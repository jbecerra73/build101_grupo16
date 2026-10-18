// Serializes check-then-write request handlers per run. The lock is per process:
// several dashboard instances over one store would need create-if-absent writes.
const tails = new Map<string, Promise<unknown>>();

export function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(runId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(runId, tail);
  void tail.then(() => {
    if (tails.get(runId) === tail) tails.delete(runId);
  });
  return run;
}
