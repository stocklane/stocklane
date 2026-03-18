import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { SHOPIFY_ADMIN_API_VERSION } from '@/lib/shopify/api-version';

export const runtime = 'nodejs';

// GET - Fetch account info and settings
export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    // SECURITY: Rate limit per IP + user
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    // Fetch user settings (Shopify config etc.)
    const { data: settings } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', user.id)
      .single();

    return NextResponse.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
        },
        settings: settings
          ? {
              shopifyStoreDomain: settings.shopify_store_domain || null,
              shopifyConnected: !!settings.shopify_access_token,
              shopifyConnectedAt: settings.shopify_connected_at || null,
            }
          : {
              shopifyStoreDomain: null,
              shopifyConnected: false,
              shopifyConnectedAt: null,
            },
      },
    });
  } catch (error) {
    console.error('Get account error:', error);
    return NextResponse.json(
      { error: 'Failed to load account settings' },
      { status: 500 }
    );
  }
}

// PUT - Update account settings
export async function PUT(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    // SECURITY: Rate limit per IP + user
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const body = await request.json();
    const { action } = body;

    // SECURITY: Validate action is a known value
    if (typeof action !== 'string' || !['connect_shopify', 'disconnect_shopify'].includes(action)) {
      return NextResponse.json(
        { error: 'Invalid action. Must be connect_shopify or disconnect_shopify' },
        { status: 400 }
      );
    }

    // Handle Shopify connect
    if (action === 'connect_shopify') {
      const { storeDomain, accessToken } = body;

      if (!storeDomain || typeof storeDomain !== 'string' || storeDomain.length > 253) {
        return NextResponse.json(
          { error: 'Shopify store domain is required' },
          { status: 400 }
        );
      }

      if (!accessToken || typeof accessToken !== 'string') {
        return NextResponse.json(
          { error: 'Shopify access token is required' },
          { status: 400 }
        );
      }

      // Normalize store domain
      let normalizedDomain = storeDomain.trim().toLowerCase();
      normalizedDomain = normalizedDomain.replace(/^https?:\/\//, '');
      normalizedDomain = normalizedDomain.replace(/\/$/, '');
      if (!normalizedDomain.includes('.myshopify.com')) {
        normalizedDomain = normalizedDomain.replace('.myshopify.com', '') + '.myshopify.com';
      }

      // Test the connection by making a request to the Shopify API
      try {
        const testResponse = await fetch(`https://${normalizedDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/shop.json`, {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        });

        if (!testResponse.ok) {
          return NextResponse.json(
            { error: 'Failed to connect to Shopify. Please check your store domain and access token.' },
            { status: 400 }
          );
        }
      } catch (fetchError) {
        return NextResponse.json(
          { error: 'Unable to reach Shopify store. Please check the store domain.' },
          { status: 400 }
        );
      }

      // Upsert settings
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('user_settings')
        .upsert(
          {
            user_id: user.id,
            shopify_store_domain: normalizedDomain,
            shopify_access_token: accessToken,
            shopify_connected_at: now,
            updated_at: now,
          },
          { onConflict: 'user_id' }
        );

      if (error) {
        console.error('Save Shopify settings error:', error);
        return NextResponse.json(
          { error: 'Failed to save Shopify settings' },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        message: 'Shopify account connected successfully',
        data: {
          shopifyStoreDomain: normalizedDomain,
          shopifyConnected: true,
          shopifyConnectedAt: now,
        },
      });
    }

    // Handle Shopify disconnect
    if (action === 'disconnect_shopify') {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('user_settings')
        .upsert(
          {
            user_id: user.id,
            shopify_store_domain: null,
            shopify_access_token: null,
            shopify_connected_at: null,
            updated_at: now,
          },
          { onConflict: 'user_id' }
        );

      if (error) {
        console.error('Disconnect Shopify error:', error);
        return NextResponse.json(
          { error: 'Failed to disconnect Shopify' },
          { status: 500 }
        );
      }

      // Remove synced Shopify orders for this user
      const { error: deleteError } = await supabase
        .from('shopify_orders')
        .delete()
        .eq('user_id', user.id);

      if (deleteError) {
        console.error('Delete orders error:', deleteError);
      }

      return NextResponse.json({
        success: true,
        message: 'Shopify account disconnected',
      });
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Update account error:', error);
    return NextResponse.json(
      { error: 'Failed to update account settings' },
      { status: 500 }
    );
  }
}
