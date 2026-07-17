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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProvider(provider: CitationProviderID): Promise<void> {
  const minimumDelay = MIN_DELAY_MS[provider];
  const previous = lastRequestAt.get(provider) ?? 0;
  const remaining = minimumDelay - (Date.now() - previous);

  if (remaining > 0) {
    await delay(remaining);
  }

  lastRequestAt.set(provider, Date.now());
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

export async function requestJSON<T>(
  provider: CitationProviderID,
  url: string,
): Promise<HTTPResult<T>> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    await waitForProvider(provider);

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
      })) as unknown as ZoteroHTTPResponse;

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
    }
  }

  return {
    ok: false,
    status: 0,
    data: null,
    message: `${provider} request failed`,
  };
}
