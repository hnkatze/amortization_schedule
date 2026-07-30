/**
 * Money is stored as integer cents, never as a float.
 *
 * In IEEE-754, 0.1 + 0.2 !== 0.3. An amortization schedule feeds each row's
 * balance into the next row's interest calculation, so that error compounds
 * across hundreds of periods until the final balance never quite reaches zero.
 * Integer cents make every operation exact; rounding happens once, explicitly,
 * at the moment a real-world payment amount is decided.
 */
export type Cents = number & { readonly __brand: "Cents" };

export const ZERO: Cents = 0 as Cents;

/** Build cents from a human-entered decimal amount, e.g. 1500.75 -> 150075. */
export function centsFromAmount(amount: number): Cents {
  return Math.round(amount * 100) as Cents;
}

/** Round a raw computed value (already on the cents scale) back onto the integer grid. */
export function centsFromRaw(value: number): Cents {
  return Math.round(value) as Cents;
}

/**
 * Round a raw cents value up.
 *
 * Installments must never round down. An installment a cent short leaves a
 * residue that the schedule can only clear with one extra period carrying an
 * absurd payment — a 12-month loan that reports 13 rows. Rounding up overpays
 * by cents and lets the final payment absorb the difference, which is also what
 * lenders do in practice.
 */
export function centsCeil(value: number): Cents {
  return Math.ceil(value) as Cents;
}

export function addCents(a: Cents, b: Cents): Cents {
  return (a + b) as Cents;
}

export function subCents(a: Cents, b: Cents): Cents {
  return (a - b) as Cents;
}

export function minCents(a: Cents, b: Cents): Cents {
  return (a < b ? a : b) as Cents;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((total, value) => addCents(total, value), ZERO);
}

export function toAmount(value: Cents): number {
  return value / 100;
}
