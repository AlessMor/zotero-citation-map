import type { CitationProviderID } from "../domain/citationTypes";

export interface HTTPResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  message: string;
}

interface ZoteroHTTPResponse {
  status: number;
  responseText?: string;
  getResponseHeader?: (name: string) => string | null;
}

const MIN_DELAY_MS: Record<CitationProviderID, number> = {
  openalex: 160,
  "semantic-scholar": 1100,
  crossref: 250,
  opencitations: 360,
  inspire: 360,
};

const lastRequestAt = new Map<CitationProviderID, number>();
const RETRY_DELAYS_MS = [1000, 3000];
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
  if (cancellationRequested || milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      activeDelayCancellers.delete(finish);
      resolve();
    };

    activeDelayCancellers.add(finish);
    timer = setTimeout(finish, milliseconds);
  });
}

async function waitForProvider(provider: CitationProviderID): Promise<void> {
  const minimumDelay = MIN_DELAY_MS[provider];
  const previous = lastRequestAt.get(provider) ?? 0;
  const remaining = minimumDelay - (Date.now() - previous);

  if (remaining > 0) {
    await delay(remaining);
  }

  if (!cancellationRequested) {
    lastRequestAt.set(provider, Date.now());
  }
}

function parseRetryAfter(response: ZoteroHTTPResponse): number | null {
  let header: string | null = null;

  try {
    header = response.getResponseHeader?.("retry-after") ?? null;
  } catch {
    return null;
  }

  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
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
  lastRequestAt.clear();
}

export function isCitationRequestCancellationRequested(): boolean {
  return cancellationRequested;
}

export function cancelPendingCitationRequests(): void {
  cancellationRequested = true;

  for (const cancelDelay of [...activeDelayCancellers]) {
    try {
      cancelDelay();
    } catch {
      // Best-effort timer cancellation.
    }
  }
  activeDelayCancellers.clear();

  for (const cancelRequest of [...activeRequestCancellers]) {
    try {
      cancelRequest();
    } catch {
      // The request may already have completed.
    }
  }
  activeRequestCancellers.clear();
}

export async function requestJSON<T>(
  provider: CitationProviderID,
  url: string,
): Promise<HTTPResult<T>> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (cancellationRequested) {
      return cancelledResult<T>();
    }

    await waitForProvider(provider);

    if (cancellationRequested) {
      return cancelledResult<T>();
    }

    let requestCanceller: (() => void) | null = null;

    try {
      const response = (await Zotero.HTTP.request("GET", url, {
        headers: {
          Accept: "application/json",
        },
        responseType: "text",
        timeout: REQUEST_TIMEOUT_MS,
        // Return the response for every HTTP status so providers can
        // distinguish 404, 429, and server errors themselves.
        successCodes: false,
        cancellerReceiver: (cancel: () => void) => {
          requestCanceller = cancel;
          activeRequestCancellers.add(cancel);
          if (cancellationRequested) {
            cancel();
          }
        },
      } as any)) as unknown as ZoteroHTTPResponse;

      if (cancellationRequested) {
        return cancelledResult<T>();
      }

      const retryable =
        response.status === 0 ||
        response.status === 429 ||
        response.status >= 500;

      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        await delay(parseRetryAfter(response) ?? RETRY_DELAYS_MS[attempt]);
        continue;
      }

      return parseJSON<T>(provider, response);
    } catch (error) {
      if (cancellationRequested) {
        return cancelledResult<T>();
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        await delay(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      return {
        ok: false,
        status: 0,
        data: null,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (requestCanceller) {
        activeRequestCancellers.delete(requestCanceller);
      }
    }
  }

  return cancellationRequested
    ? cancelledResult<T>()
    : {
        ok: false,
        status: 0,
        data: null,
        message: `${provider} request failed`,
      };
}
