import type {
  CitationMetricStatus,
  CitationProviderID,
  IdentifierKind,
  RelatedWorkMetadata,
  SourceMetrics,
} from "./citationTypes";

export type MetricID =
  | "year"
  | "citation-sequence"
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

export type CitationGraphNodeKind = "local" | "external";
export type CitationGraphFocusRole = "seed" | "reference" | "cited-by" | "both";

export interface CitationGraphNode {
  key: string;
  itemID: number;
  itemKey: string;
  kind?: CitationGraphNodeKind;
  focusRole?: CitationGraphFocusRole | null;
  externalWork?: RelatedWorkMetadata | null;
  title: string;
  abstract: string | null;
  sourceTitle: string | null;
  authors: string[];
  year: number | null;
  publicationDate: string | null;
  /** Context-derived ordinal publication/citation position. */
  citationSequence: number | null;
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
  isIsolated: boolean;
  referenceAgeMean: number | null;
  referenceAgeSpread: number | null;
  selfCitationEstimate: number | null;
  futureReferenceCount: number | null;
  references: RelatedWorkMetadata[];
}

export interface GhostPreview {
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  citationCount: number | null;
  referenceCount: number | null;
  sourceKeys: string[];
  contextLabel?: string;
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

/**
 * Read-only lookup indexes derived from a graph snapshot. Views may keep their
 * own mutable model while sharing these compact indexes for projection work.
 */
export interface CitationGraphIndex {
  nodeByKey: ReadonlyMap<string, CitationGraphNode>;
  outgoingEdgesByKey: ReadonlyMap<string, readonly CitationGraphEdge[]>;
  incomingEdgesByKey: ReadonlyMap<string, readonly CitationGraphEdge[]>;
  edgeByPair: ReadonlyMap<string, CitationGraphEdge>;
  nodesByAlias: ReadonlyMap<string, readonly CitationGraphNode[]>;
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
