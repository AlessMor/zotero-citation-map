import type {
  CitationYearCount,
  RelatedWorkMetadata,
  SourceMetrics,
} from "../domain/citationTypes";
import {
  registerProviderJSONResponseObserver,
  type ProviderJSONResponseContext,
} from "../providers/http";
import {
  externalWorkCacheIdentity,
  normalizeDOI,
  relatedWorkStableAliases,
} from "./citationIdentifiers";
import {
  cachedExternalWorkMetadata,
  saveExternalWorkCacheSuccesses,
} from "./externalWorkCacheService";
import {
  mergeRelatedWorkHydrationState,
  projectRelatedWorkSummary,
  stampRelatedWorkFieldGroups,
  type RelatedWorkFieldGroup,
} from "./relatedWorkHydrationState";

interface S2Paper {
  paperId?: string;
  externalIds?: { DOI?: string; PubMed?: string; ArXiv?: string };
  title?: string;
  abstract?: string;
  year?: number;
  authors?: Array<{ authorId?: string; name?: string }>;
  venue?: string;
  publicationVenue?: { name?: string };
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  publicationTypes?: string[];
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
  authorships?: Array<{
    author?: { id?: string; display_name?: string; orcid?: string | null };
  }>;
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
  primary_location?: {
    source?: {
      id?: string;
      display_name?: string;
      summary_stats?: {
        "2yr_mean_citedness"?: number | null;
        h_index?: number | null;
        i10_index?: number | null;
      } | null;
    } | null;
  } | null;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortOpenAlexID(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.replace(/^https:\/\/openalex\.org\//i, "") : null;
}

function abstractFromIndex(
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

function sourceMetrics(work: OpenAlexWork): SourceMetrics | null {
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

function semanticScholarMetadata(paper: S2Paper): RelatedWorkMetadata | null {
  const providerWorkID = stringOrNull(paper.paperId);
  const title = stringOrNull(paper.title);
  if (!providerWorkID || !title) return null;
  const groups: RelatedWorkFieldGroup[] = ["summary"];
  if (paper.abstract !== undefined) groups.push("abstract");
  if (paper.influentialCitationCount !== undefined) {
    groups.push("normalized-impact");
  }
  if (paper.isOpenAccess !== undefined) groups.push("open-access");
  if (paper.publicationTypes !== undefined) {
    groups.push("publication-details");
  }
  return stampRelatedWorkFieldGroups(
    {
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
      abstract: stringOrNull(paper.abstract),
      citationCount: numberOrNull(paper.citationCount),
      referenceCount: numberOrNull(paper.referenceCount),
      influentialCitationCount: numberOrNull(paper.influentialCitationCount),
      isOpenAccess:
        typeof paper.isOpenAccess === "boolean" ? paper.isOpenAccess : null,
      openAccessStatus: paper.isOpenAccess ? "open" : null,
      publicationType: stringOrNull(paper.publicationTypes?.join(", ")),
      dataSources: ["semantic-scholar"],
    },
    groups,
  );
}

function openAlexMetadata(work: OpenAlexWork): RelatedWorkMetadata | null {
  const providerWorkID = shortOpenAlexID(work.id);
  const title = stringOrNull(work.display_name ?? work.title);
  if (!providerWorkID || !title) return null;
  const counts = (work.counts_by_year ?? [])
    .map((entry) => ({
      year: Number(entry.year),
      count: Number(entry.cited_by_count),
    }))
    .filter(
      (entry) => Number.isInteger(entry.year) && Number.isFinite(entry.count),
    );
  const trend = yearlyMetrics(counts);
  const metrics = sourceMetrics(work);
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
  if (metrics) groups.push("source-metrics");
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
      sourceMetrics: metrics,
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

function collectSemanticScholarPapers(data: unknown): S2Paper[] {
  const found: S2Paper[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.paperId === "string" && record.title) {
      found.push(record as S2Paper);
      return;
    }
    visit(record.citedPaper);
    visit(record.citingPaper);
    visit(record.recommendedPapers);
    visit(record.data);
  };
  visit(data);
  return found;
}

function collectOpenAlexWorks(data: unknown): OpenAlexWork[] {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) {
    return data.filter((entry): entry is OpenAlexWork =>
      Boolean(entry && typeof entry === "object" && "id" in entry),
    );
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.results)) {
    return collectOpenAlexWorks(record.results);
  }
  return typeof record.id === "string" ? [record as OpenAlexWork] : [];
}

function mergeMetadata(
  current: RelatedWorkMetadata | null,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  if (!current) return incoming;
  const sources = new Set([
    ...(current.dataSources ?? []),
    ...(incoming.dataSources ?? []),
  ]);
  const merged = {
    ...current,
    providerWorkID: current.providerWorkID ?? incoming.providerWorkID,
    doi: current.doi ?? incoming.doi,
    pmid: current.pmid ?? incoming.pmid,
    arxiv: current.arxiv ?? incoming.arxiv,
    isbn: current.isbn ?? incoming.isbn,
    title: String(current.title ?? "").trim() ? current.title : incoming.title,
    year: current.year ?? incoming.year,
    authors:
      current.authors.length >= incoming.authors.length
        ? current.authors
        : incoming.authors,
    authorIDs:
      (current.authorIDs?.length ?? 0) >= (incoming.authorIDs?.length ?? 0)
        ? current.authorIDs
        : incoming.authorIDs,
    sourceTitle: current.sourceTitle ?? incoming.sourceTitle,
    abstract: current.abstract ?? incoming.abstract,
    citationCount:
      current.citationCount == null
        ? incoming.citationCount
        : incoming.citationCount == null
          ? current.citationCount
          : Math.max(current.citationCount, incoming.citationCount),
    referenceCount:
      current.referenceCount == null
        ? incoming.referenceCount
        : incoming.referenceCount == null
          ? current.referenceCount
          : Math.max(current.referenceCount, incoming.referenceCount),
    citationCountsByYear: current.citationCountsByYear?.length
      ? current.citationCountsByYear
      : incoming.citationCountsByYear,
    references:
      (current.references?.length ?? 0) >= (incoming.references?.length ?? 0)
        ? current.references
        : incoming.references,
    resolvedReferenceCount: Math.max(
      current.resolvedReferenceCount ?? 0,
      incoming.resolvedReferenceCount ?? 0,
    ),
    fwci: current.fwci ?? incoming.fwci,
    citationPercentile:
      current.citationPercentile ?? incoming.citationPercentile,
    isTop1Percent: current.isTop1Percent ?? incoming.isTop1Percent,
    isTop10Percent: current.isTop10Percent ?? incoming.isTop10Percent,
    citationsLastYear: current.citationsLastYear ?? incoming.citationsLastYear,
    citationVelocity: current.citationVelocity ?? incoming.citationVelocity,
    citationAcceleration:
      current.citationAcceleration ?? incoming.citationAcceleration,
    influentialCitationCount:
      current.influentialCitationCount ?? incoming.influentialCitationCount,
    publicationType: current.publicationType ?? incoming.publicationType,
    sourceMetrics: current.sourceMetrics ?? incoming.sourceMetrics,
    isOpenAccess: current.isOpenAccess ?? incoming.isOpenAccess,
    openAccessStatus: current.openAccessStatus ?? incoming.openAccessStatus,
    isRetracted: current.isRetracted ?? incoming.isRetracted,
    dataSources: [...sources],
    updatedAt: incoming.updatedAt ?? current.updatedAt,
  };
  return mergeRelatedWorkHydrationState(merged, incoming);
}

function isRelationshipResponse(url: string): boolean {
  if (/\/(?:references|citations)(?:\?|$)/i.test(url)) return true;
  try {
    const parsed = new URL(url);
    const filter = parsed.searchParams.get("filter") ?? "";
    if (/^cites:/i.test(filter)) return true;
    return false;
  } catch {
    return false;
  }
}

let persistenceTail: Promise<void> = Promise.resolve();

async function persistProviderResponse(
  context: ProviderJSONResponseContext,
): Promise<void> {
  const records: RelatedWorkMetadata[] =
    context.provider === "semantic-scholar"
      ? collectSemanticScholarPapers(context.data)
          .map(semanticScholarMetadata)
          .filter((work): work is RelatedWorkMetadata => Boolean(work))
      : context.provider === "openalex"
        ? collectOpenAlexWorks(context.data)
            .map(openAlexMetadata)
            .filter((work): work is RelatedWorkMetadata => Boolean(work))
        : [];
  if (!records.length) return;

  const summaryOnly = isRelationshipResponse(context.url);
  const entries = new Map<string, RelatedWorkMetadata>();
  for (const raw of records) {
    const work = summaryOnly ? projectRelatedWorkSummary(raw) : raw;
    const aliases = new Set([
      ...relatedWorkStableAliases(work),
      externalWorkCacheIdentity(work),
    ]);
    for (const alias of aliases) {
      if (!alias) continue;
      const cached = cachedExternalWorkMetadata(alias);
      entries.set(alias, mergeMetadata(cached, work));
    }
  }
  await saveExternalWorkCacheSuccesses(
    [...entries].map(([identityKey, metadata]) => ({ identityKey, metadata })),
  );
}

registerProviderJSONResponseObserver((context) => {
  persistenceTail = persistenceTail
    .catch(() => undefined)
    .then(() => persistProviderResponse(context));
  return persistenceTail;
});
