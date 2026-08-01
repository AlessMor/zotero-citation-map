import type {
  CitationProviderPreference,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import {
  mergeRelatedWorkMetadata,
  relatedWorkFromProviderLookup,
} from "../domain/relatedWorkMetadata";
import { workIdentifiersForRelatedWork } from "../domain/workIdentifiers";
import { mapBounded } from "../services/backgroundTaskService";
import { fetchOpenAlexWorksBatch } from "./openAlexProvider";
import {
  openAlexIdentifierForWork,
  semanticScholarIdentifierForWork,
} from "./providerIdentifiers";
import { lookupWithProvider } from "./providerLookupService";
import {
  getCitationProvider,
  getProviderPlan,
  recordProviderFailure,
  recordProviderSuccess,
} from "./registry";
import {
  fetchSemanticScholarPapersBatch,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
} from "./semanticScholarProvider";
import { relationshipPolicyFor } from "./relationshipPolicy";

const SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE = Math.min(
  relationshipPolicyFor("semantic-scholar").metadataBatchSize,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
);
const METADATA_RESOLUTION_CONCURRENCY = 2;

function relatedWorkNeedsMetadata(
  work: RelatedWorkMetadata,
  includeSecondaryMetrics = false,
): boolean {
  const basicMissing =
    !String(work.title ?? "").trim() ||
    work.year === null ||
    work.authors.length === 0 ||
    !String(work.sourceTitle ?? "").trim();
  if (basicMissing || !includeSecondaryMetrics) return basicMissing;

  return (
    work.citationCount == null ||
    work.referenceCount == null ||
    work.fwci == null ||
    work.citationPercentile == null ||
    work.citationsLastYear == null ||
    work.citationVelocity == null ||
    work.citationAcceleration == null ||
    work.influentialCitationCount == null ||
    work.publicationType == null ||
    work.sourceMetrics == null ||
    work.isOpenAccess == null ||
    work.isRetracted == null ||
    !work.references?.length
  );
}

async function applySemanticScholarBatch(
  works: RelatedWorkMetadata[],
): Promise<void> {
  const candidates = works
    .map((work, index) => ({
      index,
      identifier: semanticScholarIdentifierForWork(work),
    }))
    .filter((candidate): candidate is { index: number; identifier: string } =>
      Boolean(candidate.identifier),
    );
  for (
    let start = 0;
    start < candidates.length;
    start += SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE
  ) {
    const batch = candidates.slice(
      start,
      start + SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE,
    );
    const metadata = await fetchSemanticScholarPapersBatch(
      batch.map((candidate) => candidate.identifier),
    );
    for (const [batchIndex, candidate] of batch.entries()) {
      const entry = metadata[batchIndex];
      if (!entry) continue;
      works[candidate.index] = mergeRelatedWorkMetadata(
        works[candidate.index],
        entry,
      );
    }
  }
}

async function applyOpenAlexBatch(works: RelatedWorkMetadata[]): Promise<void> {
  const candidates = works
    .map((work, index) => ({
      index,
      identifier: openAlexIdentifierForWork(work),
    }))
    .filter((candidate): candidate is { index: number; identifier: string } =>
      Boolean(candidate.identifier),
    );
  for (let start = 0; start < candidates.length; start += 100) {
    const batch = candidates.slice(start, start + 100);
    const metadata = await fetchOpenAlexWorksBatch(
      batch.map((candidate) => candidate.identifier),
    );
    for (const [batchIndex, candidate] of batch.entries()) {
      const entry = metadata[batchIndex];
      if (!entry) continue;
      works[candidate.index] = mergeRelatedWorkMetadata(
        works[candidate.index],
        entry,
      );
    }
  }
}

export interface RelatedWorkResolutionOptions {
  /** Maximum non-batch lookups across all providers. Batch lookups are not
   * counted. Use zero for latency-sensitive relationship refreshes. */
  individualLookupLimit?: number;
}

/** Resolve incomplete external-paper records through the user-selected
 * provider policy. Batch-capable providers run first and per-work fallbacks are
 * capped so a large bibliography cannot trigger unbounded sequential work. */
export async function resolveRelatedWorksMetadata(
  input: RelatedWorkMetadata[],
  preference: CitationProviderPreference,
  includeSecondaryMetrics = false,
  options: RelatedWorkResolutionOptions = {},
): Promise<RelatedWorkMetadata[]> {
  const works = input.map((work) => ({ ...work, authors: [...work.authors] }));
  const plan = getProviderPlan("metadata-resolution", preference);
  let remainingIndividualLookups = Math.max(
    0,
    options.individualLookupLimit ?? Number.POSITIVE_INFINITY,
  );

  for (const providerID of plan.providers) {
    const unresolvedIndexes = works
      .map((work, index) => ({ work, index }))
      .filter(({ work }) =>
        relatedWorkNeedsMetadata(work, includeSecondaryMetrics),
      )
      .map(({ index }) => index);
    if (!unresolvedIndexes.length) break;

    const subset = unresolvedIndexes.map((index) => works[index]);
    const batchEligible = subset.map((work) =>
      providerID === "semantic-scholar"
        ? Boolean(semanticScholarIdentifierForWork(work))
        : providerID === "openalex"
          ? Boolean(openAlexIdentifierForWork(work))
          : false,
    );
    try {
      if (providerID === "semantic-scholar") {
        await applySemanticScholarBatch(subset);
      } else if (providerID === "openalex") {
        await applyOpenAlexBatch(subset);
      }
    } catch (error) {
      Zotero.debug(
        "Citation Map: " +
          `${getCitationProvider(providerID).label} batch metadata resolution failed: ` +
          String(error),
      );
    }
    for (const [subsetIndex, originalIndex] of unresolvedIndexes.entries()) {
      works[originalIndex] = subset[subsetIndex];
    }

    if (remainingIndividualLookups <= 0) continue;
    const provider = getCitationProvider(providerID);
    const genericCandidates = unresolvedIndexes
      .filter(
        (_, subsetIndex) =>
          !batchEligible[subsetIndex] &&
          relatedWorkNeedsMetadata(
            works[unresolvedIndexes[subsetIndex]],
            includeSecondaryMetrics,
          ),
      )
      .slice(0, remainingIndividualLookups);
    remainingIndividualLookups -= genericCandidates.length;
    await mapBounded(
      genericCandidates,
      METADATA_RESOLUTION_CONCURRENCY,
      async (workIndex) => {
        const identifiers = workIdentifiersForRelatedWork(works[workIndex]);
        try {
          const result = await lookupWithProvider(
            provider,
            identifiers,
            true,
            true,
          );
          if (result.status === "success") {
            recordProviderSuccess(provider.id);
            works[workIndex] = mergeRelatedWorkMetadata(works[workIndex], {
              ...relatedWorkFromProviderLookup(result),
              updatedAt: new Date().toISOString(),
            });
          } else {
            recordProviderFailure(preference, result);
          }
        } catch (error) {
          Zotero.debug(
            "Citation Map: " +
              `${provider.label} metadata resolution failed: ${String(error)}`,
          );
        }
      },
    );
  }

  return works;
}
