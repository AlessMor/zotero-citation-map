import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface InspireRecord {
  id?: string | number;
  metadata?: any;
}

function firstValue(value: any): any {
  return Array.isArray(value) ? value[0] : value;
}

function getDOI(metadata: any): string | null {
  const doiEntry = firstValue(metadata?.dois);
  return normalizeDOI(doiEntry?.value ?? doiEntry);
}

function getTitle(metadata: any): string | null {
  const entry = firstValue(metadata?.titles);
  return stringOrNull(entry?.title ?? entry);
}

function getYear(metadata: any): number | null {
  return (
    numberOrNull(metadata?.earliest_date?.slice?.(0, 4)) ??
    numberOrNull(firstValue(metadata?.publication_info)?.year) ??
    numberOrNull(metadata?.preprint_date?.slice?.(0, 4))
  );
}

function getAuthors(metadata: any): string[] {
  return (metadata?.authors ?? [])
    .map((author: any) => stringOrNull(author?.full_name ?? author?.raw_name))
    .filter((name: string | null): name is string => Boolean(name));
}

function getReferenceDOI(reference: any): string | null {
  const structured = reference?.reference ?? reference;
  const doiEntry = firstValue(structured?.dois);
  const direct = normalizeDOI(doiEntry?.value ?? doiEntry);

  if (direct) {
    return direct;
  }

  const rawText = (reference?.raw_refs ?? [])
    .map((entry: any) => entry?.value)
    .filter(Boolean)
    .join(" ");

  return normalizeDOI(rawText);
}

function getReferenceTitle(reference: any): string | null {
  const structured = reference?.reference ?? reference;
  const titleEntry = firstValue(structured?.titles);

  if (titleEntry) {
    return stringOrNull(titleEntry?.title ?? titleEntry);
  }

  return stringOrNull(reference?.raw_refs?.[0]?.value);
}

function getReferenceYear(reference: any): number | null {
  const structured = reference?.reference ?? reference;

  return (
    numberOrNull(firstValue(structured?.publication_info)?.year) ??
    numberOrNull(structured?.year)
  );
}

function getReferenceAuthors(reference: any): string[] {
  const structured = reference?.reference ?? reference;

  return (structured?.authors ?? [])
    .map((author: any) => stringOrNull(author?.full_name ?? author?.raw_name))
    .filter((name: string | null): name is string => Boolean(name));
}

function getReferenceRecordID(reference: any): string | null {
  const ref = stringOrNull(reference?.record?.$ref);
  if (!ref) {
    return null;
  }

  const parts = ref.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function mapReferences(metadata: any): RelatedWorkMetadata[] {
  return (metadata?.references ?? []).map((reference: any) => ({
    providerWorkID: getReferenceRecordID(reference),
    doi: getReferenceDOI(reference),
    title: getReferenceTitle(reference),
    year: getReferenceYear(reference),
    authors: getReferenceAuthors(reference),
  }));
}

export const inspireProvider: CitationProvider = {
  id: "inspire",
  label: "INSPIRE-HEP",

  supports(identifiers) {
    return Boolean(identifiers.doi || identifiers.arxiv);
  },

  async lookup(identifiers: WorkIdentifiers): Promise<ProviderLookupResult> {
    const matchedBy = identifiers.doi ? "doi" : "arxiv";
    const value = identifiers.doi ?? identifiers.arxiv;

    if (!value) {
      return {
        status: "no-identifier",
        provider: "inspire",
        message: "INSPIRE-HEP requires a DOI or arXiv ID.",
      };
    }

    const endpoint = matchedBy === "doi" ? "doi" : "arxiv";
    const url =
      `https://inspirehep.net/api/${endpoint}/` + encodeURIComponent(value);

    const response = await requestJSON<InspireRecord>("inspire", url);

    if (!response.ok || !response.data?.metadata) {
      return {
        status: failureStatusFromHTTP(response.status),
        provider: "inspire",
        message: response.message,
      };
    }

    const record = response.data;
    const metadata = record.metadata;
    const references = mapReferences(metadata);
    const declaredReferenceCount = numberOrNull(metadata.reference_count);

    return {
      status: "success",
      provider: "inspire",
      matchedBy,
      providerWorkID: stringOrNull(record.id),
      doi: getDOI(metadata) ?? normalizeDOI(identifiers.doi),
      title: getTitle(metadata),
      year: getYear(metadata),
      authors: getAuthors(metadata),
      citationCount: numberOrNull(metadata.citation_count),
      citationCountProvider: "inspire",
      referenceCount:
        declaredReferenceCount === null
          ? references.length
          : Math.max(declaredReferenceCount, references.length),
      referenceCountProvider: "inspire",
      resolvedReferenceCount: references.length,
      references,
    };
  },
};
