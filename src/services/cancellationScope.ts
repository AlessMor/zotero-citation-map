export interface CancellationSignal {
  readonly cancelled: boolean;
  subscribe(listener: () => void): () => void;
}

export interface CancellationScope {
  readonly label: string;
  readonly signal: CancellationSignal;
  cancel(): void;
}

class MutableCancellationSignal implements CancellationSignal {
  private listeners = new Set<() => void>();
  private requested = false;

  get cancelled(): boolean {
    return this.requested;
  }

  subscribe(listener: () => void): () => void {
    if (this.requested) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(): void {
    if (this.requested) return;
    this.requested = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Cancellation is best-effort; one listener must not block the rest.
      }
    }
  }
}

export function createCancellationScope(label: string): CancellationScope {
  const signal = new MutableCancellationSignal();
  return {
    label,
    signal,
    cancel: () => signal.cancel(),
  };
}

export function cancellationRequested(
  signal?: CancellationSignal | null,
): boolean {
  return signal?.cancelled === true;
}
