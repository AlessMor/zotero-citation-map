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
  citingNodeKeys?: string[];
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

interface RecommendationCandidate {
  score: number;
  citingNodeKeys: Set<string>;
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

async function fetchOpenAlexWork(
  providerWorkID: string,
): Promise<ExternalWork | null> {
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
  const result =
    response.ok && response.data ? toExternalWork(response.data) : null;
  workCache.set(id, result);
  return result;
}

function metadataToExternal(
  reference: RelatedWorkMetadata,
): ExternalWork | null {
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
    const resolved =
      embedded ??
      (record.provider === "openalex" && reference.providerWorkID
        ? await fetchOpenAlexWork(reference.providerWorkID)
        : null);
    if (resolved) results.push(resolved);
  }
  return results;
}

export async function getExternalCitedBy(
  node: CitationGraphNode,
  maximum = 50,
): Promise<ExternalWork[]> {
  if (node.provider !== "openalex") return [];
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
  visibleNodes: CitationGraphNode[],
  libraryNodes: CitationGraphNode[],
  maximum = 25,
): Promise<ExternalWork[]> {
  const libraryOpenAlexIDs = new Set(
    libraryNodes
      .filter((node) => node.provider === "openalex")
      .map((node) => shortID(node.providerWorkID))
      .filter((id): id is string => Boolean(id)),
  );
  const libraryDOIs = new Set(
    libraryNodes
      .map((node) => normalizeDOI(node.doi))
      .filter((doi): doi is string => Boolean(doi)),
  );

  const candidates = new Map<string, RecommendationCandidate>();
  for (const node of visibleNodes) {
    const record = getCitationMetricRecord(
      Zotero.Libraries.userLibraryID,
      node.itemKey,
    );
    if (!record || record.provider !== "openalex") continue;

    const seenForPaper = new Set<string>();
    for (const reference of record.references) {
      const id = shortID(reference.providerWorkID);
      const doi = normalizeDOI(reference.doi);
      if (
        !id ||
        libraryOpenAlexIDs.has(id) ||
        (doi !== null && libraryDOIs.has(doi)) ||
        seenForPaper.has(id)
      ) {
        continue;
      }
      seenForPaper.add(id);
      const candidate = candidates.get(id) ?? {
        score: 0,
        citingNodeKeys: new Set<string>(),
      };
      candidate.score += 1;
      candidate.citingNodeKeys.add(node.key);
      candidates.set(id, candidate);
    }
  }

  const shortlistSize = Math.max(maximum * 2, 40);
  const shortlist = [...candidates.entries()]
    .sort(
      ([leftID, left], [rightID, right]) =>
        right.score - left.score || leftID.localeCompare(rightID),
    )
    .slice(0, shortlistSize);

  const resolved: ExternalWork[] = [];
  for (const [id, candidate] of shortlist) {
    const work = await fetchOpenAlexWork(id);
    if (!work) continue;
    const doi = normalizeDOI(work.doi);
    if (doi && libraryDOIs.has(doi)) continue;
    resolved.push({
      ...work,
      recommendationScore: candidate.score,
      citingNodeKeys: [...candidate.citingNodeKeys],
    });
  }

  return resolved
    .sort(
      (left, right) =>
        (right.recommendationScore ?? 0) - (left.recommendationScore ?? 0) ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1) ||
        (right.year ?? -1) - (left.year ?? -1) ||
        left.title.localeCompare(right.title),
    )
    .slice(0, maximum);
}

export async function importExternalWork(
  work: ExternalWork,
  libraryID: number,
  collectionIDs: number[] = [],
): Promise<Zotero.Item[]> {
  if (!work.doi) {
    throw new Error("This work has no DOI available for Zotero import.");
  }
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
