import type {
  CitationProviderID,
  CitationProviderPreference,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { requestJSON } from "../providers/http";
import { getCitationProvider, getProviderPlan } from "../providers/registry";
import {
  externalWorkCacheIdentity,
  normalizeDOI,
  normalizeExactTitle,
} from "./citationIdentifiers";
import { getOpenAlexAPIKey } from "./citationPreferences";
import { providerExecutionPolicy } from "./providerExecutionPolicy";
import {
  projectRelatedWorkSummary,
  relatedWorkNeedsSummary,
} from "./relatedWorkHydrationState";

const SEMANTIC_SCHOLAR_BATCH_LIMIT = 500;
const OPENALEX_BATCH_LIMIT = 100;
const SEMANTIC_SCHOLAR_SUMMARY_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "year",
  "authors",
  "venue",
  "publicationVenue",
  "citationCount",
  "referenceCount",
].join(",");
const openAlexReferenceIDsCache = new Map<string, string[]>();

const OPENALEX_SUMMARY_FIELDS = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "authorships",
  "primary_location",
  "cited_by_count",
  "referenced_works_count",
].join(",");

interface S2Paper {
  paperId?: string;
  externalIds?: { DOI?: string; PubMed?: string; ArXiv?: string };
  title?: string;
  year?: number;
  authors?: Array<{ authorId?: string; name?: string }>;
  venue?: string;
  publicationVenue?: { name?: string };
  citationCount?: number;
  referenceCount?: number;
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  referenced_works_count?: number;
  authorships?: Array<{
    author?: { id?: string; display_name?: string; orcid?: string | null };
  }>;
  primary_location?: {
    source?: { id?: string; display_name?: string } | null;
  } | null;
}

interface S2Relation {
  citedPaper?: S2Paper;
  citingPaper?: S2Paper;
}

interface S2RelationResponse {
  data?: S2Relation[];
  next?: number;
}

interface OpenAlexList {
  results?: OpenAlexWork[];
}

interface OpenAlexReferenceSource {
  referenced_works?: string[];
  referenced_works_count?: number;
}

interface IndexedIdentifier {
  index: number;
  identifier: string;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortOpenAlexID(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.replace(/^https:\/\/openalex\.org\//i, "") : null;
}

function chunked<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

async function runBounded(
  tasks: Array<() => Promise<void>>,
  parallelism: number,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      await tasks[index]();
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, parallelism), tasks.length) },
      () => worker(),
    ),
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

function openAlexIdentifier(
  work: RelatedWorkMetadata,
): { kind: "openalex" | "doi"; key: string } | null {
  if (work.provider === "openalex" && work.providerWorkID?.trim()) {
    const id = shortOpenAlexID(work.providerWorkID);
    if (id && /^W\d+$/i.test(id)) {
      return { kind: "openalex", key: id.toLocaleUpperCase() };
    }
  }
  const doi = normalizeDOI(work.doi);
  return doi ? { kind: "doi", key: doi } : null;
}

function summaryFromSemanticScholar(
  paper: S2Paper,
): RelatedWorkMetadata | null {
  const providerWorkID = stringOrNull(paper.paperId);
  const title = stringOrNull(paper.title);
  if (!providerWorkID || !title) return null;
  return {
    provider: "semantic-scholar",
    providerWorkID,
    doi: normalizeDOI(paper.externalIds?.DOI),
    pmid: stringOrNull(paper.externalIds?.PubMed),
    arxiv: stringOrNull(paper.externalIds?.ArXiv),
    isbn: null,
    title,
    year: numberOrNull(paper.year),
    authors: (paper.authors ?? [])
      .map((author) => String(author.name ?? "").trim())
      .filter(Boolean),
    authorIDs: (paper.authors ?? [])
      .map((author) => String(author.authorId ?? "").trim())
      .filter(Boolean),
    sourceTitle: stringOrNull(paper.publicationVenue?.name ?? paper.venue),
    citationCount: numberOrNull(paper.citationCount),
    referenceCount: numberOrNull(paper.referenceCount),
    dataSources: ["semantic-scholar"],
  };
}

function summaryFromOpenAlex(work: OpenAlexWork): RelatedWorkMetadata | null {
  const providerWorkID = shortOpenAlexID(work.id);
  const title = stringOrNull(work.display_name);
  if (!providerWorkID || !title) return null;
  return {
    provider: "openalex",
    providerWorkID,
    doi: normalizeDOI(work.doi),
    pmid: null,
    arxiv: null,
    isbn: null,
    title,
    year: numberOrNull(work.publication_year),
    authors: (work.authorships ?? [])
      .map((entry) => String(entry.author?.display_name ?? "").trim())
      .filter(Boolean),
    authorIDs: [
      ...(work.authorships ?? []).map((entry) =>
        String(entry.author?.orcid ?? "").trim(),
      ),
      ...(work.authorships ?? []).map((entry) =>
        String(entry.author?.id ?? "")
          .replace(/^https:\/\/openalex\.org\//i, "")
          .trim(),
      ),
    ].filter(Boolean),
    sourceTitle: stringOrNull(work.primary_location?.source?.display_name),
    citationCount: numberOrNull(work.cited_by_count),
    referenceCount: numberOrNull(work.referenced_works_count),
    dataSources: ["openalex"],
  };
}

function identifiersForWork(work: RelatedWorkMetadata): WorkIdentifiers {
  return {
    doi: normalizeDOI(work.doi),
    pmid: String(work.pmid ?? "").trim() || null,
    arxiv: String(work.arxiv ?? "").trim() || null,
    isbn: String(work.isbn ?? "").trim() || null,
    title: String(work.title ?? "").trim(),
    normalizedTitle: normalizeExactTitle(work.title),
    year: work.year,
    authors: [...work.authors],
    sourceTitle: work.sourceTitle ?? null,
  };
}

function summaryFromLookup(result: ProviderLookupSuccess): RelatedWorkMetadata {
  return {
    provider: result.provider,
    providerWorkID: result.providerWorkID,
    doi: result.doi,
    title: result.title,
    year: result.year,
    authors: [...result.authors],
    sourceTitle: result.sourceTitle,
    citationCount: result.citationCount,
    referenceCount: result.referenceCount,
    dataSources: [result.provider],
  };
}

function mergeSummary(
  current: RelatedWorkMetadata,
  metadata: RelatedWorkMetadata | null,
): RelatedWorkMetadata {
  if (!metadata) return current;
  const sources = new Set([
    ...(current.dataSources ?? []),
    ...(metadata.dataSources ?? []),
  ]);
  return {
    ...current,
    providerWorkID: current.providerWorkID ?? metadata.providerWorkID,
    doi: current.doi ?? metadata.doi,
    pmid: current.pmid ?? metadata.pmid,
    arxiv: current.arxiv ?? metadata.arxiv,
    isbn: current.isbn ?? metadata.isbn,
    title: String(current.title ?? "").trim() ? current.title : metadata.title,
    year: current.year ?? metadata.year,
    authors: current.authors.length ? current.authors : [...metadata.authors],
    authorIDs: current.authorIDs?.length
      ? current.authorIDs
      : [...(metadata.authorIDs ?? [])],
    sourceTitle: current.sourceTitle ?? metadata.sourceTitle,
    citationCount:
      current.citationCount == null
        ? metadata.citationCount
        : metadata.citationCount == null
          ? current.citationCount
          : Math.max(current.citationCount, metadata.citationCount),
    referenceCount:
      current.referenceCount == null
        ? metadata.referenceCount
        : metadata.referenceCount == null
          ? current.referenceCount
          : Math.max(current.referenceCount, metadata.referenceCount),
    dataSources: [...sources],
  };
}

async function applySemanticScholarBatches(
  works: RelatedWorkMetadata[],
  indexes: number[],
): Promise<Set<number>> {
  const resolved = new Set<number>();
  const candidates = indexes
    .map((index) => ({
      index,
      identifier: semanticScholarIdentifier(works[index]),
    }))
    .filter((candidate): candidate is IndexedIdentifier =>
      Boolean(candidate.identifier),
    );
  const policy = providerExecutionPolicy("semantic-scholar");
  const batchSize = Math.min(SEMANTIC_SCHOLAR_BATCH_LIMIT, policy.batchSize);
  const tasks = chunked(candidates, batchSize).map(
    (batch) => async (): Promise<void> => {
      const response = await requestJSON<Array<S2Paper | null>>(
        "semantic-scholar",
        `https://api.semanticscholar.org/graph/v1/paper/batch?fields=${encodeURIComponent(SEMANTIC_SCHOLAR_SUMMARY_FIELDS)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: { ids: batch.map((candidate) => candidate.identifier) },
        },
      );
      if (!response.ok || !Array.isArray(response.data)) return;
      for (const [batchIndex, candidate] of batch.entries()) {
        const summary = response.data[batchIndex]
          ? summaryFromSemanticScholar(response.data[batchIndex]!)
          : null;
        works[candidate.index] = mergeSummary(works[candidate.index], summary);
        if (summary) resolved.add(candidate.index);
      }
    },
  );
  await runBounded(tasks, policy.requestParallelism);
  return resolved;
}

function openAlexURL(parameters: Record<string, string | number>): string {
  const url = new URL("https://api.openalex.org/works");
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  const key = getOpenAlexAPIKey();
  if (key) url.searchParams.set("api_key", key);
  return url.toString();
}

function openAlexPathURL(
  path: string,
  parameters: Record<string, string | number> = {},
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://api.openalex.org${normalizedPath}`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  const key = getOpenAlexAPIKey();
  if (key) url.searchParams.set("api_key", key);
  return url.toString();
}

async function applyOpenAlexBatches(
  works: RelatedWorkMetadata[],
  indexes: number[],
): Promise<Set<number>> {
  const resolved = new Set<number>();
  if (!getOpenAlexAPIKey()) return resolved;
  const candidates = indexes
    .map((index) => ({ index, identifier: openAlexIdentifier(works[index]) }))
    .filter(
      (
        candidate,
      ): candidate is {
        index: number;
        identifier: { kind: "openalex" | "doi"; key: string };
      } => Boolean(candidate.identifier),
    );
  const policy = providerExecutionPolicy("openalex");
  const size = Math.min(OPENALEX_BATCH_LIMIT, policy.batchSize);
  const tasks: Array<() => Promise<void>> = [];
  for (const kind of ["openalex", "doi"] as const) {
    const grouped = candidates.filter(
      (candidate) => candidate.identifier.kind === kind,
    );
    for (const batch of chunked(grouped, size)) {
      tasks.push(async (): Promise<void> => {
        const filterName = kind === "openalex" ? "ids.openalex" : "doi";
        const response = await requestJSON<OpenAlexList>(
          "openalex",
          openAlexURL({
            filter: `${filterName}:${batch
              .map((candidate) => candidate.identifier.key)
              .join("|")}`,
            per_page: batch.length,
            select: OPENALEX_SUMMARY_FIELDS,
          }),
        );
        if (!response.ok || !response.data) return;
        const byIdentity = new Map<string, RelatedWorkMetadata>();
        for (const entry of response.data.results ?? []) {
          const summary = summaryFromOpenAlex(entry);
          if (!summary) continue;
          const id = shortOpenAlexID(entry.id);
          const doi = normalizeDOI(entry.doi);
          if (id) byIdentity.set(`openalex:${id.toLocaleUpperCase()}`, summary);
          if (doi) byIdentity.set(`doi:${doi}`, summary);
        }
        for (const candidate of batch) {
          const key = `${candidate.identifier.kind}:${candidate.identifier.key}`;
          const summary = byIdentity.get(key) ?? null;
          works[candidate.index] = mergeSummary(
            works[candidate.index],
            summary,
          );
          if (summary) resolved.add(candidate.index);
        }
      });
    }
  }
  await runBounded(tasks, policy.requestParallelism);
  return resolved;
}

async function applyIndividualFallbacks(
  works: RelatedWorkMetadata[],
  indexes: number[],
  providerID: CitationProviderID,
  maximum: number,
): Promise<{ used: number; resolved: Set<number> }> {
  const resolved = new Set<number>();
  if (maximum <= 0) return { used: 0, resolved };
  const provider = getCitationProvider(providerID);
  const selected = indexes.slice(0, maximum);
  await runBounded(
    selected.map((index) => async (): Promise<void> => {
      const identifiers = identifiersForWork(works[index]);
      let result = provider.supports(identifiers)
        ? await (provider.lookupForRelations ?? provider.lookup)(identifiers)
        : null;
      if (
        (!result || result.status !== "success") &&
        provider.searchExactTitle &&
        identifiers.normalizedTitle
      ) {
        result = await provider.searchExactTitle(identifiers);
      }
      if (result?.status === "success") {
        works[index] = mergeSummary(works[index], summaryFromLookup(result));
        resolved.add(index);
      }
    }),
    providerExecutionPolicy(providerID).requestParallelism,
  );
  return { used: selected.length, resolved };
}

export async function fetchRelatedWorkSummaryPage(
  providerID: "semantic-scholar" | "openalex",
  providerWorkID: string,
  direction: "references" | "cited-by",
  maximum: number,
  offset = 0,
): Promise<RelatedWorkMetadata[]> {
  const requested = Math.max(0, Math.floor(maximum));
  const start = Math.max(0, Math.floor(offset));
  if (!requested) return [];

  if (providerID === "semantic-scholar") {
    const kind = direction === "references" ? "references" : "citations";
    const response = await requestJSON<S2RelationResponse>(
      "semantic-scholar",
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(providerWorkID)}/${kind}?offset=${start}&limit=${Math.min(200, requested)}&fields=${encodeURIComponent(SEMANTIC_SCHOLAR_SUMMARY_FIELDS)}`,
    );
    if (!response.ok || !response.data) return [];
    return (response.data.data ?? [])
      .map((entry) =>
        summaryFromSemanticScholar(
          direction === "references"
            ? (entry.citedPaper ?? {})
            : (entry.citingPaper ?? {}),
        ),
      )
      .filter((work): work is RelatedWorkMetadata => Boolean(work));
  }

  if (!getOpenAlexAPIKey()) return [];
  const normalizedID = shortOpenAlexID(providerWorkID);
  if (!normalizedID) return [];
  if (direction === "cited-by") {
    const page = Math.floor(start / OPENALEX_BATCH_LIMIT) + 1;
    const withinPage = start % OPENALEX_BATCH_LIMIT;
    const response = await requestJSON<OpenAlexList>(
      "openalex",
      openAlexURL({
        filter: `cites:${normalizedID}`,
        per_page: OPENALEX_BATCH_LIMIT,
        page,
        select: OPENALEX_SUMMARY_FIELDS,
      }),
    );
    if (!response.ok || !response.data) return [];
    return (response.data.results ?? [])
      .slice(withinPage, withinPage + requested)
      .map(summaryFromOpenAlex)
      .filter((work): work is RelatedWorkMetadata => Boolean(work));
  }

  let referenceIDs = openAlexReferenceIDsCache.get(normalizedID);
  if (!referenceIDs) {
    const source = await requestJSON<OpenAlexReferenceSource>(
      "openalex",
      openAlexPathURL(`/works/${encodeURIComponent(normalizedID)}`, {
        select: "referenced_works,referenced_works_count",
      }),
    );
    if (!source.ok || !source.data) return [];
    referenceIDs = (source.data.referenced_works ?? [])
      .map(shortOpenAlexID)
      .filter((id): id is string => Boolean(id));
    openAlexReferenceIDsCache.set(normalizedID, referenceIDs);
  }
  const identifiers = referenceIDs.slice(start, start + requested);
  if (!identifiers.length) return [];
  const summaries: RelatedWorkMetadata[] = identifiers.map((id) => ({
    provider: "openalex",
    providerWorkID: id,
    doi: null,
    title: null,
    year: null,
    authors: [],
  }));
  await applyOpenAlexBatches(
    summaries,
    summaries.map((_, index) => index),
  );
  return summaries.filter((work) => Boolean(work.title));
}

export interface RelatedWorkSummaryResolutionOptions {
  individualLookupLimit?: number;
}

/**
 * Resolve only the compact metadata required by relationship lists and basic
 * ghost-node display. Advanced metrics remain absent until a graph or detail
 * view explicitly requests them.
 */
export async function resolveRelatedWorkSummaries(
  input: RelatedWorkMetadata[],
  preference: CitationProviderPreference,
  options: RelatedWorkSummaryResolutionOptions = {},
): Promise<RelatedWorkMetadata[]> {
  const works = input.map((work) => ({
    ...work,
    authors: [...work.authors],
    authorIDs: [...(work.authorIDs ?? [])],
  }));
  const plan = getProviderPlan("metadata-resolution", preference);
  let remaining = Math.max(
    0,
    options.individualLookupLimit ?? Number.POSITIVE_INFINITY,
  );
  const successfullyResolved = new Set<number>();

  for (const providerID of plan.providers) {
    const unresolved = works
      .map((work, index) => ({ work, index }))
      .filter(({ work }) => relatedWorkNeedsSummary(work))
      .map(({ index }) => index);
    if (!unresolved.length) break;

    if (providerID === "semantic-scholar") {
      for (const index of await applySemanticScholarBatches(
        works,
        unresolved,
      )) {
        successfullyResolved.add(index);
      }
    } else if (providerID === "openalex") {
      for (const index of await applyOpenAlexBatches(works, unresolved)) {
        successfullyResolved.add(index);
      }
    }

    const stillUnresolved = unresolved.filter((index) =>
      relatedWorkNeedsSummary(works[index]),
    );
    const eligibleForFallback = stillUnresolved.filter((index) => {
      if (providerID === "semantic-scholar") {
        return !semanticScholarIdentifier(works[index]);
      }
      if (providerID === "openalex") {
        return !openAlexIdentifier(works[index]);
      }
      return true;
    });
    const fallback = await applyIndividualFallbacks(
      works,
      eligibleForFallback,
      providerID,
      remaining,
    );
    for (const index of fallback.resolved) successfullyResolved.add(index);
    remaining = Number.isFinite(remaining)
      ? Math.max(0, remaining - fallback.used)
      : remaining;
  }

  return works.map((work, index) => {
    const identity = externalWorkCacheIdentity(work);
    return identity &&
      (successfullyResolved.has(index) || !relatedWorkNeedsSummary(work))
      ? projectRelatedWorkSummary(work)
      : work;
  });
}
