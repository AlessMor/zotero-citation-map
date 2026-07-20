import type {
  CitationProviderID,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import {
  fetchSemanticScholarPapersBatch,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
} from "../providers/semanticScholarProvider";
import { getCitationProvider } from "../providers/registry";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import { getCitationMetricRecord } from "./citationMetricsStore";
import {
  cachedExternalWorkMetadata,
  saveExternalWorkCacheNotFound,
  saveExternalWorkCacheSuccess,
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
  citingNodeKeys?: string[];
  inLibraryItemKey?: string | null;
}

const RELATIONSHIP_MAX_AGE_MS = 30 * 86400000;
const RELATIONSHIP_FETCH_PAGE_SIZE = 200;
const RELATIONSHIP_MAX_PAGES = 20;

function cachedRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): ExternalWork[] {
  return getStoredRelationshipWorks(node, direction).map((work) => ({
    ...work,
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
    inLibraryItemKey: work.inLibraryItemKey ?? null,
  };
}

async function cacheRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: ExternalWork[],
): Promise<void> {
  const snapshot = works.map(compactRelationshipWork);
  const cacheEntries: Array<{
    identityKey: string;
    metadata: RelatedWorkMetadata;
  }> = [];
  for (const work of snapshot) {
    const key = identityKey(work);
    if (key) cacheEntries.push({ identityKey: key, metadata: work });
  }
  await saveExternalWorkCacheSuccesses(cacheEntries);
  await mergeStoredRelationships(node, direction, snapshot);
}

export async function storeExternalRelationshipSnapshot(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: RelatedWorkMetadata[],
): Promise<void> {
  // Relationship refreshes persist the provider payload immediately. Metadata
  // enrichment remains an explicit, lazy operation so large bibliographies do
  // not block Zotero's main thread.
  await cacheRelationshipResults(
    node,
    direction,
    works.map((work) => ({
      ...work,
      inLibraryItemKey: work.zoteroItemKey ?? null,
    })),
  );
}

interface ResolutionCandidate {
  identityKey: string;
  semanticScholarIdentifier: string | null;
  work: ExternalWork;
}

const SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE = Math.min(
  100,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
);
const CROSSREF_FALLBACK_WORKERS = 2;

interface CrossrefResolution {
  metadata: RelatedWorkMetadata | null;
  definitiveNotFound: boolean;
}

const activeResolutionByIdentity = new Map<
  string,
  Promise<CrossrefResolution>
>();

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

function semanticScholarIdentifier(work: RelatedWorkMetadata): string | null {
  if (work.provider === "semantic-scholar" && work.providerWorkID?.trim()) {
    return work.providerWorkID.trim();
  }
  const doi = normalizeDOI(work.doi);
  if (doi) return `DOI:${doi}`;
  if (work.pmid?.trim()) return `PMID:${work.pmid.trim()}`;
  if (work.arxiv?.trim()) return `ARXIV:${work.arxiv.trim()}`;
  if (work.isbn?.trim()) return `ISBN:${work.isbn.trim()}`;
  return null;
}

function mergeMetadata<T extends RelatedWorkMetadata>(
  work: T,
  metadata: RelatedWorkMetadata | null,
): T {
  if (!metadata) return work;
  return {
    ...work,
    providerWorkID: work.providerWorkID ?? metadata.providerWorkID,
    doi: work.doi ?? metadata.doi,
    pmid: work.pmid ?? metadata.pmid,
    arxiv: work.arxiv ?? metadata.arxiv,
    isbn: work.isbn ?? metadata.isbn,
    title:
      usableExternalTitle(work.title, work.doi) ??
      usableExternalTitle(metadata.title, metadata.doi) ??
      work.title ??
      metadata.title,
    year: work.year ?? metadata.year,
    authors: work.authors.length ? work.authors : metadata.authors,
    sourceTitle: work.sourceTitle ?? metadata.sourceTitle,
    abstract: work.abstract ?? metadata.abstract,
    citationCount: work.citationCount ?? metadata.citationCount,
    referenceCount: work.referenceCount ?? metadata.referenceCount,
    isOpenAccess: work.isOpenAccess ?? metadata.isOpenAccess,
    openAccessStatus: work.openAccessStatus ?? metadata.openAccessStatus,
    isRetracted: work.isRetracted ?? metadata.isRetracted,
  };
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

async function resolveWithCrossref(
  candidate: ResolutionCandidate,
): Promise<CrossrefResolution> {
  const doi = normalizeDOI(candidate.work.doi);
  if (!doi) return { metadata: null, definitiveNotFound: false };
  const existing = activeResolutionByIdentity.get(candidate.identityKey);
  if (existing) return existing;

  const resolution = (async (): Promise<CrossrefResolution> => {
    try {
      const result = await getCitationProvider("crossref").lookup({
        doi,
        pmid: candidate.work.pmid ?? null,
        arxiv: candidate.work.arxiv ?? null,
        isbn: candidate.work.isbn ?? null,
        title: candidate.work.title ?? "",
        normalizedTitle: normalizeExactTitle(candidate.work.title),
        year: candidate.work.year,
        authors: candidate.work.authors,
        sourceTitle: candidate.work.sourceTitle ?? null,
      });
      if (result.status !== "success" || !result.title?.trim()) {
        return {
          metadata: null,
          definitiveNotFound: result.status === "not-found",
        };
      }
      return {
        metadata: {
          provider: result.provider,
          providerWorkID: result.providerWorkID,
          doi: result.doi ?? doi,
          pmid: candidate.work.pmid ?? null,
          arxiv: candidate.work.arxiv ?? null,
          isbn: candidate.work.isbn ?? null,
          title: result.title,
          year: result.year,
          authors: result.authors,
          sourceTitle: result.sourceTitle,
          abstract: result.abstract,
          citationCount: result.citationCount,
          referenceCount: result.referenceCount,
          isOpenAccess: result.isOpenAccess ?? null,
          openAccessStatus: result.openAccessStatus ?? null,
          isRetracted: result.isRetracted ?? null,
        },
        definitiveNotFound: false,
      };
    } catch (error) {
      Zotero.debug(
        `Citation Map: Crossref external-work lookup failed for ${doi}: ${String(error)}`,
      );
      return { metadata: null, definitiveNotFound: false };
    }
  })().finally(() => activeResolutionByIdentity.delete(candidate.identityKey));

  activeResolutionByIdentity.set(candidate.identityKey, resolution);
  return resolution;
}

export async function hydrateExternalWorksMetadata(
  works: ExternalWork[],
): Promise<ExternalWork[]> {
  const hydrated = works.map((work) => {
    const key = identityKey(work);
    return key ? mergeMetadata(work, cachedExternalWorkMetadata(key)) : work;
  });

  const uniqueCandidates = new Map<string, ResolutionCandidate>();
  for (const work of hydrated) {
    if (!needsExternalMetadata(work)) continue;
    const key = identityKey(work);
    if (!key || !shouldResolveExternalWork(key)) continue;
    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(key, {
        identityKey: key,
        semanticScholarIdentifier: semanticScholarIdentifier(work),
        work,
      });
    }
  }

  const candidates = [...uniqueCandidates.values()];
  const resolved = new Map<string, RelatedWorkMetadata>();
  const semanticCandidates = candidates.filter(
    (candidate) => candidate.semanticScholarIdentifier,
  );

  for (
    let start = 0;
    start < semanticCandidates.length;
    start += SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE
  ) {
    const batch = semanticCandidates.slice(
      start,
      start + SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE,
    );
    try {
      const results = await fetchSemanticScholarPapersBatch(
        batch.map((candidate) => candidate.semanticScholarIdentifier!),
      );
      await Promise.all(
        batch.map(async (candidate, index) => {
          const metadata = results[index];
          if (!metadata) return;
          resolved.set(candidate.identityKey, metadata);
          await saveExternalWorkCacheSuccess(candidate.identityKey, metadata);
        }),
      );
    } catch (error) {
      Zotero.debug(
        `Citation Map: Semantic Scholar external-work batch failed: ${String(error)}`,
      );
    }
  }

  const fallbackCandidates = candidates.filter(
    (candidate) => !resolved.has(candidate.identityKey),
  );
  await runBounded(
    fallbackCandidates,
    CROSSREF_FALLBACK_WORKERS,
    async (candidate) => {
      const resolution = await resolveWithCrossref(candidate);
      if (resolution.metadata) {
        resolved.set(candidate.identityKey, resolution.metadata);
        await saveExternalWorkCacheSuccess(
          candidate.identityKey,
          resolution.metadata,
        );
      } else if (resolution.definitiveNotFound) {
        await saveExternalWorkCacheNotFound(candidate.identityKey);
      }
    },
  );

  return hydrated.map((work) => {
    const key = identityKey(work);
    return key ? mergeMetadata(work, resolved.get(key) ?? null) : work;
  });
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
  if (match?.status === "success") return match;

  // A stored provider identifier remains useful for relationship endpoints
  // even when a fresh metadata lookup is temporarily unavailable.
  if (providerID === node.provider && node.providerWorkID) return null;
  return null;
}

const RELATIONSHIP_PROVIDER_TIMEOUT_MS = 15000;
const RELATIONSHIP_FALLBACK_PROVIDER_LIMIT = 3;

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
      works = mergeRelatedWorkLists(works, match.references);
    }
    if (!fetcher) return works.slice(0, maximum);

    const providerWorkID =
      match?.providerWorkID ??
      (providerID === node.provider ? node.providerWorkID : null) ??
      (providerID === "opencitations" ? normalizeDOI(node.doi) : null);
    if (!providerWorkID) return works.slice(0, maximum);

    const fetched = await fetcher(providerWorkID, maximum, offset);
    return mergeRelatedWorkLists(works, fetched).slice(0, maximum);
  } catch (error) {
    Zotero.debug(
      `Citation Map: ${providerID} ${direction} lookup failed: ${String(error)}`,
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
  const orderedProviders: CitationProviderID[] = [
    node.provider ?? "crossref",
    direction === "references" ? "crossref" : "semantic-scholar",
    "semantic-scholar",
    "openalex",
    "opencitations",
    "inspire",
  ];
  const providerIDs = [...new Set(orderedProviders)].filter((providerID) => {
    const provider = getCitationProvider(providerID);
    if (direction === "references") {
      // Embedded reference lists are useful for the first page only. Later
      // pages must come from providers exposing a real paginated endpoint.
      return offset === 0 || Boolean(provider.fetchReferencedWorks);
    }
    return Boolean(provider.fetchCitingWorks);
  });
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
  const selectedProviders = expandCoverage
    ? providerIDs.slice(0, 1 + RELATIONSHIP_FALLBACK_PROVIDER_LIMIT)
    : providerIDs.slice(0, 1);
  if (!selectedProviders.length || target === 0) return [];

  // Explicit relationship refreshes query a small provider set concurrently.
  // Results are consumed as they arrive and the operation returns as soon as
  // the provider-reported target has been reached. Each provider has its own
  // deadline, so a slow fallback cannot leave the UI in an updating state.
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
  return mergeRelatedWorkLists(
    getStoredRelationshipWorks(node, "references"),
    persisted,
    node.references,
  );
}

function toExternalWorks(
  works: RelatedWorkMetadata[],
  libraryNodes: CitationGraphNode[],
): ExternalWork[] {
  const indexes = localIndexes(libraryNodes);
  return works.map((work) => toExternal(work, indexes.byDOI, indexes.byTitle));
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
      : getStoredRelationshipWorks(node, "cited-by");
  let offset = 0;
  let pages = 0;
  let previousPageSignature: string | null = null;

  // Explicit refreshes walk the provider endpoint from its first page. This
  // fills gaps left by earlier partial refreshes and also discovers new citing
  // works returned at the head of newest-first endpoints. Stored records are
  // merged and are never removed by a shorter provider response.
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

    // Pagination offsets refer to provider rows, not the deduplicated local
    // list. Advance by the number returned, but stop when a provider repeats
    // a page or exposes fewer rows than requested.
    offset += page.length;
    if (page.length < requested) break;
  }

  const stored = getStoredRelationshipWorks(node, direction);
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

    // Some providers only expose an embedded first page and do not support
    // pagination. If the next-page request returned nothing, refresh the head
    // page once so newly corrected provider records can still be merged.
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

    // Citing-paper endpoints commonly return newest records first. Re-read the
    // first page during an explicit refresh so citations added since the last
    // update are not skipped merely because a later-page cursor is used.
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

export async function getMissingPaperRecommendations(
  visibleNodes: CitationGraphNode[],
  libraryNodes: CitationGraphNode[],
  maximum = 50,
  minimumConnections = 2,
): Promise<ExternalWork[]> {
  const indexes = localIndexes(libraryNodes);
  const candidates = new Map<
    string,
    {
      work: RelatedWorkMetadata;
      score: number;
      citingNodeKeys: Set<string>;
    }
  >();

  for (const node of visibleNodes) {
    const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
    if (!record) continue;
    const seen = new Set<string>();
    for (const reference of record.references) {
      const doi = normalizeDOI(reference.doi);
      const title = normalizeExactTitle(reference.title);
      if (
        (doi && indexes.byDOI.has(doi)) ||
        (title && indexes.byTitle.has(title))
      ) {
        continue;
      }
      const identity =
        doi ??
        (reference.providerWorkID
          ? `${reference.provider}:${reference.providerWorkID}`
          : title);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      const current = candidates.get(identity) ?? {
        work: reference,
        score: 0,
        citingNodeKeys: new Set<string>(),
      };
      current.score += 1;
      current.citingNodeKeys.add(node.key);
      if (
        !current.work.abstract &&
        (reference.abstract || reference.citationCount != null)
      ) {
        current.work = reference;
      }
      candidates.set(identity, current);
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.score >= minimumConnections)
    .map((candidate) => ({
      ...toExternal(candidate.work, indexes.byDOI, indexes.byTitle),
      recommendationScore: candidate.score,
      citingNodeKeys: [...candidate.citingNodeKeys],
    }))
    .sort(
      (left, right) =>
        (right.recommendationScore ?? 0) - (left.recommendationScore ?? 0) ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1) ||
        (right.year ?? -1) - (left.year ?? -1) ||
        String(left.title).localeCompare(String(right.title)),
    )
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
