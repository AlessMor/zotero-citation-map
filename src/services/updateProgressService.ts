import { config } from "../../package.json";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICON = `chrome://${config.addonRef}/content/icons/network.svg`;
const SPINNER_STYLE_ID = `${config.addonRef}-update-spinner-style`;
const DEFAULT_FINISH_CLOSE_MS = 3500;
const DEFAULT_FAILURE_CLOSE_MS = 7000;
const EMPTY_ACTIVITY_GRACE_MS = 1500;
const PROGRESS_RENDER_DELAY_MS = 16;

export interface UpdateProgressOptions {
  document?: Document | null;
  title: string;
  message: string;
  total?: number;
  /** Optional operation-specific cancellation hook. */
  onCancel?: () => void;
}

export interface UpdateProgressHandle {
  setMessage(message: string): void;
  setProgress(completed: number, total: number, message?: string): void;
  finish(message: string, autoCloseMs?: number): void;
  fail(message: string, autoCloseMs?: number): void;
  minimize(): void;
  restore(): void;
  dismiss(): void;
  isDismissed(): boolean;
  isMinimized(): boolean;
}

type ActivityStatus = "active" | "finished" | "failed" | "dismissed";

interface ProgressActivity {
  id: number;
  title: string;
  message: string;
  completed: number;
  total: number | null;
  status: ActivityStatus;
  onCancel?: () => void;
  updatedAt: number;
  autoCloseMs: number;
}

interface ProgressWindow {
  document: Document;
  root: HTMLDivElement;
  heading: HTMLElement;
  spinner: HTMLSpanElement;
  details: HTMLDivElement;
  scope: HTMLDivElement;
  message: HTMLDivElement;
  summary: HTMLDivElement;
  progress: HTMLProgressElement;
  minimizeButton: HTMLButtonElement;
  timer: ReturnType<typeof setTimeout> | null;
  minimized: boolean;
}

const activities = new Map<number, ProgressActivity>();
const cancellationHandlers = new Set<() => void>();
let nextActivityID = 1;
let progressWindow: ProgressWindow | null = null;
let minimizedPreference = false;
let progressRenderTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRenderDocument: Document | null | undefined;

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return document.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
}

function ensureSpinnerStyle(document: Document): void {
  if (document.getElementById(SPINNER_STYLE_ID)) return;
  const style = element(document, "style");
  style.id = SPINNER_STYLE_ID;
  style.textContent = `
    @keyframes citation-map-update-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

function usableDocument(preferred?: Document | null): Document | null {
  const mainWindow = Zotero.getMainWindow?.() as Window | null;
  if (
    mainWindow &&
    !mainWindow.closed &&
    mainWindow.document?.documentElement
  ) {
    return mainWindow.document;
  }
  if (preferred?.documentElement && !preferred.defaultView?.closed) {
    return preferred;
  }
  return null;
}

function clearCloseTimer(): void {
  if (!progressWindow?.timer) return;
  clearTimeout(progressWindow.timer);
  progressWindow.timer = null;
}

function clearProgressRenderTimer(): void {
  if (progressRenderTimer === null) return;
  clearTimeout(progressRenderTimer);
  progressRenderTimer = null;
}

function cleanupWindow(clearActivities: boolean): void {
  clearCloseTimer();
  clearProgressRenderTimer();
  pendingRenderDocument = undefined;
  progressWindow?.root.remove();
  progressWindow = null;
  if (clearActivities) {
    activities.clear();
    minimizedPreference = false;
  }
}

function setMinimized(minimized: boolean): void {
  minimizedPreference = minimized;
  if (!progressWindow) return;
  progressWindow.minimized = minimized;
  progressWindow.details.style.display = minimized ? "none" : "block";
  progressWindow.heading.style.display = minimized ? "none" : "block";
  progressWindow.spinner.style.display = minimized ? "inline-flex" : "none";
  progressWindow.root.style.width = minimized
    ? "auto"
    : "min(380px, calc(100vw - 36px))";
  progressWindow.root.style.gridTemplateColumns = minimized
    ? "auto auto"
    : "minmax(0, 1fr) auto";
  progressWindow.root.style.padding = minimized ? "7px 8px" : "10px 11px";
  progressWindow.minimizeButton.textContent = minimized ? "▲" : "▼";
  progressWindow.minimizeButton.title = minimized
    ? "Expand the Citation Map update window."
    : "Collapse the Citation Map update window. Updates will continue.";
  progressWindow.minimizeButton.setAttribute(
    "aria-label",
    progressWindow.minimizeButton.title,
  );
}

function cancelAllUpdates(): void {
  const callbacks = new Set<() => void>();
  for (const activity of activities.values()) {
    if (activity.status === "active" && activity.onCancel) {
      callbacks.add(activity.onCancel);
    }
    activity.status = "dismissed";
  }
  for (const callback of cancellationHandlers) callbacks.add(callback);

  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      Zotero.debug(
        `Citation Map: update cancellation hook failed: ${String(error)}`,
      );
    }
  }
  cleanupWindow(true);
}

function makeButton(document: Document, text: string): HTMLButtonElement {
  const button = element(document, "button");
  button.type = "button";
  button.textContent = text;
  Object.assign(button.style, {
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
  return button;
}

function ensureWindow(preferred?: Document | null): ProgressWindow | null {
  const document = usableDocument(preferred);
  if (!document) return null;
  ensureSpinnerStyle(document);
  if (progressWindow?.root.isConnected) {
    if (progressWindow.document === document) return progressWindow;
    cleanupWindow(false);
  }

  const root = element(document, "div");
  root.className = "citation-map-progress-window";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  Object.assign(root.style, {
    position: "fixed",
    bottom: "18px",
    right: "18px",
    zIndex: "2147483647",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "8px",
    width: "min(380px, calc(100vw - 36px))",
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

  const header = element(document, "div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "7px",
    minHeight: "24px",
  });
  const icon = element(document, "img");
  icon.src = ICON;
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  Object.assign(icon.style, {
    width: "18px",
    height: "18px",
    flex: "0 0 auto",
  });
  const heading = element(document, "strong");
  heading.textContent = "Updating Entries";
  heading.style.display = "block";
  const spinner = element(document, "span");
  spinner.textContent = "↻";
  spinner.title = "Update in progress";
  spinner.setAttribute("aria-label", spinner.title);
  Object.assign(spinner.style, {
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    fontSize: "17px",
    lineHeight: "18px",
    transformOrigin: "50% 50%",
    animation: "citation-map-update-spin 1s linear infinite",
  });
  header.append(icon, heading, spinner);

  const details = element(document, "div");
  const scope = element(document, "div");
  Object.assign(scope.style, {
    marginTop: "4px",
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "1.35",
    overflowWrap: "anywhere",
  });
  const message = element(document, "div");
  Object.assign(message.style, {
    marginTop: "2px",
    fontSize: "12px",
    lineHeight: "1.35",
    overflowWrap: "anywhere",
    display: "-webkit-box",
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  });
  const summary = element(document, "div");
  Object.assign(summary.style, {
    marginTop: "2px",
    fontSize: "11px",
    lineHeight: "1.3",
    opacity: "0.75",
  });
  const progress = element(document, "progress");
  progress.max = 1;
  progress.value = 0;
  Object.assign(progress.style, {
    display: "block",
    width: "100%",
    height: "7px",
    marginTop: "7px",
  });
  details.append(scope, message, summary, progress);
  content.append(header, details);

  const controls = element(document, "div");
  Object.assign(controls.style, {
    display: "flex",
    alignItems: "flex-start",
    gap: "2px",
  });
  const minimize = makeButton(document, "▼");
  minimize.title =
    "Collapse the Citation Map update window. Updates will continue.";
  minimize.setAttribute("aria-label", minimize.title);
  const close = makeButton(document, "×");
  close.title = "Cancel all active and queued Citation Map updates.";
  close.setAttribute("aria-label", close.title);
  minimize.addEventListener("click", () =>
    setMinimized(!progressWindow?.minimized),
  );
  close.addEventListener("click", cancelAllUpdates);
  controls.append(minimize, close);
  root.append(content, controls);
  (document.body ?? document.documentElement).appendChild(root);

  progressWindow = {
    document,
    root,
    heading,
    spinner,
    details,
    scope,
    message,
    summary,
    progress,
    minimizeButton: minimize,
    timer: null,
    minimized: false,
  };
  setMinimized(minimizedPreference);
  return progressWindow;
}

function activeActivities(): ProgressActivity[] {
  return [...activities.values()]
    .filter((activity) => activity.status === "active")
    .sort(
      (left, right) => right.updatedAt - left.updatedAt || right.id - left.id,
    );
}

function completedActivities(): ProgressActivity[] {
  return [...activities.values()].filter(
    (activity) =>
      activity.status === "finished" || activity.status === "failed",
  );
}

function friendlyCompletion(message: string): string {
  const trimmed = message.trim();
  if (/^No new citing papers were available$/i.test(trimmed)) {
    return "Citing-paper list is current";
  }
  if (/^No new references were available$/i.test(trimmed)) {
    return "Reference list is current";
  }
  return trimmed || "All update tasks completed";
}

function scheduleWindowClose(milliseconds: number): void {
  if (!progressWindow) return;
  clearCloseTimer();
  progressWindow.timer = setTimeout(() => cleanupWindow(true), milliseconds);
}

function renderNow(preferred?: Document | null): void {
  const window = ensureWindow(preferred);
  if (!window) return;
  clearCloseTimer();

  const active = activeActivities();
  const completed = completedActivities();
  const failed = completed.filter((activity) => activity.status === "failed");

  if (active.length > 0) {
    const foreground = active[0];
    window.scope.textContent =
      active.length === 1
        ? foreground.title
        : `${active.length} update tasks running`;
    window.message.textContent = foreground.message;
    const otherActive = active.length - 1;
    const parts: string[] = [];
    if (completed.length) parts.push(`${completed.length} completed`);
    if (otherActive) parts.push(`${otherActive} other active`);
    window.summary.textContent = parts.join(" · ");
    window.summary.style.display = parts.length ? "block" : "none";

    if (foreground.total !== null && foreground.total > 0) {
      window.progress.max = Math.max(1, foreground.total);
      window.progress.value = Math.max(
        0,
        Math.min(foreground.total, foreground.completed),
      );
    } else {
      window.progress.removeAttribute("value");
    }
    return;
  }

  if (completed.length === 0) {
    // Some high-level updates replace one logical activity with the next. Keep
    // the singleton alive briefly so a minimized window does not disappear and
    // immediately reappear expanded between those phases.
    scheduleWindowClose(EMPTY_ACTIVITY_GRACE_MS);
    return;
  }

  const latest = [...completed].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.id - left.id,
  )[0];
  window.scope.textContent = failed.length
    ? "Update completed with warnings"
    : "Update complete";
  window.message.textContent = friendlyCompletion(latest.message);
  window.summary.textContent =
    completed.length > 1
      ? `${completed.length - failed.length} completed${
          failed.length ? ` · ${failed.length} failed` : ""
        }`
      : "";
  window.summary.style.display = completed.length > 1 ? "block" : "none";
  window.progress.max = 1;
  window.progress.value = 1;
  scheduleWindowClose(
    Math.max(...completed.map((activity) => activity.autoCloseMs)),
  );
}

function scheduleProgressRender(preferred?: Document | null): void {
  if (preferred !== undefined) pendingRenderDocument = preferred;
  if (progressRenderTimer !== null) return;
  progressRenderTimer = setTimeout(() => {
    progressRenderTimer = null;
    const document = pendingRenderDocument;
    pendingRenderDocument = undefined;
    renderNow(document);
  }, PROGRESS_RENDER_DELAY_MS);
}

/**
 * Register work that must be cleared when the user closes the singleton update
 * window. The returned function unregisters the handler.
 */
export function registerUpdateCancellationHandler(
  handler: () => void,
): () => void {
  cancellationHandlers.add(handler);
  return () => cancellationHandlers.delete(handler);
}

/**
 * Create a logical update activity. All activities are rendered through one
 * singleton bottom-right window; concurrent work updates the same window.
 */
export function createUpdateProgress(
  options: UpdateProgressOptions,
): UpdateProgressHandle {
  const id = nextActivityID;
  nextActivityID += 1;
  const activity: ProgressActivity = {
    id,
    title: options.title,
    message: options.message,
    completed: 0,
    total: options.total ?? null,
    status: "active",
    onCancel: options.onCancel,
    updatedAt: Date.now(),
    autoCloseMs: DEFAULT_FINISH_CLOSE_MS,
  };
  activities.set(id, activity);
  renderNow(options.document);

  const update = (operation: (current: ProgressActivity) => void): void => {
    const current = activities.get(id);
    if (!current || current.status === "dismissed") return;
    operation(current);
    current.updatedAt = Date.now();
    scheduleProgressRender(options.document);
  };

  return {
    setMessage(message) {
      update((current) => {
        current.message = message;
      });
    },
    setProgress(completed, total, message) {
      update((current) => {
        current.completed = Math.max(0, completed);
        current.total = Math.max(1, total);
        if (message) current.message = message;
      });
    },
    finish(message, autoCloseMs = DEFAULT_FINISH_CLOSE_MS) {
      update((current) => {
        current.status = "finished";
        current.message = message;
        current.completed = current.total ?? 1;
        current.total = current.total ?? 1;
        current.autoCloseMs = autoCloseMs;
      });
    },
    fail(message, autoCloseMs = DEFAULT_FAILURE_CLOSE_MS) {
      update((current) => {
        current.status = "failed";
        current.message = message;
        current.autoCloseMs = autoCloseMs;
      });
    },
    minimize() {
      setMinimized(true);
    },
    restore() {
      setMinimized(false);
    },
    dismiss() {
      const current = activities.get(id);
      if (!current) return;
      current.status = "dismissed";
      activities.delete(id);
      scheduleProgressRender(options.document);
    },
    isDismissed: () => !activities.has(id),
    isMinimized: () => progressWindow?.minimized ?? false,
  };
}

export function closeAllUpdateProgress(): void {
  cleanupWindow(true);
}
