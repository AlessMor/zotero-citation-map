import type {
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
    const references = mapReferences(work);
    const declaredReferenceCount = numberOrNull(work.referenced_works_count);
    const authors = (work.authorships ?? [])
      .map((entry) => stringOrNull(entry.author?.display_name))
      .filter((name): name is string => Boolean(name));

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
      referenceCount:
        declaredReferenceCount === null
          ? references.length
          : Math.max(declaredReferenceCount, references.length),
      referenceCountProvider: "openalex",
      resolvedReferenceCount: references.length,
      references,
    };
  },
};
