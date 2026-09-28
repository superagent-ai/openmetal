import { useSyncExternalStore } from "react";

function subscribeToClock(onStoreChange: () => void) {
  const interval = window.setInterval(onStoreChange, 30_000);
  return () => window.clearInterval(interval);
}

function getClockSnapshot() {
  return Math.floor(Date.now() / 30_000) * 30_000;
}

function getServerClockSnapshot() {
  return 0;
}

/** Current time rounded to 30 seconds; 0 during server render so durations hydrate cleanly. */
export function useNow() {
  return useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
}
