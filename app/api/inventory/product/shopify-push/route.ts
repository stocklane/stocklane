import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { isValidUUID } from '@/lib/validation';
import {
  calculateAutomatedPrice,
  pushDraftProductToShopify,
  syncShopifyInventory,
  updateShopifyPrice,
} from '@/lib/shopify/actions';

export const runtime = 'nodejs';

type InventoryJoinRow = {
  quantityonhand?: number | string | null;
  averagecostgbp?: number | string | null;
};

function getCalculatedShopifyPrice(params: {
  averageCostGbp: number | null | undefined;
  targetMargin: number | string | null | undefined;
  pricingSalesTaxPct: number | string | null | undefined;
  pricingShopifyFeePct: number | string | null | undefined;
  pricingPostagePackagingGbp: number | string | null | undefined;
}) {
  const targetMargin = Number(params.targetMargin);

  if (!Number.isFinite(targetMargin) || targetMargin <= 0 || targetMargin >= 100) {
    return null;
  }

  return calculateAutomatedPrice({
    averageCost: Number(params.averageCostGbp ?? 0),
    postagePackaging: Number(params.pricingPostagePackagingGbp ?? 0),
    targetMargin,
    salesTaxPct: Number(params.pricingSalesTaxPct ?? 0),
    shopifyFeePct: Number(params.pricingShopifyFeePct ?? 0),
  });
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    // SECURITY: Rate limit
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const body = await request.json();
    const productId = body.productId;

    if (!isValidUUID(productId)) {
      return NextResponse.json({ error: 'Invalid productId' }, { status: 400 });
    }

    // 1. Get product + inventory from DB
    const { data: product, error: productError } = await supabase
      .from('products')
      .select(`
        id,
        name,
        primarysku,
        target_margin,
        pricing_sales_tax_pct,
        pricing_shopify_fee_pct,
        pricing_postage_packaging_gbp,
        inventory(quantityonhand, averagecostgbp)
      `)
      .eq('id', productId)
      .eq('user_id', user.id)
      .single();

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // Supabase returns the joined record as an object for 1-to-1 or an array for 1-to-many.
    // In our schema, a product has one inventory row.
    const inventoryRelation = product.inventory as InventoryJoinRow | InventoryJoinRow[] | null;
    const inventoryRow = Array.isArray(inventoryRelation)
      ? inventoryRelation[0]
      : inventoryRelation;
    const inventoryQty = Number(inventoryRow?.quantityonhand ?? 0);
    const calculatedPrice = getCalculatedShopifyPrice({
      averageCostGbp: inventoryRow?.averagecostgbp,
      targetMargin: product.target_margin,
      pricingSalesTaxPct: product.pricing_sales_tax_pct,
      pricingShopifyFeePct: product.pricing_shopify_fee_pct,
      pricingPostagePackagingGbp: product.pricing_postage_packaging_gbp,
    });

    // 2. Check if already linked
    const { data: existingIntegration } = await supabase
      .from('product_integrations')
      .select('*')
      .eq('product_id', productId)
      .eq('platform', 'shopify')
      .maybeSingle();

    if (existingIntegration) {
      // If already linked, perform a Re-sync of inventory and price
      if (existingIntegration.external_inventory_item_id) {
        await syncShopifyInventory(
          existingIntegration.external_inventory_item_id,
          inventoryQty,
          user.id,
        );
      }

      if (existingIntegration.external_variant_id && calculatedPrice) {
        await updateShopifyPrice(existingIntegration.external_variant_id, calculatedPrice, user.id);
      }

      return NextResponse.json({
        success: true,
        message: calculatedPrice
          ? 'Product quantity and price re-synced to Shopify'
          : 'Product quantity re-synced to Shopify',
        data: existingIntegration
      });
    }

    // 3. Ensure SKU and set shopify_bound
    let sku = product.primarysku;
    const updates: { shopify_bound: boolean; primarysku?: string } = { shopify_bound: true };

    if (!sku) {
      sku = 'SL-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      updates.primarysku = sku;
    }
    
    await supabase.from('products').update(updates).eq('id', productId);

    // 4. Push to Shopify
    const shopifyResult = await pushDraftProductToShopify(
      { name: product.name },
      sku,
      user.id,
      inventoryQty
    );

    if (calculatedPrice) {
      await updateShopifyPrice(shopifyResult.variantId, calculatedPrice, user.id);
    }

    // 5. Save integration
    const { error: insertError } = await supabase
      .from('product_integrations')
      .insert({
        user_id: user.id,
        product_id: productId,
        platform: 'shopify',
        external_product_id: shopifyResult.productId,
        external_variant_id: shopifyResult.variantId,
        external_inventory_item_id: shopifyResult.inventoryItemId
      });

    if (insertError) {
      console.error('Failed to save product integration after Shopify push:', insertError);
      // We still return success because the product WAS created on Shopify
    }

    return NextResponse.json({
      success: true,
      message: 'Product pushed to Shopify as a draft',
      data: shopifyResult
    });

  } catch (error: unknown) {
    console.error('Shopify Push Error:', error);
    const message = error instanceof Error ? error.message : 'Failed to push product to Shopify';
    
    // Auto-cleanup stale integration if product was deleted on Shopify
    if (message.includes('does not exist')) {
       try {
         const { supabase } = await requireAuth(request);
         const body = await request.json();
         const productId = body.productId;
         
         await supabase
          .from('product_integrations')
          .delete()
          .eq('product_id', productId)
          .eq('platform', 'shopify');
         console.log('Cleared stale Shopify integration on manual push for product:', productId);
       } catch (cleanupErr) {
         console.error('Failed to cleanup stale integration:', cleanupErr);
       }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
