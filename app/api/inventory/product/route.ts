import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { deleteProductAndInventory } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { isValidUUID } from '@/lib/validation';
import { clearCache } from '@/lib/cache';

interface InventoryRow {
  id: string;
  productid: string;
  quantityonhand: number | string | null;
  averagecostgbp: number | string | null;
  lastupdated: string;
}

interface SupplierRow {
  id: string;
  name: string;
  address: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
}

interface TransitRow {
  id: string;
  productid: string;
  purchaseorderid: string;
  polineid: string;
  supplierid: string;
  quantity: number | string | null;
  remainingquantity: number | string | null;
  unitcostgbp: number | string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface POLineRow {
  id: string;
  purchaseorderid: string;
  description: string;
  suppliersku: string | null;
  quantity: number | string | null;
  unitcostexvat: number | string | null;
  linetotalexvat: number | string | null;
}

interface PurchaseOrderRow {
  id: string;
  supplierid: string;
  invoicenumber: string | null;
  invoicedate: string | null;
  currency: string;
  paymentterms: string | null;
  imageurl: string | null;
  imageurls: string[] | null;
  created_at: string;
}

interface InvoiceRow {
  id: string;
  purchaseorderid: string;
  supplierid: string;
  invoicenumber: string | null;
  invoicedate: string | null;
  currency: string;
  created_at: string;
}

interface IntegrationRow {
  platform: string;
  external_product_id: string | null;
  external_variant_id: string | null;
}

interface ProductUpdatePayload {
  name?: string;
  primarysku?: string | null;
  suppliersku?: string | null;
  category?: string | null;
  barcodes?: string[];
  tags?: string[];
  aliases?: string[];
  imageurl?: string | null;
  pricing_greenlight?: boolean;
  shopify_bound?: boolean;
  target_margin?: number | null;
  pricing_sales_tax_pct?: number;
  pricing_shopify_fee_pct?: number;
  pricing_postage_packaging_gbp?: number;
  updated_at?: string;
}

interface ProductInsertPayload {
  pricing_greenlight: boolean;
  target_margin: number | null;
  pricing_sales_tax_pct: number;
  pricing_shopify_fee_pct: number;
  pricing_postage_packaging_gbp: number;
  name: string;
  primarysku: string | null;
  suppliersku: string | null;
  barcodes: string[];
  aliases: string[];
  supplierid: string | null;
  category: string | null;
  tags: string[];
  imageurl: string | null;
  shopify_bound: boolean;
  user_id: string;
  created_at: string;
  updated_at: string;
}

async function ensureUniquePrimarySkuForUser(params: {
  supabase: Awaited<ReturnType<typeof requireAuth>>['supabase'];
  userId: string;
  primarySku: string | null;
  excludeProductId?: string;
}): Promise<string | null> {
  const primarySku = params.primarySku?.trim() || null;
  if (!primarySku) return null;

  let query = params.supabase
    .from('products')
    .select('id, name, primarysku')
    .eq('user_id', params.userId)
    .ilike('primarysku', primarySku);

  if (params.excludeProductId) {
    query = query.neq('id', params.excludeProductId);
  }

  const { data: conflict } = await query.maybeSingle();
  if (conflict) {
    return conflict.name || conflict.primarysku || primarySku;
  }

  return null;
}

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
    const emptySupplierResponse: { data: SupplierRow | null } = { data: null };
    const [inventoryRes, supplierRes, transitRes, poLinesRes, purchaseOrdersRes, invoicesRes, integrationsRes] =
      await Promise.all([
        supabase.from('inventory').select('*').eq('productid', id),
        productRow.supplierid
          ? supabase.from('suppliers').select('*').eq('id', productRow.supplierid).single()
          : Promise.resolve(emptySupplierResponse),
        supabase.from('transit').select('*').eq('productid', id),
        supabase.from('polines').select('*'),
        supabase.from('purchaseorders').select('*'),
        supabase.from('invoices').select('*'),
        supabase
          .from('product_integrations')
          .select('*')
          .eq('product_id', id)
          .eq('user_id', user.id),
      ]);

    const inventoryRows: InventoryRow[] = inventoryRes.data || [];
    const supplierRow = supplierRes.data || null;
    const transitRows: TransitRow[] = transitRes.data || [];
    const poLineRows: POLineRow[] = poLinesRes.data || [];
    const poRows: PurchaseOrderRow[] = purchaseOrdersRes.data || [];
    const invoiceRows: InvoiceRow[] = invoicesRes.data || [];
    const integrationRows: IntegrationRow[] = integrationsRes.data || [];

    const integrations = integrationRows.map((i) => ({
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
      shopifyBound: !!productRow.shopify_bound,
      pricingGreenlight: !!productRow.pricing_greenlight,
      targetMargin: productRow.target_margin != null ? Number(productRow.target_margin) : null,
      pricingSalesTaxPct: Number(productRow.pricing_sales_tax_pct ?? 0),
      pricingShopifyFeePct: Number(productRow.pricing_shopify_fee_pct ?? 0),
      pricingPostagePackagingGbp: Number(productRow.pricing_postage_packaging_gbp ?? 0),
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

    const poLinesById = new Map(
      poLineRows.map((l) => [
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

    const posById = new Map(
      poRows.map((po) => [
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

    const invoicesByPoId = new Map(
      invoiceRows.map((inv) => [
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
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      .map((t) => {
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
    const resolveUnitCost = (
      transitRow: TransitRow,
      poLine: { unitCostExVAT?: number } | null,
    ): number => {
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
      (t) => Number(t.remainingquantity ?? 0) > 0,
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
      };
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

    const updates: ProductUpdatePayload = {};

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

    if ('pricingGreenlight' in body) {
      updates.pricing_greenlight = !!body.pricingGreenlight;
    }

    if ('shopifyBound' in body) {
      updates.shopify_bound = !!body.shopifyBound;
    }

    if ('targetMargin' in body) {
      if (body.targetMargin === null || body.targetMargin === '') {
        updates.target_margin = null;
      } else {
        const parsed = Number(body.targetMargin);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
          return NextResponse.json(
            { error: 'targetMargin must be a number between 0 and 100' },
            { status: 400 }
          );
        }
        updates.target_margin = parsed;
      }
    }

    if ('pricingSalesTaxPct' in body) {
      const parsed = Number(body.pricingSalesTaxPct);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return NextResponse.json(
          { error: 'pricingSalesTaxPct must be between 0 and 100' },
          { status: 400 }
        );
      }
      updates.pricing_sales_tax_pct = parsed;
    }

    if ('pricingShopifyFeePct' in body) {
      const parsed = Number(body.pricingShopifyFeePct);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return NextResponse.json(
          { error: 'pricingShopifyFeePct must be between 0 and 100' },
          { status: 400 }
        );
      }
      updates.pricing_shopify_fee_pct = parsed;
    }

    if ('pricingPostagePackagingGbp' in body) {
      const parsed = Number(body.pricingPostagePackagingGbp);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return NextResponse.json(
          { error: 'pricingPostagePackagingGbp must be a non-negative number' },
          { status: 400 }
        );
      }
      updates.pricing_postage_packaging_gbp = parsed;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields provided for update' },
        { status: 400 }
      );
    }

    if ('primarysku' in updates) {
      const conflictingName = await ensureUniquePrimarySkuForUser({
        supabase,
        userId: user.id,
        primarySku: updates.primarysku ?? null,
        excludeProductId: id,
      });
      if (conflictingName) {
        return NextResponse.json(
          { error: `Primary SKU is already used by ${conflictingName}` },
          { status: 409 },
        );
      }
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
      shopifyBound: !!updatedRow.shopify_bound,
      pricingGreenlight: !!updatedRow.pricing_greenlight,
      targetMargin: updatedRow.target_margin != null ? Number(updatedRow.target_margin) : null,
      pricingSalesTaxPct: Number(updatedRow.pricing_sales_tax_pct ?? 0),
      pricingShopifyFeePct: Number(updatedRow.pricing_shopify_fee_pct ?? 0),
      pricingPostagePackagingGbp: Number(updatedRow.pricing_postage_packaging_gbp ?? 0),
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

    const insertPayload: ProductInsertPayload = {
      // Pricing settings defaults for margin automation
      pricing_greenlight: !!body.pricingGreenlight,
      target_margin: null as number | null,
      pricing_sales_tax_pct: 0,
      pricing_shopify_fee_pct: 0,
      pricing_postage_packaging_gbp: 0,
      name: rawName,
      primarysku: normalizeOptionalString(body.primarySku),
      suppliersku: normalizeOptionalString(body.supplierSku),
      barcodes: toStringArray(body.barcodes),
      aliases: toStringArray(body.aliases),
      supplierid: normalizeOptionalString(body.supplierId) || null,
      category: normalizeOptionalString(body.category),
      tags: toStringArray(body.tags),
      imageurl: normalizeOptionalString(body.imageUrl),
      shopify_bound: !!body.shopifyBound,
      user_id: user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (body.targetMargin !== null && body.targetMargin !== undefined && body.targetMargin !== '') {
      const parsed = Number(body.targetMargin);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
        return NextResponse.json(
          { error: 'targetMargin must be a number between 0 and 100' },
          { status: 400 },
        );
      }
      insertPayload.target_margin = parsed;
    }

    const parsedTax = Number(body.pricingSalesTaxPct ?? 0);
    const parsedFee = Number(body.pricingShopifyFeePct ?? 0);
    const parsedPostage = Number(body.pricingPostagePackagingGbp ?? 0);
    if (!Number.isFinite(parsedTax) || parsedTax < 0 || parsedTax > 100) {
      return NextResponse.json(
        { error: 'pricingSalesTaxPct must be between 0 and 100' },
        { status: 400 },
      );
    }
    if (!Number.isFinite(parsedFee) || parsedFee < 0 || parsedFee > 100) {
      return NextResponse.json(
        { error: 'pricingShopifyFeePct must be between 0 and 100' },
        { status: 400 },
      );
    }
    if (!Number.isFinite(parsedPostage) || parsedPostage < 0) {
      return NextResponse.json(
        { error: 'pricingPostagePackagingGbp must be a non-negative number' },
        { status: 400 },
      );
    }
    insertPayload.pricing_sales_tax_pct = parsedTax;
    insertPayload.pricing_shopify_fee_pct = parsedFee;
    insertPayload.pricing_postage_packaging_gbp = parsedPostage;

    const conflictingName = await ensureUniquePrimarySkuForUser({
      supabase,
      userId: user.id,
      primarySku: insertPayload.primarysku,
    });
    if (conflictingName) {
      return NextResponse.json(
        { error: `Primary SKU is already used by ${conflictingName}` },
        { status: 409 },
      );
    }

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
      shopifyBound: !!newProduct.shopify_bound,
      pricingGreenlight: !!newProduct.pricing_greenlight,
      targetMargin: newProduct.target_margin != null ? Number(newProduct.target_margin) : null,
      pricingSalesTaxPct: Number(newProduct.pricing_sales_tax_pct ?? 0),
      pricingShopifyFeePct: Number(newProduct.pricing_shopify_fee_pct ?? 0),
      pricingPostagePackagingGbp: Number(newProduct.pricing_postage_packaging_gbp ?? 0),
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
