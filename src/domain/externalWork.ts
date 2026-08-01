import type { CitationProviderID, RelatedWorkMetadata } from "./citationTypes";

/** A provider work as presented in relationship and recommendation UIs. */
export interface ExternalWork extends RelatedWorkMetadata {
  recommendationScore?: number;
  recommendationSources?: CitationProviderID[];
  citingNodeKeys?: string[];
  inLibraryItemKey?: string | null;
}
