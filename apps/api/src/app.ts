import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import swaggerUi from 'swagger-ui-express';
import { env, corsOrigins, isTest } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { limiters, originCheck, sanitizeBody } from './middleware/security.js';
import { publicRouter } from './routes/public.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { meRouter } from './routes/me.routes.js';
import { openApiDocument } from './docs/openapi.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  // Sorted, case-sensitive query parsing; arrays limited by the "simple" parser.
  app.set('query parser', 'simple');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          // Swagger UI needs these when docs are enabled.
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || corsOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      maxAge: 600,
    }),
  );
  app.use(compression());
  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
        customLogLevel: (_req, res, err) =>
          err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      }),
    );
  }
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use(sanitizeBody);
  app.use(originCheck);

  app.get('/api/v1/health', async (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    let dbPing = false;
    if (dbUp)
      dbPing = await mongoose.connection
        .db!.admin()
        .ping()
        .then(() => true)
        .catch(() => false);
    res.set('Cache-Control', 'no-store');
    res.status(dbPing ? 200 : 503).json({
      ok: dbPing,
      data: {
        status: dbPing ? 'ok' : 'degraded',
        db: dbPing ? 'up' : 'down',
        uptime: Math.round(process.uptime()),
      },
    });
  });

  app.use('/api/v1', limiters.global);
  app.use('/api/v1', publicRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/me', meRouter);

  if (env.ENABLE_API_DOCS) {
    app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument));
    app.use(
      '/api/docs',
      swaggerUi.serve,
      swaggerUi.setup(openApiDocument, { customSiteTitle: 'NEXUS API' }),
    );
  }

  if (env.UPLOAD_DRIVER === 'local') {
    app.use(
      '/uploads',
      express.static(path.resolve(env.LOCAL_UPLOAD_DIR), {
        maxAge: '7d',
        setHeaders: (res) => res.set('Cross-Origin-Resource-Policy', 'cross-origin'),
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
