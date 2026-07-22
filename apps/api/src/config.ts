import { z } from 'zod';
const secret = z.string().min(16);
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);
const optionalEnv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());
const defaultedEnv = <T extends z.ZodTypeAny>(schema: T, defaultValue: z.input<T>) =>
  z.preprocess(blankToUndefined, schema.default(defaultValue));
const envBoolean = z.preprocess(
  (value) =>
    value === '' ? undefined : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean().default(false),
);
const schema = z.object({
  NODE_ENV: defaultedEnv(z.enum(['development', 'test', 'production']), 'development'),
  RESTEC_ENV: z.enum(['sandbox', 'production', 'test']),
  RESTEC_REPOSITORY_DRIVER: z.enum(['memory', 'supabase']),
  RESTEC_PUBLIC_BASE_URL: z.string().url(),
  RESTEC_DATABASE_URL: optionalEnv(z.string()),
  SUPABASE_URL: optionalEnv(z.string().url()),
  SUPABASE_SERVICE_ROLE_KEY: optionalEnv(secret),
  PAELY_PRIVATE_BASE_URL: z.string().url(),
  PAELY_SERVICE_ID: z.string().min(1),
  PAELY_PRIVATE_BEARER_TOKEN: secret,
  PAELY_PRIVATE_SIGNING_SECRET: secret,
  PAELY_EVENT_SIGNING_SECRET: secret,
  RESTEC_API_KEY_HASH_SECRET: z.string().min(32),
  RESTEC_SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be a base64-encoded 32-byte key'),
  RESTEC_WEBHOOK_MASTER_KEY: optionalEnv(secret),
  RESTEC_TIMESTAMP_TOLERANCE_SECONDS: defaultedEnv(z.coerce.number().int().min(30).max(900), 300),
  RESTEC_PRIVATE_REQUEST_TIMEOUT_MS: defaultedEnv(
    z.coerce.number().int().min(500).max(30000),
    5000,
  ),
  RESTEC_POS_DELIVERY_TIMEOUT_MS: defaultedEnv(z.coerce.number().int().min(500).max(30000), 5000),
  RESTEC_MAX_DELIVERY_ATTEMPTS: defaultedEnv(z.coerce.number().int().min(1).max(50), 10),
  RESTEC_DISPATCH_BATCH_SIZE: defaultedEnv(z.coerce.number().int().min(1).max(100), 25),
  RESTEC_INTERNAL_JOB_TOKEN: secret,
  RESTEC_STRICT_RATE_LIMITING: envBoolean,
  RESTEC_SHARED_RATE_LIMITER_URL: optionalEnv(z.string().url()),
  RESTEC_SHARED_RATE_LIMITER_TOKEN: optionalEnv(secret),
  CRON_SECRET: optionalEnv(secret),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const config = schema.parse(env);
  if (
    (config.RESTEC_ENV === 'sandbox' || config.RESTEC_ENV === 'production') &&
    config.RESTEC_REPOSITORY_DRIVER !== 'supabase'
  )
    throw new Error('RESTEC_REPOSITORY_DRIVER=supabase is required in sandbox and production.');
  if (
    config.RESTEC_REPOSITORY_DRIVER === 'supabase' &&
    (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY)
  )
    throw new Error('Supabase repository configuration is incomplete.');
  if (config.RESTEC_ENV === 'production') {
    if (!config.RESTEC_PUBLIC_BASE_URL.startsWith('https://'))
      throw new Error('RESTEC_PUBLIC_BASE_URL must use HTTPS in production.');
    if (!config.RESTEC_WEBHOOK_MASTER_KEY || !config.CRON_SECRET)
      throw new Error('Production webhook and scheduler secrets are incomplete.');
    if (
      config.RESTEC_STRICT_RATE_LIMITING &&
      (!config.RESTEC_SHARED_RATE_LIMITER_URL || !config.RESTEC_SHARED_RATE_LIMITER_TOKEN)
    )
      throw new Error('Strict production rate limiting requires a shared limiter.');
  }
  return config;
}
export const sanitizedConfig = (c: Config) => ({
  environment: c.RESTEC_ENV,
  repository_driver: c.RESTEC_REPOSITORY_DRIVER,
  public_base_url: c.RESTEC_PUBLIC_BASE_URL,
  private_base_url_configured: Boolean(c.PAELY_PRIVATE_BASE_URL),
  strict_rate_limiting: c.RESTEC_STRICT_RATE_LIMITING,
  private_timeout_ms: c.RESTEC_PRIVATE_REQUEST_TIMEOUT_MS,
  pos_timeout_ms: c.RESTEC_POS_DELIVERY_TIMEOUT_MS,
  dispatch_batch_size: c.RESTEC_DISPATCH_BATCH_SIZE,
});
