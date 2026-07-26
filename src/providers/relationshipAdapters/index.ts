import type { CitationProviderID } from "../../domain/citationTypes";
import { crossrefRelationshipAdapter } from "./crossref";
import { inspireRelationshipAdapter } from "./inspire";
import { openAlexRelationshipAdapter } from "./openAlex";
import { openCitationsRelationshipAdapter } from "./openCitations";
import { semanticScholarRelationshipAdapter } from "./semanticScholar";
import type { RelationshipProviderAdapter } from "./types";

export type {
  PreparedRelationshipProviderSnapshot,
  RelationshipDirection,
  RelationshipProviderAdapter,
  RelationshipProviderSnapshot,
  SelectedRelationshipMembership,
} from "./types";

const ADAPTERS = new Map<CitationProviderID, RelationshipProviderAdapter>([
  [crossrefRelationshipAdapter.id, crossrefRelationshipAdapter],
  [semanticScholarRelationshipAdapter.id, semanticScholarRelationshipAdapter],
  [openCitationsRelationshipAdapter.id, openCitationsRelationshipAdapter],
  [inspireRelationshipAdapter.id, inspireRelationshipAdapter],
  [openAlexRelationshipAdapter.id, openAlexRelationshipAdapter],
]);

export function relationshipAdapterFor(
  provider: CitationProviderID,
): RelationshipProviderAdapter {
  const adapter = ADAPTERS.get(provider);
  if (!adapter) {
    throw new Error(`No relationship adapter registered for ${provider}.`);
  }
  return adapter;
}
