import { config } from "../../package.json";
import type {
  CitationMetricSummary,
  CitationProviderID,
} from "../domain/citationTypes";
import { getItemCitationMetrics } from "./citationMetricsStore";

const registeredDataKeys: string[] = [];
const SORT_WIDTH = 12;

const PROVIDER_LABELS: Record<CitationProviderID, string> = {
  openalex: "OpenAlex",
  "semantic-scholar": "Semantic Scholar",
  crossref: "Crossref",
  opencitations: "OpenCitations",
  inspire: "INSPIRE-HEP",
};

type MetricName = "citationCount" | "referenceCount";

function getMetrics(item: Zotero.Item): CitationMetricSummary | null {
  if (!item?.isRegularItem?.()) {
    return null;
  }

  return getItemCitationMetrics(Number(item.libraryID), String(item.key));
}

function providerLabel(provider: CitationProviderID | null): string {
  return provider ? PROVIDER_LABELS[provider] : "unknown provider";
}

function getColumnData(item: Zotero.Item, metric: MetricName): string {
  const metrics = getMetrics(item);
  const value = metrics?.[metric] ?? null;

  if (value === null) {
    return "";
  }

  const source =
    metric === "citationCount"
      ? metrics?.citationCountProvider
      : metrics?.referenceCountProvider;

  return [
    String(value).padStart(SORT_WIDTH, "0"),
    source ?? "",
    String(metrics?.resolvedReferenceCount ?? 0),
  ].join("|");
}

function renderNumericCell(
  data: string,
  metric: MetricName,
  column: { className: string },
  document: Document,
): HTMLElement {
  const span = document.createElement("span");
  span.className = `cell ${column.className}`;
  span.style.textAlign = "right";

  if (!data) {
    return span;
  }

  const [sortValue, providerValue, resolvedValue] = data.split("|");
  const value = Number(sortValue);
  const provider = providerValue ? (providerValue as CitationProviderID) : null;

  span.textContent = Number.isFinite(value) ? String(value) : "";

  if (metric === "citationCount") {
    span.title = `${value} citations · ${providerLabel(provider)}`;
  } else {
    const resolved = Number(resolvedValue);
    const coverageText =
      Number.isFinite(resolved) && resolved !== value
        ? ` · ${resolved} structured references cached for the graph`
        : "";

    span.title =
      `${value} references · ${providerLabel(provider)}` + coverageText;
  }

  return span;
}

export async function registerCitationColumns(): Promise<void> {
  if (registeredDataKeys.length > 0) {
    return;
  }

  const columns = [
    {
      dataKey: "citationCount",
      label: "Citations",
      pluginID: config.addonID,
      enabledTreeIDs: ["main"],
      width: "88",
      minWidth: 64,
      flex: 0,
      sortReverse: true,
      showInColumnPicker: true,
      zoteroPersist: ["width", "ordinal", "hidden", "sortDirection"],
      dataProvider: (item: Zotero.Item) => getColumnData(item, "citationCount"),
      renderCell: (
        _index: number,
        data: string,
        column: { className: string },
        _isFirstColumn: boolean,
        document: Document,
      ) => renderNumericCell(data, "citationCount", column, document),
    },
    {
      dataKey: "referenceCount",
      label: "References",
      pluginID: config.addonID,
      enabledTreeIDs: ["main"],
      width: "92",
      minWidth: 70,
      flex: 0,
      sortReverse: true,
      showInColumnPicker: true,
      zoteroPersist: ["width", "ordinal", "hidden", "sortDirection"],
      dataProvider: (item: Zotero.Item) =>
        getColumnData(item, "referenceCount"),
      renderCell: (
        _index: number,
        data: string,
        column: { className: string },
        _isFirstColumn: boolean,
        document: Document,
      ) => renderNumericCell(data, "referenceCount", column, document),
    },
  ];

  for (const column of columns) {
    const dataKey = await Zotero.ItemTreeManager.registerColumn(column);

    if (typeof dataKey === "string") {
      registeredDataKeys.push(dataKey);
    }
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
      Zotero.debug(
        `Citation Map: failed to unregister column ${dataKey}: ${error}`,
      );
    }
  }
}
