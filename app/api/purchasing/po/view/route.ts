import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { getOrSetCache } from '@/lib/cache';
import { applyRateLimit } from '@/lib/rate-limit';

const CACHE_KEY = 'purchasing_po_view_v1';
const CACHE_TTL_MS = 1000 * 60 * 5; // 5 minutes

// GET endpoint to retrieve all database data
export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const forceRefresh = request.nextUrl.searchParams.get('refresh') === 'true';
    const payload = await getOrSetCache(
      `${CACHE_KEY}_${user.id}`, // User-specific cache key
      CACHE_TTL_MS,
      async () => {
        // Fetch tables that have user_id column
        const [suppliersRaw, purchaseOrdersRaw, productsRaw, inventoryRaw, transitRaw, invoicesRaw] =
          await Promise.all([
            supabase
              .from('suppliers')
              .select('*, purchaseorders!inner(id)')
              .eq('user_id', user.id)
              .then(({ data }: any) => data || []),
            supabase
              .from('purchaseorders')
              .select('*')
              .eq('user_id', user.id)
              .then(({ data }: any) => data || []),
            supabase
              .from('products')
              .select('*')
              .eq('user_id', user.id)
              .then(({ data }: any) => data || []),
            supabase
              .from('inventory')
              .select('*')
              .eq('user_id', user.id)
              .then(({ data }: any) => data || []),
            supabase
              .from('transit')
              .select('*')
              .eq('user_id', user.id)
              .then(({ data }: any) => data || []),
            supabase
              .from('invoices')
              .select('*')
              .eq('user_id', user.id)
              .then(({ data }: any) => data || []),
          ]);

        // polines doesn't have user_id - filter by user's purchase order IDs
        const poIds = purchaseOrdersRaw.map((po: any) => po.id);
        let poLinesRaw: any[] = [];
        if (poIds.length > 0) {
          const { data } = await supabase
            .from('polines')
            .select('*')
            .in('purchaseorderid', poIds);
          poLinesRaw = data || [];
        }

        // Map DB rows to the exact shapes the frontend expects (camelCase fields)
        const suppliers = suppliersRaw.map((s: any) => ({
          id: s.id,
          name: s.name,
          address: s.address ?? null,
          email: s.email ?? null,
          phone: s.phone ?? null,
          vatNumber: null,
          createdAt: s.created_at,
        }));

        const purchaseOrders = purchaseOrdersRaw.map((po: any) => ({
          id: po.id,
          supplierId: po.supplierid,
          invoiceNumber: po.invoicenumber ?? null,
          invoiceDate: po.invoicedate ?? null,
          currency: po.currency,
          paymentTerms: po.paymentterms ?? null,
          imageUrl: po.imageurl ?? null,
          imageUrls: po.imageurls ?? null,
          notes: po.notes ?? null,
          subtotalExVAT: po.subtotalexvat != null ? Number(po.subtotalexvat) : null,
          extras: po.extras != null ? Number(po.extras) : null,
          vat: po.vat != null ? Number(po.vat) : null,
          totalAmount: po.totalamount != null ? Number(po.totalamount) : null,
          createdAt: po.created_at,
        }));

        const poLines = poLinesRaw.map((l: any) => ({
          id: l.id,
          purchaseOrderId: l.purchaseorderid,
          description: l.description,
          supplierSku: l.suppliersku ?? null,
          quantity: Number(l.quantity ?? 0),
          unitCostExVAT: Number(l.unitcostexvat ?? 0),
          lineTotalExVAT: Number(l.linetotalexvat ?? 0),
          rrp: l.rrp != null ? Number(l.rrp) : null,
        }));

        const products = productsRaw.map((p: any) => ({
          id: p.id,
          name: p.name,
          primarySku: p.primarysku ?? null,
          supplierSku: p.suppliersku ?? null,
          barcodes: p.barcodes ?? [],
          aliases: p.aliases ?? [],
          supplierId: p.supplierid ?? null,
          category: p.category ?? null,
          tags: p.tags ?? [],
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        }));

        const inventory = inventoryRaw.map((inv: any) => ({
          id: inv.id,
          productId: inv.productid,
          quantityOnHand: Number(inv.quantityonhand ?? 0),
          averageCostGBP: Number(inv.averagecostgbp ?? 0),
          lastUpdated: inv.lastupdated,
        }));

        const transit = transitRaw.map((t: any) => ({
          id: t.id,
          productId: t.productid,
          purchaseOrderId: t.purchaseorderid,
          poLineId: t.polineid,
          supplierId: t.supplierid,
          quantity: Number(t.quantity ?? 0),
          remainingQuantity: Number(t.remainingquantity ?? 0),
          unitCostGBP: Number(t.unitcostgbp ?? 0),
          status: t.status,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        }));

        const invoices = invoicesRaw.map((inv: any) => ({
          id: inv.id,
          purchaseOrderId: inv.purchaseorderid,
          supplierId: inv.supplierid,
          invoiceNumber: inv.invoicenumber ?? null,
          invoiceDate: inv.invoicedate ?? null,
          currency: inv.currency,
          createdAt: inv.created_at,
        }));

        return {
          suppliers,
          purchaseOrders,
          poLines,
          products,
          inventory,
          transit,
          invoices,
          tasks: [],
        };
      },
      forceRefresh,
    );

    return NextResponse.json(payload);
  } catch (error) {
    console.error('API error:', error);
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: 'Failed to read database' },
      { status: 500 }
    );
  }
}
