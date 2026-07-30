import {
  ZERO,
  addCents,
  centsCeil,
  centsFromRaw,
  subCents,
  sumCents,
  type Cents,
} from "./money";
import { MAX_TERM_MONTHS, PREPAYMENT_STRATEGY, type ExtraPayment, type LoanTerms } from "./loan";

export type ScheduleRow = {
  readonly period: number;
  readonly openingBalance: Cents;
  /** What is actually charged this period: interest + scheduled principal. */
  readonly payment: Cents;
  readonly interest: Cents;
  /** Principal repaid out of the scheduled installment. */
  readonly principal: Cents;
  /** Extra principal paid on top of the installment. */
  readonly extra: Cents;
  readonly closingBalance: Cents;
};

export type Schedule = {
  readonly rows: readonly ScheduleRow[];
  readonly totalInterest: Cents;
  readonly totalPaid: Cents;
  readonly months: number;
  /** The level installment before any prepayment alters it. */
  readonly firstPayment: Cents;
};

/**
 * The loop is bounded independently of the term so that a pathological rate or
 * a rounding stall can never hang the page.
 */
const SAFETY_LIMIT = MAX_TERM_MONTHS * 2;

export function monthlyRate(annualRatePercent: number): number {
  return annualRatePercent / 100 / 12;
}

/**
 * The French-system installment: the fixed amount that repays `balance` over
 * `months` periods at `rate` per period.
 *
 *   payment = balance * rate / (1 - (1 + rate)^-months)
 *
 * At rate 0 the formula divides by zero, so the degenerate case is split out:
 * with no interest the loan is simply the balance spread evenly.
 */
export function annuityPayment(balance: Cents, rate: number, months: number): Cents {
  if (months <= 0 || balance <= ZERO) return ZERO;
  if (rate === 0) return centsCeil(balance / months);
  const discountFactor = Math.pow(1 + rate, -months);
  return centsCeil((balance * rate) / (1 - discountFactor));
}

function groupExtrasByPeriod(extras: readonly ExtraPayment[]): ReadonlyMap<number, Cents> {
  const grouped = new Map<number, Cents>();
  for (const extra of extras) {
    const current = grouped.get(extra.period) ?? ZERO;
    grouped.set(extra.period, addCents(current, extra.amount));
  }
  return grouped;
}

export function buildSchedule(terms: LoanTerms): Schedule {
  const rate = monthlyRate(terms.annualRatePercent);
  const extrasByPeriod = groupExtrasByPeriod(terms.extraPayments);

  const rows: ScheduleRow[] = [];
  let balance = terms.principal;
  let installment = annuityPayment(balance, rate, terms.termMonths);
  const firstPayment = installment;
  let period = 0;

  while (balance > ZERO && period < SAFETY_LIMIT) {
    period += 1;
    const openingBalance = balance;

    // Interest always accrues on the balance owed *right now*, never on the
    // original principal. This is the whole reason early periods barely move
    // the balance, and the reason a prepayment is worth so much more early.
    const interest = centsFromRaw(balance * rate);

    let principalPaid = subCents(installment, interest);

    // The final installment is whatever clears the balance exactly, so the
    // schedule always lands on zero instead of a few stray cents.
    if (principalPaid > balance) principalPaid = balance;

    // Safety valve: if rounding ever left the installment unable to cover the
    // interest, the balance would grow every period and the loop would never
    // end. Close the loan instead of spinning.
    if (principalPaid <= ZERO) principalPaid = balance;

    balance = subCents(balance, principalPaid);

    let extra = extrasByPeriod.get(period) ?? ZERO;
    if (extra > balance) extra = balance;
    balance = subCents(balance, extra);

    rows.push({
      period,
      openingBalance,
      payment: addCents(principalPaid, interest),
      interest,
      principal: principalPaid,
      extra,
      closingBalance: balance,
    });

    // Only "reduce the installment" rewrites the future. "Reduce the term"
    // deliberately leaves the installment alone: the loan just runs out sooner.
    if (
      extra > ZERO &&
      balance > ZERO &&
      terms.strategy === PREPAYMENT_STRATEGY.reducePayment
    ) {
      installment = annuityPayment(balance, rate, terms.termMonths - period);
    }
  }

  return {
    rows,
    totalInterest: sumCents(rows.map((row) => row.interest)),
    totalPaid: sumCents(rows.map((row) => addCents(row.payment, row.extra))),
    months: rows.length,
    firstPayment,
  };
}

export type PrepaymentComparison = {
  readonly baseline: Schedule;
  readonly withExtras: Schedule;
  readonly interestSaved: Cents;
  readonly monthsSaved: number;
};

/**
 * Runs the same loan twice — once untouched, once with the extra payments — so
 * the saving can be stated as a number instead of a promise.
 */
export function comparePrepayment(terms: LoanTerms): PrepaymentComparison {
  const baseline = buildSchedule({ ...terms, extraPayments: [] });
  const withExtras = buildSchedule(terms);

  return {
    baseline,
    withExtras,
    interestSaved: subCents(baseline.totalInterest, withExtras.totalInterest),
    monthsSaved: baseline.months - withExtras.months,
  };
}
