import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import crypto from 'crypto';

export const runtime = 'nodejs';

// GET - Initiate Shopify OAuth flow
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);

    const { searchParams } = new URL(request.url);
    const shop = searchParams.get('shop');

    if (!shop) {
      return NextResponse.json({ error: 'Shop domain is required' }, { status: 400 });
    }

    // Normalize shop domain
    let shopDomain = shop.trim().toLowerCase();
    shopDomain = shopDomain.replace(/^https?:\/\//, '');
    shopDomain = shopDomain.replace(/\/$/, '');
    if (!shopDomain.includes('.myshopify.com')) {
      shopDomain = shopDomain + '.myshopify.com';
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json({ error: 'Shopify client ID not configured' }, { status: 500 });
    }

    // Generate a nonce for CSRF protection, encoding the user ID
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = `${nonce}:${user.id}`;

    const scopes = 'read_orders,read_products,write_products,read_inventory,write_inventory,read_locations,read_customers';
    const redirectUri = `${getBaseUrl(request)}/api/auth/shopify/callback`;

    const authUrl = `https://${shopDomain}/admin/oauth/authorize?` +
      `client_id=${clientId}` +
      `&scope=${scopes}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return NextResponse.json({ success: true, authUrl });
  } catch (error) {
    console.error('Shopify OAuth init error:', error);
    return NextResponse.json(
      { error: 'Failed to initiate Shopify connection' },
      { status: 500 }
    );
  }
}

function getBaseUrl(request: NextRequest): string {
  const host = request.headers.get('host') || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}`;
}
