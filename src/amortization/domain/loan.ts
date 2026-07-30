import type { Cents } from "./money";
import type { LoanCharges } from "./charges";

/**
 * What the borrower does with an extra principal payment.
 *
 * Both options apply the same money to the same balance, but they spend the
 * savings differently, and the difference is large:
 *
 * - reduceTerm  keeps the installment fixed and ends the loan earlier. Every
 *               period removed from the tail is a period of interest never paid,
 *               so this maximizes total interest saved.
 * - reducePayment keeps the original end date and recomputes a smaller
 *               installment over the periods that remain. It frees up monthly
 *               cash flow but keeps paying interest for the full original term.
 */
export const PREPAYMENT_STRATEGY = {
  reduceTerm: "reduce-term",
  reducePayment: "reduce-payment",
} as const;

export type PrepaymentStrategy =
  (typeof PREPAYMENT_STRATEGY)[keyof typeof PREPAYMENT_STRATEGY];

/** An extra payment applied to principal, on top of the scheduled installment. */
export type ExtraPayment = {
  /** 1-based period the extra payment lands on. */
  readonly period: number;
  readonly amount: Cents;
};

export type LoanTerms = {
  readonly principal: Cents;
  /** Nominal annual rate as a percentage, e.g. 18.5 for 18.5%. */
  readonly annualRatePercent: number;
  readonly termMonths: number;
  readonly extraPayments: readonly ExtraPayment[];
  readonly strategy: PrepaymentStrategy;
  readonly charges: LoanCharges;
};

export type ValidationError = {
  readonly field: string;
  readonly message: string;
};

export type Validated<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/** Hard ceiling on term length, so a typo cannot ask for a 10,000-row table. */
export const MAX_TERM_MONTHS = 600;

export function validateTerms(terms: LoanTerms): Validated<LoanTerms> {
  const errors: ValidationError[] = [];

  if (!Number.isFinite(terms.principal) || terms.principal <= 0) {
    errors.push({ field: "principal", message: "El monto debe ser mayor que cero." });
  }

  if (!Number.isFinite(terms.annualRatePercent) || terms.annualRatePercent < 0) {
    errors.push({ field: "annualRatePercent", message: "La tasa no puede ser negativa." });
  }

  if (!Number.isInteger(terms.termMonths) || terms.termMonths <= 0) {
    errors.push({ field: "termMonths", message: "El plazo debe ser un número entero de meses." });
  } else if (terms.termMonths > MAX_TERM_MONTHS) {
    errors.push({
      field: "termMonths",
      message: `El plazo no puede superar ${MAX_TERM_MONTHS} meses.`,
    });
  }

  const { charges } = terms;
  if (!Number.isFinite(charges.lifeInsurancePerMille) || charges.lifeInsurancePerMille < 0) {
    errors.push({ field: "charges", message: "El seguro de vida no puede ser negativo." });
  }
  if (!Number.isFinite(charges.damageInsurance) || charges.damageInsurance < 0) {
    errors.push({ field: "charges", message: "El seguro de daños no puede ser negativo." });
  }
  if (!Number.isFinite(charges.adminFee) || charges.adminFee < 0) {
    errors.push({ field: "charges", message: "La comisión mensual no puede ser negativa." });
  }
  if (
    !Number.isFinite(charges.originationPercent) ||
    charges.originationPercent < 0 ||
    charges.originationPercent >= 100
  ) {
    errors.push({
      field: "charges",
      message: "La comisión de otorgamiento debe estar entre 0 % y 100 %.",
    });
  }

  for (const extra of terms.extraPayments) {
    if (!Number.isInteger(extra.period) || extra.period < 1) {
      errors.push({ field: "extraPayments", message: "El mes del abono debe ser 1 o mayor." });
      break;
    }
    if (extra.amount <= 0) {
      errors.push({ field: "extraPayments", message: "El abono debe ser mayor que cero." });
      break;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: terms };
}
