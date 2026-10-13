/** Private opt-in request ceiling, shared across runner and executor module copies. */

import type { LanguageModelV4CallOptions, LanguageModelV4FilePart } from '@ai-sdk/provider';
import { realmSlot } from '../../internal/realm-slot.ts';
import type { StepExecutorContext } from '../executor.ts';
import { AgentError } from '../error.ts';
import { imageTokenUpperBound, tokenUpperBound } from './adapter.ts';

interface PixelRequestBudget {
  readonly maxInputTokens: number;
  readonly fail: (error: AgentError) => AgentError;
}

const budgetSlot = realmSlot<PixelRequestBudget>('e2e.pixel-request-budget.v1');
/** The same largest planned viewport used by the observation reserve, also charged for tiny images. */
const IMAGE_RESERVE = imageTokenUpperBound({ width: 2_560, height: 1_440 });

/** Binds the resolved limit without widening the public executor context or exposing request contents. */
export function bindPixelRequestBudget(context: StepExecutorContext, maxInputTokens: number, fail: PixelRequestBudget['fail']): void {
  budgetSlot.set(context, { maxInputTokens, fail });
}

/** Only explicitly opted-in runner contexts get a preflight; legacy contexts keep their request identity. */
export function pixelRequestPreflight(context: StepExecutorContext): ((request: LanguageModelV4CallOptions) => void) | undefined {
  const budget = budgetSlot.get(context);
  if (budget === undefined) return undefined;
  return (request) => {
    const inputBound = requestEstimate(request);
    if (inputBound > budget.maxInputTokens) {
      throw budget.fail(new AgentError(
        'STEP_BUDGET_EXHAUSTED',
        `model input upper bound ${inputBound} exceeds the agent's maxInputTokens ${budget.maxInputTokens}`,
      ));
    }
  };
}

/**
 * Byte-scaled JSON for all model inputs, plus a per-image patch reserve. Inline
 * bytes are charged as base64 as well as pixels, including every resent copy.
 * This deterministic conservative estimate is not a provider tokenizer or a
 * universal bound on provider image billing. It never changes usage metrics.
 */
function requestEstimate(request: LanguageModelV4CallOptions): number {
  let images = 0;
  for (const message of request.prompt) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'file' && /^image(?:\/|$)/i.test(part.mediaType)) images += imageEstimate(part);
      else if (part.type === 'tool-result' && part.output.type === 'content') {
        for (const item of part.output.value) {
          if (item.type === 'file' && /^image(?:\/|$)/i.test(item.mediaType)) images += imageEstimate(item);
        }
      }
    }
  }
  try {
    const json = JSON.stringify({
      prompt: request.prompt,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat,
      providerOptions: request.providerOptions,
    }, (_key, value: unknown) => value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value);
    return tokenUpperBound(json) + images;
  } catch {
    // Unmeasurable input must not bypass a finite ceiling.
    return Infinity;
  }
}

/** Uses encoded PNG geometry when larger than the reserve, without decoding or capturing another image. */
function imageEstimate(file: Pick<LanguageModelV4FilePart, 'data'>): number {
  if (file.data.type !== 'data') return Infinity;
  const data = typeof file.data.data === 'string' ? Buffer.from(file.data.data, 'base64') : Buffer.from(file.data.data);
  const png = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR';
  return png
    ? Math.max(IMAGE_RESERVE, imageTokenUpperBound({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) }))
    : IMAGE_RESERVE;
}
