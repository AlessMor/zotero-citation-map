import type { RelationshipProviderAdapter } from "./types";

export const crossrefRelationshipAdapter: RelationshipProviderAdapter = {
  id: "crossref",
  // Crossref references are embedded in the root-work response.
  relationshipPageSize: 2500,
  metadataBatchSize: 1,
  referenceAuthorityPriority: 90,
};
