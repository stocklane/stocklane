import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { sanitizePagination } from '@/lib/validation';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const { searchParams } = new URL(request.url);
    const channelRaw = searchParams.get('channel');
    // SECURITY: Validate channel against known values to prevent arbitrary filter injection
    const ALLOWED_CHANNELS = ['shopify', 'ebay', 'amazon', 'manual'] as const;
    const channel = channelRaw && (ALLOWED_CHANNELS as readonly string[]).includes(channelRaw) ? channelRaw : null;
    // SECURITY: Sanitize pagination to prevent unbounded queries
    const { limit, offset } = sanitizePagination(searchParams.get('limit'), searchParams.get('offset'), 250);

    let query = supabase
      .from('shopify_orders')
      .select(`
        id,
        shopify_order_id,
        order_number,
        channel,
        status,
        financial_status,
        fulfillment_status,
        customer_email,
        customer_name,
        total_price,
        currency,
        line_items,
        processed_at,
        created_at
      `)
      .eq('user_id', user.id)
      .order('processed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (channel) {
      query = query.eq('channel', channel);
    }

    const { data: orders, error, count } = await query;

    if (error) {
      console.error('Orders query error:', error);
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
    }

    const orderIds = (orders as any[])?.map((o: any) => o.id) || [];

    let inventoryEffects: Record<string, Array<{ product_id: string; quantity_change: number; product_name?: string }>> = {};

    if (orderIds.length > 0) {
      const { data: effects } = await supabase
        .from('order_inventory_effects')
        .select(`
          order_id,
          product_id,
          quantity_change,
          products (name)
        `)
        .in('order_id', orderIds);

      if (effects) {
        for (const e of effects) {
          if (!inventoryEffects[e.order_id]) {
            inventoryEffects[e.order_id] = [];
          }
          inventoryEffects[e.order_id].push({
            product_id: e.product_id,
            quantity_change: e.quantity_change,
            product_name: (e.products as any)?.name,
          });
        }
      }
    }

    const enrichedOrders = (orders as any[])?.map((order: any) => ({
      ...order,
      inventory_effects: inventoryEffects[order.id] || [],
    }));

    return NextResponse.json({
      orders: enrichedOrders,
      total: count,
    });
  } catch (error) {
    console.error('Get orders error:', error);
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
  }
}
