import { config } from "../../package.json";
import {
  formatMetricValue,
  METRIC_DEFINITIONS,
  SUPPLEMENTARY_PROPERTY_DEFINITIONS,
  type MetricDefinition,
  type SupplementaryPropertyDefinition,
} from "./metricRegistry";
import { createMetricNodeForItem } from "./itemMetricContext";
import {
  installDataSourceHoverTooltips,
  nodeFieldDataSourceTooltip,
  uninstallDataSourceHoverTooltips,
} from "./dataSourceTooltipService";
import { getShowMetricTooltipsEnabled } from "./citationPreferences";

const registeredDataKeys: string[] = [];
const descriptions = new Map<string, string>();
const tooltipHandlers = new Map<Window, EventListener>();
const pendingColumnResorts = new Map<
  _ZoteroTypes.MainWindow,
  ReturnType<typeof setTimeout>
>();
const activeColumnResorts = new Map<_ZoteroTypes.MainWindow, Promise<void>>();
const VALUE_SEPARATOR = "\u001f";
const COLUMN_RESORT_DELAY_MS = 100;
const SORT_KEY_FIRST_LETTER_CODE = "a".charCodeAt(0);

type ColumnMetricNode = ReturnType<typeof createMetricNodeForItem>;

interface ItemTreeForColumnRefresh {
  getSortField?: () => string;
  sort?: () => Promise<void> | void;
}

function clearPendingColumnResorts(): void {
  for (const timer of pendingColumnResorts.values()) {
    clearTimeout(timer);
  }
  pendingColumnResorts.clear();
}

async function resortActiveCitationColumn(
  win: _ZoteroTypes.MainWindow,
): Promise<void> {
  if (win.closed) return;
  const itemTree = (win as any).ZoteroPane?.itemsView as
    ItemTreeForColumnRefresh | false | undefined;
  if (!itemTree || !itemTree.getSortField || !itemTree.sort) return;

  const sortField = itemTree.getSortField();
  if (!registeredDataKeys.includes(sortField)) return;

  const startedAt = Date.now();
  try {
    resetColumnMetricNodeCache();
    await itemTree.sort();
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 500) {
      Zotero.debug(
        `Citation Map: resorted active metric column in ${durationMs} ms`,
      );
    }
  } catch (error) {
    Zotero.debug(
      `Citation Map: could not resort active metric column: ${String(error)}`,
    );
  }
}

function scheduleActiveCitationColumnResort(): void {
  for (const win of Zotero.getMainWindows()) {
    if (win.closed) continue;
    const previous = pendingColumnResorts.get(win);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      pendingColumnResorts.delete(win);
      const previous = activeColumnResorts.get(win) ?? Promise.resolve();
      const next = previous
        .then(() => resortActiveCitationColumn(win))
        .finally(() => {
          if (activeColumnResorts.get(win) === next) {
            activeColumnResorts.delete(win);
          }
        });
      activeColumnResorts.set(win, next);
    }, COLUMN_RESORT_DELAY_MS);
    pendingColumnResorts.set(win, timer);
  }
}

let columnMetricNodeCache = new WeakMap<Zotero.Item, ColumnMetricNode>();
let columnMetricNodeCacheResetScheduled = false;

function resetColumnMetricNodeCache(): void {
  columnMetricNodeCache = new WeakMap<Zotero.Item, ColumnMetricNode>();
  columnMetricNodeCacheResetScheduled = false;
}

function getColumnMetricNode(item: Zotero.Item): ColumnMetricNode {
  const cached = columnMetricNodeCache.get(item);
  if (cached) return cached;

  const node = createMetricNodeForItem(item, { includeReferences: false });
  columnMetricNodeCache.set(item, node);
  if (!columnMetricNodeCacheResetScheduled) {
    columnMetricNodeCacheResetScheduled = true;
    // Zotero may request cells across several event-loop turns during a
    // virtualized table refresh. Keep the per-item node briefly so every
    // visible Citation Map column reuses the same lightweight context.
    setTimeout(resetColumnMetricNodeCache, 250);
  }
  return node;
}

interface EncodedCell {
  display: string;
  title: string;
  className?: string;
}

type SupplementaryColumn = SupplementaryPropertyDefinition;

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
  const hexadecimal = bits.toString(16).padStart(16, "0");
  // Zotero uses natural collation, which splits digit runs inside hexadecimal
  // keys. Mapping each nibble to a-p preserves byte order as plain text.
  return Array.from(hexadecimal, (digit) =>
    String.fromCharCode(
      SORT_KEY_FIRST_LETTER_CODE + Number.parseInt(digit, 16),
    ),
  ).join("");
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
    if (decoded.title) span.title = decoded.title;
    if (decoded.className) span.classList.add(decoded.className);
  }
  return span;
}

function metricData(spec: MetricDefinition, item: Zotero.Item): string {
  if (!item?.isRegularItem?.()) return "";
  const node = getColumnMetricNode(item);
  const raw = spec.value(node);
  if (typeof raw !== "number" || !Number.isFinite(raw)) return "";
  const display = formatMetricValue(spec.id, raw);
  return encodeCell(
    floatSortKey(raw),
    display,
    getShowMetricTooltipsEnabled()
      ? nodeFieldDataSourceTooltip(node, spec.id, item)
      : "",
  );
}

function supplementaryData(
  spec: SupplementaryColumn,
  item: Zotero.Item,
): string {
  if (!item?.isRegularItem?.()) return "";
  const node = getColumnMetricNode(item);
  const value = spec.value(node);
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
    getShowMetricTooltipsEnabled()
      ? nodeFieldDataSourceTooltip(node, spec.id, item)
      : "",
    spec.id === "retractionStatus" && value === true
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
    if (!getShowMetricTooltipsEnabled()) return;
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
  installDataSourceHoverTooltips(win.document);
  tooltipHandlers.set(win, handler);
}

export function uninstallCitationColumnTooltips(
  win: _ZoteroTypes.MainWindow,
): void {
  const handler = tooltipHandlers.get(win);
  if (!handler) return;
  win.document.removeEventListener("mouseover", handler, true);
  uninstallDataSourceHoverTooltips(win.document);
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
  for (const spec of SUPPLEMENTARY_PROPERTY_DEFINITIONS) {
    if (!spec.column) continue;
    await registerColumn({
      dataKey: spec.id,
      label: spec.label,
      description: spec.description,
      width: spec.column.width,
      primary: spec.column.primary,
      dataProvider: (item) => supplementaryData(spec, item),
    });
  }
  refreshCitationColumns();
}

export function refreshCitationColumns(): void {
  resetColumnMetricNodeCache();
  const startedAt = Date.now();
  try {
    Zotero.ItemTreeManager.refreshColumns();
    scheduleActiveCitationColumnResort();
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 500) {
      Zotero.debug(
        `Citation Map: refreshed item-tree columns in ${durationMs} ms`,
      );
    }
  } catch (error) {
    Zotero.debug(`Citation Map: could not refresh columns: ${String(error)}`);
  }
}

export function unregisterCitationColumns(): void {
  resetColumnMetricNodeCache();
  clearPendingColumnResorts();
  for (const [win, handler] of tooltipHandlers) {
    win.document.removeEventListener("mouseover", handler, true);
    uninstallDataSourceHoverTooltips(win.document);
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
