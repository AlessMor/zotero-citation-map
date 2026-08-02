import type {
  CitationMetricRecord,
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import { fetchOpenAlexWorksBatch } from "../providers/openAlexProvider";
import {
  openAlexIdentifierForWork,
  semanticScholarIdentifierForWork,
} from "../providers/providerIdentifiers";
import {
  fetchSemanticScholarPapersBatch,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
} from "../providers/semanticScholarProvider";
import { mergeRelatedWorkMetadata } from "../domain/relatedWorkMetadata";
import { isCitationRequestCancellationRequested } from "../providers/http";
import type { ProviderRequestOptions } from "../providers/types";
import { cancellationRequested } from "./cancellationScope";
import { saveCitationMetricRecords } from "./citationMetricsStore";
import { getOpenAlexAPIKey, isProviderEnabled } from "./citationPreferences";
import {
  CITATION_RECORD_WRITE_CHUNK_SIZE,
  providerExecutionPolicy,
} from "./providerExecutionPolicy";
import type { ProviderIdentityHints } from "./libraryCoreBatchService";
import { mergeRelatedWorkLists } from "./relationshipStoreService";
import {
  createCooperativeCheckpoint,
  mapCooperatively,
  settleBounded,
  yieldToUI,
} from "./backgroundTaskService";
import { normalizeDOI } from "../domain/workIdentity";
import { authoritativeReferenceCountAttribution } from "./citationCountPolicy";

export interface BatchEnrichmentProgress {
  completed: number;
  total: number;
  activeBatches: number;
  message: string;
}

export interface BatchEnrichmentResult {
  records: CitationMetricRecord[];
  enriched: number;
  unchanged: number;
  failedBatches: number;
  providerIdentitiesByItemKey: Map<string, ProviderIdentityHints>;
}

interface UniqueWorkTarget {
  work: RelatedWorkMetadata;
  recordIndexes: number[];
  citationCountProvider: CitationProviderID | null;
  referenceCountProvider: CitationProviderID | null;
  providerWorkIDs: ProviderIdentityHints;
}

interface ProviderBatchTask {
  provider: CitationProviderID;
  label: string;
  run: () => Promise<void>;
}

interface IndexedIdentifier {
  targetIndex: number;
  identifier: string;
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

function recordIdentity(record: CitationMetricRecord): string {
  const doi = normalizeDOI(record.doi);
  if (doi) return `doi:${doi}`;
  const providerID = String(record.providerWorkID ?? "").trim();
  if (providerID) return `${record.provider}:${providerID.toLocaleLowerCase()}`;
  const title = String(record.normalizedTitle ?? record.title ?? "")
    .trim()
    .toLocaleLowerCase();
  return `title:${title}:year:${record.year ?? "unknown"}:item:${record.itemKey}`;
}

function recordToRelatedWork(
  record: CitationMetricRecord,
): RelatedWorkMetadata {
  return {
    provider: record.provider,
    providerWorkID: record.providerWorkID,
    doi: record.doi,
    pmid: null,
    arxiv: null,
    isbn: null,
    title: record.title,
    year: record.year,
    authors: [...record.authors],
    sourceTitle: record.sourceTitle,
    abstract: record.abstract,
    citationCount: record.citationCount,
    referenceCount: record.referenceCount,
    citationCountsByYear: [...record.citationCountsByYear],
    references: record.references.map((reference) => ({
      ...reference,
      authors: [...reference.authors],
      authorIDs: [...(reference.authorIDs ?? [])],
    })),
    resolvedReferenceCount: record.resolvedReferenceCount,
    fwci: record.fwci,
    citationPercentile: record.citationPercentile,
    isTop1Percent: record.isTop1Percent,
    isTop10Percent: record.isTop10Percent,
    citationsLastYear: record.citationsLastYear,
    citationVelocity: record.citationVelocity,
    citationAcceleration: record.citationAcceleration,
    influentialCitationCount: record.influentialCitationCount,
    publicationType: record.publicationType,
    sourceMetrics: record.sourceMetrics,
    isOpenAccess: record.isOpenAccess,
    openAccessStatus: record.openAccessStatus,
    isRetracted: record.isRetracted,
    dataSources: [record.provider],
    updatedAt: record.fetchedAt,
  };
}

function chooseLargerCount(
  previous: number | null | undefined,
  candidate: number | null | undefined,
): boolean {
  if (candidate == null) return false;
  return previous == null || candidate > previous;
}

function mergeTargetRecord(
  target: UniqueWorkTarget,
  record: CitationMetricRecord,
): void {
  const candidate = recordToRelatedWork(record);
  if (chooseLargerCount(target.work.citationCount, candidate.citationCount)) {
    target.citationCountProvider =
      record.citationCountProvider ?? record.provider;
  }
  const referenceCount = authoritativeReferenceCountAttribution([
    {
      count: target.work.referenceCount ?? null,
      provider: target.referenceCountProvider,
    },
    {
      count: candidate.referenceCount ?? null,
      provider: record.referenceCountProvider ?? record.provider,
    },
  ]);
  target.work = mergeRelatedWorkMetadata(target.work, candidate);
  target.work.referenceCount = referenceCount.count;
  target.referenceCountProvider = referenceCount.provider;
  if (record.providerWorkID) {
    target.providerWorkIDs[record.provider] = record.providerWorkID;
  }
}

function mergeProviderMetadata(
  target: UniqueWorkTarget,
  metadata: RelatedWorkMetadata,
  provider: CitationProviderID,
): void {
  if (chooseLargerCount(target.work.citationCount, metadata.citationCount)) {
    target.citationCountProvider = provider;
  }
  const referenceCount = authoritativeReferenceCountAttribution([
    {
      count: target.work.referenceCount ?? null,
      provider: target.referenceCountProvider,
    },
    { count: metadata.referenceCount ?? null, provider },
  ]);
  target.work = mergeRelatedWorkMetadata(target.work, metadata);
  target.work.referenceCount = referenceCount.count;
  target.referenceCountProvider = referenceCount.provider;
  if (metadata.providerWorkID) {
    target.providerWorkIDs[provider] = metadata.providerWorkID;
  }
}

function needsSemanticScholarEnrichment(work: RelatedWorkMetadata): boolean {
  return (
    !String(work.title ?? "").trim() ||
    !work.authors.length ||
    work.year == null ||
    !String(work.sourceTitle ?? "").trim() ||
    work.citationCount == null ||
    work.referenceCount == null ||
    work.influentialCitationCount == null ||
    work.publicationType == null ||
    work.isOpenAccess == null
  );
}

function needsOpenAlexEnrichment(work: RelatedWorkMetadata): boolean {
  return (
    !String(work.title ?? "").trim() ||
    !work.authors.length ||
    work.year == null ||
    !String(work.sourceTitle ?? "").trim() ||
    work.citationCount == null ||
    work.referenceCount == null ||
    work.fwci == null ||
    work.citationPercentile == null ||
    work.isTop1Percent == null ||
    work.isTop10Percent == null ||
    !(work.citationCountsByYear?.length ?? 0) ||
    work.citationsLastYear == null ||
    work.citationVelocity == null ||
    work.citationAcceleration == null ||
    work.publicationType == null ||
    work.isOpenAccess == null ||
    work.isRetracted == null
  );
}

function mergeRecordEnrichment(
  record: CitationMetricRecord,
  target: UniqueWorkTarget,
): CitationMetricRecord {
  const merged = mergeRelatedWorkMetadata(
    recordToRelatedWork(record),
    target.work,
  );
  const useEnrichedCitationCount = chooseLargerCount(
    record.citationCount,
    merged.citationCount,
  );
  const referenceCount = authoritativeReferenceCountAttribution([
    {
      count: record.referenceCount,
      provider: record.referenceCountProvider,
    },
    {
      count: merged.referenceCount ?? null,
      provider: target.referenceCountProvider,
    },
  ]);
  const citationCount = useEnrichedCitationCount
    ? (merged.citationCount ?? null)
    : record.citationCount;
  const references = mergeRelatedWorkLists(
    record.references,
    merged.references ?? [],
  );
  const now = new Date().toISOString();

  return {
    ...record,
    doi: record.doi ?? merged.doi,
    title: record.title ?? merged.title,
    year: record.year ?? merged.year,
    authors: record.authors.length ? record.authors : [...merged.authors],
    sourceTitle: record.sourceTitle ?? merged.sourceTitle ?? null,
    abstract: record.abstract ?? merged.abstract ?? null,
    citationCount,
    citationCountProvider: useEnrichedCitationCount
      ? (target.citationCountProvider ?? record.citationCountProvider)
      : record.citationCountProvider,
    referenceCount: referenceCount.count,
    referenceCountProvider: referenceCount.provider,
    references,
    resolvedReferenceCount: Math.max(
      record.resolvedReferenceCount,
      merged.resolvedReferenceCount ?? 0,
      references.length,
    ),
    fwci: record.fwci ?? merged.fwci ?? null,
    citationPercentile:
      record.citationPercentile ?? merged.citationPercentile ?? null,
    isTop1Percent: record.isTop1Percent ?? merged.isTop1Percent ?? null,
    isTop10Percent: record.isTop10Percent ?? merged.isTop10Percent ?? null,
    citationCountsByYear: record.citationCountsByYear.length
      ? record.citationCountsByYear
      : [...(merged.citationCountsByYear ?? [])],
    citationsLastYear:
      record.citationsLastYear ?? merged.citationsLastYear ?? null,
    citationVelocity:
      record.citationVelocity ?? merged.citationVelocity ?? null,
    citationAcceleration:
      record.citationAcceleration ?? merged.citationAcceleration ?? null,
    influentialCitationCount:
      record.influentialCitationCount ??
      merged.influentialCitationCount ??
      null,
    publicationType: record.publicationType ?? merged.publicationType ?? null,
    sourceMetrics: record.sourceMetrics ?? merged.sourceMetrics ?? null,
    isOpenAccess: record.isOpenAccess ?? merged.isOpenAccess ?? null,
    openAccessStatus:
      record.openAccessStatus ?? merged.openAccessStatus ?? null,
    isRetracted: record.isRetracted ?? merged.isRetracted ?? null,
    fetchedAt: now,
    lastAttemptAt: now,
  };
}

function enrichmentSignature(record: CitationMetricRecord): string {
  return JSON.stringify([
    record.doi,
    record.title,
    record.year,
    record.authors,
    record.sourceTitle,
    record.abstract,
    record.citationCount,
    record.citationCountProvider,
    record.referenceCount,
    record.referenceCountProvider,
    record.resolvedReferenceCount,
    record.references.length,
    record.fwci,
    record.citationPercentile,
    record.isTop1Percent,
    record.isTop10Percent,
    record.citationCountsByYear,
    record.citationsLastYear,
    record.citationVelocity,
    record.citationAcceleration,
    record.influentialCitationCount,
    record.publicationType,
    record.sourceMetrics,
    record.isOpenAccess,
    record.openAccessStatus,
    record.isRetracted,
  ]);
}

function providerTasks(
  targets: UniqueWorkTarget[],
  requestOptions?: ProviderRequestOptions,
): ProviderBatchTask[] {
  const tasks: ProviderBatchTask[] = [];

  if (isProviderEnabled("semantic-scholar")) {
    const candidates: IndexedIdentifier[] = targets
      .map((target, targetIndex) => ({
        targetIndex,
        identifier: semanticScholarIdentifierForWork(target.work),
      }))
      .filter(
        (candidate): candidate is IndexedIdentifier =>
          Boolean(candidate.identifier) &&
          needsSemanticScholarEnrichment(targets[candidate.targetIndex].work),
      );
    const semanticBatchSize = Math.min(
      SEMANTIC_SCHOLAR_BATCH_LIMIT,
      providerExecutionPolicy("semantic-scholar").batchSize,
    );
    const batches = chunked(candidates, semanticBatchSize);
    for (const [batchIndex, batch] of batches.entries()) {
      tasks.push({
        provider: "semantic-scholar",
        label: `Semantic Scholar ${batchIndex + 1}/${batches.length}`,
        run: async () => {
          const metadata = await fetchSemanticScholarPapersBatch(
            batch.map((candidate) => candidate.identifier),
            requestOptions,
          );
          for (const [index, candidate] of batch.entries()) {
            const entry = metadata[index];
            if (entry) {
              mergeProviderMetadata(
                targets[candidate.targetIndex],
                entry,
                "semantic-scholar",
              );
            }
          }
        },
      });
    }
  }

  if (isProviderEnabled("openalex") && getOpenAlexAPIKey()) {
    const candidates: IndexedIdentifier[] = targets
      .map((target, targetIndex) => ({
        targetIndex,
        identifier: openAlexIdentifierForWork(target.work),
      }))
      .filter(
        (candidate): candidate is IndexedIdentifier =>
          Boolean(candidate.identifier) &&
          needsOpenAlexEnrichment(targets[candidate.targetIndex].work),
      );
    const batches = chunked(
      candidates,
      providerExecutionPolicy("openalex").batchSize,
    );
    for (const [batchIndex, batch] of batches.entries()) {
      tasks.push({
        provider: "openalex",
        label: `OpenAlex ${batchIndex + 1}/${batches.length}`,
        run: async () => {
          const metadata = await fetchOpenAlexWorksBatch(
            batch.map((candidate) => candidate.identifier),
            requestOptions,
          );
          for (const [index, candidate] of batch.entries()) {
            const entry = metadata[index];
            if (entry) {
              mergeProviderMetadata(
                targets[candidate.targetIndex],
                entry,
                "openalex",
              );
            }
          }
        },
      });
    }
  }

  return tasks;
}

async function runProviderTaskGroups(
  tasks: ProviderBatchTask[],
  execute: (task: ProviderBatchTask) => Promise<void>,
): Promise<Array<PromiseSettledResult<void>>> {
  const groups = new Map<CitationProviderID, ProviderBatchTask[]>();
  for (const task of tasks) {
    const group = groups.get(task.provider) ?? [];
    group.push(task);
    groups.set(task.provider, group);
  }

  // Provider batches can return large JSON payloads at nearly the same time.
  // Running every provider group concurrently causes parsing and merge bursts
  // on Zotero's single UI thread. Preserve each provider's own bounded
  // parallelism, but process provider groups one after another and leave a
  // short interaction window between them.
  const results: Array<PromiseSettledResult<void>> = [];
  for (const [provider, providerTasks] of groups) {
    results.push(
      ...(await settleBounded(
        providerTasks,
        providerExecutionPolicy(provider).requestParallelism,
        execute,
        { yieldAfterEach: true, yieldDelayMs: 12 },
      )),
    );
    await yieldToUI(12);
  }
  return results;
}

/**
 * Enrich successful source-item records in provider-sized batches. Stable
 * identities are deduplicated first, so duplicate Zotero records or repeated
 * versions of the same paper are resolved only once per update job.
 */
export async function enrichCitationMetricRecords(
  input: CitationMetricRecord[],
  onProgress?: (progress: BatchEnrichmentProgress) => void,
  requestOptions?: ProviderRequestOptions,
): Promise<BatchEnrichmentResult> {
  if (
    !input.length ||
    isCitationRequestCancellationRequested() ||
    cancellationRequested(requestOptions?.signal)
  ) {
    return {
      records: input,
      enriched: 0,
      unchanged: input.length,
      failedBatches: 0,
      providerIdentitiesByItemKey: new Map(),
    };
  }

  const checkpoint = createCooperativeCheckpoint();
  const records: CitationMetricRecord[] = await mapCooperatively(
    input,
    (record) => ({
      ...record,
      authors: [...record.authors],
      citationCountsByYear: [...record.citationCountsByYear],
      references: record.references.map((reference) => ({
        ...reference,
        authors: [...reference.authors],
        authorIDs: [...(reference.authorIDs ?? [])],
      })),
    }),
    { forceEvery: 20 },
  );
  const uniqueByIdentity = new Map<string, UniqueWorkTarget>();
  for (const [recordIndex, record] of records.entries()) {
    const identity = recordIdentity(record);
    const current = uniqueByIdentity.get(identity);
    if (current) {
      mergeTargetRecord(current, record);
      current.recordIndexes.push(recordIndex);
    } else {
      uniqueByIdentity.set(identity, {
        work: recordToRelatedWork(record),
        recordIndexes: [recordIndex],
        citationCountProvider: record.citationCountProvider,
        referenceCountProvider: record.referenceCountProvider,
        providerWorkIDs: record.providerWorkID
          ? { [record.provider]: record.providerWorkID }
          : {},
      });
    }
    await checkpoint();
  }

  const uniqueTargets = [...uniqueByIdentity.values()];
  const tasks = providerTasks(uniqueTargets, requestOptions);
  const total = tasks.length;
  let completed = 0;
  let activeBatches = 0;

  const executableTasks = tasks.map((task) => async (): Promise<void> => {
    if (
      isCitationRequestCancellationRequested() ||
      cancellationRequested(requestOptions?.signal)
    ) {
      return;
    }
    activeBatches += 1;
    onProgress?.({
      completed,
      total,
      activeBatches,
      message: `${task.label} · ${completed}/${total} provider batches complete`,
    });
    try {
      await task.run();
    } finally {
      completed += 1;
      activeBatches = Math.max(0, activeBatches - 1);
      onProgress?.({
        completed,
        total,
        activeBatches,
        message: `${completed}/${total} provider batches complete${activeBatches ? ` · ${activeBatches} active` : ""}`,
      });
      await checkpoint(true);
    }
  });

  const executableByTask = new Map(
    tasks.map((task, index) => [task, executableTasks[index]]),
  );
  const settled = await runProviderTaskGroups(tasks, async (task) => {
    await executableByTask.get(task)!();
  });

  for (const target of uniqueTargets) {
    for (const recordIndex of target.recordIndexes) {
      records[recordIndex] = mergeRecordEnrichment(
        records[recordIndex],
        target,
      );
    }
    await checkpoint();
  }

  let enriched = 0;
  let unchanged = 0;
  const originalByKey = new Map(
    input.map((record) => [`${record.libraryID}:${record.itemKey}`, record]),
  );
  const writeBatchSize = CITATION_RECORD_WRITE_CHUNK_SIZE;
  for (const writeBatch of chunked(records, writeBatchSize)) {
    if (
      isCitationRequestCancellationRequested() ||
      cancellationRequested(requestOptions?.signal)
    ) {
      break;
    }
    const changed: CitationMetricRecord[] = [];
    for (const record of writeBatch) {
      const original = originalByKey.get(
        `${record.libraryID}:${record.itemKey}`,
      );
      if (
        original &&
        enrichmentSignature(original) === enrichmentSignature(record)
      ) {
        unchanged += 1;
      } else {
        changed.push(record);
      }
    }
    await saveCitationMetricRecords(changed);
    enriched += changed.length;
    await checkpoint(true);
  }

  const providerIdentitiesByItemKey = new Map<string, ProviderIdentityHints>();
  for (const target of uniqueTargets) {
    for (const recordIndex of target.recordIndexes) {
      providerIdentitiesByItemKey.set(records[recordIndex].itemKey, {
        ...target.providerWorkIDs,
      });
    }
    await checkpoint();
  }

  return {
    records,
    enriched,
    unchanged,
    failedBatches: settled.filter((result) => result.status === "rejected")
      .length,
    providerIdentitiesByItemKey,
  };
}
