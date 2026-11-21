const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Calendar day in India time as YYYY-MM-DD. */
export function indiaDay(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The last `n` India-time days, oldest first, ending today. */
export function lastIndiaDays(n: number, now: Date = new Date()): string[] {
  return Array.from({ length: n }, (_, i) =>
    indiaDay(new Date(now.getTime() - (n - 1 - i) * 24 * 60 * 60 * 1000)),
  );
}

/** Start of the given India-time day as a UTC Date. */
export function indiaDayStart(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}
