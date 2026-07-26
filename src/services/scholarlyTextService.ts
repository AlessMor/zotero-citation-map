import type { RelatedWorkMetadata } from "../domain/citationTypes";

const SUPERSCRIPT_CHARACTERS: Readonly<Record<string, string>> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};

const SUBSCRIPT_CHARACTERS: Readonly<Record<string, string>> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "p",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "ol",
]);

function elementName(element: Element): string {
  const name = String(element.localName || element.tagName)
    .trim()
    .toLocaleLowerCase();
  return name.split(":").at(-1) ?? name;
}

function renderChildren(element: Element): string {
  return Array.from(element.childNodes)
    .map((node) => (node ? renderNode(node) : ""))
    .join("");
}

function compactScript(
  value: string,
  characters: Readonly<Record<string, string>>,
  fallbackPrefix: "^" | "_",
): string {
  const compact = value.replace(/\s+/g, "").trim();
  if (!compact) return "";
  const converted = [...compact].map((character) => characters[character]);
  return converted.every(Boolean)
    ? converted.join("")
    : `${fallbackPrefix}(${normalizeRenderedText(value)})`;
}

function childText(element: Element, index: number): string {
  const child = element.childNodes.item(index);
  return child ? renderNode(child) : "";
}

function renderNode(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";

  const element = node as Element;
  const name = elementName(element);
  if (
    ["script", "style", "noscript", "annotation", "annotation-xml"].includes(
      name,
    )
  ) {
    return "";
  }
  if (name === "br") return " ";
  if (name === "img") return ` ${element.getAttribute("alt") ?? ""} `;

  if (name === "sup") {
    return compactScript(renderChildren(element), SUPERSCRIPT_CHARACTERS, "^");
  }
  if (name === "sub") {
    return compactScript(renderChildren(element), SUBSCRIPT_CHARACTERS, "_");
  }
  if (name === "msup") {
    return `${childText(element, 0)}${compactScript(
      childText(element, 1),
      SUPERSCRIPT_CHARACTERS,
      "^",
    )}`;
  }
  if (name === "msub") {
    return `${childText(element, 0)}${compactScript(
      childText(element, 1),
      SUBSCRIPT_CHARACTERS,
      "_",
    )}`;
  }
  if (name === "msubsup") {
    return `${childText(element, 0)}${compactScript(
      childText(element, 1),
      SUBSCRIPT_CHARACTERS,
      "_",
    )}${compactScript(childText(element, 2), SUPERSCRIPT_CHARACTERS, "^")}`;
  }
  if (name === "mfrac") {
    return `(${normalizeRenderedText(childText(element, 0))})/(${normalizeRenderedText(
      childText(element, 1),
    )})`;
  }
  if (name === "msqrt") {
    return `√(${normalizeRenderedText(renderChildren(element))})`;
  }
  if (name === "mroot") {
    return `root[${normalizeRenderedText(childText(element, 1))}](${normalizeRenderedText(
      childText(element, 0),
    )})`;
  }
  if (name === "mfenced") {
    const open = element.getAttribute("open") ?? "(";
    const close = element.getAttribute("close") ?? ")";
    return `${open}${renderChildren(element)}${close}`;
  }
  if (name === "semantics") {
    const visible = Array.from(element.childNodes).find((child) => {
      if (!child) return false;
      if (child.nodeType !== 1) return child.nodeType === 3;
      const childName = elementName(child as Element);
      return childName !== "annotation" && childName !== "annotation-xml";
    });
    return visible ? renderNode(visible) : "";
  }

  const rendered = renderChildren(element);
  return BLOCK_ELEMENTS.has(name) ? ` ${rendered} ` : rendered;
}

function normalizeRenderedText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .trim();
}

/**
 * Convert provider-supplied HTML, JATS, and MathML fragments into safe,
 * readable plain text. The detached parser decodes entities; no provider markup
 * is ever inserted into the live Zotero document.
 */
export function normalizeScholarlyText(
  value: string | null | undefined,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  try {
    const document = new DOMParser().parseFromString(raw, "text/html");
    return normalizeRenderedText(renderChildren(document.body));
  } catch {
    // DOMParser should be available in Zotero's chrome context, but retain a
    // conservative fallback for startup or test contexts without a live DOM.
    return normalizeRenderedText(
      raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    );
  }
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = normalizeScholarlyText(value);
  return normalized || null;
}

function normalizeRelatedWorkTextAtDepth<T extends RelatedWorkMetadata>(
  work: T,
  depth: number,
): T {
  return {
    ...work,
    title: nullableText(work.title),
    authors: work.authors
      .map((author) => normalizeScholarlyText(author))
      .filter(Boolean),
    sourceTitle: nullableText(work.sourceTitle),
    abstract: nullableText(work.abstract),
    publicationType: nullableText(work.publicationType),
    sourceMetrics: work.sourceMetrics
      ? {
          ...work.sourceMetrics,
          sourceTitle: nullableText(work.sourceMetrics.sourceTitle),
        }
      : work.sourceMetrics,
    references:
      depth > 0
        ? work.references?.map((reference) =>
            normalizeRelatedWorkTextAtDepth(reference, depth - 1),
          )
        : work.references,
  } as T;
}

/** Normalize every user-visible text field in an external scholarly record. */
export function normalizeRelatedWorkText<T extends RelatedWorkMetadata>(
  work: T,
): T {
  return normalizeRelatedWorkTextAtDepth(work, 2);
}

/** Normalize text fields written into an item produced by a Zotero translator. */
export async function normalizeImportedZoteroItems(
  items: Zotero.Item[],
): Promise<Zotero.Item[]> {
  const fields = [
    "title",
    "abstractNote",
    "publicationTitle",
    "conferenceName",
    "bookTitle",
    "series",
  ] as const;

  for (const item of items) {
    let changed = false;
    for (const field of fields) {
      const original = String(item.getField?.(field) ?? "");
      if (!original) continue;
      const normalized = normalizeScholarlyText(original);
      if (normalized && normalized !== original) {
        item.setField(field, normalized);
        changed = true;
      }
    }
    if (changed) await item.saveTx();
  }
  return items;
}
