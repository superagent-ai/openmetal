export function coalesceAsync(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let pending: Promise<void> | undefined;

  const trigger = (): Promise<void> => {
    if (!running) {
      running = run().finally(() => {
        running = undefined;
      });
      return running;
    }
    pending ??= running
      .catch(() => undefined)
      .then(() => {
        pending = undefined;
        return trigger();
      });
    return pending;
  };

  return trigger;
}
