import type {
  CitationProviderID,
  CitationProviderPreference,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { mergeRelatedWorkMetadata } from "../domain/relatedWorkMetadata";
import { relationshipCandidateIdentity } from "../domain/workIdentity";
import { fetchCrossrefRelatedWorks } from "./crossrefDiscovery";
import { fetchOpenAlexRelatedWorks } from "./openAlexProvider";
import { fetchSemanticScholarRecommendations } from "./semanticScholarProvider";
import { getCitationProvider, getProviderPlan } from "./registry";

export interface SimilarWorkResult extends RelatedWorkMetadata {
  recommendationScore: number;
  recommendationSources: CitationProviderID[];
}

/** Discover genuinely recommended papers through provider-native systems.
 * Citation-neighbour fallbacks remain outside this function. */
export async function discoverSimilarWorks(
  seeds: WorkIdentifiers[],
  preference: CitationProviderPreference,
  maximum = 100,
): Promise<SimilarWorkResult[]> {
  const plan = getProviderPlan("similar", preference);
  const candidates = new Map<
    string,
    {
      work: RelatedWorkMetadata;
      score: number;
      sources: Set<CitationProviderID>;
    }
  >();
  const requested = Math.min(500, Math.max(1, maximum));

  for (const providerID of plan.providers) {
    let works: RelatedWorkMetadata[];
    try {
      if (providerID === "semantic-scholar") {
        works = await fetchSemanticScholarRecommendations(seeds, requested);
      } else if (providerID === "crossref") {
        works = await fetchCrossrefRelatedWorks(seeds, requested);
      } else if (providerID === "openalex") {
        works = await fetchOpenAlexRelatedWorks(seeds, requested);
      } else {
        continue;
      }
    } catch (error) {
      Zotero.debug(
        `Citation Map: ${getCitationProvider(providerID).label} similar-paper discovery failed: ${String(error)}`,
      );
      continue;
    }

    for (const [rank, work] of works.entries()) {
      const identity = relationshipCandidateIdentity(work);
      const current = candidates.get(identity) ?? {
        work,
        score: 0,
        sources: new Set<CitationProviderID>(),
      };
      current.work = mergeRelatedWorkMetadata(current.work, work);
      // Reciprocal-rank fusion combines provider lists without assuming that
      // provider-specific scores use compatible scales.
      current.score += 1 / (60 + rank + 1);
      current.sources.add(providerID);
      candidates.set(identity, current);
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate.work,
      recommendationScore: candidate.score,
      recommendationSources: [...candidate.sources],
    }))
    .sort(
      (left, right) =>
        right.recommendationScore - left.recommendationScore ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1) ||
        (right.year ?? -1) - (left.year ?? -1) ||
        String(left.title ?? "").localeCompare(String(right.title ?? "")),
    )
    .slice(0, requested);
}
