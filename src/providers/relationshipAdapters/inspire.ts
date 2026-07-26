import type { RelationshipProviderAdapter } from "./types";

export const inspireRelationshipAdapter: RelationshipProviderAdapter = {
  id: "inspire",
  // INSPIRE embeds references in the matched literature record.
  relationshipPageSize: 2500,
  metadataBatchSize: 100,
  referenceAuthorityPriority: 80,
};
