/**
 * Cooperative scheduling helpers for work that must run in Zotero's main
 * JavaScript context. Network requests are already asynchronous, but parsing,
 * merging, persistence preparation, and UI publication can still monopolize
 * the event loop. These helpers split that CPU work into short slices so
 * Zotero can repaint and process input between batches.
 */

const DEFAULT_SLICE_BUDGET_MS = 8;

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/** Yield back to Zotero's event loop and resume in a later task. */
export function yieldToUI(delayMs = 0): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Return a checkpoint that yields whenever the current CPU slice exceeds its
 * budget. Passing `true` forces an immediate yield after a known-heavy phase.
 */
export function createCooperativeCheckpoint(
  budgetMs = DEFAULT_SLICE_BUDGET_MS,
): (force?: boolean) => Promise<void> {
  let sliceStartedAt = now();
  return async (force = false): Promise<void> => {
    if (!force && now() - sliceStartedAt < budgetMs) return;
    await yieldToUI();
    sliceStartedAt = now();
  };
}

/** Map values while periodically yielding to the Zotero UI thread. */
export async function mapCooperatively<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => R | Promise<R>,
  options: { budgetMs?: number; forceEvery?: number } = {},
): Promise<R[]> {
  const checkpoint = createCooperativeCheckpoint(options.budgetMs);
  const forceEvery = Math.max(1, options.forceEvery ?? 25);
  const output: R[] = [];
  for (let index = 0; index < values.length; index += 1) {
    output.push(await mapper(values[index], index));
    await checkpoint((index + 1) % forceEvery === 0);
  }
  return output;
}

/** Iterate values while periodically yielding to the Zotero UI thread. */
export async function forEachCooperatively<T>(
  values: readonly T[],
  callback: (value: T, index: number) => void | Promise<void>,
  options: { budgetMs?: number; forceEvery?: number } = {},
): Promise<void> {
  const checkpoint = createCooperativeCheckpoint(options.budgetMs);
  const forceEvery = Math.max(1, options.forceEvery ?? 25);
  for (let index = 0; index < values.length; index += 1) {
    await callback(values[index], index);
    await checkpoint((index + 1) % forceEvery === 0);
  }
}

export interface BoundedMapOptions {
  /** Yield to Zotero's event loop after every completed item. */
  yieldAfterEach?: boolean;
  /** Optional quiet interval that lets input and paint work run first. */
  yieldDelayMs?: number;
}

/**
 * Map values with a fixed upper bound on concurrent operations.
 *
 * Results preserve input order. The first rejected mapper rejects the returned
 * promise, matching Promise.all semantics used by the previous local worker
 * implementations.
 */
export async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => R | Promise<R>,
  options: BoundedMapOptions = {},
): Promise<R[]> {
  if (values.length === 0) return [];
  const output = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
      if (options.yieldAfterEach) {
        await yieldToUI(Math.max(0, options.yieldDelayMs ?? 0));
      }
    }
  }

  const requestedWorkerCount = Number.isFinite(concurrency)
    ? Math.floor(concurrency)
    : 1;
  const workerCount = Math.min(
    Math.max(1, requestedWorkerCount),
    values.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

/** Map values concurrently while retaining every fulfillment or rejection. */
export function settleBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => R | Promise<R>,
  options: BoundedMapOptions = {},
): Promise<Array<PromiseSettledResult<R>>> {
  return mapBounded(
    values,
    concurrency,
    async (value, index): Promise<PromiseSettledResult<R>> => {
      try {
        return { status: "fulfilled", value: await mapper(value, index) };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    },
    options,
  );
}
