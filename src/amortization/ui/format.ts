import { toAmount, type Cents } from "../domain/money";

export const CURRENCY = {
  hnl: "HNL",
  usd: "USD",
} as const;

export type CurrencyCode = (typeof CURRENCY)[keyof typeof CURRENCY];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return value === CURRENCY.hnl || value === CURRENCY.usd;
}

function buildFormatter(currency: CurrencyCode): Intl.NumberFormat {
  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Intl.NumberFormat construction is not free and this runs once per table cell,
// so the two formatters are built once and reused.
const FORMATTERS: Record<CurrencyCode, Intl.NumberFormat> = {
  HNL: buildFormatter(CURRENCY.hnl),
  USD: buildFormatter(CURRENCY.usd),
};

/** Number formats for Excel, so the exported cells stay real numbers. */
export const EXCEL_MONEY_FORMAT: Record<CurrencyCode, string> = {
  HNL: '"L" #,##0.00',
  USD: '"$" #,##0.00',
};

export function formatMoney(value: Cents, currency: CurrencyCode): string {
  return FORMATTERS[currency].format(toAmount(value));
}

/** "18 meses" reads worse than "1 año y 6 meses" once a term passes a year. */
export function formatDuration(months: number): string {
  if (months < 12) return `${months} ${months === 1 ? "mes" : "meses"}`;

  const years = Math.floor(months / 12);
  const remainder = months % 12;
  const yearLabel = `${years} ${years === 1 ? "año" : "años"}`;
  if (remainder === 0) return yearLabel;

  return `${yearLabel} y ${remainder} ${remainder === 1 ? "mes" : "meses"}`;
}
