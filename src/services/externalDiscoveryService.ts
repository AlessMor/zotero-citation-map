import type {
  CitationProviderID,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
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
import {
  maximumKnownCount,
  richestCountAttribution,
} from "./citationCountPolicy";
import {
  getCitationMetricRecord,
  saveCitationMetricRecord,
} from "./citationMetricsStore";
import { getProviderPreference } from "./citationPreferences";
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
} from "./relationshipStoreService";

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
const RELATIONSHIP_FETCH_PAGE_SIZE = 100;
const RELATIONSHIP_MAX_PAGES = 30;
const RELATIONSHIP_PROVIDER_TIMEOUT_MS = 15000;
const RELATIONSHIP_METADATA_BATCH_LIMIT = 200;
// Foreground refreshes use only provider batch endpoints. Individual DOI
// lookups are completed by the paced background queue below.
const RELATIONSHIP_METADATA_FOREGROUND_INDIVIDUAL_LIMIT = 0;
const RELATIONSHIP_METADATA_BACKGROUND_BATCH_SIZE = 24;
const RELATIONSHIP_METADATA_BACKGROUND_DELAY_MS = 350;

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

function cachedRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): ExternalWork[] {
  const entry = getStoredRelationshipEntry(node, direction);
  return (entry?.works ?? []).map((work) => ({
    ...work,
    dataSources: work.dataSources?.length
      ? [...work.dataSources]
      : work.provider === "manual" || work.provider === "zotero"
        ? []
        : [work.provider],
    updatedAt: work.updatedAt ?? entry?.fetchedAt ?? null,
  }));
}

function selectedRelationshipCacheIsFresh(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): boolean {
  const plan = getProviderPlan(
    direction === "references" ? "references" : "citations",
    getProviderPreference(),
  );
  if (!plan.providers.length) return false;
  return plan.providers.every((provider) => {
    const entry = getStoredProviderRelationshipEntry(node, direction, provider);
    if (!entry) return false;
    const fetchedAt = Date.parse(entry.fetchedAt);
    return (
      Number.isFinite(fetchedAt) &&
      Date.now() - fetchedAt < RELATIONSHIP_MAX_AGE_MS
    );
  });
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
  const value = String(title ?? "").trim();
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
  return {
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
  };
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
  const resolved = key
    ? mergeMetadata(work, cachedExternalWorkMetadata(key))
    : work;
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
  return {
    provider: work.provider,
    providerWorkID: work.providerWorkID,
    doi: work.doi,
    pmid: work.pmid ?? null,
    arxiv: work.arxiv ?? null,
    isbn: work.isbn ?? null,
    title: externalWorkDisplayTitle(work) ?? work.title,
    year: work.year,
    authors: work.authors.slice(0, 20),
    authorIDs: [...(work.authorIDs ?? [])],
    sourceTitle: work.sourceTitle ?? null,
    citationCount: work.citationCount ?? null,
    referenceCount: work.referenceCount ?? null,
    citationCountsByYear: [...(work.citationCountsByYear ?? [])],
    references: work.references?.map((reference) => ({
      ...reference,
      authors: [...reference.authors],
      authorIDs: [...(reference.authorIDs ?? [])],
    })),
    resolvedReferenceCount: work.resolvedReferenceCount ?? null,
    fwci: work.fwci ?? null,
    citationPercentile: work.citationPercentile ?? null,
    isTop1Percent: work.isTop1Percent ?? null,
    isTop10Percent: work.isTop10Percent ?? null,
    citationsLastYear: work.citationsLastYear ?? null,
    citationVelocity: work.citationVelocity ?? null,
    citationAcceleration: work.citationAcceleration ?? null,
    influentialCitationCount: work.influentialCitationCount ?? null,
    publicationType: work.publicationType ?? null,
    sourceMetrics: work.sourceMetrics ?? null,
    referenceAgeMean: work.referenceAgeMean ?? null,
    referenceAgeSpread: work.referenceAgeSpread ?? null,
    selfCitationEstimate: work.selfCitationEstimate ?? null,
    futureReferenceCount: work.futureReferenceCount ?? null,
    metadataCompleteness: work.metadataCompleteness ?? null,
    isOpenAccess: work.isOpenAccess ?? null,
    openAccessStatus: work.openAccessStatus ?? null,
    isRetracted: work.isRetracted ?? null,
    zoteroItemKey: work.zoteroItemKey ?? null,
    dataSources: work.dataSources?.length
      ? [...work.dataSources]
      : work.provider === "manual" || work.provider === "zotero"
        ? []
        : [work.provider],
    updatedAt: work.updatedAt ?? null,
    inLibraryItemKey: work.inLibraryItemKey ?? null,
  };
}

async function cacheProviderRelationshipSnapshot(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  provider: CitationProviderID,
  works: RelatedWorkMetadata[],
): Promise<RelatedWorkMetadata[]> {
  const refreshedAt = new Date().toISOString();
  const snapshot = mergeRelatedWorkLists(works).map((work) =>
    compactRelationshipWork({
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
  for (const work of snapshot) {
    const key = externalWorkCacheIdentity(work);
    if (key && usableExternalTitle(work.title, work.doi)) {
      cacheEntries.push({ identityKey: key, metadata: work });
    }
  }
  await saveExternalWorkCacheSuccesses(cacheEntries);
  return replaceStoredProviderRelationships(
    node,
    direction,
    provider,
    snapshot,
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

async function synchronizeStoredRelationshipRecord(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
): Promise<void> {
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  if (!record) return;
  const preference = getProviderPreference();
  const countProvider = preference === "auto" ? null : preference;
  if (direction === "references") {
    const references = mergeRelatedWorkLists(record.references, works);
    const referenceCount = richestCountAttribution([
      {
        count: record.referenceCount,
        provider: record.referenceCountProvider,
      },
      { count: works.length, provider: countProvider },
    ]);
    await saveCitationMetricRecord({
      ...record,
      referenceCount: referenceCount.count,
      referenceCountProvider: referenceCount.provider,
      resolvedReferenceCount:
        maximumKnownCount([record.resolvedReferenceCount, references.length]) ??
        0,
      references,
    });
  } else {
    const citationCount = richestCountAttribution([
      {
        count: record.citationCount,
        provider: record.citationCountProvider,
      },
      { count: works.length, provider: countProvider },
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
): Promise<void> {
  const key = relationshipRecordSynchronizationKey(node);
  const previous =
    relationshipRecordSynchronizations.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => synchronizeStoredRelationshipRecord(node, direction, works));
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
  const snapshot = mergeRelatedWorkLists(works);
  if (!snapshot.length && options.reportedCount !== 0) return;
  await mergeProviderRelationshipSnapshot(node, direction, provider, snapshot);
  const selected = getStoredRelationshipWorks(node, direction);
  await synchronizeRelationshipRecord(node, direction, selected);
  queueRelationshipMetadataHydration(node, direction, snapshot, true, [
    provider,
  ]);
}

function needsRelationshipBibliographicMetadata(
  work: RelatedWorkMetadata,
): boolean {
  return (
    !externalWorkDisplayTitle(work) ||
    work.year === null ||
    work.authors.length === 0 ||
    !work.sourceTitle?.trim()
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

function relationshipMetadataSignature(work: RelatedWorkMetadata): string {
  return JSON.stringify([
    normalizeDOI(work.doi),
    work.title ?? null,
    work.year ?? null,
    work.authors,
    work.authorIDs ?? [],
    work.sourceTitle ?? null,
    work.abstract ?? null,
    work.citationCount ?? null,
    work.referenceCount ?? null,
    work.fwci ?? null,
    work.citationPercentile ?? null,
    work.citationsLastYear ?? null,
    work.citationVelocity ?? null,
    work.citationAcceleration ?? null,
    work.influentialCitationCount ?? null,
    work.publicationType ?? null,
    work.isOpenAccess ?? null,
    work.openAccessStatus ?? null,
    work.isRetracted ?? null,
    work.dataSources ?? [],
  ]);
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

  for (const target of uniqueTargets.values()) {
    let changed = false;
    for (const provider of target.providers) {
      const entry = getStoredProviderRelationshipEntry(
        target.node,
        target.direction,
        provider,
      );
      if (!entry) continue;
      const updated = entry.works.map((work) => {
        const metadata = metadataForRelationshipWork(work, metadataIndex);
        const merged = metadata ? mergeMetadata(work, metadata) : work;
        return compactRelationshipWork({
          ...merged,
          inLibraryItemKey:
            merged.inLibraryItemKey ?? merged.zoteroItemKey ?? null,
        });
      });
      const before = entry.works.map(relationshipMetadataSignature).join("\n");
      const after = updated.map(relationshipMetadataSignature).join("\n");
      if (before === after) continue;
      await replaceStoredProviderRelationships(
        target.node,
        target.direction,
        provider,
        updated,
      );
      changed = true;
    }
    if (changed) {
      const selected = getStoredRelationshipWorks(
        target.node,
        target.direction,
      );
      await synchronizeRelationshipRecord(
        target.node,
        target.direction,
        selected,
      );
    }
  }
}

async function runRelationshipMetadataHydrationQueue(): Promise<void> {
  if (relationshipMetadataHydrationRunning) return;
  relationshipMetadataHydrationRunning = true;
  try {
    while (relationshipMetadataHydrationQueue.size > 0) {
      const batchEntries = [
        ...relationshipMetadataHydrationQueue.entries(),
      ].slice(0, RELATIONSHIP_METADATA_BACKGROUND_BATCH_SIZE);
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

      // Batch-capable providers run first, then Crossref/other DOI providers are
      // allowed to resolve every remaining work in this small background chunk.
      // This operation is deliberately detached from the user-visible refresh.
      const hydrated = await hydrateExternalWorksMetadata(
        input,
        false,
        Number.POSITIVE_INFINITY,
        true,
      );
      const resolved = hydrated.filter(
        (work) => !needsRelationshipBibliographicMetadata(work),
      );
      if (resolved.length) {
        await persistHydratedRelationshipMetadata(
          targets,
          relationshipMetadataIndex(resolved),
        );
      }

      if (relationshipMetadataHydrationQueue.size > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RELATIONSHIP_METADATA_BACKGROUND_DELAY_MS),
        );
      }
    }
  } finally {
    relationshipMetadataHydrationRunning = false;
    scheduleRelationshipMetadataHydrationRun();
  }
}

export async function hydrateExternalWorksMetadata(
  works: ExternalWork[],
  includeSecondaryMetrics = false,
  individualLookupLimit = Number.POSITIVE_INFINITY,
  bibliographicOnly = false,
): Promise<ExternalWork[]> {
  const hydrated = works.map((work) => {
    const key = externalWorkCacheIdentity(work);
    return key ? mergeMetadata(work, cachedExternalWorkMetadata(key)) : work;
  });

  const candidateIndexes: number[] = [];
  const candidates: RelatedWorkMetadata[] = [];
  for (const [index, work] of hydrated.entries()) {
    if (
      bibliographicOnly
        ? !needsRelationshipBibliographicMetadata(work)
        : !needsExternalMetadata(work)
    ) {
      continue;
    }
    const key = externalWorkCacheIdentity(work);
    if (!key) continue;
    const basicMetadataMissing =
      !usableExternalTitle(work.title, work.doi) ||
      work.year === null ||
      work.authors.length === 0 ||
      !work.sourceTitle?.trim();
    // Incomplete bibliographic records bypass stale success entries written by
    // earlier versions. A DOI-only OpenCitations record must still be offered
    // to metadata providers even when its old cache entry is considered fresh.
    if (!basicMetadataMissing && !shouldResolveExternalWork(key)) continue;
    candidateIndexes.push(index);
    candidates.push(work);
  }

  const resolved = await resolveRelatedWorksMetadata(
    candidates,
    getProviderPreference(),
    includeSecondaryMetrics,
    { individualLookupLimit },
  );
  const cacheEntries: Array<{
    identityKey: string;
    metadata: RelatedWorkMetadata;
  }> = [];
  for (const [candidateIndex, metadata] of resolved.entries()) {
    const workIndex = candidateIndexes[candidateIndex];
    hydrated[workIndex] = mergeMetadata(hydrated[workIndex], metadata);
    const key = externalWorkCacheIdentity(hydrated[workIndex]);
    if (
      key &&
      usableExternalTitle(hydrated[workIndex].title, hydrated[workIndex].doi)
    ) {
      cacheEntries.push({ identityKey: key, metadata: hydrated[workIndex] });
    }
  }
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
  node: CitationGraphNode,
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
  return works.map((work) => ({
    ...work,
    dataSources: [...new Set([...(work.dataSources ?? []), providerID])],
    updatedAt: work.updatedAt ?? updatedAt,
  }));
}

interface ProviderRelationshipSnapshot {
  provider: CitationProviderID;
  works: RelatedWorkMetadata[];
  reportedCount: number | null;
  complete: boolean;
  succeeded: boolean;
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
): Promise<ProviderRelationshipSnapshot> {
  const failed = (): ProviderRelationshipSnapshot => ({
    provider: providerID,
    works: [],
    reportedCount: null,
    complete: false,
    succeeded: false,
  });
  try {
    const identifiers = identifiersForNode(node);
    const provider = getCitationProvider(providerID);
    const fetcher =
      direction === "references"
        ? provider.fetchReferencedWorks
        : provider.fetchCitingWorks;
    const match = await withProviderTimeout(
      providerID,
      direction,
      lookupProviderRecord(providerID, node, identifiers),
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
      match?.providerWorkID ??
      (providerID === node.provider ? node.providerWorkID : null) ??
      (providerID === "opencitations" ? normalizeDOI(node.doi) : null);
    if (!providerWorkID) return failed();

    const target = Math.min(maximum, Math.max(0, reportedCount ?? maximum));
    let offset = 0;
    let pages = 0;
    let endpointExhausted = false;
    let previousSignature: string | null = null;
    while (offset < target && pages < RELATIONSHIP_MAX_PAGES) {
      const requested = Math.min(
        RELATIONSHIP_FETCH_PAGE_SIZE,
        Math.max(1, target - offset),
      );
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
      reportedCount !== null
        ? reachedReportedCount || endpointExhausted
        : endpointExhausted;
    return {
      provider: providerID,
      works,
      reportedCount,
      complete:
        complete && (reportedCount === null || reportedCount <= maximum),
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
  const stored = getStoredRelationshipEntry(node, "references");
  if (stored) return stored.works;
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  return mergeRelatedWorkLists(record?.references ?? [], node.references);
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

export async function refreshExternalRelationships(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  direction: "references" | "cited-by",
  maximum = 2500,
): Promise<ExternalWork[]> {
  const plan = getProviderPlan(
    direction === "references" ? "references" : "citations",
    getProviderPreference(),
  );
  const results = await Promise.all(
    plan.providers.map((provider) =>
      fetchProviderRelationshipSnapshot(provider, node, direction, maximum),
    ),
  );
  const persistedResults = results.filter(
    (result) =>
      result.succeeded && (result.complete || result.works.length > 0),
  );
  let persisted = false;
  if (persistedResults.length) {
    // Relationship providers such as OpenCitations often return only DOI and
    // creation year. Resolve the deduplicated union once, then project the
    // richer metadata back into every authoritative provider snapshot. This
    // avoids one metadata lookup per provider for the same DOI and preserves
    // the provider that established the relationship separately from the
    // providers that supplied title, authors, venue, and metrics.
    const canonical = mergeRelatedWorkLists(
      ...persistedResults.map((result) => result.works),
    );
    // Relationship discovery is the foreground operation. Resolve only basic
    // bibliographic fields through batch endpoints here; individual DOI
    // lookups are deferred to the paced queue so refresh latency stays bounded.
    const hydrationInput = canonical.slice(
      0,
      RELATIONSHIP_METADATA_BATCH_LIMIT,
    );
    const hydratedCanonical = hydrationInput.length
      ? await hydrateExternalWorksMetadata(
          toExternalWorks(hydrationInput, libraryNodes),
          false,
          RELATIONSHIP_METADATA_FOREGROUND_INDIVIDUAL_LIMIT,
          true,
        )
      : [];
    const metadataIndex = relationshipMetadataIndex(hydratedCanonical);

    for (const result of persistedResults) {
      const providerWorks = toExternalWorks(result.works, libraryNodes).map(
        (work) => {
          const metadata = metadataForRelationshipWork(work, metadataIndex);
          return metadata ? mergeMetadata(work, metadata) : work;
        },
      );
      if (result.complete) {
        await cacheProviderRelationshipSnapshot(
          node,
          direction,
          result.provider,
          providerWorks,
        );
      } else {
        await mergeProviderRelationshipSnapshot(
          node,
          direction,
          result.provider,
          providerWorks,
        );
      }
      persisted = true;
    }

    // Do not make the refresh wait for hundreds of DOI lookups. Any records
    // still missing title, authors, year, or venue are resolved in paced
    // background chunks and written back to both the global metadata cache and
    // the provider-specific relationship snapshots.
    if (canonical.length) {
      queueRelationshipMetadataHydration(
        node,
        direction,
        canonical,
        true,
        persistedResults.map((result) => result.provider),
      );
    }
  }

  const selected = getStoredRelationshipWorks(node, direction);
  if (
    persisted ||
    selected.length > 0 ||
    results.some((result) => result.complete)
  ) {
    await synchronizeRelationshipRecord(node, direction, selected);
  }
  return toExternalWorks(selected.slice(0, maximum), libraryNodes);
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
    await refreshExternalRelationships(node, libraryNodes, "references");
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
    await refreshExternalRelationships(node, libraryNodes, "cited-by");
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
  if (work.inLibraryItemKey) {
    const existing = Zotero.Items.getByLibraryAndKey?.(
      libraryID,
      work.inLibraryItemKey,
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

  const identifier = work.doi
    ? { DOI: work.doi }
    : work.pmid
      ? { PMID: work.pmid }
      : work.arxiv
        ? { arXiv: work.arxiv }
        : work.isbn
          ? { ISBN: work.isbn }
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
    return items;
  }

  const item = new Zotero.Item("journalArticle");
  item.libraryID = libraryID;
  item.setField(
    "title",
    work.title?.trim() ||
      work.doi?.trim() ||
      work.providerWorkID?.trim() ||
      "Untitled work",
  );
  if (work.year) item.setField("date", String(work.year));
  if (work.sourceTitle) item.setField("publicationTitle", work.sourceTitle);
  if (work.abstract) item.setField("abstractNote", work.abstract);
  if (work.doi) item.setField("DOI", work.doi);
  if (work.isbn) item.setField("ISBN", work.isbn);
  for (const [index, creator] of work.authors.entries()) {
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
