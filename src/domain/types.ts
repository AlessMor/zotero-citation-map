export interface ZoteroPaper {
  libraryID: number;
  itemID: number;
  itemKey: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  tags: string[];
  collectionIDs: number[];
  dateModified: string;
  citationCount: number | null;
  referenceCount: number | null;
  metricsUpdatedAt: string | null;
}

export interface LibraryCollectionFilter {
  collectionID: number;
  name: string;
  path: string;
  includedCollectionIDs: number[];
}

export interface LibraryStatistics {
  totalPapers: number;
  withYear: number;
  withoutYear: number;
  withDOI: number;
  withoutDOI: number;
  withCitationData: number;
  withoutCitationData: number;
  withReferenceData: number;
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
