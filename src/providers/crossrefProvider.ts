import type {
  ProviderLookupResult,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
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

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}
interface CrossrefReference {
  DOI?: string;
  doi?: string;
  "article-title"?: string;
  author?: string;
  year?: string;
  "journal-title"?: string;
}
interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  published?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  abstract?: string;
  type?: string;
  "is-referenced-by-count"?: number;
  "reference-count"?: number;
  reference?: CrossrefReference[];
  license?: Array<{ URL?: string; "delay-in-days"?: number }>;
  "update-to"?: Array<{ type?: string; DOI?: string; label?: string }>;
  relation?: Record<string, Array<{ id?: string; "id-type"?: string }>>;
}
interface CrossrefSingleResponse {
  status?: string;
  message?: CrossrefWork;
}
interface CrossrefListResponse {
  status?: string;
  message?: { items?: CrossrefWork[] };
}

function yearFromWork(work: CrossrefWork): number | null {
  const parts = work.published?.["date-parts"] ?? work.issued?.["date-parts"];
  const year = parts?.[0]?.[0];
  return Number.isFinite(year) ? Number(year) : null;
}

function authorNames(work: CrossrefWork): string[] {
  return (work.author ?? [])
    .map((author) =>
      String(
        author.name ?? [author.given, author.family].filter(Boolean).join(" "),
      ).trim(),
    )
    .filter(Boolean);
}

function stripMarkup(value: unknown): string | null {
  const text = String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function relationIsRetraction(work: CrossrefWork): boolean {
  if (
    (work["update-to"] ?? []).some((entry) =>
      /retract/i.test(`${entry.type ?? ""} ${entry.label ?? ""}`),
    )
  ) {
    return true;
  }
  return Object.keys(work.relation ?? {}).some((key) => /retract/i.test(key));
}

function referenceMetadata(reference: CrossrefReference): RelatedWorkMetadata {
  const year = Number(reference.year);
  return {
    provider: "crossref",
    providerWorkID: normalizeDOI(reference.DOI ?? reference.doi),
    doi: normalizeDOI(reference.DOI ?? reference.doi),
    title: stringOrNull(reference["article-title"]),
    year: Number.isFinite(year) ? year : null,
    authors: reference.author ? [reference.author] : [],
    sourceTitle: stringOrNull(reference["journal-title"]),
  };
}

function workToRelated(work: CrossrefWork): RelatedWorkMetadata | null {
  const title = stringOrNull(work.title?.[0]);
  if (!title) return null;
  return {
    provider: "crossref",
    providerWorkID: normalizeDOI(work.DOI),
    doi: normalizeDOI(work.DOI),
    title,
    year: yearFromWork(work),
    authors: authorNames(work),
    sourceTitle: stringOrNull(work["container-title"]?.[0]),
    abstract: stripMarkup(work.abstract),
    citationCount: numberOrNull(work["is-referenced-by-count"]),
    referenceCount: numberOrNull(work["reference-count"]),
    isRetracted: relationIsRetraction(work),
    isOpenAccess: (work.license ?? []).some(
      (license) =>
        license["delay-in-days"] === 0 ||
        /creativecommons|open/i.test(String(license.URL ?? "")),
    ),
  };
}

function successFromWork(
  work: CrossrefWork,
  matchedBy: "doi" | "isbn" | "title",
  confidence: number,
): ProviderLookupSuccess {
  const related = workToRelated(work);
  const references = (work.reference ?? []).map(referenceMetadata);
  return {
    status: "success",
    provider: "crossref",
    matchedBy,
    matchConfidence: confidence,
    providerWorkID: normalizeDOI(work.DOI),
    doi: normalizeDOI(work.DOI),
    title: related?.title ?? null,
    year: related?.year ?? null,
    authors: related?.authors ?? [],
    sourceTitle: related?.sourceTitle ?? null,
    abstract: related?.abstract ?? null,
    citationCount: related?.citationCount ?? null,
    citationCountProvider: "crossref",
    referenceCount: numberOrNull(work["reference-count"]) ?? references.length,
    referenceCountProvider: "crossref",
    resolvedReferenceCount: references.filter(
      (reference) => reference.doi || reference.title,
    ).length,
    references,
    fwci: null,
    citationPercentile: null,
    isTop1Percent: null,
    isTop10Percent: null,
    citationCountsByYear: [],
    citationsLastYear: null,
    citationVelocity: null,
    citationAcceleration: null,
    influentialCitationCount: null,
    isRetracted: related?.isRetracted ?? null,
    openAccessStatus: related?.isOpenAccess ? "open" : null,
    isOpenAccess: related?.isOpenAccess ?? null,
    publicationType: stringOrNull(work.type),
    sourceMetrics: null,
  };
}

async function fetchDOI(doi: string): Promise<ProviderLookupResult> {
  const response = await requestJSON<CrossrefSingleResponse>(
    "crossref",
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  );
  if (!response.ok || !response.data?.message) {
    return {
      status: failureStatusFromHTTP(response.status),
      provider: "crossref",
      message: response.message || "Crossref did not return a matching work.",
    };
  }
  return successFromWork(response.data.message, "doi", 1);
}

async function searchWorks(
  identifiers: WorkIdentifiers,
  query: string,
  matchedBy: "isbn" | "title",
): Promise<ProviderLookupResult> {
  const select = [
    "DOI",
    "title",
    "author",
    "published",
    "issued",
    "container-title",
    "abstract",
    "type",
    "is-referenced-by-count",
    "reference-count",
    "reference",
    "license",
    "update-to",
    "relation",
  ].join(",");
  const response = await requestJSON<CrossrefListResponse>(
    "crossref",
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=10&select=${encodeURIComponent(select)}`,
  );
  if (!response.ok || !response.data?.message) {
    return {
      status: failureStatusFromHTTP(response.status),
      provider: "crossref",
      message: response.message || "Crossref search failed.",
    };
  }
  const candidates = (response.data.message.items ?? [])
    .map(workToRelated)
    .filter((work): work is RelatedWorkMetadata => Boolean(work));
  const exact = candidates.filter(
    (candidate) =>
      normalizeExactTitle(candidate.title) === identifiers.normalizedTitle,
  );
  const compatible = exact.filter((candidate) =>
    metadataIsNonContradictory(identifiers, candidate),
  );
  if (compatible.length === 1) {
    const item = (response.data.message.items ?? []).find(
      (work) => normalizeDOI(work.DOI) === compatible[0].doi,
    );
    if (item)
      return successFromWork(
        item,
        matchedBy,
        matchedBy === "title" ? 0.92 : 0.98,
      );
  }
  if (exact.length > 0) {
    return {
      status: "ambiguous-match",
      provider: "crossref",
      message:
        "Crossref returned multiple or contradictory exact-title matches.",
      candidates: exact,
    };
  }
  return {
    status: "not-found",
    provider: "crossref",
    message: "Crossref did not return a unique exact-title match.",
  };
}

export const crossrefProvider: CitationProvider = {
  id: "crossref",
  label: "Crossref",
  capabilities: {
    identifiers: {
      doi: true,
      pmid: false,
      arxiv: false,
      isbn: true,
      titleSearch: true,
    },
    citationCount: true,
    referenceCount: true,
    citingWorks: false,
    referencedWorks: true,
    abstract: true,
    openAccess: true,
    retraction: true,
    sourceMetrics: false,
  },
  supports: (identifiers) => Boolean(identifiers.doi || identifiers.isbn),
  lookup: async (identifiers) => {
    if (identifiers.doi) return fetchDOI(identifiers.doi);
    if (identifiers.isbn) {
      return searchWorks(identifiers, identifiers.isbn, "isbn");
    }
    return {
      status: "no-identifier",
      provider: "crossref",
      message: "Crossref needs a DOI or ISBN.",
    };
  },
  searchExactTitle: (identifiers) =>
    searchWorks(identifiers, identifiers.title, "title"),
};
