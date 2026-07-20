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
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

const BACKGROUND_REFERENCE_LIMIT = 200;
const ON_DEMAND_REFERENCE_LIMIT = 25;
const sourceMetricsCache = new Map<string, SourceMetrics | null>();

interface OpenAlexAuthor {
  author?: { display_name?: string };
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
  const response = await requestJSON<OpenAlexWork>(
    "openalex",
    `https://api.openalex.org/works/${encodeURIComponent(id)}`,
  );
  return response.ok && response.data ? response.data : null;
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
    const response = await requestJSON<OpenAlexSource>(
      "openalex",
      `https://api.openalex.org/sources/${encodeURIComponent(id)}`,
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
): { id: string; kind: "doi" | "pmid" | "arxiv" | "isbn" } | null {
  if (identifiers.doi) return { id: `doi:${identifiers.doi}`, kind: "doi" };
  if (identifiers.pmid) return { id: `pmid:${identifiers.pmid}`, kind: "pmid" };
  if (identifiers.arxiv)
    return { id: `arxiv:${identifiers.arxiv}`, kind: "arxiv" };
  if (identifiers.isbn) return { id: `isbn:${identifiers.isbn}`, kind: "isbn" };
  return null;
}

async function listByFilter(
  filter: string,
  maximum: number,
  offset = 0,
): Promise<RelatedWorkMetadata[]> {
  const page = Math.floor(offset / Math.max(1, maximum)) + 1;
  const response = await requestJSON<OpenAlexList>(
    "openalex",
    `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=${Math.min(200, maximum)}&page=${page}`,
  );
  if (!response.ok || !response.data) return [];
  return (response.data.results ?? [])
    .map(toRelated)
    .filter((work): work is RelatedWorkMetadata => Boolean(work));
}

export const openAlexProvider: CitationProvider = {
  id: "openalex",
  label: "OpenAlex",
  capabilities: {
    identifiers: {
      doi: true,
      pmid: true,
      arxiv: true,
      isbn: true,
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
        message: "OpenAlex needs a supported identifier.",
      };
    const response = await requestJSON<OpenAlexWork>(
      "openalex",
      `https://api.openalex.org/works/${encodeURIComponent(target.id)}`,
    );
    if (!response.ok || !response.data) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "openalex",
        message: response.message || "OpenAlex did not return a work.",
      };
    }
    return success(
      response.data,
      target.kind,
      target.kind === "doi" ? 1 : 0.98,
    );
  },
  searchExactTitle: async (identifiers) => {
    const response = await requestJSON<OpenAlexList>(
      "openalex",
      `https://api.openalex.org/works?search=${encodeURIComponent(identifiers.title)}&per-page=20`,
    );
    if (!response.ok || !response.data)
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "openalex",
        message: response.message || "OpenAlex title search failed.",
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
  fetchCitingWorks: (id, maximum, offset) =>
    listByFilter(`cites:${shortID(id)}`, maximum, offset),
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
