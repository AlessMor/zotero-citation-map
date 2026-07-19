import type {
  CitationProviderID,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import { getCitationProvider } from "../providers/registry";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import { getCitationMetricRecord } from "./citationMetricsStore";

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

async function fetchFromProvider(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  maximum: number,
  offset: number,
): Promise<RelatedWorkMetadata[]> {
  if (!node.provider || !node.providerWorkID) return [];
  const provider = getCitationProvider(node.provider);
  const fetcher =
    direction === "references"
      ? provider.fetchReferencedWorks
      : provider.fetchCitingWorks;
  if (!fetcher) return [];
  return fetcher(node.providerWorkID, maximum, offset);
}

export async function getExternalReferences(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
): Promise<ExternalWork[]> {
  const indexes = localIndexes(libraryNodes);
  const record = getCitationMetricRecord(nodeLibraryID(node), node.itemKey);
  const cached = record?.references.slice(offset, offset + maximum) ?? [];
  const works =
    cached.length > 0
      ? cached
      : await fetchFromProvider(node, "references", maximum, offset);
  return works.map((work) => toExternal(work, indexes.byDOI, indexes.byTitle));
}

export async function getExternalCitedBy(
  node: CitationGraphNode,
  libraryNodes: CitationGraphNode[],
  maximum = 100,
  offset = 0,
): Promise<ExternalWork[]> {
  const indexes = localIndexes(libraryNodes);
  const providers: CitationProviderID[] = [
    node.provider ?? "semantic-scholar",
    "semantic-scholar",
    "openalex",
  ];
  for (const providerID of [...new Set(providers)]) {
    try {
      const provider = getCitationProvider(providerID);
      if (!provider.fetchCitingWorks) continue;
      let providerIDForLookup =
        providerID === node.provider ? node.providerWorkID : null;
      if (!providerIDForLookup) {
        const identifiers: WorkIdentifiers = {
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
        if (!provider.supports(identifiers)) continue;
        const match = await provider.lookup(identifiers);
        if (match.status !== "success" || !match.providerWorkID) continue;
        providerIDForLookup = match.providerWorkID;
      }
      const works = await provider.fetchCitingWorks(
        providerIDForLookup,
        maximum,
        offset,
      );
      if (works.length > 0) {
        return works.map((work) =>
          toExternal(work, indexes.byDOI, indexes.byTitle),
        );
      }
    } catch (error) {
      Zotero.debug(
        `Citation Map: ${providerID} cited-by lookup failed: ${String(error)}`,
      );
    }
  }
  return [];
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
      // Prefer the richer record when providers supplied duplicates.
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

  // Provider metadata can still be imported safely even when no resolvable
  // identifier is available. This is not used for manual citation relations;
  // it creates a normal Zotero bibliographic item first.
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
