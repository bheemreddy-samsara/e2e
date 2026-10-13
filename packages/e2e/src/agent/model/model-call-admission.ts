/** Private runner admission shared with supported helpers across module copies. */
import { realmSlot } from '../../internal/realm-slot.ts';
import type { StepExecutorContext } from '../executor.ts';

const admission = realmSlot<() => () => void>('e2e.model-call-admission.v1');

/** The accounting owner supplies admission; executor context declarations do not grow. */
export function bindModelCallAdmission(context: StepExecutorContext, reserve: () => () => void): void {
  admission.set(context, reserve);
}

/** Reserves one logical request until its result is accounted or its transport fails. */
export function reserveModelCall(context: StepExecutorContext): () => void {
  const reserve = admission.get(context);
  if (reserve !== undefined) return reserve();
  context.budgets.checkModelCall?.();
  return () => {};
}
