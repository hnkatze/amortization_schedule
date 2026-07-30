import { describe, expect, it } from "vitest";
import { centsFromAmount, toAmount, type Cents } from "./money";
import { PREPAYMENT_STRATEGY, type LoanTerms } from "./loan";
import { NO_CHARGES, type LoanCharges } from "./charges";
import { annuityPayment, buildSchedule, comparePrepayment, monthlyRate } from "./schedule";

function terms(overrides: Partial<LoanTerms> = {}): LoanTerms {
  return {
    principal: centsFromAmount(100_000),
    annualRatePercent: 12,
    termMonths: 12,
    extraPayments: [],
    strategy: PREPAYMENT_STRATEGY.reduceTerm,
    charges: NO_CHARGES,
    ...overrides,
  };
}

function charges(overrides: Partial<LoanCharges> = {}): LoanCharges {
  return { ...NO_CHARGES, ...overrides };
}

const lastRow = <TRow,>(rows: readonly TRow[]): TRow => {
  const row = rows.at(-1);
  if (row === undefined) throw new Error("schedule produced no rows");
  return row;
};

describe("annuityPayment", () => {
  it("matches the textbook French-system installment", () => {
    // 100,000 at 12% nominal over 12 months is a widely published example:
    // the level installment is 8,884.88.
    const payment = annuityPayment(centsFromAmount(100_000), monthlyRate(12), 12);
    expect(toAmount(payment)).toBeCloseTo(8_884.88, 2);
  });

  it("spreads the principal evenly when the rate is zero", () => {
    const payment = annuityPayment(centsFromAmount(1_200), 0, 12);
    expect(toAmount(payment)).toBe(100);
  });
});

describe("buildSchedule", () => {
  it("ends at exactly zero, with no stray cents", () => {
    const schedule = buildSchedule(terms());
    expect(lastRow(schedule.rows).closingBalance).toBe(0);
  });

  it("repays exactly the principal borrowed across all periods", () => {
    const schedule = buildSchedule(terms());
    const repaid = schedule.rows.reduce((total, row) => total + row.principal + row.extra, 0);
    expect(repaid).toBe(centsFromAmount(100_000));
  });

  it("runs for the full term when nothing is prepaid", () => {
    expect(buildSchedule(terms()).months).toBe(12);
  });

  it("charges interest on the outstanding balance, not the original principal", () => {
    const schedule = buildSchedule(terms({ termMonths: 120 }));
    const [first, second] = schedule.rows;
    if (first === undefined || second === undefined) throw new Error("expected two rows");

    // First period interest is principal * monthly rate: 100,000 * 1% = 1,000.
    expect(toAmount(first.interest)).toBeCloseTo(1_000, 2);
    // The balance shrank, so the next period's interest must be strictly less.
    expect(second.interest).toBeLessThan(first.interest);
  });

  it("shifts each installment from interest toward principal over time", () => {
    const schedule = buildSchedule(terms({ termMonths: 120 }));
    const first = schedule.rows[0];
    const last = lastRow(schedule.rows);
    if (first === undefined) throw new Error("expected a first row");

    expect(first.interest).toBeGreaterThan(first.principal);
    expect(last.principal).toBeGreaterThan(last.interest);
  });

  it("never lets the balance grow", () => {
    const schedule = buildSchedule(terms({ termMonths: 360, annualRatePercent: 24 }));
    for (const row of schedule.rows) {
      expect(row.closingBalance).toBeLessThanOrEqual(row.openingBalance);
    }
  });

  it("caps an oversized extra payment at the remaining balance", () => {
    const schedule = buildSchedule(
      terms({
        extraPayments: [{ period: 2, amount: centsFromAmount(999_999) }],
      }),
    );

    expect(lastRow(schedule.rows).closingBalance).toBe(0);
    expect(schedule.months).toBe(2);
    const repaid = schedule.rows.reduce((total, row) => total + row.principal + row.extra, 0);
    expect(repaid).toBe(centsFromAmount(100_000));
  });

  it("terminates on a zero-interest loan", () => {
    const schedule = buildSchedule(terms({ annualRatePercent: 0 }));
    expect(schedule.months).toBe(12);
    expect(schedule.totalInterest).toBe(0);
  });
});

describe("prepayment strategies", () => {
  const withExtra = (strategy: LoanTerms["strategy"]): LoanTerms =>
    terms({
      termMonths: 120,
      strategy,
      extraPayments: [{ period: 6, amount: centsFromAmount(20_000) }],
    });

  it("reduceTerm keeps the installment fixed and finishes early", () => {
    const schedule = buildSchedule(withExtra(PREPAYMENT_STRATEGY.reduceTerm));
    const baseline = buildSchedule(terms({ termMonths: 120 }));

    expect(schedule.months).toBeLessThan(baseline.months);
    // The scheduled installment after the prepayment is unchanged (the final
    // row is excluded: it is the stub payment that clears the balance).
    const afterPrepayment = schedule.rows.slice(6, -1);
    for (const row of afterPrepayment) {
      expect(toAmount(row.payment)).toBeCloseTo(toAmount(baseline.firstPayment), 1);
    }
  });

  it("reducePayment keeps the end date and lowers the installment", () => {
    const schedule = buildSchedule(withExtra(PREPAYMENT_STRATEGY.reducePayment));
    const baseline = buildSchedule(terms({ termMonths: 120 }));
    const rowAfter = schedule.rows[6];
    if (rowAfter === undefined) throw new Error("expected a row after the prepayment");

    expect(rowAfter.payment).toBeLessThan(baseline.firstPayment);
    expect(schedule.months).toBe(baseline.months);
  });

  it("reduceTerm saves strictly more interest than reducePayment", () => {
    const shorterTerm = buildSchedule(withExtra(PREPAYMENT_STRATEGY.reduceTerm));
    const smallerPayment = buildSchedule(withExtra(PREPAYMENT_STRATEGY.reducePayment));

    expect(shorterTerm.totalInterest).toBeLessThan(smallerPayment.totalInterest);
  });

  it("an early prepayment saves more than the same amount paid late", () => {
    const amount: Cents = centsFromAmount(20_000);
    const early = buildSchedule(
      terms({ termMonths: 120, extraPayments: [{ period: 6, amount }] }),
    );
    const late = buildSchedule(
      terms({ termMonths: 120, extraPayments: [{ period: 60, amount }] }),
    );

    expect(early.totalInterest).toBeLessThan(late.totalInterest);
  });
});

describe("charges", () => {
  it("leaves the amortization untouched — only the outflow grows", () => {
    const bare = buildSchedule(terms({ termMonths: 60 }));
    const charged = buildSchedule(
      terms({ termMonths: 60, charges: charges({ adminFee: centsFromAmount(150) }) }),
    );

    expect(charged.months).toBe(bare.months);
    expect(charged.totalInterest).toBe(bare.totalInterest);
    expect(charged.rows.map((row) => row.closingBalance)).toEqual(
      bare.rows.map((row) => row.closingBalance),
    );
    expect(charged.totalPaid).toBeGreaterThan(bare.totalPaid);
  });

  it("charges a fixed fee identically every period", () => {
    const schedule = buildSchedule(
      terms({ termMonths: 24, charges: charges({ adminFee: centsFromAmount(150) }) }),
    );

    for (const row of schedule.rows) {
      expect(toAmount(row.charges)).toBeCloseTo(150, 2);
    }
    expect(toAmount(schedule.totalCharges)).toBeCloseTo(150 * 24, 2);
  });

  it("shrinks life insurance as the balance is repaid", () => {
    const schedule = buildSchedule(
      terms({ termMonths: 60, charges: charges({ lifeInsurancePerMille: 0.85 }) }),
    );
    const first = schedule.rows[0];
    const last = lastRow(schedule.rows);
    if (first === undefined) throw new Error("expected a first row");

    // 100,000 owed at 0.85 per thousand is 85.00 in the first period.
    expect(toAmount(first.charges)).toBeCloseTo(85, 2);
    expect(last.charges).toBeLessThan(first.charges);
  });

  it("takes the origination fee once, not monthly", () => {
    const schedule = buildSchedule(
      terms({ termMonths: 12, charges: charges({ originationPercent: 2 }) }),
    );

    expect(toAmount(schedule.originationFee)).toBeCloseTo(2_000, 2);
    expect(schedule.totalCharges).toBe(0);
    expect(schedule.totalCost).toBe(schedule.totalPaid + schedule.originationFee);
  });

  it("reports the effective rate as the nominal rate when nothing is charged", () => {
    const schedule = buildSchedule(terms({ termMonths: 60 }));
    expect(schedule.effectiveAnnualRatePercent).toBeCloseTo(12.68, 1);
  });

  it("reports an effective rate above nominal once charges apply", () => {
    const bare = buildSchedule(terms({ termMonths: 60 }));
    const charged = buildSchedule(
      terms({
        termMonths: 60,
        charges: charges({
          lifeInsurancePerMille: 0.85,
          adminFee: centsFromAmount(150),
          originationPercent: 2,
        }),
      }),
    );

    expect(charged.effectiveAnnualRatePercent).toBeGreaterThan(
      bare.effectiveAnnualRatePercent,
    );
  });

  it("prices an interest-free loan that only carries a fee", () => {
    const schedule = buildSchedule(
      terms({
        annualRatePercent: 0,
        termMonths: 12,
        charges: charges({ adminFee: centsFromAmount(500) }),
      }),
    );

    expect(schedule.totalInterest).toBe(0);
    // Paying 500 a month on top of a free loan is not free.
    expect(schedule.effectiveAnnualRatePercent).toBeGreaterThan(0);
  });
});

describe("comparePrepayment", () => {
  it("reports the interest and months actually saved", () => {
    const comparison = comparePrepayment(
      terms({
        termMonths: 120,
        extraPayments: [{ period: 6, amount: centsFromAmount(20_000) }],
      }),
    );

    expect(comparison.interestSaved).toBeGreaterThan(0);
    expect(comparison.monthsSaved).toBeGreaterThan(0);
    expect(comparison.baseline.months).toBe(120);
  });

  it("reports no saving when nothing is prepaid", () => {
    const comparison = comparePrepayment(terms());
    expect(comparison.interestSaved).toBe(0);
    expect(comparison.monthsSaved).toBe(0);
  });
});
