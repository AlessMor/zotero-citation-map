import type {
  ProviderLookupResult,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  matchWorkIdentifiers,
  normalizeDOI,
  normalizeExactTitle,
} from "../domain/workIdentity";
import { requestJSON } from "./http";
import {
  crossrefReferenceMetadata,
  crossrefWorkMetadata,
  type CrossrefWork,
} from "./crossrefMapper";
import type { CitationProvider, ProviderRequestOptions } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface CrossrefSingleResponse {
  status?: string;
  message?: CrossrefWork;
}
interface CrossrefListResponse {
  status?: string;
  message?: { items?: CrossrefWork[] };
}

function successFromWork(
  work: CrossrefWork,
  matchedBy: "doi" | "isbn" | "title",
  confidence: number,
): ProviderLookupSuccess {
  const related = crossrefWorkMetadata(work);
  const references = (work.reference ?? []).map(crossrefReferenceMetadata);
  return {
    status: "success",
    provider: "crossref",
    matchedBy,
    matchConfidence: confidence,
    providerWorkID: normalizeDOI(work.DOI),
    doi: normalizeDOI(work.DOI),
    title: related?.title ?? null,
    year: related?.year ?? null,
    publicationDate: related?.publicationDate ?? null,
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

async function fetchDOI(
  doi: string,
  options?: ProviderRequestOptions,
): Promise<ProviderLookupResult> {
  const response = await requestJSON<CrossrefSingleResponse>(
    "crossref",
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { signal: options?.signal },
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
  options?: ProviderRequestOptions,
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
    { signal: options?.signal },
  );
  if (!response.ok || !response.data?.message) {
    return {
      status: failureStatusFromHTTP(response.status),
      provider: "crossref",
      message: response.message || "Crossref search failed.",
    };
  }
  const candidates = (response.data.message.items ?? [])
    .map(crossrefWorkMetadata)
    .filter((work): work is RelatedWorkMetadata => Boolean(work));
  const exact = candidates.filter(
    (candidate) =>
      normalizeExactTitle(candidate.title) === identifiers.normalizedTitle,
  );
  const compatible = exact.filter(
    (candidate) =>
      matchWorkIdentifiers(identifiers, candidate).decision === "same-work",
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
  lookup: async (identifiers, options) => {
    if (identifiers.doi) return fetchDOI(identifiers.doi, options);
    if (identifiers.isbn) {
      return searchWorks(identifiers, identifiers.isbn, "isbn", options);
    }
    return {
      status: "no-identifier",
      provider: "crossref",
      message: "Crossref needs a DOI or ISBN.",
    };
  },
  searchExactTitle: (identifiers, options) =>
    searchWorks(identifiers, identifiers.title, "title", options),
};
