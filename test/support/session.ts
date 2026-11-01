import type { Clock, IdSource } from "../../src/core/ports.js";
import { SessionLog } from "../../src/core/session/log.js";

// Deterministic ports for session tests: IDs count up per prefix, and the clock ticks one
// second per reading, so every record's ID and `createdAt` are predictable.

export function countingIds(): IdSource {
  const counts = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      return `${prefix}_${String(n).padStart(4, "0")}`;
    },
  };
}

export function tickingClock(start = Date.UTC(2026, 10, 1, 10, 15, 0)): Clock {
  let now = start;
  return {
    now() {
      const date = new Date(now);
      now += 1000;
      return date;
    },
  };
}

export function newLog(): SessionLog {
  return new SessionLog({ clock: tickingClock(), ids: countingIds() });
}

export const hashOf = (byte: string) => `sha256:${byte.repeat(64 / byte.length)}` as const;
