import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../../domain/citationTypes";

export type RelationshipDirection = "references" | "cited-by";

export interface RelationshipProviderAdapter {
  readonly id: CitationProviderID;
  /** Maximum useful relationship records requested in one provider call. */
  readonly relationshipPageSize: number;
  /** Maximum metadata identifiers grouped into one provider batch. */
  readonly metadataBatchSize: number;
  /** Higher values are preferred when choosing a complete reference source. */
  readonly referenceAuthorityPriority: number;
}

export interface RelationshipProviderSnapshot {
  provider: CitationProviderID;
  works: RelatedWorkMetadata[];
  reportedCount: number | null;
  complete: boolean;
  succeeded: boolean;
}

export interface PreparedRelationshipProviderSnapshot extends RelationshipProviderSnapshot {
  rawRetrievedCount: number;
  identifiedWorks: RelatedWorkMetadata[];
  unresolvedWorks: RelatedWorkMetadata[];
}

export interface SelectedRelationshipMembership {
  works: RelatedWorkMetadata[];
  reportedCount: number | null;
  countProvider: CitationProviderID | null;
  authorityProvider: CitationProviderID | null;
  complete: boolean;
  providerSnapshots: PreparedRelationshipProviderSnapshot[];
}
