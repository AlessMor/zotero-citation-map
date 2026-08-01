/** Return a positive integer, or null when the input is invalid. */
export function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** Return unique positive integers while preserving their first-seen order. */
export function uniquePositiveIntegers(values: readonly unknown[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const normalized = positiveInteger(value);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Normalize a publication year without treating missing values as year zero.
 *
 * Provider payloads and persisted rows sometimes contain null, an empty
 * string, or zero. Number(null) and Number("") both produce zero, so generic
 * numeric conversion is not suitable for publication years.
 */
export function publicationYearOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1500 && year <= 2199 ? year : null;
}

/** Return the first valid publication year from a list of candidates. */
export function firstPublicationYear(
  ...values: readonly unknown[]
): number | null {
  for (const value of values) {
    const year = publicationYearOrNull(value);
    if (year !== null) return year;
  }
  return null;
}

/** Compare valid publication years while always placing missing years last. */
export function comparePublicationYears(
  left: unknown,
  right: unknown,
  direction: "ascending" | "descending",
): number {
  const a = publicationYearOrNull(left);
  const b = publicationYearOrNull(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "ascending" ? a - b : b - a;
}
