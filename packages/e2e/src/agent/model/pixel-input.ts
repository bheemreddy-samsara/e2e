/** Image safety at the provider boundary. A rejected request never retries an action. */

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { AiSdk, SdkLanguageModel } from '../ai-sdk.ts';
import type { VisionDegradation } from '../../run/steps.ts';
import { AgentError } from '../error.ts';

/** A provider's confirmed lack of image support, remembered for this instance only. */
const TEXT_ONLY_MODELS = new WeakSet<object>();

export interface PixelInputPolicy {
  /** Private runner-bound check on the final request, after permitted degradation and before transport. */
  readonly preflight?: ((request: LanguageModelV4CallOptions) => void) | undefined;
  readonly supported?: boolean | undefined;
  readonly permitted: () => boolean;
  readonly canDegrade: () => boolean;
  readonly record: (input: { bytes?: number; peakBytes?: number; degraded?: VisionDegradation }) => void;
  /** Charges an image request the caller has not already accounted. */
  readonly rejected: () => void;
  /** Checks/charges the replacement request before dispatch, when degradation is allowed. */
  readonly retry?: () => void;
}

/**
 * Checks pixels immediately before every request, including history after a
 * secret fill. Only an explicit image rejection permits one text-only request
 * with identical tool history. No action is redispatched or repeated.
 */
export function withSafePixelInput(ai: AiSdk, model: SdkLanguageModel, policy: PixelInputPolicy): SdkLanguageModel {
  return ai.wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ params, model: inner }) => {
        const aborted = () => params.abortSignal?.aborted === true;
        const sizes = params.prompt.flatMap((message) => typeof message.content === 'string' ? [] :
          message.content.flatMap((part) => {
            if (part.type === 'file' && /^image(?:\/|$)/i.test(part.mediaType)) return [fileBytes(part.data)];
            if (part.type === 'tool-result' && part.output.type === 'content') {
              return part.output.value.flatMap((item) => item.type === 'file' && /^image(?:\/|$)/i.test(item.mediaType) ? [fileBytes(item.data)] : []);
            }
            return [];
          }));
        const imageBytes = sizes.reduce((sum, bytes) => sum + bytes, 0);
        const hasImages = params.prompt.some((message) => typeof message.content !== 'string' && message.content.some((part) =>
          part.type === 'file' && /^image(?:\/|$)/i.test(part.mediaType) || (part.type === 'tool-result' && part.output.type === 'content' && part.output.value.some((item) => item.type === 'file' && /^image(?:\/|$)/i.test(item.mediaType))),
        ));
        if (!hasImages) {
          policy.preflight?.(params);
          return inner.doGenerate(params);
        }
        const permitted = policy.permitted();
        const unsupported = policy.supported === false || TEXT_ONLY_MODELS.has(model);
        const degrade = (reason: VisionDegradation) => {
          policy.record({ degraded: reason });
          if (!policy.canDegrade()) throw new AgentError('POLICY_DENIED', `pixel evidence is required but unavailable (${reason}); refusing tree-only input`);
        };
        const withoutImages = (reason: VisionDegradation) => ({
          ...params,
          prompt: params.prompt.map((message) => typeof message.content === 'string' ? message : {
            ...message,
            content: message.content.flatMap((part) => {
              if (part.type === 'file' && /^image(?:\/|$)/i.test(part.mediaType)) return [{ type: 'text' as const, text: `[Screenshot withheld: ${reason}. Use semantic evidence only.]` }];
              if (part.type === 'tool-result' && part.output.type === 'content') {
                if (!part.output.value.some((item) => item.type === 'file' && /^image(?:\/|$)/i.test(item.mediaType))) return [part];
                return [{ ...part, output: { ...part.output, value: [...part.output.value.filter((item) => !(item.type === 'file' && /^image(?:\/|$)/i.test(item.mediaType))), { type: 'text' as const, text: `[Screenshots withheld: ${reason}. Use semantic evidence only.]` }] } }];
              }
              return [part];
            }),
          }),
        });
        if (!permitted || unsupported) {
          const reason = permitted ? 'MODEL_IMAGES_UNSUPPORTED' : 'PIXEL_TAINTED';
          degrade(reason);
          const replacement = withoutImages(reason) as typeof params;
          policy.preflight?.(replacement);
          return inner.doGenerate(replacement);
        }
        policy.preflight?.(params);
        try {
          const result = await inner.doGenerate(params);
          // A late response to an abandoned generation has no result reader and
          // must not mutate live pixel accounting or remembered image support.
          if (aborted()) return result;
          // A provider can accept the request while warning that it ignored images.
          if (result.warnings.some((warning) => warning.type === 'unsupported' && /image|vision/i.test(warning.feature))) {
            TEXT_ONLY_MODELS.add(model);
            if (!policy.canDegrade()) policy.rejected();
            degrade('MODEL_IMAGES_UNSUPPORTED');
          } else {
            policy.record({ bytes: imageBytes, peakBytes: Math.max(0, ...sizes) });
          }
          return result;
        } catch (cause) {
          if (!imageRejected(cause) || aborted()) throw cause;
          TEXT_ONLY_MODELS.add(model);
          policy.rejected();
          degrade('MODEL_IMAGES_UNSUPPORTED');
          policy.retry?.();
          const replacement = withoutImages('MODEL_IMAGES_UNSUPPORTED') as typeof params;
          policy.preflight?.(replacement);
          try {
            return await inner.doGenerate(replacement);
          } catch (replacementFailure) {
            // A successful replacement is charged by the caller's normal
            // step-end hook. A failed one never reaches that hook.
            if (!aborted()) policy.rejected();
            throw replacementFailure;
          }
        }
      },
    },
  });
}

/** Only a non-retryable image capability rejection, never auth, timeout, or a generic outage. */
function imageRejected(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const error = cause as Error & { statusCode?: number; functionality?: string };
  const message = error.functionality ?? error.message;
  // A codec, payload, or size problem says nothing about image capability.
  if (/\b(?:image|file)\s+(?:(?:input|payload|data|url)\s+)*(?:format|type|size|encoding)|\b(?:invalid|corrupt(?:ed)?)\s+image\b|image\//i.test(message)) return false;
  if (error.name === 'AI_UnsupportedFunctionalityError') return /^(?:images?|image input|vision)$/i.test(message);
  return (error.statusCode === 400 || error.statusCode === 422) &&
    /(?:does not support|cannot accept|unsupported|not supported)\s+(?:image input|images?|vision)(?=$|[.!;,:"'\r\n]|\s+(?:by|for|on)\s+(?:this|the)\s+(?:model|endpoint|provider)\b)|(?:image input|vision|images)\s+(?:is |are )?(?:not supported|unsupported)(?=$|[.!;,:"'\r\n]|\s+(?:by|for|on)\s+(?:this|the)\s+(?:model|endpoint|provider)\b)/i.test(message);
}

/** Counts inline image bytes only; URL and provider references carry no inline bytes. */
function fileBytes(data: { type: string; data?: Uint8Array | string }): number {
  if (data.type !== 'data' || data.data === undefined) return 0;
  return typeof data.data === 'string' ? Buffer.byteLength(data.data, 'base64') : data.data.byteLength;
}
