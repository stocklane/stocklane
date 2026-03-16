'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authenticatedFetch } from '@/lib/api-client';

interface BinItem {
  id: string;
  name: string;
  primarysku: string | null;
  suppliersku: string | null;
  imageurl: string | null;
  deleted_at: string | null;
}

export default function InventoryBinPage() {
  const [items, setItems] = useState<BinItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [emptying, setEmptying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBin = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await authenticatedFetch('/api/inventory/bin');
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load bin');
      }
      setItems(json.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bin');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBin();
  }, []);

  const handleEmptyBin = async () => {
    if (items.length === 0) return;
    if (!window.confirm(`Empty bin and permanently delete ${items.length} item(s)?`)) {
      return;
    }

    try {
      setEmptying(true);
      setError(null);
      const res = await authenticatedFetch('/api/inventory/bin', { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to empty bin');
      }
      setItems([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to empty bin');
    } finally {
      setEmptying(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#f9f9f8] dark:bg-stone-900">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">Inventory</p>
            <h1 className="mt-1 text-3xl font-semibold text-stone-900 dark:text-stone-100">Bin</h1>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Deleted items stay here until you empty the bin.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/inventory"
              className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
            >
              Back to inventory
            </Link>
            <button
              type="button"
              onClick={handleEmptyBin}
              disabled={emptying || items.length === 0}
              className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {emptying ? 'Emptying...' : 'Empty bin'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="mt-8 flex items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-amber-600" />
          </div>
        ) : items.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-10 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400">
            Bin is empty.
          </div>
        ) : (
          <div className="mt-8 overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-800">
            <div className="grid grid-cols-[minmax(0,1fr)_160px] gap-4 border-b border-stone-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:border-stone-700 dark:text-stone-400 sm:grid-cols-[minmax(0,1fr)_180px_200px]">
              <span>Name</span>
              <span className="hidden sm:block">SKU</span>
              <span>Deleted</span>
            </div>
            <div className="divide-y divide-stone-200 dark:divide-stone-700">
              {items.map((item) => (
                <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_160px] gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_180px_200px]">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-stone-100 text-xs font-semibold uppercase text-stone-600 dark:bg-stone-700 dark:text-stone-200">
                      {item.name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'PR'}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">{item.name}</p>
                    </div>
                  </div>
                  <div className="hidden text-sm text-stone-500 dark:text-stone-400 sm:block">
                    {item.primarysku || item.suppliersku || '-'}
                  </div>
                  <div className="text-sm text-stone-500 dark:text-stone-400">
                    {item.deleted_at ? new Date(item.deleted_at).toLocaleString('en-GB') : '-'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
