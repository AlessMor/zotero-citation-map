import type {
  CitationProviderID,
  CitationProviderPreference,
  ProviderLookupResult,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { fetchOpenAlexWorksBatch } from "../providers/openAlexProvider";
import {
  openAlexIdentifierForIdentifiers,
  semanticScholarIdentifierForIdentifiers,
} from "../providers/providerIdentifiers";
import { lookupCitationMetrics } from "../providers/providerLookupService";
import {
  fetchSemanticScholarPapersBatch,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
} from "../providers/semanticScholarProvider";
import { isCitationRequestCancellationRequested } from "../providers/http";
import type { ProviderRequestOptions } from "../providers/types";
import { cancellationRequested } from "./cancellationScope";
import { getOpenAlexAPIKey, isProviderEnabled } from "./citationPreferences";
import { normalizeDOI } from "../domain/workIdentity";
import {
  LIBRARY_CORE_FALLBACK_PARALLELISM,
  providerExecutionPolicy,
} from "./providerExecutionPolicy";
import type { PlannedCitationItem } from "./updatePlanner";
import { mapBounded } from "./backgroundTaskService";

export type ProviderIdentityHints = Partial<Record<CitationProviderID, string>>;

export interface LibraryCoreBatchProgress {
  completed: number;
  total: number;
  message: string;
}

export interface LibraryCoreBatchResult {
  lookups: ProviderLookupResult[];
  providerIdentitiesByItemKey: Map<string, ProviderIdentityHints>;
}

interface BatchCandidate {
  identifier: string;
  indexes: number[];
}

function chunked<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

function matchedBy(
  metadata: RelatedWorkMetadata,
  requested: WorkIdentifiers,
): ProviderLookupSuccess["matchedBy"] {
  if (requested.doi && normalizeDOI(metadata.doi) === requested.doi)
    return "doi";
  if (requested.pmid && metadata.pmid === requested.pmid) return "pmid";
  if (requested.arxiv && metadata.arxiv === requested.arxiv) return "arxiv";
  if (requested.isbn && metadata.isbn === requested.isbn) return "isbn";
  return "title";
}

function successFromMetadata(
  metadata: RelatedWorkMetadata,
  requested: WorkIdentifiers,
): ProviderLookupSuccess {
  const provider = metadata.provider as CitationProviderID;
  const matchKind = matchedBy(metadata, requested);
  return {
    status: "success",
    provider,
    matchedBy: matchKind,
    matchConfidence:
      matchKind === "doi" ? 1 : matchKind === "title" ? 0.92 : 0.98,
    providerWorkID: metadata.providerWorkID,
    doi: metadata.doi,
    title: metadata.title,
    year: metadata.year,
    authors: [...metadata.authors],
    sourceTitle: metadata.sourceTitle ?? null,
    abstract: metadata.abstract ?? null,
    citationCount: metadata.citationCount ?? null,
    citationCountProvider: provider,
    referenceCount: metadata.referenceCount ?? null,
    referenceCountProvider: provider,
    resolvedReferenceCount: metadata.references?.length ?? 0,
    references: metadata.references ?? [],
    fwci: metadata.fwci ?? null,
    citationPercentile: metadata.citationPercentile ?? null,
    isTop1Percent: metadata.isTop1Percent ?? null,
    isTop10Percent: metadata.isTop10Percent ?? null,
    citationCountsByYear: metadata.citationCountsByYear ?? [],
    citationsLastYear: metadata.citationsLastYear ?? null,
    citationVelocity: metadata.citationVelocity ?? null,
    citationAcceleration: metadata.citationAcceleration ?? null,
    influentialCitationCount: metadata.influentialCitationCount ?? null,
    isRetracted: metadata.isRetracted ?? null,
    openAccessStatus: metadata.openAccessStatus ?? null,
    isOpenAccess: metadata.isOpenAccess ?? null,
    publicationType: metadata.publicationType ?? null,
    sourceMetrics: metadata.sourceMetrics ?? null,
  };
}

function successFromRecord(
  record: NonNullable<PlannedCitationItem["previous"]>,
): ProviderLookupSuccess {
  return {
    status: "success",
    provider: record.provider,
    matchedBy: record.matchedBy ?? "title",
    matchConfidence: record.matchConfidence ?? 1,
    providerWorkID: record.providerWorkID,
    doi: record.doi,
    title: record.title,
    year: record.year,
    authors: [...record.authors],
    sourceTitle: record.sourceTitle,
    abstract: record.abstract,
    citationCount: record.citationCount,
    citationCountProvider: record.citationCountProvider ?? record.provider,
    referenceCount: record.referenceCount,
    referenceCountProvider: record.referenceCountProvider ?? record.provider,
    resolvedReferenceCount: record.resolvedReferenceCount,
    references: record.references,
    fwci: record.fwci,
    citationPercentile: record.citationPercentile,
    isTop1Percent: record.isTop1Percent,
    isTop10Percent: record.isTop10Percent,
    citationCountsByYear: record.citationCountsByYear,
    citationsLastYear: record.citationsLastYear,
    citationVelocity: record.citationVelocity,
    citationAcceleration: record.citationAcceleration,
    influentialCitationCount: record.influentialCitationCount,
    isRetracted: record.isRetracted,
    openAccessStatus: record.openAccessStatus,
    isOpenAccess: record.isOpenAccess,
    publicationType: record.publicationType,
    sourceMetrics: record.sourceMetrics,
  };
}

function unavailableResult(
  preference: CitationProviderPreference,
): ProviderLookupResult {
  return {
    status: "not-found",
    provider: preference === "auto" ? "crossref" : preference,
    message: "No citation provider returned a matching work.",
  };
}

function addIdentityHint(
  hints: Map<string, ProviderIdentityHints>,
  itemKey: string,
  metadata: RelatedWorkMetadata,
): void {
  if (
    metadata.provider === "manual" ||
    metadata.provider === "zotero" ||
    !metadata.providerWorkID
  ) {
    return;
  }
  const current = hints.get(itemKey) ?? {};
  current[metadata.provider] = metadata.providerWorkID;
  hints.set(itemKey, current);
}

function batchCandidates(
  pending: PlannedCitationItem[],
  unresolved: Set<number>,
  provider: "semantic-scholar" | "openalex",
): BatchCandidate[] {
  const grouped = new Map<string, number[]>();
  for (const index of unresolved) {
    const identifier =
      provider === "semantic-scholar"
        ? semanticScholarIdentifierForIdentifiers(pending[index].identifiers)
        : openAlexIdentifierForIdentifiers(pending[index].identifiers);
    if (!identifier) continue;
    const indexes = grouped.get(identifier) ?? [];
    indexes.push(index);
    grouped.set(identifier, indexes);
  }
  return [...grouped].map(([identifier, indexes]) => ({ identifier, indexes }));
}

async function resolveProviderBatches(
  provider: "semantic-scholar" | "openalex",
  pending: PlannedCitationItem[],
  unresolved: Set<number>,
  lookups: Array<ProviderLookupResult | null>,
  hints: Map<string, ProviderIdentityHints>,
  onProgress?: (progress: LibraryCoreBatchProgress) => void,
  requestOptions?: ProviderRequestOptions,
): Promise<void> {
  const candidates = batchCandidates(pending, unresolved, provider);
  if (!candidates.length) return;
  const policy = providerExecutionPolicy(provider);
  const batchSize =
    provider === "semantic-scholar"
      ? Math.min(policy.batchSize, SEMANTIC_SCHOLAR_BATCH_LIMIT)
      : policy.batchSize;
  const batches = chunked(candidates, batchSize);
  let completedBatches = 0;
  await mapBounded(
    batches,
    policy.requestParallelism,
    async (batch) => {
      if (
        isCitationRequestCancellationRequested() ||
        cancellationRequested(requestOptions?.signal)
      ) {
        return;
      }
      try {
        const metadata =
          provider === "semantic-scholar"
            ? await fetchSemanticScholarPapersBatch(
                batch.map((candidate) => candidate.identifier),
                requestOptions,
              )
            : await fetchOpenAlexWorksBatch(
                batch.map((candidate) => candidate.identifier),
                requestOptions,
              );
        for (const [batchIndex, candidate] of batch.entries()) {
          const entry = metadata[batchIndex];
          if (!entry) continue;
          for (const index of candidate.indexes) {
            lookups[index] = successFromMetadata(
              entry,
              pending[index].identifiers,
            );
            unresolved.delete(index);
            addIdentityHint(hints, pending[index].itemKey, entry);
          }
        }
      } catch (error) {
        Zotero.debug(
          `Citation Map: ${provider} core batch failed; unresolved works will use fallback lookup: ${String(error)}`,
        );
      }
      completedBatches += 1;
      onProgress?.({
        completed: pending.length - unresolved.size,
        total: pending.length,
        message:
          `${provider === "semantic-scholar" ? "Semantic Scholar" : "OpenAlex"} ` +
          `batch ${completedBatches}/${batches.length}`,
      });
    },
    { yieldAfterEach: true },
  );
}

/**
 * Resolve canonical library-paper records in provider batches first. Only the
 * small remainder that cannot use a batch identifier falls back to ordinary
 * per-item provider routing.
 */
export async function resolveLibraryCoreLookups(
  pending: PlannedCitationItem[],
  preference: CitationProviderPreference,
  allowTitleFallback: boolean,
  onProgress?: (progress: LibraryCoreBatchProgress) => void,
  requestOptions?: ProviderRequestOptions,
): Promise<LibraryCoreBatchResult> {
  const lookups: Array<ProviderLookupResult | null> = pending.map(() => null);
  const unresolved = new Set(pending.map((_, index) => index));
  const providerIdentitiesByItemKey = new Map<string, ProviderIdentityHints>();

  for (const [index, planned] of pending.entries()) {
    const previous = planned.previous;
    if (
      planned.needsCoreRefresh ||
      !previous ||
      previous.status !== "success"
    ) {
      continue;
    }
    lookups[index] = successFromRecord(previous);
    unresolved.delete(index);
    if (previous.providerWorkID) {
      providerIdentitiesByItemKey.set(planned.itemKey, {
        [previous.provider]: previous.providerWorkID,
        ...(previous.sourceMetrics?.libraryUpdateState?.providerWorkIDs ?? {}),
      });
    } else if (previous.sourceMetrics?.libraryUpdateState?.providerWorkIDs) {
      providerIdentitiesByItemKey.set(planned.itemKey, {
        ...previous.sourceMetrics.libraryUpdateState.providerWorkIDs,
      });
    }
  }

  const batchProviders: Array<"semantic-scholar" | "openalex"> = [];
  if (
    (preference === "auto" || preference === "semantic-scholar") &&
    isProviderEnabled("semantic-scholar")
  ) {
    batchProviders.push("semantic-scholar");
  }
  if (
    (preference === "auto" || preference === "openalex") &&
    isProviderEnabled("openalex") &&
    Boolean(getOpenAlexAPIKey())
  ) {
    batchProviders.push("openalex");
  }

  for (const provider of batchProviders) {
    if (
      !unresolved.size ||
      isCitationRequestCancellationRequested() ||
      cancellationRequested(requestOptions?.signal)
    ) {
      break;
    }
    await resolveProviderBatches(
      provider,
      pending,
      unresolved,
      lookups,
      providerIdentitiesByItemKey,
      onProgress,
      requestOptions,
    );
  }

  const fallbackGroups = new Map<string, number[]>();
  for (const index of unresolved) {
    const identifiers = pending[index].identifiers;
    const key = identifiers.doi
      ? `doi:${identifiers.doi}`
      : identifiers.normalizedTitle
        ? `title:${identifiers.normalizedTitle}:year:${identifiers.year ?? "unknown"}`
        : `item:${pending[index].libraryID}:${pending[index].itemKey}`;
    const indexes = fallbackGroups.get(key) ?? [];
    indexes.push(index);
    fallbackGroups.set(key, indexes);
  }
  await mapBounded(
    [...fallbackGroups.values()],
    LIBRARY_CORE_FALLBACK_PARALLELISM,
    async (indexes) => {
      if (
        isCitationRequestCancellationRequested() ||
        cancellationRequested(requestOptions?.signal)
      ) {
        return;
      }
      const representative = indexes[0];
      const result = await lookupCitationMetrics(
        preference,
        pending[representative].identifiers,
        allowTitleFallback,
        false,
        requestOptions,
      );
      for (const index of indexes) {
        lookups[index] = result;
        if (result.status === "success" && result.providerWorkID) {
          const current =
            providerIdentitiesByItemKey.get(pending[index].itemKey) ?? {};
          current[result.provider as CitationProviderID] =
            result.providerWorkID;
          providerIdentitiesByItemKey.set(pending[index].itemKey, current);
        }
        unresolved.delete(index);
      }
      onProgress?.({
        completed: pending.length - unresolved.size,
        total: pending.length,
        message: `Resolving unmatched papers · ${pending.length - unresolved.size}/${pending.length}`,
      });
    },
    { yieldAfterEach: true },
  );

  return {
    lookups: lookups.map((lookup) => lookup ?? unavailableResult(preference)),
    providerIdentitiesByItemKey,
  };
}
