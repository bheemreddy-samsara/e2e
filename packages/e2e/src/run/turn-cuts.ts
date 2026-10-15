/** Private producer boundaries; never serialized and never holding transcript text. */
import type { StepTurn } from './steps.ts';
import type { SecretLedger } from '../internal/redact.ts';

interface Cuts { calls: readonly (readonly number[])[]; outcome: readonly number[] }
const cutsByTurn = new WeakMap<StepTurn, Cuts>();

/** Associates actual SDK cuts with the exact turn handed to attachTurns. */
export function recordTurnCuts(turn: StepTurn, calls: Cuts['calls'], outcome: Cuts['outcome']): StepTurn {
  cutsByTurn.set(turn, { calls, outcome });
  return turn;
}

/** Keeps only boundaries that whole-value redaction did not consume. */
function mappedCuts(text: string, cuts: readonly number[], redact: (text: string) => string): number[] {
  const whole = redact(text);
  return cuts.flatMap((cut) => {
    const head = redact(text.slice(0, cut));
    return head + redact(text.slice(cut)) === whole ? [head.length] : [];
  });
}

/** Redacts exactly as attachTurns did, carrying surviving positions, not raw prose. */
export function redactRecordedTurn(turn: StepTurn, redact: (text: string) => string): StepTurn {
  const result = { index: turn.index, calls: turn.calls.map(redact), outcome: redact(turn.outcome) };
  const cuts = cutsByTurn.get(turn);
  if (cuts !== undefined) recordTurnCuts(result,
    turn.calls.map((call, index) => mappedCuts(call, cuts.calls[index] ?? [], redact)),
    mappedCuts(turn.outcome, cuts.outcome, redact));
  return result;
}

/** Masks late-known cut prefixes without splitting a whole-value match or parsing aliases. */
function redactAtCuts(text: string, cuts: readonly number[], ledger: Pick<SecretLedger, 'redact' | 'redactCut'>): string {
  const whole = ledger.redact(text);
  const surviving = cuts.filter((cut) => ledger.redact(text.slice(0, cut)) + ledger.redact(text.slice(cut)) === whole);
  let from = 0;
  let output = '';
  for (const cut of surviving) {
    output += ledger.redactCut(text.slice(from, cut));
    from = cut;
  }
  return output + ledger.redact(text.slice(from));
}

/** The report uses the SDK boundaries retained through recording; custom turns have none. */
export function redactReportTurn(turn: StepTurn, ledger: Pick<SecretLedger, 'redact' | 'redactCut'>): StepTurn {
  const cuts = cutsByTurn.get(turn);
  return {
    index: turn.index,
    calls: turn.calls.map((call, index) => redactAtCuts(call, cuts?.calls[index] ?? [], ledger)),
    outcome: redactAtCuts(turn.outcome, cuts?.outcome ?? [], ledger),
  };
}
