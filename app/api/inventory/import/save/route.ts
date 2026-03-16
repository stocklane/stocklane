import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';

interface ImportRow {
  name: string;
  primarySku?: string | null;
  supplierSku?: string | null;
  category?: string | null;
  barcodes?: string[];
  quantityOnHand?: number;
  quantityInTransit?: number;
  averageCostGBP?: number;
  supplier?: string | null;
}

interface ExistingProductRow {
  id: string;
  name: string;
  primarysku: string | null;
  suppliersku: string | null;
  barcodes: string[] | null;
}

type ProductSelectRow = ExistingProductRow;

interface ExistingSupplierRow {
  id: string;
  name: string;
}

type SupplierIdRow = {
  id: string;
};

type SupplierInsertRow = {
  name: string;
  user_id: string;
};

type ProductInsertRow = {
  name: string;
  primarysku: string;
  suppliersku: string | null;
  barcodes: string[];
  aliases: string[];
  supplierid: string | null;
  category: string | null;
  tags: string[];
  imageurl: null;
  user_id: string;
  created_at: string;
  updated_at: string;
};

type InventoryUpdateRow = {
  quantityonhand: number;
  averagecostgbp: number;
  lastupdated: string;
};

type InventoryInsertRow = {
  productid: string;
  quantityonhand: number;
  averagecostgbp: number;
  lastupdated: string;
  user_id: string;
};

type InventorySelectRow = {
  id: string;
  quantityonhand: number | null;
  averagecostgbp: number | null;
};

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
    // SECURITY: Rate limit – import is a bulk write operation
    const blocked = applyRateLimit(request, user.id, { limit: 10, windowMs: 60_000 });
    if (blocked) return blocked;

    const body = await request.json();

    const rows: ImportRow[] = body.rows;
    // SECURITY: Cap row count to prevent abuse
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5000) {
      return NextResponse.json(
        { error: 'rows must be an array with 1–5000 items' },
        { status: 400 },
      );
    }

    // Fetch existing products for deduplication
    const { data: existingProducts } = await supabase
      .from('products')
      .select('id, name, primarysku, suppliersku, barcodes')
      .eq('user_id', user.id);

    const products: ExistingProductRow[] = existingProducts || [];
    const usedSkuLower = new Set<string>();
    products.forEach((p) => {
      if (typeof p.primarysku === 'string' && p.primarysku.trim()) {
        usedSkuLower.add(p.primarysku.trim().toLowerCase());
      }
      if (typeof p.suppliersku === 'string' && p.suppliersku.trim()) {
        usedSkuLower.add(p.suppliersku.trim().toLowerCase());
      }
    });

    // Fetch existing suppliers for matching by name
    const { data: existingSuppliers } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('user_id', user.id);

    const suppliers: ExistingSupplierRow[] = existingSuppliers || [];
    const supplierCache = new Map<string, string>(); // lowercase name -> id
    suppliers.forEach((s) => supplierCache.set(s.name.toLowerCase(), s.id));

    const resolveSupplier = async (name: string | null): Promise<string | null> => {
      if (!name) return null;
      const key = name.toLowerCase();

      // Check cache first
      const cached = supplierCache.get(key);
      if (cached) return cached;

      // Create new supplier
      const { data: newSupplier, error: supErr } = await supabase
        .from('suppliers')
        .insert({ name, user_id: user.id } as SupplierInsertRow as never)
        .select('id')
        .single();
      const createdSupplier = newSupplier as SupplierIdRow | null;

      if (supErr || !createdSupplier) return null;

      supplierCache.set(key, createdSupplier.id);
      return createdSupplier.id;
    };

    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawName = typeof row.name === 'string' ? row.name.trim() : '';
      if (!rawName) {
        skipped++;
        errors.push(`Row ${i + 1}: Missing product name, skipped`);
        continue;
      }

      const supplierName = typeof row.supplier === 'string' ? row.supplier.trim() || null : null;
      const primarySku = typeof row.primarySku === 'string' ? row.primarySku.trim() || null : null;
      const supplierSku = typeof row.supplierSku === 'string' ? row.supplierSku.trim() || null : null;
      const category = typeof row.category === 'string' ? row.category.trim() || null : null;
      const barcodes = Array.isArray(row.barcodes)
        ? row.barcodes.map((b) => (typeof b === 'string' ? b.trim() : '')).filter((b) => b.length > 0)
        : [];
      const quantityOnHand = typeof row.quantityOnHand === 'number' && row.quantityOnHand >= 0
        ? row.quantityOnHand
        : 0;
      const quantityInTransit = typeof row.quantityInTransit === 'number' && row.quantityInTransit >= 0
        ? row.quantityInTransit
        : 0;
      const totalQuantity = quantityOnHand + quantityInTransit;
      const averageCostGBP = typeof row.averageCostGBP === 'number' && row.averageCostGBP >= 0
        ? Number(row.averageCostGBP.toFixed(4))
        : 0;

      // Deduplicate: match by SKU (Primary or Supplier), Barcode, or Name
      let matchedProduct: (typeof products)[number] | null = null;

      // 1) Try SKU matching (checks any SKU provided in CSV against both fields in DB)
      const skusToMatch = [primarySku, supplierSku].filter(Boolean) as string[];
      if (skusToMatch.length > 0) {
        const skuLowerSet = new Set(skusToMatch.map(s => s.toLowerCase()));
        matchedProduct = products.find(
          (p) =>
            (p.primarysku && skuLowerSet.has(p.primarysku.toLowerCase())) ||
            (p.suppliersku && skuLowerSet.has(p.suppliersku.toLowerCase()))
        ) || null;
      }

      // 2) Try Barcode matching
      if (!matchedProduct && barcodes.length > 0) {
        const barcodeLowerSet = new Set(barcodes.map((b) => b.toLowerCase()));
        matchedProduct = products.find((p) => {
          const existingBarcodes = Array.isArray(p.barcodes) ? p.barcodes : [];
          return existingBarcodes.some((b: string) => barcodeLowerSet.has(b.toLowerCase()));
        }) || null;
      }

      // 3) Try Name matching (Case-insensitive fallback)
      if (!matchedProduct) {
        const nameLower = rawName.toLowerCase();
        matchedProduct = products.find((p) => p.name.toLowerCase() === nameLower) || null;
      }

      let productId: string;

      if (matchedProduct) {
        // Update existing product if needed
        productId = matchedProduct.id;
        updated++;
      } else {
        let resolvedPrimarySku = primarySku || supplierSku || generateInternalSku(usedSkuLower);
        if (resolvedPrimarySku && usedSkuLower.has(resolvedPrimarySku.toLowerCase())) {
          resolvedPrimarySku = generateInternalSku(usedSkuLower);
        } else if (resolvedPrimarySku) {
          usedSkuLower.add(resolvedPrimarySku.toLowerCase());
        }

        // Create new product
        const newProductPayload: ProductInsertRow = {
          name: rawName,
          primarysku: resolvedPrimarySku,
          suppliersku: supplierSku,
          barcodes,
          aliases: [],
          supplierid: await resolveSupplier(supplierName),
          category,
          tags: [],
          imageurl: null,
          user_id: user.id,
          created_at: now,
          updated_at: now,
        };
        const { data: newProduct, error: insertError } = await supabase
          .from('products')
          .insert(newProductPayload as never)
          .select('id, name, primarysku, suppliersku, barcodes')
          .single();
        const createdProduct = newProduct as ProductSelectRow | null;

        if (insertError || !createdProduct) {
          errors.push(`Row ${i + 1} ("${rawName}"): Failed to create product - ${insertError?.message || 'Unknown error'}`);
          skipped++;
          continue;
        }

        products.push(createdProduct);
        productId = createdProduct.id;
        created++;
      }

      // Create or update inventory record if quantity > 0 or cost > 0
      if (totalQuantity > 0 || averageCostGBP > 0) {
        const { data: existingInventory } = await supabase
          .from('inventory')
          .select('id, quantityonhand, averagecostgbp')
          .eq('productid', productId)
          .single();
        const inventoryRow = existingInventory as InventorySelectRow | null;

        if (inventoryRow) {
          // Weighted average merge: combine existing + imported
          const existQty = Number(inventoryRow.quantityonhand ?? 0);
          const existCost = Number(inventoryRow.averagecostgbp ?? 0);
          const newQty = existQty + totalQuantity;
          const newCost = newQty > 0
            ? Number(((existQty * existCost + totalQuantity * averageCostGBP) / newQty).toFixed(4))
            : averageCostGBP;

          await supabase
            .from('inventory')
            .update({
              quantityonhand: newQty,
              averagecostgbp: newCost,
              lastupdated: now,
            } as InventoryUpdateRow as never)
            .eq('id', inventoryRow.id);
        } else {
          const inventoryPayload: InventoryInsertRow = {
            productid: productId,
            quantityonhand: totalQuantity,
            averagecostgbp: averageCostGBP,
            lastupdated: now,
            user_id: user.id,
          };
          await supabase
            .from('inventory')
            .insert(inventoryPayload as never);
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        total: rows.length,
        created,
        updated,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    console.error('Inventory import save error:', error);
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: 'Failed to import inventory' },
      { status: 500 },
    );
  }
}
