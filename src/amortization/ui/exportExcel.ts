import writeXlsxFile, { type Cell, type Row, type SheetData } from "write-excel-file/browser";
import { toAmount, type Cents } from "../domain/money";
import type { LoanTerms } from "../domain/loan";
import { PREPAYMENT_STRATEGY } from "../domain/loan";
import type { PrepaymentComparison, Schedule } from "../domain/schedule";
import { EXCEL_MONEY_FORMAT, type CurrencyCode } from "./format";

export type ExcelExportRequest = {
  readonly title: string;
  readonly comparison: PrepaymentComparison;
  readonly currency: CurrencyCode;
  readonly terms: LoanTerms;
  /** Emit live formulas instead of frozen numbers. */
  readonly useFormulas: boolean;
};

const HEADERS = ["Mes", "Cuota total", "Interés", "Capital", "Cargos", "Abono", "Saldo"] as const;

const INK = "#1E293B";
const MUTED = "#64748B";
const HEADER_FILL = "#0F172A";
const HEADER_INK = "#FFFFFF";
const ACCENT = "#047857";
const INPUT_FILL = "#FEF9C3";

/** Worksheet layout. Everything below is anchored to these row numbers. */
const ROW = {
  title: 1,
  principal: 4,
  annualRate: 5,
  termMonths: 6,
  installment: 7,
  lifePerMille: 8,
  damageInsurance: 9,
  adminFee: 10,
  originationPercent: 11,
  header: 13,
  firstData: 14,
} as const;

/**
 * Live formulas describe a loan whose installment never moves. The
 * "reduce the installment" strategy recomputes it after every prepayment, and
 * a single `$B$7` reference cannot express that — the sheet would silently
 * disagree with the table on screen. In that case the export must fall back to
 * frozen values.
 */
export function canUseFormulas(terms: LoanTerms): boolean {
  return !(
    terms.strategy === PREPAYMENT_STRATEGY.reducePayment && terms.extraPayments.length > 0
  );
}

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
function money(value: Cents, currency: CurrencyCode, emphasis = false): Cell {
  return {
    value: toAmount(value),
    type: Number,
    format: EXCEL_MONEY_FORMAT[currency],
    align: "right",
    ...(emphasis ? { fontWeight: "bold" as const, textColor: ACCENT } : {}),
  };
}

function formula(expression: string, currency: CurrencyCode, bold = false): Cell {
  return {
    type: "Formula",
    value: expression,
    format: EXCEL_MONEY_FORMAT[currency],
    align: "right",
    ...(bold ? { fontWeight: "bold" as const } : {}),
  };
}

function labelCell(text: string): Cell {
  return { value: text, fontWeight: "bold", textColor: MUTED };
}

/** Inputs are tinted so it is obvious which cells are safe to edit. */
function inputCell(value: number, format: string): Cell {
  return {
    value,
    type: Number,
    format,
    align: "right",
    backgroundColor: INPUT_FILL,
  };
}

function buildInputBlock(request: ExcelExportRequest): Row[] {
  const { terms, currency, title, useFormulas } = request;
  const { charges } = terms;
  const cash = EXCEL_MONEY_FORMAT[currency];

  const installment: Cell = useFormulas
    ? formula(
        `=ROUNDUP(-PMT(B${ROW.annualRate}/100/12,B${ROW.termMonths},B${ROW.principal}),2)`,
        currency,
        true,
      )
    : money(request.comparison.withExtras.firstPayment, currency, true);

  return [
    [{ value: title, fontWeight: "bold", fontSize: 16, textColor: INK, columnSpan: 7 }],
    [],
    [
      {
        value: useFormulas
          ? "Datos del préstamo — editá las celdas amarillas y la tabla se recalcula sola"
          : "Datos del préstamo",
        fontWeight: "bold",
        textColor: INK,
        columnSpan: 7,
      },
    ],
    [labelCell("Monto"), inputCell(toAmount(terms.principal), cash)],
    [labelCell("Tasa anual (%)"), inputCell(terms.annualRatePercent, "0.00")],
    [labelCell("Plazo (meses)"), inputCell(terms.termMonths, "0")],
    [labelCell("Cuota"), installment],
    [labelCell("Seguro de vida (por millar)"), inputCell(charges.lifeInsurancePerMille, "0.00")],
    [labelCell("Seguro de daños (mensual)"), inputCell(toAmount(charges.damageInsurance), cash)],
    [labelCell("Comisión mensual"), inputCell(toAmount(charges.adminFee), cash)],
    [labelCell("Comisión de otorgamiento (%)"), inputCell(charges.originationPercent, "0.00")],
    [],
  ];
}

function buildHeaderRow(): Row {
  return HEADERS.map((header) => ({
    value: header,
    fontWeight: "bold" as const,
    textColor: HEADER_INK,
    backgroundColor: HEADER_FILL,
    align: header === "Mes" ? ("left" as const) : ("right" as const),
  }));
}

function buildFormulaRows(schedule: Schedule, currency: CurrencyCode): Row[] {
  return schedule.rows.map((scheduleRow, index) => {
    const sheetRow = ROW.firstData + index;
    // The first period draws from the principal cell; every later one draws
    // from the balance the previous row landed on.
    const previousBalance = index === 0 ? `$B$${ROW.principal}` : `G${sheetRow - 1}`;

    return [
      { value: scheduleRow.period, type: Number, align: "left" },
      formula(`=C${sheetRow}+D${sheetRow}+E${sheetRow}+F${sheetRow}`, currency),
      formula(`=ROUND(${previousBalance}*$B$${ROW.annualRate}/100/12,2)`, currency),
      // Capped at the outstanding balance so the final period pays the stub
      // rather than overshooting into a negative balance.
      formula(
        `=MIN(ROUND($B$${ROW.installment}-C${sheetRow},2),${previousBalance})`,
        currency,
      ),
      formula(
        `=IF(${previousBalance}>0,ROUND(${previousBalance}*$B$${ROW.lifePerMille}/1000+$B$${ROW.damageInsurance}+$B$${ROW.adminFee},2),0)`,
        currency,
      ),
      money(scheduleRow.extra, currency),
      formula(`=MAX(0,ROUND(${previousBalance}-D${sheetRow}-F${sheetRow},2))`, currency),
    ];
  });
}

function buildValueRows(schedule: Schedule, currency: CurrencyCode): Row[] {
  return schedule.rows.map((row) => [
    { value: row.period, type: Number, align: "left" },
    money(row.totalDue, currency),
    money(row.interest, currency),
    money(row.principal, currency),
    money(row.charges, currency),
    row.extra > 0 ? money(row.extra, currency, true) : money(row.extra, currency),
    money(row.closingBalance, currency),
  ]);
}

function buildTotalsRow(schedule: Schedule, currency: CurrencyCode): Row {
  const last = ROW.firstData + schedule.rows.length - 1;
  const sum = (column: string): Cell =>
    formula(`=SUM(${column}${ROW.firstData}:${column}${last})`, currency, true);

  return [
    { value: "Totales", fontWeight: "bold", textColor: INK },
    sum("B"),
    sum("C"),
    sum("D"),
    sum("E"),
    sum("F"),
    { value: "", type: String },
  ];
}

function buildSheetData(request: ExcelExportRequest): SheetData {
  const { comparison, currency, useFormulas } = request;
  const schedule = comparison.withExtras;

  return [
    ...buildInputBlock(request),
    buildHeaderRow(),
    ...(useFormulas
      ? buildFormulaRows(schedule, currency)
      : buildValueRows(schedule, currency)),
    buildTotalsRow(schedule, currency),
  ];
}

export async function exportScheduleToExcel(request: ExcelExportRequest): Promise<void> {
  const useFormulas = request.useFormulas && canUseFormulas(request.terms);
  const data = buildSheetData({ ...request, useFormulas });

  await writeXlsxFile(data, {
    sheet: "Amortización",
    // Freeze the input block and the column headers.
    stickyRowsCount: ROW.header,
    columns: [
      { width: 8 },
      { width: 16 },
      { width: 15 },
      { width: 15 },
      { width: 15 },
      { width: 15 },
      { width: 18 },
    ],
  }).toFile(toSafeFileName(request.title));
}
