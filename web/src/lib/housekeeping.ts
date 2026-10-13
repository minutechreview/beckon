// Periodic server work that must not depend on the process staying alive. On a host that scales to zero
// (Cloud Run) CPU is throttled and the instance may be stopped whenever no request or socket is open,
// so a timer alone is not enough. Each task therefore runs:
//   - when the server starts,
//   - on a timer (this is what drives it on an always-on machine, and while any socket is open),
//   - and opportunistically when traffic arrives (`poke`), if it is due.
// Tasks are idempotent and safe to run in several instances at once (advisory locks, atomic claims).

export interface Task {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

export interface Housekeeping {
  /** Runs every task that is due and not already running. Cheap enough to call on every request. */
  poke(): void;
  /** Runs everything once now and starts the timer. Returns a stop function. */
  start(): () => void;
}

export function createHousekeeping(
  tasks: Task[],
  opts: {
    now?: () => number;
    onError?: (name: string, err: Error) => void;
    /**
     * When it returns false the timer does nothing. `poke()` (traffic arriving) and the run at start-up still do.
     * A host that suspends an idle database (Neon) is kept awake by a timer that queries every few seconds in an
     * idle instance, so there the timer should only run while a socket is open.
     */
    timerWhen?: () => boolean;
  } = {},
): Housekeeping {
  const now = opts.now ?? Date.now;
  const onError = opts.onError ?? ((name, err) => console.error(`[${name}]`, err.message));
  const last = new Map<string, number>();
  const running = new Set<string>();

  const runTask = (t: Task) => {
    if (running.has(t.name)) return;
    running.add(t.name);
    last.set(t.name, now());
    void t.run().catch((err) => onError(t.name, err as Error)).finally(() => running.delete(t.name));
  };
  const poke = () => {
    const at = now();
    for (const t of tasks) if (at - (last.get(t.name) ?? -Infinity) >= t.everyMs) runTask(t);
  };

  return {
    poke,
    start() {
      for (const t of tasks) runTask(t);
      // Tick at the shortest period; poke() decides which tasks are due.
      const timer = setInterval(() => {
        if (!opts.timerWhen || opts.timerWhen()) poke();
      }, Math.min(...tasks.map((t) => t.everyMs)));
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
