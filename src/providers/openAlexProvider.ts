import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  SourceMetrics,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  matchWorkIdentifiers,
  normalizeDOI,
  normalizeExactTitle,
} from "../domain/workIdentity";
import { getOpenAlexAPIKey } from "../services/citationPreferences";
import { requestJSON, type HTTPResult } from "./http";
import {
  openAlexWorkMetadata as toRelated,
  openAlexYearlyMetrics as yearlyMetrics,
  type OpenAlexList,
  type OpenAlexSource,
  type OpenAlexWork,
} from "./openAlexMapper";
import { shortOpenAlexID as shortID } from "./providerIdentifiers";
import type { CitationProvider, ProviderRequestOptions } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

const OPENALEX_BASE_URL = "https://api.openalex.org";
const OPENALEX_MAX_PER_PAGE = 100;
const BACKGROUND_REFERENCE_LIMIT = 200;
const ON_DEMAND_REFERENCE_LIMIT = 100;
const sourceMetricsCache = new Map<string, SourceMetrics | null>();
const workByIDCache = new Map<string, Promise<OpenAlexWork | null>>();

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
  options?: ProviderRequestOptions,
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
  return requestJSON<T>("openalex", openAlexURL(path, parameters), {
    signal: options?.signal,
  });
}

function failureMessage<T>(response: HTTPResult<T>, fallback: string): string {
  if (response.status === 401 || response.status === 403) {
    return response.message || "OpenAlex rejected the configured API key.";
  }
  return response.message || fallback;
}

async function fetchWorkByID(
  id: string,
  options?: ProviderRequestOptions,
): Promise<OpenAlexWork | null> {
  const normalizedID = shortID(id);
  if (!normalizedID) return null;
  const key = normalizedID.toLocaleUpperCase();
  const existing = workByIDCache.get(key);
  if (existing) return existing;
  const request = requestOpenAlex<OpenAlexWork>(
    `/works/${encodeURIComponent(normalizedID)}`,
    {},
    options,
  ).then((response) => (response.ok && response.data ? response.data : null));
  if (!options?.signal) workByIDCache.set(key, request);
  return request;
}

interface OpenAlexBatchIdentifier {
  kind: "openalex" | "doi";
  key: string;
}

function openAlexBatchIdentifier(
  value: string,
): OpenAlexBatchIdentifier | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const withoutDOIPrefix = raw.replace(/^doi:\s*/i, "");
  const doi = normalizeDOI(withoutDOIPrefix);
  const id = shortID(raw);
  if (id && /^W\d+$/i.test(id)) {
    return { kind: "openalex", key: id.toLocaleUpperCase() };
  }
  return doi ? { kind: "doi", key: doi } : null;
}

/**
 * Resolve OpenAlex work IDs or DOIs into display-ready metadata. OpenAlex
 * supports OR filters with up to 100 identifiers, so DOI-only relationship
 * records can be hydrated in bulk instead of falling back to one HTTP request
 * per work.
 */
export async function fetchOpenAlexWorksBatch(
  identifiers: string[],
  options?: ProviderRequestOptions,
): Promise<Array<RelatedWorkMetadata | null>> {
  if (!identifiers.length) return [];

  const normalized = identifiers.map(openAlexBatchIdentifier);
  const resolved = new Map<string, RelatedWorkMetadata>();

  for (const kind of ["openalex", "doi"] as const) {
    const unique = [
      ...new Set(
        normalized
          .filter(
            (identifier): identifier is OpenAlexBatchIdentifier =>
              identifier?.kind === kind,
          )
          .map((identifier) => identifier.key),
      ),
    ];
    for (let start = 0; start < unique.length; start += OPENALEX_MAX_PER_PAGE) {
      const batch = unique.slice(start, start + OPENALEX_MAX_PER_PAGE);
      const filterName = kind === "openalex" ? "ids.openalex" : "doi";
      const response = await requestOpenAlex<OpenAlexList>(
        "/works",
        {
          filter: `${filterName}:${batch.join("|")}`,
          per_page: batch.length,
        },
        options,
      );
      if (!response.ok || !response.data) {
        throw new Error(
          failureMessage(response, "OpenAlex batch metadata lookup failed."),
        );
      }
      for (const work of response.data.results ?? []) {
        const metadata = toRelated(work);
        if (!metadata) continue;
        const id = shortID(work.id);
        const doi = normalizeDOI(work.doi);
        if (id) resolved.set(`openalex:${id.toLocaleUpperCase()}`, metadata);
        if (doi) resolved.set(`doi:${doi}`, metadata);
      }
    }
  }

  return normalized.map((identifier) =>
    identifier
      ? (resolved.get(`${identifier.kind}:${identifier.key}`) ?? null)
      : null,
  );
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

async function sourceMetrics(
  source: OpenAlexSource | null | undefined,
  options?: ProviderRequestOptions,
): Promise<SourceMetrics | null> {
  const id = shortID(source?.id);
  if (!id) return null;
  if (sourceMetricsCache.has(id)) return sourceMetricsCache.get(id) ?? null;
  let resolved = source ?? null;
  if (!resolved?.summary_stats) {
    const response = await requestOpenAlex<OpenAlexSource>(
      `/sources/${encodeURIComponent(id)}`,
      {},
      options,
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
  options?: ProviderRequestOptions,
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
    publicationDate: related.publicationDate ?? null,
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
    sourceMetrics: await sourceMetrics(work.primary_location?.source, options),
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
  options?: ProviderRequestOptions,
): Promise<RelatedWorkMetadata[]> {
  const requested = Math.max(0, Math.floor(maximum));
  let currentOffset = Math.max(0, Math.floor(offset));
  const works: RelatedWorkMetadata[] = [];

  while (works.length < requested) {
    const page = Math.floor(currentOffset / OPENALEX_MAX_PER_PAGE) + 1;
    const withinPage = currentOffset % OPENALEX_MAX_PER_PAGE;
    const response = await requestOpenAlex<OpenAlexList>(
      "/works",
      {
        filter,
        per_page: OPENALEX_MAX_PER_PAGE,
        page,
      },
      options,
    );
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
  options?: ProviderRequestOptions,
): Promise<OpenAlexWork | null> {
  const direct = workURL(identifiers);
  if (direct) {
    const response = await requestOpenAlex<OpenAlexWork>(
      `/works/${encodeURIComponent(direct.id)}`,
      {},
      options,
    );
    if (response.ok && response.data) return response.data;
  }

  const title = String(identifiers.title ?? "").trim();
  if (!title) return null;
  const response = await requestOpenAlex<OpenAlexList>(
    "/works",
    {
      search: title,
      per_page: 20,
    },
    options,
  );
  if (!response.ok || !response.data) return null;
  const candidates = response.data.results ?? [];
  const exact = candidates.filter(
    (work) =>
      normalizeExactTitle(work.display_name ?? work.title) ===
      identifiers.normalizedTitle,
  );
  const compatible = exact.filter((work) => {
    const candidate = toRelated(work);
    return Boolean(
      candidate &&
      matchWorkIdentifiers(identifiers, candidate).decision === "same-work",
    );
  });
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
  const closestWork = toRelated(closest);
  if (
    (identifiers.year !== null || identifiers.authors.length > 0) &&
    (!closestWork ||
      matchWorkIdentifiers(identifiers, closestWork).decision !== "same-work")
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
  options?: ProviderRequestOptions,
): Promise<RelatedWorkMetadata[]> {
  const relatedIDs: string[] = [];
  for (const seed of seeds.slice(0, 25)) {
    const work = await resolveOpenAlexWork(seed, options);
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
    options,
  );
  return metadata.filter((work): work is RelatedWorkMetadata =>
    Boolean(work?.title),
  );
}

export function clearOpenAlexProviderCache(): void {
  sourceMetricsCache.clear();
  workByIDCache.clear();
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
  lookup: async (identifiers, options) => {
    const target = workURL(identifiers);
    if (!target)
      return {
        status: "no-identifier",
        provider: "openalex",
        message: "OpenAlex needs a DOI, PMID, or arXiv identifier.",
      };
    const response = await requestOpenAlex<OpenAlexWork>(
      `/works/${encodeURIComponent(target.id)}`,
      {},
      options,
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
      options,
    );
  },
  searchExactTitle: async (identifiers, options) => {
    const response = await requestOpenAlex<OpenAlexList>(
      "/works",
      {
        search: identifiers.title,
        per_page: 20,
      },
      options,
    );
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
    const compatible = exact.filter((work) => {
      const candidate = toRelated(work);
      return Boolean(
        candidate &&
        matchWorkIdentifiers(identifiers, candidate).decision === "same-work",
      );
    });
    if (compatible.length === 1) {
      return success(compatible[0], "title", 0.92, options);
    }
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
  fetchCitingWorks: async (id, maximum, offset, options) => {
    const workID = shortID(id);
    return workID
      ? listByFilter(`cites:${workID}`, maximum, offset, options)
      : [];
  },
  fetchReferencedWorks: async (id, maximum, offset = 0, options) => {
    const work = await fetchWorkByID(id, options);
    if (!work) return [];
    return (work.referenced_works ?? [])
      .slice(offset, offset + Math.min(ON_DEMAND_REFERENCE_LIMIT, maximum))
      .map(shortID)
      .filter((target): target is string => Boolean(target))
      .map((target) => ({
        provider: "openalex" as const,
        providerWorkID: target,
        doi: null,
        title: null,
        year: null,
        authors: [],
      }));
  },
  fetchSourceMetrics: async (id, options) => sourceMetrics({ id }, options),
};
