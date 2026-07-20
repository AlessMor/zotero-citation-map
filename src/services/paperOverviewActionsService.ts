const HTML_NS = "http://www.w3.org/1999/xhtml";
import { createCitationMapIcon } from "./uiIconService";

type Action = () => void | Promise<void>;

export interface PaperOverviewActionOptions {
  document: Document;
  actionsClass: string;
  primaryButtonClass: string;
  secondaryButtonClass?: string;
  doi: string | null;
  onShowInZotero: Action;
  onSimilar: Action;
  onRefresh: Action;
}

export interface PaperOverviewActionBar {
  root: HTMLDivElement;
  showInZoteroButton: HTMLButtonElement;
  openDOIButton: HTMLButtonElement | null;
  similarButton: HTMLButtonElement;
  refreshButton: HTMLButtonElement;
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

function invoke(button: HTMLButtonElement, action: Action): void {
  if (button.disabled) return;
  button.disabled = true;
  void Promise.resolve(action())
    .catch((error: unknown) => {
      Zotero.logError(
        error instanceof Error
          ? error
          : new Error(`Citation Map overview action failed: ${String(error)}`),
      );
    })
    .finally(() => {
      if (button.isConnected) button.disabled = false;
    });
}

export function createPaperOverviewActionBar(
  options: PaperOverviewActionOptions,
): PaperOverviewActionBar {
  const {
    document,
    actionsClass,
    primaryButtonClass,
    secondaryButtonClass = "",
  } = options;
  const root = element(document, "div", actionsClass);
  root.style.display = "flex";
  root.style.flexWrap = "wrap";
  root.style.alignItems = "center";
  root.style.justifyContent = "space-between";
  root.style.gap = "6px";
  root.style.width = "100%";

  const left = element(document, "div", actionsClass);
  left.style.margin = "0";
  const right = element(document, "div", actionsClass);
  right.style.margin = "0";

  const showInZoteroButton = element(document, "button", secondaryButtonClass);
  showInZoteroButton.type = "button";
  showInZoteroButton.textContent = "Show in Zotero";
  showInZoteroButton.title = "Select this paper in the Zotero library.";
  showInZoteroButton.addEventListener("click", () =>
    invoke(showInZoteroButton, options.onShowInZotero),
  );
  left.appendChild(showInZoteroButton);

  let openDOIButton: HTMLButtonElement | null = null;
  const doi = options.doi?.trim() ?? "";
  if (doi) {
    openDOIButton = element(document, "button", secondaryButtonClass);
    openDOIButton.type = "button";
    openDOIButton.textContent = "Open DOI";
    openDOIButton.title = "Open this paper's DOI in the default browser.";
    openDOIButton.addEventListener("click", () => {
      Zotero.launchURL(`https://doi.org/${encodeURIComponent(doi)}`);
    });
    left.appendChild(openDOIButton);
  }

  const similarButton = element(document, "button", primaryButtonClass);
  similarButton.type = "button";
  similarButton.append(
    createCitationMapIcon(document, "similar"),
    document.createTextNode("Similar"),
  );
  similarButton.title =
    "Find papers similar to this work using scholarly-data providers. Results are shown for review and are not added to Zotero automatically.";
  similarButton.setAttribute("aria-label", similarButton.title);
  similarButton.addEventListener("click", () =>
    invoke(similarButton, options.onSimilar),
  );
  right.appendChild(similarButton);

  const refreshButton = element(document, "button", secondaryButtonClass);
  refreshButton.type = "button";
  refreshButton.appendChild(createCitationMapIcon(document, "refresh"));
  refreshButton.style.width = "30px";
  refreshButton.style.minWidth = "30px";
  refreshButton.style.padding = "4px";
  refreshButton.style.justifyContent = "center";
  refreshButton.title =
    "Check scholarly-data providers online and update the citation metrics, reference metrics, open-access and retraction status, journal metrics, and stored cited-by/reference lists for this paper.";
  refreshButton.setAttribute("aria-label", refreshButton.title);
  refreshButton.addEventListener("click", () =>
    invoke(refreshButton, options.onRefresh),
  );
  right.appendChild(refreshButton);

  root.append(left, right);
  return {
    root,
    showInZoteroButton,
    openDOIButton,
    similarButton,
    refreshButton,
  };
}
