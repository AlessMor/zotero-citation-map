import type {
  CitationMetricStatus,
  CitationProviderID,
  IdentifierKind,
  RelatedWorkMetadata,
  SourceMetrics,
} from "./citationTypes";

export type MetricID =
  | "year"
  | "citations"
  | "references"
  | "citations-last-year"
  | "citation-rate"
  | "citation-acceleration"
  | "fwci"
  | "citation-percentile"
  | "influential-citations"
  | "two-year-mean-citedness"
  | "journal-h-index"
  | "journal-i10-index"
  | "library-coverage"
  | "local-global-impact"
  | "pagerank"
  | "betweenness"
  | "eigenvector"
  | "component-size"
  | "citation-chain-depth"
  | "reference-coverage"
  | "reference-age-mean"
  | "reference-age-spread"
  | "self-citation-estimate"
  | "future-references"
  | "data-age"
  | "metadata-completeness"
  | "match-confidence";

export type GraphAxisMetric = "free" | MetricID;
export type GraphScaleType = "linear" | "log";
export type GraphNodeSizeMetric = "uniform" | MetricID;
export type GraphNodeColorMetric =
  | "collection"
  | "publication-type"
  | "provider"
  | "open-access"
  | "retraction"
  | MetricID;
export type GraphNodeLabelMode = "title" | "author-year" | "none";

export interface CitationGraphNode {
  key: string;
  itemID: number;
  itemKey: string;
  title: string;
  abstract: string | null;
  sourceTitle: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  tags: string[];
  collectionIDs: number[];
  citationCount: number | null;
  referenceCount: number | null;
  resolvedReferenceCount: number;
  referenceCoverage: number | null;
  metricsUpdatedAt: string | null;
  dataAgeDays: number | null;
  provider: CitationProviderID | null;
  citationCountProvider: CitationProviderID | null;
  referenceCountProvider: CitationProviderID | null;
  providerWorkID: string | null;
  matchedBy: IdentifierKind | null;
  matchConfidence: number | null;
  matchConfirmed: boolean;
  metricStatus: CitationMetricStatus | null;
  fwci: number | null;
  citationPercentile: number | null;
  isTop1Percent: boolean | null;
  isTop10Percent: boolean | null;
  citationsLastYear: number | null;
  citationVelocity: number | null;
  citationAcceleration: number | null;
  influentialCitationCount: number | null;
  isRetracted: boolean | null;
  openAccessStatus: string | null;
  isOpenAccess: boolean | null;
  publicationType: string | null;
  sourceMetrics: SourceMetrics | null;
  metadataCompleteness: number;
  incomingLibraryCitations: number;
  outgoingLibraryReferences: number;
  libraryCoverage: number | null;
  localGlobalImpactRatio: number | null;
  pageRank: number;
  betweennessCentrality: number;
  eigenvectorCentrality: number;
  componentSize: number;
  citationChainDepth: number;
  isIsolated: boolean;
  referenceAgeMean: number | null;
  referenceAgeSpread: number | null;
  selfCitationEstimate: number | null;
  futureReferenceCount: number | null;
  references: RelatedWorkMetadata[];
}

export interface CitationGraphEdge {
  key: string;
  source: string;
  target: string;
  provenance: string;
  manual: boolean;
}

export interface CitationGraphStatistics {
  nodes: number;
  resolvedNodes: number;
  edges: number;
  isolatedNodes: number;
}

export interface CitationGraphModel {
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  statistics: CitationGraphStatistics;
}

export interface GraphLayoutOptions {
  xMetric: GraphAxisMetric;
  xScale: GraphScaleType;
  yMetric: GraphAxisMetric;
  yScale: GraphScaleType;
  nodeSizeMetric: GraphNodeSizeMetric;
  nodeColorMetric: GraphNodeColorMetric;
  nodeLabelMode: GraphNodeLabelMode;
}
