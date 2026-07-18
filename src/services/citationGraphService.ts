import type {
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import type { LibrarySnapshot } from "../domain/types";
import type { CitationMetricRecord } from "../domain/citationTypes";
import {
  calculateFutureReferenceCount,
  calculateRecordReferenceAgeStats,
  calculateSelfCitationEstimate,
} from "./citationAnalyticsService";
import {
  computeNetworkAnalytics,
  resolveRecordCitationEdges,
} from "./citationNetworkAnalytics";
import {
  getCitationMetricRecord,
  getItemCitationMetrics,
} from "./citationMetricsStore";
import { normalizeDOI } from "./citationIdentifiers";

function ratio(numerator: number, denominator: number | null): number | null {
  if (denominator === null || denominator < 0) {
    return null;
  }
  if (denominator === 0) {
    return numerator === 0 ? 1 : null;
  }
  return numerator / denominator;
}

function createNode(
  snapshot: LibrarySnapshot,
  paperIndex: number,
  record: CitationMetricRecord | null,
): CitationGraphNode {
  const paper = snapshot.papers[paperIndex];
  const summary = getItemCitationMetrics(paper.libraryID, paper.itemKey);
  const age = record
    ? calculateRecordReferenceAgeStats(record)
    : { mean: null, spread: null };

  return {
    key: paper.itemKey,
    itemID: paper.itemID,
    itemKey: paper.itemKey,
    title: paper.title,
    authors: [...paper.authors],
    year: paper.year,
    doi: normalizeDOI(paper.doi ?? record?.doi),
    tags: [...paper.tags],
    collectionIDs: [...paper.collectionIDs],
    citationCount: summary.citationCount,
    referenceCount: summary.referenceCount,
    resolvedReferenceCount: summary.resolvedReferenceCount,
    referenceCoverage: ratio(
      summary.resolvedReferenceCount,
      summary.referenceCount,
    ),
    metricsUpdatedAt: summary.updatedAt,
    dataAgeDays: summary.dataAgeDays,
    provider: summary.provider,
    citationCountProvider: summary.citationCountProvider,
    referenceCountProvider: summary.referenceCountProvider,
    providerWorkID: record?.providerWorkID ?? null,
    matchedBy: summary.matchedBy,
    matchConfidence: summary.matchConfidence,
    metricStatus: summary.status,
    fwci: summary.fwci,
    citationPercentile: summary.citationPercentile,
    isTop1Percent: summary.isTop1Percent,
    isTop10Percent: summary.isTop10Percent,
    citationsLastYear: summary.citationsLastYear,
    citationVelocity: summary.citationVelocity,
    citationAcceleration: summary.citationAcceleration,
    influentialCitationCount: summary.influentialCitationCount,
    isRetracted: summary.isRetracted,
    openAccessStatus: summary.openAccessStatus,
    isOpenAccess: summary.isOpenAccess,
    publicationType: summary.publicationType,
    metadataCompleteness: paper.metadataCompleteness,
    incomingLibraryCitations: 0,
    outgoingLibraryReferences: 0,
    libraryCoverage: null,
    localGlobalImpactRatio: null,
    pageRank: 0,
    betweennessCentrality: 0,
    eigenvectorCentrality: 0,
    componentSize: 1,
    citationChainDepth: 0,
    isIsolated: true,
    referenceAgeMean: age.mean,
    referenceAgeSpread: age.spread,
    selfCitationEstimate: record ? calculateSelfCitationEstimate(record) : null,
    futureReferenceCount: record ? calculateFutureReferenceCount(record) : null,
  };
}

export function buildCitationGraph(
  snapshot: LibrarySnapshot,
): CitationGraphModel {
  const records = new Map<string, CitationMetricRecord>();
  const nodes = snapshot.papers.map((paper, index) => {
    const record = getCitationMetricRecord(paper.libraryID, paper.itemKey);
    if (record) {
      records.set(paper.itemKey, record);
    }
    return createNode(snapshot, index, record);
  });

  const nodeKeys = new Set(nodes.map((node) => node.key));
  const edges = resolveRecordCitationEdges([...records.values()]).filter(
    (edge) => nodeKeys.has(edge.source) && nodeKeys.has(edge.target),
  );
  const analytics = computeNetworkAnalytics(
    nodes.map((node) => node.key),
    edges,
  );

  for (const node of nodes) {
    const network = analytics.get(node.key);
    if (!network) {
      continue;
    }

    node.incomingLibraryCitations = network.incoming;
    node.outgoingLibraryReferences = network.outgoing;
    node.libraryCoverage = ratio(network.outgoing, node.referenceCount);
    node.localGlobalImpactRatio = ratio(network.incoming, node.citationCount);
    node.pageRank = network.pageRank;
    node.betweennessCentrality = network.betweennessCentrality;
    node.eigenvectorCentrality = network.eigenvectorCentrality;
    node.componentSize = network.componentSize;
    node.citationChainDepth = network.citationChainDepth;
    node.isIsolated = network.isIsolated;
  }

  return {
    nodes,
    edges,
    statistics: {
      nodes: nodes.length,
      resolvedNodes: nodes.filter((node) => node.metricStatus === "success")
        .length,
      edges: edges.length,
      isolatedNodes: nodes.filter((node) => node.isIsolated).length,
    },
  };
}
