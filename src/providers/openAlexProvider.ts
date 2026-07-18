import type {
  CitationYearCount,
  IdentifierKind,
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  referenced_works_count?: number | null;
  referenced_works?: string[];
  fwci?: number | null;
  citation_normalized_percentile?: {
    value?: number | null;
    is_in_top_1_percent?: boolean | null;
    is_in_top_10_percent?: boolean | null;
  } | null;
  counts_by_year?: Array<{
    year?: number | null;
    cited_by_count?: number | null;
  }>;
  is_retracted?: boolean | null;
  open_access?: {
    is_oa?: boolean | null;
    oa_status?: string | null;
  } | null;
  type?: string | null;
  authorships?: Array<{
    author?: {
      display_name?: string | null;
    };
  }>;
}

function getLookupIdentifier(
  identifiers: WorkIdentifiers,
): { kind: IdentifierKind; value: string } | null {
  if (identifiers.doi) {
    return { kind: "doi", value: identifiers.doi };
  }
  if (identifiers.pmid) {
    return { kind: "pmid", value: identifiers.pmid };
  }
  if (identifiers.arxiv) {
    return { kind: "arxiv", value: identifiers.arxiv };
  }
  if (identifiers.isbn) {
    return { kind: "isbn", value: identifiers.isbn };
  }
  return null;
}

function shortOpenAlexID(value: unknown): string | null {
  const text = stringOrNull(value);
  return text?.replace(/^https:\/\/openalex\.org\//i, "") ?? null;
}

function mapReferences(work: OpenAlexWork): RelatedWorkMetadata[] {
  return (work.referenced_works ?? [])
    .map((id) => shortOpenAlexID(id))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({
      providerWorkID: id,
      doi: null,
      title: null,
      year: null,
      authors: [],
    }));
}

function mapCitationCountsByYear(work: OpenAlexWork): CitationYearCount[] {
  return (work.counts_by_year ?? [])
    .map((entry) => ({
      year: Number(entry.year),
      count: Number(entry.cited_by_count),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.year) &&
        entry.year > 0 &&
        Number.isFinite(entry.count) &&
        entry.count >= 0,
    )
    .sort((left, right) => left.year - right.year);
}

function deriveRecentCitationMetrics(counts: CitationYearCount[]): {
  citationsLastYear: number | null;
  citationVelocity: number | null;
  citationAcceleration: number | null;
} {
  if (counts.length === 0) {
    return {
      citationsLastYear: null,
      citationVelocity: null,
      citationAcceleration: null,
    };
  }

  const countByYear = new Map(counts.map((entry) => [entry.year, entry.count]));
  const latestCompleteYear = new Date().getUTCFullYear() - 1;
  const previousYear = latestCompleteYear - 1;
  const recentYears = [
    latestCompleteYear - 2,
    previousYear,
    latestCompleteYear,
  ];
  const citationsLastYear = countByYear.get(latestCompleteYear) ?? 0;
  const citationVelocity =
    recentYears.reduce((sum, year) => sum + (countByYear.get(year) ?? 0), 0) /
    recentYears.length;
  const citationAcceleration =
    citationsLastYear - (countByYear.get(previousYear) ?? 0);

  return {
    citationsLastYear,
    citationVelocity,
    citationAcceleration,
  };
}

export const openAlexProvider: CitationProvider = {
  id: "openalex",
  label: "OpenAlex",

  supports(identifiers) {
    return Boolean(
      identifiers.doi ||
      identifiers.pmid ||
      identifiers.arxiv ||
      identifiers.isbn,
    );
  },

  async lookup(identifiers: WorkIdentifiers): Promise<ProviderLookupResult> {
    const lookup = getLookupIdentifier(identifiers);

    if (!lookup) {
      return {
        status: "no-identifier",
        provider: "openalex",
        message: "OpenAlex requires a DOI, PMID, arXiv ID, or ISBN.",
      };
    }

    const select = [
      "id",
      "doi",
      "title",
      "display_name",
      "publication_year",
      "cited_by_count",
      "referenced_works_count",
      "referenced_works",
      "authorships",
      "fwci",
      "citation_normalized_percentile",
      "counts_by_year",
      "is_retracted",
      "open_access",
      "type",
    ].join(",");

    const url =
      `https://api.openalex.org/works/${lookup.kind}:` +
      `${encodeURIComponent(lookup.value)}?select=${encodeURIComponent(select)}`;

    const response = await requestJSON<OpenAlexWork>("openalex", url);

    if (!response.ok || !response.data) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "openalex",
        message:
          response.status === 401 || response.status === 403
            ? "Anonymous OpenAlex access was rejected; automatic mode will try another free provider."
            : response.message,
      };
    }

    const work = response.data;
    const authors = (work.authorships ?? [])
      .map((entry) => stringOrNull(entry.author?.display_name))
      .filter((name): name is string => Boolean(name));
    const references = mapReferences(work);
    const citationCountsByYear = mapCitationCountsByYear(work);
    const recentMetrics = deriveRecentCitationMetrics(citationCountsByYear);

    return {
      status: "success",
      provider: "openalex",
      matchedBy: lookup.kind,
      providerWorkID: shortOpenAlexID(work.id),
      doi: normalizeDOI(work.doi),
      title: stringOrNull(work.title ?? work.display_name),
      year: numberOrNull(work.publication_year),
      authors,
      citationCount: numberOrNull(work.cited_by_count),
      citationCountProvider: "openalex",
      referenceCount: numberOrNull(work.referenced_works_count),
      referenceCountProvider: "openalex",
      resolvedReferenceCount: references.length,
      references,
      fwci: numberOrNull(work.fwci),
      citationPercentile: numberOrNull(
        work.citation_normalized_percentile?.value,
      ),
      isTop1Percent:
        typeof work.citation_normalized_percentile?.is_in_top_1_percent ===
        "boolean"
          ? work.citation_normalized_percentile.is_in_top_1_percent
          : null,
      isTop10Percent:
        typeof work.citation_normalized_percentile?.is_in_top_10_percent ===
        "boolean"
          ? work.citation_normalized_percentile.is_in_top_10_percent
          : null,
      citationCountsByYear,
      ...recentMetrics,
      isRetracted:
        typeof work.is_retracted === "boolean" ? work.is_retracted : null,
      openAccessStatus: stringOrNull(work.open_access?.oa_status),
      isOpenAccess:
        typeof work.open_access?.is_oa === "boolean"
          ? work.open_access.is_oa
          : null,
      publicationType: stringOrNull(work.type),
    };
  },
};
