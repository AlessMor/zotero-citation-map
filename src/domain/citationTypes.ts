export type CitationProviderPreference = "auto" | CitationProviderID;

export type CitationProviderID =
  | "crossref"
  | "semantic-scholar"
  | "opencitations"
  | "inspire"
  | "openalex"
  | "ads";

export const CITATION_PROVIDER_IDS: readonly CitationProviderID[] = [
  "crossref",
  "semantic-scholar",
  "opencitations",
  "inspire",
  "openalex",
  "ads",
];

export type IdentifierKind = "doi" | "pmid" | "arxiv" | "isbn" | "title";

export type RelationshipUpdateStatus =
  "complete" | "first-hop-ready" | "empty" | "unavailable";

export type CitationMetricStatus =
  | "success"
  | "identity-conflict"
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

export interface LibraryUpdateState {
  coreUpdatedAt?: string | null;
  sourceMetricsUpdatedAt?: string | null;
  referencesUpdatedAt?: string | null;
  citedByUpdatedAt?: string | null;
  referencesComplete?: boolean;
  citedByComplete?: boolean;
  /** Number of first-hop relationship summaries currently available locally. */
  referencesLoadedCount?: number;
  citedByLoadedCount?: number;
  /** Provider-reported totals, retained even when only the first page is cached. */
  referencesReportedCount?: number | null;
  citedByReportedCount?: number | null;
  /** Outcome of the most recent relationship attempt for each direction. */
  referencesStatus?: RelationshipUpdateStatus;
  citedByStatus?: RelationshipUpdateStatus;
  /** Failed or unavailable relationship attempts are not retried before this time. */
  referencesNextRetryAt?: string | null;
  citedByNextRetryAt?: string | null;
  /** Provider work IDs discovered during batched enrichment and reused by relationship refreshes. */
  providerWorkIDs?: Partial<Record<CitationProviderID, string>>;
}

export interface SourceMetrics {
  sourceID: string | null;
  sourceTitle: string | null;
  twoYearMeanCitedness: number | null;
  hIndex: number | null;
  i10Index: number | null;
  updatedAt: string | null;
  /** Independently refreshed parts of a complete Zotero-library update. */
  libraryUpdateState?: LibraryUpdateState;
}

export type WorkIdentityStatus =
  "resolved" | "ambiguous" | "possible-version" | "conflict";

export type RelatedWorkPropertyName =
  | "doi"
  | "pmid"
  | "arxiv"
  | "isbn"
  | "title"
  | "year"
  | "publicationDate"
  | "authors"
  | "authorIDs"
  | "sourceTitle"
  | "abstract"
  | "citationCount"
  | "referenceCount"
  | "citationCountsByYear"
  | "references"
  | "resolvedReferenceCount"
  | "fwci"
  | "citationPercentile"
  | "isTop1Percent"
  | "isTop10Percent"
  | "citationsLastYear"
  | "citationVelocity"
  | "citationAcceleration"
  | "influentialCitationCount"
  | "publicationType"
  | "sourceMetrics"
  | "referenceAgeMean"
  | "referenceAgeSpread"
  | "selfCitationEstimate"
  | "futureReferenceCount"
  | "metadataCompleteness"
  | "isOpenAccess"
  | "openAccessStatus"
  | "isRetracted";

export type RelatedWorkPropertySource =
  CitationProviderID | "citation-map" | "manual" | "zotero";

export interface RelatedWorkPropertyConflict {
  property: RelatedWorkPropertyName;
  existingValue: string;
  incomingValue: string;
  existingSources: RelatedWorkPropertySource[];
  incomingSources: RelatedWorkPropertySource[];
}

export interface WorkIdentityConflict {
  reason: string;
  existingAliases: string[];
  incomingAliases: string[];
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
  /** Most precise known publication date, preferably ISO-8601. */
  publicationDate?: string | null;
  authors: string[];
  /** Stable provider author identifiers when available (ORCID/provider IDs). */
  authorIDs?: string[];
  sourceTitle?: string | null;
  abstract?: string | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  citationCountsByYear?: CitationYearCount[];
  references?: RelatedWorkMetadata[];
  resolvedReferenceCount?: number | null;
  fwci?: number | null;
  citationPercentile?: number | null;
  isTop1Percent?: boolean | null;
  isTop10Percent?: boolean | null;
  citationsLastYear?: number | null;
  citationVelocity?: number | null;
  citationAcceleration?: number | null;
  influentialCitationCount?: number | null;
  publicationType?: string | null;
  sourceMetrics?: SourceMetrics | null;
  referenceAgeMean?: number | null;
  referenceAgeSpread?: number | null;
  selfCitationEstimate?: number | null;
  futureReferenceCount?: number | null;
  metadataCompleteness?: number | null;
  isOpenAccess?: boolean | null;
  openAccessStatus?: string | null;
  isRetracted?: boolean | null;
  zoteroItemKey?: string | null;
  inLibraryItemKey?: string | null;
  /** Library scope for Zotero item keys, which are not globally unique. */
  zoteroLibraryID?: number | null;
  /** Providers that contributed one or more values to this merged record. */
  dataSources?: CitationProviderID[];
  /** Provider provenance retained independently for every canonical property. */
  propertySources?: Partial<
    Record<RelatedWorkPropertyName, RelatedWorkPropertySource[]>
  >;
  /** Alternative observations retained when providers disagree. */
  propertyConflicts?: RelatedWorkPropertyConflict[];
  identityStatus?: WorkIdentityStatus;
  identityConflict?: WorkIdentityConflict | null;
  /** Most recent provider fetch involved in this merged record. */
  updatedAt?: string | null;
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
  publicationDate?: string | null;
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
  ProviderLookupSuccess | ProviderLookupFailure;

export interface CitationMetricRecord {
  libraryID: number;
  itemKey: string;
  provider: CitationProviderID;
  providerWorkID: string | null;
  matchedBy: IdentifierKind | null;
  matchConfidence: number | null;
  matchConfirmed: boolean;
  identityConflict: boolean;
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
  propertySources: Partial<
    Record<RelatedWorkPropertyName, RelatedWorkPropertySource[]>
  >;
  propertyConflicts: RelatedWorkPropertyConflict[];
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
  identityConflict: boolean;
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
