import type {
  CitationYearCount,
  RelatedWorkMetadata,
  SourceMetrics,
} from "../domain/citationTypes";
import { publicationYearOrNull } from "../domain/valueNormalization";
import { normalizeDOI } from "../domain/workIdentity";
import {
  stampRelatedWorkFieldGroups,
  type RelatedWorkFieldGroup,
} from "../services/relatedWorkHydrationState";
import { shortOpenAlexID } from "./providerIdentifiers";
import { numberOrNull, stringOrNull } from "./types";

export interface OpenAlexAuthor {
  author?: { id?: string; display_name?: string; orcid?: string | null };
}

export interface OpenAlexSource {
  id?: string;
  display_name?: string;
  summary_stats?: {
    "2yr_mean_citedness"?: number | null;
    h_index?: number | null;
    i10_index?: number | null;
  };
}

export interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string;
  title?: string;
  publication_year?: number;
  publication_date?: string;
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
  } | null;
  is_retracted?: boolean;
  open_access?: { is_oa?: boolean; oa_status?: string } | null;
  type?: string;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: { source?: OpenAlexSource | null } | null;
}

export interface OpenAlexList {
  results?: OpenAlexWork[];
}

export function openAlexAbstract(
  index: Record<string, number[]> | null | undefined,
): string | null {
  if (!index) return null;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  words.sort((left, right) => left[0] - right[0]);
  return words.map((entry) => entry[1]).join(" ") || null;
}

export function openAlexYearlyMetrics(counts: CitationYearCount[]): {
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

export function openAlexSourceMetrics(
  work: OpenAlexWork,
): SourceMetrics | null {
  const source = work.primary_location?.source;
  const stats = source?.summary_stats;
  if (!stats) return null;
  const metrics: SourceMetrics = {
    sourceID: shortOpenAlexID(source?.id),
    sourceTitle: stringOrNull(source?.display_name),
    twoYearMeanCitedness: numberOrNull(stats["2yr_mean_citedness"]),
    hIndex: numberOrNull(stats.h_index),
    i10Index: numberOrNull(stats.i10_index),
    updatedAt: new Date().toISOString(),
  };
  return Boolean(metrics.sourceID) ||
    metrics.twoYearMeanCitedness !== null ||
    metrics.hIndex !== null ||
    metrics.i10Index !== null
    ? metrics
    : null;
}

export function openAlexWorkMetadata(
  work: OpenAlexWork,
): RelatedWorkMetadata | null {
  const providerWorkID = shortOpenAlexID(work.id);
  const title = stringOrNull(work.display_name ?? work.title);
  if (!providerWorkID || !title) return null;
  const counts: CitationYearCount[] = (work.counts_by_year ?? [])
    .map((entry) => ({
      year: Number(entry.year),
      count: Number(entry.cited_by_count),
    }))
    .filter(
      (entry) => Number.isInteger(entry.year) && Number.isFinite(entry.count),
    );
  const trend = openAlexYearlyMetrics(counts);
  const sourceMetrics = openAlexSourceMetrics(work);
  const groups: RelatedWorkFieldGroup[] = ["summary"];
  if (work.abstract_inverted_index !== undefined) groups.push("abstract");
  if (work.counts_by_year !== undefined) groups.push("citation-history");
  if (
    work.fwci !== undefined ||
    work.citation_normalized_percentile !== undefined
  ) {
    groups.push("normalized-impact");
  }
  if (work.open_access !== undefined) groups.push("open-access");
  if (work.type !== undefined || work.is_retracted !== undefined) {
    groups.push("publication-details");
  }
  if (sourceMetrics) groups.push("source-metrics");
  if (work.referenced_works !== undefined) groups.push("relationships");

  return stampRelatedWorkFieldGroups(
    {
      provider: "openalex",
      providerWorkID,
      doi: normalizeDOI(work.doi),
      pmid: null,
      arxiv: null,
      isbn: null,
      title,
      year: publicationYearOrNull(work.publication_year),
      publicationDate: stringOrNull(work.publication_date),
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
      abstract: openAlexAbstract(work.abstract_inverted_index),
      citationCount: numberOrNull(work.cited_by_count),
      referenceCount: numberOrNull(work.referenced_works_count),
      citationCountsByYear: counts,
      references: (work.referenced_works ?? [])
        .map(shortOpenAlexID)
        .filter((id): id is string => Boolean(id))
        .map((id) => ({
          provider: "openalex" as const,
          providerWorkID: id,
          doi: null,
          title: null,
          year: null,
          authors: [],
        })),
      resolvedReferenceCount: work.referenced_works?.length ?? 0,
      fwci: numberOrNull(work.fwci),
      citationPercentile: numberOrNull(
        work.citation_normalized_percentile?.value,
      ),
      isTop1Percent:
        work.citation_normalized_percentile?.is_in_top_1_percent ?? null,
      isTop10Percent:
        work.citation_normalized_percentile?.is_in_top_10_percent ?? null,
      citationsLastYear: counts.length ? trend.lastYear : null,
      citationVelocity: counts.length ? trend.velocity : null,
      citationAcceleration: counts.length ? trend.acceleration : null,
      publicationType: stringOrNull(work.type),
      sourceMetrics,
      isOpenAccess:
        typeof work.open_access?.is_oa === "boolean"
          ? work.open_access.is_oa
          : null,
      openAccessStatus: stringOrNull(work.open_access?.oa_status),
      isRetracted:
        typeof work.is_retracted === "boolean" ? work.is_retracted : null,
      dataSources: ["openalex"],
    },
    groups,
  );
}

export function collectOpenAlexWorks(data: unknown): OpenAlexWork[] {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) {
    return data.filter((entry): entry is OpenAlexWork =>
      Boolean(entry && typeof entry === "object" && "id" in entry),
    );
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.results))
    return collectOpenAlexWorks(record.results);
  return typeof record.id === "string" ? [record as OpenAlexWork] : [];
}
