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

  /**
   * null means that the value has not been retrieved or is unavailable.
   * 0 will later mean that the provider confirmed a count of zero.
   */
  citationCount: number | null;
  referenceCount: number | null;
  metricsUpdatedAt: string | null;
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
  statistics: LibraryStatistics;
}
