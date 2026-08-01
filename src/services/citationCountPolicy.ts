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
    if (
      candidate.count === null ||
      !Number.isFinite(candidate.count) ||
      candidate.count < 0
    ) {
      continue;
    }
    if (richest.count === null || candidate.count > richest.count) {
      richest = candidate;
    }
  }
  return richest;
}

/**
 * Reference totals are provider-dependent coverage indicators. Keep the
 * largest valid value so a later provider with narrower coverage cannot make
 * the displayed count move backwards.
 */
export function authoritativeReferenceCountAttribution(
  candidates: readonly CitationCountAttribution[],
): CitationCountAttribution {
  return richestCountAttribution(candidates);
}
