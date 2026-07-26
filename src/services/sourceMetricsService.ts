import type {
  CitationGraphNode,
  GraphLayoutOptions,
  GraphNodeColorMetric,
  GraphNodeSizeMetric,
} from "../domain/graphTypes";
import { getCitationMetricRecord } from "./citationMetricsStore";

const SOURCE_METRIC_IDS = new Set<string>([
  "two-year-mean-citedness",
  "journal-h-index",
  "journal-i10-index",
]);

function usesSourceMetric(
  metric: string | GraphNodeColorMetric | GraphNodeSizeMetric,
): boolean {
  return SOURCE_METRIC_IDS.has(metric);
}

export function graphLayoutUsesSourceMetrics(
  layout: GraphLayoutOptions,
): boolean {
  return (
    usesSourceMetric(layout.xMetric) ||
    usesSourceMetric(layout.yMetric) ||
    usesSourceMetric(layout.nodeSizeMetric) ||
    usesSourceMetric(layout.nodeColorMetric)
  );
}

/**
 * Copy already-persisted source metrics into existing graph nodes.
 *
 * Network resolution is deliberately excluded from graph rendering. Complete
 * Zotero-item updates resolve journal metrics beforehand; selecting an axis
 * must therefore remain an immediate, cache-only operation.
 */
export async function ensureSourceMetricsForNodes(
  nodes: CitationGraphNode[],
  onUpdate?: (updated: number, total: number) => void,
): Promise<number> {
  const missing = nodes.filter((node) => !node.sourceMetrics);
  let updated = 0;
  for (const node of missing) {
    const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
    const libraryID = Number(item?.libraryID);
    if (!item || !Number.isFinite(libraryID)) continue;
    const record = getCitationMetricRecord(libraryID, node.itemKey);
    if (!record?.sourceMetrics) continue;
    node.sourceMetrics = record.sourceMetrics;
    updated += 1;
    onUpdate?.(updated, missing.length);
  }
  return updated;
}
