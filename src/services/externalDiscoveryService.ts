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
  getExternalRelationshipCacheEntry,
  saveExternalRelationshipCache,
  saveExternalWorkCacheNotFound,
  saveExternalWorkCacheSuccess,
  shouldResolveExternalWork,
  type ExternalRelationshipCacheEntry,
} from "./externalWorkCacheService";

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

function relationshipCacheKey(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): string {
  const doi = normalizeDOI(node.doi);
  if (doi) return `${direction}:doi:${doi}`;
  if (node.provider && node.providerWorkID) {
    return `${direction}:provider:${node.provider}:${node.providerWorkID.toLocaleLowerCase()}`;
  }
  const title = normalizeExactTitle(node.title);
  if (title)
    return `${direction}:title:${title}:year:${node.year ?? "unknown"}`;
  return `${direction}:library:${nodeLibraryID(node)}:item:${node.itemKey}`;
}

function legacyRelationshipCacheKey(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): string {
  return `${direction}:library:${nodeLibraryID(node)}:item:${node.itemKey}`;
}

function cachedRelationshipEntry(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): ExternalRelationshipCacheEntry | null {
  const key = relationshipCacheKey(node, direction);
  return (
    getExternalRelationshipCacheEntry(key) ??
    getExternalRelationshipCacheEntry(
      legacyRelationshipCacheKey(node, direction),
    )
  );
}

function cachedRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
): ExternalWork[] {
  return (
    cachedRelationshipEntry(node, direction)?.works.map((work) => ({
      ...work,
    })) ?? []
  );
}

function relationshipCacheIsFresh(
  entry: ExternalRelationshipCacheEntry | null,
): boolean {
  if (!entry) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  return (
    Number.isFinite(fetchedAt) &&
    Date.now() - fetchedAt < RELATIONSHIP_MAX_AGE_MS
  );
}

async function cacheRelationshipResults(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  works: ExternalWork[],
): Promise<void> {
  if (!works.length) return;
  const relationshipKey = relationshipCacheKey(node, direction);
  const snapshot = works.map((work) => ({ ...work }));
  await saveExternalRelationshipCache(relationshipKey, snapshot);
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
  const doi = normalizeDOI(work.doi);
  const title = normalizeExactTitle(work.title);
  return {
    ...work,
    inLibraryItemKey:
      (doi ? localByDOI.get(doi) : null) ??
      (title ? localByTitle.get(title) : null) ??
      work.zoteroItemKey ??
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

function needsExternalMetadata(work: RelatedWorkMetadata): boolean {
  return (
    !work.title?.trim() ||
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
    title: work.title?.trim() ? work.title : metadata.title,
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
  let match = provider.supports(identifiers)
    ? await provider.lookup(identifiers)
    : null;
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

async function fetchFromProviders(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  maximum: number,
  offset: number,
): Promise<RelatedWorkMetadata[]> {
  const providerIDs: CitationProviderID[] = [
    node.provider ?? "crossref",
    "crossref",
    "semantic-scholar",
    "openalex",
    "opencitations",
    "inspire",
  ];
  const identifiers = identifiersForNode(node);
  let works: RelatedWorkMetadata[] = [];

  for (const providerID of [...new Set(providerIDs)]) {
    try {
      const provider = getCitationProvider(providerID);
      const match = await lookupProviderRecord(providerID, node, identifiers);

      // Crossref and INSPIRE expose their structured bibliography directly in
      // the lookup result and do not necessarily implement a separate relation
      // endpoint. Preserve those records before trying endpoint-based providers.
      if (direction === "references" && match?.references?.length) {
        works = mergeWorkLists(works, match.references);
      }

      const fetcher =
        direction === "references"
          ? provider.fetchReferencedWorks
          : provider.fetchCitingWorks;
      if (!fetcher) continue;

      const providerWorkID =
        match?.providerWorkID ??
        (providerID === node.provider ? node.providerWorkID : null) ??
        (providerID === "opencitations" ? normalizeDOI(node.doi) : null);
      if (!providerWorkID) continue;

      const fetched = await fetcher(providerWorkID, maximum, offset);
      if (fetched.length) works = mergeWorkLists(works, fetched);
    } catch (error) {
      Zotero.debug(
        `Citation Map: ${providerID} ${direction} lookup failed: ${String(error)}`,
      );
    }
  }

  return works.slice(0, maximum);
}

function mergeWorkLists(
  existing: RelatedWorkMetadata[],
  fetched: RelatedWorkMetadata[],
): RelatedWorkMetadata[] {
  const output = [...existing];
  const indexByIdentity = new Map<string, number>();
  output.forEach((work, index) => {
    const key = identityKey(work);
    if (key) indexByIdentity.set(key, index);
  });
  for (const work of fetched) {
    const key = identityKey(work);
    const existingIndex = key ? indexByIdentity.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) indexByIdentity.set(key, output.length);
      output.push(work);
    } else {
      output[existingIndex] = mergeMetadata(output[existingIndex], work);
    }
  }
  return output;
}

function cachedReferenceWorks(
  node: CitationGraphNode,
  maximum: number,
  offset: number,
): RelatedWorkMetadata[] {
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  const persisted = (
    record?.references.slice(offset, offset + maximum) ?? []
  ).map((work) => {
    const key = identityKey(work);
    return key ? mergeMetadata(work, cachedExternalWorkMetadata(key)) : work;
  });
  const nodeReferences = node.references.slice(offset, offset + maximum);
  const shared = cachedRelationshipResults(node, "references").slice(
    offset,
    offset + maximum,
  );
  const cached = mergeWorkLists(
    mergeWorkLists(persisted, nodeReferences),
    shared,
  );
  return cached.slice(0, maximum);
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
    cachedReferenceWorks(node, maximum, offset),
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

export async function getExternalReferences(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
): Promise<ExternalWork[]> {
  const relationshipEntry = cachedRelationshipEntry(node, "references");
  const relationshipKeyChanged =
    relationshipEntry !== null &&
    relationshipEntry.relationshipKey !==
      relationshipCacheKey(node, "references");
  const cached = cachedReferenceWorks(node, maximum, offset);
  let works: RelatedWorkMetadata[] = cached;
  const expectedCount =
    node.referenceCount === null
      ? cached.length
      : Math.min(maximum, Math.max(0, node.referenceCount - offset));
  if (
    !relationshipCacheIsFresh(relationshipEntry) &&
    (cached.length === 0 || cached.length < expectedCount)
  ) {
    const fetched = await fetchFromProviders(
      node,
      "references",
      maximum,
      offset,
    );
    if (fetched.length > 0) {
      works = mergeWorkLists(cached, fetched).slice(0, maximum);
      await Promise.all(
        fetched.map(async (work) => {
          const key = identityKey(work);
          if (key) await saveExternalWorkCacheSuccess(key, work);
        }),
      );
    }
  }
  const external = toExternalWorks(works, libraryNodes);
  if (
    external.length > 0 &&
    (!relationshipCacheIsFresh(relationshipEntry) || relationshipKeyChanged)
  ) {
    await cacheRelationshipResults(node, "references", external);
  }
  return external;
}

export async function getExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
): Promise<ExternalWork[]> {
  const relationshipEntry = cachedRelationshipEntry(node, "cited-by");
  const relationshipKeyChanged =
    relationshipEntry !== null &&
    relationshipEntry.relationshipKey !==
      relationshipCacheKey(node, "cited-by");
  const shared = cachedRelationshipResults(node, "cited-by").slice(
    offset,
    offset + maximum,
  );
  let works: RelatedWorkMetadata[] = shared;
  let fetchedWorks = false;
  if (!relationshipCacheIsFresh(relationshipEntry)) {
    const fetched = await fetchFromProviders(node, "cited-by", maximum, offset);
    works = mergeWorkLists(shared, fetched).slice(0, maximum);
    fetchedWorks = fetched.length > 0;
  }
  const external = toExternalWorks(works, libraryNodes);
  if (
    external.length > 0 &&
    (fetchedWorks || !relationshipEntry || relationshipKeyChanged)
  ) {
    await cacheRelationshipResults(node, "cited-by", external);
  }
  return external;
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
