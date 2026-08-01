import type {
  ProviderLookupResult,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  matchWorkIdentifiers,
  normalizeExactTitle,
} from "../domain/workIdentity";
import { requestJSON } from "./http";
import {
  semanticScholarWork as toRelated,
  type SemanticScholarPaper as S2Paper,
} from "./semanticScholarMapper";
import type { CitationProvider, ProviderRequestOptions } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface S2SearchResponse {
  data?: S2Paper[];
}
interface S2Relation {
  citedPaper?: S2Paper;
  citingPaper?: S2Paper;
}
interface S2RelationResponse {
  data?: S2Relation[];
  next?: number;
}
interface S2RecommendationResponse {
  recommendedPapers?: S2Paper[];
}

const BACKGROUND_REFERENCE_LIMIT = 200;
const MAX_RELATION_PAGE_SIZE = 1000;
const MAX_RECOMMENDATIONS = 500;
export const SEMANTIC_SCHOLAR_BATCH_LIMIT = 500;

const BASIC_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "year",
  "publicationDate",
  "authors",
  "venue",
  "publicationVenue",
  "citationCount",
  "referenceCount",
  "influentialCitationCount",
  "isOpenAccess",
  "openAccessPdf",
  "publicationTypes",
].join(",");

const RELATIONSHIP_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "year",
  "publicationDate",
  "authors",
  "venue",
  "publicationVenue",
  "citationCount",
  "referenceCount",
  "influentialCitationCount",
  "isOpenAccess",
  "publicationTypes",
].join(",");

export async function fetchSemanticScholarPapersBatch(
  identifiers: string[],
  options?: ProviderRequestOptions,
): Promise<Array<RelatedWorkMetadata | null>> {
  if (!identifiers.length) return [];
  if (identifiers.length > SEMANTIC_SCHOLAR_BATCH_LIMIT) {
    throw new Error(
      `Semantic Scholar batch exceeds ${SEMANTIC_SCHOLAR_BATCH_LIMIT} papers.`,
    );
  }
  const response = await requestJSON<Array<S2Paper | null>>(
    "semantic-scholar",
    `https://api.semanticscholar.org/graph/v1/paper/batch?fields=${encodeURIComponent(BASIC_FIELDS)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { ids: identifiers },
      signal: options?.signal,
    },
  );
  if (!response.ok || !Array.isArray(response.data)) {
    throw new Error(
      response.message || "Semantic Scholar batch metadata lookup failed.",
    );
  }
  return identifiers.map((_, index) => {
    const paper = response.data?.[index];
    return paper ? toRelated(paper) : null;
  });
}

async function fetchRelations(
  paperID: string,
  kind: "references" | "citations",
  maximum: number,
  offset = 0,
  options?: ProviderRequestOptions,
): Promise<RelatedWorkMetadata[]> {
  const response = await requestJSON<S2RelationResponse>(
    "semantic-scholar",
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperID)}/${kind}?offset=${Math.max(0, offset)}&limit=${Math.min(MAX_RELATION_PAGE_SIZE, maximum)}&fields=${encodeURIComponent(RELATIONSHIP_FIELDS)}`,
    { signal: options?.signal },
  );
  if (!response.ok || !response.data) return [];
  return (response.data.data ?? [])
    .map((entry) =>
      toRelated(
        kind === "references"
          ? (entry.citedPaper ?? {})
          : (entry.citingPaper ?? {}),
      ),
    )
    .filter((work): work is RelatedWorkMetadata => Boolean(work));
}

async function successFromPaper(
  paper: S2Paper,
  matchedBy: "doi" | "pmid" | "arxiv" | "isbn" | "title",
  confidence: number,
  includeReferences = false,
  options?: ProviderRequestOptions,
): Promise<ProviderLookupSuccess> {
  const related = toRelated(paper);
  const paperID = String(paper.paperId ?? "");
  const references =
    includeReferences && paperID
      ? await fetchRelations(
          paperID,
          "references",
          BACKGROUND_REFERENCE_LIMIT,
          0,
          options,
        )
      : [];
  return {
    status: "success",
    provider: "semantic-scholar",
    matchedBy,
    matchConfidence: confidence,
    providerWorkID: related?.providerWorkID ?? null,
    doi: related?.doi ?? null,
    title: related?.title ?? null,
    year: related?.year ?? null,
    publicationDate: related?.publicationDate ?? null,
    authors: related?.authors ?? [],
    sourceTitle: related?.sourceTitle ?? null,
    abstract: related?.abstract ?? null,
    citationCount: related?.citationCount ?? null,
    citationCountProvider: "semantic-scholar",
    referenceCount: related?.referenceCount ?? references.length,
    referenceCountProvider: "semantic-scholar",
    resolvedReferenceCount: references.length,
    references,
    fwci: null,
    citationPercentile: null,
    isTop1Percent: null,
    isTop10Percent: null,
    citationCountsByYear: [],
    citationsLastYear: null,
    citationVelocity: null,
    citationAcceleration: null,
    influentialCitationCount: numberOrNull(paper.influentialCitationCount),
    isRetracted: null,
    openAccessStatus: paper.isOpenAccess ? "open" : null,
    isOpenAccess:
      typeof paper.isOpenAccess === "boolean" ? paper.isOpenAccess : null,
    publicationType: stringOrNull(paper.publicationTypes?.join(", ")),
    sourceMetrics: null,
  };
}

function identifier(identifiers: WorkIdentifiers): {
  value: string;
  kind: "doi" | "pmid" | "arxiv" | "isbn";
} | null {
  if (identifiers.doi) return { value: `DOI:${identifiers.doi}`, kind: "doi" };
  if (identifiers.pmid)
    return { value: `PMID:${identifiers.pmid}`, kind: "pmid" };
  if (identifiers.arxiv)
    return { value: `ARXIV:${identifiers.arxiv}`, kind: "arxiv" };
  if (identifiers.isbn)
    return { value: `ISBN:${identifiers.isbn}`, kind: "isbn" };
  return null;
}

async function lookupPaper(
  identifiers: WorkIdentifiers,
  includeReferences: boolean,
  options?: ProviderRequestOptions,
): Promise<ProviderLookupResult> {
  const selected = identifier(identifiers);
  if (!selected) {
    return {
      status: "no-identifier",
      provider: "semantic-scholar",
      message: "Semantic Scholar needs a DOI, PMID, arXiv ID, or ISBN.",
    };
  }
  const response = await requestJSON<S2Paper>(
    "semantic-scholar",
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(selected.value)}?fields=${encodeURIComponent(BASIC_FIELDS)}`,
    { signal: options?.signal },
  );
  if (!response.ok || !response.data?.paperId) {
    return {
      status: failureStatusFromHTTP(response.status),
      provider: "semantic-scholar",
      message:
        response.message || "Semantic Scholar did not return a matching work.",
    };
  }
  return successFromPaper(
    response.data,
    selected.kind,
    selected.kind === "doi" ? 1 : 0.98,
    includeReferences,
    options,
  );
}

async function lookup(
  identifiers: WorkIdentifiers,
  options?: ProviderRequestOptions,
): Promise<ProviderLookupResult> {
  return lookupPaper(identifiers, false, options);
}

async function lookupForRelations(
  identifiers: WorkIdentifiers,
  options?: ProviderRequestOptions,
): Promise<ProviderLookupResult> {
  return lookupPaper(identifiers, false, options);
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

async function searchClosestTitle(
  identifiers: WorkIdentifiers,
  options?: ProviderRequestOptions,
): Promise<S2Paper | null> {
  const title = String(identifiers.title ?? "").trim();
  if (!title) return null;
  const response = await requestJSON<S2Paper>(
    "semantic-scholar",
    `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(title)}&fields=${encodeURIComponent(BASIC_FIELDS)}`,
    { signal: options?.signal },
  );
  if (!response.ok || !response.data?.paperId) return null;
  const candidate = response.data;
  const similarity = titleSimilarity(title, candidate.title);
  const exact = similarity === 1;
  const matchScore = Number(candidate.matchScore);
  const scoreIsUseful = Number.isFinite(matchScore) && matchScore >= 0.7;
  if (!exact && similarity < 0.72 && !scoreIsUseful) return null;
  const candidateWork = toRelated(candidate);
  if (
    (identifiers.year !== null || identifiers.authors.length > 0) &&
    (!candidateWork ||
      matchWorkIdentifiers(identifiers, candidateWork).decision !== "same-work")
  ) {
    return null;
  }
  return candidate;
}

async function searchExactTitle(
  identifiers: WorkIdentifiers,
  options?: ProviderRequestOptions,
): Promise<ProviderLookupResult> {
  const response = await requestJSON<S2SearchResponse>(
    "semantic-scholar",
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(identifiers.title)}&limit=20&fields=${encodeURIComponent(BASIC_FIELDS)}`,
    { signal: options?.signal },
  );
  if (!response.ok || !response.data) {
    return {
      status: failureStatusFromHTTP(response.status),
      provider: "semantic-scholar",
      message: response.message || "Semantic Scholar title search failed.",
    };
  }
  const exactPapers = (response.data.data ?? []).filter(
    (paper) => normalizeExactTitle(paper.title) === identifiers.normalizedTitle,
  );
  const compatible = exactPapers.filter((paper) => {
    const work = toRelated(paper);
    return Boolean(
      work && matchWorkIdentifiers(identifiers, work).decision === "same-work",
    );
  });
  if (compatible.length === 1) {
    return successFromPaper(compatible[0], "title", 0.92, false, options);
  }
  const candidates = exactPapers
    .map(toRelated)
    .filter((candidate): candidate is RelatedWorkMetadata =>
      Boolean(candidate),
    );
  if (candidates.length > 0) {
    return {
      status: "ambiguous-match",
      provider: "semantic-scholar",
      message:
        "Semantic Scholar returned multiple or contradictory exact-title matches.",
      candidates,
    };
  }

  // Similar-paper discovery must also work for a title-only Zotero item. The
  // match endpoint supplies the closest paper even when punctuation, subtitle,
  // or indexing differences prevent strict normalized equality.
  const closest = await searchClosestTitle(identifiers, options);
  if (closest) {
    const confidence = Math.max(
      0.75,
      Math.min(
        0.95,
        Number(closest.matchScore) ||
          titleSimilarity(identifiers.title, closest.title),
      ),
    );
    return successFromPaper(closest, "title", confidence, false, options);
  }

  return {
    status: "not-found",
    provider: "semantic-scholar",
    message: "Semantic Scholar did not return a reliable title match.",
  };
}

/** Resolve a seed paper to a Semantic Scholar paper ID. Unlike regular metric
 * lookup, this accepts a title-only Zotero item and uses the dedicated closest
 * title-match endpoint when no external identifier is available. */
export async function resolveSemanticScholarPaperID(
  identifiers: WorkIdentifiers,
  options?: ProviderRequestOptions,
): Promise<string | null> {
  const selected = identifier(identifiers);
  if (selected) {
    const response = await requestJSON<S2Paper>(
      "semantic-scholar",
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(selected.value)}?fields=paperId,title,year,authors`,
      { signal: options?.signal },
    );
    if (response.ok && response.data?.paperId) {
      return String(response.data.paperId);
    }
  }
  const closest = await searchClosestTitle(identifiers, options);
  return stringOrNull(closest?.paperId);
}

/** Return actual Semantic Scholar recommendations, not merely references or
 * citing papers. Multiple seeds are supplied as positive examples. */
export async function fetchSemanticScholarRecommendations(
  seeds: WorkIdentifiers[],
  maximum = 100,
  options?: ProviderRequestOptions,
): Promise<RelatedWorkMetadata[]> {
  const positivePaperIds: string[] = [];
  for (const seed of seeds.slice(0, 100)) {
    const paperID = await resolveSemanticScholarPaperID(seed, options);
    if (paperID && !positivePaperIds.includes(paperID)) {
      positivePaperIds.push(paperID);
    }
  }
  if (!positivePaperIds.length) return [];

  const limit = Math.min(MAX_RECOMMENDATIONS, Math.max(1, Math.floor(maximum)));
  const response = await requestJSON<S2RecommendationResponse>(
    "semantic-scholar",
    `https://api.semanticscholar.org/recommendations/v1/papers/?limit=${limit}&fields=${encodeURIComponent(BASIC_FIELDS)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { positivePaperIds, negativePaperIds: [] },
      signal: options?.signal,
    },
  );
  if (!response.ok || !response.data) return [];
  return (response.data.recommendedPapers ?? [])
    .map(toRelated)
    .filter((work): work is RelatedWorkMetadata => Boolean(work))
    .slice(0, limit);
}

export const semanticScholarProvider: CitationProvider = {
  id: "semantic-scholar",
  label: "Semantic Scholar",
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
    retraction: false,
    sourceMetrics: false,
  },
  supports: (identifiers) => Boolean(identifier(identifiers)),
  lookup,
  lookupForRelations,
  searchExactTitle,
  fetchCitingWorks: (paperID, maximum, offset, options) =>
    fetchRelations(paperID, "citations", maximum, offset, options),
  fetchReferencedWorks: (paperID, maximum, offset, options) =>
    fetchRelations(paperID, "references", maximum, offset, options),
};
