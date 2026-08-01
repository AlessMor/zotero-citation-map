import { publicationYearOrNull } from "../domain/valueNormalization";

export interface DatePartsCarrier {
  published?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
}

/** Convert Crossref-style date-parts into the most precise ISO-like string. */
export function publicationDateFromParts(
  value: DatePartsCarrier,
): string | null {
  const parts = value.published?.["date-parts"] ?? value.issued?.["date-parts"];
  const values = parts?.[0] ?? [];
  const year = publicationYearOrNull(values[0]);
  if (year === null) return null;
  const month = Number(values[1]);
  const day = Number(values[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return String(year);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
