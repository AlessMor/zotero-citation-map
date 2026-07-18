import type {
  CitationMetricStatus,
  CitationProviderID,
  IdentifierKind,
} from "./citationTypes";

export type GraphAxisMetric =
  | "none"
  | "year"
  | "citations"
  | "references"
  | "library-coverage"
  | "citation-velocity"
  | "citation-acceleration";

export type GraphScaleType = "linear" | "log";

export type GraphNodeSizeMetric = "uniform" | "citations" | "references";

export type GraphNodeLabelMode = "title" | "author-year";

export interface CitationGraphNode {
  key: string;
  itemID: number;
  itemKey: string;

  title: string;
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
}

export interface CitationGraphEdge {
  key: string;
  source: string;
  target: string;
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
}
