import type { HTTPResult } from "./http";
import type { RelatedWorkMetadata } from "../domain/citationTypes";

export function requireRelatedWorks(
  works: (RelatedWorkMetadata | null)[],
  operation: string,
): RelatedWorkMetadata[] {
  return works.map((work) => {
    if (!work)
      throw new TypeError(
        `${operation}: a relationship record has no usable identity or title`,
      );
    return work;
  });
}

/** Reject failed requests before callers can mistake them for empty pages. */
export function requireResponseData<T>(
  response: HTTPResult<T>,
  operation: string,
): T {
  if (!response.ok || response.data === null) {
    throw new Error(
      `${operation} failed (HTTP ${response.status}): ${response.message || "missing response data"}`,
    );
  }
  return response.data;
}

export function requireArray<T>(
  value: T[] | undefined,
  operation: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${operation}: expected a JSON array`);
  }
  return value;
}

export function requireRecord(
  value: unknown,
  operation: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${operation}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Validate nested collections before mapping or persisting provider metadata. */
export function validateMetadataCollections(
  value: unknown,
  operation: string,
): void {
  const record = requireRecord(value, operation);
  const stringArrays = [
    "referenced_works",
    "related_works",
    "publicationTypes",
  ];
  const objectArrays = ["authors", "authorships", "counts_by_year"];
  for (const field of stringArrays) {
    const entries = record[field];
    if (entries === undefined || entries === null) continue;
    if (
      !Array.isArray(entries) ||
      entries.some((entry: unknown) => typeof entry !== "string")
    ) {
      throw new TypeError(`${operation}: ${field} must be an array of strings`);
    }
  }
  for (const field of objectArrays) {
    const entries = record[field];
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries))
      throw new TypeError(`${operation}: ${field} must be an array`);
    for (const entry of entries) requireRecord(entry, `${operation}.${field}`);
  }
}
