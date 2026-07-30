import writeXlsxFile, { type Cell, type Row, type SheetData } from "write-excel-file/browser";
import { toAmount, type Cents } from "../domain/money";
import type { PrepaymentComparison } from "../domain/schedule";
import { EXCEL_MONEY_FORMAT, formatDuration, type CurrencyCode } from "./format";

export type ExcelExportRequest = {
  readonly title: string;
  readonly comparison: PrepaymentComparison;
  readonly currency: CurrencyCode;
  readonly annualRatePercent: number;
};

const HEADERS = ["Mes", "Cuota", "Interés", "Capital", "Abono", "Saldo"] as const;

const INK = "#1E293B";
const MUTED = "#64748B";
const HEADER_FILL = "#0F172A";
const HEADER_INK = "#FFFFFF";
const ACCENT = "#047857";

/**
 * Windows forbids these characters in a file name, and a title typed by a
 * human will eventually contain one. Left unchecked the download just fails.
 */
function toSafeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return `${cleaned === "" ? "tabla-de-amortizacion" : cleaned}.xlsx`;
}

/**
 * Money goes in as a real number with a currency display format, never as a
 * pre-formatted string — otherwise the spreadsheet cannot sum its own column.
 */
function moneyCell(value: Cents, currency: CurrencyCode, emphasis = false): Cell {
  return {
    value: toAmount(value),
    type: Number,
    format: EXCEL_MONEY_FORMAT[currency],
    align: "right",
    ...(emphasis ? { fontWeight: "bold" as const, textColor: ACCENT } : {}),
  };
}

function summaryRow(label: string, value: Cell): Row {
  return [{ value: label, fontWeight: "bold", textColor: MUTED }, value];
}

function textCell(value: string): Cell {
  return { value, textColor: INK };
}

type Sheet = {
  readonly data: SheetData;
  /** Rows to freeze: everything down to and including the column headers. */
  readonly stickyRowsCount: number;
};

function buildSheet(request: ExcelExportRequest): Sheet {
  const { comparison, currency, annualRatePercent, title } = request;
  const { withExtras, interestSaved, monthsSaved } = comparison;

  const preamble: Row[] = [
    [{ value: title, fontWeight: "bold", fontSize: 16, textColor: INK, columnSpan: 6 }],
    summaryRow("Tasa anual", textCell(`${annualRatePercent}%`)),
    summaryRow("Cuota mensual", moneyCell(withExtras.firstPayment, currency)),
    summaryRow("Plazo", textCell(formatDuration(withExtras.months))),
    summaryRow("Intereses totales", moneyCell(withExtras.totalInterest, currency)),
    summaryRow("Total a pagar", moneyCell(withExtras.totalPaid, currency)),
  ];

  if (interestSaved > 0 || monthsSaved > 0) {
    preamble.push([
      { value: "Ahorro por abonos", fontWeight: "bold", textColor: MUTED },
      moneyCell(interestSaved, currency, true),
      textCell(`${formatDuration(monthsSaved)} menos`),
    ]);
  }

  const headerRow: Row = HEADERS.map((header) => ({
    value: header,
    fontWeight: "bold" as const,
    textColor: HEADER_INK,
    backgroundColor: HEADER_FILL,
    align: header === "Mes" ? ("left" as const) : ("right" as const),
  }));

  const body: Row[] = withExtras.rows.map((row) => [
    { value: row.period, type: Number, align: "left" },
    moneyCell(row.payment, currency),
    moneyCell(row.interest, currency),
    moneyCell(row.principal, currency),
    row.extra > 0 ? moneyCell(row.extra, currency, true) : null,
    moneyCell(row.closingBalance, currency),
  ]);

  const data: SheetData = [...preamble, [], headerRow, ...body];

  return { data, stickyRowsCount: preamble.length + 2 };
}

export async function exportScheduleToExcel(request: ExcelExportRequest): Promise<void> {
  const { data, stickyRowsCount } = buildSheet(request);

  await writeXlsxFile(data, {
    sheet: "Amortización",
    stickyRowsCount,
    columns: [{ width: 8 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 18 }],
  }).toFile(toSafeFileName(request.title));
}
