import type { RelationshipProviderAdapter } from "./types";

export const openAlexRelationshipAdapter: RelationshipProviderAdapter = {
  id: "openalex",
  relationshipPageSize: 100,
  metadataBatchSize: 100,
  referenceAuthorityPriority: 50,
};
