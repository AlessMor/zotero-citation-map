import type {
  ProviderLookupResult,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { normalizeDOI } from "../services/citationIdentifiers";
import { requestJSON } from "./http";
import type { CitationProvider } from "./types";
import { failureStatusFromHTTP, numberOrNull, stringOrNull } from "./types";

interface CountResponseRow {
  count?: string | number;
}

interface CitationRow {
  citing?: string;
  cited?: string;
  creation?: string;
}

function getPID(identifiers: WorkIdentifiers): {
  kind: "doi" | "pmid";
  value: string;
  pid: string;
} | null {
  if (identifiers.doi) {
    return {
      kind: "doi",
      value: identifiers.doi,
      pid: `doi:${identifiers.doi}`,
    };
  }

  if (identifiers.pmid) {
    return {
      kind: "pmid",
      value: identifiers.pmid,
      pid: `pmid:${identifiers.pmid}`,
    };
  }

  return null;
}

function extractPIDValue(
  text: string | undefined,
  prefix: "doi" | "pmid" | "omid",
): string | null {
  if (!text) {
    return null;
  }

  const match = text.match(new RegExp(`(?:^|\\s)${prefix}:([^\\s;]+)`, "i"));
  return match ? match[1] : null;
}

function yearFromCreation(value: unknown): number | null {
  const match = String(value ?? "").match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function mapReferences(rows: CitationRow[] | null): RelatedWorkMetadata[] {
  const sourceRows = (rows ?? []) as Array<CitationRow | CitationRow[]>;
  const flattened = sourceRows.flatMap((row) =>
    Array.isArray(row) ? row : [row],
  );

  return flattened.map((row) => {
    const doi = normalizeDOI(extractPIDValue(row.cited, "doi"));
    const pmid = extractPIDValue(row.cited, "pmid");
    const omid = extractPIDValue(row.cited, "omid");

    return {
      providerWorkID: omid ? `omid:${omid}` : pmid ? `pmid:${pmid}` : doi,
      doi,
      title: null,
      year: yearFromCreation(row.creation),
      authors: [],
    };
  });
}

export const openCitationsProvider: CitationProvider = {
  id: "opencitations",
  label: "OpenCitations",

  supports(identifiers) {
    return Boolean(identifiers.doi || identifiers.pmid);
  },

  async lookup(identifiers: WorkIdentifiers): Promise<ProviderLookupResult> {
    const lookup = getPID(identifiers);

    if (!lookup) {
      return {
        status: "no-identifier",
        provider: "opencitations",
        message: "OpenCitations requires a DOI or PMID.",
      };
    }

    const encodedPID = encodeURIComponent(lookup.pid);
    const base = "https://api.opencitations.net/index/v2";

    const citationResponse = await requestJSON<CountResponseRow[]>(
      "opencitations",
      `${base}/citation-count/${encodedPID}`,
    );

    if (!citationResponse.ok) {
      return {
        status: failureStatusFromHTTP(citationResponse.status),
        provider: "opencitations",
        message: citationResponse.message,
      };
    }

    const referenceResponse = await requestJSON<CountResponseRow[]>(
      "opencitations",
      `${base}/reference-count/${encodedPID}`,
    );

    if (!referenceResponse.ok) {
      return {
        status: failureStatusFromHTTP(referenceResponse.status),
        provider: "opencitations",
        message: referenceResponse.message,
      };
    }

    const referencesResponse = await requestJSON<CitationRow[]>(
      "opencitations",
      `${base}/references/${encodedPID}`,
    );

    const references = referencesResponse.ok
      ? mapReferences(referencesResponse.data)
      : [];

    const citationCount = numberOrNull(citationResponse.data?.[0]?.count);
    const declaredReferenceCount = numberOrNull(
      referenceResponse.data?.[0]?.count,
    );
    const referenceCount =
      declaredReferenceCount === null
        ? references.length
        : Math.max(declaredReferenceCount, references.length);

    if (citationCount === null && referenceCount === null) {
      return {
        status: "not-found",
        provider: "opencitations",
        message: "OpenCitations returned no record for this identifier.",
      };
    }

    return {
      status: "success",
      provider: "opencitations",
      matchedBy: lookup.kind,
      providerWorkID: lookup.pid,
      doi: lookup.kind === "doi" ? normalizeDOI(lookup.value) : null,
      title: stringOrNull(identifiers.title),
      year: identifiers.year,
      authors: identifiers.authors,
      citationCount,
      citationCountProvider: "opencitations",
      referenceCount,
      referenceCountProvider: "opencitations",
      resolvedReferenceCount: references.length,
      references,
    };
  },
};
