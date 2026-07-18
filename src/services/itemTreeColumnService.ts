import { config } from "../../package.json";
import type { CitationMetricSummary } from "../domain/citationTypes";
import type { CitationDerivedAnalytics } from "./citationAnalyticsService";
import { getItemCitationAnalytics } from "./citationAnalyticsService";
import { getItemCitationMetrics } from "./citationMetricsStore";

const registeredDataKeys: string[] = [];
const VALUE_SEPARATOR = "\u001f";

type ColumnKind = "integer" | "decimal" | "percentage";
type ColumnValue = number | null;

interface ColumnContext {
  metrics: CitationMetricSummary;
  analytics: CitationDerivedAnalytics | null;
}

interface ColumnSpec {
  dataKey: string;
  label: string;
  width: number;
  kind: ColumnKind;
  decimals?: number;
  value: (context: ColumnContext) => ColumnValue;
  title?: (context: ColumnContext, display: string) => string;
  primary?: boolean;
}

interface EncodedCell {
  display: string;
  title: string;
}

function getContext(item: Zotero.Item): ColumnContext | null {
  if (!item?.isRegularItem?.()) return null;
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  return {
    metrics: getItemCitationMetrics(libraryID, itemKey),
    analytics: getItemCitationAnalytics(libraryID, itemKey),
  };
}

function floatSortKey(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  const signBit = 1n << 63n;
  bits = bits & signBit ? ~bits & ((1n << 64n) - 1n) : bits ^ signBit;
  return bits.toString(16).padStart(16, "0");
}

function formatValue(value: number, kind: ColumnKind, decimals = 2): string {
  if (kind === "percentage") {
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: decimals,
    }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: kind === "integer" ? 0 : decimals,
  }).format(value);
}

function encodeCell(spec: ColumnSpec, item: Zotero.Item): string {
  const context = getContext(item);
  if (!context) return "";
  const value = spec.value(context);
  if (value === null || !Number.isFinite(value)) return "";
  const display = formatValue(value, spec.kind, spec.decimals);
  const encoded: EncodedCell = {
    display,
    title: spec.title?.(context, display) ?? display,
  };
  return `${floatSortKey(value)}${VALUE_SEPARATOR}${JSON.stringify(encoded)}`;
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
  }
  return span;
}

const COLUMN_SPECS: ColumnSpec[] = [
  {
    dataKey: "citationCount",
    label: "Citations",
    width: 88,
    kind: "integer",
    primary: true,
    value: ({ metrics }) => metrics.citationCount,
  },
  {
    dataKey: "referenceCount",
    label: "References",
    width: 92,
    kind: "integer",
    primary: true,
    value: ({ metrics }) => metrics.referenceCount,
  },
  {
    dataKey: "libraryCoverage",
    label: "Library Coverage",
    width: 112,
    kind: "percentage",
    decimals: 1,
    value: ({ analytics }) => analytics?.libraryCoverage ?? null,
    title: (_context, display) =>
      `${display} of declared references connect to items in this Zotero library`,
  },
  {
    dataKey: "citationVelocity",
    label: "Citation Velocity",
    width: 116,
    kind: "decimal",
    decimals: 2,
    value: ({ metrics }) => metrics.citationVelocity,
    title: (_context, display) =>
      `${display} citations/year averaged over the last three complete years`,
  },
  {
    dataKey: "citationAcceleration",
    label: "Citation Acceleration",
    width: 130,
    kind: "decimal",
    decimals: 2,
    value: ({ metrics }) => metrics.citationAcceleration,
    title: (_context, display) =>
      `${display}: citations last complete year minus the preceding year`,
  },
];

export async function registerCitationColumns(): Promise<void> {
  if (registeredDataKeys.length > 0) return;
  for (const spec of COLUMN_SPECS) {
    const dataKey = await Zotero.ItemTreeManager.registerColumn({
      dataKey: spec.dataKey,
      label: spec.label,
      pluginID: config.addonID,
      enabledTreeIDs: ["main"],
      width: String(spec.width),
      minWidth: Math.min(spec.width, 64),
      flex: 0,
      sortReverse: true,
      showInColumnPicker: true,
      columnPickerSubMenu: !spec.primary,
      zoteroPersist: ["width", "ordinal", "hidden", "sortDirection"],
      dataProvider: (item: Zotero.Item) => encodeCell(spec, item),
      renderCell: (
        _index: number,
        data: string,
        column: { className: string },
        _isFirstColumn: boolean,
        document: Document,
      ) => renderCell(data, column, document),
    });
    if (typeof dataKey === "string") registeredDataKeys.push(dataKey);
  }
  Zotero.ItemTreeManager.refreshColumns();
}

export function refreshCitationColumns(): void {
  Zotero.ItemTreeManager.refreshColumns();
}

export function unregisterCitationColumns(): void {
  for (const dataKey of registeredDataKeys.splice(0)) {
    try {
      Zotero.ItemTreeManager.unregisterColumn(dataKey);
    } catch (error) {
      Zotero.debug(`Citation Map: failed to unregister column ${dataKey}: ${error}`);
    }
  }
}
