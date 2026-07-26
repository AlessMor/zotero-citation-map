import type { RelationshipProviderAdapter } from "./types";

export const openCitationsRelationshipAdapter: RelationshipProviderAdapter = {
  id: "opencitations",
  // The endpoint returns the complete DOI-link array; slice it locally once.
  relationshipPageSize: 2500,
  metadataBatchSize: 50,
  referenceAuthorityPriority: 40,
};
