import { createClient } from '@supabase/supabase-js';

// SECURITY: Read credentials from environment variables only – never hardcode keys
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Avoid crashing the build if keys are missing (Next.js build phase might not see them)
export const supabase = (supabaseUrl && supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
      },
    })
  : null as any;

if (!supabase && process.env.NODE_ENV === 'production' && typeof window === 'undefined') {
  console.warn('Warning: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.');
}
