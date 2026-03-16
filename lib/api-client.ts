import { supabase } from './supabaseClient';

/**
 * Authenticated fetch wrapper that automatically adds auth headers
 */
export async function authenticatedFetch(url: string, options: RequestInit = {}) {
  // Get the current session
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session?.access_token) {
    throw new Error('No authentication token found');
  }

  // Add authorization header
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
  
  // Add existing headers if any
  if (options.headers) {
    Object.entries(options.headers).forEach(([key, value]) => {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    });
  }

  // Remove Content-Type for FormData
  if (options.body instanceof FormData) {
    delete headers['Content-Type'];
  }

  return fetch(url, {
    ...options,
    headers,
    cache: options.cache ?? 'no-store',
  });
}
