import { z } from 'zod';
const schema = z.object({
  RESTEC_ENV: z.enum(['sandbox', 'production', 'test']),
  RESTEC_PUBLIC_BASE_URL: z.string().url(),
  RESTEC_TIMESTAMP_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  RESTEC_PRIVATE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  RESTEC_POS_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  RESTEC_MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
  RESTEC_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
});
export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv): Config => schema.parse(env);
