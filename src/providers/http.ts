import type { CitationProviderID } from "../domain/citationTypes";
import {
  getSemanticScholarAPIKey,
  isProviderEnabled,
} from "../services/citationPreferences";
import { providerExecutionPolicy } from "../services/providerExecutionPolicy";
import type { CancellationSignal } from "../services/cancellationScope";

export interface HTTPResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  message: string;
}

export interface ProviderJSONResponseContext {
  provider: CitationProviderID;
  url: string;
  method: "GET" | "POST";
  data: unknown;
}

export type ProviderJSONResponseObserver = (
  context: ProviderJSONResponseContext,
) => void | Promise<void>;

export interface JSONRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: CancellationSignal;
  /** Override the normal bounded retry count for latency-sensitive batches. */
  retryLimit?: number;
}

interface ZoteroHTTPResponse {
  status: number;
  responseText?: string;
  getResponseHeader?: (name: string) => string | null;
}

type ZoteroHTTPRequestOptions = NonNullable<
  Parameters<typeof Zotero.HTTP.request>[2]
>;

interface ProviderQueueEntry {
  start: () => Promise<void>;
  cancel: () => void;
  signal?: CancellationSignal;
}

interface ProviderQueueState {
  active: number;
  queue: ProviderQueueEntry[];
  nextStartAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const providerQueues = new Map<CitationProviderID, ProviderQueueState>();
// One bounded retry is enough for interactive updates. Multiple 30-second
// retries used to block every request queued behind one unavailable provider.
const RETRY_DELAYS_MS = [1500];
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 15000;
const activeRequestCancellers = new Set<() => void>();
const responseObservers = new Set<ProviderJSONResponseObserver>();
let cancellationRequested = false;

export function registerProviderJSONResponseObserver(
  observer: ProviderJSONResponseObserver,
): () => void {
  responseObservers.add(observer);
  return () => responseObservers.delete(observer);
}

function notifyResponseObservers(context: ProviderJSONResponseContext): void {
  for (const observer of responseObservers) {
    void Promise.resolve(observer(context)).catch((error: unknown) => {
      Zotero.debug(
        `Citation Map: provider response observer failed: ${String(error)}`,
      );
    });
  }
}

function cancelledResult<T>(): HTTPResult<T> {
  return {
    ok: false,
    status: 0,
    data: null,
    message: "Citation Map request cancelled during shutdown",
  };
}

function requestWasCancelled(signal?: CancellationSignal): boolean {
  return cancellationRequested || signal?.cancelled === true;
}

function disabledProviderResult<T>(
  provider: CitationProviderID,
): HTTPResult<T> {
  return {
    ok: false,
    status: 403,
    data: null,
    message: `${provider} is disabled in Citation Map settings`,
  };
}

function providerParallelism(provider: CitationProviderID): number {
  return providerExecutionPolicy(provider).requestParallelism;
}

function queueState(provider: CitationProviderID): ProviderQueueState {
  const existing = providerQueues.get(provider);
  if (existing) return existing;
  const created: ProviderQueueState = {
    active: 0,
    queue: [],
    nextStartAt: 0,
    timer: null,
  };
  providerQueues.set(provider, created);
  return created;
}

function scheduleProviderPump(
  provider: CitationProviderID,
  state: ProviderQueueState,
): void {
  if (state.timer !== null || cancellationRequested || !state.queue.length) {
    return;
  }
  const wait = Math.max(0, state.nextStartAt - Date.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    pumpProviderQueue(provider, state);
  }, wait);
}

function pumpProviderQueue(
  provider: CitationProviderID,
  state = queueState(provider),
): void {
  if (cancellationRequested) {
    for (const entry of state.queue.splice(0)) entry.cancel();
    return;
  }

  for (let index = state.queue.length - 1; index >= 0; index -= 1) {
    const entry = state.queue[index];
    if (!entry.signal?.cancelled) continue;
    state.queue.splice(index, 1);
    entry.cancel();
  }

  const limit = providerParallelism(provider);
  while (state.active < limit && state.queue.length) {
    const remaining = state.nextStartAt - Date.now();
    if (remaining > 0) {
      scheduleProviderPump(provider, state);
      return;
    }

    const entry = state.queue.shift();
    if (!entry) return;
    state.active += 1;
    state.nextStartAt =
      Date.now() + providerExecutionPolicy(provider).minimumStartDelayMs;
    void entry.start().finally(() => {
      state.active = Math.max(0, state.active - 1);
      pumpProviderQueue(provider, state);
    });
  }
}

function postponeProvider(
  provider: CitationProviderID,
  milliseconds: number,
): void {
  const state = queueState(provider);
  const bounded = Math.min(MAX_RETRY_AFTER_MS, Math.max(0, milliseconds));
  state.nextStartAt = Math.max(state.nextStartAt, Date.now() + bounded);
  scheduleProviderPump(provider, state);
}

function runInProviderQueue<T>(
  provider: CitationProviderID,
  task: () => Promise<T>,
  signal?: CancellationSignal,
): Promise<T | null> {
  if (requestWasCancelled(signal)) return Promise.resolve(null);
  const state = queueState(provider);
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    let unsubscribe = (): void => undefined;
    const settleCancelled = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(null);
    };
    unsubscribe = signal?.subscribe(settleCancelled) ?? unsubscribe;
    state.queue.push({
      cancel: settleCancelled,
      signal,
      start: async (): Promise<void> => {
        if (settled || requestWasCancelled(signal)) {
          settleCancelled();
          return;
        }
        try {
          const value = await task();
          if (!settled) {
            settled = true;
            unsubscribe();
            resolve(value);
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            unsubscribe();
            reject(error);
          }
        }
      },
    });
    pumpProviderQueue(provider, state);
  });
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
  for (const [provider, state] of providerQueues.entries()) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    for (const entry of state.queue.splice(0)) entry.cancel();
    state.nextStartAt = 0;
    if (state.active === 0) providerQueues.delete(provider);
  }
  cancellationRequested = false;
}

export function isCitationRequestCancellationRequested(): boolean {
  return cancellationRequested;
}

export function cancelPendingCitationRequests(): void {
  cancellationRequested = true;

  for (const state of providerQueues.values()) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    for (const entry of state.queue.splice(0)) entry.cancel();
  }

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
  options: JSONRequestOptions,
): Promise<HTTPResult<T>> {
  if (!isProviderEnabled(provider)) return disabledProviderResult<T>(provider);

  const requestedRetryLimit = Number.isFinite(options.retryLimit)
    ? Math.floor(options.retryLimit!)
    : RETRY_DELAYS_MS.length;
  const retryLimit = Math.min(
    RETRY_DELAYS_MS.length,
    Math.max(0, requestedRetryLimit),
  );
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    if (requestWasCancelled(options.signal)) return cancelledResult<T>();
    try {
      const response = await runInProviderQueue(
        provider,
        async (): Promise<ZoteroHTTPResponse> => {
          let requestCanceller: (() => void) | null = null;
          try {
            const semanticScholarAPIKey =
              provider === "semantic-scholar" ? getSemanticScholarAPIKey() : "";
            const headers = {
              Accept: "application/json",
              "User-Agent":
                "Zotero-Citation-Map/0.2 (mailto omitted; public API pool)",
              ...(semanticScholarAPIKey
                ? { "x-api-key": semanticScholarAPIKey }
                : {}),
              ...options.headers,
            };
            const body =
              options.body === undefined
                ? undefined
                : typeof options.body === "string"
                  ? options.body
                  : JSON.stringify(options.body);
            const requestOptions: ZoteroHTTPRequestOptions = {
              headers,
              body,
              responseType: "text",
              timeout: REQUEST_TIMEOUT_MS,
              successCodes: false,
              cancellerReceiver: (cancel: () => void) => {
                requestCanceller = cancel;
                activeRequestCancellers.add(cancel);
                if (requestWasCancelled(options.signal)) cancel();
              },
            };
            const unsubscribe = options.signal?.subscribe(() => {
              try {
                requestCanceller?.();
              } catch {
                // The request may already have settled.
              }
            });
            try {
              return await Zotero.HTTP.request(
                options.method ?? "GET",
                url,
                requestOptions,
              );
            } finally {
              unsubscribe?.();
            }
          } finally {
            if (requestCanceller) {
              activeRequestCancellers.delete(requestCanceller);
            }
          }
        },
        options.signal,
      );
      if (!response || requestWasCancelled(options.signal)) {
        return cancelledResult<T>();
      }

      const retryable =
        response.status === 0 ||
        response.status === 429 ||
        response.status >= 500;
      if (retryable && attempt < retryLimit) {
        const retryAfter = parseRetryAfter(response);
        // A long Retry-After should fail this interactive update promptly
        // instead of freezing every request queued for the provider. The next
        // user-initiated refresh can try again later.
        if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
          return parseJSON<T>(provider, response);
        }
        postponeProvider(provider, retryAfter ?? RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const parsed = parseJSON<T>(provider, response);
      if (parsed.ok && parsed.data !== null) {
        notifyResponseObservers({
          provider,
          url,
          method: options.method ?? "GET",
          data: parsed.data,
        });
      }
      return parsed;
    } catch (error) {
      if (requestWasCancelled(options.signal)) return cancelledResult<T>();
      if (attempt < retryLimit) {
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
