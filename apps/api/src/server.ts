import { createApp } from './app.js';
import { connectDb, disconnectDb } from './db.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { expireFeatured } from './services/featured.service.js';
import { ensureDefaultPlan, sendPlanReminders, syncPlanPerks } from './services/billing.service.js';
import { migrateSeekers } from './services/user.service.js';

async function main() {
  await connectDb();
  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () =>
    logger.info(`API listening on http://${env.HOST}:${env.PORT}`),
  );
  server.keepAliveTimeout = 65_000; // longer than Nginx's upstream keepalive
  server.headersTimeout = 66_000;

  await ensureDefaultPlan().catch((err) => logger.warn({ err }, 'default plan'));
  // Buyers and tenants from the number popup get their own account type.
  await migrateSeekers()
    .then((n) => n && logger.info({ n }, 'buyer/tenant accounts moved to seeker'))
    .catch((err) => logger.warn({ err }, 'seeker migration'));

  // Featured placements end on their date; plan-ending reminders go out.
  const sweep = () => {
    void expireFeatured().catch((err) => logger.warn({ err }, 'expire sweep'));
    void sendPlanReminders().catch((err) => logger.warn({ err }, 'plan reminders'));
    void syncPlanPerks().catch((err) => logger.warn({ err }, 'plan perks'));
  };
  sweep();
  setInterval(sweep, 10 * 60_000).unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    const force = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15_000);
    force.unref();
    server.close(async () => {
      await disconnectDb().catch(() => undefined);
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
