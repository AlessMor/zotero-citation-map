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
  providerResultAllowed,
  resolveRelatedWorksMetadata,
} from "../providers/registry";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
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
  mergeStoredRelationships,
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
const RELATIONSHIP_FETCH_PAGE_SIZE = 200;
const RELATIONSHIP_MAX_PAGES = 20;
const RELATIONSHIP_PROVIDER_TIMEOUT_MS = 15000;
const RELATIONSHIP_FALLBACK_PROVIDER_LIMIT = 3;

function cachedRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): ExternalWork[] {
  const preference = getProviderPreference();
  const entry = getStoredRelationshipEntry(node, direction);
  return (entry?.works ?? [])
    .filter((work) => providerResultAllowed(work.provider, preference))
    .map((work) => ({
      ...work,
      dataSources: work.dataSources?.length
        ? [...work.dataSources]
        : work.provider === "manual" || work.provider === "zotero"
          ? []
          : [work.provider],
      updatedAt: work.updatedAt ?? entry?.fetchedAt ?? null,
    }));
}

function relationshipCacheIsFresh(
  entry: ReturnType<typeof getStoredRelationshipEntry>,
): boolean {
  if (!entry) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  return (
    Number.isFinite(fetchedAt) &&
    Date.now() - fetchedAt < RELATIONSHIP_MAX_AGE_MS
  );
}

function identityKey(work: RelatedWorkMetadata): string | null {
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  if (work.providerWorkID) {
    return `${work.provider}:${work.providerWorkID.trim()}`;
  }
  const title = normalizeExactTitle(work.title);
  return title ? `title:${title}` : null;
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
  const key = identityKey(work);
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
  return {
    ...merged,
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
  const key = identityKey(work);
  const resolved = key
    ? mergeMetadata(work, cachedExternalWorkMetadata(key))
    : work;
  const doi = normalizeDOI(resolved.doi);
  const title = normalizeExactTitle(resolved.title);
  return {
    ...resolved,
    inLibraryItemKey:
      (doi ? localByDOI.get(doi) : null) ??
      (title ? localByTitle.get(title) : null) ??
      resolved.zoteroItemKey ??
      null,
  };
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
    authors: work.authors.slice(0, 5),
    sourceTitle: work.sourceTitle ?? null,
    citationCount: work.citationCount ?? null,
    referenceCount: work.referenceCount ?? null,
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

async function cacheRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: ExternalWork[],
): Promise<void> {
  const refreshedAt = new Date().toISOString();
  const sourceSets = new Map<string, Set<CitationProviderID>>();
  for (const work of [
    ...getStoredRelationshipWorks(node, direction),
    ...works,
  ]) {
    const key = identityKey(work);
    if (!key) continue;
    const sources = sourceSets.get(key) ?? new Set<CitationProviderID>();
    for (const source of work.dataSources ?? []) sources.add(source);
    if (work.provider !== "manual" && work.provider !== "zotero") {
      sources.add(work.provider);
    }
    sourceSets.set(key, sources);
  }
  const snapshot = works.map((work) => {
    const key = identityKey(work);
    const sources = key ? [...(sourceSets.get(key) ?? [])] : [];
    return compactRelationshipWork({
      ...work,
      dataSources: sources,
      updatedAt: work.updatedAt ?? refreshedAt,
    });
  });
  const cacheEntries: Array<{
    identityKey: string;
    metadata: RelatedWorkMetadata;
  }> = [];
  for (const work of snapshot) {
    const key = identityKey(work);
    // A relationship payload may contain only a provider work ID. Do not mark
    // such dehydrated records as successfully resolved metadata, otherwise the
    // metadata cache suppresses the later title lookup for months.
    if (key && usableExternalTitle(work.title, work.doi)) {
      cacheEntries.push({ identityKey: key, metadata: work });
    }
  }
  await saveExternalWorkCacheSuccesses(cacheEntries);
  await mergeStoredRelationships(node, direction, snapshot);

  // The graph is built from the reference list stored with each citation
  // metric record. Keep that canonical list synchronized with relationship
  // pages, otherwise a successful reference refresh can appear in the side
  // panel without creating the corresponding graph edges.
  if (direction === "references") {
    const libraryID = nodeLibraryID(node);
    const record = getCitationMetricRecord(libraryID, node.itemKey);
    if (record) {
      const references = mergeRelatedWorkLists(record.references, snapshot);
      if (references.length !== record.references.length) {
        await saveCitationMetricRecord({
          ...record,
          referenceCount: record.referenceCount ?? references.length,
          resolvedReferenceCount: Math.max(
            record.resolvedReferenceCount,
            references.length,
          ),
          references,
        });
      }
    }
  }
}

export async function storeExternalRelationshipSnapshot(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
): Promise<void> {
  await cacheRelationshipResults(
    node,
    direction,
    works.map((work) => ({
      ...work,
      inLibraryItemKey: work.zoteroItemKey ?? null,
    })),
  );
}

function needsExternalMetadata(work: RelatedWorkMetadata): boolean {
  return (
    !externalWorkDisplayTitle(work) ||
    work.year === null ||
    work.authors.length === 0 ||
    !work.sourceTitle?.trim() ||
    work.citationCount === null ||
    work.citationCount === undefined ||
    work.referenceCount === null ||
    work.referenceCount === undefined
  );
}

export async function hydrateExternalWorksMetadata(
  works: ExternalWork[],
): Promise<ExternalWork[]> {
  const hydrated = works.map((work) => {
    const key = identityKey(work);
    return key ? mergeMetadata(work, cachedExternalWorkMetadata(key)) : work;
  });

  const candidateIndexes: number[] = [];
  const candidates: RelatedWorkMetadata[] = [];
  for (const [index, work] of hydrated.entries()) {
    if (!needsExternalMetadata(work)) continue;
    const key = identityKey(work);
    if (!key) continue;
    const titleMissing = !usableExternalTitle(work.title, work.doi);
    // Missing titles bypass stale success records written by earlier versions.
    if (!titleMissing && !shouldResolveExternalWork(key)) continue;
    candidateIndexes.push(index);
    candidates.push(work);
  }

  const resolved = await resolveRelatedWorksMetadata(
    candidates,
    getProviderPreference(),
  );
  const cacheEntries: Array<{
    identityKey: string;
    metadata: RelatedWorkMetadata;
  }> = [];
  for (const [candidateIndex, metadata] of resolved.entries()) {
    const workIndex = candidateIndexes[candidateIndex];
    hydrated[workIndex] = mergeMetadata(hydrated[workIndex], metadata);
    const key = identityKey(hydrated[workIndex]);
    if (
      key &&
      usableExternalTitle(hydrated[workIndex].title, hydrated[workIndex].doi)
    ) {
      cacheEntries.push({ identityKey: key, metadata: hydrated[workIndex] });
    }
  }
  await saveExternalWorkCacheSuccesses(cacheEntries);
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
  return match?.status === "success" ? match : null;
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

async function relationshipProviderResult(
  providerID: CitationProviderID,
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  maximum: number,
  offset: number,
  identifiers: WorkIdentifiers,
): Promise<RelatedWorkMetadata[]> {
  try {
    const provider = getCitationProvider(providerID);
    const fetcher =
      direction === "references"
        ? provider.fetchReferencedWorks
        : provider.fetchCitingWorks;
    if (direction === "cited-by" && !fetcher) return [];

    const match = await lookupProviderRecord(providerID, node, identifiers);
    let works: RelatedWorkMetadata[] = [];
    if (
      direction === "references" &&
      offset === 0 &&
      match?.references?.length
    ) {
      works = mergeRelatedWorkLists(
        works,
        stampProviderWorks(match.references, providerID),
      );
    }
    if (!fetcher) return works.slice(0, maximum);

    const providerWorkID =
      match?.providerWorkID ??
      (providerID === node.provider ? node.providerWorkID : null) ??
      (providerID === "opencitations" ? normalizeDOI(node.doi) : null);
    if (!providerWorkID) return works.slice(0, maximum);

    const fetched = stampProviderWorks(
      await fetcher(providerWorkID, maximum, offset),
      providerID,
    );
    return mergeRelatedWorkLists(works, fetched).slice(0, maximum);
  } catch (error) {
    Zotero.debug(
      `Citation Map: ${providerID} ${direction} lookup failed: ` +
        String(error),
    );
    return [];
  }
}

async function relationshipProviderResultWithTimeout(
  providerID: CitationProviderID,
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  maximum: number,
  offset: number,
  identifiers: WorkIdentifiers,
): Promise<RelatedWorkMetadata[]> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      relationshipProviderResult(
        providerID,
        node,
        direction,
        maximum,
        offset,
        identifiers,
      ),
      new Promise<RelatedWorkMetadata[]>((resolve) => {
        timer = setTimeout(() => {
          Zotero.debug(
            `Citation Map: ${providerID} ${direction} lookup timed out`,
          );
          resolve([]);
        }, RELATIONSHIP_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function fetchFromProviders(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  maximum: number,
  offset: number,
  expandCoverage: boolean,
): Promise<RelatedWorkMetadata[]> {
  const preference = getProviderPreference();
  const plan = getProviderPlan(
    direction === "references" ? "references" : "citations",
    preference,
    { offset },
  );
  const providerIDs = plan.providers;
  const identifiers = identifiersForNode(node);
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  const reported =
    direction === "references"
      ? (record?.referenceCount ?? node.referenceCount)
      : (record?.citationCount ?? node.citationCount);
  const target =
    reported === null
      ? maximum
      : Math.min(maximum, Math.max(0, reported - offset));
  const selectedProviders =
    plan.mode === "single"
      ? providerIDs
      : expandCoverage
        ? providerIDs.slice(0, 1 + RELATIONSHIP_FALLBACK_PROVIDER_LIMIT)
        : providerIDs.slice(0, 1);
  if (!selectedProviders.length || target === 0) return [];

  const pending = selectedProviders.map((providerID, index) => ({
    index,
    promise: relationshipProviderResultWithTimeout(
      providerID,
      node,
      direction,
      maximum,
      offset,
      identifiers,
    ).then((result) => ({ index, result })),
  }));
  let works: RelatedWorkMetadata[] = [];
  while (pending.length) {
    const settled = await Promise.race(pending.map((entry) => entry.promise));
    const pendingIndex = pending.findIndex(
      (entry) => entry.index === settled.index,
    );
    if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
    works = mergeRelatedWorkLists(works, settled.result);
    if (works.length >= target) break;
  }
  return works.slice(0, maximum);
}

function cachedReferenceWorks(node: CitationGraphNode): RelatedWorkMetadata[] {
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  const persisted = (record?.references ?? []).map((work) => {
    const key = identityKey(work);
    return key ? mergeMetadata(work, cachedExternalWorkMetadata(key)) : work;
  });
  const preference = getProviderPreference();
  return mergeRelatedWorkLists(
    getStoredRelationshipWorks(node, "references"),
    persisted,
    node.references,
  ).filter((work) => providerResultAllowed(work.provider, preference));
}

export function getCachedExternalReferences(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum: number,
  offset: number,
): ExternalWork[] {
  return toExternalWorks(
    cachedReferenceWorks(node).slice(offset, offset + maximum),
    libraryNodes,
  );
}

export function getCachedExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum: number,
  offset: number,
): ExternalWork[] {
  return toExternalWorks(
    cachedRelationshipResults(node, "cited-by").slice(offset, offset + maximum),
    libraryNodes,
  );
}

export async function refreshExternalRelationships(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  direction: "references" | "cited-by",
  maximum = 2500,
): Promise<ExternalWork[]> {
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  const reported =
    direction === "references"
      ? (record?.referenceCount ?? node.referenceCount)
      : (record?.citationCount ?? node.citationCount);
  const target = Math.min(maximum, Math.max(0, reported ?? maximum));
  let merged =
    direction === "references"
      ? cachedReferenceWorks(node)
      : cachedRelationshipResults(node, "cited-by");
  let offset = 0;
  let pages = 0;
  let previousPageSignature: string | null = null;

  while (offset < target && pages < RELATIONSHIP_MAX_PAGES) {
    const requested = Math.min(
      RELATIONSHIP_FETCH_PAGE_SIZE,
      Math.max(1, target - offset),
    );
    const page = await fetchFromProviders(
      node,
      direction,
      requested,
      offset,
      true,
    );
    pages += 1;
    if (!page.length) break;

    const pageSignature = page
      .map((work) => identityKey(work) ?? JSON.stringify(work))
      .join("|");
    if (pageSignature === previousPageSignature) break;
    previousPageSignature = pageSignature;
    merged = mergeRelatedWorkLists(merged, page);
    await cacheRelationshipResults(
      node,
      direction,
      toExternalWorks(page, libraryNodes),
    );
    offset += page.length;
    if (page.length < requested) break;
  }

  const preference = getProviderPreference();
  const stored = getStoredRelationshipWorks(node, direction).filter((work) =>
    providerResultAllowed(work.provider, preference),
  );
  const all = mergeRelatedWorkLists(merged, stored).slice(0, maximum);
  return toExternalWorks(all, libraryNodes);
}

export async function getExternalReferences(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
  forceRefresh = false,
  expandCoverage = forceRefresh,
): Promise<ExternalWork[]> {
  const relationshipEntry = getStoredRelationshipEntry(node, "references");
  const cached = cachedReferenceWorks(node);
  const refreshOffset =
    forceRefresh && offset === 0 ? cached.length : Math.max(0, offset);
  const expectedCount =
    node.referenceCount === null
      ? cached.length
      : Math.min(maximum, Math.max(0, node.referenceCount - refreshOffset));
  let fetched: RelatedWorkMetadata[] = [];
  if (
    (forceRefresh || !relationshipCacheIsFresh(relationshipEntry)) &&
    (forceRefresh || cached.length < offset + expectedCount)
  ) {
    fetched = await fetchFromProviders(
      node,
      "references",
      maximum,
      refreshOffset,
      expandCoverage,
    );
    if (forceRefresh && refreshOffset > 0 && fetched.length === 0) {
      fetched = await fetchFromProviders(
        node,
        "references",
        maximum,
        0,
        expandCoverage,
      );
    }
  }
  if (fetched.length > 0 || !relationshipEntry) {
    await cacheRelationshipResults(
      node,
      "references",
      toExternalWorks(fetched, libraryNodes),
    );
  }
  const merged = mergeRelatedWorkLists(
    cached,
    getStoredRelationshipWorks(node, "references"),
    fetched,
  );
  return toExternalWorks(merged.slice(offset, offset + maximum), libraryNodes);
}

export async function getExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
  forceRefresh = false,
  expandCoverage = forceRefresh,
): Promise<ExternalWork[]> {
  const relationshipEntry = getStoredRelationshipEntry(node, "cited-by");
  const cached = getStoredRelationshipWorks(node, "cited-by");
  const refreshOffset =
    forceRefresh && offset === 0 ? cached.length : Math.max(0, offset);
  let fetched: RelatedWorkMetadata[] = [];
  if (forceRefresh || !relationshipCacheIsFresh(relationshipEntry)) {
    const nextPage = await fetchFromProviders(
      node,
      "cited-by",
      maximum,
      refreshOffset,
      expandCoverage,
    );
    const headPage =
      forceRefresh && refreshOffset > 0
        ? await fetchFromProviders(node, "cited-by", maximum, 0, false)
        : [];
    fetched = mergeRelatedWorkLists(headPage, nextPage);
  }
  if (fetched.length > 0 || !relationshipEntry) {
    await cacheRelationshipResults(
      node,
      "cited-by",
      toExternalWorks(fetched, libraryNodes),
    );
  }
  const merged = mergeRelatedWorkLists(
    cached,
    getStoredRelationshipWorks(node, "cited-by"),
    fetched,
  );
  return toExternalWorks(merged.slice(offset, offset + maximum), libraryNodes);
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
  const identity = identityKey(work);
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
        const identity = identityKey(work);
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
