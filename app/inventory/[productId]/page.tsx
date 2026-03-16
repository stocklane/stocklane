'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/api-client';

interface Supplier {
  id: string;
  name: string;
  address: string | null;
  email: string | null;
  phone: string | null;
  vatNumber: string | null;
  createdAt: string;
}

interface Product {
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
  shopifyBound: boolean;
  pricingGreenlight: boolean;
  targetMargin: number | null;
  pricingSalesTaxPct: number;
  pricingShopifyFeePct: number;
  pricingPostagePackagingGbp: number;
  createdAt: string;
  updatedAt: string;
}

interface MutationResponse {
  success?: boolean;
  error?: string;
}

interface InventoryRecord {
  id: string;
  productId: string;
  quantityOnHand: number;
  averageCostGBP: number;
  averageCostInTransitGBP?: number;
  averageCostCombinedGBP?: number;
  lastUpdated: string;
}

interface PurchaseOrder {
  id: string;
  supplierId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string;
  paymentTerms: string | null;
  imageUrl: string | null;
  imageUrls: string[] | null;
  createdAt: string;
}

interface POLine {
  id: string;
  purchaseOrderId: string;
  description: string;
  supplierSku: string | null;
  quantity: number;
  unitCostExVAT: number;
  lineTotalExVAT: number;
}

interface TransitRecord {
  id: string;
  productId: string;
  purchaseOrderId: string;
  poLineId: string;
  supplierId: string;
  quantity: number;
  remainingQuantity: number;
  unitCostGBP: number;
  status: 'in_transit' | 'partially_received' | 'received';
  createdAt: string;
  updatedAt: string;
}

interface Invoice {
  id: string;
  purchaseOrderId: string;
  supplierId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string;
  createdAt: string;
}

interface TransitWithContext {
  transit: TransitRecord;
  poLine: POLine | null;
  purchaseOrder: PurchaseOrder | null;
  invoice: Invoice | null;
}

interface ProductIntegration {
  platform: string;
  externalProductId: string;
  externalVariantId: string;
}

interface ProductHistoryResponse {
  product: Product;
  inventory: InventoryRecord | null;
  supplier: Supplier | null;
  transit: TransitWithContext[];
  integrations: ProductIntegration[];
}

const MobileBarcodeScanner = dynamic(
  () => import('@/components/MobileBarcodeScanner'),
  { ssr: false },
);

export default function ProductHistoryPage() {
  const params = useParams<{ productId: string }>();
  const router = useRouter();
  const productId = params.productId;

  const [data, setData] = useState<ProductHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingPrices, setEditingPrices] = useState(false);
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [priceError, setPriceError] = useState<string | null>(null);
  const [savingPrices, setSavingPrices] = useState(false);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [receivingTransitId, setReceivingTransitId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    sku: '',
    category: '',
    barcodes: '',
    tags: '',
    aliases: '',
    imageUrl: '',
    shopifyBound: false,
    pricingGreenlight: false,
    targetMargin: '',
    pricingSalesTaxPct: '',
    pricingShopifyFeePct: '',
    pricingPostagePackagingGbp: '',
  });
  const [deleting, setDeleting] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        if (!productId) return;
        setLoading(true);
        setError(null);
        const res = await authenticatedFetch(
          `/api/inventory/product?id=${encodeURIComponent(productId)}`,
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || 'Failed to load product history');
        }
        const nextData = json.data as ProductHistoryResponse;
        setData(nextData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load product history');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [productId]);

  useEffect(() => {
    if (data?.product) {
      setEditForm({
        name: data.product.name || '',
        sku: data.product.primarySku || data.product.supplierSku || '',
        category: data.product.category || '',
        barcodes: (data.product.barcodes || []).join(', '),
        tags: (data.product.tags || []).join(', '),
        aliases: (data.product.aliases || []).join(', '),
        imageUrl: data.product.imageUrl || '',
        shopifyBound: !!data.product.shopifyBound,
        pricingGreenlight: !!data.product.pricingGreenlight,
        targetMargin:
          data.product.targetMargin == null ? '' : String(data.product.targetMargin),
        pricingSalesTaxPct: String(data.product.pricingSalesTaxPct ?? 0),
        pricingShopifyFeePct: String(data.product.pricingShopifyFeePct ?? 0),
        pricingPostagePackagingGbp: String(data.product.pricingPostagePackagingGbp ?? 0),
      });
    }

    if (data?.transit) {
      const initialPrices: Record<string, string> = {};
      data.transit.forEach((row) => {
        if (row.poLine) {
          const rawUnit =
            row.poLine.unitCostExVAT ??
            row.transit.unitCostGBP ??
            0;
          initialPrices[row.poLine.id] = String(rawUnit);
        }
      });
      setPriceEdits(initialPrices);
    } else {
      setPriceEdits({});
    }

    if (data?.transit) {
      const initialReceiveQuantities: Record<string, string> = {};
      data.transit.forEach((row) => {
        const remaining = row.transit.remainingQuantity ?? 0;
        if (remaining > 0) {
          initialReceiveQuantities[row.transit.id] = String(remaining);
        }
      });
      setReceiveQuantities(initialReceiveQuantities);
    } else {
      setReceiveQuantities({});
    }
  }, [data]);

  const formatDate = (value: string | null | undefined) => {
    if (!value) return 'N/A';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null || isNaN(amount)) return '£0.00 GBP';
    return `£${amount.toFixed(2)} GBP`;
  };

  const handleEditFieldChange = (
    field: keyof typeof editForm,
    value: string | boolean,
  ) => {
    setEditForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handlePriceChange = (lineId: string, value: string) => {
    setPriceEdits((prev) => ({
      ...prev,
      [lineId]: value,
    }));
  };

  const handleReceiveQuantityChange = (transitId: string, value: string) => {
    setReceiveQuantities((prev) => ({
      ...prev,
      [transitId]: value,
    }));
  };

  const reloadProductData = async () => {
    if (!productId) {
      return null;
    }

    const res = await authenticatedFetch(
      `/api/inventory/product?id=${encodeURIComponent(productId)}`,
    );
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Failed to reload product history');
    }

    const nextData = json.data as ProductHistoryResponse;
    setData(nextData);
    return nextData;
  };

  const handleSaveProduct = async () => {
    if (!data) return;

    try {
      setSaving(true);
      setError(null);

      const normalizeList = (input: string): string[] =>
        input
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);

      const sku = editForm.sku.trim();

      const payload = {
        name: editForm.name.trim() || data.product.name,
        primarySku: sku || null,
        supplierSku: sku || null,
        category: editForm.category.trim() || null,
        barcodes: normalizeList(editForm.barcodes),
        tags: normalizeList(editForm.tags),
        aliases: normalizeList(editForm.aliases),
        imageUrl: editForm.imageUrl.trim() || null,
        shopifyBound: editForm.shopifyBound,
        pricingGreenlight: editForm.pricingGreenlight,
        targetMargin:
          editForm.targetMargin.trim() === '' ? null : Number(editForm.targetMargin),
        pricingSalesTaxPct:
          editForm.pricingSalesTaxPct.trim() === ''
            ? 0
            : Number(editForm.pricingSalesTaxPct),
        pricingShopifyFeePct:
          editForm.pricingShopifyFeePct.trim() === ''
            ? 0
            : Number(editForm.pricingShopifyFeePct),
        pricingPostagePackagingGbp:
          editForm.pricingPostagePackagingGbp.trim() === ''
            ? 0
            : Number(editForm.pricingPostagePackagingGbp),
      };

      const res = await authenticatedFetch(
        `/api/inventory/product?id=${encodeURIComponent(data.product.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to update product');
      }

      const updated: Product = json.data.product;
      setData((prev) => (prev ? { ...prev, product: updated } : prev));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update product');
    } finally {
      setSaving(false);
    }
  };

  const handleSavePrices = async () => {
    if (!data) return;

    try {
      setSavingPrices(true);
      setPriceError(null);

      const updates: {
        id: string;
        unitCostExVAT: number;
        lineTotalExVAT: number;
      }[] = [];

      data.transit.forEach((row) => {
        if (!row.poLine) return;
        const line = row.poLine;
        const raw = priceEdits[line.id];
        if (raw === undefined) return;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error('Unit prices must be non-negative numbers');
        }
        if (parsed === line.unitCostExVAT) return;
        const quantity = line.quantity ?? row.transit.quantity ?? 0;
        const lineTotal = parsed * quantity;
        updates.push({
          id: line.id,
          unitCostExVAT: parsed,
          lineTotalExVAT: lineTotal,
        });
      });

      for (const update of updates) {
        const res = await authenticatedFetch(
          `/api/purchasing/po/lines?id=${encodeURIComponent(update.id)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              unitCostExVAT: update.unitCostExVAT,
              lineTotalExVAT: update.lineTotalExVAT,
            }),
          },
        );
        const json: MutationResponse = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) {
          throw new Error(
            json.error || 'Failed to update line item',
          );
        }
      }

      if (updates.length > 0) {
        await reloadProductData();
      }

      setEditingPrices(false);
    } catch (err) {
      setPriceError(
        err instanceof Error ? err.message : 'Failed to update prices',
      );
    } finally {
      setSavingPrices(false);
    }
  };

  const handleDeleteProduct = async () => {
    if (!data) return;

    if (
      !window.confirm(
        `Move "${data.product.name}" to bin? You can empty it permanently from the bin page.`,
      )
    ) {
      return;
    }

    try {
      setDeleting(true);
      setError(null);

      const res = await authenticatedFetch(
        `/api/inventory/product?id=${encodeURIComponent(data.product.id)}`,
        {
          method: 'DELETE',
        },
      );

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to move product to bin');
      }

      router.push('/inventory');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete product',
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleClearBarcodes = async () => {
    if (!data) return;

    if (!window.confirm('Clear all barcodes for this product?')) {
      return;
    }

    try {
      setError(null);
      const res = await authenticatedFetch(
        `/api/inventory/product?id=${encodeURIComponent(data.product.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ barcodes: [] }),
        },
      );

      const json = await res.json().catch(() => null);
      if (!res.ok || !json || !json.success) {
        throw new Error((json && json.error) || 'Failed to clear barcodes');
      }

      const updated: Product = json.data.product;
      setData((prev) => (prev ? { ...prev, product: updated } : prev));
      setEditForm((prev) => ({
        ...prev,
        barcodes: '',
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear barcodes');
    }
  };

  const handleScannedBarcode = async (code: string) => {
    const raw = (code || '').trim();
    setScannerOpen(false);
    if (!raw || !data) {
      return;
    }

    try {
      const res = await authenticatedFetch('/api/inventory/add-barcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: data.product.id, barcode: raw }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || !json.success) {
        throw new Error((json && json.error) || 'Failed to add barcode');
      }

      const reloadRes = await authenticatedFetch(
        `/api/inventory/product?id=${encodeURIComponent(data.product.id)}`,
      );
      const reloadJson = await reloadRes.json().catch(() => null);
      if (reloadRes.ok && reloadJson && reloadJson.success) {
        const nextData: ProductHistoryResponse = reloadJson.data;
        setData(nextData);
        if (nextData.product) {
          setEditForm((prev) => ({
            ...prev,
            barcodes: (nextData.product.barcodes || []).join(', '),
          }));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add barcode');
    }
  };

  const handleReceiveTransit = async (row: TransitWithContext) => {
    const remainingQuantity = row.transit.remainingQuantity || 0;
    if (remainingQuantity <= 0) {
      return;
    }

    const rawQuantity = receiveQuantities[row.transit.id] ?? String(remainingQuantity);
    const quantityToReceive = Number(rawQuantity);

    if (!Number.isFinite(quantityToReceive) || quantityToReceive <= 0) {
      alert('Please enter a valid quantity to receive.');
      return;
    }

    if (quantityToReceive > remainingQuantity) {
      alert(`You can receive at most ${remainingQuantity} units for this shipment.`);
      return;
    }

    const description = row.poLine?.description || data?.product.name || 'this item';
    if (
      !window.confirm(
        `Mark ${quantityToReceive} unit(s) as received for "${description}"? (In transit: ${remainingQuantity})`,
      )
    ) {
      return;
    }

    try {
      setReceivingTransitId(row.transit.id);
      setError(null);

      const endpoint = row.poLine
        ? '/api/inventory/receive-line'
        : '/api/inventory/receive';
      const payload = row.poLine
        ? {
            productId: row.transit.productId,
            poLineId: row.poLine.id,
            quantity: quantityToReceive,
          }
        : {
            productId: row.transit.productId,
            quantity: quantityToReceive,
          };

      const res = await authenticatedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json: MutationResponse = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        throw new Error(json.error || 'Failed to receive stock');
      }

      await reloadProductData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to receive stock');
    } finally {
      setReceivingTransitId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f9f9f8] dark:bg-stone-900 py-4 sm:py-6 px-3 sm:px-6 lg:px-8">
        <div className="max-w-[1400px] mx-auto">
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400 hover:text-amber-600 mb-6"
          >
            <span>←</span>
            <span>Back to inventory</span>
          </button>
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-amber-600"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#f9f9f8] dark:bg-stone-900 py-8 px-4">
        <div className="max-w-3xl mx-auto">
          <button
            type="button"
            onClick={() => router.back()}
            className="mb-4 text-sm text-amber-600 hover:text-amber-700"
          >
            ← Back
          </button>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            {error || 'Product not found'}
          </div>
        </div>
      </div>
    );
  }

  const { product, inventory, supplier, transit } = data;

  const initials = product.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  const inTransitQty = transit.reduce((sum, t) => sum + (t.transit.remainingQuantity || 0), 0);
  const quantityOnHand = inventory?.quantityOnHand || 0;
  const totalStockForValue = quantityOnHand + inTransitQty;
  const rowCostBreakdown = transit.reduce(
    (acc, row) => {
      const ordered = row.transit.quantity || 0;
      const remaining = row.transit.remainingQuantity || 0;
      const received = Math.max(0, ordered - remaining);
      const poUnit = row.poLine?.unitCostExVAT;
      const transitUnit = row.transit.unitCostGBP;
      const fallbackUnit =
        typeof poUnit === 'number' && Number.isFinite(poUnit) && poUnit > 0
          ? poUnit
          : typeof transitUnit === 'number' && Number.isFinite(transitUnit) && transitUnit > 0
            ? transitUnit
            : 0;
      const lineTotal = row.poLine?.lineTotalExVAT;
      const hasLineTotal =
        typeof lineTotal === 'number' &&
        Number.isFinite(lineTotal) &&
        lineTotal >= 0 &&
        ordered > 0;
      const unit = hasLineTotal ? (lineTotal as number) / ordered : fallbackUnit;

      acc.receivedQty += received;
      acc.receivedValue += received * unit;
      acc.transitValue += remaining * unit;
      return acc;
    },
    { receivedQty: 0, receivedValue: 0, transitValue: 0 },
  );

  const hasReliableReceivedBreakdown =
    rowCostBreakdown.receivedQty > 0 &&
    Math.abs(rowCostBreakdown.receivedQty - quantityOnHand) < 0.0001;

  const onHandValue = hasReliableReceivedBreakdown
    ? rowCostBreakdown.receivedValue
    : quantityOnHand * (inventory?.averageCostGBP || 0);

  const totalValue = onHandValue + rowCostBreakdown.transitValue;
  const displayUnitPrice = totalStockForValue > 0 ? totalValue / totalStockForValue : 0;
  const isLongProductName = (product.name || '').length > 40;

  const configuredMarginPct =
    editForm.targetMargin.trim() === ''
      ? product.targetMargin ?? 0
      : Number(editForm.targetMargin);
  const configuredTaxPct = Number(
    editForm.pricingSalesTaxPct.trim() === ''
      ? product.pricingSalesTaxPct
      : editForm.pricingSalesTaxPct,
  );
  const configuredFeePct = Number(
    editForm.pricingShopifyFeePct.trim() === ''
      ? product.pricingShopifyFeePct
      : editForm.pricingShopifyFeePct,
  );
  const configuredPostage = Number(
    editForm.pricingPostagePackagingGbp.trim() === ''
      ? product.pricingPostagePackagingGbp
      : editForm.pricingPostagePackagingGbp,
  );

  const marginRate = configuredMarginPct / 100;
  const deductionRate = configuredTaxPct / 100 + configuredFeePct / 100;
  const calculatorValid =
    Number.isFinite(configuredMarginPct) &&
    Number.isFinite(configuredTaxPct) &&
    Number.isFinite(configuredFeePct) &&
    Number.isFinite(configuredPostage) &&
    configuredMarginPct > 0 &&
    configuredMarginPct < 100 &&
    configuredTaxPct >= 0 &&
    configuredFeePct >= 0 &&
    configuredPostage >= 0 &&
    marginRate < 1 &&
    deductionRate < 1;

  const projectedShopifyPrice = calculatorValid
    ? ((Math.max(0, displayUnitPrice) + configuredPostage) / (1 - marginRate)) / (1 - deductionRate)
    : null;

  return (
    <div className="h-full overflow-y-auto bg-[#f9f9f8] dark:bg-stone-900">
      <div className="py-4 sm:py-6 px-3 sm:px-6 lg:px-8">
        <div className="max-w-[1400px] mx-auto space-y-4">
          {/* Header row - Sortly style */}
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => router.back()}
                className="inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400 hover:text-amber-600 mb-2"
              >
                <span>←</span>
                <span>Back to inventory</span>
              </button>
              <h1
                className={`font-bold text-stone-900 dark:text-stone-100 uppercase tracking-tight break-words ${isLongProductName ? 'text-lg sm:text-xl md:text-2xl leading-snug' : 'text-lg sm:text-2xl md:text-3xl'
                  }`}
              >
                {product.name}
              </h1>
              <p className="text-xs text-stone-400 dark:text-stone-500 mt-1">
                Product ID: <span className="font-mono">{product.id.slice(0, 8)}...</span> · Updated {formatDate(product.updatedAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      if (data?.product) {
                        setEditForm({
                          name: data.product.name || '',
                          sku: data.product.primarySku || data.product.supplierSku || '',
                          category: data.product.category || '',
                          barcodes: (data.product.barcodes || []).join(', '),
                          tags: (data.product.tags || []).join(', '),
                          aliases: (data.product.aliases || []).join(', '),
                          imageUrl: data.product.imageUrl || '',
                          shopifyBound: !!data.product.shopifyBound,
                          pricingGreenlight: !!data.product.pricingGreenlight,
                          targetMargin:
                            data.product.targetMargin == null
                              ? ''
                              : String(data.product.targetMargin),
                          pricingSalesTaxPct: String(data.product.pricingSalesTaxPct ?? 0),
                          pricingShopifyFeePct: String(data.product.pricingShopifyFeePct ?? 0),
                          pricingPostagePackagingGbp: String(data.product.pricingPostagePackagingGbp ?? 0),
                        });
                      }
                    }}
                    disabled={saving}
                    className="px-4 py-2 rounded-md border border-stone-200 dark:border-stone-700 text-sm text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveProduct}
                    disabled={saving}
                    className="px-4 py-2 rounded-md bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-amber-600 text-white text-sm font-medium hover:bg-amber-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                  EDIT
                </button>
              )}
            </div>
          </div>

          {/* Two-column body - Sortly style */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            {/* Left column: Product identity + image */}
            <div className="space-y-4">
              <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-4 sm:p-5 flex flex-col">
                <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-4">Product Information</h2>

              {/* Large product image - Sortly style */}
              <div className="mb-4">
                <div className="flex justify-center">
                  <div className="relative w-full h-[180px] sm:h-[210px] md:h-[240px] rounded-lg overflow-hidden border border-stone-200 bg-[#f9f9f8]">
                    {editing ? (
                      editForm.imageUrl.trim() ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={editForm.imageUrl}
                          alt={editForm.name || product.name || 'Product image'}
                          className="h-full w-full object-contain p-2"
                        />
                      ) : (
                        <div className="h-full w-full bg-gradient-to-br from-stone-100 to-stone-200 dark:from-stone-700 dark:to-stone-600 flex items-center justify-center text-4xl font-bold text-stone-600 dark:text-stone-300 uppercase">
                          {initials || 'PR'}
                        </div>
                      )
                    ) : product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={product.imageUrl}
                        alt={product.name || 'Product image'}
                        className="h-full w-full object-contain p-2"
                      />
                    ) : (
                      <div className="h-full w-full bg-gradient-to-br from-stone-100 to-stone-200 dark:from-stone-700 dark:to-stone-600 flex items-center justify-center text-4xl font-bold text-stone-600 dark:text-stone-300 uppercase">
                        {initials || 'PR'}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Image URL input when editing */}
              {editing && (
                <div className="mb-4">
                  <label className="block text-xs text-stone-500 dark:text-stone-400 mb-1">Image URL</label>
                  <input
                    value={editForm.imageUrl}
                    onChange={(e) => handleEditFieldChange('imageUrl', e.target.value)}
                    placeholder="Paste image URL (e.g. from Supabase storage)"
                    className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-600"
                  />
                </div>
              )}

              </div>

              <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-4">
                <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-4">Product Details</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-stone-500 dark:text-stone-400 mb-1">Name</p>
                    {editing ? (
                      <input
                        value={editForm.name}
                        onChange={(e) => handleEditFieldChange('name', e.target.value)}
                        className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-600"
                      />
                    ) : (
                      <p className="text-sm text-stone-900 dark:text-stone-100">{product.name}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-stone-500 dark:text-stone-400 mb-1">SKU</p>
                    {editing ? (
                      <input
                        value={editForm.sku}
                        onChange={(e) => handleEditFieldChange('sku', e.target.value)}
                        className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-600 font-mono"
                      />
                    ) : (
                      <p className="text-sm text-stone-900 dark:text-stone-100 font-mono">
                        {product.primarySku || product.supplierSku || '-'}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-stone-500 dark:text-stone-400 mb-1">Category</p>
                    {editing ? (
                      <input
                        value={editForm.category}
                        onChange={(e) => handleEditFieldChange('category', e.target.value)}
                        className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-600"
                      />
                    ) : (
                      <p className="text-sm text-stone-900 dark:text-stone-100">{product.category || '-'}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-stone-500 dark:text-stone-400 mb-1">Supplier</p>
                    <p className="text-sm text-stone-900 dark:text-stone-100">{supplier?.name || '-'}</p>
                  </div>
                  <div className="sm:col-span-2 border-t border-stone-200 dark:border-stone-700 pt-3">
                    <p className="text-xs text-stone-500 dark:text-stone-400 mb-1">Notes</p>
                    {editing ? (
                      <input
                        value={editForm.aliases}
                        onChange={(e) => handleEditFieldChange('aliases', e.target.value)}
                        placeholder="Alternative names, notes, etc."
                        className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-600"
                      />
                    ) : (
                      <p className="text-sm text-stone-600 dark:text-stone-400 max-h-14 overflow-y-auto pr-1">
                        {product.aliases && product.aliases.length
                          ? product.aliases.join(' / ')
                          : '-'}
                      </p>
                    )}
                  </div>
                </div>
              </div>

            </div>

            {/* Right column: Metrics 2x2 + Details */}
              <div className="space-y-4">
              {/* Metrics 2x2 grid */}
              <div className="grid grid-cols-2 gap-2 sm:gap-3">
                <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-3 sm:p-4">
                  <p className="text-[10px] sm:text-xs text-stone-500 dark:text-stone-400 mb-1">In hand</p>
                  <p className="text-xl sm:text-2xl font-bold text-stone-900 dark:text-stone-100">{inventory?.quantityOnHand || 0}</p>
                </div>
                <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-3 sm:p-4">
                  <p className="text-[10px] sm:text-xs text-stone-500 dark:text-stone-400 mb-1">In Transit</p>
                  <p className="text-xl sm:text-2xl font-bold text-stone-900 dark:text-stone-100">{inTransitQty}</p>
                </div>
                <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-3 sm:p-4">
                  <p className="text-[10px] sm:text-xs text-stone-500 dark:text-stone-400 mb-1">Price/unit</p>
                  <p className="text-xl sm:text-2xl font-bold text-stone-900 dark:text-stone-100">£{displayUnitPrice.toFixed(2)}</p>
                </div>
                <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-3 sm:p-4">
                  <p className="text-[10px] sm:text-xs text-stone-500 dark:text-stone-400 mb-1">Total value</p>
                  <p className="text-xl sm:text-2xl font-bold text-stone-900 dark:text-stone-100">£{totalValue.toFixed(2)}</p>
                </div>
              </div>

              {/* Pricing automation card */}
              <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-4">
                <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-4">Pricing Automation</h2>
                <div className="space-y-4">
                  <div className="rounded-md border border-stone-200 dark:border-stone-700 p-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <p className="text-[11px] text-stone-500 dark:text-stone-400 mb-1">Target margin %</p>
                        {editing ? (
                          <input
                            type="number"
                            min={0}
                            max={99.99}
                            step="0.01"
                            value={editForm.targetMargin}
                            onChange={(e) => handleEditFieldChange('targetMargin', e.target.value)}
                            className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                          />
                        ) : (
                          <p className="text-sm text-stone-900 dark:text-stone-100">
                            {product.targetMargin != null ? `${product.targetMargin}%` : '-'}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-[11px] text-stone-500 dark:text-stone-400 mb-1">Sales tax %</p>
                        {editing ? (
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={editForm.pricingSalesTaxPct}
                            onChange={(e) => handleEditFieldChange('pricingSalesTaxPct', e.target.value)}
                            className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                          />
                        ) : (
                          <p className="text-sm text-stone-900 dark:text-stone-100">{product.pricingSalesTaxPct}%</p>
                        )}
                      </div>
                      <div>
                        <p className="text-[11px] text-stone-500 dark:text-stone-400 mb-1">Shopify fee %</p>
                        {editing ? (
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={editForm.pricingShopifyFeePct}
                            onChange={(e) => handleEditFieldChange('pricingShopifyFeePct', e.target.value)}
                            className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                          />
                        ) : (
                          <p className="text-sm text-stone-900 dark:text-stone-100">{product.pricingShopifyFeePct}%</p>
                        )}
                      </div>
                      <div>
                        <p className="text-[11px] text-stone-500 dark:text-stone-400 mb-1">Postage/packaging £</p>
                        {editing ? (
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={editForm.pricingPostagePackagingGbp}
                            onChange={(e) => handleEditFieldChange('pricingPostagePackagingGbp', e.target.value)}
                            className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                          />
                        ) : (
                          <p className="text-sm text-stone-900 dark:text-stone-100">
                            £{product.pricingPostagePackagingGbp.toFixed(2)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] text-stone-500 dark:text-stone-400">
                        Projected Shopify price on receive
                      </p>
                      <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                        {projectedShopifyPrice != null ? `£${projectedShopifyPrice.toFixed(2)}` : '-'}
                      </p>
                    </div>
                    <div className="mt-2">
                      {editing ? (
                        <label className="inline-flex items-center gap-2 text-xs text-stone-700 dark:text-stone-300 mb-2">
                          <input
                            type="checkbox"
                            checked={editForm.shopifyBound}
                            onChange={(e) =>
                              handleEditFieldChange('shopifyBound', e.target.checked)
                            }
                            className="rounded border-stone-300 dark:border-stone-600 text-amber-600 focus:ring-amber-600"
                          />
                          Create Shopify draft on receive when no link exists
                        </label>
                      ) : (
                        <p className="text-xs text-stone-700 dark:text-stone-300 mb-2">
                          {product.shopifyBound
                            ? 'Shopify-bound: draft can be created on receive when unlinked'
                            : 'Not marked for Shopify draft creation'}
                        </p>
                      )}
                    </div>
                    <div className="mt-2">
                      {editing ? (
                        <label className="inline-flex items-center gap-2 text-xs text-stone-700 dark:text-stone-300">
                          <input
                            type="checkbox"
                            checked={editForm.pricingGreenlight}
                            onChange={(e) =>
                              handleEditFieldChange('pricingGreenlight', e.target.checked)
                            }
                            className="rounded border-stone-300 dark:border-stone-600 text-amber-600 focus:ring-amber-600"
                          />
                          Auto-push price to Shopify when stock is received
                        </label>
                      ) : (
                        <p className="text-xs text-stone-700 dark:text-stone-300">
                          {product.pricingGreenlight
                            ? 'Greenlit for auto Shopify price updates on receive'
                            : 'Not greenlit'}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="pt-1 border-t border-stone-200/70 dark:border-stone-700/70">
                    <p className="text-xs text-stone-500 dark:text-stone-400 mb-2">Sources & Integrations</p>
                    <div className="flex flex-wrap gap-2">
                      {/* Internal Source (Invoices) */}
                      {transit && transit.length > 0 && (
                        <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-stone-100 dark:bg-stone-700 border border-stone-200 dark:border-stone-600">
                          <svg className="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          <span className="text-xs font-medium text-stone-700 dark:text-stone-200">Purchasing (Invoices)</span>
                        </div>
                      )}

                      {/* External Integrations (Shopify, etc.) */}
                      {data.integrations && data.integrations.map((int) => (
                        <div
                          key={int.platform}
                          className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-stone-100 dark:bg-stone-700 border border-stone-200 dark:border-stone-600"
                        >
                          {int.platform.toLowerCase() === 'shopify' && (
                            <svg className="w-3.5 h-3.5 text-[#95bf47]" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M4.17 3.3C4.35 3.15 4.5 3 4.83 3c.33 0 1.25.13 2.13.25.88.13 2.22.42 2.22.42s5.75-2 7.04-2.58c1.3-.58 2.37-.1 2.37.58 0 .68-1.54 10.37-1.54 10.37s.21.3.62.71c.42.41 1.25 1.12 1.25 2.12 0 .67-.42 1.46-.83 1.88s-1.04.41-1.46.41c-.41 0-1.83-.95-1.83-.95s-2.04 1.25-3.33 1.83c-1.3.58-3.08.75-4.5.75-.5 0-.91-.12-1.33-.25C5.17 21.36 3.5 19.38 3 16.4c-.2-.8-.4-4.83-.5-7.5-.1-2.67.17-5.17.67-5.6z" />
                            </svg>
                          )}
                          <span className="text-xs font-medium text-stone-700 dark:text-stone-200 capitalize">
                            {int.platform}
                          </span>
                        </div>
                      ))}

                      {(!transit || transit.length === 0) && (!data.integrations || data.integrations.length === 0) && (
                        <span className="text-sm text-stone-400 italic">None specified</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* QR & Barcode card */}
              <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-4 sm:p-5">
                <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-4">QR & Barcode</h2>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-stone-500 dark:text-stone-400">Barcodes</p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setScannerOpen(true)}
                        className="inline-flex items-center justify-center px-3 py-1.5 rounded-md bg-amber-600 text-white text-[11px] font-medium hover:bg-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-600 sm:hidden"
                      >
                        <svg
                          className="w-3.5 h-3.5 mr-1"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 7h3M4 17h3M17 7h3M17 17h3M9 7h6M9 17h6M7 9v6M17 9v6"
                          />
                        </svg>
                        Scan & add
                      </button>
                      <button
                        type="button"
                        onClick={handleClearBarcodes}
                        className="inline-flex items-center justify-center px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 text-[11px] text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  {editing ? (
                    <input
                      value={editForm.barcodes}
                      onChange={(e) => handleEditFieldChange('barcodes', e.target.value)}
                      placeholder="Comma-separated barcodes"
                      className="w-full rounded-md bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-600 font-mono"
                    />
                  ) : (
                    <p className="text-sm text-stone-900 dark:text-stone-100 font-mono">
                      {product.barcodes && product.barcodes.length
                        ? product.barcodes.join(', ')
                        : '-'}
                    </p>
                  )}
                </div>
              </div>

            </div>
          </div>

          {/* Transit & invoice history */}
          <div className="bg-white dark:bg-stone-800 rounded-lg border border-stone-200 dark:border-stone-700 p-3 sm:p-5 md:p-6">
            <div className="flex items-center justify-between mb-3 sm:mb-4">
              <h2 className="text-sm sm:text-base font-semibold text-stone-900 dark:text-stone-100">
                Purchase orders & shipments
              </h2>
              {transit.length > 0 && (
                <div className="flex items-center gap-2">
                  {editingPrices ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingPrices(false);
                          setPriceError(null);
                          if (data?.transit) {
                            const reset: Record<string, string> = {};
                            data.transit.forEach((row) => {
                              if (row.poLine) {
                                const rawUnit =
                                  row.poLine.unitCostExVAT ??
                                  row.transit.unitCostGBP ??
                                  0;
                                reset[row.poLine.id] = String(rawUnit);
                              }
                            });
                            setPriceEdits(reset);
                          }
                        }}
                        disabled={savingPrices}
                        className="px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 text-[11px] text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSavePrices}
                        disabled={savingPrices}
                        className="px-3 py-1.5 rounded-md bg-amber-600 text-white text-[11px] hover:bg-amber-700 disabled:opacity-50"
                      >
                        {savingPrices ? 'Saving…' : 'Save prices'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPrices(true);
                        setPriceError(null);
                      }}
                      className="px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 text-[11px] text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700"
                    >
                      Edit prices
                    </button>
                  )}
                </div>
              )}
            </div>

            {priceError && (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                {priceError}
              </div>
            )}

            {transit.length === 0 ? (
              <p className="text-xs sm:text-sm text-stone-500 dark:text-stone-400">No shipments recorded for this product yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-[11px] sm:text-sm divide-y divide-stone-200 dark:divide-stone-700">
                  <thead className="bg-[#f9f9f8] dark:bg-stone-900">
                    <tr>
                      <th className="px-2 sm:px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400">PO</th>
                      <th className="px-2 sm:px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400 hidden sm:table-cell">Line</th>
                      <th className="px-2 sm:px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400 hidden md:table-cell">Invoice</th>
                      <th className="px-2 sm:px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400 whitespace-nowrap">Ord</th>
                      <th className="px-2 sm:px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400 hidden sm:table-cell">Rcv</th>
                      <th className="px-2 sm:px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400">Left</th>
                      <th className="px-2 sm:px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400 whitespace-nowrap">Unit £</th>
                      <th className="px-2 sm:px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400 hidden sm:table-cell">Total</th>
                      <th className="px-2 sm:px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400">Status</th>
                      <th className="px-2 sm:px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400 whitespace-nowrap">Receive</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                    {transit.map((row) => {
                      const ordered = row.transit.quantity || 0;
                      const remaining = row.transit.remainingQuantity || 0;
                      const received = ordered - remaining;
                      const po = row.purchaseOrder;
                      const invoice = row.invoice;
                      const poLineId = row.poLine?.id || null;
                      const defaultUnit =
                        row.poLine?.unitCostExVAT ?? row.transit.unitCostGBP ?? 0;
                      const editedUnitRaw =
                        poLineId && priceEdits[poLineId] !== undefined
                          ? priceEdits[poLineId]
                          : String(defaultUnit);
                      const parsedEditedUnit = Number(editedUnitRaw);
                      const effectiveUnit =
                        editingPrices && poLineId &&
                          Number.isFinite(parsedEditedUnit) &&
                          parsedEditedUnit >= 0
                          ? parsedEditedUnit
                          : defaultUnit;
                      const effectiveLineTotal =
                        editingPrices && poLineId
                          ? effectiveUnit * ordered
                          : row.poLine?.lineTotalExVAT ??
                          (row.poLine?.unitCostExVAT ?? row.transit.unitCostGBP) *
                          ordered;

                      const isLongDescription =
                        (row.poLine?.description || '').length > 60;
                      const canReceive = remaining > 0;
                      const receiveValue =
                        receiveQuantities[row.transit.id] ?? String(remaining);
                      const receivingThisRow = receivingTransitId === row.transit.id;

                      return (
                        <tr key={row.transit.id} className="hover:bg-[#f9f9f8] dark:hover:bg-stone-700/50">
                          <td className="px-2 sm:px-3 py-2 align-top">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-stone-900 dark:text-stone-100 font-medium text-[11px] sm:text-xs">
                                {po?.invoiceNumber || 'PO ' + (po?.id ?? '').slice(0, 8)}
                              </span>
                              {invoice && (
                                <span className="text-stone-500 dark:text-stone-400 text-[10px] sm:text-xs hidden sm:block">
                                  Inv: {invoice.invoiceNumber || '-'}
                                </span>
                              )}
                              {po && (
                                <span className="text-stone-400 dark:text-stone-500 text-[10px] sm:text-xs">
                                  {formatDate(po.invoiceDate || po.createdAt)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 sm:px-3 py-2 align-top hidden sm:table-cell">
                            <p
                              className={`text-stone-900 dark:text-stone-100 break-words ${isLongDescription ? 'text-[10px] sm:text-xs leading-snug' : ''
                                }`}
                            >
                              {row.poLine?.description || '-'}
                            </p>
                            {row.poLine?.supplierSku && (
                              <p className="text-stone-500 font-mono">
                                {row.poLine.supplierSku}
                              </p>
                            )}
                          </td>
                          <td className="px-2 sm:px-3 py-2 align-top hidden md:table-cell">
                            {po?.imageUrls && po.imageUrls.length > 0 ? (
                              <div className="flex gap-1">
                                {po.imageUrls.slice(0, 2).map((imageUrl, idx) => (
                                  <a
                                    key={idx}
                                    href={imageUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group relative w-12 h-16 bg-white dark:bg-stone-700 rounded border border-stone-200 dark:border-stone-600 hover:border-amber-600 overflow-hidden transition-colors"
                                    title={`View invoice page ${idx + 1}`}
                                  >
                                    <img
                                      src={imageUrl}
                                      alt={`Invoice ${idx + 1}`}
                                      className="w-full h-full object-cover"
                                    />
                                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
                                      <svg className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                      </svg>
                                    </div>
                                  </a>
                                ))}
                                {po.imageUrls.length > 2 && (
                                  <div className="flex items-center justify-center w-12 h-16 bg-white dark:bg-stone-700 rounded border border-stone-200 dark:border-stone-600 text-[10px] text-stone-500 dark:text-stone-400">
                                    +{po.imageUrls.length - 2}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-stone-400 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-right align-top text-stone-900 dark:text-stone-100">
                            {ordered}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-right align-top text-stone-900 dark:text-stone-100 hidden sm:table-cell">
                            {received}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-right align-top text-stone-900 dark:text-stone-100">
                            {remaining}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-right align-top text-stone-900 dark:text-stone-100">
                            {editingPrices && row.poLine ? (
                              <input
                                type="number"
                                value={editedUnitRaw}
                                onChange={(e) =>
                                  handlePriceChange(row.poLine!.id, e.target.value)
                                }
                                min="0"
                                step="0.01"
                                className="w-20 rounded-md border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 px-2 py-1 text-right text-xs text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                              />
                            ) : (
                              formatCurrency(defaultUnit)
                            )}
                          </td>
                          <td className="px-2 sm:px-3 py-2 text-right align-top text-stone-900 dark:text-stone-100 hidden sm:table-cell">
                            {formatCurrency(effectiveLineTotal)}
                          </td>
                          <td className="px-2 sm:px-3 py-2 align-top">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${row.transit.status === 'received'
                                ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
                                : row.transit.status === 'partially_received'
                                  ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                                  : 'bg-stone-100 dark:bg-stone-700 text-stone-800 dark:text-stone-300'
                                }`}
                            >
                              {row.transit.status.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="px-2 sm:px-3 py-2 align-top">
                            {canReceive ? (
                              <div className="flex items-center justify-end gap-2">
                                <input
                                  type="number"
                                  min="0"
                                  max={remaining}
                                  step="1"
                                  value={receiveValue}
                                  onChange={(e) =>
                                    handleReceiveQuantityChange(
                                      row.transit.id,
                                      e.target.value,
                                    )
                                  }
                                  className="w-16 rounded-md border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 px-2 py-1 text-right text-xs text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleReceiveTransit(row)}
                                  disabled={receivingThisRow}
                                  className="inline-flex items-center px-2.5 py-1.5 rounded-md bg-amber-600 text-white text-[11px] font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {receivingThisRow ? 'Receiving…' : 'Receive'}
                                </button>
                              </div>
                            ) : (
                              <span className="block text-right text-[10px] text-stone-400 dark:text-stone-500">
                                Complete
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="flex justify-end mt-4">
            <button
              type="button"
              onClick={handleDeleteProduct}
              disabled={deleting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50 text-sm"
              aria-label={deleting ? 'Moving product to bin' : 'Move product to bin'}
            >
              {deleting ? 'Moving…' : 'Move to bin'}
            </button>
          </div>
        </div>

        {scannerOpen && (
          <MobileBarcodeScanner
            onScan={handleScannedBarcode}
            onClose={() => setScannerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
