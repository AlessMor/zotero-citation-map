const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface UpdateProgressOptions {
  document?: Document | null;
  title: string;
  message: string;
  total?: number;
}

export interface UpdateProgressHandle {
  setMessage(message: string): void;
  setProgress(completed: number, total: number, message?: string): void;
  finish(message: string, autoCloseMs?: number): void;
  fail(message: string, autoCloseMs?: number): void;
  dismiss(): void;
  isDismissed(): boolean;
}

interface ProgressEntry {
  root: HTMLDivElement | null;
  label: HTMLDivElement | null;
  progress: HTMLProgressElement | null;
  timer: ReturnType<typeof setTimeout> | null;
  dismissed: boolean;
}

const entries = new Set<ProgressEntry>();
const hosts = new WeakMap<Document, HTMLDivElement>();

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return document.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
}

function usableDocument(preferred?: Document | null): Document | null {
  if (preferred?.documentElement && !preferred.defaultView?.closed) {
    return preferred;
  }
  const mainWindow = Zotero.getMainWindow?.() as Window | null;
  return mainWindow && !mainWindow.closed ? mainWindow.document : null;
}

function progressHost(document: Document): HTMLDivElement {
  const existing = hosts.get(document);
  if (existing?.isConnected) return existing;
  const host = element(document, "div");
  host.className = "citation-map-progress-window-stack";
  Object.assign(host.style, {
    position: "fixed",
    top: "18px",
    right: "18px",
    zIndex: "2147483647",
    display: "grid",
    gap: "8px",
    width: "min(360px, calc(100vw - 36px))",
    pointerEvents: "none",
  });
  (document.body ?? document.documentElement).appendChild(host);
  hosts.set(document, host);
  return host;
}

function cleanup(entry: ProgressEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.root?.remove();
  entry.root = null;
  entry.label = null;
  entry.progress = null;
  entries.delete(entry);
}

export function createUpdateProgress(
  options: UpdateProgressOptions,
): UpdateProgressHandle {
  const document = usableDocument(options.document);
  const entry: ProgressEntry = {
    root: null,
    label: null,
    progress: null,
    timer: null,
    dismissed: false,
  };
  entries.add(entry);

  if (document) {
    const root = element(document, "div");
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    Object.assign(root.style, {
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      gap: "8px",
      padding: "10px 11px",
      border: "1px solid color-mix(in srgb, CanvasText 18%, transparent)",
      borderRadius: "9px",
      background: "Canvas",
      color: "CanvasText",
      boxShadow: "0 8px 28px rgba(0, 0, 0, .22)",
      pointerEvents: "auto",
    });

    const content = element(document, "div");
    content.style.minWidth = "0";
    const heading = element(document, "strong");
    heading.textContent = options.title;
    heading.style.display = "block";
    heading.style.marginBottom = "3px";
    const label = element(document, "div");
    label.textContent = options.message;
    Object.assign(label.style, {
      fontSize: "12px",
      lineHeight: "1.35",
      overflowWrap: "anywhere",
    });
    const progress = element(document, "progress");
    progress.max = Math.max(1, options.total ?? 1);
    if (options.total !== undefined) progress.value = 0;
    Object.assign(progress.style, {
      display: "block",
      width: "100%",
      height: "7px",
      marginTop: "7px",
    });
    content.append(heading, label, progress);

    const close = element(document, "button");
    close.type = "button";
    close.textContent = "×";
    close.title =
      "Hide this progress window. The update will continue in the background.";
    close.setAttribute("aria-label", close.title);
    Object.assign(close.style, {
      alignSelf: "start",
      width: "24px",
      minWidth: "24px",
      height: "24px",
      padding: "0",
      border: "0",
      borderRadius: "5px",
      background: "transparent",
      color: "inherit",
      fontSize: "18px",
      lineHeight: "20px",
      cursor: "pointer",
    });
    close.addEventListener("click", () => {
      entry.dismissed = true;
      cleanup(entry);
    });

    root.append(content, close);
    progressHost(document).appendChild(root);
    entry.root = root;
    entry.label = label;
    entry.progress = progress;
  }

  const scheduleClose = (milliseconds: number): void => {
    if (entry.dismissed || !entry.root) {
      entries.delete(entry);
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => cleanup(entry), milliseconds);
  };

  return {
    setMessage(message) {
      if (entry.dismissed) return;
      if (entry.label) entry.label.textContent = message;
    },
    setProgress(completed, total, message) {
      if (entry.dismissed) return;
      if (message && entry.label) entry.label.textContent = message;
      if (entry.progress) {
        entry.progress.max = Math.max(1, total);
        entry.progress.value = Math.max(0, Math.min(total, completed));
      }
    },
    finish(message, autoCloseMs = 3500) {
      if (entry.dismissed) return;
      if (entry.label) entry.label.textContent = message;
      if (entry.progress) {
        entry.progress.max = 1;
        entry.progress.value = 1;
      }
      scheduleClose(autoCloseMs);
    },
    fail(message, autoCloseMs = 7000) {
      if (entry.dismissed) return;
      if (entry.label) entry.label.textContent = message;
      if (entry.progress) entry.progress.removeAttribute("value");
      scheduleClose(autoCloseMs);
    },
    dismiss() {
      entry.dismissed = true;
      cleanup(entry);
    },
    isDismissed: () => entry.dismissed,
  };
}

export function closeAllUpdateProgress(): void {
  for (const entry of [...entries]) cleanup(entry);
}
