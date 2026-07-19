import type {
  CitationGraphNode,
  GraphAxisMetric,
  MetricID,
} from "../domain/graphTypes";
import {
  axisMetricDefinitions,
  formatMetricValue,
  getMetricDefinition,
  metricTooltip,
  metricValue,
} from "./metricRegistry";

export const GRAPH_AXIS_OPTIONS = [
  { metric: "free" as const, label: "Free", group: "Layout" as const },
  ...axisMetricDefinitions().map((definition) => ({
    metric: definition.id,
    label: definition.label,
    group: definition.group,
  })),
];

export function graphMetricLabel(metric: GraphAxisMetric): string {
  return metric === "free" ? "Free" : getMetricDefinition(metric).label;
}

export function graphMetricDescription(metric: GraphAxisMetric): string | null {
  return metric === "free"
    ? "Leave this dimension unconstrained and position papers using the citation-network force layout."
    : metricTooltip(metric);
}

export function graphMetricValue(
  node: CitationGraphNode,
  metric: GraphAxisMetric,
): number | null {
  if (metric === "free") return null;
  const value = metricValue(node, metric);
  return typeof value === "number" ? value : null;
}

export function graphMetricIsPercentage(metric: GraphAxisMetric): boolean {
  return (
    metric !== "free" && getMetricDefinition(metric).valueType === "percentage"
  );
}

export function graphMetricAllowsNegative(metric: GraphAxisMetric): boolean {
  return (
    metric !== "free" && Boolean(getMetricDefinition(metric).allowsNegative)
  );
}

export function graphMetricSupportsLog(metric: GraphAxisMetric): boolean {
  return (
    metric !== "free" &&
    getMetricDefinition(metric).graph.logarithmic &&
    !graphMetricAllowsNegative(metric)
  );
}

export function formatGraphMetricValue(
  metric: GraphAxisMetric,
  value: number,
): string {
  return metric === "free" ? "" : formatMetricValue(metric as MetricID, value);
}
