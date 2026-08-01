import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import { projectRelatedWorkSummary } from "./relatedWorkHydrationState";

export function stampProviderWorks(
  works: RelatedWorkMetadata[],
  providerID: CitationProviderID,
  updatedAt = new Date().toISOString(),
): RelatedWorkMetadata[] {
  return works.map((work) =>
    projectRelatedWorkSummary(
      {
        ...work,
        dataSources: [...new Set([...(work.dataSources ?? []), providerID])],
        updatedAt: work.updatedAt ?? updatedAt,
      },
      false,
    ),
  );
}
