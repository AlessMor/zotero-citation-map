import type { CitationGraphNode } from "../domain/graphTypes";
import type { RelatedWorkMetadata } from "../domain/citationTypes";
import { requestJSON } from "../providers/http";
import { normalizeDOI } from "./citationIdentifiers";
import { getCitationMetricRecord } from "./citationMetricsStore";

export interface ExternalWork {
  providerWorkID: string;
  doi: string | null;
  title: string;
  year: number | null;
  authors: string[];
  citationCount: number | null;
  referenceCount: number | null;
  recommendationScore?: number;
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string | null;
  title?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  referenced_works_count?: number | null;
  authorships?: Array<{ author?: { display_name?: string | null } }>;
}

interface OpenAlexListResponse {
  results?: OpenAlexWork[];
}

const workCache = new Map<string, ExternalWork | null>();

function shortID(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/^https:\/\/openalex\.org\//i, "");
}

function toExternalWork(work: OpenAlexWork): ExternalWork | null {
  const providerWorkID = shortID(work.id);
  const title = String(work.display_name ?? work.title ?? "").trim();
  if (!providerWorkID || !title) return null;
  return {
    providerWorkID,
    doi: normalizeDOI(work.doi),
    title,
    year:
      work.publication_year === null || work.publication_year === undefined
        ? null
        : Number(work.publication_year),
    authors: (work.authorships ?? [])
      .map((entry) => String(entry.author?.display_name ?? "").trim())
      .filter(Boolean),
    citationCount:
      work.cited_by_count === null || work.cited_by_count === undefined
        ? null
        : Number(work.cited_by_count),
    referenceCount:
      work.referenced_works_count === null ||
      work.referenced_works_count === undefined
        ? null
        : Number(work.referenced_works_count),
  };
}

async function fetchOpenAlexWork(providerWorkID: string): Promise<ExternalWork | null> {
  const id = shortID(providerWorkID);
  if (!id) return null;
  if (workCache.has(id)) return workCache.get(id) ?? null;

  const select = [
    "id",
    "doi",
    "display_name",
    "publication_year",
    "cited_by_count",
    "referenced_works_count",
    "authorships",
  ].join(",");
  const response = await requestJSON<OpenAlexWork>(
    "openalex",
    `https://api.openalex.org/works/${encodeURIComponent(id)}?select=${encodeURIComponent(select)}`,
  );
  const result = response.ok && response.data ? toExternalWork(response.data) : null;
  workCache.set(id, result);
  return result;
}

function metadataToExternal(reference: RelatedWorkMetadata): ExternalWork | null {
  const id = shortID(reference.providerWorkID);
  if (!id || !reference.title) return null;
  return {
    providerWorkID: id,
    doi: normalizeDOI(reference.doi),
    title: reference.title,
    year: reference.year,
    authors: [...reference.authors],
    citationCount: null,
    referenceCount: null,
  };
}

export async function getExternalReferences(
  node: CitationGraphNode,
  maximum = 60,
): Promise<ExternalWork[]> {
  const record = getCitationMetricRecord(
    Zotero.Libraries.userLibraryID,
    node.itemKey,
  );
  if (!record) return [];

  const results: ExternalWork[] = [];
  for (const reference of record.references.slice(0, maximum)) {
    const embedded = metadataToExternal(reference);
    const resolved = embedded ??
      (reference.providerWorkID ? await fetchOpenAlexWork(reference.providerWorkID) : null);
    if (resolved) results.push(resolved);
  }
  return results;
}

export async function getExternalCitedBy(
  node: CitationGraphNode,
  maximum = 50,
): Promise<ExternalWork[]> {
  const id = shortID(node.providerWorkID);
  if (!id) return [];
  const select = [
    "id",
    "doi",
    "display_name",
    "publication_year",
    "cited_by_count",
    "referenced_works_count",
    "authorships",
  ].join(",");
  const url =
    `https://api.openalex.org/works?filter=cites:${encodeURIComponent(id)}` +
    `&sort=cited_by_count:desc&per-page=${Math.min(200, maximum)}` +
    `&select=${encodeURIComponent(select)}`;
  const response = await requestJSON<OpenAlexListResponse>("openalex", url);
  if (!response.ok || !response.data) return [];
  return (response.data.results ?? [])
    .map(toExternalWork)
    .filter((work): work is ExternalWork => Boolean(work));
}

export async function getMissingPaperRecommendations(
  nodes: CitationGraphNode[],
  maximum = 25,
): Promise<ExternalWork[]> {
  const localIDs = new Set(
    nodes.map((node) => shortID(node.providerWorkID)).filter(Boolean),
  );
  const scores = new Map<string, number>();
  for (const node of nodes) {
    const record = getCitationMetricRecord(Zotero.Libraries.userLibraryID, node.itemKey);
    if (!record) continue;
    const seenForPaper = new Set<string>();
    for (const reference of record.references) {
      const id = shortID(reference.providerWorkID);
      if (!id || localIDs.has(id) || seenForPaper.has(id)) continue;
      seenForPaper.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1);
    }
  }

  const ranked = [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maximum);
  const results: ExternalWork[] = [];
  for (const [id, score] of ranked) {
    const work = await fetchOpenAlexWork(id);
    if (work) results.push({ ...work, recommendationScore: score });
  }
  return results;
}

export async function importExternalWork(
  work: ExternalWork,
  libraryID: number,
  collectionIDs: number[] = [],
): Promise<Zotero.Item[]> {
  if (!work.doi) throw new Error("This work has no DOI available for Zotero import.");
  const translate = new (Zotero.Translate as any).Search();
  translate.setIdentifier({ DOI: work.doi });
  const translators = await translate.getTranslators();
  translate.setTranslator(translators);
  return (await translate.translate({
    libraryID,
    collections: collectionIDs.length > 0 ? collectionIDs : false,
    saveAttachments: true,
  })) as Zotero.Item[];
}
