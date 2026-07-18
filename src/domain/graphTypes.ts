import type { CitationMetricStatus, CitationProviderID } from "./citationTypes";

export type GraphAxisMetric = "none" | "year" | "citations" | "references";

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
  metricsUpdatedAt: string | null;

  provider: CitationProviderID | null;
  providerWorkID: string | null;
  metricStatus: CitationMetricStatus | null;
  resolvedReferenceCount: number;

  incomingLibraryCitations: number;
  outgoingLibraryReferences: number;
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
