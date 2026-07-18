export type CitationProviderPreference = "auto" | CitationProviderID;

export type CitationProviderID =
  | "openalex"
  | "semantic-scholar"
  | "crossref"
  | "opencitations"
  | "inspire";

export type IdentifierKind = "doi" | "pmid" | "arxiv" | "isbn";

export type CitationMetricStatus =
  | "success"
  | "not-found"
  | "no-identifier"
  | "rate-limited"
  | "network-error"
  | "provider-error";

export interface WorkIdentifiers {
  doi: string | null;
  pmid: string | null;
  arxiv: string | null;
  isbn: string | null;

  title: string;
  year: number | null;
  authors: string[];
}

export interface CitationYearCount {
  year: number;
  count: number;
}

export interface RelatedWorkMetadata {
  providerWorkID: string | null;
  doi: string | null;
  title: string | null;
  year: number | null;
  authors: string[];
}

export interface ProviderLookupSuccess {
  status: "success";

  /** Provider whose work identity and outgoing references are cached. */
  provider: CitationProviderID;
  matchedBy: IdentifierKind;

  providerWorkID: string | null;
  doi: string | null;
  title: string | null;
  year: number | null;
  authors: string[];

  citationCount: number | null;
  citationCountProvider: CitationProviderID;

  /** Declared bibliography/reference total exposed in Zotero's column. */
  referenceCount: number | null;
  referenceCountProvider: CitationProviderID;

  /** Number of structured outgoing reference records saved for the graph. */
  resolvedReferenceCount: number;
  references: RelatedWorkMetadata[];

  /** Optional provider-enriched bibliometric and status fields. */
  fwci?: number | null;
  citationPercentile?: number | null;
  isTop1Percent?: boolean | null;
  isTop10Percent?: boolean | null;
  citationCountsByYear?: CitationYearCount[];
  citationsLastYear?: number | null;
  citationVelocity?: number | null;
  citationAcceleration?: number | null;
  influentialCitationCount?: number | null;
  isRetracted?: boolean | null;
  openAccessStatus?: string | null;
  isOpenAccess?: boolean | null;
  publicationType?: string | null;
}

export interface ProviderLookupFailure {
  status: Exclude<CitationMetricStatus, "success">;
  provider: CitationProviderID;
  message: string;
}

export type ProviderLookupResult =
  | ProviderLookupSuccess
  | ProviderLookupFailure;

export interface CitationMetricRecord {
  libraryID: number;
  itemKey: string;

  /** Canonical provider for work identity and graph relationship records. */
  provider: CitationProviderID;
  providerWorkID: string | null;
  matchedBy: IdentifierKind | null;

  doi: string | null;
  title: string | null;
  year: number | null;
  authors: string[];

  citationCount: number | null;
  citationCountProvider: CitationProviderID | null;

  referenceCount: number | null;
  referenceCountProvider: CitationProviderID | null;
  resolvedReferenceCount: number;
  references: RelatedWorkMetadata[];

  fwci: number | null;
  citationPercentile: number | null;
  isTop1Percent: boolean | null;
  isTop10Percent: boolean | null;
  citationCountsByYear: CitationYearCount[];
  citationsLastYear: number | null;
  citationVelocity: number | null;
  citationAcceleration: number | null;
  influentialCitationCount: number | null;
  isRetracted: boolean | null;
  openAccessStatus: string | null;
  isOpenAccess: boolean | null;
  publicationType: string | null;

  status: CitationMetricStatus;
  fetchedAt: string | null;
  lastAttemptAt: string;
  errorMessage: string | null;
  failureCount: number;
  nextRetryAt: string | null;
}

export interface CitationMetricSummary {
  citationCount: number | null;
  citationCountProvider: CitationProviderID | null;
  referenceCount: number | null;
  referenceCountProvider: CitationProviderID | null;
  resolvedReferenceCount: number;
  provider: CitationProviderID | null;
  matchedBy: IdentifierKind | null;
  matchConfidence: number | null;

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

  updatedAt: string | null;
  dataAgeDays: number | null;
  status: CitationMetricStatus | null;
}

export interface CitationUpdateBatchResult {
  total: number;
  updated: number;
  cached: number;
  failed: number;
  skipped: number;
}
