import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

interface ExecVariant {
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  quantity: number;
  price: number;
  vendor: string | null;
  category: string | null;
  inventoryItemId: string | null;
  
  action: 'create' | 'update' | 'ignore';
  targetProductId: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    // SECURITY: Rate limit
    const blocked = applyRateLimit(request, user.id, { limit: 5, windowMs: 60_000 });
    if (blocked) return blocked;

    const body = await request.json();
    const variants: ExecVariant[] = body.variants;

    if (!Array.isArray(variants)) {
      return NextResponse.json({ error: 'Invalid payload expected an array of variants' }, { status: 400 });
    }

    // Pre-cache suppliers
    const { data: existingSuppliers } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('user_id', user.id);
    const suppliers = (existingSuppliers as any[]) || [];
    const supplierCache = new Map<string, string>();
    suppliers.forEach((s: any) => supplierCache.set(s.name.toLowerCase(), s.id));

    const resolveSupplier = async (name: string | null): Promise<string | null> => {
      if (!name) return null;
      const key = name.toLowerCase();
      const cached = supplierCache.get(key);
      if (cached) return cached;

      const { data: newSupplier, error: supErr } = await supabase
        .from('suppliers')
        .insert({ name, user_id: user.id })
        .select('id')
        .single();

      if (supErr || !newSupplier) return null;
      supplierCache.set(key, newSupplier.id);
      return newSupplier.id;
    };

    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    let ignored = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const v of variants) {
      if (v.action === 'ignore') {
        ignored++;
        continue;
      }

      let productId: string = '';

      if (v.action === 'update') {
        if (!v.targetProductId) {
          errors.push(`Missing targetProductId for update action on Shopify item: ${v.title}`);
          failed++;
          continue;
        }
        productId = v.targetProductId;
        updated++;
      } else if (v.action === 'create') {
        const barcodes = v.barcode ? [v.barcode] : [];
        const { data: newDbProduct, error: insertError } = await supabase
          .from('products')
          .insert({
            name: v.title,
            primarysku: v.sku,
            barcodes,
            aliases: [],
            supplierid: await resolveSupplier(v.vendor),
            category: v.category,
            tags: [],
            user_id: user.id,
            created_at: now,
            updated_at: now,
          })
          .select('id')
          .single();

        if (insertError || !newDbProduct) {
          errors.push(`Failed to create product "${v.title}": ${insertError?.message || 'Unknown'}`);
          failed++;
          continue;
        }
        productId = newDbProduct.id;
        created++;
      } else {
        ignored++;
        continue; // Fallback
      }

      // Update Inventory
      const { data: existingInventory } = await supabase
        .from('inventory')
        .select('id, quantityonhand')
        .eq('productid', productId)
        .single();

      if (existingInventory) {
        if (existingInventory.quantityonhand !== v.quantity) {
          await supabase
            .from('inventory')
            .update({ quantityonhand: v.quantity, lastupdated: now })
            .eq('id', existingInventory.id);
        }
      } else {
        await supabase
          .from('inventory')
          .insert({
            productid: productId,
            quantityonhand: v.quantity,
            averagecostgbp: 0,
            lastupdated: now,
            user_id: user.id,
          });
      }

      // Upsert Integrations
      await supabase
        .from('product_integrations')
        .upsert({
          product_id: productId,
          platform: 'shopify',
          external_product_id: v.shopifyProductId,
          external_variant_id: v.shopifyVariantId,
          external_inventory_item_id: v.inventoryItemId || null,
        }, { onConflict: 'platform,external_product_id,external_variant_id' });
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${created + updated} items (${created} created, ${updated} updated, ${ignored} ignored, ${failed} failed).`,
      data: { total: created + updated, created, updated, ignored, failed, errors }
    });

  } catch (error: any) {
    console.error('Shopify Sync Execute Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to execute Shopify sync' }, { status: 500 });
  }
}
