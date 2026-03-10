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

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    // SECURITY: Rate limit – import is a bulk write operation
    const blocked = applyRateLimit(request, user.id, { limit: 10, windowMs: 60_000 });
    if (blocked) return blocked;

    const body = await request.json();
    const rows: ImportRow[] = body.rows;

    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5000) {
      return NextResponse.json({ error: 'rows must be an array with 1–5000 items' }, { status: 400 });
    }

    // 1) Fetch existing data for lookup
    const [existingProductsRes, existingSuppliersRes] = await Promise.all([
      supabase.from('products').select('id, name, primarysku, suppliersku, barcodes').eq('user_id', user.id),
      supabase.from('suppliers').select('id, name').eq('user_id', user.id),
    ]);

    const products = (existingProductsRes.data as any[]) || [];
    const suppliers = (existingSuppliersRes.data as any[]) || [];
    const supplierCache = new Map<string, string>();
    suppliers.forEach((s: any) => supplierCache.set(s.name.toLowerCase(), s.id));

    // 2) Batch Match Products (SKU, Barcode, Name + AI fallback)
    const { matchProducts } = await import('@/lib/ai-matching');
    const matchInputs = rows.map((row, index) => ({
      externalId: String(index),
      name: row.name,
      primarySku: row.primarySku,
      supplierSku: row.supplierSku,
      barcodes: row.barcodes,
    }));

    const matchResults = await matchProducts(
      matchInputs,
      products,
      { useAI: !!process.env.GEMINI_API_KEY, apiKey: process.env.GEMINI_API_KEY }
    );
    const resultsByRowIndex = new Map(matchResults.map(r => [Number(r.externalId), r]));

    // 3) Process Rows
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
    let created = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const matchResult = resultsByRowIndex.get(i);
      
      const rawName = typeof row.name === 'string' ? row.name.trim() : '';
      if (!rawName) {
        skipped++;
        errors.push(`Row ${i + 1}: Missing product name, skipped`);
        continue;
      }

      const quantityOnHand = Number(row.quantityOnHand || 0);
      const quantityInTransit = Number(row.quantityInTransit || 0);
      const totalQuantity = quantityOnHand + quantityInTransit;
      const averageCostGBP = Number(row.averageCostGBP || 0);

      let productId: string;
      const targetId = matchResult?.targetProductId;

      if (targetId) {
        productId = targetId;
        updated++;
      } else {
        const { data: newProduct, error: insertError } = await supabase
          .from('products')
          .insert({
            name: rawName,
            primarysku: row.primarySku || null,
            suppliersku: row.supplierSku || null,
            barcodes: row.barcodes || [],
            aliases: [],
            supplierid: await resolveSupplier(row.supplier || null),
            category: row.category || null,
            tags: [],
            user_id: user.id,
            created_at: now,
            updated_at: now,
          })
          .select('id')
          .single();

        if (insertError || !newProduct) {
          errors.push(`Row ${i + 1} ("${rawName}"): ${insertError?.message || 'Failed to create'}`);
          skipped++;
          continue;
        }
        productId = newProduct.id;
        created++;
      }

      if (totalQuantity > 0 || averageCostGBP > 0) {
        const { data: existingInventory } = await supabase
          .from('inventory')
          .select('id, quantityonhand, averagecostgbp')
          .eq('productid', productId)
          .single();

        if (existingInventory) {
          const existQty = Number(existingInventory.quantityonhand ?? 0);
          const existCost = Number(existingInventory.averagecostgbp ?? 0);
          const newQty = existQty + totalQuantity;
          const newCost = newQty > 0
            ? Number(((existQty * existCost + totalQuantity * averageCostGBP) / newQty).toFixed(4))
            : averageCostGBP;

          await supabase.from('inventory').update({ quantityonhand: newQty, averagecostgbp: newCost, lastupdated: now }).eq('id', existingInventory.id);
        } else {
          await supabase.from('inventory').insert({ productid: productId, quantityonhand: totalQuantity, averagecostgbp: averageCostGBP, lastupdated: now, user_id: user.id });
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: { total: rows.length, created, updated, skipped, errors: errors.length > 0 ? errors : undefined },
    });
  } catch (error) {
    console.error('Inventory import save error:', error);
    return NextResponse.json({ error: 'Failed to import inventory' }, { status: 500 });
  }
}
