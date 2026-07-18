import type { CitationGraphNode, GraphAxisMetric } from "../domain/graphTypes";

export type GraphMetricGroup = "Core" | "Impact";

export interface GraphMetricOption {
  metric: GraphAxisMetric;
  label: string;
  group: GraphMetricGroup;
}

export const GRAPH_AXIS_OPTIONS: GraphMetricOption[] = [
  { metric: "none", label: "Force layout", group: "Core" },
  { metric: "year", label: "Publication year", group: "Core" },
  { metric: "citations", label: "Global citations", group: "Core" },
  { metric: "references", label: "References", group: "Core" },
  { metric: "library-coverage", label: "Library coverage", group: "Impact" },
  { metric: "citation-velocity", label: "Citation velocity", group: "Impact" },
  {
    metric: "citation-acceleration",
    label: "Citation acceleration",
    group: "Impact",
  },
];

const LABELS = new Map(GRAPH_AXIS_OPTIONS.map((option) => [option.metric, option.label]));

export function graphMetricLabel(metric: GraphAxisMetric): string {
  return LABELS.get(metric) ?? metric;
}

export function graphMetricValue(
  node: CitationGraphNode,
  metric: GraphAxisMetric,
): number | null {
  switch (metric) {
    case "none":
      return null;
    case "year":
      return node.year;
    case "citations":
      return node.citationCount;
    case "references":
      return node.referenceCount;
    case "library-coverage":
      return node.libraryCoverage;
    case "citation-velocity":
      return node.citationVelocity;
    case "citation-acceleration":
      return node.citationAcceleration;
  }
}

export function graphMetricIsPercentage(metric: GraphAxisMetric): boolean {
  return metric === "library-coverage";
}

export function graphMetricIsBoolean(_metric: GraphAxisMetric): boolean {
  return false;
}

export function graphMetricAllowsNegative(metric: GraphAxisMetric): boolean {
  return metric === "citation-acceleration";
}

export function graphMetricSupportsLog(metric: GraphAxisMetric): boolean {
  return (
    metric !== "none" &&
    metric !== "year" &&
    !graphMetricIsPercentage(metric) &&
    !graphMetricAllowsNegative(metric)
  );
}

export function formatGraphMetricValue(
  metric: GraphAxisMetric,
  value: number,
): string {
  if (metric === "year") return String(Math.round(value));
  if (graphMetricIsPercentage(metric)) {
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(value);
  }
  if (metric === "citation-velocity" || metric === "citation-acceleration") {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}
