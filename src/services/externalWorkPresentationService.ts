import type { RelatedWorkMetadata } from "../domain/citationTypes";

type ExternalWorkSummary = Pick<
  RelatedWorkMetadata,
  "authors" | "sourceTitle" | "year" | "citationCount" | "referenceCount"
>;

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { useGrouping: false }).format(value);
}

export function externalWorkAuthorsText(
  work: Pick<RelatedWorkMetadata, "authors">,
): string {
  return work.authors.length
    ? work.authors.slice(0, 6).join(", ")
    : "Authors unavailable";
}

export function externalWorkMetadataText(
  work: ExternalWorkSummary,
  recommendationScore: number | undefined,
): string {
  return [
    work.sourceTitle,
    work.year,
    work.citationCount === null || work.citationCount === undefined
      ? ""
      : `${formatCount(work.citationCount)} citations`,
    work.referenceCount === null || work.referenceCount === undefined
      ? ""
      : `${formatCount(work.referenceCount)} references`,
    recommendationScore
      ? `connected to ${recommendationScore} visible papers`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
