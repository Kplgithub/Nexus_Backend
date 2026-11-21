import { connectDb, disconnectDb } from '../db.js';
import { flushWebsiteRefresh } from '../lib/web-revalidate.js';

/** Small wrapper so every script connects, runs, and always disconnects. */
export async function runScript(name: string, fn: () => Promise<void>) {
  try {
    await connectDb();
    await fn();
    // Send any pending website cache refresh before the process exits.
    await flushWebsiteRefresh();
    console.warn(`✔ ${name} finished`);
  } catch (err) {
    console.error(`✖ ${name} failed:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await disconnectDb().catch(() => undefined);
    // Exit explicitly so open handles (log transports, timers) can never keep a script alive.
    process.exit(process.exitCode ?? 0);
  }
}
