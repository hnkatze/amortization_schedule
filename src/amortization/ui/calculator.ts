import { addCents, centsFromAmount, type Cents } from "../domain/money";
import {
  PREPAYMENT_STRATEGY,
  validateTerms,
  type ExtraPayment,
  type LoanTerms,
  type PrepaymentStrategy,
  type ValidationError,
} from "../domain/loan";
import type { LoanCharges } from "../domain/charges";
import { comparePrepayment, type PrepaymentComparison, type ScheduleRow } from "../domain/schedule";
import { canUseFormulas, exportScheduleToExcel } from "./exportExcel";
import { CURRENCY, formatDuration, formatMoney, isCurrencyCode, type CurrencyCode } from "./format";

type ElementConstructor<TElement extends Element> = abstract new () => TElement;

/**
 * Fails loudly instead of with a non-null assertion. If the markup and this
 * script ever drift apart, a thrown error naming the selector is far easier to
 * chase than a silent `null` surfacing three calls later.
 */
function requireElement<TElement extends Element>(
  selector: string,
  ctor: ElementConstructor<TElement>,
  root: ParentNode = document,
): TElement {
  const found = root.querySelector(selector);
  if (!(found instanceof ctor)) {
    throw new Error(`El elemento ${selector} no existe o no es del tipo esperado.`);
  }
  return found;
}

function numberFrom(input: HTMLInputElement): number {
  const parsed = Number.parseFloat(input.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const form = requireElement("#loan-form", HTMLFormElement);
const principalInput = requireElement("#principal", HTMLInputElement);
const rateInput = requireElement("#annual-rate", HTMLInputElement);
const termInput = requireElement("#term-months", HTMLInputElement);
const currencySelect = requireElement("#currency", HTMLSelectElement);
const lifeInsuranceInput = requireElement("#life-insurance", HTMLInputElement);
const damageInsuranceInput = requireElement("#damage-insurance", HTMLInputElement);
const adminFeeInput = requireElement("#admin-fee", HTMLInputElement);
const originationInput = requireElement("#origination", HTMLInputElement);
const extrasList = requireElement("#extra-payments", HTMLElement);
const extraTemplate = requireElement("#extra-row-template", HTMLTemplateElement);
const addExtraButton = requireElement("#add-extra", HTMLButtonElement);
const errorsPanel = requireElement("#form-errors", HTMLElement);
const statusRegion = requireElement("#calc-status", HTMLElement);
const resultsPanel = requireElement("#results", HTMLElement);
const savingsPanel = requireElement("#savings", HTMLElement);
const scheduleBody = requireElement("#schedule-body", HTMLTableSectionElement);
const scheduleScroll = requireElement("#schedule-scroll", HTMLElement);
const exportButton = requireElement("#export-excel", HTMLButtonElement);
const exportDialog = requireElement("#export-dialog", HTMLDialogElement);
const exportTitleInput = requireElement("#export-title", HTMLInputElement);
const formulaCheckbox = requireElement("#export-formulas", HTMLInputElement);
const formulaNote = requireElement("#export-formulas-note", HTMLElement);

const output = {
  payment: requireElement("#out-payment", HTMLElement),
  effective: requireElement("#out-effective", HTMLElement),
  effectiveHint: requireElement("#out-effective-hint", HTMLElement),
  term: requireElement("#out-term", HTMLElement),
  creditCost: requireElement("#out-credit-cost", HTMLElement),
  total: requireElement("#out-total", HTMLElement),
  interestSaved: requireElement("#out-interest-saved", HTMLElement),
  monthsSaved: requireElement("#out-months-saved", HTMLElement),
};

let extraRowCount = 0;

/** The last successful calculation, kept so the export does not recompute it. */
let lastResult: { readonly terms: LoanTerms; readonly comparison: PrepaymentComparison } | null =
  null;

function readCurrency(): CurrencyCode {
  const { value } = currencySelect;
  return isCurrencyCode(value) ? value : CURRENCY.hnl;
}

function readStrategy(): PrepaymentStrategy {
  const checked = form.querySelector('input[name="strategy"]:checked');
  return checked instanceof HTMLInputElement &&
    checked.value === PREPAYMENT_STRATEGY.reducePayment
    ? PREPAYMENT_STRATEGY.reducePayment
    : PREPAYMENT_STRATEGY.reduceTerm;
}

function readCharges(): LoanCharges {
  return {
    lifeInsurancePerMille: numberFrom(lifeInsuranceInput),
    damageInsurance: centsFromAmount(numberFrom(damageInsuranceInput)),
    adminFee: centsFromAmount(numberFrom(adminFeeInput)),
    originationPercent: numberFrom(originationInput),
  };
}

function readExtraPayments(): readonly ExtraPayment[] {
  const extras: ExtraPayment[] = [];

  for (const row of extrasList.querySelectorAll("[data-extra-row]")) {
    const periodField = row.querySelector("[data-extra-period]");
    const amountField = row.querySelector("[data-extra-amount]");
    if (!(periodField instanceof HTMLInputElement)) continue;
    if (!(amountField instanceof HTMLInputElement)) continue;

    const period = Number.parseInt(periodField.value, 10);
    const amount = Number.parseFloat(amountField.value);
    // A half-filled row is someone still typing, not an error to shout about.
    if (!Number.isFinite(period) || !Number.isFinite(amount) || amount <= 0) continue;

    extras.push({ period, amount: centsFromAmount(amount) });
  }

  return extras;
}

function readTerms(): LoanTerms {
  return {
    principal: centsFromAmount(Number.parseFloat(principalInput.value)),
    annualRatePercent: Number.parseFloat(rateInput.value),
    termMonths: Number.parseInt(termInput.value, 10),
    extraPayments: readExtraPayments(),
    strategy: readStrategy(),
    charges: readCharges(),
  };
}

function showErrors(messages: readonly string[], { keepResults = false } = {}): void {
  const list = document.createElement("ul");
  list.className = "list-disc space-y-1 pl-5";
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = message;
    list.append(item);
  }

  errorsPanel.replaceChildren(list);
  errorsPanel.hidden = false;
  if (!keepResults) resultsPanel.hidden = true;
}

function clearErrors(): void {
  errorsPanel.replaceChildren();
  errorsPanel.hidden = true;
}

/**
 * Restarts the highlight animation. Removing the class is not enough on its
 * own: without forcing a reflow the browser coalesces remove+add into no
 * change at all, and the animation never replays.
 */
function pulse(element: HTMLElement): void {
  element.classList.remove("value-pulse");
  void element.offsetWidth;
  element.classList.add("value-pulse");
}

function appendCell(row: HTMLTableRowElement, text: string, extraClass = ""): void {
  const cell = document.createElement("td");
  cell.className = `px-3 py-1.5 text-right tabular-nums ${extraClass}`.trim();
  cell.textContent = text;
  row.append(cell);
}

function renderSchedule(rows: readonly ScheduleRow[], currency: CurrencyCode): void {
  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const tableRow = document.createElement("tr");
    tableRow.className =
      row.extra > 0
        ? "bg-emerald-50/70 transition-colors dark:bg-emerald-950/40"
        : "transition-colors odd:bg-slate-50/60 hover:bg-sky-50 dark:odd:bg-slate-800/30 dark:hover:bg-sky-950/40";

    const period = document.createElement("th");
    period.scope = "row";
    period.className = "px-3 py-1.5 text-left font-medium tabular-nums";
    period.textContent = String(row.period);
    tableRow.append(period);

    appendCell(tableRow, formatMoney(row.totalDue, currency), "font-medium");
    appendCell(tableRow, formatMoney(row.interest, currency), "text-rose-600 dark:text-rose-400");
    appendCell(tableRow, formatMoney(row.principal, currency), "text-sky-700 dark:text-sky-400");
    appendCell(
      tableRow,
      row.charges > 0 ? formatMoney(row.charges, currency) : "·",
      row.charges > 0 ? "text-amber-700 dark:text-amber-400" : "text-slate-300",
    );
    appendCell(
      tableRow,
      row.extra > 0 ? formatMoney(row.extra, currency) : "·",
      row.extra > 0 ? "font-semibold text-emerald-700 dark:text-emerald-400" : "text-slate-300",
    );
    appendCell(tableRow, formatMoney(row.closingBalance, currency), "font-medium");

    fragment.append(tableRow);
  }

  scheduleBody.replaceChildren(fragment);
  // A fresh schedule is a different loan. Leaving the box parked at row 200
  // hides the change that was just made.
  scheduleScroll.scrollTop = 0;
}

function renderSummary(
  comparison: PrepaymentComparison,
  terms: LoanTerms,
  currency: CurrencyCode,
): void {
  const { withExtras, interestSaved, monthsSaved } = comparison;
  const firstInstalment: Cents = addCents(withExtras.firstPayment, withExtras.firstCharges);
  const creditCost: Cents = addCents(
    addCents(withExtras.totalInterest, withExtras.totalCharges),
    withExtras.originationFee,
  );

  output.payment.textContent = formatMoney(firstInstalment, currency);
  output.effective.textContent = `${withExtras.effectiveAnnualRatePercent.toFixed(2)} %`;
  output.effectiveHint.textContent = `nominal ${terms.annualRatePercent} %`;
  output.term.textContent = formatDuration(withExtras.months);
  output.creditCost.textContent = formatMoney(creditCost, currency);
  output.total.textContent = formatMoney(withExtras.totalCost, currency);

  for (const value of [
    output.payment,
    output.effective,
    output.term,
    output.creditCost,
    output.total,
  ]) {
    pulse(value);
  }

  const hasSavings = interestSaved > 0 || monthsSaved > 0;
  savingsPanel.hidden = !hasSavings;
  if (hasSavings) {
    output.interestSaved.textContent = formatMoney(interestSaved, currency);
    output.monthsSaved.textContent = formatDuration(monthsSaved);
  }

  statusRegion.textContent =
    `Cuota mensual ${formatMoney(firstInstalment, currency)}. ` +
    `Tasa efectiva ${withExtras.effectiveAnnualRatePercent.toFixed(2)} por ciento. ` +
    `Plazo ${formatDuration(withExtras.months)}.`;
}

function calculate(): void {
  const validation = validateTerms(readTerms());

  if (!validation.ok) {
    lastResult = null;
    exportButton.disabled = true;
    showErrors(validation.errors.map((error: ValidationError) => error.message));
    statusRegion.textContent = "Revisá los datos del préstamo.";
    return;
  }

  clearErrors();
  const currency = readCurrency();
  const comparison = comparePrepayment(validation.value);

  renderSummary(comparison, validation.value, currency);
  renderSchedule(comparison.withExtras.rows, currency);
  resultsPanel.hidden = false;
  lastResult = { terms: validation.value, comparison };
  exportButton.disabled = false;
}

function addExtraPaymentRow(): void {
  extraRowCount += 1;
  const index = extraRowCount;

  const fragment = extraTemplate.content.cloneNode(true);
  if (!(fragment instanceof DocumentFragment)) return;

  const periodInput = requireElement("[data-extra-period]", HTMLInputElement, fragment);
  const amountInput = requireElement("[data-extra-amount]", HTMLInputElement, fragment);
  const periodLabel = requireElement("[data-extra-period-label]", HTMLLabelElement, fragment);
  const amountLabel = requireElement("[data-extra-amount-label]", HTMLLabelElement, fragment);
  const removeButton = requireElement("[data-remove-extra]", HTMLButtonElement, fragment);

  // Every field needs its own id so its label points at exactly one input, and
  // the visible index tells a screen-reader user which prepayment they are on.
  periodInput.id = `extra-period-${index}`;
  amountInput.id = `extra-amount-${index}`;
  periodLabel.htmlFor = periodInput.id;
  amountLabel.htmlFor = amountInput.id;
  periodLabel.textContent = `Mes del abono ${index}`;
  amountLabel.textContent = `Monto del abono ${index}`;
  removeButton.setAttribute("aria-label", `Quitar abono ${index}`);

  removeButton.addEventListener("click", () => {
    removeButton.closest("[data-extra-row]")?.remove();
    addExtraButton.focus();
    calculate();
  });

  extrasList.append(fragment);
  periodInput.focus();
}

async function runExport(): Promise<void> {
  if (lastResult === null) return;

  exportButton.disabled = true;
  try {
    await exportScheduleToExcel({
      title: exportTitleInput.value.trim(),
      comparison: lastResult.comparison,
      currency: readCurrency(),
      terms: lastResult.terms,
      useFormulas: formulaCheckbox.checked,
    });
    statusRegion.textContent = "Archivo de Excel descargado.";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "causa desconocida";
    showErrors([`No se pudo generar el Excel: ${reason}`], { keepResults: true });
    statusRegion.textContent = "No se pudo generar el Excel.";
  } finally {
    exportButton.disabled = false;
  }
}

addExtraButton.addEventListener("click", addExtraPaymentRow);

exportButton.addEventListener("click", () => {
  if (lastResult === null) return;

  // Formulas assume one fixed installment for the whole loan, which the
  // "reduce the installment" strategy breaks. Say so instead of exporting a
  // sheet that quietly disagrees with the table on screen.
  const formulasPossible = canUseFormulas(lastResult.terms);
  formulaCheckbox.disabled = !formulasPossible;
  if (!formulasPossible) formulaCheckbox.checked = false;
  formulaNote.hidden = formulasPossible;

  exportDialog.showModal();
  exportTitleInput.select();
});

// `method="dialog"` closes the dialog and reports which button submitted it,
// so no manual close handling or backdrop wiring is needed.
exportDialog.addEventListener("close", () => {
  if (exportDialog.returnValue !== "confirm") return;
  void runExport();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  calculate();
});
// `change` fires on blur for text fields, so the table refreshes when a value
// is actually settled rather than on every keystroke.
form.addEventListener("change", calculate);

calculate();
