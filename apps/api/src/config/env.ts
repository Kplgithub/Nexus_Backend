import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

    /** Public site origin(s) allowed by CORS, comma separated. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    /** Canonical public URL, used in emails and links. */
    PUBLIC_SITE_URL: z.url().default('http://localhost:3000'),
    /** Number of reverse proxies in front of the API (Nginx = 1). Required for correct client IPs. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    /** Website user sessions (buyers, owners, agents, builders). */
    USER_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    /**
     * SMS for one-time passwords.
     *   disabled — OTP sign-in hidden; phone numbers are not verified.
     *   console  — development only: codes are logged and returned in API responses.
     *   msg91    — production SMS via MSG91 (DLT-approved OTP template required).
     *   bulksms  — production SMS via BulkSMSServiceProviders (DLT-approved template below).
     */
    SMS_DRIVER: z.enum(['disabled', 'console', 'msg91', 'bulksms']).default('disabled'),
    /** BulkSMSServiceProviders gateway. Sender, route and DLT template must match the approved ones. */
    BULKSMS_AUTH_KEY: z.string().optional(),
    BULKSMS_SENDER: z.string().default('DNHIRE'),
    BULKSMS_ROUTE: z.string().default('TR'),
    BULKSMS_OTP_TEMPLATE_ID: z.string().default('1107175679254991157'),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_TEMPLATE_ID: z.string().optional(),
    /** Optional MSG91 Flow (DLT-approved) used to SMS a poster's number to a visitor: vars name, phone, title. */
    MSG91_CONTACT_FLOW_ID: z.string().optional(),
    /** Launch testing: optional ISO date after which the fixed OTP 123456 stops working (a past date turns it off). See lib/test-otp.ts. */
    TEST_OTP_UNTIL: z.string().optional(),
    COOKIE_SECURE: bool,
    COOKIE_DOMAIN: z.string().optional(),

    /** Upload driver: cloudinary in production; local only for development. */
    UPLOAD_DRIVER: z.enum(['cloudinary', 'local']).default('local'),
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    CLOUDINARY_FOLDER: z.string().default('nexus-estate/properties'),
    LOCAL_UPLOAD_DIR: z.string().default('uploads'),
    // Relative by default: the web app proxies /uploads to the API, so images are same-origin.
    LOCAL_UPLOAD_PUBLIC_URL: z.string().default('/uploads'),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: bool,
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().optional(),

    /** WhatsApp Cloud API (Meta) for staff alerts. Unset = WhatsApp alerts off. */
    WHATSAPP_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    /** Approved utility template with one body variable ({{1}}) that carries the alert text. */
    WHATSAPP_TEMPLATE: z.string().default('nexus_alert'),
    WHATSAPP_TEMPLATE_LANG: z.string().default('en'),

    /** Razorpay for paid plans. Unset = online payment off (manual payments still work). */
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    /** Secret set on the Razorpay webhook (Dashboard → Webhooks). Unset = webhook refused. */
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

    ENABLE_API_DOCS: bool,
    /** Seconds; public GET responses get Cache-Control: public, s-maxage=... */
    PUBLIC_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    /** Shared secret Next.js sends when revalidating; optional. */
    REVALIDATE_URL: z.string().optional(),
    REVALIDATE_SECRET: z.string().optional(),
    /** Optional Redis (e.g. redis://:password@127.0.0.1:6379). Unset = everything stays in memory / database. */
    REDIS_URL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.UPLOAD_DRIVER !== 'cloudinary') {
        ctx.addIssue({
          code: 'custom',
          path: ['UPLOAD_DRIVER'],
          message: 'Use cloudinary in production',
        });
      }
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'COOKIE_SECURE must be true in production',
        });
      }
      if (env.SMS_DRIVER === 'console') {
        ctx.addIssue({
          code: 'custom',
          path: ['SMS_DRIVER'],
          message: 'The console SMS driver exposes codes and is not allowed in production',
        });
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: 'Wildcard CORS is not allowed in production',
        });
      }
    }
    if (env.SMS_DRIVER === 'msg91') {
      for (const key of ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'] as const) {
        if (!env[key])
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required for msg91` });
      }
    }
    if (env.SMS_DRIVER === 'bulksms' && !env.BULKSMS_AUTH_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['BULKSMS_AUTH_KEY'],
        message: 'BULKSMS_AUTH_KEY is required for bulksms',
      });
    }
    if (env.UPLOAD_DRIVER === 'cloudinary') {
      for (const key of [
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
      ] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required for cloudinary uploads`,
          });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Fail fast and loudly; never print values, only names.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const mailEnabled = Boolean(env.SMTP_HOST && env.MAIL_FROM);
export const otpEnabled = env.SMS_DRIVER !== 'disabled';
export const whatsappEnabled = Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
export const razorpayEnabled = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
