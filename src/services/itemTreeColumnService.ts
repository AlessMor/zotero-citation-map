import { config } from "../../package.json";
import type { CitationGraphNode } from "../domain/graphTypes";
import {
  formatMetricValue,
  METRIC_DEFINITIONS,
  type MetricDefinition,
} from "./metricRegistry";
import { createMetricNodeForItem } from "./itemMetricContext";

const registeredDataKeys: string[] = [];
const descriptions = new Map<string, string>();
const tooltipHandlers = new Map<Window, EventListener>();
const VALUE_SEPARATOR = "\u001f";

interface EncodedCell {
  display: string;
  title: string;
  className?: string;
}

interface SupplementaryColumn {
  dataKey: string;
  label: string;
  description: string;
  width: number;
  value: (node: CitationGraphNode) => string | number | boolean | null;
  format: (value: string | number | boolean) => string;
}

const SUPPLEMENTARY_COLUMNS: SupplementaryColumn[] = [
  {
    dataKey: "openAccessStatus",
    label: "Open Access",
    description:
      "Whether the active scholarly-data provider reports that this work is openly accessible.",
    width: 104,
    value: (node) => node.isOpenAccess,
    format: (value) => (value ? "Yes" : "No"),
  },
  {
    dataKey: "retractionStatus",
    label: "Retracted",
    description:
      "Whether a trusted provider reports that this work has been retracted. Verify critical cases with the publisher.",
    width: 92,
    value: (node) => node.isRetracted,
    format: (value) => (value ? "Yes" : "No"),
  },
  {
    dataKey: "citationProvider",
    label: "Citation provider",
    description:
      "The provider supplying the canonical work identity and citation relationships for this item.",
    width: 126,
    value: (node) => node.provider,
    format: String,
  },
];

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function columnLabel(label: string, description: string): string {
  return `<span title="${escapeAttribute(description)}">${escapeAttribute(label)} <span aria-hidden="true">ⓘ</span></span>`;
}

function floatSortKey(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  const sign = 1n << 63n;
  bits = bits & sign ? ~bits & ((1n << 64n) - 1n) : bits ^ sign;
  return bits.toString(16).padStart(16, "0");
}

function stringSortKey(value: string): string {
  return value.toLocaleLowerCase().padEnd(64, " ").slice(0, 64);
}

function encodeCell(
  sortKey: string,
  display: string,
  title: string,
  className?: string,
): string {
  return `${sortKey}${VALUE_SEPARATOR}${JSON.stringify({ display, title, className })}`;
}

function decodeCell(data: string): EncodedCell | null {
  if (!data) return null;
  const separator = data.indexOf(VALUE_SEPARATOR);
  if (separator < 0) return { display: data, title: data };
  try {
    return JSON.parse(data.slice(separator + 1)) as EncodedCell;
  } catch {
    return null;
  }
}

function renderCell(
  data: string,
  column: { className: string },
  document: Document,
): HTMLElement {
  const span = document.createElement("span");
  span.className = `cell ${column.className}`;
  span.style.textAlign = "right";
  span.style.fontVariantNumeric = "tabular-nums";
  const decoded = decodeCell(data);
  if (decoded) {
    span.textContent = decoded.display;
    span.title = decoded.title;
    if (decoded.className) span.classList.add(decoded.className);
  }
  return span;
}

function metricData(spec: MetricDefinition, item: Zotero.Item): string {
  if (!item?.isRegularItem?.()) return "";
  const raw = spec.value(createMetricNodeForItem(item));
  if (typeof raw !== "number" || !Number.isFinite(raw)) return "";
  const display = formatMetricValue(spec.id, raw);
  return encodeCell(
    floatSortKey(raw),
    display,
    [spec.description, spec.interpretation, `Value: ${display}`]
      .filter(Boolean)
      .join("\n"),
  );
}

function supplementaryData(
  spec: SupplementaryColumn,
  item: Zotero.Item,
): string {
  if (!item?.isRegularItem?.()) return "";
  const value = spec.value(createMetricNodeForItem(item));
  if (value === null || value === undefined || value === "") return "";
  const display = spec.format(value);
  const sortKey =
    typeof value === "number"
      ? floatSortKey(value)
      : typeof value === "boolean"
        ? floatSortKey(value ? 1 : 0)
        : stringSortKey(String(value));
  return encodeCell(
    sortKey,
    display,
    `${spec.description}\nValue: ${display}`,
    spec.dataKey === "retractionStatus" && value === true
      ? "citation-map-column-warning"
      : undefined,
  );
}

async function registerColumn(options: {
  dataKey: string;
  label: string;
  description: string;
  width: number;
  primary: boolean;
  dataProvider: (item: Zotero.Item) => string;
}): Promise<void> {
  const dataKey = await (Zotero.ItemTreeManager.registerColumn as any)({
    dataKey: options.dataKey,
    label: options.label,
    htmlLabel: columnLabel(options.label, options.description),
    pluginID: config.addonID,
    // Zotero 9 replacement for deprecated defaultIn/disableIn properties.
    enabledTreeIDs: ["main"],
    width: String(options.width),
    minWidth: Math.min(options.width, 64),
    flex: 0,
    sortReverse: true,
    showInColumnPicker: true,
    columnPickerSubMenu: !options.primary,
    zoteroPersist: ["width", "ordinal", "hidden", "sortDirection"],
    dataProvider: options.dataProvider,
    renderCell: (
      _index: number,
      data: string,
      column: { className: string },
      _isFirstColumn: boolean,
      document: Document,
    ) => renderCell(data, column, document),
  });
  if (typeof dataKey === "string") {
    registeredDataKeys.push(dataKey);
    descriptions.set(dataKey, options.description);
  }
}

export function installCitationColumnTooltips(
  win: _ZoteroTypes.MainWindow,
): void {
  if (tooltipHandlers.has(win)) return;
  const handler: EventListener = (event) => {
    const target = event.target as Element | null;
    const cell = target?.closest?.(".virtualized-table-header .cell");
    if (!cell) return;
    for (const [dataKey, description] of descriptions) {
      if (!cell.classList.contains(dataKey)) continue;
      cell.setAttribute("title", description);
      cell.querySelector(".label")?.setAttribute("title", description);
      return;
    }
  };
  win.document.addEventListener("mouseover", handler, true);
  tooltipHandlers.set(win, handler);
}

export function uninstallCitationColumnTooltips(
  win: _ZoteroTypes.MainWindow,
): void {
  const handler = tooltipHandlers.get(win);
  if (!handler) return;
  win.document.removeEventListener("mouseover", handler, true);
  tooltipHandlers.delete(win);
}

export async function registerCitationColumns(): Promise<void> {
  if (registeredDataKeys.length) return;
  for (const spec of METRIC_DEFINITIONS) {
    if (!spec.column) continue;
    await registerColumn({
      dataKey: spec.id,
      label: spec.label,
      description: spec.description,
      width: spec.column.width,
      primary: spec.column.primary,
      dataProvider: (item) => metricData(spec, item),
    });
  }
  for (const spec of SUPPLEMENTARY_COLUMNS) {
    await registerColumn({
      ...spec,
      primary: false,
      dataProvider: (item) => supplementaryData(spec, item),
    });
  }
  refreshCitationColumns();
}

export function refreshCitationColumns(): void {
  try {
    Zotero.ItemTreeManager.refreshColumns();
  } catch (error) {
    Zotero.debug(`Citation Map: could not refresh columns: ${String(error)}`);
  }
}

export function unregisterCitationColumns(): void {
  for (const [win, handler] of tooltipHandlers) {
    win.document.removeEventListener("mouseover", handler, true);
  }
  tooltipHandlers.clear();
  descriptions.clear();
  for (const dataKey of registeredDataKeys.splice(0)) {
    try {
      Zotero.ItemTreeManager.unregisterColumn(dataKey);
    } catch (error) {
      Zotero.debug(
        `Citation Map: failed to unregister column ${dataKey}: ${String(error)}`,
      );
    }
  }
}
