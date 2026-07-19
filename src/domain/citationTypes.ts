export type CitationProviderPreference = "auto" | CitationProviderID;

export type CitationProviderID =
  | "crossref"
  | "semantic-scholar"
  | "opencitations"
  | "inspire"
  | "openalex";

export type IdentifierKind = "doi" | "pmid" | "arxiv" | "isbn" | "title";

export type CitationMetricStatus =
  | "success"
  | "not-found"
  | "ambiguous-match"
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
  normalizedTitle: string;
  year: number | null;
  authors: string[];
  sourceTitle: string | null;
}

export interface CitationYearCount {
  year: number;
  count: number;
}

export interface SourceMetrics {
  sourceID: string | null;
  sourceTitle: string | null;
  twoYearMeanCitedness: number | null;
  hIndex: number | null;
  i10Index: number | null;
  updatedAt: string | null;
}

export interface RelatedWorkMetadata {
  provider: CitationProviderID | "manual" | "zotero";
  providerWorkID: string | null;
  doi: string | null;
  pmid?: string | null;
  arxiv?: string | null;
  isbn?: string | null;
  title: string | null;
  year: number | null;
  authors: string[];
  sourceTitle?: string | null;
  abstract?: string | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  isOpenAccess?: boolean | null;
  openAccessStatus?: string | null;
  isRetracted?: boolean | null;
  zoteroItemKey?: string | null;
}

export interface ProviderLookupSuccess {
  status: "success";
  provider: CitationProviderID;
  matchedBy: IdentifierKind;
  matchConfidence: number;
  providerWorkID: string | null;
  doi: string | null;
  title: string | null;
  year: number | null;
  authors: string[];
  sourceTitle: string | null;
  abstract: string | null;
  citationCount: number | null;
  citationCountProvider: CitationProviderID;
  referenceCount: number | null;
  referenceCountProvider: CitationProviderID;
  resolvedReferenceCount: number;
  references: RelatedWorkMetadata[];
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
  sourceMetrics?: SourceMetrics | null;
}

export interface ProviderLookupFailure {
  status: Exclude<CitationMetricStatus, "success">;
  provider: CitationProviderID;
  message: string;
  candidates?: RelatedWorkMetadata[];
}

export type ProviderLookupResult =
  | ProviderLookupSuccess
  | ProviderLookupFailure;

export interface CitationMetricRecord {
  libraryID: number;
  itemKey: string;
  provider: CitationProviderID;
  providerWorkID: string | null;
  matchedBy: IdentifierKind | null;
  matchConfidence: number | null;
  matchConfirmed: boolean;
  doi: string | null;
  title: string | null;
  normalizedTitle: string | null;
  year: number | null;
  authors: string[];
  sourceTitle: string | null;
  abstract: string | null;
  citationCount: number | null;
  citationCountProvider: CitationProviderID | null;
  referenceCount: number | null;
  referenceCountProvider: CitationProviderID | null;
  resolvedReferenceCount: number;
  references: RelatedWorkMetadata[];
  matchCandidates: RelatedWorkMetadata[];
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
  sourceMetrics: SourceMetrics | null;
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
  matchConfirmed: boolean;
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
  updatedAt: string | null;
  dataAgeDays: number | null;
  status: CitationMetricStatus | null;
}

export type ManualRelationDirection = "reference" | "cited-by";

export interface ManualCitationRelation {
  id: number;
  libraryID: number;
  subjectItemKey: string;
  relatedItemKey: string;
  direction: ManualRelationDirection;
  createdAt: string;
}

export interface IgnoredProviderRelation {
  id: number;
  libraryID: number;
  subjectItemKey: string;
  direction: ManualRelationDirection;
  provider: CitationProviderID;
  providerWorkID: string | null;
  doi: string | null;
  normalizedTitle: string | null;
  createdAt: string;
}

export interface CitationUpdateBatchResult {
  total: number;
  updated: number;
  cached: number;
  failed: number;
  skipped: number;
}
