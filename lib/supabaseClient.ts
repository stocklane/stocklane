import { createClient } from '@supabase/supabase-js';

let supabaseInstance: any = null;

function createBrowserSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  // SECURITY: Read credentials from environment variables only – never hardcode keys
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in environment variables',
    );
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
    },
  });
}

function getBrowserSupabaseClient() {
  if (!supabaseInstance) {
    supabaseInstance = createBrowserSupabase();
  }

  return supabaseInstance;
}

// Keep a stable export shape while deferring env validation until runtime use.
export const supabase = new Proxy({} as any, {
  get(_target, prop, receiver) {
    return Reflect.get(getBrowserSupabaseClient(), prop, receiver);
  },
}) as any;
