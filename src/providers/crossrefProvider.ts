import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface CrossrefReference {
  DOI?: string;
  doi?: string;
  "article-title"?: string;
  unstructured?: string;
  author?: string;
  year?: string | number;
}

interface CrossrefMessage {
  DOI?: string;
  title?: string[];
  author?: Array<{
    given?: string;
    family?: string;
    name?: string;
  }>;
  issued?: {
    "date-parts"?: number[][];
  };
  "is-referenced-by-count"?: number;
  "reference-count"?: number;
  reference?: CrossrefReference[];
}

interface CrossrefResponse {
  status?: string;
  message?: CrossrefMessage;
}

function getAuthors(message: CrossrefMessage): string[] {
  return (message.author ?? [])
    .map((author) => {
      const literal = stringOrNull(author.name);
      if (literal) {
        return literal;
      }

      return [author.given, author.family]
        .map((part) => stringOrNull(part))
        .filter((part): part is string => Boolean(part))
        .join(" ");
    })
    .filter(Boolean);
}

function getYear(message: CrossrefMessage): number | null {
  return numberOrNull(message.issued?.["date-parts"]?.[0]?.[0]);
}

function mapReferences(
  references: CrossrefReference[] | undefined,
): RelatedWorkMetadata[] {
  return (references ?? []).map((reference) => ({
    providerWorkID: null,
    doi: normalizeDOI(reference.DOI ?? reference.doi),
    title: stringOrNull(reference["article-title"] ?? reference.unstructured),
    year: numberOrNull(reference.year),
    authors: stringOrNull(reference.author)
      ? [String(reference.author).trim()]
      : [],
  }));
}

export const crossrefProvider: CitationProvider = {
  id: "crossref",
  label: "Crossref",

  supports(identifiers) {
    return Boolean(identifiers.doi);
  },

  async lookup(identifiers: WorkIdentifiers): Promise<ProviderLookupResult> {
    if (!identifiers.doi) {
      return {
        status: "no-identifier",
        provider: "crossref",
        message: "Crossref requires a DOI.",
      };
    }

    const url =
      "https://api.crossref.org/works/" + encodeURIComponent(identifiers.doi);

    const response = await requestJSON<CrossrefResponse>("crossref", url);

    if (!response.ok || !response.data?.message) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "crossref",
        message: response.message,
      };
    }

    const message = response.data.message;
    const references = mapReferences(message.reference);
    const declaredReferenceCount = numberOrNull(message["reference-count"]);

    return {
      status: "success",
      provider: "crossref",
      matchedBy: "doi",
      providerWorkID: normalizeDOI(message.DOI) ?? identifiers.doi,
      doi: normalizeDOI(message.DOI) ?? identifiers.doi,
      title: stringOrNull(message.title?.[0]),
      year: getYear(message),
      authors: getAuthors(message),
      citationCount: numberOrNull(message["is-referenced-by-count"]),
      citationCountProvider: "crossref",
      referenceCount:
        declaredReferenceCount === null
          ? references.length
          : Math.max(declaredReferenceCount, references.length),
      referenceCountProvider: "crossref",
      resolvedReferenceCount: references.length,
      references,
    };
  },
};
