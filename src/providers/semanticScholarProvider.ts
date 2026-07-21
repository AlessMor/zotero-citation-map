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

interface S2Author {
  name?: string;
}
interface S2Paper {
  paperId?: string;
  externalIds?: { DOI?: string; PubMed?: string; ArXiv?: string };
  title?: string;
  abstract?: string;
  year?: number;
  authors?: S2Author[];
  venue?: string;
  publicationVenue?: { name?: string };
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string } | null;
  publicationTypes?: string[];
}
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

const BACKGROUND_REFERENCE_LIMIT = 200;
const MAX_RELATION_PAGE_SIZE = 200;
export const SEMANTIC_SCHOLAR_BATCH_LIMIT = 500;

const BASIC_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "year",
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

function authors(paper: S2Paper): string[] {
  return (paper.authors ?? [])
    .map((author) => String(author.name ?? "").trim())
    .filter(Boolean);
}

function toRelated(paper: S2Paper): RelatedWorkMetadata | null {
  const title = stringOrNull(paper.title);
  const paperID = stringOrNull(paper.paperId);
  if (!title || !paperID) return null;
  return {
    provider: "semantic-scholar",
    providerWorkID: paperID,
    doi: normalizeDOI(paper.externalIds?.DOI),
    pmid: stringOrNull(paper.externalIds?.PubMed),
    arxiv: stringOrNull(paper.externalIds?.ArXiv),
    title,
    year: numberOrNull(paper.year),
    authors: authors(paper),
    sourceTitle: stringOrNull(paper.publicationVenue?.name ?? paper.venue),
    abstract: stringOrNull(paper.abstract),
    citationCount: numberOrNull(paper.citationCount),
    referenceCount: numberOrNull(paper.referenceCount),
    isOpenAccess:
      typeof paper.isOpenAccess === "boolean" ? paper.isOpenAccess : null,
    openAccessStatus: paper.isOpenAccess ? "open" : null,
    isRetracted: null,
  };
}

export async function fetchSemanticScholarPapersBatch(
  identifiers: string[],
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
): Promise<RelatedWorkMetadata[]> {
  const response = await requestJSON<S2RelationResponse>(
    "semantic-scholar",
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperID)}/${kind}?offset=${Math.max(0, offset)}&limit=${Math.min(MAX_RELATION_PAGE_SIZE, maximum)}&fields=${encodeURIComponent(BASIC_FIELDS)}`,
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
  includeReferences = true,
): Promise<ProviderLookupSuccess> {
  const related = toRelated(paper);
  const paperID = String(paper.paperId ?? "");
  const references =
    includeReferences && paperID
      ? await fetchRelations(paperID, "references", BACKGROUND_REFERENCE_LIMIT)
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
  );
}

async function lookup(
  identifiers: WorkIdentifiers,
): Promise<ProviderLookupResult> {
  return lookupPaper(identifiers, true);
}

async function lookupForRelations(
  identifiers: WorkIdentifiers,
): Promise<ProviderLookupResult> {
  return lookupPaper(identifiers, false);
}

async function searchExactTitle(
  identifiers: WorkIdentifiers,
): Promise<ProviderLookupResult> {
  const response = await requestJSON<S2SearchResponse>(
    "semantic-scholar",
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(identifiers.title)}&limit=20&fields=${encodeURIComponent(BASIC_FIELDS)}`,
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
  const compatible = exactPapers.filter((paper) =>
    metadataIsNonContradictory(identifiers, {
      year: numberOrNull(paper.year),
      authors: authors(paper),
    }),
  );
  if (compatible.length === 1) {
    return successFromPaper(compatible[0], "title", 0.92);
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
  return {
    status: "not-found",
    provider: "semantic-scholar",
    message: "Semantic Scholar did not return a unique exact-title match.",
  };
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
  fetchCitingWorks: (paperID, maximum, offset) =>
    fetchRelations(paperID, "citations", maximum, offset),
  fetchReferencedWorks: (paperID, maximum, offset) =>
    fetchRelations(paperID, "references", maximum, offset),
};
