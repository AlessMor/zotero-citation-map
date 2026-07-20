import type { CitationGraphNode, MetricID } from "../domain/graphTypes";

export type MetricGroup =
  | "Core"
  | "Impact"
  | "Status"
  | "Source"
  | "Library network"
  | "Bibliography"
  | "Data quality";

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
  itemPane: "summary" | "overview" | "advanced" | false;
  graph: {
    axis: boolean;
    logarithmic: boolean;
    nodeSize: boolean;
    nodeColor: boolean;
    filter: boolean;
  };
  value: (node: CitationGraphNode) => number | boolean | null;
}

const graphAll = {
  axis: true,
  logarithmic: true,
  nodeSize: true,
  nodeColor: true,
  filter: true,
};

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    id: "year",
    label: "Publication year",
    group: "Core",
    description: "The publication year stored on the Zotero item.",
    valueType: "integer",
    column: false,
    itemPane: false,
    graph: { ...graphAll, logarithmic: false, nodeSize: false },
    value: (node) => node.year,
  },
  {
    id: "citations",
    label: "Citations",
    group: "Core",
    description:
      "The aggregate number of works reported by the active provider as citing this paper.",
    interpretation:
      "Counts differ between scholarly indexes; the item pane shows the provider used.",
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
    description:
      "The provider-declared number of works in this paper's bibliography.",
    valueType: "integer",
    column: { primary: true, defaultVisible: true, width: 92 },
    itemPane: "summary",
    graph: graphAll,
    value: (node) => node.referenceCount,
  },
  {
    id: "citation-rate",
    label: "Citation rate",
    shortLabel: "Citations/year",
    group: "Core",
    description:
      "Average citations received per year over the three most recent complete calendar years.",
    interpretation: "Higher values indicate more recent citation activity.",
    valueType: "decimal",
    decimals: 2,
    column: { primary: true, defaultVisible: false, width: 112 },
    itemPane: "summary",
    graph: graphAll,
    value: (node) => node.citationVelocity,
  },
  {
    id: "citation-acceleration",
    label: "Citation acceleration",
    group: "Impact",
    description:
      "Citations in the last complete calendar year minus citations in the preceding year.",
    interpretation:
      "Positive values indicate rising citation activity; negative values indicate a decline.",
    valueType: "decimal",
    decimals: 2,
    allowsNegative: true,
    column: { primary: false, defaultVisible: false, width: 142 },
    itemPane: "overview",
    graph: { ...graphAll, logarithmic: false },
    value: (node) => node.citationAcceleration,
  },
  {
    id: "citations-last-year",
    label: "Citations last year",
    group: "Impact",
    description:
      "Citations received during the most recent complete calendar year.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 128 },
    itemPane: "overview",
    graph: graphAll,
    value: (node) => node.citationsLastYear,
  },
  {
    id: "fwci",
    label: "FWCI",
    group: "Impact",
    description:
      "Field-Weighted Citation Impact compares this paper with works from the same field, year and publication type. A value of 1 is the field average.",
    valueType: "decimal",
    decimals: 2,
    column: { primary: false, defaultVisible: false, width: 78 },
    itemPane: "overview",
    graph: graphAll,
    value: (node) => node.fwci,
  },
  {
    id: "citation-percentile",
    label: "Citation percentile",
    group: "Impact",
    description:
      "The paper's citation percentile among comparable works in its field and publication year.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 126 },
    itemPane: "overview",
    graph: { ...graphAll, logarithmic: false },
    value: (node) =>
      node.citationPercentile === null
        ? null
        : node.citationPercentile > 1
          ? node.citationPercentile / 100
          : node.citationPercentile,
  },
  {
    id: "influential-citations",
    label: "Influential citations",
    group: "Impact",
    description:
      "Citations classified by the provider as substantially influencing the citing work.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 132 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.influentialCitationCount,
  },
  {
    id: "two-year-mean-citedness",
    label: "2-year mean citedness",
    group: "Source",
    description:
      "Average citations received by recent works from this journal or source. This is a source-level metric, not a property of the individual paper.",
    valueType: "decimal",
    decimals: 2,
    column: { primary: false, defaultVisible: false, width: 150 },
    itemPane: "overview",
    graph: graphAll,
    value: (node) => node.sourceMetrics?.twoYearMeanCitedness ?? null,
  },
  {
    id: "journal-h-index",
    label: "Journal h-index",
    group: "Source",
    description:
      "The h-index reported for this paper's journal or source. This is a source-level metric.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 118 },
    itemPane: "overview",
    graph: graphAll,
    value: (node) => node.sourceMetrics?.hIndex ?? null,
  },
  {
    id: "journal-i10-index",
    label: "Journal i10-index",
    group: "Source",
    description:
      "Number of works from this journal or source with at least ten citations, when supplied by the provider.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 126 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.sourceMetrics?.i10Index ?? null,
  },
  {
    id: "library-coverage",
    label: "Library coverage",
    group: "Library network",
    description:
      "References linked to items anywhere in this Zotero library divided by the provider-declared reference count.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 124 },
    itemPane: "overview",
    graph: { ...graphAll, logarithmic: false },
    value: (node) => node.libraryCoverage,
  },
  {
    id: "local-global-impact",
    label: "Local/global impact",
    group: "Library network",
    description:
      "Citations received from papers in this Zotero library divided by the global provider citation count.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 132 },
    itemPane: "advanced",
    graph: { ...graphAll, logarithmic: false },
    value: (node) => node.localGlobalImpactRatio,
  },
  {
    id: "pagerank",
    label: "PageRank",
    group: "Library network",
    description:
      "Relative network importance calculated from citation links between papers in this Zotero library.",
    valueType: "decimal",
    decimals: 4,
    column: { primary: false, defaultVisible: false, width: 92 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.pageRank,
  },
  {
    id: "betweenness",
    label: "Betweenness",
    group: "Library network",
    description:
      "How often the paper lies on shortest citation paths between other papers in this library.",
    valueType: "decimal",
    decimals: 4,
    column: { primary: false, defaultVisible: false, width: 108 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.betweennessCentrality,
  },
  {
    id: "eigenvector",
    label: "Eigenvector centrality",
    group: "Library network",
    description:
      "Network importance that gives greater weight to links from other well-connected papers.",
    valueType: "decimal",
    decimals: 4,
    column: { primary: false, defaultVisible: false, width: 146 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.eigenvectorCentrality,
  },
  {
    id: "component-size",
    label: "Component size",
    group: "Library network",
    description:
      "Number of papers in the connected citation-network component containing this paper.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 116 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.componentSize,
  },
  {
    id: "citation-chain-depth",
    label: "Citation-chain depth",
    group: "Library network",
    description:
      "Longest directed citation path starting from this paper within the current library graph.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 138 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.citationChainDepth,
  },
  {
    id: "reference-coverage",
    label: "Reference coverage",
    group: "Bibliography",
    description:
      "Structured reference records retrieved from the provider divided by the provider-declared bibliography count.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 132 },
    itemPane: "advanced",
    graph: { ...graphAll, logarithmic: false },
    value: (node) => node.referenceCoverage,
  },
  {
    id: "reference-age-mean",
    label: "Mean reference age",
    group: "Bibliography",
    description:
      "Average number of years between this paper and the works in its retrieved bibliography.",
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
      "Standard deviation of reference ages in the retrieved bibliography.",
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
      "Estimated fraction of retrieved references sharing at least one author surname with this paper.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 152 },
    itemPane: "advanced",
    graph: { ...graphAll, logarithmic: false },
    value: (node) => node.selfCitationEstimate,
  },
  {
    id: "future-references",
    label: "Future-dated references",
    group: "Bibliography",
    description:
      "Retrieved references whose publication year is later than this paper's year; useful as a metadata diagnostic.",
    valueType: "integer",
    column: { primary: false, defaultVisible: false, width: 154 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.futureReferenceCount,
  },
  {
    id: "data-age",
    label: "Data age",
    group: "Data quality",
    description: "Days since citation data for this item were last refreshed.",
    valueType: "days",
    decimals: 0,
    column: { primary: false, defaultVisible: false, width: 92 },
    itemPane: "advanced",
    graph: graphAll,
    value: (node) => node.dataAgeDays,
  },
  {
    id: "metadata-completeness",
    label: "Metadata completeness",
    group: "Data quality",
    description:
      "Fraction of core identity fields available for matching and graph display.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 150 },
    itemPane: "advanced",
    graph: { ...graphAll, logarithmic: false },
    value: (node) => node.metadataCompleteness,
  },
  {
    id: "match-confidence",
    label: "Match confidence",
    group: "Data quality",
    description:
      "Confidence that the provider record corresponds to the Zotero item. Identifier matches are normally exact.",
    valueType: "percentage",
    decimals: 1,
    column: { primary: false, defaultVisible: false, width: 124 },
    itemPane: "advanced",
    graph: { ...graphAll, logarithmic: false },
    value: (node) => node.matchConfidence,
  },
];

const BY_ID = new Map(METRIC_DEFINITIONS.map((metric) => [metric.id, metric]));

export function getMetricDefinition(id: MetricID): MetricDefinition {
  const metric = BY_ID.get(id);
  if (!metric) throw new Error(`Unknown Citation Map metric: ${id}`);
  return metric;
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
    return `${new Intl.NumberFormat(undefined, {
      useGrouping: false,
      maximumFractionDigits: 0,
    }).format(value)} d`;
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
