'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/api-client';

interface PreviewVariant {
    shopifyProductId: string;
    shopifyVariantId: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    quantity: number;
    price: number;
    vendor: string | null;
    category: string | null;
    inventoryItemId: string | null;

    matchType: 'exact_sku' | 'exact_barcode' | 'ai_suggested' | 'none';
    targetProductId: string | null;
    targetProductName: string | null;
    action: 'create' | 'update' | 'ignore';
}

interface LocalProduct {
    id: string;
    name: string;
    primarysku: string | null;
}

export default function ShopifySyncPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [variants, setVariants] = useState<PreviewVariant[]>([]);
    const [localProducts, setLocalProducts] = useState<LocalProduct[]>([]);

    useEffect(() => {
        async function load() {
            try {
                const res = await authenticatedFetch('/api/inventory/shopify-sync/preview', {
                    method: 'POST'
                });
                const json = await res.json();
                if (!res.ok || !json.success) throw new Error(json.error || 'Failed to connect to Shopify');

                setVariants(json.data.variants || []);
                setLocalProducts(json.data.localProducts || []);
            } catch (err: any) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        load();
    }, []);

    const handleActionChange = (index: number, action: 'create' | 'update' | 'ignore') => {
        const newVariants = [...variants];
        newVariants[index].action = action;
        if (action === 'update' && !newVariants[index].targetProductId) {
            // automatically select first if switching to update
            if (localProducts.length > 0) {
                newVariants[index].targetProductId = localProducts[0].id;
                newVariants[index].targetProductName = localProducts[0].name;
            }
        }
        setVariants(newVariants);
    };

    const handleTargetChange = (index: number, targetId: string) => {
        const newVariants = [...variants];
        newVariants[index].targetProductId = targetId;
        const prod = localProducts.find(p => p.id === targetId);
        newVariants[index].targetProductName = prod ? prod.name : null;
        setVariants(newVariants);
    };

    const handleSkuChange = (index: number, value: string) => {
        const newVariants = [...variants];
        const trimmed = value.trim();
        newVariants[index].sku = trimmed.length > 0 ? trimmed : null;
        setVariants(newVariants);
    };

    const handleExecute = async () => {
        try {
            setSaving(true);
            setError(null);

            const payload = { variants };

            const res = await authenticatedFetch('/api/inventory/shopify-sync/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to sync execution');

            alert(json.message);
            router.push('/inventory');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="h-full flex items-center justify-center bg-[#f9f9f8] dark:bg-stone-900">
                <div className="flex flex-col items-center gap-4">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-600"></div>
                    <p className="text-stone-600 dark:text-stone-400">Reviewing Shopify Catalog & Identifying AI Matches...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-[#f9f9f8] dark:bg-stone-900">
            <div className="flex-none px-4 lg:px-6 pt-6 pb-4 border-b border-stone-200 dark:border-stone-800 bg-[#f9f9f8] dark:bg-stone-900 z-10">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                    <div className="min-w-0 lg:max-w-[72%]">
                        <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100 flex items-center gap-2 leading-tight">
                            <img src="/Shopify_icon.svg" className="w-6 h-6" alt="Shopify" />
                            Review Shopify Import
                        </h1>
                        <p className="text-sm text-stone-500 mt-2 leading-relaxed">
                            We found {variants.length} active variants on your Shopify store. Please review the mapping below before continuing to ensure no duplicates are created. You can link incoming products with existing stock.
                        </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 self-start">
                        <button
                            onClick={() => router.push('/inventory')}
                            className="h-12 px-6 border border-stone-300 text-stone-700 bg-white rounded-xl hover:bg-stone-50 active:scale-[0.99] dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700 transition disabled:opacity-60 disabled:cursor-not-allowed text-base font-medium"
                            disabled={saving}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleExecute}
                            disabled={saving}
                            aria-busy={saving}
                            className="h-12 min-w-[188px] px-6 bg-amber-600 text-white rounded-xl hover:bg-amber-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition inline-flex items-center justify-center gap-2 text-base font-semibold"
                        >
                            {saving && (
                                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
                            )}
                            <span>{saving ? 'Syncing...' : 'Confirm & Sync'}</span>
                        </button>
                    </div>
                </div>
                {error && (
                    <div className="mt-4 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md">
                        {error}
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-auto p-4 lg:px-6">
                <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl shadow-sm overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-stone-50 dark:bg-stone-900/50 border-b border-stone-200 dark:border-stone-700">
                                <th className="p-3 text-xs font-medium text-stone-500 uppercase tracking-wider">Shopify Product (Variant)</th>
                                <th className="p-3 text-xs font-medium text-stone-500 uppercase tracking-wider">Identifiers</th>
                                <th className="p-3 text-xs font-medium text-stone-500 uppercase tracking-wider">Action</th>
                                <th className="p-3 text-xs font-medium text-stone-500 uppercase tracking-wider">Target StockLane Product</th>
                                <th className="p-3 text-xs font-medium text-stone-500 uppercase tracking-wider text-right">Shopify Qty</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-200 dark:divide-stone-700 text-sm">
                            {variants.map((v, i) => (
                                <tr key={i} className="hover:bg-stone-50 dark:hover:bg-stone-800/50">
                                    <td className="p-3 font-medium text-stone-900 dark:text-stone-100">
                                        {v.title}
                                    </td>
                                    <td className="p-3 text-stone-500 dark:text-stone-400">
                                        {v.sku && <span className="block">SKU: {v.sku}</span>}
                                        {v.barcode && <span className="block">Barcode: {v.barcode}</span>}
                                        {!v.sku && !v.barcode && (
                                            <span className="block text-stone-400 italic">No SKU or barcode from Shopify</span>
                                        )}
                                        <div className="mt-2">
                                            <label className="sr-only" htmlFor={`manual-sku-${i}`}>Manual SKU</label>
                                            <input
                                                id={`manual-sku-${i}`}
                                                type="text"
                                                value={v.sku || ''}
                                                onChange={(e) => handleSkuChange(i, e.target.value)}
                                                placeholder="Add SKU (optional)"
                                                className="w-full max-w-[220px] border-stone-200 dark:border-stone-700 rounded-md text-sm bg-white dark:bg-stone-900 py-1.5 px-2 focus:border-amber-500 focus:ring-amber-500"
                                            />
                                        </div>
                                    </td>
                                    <td className="p-3">
                                        <select
                                            value={v.action}
                                            onChange={(e) => handleActionChange(i, e.target.value as 'create' | 'update' | 'ignore')}
                                            className="border-stone-200 dark:border-stone-700 rounded-md text-sm bg-white dark:bg-stone-900 py-1.5 focus:border-amber-500 focus:ring-amber-500"
                                        >
                                            <option value="create">Create New Item</option>
                                            <option value="update">Update Existing</option>
                                            <option value="ignore">Ignore</option>
                                        </select>
                                    </td>
                                    <td className="p-3">
                                        {v.action === 'update' ? (
                                            <div className="flex flex-col gap-1">
                                                <select
                                                    value={v.targetProductId || ''}
                                                    onChange={(e) => handleTargetChange(i, e.target.value)}
                                                    className="border-stone-200 dark:border-stone-700 rounded-md text-sm bg-white dark:bg-stone-900 py-1.5 focus:border-amber-500 focus:ring-amber-500 max-w-[250px]"
                                                >
                                                    {localProducts.map(p => (
                                                        <option key={p.id} value={p.id}>{p.name} {p.primarysku ? `(${p.primarysku})` : ''}</option>
                                                    ))}
                                                </select>
                                                {v.matchType === 'ai_suggested' && (
                                                    <span className="text-xs text-amber-600 font-medium bg-amber-50 w-fit px-1.5 rounded">✨ AI Suggestion</span>
                                                )}
                                                {v.matchType === 'exact_sku' && (
                                                    <span className="text-xs text-green-600 font-medium bg-green-50 w-fit px-1.5 rounded">Exact SKU Match</span>
                                                )}
                                                {v.matchType === 'exact_barcode' && (
                                                    <span className="text-xs text-green-600 font-medium bg-green-50 w-fit px-1.5 rounded">Exact Barcode Match</span>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="text-stone-400 italic">
                                                {v.action === 'create' ? 'Will create a new inventory record' : 'Will be ignored'}
                                            </span>
                                        )}
                                    </td>
                                    <td className="p-3 text-right tabular-nums text-stone-900 dark:text-stone-100">
                                        {v.quantity}
                                    </td>
                                </tr>
                            ))}
                            {variants.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="p-8 text-center text-stone-500">
                                        No active products found on your Shopify store.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
