import type { CitationMetricSummary } from "./citationTypes";

export interface ZoteroPaper {
  itemID: number;
  itemKey: string;
  libraryID: number;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  abstract: string | null;
  sourceTitle: string | null;
  tags: string[];
  collectionIDs: number[];
  metadataCompleteness: number;
  metrics: CitationMetricSummary;
}

export interface LibraryCollectionFilter {
  collectionID: number;
  parentCollectionID: number | null;
  key: string;
  name: string;
  path: string;
  depth: number;
  orderIndex: number;
  includedCollectionIDs: number[];
}

export interface LibraryStatistics {
  totalPapers: number;
  withoutYear: number;
  withoutDOI: number;
  withoutCitationData: number;
  withoutReferenceData: number;
}

export interface LibrarySnapshot {
  libraryID: number;
  libraryName: string;
  generatedAt: string;
  papers: ZoteroPaper[];
  collections: LibraryCollectionFilter[];
  tags: string[];
  statistics: LibraryStatistics;
}
