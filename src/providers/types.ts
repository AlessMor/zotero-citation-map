import type {
  CitationProviderID,
  ProviderLookupResult,
  WorkIdentifiers,
} from "../domain/citationTypes";

export interface CitationProvider {
  readonly id: CitationProviderID;
  readonly label: string;

  supports(identifiers: WorkIdentifiers): boolean;

  lookup(identifiers: WorkIdentifiers): Promise<ProviderLookupResult>;
}

export function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

export function failureStatusFromHTTP(
  status: number,
): "not-found" | "rate-limited" | "network-error" | "provider-error" {
  if (status === 400 || status === 404) {
    return "not-found";
  }

  if (status === 429) {
    return "rate-limited";
  }

  if (status === 0 || status >= 500) {
    return "network-error";
  }

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
