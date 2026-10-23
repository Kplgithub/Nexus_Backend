import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Environment must exist before src/config/env.ts is imported by any test.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-123456';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/placeholder'; // replaced per file by the in-memory server
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.UPLOAD_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'nexus-uploads-'));
process.env.LOG_LEVEL = 'silent';
process.env.ENABLE_API_DOCS = 'true';
process.env.SMS_DRIVER = 'console';
