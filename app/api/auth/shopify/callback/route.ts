import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const runtime = 'nodejs';

// GET - Handle Shopify OAuth callback
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const shop = searchParams.get('shop');
    const state = searchParams.get('state');
    const hmac = searchParams.get('hmac');

    if (!code || !shop || !state) {
      return redirectWithError(request, 'Missing required OAuth parameters');
    }

    // Extract user ID from state
    const stateParts = state.split(':');
    if (stateParts.length < 2) {
      return redirectWithError(request, 'Invalid state parameter');
    }
    const userId = stateParts[1];

    // Verify HMAC if present
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    const clientId = process.env.SHOPIFY_CLIENT_ID;

    if (!clientSecret || !clientId) {
      return redirectWithError(request, 'Shopify credentials not configured');
    }

    // SECURITY: HMAC must always be present and valid – never skip verification
    if (!hmac) {
      return redirectWithError(request, 'Missing HMAC parameter');
    }

    // Build message from raw query params (no URL encoding), sorted by key
    const entries: [string, string][] = [];
    searchParams.forEach((value, key) => {
      if (key !== 'hmac') {
        entries.push([key, value]);
      }
    });
    entries.sort(([a], [b]) => a.localeCompare(b));
    const message = entries.map(([k, v]) => `${k}=${v}`).join('&');

    const generatedHmac = crypto
      .createHmac('sha256', clientSecret)
      .update(message)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(generatedHmac, 'hex'), Buffer.from(hmac, 'hex'))) {
      console.error('HMAC mismatch for shop:', shop);
      return redirectWithError(request, 'HMAC verification failed');
    }

    // Exchange the code for an access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange error:', errorText);
      return redirectWithError(request, 'Failed to exchange authorization code');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return redirectWithError(request, 'No access token received from Shopify');
    }

    // Verify the token works by fetching shop info
    const shopResponse = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!shopResponse.ok) {
      return redirectWithError(request, 'Failed to verify Shopify connection');
    }

    // Save to user_settings using service-role client
    // SECURITY: Never hardcode Supabase URLs – read from environment variables only
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return redirectWithError(request, 'Server configuration error');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date().toISOString();
    const { error: upsertError } = await supabase
      .from('user_settings')
      .upsert(
        {
          user_id: userId,
          shopify_store_domain: shop,
          shopify_access_token: accessToken,
          shopify_connected_at: now,
          updated_at: now,
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.error('Save settings error:', upsertError);
      return redirectWithError(request, 'Failed to save Shopify credentials');
    }

    // Redirect back to shopify sync preview page with success
    const baseUrl = getBaseUrl(request);
    return NextResponse.redirect(`${baseUrl}/inventory/shopify-sync?shopify=connected`);
  } catch (error) {
    console.error('Shopify callback error:', error);
    return redirectWithError(request, 'An unexpected error occurred');
  }
}

function getBaseUrl(request: NextRequest): string {
  const host = request.headers.get('host') || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

function redirectWithError(request: NextRequest, message: string) {
  const baseUrl = getBaseUrl(request);
  return NextResponse.redirect(
    `${baseUrl}/account?shopify=error&message=${encodeURIComponent(message)}`
  );
}
