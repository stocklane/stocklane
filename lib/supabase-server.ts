import { createClient } from '@supabase/supabase-js';

let serverSupabaseInstance: any = null;

function createServerSupabase() {
  const serverSupabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serverSupabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serverSupabaseUrl || !serverSupabaseServiceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in server environment');
  }

  return createClient(serverSupabaseUrl, serverSupabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getServerSupabaseClient() {
  if (!serverSupabaseInstance) {
    serverSupabaseInstance = createServerSupabase();
  }

  return serverSupabaseInstance;
}

// Delay client creation until the first real use so build-time module evaluation
// for API routes does not fail when deployment env vars are absent.
export const serverSupabase = new Proxy({} as any, {
  get(_target, prop, receiver) {
    return Reflect.get(getServerSupabaseClient(), prop, receiver);
  },
}) as any;
