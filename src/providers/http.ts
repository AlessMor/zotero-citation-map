import type { CitationProviderID } from "../domain/citationTypes";

export interface HTTPResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  message: string;
}

export interface JSONRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
}

interface ZoteroHTTPResponse {
  status: number;
  responseText?: string;
  getResponseHeader?: (name: string) => string | null;
}

interface ProviderQueueState {
  tail: Promise<void>;
  nextStartAt: number;
}

const MIN_DELAY_MS: Record<CitationProviderID, number> = {
  crossref: 350,
  "semantic-scholar": 1150,
  opencitations: 500,
  inspire: 500,
  openalex: 1100,
};
const providerQueues = new Map<CitationProviderID, ProviderQueueState>();
const RETRY_DELAYS_MS = [1200, 3500];
const REQUEST_TIMEOUT_MS = 30000;
const activeRequestCancellers = new Set<() => void>();
const activeDelayCancellers = new Set<() => void>();
let cancellationRequested = false;

function cancelledResult<T>(): HTTPResult<T> {
  return {
    ok: false,
    status: 0,
    data: null,
    message: "Citation Map request cancelled during shutdown",
  };
}

function delay(milliseconds: number): Promise<void> {
  if (cancellationRequested || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      activeDelayCancellers.delete(finish);
      resolve();
    };
    activeDelayCancellers.add(finish);
    timer = setTimeout(finish, milliseconds);
  });
}

function queueState(provider: CitationProviderID): ProviderQueueState {
  const existing = providerQueues.get(provider);
  if (existing) return existing;
  const created: ProviderQueueState = {
    tail: Promise.resolve(),
    nextStartAt: 0,
  };
  providerQueues.set(provider, created);
  return created;
}

function postponeProvider(
  provider: CitationProviderID,
  milliseconds: number,
): void {
  const state = queueState(provider);
  state.nextStartAt = Math.max(
    state.nextStartAt,
    Date.now() + Math.max(0, milliseconds),
  );
}

async function runInProviderQueue<T>(
  provider: CitationProviderID,
  task: () => Promise<T>,
): Promise<T | null> {
  const state = queueState(provider);
  const previous = state.tail.catch(() => undefined);
  let release = (): void => undefined;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => ticket);

  await previous;
  try {
    const remaining = state.nextStartAt - Date.now();
    if (remaining > 0) await delay(remaining);
    if (cancellationRequested) return null;
    state.nextStartAt = Date.now() + MIN_DELAY_MS[provider];
    return await task();
  } finally {
    release();
  }
}

function parseRetryAfter(response: ZoteroHTTPResponse): number | null {
  try {
    const header = response.getResponseHeader?.("retry-after") ?? null;
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  } catch {
    return null;
  }
}

function parseJSON<T>(
  provider: CitationProviderID,
  response: ZoteroHTTPResponse,
): HTTPResult<T> {
  const responseText = response.responseText ?? "";
  let data: T | null = null;
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText) as T;
    } catch {
      return {
        ok: false,
        status: response.status,
        data: null,
        message: `${provider} returned invalid JSON`,
      };
    }
  }
  const ok = response.status >= 200 && response.status < 300;
  return {
    ok,
    status: response.status,
    data,
    message: ok ? "" : `${provider} returned HTTP ${response.status}`,
  };
}

export function resetCitationRequestCancellation(): void {
  cancellationRequested = false;
  providerQueues.clear();
}

export function isCitationRequestCancellationRequested(): boolean {
  return cancellationRequested;
}

export function cancelPendingCitationRequests(): void {
  cancellationRequested = true;

  for (const cancel of [...activeDelayCancellers]) {
    try {
      cancel();
    } catch {
      // Best-effort cancellation; the delay may already have completed.
    }
  }
  activeDelayCancellers.clear();

  for (const cancel of [...activeRequestCancellers]) {
    try {
      cancel();
    } catch {
      // Best-effort cancellation; the request may already have completed.
    }
  }
  activeRequestCancellers.clear();
}

export async function requestJSON<T>(
  provider: CitationProviderID,
  url: string,
  options: JSONRequestOptions = {},
): Promise<HTTPResult<T>> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (cancellationRequested) return cancelledResult<T>();
    try {
      const response = await runInProviderQueue(
        provider,
        async (): Promise<ZoteroHTTPResponse> => {
          let requestCanceller: (() => void) | null = null;
          try {
            const headers = {
              Accept: "application/json",
              "User-Agent":
                "Zotero-Citation-Map/0.2 (mailto omitted; public API pool)",
              ...options.headers,
            };
            const body =
              options.body === undefined
                ? undefined
                : typeof options.body === "string"
                  ? options.body
                  : JSON.stringify(options.body);
            return (await Zotero.HTTP.request(options.method ?? "GET", url, {
              headers,
              body,
              responseType: "text",
              timeout: REQUEST_TIMEOUT_MS,
              successCodes: false,
              cancellerReceiver: (cancel: () => void) => {
                requestCanceller = cancel;
                activeRequestCancellers.add(cancel);
                if (cancellationRequested) cancel();
              },
            } as any)) as unknown as ZoteroHTTPResponse;
          } finally {
            if (requestCanceller) {
              activeRequestCancellers.delete(requestCanceller);
            }
          }
        },
      );
      if (!response || cancellationRequested) return cancelledResult<T>();

      const retryable =
        response.status === 0 ||
        response.status === 429 ||
        response.status >= 500;
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        postponeProvider(
          provider,
          parseRetryAfter(response) ?? RETRY_DELAYS_MS[attempt],
        );
        continue;
      }
      return parseJSON<T>(provider, response);
    } catch (error) {
      if (cancellationRequested) return cancelledResult<T>();
      if (attempt < RETRY_DELAYS_MS.length) {
        postponeProvider(provider, RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return {
        ok: false,
        status: 0,
        data: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return cancelledResult<T>();
}
