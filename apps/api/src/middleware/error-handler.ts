import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { AppError, validationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
}

// Express recognises error middleware by its four arguments.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let error: AppError;

  if (err instanceof AppError) error = err;
  else if (err instanceof ZodError) error = validationError(err);
  else if (err instanceof MulterError) {
    error = new AppError(
      400,
      'UPLOAD_ERROR',
      err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large' : 'Upload rejected',
    );
  } else if (err instanceof mongoose.Error.ValidationError) {
    const details: Record<string, string[]> = {};
    for (const [path, e] of Object.entries(err.errors)) details[path] = [e.message];
    error = new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields', details);
  } else if (err instanceof mongoose.Error.CastError) {
    error = new AppError(400, 'BAD_REQUEST', 'Invalid identifier');
  } else if (isDuplicateKey(err)) {
    error = new AppError(409, 'CONFLICT', 'A record with the same unique value already exists');
  } else if (err instanceof SyntaxError && 'body' in err) {
    error = new AppError(400, 'BAD_JSON', 'Malformed JSON body');
  } else if (isPayloadTooLarge(err)) {
    error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request is too large');
  } else {
    error = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }

  if (error.status >= 500)
    logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  else logger.debug({ code: error.code, path: req.path }, error.message);

  // Never leak stack traces or driver messages.
  res.status(error.status).json({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

function isPayloadTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.too.large'
  );
}
