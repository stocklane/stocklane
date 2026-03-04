'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/contexts/AuthContext';
import { authenticatedFetch } from '@/lib/api-client';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';

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
  createdAt: string;
  updatedAt: string;
}

interface InventoryRecord {
  id: string;
  productId: string;
  quantityOnHand: number;
  averageCostGBP: number;
  lastUpdated: string;
}

interface InventoryRow {
  product: Product;
  inventory: InventoryRecord | null;
  quantityInTransit: number;
  supplier: Supplier | null;
}

const MobileBarcodeScanner = dynamic(
  () => import('@/components/MobileBarcodeScanner'),
  { ssr: false },
);

export default function InventoryPage() {
  const router = useRouter();

  const [items, setItems] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'onHand' | 'inTransit'>('all');
  const [activeFolderId, setActiveFolderId] = useState<string>('all');
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [isDraggingFolder, setIsDraggingFolder] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [barcodeProductId, setBarcodeProductId] = useState<string | null>(null);
  const [barcodeValue, setBarcodeValue] = useState('');
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sl_inventory_viewMode');
      if (saved === 'grid' || saved === 'table') return saved;
    }
    return 'grid';
  });
  const [foldersPanelCollapsed, setFoldersPanelCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('sl_inventory_foldersCollapsed') === 'true';
    }
    return false;
  });

  useEffect(() => {
    localStorage.setItem('sl_inventory_viewMode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('sl_inventory_foldersCollapsed', String(foldersPanelCollapsed));
  }, [foldersPanelCollapsed]);

  const [deletingProductId, setDeletingProductId] = useState<string | null>(null);
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);

  const [customFolders, setCustomFolders] = useState<
    { id: string; name: string; dbId?: string; parentId?: string | null }[]
  >([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [headerScrolled, setHeaderScrolled] = useState(false);

  const handleScannedBarcode = (code: string) => {
    const raw = (code || '').trim();
    if (!raw) {
      setScannerOpen(false);
      return;
    }

    const normalized = raw.toLowerCase();

    const matched = items.find((row) => {
      const product = row.product;
      const barcodes = Array.isArray(product.barcodes) ? product.barcodes : [];
      if (barcodes.some((b) => b.toLowerCase() === normalized)) return true;
      if (product.primarySku && product.primarySku.toLowerCase() === normalized) return true;
      if (product.supplierSku && product.supplierSku.toLowerCase() === normalized) return true;
      return false;
    });

    setScannerOpen(false);

    if (matched) {
      router.push(`/inventory/${matched.product.id}`);
      return;
    }

    setSearch(raw);
    showToast('No product found for scanned code. Showing search results instead.');
  };

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await authenticatedFetch('/api/inventory/snapshot');
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || 'Failed to load inventory');
        }
        setItems(json.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load inventory');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  useEffect(() => {
    const loadFolders = async () => {
      try {
        const res = await authenticatedFetch('/api/folders');
        const json = await res.json();
        if (!res.ok || !json.success) {
          // eslint-disable-next-line no-console
          console.error('Failed to load folders', json.error);
          return;
        }
        const rawFolders = (json.data || []) as {
          id: string;
          name: string;
          parentid: string | null;
        }[];
        setCustomFolders(
          rawFolders.map((f) => ({
            id: f.name,
            name: f.name,
            dbId: f.id,
            parentId: f.parentid,
          })),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to load folders', err);
      }
    };

    loadFolders();
  }, []);

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;

    return items.filter(({ product }) => {
      const tokens: string[] = [];
      if (product.name) tokens.push(product.name.toLowerCase());
      if (product.primarySku) tokens.push(product.primarySku.toLowerCase());
      if (product.supplierSku) tokens.push(product.supplierSku.toLowerCase());
      if (Array.isArray(product.aliases)) {
        product.aliases.forEach((a) => tokens.push(a.toLowerCase()));
      }
      if (Array.isArray(product.barcodes)) {
        product.barcodes.forEach((b) => tokens.push(b.toLowerCase()));
      }

      return tokens.some((t) => t.includes(term));
    });
  }, [items, search]);

  const folders = useMemo(
    () => {
      const categories = new Set<string>();
      items.forEach((row) => {
        if (row.product.category) {
          categories.add(row.product.category);
        }
      });

      const categoryFolders = Array.from(categories)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ id: name, name }))
        .filter((folder) => !customFolders.some((f) => f.id === folder.id));

      return [...categoryFolders, ...customFolders];
    },
    [items, customFolders],
  );

  const folderTree = useMemo(
    () => {
      type TreeNode = {
        id: string;
        name: string;
        dbId?: string;
        depth: number;
        isCustom: boolean;
        parentId: string | null;
      };

      const categoryNodes: TreeNode[] = [];
      const categories = new Set<string>();
      items.forEach((row) => {
        if (row.product.category) {
          categories.add(row.product.category);
        }
      });

      Array.from(categories)
        .sort((a, b) => a.localeCompare(b))
        .forEach((name) => {
          if (!customFolders.some((f) => f.id === name)) {
            categoryNodes.push({ id: name, name, depth: 0, isCustom: false, parentId: null });
          }
        });

      const childrenByParent = new Map<string | null, typeof customFolders>();
      const byDbId = new Map<string, (typeof customFolders)[number]>();
      customFolders.forEach((folder) => {
        if (folder.dbId) {
          byDbId.set(folder.dbId, folder);
        }
        const key = folder.parentId ?? null;
        const arr = childrenByParent.get(key) ?? [];
        arr.push(folder);
        childrenByParent.set(key, arr);
      });

      const result: TreeNode[] = [...categoryNodes];
      const visited = new Set<string>();

      const visit = (
        folder: (typeof customFolders)[number],
        depth: number,
        parentId: string | null,
      ) => {
        const key = folder.dbId ?? folder.id;
        if (visited.has(key)) return;
        visited.add(key);

        result.push({
          id: folder.id,
          name: folder.name,
          dbId: folder.dbId,
          depth,
          isCustom: true,
          parentId,
        });

        const children = (childrenByParent.get(folder.dbId ?? null) ?? []).slice();
        children.sort((a, b) => a.name.localeCompare(b.name));
        children.forEach((child) => visit(child, depth + 1, folder.id));
      };

      const roots = customFolders.filter((folder) => {
        if (!folder.parentId) return true;
        return !byDbId.has(folder.parentId);
      });

      if (roots.length > 0) {
        roots
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((root) => visit(root, 0, null));
      } else {
        customFolders
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((folder) => visit(folder, 0, null));
      }

      return result;
    },
    [items, customFolders],
  );

  const folderParentById = useMemo(
    () => {
      const map = new Map<string, string | null>();
      folderTree.forEach((node) => {
        map.set(node.id, node.parentId ?? null);
      });
      return map;
    },
    [folderTree],
  );

  const activeFolderPath = useMemo(
    () => {
      if (activeFolderId === 'all') return [];

      const path: { id: string; name: string }[] = [];
      let currentId: string | null = activeFolderId;
      const safetyLimit = 50;

      while (currentId && currentId !== 'all' && path.length < safetyLimit) {
        const folder = folders.find((f) => f.id === currentId);
        if (!folder) break;

        path.unshift({ id: folder.id, name: folder.name });

        const parentId: string | null = folderParentById.get(currentId) ?? null;
        if (!parentId || parentId === currentId) break;
        currentId = parentId;
      }

      return path;
    },
    [activeFolderId, folders, folderParentById],
  );

  const toggleFolderCollapsed = (id: string) => {
    setCollapsedFolders((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const hasCollapsedAncestor = (id: string): boolean => {
    let parentId = folderParentById.get(id) ?? null;
    while (parentId) {
      if (collapsedFolders[parentId]) return true;
      parentId = folderParentById.get(parentId) ?? null;
    }
    return false;
  };

  const visibleItems = useMemo(
    () => {
      // Only show products that have stock in hand or quantity in transit
      let nonZeroStock = filteredItems.filter((row) => {
        const onHand = row.inventory?.quantityOnHand ?? 0;
        const inTransit = row.quantityInTransit ?? 0;
        return onHand > 0 || inTransit > 0;
      });

      if (stockFilter === 'onHand') {
        nonZeroStock = nonZeroStock.filter((row) => {
          const onHand = row.inventory?.quantityOnHand ?? 0;
          return onHand > 0;
        });
      } else if (stockFilter === 'inTransit') {
        nonZeroStock = nonZeroStock.filter((row) => {
          const inTransit = row.quantityInTransit ?? 0;
          return inTransit > 0;
        });
      }

      if (activeFolderId === 'all') return nonZeroStock;

      return nonZeroStock.filter((row) => row.product.category === activeFolderId);
    },
    [filteredItems, activeFolderId, stockFilter],
  );

  const handleRefresh = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await authenticatedFetch('/api/inventory/snapshot?refresh=true');
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load inventory');
      }
      setItems(json.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inventory');
    } finally {
      setLoading(false);
    }
  };

  const handleAddBarcode = async () => {
    if (!barcodeProductId) return;
    const code = barcodeValue.trim();
    if (!code) {
      alert('Please enter a barcode value');
      return;
    }

    try {
      setBarcodeLoading(true);
      const res = await authenticatedFetch('/api/inventory/add-barcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: barcodeProductId, barcode: code }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to add barcode');
      }
      setBarcodeProductId(null);
      setBarcodeValue('');
      await handleRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add barcode');
    } finally {
      setBarcodeLoading(false);
    }
  };

  const handleDeleteProduct = async (product: Product) => {
    if (
      !window.confirm(
        `Delete "${product.name}" from inventory? This will also remove any on-hand and in-transit records for this product.`,
      )
    ) {
      return;
    }

    try {
      setDeletingProductId(product.id);
      const res = await authenticatedFetch(
        `/api/inventory/product?id=${encodeURIComponent(product.id)}`,
        {
          method: 'DELETE',
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to delete product');
      }
      await handleRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete product');
    } finally {
      setDeletingProductId(null);
    }
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        setToastMessage((current) => (current === message ? null : current));
      }, 2500);
    }
  };

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null || isNaN(amount)) return '£0.00 GBP';
    return `£${amount.toFixed(2)} GBP`;
  };

  const exportInventoryCSV = () => {
    const escapeCSV = (val: string) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const headers = ['Name', 'Primary SKU', 'Supplier SKU', 'Category', 'Supplier', 'Barcodes', 'Qty On Hand', 'Qty In Transit', 'Avg Cost (GBP)', 'On Hand Value (GBP)', 'Total Value (GBP)'];
    const rows: string[][] = visibleItems.map((row) => {
      const onHand = row.inventory?.quantityOnHand ?? 0;
      const inTransit = row.quantityInTransit ?? 0;
      const avgCost = row.inventory?.averageCostGBP ?? 0;
      const onHandValue = onHand * avgCost;
      const totalValue = (onHand + inTransit) * avgCost;

      return [
        row.product.name || '',
        row.product.primarySku || '',
        row.product.supplierSku || '',
        row.product.category || '',
        row.supplier?.name || '',
        (row.product.barcodes || []).join('; '),
        String(onHand),
        String(inTransit),
        avgCost.toFixed(4),
        onHandValue.toFixed(2),
        totalValue.toFixed(2),
      ];
    });

    const csvContent = [headers, ...rows].map(row => row.map(escapeCSV).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `inventory-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleStartNewFolder = () => {
    let parentId: string | null = null;
    if (activeFolderId !== 'all') {
      const activeCustomFolder = customFolders.find((f) => f.id === activeFolderId);
      if (activeCustomFolder && activeCustomFolder.dbId) {
        parentId = activeCustomFolder.dbId;
      }
    }
    setCreateFolderParentId(parentId);
    setIsCreatingFolder(true);
    setNewFolderName('');
  };

  const handleCancelNewFolder = () => {
    setIsCreatingFolder(false);
    setNewFolderName('');
    setCreateFolderParentId(null);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;

    try {
      const exists = customFolders.some(
        (f) => f.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (exists) {
        // eslint-disable-next-line no-alert
        alert('A folder with that name already exists. Please choose a different name.');
        return;
      }

      const parentId = createFolderParentId;
      const res = await authenticatedFetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        // eslint-disable-next-line no-alert
        alert(json.error || 'Failed to create folder');
        return;
      }

      const folder = json.data as { id: string; name: string; parentid?: string | null };
      const viewFolder = {
        id: folder.name,
        name: folder.name,
        dbId: folder.id,
        parentId: folder.parentid ?? parentId ?? null,
      };
      setCustomFolders((prev) => [...prev, viewFolder]);
      setActiveFolderId(viewFolder.id);
      setIsCreatingFolder(false);
      setNewFolderName('');
      setCreateFolderParentId(null);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    // Do not allow deleting the synthetic "all" folder or category-based folders
    const folder = customFolders.find((f) => f.id === folderId);
    if (!folder) return;

    // eslint-disable-next-line no-alert
    const confirmed = window.confirm('Delete this folder? This cannot be undone.');
    if (!confirmed) return;

    try {
      const res = await authenticatedFetch(
        `/api/folders?id=${encodeURIComponent(folder.dbId || folderId)}`,
        {
          method: 'DELETE',
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || (json && (json as any).success === false)) {
        // eslint-disable-next-line no-alert
        alert(((json as any) && (json as any).error) || 'Failed to delete folder');
        return;
      }

      setCustomFolders((prev) => prev.filter((f) => f.id !== folderId));
      if (activeFolderId === folderId) {
        setActiveFolderId('all');
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Failed to delete folder');
    }
  };

  const handleProductDragStart = (
    e: DragEvent<HTMLDivElement>,
    product: Product,
  ) => {
    e.dataTransfer.setData('application/x-product-id', product.id);
    e.dataTransfer.effectAllowed = 'move';

    if (typeof document === 'undefined') return;

    const preview = document.createElement('div');
    preview.textContent = product.name || 'Product';
    preview.style.position = 'absolute';
    preview.style.top = '-1000px';
    preview.style.left = '-1000px';
    preview.style.padding = '4px 8px';
    preview.style.maxWidth = '220px';
    preview.style.backgroundColor = '#ffffff';
    preview.style.color = '#1c1917';
    preview.style.borderRadius = '999px';
    preview.style.fontSize = '11px';
    preview.style.fontWeight = '600';
    preview.style.whiteSpace = 'nowrap';
    preview.style.overflow = 'hidden';
    preview.style.textOverflow = 'ellipsis';

    document.body.appendChild(preview);
    const rect = preview.getBoundingClientRect();
    e.dataTransfer.setDragImage(preview, rect.width / 2, rect.height / 2);

    window.setTimeout(() => {
      if (preview.parentNode) {
        preview.parentNode.removeChild(preview);
      }
    }, 0);
  };

  const handleFolderDragStart = (
    e: DragEvent<HTMLDivElement>,
    folder: { id: string; name: string; dbId?: string; parentId?: string | null },
  ) => {
    if (!folder.dbId) return;
    e.dataTransfer.setData('application/x-folder-id', folder.dbId);
    e.dataTransfer.effectAllowed = 'move';
    setIsDraggingFolder(true);
  };

  const handleAssignProductToFolder = async (productId: string, folderId: string) => {
    try {
      const targetCategory = folderId === 'all' ? '' : folderId;
      const res = await authenticatedFetch(
        `/api/inventory/product?id=${encodeURIComponent(productId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: targetCategory }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        // eslint-disable-next-line no-alert
        alert(json.error || 'Failed to move product to folder');
        return;
      }

      const updated = json.data.product as Product;
      setItems((prev) =>
        prev.map((row) =>
          row.product.id === updated.id
            ? { ...row, product: { ...row.product, category: updated.category } }
            : row,
        ),
      );

      const destinationName = folderId === 'all'
        ? 'All items'
        : folders.find((f) => f.id === folderId)?.name || folderId;
      showToast(`Moved to "${destinationName}"`);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Failed to move product to folder');
    }
  };

  const handleMoveFolder = async (folderDbId: string, targetFolderDbId: string | null) => {
    if (!folderDbId || folderDbId === targetFolderDbId) return;

    if (targetFolderDbId) {
      const mapByDbId = new Map<string, { dbId?: string; parentId?: string | null }>();
      customFolders.forEach((f) => {
        if (f.dbId) {
          mapByDbId.set(f.dbId, { dbId: f.dbId, parentId: f.parentId ?? null });
        }
      });

      let current: string | null = targetFolderDbId;
      while (current) {
        if (current === folderDbId) {
          return;
        }
        const node = mapByDbId.get(current);
        if (!node || !node.parentId) break;
        current = node.parentId;
      }
    }

    try {
      const res = await authenticatedFetch('/api/folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: folderDbId, parentId: targetFolderDbId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        // eslint-disable-next-line no-alert
        alert(json.error || 'Failed to move folder');
        return;
      }

      const updated = json.data as { id: string; parentid: string | null };
      setCustomFolders((prev) =>
        prev.map((f) => (f.dbId === updated.id ? { ...f, parentId: updated.parentid } : f)),
      );
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Failed to move folder');
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#f9f9f8] dark:bg-stone-900 overflow-hidden">
      {/* Sticky top section */}
      <div className="flex-none px-3 sm:px-4 lg:px-6 md:pl-0 pt-3 sm:pt-6 pb-3 space-y-3 sm:space-y-4 border-b border-stone-200 dark:border-stone-800 bg-[#f9f9f8] dark:bg-stone-900">
        {/* Header */}
        <div className="flex flex-row items-center justify-between gap-2">
          <div>
            <h1 className="text-xl sm:text-3xl font-bold text-stone-900 dark:text-stone-100">Inventory</h1>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/inventory/import"
              title="Import CSV"
              className="inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="hidden sm:inline">Import CSV</span>
            </a>
            <button
              onClick={exportInventoryCSV}
              disabled={visibleItems.length === 0}
              title="Export CSV"
              className="inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="hidden sm:inline">Export CSV</span>
            </button>
            <button
              onClick={handleRefresh}
              title="Refresh"
              className="inline-flex items-center justify-center w-9 h-9 border border-transparent rounded-md text-white bg-amber-600 hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Global error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Stats - collapsible on mobile when scrolled */}
        <div className={`transition-all duration-300 ease-in-out sm:block ${headerScrolled ? 'max-h-0 overflow-hidden opacity-0 sm:max-h-none sm:overflow-visible sm:opacity-100 -mt-3 sm:mt-0' : 'max-h-56 overflow-visible opacity-100'}`}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 px-0.5 pb-0.5">
              <button
                type="button"
                onClick={() => setStockFilter('all')}
                className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${
                  stockFilter === 'all'
                    ? 'border-amber-600 bg-amber-50 dark:bg-amber-900/20 scale-[1.02]'
                    : 'bg-stone-50 dark:bg-stone-800 border-stone-200 dark:border-stone-700 hover:border-amber-600'
                }`}
              >
                <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">Products</p>
                {loading ? (
                  <div className="h-6 sm:h-7 w-12 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
                ) : (
                  <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">{items.length.toLocaleString()}</p>
                )}
              </button>
              <button
                type="button"
                onClick={() => setStockFilter('onHand')}
                className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${
                  stockFilter === 'onHand'
                    ? 'border-amber-600 bg-amber-50 dark:bg-amber-900/20 scale-[1.02]'
                    : 'bg-stone-50 dark:bg-stone-800 border-stone-200 dark:border-stone-700 hover:border-amber-600'
                }`}
              >
                <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">In Hand</p>
                {loading ? (
                  <div className="h-6 sm:h-7 w-12 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
                ) : (
                  <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">
                    £{items.reduce(
                      (sum, row) => sum + ((row.inventory?.quantityOnHand || 0) * (row.inventory?.averageCostGBP || 0)),
                      0
                    ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                )}
              </button>
              <button
                type="button"
                onClick={() => setStockFilter('inTransit')}
                className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${
                  stockFilter === 'inTransit'
                    ? 'border-amber-600 bg-amber-50 dark:bg-amber-900/20 scale-[1.02]'
                    : 'bg-stone-50 dark:bg-stone-800 border-stone-200 dark:border-stone-700 hover:border-amber-600'
                }`}
              >
                <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">In Transit</p>
                {loading ? (
                  <div className="h-6 sm:h-7 w-12 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
                ) : (
                  <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">
                    £{items.reduce((sum, row) => sum + ((row.quantityInTransit || 0) * (row.inventory?.averageCostGBP || 0)), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                )}
              </button>
              <div className="flex flex-col justify-between bg-stone-50 dark:bg-stone-800 rounded-xl border border-stone-200 dark:border-stone-700 p-3 sm:p-4 text-left shadow-sm">
                <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">Total Value</p>
                {loading ? (
                  <div className="h-6 sm:h-7 w-24 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
                ) : (
                  <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">
                    £{items.reduce(
                      (sum, row) => sum + (((row.inventory?.quantityOnHand || 0) + (row.quantityInTransit || 0)) * (row.inventory?.averageCostGBP || 0)),
                      0
                    ).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                )}
              </div>
        </div>
        </div>

        {/* Toolbar - mobile: search row + controls row; desktop: single row */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* Row 1: Search (full width on mobile) */}
        <div className="flex items-center gap-2 flex-1 sm:flex-none sm:ml-auto sm:order-2">
          <div className="relative flex-1 sm:max-w-xs sm:w-72">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name / SKU"
              className="w-full rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-xs px-3 py-1.5 pr-7 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute inset-y-0 right-2 my-auto inline-flex h-4 w-4 items-center justify-center rounded-full text-[11px] text-stone-500 hover:text-stone-900 hover:bg-stone-100"
                aria-label="Clear search"
              >
                ×
              </button>
            ) : (
              <svg className="absolute inset-y-0 right-2 my-auto h-3.5 w-3.5 text-stone-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
          </div>
          {/* Scanner button - mobile only */}
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-amber-600 text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600 sm:hidden flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h3M4 17h3M17 7h3M17 17h3M9 7h6M9 17h6M7 9v6M17 9v6" />
            </svg>
          </button>
          {/* View toggle + new item - desktop only inline */}
          <div className="hidden sm:inline-flex rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'grid'
                  ? 'bg-amber-600 text-white'
                  : 'text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700'
              }`}
              title="Grid view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'table'
                  ? 'bg-amber-600 text-white'
                  : 'text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700'
              }`}
              title="Table view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            onClick={() => router.push('/inventory/new')}
            className="hidden sm:block px-3 py-1.5 text-xs rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-700 whitespace-nowrap"
          >
            New item
          </button>
        </div>
        {/* Row 2: Breadcrumb + view toggle + new item (mobile) */}
        <div className="flex items-center justify-between gap-2 sm:order-1 sm:flex-shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-stone-500 min-w-0 overflow-hidden">
            {/* Mobile folders button - always visible on mobile */}
            <button
              type="button"
              onClick={() => setMobileFoldersOpen(true)}
              className="md:hidden inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-stone-200 dark:border-stone-700 text-stone-500 hover:bg-stone-50 dark:hover:bg-stone-800 hover:text-stone-700 transition-colors text-[11px] font-medium mr-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Folders
            </button>
            {/* Desktop folders button - only when collapsed */}
            {foldersPanelCollapsed && (
              <button
                type="button"
                onClick={() => setFoldersPanelCollapsed(false)}
                className="hidden md:inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-stone-200 dark:border-stone-700 text-stone-500 hover:bg-stone-50 dark:hover:bg-stone-800 hover:text-stone-700 transition-colors text-[11px] font-medium mr-1"
                title="Show folders"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Folders
              </button>
            )}
            <span className="uppercase tracking-wide text-[10px] text-stone-400 hidden sm:inline">Location</span>
            <span className="text-stone-400 hidden sm:inline">/</span>
            <button
              type="button"
              onClick={() => setActiveFolderId('all')}
              className={`px-2 py-0.5 rounded-md text-xs ${
                activeFolderId === 'all'
                  ? 'bg-amber-600 text-white'
                  : 'text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
              }`}
            >
              All items
            </button>
            {activeFolderPath.map((segment, index) => (
              <span key={segment.id} className="flex items-center gap-1.5 min-w-0">
                <span className="text-stone-400">/</span>
                {index === activeFolderPath.length - 1 ? (
                  <span className="px-2 py-0.5 rounded-md bg-amber-600 text-white font-semibold truncate max-w-[120px]">
                    {segment.name}
                  </span>
                ) : (
                  <span className="text-stone-600 dark:text-stone-400 truncate max-w-[80px]">{segment.name}</span>
                )}
              </span>
            ))}
          </div>
          {/* View toggle + new item - mobile only */}
          <div className="flex items-center gap-1.5 sm:hidden flex-shrink-0">
            <div className="inline-flex rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-0.5">
              <button
                onClick={() => setViewMode('grid')}
                className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-amber-600 text-white'
                    : 'text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700'
                }`}
                title="Grid view"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'table'
                    ? 'bg-amber-600 text-white'
                    : 'text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700'
                }`}
                title="Table view"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              onClick={() => router.push('/inventory/new')}
              className="px-2.5 py-1.5 text-xs rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-700 whitespace-nowrap"
            >
              New item
            </button>
          </div>
        </div>
        </div>{/* end toolbar wrapper */}
      </div>{/* end sticky top */}

      {/* Scrollable content */}
      <div className="flex-1 overflow-hidden w-full">
        <div className="h-full w-full flex gap-0">
          {/* Folders sidebar - hidden on mobile */}
          <div className={`hidden md:block overflow-hidden flex-shrink-0 transition-[width,opacity] duration-300 ease-in-out ${foldersPanelCollapsed ? 'w-0 opacity-0' : 'w-64 opacity-100'}`}>
            <div className="w-64 h-full flex flex-col bg-white dark:bg-stone-900 border-r border-stone-200 dark:border-stone-700">
            {/* Drawer header */}
            <div className="px-3 py-2 border-b border-stone-200 dark:border-stone-700 flex items-center justify-between bg-white dark:bg-stone-900">
              <div className="flex flex-col">
                <span className="text-[11px] font-semibold text-stone-800 dark:text-stone-200 uppercase tracking-wide">
                  Available inventory
                </span>
                <span className="text-[10px] text-stone-400 dark:text-stone-500">Browse locations & folders</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleStartNewFolder}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-200 dark:border-stone-700 text-stone-800 dark:text-stone-200 bg-stone-50 dark:bg-stone-800 hover:bg-amber-50 dark:hover:bg-amber-900/30 text-xs"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setFoldersPanelCollapsed(true)}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-200 dark:border-stone-700 text-stone-400 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 hover:text-stone-600 transition-colors"
                  title="Hide folders"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Folder tree */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden py-2">
              {isCreatingFolder && (
                <div className="px-3 pb-2 flex items-center gap-2">
                  <input
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCreateFolder();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        handleCancelNewFolder();
                      }
                    }}
                    placeholder="New folder name"
                    className="flex-1 rounded-md bg-[#f9f9f8] dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-[11px] text-stone-900 dark:text-stone-100 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-600"
                  />
                  <button
                    type="button"
                    onClick={handleCreateFolder}
                    className="px-2 py-1 text-[11px] rounded-md bg-amber-600 text-white hover:bg-amber-700"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelNewFolder}
                    className="px-1.5 py-1 text-[11px] rounded-md text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
                  >
                    ×
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setActiveFolderId('all')}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverFolderId('all');
                }}
                onDragEnter={() => setDragOverFolderId('all')}
                onDragLeave={() => {
                  setDragOverFolderId((prev) => (prev === 'all' ? null : prev));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const folderDbId = e.dataTransfer.getData('application/x-folder-id');
                  const productId =
                    e.dataTransfer.getData('application/x-product-id') ||
                    e.dataTransfer.getData('text/plain');

                  if (folderDbId) {
                    handleMoveFolder(folderDbId, null);
                  } else if (productId) {
                    handleAssignProductToFolder(productId, 'all');
                  }
                  setDragOverFolderId(null);
                }}
                className={`flex items-center justify-between w-full px-4 py-2.5 text-sm font-medium border-l-2 transition-colors transition-transform duration-150 ${
                  activeFolderId === 'all' || dragOverFolderId === 'all'
                    ? 'border-amber-600 bg-stone-50 dark:bg-stone-800 text-stone-900 dark:text-stone-100 translate-x-0.5'
                    : isDraggingFolder
                      ? 'border-stone-300 bg-stone-50 dark:bg-stone-800 text-stone-900 dark:text-stone-100'
                      : 'border-transparent text-stone-800 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="inline-flex h-5 w-5 items-center justify-center">
                    {/* Folder icon */}
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M4 7.5C4 6.67157 4.67157 6 5.5 6H9l2 2h7.5C19.3284 8 20 8.67157 20 9.5V16.5C20 17.3284 19.3284 18 18.5 18H5.5C4.67157 18 4 17.3284 4 16.5V7.5Z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span>All items</span>
                </span>
                {dragOverFolderId === 'all' ? (
                  <span className="ml-2 text-[10px] text-amber-500">Drop to move folder to top level</span>
                ) : isDraggingFolder ? (
                  <span className="ml-2 text-[10px] text-stone-500">Drag here to move folder to top level</span>
                ) : null}
              </button>

              <div className="mt-1 space-y-0 text-sm">
                {folderTree.length === 0 ? (
                  <p className="text-[11px] text-stone-400 px-4 pt-1">
                    No folders yet. Products will appear here once categories are added.
                  </p>
                ) : (
                  folderTree.map((folder) => {
                    const isCustom = folder.isCustom;
                    const paddingLeft = 20 + folder.depth * 14;
                    const hasChildren = folderTree.some((f) => f.parentId === folder.id);

                    if (hasCollapsedAncestor(folder.id)) {
                      return null;
                    }

                    return (
                      <div
                        key={`${folder.id}-${folder.depth}`}
                        draggable={isCustom}
                        onDragStart={(e) => {
                          if (!isCustom) return;
                          const customFolder = customFolders.find((f) => f.id === folder.id);
                          if (!customFolder) return;
                          handleFolderDragStart(e, customFolder);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          setDragOverFolderId(folder.id);
                        }}
                        onDragEnter={() => setDragOverFolderId(folder.id)}
                        onDragLeave={() => {
                          setDragOverFolderId((prev) => (prev === folder.id ? null : prev));
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const folderDbId = e.dataTransfer.getData('application/x-folder-id');
                          const productId =
                            e.dataTransfer.getData('application/x-product-id') ||
                            e.dataTransfer.getData('text/plain');

                          if (folderDbId && isCustom) {
                            const targetCustom = customFolders.find((f) => f.id === folder.id);
                            if (targetCustom && targetCustom.dbId && targetCustom.dbId !== folderDbId) {
                              handleMoveFolder(folderDbId, targetCustom.dbId);
                            }
                          } else if (productId) {
                            handleAssignProductToFolder(productId, folder.id);
                          }
                          setDragOverFolderId(null);
                          setIsDraggingFolder(false);
                        }}
                        onDragEnd={() => {
                          setDragOverFolderId((prev) => (prev === folder.id ? null : prev));
                          setIsDraggingFolder(false);
                        }}
                        className={`flex items-center justify-between w-full py-2.5 border-l-2 transition-colors transition-transform duration-150 ${
                          activeFolderId === folder.id || dragOverFolderId === folder.id
                            ? 'border-amber-600 bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 translate-x-0.5'
                            : 'border-transparent text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
                        } ${isCustom ? 'cursor-move' : ''}`}
                        style={{ paddingLeft }}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveFolderId(folder.id)}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        >
                          {folder.depth > 0 && (
                            <span
                              className="self-stretch border-l border-stone-200 mr-1"
                              aria-hidden="true"
                            />
                          )}
                          <span className="inline-flex h-5 w-5 items-center justify-center text-stone-600">
                            {/* Nested folder icon */}
                            <svg
                              className="h-4 w-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <path
                                d="M4.5 8.5C4.5 7.67157 5.17157 7 6 7H9.5L11 8.5H18C18.8284 8.5 19.5 9.17157 19.5 10V16C19.5 16.8284 18.8284 17.5 18 17.5H6C5.17157 17.5 4.5 16.8284 4.5 16V8.5Z"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                          <span className="truncate">{folder.name}</span>
                        </button>

                        <div className="flex items-center gap-1 text-[10px] text-stone-600 pr-2">
                          {isCustom && hasChildren && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFolderCollapsed(folder.id);
                              }}
                              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-amber-50 focus:outline-none"
                              aria-label={collapsedFolders[folder.id] ? 'Expand folder' : 'Collapse folder'}
                            >
                              <svg
                                className={`h-3 w-3 transform transition-transform ${
                                  collapsedFolders[folder.id] ? '' : 'rotate-90'
                                }`}
                                viewBox="0 0 20 20"
                                fill="none"
                                xmlns="http://www.w3.org/2000/svg"
                              >
                                <path
                                  d="M7 5L12 10L7 15"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>
                          )}
                          {dragOverFolderId === folder.id && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-500 border border-amber-200">
                              Drop to move here
                            </span>
                          )}
                          {isCustom && (
                            <button
                              type="button"
                              onClick={() => handleDeleteFolder(folder.id)}
                              className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded-full text-xs text-stone-400 hover:text-red-500 hover:bg-red-50"
                              aria-label="Delete folder"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            </div>
          </div>

          {/* Main scrollable content */}
          <div className="flex-1 overflow-y-auto w-full px-3 sm:px-4 lg:px-6 py-4" onScroll={(e) => {
            const el = e.currentTarget;
            setHeaderScrolled(el.scrollTop > 10);
          }}>
            {loading ? (
              <div className="flex items-center justify-center py-24">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-amber-600"></div>
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg p-8 text-center text-sm text-stone-600 dark:text-stone-400">
                No products match this search or folder.
              </div>
            ) : viewMode === 'table' ? (
              <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg overflow-hidden">
                  <table className="w-full divide-y divide-stone-200 dark:divide-stone-700">
                    <thead className="bg-[#f9f9f8] dark:bg-stone-900">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                          Product
                        </th>
                        {foldersPanelCollapsed && (
                          <th className="hidden lg:table-cell px-4 py-3 text-left text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider whitespace-nowrap">
                            SKU
                          </th>
                        )}
                        <th className="px-4 py-3 text-right text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider whitespace-nowrap w-20">
                          In Hand
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider whitespace-nowrap w-20">
                          In Transit
                        </th>
                        {foldersPanelCollapsed && (
                          <th className="hidden lg:table-cell px-4 py-3 text-right text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider whitespace-nowrap w-24">
                            Avg Cost
                          </th>
                        )}
                        <th className="px-4 py-3 text-right text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider w-12">
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                      {visibleItems.map((row) => {
                        return (
                          <tr
                            key={row.product.id}
                            className="hover:border-l-2 hover:border-l-amber-600 dark:hover:bg-stone-700/20 cursor-pointer transition-colors"
                            onClick={() => router.push(`/inventory/${row.product.id}`)}
                          >
                            <td className="px-4 py-3 text-sm text-stone-900 dark:text-stone-100">
                              <div className="flex items-center gap-3">
                                <div className="h-9 w-9 rounded-md bg-gradient-to-br from-stone-100 to-stone-200 dark:from-stone-700 dark:to-stone-600 flex items-center justify-center text-[10px] font-bold text-stone-800 dark:text-stone-200 uppercase flex-shrink-0">
                                  {row.product.name
                                    .split(' ')
                                    .filter(Boolean)
                                    .slice(0, 2)
                                    .map((word) => word[0])
                                    .join('')
                                    .toUpperCase() || 'PR'}
                                </div>
                                <div className="min-w-0">
                                  <div className="font-medium text-stone-900 dark:text-stone-100 truncate">{row.product.name}</div>
                                  {row.supplier?.name && (
                                    <div className="text-xs text-stone-400 dark:text-stone-500">{row.supplier.name}</div>
                                  )}
                                </div>
                              </div>
                            </td>
                            {foldersPanelCollapsed && (
                              <td className="hidden lg:table-cell px-4 py-3 text-sm text-stone-500 dark:text-stone-400 font-mono truncate max-w-[140px]">
                                {row.product.primarySku || row.product.supplierSku || '-'}
                              </td>
                            )}
                            <td className="px-4 py-3 text-sm text-right tabular-nums text-stone-900 dark:text-stone-100 font-medium whitespace-nowrap">
                              {row.inventory?.quantityOnHand || 0}
                            </td>
                            <td className="px-4 py-3 text-sm text-right tabular-nums text-stone-500 dark:text-stone-400 whitespace-nowrap">
                              {row.quantityInTransit || 0}
                            </td>
                            {foldersPanelCollapsed && (
                              <td className="hidden lg:table-cell px-4 py-3 text-sm text-stone-900 dark:text-stone-100 text-right font-mono tabular-nums whitespace-nowrap">
                                £{(row.inventory?.averageCostGBP || 0).toFixed(2)}
                              </td>
                            )}
                            <td className="px-4 py-3 text-sm text-right">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteProduct(row.product);
                                }}
                                disabled={deletingProductId === row.product.id}
                                className="inline-flex items-center justify-center p-1.5 rounded-md text-stone-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-50"
                                aria-label="Delete product"
                              >
                                {deletingProductId === row.product.id ? (
                                  <svg
                                    className="animate-spin h-4 w-4"
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                  >
                                    <circle
                                      className="opacity-25"
                                      cx="12"
                                      cy="12"
                                      r="10"
                                      stroke="currentColor"
                                      strokeWidth="4"
                                    ></circle>
                                    <path
                                      className="opacity-75"
                                      fill="currentColor"
                                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                    ></path>
                                  </svg>
                                ) : (
                                  <svg
                                    className="h-4 w-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                    />
                                  </svg>
                                )}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
              </div>
            ) : (
              <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${
                foldersPanelCollapsed ? 'lg:grid-cols-3 xl:grid-cols-4' : 'xl:grid-cols-3'
              }`}>
                {visibleItems.map((row) => {
                  const onHand = row.inventory?.quantityOnHand || 0;
                  const inTransit = row.quantityInTransit || 0;
                  const initials = row.product.name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'PR';

                  return (
                    <div
                      key={row.product.id}
                      className="group bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg overflow-hidden cursor-pointer hover:border-amber-600 dark:hover:border-amber-600 hover:shadow-sm transition-all duration-200 flex flex-col"
                      onClick={() => router.push(`/inventory/${row.product.id}`)}
                      draggable
                      onDragStart={(e) => handleProductDragStart(e, row.product)}
                    >
                      <div className="h-28 bg-gradient-to-br from-stone-50 to-stone-100 dark:from-stone-700 dark:to-stone-600 flex items-center justify-center border-b border-stone-100 dark:border-stone-700 overflow-hidden">
                        {row.product.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={row.product.imageUrl}
                            alt={row.product.name}
                            className="h-full w-full object-contain p-2"
                          />
                        ) : (
                          <span className="text-2xl font-bold text-stone-300 dark:text-stone-500 uppercase tracking-wider">{initials}</span>
                        )}
                      </div>
                      <div className="p-3 flex flex-col flex-1">
                        <div className="flex items-start justify-between gap-2 flex-1 mb-2">
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-medium text-stone-900 dark:text-stone-100 leading-snug">
                              {row.product.name}
                            </h3>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteProduct(row.product);
                            }}
                            disabled={deletingProductId === row.product.id}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded text-stone-300 hover:text-red-500 hover:bg-red-50 transition-all disabled:opacity-50 flex-shrink-0"
                            aria-label="Delete product"
                          >
                            {deletingProductId === row.product.id ? (
                              <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                            ) : (
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            )}
                          </button>
                        </div>
                        <p className="text-xs text-stone-400 dark:text-stone-500 mt-auto">
                          {row.supplier?.name || 'Unknown supplier'}
                        </p>
                        <div className="flex items-baseline gap-4 pt-2 mt-2 border-t border-stone-100 dark:border-stone-700">
                          <div>
                            <span className="text-sm font-medium text-green-700 tabular-nums">{onHand}</span>
                            <span className="text-[10px] text-green-600 ml-1 uppercase tracking-wide">in hand</span>
                          </div>
                          <div>
                            <span className="text-sm font-medium text-amber-600 tabular-nums">{inTransit}</span>
                            <span className="text-[10px] text-amber-500 ml-1 uppercase tracking-wide">in transit</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 max-w-xs px-3 py-2 rounded-md bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 shadow-lg shadow-stone-200">
          {toastMessage}
        </div>
      )}

      {scannerOpen && (
        <MobileBarcodeScanner
          onScan={handleScannedBarcode}
          onClose={() => setScannerOpen(false)}
        />
      )}

      {/* Mobile folders drawer */}
      <div className={`fixed inset-0 z-50 md:hidden transition-all duration-300 ${mobileFoldersOpen ? 'visible' : 'invisible'}`}>
          {/* Backdrop */}
          <div
            className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ${mobileFoldersOpen ? 'opacity-100' : 'opacity-0'}`}
            onClick={() => setMobileFoldersOpen(false)}
          />
          {/* Drawer */}
          <div className={`absolute inset-y-0 left-0 w-72 flex flex-col bg-white dark:bg-stone-900 shadow-xl transition-transform duration-300 ease-in-out ${mobileFoldersOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {/* Header - same as desktop sidebar */}
            <div className="px-3 py-2 border-b border-stone-200 dark:border-stone-700 flex items-center justify-between bg-white dark:bg-stone-900">
              <div className="flex flex-col">
                <span className="text-[11px] font-semibold text-stone-800 dark:text-stone-200 uppercase tracking-wide">Available inventory</span>
                <span className="text-[10px] text-stone-400 dark:text-stone-500">Browse locations & folders</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleStartNewFolder}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-200 dark:border-stone-700 text-stone-800 dark:text-stone-200 bg-stone-50 dark:bg-stone-800 hover:bg-amber-50 dark:hover:bg-amber-900/30 text-xs"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setMobileFoldersOpen(false)}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-200 dark:border-stone-700 text-stone-400 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 hover:text-stone-600 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              </div>
            </div>
            {/* Folder tree - identical to desktop sidebar */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden py-2">
              {isCreatingFolder && (
                <div className="px-3 pb-2 flex items-center gap-2">
                  <input
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleCreateFolder(); }
                      else if (e.key === 'Escape') { e.preventDefault(); handleCancelNewFolder(); }
                    }}
                    placeholder="New folder name"
                    autoFocus
                    className="flex-1 rounded-md bg-[#f9f9f8] dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-[11px] text-stone-900 dark:text-stone-100 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-600"
                  />
                  <button type="button" onClick={handleCreateFolder} className="px-2 py-1 text-[11px] rounded-md bg-amber-600 text-white hover:bg-amber-700">Save</button>
                  <button type="button" onClick={handleCancelNewFolder} className="px-1.5 py-1 text-[11px] rounded-md text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100">×</button>
                </div>
              )}
              <button
                type="button"
                onClick={() => { setActiveFolderId('all'); setMobileFoldersOpen(false); }}
                className={`flex items-center justify-between w-full px-4 py-2.5 text-sm font-medium border-l-2 transition-colors ${
                  activeFolderId === 'all'
                    ? 'border-amber-600 bg-stone-50 dark:bg-stone-800 text-stone-900 dark:text-stone-100'
                    : 'border-transparent text-stone-800 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800'
                }`}
              >
                <span className="flex items-center gap-2">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <path d="M4 7.5C4 6.67157 4.67157 6 5.5 6H9l2 2h7.5C19.3284 8 20 8.67157 20 9.5V16.5C20 17.3284 19.3284 18 18.5 18H5.5C4.67157 18 4 17.3284 4 16.5V7.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  All items
                </span>
              </button>
              <div className="mt-1 space-y-0 text-sm">
                {folderTree.length === 0 ? (
                  <p className="text-[11px] text-stone-400 px-4 pt-1">No folders yet.</p>
                ) : (
                  folderTree.map((folder) => {
                    if (hasCollapsedAncestor(folder.id)) return null;
                    const isCustom = folder.isCustom;
                    const paddingLeft = 20 + folder.depth * 14;
                    const hasChildren = folderTree.some((f) => f.parentId === folder.id);
                    return (
                      <div
                        key={`mobile-${folder.id}-${folder.depth}`}
                        className={`flex items-center justify-between w-full py-2.5 border-l-2 transition-colors ${
                          activeFolderId === folder.id
                            ? 'border-amber-600 bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100'
                            : 'border-transparent text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
                        }`}
                        style={{ paddingLeft }}
                      >
                        <button
                          type="button"
                          onClick={() => { setActiveFolderId(folder.id); setMobileFoldersOpen(false); }}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        >
                          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                            <path d="M4.5 8.5C4.5 7.67157 5.17157 7 6 7H9.5L11 8.5H18C18.8284 8.5 19.5 9.17157 19.5 10V16C19.5 16.8284 18.8284 17.5 18 17.5H6C5.17157 17.5 4.5 16.8284 4.5 16V8.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="truncate">{folder.name}</span>
                        </button>
                        <div className="flex items-center gap-1 pr-2">
                          {isCustom && hasChildren && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); toggleFolderCollapsed(folder.id); }} className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-amber-50">
                              <svg className={`h-3 w-3 transform transition-transform ${collapsedFolders[folder.id] ? '' : 'rotate-90'}`} viewBox="0 0 20 20" fill="none">
                                <path d="M7 5L12 10L7 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          )}
                          {isCustom && (
                            <button type="button" onClick={() => handleDeleteFolder(folder.id)} className="inline-flex items-center justify-center h-5 w-5 rounded-full text-xs text-stone-400 hover:text-red-500 hover:bg-red-50">×</button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
    </div>
  );
}
