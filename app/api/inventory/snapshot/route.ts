import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { getOrSetCache } from '@/lib/cache';
import { applyRateLimit } from '@/lib/rate-limit';

const CACHE_KEY = 'inventory_snapshot_v1';
const CACHE_TTL_MS = 1000 * 60; // 1 minute

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const forceRefresh = request.nextUrl.searchParams.get('refresh') === 'true';
    
    const enriched = await getOrSetCache(
      `${CACHE_KEY}_${user.id}`,
      CACHE_TTL_MS,
      async () => {
        // Get products with inventory data filtered by user
        const { data: products } = await supabase
          .from('products')
          .select('*')
          .eq('user_id', user.id);

        const { data: inventory } = await supabase
          .from('inventory')
          .select('*')
          .eq('user_id', user.id);

        const { data: transit } = await supabase
          .from('transit')
          .select('*')
          .eq('user_id', user.id);

        const { data: suppliers } = await supabase
          .from('suppliers')
          .select('*')
          .eq('user_id', user.id);

        // Also fetch PO lines for cost fallback (no user_id column on polines)
        const { data: purchaseOrders } = await supabase
          .from('purchaseorders')
          .select('id')
          .eq('user_id', user.id);
        const poIds = purchaseOrders?.map((po: any) => po.id) || [];
        let poLines: any[] = [];
        if (poIds.length > 0) {
          const { data } = await supabase
            .from('polines')
            .select('id, unitcostexvat, purchaseorderid')
            .in('purchaseorderid', poIds);
          poLines = data || [];
        }

        const suppliersById = new Map(suppliers?.map((s: any) => [s.id, s]) ?? []);
        const inventoryByProductId = new Map(inventory?.map((i: any) => [i.productid, i]) ?? []);
        const poLinesById = new Map(poLines.map((l: any) => [l.id, l]));

        // Group transit by product
        const transitByProductId = new Map<string, any[]>();
        transit?.forEach((t: any) => {
          const arr = transitByProductId.get(t.productid) || [];
          arr.push(t);
          transitByProductId.set(t.productid, arr);
        });

        return products?.map((product: any) => {
          const invRow = inventoryByProductId.get(product.id) || null;

          let inventoryRecord = invRow
            ? {
                id: invRow.id,
                productId: invRow.productid,
                quantityOnHand: Number(invRow.quantityonhand ?? 0),
                averageCostGBP: Number(invRow.averagecostgbp ?? 0),
                lastUpdated: invRow.lastupdated,
              }
            : null;

          const productTransit = transitByProductId.get(product.id) || [];
          const remainingTransit = productTransit.filter(
            (t: any) => Number(t.remainingquantity ?? 0) > 0,
          );

          const quantityInTransit = remainingTransit.reduce(
            (sum: number, t: any) => sum + Number(t.remainingquantity ?? 0),
            0,
          );

          // Prefer editable PO line pricing over transit.unitcostgbp, which can become stale.
          const resolveUnitCost = (transitRow: any, poLine: any): number => {
            const poLineUnit = Number(poLine?.unitcostexvat);
            if (Number.isFinite(poLineUnit) && poLineUnit >= 0) {
              return poLineUnit;
            }
            const transitUnit = Number(transitRow?.unitcostgbp);
            if (Number.isFinite(transitUnit) && transitUnit >= 0) {
              return transitUnit;
            }
            return 0;
          };

          // Derive blended average cost from on-hand + transit (matches original getInventorySnapshot)
          const onHandQty = inventoryRecord ? inventoryRecord.quantityOnHand : 0;
          const onHandAvg = inventoryRecord ? inventoryRecord.averageCostGBP : 0;
          let blendedTotalQty = onHandQty;
          let blendedTotalCost = onHandQty * onHandAvg;

          if (remainingTransit.length > 0) {
            for (const t of remainingTransit) {
              const qty = Number(t.remainingquantity ?? 0);
              if (!Number.isFinite(qty) || qty <= 0) continue;

              const poLine = poLinesById.get(t.polineid) || null;

              const unitCost = resolveUnitCost(t, poLine);

              blendedTotalQty += qty;
              blendedTotalCost += qty * unitCost;
            }
          }

          let displayAverageCost = inventoryRecord ? inventoryRecord.averageCostGBP : 0;
          if (blendedTotalQty > 0 && blendedTotalCost > 0) {
            displayAverageCost = Number((blendedTotalCost / blendedTotalQty).toFixed(4));
          }

          // Fallback: if average is still 0 but we have transit history (including
          // received), derive from ALL transit records using PO line unit costs
          if (displayAverageCost <= 0 && productTransit.length > 0) {
            let fallbackTotalQty = 0;
            let fallbackTotalCost = 0;
            for (const t of productTransit) {
              const qty = Number(t.quantity ?? 0);
              if (!Number.isFinite(qty) || qty <= 0) continue;

              const poLine = poLinesById.get(t.polineid) || null;
              const unitCost = resolveUnitCost(t, poLine);
              if (!Number.isFinite(unitCost) || unitCost <= 0) continue;

              fallbackTotalQty += qty;
              fallbackTotalCost += qty * unitCost;
            }
            if (fallbackTotalQty > 0 && fallbackTotalCost > 0) {
              displayAverageCost = Number((fallbackTotalCost / fallbackTotalQty).toFixed(4));
            }
          }

          if (inventoryRecord) {
            inventoryRecord = { ...inventoryRecord, averageCostGBP: displayAverageCost };
          } else if (displayAverageCost > 0) {
            inventoryRecord = {
              id: product.id,
              productId: product.id,
              quantityOnHand: 0,
              averageCostGBP: displayAverageCost,
              lastUpdated: product.updated_at || product.created_at,
            };
          }

          return {
            product: {
              id: product.id,
              name: product.name,
              primarySku: product.primarysku,
              supplierSku: product.suppliersku,
              supplierId: product.supplierid,
              barcodes: product.barcodes || [],
              aliases: product.aliases || [],
              category: product.category,
              tags: product.tags || [],
              imageUrl: product.imageurl ?? null,
            },
            inventory: inventoryRecord,
            quantityInTransit,
            supplier: product.supplierid ? suppliersById.get(product.supplierid) || null : null,
          };
        }) || [];
      },
      forceRefresh,
    );

    return NextResponse.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Inventory snapshot error:', error);
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: 'Failed to load inventory snapshot' },
      { status: 500 }
    );
  }
}
