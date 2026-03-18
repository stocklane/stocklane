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

interface SupplierRow {
  id: string;
  name: string;
}

interface ProductSkuRow {
  primarysku: string | null;
  suppliersku: string | null;
}

function generateInternalSku(usedSkuLower: Set<string>): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = '';
    for (let i = 0; i < 8; i++) {
      suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const candidate = `SL-${suffix}`;
    const key = candidate.toLowerCase();
    if (!usedSkuLower.has(key)) {
      usedSkuLower.add(key);
      return candidate;
    }
  }

  const fallback = `SL-${Date.now().toString(36).toUpperCase()}`;
  usedSkuLower.add(fallback.toLowerCase());
  return fallback;
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
    const suppliers: SupplierRow[] = existingSuppliers || [];
    const supplierCache = new Map<string, string>();
    suppliers.forEach((s) => supplierCache.set(s.name.toLowerCase(), s.id));

    const { data: existingProducts } = await supabase
      .from('products')
      .select('primarysku, suppliersku')
      .eq('user_id', user.id);
    const usedSkuLower = new Set<string>();
    const productSkus: ProductSkuRow[] = existingProducts || [];
    productSkus.forEach((p) => {
      if (typeof p.primarysku === 'string' && p.primarysku.trim()) {
        usedSkuLower.add(p.primarysku.trim().toLowerCase());
      }
      if (typeof p.suppliersku === 'string' && p.suppliersku.trim()) {
        usedSkuLower.add(p.suppliersku.trim().toLowerCase());
      }
    });

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
        const providedSku = typeof v.sku === 'string' ? v.sku.trim() : '';
        if (providedSku && usedSkuLower.has(providedSku.toLowerCase())) {
          errors.push(`Cannot create "${v.title}" because SKU "${providedSku}" already exists in this account.`);
          failed++;
          continue;
        }
        const resolvedPrimarySku = providedSku || generateInternalSku(usedSkuLower);
        usedSkuLower.add(resolvedPrimarySku.toLowerCase());
        const { data: newDbProduct, error: insertError } = await supabase
          .from('products')
          .insert({
            name: v.title,
            primarysku: resolvedPrimarySku,
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
            .update({ 
              quantityonhand: v.quantity, 
              lastupdated: now,
              user_id: user.id 
            })
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
          user_id: user.id,
          product_id: productId,
          platform: 'shopify',
          external_product_id: v.shopifyProductId,
          external_variant_id: v.shopifyVariantId,
          external_inventory_item_id: v.inventoryItemId || null,
        }, { onConflict: 'user_id,platform,external_product_id,external_variant_id' });
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${created + updated} items (${created} created, ${updated} updated, ${ignored} ignored, ${failed} failed).`,
      data: { total: created + updated, created, updated, ignored, failed, errors }
    });

  } catch (error: unknown) {
    console.error('Shopify Sync Execute Error:', error);
    const message = error instanceof Error ? error.message : 'Failed to execute Shopify sync';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
