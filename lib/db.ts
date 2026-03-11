import { serverSupabase as supabase } from './supabase-server';
import { syncShopifyInventory, pushDraftProductToShopify, updateShopifyPrice } from './shopify/actions';

// Define the database schema types
export interface Supplier {
  id: string;
  name: string;
  address: string | null;
  email: string | null;
  phone: string | null;
  vatNumber: string | null;
  createdAt: string;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string;
  paymentTerms: string | null;
  imageUrl: string | null;
  imageUrls: string[] | null;
  notes: string | null;
  subtotalExVAT: number | null;
  extras: number | null;
  vat: number | null;
  totalAmount: number | null;
  trackingNumber: string | null;
  trackingPostcode: string | null;
  courier: string | null;
  trackingStatus: string | null;
  createdAt: string;
}

export interface POLine {
  id: string;
  purchaseOrderId: string;
  description: string;
  supplierSku: string | null;
  quantity: number;
  unitCostExVAT: number;
  lineTotalExVAT: number;
  rrp: number | null;
}

export interface Totals {
  subTotalExVAT: number | null;
  vatTotal: number | null;
  grandTotal: number | null;
}


// Helper function to find or create a supplier
export async function findOrCreateSupplier(
  supplierData: Omit<Supplier, 'id' | 'createdAt'> & { user_id: string }
): Promise<string> {
  // Validate that supplier name is not null or empty
  if (!supplierData.name || supplierData.name.trim() === '') {
    throw new Error('Supplier name is required');
  }

  // Try to find existing supplier by name (case-insensitive) within user's data
  const { data: existing } = await supabase
    .from('suppliers')
    .select('id')
    .ilike('name', supplierData.name)
    .eq('user_id', supplierData.user_id)
    .single();

  if (existing) {
    return existing.id;
  }

  // Create new supplier
  const { data: newSupplier, error } = await supabase
    .from('suppliers')
    .insert({
      name: supplierData.name,
      address: supplierData.address,
      email: supplierData.email,
      phone: supplierData.phone,
      user_id: supplierData.user_id,
    })
    .select('id')
    .single();

  if (error || !newSupplier) {
    throw new Error(`Failed to create supplier: ${error?.message}`);
  }

  return newSupplier.id;
}

// Helper function to create a purchase order
export async function createPurchaseOrder(
  poData: Omit<PurchaseOrder, 'id' | 'createdAt'> & { user_id: string }
): Promise<string> {
  const { data: newPO, error } = await supabase
    .from('purchaseorders')
    .insert({
      supplierid: poData.supplierId,
      invoicenumber: poData.invoiceNumber,
      invoicedate: poData.invoiceDate,
      currency: poData.currency,
      paymentterms: poData.paymentTerms,
      imageurl: poData.imageUrl,
      imageurls: poData.imageUrls,
      notes: poData.notes,
      subtotalexvat: poData.subtotalExVAT ?? null,
      extras: poData.extras ?? null,
      vat: poData.vat ?? null,
      totalamount: poData.totalAmount ?? null,
      tracking_number: poData.trackingNumber ?? null,
      tracking_postcode: poData.trackingPostcode ?? null,
      courier: poData.courier ?? null,
      tracking_status: poData.trackingStatus ?? 'pending',
      user_id: poData.user_id,
    })
    .select('id')
    .single();

  if (error || !newPO) {
    console.error('Supabase error:', error);
    throw new Error(`Failed to create purchase order: ${error?.message}`);
  }

  return newPO.id;
}

// Helper function to update a purchase order
export async function updatePurchaseOrder(
  poId: string,
  updates: Partial<Omit<PurchaseOrder, 'id' | 'createdAt'>>
): Promise<PurchaseOrder | null> {
  const mappedUpdates: any = {};
  if (updates.supplierId !== undefined) mappedUpdates.supplierid = updates.supplierId;
  if (updates.invoiceNumber !== undefined) mappedUpdates.invoicenumber = updates.invoiceNumber;
  if (updates.invoiceDate !== undefined) mappedUpdates.invoicedate = updates.invoiceDate;
  if (updates.currency !== undefined) mappedUpdates.currency = updates.currency;
  if (updates.paymentTerms !== undefined) mappedUpdates.paymentterms = updates.paymentTerms;
  if (updates.imageUrl !== undefined) mappedUpdates.imageurl = updates.imageUrl;
  if (updates.imageUrls !== undefined) mappedUpdates.imageurls = updates.imageUrls;
  if (updates.notes !== undefined) mappedUpdates.notes = updates.notes;
  if (updates.subtotalExVAT !== undefined) mappedUpdates.subtotalexvat = updates.subtotalExVAT;
  if (updates.extras !== undefined) mappedUpdates.extras = updates.extras;
  if (updates.vat !== undefined) mappedUpdates.vat = updates.vat;
  if (updates.totalAmount !== undefined) mappedUpdates.totalamount = updates.totalAmount;
  if (updates.trackingNumber !== undefined) mappedUpdates.tracking_number = updates.trackingNumber;
  if (updates.trackingPostcode !== undefined) mappedUpdates.tracking_postcode = updates.trackingPostcode;
  if (updates.courier !== undefined) mappedUpdates.courier = updates.courier;
  if (updates.trackingStatus !== undefined) mappedUpdates.tracking_status = updates.trackingStatus;

  const { data, error } = await supabase
    .from('purchaseorders')
    .update(mappedUpdates)
    .eq('id', poId)
    .select()
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

// Helper function to create PO lines
export async function createPOLines(
  lines: Omit<POLine, 'id'>[]
): Promise<POLine[]> {
  const { data, error } = await supabase
    .from('polines')
    .insert(
      lines.map(line => ({
        purchaseorderid: line.purchaseOrderId,
        description: line.description,
        suppliersku: line.supplierSku,
        quantity: line.quantity,
        unitcostexvat: line.unitCostExVAT,
        linetotalexvat: line.lineTotalExVAT,
        rrp: line.rrp,
      }))
    )
    .select();

  if (error || !data) {
    throw new Error(`Failed to create PO lines: ${error?.message}`);
  }

  return data.map((row: any) => ({
    id: row.id,
    purchaseOrderId: row.purchaseorderid,
    description: row.description,
    supplierSku: row.suppliersku ?? null,
    quantity: Number(row.quantity ?? 0),
    unitCostExVAT: Number(row.unitcostexvat ?? 0),
    lineTotalExVAT: Number(row.linetotalexvat ?? 0),
    rrp: row.rrp != null ? Number(row.rrp) : null,
  }));
}

// Helper function to update a line item
export async function updatePOLine(
  lineId: string,
  updates: Partial<Omit<POLine, 'id' | 'purchaseOrderId'>>
): Promise<POLine | null> {
  const mappedUpdates: any = {};
  if (updates.description !== undefined) mappedUpdates.description = updates.description;
  if (updates.supplierSku !== undefined) mappedUpdates.suppliersku = updates.supplierSku;
  if (updates.quantity !== undefined) mappedUpdates.quantity = updates.quantity;
  if (updates.unitCostExVAT !== undefined) mappedUpdates.unitcostexvat = updates.unitCostExVAT;
  if (updates.lineTotalExVAT !== undefined) mappedUpdates.linetotalexvat = updates.lineTotalExVAT;
  if (updates.rrp !== undefined) mappedUpdates.rrp = updates.rrp;

  const { data, error } = await supabase
    .from('polines')
    .update(mappedUpdates)
    .eq('id', lineId)
    .select()
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

// Helper function to delete a line item
export async function deletePOLine(lineId: string): Promise<boolean> {
  const { error } = await supabase
    .from('polines')
    .delete()
    .eq('id', lineId);

  if (error) {
    return false;
  }

  return true;
}

// Helper function to delete a supplier
export async function deleteSupplier(supplierId: string): Promise<{
  success: boolean;
  deletedPurchaseOrders: number;
  deletedLines: number;
}> {
  // Get count of purchase orders for this supplier
  const { count: deletedPurchaseOrders } = await supabase
    .from('purchaseorders')
    .select('*', { count: 'exact', head: true })
    .eq('supplierid', supplierId);

  // Delete all line items for these purchase orders (cascade will handle this)
  // Delete all purchase orders for this supplier (cascade will handle this)
  // Delete the supplier
  const { error: detachError } = await supabase
    .from('products')
    .update({ supplierid: null })
    .eq('supplierid', supplierId);

  if (detachError) {
    throw new Error(`Failed to detach products from supplier: ${detachError.message}`);
  }

  const { error } = await supabase
    .from('suppliers')
    .delete()
    .eq('id', supplierId);

  if (error) {
    throw new Error(`Failed to delete supplier: ${error.message}`);
  }

  // Note: With cascade deletes, we don't need to manually delete POs and lines
  // Count deleted lines by querying poLines before deletion
  const { count: deletedLines } = await supabase
    .from('polines')
    .select('*', { count: 'exact', head: true })
    .in('purchaseorderid', (await supabase
      .from('purchaseorders')
      .select('id')
      .eq('supplierid', supplierId)
      .then(({ data }: any) => (data as any[])?.map((po: any) => po.id) || [])));

  return {
    success: true,
    deletedPurchaseOrders: deletedPurchaseOrders || 0,
    deletedLines: deletedLines || 0,
  };
}

export async function deleteProductAndInventory(productId: string): Promise<{
  deletedInventoryCount: number;
  deletedTransitCount: number;
}> {
  const { count: inventoryCount } = await supabase
    .from('inventory')
    .select('*', { count: 'exact', head: true })
    .eq('productid', productId);

  const { count: transitCount } = await supabase
    .from('transit')
    .select('*', { count: 'exact', head: true })
    .eq('productid', productId);

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId);

  if (error) {
    throw new Error(`Failed to delete product: ${error.message}`);
  }

  return {
    deletedInventoryCount: inventoryCount || 0,
    deletedTransitCount: transitCount || 0,
  };
}

// New inventory and product types
export interface ProductIntegration {
  platform: string;
  externalProductId: string;
  externalVariantId: string;
}

export interface Product {
  id: string;
  name: string;
  primarySku: string | null;
  supplierSku: string | null;
  barcodes: string[];
  aliases: string[];
  supplierId: string | null;
  category: string | null;
  tags: string[];
  imageUrl: string | null;
  integrations?: ProductIntegration[];
  createdAt: string;
  updatedAt: string;
}

export interface InventoryRecord {
  id: string;
  productId: string;
  quantityOnHand: number;
  averageCostGBP: number;
  lastUpdated: string;
}

export type TransitStatus = 'in_transit' | 'partially_received' | 'received';

export interface TransitRecord {
  id: string;
  productId: string;
  purchaseOrderId: string;
  poLineId: string;
  supplierId: string;
  quantity: number;
  remainingQuantity: number;
  unitCostGBP: number;
  status: TransitStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  purchaseOrderId: string;
  supplierId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string;
  createdAt: string;
}

export async function createOrUpdateInvoiceForPurchaseOrder(params: {
  purchaseOrderId: string;
  supplierId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string;
}): Promise<Invoice> {
  // Try to find existing invoice
  const { data: existing } = await supabase
    .from('invoices')
    .select('*')
    .eq('purchaseorderid', params.purchaseOrderId)
    .single();

  if (existing) {
    // Update existing invoice
    const { data: updated, error } = await supabase
      .from('invoices')
      .update({
        supplierid: params.supplierId,
        invoicenumber: params.invoiceNumber,
        invoicedate: params.invoiceDate,
        currency: params.currency,
      })
      .eq('purchaseorderid', params.purchaseOrderId)
      .select()
      .single();

    if (error || !updated) {
      throw new Error(`Failed to update invoice: ${error?.message}`);
    }

    return updated;
  }

  // Create new invoice
  const { data: newInvoice, error } = await supabase
    .from('invoices')
    .insert({
      purchaseorderid: params.purchaseOrderId,
      supplierid: params.supplierId,
      invoicenumber: params.invoiceNumber,
      invoicedate: params.invoiceDate,
      currency: params.currency,
    })
    .select()
    .single();

  if (error || !newInvoice) {
    throw new Error(`Failed to create invoice: ${error?.message}`);
  }

  return newInvoice;
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface ActivityLog {
  id: string;
  user_id: string;
  type: string;
  message: string;
  metadata: any;
  is_read: boolean;
  created_at: string;
}

export interface InventoryItemView {
  product: Product;
  inventory: InventoryRecord | null;
  quantityInTransit: number;
}

// Helper function to log activity
export async function logActivity(params: {
  userId: string;
  type: string;
  message: string;
  metadata?: any;
}): Promise<void> {
  const { error } = await supabase
    .from('activity_log')
    .insert({
      user_id: params.userId,
      type: params.type,
      message: params.message,
      metadata: params.metadata || {},
    });

  if (error) {
    console.error('Failed to log activity:', error.message);
  }
}

// Updated database schema including inventory-related collections
export interface DatabaseSchema {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  poLines: POLine[];
  products: Product[];
  inventory: InventoryRecord[];
  transit: TransitRecord[];
  invoices: Invoice[];
  tasks: Task[];
  activity_log: ActivityLog[];
}


// Interface for duplicate detection result
export interface DuplicateMatch {
  purchaseOrder: PurchaseOrder;
  supplier: Supplier;
  matchScore: number;
  matchReasons: string[];
  lineCount: number;
}

// Helper function to detect duplicate purchase orders
export async function findDuplicatePurchaseOrders(
  supplierName: string,
  invoiceNumber: string | null,
  invoiceDate: string | null,
  poLines: Array<{ description: string; quantity: number; unitCostExVAT: number }>,
  userId: string
): Promise<DuplicateMatch[]> {
  const duplicates: DuplicateMatch[] = [];

  // Find supplier by name (case-insensitive) for this user
  const { data: supplier } = await supabase
    .from('suppliers')
    .select('*')
    .ilike('name', supplierName)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (!supplier) {
    // No supplier found, so no duplicates possible
    return [];
  }

  // Get all purchase orders for this supplier
  // We explicitly check user_id on purchaseorders too just in case supplier.id is shared somehow
  const { data: supplierPOs } = await supabase
    .from('purchaseorders')
    .select('*')
    .eq('supplierid', supplier.id)
    .eq('user_id', userId);

  if (!supplierPOs) return [];

  for (const po of supplierPOs) {
    const matchReasons: string[] = [];
    let matchScore = 0;

    // Check invoice number match (strong indicator)
    if (invoiceNumber && po.invoicenumber && invoiceNumber.trim() !== '' && po.invoicenumber.trim() !== '' &&
        invoiceNumber.toLowerCase() === po.invoicenumber.toLowerCase()) {
      matchReasons.push('Same invoice number');
      matchScore += 50;
    }

    // Check invoice date match
    if (invoiceDate && po.invoicedate && invoiceDate.trim() !== '' && po.invoicedate.trim() !== '' && invoiceDate === po.invoicedate) {
      matchReasons.push('Same invoice date');
      matchScore += 20;
    }

    // Get line items for this PO
    const { data: existingLines } = await supabase
      .from('polines')
      .select('*')
      .eq('purchaseorderid', po.id);

    if (!existingLines) continue;

    // Check if line items are similar
    if (existingLines.length === poLines.length && poLines.length > 0) {
      matchReasons.push('Same number of line items');
      matchScore += 10;

      // Check for matching line items
      let matchingLines = 0;
      for (const newLine of poLines) {
        const similarLine = (existingLines as any[]).find(
          (existingLine: any) =>
            existingLine.description.toLowerCase().includes(newLine.description.toLowerCase().substring(0, 20)) ||
            newLine.description.toLowerCase().includes(existingLine.description.toLowerCase().substring(0, 20)) ||
            (Math.abs(existingLine.unitCostExVAT - newLine.unitCostExVAT) < 0.01 &&
             existingLine.quantity === newLine.quantity)
        );
        if (similarLine) {
          matchingLines++;
        }
      }

      if (matchingLines > 0) {
        const matchPercentage = (matchingLines / poLines.length) * 100;
        matchReasons.push(`${matchingLines}/${poLines.length} similar line items`);
        matchScore += matchPercentage * 0.2; // Up to 20 points for 100% match
      }
    }

    // If match score is significant, add to duplicates
    if (matchScore >= 30) {
      duplicates.push({
        purchaseOrder: po,
        supplier,
        matchScore,
        matchReasons,
        lineCount: existingLines.length,
      });
    }
  }

  // Sort by match score (highest first)
  duplicates.sort((a, b) => b.matchScore - a.matchScore);

  return duplicates;
}

// --- Inventory & transit helpers ---

// Normalize text into tokens for fuzzy matching
function normalizeTextForMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !['the', 'and', 'with', 'card', 'cards', 'booster', 'box', 'boxes', 'ver', 'version'].includes(token));
}

function computeTokenSimilarity(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersection = 0;
  aSet.forEach((token) => {
    if (bSet.has(token)) intersection++;
  });
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

// Sync purchase order lines into products + transit records
export async function syncInventoryFromPurchaseOrder(params: {
  supplierId: string;
  purchaseOrderId: string;
  poLines: POLine[];
  user_id: string;
}): Promise<{
  productsCreated: number;
  productsMatched: number;
  transitCreated: number;
}> {
  let productsCreated = 0;
  let productsMatched = 0;
  let transitCreated = 0;

  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('user_id', params.user_id);

  if (!products) {
    throw new Error('Failed to fetch products');
  }

  for (const line of params.poLines) {
    const rawDescription = line.description?.trim();
    if (!rawDescription) {
      continue;
    }

    const supplierSku = line.supplierSku?.trim() || null;

    // 1. Try exact SKU/barcode match first
    let matchedProduct: Product | null = null;
    if (supplierSku) {
      const skuLower = supplierSku.toLowerCase();
      matchedProduct = (products as any[]).find(p => {
        // Handle both camelCase from interface and snake_case from DB
        const pSku = (p.primarysku || p.primarySku || '').toLowerCase();
        const sSku = (p.suppliersku || p.supplierSku || '').toLowerCase();
        const barcodes = p.barcodes || [];
        return pSku === skuLower || sSku === skuLower || barcodes.some((b: string) => b.toLowerCase() === skuLower);
      }) || null;
    }

    // 2. Fuzzy match on description if no SKU match
    if (!matchedProduct) {
      const lineTokens = normalizeTextForMatch(rawDescription);
      let bestScore = 0;
      for (const candidate of products) {
        const nameTokens = normalizeTextForMatch(candidate.name || '');
        let score = computeTokenSimilarity(lineTokens, nameTokens);

        if ((candidate.aliases || []).length > 0) {
          for (const alias of candidate.aliases) {
            const aliasTokens = normalizeTextForMatch(alias);
            const aliasScore = computeTokenSimilarity(lineTokens, aliasTokens);
            if (aliasScore > score) {
              score = aliasScore;
            }
          }
        }

        if (score > bestScore) {
          // STRICT RULE: If both have SKUs and they are different, NEVER match fuzzy
          const candPSku = (candidate.primarysku || (candidate as any).primarySku || '').toLowerCase();
          const candSSku = (candidate.suppliersku || (candidate as any).supplierSku || '').toLowerCase();
          
          const skuLower = (supplierSku || '').toLowerCase();
          const hasDifferentSku = skuLower && (candPSku || candSSku) && 
                                (candPSku !== skuLower && candSSku !== skuLower);

          if (!hasDifferentSku) {
            bestScore = score;
            matchedProduct = candidate;
          }
        }
      }

      // Require a high similarity threshold to avoid bad matches (like different variants of the same set)
      if (bestScore < 0.7) {
        matchedProduct = null;
      }
    }

    const now = new Date().toISOString();
    let product: Product;

    if (matchedProduct) {
      productsMatched++;
      // Update aliases/supplier linkage if needed
      const updatedAliases = matchedProduct.aliases || [];
      if (!updatedAliases.includes(rawDescription)) {
        updatedAliases.push(rawDescription);
      }
      const { error: updateError } = await supabase
        .from('products')
        .update({
          aliases: updatedAliases,
          supplierid: matchedProduct.supplierId || params.supplierId,
          updated_at: now,
        })
        .eq('id', matchedProduct.id);
      if (updateError) {
        console.error('Failed to update product:', updateError.message || 'Unknown error');
      }
      product = matchedProduct;
    } else {
      // Create new product
      const { data: newProduct, error: insertError } = await supabase
        .from('products')
        .insert({
          name: rawDescription,
          primarysku: supplierSku,
          suppliersku: supplierSku,
          barcodes: [],
          aliases: [rawDescription],
          supplierid: params.supplierId,
          category: null,
          tags: [],
          imageurl: null,
          user_id: params.user_id,
        })
        .select()
        .single();

      if (insertError || !newProduct) {
        console.error('Failed to create product:', insertError?.message || 'Unknown error');
        continue;
      }
      products.push({
        ...newProduct,
        id: newProduct.id,
        name: newProduct.name,
        primarySku: newProduct.primarysku,
        supplierSku: newProduct.suppliersku,
        barcodes: newProduct.barcodes || [],
        aliases: newProduct.aliases || [],
        supplierId: newProduct.supplierid,
        user_id: newProduct.user_id,
      } as any);
      productsCreated++;
      product = newProduct;
    }

    // Validate quantity and unit cost before creating transit
    const quantity = typeof line.quantity === 'number' && line.quantity > 0 ? line.quantity : 0;
    const unitCost = typeof line.unitCostExVAT === 'number' && line.unitCostExVAT >= 0
      ? Number(line.unitCostExVAT.toFixed(4))
      : 0;

    if (quantity <= 0) {
      continue;
    }

    const { error: transitError } = await supabase
      .from('transit')
      .insert({
        productid: product.id,
        purchaseorderid: params.purchaseOrderId,
        polineid: line.id,
        supplierid: params.supplierId,
        quantity,
        remainingquantity: quantity,
        unitcostgbp: unitCost,
        status: 'in_transit',
        user_id: params.user_id,
      });

    if (transitError) {
      console.error('Failed to create transit record:', transitError.message || 'Unknown error');
      continue;
    }
    transitCreated++;
  }

  // Log the import activity
  if (params.poLines.length > 0) {
    await logActivity({
      userId: params.user_id,
      type: 'import',
      message: `Imported ${params.poLines.length} line items for PO ${params.purchaseOrderId}`,
      metadata: {
        purchaseOrderId: params.purchaseOrderId,
        supplierId: params.supplierId,
        productsCreated,
        productsMatched,
        transitCreated,
      },
    });
  }

  return {
    productsCreated,
    productsMatched,
    transitCreated,
  };
}

// Get an inventory snapshot (products + on-hand + quantity in transit)
// Average cost is derived primarily from what is currently on order (transit),
// and only falls back to the stored inventory.averagecostgbp when nothing is in transit.
export async function getInventorySnapshot(): Promise<InventoryItemView[]> {
  const [productsRes, inventoryRes, transitRes, poLinesRes] = await Promise.all([
    supabase.from('products').select('*'),
    supabase.from('inventory').select('*'),
    supabase.from('transit').select('*'),
    supabase.from('polines').select('id, unitcostexvat, purchaseorderid'),
  ]);

  const rawProducts = productsRes.data || [];
  const rawInventory = inventoryRes.data || [];
  const rawTransit = transitRes.data || [];
  const rawPoLines = poLinesRes.data || [];

  const poLinesById = new Map<string, any>(
    rawPoLines.map((l: any) => [l.id as string, l]),
  );

  const typedProducts: Product[] = rawProducts.map((p: any) => ({
    id: p.id,
    name: p.name,
    primarySku: p.primarysku ?? null,
    supplierSku: p.suppliersku ?? null,
    barcodes: p.barcodes ?? [],
    aliases: p.aliases ?? [],
    supplierId: p.supplierid ?? null,
    category: p.category ?? null,
    tags: p.tags ?? [],
    imageUrl: p.imageurl ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));

  const items: InventoryItemView[] = typedProducts.map((product) => {
    const invRow = rawInventory.find((i: any) => i.productid === product.id) || null;

    let inventory: InventoryRecord | null = invRow
      ? {
          id: invRow.id,
          productId: invRow.productid,
          quantityOnHand: Number(invRow.quantityonhand ?? 0),
          averageCostGBP: Number(invRow.averagecostgbp ?? 0),
          lastUpdated: invRow.lastupdated,
        }
      : null;

    const productTransit = rawTransit.filter((t: any) => t.productid === product.id);
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

    // Derive expected average unit cost from on-hand + what is currently on order (transit)
    const onHandQty = inventory ? inventory.quantityOnHand : 0;
    const onHandAvg = inventory ? inventory.averageCostGBP : 0;
    let blendedTotalQty = onHandQty;
    let blendedTotalCost = onHandQty * onHandAvg;

    if (remainingTransit.length > 0) {
      for (const t of remainingTransit) {
        const qty = Number(t.remainingquantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const poLine = poLinesById.get(t.polineid as string) || null;

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
    if (displayAverageCost <= 0 && productTransit.length > 0) {
      let fallbackTotalQty = 0;
      let fallbackTotalCost = 0;
      for (const t of productTransit) {
        const qty = Number(t.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const poLine = poLinesById.get(t.polineid as string) || null;
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
      // No on-hand inventory yet, but we do have pricing from POs in transit.
      inventory = {
        id: product.id,
        productId: product.id,
        quantityOnHand: 0,
        averageCostGBP: displayAverageCost,
        lastUpdated: product.updatedAt || product.createdAt,
      };
    }

    return {
      product,
      inventory,
      quantityInTransit,
    };
  });

  return items;
}

export interface ReceiveStockResult {
  productId: string;
  receivedQuantity: number;
  remainingRequestedQuantity: number;
  newQuantityOnHand: number;
  newAverageCostGBP: number;
  affectedTransitIds: string[];
}

// Move quantities from transit to on-hand inventory using dollar cost averaging
export async function receiveStockForProduct(params: {
  productId: string;
  quantity: number;
  poLineId?: string;
  user_id?: string;
}): Promise<ReceiveStockResult> {
  const { productId, quantity, poLineId, user_id } = params;

  if (!productId) {
    throw new Error('productId is required');
  }

  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity must be a positive number');
  }

  const { data: product } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .single();

  if (!product) {
    throw new Error('Product not found');
  }

  const now = new Date().toISOString();

  // Get or create inventory record (raw DB row)
  let inventoryRecord: any = null;
  const { data: existingInventory } = await supabase
    .from('inventory')
    .select('*')
    .eq('productid', productId)
    .single();

  if (existingInventory) {
    inventoryRecord = existingInventory;
  } else {
    const { data: newInventory, error: insertError } = await supabase
      .from('inventory')
      .insert({
        productid: productId,
        quantityonhand: 0,
        averagecostgbp: 0,
        ...(user_id ? { user_id } : {}),
      })
      .select()
      .single();

    if (insertError || !newInventory) {
      throw new Error(`Failed to create inventory record: ${insertError?.message}`);
    }
    inventoryRecord = newInventory;
  }

  // Get transit records sorted by creation date
  let transitQuery = supabase
    .from('transit')
    .select('*')
    .eq('productid', productId)
    .gt('remainingquantity', 0);

  if (poLineId) {
    transitQuery = transitQuery.eq('polineid', poLineId);
  }

  const { data: transitRecords, error: transitError } = await transitQuery.order(
    'created_at',
    { ascending: true },
  );

  if (transitError) {
    throw new Error(`Failed to load transit records: ${transitError.message}`);
  }

  if (!transitRecords || transitRecords.length === 0) {
    throw new Error('No in-transit quantity available for this product');
  }

  let remainingToReceive = quantity;
  let receivedQuantity = 0;
  let incomingTotalValue = 0;
  const affectedTransitIds: string[] = [];

  for (const t of transitRecords) {
    if (remainingToReceive <= 0) break;

    const available = Number(t.remainingquantity ?? 0);
    if (available <= 0) continue;

    const take = Math.min(remainingToReceive, available);

    // Supabase returns NUMERIC columns as strings; coerce to number safely
    const rawUnitCost = Number(t.unitcostgbp);
    const unitCost = Number.isFinite(rawUnitCost) && rawUnitCost >= 0 ? rawUnitCost : 0;

    incomingTotalValue += take * unitCost;
    receivedQuantity += take;
    const newRemaining = available - take;
    const newStatus = newRemaining > 0 ? 'partially_received' : 'received';

    await supabase
      .from('transit')
      .update({
        remainingquantity: newRemaining,
        status: newStatus,
        updated_at: now,
      })
      .eq('id', t.id);

    affectedTransitIds.push(t.id);
    remainingToReceive -= take;
  }

  if (receivedQuantity <= 0) {
    throw new Error('Unable to receive stock: no available in-transit quantity for this product');
  }

  if (!inventoryRecord) {
    throw new Error('Failed to get inventory record');
  }

  const currentOnHand = Number(inventoryRecord.quantityonhand ?? 0);
  const currentAvg = Number(inventoryRecord.averagecostgbp ?? 0);
  const currentValue = currentOnHand * currentAvg;

  const newOnHand = currentOnHand + receivedQuantity;
  const newAvg = newOnHand > 0
    ? Number(((currentValue + incomingTotalValue) / newOnHand).toFixed(4))
    : 0;

  await supabase
    .from('inventory')
    .update({
      quantityonhand: newOnHand,
      averagecostgbp: newAvg,
      lastupdated: now,
    })
    .eq('id', inventoryRecord.id);

  // --- SHOPIFY SYNC & LINK ENGINE ---
  try {
    const { data: integration } = await supabase
      .from('product_integrations')
      .select('*')
      .eq('user_id', product.user_id)
      .eq('product_id', productId)
      .eq('platform', 'shopify')
      .maybeSingle();

    if (integration) {
      // 1. Sync Inventory to Shopify
      if (receivedQuantity !== 0 && integration.external_inventory_item_id) {
        await syncShopifyInventory(integration.external_inventory_item_id, receivedQuantity, product.user_id);
      }
      
      // 2. Push Price if Greenlighted (Margin Engine)
      if (product.pricing_greenlight && product.target_margin) {
        const targetMarginPct = Number(product.target_margin);
        if (targetMarginPct > 0 && targetMarginPct < 100) {
          // Margin model:
          // requiredNet = (unitCost + fixedPerUnitCost) / (1 - targetMargin)
          // sellingPrice = requiredNet / (1 - taxPct - feePct)
          const taxPct = Number(product.pricing_sales_tax_pct ?? 0);
          const feePct = Number(product.pricing_shopify_fee_pct ?? 0);
          const fixedPerUnitCost = Number(product.pricing_postage_packaging_gbp ?? 0);

          const marginRate = targetMarginPct / 100;
          const taxRate = Math.max(0, taxPct) / 100;
          const feeRate = Math.max(0, feePct) / 100;
          const variableDeductions = taxRate + feeRate;

          if (marginRate >= 1 || variableDeductions >= 1) {
            throw new Error('Invalid pricing settings: rates must total below 100%');
          }

          const unitCost = Math.max(0, newAvg) + Math.max(0, fixedPerUnitCost);
          const requiredNet = unitCost / (1 - marginRate);
          const newPrice = requiredNet / (1 - variableDeductions);
          const formattedPrice = Math.max(0, newPrice).toFixed(2);
          
          if (integration.external_variant_id) {
            await updateShopifyPrice(integration.external_variant_id, formattedPrice, product.user_id);
          }
        }
      }
    } else {
      // 3. Draft Push: Product doesn't exist on Shopify, so create it
      // Ensure SKU exists
      let sku = product.primarysku;
      if (!sku) {
        sku = 'SL-' + Math.random().toString(36).substring(2, 10).toUpperCase();
        await supabase.from('products').update({ primarysku: sku }).eq('id', productId);
      }
      
      const newShopifyIds = await pushDraftProductToShopify(product, sku, product.user_id);
      
      // Save the new link
      await supabase.from('product_integrations').insert({
        user_id: product.user_id,
        product_id: productId,
        platform: 'shopify',
        external_product_id: newShopifyIds.productId,
        external_variant_id: newShopifyIds.variantId,
        external_inventory_item_id: newShopifyIds.inventoryItemId
      });
      
      // Push the inventory to the newly created item
      if (receivedQuantity !== 0) {
         await syncShopifyInventory(newShopifyIds.inventoryItemId, receivedQuantity, product.user_id);
      }
    }
  } catch (err) {
    console.error('Failed to sync receiving event to Shopify:', err);
    // We do not throw here to prevent rolling back the local StockLane receiving if Shopify fails
  }

  return {
    productId,
    receivedQuantity,
    remainingRequestedQuantity: remainingToReceive,
    newQuantityOnHand: newOnHand,
    newAverageCostGBP: newAvg,
    affectedTransitIds,
  };
}

// Attach a barcode to a product (used for scanner-based lookup)
export async function addBarcodeToProduct(
  productId: string,
  barcode: string
): Promise<Product> {
  const trimmed = (barcode || '').trim();
  if (!productId) {
    throw new Error('productId is required');
  }
  if (!trimmed) {
    throw new Error('Barcode is required');
  }
  if (trimmed.length > 128) {
    throw new Error('Barcode is too long');
  }

  // Ensure this barcode is not already linked to another product
  const { data: existingWithBarcode, error: lookupError } = await supabase
    .from('products')
    .select('id, name, barcodes')
    .contains('barcodes', [trimmed]);

  if (lookupError) {
    throw new Error(`Failed to check existing barcodes: ${lookupError.message}`);
  }

  if (existingWithBarcode && existingWithBarcode.length > 0) {
    const conflicting = existingWithBarcode.find((p: any) => p.id !== productId);
    if (conflicting) {
      const otherName = conflicting.name || conflicting.id;
      throw new Error(`This barcode is already linked to another product: "${otherName}"`);
    }
  }

  // Get current product
  const { data: product } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .single();

  if (!product) {
    throw new Error('Product not found');
  }

  const currentBarcodes = product.barcodes || [];
  if (!currentBarcodes.includes(trimmed)) {
    const { data: updated, error } = await supabase
      .from('products')
      .update({
        barcodes: [...currentBarcodes, trimmed],
        updated_at: new Date().toISOString(),
      })
      .eq('id', productId)
      .select()
      .single();

    if (error || !updated) {
      throw new Error(`Failed to add barcode: ${error?.message}`);
    }

    return updated;
  }

  return product;
}
