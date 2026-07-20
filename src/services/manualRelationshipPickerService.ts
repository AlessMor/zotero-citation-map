/// <reference lib="dom" />

import type {
  ManualCitationRelation,
  ManualRelationDirection,
} from "../domain/citationTypes";
import type { LibrarySnapshot } from "../domain/types";
import {
  addManualRelation,
  getManualRelations,
  removeManualRelation,
} from "./citationMetricsStore";
import {
  createPaperListToolbar,
  descriptorsFromSnapshot,
  type PaperListDescriptor,
} from "./paperListViewService";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface ManualRelationshipChange {
  action: "added" | "removed";
  relatedItemKey: string;
  relationID?: number;
}

export interface ManualRelationshipPickerOptions {
  document: Document;
  snapshot: LibrarySnapshot;
  subjectItemKey: string;
  direction: ManualRelationDirection;
  getAlreadyRelatedItemKeys?: () => Set<string>;
  buttonClassName?: string;
  inputClassName?: string;
  onApplied: (changes: ManualRelationshipChange[]) => void | Promise<void>;
}

export interface ManualRelationshipPicker {
  button: HTMLButtonElement;
  overlay: HTMLDivElement;
  close(): void;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElementNS(
    HTML_NS,
    tag,
  ) as HTMLElementTagNameMap[K];
  if (className) node.className = className;
  return node;
}

export function manualRelationsForSubject(
  libraryID: number,
  subjectItemKey: string,
  direction: ManualRelationDirection,
): Array<{ relation: ManualCitationRelation; relatedItemKey: string }> {
  const output: Array<{
    relation: ManualCitationRelation;
    relatedItemKey: string;
  }> = [];
  for (const relation of getManualRelations(libraryID)) {
    if (relation.direction === "reference") {
      if (
        direction === "reference" &&
        relation.subjectItemKey === subjectItemKey
      ) {
        output.push({ relation, relatedItemKey: relation.relatedItemKey });
      } else if (
        direction === "cited-by" &&
        relation.relatedItemKey === subjectItemKey
      ) {
        output.push({ relation, relatedItemKey: relation.subjectItemKey });
      }
    } else if (relation.direction === "cited-by") {
      if (
        direction === "cited-by" &&
        relation.subjectItemKey === subjectItemKey
      ) {
        output.push({ relation, relatedItemKey: relation.relatedItemKey });
      } else if (
        direction === "reference" &&
        relation.relatedItemKey === subjectItemKey
      ) {
        output.push({ relation, relatedItemKey: relation.subjectItemKey });
      }
    }
  }
  return output;
}

function actionLabel(direction: ManualRelationDirection): string {
  return direction === "reference"
    ? "Add or remove manual references"
    : "Add or remove manual citing papers";
}

function resultSubtitle(descriptor: PaperListDescriptor): string {
  return [
    descriptor.authors.join(", "),
    descriptor.sourceTitle,
    descriptor.year,
  ]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(" · ");
}

export function createManualRelationshipPicker(
  options: ManualRelationshipPickerOptions,
): ManualRelationshipPicker {
  const { document, snapshot } = options;
  const button = element(document, "button", options.buttonClassName);
  button.type = "button";
  button.textContent = "±";
  const label = actionLabel(options.direction);
  button.title = label;
  button.setAttribute("aria-label", label);
  Object.assign(button.style, {
    width: "30px",
    minWidth: "30px",
    padding: "4px",
    justifyContent: "center",
    color: "inherit",
    fontSize: "18px",
    lineHeight: "1",
  });

  const overlay = element(document, "div");
  Object.assign(overlay.style, {
    display: "none",
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    placeItems: "center",
    padding: "20px",
    background: "rgba(0, 0, 0, .34)",
  });
  const dialog = element(document, "section");
  Object.assign(dialog.style, {
    display: "grid",
    gridTemplateRows: "auto auto minmax(120px, 1fr) auto",
    gap: "9px",
    width: "min(760px, calc(100vw - 40px))",
    height: "min(720px, calc(100vh - 40px))",
    maxHeight: "calc(100vh - 40px)",
    overflow: "hidden",
    padding: "14px",
    border: "1px solid color-mix(in srgb, CanvasText 18%, transparent)",
    borderRadius: "10px",
    background: "Canvas",
    color: "CanvasText",
    boxShadow: "0 16px 55px rgba(0, 0, 0, .35)",
  });
  const header = element(document, "header");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  });
  const heading = element(document, "strong");
  heading.textContent = label;
  const closeButton = element(document, "button", options.buttonClassName);
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Close";
  closeButton.setAttribute("aria-label", "Close");
  Object.assign(closeButton.style, {
    marginInlineStart: "auto",
    width: "30px",
    minWidth: "30px",
    padding: "4px",
    justifyContent: "center",
  });
  header.append(heading, closeButton);

  let renderRows = (): void => undefined;
  const toolbar = createPaperListToolbar({
    document,
    searchPlaceholder: "Search this Zotero library",
    collections: snapshot.collections,
    buttonClassName: options.buttonClassName,
    inputClassName: options.inputClassName,
    showRelationshipFilter: true,
    showItemTypeFilter: true,
    onChange: () => renderRows(),
  });
  const results = element(document, "div");
  Object.assign(results.style, {
    display: "grid",
    alignContent: "start",
    gap: "6px",
    overflow: "auto",
    minHeight: "0",
    padding: "2px",
  });
  const footer = element(document, "footer");
  Object.assign(footer.style, {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "7px",
    paddingTop: "8px",
    borderTop: "1px solid color-mix(in srgb, CanvasText 14%, transparent)",
  });
  const selectionStatus = element(document, "span");
  selectionStatus.style.marginInlineEnd = "auto";
  selectionStatus.style.opacity = ".72";
  const errorStatus = element(document, "span");
  errorStatus.style.color = "#dc2626";
  const cancelButton = element(document, "button", options.buttonClassName);
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  const applyButton = element(document, "button", options.buttonClassName);
  applyButton.type = "button";
  applyButton.textContent = "Apply selected";
  footer.append(selectionStatus, errorStatus, cancelButton, applyButton);

  let baseline = new Map<string, ManualCitationRelation>();
  let selectedKeys = new Set<string>();
  let open = false;
  let applying = false;

  const currentManualRelations = (): Map<string, ManualCitationRelation> =>
    new Map(
      manualRelationsForSubject(
        snapshot.libraryID,
        options.subjectItemKey,
        options.direction,
      ).map(({ relation, relatedItemKey }) => [relatedItemKey, relation]),
    );

  const updateSelectionStatus = (): void => {
    const additions = [...selectedKeys].filter(
      (key) => !baseline.has(key),
    ).length;
    const removals = [...baseline.keys()].filter(
      (key) => !selectedKeys.has(key),
    ).length;
    selectionStatus.textContent = `${selectedKeys.size} selected · ${additions} to add · ${removals} to remove`;
    applyButton.disabled = applying;
  };

  renderRows = (): void => {
    results.replaceChildren();
    const alreadyRelated =
      options.getAlreadyRelatedItemKeys?.() ?? new Set<string>();
    const entries = descriptorsFromSnapshot(
      snapshot,
      options.subjectItemKey,
      alreadyRelated,
      new Set(baseline.keys()),
    );
    const ordered = toolbar.apply(entries, ({ descriptor }) => ({
      ...descriptor,
      alreadyRelated:
        descriptor.alreadyRelated || selectedKeys.has(descriptor.key),
      manuallyRelated: selectedKeys.has(descriptor.key),
    }));
    for (const { paper, descriptor } of ordered) {
      const row = element(document, "label");
      Object.assign(row.style, {
        display: "grid",
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        gap: "8px",
        alignItems: "start",
        padding: "8px",
        border: "1px solid color-mix(in srgb, CanvasText 14%, transparent)",
        borderRadius: "7px",
        background: selectedKeys.has(paper.itemKey)
          ? "color-mix(in srgb, var(--accent-blue, #2563eb) 10%, Canvas)"
          : "Canvas",
        cursor: "pointer",
      });
      const checkbox = element(document, "input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedKeys.has(paper.itemKey);
      const content = element(document, "span");
      content.style.minWidth = "0";
      const title = element(document, "strong");
      title.textContent = descriptor.title;
      title.style.display = "block";
      title.style.overflowWrap = "anywhere";
      const subtitle = element(document, "small");
      subtitle.textContent = resultSubtitle(descriptor);
      subtitle.style.display = "block";
      subtitle.style.marginTop = "2px";
      subtitle.style.opacity = ".72";
      content.append(title, subtitle);
      const badges = element(document, "span");
      Object.assign(badges.style, {
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: "4px",
      });
      if (baseline.has(paper.itemKey)) {
        const badge = element(document, "span");
        badge.textContent = "Manual relationship";
        badge.style.fontSize = "10px";
        badges.appendChild(badge);
      } else if (descriptor.alreadyRelated) {
        const badge = element(document, "span");
        badge.textContent = "Already related";
        badge.style.fontSize = "10px";
        badges.appendChild(badge);
      }
      const setChecked = (checked: boolean): void => {
        if (checked) selectedKeys.add(paper.itemKey);
        else selectedKeys.delete(paper.itemKey);
        updateSelectionStatus();
        renderRows();
      };
      checkbox.addEventListener("change", () => setChecked(checkbox.checked));
      row.append(checkbox, content, badges);
      results.appendChild(row);
    }
    if (!ordered.length) {
      const empty = element(document, "p");
      empty.textContent = "No papers match the current search and filters.";
      empty.style.opacity = ".72";
      results.appendChild(empty);
    }
    updateSelectionStatus();
  };

  const discardSession = (): void => {
    baseline = new Map();
    selectedKeys = new Set();
    errorStatus.textContent = "";
    toolbar.reset();
  };
  const close = (): void => {
    if (!open || applying) return;
    open = false;
    overlay.style.display = "none";
    discardSession();
    if (button.isConnected) button.focus();
  };
  const openDialog = (): void => {
    baseline = currentManualRelations();
    selectedKeys = new Set(baseline.keys());
    errorStatus.textContent = "";
    toolbar.reset();
    open = true;
    overlay.style.display = "grid";
    renderRows();
    toolbar.searchInput.focus();
  };

  const applyChanges = async (): Promise<void> => {
    if (applying) return;
    applying = true;
    errorStatus.textContent = "";
    updateSelectionStatus();
    const changes: ManualRelationshipChange[] = [];
    try {
      for (const [relatedItemKey, relation] of baseline) {
        if (selectedKeys.has(relatedItemKey)) continue;
        await removeManualRelation(relation.id);
        changes.push({
          action: "removed",
          relatedItemKey,
          relationID: relation.id,
        });
      }
      for (const relatedItemKey of selectedKeys) {
        if (baseline.has(relatedItemKey)) continue;
        await addManualRelation(
          snapshot.libraryID,
          options.subjectItemKey,
          relatedItemKey,
          options.direction,
        );
        changes.push({ action: "added", relatedItemKey });
      }
      applying = false;
      open = false;
      overlay.style.display = "none";
      baseline = new Map();
      selectedKeys = new Set();
      toolbar.reset();
      await options.onApplied(changes);
      if (button.isConnected) button.focus();
    } catch (error) {
      applying = false;
      errorStatus.textContent =
        error instanceof Error ? error.message : String(error);
      updateSelectionStatus();
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  button.addEventListener("click", openDialog);
  closeButton.addEventListener("click", close);
  cancelButton.addEventListener("click", close);
  applyButton.addEventListener("click", () => void applyChanges());
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!overlay.isConnected) {
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      return;
    }
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    close();
  };
  document.addEventListener("keydown", onDocumentKeyDown, true);

  dialog.append(header, toolbar.root, results, footer);
  overlay.appendChild(dialog);

  return {
    button,
    overlay,
    close,
    destroy: () => {
      toolbar.destroy();
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      overlay.remove();
    },
  };
}
