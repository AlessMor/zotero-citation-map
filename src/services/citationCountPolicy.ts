import type { CitationProviderID } from "../domain/citationTypes";

export interface CitationCountAttribution {
  count: number | null;
  provider: CitationProviderID | null;
}

export function maximumKnownCount(
  values: ReadonlyArray<number | null | undefined>,
): number | null {
  const known = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return known.length ? Math.max(...known) : null;
}

export function richestCountAttribution(
  candidates: readonly CitationCountAttribution[],
): CitationCountAttribution {
  let richest: CitationCountAttribution = { count: null, provider: null };
  for (const candidate of candidates) {
    if (candidate.count === null || !Number.isFinite(candidate.count)) continue;
    if (richest.count === null || candidate.count > richest.count) {
      richest = candidate;
    }
  }
  return richest;
}
