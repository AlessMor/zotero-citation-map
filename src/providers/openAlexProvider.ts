import type {
  CitationYearCount,
  ProviderLookupResult,
  RelatedWorkMetadata,
  SourceMetrics,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  metadataIsNonContradictory,
  normalizeDOI,
  normalizeExactTitle,
} from "../services/citationIdentifiers";
import { getOpenAlexAPIKey } from "../services/citationPreferences";
import { requestJSON, type HTTPResult } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

const OPENALEX_BASE_URL = "https://api.openalex.org";
const OPENALEX_MAX_PER_PAGE = 100;
const BACKGROUND_REFERENCE_LIMIT = 200;
const ON_DEMAND_REFERENCE_LIMIT = 25;
const sourceMetricsCache = new Map<string, SourceMetrics | null>();

interface OpenAlexAuthor {
  author?: { id?: string; display_name?: string; orcid?: string | null };
}
interface OpenAlexSource {
  id?: string;
  display_name?: string;
  summary_stats?: {
    "2yr_mean_citedness"?: number;
    h_index?: number;
    i10_index?: number;
  };
}
interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string;
  title?: string;
  publication_year?: number;
  cited_by_count?: number;
  referenced_works_count?: number;
  referenced_works?: string[];
  related_works?: string[];
  relevance_score?: number;
  authorships?: OpenAlexAuthor[];
  counts_by_year?: Array<{ year?: number; cited_by_count?: number }>;
  fwci?: number | null;
  citation_normalized_percentile?: {
    value?: number;
    is_in_top_1_percent?: boolean;
    is_in_top_10_percent?: boolean;
  };
  is_retracted?: boolean;
  open_access?: { is_oa?: boolean; oa_status?: string };
  type?: string;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: { source?: OpenAlexSource | null };
}
interface OpenAlexList {
  results?: OpenAlexWork[];
}

function shortID(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.replace(/^https:\/\/openalex\.org\//i, "");
}

function openAlexURL(
  path: string,
  parameters: Record<string, string | number> = {},
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${OPENALEX_BASE_URL}${normalizedPath}`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  const apiKey = getOpenAlexAPIKey();
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url.toString();
}

async function requestOpenAlex<T>(
  path: string,
  parameters: Record<string, string | number> = {},
): Promise<HTTPResult<T>> {
  if (!getOpenAlexAPIKey()) {
    return {
      ok: false,
      status: 401,
      data: null,
      message:
        "OpenAlex API key is not configured. Add it in Settings → Citation Map.",
    };
  }
  return requestJSON<T>("openalex", openAlexURL(path, parameters));
}

function failureMessage<T>(response: HTTPResult<T>, fallback: string): string {
  if (response.status === 401 || response.status === 403) {
    return response.message || "OpenAlex rejected the configured API key.";
  }
  return response.message || fallback;
}

function abstractFromIndex(
  index: Record<string, number[]> | null | undefined,
): string | null {
  if (!index) return null;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map((entry) => entry[1]).join(" ") || null;
}

function toRelated(work: OpenAlexWork): RelatedWorkMetadata | null {
  const id = shortID(work.id);
  const title = stringOrNull(work.display_name ?? work.title);
  if (!id || !title) return null;
  return {
    provider: "openalex",
    providerWorkID: id,
    doi: normalizeDOI(work.doi),
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
    abstract: abstractFromIndex(work.abstract_inverted_index),
    citationCount: numberOrNull(work.cited_by_count),
    referenceCount: numberOrNull(work.referenced_works_count),
    isOpenAccess:
      typeof work.open_access?.is_oa === "boolean"
        ? work.open_access.is_oa
        : null,
    openAccessStatus: stringOrNull(work.open_access?.oa_status),
    isRetracted:
      typeof work.is_retracted === "boolean" ? work.is_retracted : null,
  };
}

async function fetchWorkByID(id: string): Promise<OpenAlexWork | null> {
  const normalizedID = shortID(id);
  if (!normalizedID) return null;
  const response = await requestOpenAlex<OpenAlexWork>(
    `/works/${encodeURIComponent(normalizedID)}`,
  );
  return response.ok && response.data ? response.data : null;
}

/**
 * Resolve OpenAlex work IDs into display-ready metadata. OpenAlex relationship
 * payloads often contain only dehydrated work IDs, so callers must hydrate
 * those IDs before presenting them as papers.
 */
export async function fetchOpenAlexWorksBatch(
  identifiers: string[],
): Promise<Array<RelatedWorkMetadata | null>> {
  if (!identifiers.length) return [];

  const normalized = identifiers.map(shortID);
  const unique = [
    ...new Set(normalized.filter((id): id is string => Boolean(id))),
  ];
  const resolved = new Map<string, RelatedWorkMetadata>();

  for (let start = 0; start < unique.length; start += OPENALEX_MAX_PER_PAGE) {
    const batch = unique.slice(start, start + OPENALEX_MAX_PER_PAGE);
    const response = await requestOpenAlex<OpenAlexList>("/works", {
      filter: `ids.openalex:${batch.join("|")}`,
      per_page: batch.length,
    });
    if (!response.ok || !response.data) {
      throw new Error(
        failureMessage(response, "OpenAlex batch metadata lookup failed."),
      );
    }
    for (const work of response.data.results ?? []) {
      const id = shortID(work.id);
      const metadata = toRelated(work);
      if (id && metadata) resolved.set(id, metadata);
    }
  }

  return normalized.map((id) => (id ? (resolved.get(id) ?? null) : null));
}

function resolveReferences(work: OpenAlexWork): RelatedWorkMetadata[] {
  return (work.referenced_works ?? [])
    .map(shortID)
    .filter((id): id is string => Boolean(id))
    .slice(0, BACKGROUND_REFERENCE_LIMIT)
    .map((id) => ({
      provider: "openalex" as const,
      providerWorkID: id,
      doi: null,
      title: null,
      year: null,
      authors: [],
    }));
}

function yearlyMetrics(counts: CitationYearCount[]): {
  lastYear: number | null;
  velocity: number | null;
  acceleration: number | null;
} {
  const current = new Date().getFullYear();
  const byYear = new Map(counts.map((entry) => [entry.year, entry.count]));
  const previous = byYear.get(current - 1) ?? 0;
  const before = byYear.get(current - 2) ?? 0;
  const three = [current - 3, current - 2, current - 1].map(
    (year) => byYear.get(year) ?? 0,
  );
  return {
    lastYear: previous,
    velocity: three.reduce((sum, count) => sum + count, 0) / 3,
    acceleration: previous - before,
  };
}

async function sourceMetrics(
  source: OpenAlexSource | null | undefined,
): Promise<SourceMetrics | null> {
  const id = shortID(source?.id);
  if (!id) return null;
  if (sourceMetricsCache.has(id)) return sourceMetricsCache.get(id) ?? null;
  let resolved = source ?? null;
  if (!resolved?.summary_stats) {
    const response = await requestOpenAlex<OpenAlexSource>(
      `/sources/${encodeURIComponent(id)}`,
    );
    resolved = response.ok ? response.data : resolved;
  }
  const metrics: SourceMetrics = {
    sourceID: id,
    sourceTitle: stringOrNull(resolved?.display_name),
    twoYearMeanCitedness: numberOrNull(
      resolved?.summary_stats?.["2yr_mean_citedness"],
    ),
    hIndex: numberOrNull(resolved?.summary_stats?.h_index),
    i10Index: numberOrNull(resolved?.summary_stats?.i10_index),
    updatedAt: new Date().toISOString(),
  };
  const hasMetric =
    metrics.twoYearMeanCitedness !== null ||
    metrics.hIndex !== null ||
    metrics.i10Index !== null;
  if (!hasMetric) return null;
  sourceMetricsCache.set(id, metrics);
  return metrics;
}

async function success(
  work: OpenAlexWork,
  matchedBy: "doi" | "pmid" | "arxiv" | "isbn" | "title",
  confidence: number,
): Promise<ProviderLookupResult> {
  const related = toRelated(work);
  if (!related) {
    return {
      status: "not-found",
      provider: "openalex",
      message: "OpenAlex returned an incomplete record.",
    };
  }
  const references = resolveReferences(work);
  const counts = (work.counts_by_year ?? [])
    .map((entry) => ({
      year: Number(entry.year),
      count: Number(entry.cited_by_count),
    }))
    .filter(
      (entry) => Number.isFinite(entry.year) && Number.isFinite(entry.count),
    );
  const trend = yearlyMetrics(counts);
  const percentile = numberOrNull(work.citation_normalized_percentile?.value);
  return {
    status: "success",
    provider: "openalex",
    matchedBy,
    matchConfidence: confidence,
    providerWorkID: related.providerWorkID,
    doi: related.doi,
    title: related.title,
    year: related.year,
    authors: related.authors,
    sourceTitle: related.sourceTitle ?? null,
    abstract: related.abstract ?? null,
    citationCount: related.citationCount ?? null,
    citationCountProvider: "openalex",
    referenceCount: related.referenceCount ?? references.length,
    referenceCountProvider: "openalex",
    resolvedReferenceCount: references.length,
    references,
    fwci: typeof work.fwci === "number" ? work.fwci : null,
    citationPercentile: percentile,
    isTop1Percent:
      work.citation_normalized_percentile?.is_in_top_1_percent ?? null,
    isTop10Percent:
      work.citation_normalized_percentile?.is_in_top_10_percent ?? null,
    citationCountsByYear: counts,
    citationsLastYear: trend.lastYear,
    citationVelocity: trend.velocity,
    citationAcceleration: trend.acceleration,
    influentialCitationCount: null,
    isRetracted: related.isRetracted ?? null,
    openAccessStatus: related.openAccessStatus ?? null,
    isOpenAccess: related.isOpenAccess ?? null,
    publicationType: stringOrNull(work.type),
    sourceMetrics: await sourceMetrics(work.primary_location?.source),
  };
}

function workURL(
  identifiers: WorkIdentifiers,
): { id: string; kind: "doi" | "pmid" | "arxiv" } | null {
  if (identifiers.doi) return { id: `doi:${identifiers.doi}`, kind: "doi" };
  if (identifiers.pmid) return { id: `pmid:${identifiers.pmid}`, kind: "pmid" };
  if (identifiers.arxiv) {
    return {
      id: `doi:10.48550/arxiv.${identifiers.arxiv}`,
      kind: "arxiv",
    };
  }
  return null;
}

async function listByFilter(
  filter: string,
  maximum: number,
  offset = 0,
): Promise<RelatedWorkMetadata[]> {
  const requested = Math.max(0, Math.floor(maximum));
  let currentOffset = Math.max(0, Math.floor(offset));
  const works: RelatedWorkMetadata[] = [];

  while (works.length < requested) {
    const page = Math.floor(currentOffset / OPENALEX_MAX_PER_PAGE) + 1;
    const withinPage = currentOffset % OPENALEX_MAX_PER_PAGE;
    const response = await requestOpenAlex<OpenAlexList>("/works", {
      filter,
      per_page: OPENALEX_MAX_PER_PAGE,
      page,
    });
    if (!response.ok || !response.data) break;

    const pageResults = response.data.results ?? [];
    const raw = pageResults.slice(
      withinPage,
      withinPage + (requested - works.length),
    );
    works.push(
      ...raw
        .map(toRelated)
        .filter((work): work is RelatedWorkMetadata => Boolean(work)),
    );
    currentOffset += raw.length;

    if (!raw.length || pageResults.length < OPENALEX_MAX_PER_PAGE) break;
  }

  return works.slice(0, requested);
}

function titleTokens(value: string | null | undefined): Set<string> {
  return new Set(
    normalizeExactTitle(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}

function titleSimilarity(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftNormalized = normalizeExactTitle(left);
  const rightNormalized = normalizeExactTitle(right);
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

async function resolveOpenAlexWork(
  identifiers: WorkIdentifiers,
): Promise<OpenAlexWork | null> {
  const direct = workURL(identifiers);
  if (direct) {
    const response = await requestOpenAlex<OpenAlexWork>(
      `/works/${encodeURIComponent(direct.id)}`,
    );
    if (response.ok && response.data) return response.data;
  }

  const title = String(identifiers.title ?? "").trim();
  if (!title) return null;
  const response = await requestOpenAlex<OpenAlexList>("/works", {
    search: title,
    per_page: 20,
  });
  if (!response.ok || !response.data) return null;
  const candidates = response.data.results ?? [];
  const exact = candidates.filter(
    (work) =>
      normalizeExactTitle(work.display_name ?? work.title) ===
      identifiers.normalizedTitle,
  );
  const compatible = exact.filter((work) =>
    metadataIsNonContradictory(identifiers, {
      year: numberOrNull(work.publication_year),
      authors: (work.authorships ?? []).map((entry) =>
        String(entry.author?.display_name ?? ""),
      ),
    }),
  );
  if (compatible.length === 1) return compatible[0];

  const closest = [...candidates].sort(
    (left, right) =>
      titleSimilarity(title, right.display_name ?? right.title) -
        titleSimilarity(title, left.display_name ?? left.title) ||
      Number(right.relevance_score ?? 0) - Number(left.relevance_score ?? 0),
  )[0];
  if (!closest) return null;
  const similarity = titleSimilarity(
    title,
    closest.display_name ?? closest.title,
  );
  if (similarity < 0.72) return null;
  if (
    (identifiers.year !== null || identifiers.authors.length > 0) &&
    !metadataIsNonContradictory(identifiers, {
      year: numberOrNull(closest.publication_year),
      authors: (closest.authorships ?? []).map((entry) =>
        String(entry.author?.display_name ?? ""),
      ),
    })
  ) {
    return null;
  }
  return closest;
}

/** Return OpenAlex's algorithmically computed related works. OpenAlex is used
 * only when the centralized provider policy permits it and an API key exists. */
export async function fetchOpenAlexRelatedWorks(
  seeds: WorkIdentifiers[],
  maximum = 100,
): Promise<RelatedWorkMetadata[]> {
  const relatedIDs: string[] = [];
  for (const seed of seeds.slice(0, 25)) {
    const work = await resolveOpenAlexWork(seed);
    for (const value of work?.related_works ?? []) {
      const id = shortID(value);
      if (id && !relatedIDs.includes(id)) relatedIDs.push(id);
      if (relatedIDs.length >= maximum * 2) break;
    }
    if (relatedIDs.length >= maximum * 2) break;
  }
  if (!relatedIDs.length) return [];
  const metadata = await fetchOpenAlexWorksBatch(
    relatedIDs.slice(0, Math.max(1, maximum)),
  );
  return metadata.filter((work): work is RelatedWorkMetadata =>
    Boolean(work?.title),
  );
}

export function clearOpenAlexProviderCache(): void {
  sourceMetricsCache.clear();
}

export const openAlexProvider: CitationProvider = {
  id: "openalex",
  label: "OpenAlex",
  capabilities: {
    identifiers: {
      doi: true,
      pmid: true,
      arxiv: true,
      isbn: false,
      titleSearch: true,
    },
    citationCount: true,
    referenceCount: true,
    citingWorks: true,
    referencedWorks: true,
    abstract: true,
    openAccess: true,
    retraction: true,
    sourceMetrics: true,
  },
  supports: (identifiers) => Boolean(workURL(identifiers)),
  lookup: async (identifiers) => {
    const target = workURL(identifiers);
    if (!target)
      return {
        status: "no-identifier",
        provider: "openalex",
        message: "OpenAlex needs a DOI, PMID, or arXiv identifier.",
      };
    const response = await requestOpenAlex<OpenAlexWork>(
      `/works/${encodeURIComponent(target.id)}`,
    );
    if (!response.ok || !response.data) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "openalex",
        message: failureMessage(response, "OpenAlex did not return a work."),
      };
    }
    return success(
      response.data,
      target.kind,
      target.kind === "doi" ? 1 : 0.98,
    );
  },
  searchExactTitle: async (identifiers) => {
    const response = await requestOpenAlex<OpenAlexList>("/works", {
      search: identifiers.title,
      per_page: 20,
    });
    if (!response.ok || !response.data)
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "openalex",
        message: failureMessage(response, "OpenAlex title search failed."),
      };
    const exact = (response.data.results ?? []).filter(
      (work) =>
        normalizeExactTitle(work.display_name ?? work.title) ===
        identifiers.normalizedTitle,
    );
    const compatible = exact.filter((work) =>
      metadataIsNonContradictory(identifiers, {
        year: numberOrNull(work.publication_year),
        authors: (work.authorships ?? []).map((entry) =>
          String(entry.author?.display_name ?? ""),
        ),
      }),
    );
    if (compatible.length === 1) return success(compatible[0], "title", 0.92);
    const candidates = exact
      .map(toRelated)
      .filter((work): work is RelatedWorkMetadata => Boolean(work));
    return candidates.length
      ? {
          status: "ambiguous-match",
          provider: "openalex",
          message:
            "OpenAlex returned multiple or contradictory exact-title matches.",
          candidates,
        }
      : {
          status: "not-found",
          provider: "openalex",
          message: "OpenAlex did not return a unique exact-title match.",
        };
  },
  fetchCitingWorks: async (id, maximum, offset) => {
    const workID = shortID(id);
    return workID ? listByFilter(`cites:${workID}`, maximum, offset) : [];
  },
  fetchReferencedWorks: async (id, maximum, offset = 0) => {
    const work = await fetchWorkByID(id);
    if (!work) return [];
    const ids = (work.referenced_works ?? []).slice(
      offset,
      offset + Math.min(ON_DEMAND_REFERENCE_LIMIT, maximum),
    );
    const results: RelatedWorkMetadata[] = [];
    for (const target of ids) {
      const related = toRelated((await fetchWorkByID(target)) ?? {});
      if (related) results.push(related);
    }
    return results;
  },
  fetchSourceMetrics: async (id) => sourceMetrics({ id }),
};
