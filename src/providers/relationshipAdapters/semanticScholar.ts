import type { RelationshipProviderAdapter } from "./types";

export const semanticScholarRelationshipAdapter: RelationshipProviderAdapter = {
  id: "semantic-scholar",
  relationshipPageSize: 1000,
  metadataBatchSize: 200,
  referenceAuthorityPriority: 70,
};
