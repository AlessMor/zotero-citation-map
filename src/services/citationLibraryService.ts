export interface CitationLibraryOption {
  libraryID: number;
  name: string;
  libraryType: string;
  isUserLibrary: boolean;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Return the Zotero libraries that can contain ordinary bibliographic items.
 * Feeds and My Publications are intentionally excluded from graph and
 * citation-update scopes.
 */
export function getAvailableCitationLibraries(
  includeLibraryID?: number | null,
): CitationLibraryOption[] {
  const libraries = new Map<number, CitationLibraryOption>();
  const userLibraryID = positiveInteger(Zotero.Libraries.userLibraryID);

  const add = (value: unknown, forcedType?: string): void => {
    const candidate = value as any;
    const libraryID = positiveInteger(
      typeof value === "number"
        ? value
        : (candidate?.libraryID ?? candidate?.id),
    );
    if (!libraryID) return;

    const libraryType = String(
      forcedType ?? candidate?.libraryType ?? candidate?.type ?? "",
    ).toLocaleLowerCase();
    if (libraryType === "feed" || libraryType === "publications") return;

    const name =
      String(
        candidate?.name ??
          candidate?.libraryName ??
          Zotero.Libraries.getName?.(libraryID) ??
          "",
      ).trim() || `Library ${libraryID}`;

    libraries.set(libraryID, {
      libraryID,
      name,
      libraryType:
        libraryID === userLibraryID ? "user" : libraryType || "group",
      isUserLibrary: libraryID === userLibraryID,
    });
  };

  if (userLibraryID) add(userLibraryID, "user");

  try {
    for (const library of (Zotero.Libraries as any).getAll?.() ?? []) {
      add(library);
    }
  } catch {
    // The user library and group fallback below remain available.
  }

  try {
    for (const group of (Zotero.Groups as any)?.getAll?.() ?? []) {
      add(
        {
          libraryID: group?.libraryID,
          name: group?.name,
        },
        "group",
      );
    }
  } catch {
    // Group enumeration is optional in some Zotero contexts.
  }

  const included = positiveInteger(includeLibraryID);
  if (included) add(included);

  return [...libraries.values()].sort((left, right) => {
    if (left.isUserLibrary) return -1;
    if (right.isUserLibrary) return 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
}
