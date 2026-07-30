import {
  ZERO,
  addCents,
  centsCeil,
  centsFromRaw,
  subCents,
  sumCents,
  toAmount,
  type Cents,
} from "./money";
import { MAX_TERM_MONTHS, PREPAYMENT_STRATEGY, type ExtraPayment, type LoanTerms } from "./loan";
import { chargesForPeriod, originationFee } from "./charges";

export type ScheduleRow = {
  readonly period: number;
  readonly openingBalance: Cents;
  /** The loan installment alone: interest + scheduled principal. */
  readonly payment: Cents;
  readonly interest: Cents;
  readonly principal: Cents;
  /** Insurance and fees owed this period, on top of the installment. */
  readonly charges: Cents;
  /** Extra principal paid on top of the installment. */
  readonly extra: Cents;
  /** Everything that actually leaves the borrower's pocket this period. */
  readonly totalDue: Cents;
  readonly closingBalance: Cents;
};

export type Schedule = {
  readonly rows: readonly ScheduleRow[];
  readonly totalInterest: Cents;
  readonly totalCharges: Cents;
  readonly originationFee: Cents;
  /** Sum of every monthly outflow. */
  readonly totalPaid: Cents;
  /** Monthly outflows plus the one-off origination fee. */
  readonly totalCost: Cents;
  readonly months: number;
  /** The level installment before any prepayment alters it. */
  readonly firstPayment: Cents;
  /** First-period charges, i.e. the largest they will ever be. */
  readonly firstCharges: Cents;
  /**
   * The rate that actually applies once charges are counted, annualised.
   * Equals the nominal rate only when there are no charges at all.
   */
  readonly effectiveAnnualRatePercent: number;
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

function presentValue(outflows: readonly number[], rate: number): number {
  let total = 0;
  for (const [index, outflow] of outflows.entries()) {
    total += outflow / Math.pow(1 + rate, index + 1);
  }
  return total;
}

/**
 * The internal rate of return of the borrower's actual cash flows, annualised.
 *
 * Solved by bisection rather than Newton's method: present value is strictly
 * decreasing in the rate, so bisection cannot diverge or need a derivative,
 * and 200 halvings pin the answer far below display precision.
 */
export function effectiveAnnualRatePercent(
  outflows: readonly number[],
  netReceived: number,
): number {
  if (netReceived <= 0 || outflows.length === 0) return 0;

  const totalOut = outflows.reduce((sum, outflow) => sum + outflow, 0);
  if (totalOut <= netReceived) return 0;

  let low = 0;
  let high = 1;
  while (presentValue(outflows, high) > netReceived && high < 1000) high *= 2;

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    if (presentValue(outflows, mid) > netReceived) low = mid;
    else high = mid;
  }

  const monthly = (low + high) / 2;
  return (Math.pow(1 + monthly, 12) - 1) * 100;
}

export function buildSchedule(terms: LoanTerms): Schedule {
  const rate = monthlyRate(terms.annualRatePercent);
  const extrasByPeriod = groupExtrasByPeriod(terms.extraPayments);
  const upfrontFee = originationFee(terms.principal, terms.charges);

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
    const charges = chargesForPeriod(openingBalance, terms.charges);

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

    const payment = addCents(principalPaid, interest);

    rows.push({
      period,
      openingBalance,
      payment,
      interest,
      principal: principalPaid,
      charges,
      extra,
      totalDue: addCents(addCents(payment, charges), extra),
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

  const totalPaid = sumCents(rows.map((row) => row.totalDue));
  const firstRow = rows[0];

  return {
    rows,
    totalInterest: sumCents(rows.map((row) => row.interest)),
    totalCharges: sumCents(rows.map((row) => row.charges)),
    originationFee: upfrontFee,
    totalPaid,
    totalCost: addCents(totalPaid, upfrontFee),
    months: rows.length,
    firstPayment,
    firstCharges: firstRow?.charges ?? ZERO,
    effectiveAnnualRatePercent: effectiveAnnualRatePercent(
      rows.map((row) => toAmount(row.totalDue)),
      toAmount(subCents(terms.principal, upfrontFee)),
    ),
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
