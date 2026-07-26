import type {
  CitationProviderID,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import type { RelationshipProviderSnapshot } from "../providers/relationshipAdapters";
import { isCitationRequestCancellationRequested } from "../providers/http";
import "./providerResponseCacheService";
import {
  discoverSimilarWorks,
  getCitationProvider,
  getProviderPlan,
  mergeRelatedWorkMetadata,
  resolveRelatedWorksMetadata,
} from "../providers/registry";
import {
  externalWorkCacheIdentity,
  normalizeDOI,
  normalizeExactTitle,
  relatedWorkMetadataAliases,
} from "./citationIdentifiers";
import {
  registerExternalWorkMetricBatch,
  registerExternalWorkMetrics,
} from "./externalWorkMetricRegistry";
import { richestCountAttribution } from "./citationCountPolicy";
import {
  getCitationMetricRecord,
  saveCitationMetricRecord,
} from "./citationMetricsStore";
import { getProviderPreference } from "./citationPreferences";
import type { ProviderIdentityHints } from "./libraryCoreBatchService";
import {
  RELATIONSHIP_SUMMARY_BACKGROUND_FALLBACK_LIMIT,
  RELATIONSHIP_SUMMARY_BATCH_SIZE,
  providerExecutionPolicy,
} from "./providerExecutionPolicy";
import {
  cachedExternalWorkMetadata,
  saveExternalWorkCacheSuccesses,
  shouldResolveExternalWork,
} from "./externalWorkCacheService";
import {
  getStoredRelationshipEntry,
  getStoredRelationshipWorks,
  mergeRelatedWorkLists,
  getStoredProviderRelationshipEntry,
  replaceStoredProviderRelationships,
  replaceStoredRelationshipSelection,
} from "./relationshipStoreService";
import {
  prepareRelationshipSnapshots,
  selectRelationshipMembership,
} from "./providerDispatcher";
import { createUpdateProgress } from "./updateProgressService";
import {
  mergeRelatedWorkHydrationState,
  projectRelatedWorkSummary,
  relatedWorkNeedsSummary,
} from "./relatedWorkHydrationState";
import {
  fetchRelatedWorkSummaryPage,
  resolveRelatedWorkSummaries,
} from "./relatedWorkSummaryService";
import {
  normalizeImportedZoteroItems,
  normalizeRelatedWorkText,
  normalizeScholarlyText,
} from "./scholarlyTextService";

function nodeLibraryID(node: CitationGraphNode): number {
  const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
  const libraryID = Number(item?.libraryID);
  return Number.isFinite(libraryID)
    ? libraryID
    : Zotero.Libraries.userLibraryID;
}

export interface ExternalWork extends RelatedWorkMetadata {
  recommendationScore?: number;
  recommendationSources?: CitationProviderID[];
  citingNodeKeys?: string[];
  inLibraryItemKey?: string | null;
}

const RELATIONSHIP_MAX_AGE_MS = 30 * 86400000;
const RELATIONSHIP_MAX_PAGES = 30;
const RELATIONSHIP_ABSOLUTE_MAX_PAGES = 1000;
const RELATIONSHIP_PROVIDER_TIMEOUT_MS = 15000;
// Batch-capable providers hydrate the entire deduplicated neighbour set.
// A small bounded fallback covers identifiers unsupported by batch endpoints.
const RELATIONSHIP_METADATA_FOREGROUND_INDIVIDUAL_LIMIT = 8;
const RELATIONSHIP_METADATA_BACKGROUND_DELAY_MS = 350;

function relationshipMetadataBatchSize(): number {
  return RELATIONSHIP_SUMMARY_BATCH_SIZE;
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
const relationshipRecordSynchronizations = new Map<string, Promise<void>>();
const activeExternalMetadataResolutions = new Map<
  string,
  Promise<RelatedWorkMetadata | null>
>();

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

function selectedRelationshipCacheIsFresh(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): boolean {
  const entry = getStoredRelationshipEntry(node, direction);
  if (!entry) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  return (
    Number.isFinite(fetchedAt) &&
    Date.now() - fetchedAt < RELATIONSHIP_MAX_AGE_MS
  );
}

function relationshipMetadataIndex(
  works: RelatedWorkMetadata[],
): Map<string, RelatedWorkMetadata> {
  const index = new Map<string, RelatedWorkMetadata>();
  for (const work of works) {
    for (const alias of relatedWorkMetadataAliases(work)) {
      const previous = index.get(alias);
      index.set(alias, previous ? mergeMetadata(previous, work) : work);
    }
  }
  return index;
}

function metadataForRelationshipWork(
  work: RelatedWorkMetadata,
  index: Map<string, RelatedWorkMetadata>,
): RelatedWorkMetadata | null {
  let metadata: RelatedWorkMetadata | null = null;
  for (const alias of relatedWorkMetadataAliases(work)) {
    const candidate = index.get(alias);
    if (candidate)
      metadata = metadata ? mergeMetadata(metadata, candidate) : candidate;
  }
  return metadata;
}

function usableExternalTitle(
  title: string | null | undefined,
  doi: string | null | undefined,
): string | null {
  const value = normalizeScholarlyText(title);
  if (!value) return null;
  const normalizedValue = value
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim()
    .toLocaleLowerCase();
  const normalizedDOI = normalizeDOI(doi);
  if (normalizedDOI && normalizedValue === normalizedDOI) return null;
  if (/^https?:\/\//i.test(value)) return null;
  return value;
}

export function externalWorkDisplayTitle(
  work: RelatedWorkMetadata,
): string | null {
  const direct = usableExternalTitle(work.title, work.doi);
  if (direct) return direct;
  const key = externalWorkCacheIdentity(work);
  const cached = key ? cachedExternalWorkMetadata(key) : null;
  return cached
    ? usableExternalTitle(cached.title, cached.doi ?? work.doi)
    : null;
}

function mergeMetadata<T extends RelatedWorkMetadata>(
  work: T,
  metadata: RelatedWorkMetadata | null,
): T {
  const merged = mergeRelatedWorkMetadata(work, metadata);
  const sources = new Set<CitationProviderID>(work.dataSources ?? []);
  if (work.provider !== "manual" && work.provider !== "zotero") {
    sources.add(work.provider);
  }
  for (const source of metadata?.dataSources ?? []) sources.add(source);
  if (
    metadata &&
    metadata.provider !== "manual" &&
    metadata.provider !== "zotero"
  ) {
    sources.add(metadata.provider);
  }
  const timestamps = [work.updatedAt, metadata?.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const authors =
    work.authors.length >= (metadata?.authors.length ?? 0)
      ? work.authors
      : (metadata?.authors ?? []);
  const normalized = normalizeRelatedWorkText({
    ...merged,
    authors: [...authors],
    authorIDs: [
      ...new Set([...(work.authorIDs ?? []), ...(metadata?.authorIDs ?? [])]),
    ],
    citationCountsByYear: work.citationCountsByYear?.length
      ? work.citationCountsByYear
      : (metadata?.citationCountsByYear ?? []),
    references:
      (work.references?.length ?? 0) >= (metadata?.references?.length ?? 0)
        ? work.references
        : metadata?.references,
    resolvedReferenceCount:
      work.resolvedReferenceCount ?? metadata?.resolvedReferenceCount ?? null,
    fwci: work.fwci ?? metadata?.fwci ?? null,
    citationPercentile:
      work.citationPercentile ?? metadata?.citationPercentile ?? null,
    isTop1Percent: work.isTop1Percent ?? metadata?.isTop1Percent ?? null,
    isTop10Percent: work.isTop10Percent ?? metadata?.isTop10Percent ?? null,
    citationsLastYear:
      work.citationsLastYear ?? metadata?.citationsLastYear ?? null,
    citationVelocity:
      work.citationVelocity ?? metadata?.citationVelocity ?? null,
    citationAcceleration:
      work.citationAcceleration ?? metadata?.citationAcceleration ?? null,
    influentialCitationCount:
      work.influentialCitationCount ??
      metadata?.influentialCitationCount ??
      null,
    publicationType: work.publicationType ?? metadata?.publicationType ?? null,
    sourceMetrics: work.sourceMetrics ?? metadata?.sourceMetrics ?? null,
    referenceAgeMean:
      work.referenceAgeMean ?? metadata?.referenceAgeMean ?? null,
    referenceAgeSpread:
      work.referenceAgeSpread ?? metadata?.referenceAgeSpread ?? null,
    selfCitationEstimate:
      work.selfCitationEstimate ?? metadata?.selfCitationEstimate ?? null,
    futureReferenceCount:
      work.futureReferenceCount ?? metadata?.futureReferenceCount ?? null,
    metadataCompleteness:
      work.metadataCompleteness ?? metadata?.metadataCompleteness ?? null,
    dataSources: [...sources],
    updatedAt: timestamps.at(-1) ?? null,
  } as T);
  return mergeRelatedWorkHydrationState(normalized, metadata);
}

function localIndexes(nodes: CitationGraphNode[]): {
  byDOI: Map<string, string>;
  byTitle: Map<string, string>;
} {
  const byDOI = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const node of nodes) {
    const doi = normalizeDOI(node.doi);
    const title = normalizeExactTitle(node.title);
    if (doi && !byDOI.has(doi)) byDOI.set(doi, node.itemKey);
    if (title && !byTitle.has(title)) byTitle.set(title, node.itemKey);
  }
  return { byDOI, byTitle };
}

function toExternal(
  work: RelatedWorkMetadata,
  localByDOI: Map<string, string>,
  localByTitle: Map<string, string>,
): ExternalWork {
  const key = externalWorkCacheIdentity(work);
  const resolved = normalizeRelatedWorkText(
    key ? mergeMetadata(work, cachedExternalWorkMetadata(key)) : work,
  );
  const doi = normalizeDOI(resolved.doi);
  const title = normalizeExactTitle(resolved.title);
  const external: ExternalWork = {
    ...resolved,
    inLibraryItemKey:
      (doi ? localByDOI.get(doi) : null) ??
      (title ? localByTitle.get(title) : null) ??
      resolved.zoteroItemKey ??
      null,
  };
  registerExternalWorkMetrics(external);
  return external;
}

function toExternalWorks(
  works: RelatedWorkMetadata[],
  libraryNodes: CitationGraphNode[],
): ExternalWork[] {
  const indexes = localIndexes(libraryNodes);
  return works.map((work) => toExternal(work, indexes.byDOI, indexes.byTitle));
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

async function cacheProviderRelationshipSnapshot(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  provider: CitationProviderID,
  works: RelatedWorkMetadata[],
): Promise<RelatedWorkMetadata[]> {
  const refreshedAt = new Date().toISOString();
  const fullSnapshot = mergeRelatedWorkLists(works).map((work) =>
    normalizeRelatedWorkText({
      ...work,
      dataSources: [...new Set([...(work.dataSources ?? []), provider])],
      updatedAt: work.updatedAt ?? refreshedAt,
      inLibraryItemKey:
        (work as ExternalWork).inLibraryItemKey ?? work.zoteroItemKey ?? null,
    }),
  );
  const cacheEntries: Array<{
    identityKey: string;
    metadata: RelatedWorkMetadata;
  }> = [];
  for (const work of fullSnapshot) {
    const key = externalWorkCacheIdentity(work);
    if (key && usableExternalTitle(work.title, work.doi)) {
      cacheEntries.push({ identityKey: key, metadata: work });
    }
  }
  await saveExternalWorkCacheSuccesses(cacheEntries);
  const membership = fullSnapshot.map((work) =>
    compactRelationshipWork(work as ExternalWork),
  );
  return replaceStoredProviderRelationships(
    node,
    direction,
    provider,
    membership,
  );
}

async function mergeProviderRelationshipSnapshot(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  provider: CitationProviderID,
  works: RelatedWorkMetadata[],
): Promise<RelatedWorkMetadata[]> {
  const existing = getStoredProviderRelationshipEntry(
    node,
    direction,
    provider,
  );
  return cacheProviderRelationshipSnapshot(
    node,
    direction,
    provider,
    mergeRelatedWorkLists(existing?.works ?? [], works),
  );
}

function relationshipRecordSynchronizationKey(node: CitationGraphNode): string {
  return `${nodeLibraryID(node)}:${node.itemKey.toLocaleUpperCase()}`;
}

interface RelationshipReportedCount {
  count: number | null;
  provider: CitationProviderID | null;
}

function expandStoredRelationshipMetadata(
  works: RelatedWorkMetadata[],
): RelatedWorkMetadata[] {
  return works.map((work) => {
    const key = externalWorkCacheIdentity(work);
    const cached = key ? cachedExternalWorkMetadata(key) : null;
    return cached ? mergeMetadata(work, cached) : work;
  });
}

async function synchronizeStoredRelationshipRecord(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
  reported: RelationshipReportedCount | null,
): Promise<void> {
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  if (!record) return;
  if (direction === "references") {
    const expandedWorks = expandStoredRelationshipMetadata(works);
    await saveCitationMetricRecord({
      ...record,
      referenceCount: reported?.count ?? record.referenceCount,
      referenceCountProvider:
        reported?.provider ?? record.referenceCountProvider,
      resolvedReferenceCount: expandedWorks.length,
      references: expandedWorks,
    });
  } else {
    const citationCount = richestCountAttribution([
      {
        count: record.citationCount,
        provider: record.citationCountProvider,
      },
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
  }
}

function synchronizeRelationshipRecord(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
  reported: RelationshipReportedCount | null = null,
): Promise<void> {
  const key = relationshipRecordSynchronizationKey(node);
  const previous =
    relationshipRecordSynchronizations.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() =>
      synchronizeStoredRelationshipRecord(node, direction, works, reported),
    );
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
}

export async function storeExternalRelationshipSnapshot(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
  options: StoreRelationshipSnapshotOptions = {},
): Promise<void> {
  const provider =
    options.provider ??
    node.provider ??
    works.find(
      (work) => work.provider !== "manual" && work.provider !== "zotero",
    )?.provider;
  if (!provider || provider === "manual" || provider === "zotero") return;

  const rawSnapshot = mergeRelatedWorkLists(works);
  const prepared = prepareRelationshipSnapshots(
    [
      {
        provider,
        works: rawSnapshot,
        reportedCount: options.reportedCount ?? null,
        complete: options.complete === true,
        succeeded: true,
      },
    ],
    mergeRelatedWorkLists,
  )[0];
  const complete =
    options.complete === true ||
    options.reportedCount === 0 ||
    (options.reportedCount != null &&
      rawSnapshot.length >= options.reportedCount);
  const providerOwnsMembership = rawSnapshot.every(
    (work) =>
      work.provider === provider || work.dataSources?.includes(provider),
  );
  if (!complete || !providerOwnsMembership) return;

  // Never expose an incomplete or cross-provider scalar list as membership.
  const selectedMembership = prepared.identifiedWorks.map((work) =>
    compactRelationshipWork(work as ExternalWork),
  );
  await replaceStoredRelationshipSelection(node, direction, selectedMembership);
  await synchronizeRelationshipRecord(
    node,
    direction,
    prepared.identifiedWorks,
    {
      count: options.reportedCount ?? null,
      provider,
    },
  );
  await cacheProviderRelationshipSnapshot(
    node,
    direction,
    provider,
    prepared.identifiedWorks,
  );
  queueRelationshipMetadataHydration(
    node,
    direction,
    prepared.identifiedWorks,
    true,
    [provider],
  );
}

function needsRelationshipBibliographicMetadata(
  work: RelatedWorkMetadata,
): boolean {
  if (!relatedWorkNeedsSummary(work)) return false;
  return (
    !externalWorkDisplayTitle(work) ||
    work.year === null ||
    work.authors.length === 0 ||
    !work.sourceTitle?.trim() ||
    work.citationCount == null ||
    work.referenceCount == null
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
  return `${nodeLibraryID(target.node)}:${target.node.itemKey.toLocaleUpperCase()}:${target.direction}`;
}

function scheduleRelationshipMetadataHydrationRun(): void {
  if (
    relationshipMetadataHydrationRunning ||
    relationshipMetadataHydrationTimer !== null ||
    relationshipMetadataHydrationQueue.size === 0
  ) {
    return;
  }
  relationshipMetadataHydrationTimer = setTimeout(() => {
    relationshipMetadataHydrationTimer = null;
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
    getProviderPreference(),
  ).providers,
): void {
  const target: RelationshipMetadataHydrationTarget = {
    node,
    direction,
    providers: new Set(providers),
  };
  const targetKey = relationshipHydrationTargetKey(target);
  for (const rawWork of works) {
    if (!needsRelationshipBibliographicMetadata(rawWork)) continue;
    const key = externalWorkCacheIdentity(rawWork);
    if (!key) continue;
    const cached = cachedExternalWorkMetadata(key);
    const work = cached ? mergeMetadata(rawWork, cached) : rawWork;
    const stillNeedsLookup = needsRelationshipBibliographicMetadata(work);
    if (retryAttempted) relationshipMetadataAttemptedThisSession.delete(key);
    if (stillNeedsLookup && relationshipMetadataAttemptedThisSession.has(key)) {
      continue;
    }
    const existing = relationshipMetadataHydrationQueue.get(key);
    if (existing) {
      existing.work = mergeMetadata(existing.work, work);
      const existingTarget = existing.targets.get(targetKey);
      if (existingTarget) {
        for (const provider of target.providers) {
          existingTarget.providers.add(provider);
        }
      } else {
        existing.targets.set(targetKey, target);
      }
    } else {
      relationshipMetadataHydrationQueue.set(key, {
        work: { ...work, authors: [...work.authors] },
        targets: new Map([[targetKey, target]]),
      });
    }
  }
  scheduleRelationshipMetadataHydrationRun();
}

async function persistHydratedRelationshipMetadata(
  targets: RelationshipMetadataHydrationTarget[],
  metadataIndex: Map<string, RelatedWorkMetadata>,
): Promise<void> {
  void metadataIndex;
  const uniqueTargets = new Map<string, RelationshipMetadataHydrationTarget>();
  for (const target of targets) {
    const key = relationshipHydrationTargetKey(target);
    const existing = uniqueTargets.get(key);
    if (existing) {
      for (const provider of target.providers) existing.providers.add(provider);
    } else {
      uniqueTargets.set(key, target);
    }
  }

  // Membership rows store only stable identities. Hydrated metadata lives once
  // in the global external-work cache, so no relationship snapshot rewrite is
  // required when a title, author list, journal, or count is filled in.
  for (const target of uniqueTargets.values()) {
    const selected = getStoredRelationshipWorks(target.node, target.direction);
    await synchronizeRelationshipRecord(
      target.node,
      target.direction,
      expandStoredRelationshipMetadata(selected),
    );
  }
}

async function runRelationshipMetadataHydrationQueue(): Promise<void> {
  if (relationshipMetadataHydrationRunning) return;
  relationshipMetadataHydrationRunning = true;
  const initialTotal = relationshipMetadataHydrationQueue.size;
  let completed = 0;
  const progress = createUpdateProgress({
    title: "Updating relationship metadata",
    message: `Preparing ${initialTotal} related paper${initialTotal === 1 ? "" : "s"}`,
    total: Math.max(1, initialTotal),
  });
  try {
    while (relationshipMetadataHydrationQueue.size > 0) {
      if (isCitationRequestCancellationRequested()) {
        relationshipMetadataHydrationQueue.clear();
        break;
      }
      const batchEntries = [
        ...relationshipMetadataHydrationQueue.entries(),
      ].slice(0, relationshipMetadataBatchSize());
      const targets: RelationshipMetadataHydrationTarget[] = [];
      const input: ExternalWork[] = [];
      for (const [key, entry] of batchEntries) {
        relationshipMetadataHydrationQueue.delete(key);
        relationshipMetadataAttemptedThisSession.add(key);
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
        `Retrieving summaries for ${input.length} related paper${input.length === 1 ? "" : "s"} · ${completed}/${currentTotal} complete`,
      );

      // Batch-capable providers run first, then Crossref/other DOI providers are
      // allowed to resolve every remaining work in this bounded background chunk.
      const hydrated = await hydrateExternalWorksMetadata(
        input,
        false,
        RELATIONSHIP_SUMMARY_BACKGROUND_FALLBACK_LIMIT,
        true,
      );
      if (isCitationRequestCancellationRequested()) {
        relationshipMetadataHydrationQueue.clear();
        break;
      }
      const resolved = hydrated.filter(
        (work) => !needsRelationshipBibliographicMetadata(work),
      );
      if (resolved.length) {
        await persistHydratedRelationshipMetadata(
          targets,
          relationshipMetadataIndex(resolved),
        );
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
    if (!isCitationRequestCancellationRequested()) {
      scheduleRelationshipMetadataHydrationRun();
    }
  }
}

export async function hydrateExternalWorksMetadata(
  works: ExternalWork[],
  includeSecondaryMetrics = false,
  individualLookupLimit = Number.POSITIVE_INFINITY,
  bibliographicOnly = false,
  forceRefresh = false,
): Promise<ExternalWork[]> {
  const hydrated = works.map((work) => {
    const key = externalWorkCacheIdentity(work);
    return key ? mergeMetadata(work, cachedExternalWorkMetadata(key)) : work;
  });

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
    const key = externalWorkCacheIdentity(work);
    if (!key) continue;
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

    void runBounded(
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
            ? await resolveRelatedWorkSummaries(
                input,
                getProviderPreference(),
                { individualLookupLimit: lookupLimit },
              )
            : await resolveRelatedWorksMetadata(
                input,
                getProviderPreference(),
                includeSecondaryMetrics,
                { individualLookupLimit: lookupLimit },
              );
          deferred.forEach((result, index) => {
            result.resolve(resolved[index] ?? null);
          });
        } catch (error) {
          Zotero.debug(
            `Citation Map: metadata batch resolution failed: ${String(error)}`,
          );
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
  await Promise.all(
    [...resolutionByIndex.entries()].map(async ([workIndex, resolution]) => {
      const metadata = await resolution;
      if (!metadata) return;
      hydrated[workIndex] = mergeMetadata(hydrated[workIndex], metadata);
      const key = externalWorkCacheIdentity(hydrated[workIndex]);
      if (
        key &&
        usableExternalTitle(hydrated[workIndex].title, hydrated[workIndex].doi)
      ) {
        cacheEntries.push({ identityKey: key, metadata: hydrated[workIndex] });
      }
    }),
  );
  await saveExternalWorkCacheSuccesses(cacheEntries);
  registerExternalWorkMetricBatch(hydrated);
  return hydrated;
}

function identifiersForNode(node: CitationGraphNode): WorkIdentifiers {
  return {
    doi: normalizeDOI(node.doi),
    pmid: null,
    arxiv: null,
    isbn: null,
    title: node.title,
    normalizedTitle: normalizeExactTitle(node.title),
    year: node.year,
    authors: node.authors,
    sourceTitle: node.sourceTitle,
  };
}

function normalizedSurname(value: string): string {
  const compact = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .trim();
  return compact.split(/\s+/).filter(Boolean).at(-1) ?? compact;
}

function providerMatchCompatible(
  match: {
    doi: string | null;
    title: string | null;
    year: number | null;
    authors: string[];
  },
  identifiers: WorkIdentifiers,
): boolean {
  const expectedDOI = normalizeDOI(identifiers.doi);
  const matchDOI = normalizeDOI(match.doi);
  if (expectedDOI && matchDOI) return expectedDOI === matchDOI;

  const expectedTitle = identifiers.normalizedTitle;
  const matchTitle = normalizeExactTitle(match.title);
  if (expectedTitle && matchTitle && expectedTitle !== matchTitle) return false;
  if (
    identifiers.year !== null &&
    match.year !== null &&
    Math.abs(identifiers.year - match.year) > 1
  ) {
    return false;
  }
  if (identifiers.authors.length && match.authors.length) {
    const expected = new Set(
      identifiers.authors.map(normalizedSurname).filter(Boolean),
    );
    if (
      !match.authors.some((author) => expected.has(normalizedSurname(author)))
    ) {
      return false;
    }
  }
  return Boolean(expectedTitle && matchTitle && expectedTitle === matchTitle);
}

async function lookupProviderRecord(
  providerID: CitationProviderID,
  identifiers: WorkIdentifiers,
) {
  const provider = getCitationProvider(providerID);
  const lookup = provider.lookupForRelations ?? provider.lookup;
  let match = provider.supports(identifiers) ? await lookup(identifiers) : null;
  if (
    (!match || match.status !== "success") &&
    provider.searchExactTitle &&
    identifiers.normalizedTitle
  ) {
    match = await provider.searchExactTitle(identifiers);
  }
  return match?.status === "success" &&
    providerMatchCompatible(match, identifiers)
    ? match
    : null;
}

function stampProviderWorks(
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
): Promise<RelationshipProviderSnapshot> {
  const failed = (): RelationshipProviderSnapshot => ({
    provider: providerID,
    works: [],
    reportedCount: null,
    complete: false,
    succeeded: false,
  });
  try {
    const identifiers = identifiersForNode(node);
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
          )
      : nativeFetcher;
    const hintedProviderWorkID = providerWorkIDs[providerID] ?? null;
    const match = hintedProviderWorkID
      ? null
      : await withProviderTimeout(
          providerID,
          direction,
          lookupProviderRecord(providerID, identifiers),
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
      (providerID === node.provider ? node.providerWorkID : null) ??
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
        fetcher(providerWorkID, requested, offset),
      );
      if (!Array.isArray(pageResult)) return failed();
      const page = pageResult;
      pages += 1;
      if (!page.length) {
        endpointExhausted = true;
        break;
      }
      const stamped = stampProviderWorks(page, providerID);
      const signature = stamped
        .map((work) => externalWorkCacheIdentity(work) ?? JSON.stringify(work))
        .join("|");
      if (signature === previousSignature) {
        return {
          provider: providerID,
          works,
          reportedCount,
          complete: false,
          succeeded: true,
        };
      }
      previousSignature = signature;
      works = mergeRelatedWorkLists(works, stamped);
      offset += page.length;
      if (page.length < requested) {
        endpointExhausted = true;
        break;
      }
      if (reportedCount !== null && works.length >= reportedCount) break;
    }

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
  libraryNodes: CitationGraphNode[],
  maximum: number,
  offset: number,
): ExternalWork[] {
  const cached = cachedReferenceWorks(node);
  queueRelationshipMetadataHydration(node, "references", cached);
  return toExternalWorks(cached.slice(offset, offset + maximum), libraryNodes);
}

export function getCachedExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum: number,
  offset: number,
): ExternalWork[] {
  const cached = cachedRelationshipResults(node, "cited-by");
  queueRelationshipMetadataHydration(node, "cited-by", cached);
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
  onMembershipResolved?: (resolution: RelationshipRefreshResolution) => void;
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
): RelationshipProgress {
  if (!silent) return createUpdateProgress({ title, message, total: 4 });
  return {
    setProgress: () => undefined,
    finish: () => undefined,
    fail: () => undefined,
    dismiss: () => undefined,
    isDismissed: () => false,
  };
}

export async function refreshExternalRelationships(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  direction: "references" | "cited-by",
  maximumOrOptions:
    number | ExternalRelationshipRefreshOptions = Number.POSITIVE_INFINITY,
  legacyRefreshMembership = false,
): Promise<ExternalWork[]> {
  const options: ExternalRelationshipRefreshOptions =
    typeof maximumOrOptions === "number"
      ? {
          maximum: maximumOrOptions,
          refreshMembership: legacyRefreshMembership,
        }
      : maximumOrOptions;
  const requestedMaximum = options.maximum ?? Number.POSITIVE_INFINITY;
  const maximum = Number.isFinite(requestedMaximum)
    ? Math.max(0, Math.floor(requestedMaximum))
    : Number.POSITIVE_INFINITY;
  const refreshMembership = options.refreshMembership === true;
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
  );
  const existingResult = (): ExternalWork[] =>
    toExternalWorks(
      getStoredRelationshipWorks(node, direction).slice(0, maximum),
      libraryNodes,
    );

  try {
    const cachedMembership = getStoredRelationshipWorks(node, direction);
    if (!refreshMembership && cachedMembership.length) {
      progress.setProgress(
        1,
        4,
        `Refreshing metadata for ${cachedMembership.length} cached ${relationshipLabel}`,
      );
      const hydrated = await hydrateExternalWorksMetadata(
        toExternalWorks(cachedMembership, libraryNodes),
        false,
        summaryLookupLimit,
        true,
        true,
      );
      if (isCitationRequestCancellationRequested()) return existingResult();
      const plan = getProviderPlan(
        direction === "references" ? "references" : "citations",
        getProviderPreference(),
      );
      progress.setProgress(2, 4, `Validating ${relationshipLabel}`);
      if (hydrated.length && plan.providers.length) {
        await persistHydratedRelationshipMetadata(
          [
            {
              node,
              direction,
              providers: new Set(plan.providers),
            },
          ],
          relationshipMetadataIndex(hydrated),
        );
      }
      if (isCitationRequestCancellationRequested()) return existingResult();
      const selected = getStoredRelationshipWorks(node, direction);
      progress.setProgress(
        3,
        4,
        `Saving ${selected.length} ${relationshipLabel}`,
      );
      await synchronizeRelationshipRecord(node, direction, selected);
      const output = toExternalWorks(selected.slice(0, maximum), libraryNodes);
      options.onMembershipResolved?.({
        complete: true,
        provider: null,
        reportedCount: null,
        identifiedCount: selected.length,
      });
      if (!progress.isDismissed()) {
        progress.finish(`${output.length} ${relationshipLabel} ready`);
      }
      return output;
    }

    const plan = getProviderPlan(
      direction === "references" ? "references" : "citations",
      getProviderPreference(),
    );
    progress.setProgress(
      1,
      4,
      `Retrieving ${relationshipLabel} from ${plan.providers.length} provider${plan.providers.length === 1 ? "" : "s"}`,
    );
    const results: RelationshipProviderSnapshot[] = [];
    for (const provider of plan.providers) {
      if (isCitationRequestCancellationRequested()) break;
      const snapshot = await fetchProviderRelationshipSnapshot(
        provider,
        node,
        direction,
        maximum,
        options.providerWorkIDs,
      );
      results.push(snapshot);
      // A complete authoritative provider already supplies the full membership.
      // Additional providers would add latency and duplicate edges, so only fall
      // through when the current provider is unavailable or incomplete.
      if (snapshot.succeeded && snapshot.complete) break;
    }
    if (isCitationRequestCancellationRequested()) return existingResult();

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

    progress.setProgress(
      2,
      4,
      `Retrieving summaries for ${selection.works.length} identified ${relationshipLabel}`,
    );
    const hydratedSelection = selection.works.length
      ? await hydrateExternalWorksMetadata(
          toExternalWorks(selection.works, libraryNodes),
          false,
          summaryLookupLimit,
          true,
        )
      : [];
    if (isCitationRequestCancellationRequested()) return existingResult();
    const metadataIndex = relationshipMetadataIndex(hydratedSelection);
    const selectedWorks = selection.works.map((work) => {
      const metadata = metadataForRelationshipWork(work, metadataIndex);
      return metadata ? mergeMetadata(work, metadata) : work;
    });

    // Publish only after all selected membership and foreground metadata are
    // ready, so panels never expose a partial provider result.
    progress.setProgress(
      3,
      4,
      `Saving ${selectedWorks.length} ${relationshipLabel}`,
    );
    const selectedMembership = selectedWorks.map((work) =>
      compactRelationshipWork(work as ExternalWork),
    );
    const committed = await replaceStoredRelationshipSelection(
      node,
      direction,
      selectedMembership,
    );
    await synchronizeRelationshipRecord(node, direction, selectedWorks, {
      count: selection.reportedCount,
      provider: selection.countProvider,
    });

    for (const snapshot of usable) {
      if (isCitationRequestCancellationRequested()) break;
      const providerWorks = snapshot.identifiedWorks.map((work) => {
        const metadata = metadataForRelationshipWork(work, metadataIndex);
        return metadata ? mergeMetadata(work, metadata) : work;
      });
      if (snapshot.complete) {
        await cacheProviderRelationshipSnapshot(
          node,
          direction,
          snapshot.provider,
          providerWorks,
        );
      } else {
        await mergeProviderRelationshipSnapshot(
          node,
          direction,
          snapshot.provider,
          providerWorks,
        );
      }
    }

    const completeSnapshot =
      usable.find(
        (snapshot) =>
          snapshot.complete && snapshot.provider === selection.countProvider,
      ) ?? usable.find((snapshot) => snapshot.complete);
    options.onMembershipResolved?.({
      complete: Boolean(completeSnapshot),
      provider: completeSnapshot?.provider ?? selection.countProvider,
      reportedCount: selection.reportedCount,
      identifiedCount: committed.length,
    });

    if (
      queueBackgroundHydration &&
      committed.length &&
      !isCitationRequestCancellationRequested()
    ) {
      queueRelationshipMetadataHydration(
        node,
        direction,
        committed,
        true,
        usable.map((snapshot) => snapshot.provider),
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
    if (isCitationRequestCancellationRequested() && !progress.isDismissed()) {
      progress.dismiss();
    }
  }
}

export async function getExternalReferences(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
  forceRefresh = false,
  _expandCoverage = forceRefresh,
): Promise<ExternalWork[]> {
  if (forceRefresh || !selectedRelationshipCacheIsFresh(node, "references")) {
    await refreshExternalRelationships(
      node,
      libraryNodes,
      "references",
      2500,
      true,
    );
  }
  return getCachedExternalReferences(node, libraryNodes, maximum, offset);
}

export async function getExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
  forceRefresh = false,
  _expandCoverage = forceRefresh,
): Promise<ExternalWork[]> {
  if (forceRefresh || !selectedRelationshipCacheIsFresh(node, "cited-by")) {
    await refreshExternalRelationships(
      node,
      libraryNodes,
      "cited-by",
      2500,
      true,
    );
  }
  return getCachedExternalCitedBy(node, libraryNodes, maximum, offset);
}

interface RecommendationCandidate {
  work: RelatedWorkMetadata;
  score: number;
  connectedNodeKeys: Set<string>;
}

function addRecommendationCandidate(
  candidates: Map<string, RecommendationCandidate>,
  indexes: ReturnType<typeof localIndexes>,
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
  const identity = externalWorkCacheIdentity(work);
  if (!identity) return;
  const current = candidates.get(identity) ?? {
    work,
    score: 0,
    connectedNodeKeys: new Set<string>(),
  };
  current.score += weight;
  current.connectedNodeKeys.add(node.key);
  current.work = mergeMetadata(current.work, work);
  candidates.set(identity, current);
}

function identifiersForExternalWork(
  work: RelatedWorkMetadata,
): WorkIdentifiers {
  return {
    doi: normalizeDOI(work.doi),
    pmid: String(work.pmid ?? "").trim() || null,
    arxiv: String(work.arxiv ?? "").trim() || null,
    isbn: String(work.isbn ?? "").trim() || null,
    title: String(work.title ?? "").trim(),
    normalizedTitle: normalizeExactTitle(work.title),
    year: work.year,
    authors: work.authors,
    sourceTitle: work.sourceTitle ?? null,
  };
}

async function citingWorksForReference(
  reference: RelatedWorkMetadata,
  maximum: number,
): Promise<RelatedWorkMetadata[]> {
  const preference = getProviderPreference();
  const plan = getProviderPlan("citations", preference);
  const identifiers = identifiersForExternalWork(reference);

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

async function runBounded<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
}

/** Find papers that cite several of the same references as the seed. This is
 * bibliographic coupling: candidates need not cite the seed or be cited by it. */
async function bibliographicCouplingRecommendations(
  visibleNodes: CitationGraphNode[],
  libraryNodes: CitationGraphNode[],
  maximum: number,
): Promise<ExternalWork[]> {
  const indexes = localIndexes(libraryNodes);
  const candidates = new Map<string, RecommendationCandidate>();
  let sampledReferenceCount = 0;

  for (const node of visibleNodes.slice(0, 5)) {
    const references = (
      await getExternalReferences(node, libraryNodes, 20, 0, false, false)
    )
      .filter((work) =>
        Boolean(
          work.doi || work.providerWorkID || normalizeExactTitle(work.title),
        ),
      )
      .slice(0, 12);
    sampledReferenceCount += references.length;

    await runBounded(references, 2, async (reference) => {
      const citing = await citingWorksForReference(reference, 25);
      const seen = new Set<string>();
      for (const work of citing) {
        const identity = externalWorkCacheIdentity(work);
        if (!identity || seen.has(identity)) continue;
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
        ...toExternal(candidate.work, indexes.byDOI, indexes.byTitle),
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
  const indexes = localIndexes(libraryNodes);
  const candidates = new Map<string, RecommendationCandidate>();
  const seedLimit = Math.min(visibleNodes.length, 25);
  const perSeedLimit = Math.min(100, Math.max(25, maximum * 2));

  for (const node of visibleNodes.slice(0, seedLimit)) {
    let references = cachedReferenceWorks(node);
    if (!references.length && visibleNodes.length === 1) {
      references = await getExternalReferences(
        node,
        libraryNodes,
        perSeedLimit,
        0,
        true,
        false,
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
            false,
          )
        : getCachedExternalCitedBy(
            node,
            libraryNodes,
            Math.min(50, perSeedLimit),
            0,
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
      ...toExternal(candidate.work, indexes.byDOI, indexes.byTitle),
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
 * systems. A title alone is sufficient for seed resolution. Direct references
 * and citing papers are retained only as a bounded fallback for providers that
 * expose no recommendation endpoint or when recommendation services fail. */
export async function getMissingPaperRecommendations(
  visibleNodes: CitationGraphNode[],
  libraryNodes: CitationGraphNode[],
  maximum = 50,
  minimumConnections = 2,
): Promise<ExternalWork[]> {
  if (!visibleNodes.length || maximum <= 0) return [];
  const indexes = localIndexes(libraryNodes);
  const seeds = visibleNodes
    .slice(0, 25)
    .map(identifiersForNode)
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
    getProviderPreference(),
    Math.min(500, Math.max(maximum * 3, 100)),
  );
  const providerResults = recommended
    .map((work) => ({
      ...toExternal(work, indexes.byDOI, indexes.byTitle),
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
