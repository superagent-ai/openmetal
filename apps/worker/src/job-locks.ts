export type JobLockMode = "shared" | "exclusive";

type Waiter = { mode: JobLockMode; limit: number; grant: () => void };
type LockState = { holders: number; exclusive: boolean; waiters: Waiter[] };

function canGrant(state: LockState, mode: JobLockMode, limit: number): boolean {
  if (mode === "exclusive") return state.holders === 0;
  return !state.exclusive && state.holders < limit;
}

// In-process reader/writer locks keyed by resource. Waiters are granted in
// arrival order, so a queued exclusive holder is not starved by later shared ones.
export class JobLocks {
  private readonly states = new Map<string, LockState>();

  acquire(key: string, mode: JobLockMode, limit = Number.POSITIVE_INFINITY): Promise<() => void> {
    let state = this.states.get(key);
    if (!state) {
      state = { holders: 0, exclusive: false, waiters: [] };
      this.states.set(key, state);
    }
    const lock = state;
    return new Promise((resolve) => {
      const grant = () => {
        lock.holders += 1;
        lock.exclusive = mode === "exclusive";
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release(key, lock);
        });
      };
      if (lock.waiters.length === 0 && canGrant(lock, mode, limit)) grant();
      else lock.waiters.push({ mode, limit, grant });
    });
  }

  private release(key: string, lock: LockState) {
    lock.holders -= 1;
    if (lock.holders === 0) lock.exclusive = false;
    while (
      lock.waiters.length > 0 &&
      canGrant(lock, lock.waiters[0]!.mode, lock.waiters[0]!.limit)
    ) {
      lock.waiters.shift()!.grant();
    }
    if (lock.holders === 0 && lock.waiters.length === 0) this.states.delete(key);
  }
}
