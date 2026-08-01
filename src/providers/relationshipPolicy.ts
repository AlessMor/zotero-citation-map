import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";

export type RelationshipDirection = "references" | "cited-by";

export interface RelationshipProviderPolicy {
  /** Maximum useful relationship records retained from one provider response. */
  readonly relationshipFetchLimit: number;
  /** Maximum metadata identifiers grouped into one provider batch. */
  readonly metadataBatchSize: number;
  /** Higher values are preferred when choosing a complete reference source. */
  readonly referenceAuthorityPriority: number;
}

const RELATIONSHIP_POLICIES: Readonly<
  Record<CitationProviderID, RelationshipProviderPolicy>
> = {
  crossref: {
    relationshipFetchLimit: 2500,
    metadataBatchSize: 1,
    referenceAuthorityPriority: 90,
  },
  "semantic-scholar": {
    relationshipFetchLimit: 1000,
    metadataBatchSize: 200,
    referenceAuthorityPriority: 70,
  },
  opencitations: {
    relationshipFetchLimit: 2500,
    metadataBatchSize: 50,
    referenceAuthorityPriority: 40,
  },
  inspire: {
    relationshipFetchLimit: 2500,
    metadataBatchSize: 100,
    referenceAuthorityPriority: 80,
  },
  openalex: {
    relationshipFetchLimit: 100,
    metadataBatchSize: 100,
    referenceAuthorityPriority: 50,
  },
};

export function relationshipPolicyFor(
  provider: CitationProviderID,
): RelationshipProviderPolicy {
  return RELATIONSHIP_POLICIES[provider];
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
