import { createClient } from '@supabase/supabase-js';
export const createDatabaseClient = (url: string, serviceKey: string) =>
  createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
