import { createClient } from '@supabase/supabase-js';

// Server-side Supabase for admin operations (API routes only)
const serverSupabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serverSupabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Use lazy initialization or fallback to prevent build-time crashes
export const serverSupabase = (serverSupabaseUrl && serverSupabaseServiceKey) 
  ? createClient(serverSupabaseUrl, serverSupabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null as any;

if (!serverSupabase && process.env.NODE_ENV === 'production' && typeof window === 'undefined') {
  console.warn('Warning: Server-side Supabase client could not be initialized. This may cause issues in API routes.');
}
