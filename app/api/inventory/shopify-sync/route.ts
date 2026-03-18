import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import {
  calculateAutomatedPrice,
  pushDraftProductToShopify,
  syncShopifyInventory,
  updateShopifyPrice,
  updateShopifyProduct,
} from '@/lib/shopify/actions';

export const runtime = 'nodejs';

type InventoryRow = {
  quantityonhand?: number | string | null;
  averagecostgbp?: number | string | null;
};

type ProductRow = {
  id: string;
  name: string | null;
  primarysku: string | null;
  shopify_bound: boolean | null;
  target_margin: number | string | null;
  pricing_sales_tax_pct: number | string | null;
  pricing_shopify_fee_pct: number | string | null;
  pricing_postage_packaging_gbp: number | string | null;
  inventory: InventoryRow | InventoryRow[] | null;
};

type ProductIntegrationRow = {
  product_id: string;
  external_product_id: string | null;
  external_variant_id: string | null;
  external_inventory_item_id: string | null;
};

function calculateProductPrice(product: ProductRow, inventoryRow: InventoryRow | null) {
  const targetMargin = Number(product.target_margin);

  if (!Number.isFinite(targetMargin) || targetMargin <= 0 || targetMargin >= 100) {
    return null;
  }

  return calculateAutomatedPrice({
    averageCost: Number(inventoryRow?.averagecostgbp ?? 0),
    postagePackaging: Number(product.pricing_postage_packaging_gbp ?? 0),
    targetMargin,
    salesTaxPct: Number(product.pricing_sales_tax_pct ?? 0),
    shopifyFeePct: Number(product.pricing_shopify_fee_pct ?? 0),
  });
}

function resolveInventoryRow(inventory: ProductRow['inventory']): InventoryRow | null {
  if (Array.isArray(inventory)) {
    return inventory[0] ?? null;
  }

  return inventory ?? null;
}

function generateSku() {
  return `SL-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    const blocked = applyRateLimit(request, user.id, { limit: 5, windowMs: 60_000 });
    if (blocked) return blocked;

    const { data: products, error: productsError } = await supabase
      .from('products')
      .select(`
        id,
        name,
        primarysku,
        shopify_bound,
        target_margin,
        pricing_sales_tax_pct,
        pricing_shopify_fee_pct,
        pricing_postage_packaging_gbp,
        inventory(quantityonhand, averagecostgbp)
      `)
      .eq('user_id', user.id)
      .is('deleted_at', null);

    if (productsError) {
      throw new Error(productsError.message);
    }

    const productRows = (products ?? []) as ProductRow[];

    const { data: integrations, error: integrationsError } = await supabase
      .from('product_integrations')
      .select('product_id, external_product_id, external_variant_id, external_inventory_item_id')
      .eq('user_id', user.id)
      .eq('platform', 'shopify');

    if (integrationsError) {
      throw new Error(integrationsError.message);
    }

    const integrationByProductId = new Map<string, ProductIntegrationRow>();
    for (const integration of (integrations ?? []) as ProductIntegrationRow[]) {
      integrationByProductId.set(integration.product_id, integration);
    }

    let synced = 0;
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const product of productRows) {
      const integration = integrationByProductId.get(product.id);
      const shouldSync = Boolean(integration || product.shopify_bound);

      if (!shouldSync) {
        skipped++;
        continue;
      }

      const inventoryRow = resolveInventoryRow(product.inventory);
      const quantityOnHand = Number(inventoryRow?.quantityonhand ?? 0);
      const formattedPrice = calculateProductPrice(product, inventoryRow);

      try {
        if (integration?.external_product_id && integration.external_variant_id) {
          await updateShopifyProduct(
            integration.external_product_id,
            { title: product.name ?? 'Untitled product' },
            user.id,
          );

          if (integration.external_inventory_item_id) {
            await syncShopifyInventory(
              integration.external_inventory_item_id,
              quantityOnHand,
              user.id,
            );
          }

          if (formattedPrice) {
            await updateShopifyPrice(integration.external_variant_id, formattedPrice, user.id);
          }

          synced++;
          continue;
        }

        let sku = product.primarysku;
        if (!sku) {
          sku = generateSku();
          const { error: updateError } = await supabase
            .from('products')
            .update({ primarysku: sku, shopify_bound: true })
            .eq('id', product.id)
            .eq('user_id', user.id);

          if (updateError) {
            throw new Error(updateError.message);
          }
        }

        const shopifyResult = await pushDraftProductToShopify(
          { name: product.name },
          sku,
          user.id,
          quantityOnHand,
        );

        if (formattedPrice) {
          await updateShopifyPrice(shopifyResult.variantId, formattedPrice, user.id);
        }

        const { error: insertError } = await supabase
          .from('product_integrations')
          .insert({
            user_id: user.id,
            product_id: product.id,
            platform: 'shopify',
            external_product_id: shopifyResult.productId,
            external_variant_id: shopifyResult.variantId,
            external_inventory_item_id: shopifyResult.inventoryItemId,
          });

        if (insertError) {
          throw new Error(insertError.message);
        }

        created++;
        synced++;
      } catch (error: unknown) {
        failed++;
        errors.push(
          `${product.name ?? product.id}: ${error instanceof Error ? error.message : 'Unknown Shopify sync error'}`,
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: `Shopify sync complete: ${synced} synced, ${created} created, ${skipped} skipped, ${failed} failed.`,
      data: {
        synced,
        created,
        skipped,
        failed,
        errors,
      },
    });
  } catch (error: unknown) {
    console.error('Shopify Sync Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync with Shopify' },
      { status: 500 },
    );
  }
}
