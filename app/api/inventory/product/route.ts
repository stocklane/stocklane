import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { deleteProductAndInventory } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { isValidUUID } from '@/lib/validation';
import { clearCache } from '@/lib/cache';

// GET product + inventory + transit history for /inventory/[productId]
export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!isValidUUID(id)) {
      return NextResponse.json(
        { error: 'Product id must be a valid UUID' },
        { status: 400 }
      );
    }

    // 1) Load the product row first
    const { data: productRow, error: productError } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (productError || !productRow) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    // 2) Load related entities in parallel
    const [inventoryRes, supplierRes, transitRes, poLinesRes, purchaseOrdersRes, invoicesRes, integrationsRes] =
      await Promise.all([
        supabase.from('inventory').select('*').eq('productid', id),
        productRow.supplierid
          ? supabase.from('suppliers').select('*').eq('id', productRow.supplierid).single()
          : Promise.resolve({ data: null } as any),
        supabase.from('transit').select('*').eq('productid', id),
        supabase.from('polines').select('*'),
        supabase.from('purchaseorders').select('*'),
        supabase.from('invoices').select('*'),
        supabase.from('product_integrations').select('*').eq('product_id', id),
      ]);

    const inventoryRows = inventoryRes.data || [];
    const supplierRow = (supplierRes as any).data || null;
    const transitRows = transitRes.data || [];
    const poLineRows = poLinesRes.data || [];
    const poRows = purchaseOrdersRes.data || [];
    const invoiceRows = invoicesRes.data || [];
    const integrationRows = integrationsRes.data || [];

    const integrations = integrationRows.map((i: any) => ({
      platform: i.platform,
      externalProductId: i.external_product_id,
      externalVariantId: i.external_variant_id,
    }));

    // Map product to camelCase DTO
    const product = {
      id: productRow.id,
      name: productRow.name,
      primarySku: productRow.primarysku ?? null,
      supplierSku: productRow.suppliersku ?? null,
      barcodes: productRow.barcodes ?? [],
      aliases: productRow.aliases ?? [],
      supplierId: productRow.supplierid ?? null,
      category: productRow.category ?? null,
      tags: productRow.tags ?? [],
      imageUrl: productRow.imageurl ?? null,
      createdAt: productRow.created_at,
      updatedAt: productRow.updated_at,
    };

    let inventory =
      inventoryRows[0]
        ? {
            id: inventoryRows[0].id,
            productId: inventoryRows[0].productid,
            quantityOnHand: Number(inventoryRows[0].quantityonhand ?? 0),
            averageCostGBP: Number(inventoryRows[0].averagecostgbp ?? 0),
            lastUpdated: inventoryRows[0].lastupdated,
          }
        : null;

    const supplier = supplierRow
      ? {
          id: supplierRow.id,
          name: supplierRow.name,
          address: supplierRow.address ?? null,
          email: supplierRow.email ?? null,
          phone: supplierRow.phone ?? null,
          vatNumber: null,
          createdAt: supplierRow.created_at,
        }
      : null;

    const poLinesById = new Map<string, any>(
      poLineRows.map((l: any) => [
        l.id,
        {
          id: l.id,
          purchaseOrderId: l.purchaseorderid,
          description: l.description,
          supplierSku: l.suppliersku ?? null,
          quantity: Number(l.quantity ?? 0),
          unitCostExVAT: Number(l.unitcostexvat ?? 0),
          lineTotalExVAT: Number(l.linetotalexvat ?? 0),
        },
      ])
    );

    const posById = new Map<string, any>(
      poRows.map((po: any) => [
        po.id,
        {
          id: po.id,
          supplierId: po.supplierid,
          invoiceNumber: po.invoicenumber ?? null,
          invoiceDate: po.invoicedate ?? null,
          currency: po.currency,
          paymentTerms: po.paymentterms ?? null,
          imageUrl: po.imageurl ?? null,
          imageUrls: po.imageurls ?? null,
          createdAt: po.created_at,
        },
      ])
    );

    const invoicesByPoId = new Map<string, any>(
      invoiceRows.map((inv: any) => [
        inv.purchaseorderid,
        {
          id: inv.id,
          purchaseOrderId: inv.purchaseorderid,
          supplierId: inv.supplierid,
          invoiceNumber: inv.invoicenumber ?? null,
          invoiceDate: inv.invoicedate ?? null,
          currency: inv.currency,
          createdAt: inv.created_at,
        },
      ])
    );

    const transit = transitRows
      .slice()
      .sort(
        (a: any, b: any) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      .map((t: any) => {
        const transitRecord = {
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
        };

        const po = posById.get(t.purchaseorderid) || null;
        const poLine = poLinesById.get(t.polineid) || null;
        const invoice = po ? invoicesByPoId.get(po.id) || null : null;

        return {
          transit: transitRecord,
          poLine,
          purchaseOrder: po,
          invoice,
        };
      });

    // Prefer the PO line unit cost (editable) over transit.unitcostgbp, which can become stale.
    const resolveUnitCost = (transitRow: any, poLine: any): number => {
      const poLineUnit = Number(poLine?.unitCostExVAT);
      if (Number.isFinite(poLineUnit) && poLineUnit >= 0) {
        return poLineUnit;
      }
      const transitUnit = Number(transitRow?.unitcostgbp);
      if (Number.isFinite(transitUnit) && transitUnit >= 0) {
        return transitUnit;
      }
      return 0;
    };

    // Derive an expected average unit cost from on-hand + current POs (transit)
    const remainingTransit = transitRows.filter(
      (t: any) => Number(t.remainingquantity ?? 0) > 0,
    );

    const onHandQty = inventory ? inventory.quantityOnHand : 0;
    const onHandAvg = inventory ? inventory.averageCostGBP : 0;
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

    let displayAverageCost = inventory ? inventory.averageCostGBP : 0;
    if (blendedTotalQty > 0 && blendedTotalCost > 0) {
      displayAverageCost = Number((blendedTotalCost / blendedTotalQty).toFixed(4));
    }

    // Fallback: if average is still 0 but we have transit history, derive from ALL
    // transit records (including received) using PO line unit costs
    if (displayAverageCost <= 0 && transitRows.length > 0) {
      let fallbackTotalQty = 0;
      let fallbackTotalCost = 0;
      for (const t of transitRows) {
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

    if (inventory) {
      inventory = { ...inventory, averageCostGBP: displayAverageCost };
    } else if (displayAverageCost > 0) {
      inventory = {
        id: product.id,
        productId: product.id,
        quantityOnHand: 0,
        averageCostGBP: displayAverageCost,
        lastUpdated: product.updatedAt || product.createdAt,
      } as any;
    }

    return NextResponse.json({
      success: true,
      data: {
        product,
        inventory,
        supplier,
        transit,
        integrations,
      },
    });
  } catch (error) {
    console.error('Get product history error:', error);
    return NextResponse.json(
      { error: 'Failed to load product history' },
      { status: 500 }
    );
  }
}

// Update product metadata (name, SKUs, category, tags, barcodes)
export async function PUT(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!isValidUUID(id)) {
      return NextResponse.json(
        { error: 'Product id must be a valid UUID' },
        { status: 400 }
      );
    }

    const body = await request.json();

    const updates: any = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (name.length === 0) {
        return NextResponse.json(
          { error: 'Name cannot be empty' },
          { status: 400 }
        );
      }
      updates.name = name;
    }

    if ('primarySku' in body) {
      const raw = body.primarySku;
      const value = typeof raw === 'string' ? raw.trim() : '';
      updates.primarysku = value.length > 0 ? value : null;
    }

    if ('supplierSku' in body) {
      const raw = body.supplierSku;
      const value = typeof raw === 'string' ? raw.trim() : '';
      updates.suppliersku = value.length > 0 ? value : null;
    }

    if ('category' in body) {
      const raw = body.category;
      const value = typeof raw === 'string' ? raw.trim() : '';
      updates.category = value.length > 0 ? value : null;
    }

    if (Array.isArray(body.barcodes)) {
      updates.barcodes = body.barcodes;
    }

    if (Array.isArray(body.tags)) {
      updates.tags = body.tags;
    }

    if (Array.isArray(body.aliases)) {
      updates.aliases = body.aliases;
    }

    if ('imageUrl' in body) {
      const raw = body.imageUrl;
      if (raw === null || raw === undefined || raw === '') {
        updates.imageurl = null;
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        // SECURITY: Only allow http/https URLs to prevent javascript: or data: URIs
        if (trimmed.length > 0 && !/^https?:\/\//i.test(trimmed)) {
          return NextResponse.json(
            { error: 'imageUrl must be a valid http/https URL' },
            { status: 400 }
          );
        }
        updates.imageurl = trimmed.length > 0 ? trimmed.slice(0, 2048) : null;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields provided for update' },
        { status: 400 }
      );
    }

    updates.updated_at = new Date().toISOString();

    const { data: updatedRow, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !updatedRow) {
      console.error('Update product error:', error);
      return NextResponse.json(
        { error: 'Failed to update product' },
        { status: 500 }
      );
    }

    const product = {
      id: updatedRow.id,
      name: updatedRow.name,
      primarySku: updatedRow.primarysku ?? null,
      supplierSku: updatedRow.suppliersku ?? null,
      barcodes: updatedRow.barcodes ?? [],
      aliases: updatedRow.aliases ?? [],
      supplierId: updatedRow.supplierid ?? null,
      category: updatedRow.category ?? null,
      tags: updatedRow.tags ?? [],
      imageUrl: updatedRow.imageurl ?? null,
      createdAt: updatedRow.created_at,
      updatedAt: updatedRow.updated_at,
    }

    clearCache(`inventory_snapshot_v1_${user.id}`);
    return NextResponse.json({ success: true, data: { product } });
  } catch (error) {
    console.error('Update product error:', error);
    return NextResponse.json(
      { error: 'Failed to update product' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const body = await request.json();

    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 },
      );
    }

    const normalizeOptionalString = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const toStringArray = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return value
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0);
    };

    const insertPayload: any = {
      name: rawName,
      primarysku: normalizeOptionalString(body.primarySku),
      suppliersku: normalizeOptionalString(body.supplierSku),
      barcodes: toStringArray(body.barcodes),
      aliases: toStringArray(body.aliases),
      supplierid: normalizeOptionalString(body.supplierId) || null,
      category: normalizeOptionalString(body.category),
      tags: toStringArray(body.tags),
      imageurl: normalizeOptionalString(body.imageUrl),
      user_id: user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: newProduct, error } = await supabase
      .from('products')
      .insert(insertPayload)
      .select('*')
      .single();

    if (error || !newProduct) {
      console.error('Create product error:', error);
      return NextResponse.json(
        { error: 'Failed to create product' },
        { status: 500 },
      );
    }

    const product = {
      id: newProduct.id,
      name: newProduct.name,
      primarySku: newProduct.primarysku ?? null,
      supplierSku: newProduct.suppliersku ?? null,
      barcodes: newProduct.barcodes ?? [],
      aliases: newProduct.aliases ?? [],
      supplierId: newProduct.supplierid ?? null,
      category: newProduct.category ?? null,
      tags: newProduct.tags ?? [],
      imageUrl: newProduct.imageurl ?? null,
      createdAt: newProduct.created_at,
      updatedAt: newProduct.updated_at,
    };

    clearCache(`inventory_snapshot_v1_${user.id}`);

    return NextResponse.json({ success: true, data: { product } });
  } catch (error) {
    console.error('Create product error:', error);
    return NextResponse.json(
      { error: 'Failed to create product' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!isValidUUID(id)) {
      return NextResponse.json(
        { error: 'Product id must be a valid UUID' },
        { status: 400 }
      );
    }

    const { data: product, error: fetchError } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !product) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    const result = await deleteProductAndInventory(id);

    clearCache(`inventory_snapshot_v1_${user.id}`);

    return NextResponse.json({
      success: true,
      message: 'Product deleted successfully',
      deleted: {
        productId: id,
        productName: product.name,
        inventoryRows: result.deletedInventoryCount,
        transitRows: result.deletedTransitCount,
      },
    });
  } catch (error) {
    console.error('Delete product error:', error);
    return NextResponse.json(
      { error: 'Failed to delete product' },
      { status: 500 }
    );
  }
}
