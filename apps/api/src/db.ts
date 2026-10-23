import mongoose from 'mongoose';
import { env, isProd } from './config/env.js';
import { logger } from './lib/logger.js';

// Unknown fields in filters are dropped. Operator injection is prevented upstream:
// bodies are stripped of $-keys and every query parameter passes through a Zod schema.
mongoose.set('strictQuery', true);

export async function connectDb(uri = env.MONGODB_URI) {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  await mongoose.connect(uri, {
    autoIndex: !isProd, // production: run `pnpm --filter @nexus/api db:indexes` on deploy
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });
  logger.info('MongoDB connected');
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
