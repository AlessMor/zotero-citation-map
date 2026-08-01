import type {
  CitationProviderID,
  ProviderLookupResult,
  RelatedWorkMetadata,
  SourceMetrics,
  WorkIdentifiers,
} from "../domain/citationTypes";
import type { CancellationSignal } from "../services/cancellationScope";

export interface ProviderRequestOptions {
  signal?: CancellationSignal;
}

export interface ProviderCapabilities {
  identifiers: {
    doi: boolean;
    pmid: boolean;
    arxiv: boolean;
    isbn: boolean;
    titleSearch: boolean;
  };
  citationCount: boolean;
  referenceCount: boolean;
  citingWorks: boolean;
  referencedWorks: boolean;
  abstract: boolean;
  openAccess: boolean;
  retraction: boolean;
  sourceMetrics: boolean;
}

export interface CitationProvider {
  readonly id: CitationProviderID;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  supports(identifiers: WorkIdentifiers): boolean;
  lookup(
    identifiers: WorkIdentifiers,
    options?: ProviderRequestOptions,
  ): Promise<ProviderLookupResult>;
  lookupForRelations?(
    identifiers: WorkIdentifiers,
    options?: ProviderRequestOptions,
  ): Promise<ProviderLookupResult>;
  searchExactTitle?(
    identifiers: WorkIdentifiers,
    options?: ProviderRequestOptions,
  ): Promise<ProviderLookupResult>;
  fetchCitingWorks?(
    providerWorkID: string,
    maximum: number,
    offset?: number,
    options?: ProviderRequestOptions,
  ): Promise<RelatedWorkMetadata[]>;
  fetchReferencedWorks?(
    providerWorkID: string,
    maximum: number,
    offset?: number,
    options?: ProviderRequestOptions,
  ): Promise<RelatedWorkMetadata[]>;
  fetchSourceMetrics?(
    sourceID: string,
    options?: ProviderRequestOptions,
  ): Promise<SourceMetrics | null>;
}

export function failureStatusFromHTTP(
  status: number,
): "not-found" | "rate-limited" | "network-error" | "provider-error" {
  if (status === 400 || status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status === 0 || status >= 500) return "network-error";
  return "provider-error";
}

export function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function stringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}
