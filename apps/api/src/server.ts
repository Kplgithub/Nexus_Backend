import { createApp } from './app.js';
import { connectDb, disconnectDb } from './db.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

async function main() {
  await connectDb();
  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () =>
    logger.info(`API listening on http://${env.HOST}:${env.PORT}`),
  );
  server.keepAliveTimeout = 65_000; // longer than Nginx's upstream keepalive
  server.headersTimeout = 66_000;

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
