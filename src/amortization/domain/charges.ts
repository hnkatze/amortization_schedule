import { ZERO, addCents, centsFromRaw, type Cents } from "./money";

/**
 * What the lender adds on top of interest.
 *
 * These do not change how the loan amortizes — the installment and the balance
 * behave exactly the same. They change what actually leaves the borrower's
 * pocket, which is why a quoted nominal rate and the real cost of a loan are
 * two different numbers.
 */
export type LoanCharges = {
  /**
   * Life insurance quoted per thousand of the outstanding balance, charged
   * monthly. A quote of 0.85 means 0.85 currency units per 1,000 owed.
   */
  readonly lifeInsurancePerMille: number;
  /** Fixed monthly property/damage insurance. */
  readonly damageInsurance: Cents;
  /** Fixed monthly administration fee. */
  readonly adminFee: Cents;
  /** One-off origination fee, as a percentage of the principal. */
  readonly originationPercent: number;
};

export const NO_CHARGES: LoanCharges = {
  lifeInsurancePerMille: 0,
  damageInsurance: ZERO,
  adminFee: ZERO,
  originationPercent: 0,
};

export function hasAnyCharge(charges: LoanCharges): boolean {
  return (
    charges.lifeInsurancePerMille > 0 ||
    charges.damageInsurance > ZERO ||
    charges.adminFee > ZERO ||
    charges.originationPercent > 0
  );
}

/**
 * Charges owed for one period.
 *
 * Life insurance rides on the balance still owed at the start of the period,
 * so it shrinks as the loan is repaid. The fixed items do not.
 */
export function chargesForPeriod(openingBalance: Cents, charges: LoanCharges): Cents {
  const lifeInsurance = centsFromRaw((openingBalance * charges.lifeInsurancePerMille) / 1000);
  return addCents(addCents(lifeInsurance, charges.damageInsurance), charges.adminFee);
}

/** Charged once, up front, against the amount borrowed. */
export function originationFee(principal: Cents, charges: LoanCharges): Cents {
  return centsFromRaw((principal * charges.originationPercent) / 100);
}
