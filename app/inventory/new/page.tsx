'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/api-client';

interface SupplierOption {
  id: string;
  name: string;
}

interface SuppliersResponse {
  suppliers?: SupplierOption[];
}

interface NewProductForm {
  name: string;
  primarySku: string;
  supplierSku: string;
  category: string;
  barcodes: string;
  tags: string;
  aliases: string;
  imageUrl: string;
  supplierId: string;
}

export default function NewProductPage() {
  const router = useRouter();

  const [form, setForm] = useState<NewProductForm>({
    name: '',
    primarySku: '',
    supplierSku: '',
    category: '',
    barcodes: '',
    tags: '',
    aliases: '',
    imageUrl: '',
    supplierId: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);

  const handleChange = (field: keyof NewProductForm, value: string) => {
    setForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  useEffect(() => {
    const loadSuppliers = async () => {
      try {
        const res = await authenticatedFetch('/api/purchasing/po/view');
        const json = (await res.json().catch(() => null)) as SuppliersResponse | null;
        if (!res.ok || !json || !Array.isArray(json.suppliers)) return;
        setSuppliers(json.suppliers);
      } catch (err) {
        console.error('Failed to load suppliers for new product form', err);
      }
    };

    loadSuppliers();
  }, []);

  const parseList = (value: string): string[] =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);

  const initials = form.name
    .split(' ')
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  const handleCreate = async () => {
    const name = form.name.trim();
    if (!name) {
      setError('Name is required');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const payload = {
        name,
        primarySku: form.primarySku.trim() || null,
        supplierSku: form.supplierSku.trim() || null,
        category: form.category.trim() || null,
        barcodes: parseList(form.barcodes),
        tags: parseList(form.tags),
        aliases: parseList(form.aliases),
        imageUrl: form.imageUrl.trim() || null,
        supplierId: form.supplierId.trim() || null,
      };

      const res = await authenticatedFetch('/api/inventory/product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to create product');
      }

      const productId: string | undefined = json.data?.product?.id;
      if (productId) {
        router.push(`/inventory/${productId}`);
      } else {
        router.push('/inventory');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#f9f9f8]">
    <div className="py-4 sm:py-6 px-3 sm:px-6 lg:px-8">
      <div className="max-w-[1400px] mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => router.back()}
              className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-amber-600 mb-2"
            >
              <span>←</span>
              <span>Back to inventory</span>
            </button>
            <h1 className="text-2xl sm:text-3xl font-bold text-stone-900 truncate">New product</h1>
            <p className="text-xs text-stone-500 mt-1 truncate">
              Create a standalone product that can receive stock later from purchase orders or manual receipts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-amber-600 text-white text-xs sm:text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create product'}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-[11px] text-red-700">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Left column: Product Information card */}
          <div className="bg-white rounded-lg border border-stone-200 p-4 sm:p-5 space-y-4">
            <h2 className="text-sm font-semibold text-stone-900">Product Information</h2>
            <div className="relative w-full h-48 sm:h-64 rounded-md overflow-hidden border border-stone-200 bg-[#f9f9f8]">
              {form.imageUrl.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.imageUrl}
                  alt={form.name || 'Product image'}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="h-full w-full bg-gradient-to-br from-stone-100 to-stone-200 flex items-center justify-center text-3xl font-bold text-stone-600 uppercase">
                  {initials || 'PR'}
                </div>
              )}
            </div>
            <div>
              <p className="text-stone-500 text-xs mb-1">Image URL</p>
              <input
                value={form.imageUrl}
                onChange={(e) => handleChange('imageUrl', e.target.value)}
                placeholder="Paste image URL (e.g. from Supabase storage)"
                className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
              />
            </div>
            <div className="border-t border-stone-200 pt-3">
              <p className="text-stone-500 text-xs mb-1">Notes / Aliases</p>
              <input
                value={form.aliases}
                onChange={(e) => handleChange('aliases', e.target.value)}
                placeholder="Comma-separated alternative names used on invoices, etc."
                className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
              />
            </div>
          </div>

          {/* Right column: Product Details + QR & Barcode cards */}
          <div className="space-y-5">
            <div className="bg-white rounded-lg border border-stone-200 p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-semibold text-stone-900 mb-1">Product Details</h2>
              <div>
                <p className="text-xs text-stone-500 mb-1">Name</p>
                <input
                  value={form.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                  className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-stone-500 mb-1">Primary SKU</p>
                  <input
                    value={form.primarySku}
                    onChange={(e) => handleChange('primarySku', e.target.value)}
                    className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600 font-mono"
                  />
                </div>
                <div>
                  <p className="text-xs text-stone-500 mb-1">Supplier SKU</p>
                  <input
                    value={form.supplierSku}
                    onChange={(e) => handleChange('supplierSku', e.target.value)}
                    className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600 font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-stone-500 mb-1">Category</p>
                  <input
                    value={form.category}
                    onChange={(e) => handleChange('category', e.target.value)}
                    className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                  />
                </div>
                <div>
                  <p className="text-xs text-stone-500 mb-1">Supplier</p>
                  <select
                    value={form.supplierId}
                    onChange={(e) => handleChange('supplierId', e.target.value)}
                    className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                  >
                    <option value="">No supplier (optional)</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg border border-stone-200 p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-semibold text-stone-900 mb-1">QR & Barcode</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-stone-500 mb-1">Barcodes</p>
                  <input
                    value={form.barcodes}
                    onChange={(e) => handleChange('barcodes', e.target.value)}
                    placeholder="Comma-separated"
                    className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600 font-mono"
                  />
                </div>
                <div>
                  <p className="text-xs text-stone-500 mb-1">Tags</p>
                  <input
                    value={form.tags}
                    onChange={(e) => handleChange('tags', e.target.value)}
                    placeholder="Comma-separated"
                    className="w-full rounded-md bg-[#f9f9f8] border border-stone-200 text-stone-900 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
