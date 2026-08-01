/**
 * Small reusable serial queue for lifecycle-bound asynchronous work.
 * Failures are reported to the caller but never poison later tasks.
 */
export class SerializedTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("Task queue is closed."));
    }
    const previous = this.tail.catch(() => undefined);
    const result = previous.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  public close(): void {
    this.accepting = false;
  }

  public reopen(): void {
    this.accepting = true;
  }
}
