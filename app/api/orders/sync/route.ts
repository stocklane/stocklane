import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { resolveProductIdFromVariantOrSku } from '@/lib/shopify/webhooks/supabase';
import { SHOPIFY_ADMIN_API_VERSION } from '@/lib/shopify/api-version';

export const runtime = 'nodejs';

function getCustomerName(order: any): string | null {
  // Try shipping address first, then billing address
  const addr = order.shippingAddress || order.billingAddress;
  if (addr) {
    const name = `${addr.firstName || ''} ${addr.lastName || ''}`.trim();
    if (name) return name;
  }
  return null;
}

// POST - Sync orders from the user's linked Shopify account
export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    // SECURITY: Rate limit – sync is expensive, allow 30 requests/min
    const blocked = applyRateLimit(request, user.id, { limit: 30, windowMs: 60_000 });
    if (blocked) return blocked;

    // Get the user's Shopify credentials
    const { data: settings } = await supabase
      .from('user_settings')
      .select('shopify_store_domain, shopify_access_token')
      .eq('user_id', user.id)
      .single();

    if (!settings?.shopify_store_domain || !settings?.shopify_access_token) {
      return NextResponse.json(
        { error: 'Shopify account not connected. Go to Account Settings to link your store.' },
        { status: 400 }
      );
    }

    const { shopify_store_domain: domain, shopify_access_token: token } = settings;

    // Fetch orders via Shopify GraphQL Admin API (avoids protected customer data restrictions)
    const shopifyHeaders = {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    };

    const graphqlQuery = `{
      orders(first: 250, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            email
            createdAt
            processedAt
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            shippingAddress {
              firstName
              lastName
            }
            billingAddress {
              firstName
              lastName
            }
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  sku
                  variant {
                    id
                  }
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;

    const shopifyRes = await fetch(`https://${domain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: shopifyHeaders,
      body: JSON.stringify({ query: graphqlQuery }),
    });

    if (!shopifyRes.ok) {
      const errorText = await shopifyRes.text();
      console.error('Shopify GraphQL error:', shopifyRes.status, errorText);
      return NextResponse.json(
        { error: `Shopify API error: ${shopifyRes.status}. Check your credentials in Account Settings.` },
        { status: 502 }
      );
    }

    const graphqlData = await shopifyRes.json();

    if (graphqlData.errors && !graphqlData.data) {
      // Only fail if there's no data at all (complete failure)
      console.error('Shopify GraphQL errors:', graphqlData.errors);
      return NextResponse.json(
        { error: `Shopify API error: ${graphqlData.errors[0]?.message || 'Unknown error'}` },
        { status: 502 }
      );
    }

    if (graphqlData.errors) {
      // Partial errors (e.g. missing customer scope) - log but continue
      console.warn('Shopify GraphQL partial errors (non-fatal):', graphqlData.errors.map((e: any) => e.message));
    }

    const shopifyOrders = (graphqlData.data?.orders?.edges || []).map((edge: any) => edge.node);

    if (shopifyOrders.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No orders found in Shopify',
        synced: 0,
        total: 0,
      });
    }

    // Upsert orders into shopify_orders table
    let synced = 0;
    let errors = 0;

    for (const order of shopifyOrders) {
      // Map GraphQL line items
      const lineItems = (order.lineItems?.edges || []).map((edge: any) => {
        const item = edge.node;
        return {
          variant_id: item.variant?.id ? item.variant.id.replace('gid://shopify/ProductVariant/', '') : null,
          sku: item.sku || null,
          title: item.title || '',
          quantity: item.quantity || 0,
          price: item.originalUnitPriceSet?.shopMoney?.amount || '0.00',
        };
      });

      // Extract numeric order ID from GraphQL global ID (gid://shopify/Order/12345)
      const shopifyOrderId = order.id.replace('gid://shopify/Order/', '');

      // Map GraphQL status enums to lowercase
      const financialStatus = order.displayFinancialStatus
        ? order.displayFinancialStatus.toLowerCase()
        : null;
      const fulfillmentStatus = order.displayFulfillmentStatus
        ? order.displayFulfillmentStatus.toLowerCase()
        : null;

      const totalPrice = parseFloat(order.totalPriceSet?.shopMoney?.amount || '0');
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || 'GBP';

      const orderData = {
        shopify_order_id: shopifyOrderId,
        order_number: String(order.name || '').replace('#', ''),
        channel: 'shopify',
        status: order.cancelledAt ? 'cancelled' : 'active',
        financial_status: financialStatus,
        fulfillment_status: fulfillmentStatus,
        customer_email: order.email || null,
        customer_name: getCustomerName(order),
        total_price: totalPrice,
        currency,
        line_items: lineItems,
        raw_payload: order,
        processed_at: order.processedAt || order.createdAt,
        created_at: order.createdAt,
        user_id: user.id,
        updated_at: new Date().toISOString(),
      };

      const { data: internalOrder, error: upsertError } = await supabase
        .from('shopify_orders')
        .upsert(orderData, {
          onConflict: 'shopify_order_id',
        })
        .select('id')
        .single();

      if (upsertError || !internalOrder) {
        console.error(`Failed to upsert order ${order.id}:`, upsertError?.message);
        errors++;
      } else {
        synced++;
        
        // --- INVENTORY EFFECT ENGINE ---
        // Resolve products and record inventory effects if not already present
        const { data: existingEffects } = await supabase
          .from('order_inventory_effects')
          .select('id')
          .eq('order_id', internalOrder.id);
        
        if (!existingEffects || existingEffects.length === 0) {
          for (const item of lineItems) {
            try {
              const productId = await resolveProductIdFromVariantOrSku(supabase, {
                shopifyVariantId: item.variant_id,
                sku: item.sku
              });

              if (productId) {
                // 1. Record for UI
                await supabase.from('order_inventory_effects').insert({
                  order_id: internalOrder.id,
                  product_id: productId,
                  quantity_change: -item.quantity
                });

                // 2. Apply actual inventory deduction (idempotent via RPC)
                await supabase.rpc('apply_shopify_inventory_effect', {
                  p_webhook_id: `sync-${shopifyOrderId}-${productId}`,
                  p_product_id: productId,
                  p_delta: -item.quantity,
                  p_context: { 
                    order_number: orderData.order_number, 
                    source: 'manual_sync_v1' 
                  }
                });
              }
            } catch (err) {
              console.error(`Error resolving line item for order ${shopifyOrderId}:`, err);
            }
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${synced} orders from Shopify${errors > 0 ? ` (${errors} errors)` : ''}`,
      synced,
      errors,
      total: shopifyOrders.length,
    });
  } catch (error) {
    console.error('Sync orders error:', error);
    return NextResponse.json(
      { error: 'Failed to sync orders from Shopify' },
      { status: 500 }
    );
  }
}
