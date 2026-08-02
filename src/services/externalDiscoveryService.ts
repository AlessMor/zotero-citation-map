import type {
  CitationProviderID,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import type { ExternalWork } from "../domain/externalWork";
import type { CitationGraphNode } from "../domain/graphTypes";
import { workIdentifiersForGraphNode } from "../domain/workIdentifiers";
import type { RelationshipProviderSnapshot } from "../providers/relationshipPolicy";
import { isCitationRequestCancellationRequested } from "../providers/http";
import type { ProviderRequestOptions } from "../providers/types";
import { getCitationProvider, getProviderPlan } from "../providers/registry";
import { resolveRelatedWorksMetadata } from "../providers/relatedWorkResolutionService";
import {
  externalWorkLookupIdentity,
  matchWorkIdentifiers,
  normalizeDOI,
  stableExternalWorkIdentity,
  stableWorkAliases,
  workLookupAliases,
} from "../domain/workIdentity";
import { relatedWorkFromProviderLookup } from "../domain/relatedWorkMetadata";
import { registerExternalWorkMetricBatch } from "./externalWorkMetricRegistry";
import { richestCountAttribution } from "./citationCountPolicy";
import { getEnabledProviders, isProviderEnabled } from "./citationPreferences";
import {
  getCitationMetricRecord,
  saveCitationMetricRecord,
} from "./citationMetricsStore";
import type { ProviderIdentityHints } from "./libraryCoreBatchService";
import {
  RELATIONSHIP_SUMMARY_BACKGROUND_FALLBACK_LIMIT,
  RELATIONSHIP_SUMMARY_BATCH_SIZE,
  providerExecutionPolicy,
} from "./providerExecutionPolicy";
import {
  cachedExternalWorkMetadata,
  invalidateExternalRelationshipMetadata,
  saveExternalWorkCacheFailures,
  saveExternalWorkCacheSuccesses,
  shouldResolveExternalWork,
} from "./externalWorkCacheService";
import {
  getStoredRelationshipCount,
  getStoredRelationshipEntry,
  getStoredRelationshipSummary,
  getStoredRelationshipWorks,
  mergeRelatedWorkLists,
  replaceStoredRelationshipSelection,
} from "./relationshipStoreService";
import {
  prepareRelationshipSnapshots,
  selectRelationshipMembership,
} from "./providerDispatcher";
import { createUpdateProgress } from "./updateProgressService";
import { projectRelatedWorkSummary } from "./relatedWorkHydrationState";
import {
  clearRelatedWorkSummaryCaches,
  fetchRelatedWorkSummaryPage,
  resolveRelatedWorkSummaries,
} from "./relatedWorkSummaryService";
import {
  normalizeImportedZoteroItems,
  normalizeRelatedWorkText,
} from "./scholarlyTextService";
import {
  externalWorkDisplayTitle,
  mergeExternalWorkMetadata,
  toExternalWorks,
  usableExternalTitle,
  type LibraryWorkIdentity,
} from "./externalWorkMetadataService";
import { stampProviderWorks } from "./providerWorkMetadata";
import {
  orderRelationshipProviders,
  preferredRelationshipProviders,
  relationshipForegroundMetadataLimit,
  relationshipProviderPolicyForSize,
  relationshipRefreshRequiresFollowUp,
  relationshipRefreshPolicy,
  relationshipSnapshotIsFresh,
  type RelationshipProviderStrategy,
  type RelationshipRefreshMode,
} from "./relationshipRefreshPolicy";
import {
  beginRelationshipPublicationBatch,
  endRelationshipPublicationBatch,
  publishRelationshipPublication,
} from "./relationshipEvents";
import {
  beginCitationUpdatePublicationBatch,
  endCitationUpdatePublicationBatch,
} from "./citationUpdateEvents";
import {
  createCooperativeCheckpoint,
  mapBounded,
  mapCooperatively,
  yieldToUI,
} from "./backgroundTaskService";
import {
  cancellationRequested,
  createCancellationScope,
  type CancellationSignal,
} from "./cancellationScope";

function externalCacheFailureStatus(
  error: unknown,
): "rate-limited" | "network-error" | "provider-error" {
  const message = String(error).toLocaleLowerCase();
  if (message.includes("429") || message.includes("rate limit")) {
    return "rate-limited";
  }
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("connection")
  ) {
    return "network-error";
  }
  return "provider-error";
}

function nodeLibraryID(node: CitationGraphNode): number {
  if (node.itemID > 0) {
    try {
      const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
      const libraryID = Number(item?.libraryID);
      if (Number.isFinite(libraryID)) return libraryID;
    } catch {
      // External focus nodes deliberately have no Zotero item.
    }
  }
  return Zotero.Libraries.userLibraryID;
}

const RELATIONSHIP_MAX_PAGES = 30;
const RELATIONSHIP_ABSOLUTE_MAX_PAGES = 1000;
const RELATIONSHIP_PROVIDER_TIMEOUT_MS = 15000;
const RELATIONSHIP_PROVIDER_PARALLELISM = 3;
// Batch-capable providers hydrate the entire deduplicated neighbour set.
// A small bounded fallback covers identifiers unsupported by batch endpoints.
const RELATIONSHIP_METADATA_FOREGROUND_INDIVIDUAL_LIMIT = 8;
const RELATIONSHIP_METADATA_BACKGROUND_DELAY_MS = 350;
const RELATIONSHIP_METADATA_ATTEMPTED_MAX = 5000;

function relationshipMetadataBatchSize(): number {
  // Semantic Scholar and OpenAlex both expose batch summary endpoints. Small
  // five-record chunks multiplied request overhead and the cooperative delay
  // for large relationship sets without materially improving responsiveness.
  return Math.min(100, RELATIONSHIP_SUMMARY_BATCH_SIZE);
}

interface DeferredValue<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}

interface RelationshipMetadataHydrationTarget {
  node: CitationGraphNode;
  direction: "references" | "cited-by";
  providers: Set<CitationProviderID>;
  silent: boolean;
  onHydrated: Set<() => void>;
}

interface RelationshipMetadataHydrationQueueEntry {
  work: RelatedWorkMetadata;
  targets: Map<string, RelationshipMetadataHydrationTarget>;
}

const relationshipMetadataHydrationQueue = new Map<
  string,
  RelationshipMetadataHydrationQueueEntry
>();
const relationshipMetadataAttemptedThisSession = new Set<string>();
let relationshipMetadataHydrationTimer: ReturnType<typeof setTimeout> | null =
  null;
let relationshipMetadataHydrationRunning = false;
let activeRelationshipMembershipRefreshes = 0;
let externalDiscoveryRunning = true;
let externalDiscoveryGeneration = 0;
const relationshipRecordSynchronizations = new Map<string, Promise<unknown>>();
const activeExternalMetadataResolutions = new Map<
  string,
  Promise<RelatedWorkMetadata | null>
>();

function markRelationshipMetadataAttempted(identityKey: string): void {
  relationshipMetadataAttemptedThisSession.delete(identityKey);
  relationshipMetadataAttemptedThisSession.add(identityKey);
  while (
    relationshipMetadataAttemptedThisSession.size >
    RELATIONSHIP_METADATA_ATTEMPTED_MAX
  ) {
    const oldest = relationshipMetadataAttemptedThisSession.values().next()
      .value as string | undefined;
    if (!oldest) break;
    relationshipMetadataAttemptedThisSession.delete(oldest);
  }
}

interface ActiveRelationshipRefresh {
  promise: Promise<ExternalWork[]>;
  cancel: () => void;
  maximum: number;
  mode: RelationshipRefreshMode;
  lastResolution: RelationshipRefreshResolution | null;
  metadataHydrated: boolean;
  membershipCallbacks: Set<(resolution: RelationshipRefreshResolution) => void>;
  metadataCallbacks: Set<() => void>;
}

const activeRelationshipRefreshOperations = new Map<
  string,
  ActiveRelationshipRefresh
>();

function invokeRefreshCallback<T>(
  callback: (value: T) => void,
  value: T,
): void {
  try {
    callback(value);
  } catch (error) {
    Zotero.debug(
      `Citation Map: relationship refresh callback failed: ${String(error)}`,
    );
  }
}

function invokeRefreshSignal(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    Zotero.debug(
      `Citation Map: relationship refresh signal failed: ${String(error)}`,
    );
  }
}

function cachedRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): ExternalWork[] {
  const entry = getStoredRelationshipEntry(node, direction);
  return (entry?.works ?? []).map((work) =>
    normalizeRelatedWorkText({
      ...work,
      dataSources: work.dataSources?.length
        ? [...work.dataSources]
        : work.provider === "manual" || work.provider === "zotero"
          ? []
          : [work.provider],
      updatedAt: work.updatedAt ?? entry?.fetchedAt ?? null,
    }),
  );
}

export function selectedRelationshipCacheIsFresh(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  maxAgeMs?: number,
): boolean {
  const summary = getStoredRelationshipSummary(node, direction);
  return relationshipSnapshotIsFresh(summary?.fetchedAt, maxAgeMs);
}

function metadataForRelationshipWork(
  work: RelatedWorkMetadata,
  index: Map<string, RelatedWorkMetadata>,
): RelatedWorkMetadata | null {
  let metadata: RelatedWorkMetadata | null = null;
  for (const alias of workLookupAliases(work)) {
    const candidate = index.get(alias);
    if (candidate)
      metadata = metadata
        ? mergeExternalWorkMetadata(metadata, candidate)
        : candidate;
  }
  return metadata;
}

function compactRelationshipWork(work: ExternalWork): ExternalWork {
  const normalized = normalizeRelatedWorkText(work);
  const localKey =
    normalized.inLibraryItemKey ?? normalized.zoteroItemKey ?? null;
  const hasStableExternalIdentity = Boolean(
    normalizeDOI(normalized.doi) ||
    normalized.pmid?.trim() ||
    normalized.arxiv?.trim() ||
    normalized.isbn?.trim() ||
    normalized.providerWorkID?.trim(),
  );
  if (
    normalized.provider === "manual" ||
    normalized.provider === "zotero" ||
    !hasStableExternalIdentity
  ) {
    return projectRelatedWorkSummary(normalized) as ExternalWork;
  }
  return {
    provider: normalized.provider,
    providerWorkID: normalized.providerWorkID,
    doi: normalizeDOI(normalized.doi),
    pmid: normalized.pmid ?? null,
    arxiv: normalized.arxiv ?? null,
    isbn: normalized.isbn ?? null,
    title: null,
    year: null,
    authors: [],
    zoteroItemKey: normalized.zoteroItemKey ?? null,
    inLibraryItemKey: localKey,
    dataSources: normalized.dataSources?.length
      ? [...normalized.dataSources]
      : [normalized.provider],
    updatedAt: normalized.updatedAt ?? null,
  };
}

function relationshipRecordSynchronizationKey(node: CitationGraphNode): string {
  return `${nodeLibraryID(node)}:${node.itemKey.toLocaleUpperCase()}`;
}

interface RelationshipReportedCount {
  count: number | null;
  provider: CitationProviderID | null;
}

function retainedStoredCount(
  count: number | null | undefined,
  provider: CitationProviderID | null | undefined,
): RelationshipReportedCount {
  if (provider && !isProviderEnabled(provider)) {
    return { count: null, provider: null };
  }
  return { count: count ?? null, provider: provider ?? null };
}

async function synchronizeStoredRelationshipSummary(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  identifiedCount: number,
  reported: RelationshipReportedCount | null,
): Promise<RelationshipReportedCount> {
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  if (!record) {
    return {
      count: reported?.count ?? null,
      provider: reported?.provider ?? null,
    };
  }
  if (direction === "references") {
    const previous = retainedStoredCount(
      record.referenceCount,
      record.referenceCountProvider,
    );
    const result = richestCountAttribution([
      previous,
      {
        count: reported?.count ?? null,
        provider: reported?.provider ?? null,
      },
    ]);
    await saveCitationMetricRecord({
      ...record,
      referenceCount: result.count,
      referenceCountProvider: result.provider,
      resolvedReferenceCount: identifiedCount,
    });
    return result;
  }
  const previous = retainedStoredCount(
    record.citationCount,
    record.citationCountProvider,
  );
  const citationCount = richestCountAttribution([
    previous,
    {
      count: reported?.count ?? null,
      provider: reported?.provider ?? null,
    },
  ]);
  await saveCitationMetricRecord({
    ...record,
    citationCount: citationCount.count,
    citationCountProvider: citationCount.provider,
  });
  return citationCount;
}

function publishRelationshipState(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  phase:
    | "refresh-started"
    | "membership-published"
    | "metadata-published"
    | "refresh-finished",
  identifiedCount: number,
  reported: RelationshipReportedCount | null,
): void {
  publishRelationshipPublication({
    libraryID: nodeLibraryID(node),
    subjectItemKey: node.itemKey,
    direction,
    phase,
    reportedCount: reported?.count ?? null,
    reportedCountProvider: reported?.provider ?? null,
    identifiedCount,
  });
}

function storedRelationshipReportedCount(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): RelationshipReportedCount {
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  if (direction === "references") {
    return {
      count: record?.referenceCount ?? node.referenceCount,
      provider:
        record?.referenceCountProvider ?? node.referenceCountProvider ?? null,
    };
  }
  return {
    count: record?.citationCount ?? node.citationCount,
    provider:
      record?.citationCountProvider ?? node.citationCountProvider ?? null,
  };
}

function synchronizeRelationshipSummary(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  identifiedCount: number,
  reported: RelationshipReportedCount | null,
): Promise<RelationshipReportedCount> {
  return queueRelationshipRecordSynchronization(node, () =>
    synchronizeStoredRelationshipSummary(
      node,
      direction,
      identifiedCount,
      reported,
    ),
  );
}

function queueRelationshipRecordSynchronization<T>(
  node: CitationGraphNode,
  task: () => Promise<T>,
): Promise<T> {
  const key = relationshipRecordSynchronizationKey(node);
  const previous =
    relationshipRecordSynchronizations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  relationshipRecordSynchronizations.set(key, current);
  void current.then(
    () => {
      if (relationshipRecordSynchronizations.get(key) === current) {
        relationshipRecordSynchronizations.delete(key);
      }
    },
    () => {
      if (relationshipRecordSynchronizations.get(key) === current) {
        relationshipRecordSynchronizations.delete(key);
      }
    },
  );
  return current;
}

interface StoreRelationshipSnapshotOptions {
  provider?: CitationProviderID;
  reportedCount?: number | null;
  complete?: boolean;
  queueBackgroundHydration?: boolean;
}

export async function storeExternalRelationshipSnapshot(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
  options: StoreRelationshipSnapshotOptions = {},
): Promise<number | null> {
  const provider =
    options.provider ??
    node.provider ??
    works.find(
      (work) => work.provider !== "manual" && work.provider !== "zotero",
    )?.provider;
  if (!provider || provider === "manual" || provider === "zotero") {
    return null;
  }

  const complete =
    options.complete === true ||
    options.reportedCount === 0 ||
    (options.reportedCount != null && works.length >= options.reportedCount);
  const providerOwnsMembership = works.every(
    (work) =>
      work.provider === provider || work.dataSources?.includes(provider),
  );
  // Avoid canonicalizing a large partial bibliography that cannot be admitted
  // as authoritative membership.
  if (!complete || !providerOwnsMembership) return null;

  const prepared = prepareRelationshipSnapshots(
    [
      {
        provider,
        works,
        reportedCount: options.reportedCount ?? null,
        complete: options.complete === true,
        succeeded: true,
      },
    ],
    mergeRelatedWorkLists,
  )[0];

  // Never expose an incomplete or cross-provider scalar list as membership.
  const selectedMembership = await mapCooperatively(
    prepared.identifiedWorks,
    (work) => compactRelationshipWork(work as ExternalWork),
    { forceEvery: 25 },
  );
  await replaceStoredRelationshipSelection(
    node,
    direction,
    selectedMembership,
    { alreadyCanonical: true, writeMetadata: false },
  );
  const reported = {
    count: options.reportedCount ?? null,
    provider,
  } satisfies RelationshipReportedCount;
  publishRelationshipState(
    node,
    direction,
    "membership-published",
    prepared.identifiedWorks.length,
    reported,
  );
  if (options.queueBackgroundHydration !== false) {
    queueRelationshipMetadataHydration(
      node,
      direction,
      prepared.identifiedWorks,
      true,
      [provider],
    );
  }
  return prepared.identifiedWorks.length;
}

function needsRelationshipBibliographicMetadata(
  work: RelatedWorkMetadata,
): boolean {
  // Relationship lists can already present a useful card when a title and at
  // least one piece of bibliographic context are present. Citation/reference
  // totals and venue are optional enrichment and must not trigger hundreds of
  // network lookups merely because a large References tab was opened.
  if (!externalWorkDisplayTitle(work)) return true;
  return (
    work.year === null && work.authors.length === 0 && !work.sourceTitle?.trim()
  );
}

function needsExternalMetadata(work: RelatedWorkMetadata): boolean {
  return (
    needsRelationshipBibliographicMetadata(work) ||
    work.citationCount === null ||
    work.citationCount === undefined ||
    work.referenceCount === null ||
    work.referenceCount === undefined
  );
}

function relationshipHydrationTargetKey(
  target: RelationshipMetadataHydrationTarget,
): string {
  return [
    nodeLibraryID(target.node),
    target.node.itemKey.toLocaleUpperCase(),
    target.direction,
  ].join(":");
}

function scheduleRelationshipMetadataHydrationRun(): void {
  if (
    !externalDiscoveryRunning ||
    relationshipMetadataHydrationRunning ||
    relationshipMetadataHydrationTimer !== null ||
    relationshipMetadataHydrationQueue.size === 0
  ) {
    return;
  }
  relationshipMetadataHydrationTimer = setTimeout(() => {
    relationshipMetadataHydrationTimer = null;
    if (!externalDiscoveryRunning) return;
    if (activeRelationshipMembershipRefreshes > 0) {
      scheduleRelationshipMetadataHydrationRun();
      return;
    }
    void runRelationshipMetadataHydrationQueue().catch((error: unknown) => {
      Zotero.debug(
        `Citation Map: background relationship metadata hydration failed: ${String(error)}`,
      );
    });
  }, RELATIONSHIP_METADATA_BACKGROUND_DELAY_MS);
}

function queueRelationshipMetadataHydration(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
  retryAttempted = false,
  providers = getProviderPlan(
    direction === "references" ? "references" : "citations",
    "auto",
  ).providers,
  silent = false,
  onHydrated?: () => void,
): void {
  if (!externalDiscoveryRunning) return;
  const target: RelationshipMetadataHydrationTarget = {
    node,
    direction,
    providers: new Set(providers),
    silent,
    onHydrated: new Set(onHydrated ? [onHydrated] : []),
  };
  const targetKey = relationshipHydrationTargetKey(target);
  for (const rawWork of works) {
    if (!needsRelationshipBibliographicMetadata(rawWork)) continue;
    const key = externalWorkLookupIdentity(rawWork);
    const cached = cachedExternalWorkMetadata(key);
    const work = cached ? mergeExternalWorkMetadata(rawWork, cached) : rawWork;
    const stillNeedsLookup = needsRelationshipBibliographicMetadata(work);
    if (retryAttempted) relationshipMetadataAttemptedThisSession.delete(key);
    if (stillNeedsLookup && relationshipMetadataAttemptedThisSession.has(key)) {
      continue;
    }
    const existing = relationshipMetadataHydrationQueue.get(key);
    if (existing) {
      existing.work = mergeExternalWorkMetadata(existing.work, work);
      const existingTarget = existing.targets.get(targetKey);
      if (existingTarget) {
        for (const provider of target.providers) {
          existingTarget.providers.add(provider);
        }
        existingTarget.silent = existingTarget.silent && silent;
        if (onHydrated) existingTarget.onHydrated.add(onHydrated);
      } else {
        existing.targets.set(targetKey, target);
      }
    } else {
      relationshipMetadataHydrationQueue.set(key, {
        // Keep only the compact fields required by summary resolution. Some
        // provider relationship records carry abstracts, nested references,
        // source metrics and citation histories; retaining those fields for
        // every queued neighbour caused the background queue itself to become
        // a second large in-memory relationship cache.
        work: projectRelatedWorkSummary(work, false),
        targets: new Map([[targetKey, target]]),
      });
    }
  }
  scheduleRelationshipMetadataHydrationRun();
}

async function persistHydratedRelationshipMetadata(
  targets: RelationshipMetadataHydrationTarget[],
): Promise<void> {
  const uniqueTargets = uniqueRelationshipHydrationTargets(targets);

  // Summary metadata is already persisted once in external_works_v2 and is
  // joined into relationship membership lazily. Rewriting the citation-metric
  // record here duplicated the complete bibliography JSON after every summary
  // run and could block Zotero's main thread for many seconds on 1,000+ item
  // lists. Counts and membership were committed before hydration, so metadata
  // publication only needs to invalidate views and announce the final state.
  for (const target of uniqueTargets) {
    const selectedCount = getStoredRelationshipCount(
      target.node,
      target.direction,
    );
    publishRelationshipState(
      target.node,
      target.direction,
      "metadata-published",
      selectedCount,
      storedRelationshipReportedCount(target.node, target.direction),
    );
    await yieldToUI();
  }
}

function relationshipMetadataHydrationShowsProgress(): boolean {
  for (const entry of relationshipMetadataHydrationQueue.values()) {
    for (const target of entry.targets.values()) {
      if (!target.silent) return true;
    }
  }
  return false;
}

function takeRelationshipMetadataHydrationBatch(
  maximum: number,
): Array<[string, RelationshipMetadataHydrationQueueEntry]> {
  const batch: Array<[string, RelationshipMetadataHydrationQueueEntry]> = [];
  for (const entry of relationshipMetadataHydrationQueue.entries()) {
    batch.push(entry);
    if (batch.length >= maximum) break;
  }
  return batch;
}

function accumulateHydrationTargets(
  destination: Map<string, RelationshipMetadataHydrationTarget>,
  targets: RelationshipMetadataHydrationTarget[],
): void {
  for (const target of uniqueRelationshipHydrationTargets(targets)) {
    const key = relationshipHydrationTargetKey(target);
    const existing = destination.get(key);
    if (!existing) {
      destination.set(key, target);
      continue;
    }
    for (const provider of target.providers) existing.providers.add(provider);
    existing.silent = existing.silent && target.silent;
    for (const callback of target.onHydrated) {
      existing.onHydrated.add(callback);
    }
  }
}

function uniqueRelationshipHydrationTargets(
  targets: RelationshipMetadataHydrationTarget[],
): RelationshipMetadataHydrationTarget[] {
  const uniqueTargets = new Map<string, RelationshipMetadataHydrationTarget>();
  for (const target of targets) {
    const key = relationshipHydrationTargetKey(target);
    const existing = uniqueTargets.get(key);
    if (existing) {
      for (const provider of target.providers) existing.providers.add(provider);
      existing.silent = existing.silent && target.silent;
      for (const callback of target.onHydrated) {
        existing.onHydrated.add(callback);
      }
    } else {
      uniqueTargets.set(key, target);
    }
  }
  return [...uniqueTargets.values()];
}

async function runRelationshipMetadataHydrationQueue(): Promise<void> {
  if (!externalDiscoveryRunning || relationshipMetadataHydrationRunning) return;
  const generation = externalDiscoveryGeneration;
  relationshipMetadataHydrationRunning = true;
  const initialTotal = relationshipMetadataHydrationQueue.size;
  let completed = 0;
  let remainingFallbackLookups = RELATIONSHIP_SUMMARY_BACKGROUND_FALLBACK_LIMIT;
  const hydratedTargets = new Map<
    string,
    RelationshipMetadataHydrationTarget
  >();
  const hydratedIdentityKeys = new Set<string>();
  const showProgress = relationshipMetadataHydrationShowsProgress();
  const progress = showProgress
    ? createUpdateProgress({
        title: "Updating relationship metadata",
        message: `Preparing ${initialTotal} related paper${initialTotal === 1 ? "" : "s"}`,
        total: Math.max(1, initialTotal),
      })
    : relationshipProgress(true, "", "");
  try {
    while (
      externalDiscoveryRunning &&
      generation === externalDiscoveryGeneration &&
      relationshipMetadataHydrationQueue.size > 0
    ) {
      if (isCitationRequestCancellationRequested()) {
        relationshipMetadataHydrationQueue.clear();
        break;
      }
      if (activeRelationshipMembershipRefreshes > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RELATIONSHIP_METADATA_BACKGROUND_DELAY_MS),
        );
        continue;
      }
      const batchEntries = takeRelationshipMetadataHydrationBatch(
        relationshipMetadataBatchSize(),
      );
      const targets: RelationshipMetadataHydrationTarget[] = [];
      const input: ExternalWork[] = [];
      for (const [key, entry] of batchEntries) {
        relationshipMetadataHydrationQueue.delete(key);
        markRelationshipMetadataAttempted(key);
        targets.push(...entry.targets.values());
        input.push({
          ...entry.work,
          authors: [...entry.work.authors],
          inLibraryItemKey:
            entry.work.inLibraryItemKey ?? entry.work.zoteroItemKey ?? null,
        });
      }

      const currentTotal = Math.max(
        initialTotal,
        completed + input.length + relationshipMetadataHydrationQueue.size,
      );
      progress.setProgress(
        completed,
        currentTotal,
        `Retrieving summaries for ${input.length} related paper${
          input.length === 1 ? "" : "s"
        } · ${completed}/${currentTotal} complete`,
      );

      // Batch-capable providers run first, then Crossref/other DOI providers are
      // allowed to resolve every remaining work in this bounded background chunk.
      // Yield before and after each network/normalization batch so the popup can
      // repaint and Zotero can continue handling input.
      await yieldToUI();
      const fallbackAllocation = Number.isFinite(remainingFallbackLookups)
        ? Math.min(remainingFallbackLookups, input.length)
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(remainingFallbackLookups)) {
        remainingFallbackLookups = Math.max(
          0,
          remainingFallbackLookups - fallbackAllocation,
        );
      }
      const hydrated = await hydrateExternalWorksMetadata(
        input,
        false,
        fallbackAllocation,
        true,
        false,
        {
          deferRelationshipInvalidation: true,
          registerMetrics: false,
        },
      );
      await yieldToUI();
      if (isCitationRequestCancellationRequested()) {
        relationshipMetadataHydrationQueue.clear();
        break;
      }
      const resolved = hydrated.filter(
        (work) => !needsRelationshipBibliographicMetadata(work),
      );
      if (resolved.length) {
        accumulateHydrationTargets(hydratedTargets, targets);
        for (const work of resolved) {
          for (const identity of stableWorkAliases(work)) {
            hydratedIdentityKeys.add(identity);
          }
        }
      }
      completed += input.length;
      progress.setProgress(
        completed,
        currentTotal,
        `${completed}/${currentTotal} related-paper summaries retrieved`,
      );

      if (relationshipMetadataHydrationQueue.size > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RELATIONSHIP_METADATA_BACKGROUND_DELAY_MS),
        );
      }
    }

    // A large bibliography used to rewrite and republish its complete
    // relationship record after every 100-summary batch. Keep the newly
    // resolved metadata in the external-work cache during retrieval, then
    // invalidate and rebuild each affected relationship list exactly once.
    if (
      externalDiscoveryRunning &&
      generation === externalDiscoveryGeneration
    ) {
      const finalTargets = [...hydratedTargets.values()];
      if (hydratedIdentityKeys.size) {
        invalidateExternalRelationshipMetadata(hydratedIdentityKeys);
      }
      if (finalTargets.length) {
        progress.setProgress(
          completed,
          Math.max(initialTotal, completed),
          "Publishing retrieved summaries",
        );
        const publicationStartedAt = Date.now();
        await persistHydratedRelationshipMetadata(finalTargets);
        const publicationDurationMs = Date.now() - publicationStartedAt;
        if (publicationDurationMs >= 500) {
          Zotero.debug(
            `Citation Map: published relationship summaries for ${finalTargets.length} target${
              finalTargets.length === 1 ? "" : "s"
            } in ${publicationDurationMs} ms`,
          );
        }
        for (const target of finalTargets) {
          for (const callback of target.onHydrated) {
            try {
              callback();
            } catch (error) {
              Zotero.debug(
                `Citation Map: relationship hydration callback failed: ${String(error)}`,
              );
            }
          }
        }
        await yieldToUI();
      }
    }
    if (!progress.isDismissed()) {
      if (isCitationRequestCancellationRequested()) {
        progress.dismiss();
      } else {
        progress.finish(
          `${completed} related-paper ${completed === 1 ? "summary" : "summaries"} retrieved`,
        );
      }
    }
  } catch (error) {
    if (!progress.isDismissed()) {
      progress.fail(`Relationship metadata update failed: ${String(error)}`);
    }
    throw error;
  } finally {
    relationshipMetadataHydrationRunning = false;
    if (
      externalDiscoveryRunning &&
      generation === externalDiscoveryGeneration &&
      !isCitationRequestCancellationRequested()
    ) {
      scheduleRelationshipMetadataHydrationRun();
    }
  }
}

interface ExternalMetadataHydrationRuntimeOptions {
  /** Delay expensive relationship-list cache invalidation until the caller
   * publishes a complete group of summary batches. */
  deferRelationshipInvalidation?: boolean;
  /** Background relationship summaries do not need to populate the global
   * graph-metric registry until a work is actually materialized in a view. */
  registerMetrics?: boolean;
}

export async function hydrateExternalWorksMetadata(
  works: ExternalWork[],
  includeSecondaryMetrics = false,
  individualLookupLimit = Number.POSITIVE_INFINITY,
  bibliographicOnly = false,
  forceRefresh = false,
  runtimeOptions: ExternalMetadataHydrationRuntimeOptions = {},
): Promise<ExternalWork[]> {
  if (!externalDiscoveryRunning) return works;
  const checkpoint = createCooperativeCheckpoint();
  const hydrated = await mapCooperatively(
    works,
    (work) => {
      const key = stableExternalWorkIdentity(work);
      return key
        ? mergeExternalWorkMetadata(work, cachedExternalWorkMetadata(key))
        : work;
    },
    { forceEvery: 25 },
  );

  const resolutionByIndex = new Map<
    number,
    Promise<RelatedWorkMetadata | null>
  >();
  const newCandidates = new Map<
    string,
    { work: RelatedWorkMetadata; indexes: number[] }
  >();
  for (const [index, work] of hydrated.entries()) {
    const needsMetadata = bibliographicOnly
      ? needsRelationshipBibliographicMetadata(work)
      : needsExternalMetadata(work);
    if (!forceRefresh && !needsMetadata) continue;
    const key = externalWorkLookupIdentity(work);
    const basicMetadataMissing = bibliographicOnly
      ? needsRelationshipBibliographicMetadata(work)
      : !usableExternalTitle(work.title, work.doi) ||
        work.year === null ||
        work.authors.length === 0 ||
        !work.sourceTitle?.trim();
    // Incomplete bibliographic records bypass stale success entries written by
    // earlier versions. Explicit panel refreshes also bypass the TTL.
    if (
      !forceRefresh &&
      !basicMetadataMissing &&
      !shouldResolveExternalWork(key)
    ) {
      continue;
    }
    const active = activeExternalMetadataResolutions.get(key);
    if (active) {
      resolutionByIndex.set(index, active);
      continue;
    }
    const pending = newCandidates.get(key);
    if (pending) {
      pending.indexes.push(index);
    } else {
      newCandidates.set(key, { work, indexes: [index] });
    }
    await checkpoint();
  }

  if (newCandidates.size) {
    const entries = [...newCandidates.entries()];
    const chunks = chunkValues(entries, RELATIONSHIP_SUMMARY_BATCH_SIZE);
    let remainingIndividualLookups = individualLookupLimit;
    const jobs = chunks.map((batch) => {
      const allocation = Number.isFinite(remainingIndividualLookups)
        ? Math.min(remainingIndividualLookups, batch.length)
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(remainingIndividualLookups)) {
        remainingIndividualLookups = Math.max(
          0,
          remainingIndividualLookups - allocation,
        );
      }
      const deferred = batch.map(() =>
        deferredValue<RelatedWorkMetadata | null>(),
      );
      batch.forEach(([key, entry], batchIndex) => {
        const resolution = deferred[batchIndex].promise.finally(() => {
          if (activeExternalMetadataResolutions.get(key) === resolution) {
            activeExternalMetadataResolutions.delete(key);
          }
        });
        activeExternalMetadataResolutions.set(key, resolution);
        for (const index of entry.indexes) {
          resolutionByIndex.set(index, resolution);
        }
      });
      return { batch, deferred, individualLookupLimit: allocation };
    });

    void mapBounded(
      jobs,
      Math.max(
        providerExecutionPolicy("semantic-scholar").requestParallelism,
        providerExecutionPolicy("openalex").requestParallelism,
      ),
      async ({ batch, deferred, individualLookupLimit: lookupLimit }) => {
        try {
          if (isCitationRequestCancellationRequested()) {
            for (const result of deferred) result.resolve(null);
            return;
          }
          const input = batch.map(([, entry]) => entry.work);
          const resolved = bibliographicOnly
            ? await resolveRelatedWorkSummaries(input, "auto", {
                individualLookupLimit: lookupLimit,
              })
            : await resolveRelatedWorksMetadata(
                input,
                "auto",
                includeSecondaryMetrics,
                { individualLookupLimit: lookupLimit },
              );
          deferred.forEach((result, index) => {
            result.resolve(resolved[index] ?? null);
          });
        } catch (error) {
          const status = externalCacheFailureStatus(error);
          const message =
            `Metadata resolution failed for ${batch.length} ` +
            `work${batch.length === 1 ? "" : "s"}: ${String(error)}`;
          await saveExternalWorkCacheFailures(
            batch.map(([identityKey]) => ({
              identityKey,
              status,
              message,
            })),
            {
              invalidateRelationships:
                runtimeOptions.deferRelationshipInvalidation !== true,
            },
          );
          Zotero.logError(new Error(message, { cause: error }));
          for (const result of deferred) result.resolve(null);
        }
      },
    ).catch((error: unknown) => {
      Zotero.debug(
        `Citation Map: metadata batch queue failed: ${String(error)}`,
      );
      for (const job of jobs) {
        for (const result of job.deferred) result.resolve(null);
      }
    });
  }

  const cacheEntries: Array<{
    identityKey: string;
    metadata: RelatedWorkMetadata;
  }> = [];
  for (const [workIndex, resolution] of resolutionByIndex.entries()) {
    const metadata = await resolution;
    if (metadata) {
      hydrated[workIndex] = mergeExternalWorkMetadata(
        hydrated[workIndex],
        metadata,
      );
      const key = stableExternalWorkIdentity(hydrated[workIndex]);
      if (
        key &&
        usableExternalTitle(hydrated[workIndex].title, hydrated[workIndex].doi)
      ) {
        cacheEntries.push({ identityKey: key, metadata: hydrated[workIndex] });
      }
    }
    await checkpoint();
  }
  await checkpoint(true);
  const cacheSaveStartedAt = Date.now();
  await saveExternalWorkCacheSuccesses(cacheEntries, {
    invalidateRelationships:
      runtimeOptions.deferRelationshipInvalidation !== true,
  });
  const cacheSaveDurationMs = Date.now() - cacheSaveStartedAt;
  if (cacheSaveDurationMs >= 500) {
    Zotero.debug(
      `Citation Map: saved ${cacheEntries.length} related-paper summaries in ${cacheSaveDurationMs} ms`,
    );
  }
  await checkpoint(true);
  if (runtimeOptions.registerMetrics !== false) {
    registerExternalWorkMetricBatch(hydrated);
  }
  return hydrated;
}

async function lookupProviderRecord(
  providerID: CitationProviderID,
  identifiers: WorkIdentifiers,
  requestOptions?: ProviderRequestOptions,
) {
  const provider = getCitationProvider(providerID);
  const lookup = provider.lookupForRelations ?? provider.lookup;
  let match = provider.supports(identifiers)
    ? await lookup(identifiers, requestOptions)
    : null;
  if (
    (!match || match.status !== "success") &&
    provider.searchExactTitle &&
    identifiers.normalizedTitle
  ) {
    match = await provider.searchExactTitle(identifiers, requestOptions);
  }
  return match?.status === "success" &&
    matchWorkIdentifiers(identifiers, relatedWorkFromProviderLookup(match))
      .decision === "same-work"
    ? match
    : null;
}

async function withProviderTimeout<T>(
  providerID: CitationProviderID,
  direction: "references" | "cited-by",
  operation: Promise<T>,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          Zotero.debug(
            `Citation Map: ${providerID} ${direction} lookup timed out`,
          );
          resolve(null);
        }, RELATIONSHIP_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function fetchProviderRelationshipSnapshot(
  providerID: CitationProviderID,
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  maximum: number,
  providerWorkIDs: ProviderIdentityHints = {},
  requestOptions?: ProviderRequestOptions,
): Promise<RelationshipProviderSnapshot> {
  const failed = (): RelationshipProviderSnapshot => ({
    provider: providerID,
    works: [],
    reportedCount: null,
    complete: false,
    succeeded: false,
  });
  try {
    const checkpoint = createCooperativeCheckpoint();
    const identifiers = workIdentifiersForGraphNode(node);
    const provider = getCitationProvider(providerID);
    const nativeFetcher =
      direction === "references"
        ? provider.fetchReferencedWorks
        : provider.fetchCitingWorks;
    const hasSummaryFetcher =
      providerID === "semantic-scholar" || providerID === "openalex";
    const fetcher = hasSummaryFetcher
      ? (id: string, requested: number, offset: number) =>
          fetchRelatedWorkSummaryPage(
            providerID,
            id,
            direction,
            requested,
            offset,
            requestOptions,
          )
      : nativeFetcher;
    const hintedProviderWorkID =
      providerWorkIDs[providerID] ??
      (providerID === node.provider ? node.providerWorkID : null) ??
      null;
    const match = hintedProviderWorkID
      ? null
      : await withProviderTimeout(
          providerID,
          direction,
          lookupProviderRecord(providerID, identifiers, requestOptions),
        );
    const reportedCount =
      direction === "references"
        ? (match?.referenceCount ??
          (providerID === node.referenceCountProvider
            ? node.referenceCount
            : null))
        : (match?.citationCount ??
          (providerID === node.citationCountProvider
            ? node.citationCount
            : null));
    let works =
      direction === "references" && match?.references?.length
        ? mergeRelatedWorkLists(
            stampProviderWorks(match.references, providerID),
          )
        : [];

    if (reportedCount === 0) {
      return {
        provider: providerID,
        works: [],
        reportedCount: 0,
        complete: true,
        succeeded: Boolean(match) || Boolean(fetcher),
      };
    }

    if (!fetcher) {
      return {
        provider: providerID,
        works,
        reportedCount,
        complete:
          Boolean(match) &&
          (reportedCount === null || works.length >= reportedCount),
        succeeded: Boolean(match),
      };
    }

    const providerWorkID =
      hintedProviderWorkID ??
      match?.providerWorkID ??
      (providerID === "opencitations" ? normalizeDOI(node.doi) : null);
    if (!providerWorkID) return failed();

    const boundedMaximum = Number.isFinite(maximum)
      ? Math.max(0, maximum)
      : Number.POSITIVE_INFINITY;
    const target =
      reportedCount === null
        ? boundedMaximum
        : Math.min(boundedMaximum, Math.max(0, reportedCount));
    const pageSize = providerExecutionPolicy(providerID).relationshipPageSize;
    const maximumPages = Number.isFinite(target)
      ? Math.min(
          RELATIONSHIP_ABSOLUTE_MAX_PAGES,
          Math.max(RELATIONSHIP_MAX_PAGES, Math.ceil(target / pageSize) + 1),
        )
      : RELATIONSHIP_ABSOLUTE_MAX_PAGES;
    const collectedWorks = [...works];
    const collectedIdentities = new Set(
      collectedWorks.map((work) => externalWorkLookupIdentity(work)),
    );
    let offset = works.length;
    let pages = 0;
    let endpointExhausted = false;
    let previousSignature: string | null = null;
    while (
      (offset < target || !Number.isFinite(target)) &&
      pages < maximumPages
    ) {
      const requested = Number.isFinite(target)
        ? Math.min(pageSize, Math.max(1, target - offset))
        : pageSize;
      const pageResult = await withProviderTimeout(
        providerID,
        direction,
        hasSummaryFetcher
          ? fetcher(providerWorkID, requested, offset)
          : nativeFetcher!(providerWorkID, requested, offset, requestOptions),
      );
      if (!Array.isArray(pageResult)) return failed();
      const page = pageResult;
      pages += 1;
      if (!page.length) {
        endpointExhausted = true;
        break;
      }
      const stamped = stampProviderWorks(page, providerID);
      const pageIdentities = stamped.map((work) =>
        externalWorkLookupIdentity(work),
      );
      const signature = pageIdentities.join("|");
      if (signature === previousSignature) {
        break;
      }
      previousSignature = signature;
      collectedWorks.push(...stamped);
      for (const identity of pageIdentities) collectedIdentities.add(identity);
      offset += page.length;
      // Keep page retrieval append-only. Re-merging the complete accumulated
      // list after every page makes large bibliographies increasingly
      // expensive and can monopolize Zotero's main thread. Canonicalize once
      // after the endpoint has finished instead.
      await checkpoint(true);
      if (page.length < requested) {
        endpointExhausted = true;
        break;
      }
      if (reportedCount !== null && collectedIdentities.size >= reportedCount) {
        break;
      }
    }

    await checkpoint(true);
    works = mergeRelatedWorkLists(collectedWorks);
    await checkpoint(true);

    const reachedReportedCount =
      reportedCount !== null && works.length >= reportedCount;
    const complete =
      reportedCount !== null ? reachedReportedCount : endpointExhausted;
    return {
      provider: providerID,
      works,
      reportedCount,
      complete:
        complete &&
        (reportedCount === null ||
          !Number.isFinite(boundedMaximum) ||
          reportedCount <= boundedMaximum),
      succeeded: true,
    };
  } catch (error) {
    Zotero.debug(
      `Citation Map: ${providerID} ${direction} lookup failed: ${String(error)}`,
    );
    return failed();
  }
}

function cachedReferenceWorks(node: CitationGraphNode): RelatedWorkMetadata[] {
  return getStoredRelationshipEntry(node, "references")?.works ?? [];
}

export function getCachedExternalReferences(
  node: CitationGraphNode,
  libraryNodes: readonly LibraryWorkIdentity[],
  maximum: number,
  offset: number,
  options: { queueBackgroundHydration?: boolean } = {},
): ExternalWork[] {
  const cached = cachedReferenceWorks(node);
  if (options.queueBackgroundHydration !== false) {
    // Opening a cached relationship list must not create a foreground popup.
    // Only genuinely display-incomplete records are queued by the hydrator.
    queueRelationshipMetadataHydration(
      node,
      "references",
      cached,
      false,
      undefined,
      true,
    );
  }
  return toExternalWorks(cached.slice(offset, offset + maximum), libraryNodes);
}

export function getCachedExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: readonly LibraryWorkIdentity[],
  maximum: number,
  offset: number,
  options: { queueBackgroundHydration?: boolean } = {},
): ExternalWork[] {
  const cached = cachedRelationshipResults(node, "cited-by");
  if (options.queueBackgroundHydration !== false) {
    queueRelationshipMetadataHydration(
      node,
      "cited-by",
      cached,
      false,
      undefined,
      true,
    );
  }
  return toExternalWorks(cached.slice(offset, offset + maximum), libraryNodes);
}

export interface RelationshipRefreshResolution {
  complete: boolean;
  provider: CitationProviderID | null;
  reportedCount: number | null;
  identifiedCount: number;
}

export interface ExternalRelationshipRefreshOptions {
  maximum?: number;
  refreshMembership?: boolean;
  silent?: boolean;
  summaryLookupLimit?: number;
  queueBackgroundHydration?: boolean;
  providerWorkIDs?: ProviderIdentityHints;
  mode?: RelationshipRefreshMode;
  providerStrategy?: RelationshipProviderStrategy;
  providerLimit?: number;
  metadataHydrationLimit?: number;
  metadataBatchSize?: number;
  /** Show a singleton progress activity while deferred metadata is hydrated. */
  showBackgroundProgress?: boolean;
  onMembershipResolved?: (resolution: RelationshipRefreshResolution) => void;
  onMetadataHydrated?: () => void;
  signal?: CancellationSignal;
  /** Internal cancellation hook used by the shared progress activity. */
  onCancel?: () => void;
}

interface RelationshipProgress {
  setProgress: (completed: number, total: number, message: string) => void;
  finish: (message: string) => void;
  fail: (message: string) => void;
  dismiss: () => void;
  isDismissed: () => boolean;
}

function relationshipProgress(
  silent: boolean,
  title: string,
  message: string,
  onCancel?: () => void,
): RelationshipProgress {
  if (!silent) {
    return createUpdateProgress({ title, message, total: 4, onCancel });
  }
  return {
    setProgress: () => undefined,
    finish: () => undefined,
    fail: () => undefined,
    dismiss: () => undefined,
    isDismissed: () => false,
  };
}

function relationshipProviders(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  strategy: RelationshipProviderStrategy,
  maximum: number,
): CitationProviderID[] {
  const plan = getProviderPlan(
    direction === "references" ? "references" : "citations",
    "auto",
  );
  const enabledProviderSet = new Set(getEnabledProviders());
  const enabledProviders = plan.providers.filter((provider) =>
    enabledProviderSet.has(provider),
  );
  const countProvider =
    direction === "references"
      ? node.referenceCountProvider
      : node.citationCountProvider;
  return orderRelationshipProviders(
    enabledProviders,
    preferredRelationshipProviders(
      direction,
      enabledProviders,
      node.provider,
      countProvider,
      Boolean(normalizeDOI(node.doi)),
    ),
    strategy,
    maximum,
  );
}

async function hydrateRelationshipSelectionInBatches(
  works: RelatedWorkMetadata[],
  libraryNodes: readonly LibraryWorkIdentity[],
  maximum: number,
  batchSize: number,
  individualLookupLimit: number,
  signal?: CancellationSignal,
): Promise<Map<string, RelatedWorkMetadata>> {
  const boundedMaximum = Number.isFinite(maximum)
    ? Math.max(0, Math.floor(maximum))
    : works.length;
  const selected = works.slice(0, boundedMaximum);
  const metadata = new Map<string, RelatedWorkMetadata>();
  let remainingIndividualLookups = individualLookupLimit;
  for (const batch of chunkValues(selected, Math.max(1, batchSize))) {
    if (
      isCitationRequestCancellationRequested() ||
      cancellationRequested(signal)
    ) {
      break;
    }
    const allocation = Number.isFinite(remainingIndividualLookups)
      ? Math.min(remainingIndividualLookups, batch.length)
      : Number.POSITIVE_INFINITY;
    if (Number.isFinite(remainingIndividualLookups)) {
      remainingIndividualLookups = Math.max(
        0,
        remainingIndividualLookups - allocation,
      );
    }
    const hydrated = await hydrateExternalWorksMetadata(
      toExternalWorks(batch, libraryNodes),
      false,
      allocation,
      true,
      false,
    );
    for (const work of hydrated) {
      for (const alias of workLookupAliases(work)) {
        metadata.set(alias, work);
      }
    }
    await yieldToUI();
  }
  return metadata;
}

async function runExternalRelationshipRefresh(
  node: CitationGraphNode,
  libraryNodes: readonly LibraryWorkIdentity[],
  direction: "references" | "cited-by",
  options: ExternalRelationshipRefreshOptions,
): Promise<ExternalWork[]> {
  const cancelled = (): boolean =>
    isCitationRequestCancellationRequested() ||
    cancellationRequested(options.signal);
  const mode = options.mode ?? "manual";
  const reportedRelationshipCount =
    direction === "references" ? node.referenceCount : node.citationCount;
  const providerPolicy = relationshipProviderPolicyForSize(
    mode,
    reportedRelationshipCount,
    {
      ...(options.providerStrategy
        ? { providerStrategy: options.providerStrategy }
        : {}),
      ...(options.providerLimit !== undefined
        ? { providerLimit: options.providerLimit }
        : {}),
    },
  );
  const policy = relationshipRefreshPolicy(mode, {
    ...providerPolicy,
    ...(options.metadataHydrationLimit !== undefined
      ? { metadataLimit: options.metadataHydrationLimit }
      : {}),
    ...(options.metadataBatchSize !== undefined
      ? { metadataBatchSize: options.metadataBatchSize }
      : {}),
  });
  const requestedMaximum = options.maximum ?? policy.membershipLimit;
  const maximum = Number.isFinite(requestedMaximum)
    ? Math.max(0, Math.floor(requestedMaximum))
    : Number.POSITIVE_INFINITY;
  const refreshMembership = options.refreshMembership === true;
  if (refreshMembership) activeRelationshipMembershipRefreshes += 1;
  const summaryLookupLimit =
    options.summaryLookupLimit ??
    RELATIONSHIP_METADATA_FOREGROUND_INDIVIDUAL_LIMIT;
  const queueBackgroundHydration = options.queueBackgroundHydration !== false;
  const relationshipLabel =
    direction === "references" ? "references" : "citing papers";
  const progress = relationshipProgress(
    options.silent === true,
    `Updating ${relationshipLabel}`,
    `Preparing ${relationshipLabel} for ${node.title || node.itemKey}`,
    options.onCancel,
  );
  const checkpoint = createCooperativeCheckpoint();
  const existingResult = (): ExternalWork[] =>
    toExternalWorks(
      getStoredRelationshipWorks(node, direction, maximum),
      libraryNodes,
    );
  let refreshStarted = false;
  let publicationBatchStarted = false;

  try {
    const cachedMembershipCount = getStoredRelationshipCount(node, direction);
    if (!refreshMembership && cachedMembershipCount) {
      const output = existingResult();
      options.onMembershipResolved?.({
        complete: true,
        provider: null,
        reportedCount: null,
        identifiedCount: cachedMembershipCount,
      });
      if (!progress.isDismissed()) {
        progress.finish(`${output.length} ${relationshipLabel} ready`);
      }
      return output;
    }

    if (
      mode === "automatic" &&
      node.itemID <= 0 &&
      !normalizeDOI(node.doi) &&
      !node.providerWorkID?.trim()
    ) {
      const output = existingResult();
      options.onMembershipResolved?.({
        complete: false,
        provider: null,
        reportedCount: null,
        identifiedCount: output.length,
      });
      if (!progress.isDismissed()) {
        progress.finish(
          `Cannot update ${relationshipLabel}: no stable paper identifier`,
        );
      }
      return output;
    }

    refreshStarted = true;
    beginCitationUpdatePublicationBatch();
    beginRelationshipPublicationBatch();
    publicationBatchStarted = true;
    publishRelationshipState(
      node,
      direction,
      "refresh-started",
      cachedMembershipCount,
      storedRelationshipReportedCount(node, direction),
    );
    const providers = relationshipProviders(
      node,
      direction,
      policy.providerStrategy,
      policy.providerLimit,
    );
    progress.setProgress(
      1,
      4,
      `Retrieving ${relationshipLabel} from ${providers.length} provider${
        providers.length === 1 ? "" : "s"
      }`,
    );
    const providerParallelism =
      mode === "automatic" ? 1 : RELATIONSHIP_PROVIDER_PARALLELISM;
    const results = await mapBounded(
      providers,
      providerParallelism,
      async (provider): Promise<RelationshipProviderSnapshot> => {
        if (cancelled()) {
          return {
            provider,
            works: [],
            reportedCount: null,
            complete: false,
            succeeded: false,
          };
        }
        return fetchProviderRelationshipSnapshot(
          provider,
          node,
          direction,
          maximum,
          options.providerWorkIDs,
          { signal: options.signal },
        );
      },
      {
        yieldAfterEach: true,
        yieldDelayMs: mode === "automatic" ? 12 : 4,
      },
    );
    if (cancelled()) return existingResult();

    const prepared = prepareRelationshipSnapshots(
      results,
      mergeRelatedWorkLists,
    );
    const selection = selectRelationshipMembership(
      direction,
      prepared,
      mergeRelatedWorkLists,
    );
    const usable = prepared.filter(
      (snapshot) =>
        snapshot.succeeded &&
        (snapshot.complete ||
          snapshot.identifiedWorks.length > 0 ||
          snapshot.reportedCount === 0),
    );

    if (!usable.length) {
      const output = existingResult();
      options.onMembershipResolved?.({
        complete: false,
        provider: null,
        reportedCount: null,
        identifiedCount: output.length,
      });
      if (!progress.isDismissed()) {
        progress.finish(`No new ${relationshipLabel} were available`);
      }
      return output;
    }

    // Commit compact membership before metadata hydration. Focus View can now
    // render the new graph immediately while summaries are enriched in small
    // yielded batches.
    progress.setProgress(
      2,
      4,
      `Saving ${selection.works.length} identified ${relationshipLabel}`,
    );
    const selectedMembership = await mapCooperatively(
      selection.works,
      (work) => compactRelationshipWork(work as ExternalWork),
      { forceEvery: 25 },
    );
    const committed = await replaceStoredRelationshipSelection(
      node,
      direction,
      selectedMembership,
      { alreadyCanonical: true, writeMetadata: false },
    );
    const reported = {
      count: selection.reportedCount,
      provider: selection.countProvider,
    } satisfies RelationshipReportedCount;
    const publishedReported = await synchronizeRelationshipSummary(
      node,
      direction,
      committed.length,
      reported,
    );
    publishRelationshipState(
      node,
      direction,
      "membership-published",
      committed.length,
      publishedReported,
    );
    options.onMembershipResolved?.({
      complete: selection.complete,
      provider: publishedReported.provider,
      reportedCount: publishedReported.count,
      identifiedCount: committed.length,
    });

    await checkpoint(true);
    if (cancelled()) return existingResult();

    const foregroundMetadataLimit = relationshipForegroundMetadataLimit(
      mode,
      selection.works.length,
      policy.metadataLimit,
    );
    let metadataIndex = new Map<string, RelatedWorkMetadata>();
    if (foregroundMetadataLimit > 0) {
      progress.setProgress(
        3,
        4,
        `Retrieving summaries for ${Math.min(
          selection.works.length,
          foregroundMetadataLimit,
        )} visible ${relationshipLabel}`,
      );
      metadataIndex = await hydrateRelationshipSelectionInBatches(
        selection.works,
        libraryNodes,
        foregroundMetadataLimit,
        policy.metadataBatchSize,
        summaryLookupLimit,
        options.signal,
      );
    } else {
      progress.setProgress(
        3,
        4,
        `Scheduling ${relationshipLabel} metadata in the background`,
      );
    }
    const selectedWorks = await mapCooperatively(
      selection.works,
      (work) => {
        const metadata = metadataForRelationshipWork(work, metadataIndex);
        return metadata ? mergeExternalWorkMetadata(work, metadata) : work;
      },
      { forceEvery: 25 },
    );
    if (metadataIndex.size) options.onMetadataHydrated?.();

    publishRelationshipState(
      node,
      direction,
      "metadata-published",
      committed.length,
      publishedReported,
    );

    if (queueBackgroundHydration && committed.length && !cancelled()) {
      queueRelationshipMetadataHydration(
        node,
        direction,
        selectedWorks.slice(
          Number.isFinite(policy.metadataLimit) ? policy.metadataLimit : 0,
        ),
        true,
        usable.map((snapshot) => snapshot.provider),
        options.showBackgroundProgress !== true,
        options.onMetadataHydrated,
      );
    }
    const output = toExternalWorks(committed.slice(0, maximum), libraryNodes);
    if (!progress.isDismissed()) {
      progress.finish(
        `${committed.length} identified ${relationshipLabel} saved${
          selection.reportedCount === null
            ? ""
            : ` · ${selection.reportedCount} reported`
        }`,
      );
    }
    return output;
  } catch (error) {
    if (!progress.isDismissed()) {
      progress.fail(`Failed to update ${relationshipLabel}: ${String(error)}`);
    }
    throw error;
  } finally {
    if (refreshStarted) {
      const selectedCount = getStoredRelationshipCount(node, direction);
      publishRelationshipState(
        node,
        direction,
        "refresh-finished",
        selectedCount,
        storedRelationshipReportedCount(node, direction),
      );
    }
    if (refreshMembership) {
      activeRelationshipMembershipRefreshes = Math.max(
        0,
        activeRelationshipMembershipRefreshes - 1,
      );
      scheduleRelationshipMetadataHydrationRun();
    }
    if (cancelled() && !progress.isDismissed()) {
      progress.dismiss();
    }
    if (publicationBatchStarted) {
      // Release graph/listeners while the pane/column repaint remains held so
      // every surface observes the same final relationship snapshot.
      endRelationshipPublicationBatch();
      endCitationUpdatePublicationBatch({
        refreshGraph: false,
        refreshColumns: true,
        refreshItemPanes: true,
      });
    }
  }
}

function relationshipRefreshOperationKey(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): string {
  return `${nodeLibraryID(node)}:${node.itemKey.toLocaleUpperCase()}:${direction}`;
}

function requestedRelationshipMaximum(
  options: ExternalRelationshipRefreshOptions,
): number {
  const mode = options.mode ?? "manual";
  const requested =
    options.maximum ?? relationshipRefreshPolicy(mode).membershipLimit;
  return Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : Number.POSITIVE_INFINITY;
}

/**
 * Coalesce refreshes for one paper and direction. A broader manual refresh is
 * serialized after an existing automatic refresh instead of competing with it
 * for providers, metadata resolution, SQLite, and Zotero's UI thread.
 */
export function refreshExternalRelationships(
  node: CitationGraphNode,
  libraryNodes: readonly LibraryWorkIdentity[],
  direction: "references" | "cited-by",
  options: ExternalRelationshipRefreshOptions = {
    maximum: Number.POSITIVE_INFINITY,
  },
): Promise<ExternalWork[]> {
  if (!externalDiscoveryRunning) {
    return Promise.resolve(cachedRelationshipResults(node, direction));
  }
  const key = relationshipRefreshOperationKey(node, direction);
  const mode = options.mode ?? "manual";
  const maximum = requestedRelationshipMaximum(options);
  const existing = activeRelationshipRefreshOperations.get(key);
  if (existing) {
    const unsubscribeCallerCancellation = options.signal?.subscribe(() =>
      existing.cancel(),
    );
    const needsBroaderFollowUp = relationshipRefreshRequiresFollowUp(
      { mode: existing.mode, membershipLimit: existing.maximum },
      { mode, membershipLimit: maximum },
      options.refreshMembership === true,
    );
    if (needsBroaderFollowUp) {
      return existing.promise
        .catch(() => undefined)
        .then(() =>
          refreshExternalRelationships(node, libraryNodes, direction, options),
        )
        .finally(() => unsubscribeCallerCancellation?.());
    }
    if (options.onMembershipResolved) {
      existing.membershipCallbacks.add(options.onMembershipResolved);
      if (existing.lastResolution) {
        invokeRefreshCallback(
          options.onMembershipResolved,
          existing.lastResolution,
        );
      }
    }
    if (options.onMetadataHydrated) {
      existing.metadataCallbacks.add(options.onMetadataHydrated);
      if (existing.metadataHydrated) {
        invokeRefreshSignal(options.onMetadataHydrated);
      }
    }
    return existing.promise
      .then((works) => works.slice(0, maximum))
      .finally(() => unsubscribeCallerCancellation?.());
  }

  const membershipCallbacks = new Set<
    (resolution: RelationshipRefreshResolution) => void
  >();
  const metadataCallbacks = new Set<() => void>();
  if (options.onMembershipResolved) {
    membershipCallbacks.add(options.onMembershipResolved);
  }
  if (options.onMetadataHydrated) {
    metadataCallbacks.add(options.onMetadataHydrated);
  }
  const operation: ActiveRelationshipRefresh = {
    promise: Promise.resolve([]),
    cancel: () => undefined,
    maximum,
    mode,
    lastResolution: null,
    metadataHydrated: false,
    membershipCallbacks,
    metadataCallbacks,
  };
  const requestScope = createCancellationScope(
    `${direction} relationship refresh for ${node.itemKey}`,
  );
  const unsubscribeCallerCancellation = options.signal?.subscribe(() =>
    requestScope.cancel(),
  );
  operation.cancel = () => requestScope.cancel();
  const coordinatedOptions: ExternalRelationshipRefreshOptions = {
    ...options,
    signal: requestScope.signal,
    onCancel: () => requestScope.cancel(),
    onMembershipResolved: (resolution) => {
      operation.lastResolution = resolution;
      for (const callback of membershipCallbacks) {
        invokeRefreshCallback(callback, resolution);
      }
    },
    onMetadataHydrated: () => {
      operation.metadataHydrated = true;
      for (const callback of metadataCallbacks) invokeRefreshSignal(callback);
    },
  };
  const promise = runExternalRelationshipRefresh(
    node,
    libraryNodes,
    direction,
    coordinatedOptions,
  ).finally(() => {
    unsubscribeCallerCancellation?.();
    if (activeRelationshipRefreshOperations.get(key) === operation) {
      activeRelationshipRefreshOperations.delete(key);
    }
  });
  operation.promise = promise;
  activeRelationshipRefreshOperations.set(key, operation);
  return promise;
}

export function startExternalDiscoveryRuntime(): void {
  externalDiscoveryGeneration += 1;
  externalDiscoveryRunning = true;
}

export function stopExternalDiscoveryRuntime(): void {
  externalDiscoveryGeneration += 1;
  externalDiscoveryRunning = false;
  if (relationshipMetadataHydrationTimer !== null) {
    clearTimeout(relationshipMetadataHydrationTimer);
    relationshipMetadataHydrationTimer = null;
  }
  relationshipMetadataHydrationQueue.clear();
  relationshipMetadataAttemptedThisSession.clear();
  relationshipRecordSynchronizations.clear();
  activeExternalMetadataResolutions.clear();
  clearRelatedWorkSummaryCaches();
  for (const operation of activeRelationshipRefreshOperations.values()) {
    operation.cancel();
  }
  activeRelationshipRefreshOperations.clear();
  activeRelationshipMembershipRefreshes = 0;
}

export async function getExternalReferences(
  node: CitationGraphNode,
  libraryNodes: readonly LibraryWorkIdentity[],
  maximum = 100,
  offset = 0,
  forceRefresh = false,
): Promise<ExternalWork[]> {
  if (forceRefresh || !selectedRelationshipCacheIsFresh(node, "references")) {
    await refreshExternalRelationships(node, libraryNodes, "references", {
      maximum: Math.max(50, maximum + offset),
      refreshMembership: true,
      mode: "automatic",
      metadataHydrationLimit: maximum,
      queueBackgroundHydration: true,
    });
  }
  return getCachedExternalReferences(node, libraryNodes, maximum, offset);
}

export async function getExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: readonly LibraryWorkIdentity[],
  maximum = 100,
  offset = 0,
  forceRefresh = false,
): Promise<ExternalWork[]> {
  if (forceRefresh || !selectedRelationshipCacheIsFresh(node, "cited-by")) {
    await refreshExternalRelationships(node, libraryNodes, "cited-by", {
      maximum: Math.max(50, maximum + offset),
      refreshMembership: true,
      mode: "automatic",
      metadataHydrationLimit: maximum,
      queueBackgroundHydration: true,
    });
  }
  return getCachedExternalCitedBy(node, libraryNodes, maximum, offset);
}

export async function importExternalWork(
  work: ExternalWork,
  libraryID: number,
  collectionIDs: number[],
): Promise<Zotero.Item[]> {
  const normalizedWork = normalizeRelatedWorkText(work);
  if (normalizedWork.inLibraryItemKey) {
    const existing = Zotero.Items.getByLibraryAndKey?.(
      libraryID,
      normalizedWork.inLibraryItemKey,
    );
    if (existing) {
      for (const collectionID of collectionIDs) {
        const collection = Zotero.Collections.get(collectionID);
        if (collection && !collection.hasItem?.(existing.id)) {
          collection.addItem(existing.id);
          await collection.saveTx?.();
        }
      }
      return [existing];
    }
  }

  const identifier = normalizedWork.doi
    ? { DOI: normalizedWork.doi }
    : normalizedWork.pmid
      ? { PMID: normalizedWork.pmid }
      : normalizedWork.arxiv
        ? { arXiv: normalizedWork.arxiv }
        : normalizedWork.isbn
          ? { ISBN: normalizedWork.isbn }
          : null;

  if (identifier) {
    const translate = new (Zotero.Translate as any).Search();
    translate.setIdentifier(identifier);
    const translators = await translate.getTranslators();
    translate.setTranslator(translators);
    const items = (await translate.translate({
      libraryID,
      collections: collectionIDs.length > 0 ? collectionIDs : false,
      saveAttachments: true,
    })) as Zotero.Item[];
    return normalizeImportedZoteroItems(items);
  }

  const item = new Zotero.Item("journalArticle");
  item.libraryID = libraryID;
  item.setField(
    "title",
    normalizedWork.title?.trim() ||
      normalizedWork.doi?.trim() ||
      normalizedWork.providerWorkID?.trim() ||
      "Untitled work",
  );
  if (normalizedWork.year) item.setField("date", String(normalizedWork.year));
  if (normalizedWork.sourceTitle)
    item.setField("publicationTitle", normalizedWork.sourceTitle);
  if (normalizedWork.abstract)
    item.setField("abstractNote", normalizedWork.abstract);
  if (normalizedWork.doi) item.setField("DOI", normalizedWork.doi);
  if (normalizedWork.isbn) item.setField("ISBN", normalizedWork.isbn);
  for (const [index, creator] of normalizedWork.authors.entries()) {
    const parts = creator.trim().split(/\s+/);
    item.setCreator(index, {
      creatorType: "author",
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts.at(-1) ?? creator,
    });
  }
  const id = await item.saveTx();
  for (const collectionID of collectionIDs) {
    const collection = Zotero.Collections.get(collectionID);
    if (collection) {
      collection.addItem(id);
      await collection.saveTx?.();
    }
  }
  return [item];
}
