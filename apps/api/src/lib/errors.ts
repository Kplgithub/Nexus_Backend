import type { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: Record<string, string[]>) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

/** Convert Zod issues to { field: [messages] } for form display. */
export function zodDetails(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export function validationError(error: ZodError) {
  return new AppError(
    422,
    'VALIDATION_ERROR',
    'Please check the highlighted fields',
    zodDetails(error),
  );
}
