import type { RelatedWorkMetadata } from "../domain/citationTypes";
import type { ExternalWork } from "../domain/externalWork";
import type { CitationGraphNode } from "../domain/graphTypes";
import {
  externalWorkLookupIdentity,
  normalizeDOI,
  normalizeExactTitle,
} from "../domain/workIdentity";
import {
  workIdentifiersForGraphNode,
  workIdentifiersForRelatedWork,
} from "../domain/workIdentifiers";
import { discoverSimilarWorks } from "../providers/similarWorkDiscoveryService";
import { getCitationProvider, getProviderPlan } from "../providers/registry";
import { mapBounded } from "./backgroundTaskService";
import {
  getCachedExternalCitedBy,
  getCachedExternalReferences,
  getExternalCitedBy,
  getExternalReferences,
  hydrateExternalWorksMetadata,
} from "./externalDiscoveryService";
import {
  externalWorkDisplayTitle,
  localExternalWorkIndexes,
  mergeExternalWorkMetadata,
  toExternalWork,
} from "./externalWorkMetadataService";
import { stampProviderWorks } from "./providerWorkMetadata";

interface RecommendationCandidate {
  work: RelatedWorkMetadata;
  score: number;
  connectedNodeKeys: Set<string>;
}

function addRecommendationCandidate(
  candidates: Map<string, RecommendationCandidate>,
  indexes: ReturnType<typeof localExternalWorkIndexes>,
  node: CitationGraphNode,
  work: RelatedWorkMetadata,
  weight: number,
): void {
  const doi = normalizeDOI(work.doi);
  const title = normalizeExactTitle(work.title);
  if (
    (doi && indexes.byDOI.has(doi)) ||
    (title && indexes.byTitle.has(title))
  ) {
    return;
  }
  const identity = externalWorkLookupIdentity(work);
  const current = candidates.get(identity) ?? {
    work,
    score: 0,
    connectedNodeKeys: new Set<string>(),
  };
  current.score += weight;
  current.connectedNodeKeys.add(node.key);
  current.work = mergeExternalWorkMetadata(current.work, work);
  candidates.set(identity, current);
}

async function citingWorksForReference(
  reference: RelatedWorkMetadata,
  maximum: number,
): Promise<RelatedWorkMetadata[]> {
  const plan = getProviderPlan("citations", "auto");
  const identifiers = workIdentifiersForRelatedWork(reference);

  for (const providerID of plan.providers) {
    const provider = getCitationProvider(providerID);
    const fetcher = provider.fetchCitingWorks;
    if (!fetcher) continue;
    try {
      let providerWorkID =
        providerID === reference.provider
          ? reference.providerWorkID?.trim() || null
          : null;
      if (!providerWorkID && providerID === "opencitations") {
        providerWorkID = normalizeDOI(reference.doi);
      }
      if (!providerWorkID) {
        const lookup = provider.lookupForRelations ?? provider.lookup;
        let result = provider.supports(identifiers)
          ? await lookup(identifiers)
          : null;
        if (
          (!result || result.status !== "success") &&
          provider.searchExactTitle &&
          identifiers.normalizedTitle
        ) {
          result = await provider.searchExactTitle(identifiers);
        }
        if (result?.status === "success") {
          providerWorkID = result.providerWorkID;
        }
      }
      if (!providerWorkID) continue;
      const works = stampProviderWorks(
        await fetcher(providerWorkID, maximum, 0),
        providerID,
      );
      if (works.length) return works;
    } catch (error) {
      Zotero.debug(
        `Citation Map: bibliographic-coupling lookup failed through ${providerID}: ${String(error)}`,
      );
    }
  }
  return [];
}

/** Find papers that cite several of the same references as the seed. */
async function bibliographicCouplingRecommendations(
  visibleNodes: CitationGraphNode[],
  libraryNodes: CitationGraphNode[],
  maximum: number,
): Promise<ExternalWork[]> {
  const indexes = localExternalWorkIndexes(libraryNodes);
  const candidates = new Map<string, RecommendationCandidate>();
  let sampledReferenceCount = 0;

  for (const node of visibleNodes.slice(0, 5)) {
    const references = (
      await getExternalReferences(node, libraryNodes, 20, 0, false)
    )
      .filter((work) =>
        Boolean(
          work.doi || work.providerWorkID || normalizeExactTitle(work.title),
        ),
      )
      .slice(0, 12);
    sampledReferenceCount += references.length;

    await mapBounded(references, 2, async (reference) => {
      const citing = await citingWorksForReference(reference, 25);
      const seen = new Set<string>();
      for (const work of citing) {
        const identity = externalWorkLookupIdentity(work);
        if (seen.has(identity)) continue;
        seen.add(identity);
        addRecommendationCandidate(candidates, indexes, node, work, 1);
      }
    });
  }

  if (!candidates.size) return [];
  const values = [...candidates.values()];
  const hasStrongCoupling = values.some((candidate) => candidate.score >= 2);
  return values
    .filter((candidate) => !hasStrongCoupling || candidate.score >= 2)
    .map((candidate) => {
      const denominator = Math.sqrt(
        Math.max(1, sampledReferenceCount) *
          Math.max(
            candidate.score,
            candidate.work.referenceCount ?? candidate.score,
          ),
      );
      return {
        ...toExternalWork(candidate.work, indexes.byDOI, indexes.byTitle),
        recommendationScore: candidate.score / denominator,
        citingNodeKeys: [...candidate.connectedNodeKeys],
      };
    })
    .sort(
      (left, right) =>
        (right.recommendationScore ?? 0) - (left.recommendationScore ?? 0) ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1) ||
        (right.year ?? -1) - (left.year ?? -1),
    )
    .slice(0, Math.max(maximum, Math.min(maximum * 2, 100)));
}

async function citationNeighbourFallback(
  visibleNodes: CitationGraphNode[],
  libraryNodes: CitationGraphNode[],
  maximum: number,
  minimumConnections: number,
): Promise<ExternalWork[]> {
  const indexes = localExternalWorkIndexes(libraryNodes);
  const candidates = new Map<string, RecommendationCandidate>();
  const seedLimit = Math.min(visibleNodes.length, 25);
  const perSeedLimit = Math.min(100, Math.max(25, maximum * 2));

  for (const node of visibleNodes.slice(0, seedLimit)) {
    let references = getCachedExternalReferences(
      node,
      libraryNodes,
      perSeedLimit,
      0,
      { queueBackgroundHydration: false },
    );
    if (!references.length && visibleNodes.length === 1) {
      references = await getExternalReferences(
        node,
        libraryNodes,
        perSeedLimit,
        0,
        true,
      );
    }
    for (const reference of references.slice(0, perSeedLimit)) {
      addRecommendationCandidate(candidates, indexes, node, reference, 2);
    }

    const citing =
      visibleNodes.length === 1
        ? await getExternalCitedBy(
            node,
            libraryNodes,
            Math.min(50, perSeedLimit),
            0,
            false,
          )
        : getCachedExternalCitedBy(
            node,
            libraryNodes,
            Math.min(50, perSeedLimit),
            0,
            { queueBackgroundHydration: false },
          );
    for (const work of citing) {
      addRecommendationCandidate(candidates, indexes, node, work, 1);
    }
  }

  const requiredConnections =
    visibleNodes.length <= 1
      ? 1
      : Math.min(Math.max(1, minimumConnections), visibleNodes.length);
  return [...candidates.values()]
    .filter(
      (candidate) => candidate.connectedNodeKeys.size >= requiredConnections,
    )
    .map((candidate) => ({
      ...toExternalWork(candidate.work, indexes.byDOI, indexes.byTitle),
      recommendationScore: candidate.score,
      citingNodeKeys: [...candidate.connectedNodeKeys],
    }))
    .sort(
      (left, right) =>
        (right.citingNodeKeys?.length ?? 0) -
          (left.citingNodeKeys?.length ?? 0) ||
        (right.recommendationScore ?? 0) - (left.recommendationScore ?? 0) ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1) ||
        (right.year ?? -1) - (left.year ?? -1) ||
        String(left.title).localeCompare(String(right.title)),
    )
    .slice(0, Math.max(maximum, Math.min(maximum * 2, 100)));
}

/** Find genuinely similar papers through provider-native recommendation
 * systems, retaining direct citation neighbours only as a bounded fallback. */
export async function getMissingPaperRecommendations(
  visibleNodes: CitationGraphNode[],
  libraryNodes: CitationGraphNode[],
  maximum = 50,
  minimumConnections = 2,
): Promise<ExternalWork[]> {
  if (!visibleNodes.length || maximum <= 0) return [];
  const indexes = localExternalWorkIndexes(libraryNodes);
  const seeds = visibleNodes
    .slice(0, 25)
    .map(workIdentifiersForGraphNode)
    .filter((identifiers) =>
      Boolean(
        identifiers.doi ||
        identifiers.pmid ||
        identifiers.arxiv ||
        identifiers.isbn ||
        identifiers.normalizedTitle,
      ),
    );

  const recommended = await discoverSimilarWorks(
    seeds,
    "auto",
    Math.min(500, Math.max(maximum * 3, 100)),
  );
  const providerResults = recommended
    .map((work) => ({
      ...toExternalWork(work, indexes.byDOI, indexes.byTitle),
      recommendationScore: work.recommendationScore,
      recommendationSources: work.recommendationSources,
    }))
    .filter((work) => !work.inLibraryItemKey)
    .slice(0, Math.max(maximum, Math.min(maximum * 2, 100)));

  if (providerResults.length) {
    const hydrated = await hydrateExternalWorksMetadata(providerResults);
    return hydrated
      .filter((work) => Boolean(externalWorkDisplayTitle(work)))
      .slice(0, maximum);
  }

  const coupled = await bibliographicCouplingRecommendations(
    visibleNodes,
    libraryNodes,
    maximum,
  );
  const fallback = coupled.length
    ? coupled
    : await citationNeighbourFallback(
        visibleNodes,
        libraryNodes,
        maximum,
        minimumConnections,
      );
  const hydrated = await hydrateExternalWorksMetadata(fallback);
  return hydrated
    .filter((work) => Boolean(externalWorkDisplayTitle(work)))
    .slice(0, maximum);
}
