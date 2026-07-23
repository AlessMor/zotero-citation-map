import type { CitationGraphNode, MetricID } from "../domain/graphTypes";

export type MetricGroup =
  "Core" | "Impact" | "Source" | "Library" | "Bibliography" | "Data quality";

export type MetricValueType =
  "integer" | "decimal" | "percentage" | "boolean" | "days";

export interface MetricDefinition {
  id: MetricID;
  label: string;
  shortLabel?: string;
  group: MetricGroup;
  description: string;
  interpretation?: string;
  valueType: MetricValueType;
  decimals?: number;
  allowsNegative?: boolean;
  column:
    | false
    | {
        primary: boolean;
        defaultVisible: boolean;
        width: number;
      };
  itemPane: "summary" | "advanced" | false;
  graph: {
    axis: boolean;
    logarithmic: boolean;
    nodeSize: boolean;
    nodeColor: boolean;
    filter: boolean;
  };
  value: (node: CitationGraphNode) => number | boolean | null;
}

export interface SupplementaryPropertyDefinition {
  id: string;
  label: string;
  description: string;
  group: MetricGroup;
  column:
    | false
    | {
        primary: boolean;
        defaultVisible: boolean;
        width: number;
      };
  itemPane: "summary" | "advanced" | false;
  graph: {
    nodeColor: boolean;
    filter: boolean;
  };
  value: (node: CitationGraphNode) => string | boolean | null;
  format: (value: string | boolean) => string;
}

const graphAll = {
  axis: true,
  logarithmic: true,
  nodeSize: true,
  nodeColor: true,
  filter: true,
};
const graphLinear = { ...graphAll, logarithmic: false };

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    id: "year",
    label: "Publication year",
    group: "Core",
    description: "Publication year stored in the Zotero item.",
    valueType: "integer",
    column: false,
    itemPane: false,
    graph: { ...graphLinear, nodeSize: false },
    value: (node) => node.year,
  },
  {
    id: "citations",
    label: "Citations",
    group: "Core",
    description: "Number of works known to cite this paper.",
    valueType: "integer",
    column: { primary: true, defaultVisible: true, width: 88 },
    itemPane: "summary",
    graph: graphAll,
    value: (node) => node.citationCount,
  },
  {
    id: "references",
    label: "References",
    group: "Core",
    description: "Number of works known to be referenced by this paper.",
    valueType: "integer",
    column: { primary: true, defaultVisible: true, width: 92 },
    itemPane: "summary",
    graph: graphAll,
    value: (node) => node.referenceCount,
  },
  {
    id: "citations-last-year",
    label: "Citations last year",
    group: "Impact",
    description:
      "Citations received during the most recent complete calendar year.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 128 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.citationsLastYear,
  },
  {
    id: "citation-rate",
    label: "Recent citation rate",
    shortLabel: "Citation rate",
    group: "Impact",
    description:
      "Average citations received per year over the three most recent complete calendar years.",
    valueType: "decimal",
    decimals: 2,
    column: { primary: false, defaultVisible: false, width: 124 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.citationVelocity,
  },
  {
    id: "citation-acceleration",
    label: "Change in annual citations",
    shortLabel: "Annual citation change",
    group: "Impact",
    description:
      "Citations in the most recent complete calendar year minus citations in the preceding year. Positive values indicate growth; negative values indicate decline.",
    valueType: "decimal",
    decimals: 0,
    allowsNegative: true,
    column: { primary: false, defaultVisible: false, width: 154 },
    itemPane: "advanced",
    graph: graphLinear,
    value: (node) => node.citationAcceleration,
  },
  {
    id: "fwci",
    label: "FWCI",
    group: "Impact",
    description:
      "Field-Weighted Citation Impact reported by OpenAlex: citations received divided by the expected citations for comparable works. A value of 1 is approximately expected.",
    valueType: "decimal",
    decimals: 2,
    column: { primary: false, defaultVisible: false, width: 78 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.fwci,
  },
  {
    id: "citation-percentile",
    label: "Citation percentile",
    group: "Impact",
    description:
      "OpenAlex citation percentile among works of the same type, publication year and subfield.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 126 },
    itemPane: "advanced",
    graph: graphLinear,
    value: (node) =>
      node.citationPercentile === null
        ? null
        : node.citationPercentile > 1
          ? node.citationPercentile / 100
          : node.citationPercentile,
  },
  {
    id: "influential-citations",
    label: "Highly influential citations",
    group: "Impact",
    description:
      "Number of citing works classified by Semantic Scholar as substantially influenced by this paper. The machine-generated classification is available only where sufficient citing-paper text can be analysed.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 160 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.influentialCitationCount,
  },
  {
    id: "journal-h-index",
    label: "Journal h-index",
    group: "Source",
    description:
      "OpenAlex source h-index: the largest h for which the journal has at least h works cited at least h times.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 118 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.sourceMetrics?.hIndex ?? null,
  },
  {
    id: "journal-i10-index",
    label: "Journal i10-index",
    group: "Source",
    description:
      "Number of works from the journal or source that OpenAlex reports as having at least ten citations.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 126 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.sourceMetrics?.i10Index ?? null,
  },
  {
    id: "two-year-mean-citedness",
    label: "Journal 2-year mean citedness",
    group: "Source",
    description:
      "OpenAlex source metric measuring the recent average citation activity of works from this journal or source.",
    valueType: "decimal",
    decimals: 2,
    column: { primary: false, defaultVisible: false, width: 172 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.sourceMetrics?.twoYearMeanCitedness ?? null,
  },
  {
    id: "library-coverage",
    label: "Connections in library",
    group: "Library",
    description:
      "Number of citation connections between this paper and papers in the current Zotero library. Incoming and outgoing connections are combined.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 140 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) =>
      Math.max(
        0,
        node.incomingLibraryCitations + node.outgoingLibraryReferences,
      ),
  },
  {
    id: "reference-coverage",
    label: "Reference coverage",
    group: "Bibliography",
    description:
      "Retrieved structured references divided by the reported bibliography size.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 132 },
    itemPane: "advanced",
    graph: graphLinear,
    value: (node) => node.referenceCoverage,
  },
  {
    id: "reference-age-mean",
    label: "Mean reference age",
    group: "Bibliography",
    description:
      "Mean publication-age difference between this paper and its externally retrieved structured references. Displayed only with at least five usable references and at least 25% reference coverage.",
    valueType: "decimal",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 134 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.referenceAgeMean,
  },
  {
    id: "reference-age-spread",
    label: "Reference-age spread",
    group: "Bibliography",
    description:
      "Standard deviation of reference ages among externally retrieved structured references. Displayed only with at least five usable references and at least 25% reference coverage.",
    valueType: "decimal",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 138 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.referenceAgeSpread,
  },
  {
    id: "self-citation-estimate",
    label: "Estimated self-citations",
    group: "Bibliography",
    description:
      "Estimated share of externally retrieved structured references sharing an author identifier, or a normalized surname when identifiers are unavailable. Displayed only with at least five comparable references and at least 25% reference coverage.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 152 },
    itemPane: "advanced",
    graph: graphLinear,
    value: (node) => node.selfCitationEstimate,
  },
  {
    id: "metadata-completeness",
    label: "Metadata completeness",
    group: "Data quality",
    description:
      "Percentage of six Zotero metadata categories populated: title, creators, publication year, publication source, abstract and at least one external identifier.",
    valueType: "percentage",
    decimals: 0,
    column: { primary: false, defaultVisible: false, width: 150 },
    itemPane: "advanced",
    graph: graphLinear,
    value: (node) => node.metadataCompleteness,
  },
];

export const SUPPLEMENTARY_PROPERTY_DEFINITIONS: SupplementaryPropertyDefinition[] =
  [
    {
      id: "openAccessStatus",
      label: "Open Access",
      description:
        "Open-access status reported by scholarly-data providers. Detailed values may include Gold, Diamond, Hybrid, Green, Bronze or Open.",
      group: "Data quality",
      column: { primary: false, defaultVisible: false, width: 104 },
      itemPane: "advanced",
      graph: { nodeColor: true, filter: true },
      value: (node) => node.openAccessStatus ?? node.isOpenAccess,
      format: (value) =>
        typeof value === "boolean"
          ? value
            ? "Open"
            : "Closed"
          : String(value),
    },
    {
      id: "retractionStatus",
      label: "Retracted",
      description:
        "Whether a scholarly-data provider reports that this work has been retracted. Verify critical cases with the publisher.",
      group: "Data quality",
      column: { primary: false, defaultVisible: false, width: 92 },
      itemPane: "advanced",
      graph: { nodeColor: true, filter: true },
      value: (node) => node.isRetracted,
      format: (value) => (value === true ? "Yes" : "No"),
    },
    {
      id: "lastUpdate",
      label: "Last update",
      description:
        "Date and time of the most recent successful general citation-data refresh for this paper.",
      group: "Data quality",
      column: { primary: false, defaultVisible: false, width: 150 },
      itemPane: "advanced",
      graph: { nodeColor: false, filter: false },
      value: (node) => node.metricsUpdatedAt,
      format: (value) =>
        typeof value === "string" && value
          ? new Date(value).toLocaleString()
          : "—",
    },
    {
      id: "matchMethod",
      label: "Match method",
      description:
        "Identifier or metadata field used to match the Zotero item to the external scholarly record.",
      group: "Data quality",
      column: { primary: false, defaultVisible: false, width: 112 },
      itemPane: "advanced",
      graph: { nodeColor: false, filter: false },
      value: (node) => node.matchedBy,
      format: (value) =>
        String(value)
          .replace("arxiv", "arXiv ID")
          .replace("pmid", "PMID")
          .replace("doi", "DOI")
          .replace("isbn", "ISBN")
          .replace("title", "Exact title"),
    },
  ];

const BY_ID = new Map(METRIC_DEFINITIONS.map((metric) => [metric.id, metric]));
const PROPERTY_BY_ID = new Map<
  string,
  MetricDefinition | SupplementaryPropertyDefinition
>();
for (const property of METRIC_DEFINITIONS) {
  PROPERTY_BY_ID.set(property.id, property);
}
for (const property of SUPPLEMENTARY_PROPERTY_DEFINITIONS) {
  PROPERTY_BY_ID.set(property.id, property);
}

export function getMetricDefinition(id: MetricID): MetricDefinition {
  const metric = BY_ID.get(id);
  if (!metric) throw new Error(`Unknown Citation Map metric: ${id}`);
  return metric;
}

export function getPropertyDefinition(id: string) {
  return PROPERTY_BY_ID.get(id) ?? null;
}

export function metricValue(
  node: CitationGraphNode,
  id: MetricID,
): number | boolean | null {
  return getMetricDefinition(id).value(node);
}

export function formatMetricValue(
  id: MetricID,
  value: number | boolean | null,
): string {
  if (value === null || value === undefined) return "—";
  const definition = getMetricDefinition(id);
  if (definition.valueType === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (definition.valueType === "percentage") {
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      useGrouping: false,
      maximumFractionDigits: definition.decimals ?? 1,
    }).format(value);
  }
  if (definition.valueType === "days") {
    return `${new Intl.NumberFormat(undefined, { useGrouping: false, maximumFractionDigits: 0 }).format(value)} d`;
  }
  return new Intl.NumberFormat(undefined, {
    useGrouping: false,
    maximumFractionDigits:
      definition.valueType === "integer" ? 0 : (definition.decimals ?? 2),
  }).format(value);
}

export function metricTooltip(id: MetricID): string {
  const metric = getMetricDefinition(id);
  return [metric.description, metric.interpretation].filter(Boolean).join("\n");
}

export function axisMetricDefinitions(): MetricDefinition[] {
  return METRIC_DEFINITIONS.filter((metric) => metric.graph.axis);
}
export function nodeSizeMetricDefinitions(): MetricDefinition[] {
  return METRIC_DEFINITIONS.filter((metric) => metric.graph.nodeSize);
}
export function nodeColorMetricDefinitions(): MetricDefinition[] {
  return METRIC_DEFINITIONS.filter((metric) => metric.graph.nodeColor);
}
