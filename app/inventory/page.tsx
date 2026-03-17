'use client';

import { useEffect, useMemo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { authenticatedFetch } from '@/lib/api-client';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import ConfirmDialog from '@/components/ConfirmDialog';

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
  folderId: string | null;
  category: string | null;
  tags: string[];
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FolderEntry {
  id: string;
  name: string;
  parentId: string | null;
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

type ConfirmState =
  | { type: 'none' }
  | { type: 'deleteProduct'; product: Product }
  | { type: 'deleteFolder'; folderId: string; folderName: string };

type FolderMenuState =
  | { open: false }
  | { open: true; folderId: string; x: number; y: number };

type CanvasMenuState =
  | { open: false }
  | { open: true; x: number; y: number; parentId: string | null };

type ProductMenuState =
  | { open: false }
  | { open: true; product: Product; x: number; y: number };

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
  const [stockFilter, setStockFilter] = useState<'all' | 'onHand' | 'inTransit' | 'zeroStock'>('all');
  const [sortBy, setSortBy] = useState<'nameAsc' | 'nameDesc' | 'onHandDesc' | 'inTransitDesc' | 'newest'>('newest');
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
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState>({ type: 'none' });

  const [customFolders, setCustomFolders] = useState<
    FolderEntry[]
  >([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState>({ open: false });
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenuState>({ open: false });
  const [productMenu, setProductMenu] = useState<ProductMenuState>({ open: false });
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState('');
  const [renamingFolderLoading, setRenamingFolderLoading] = useState(false);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [headerScrolled, setHeaderScrolled] = useState(false);
  const [syncingShopify, setSyncingShopify] = useState(false);

  useEffect(() => {
    const closeAll = () => {
      setFolderMenu({ open: false });
      setCanvasMenu({ open: false });
      setProductMenu({ open: false });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAll();
      }
    };

    const handleGlobalContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Always close any active custom menus on right-click to ensure state is clean
      // We do this via the setters below.

      // EXCLUSIONS (Where we want the BROWSER'S default menu):
      // 1. Inputs and editable areas
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('input') ||
        target.closest('textarea')
      ) {
        closeAll();
        return;
      }

      // 2. UI Shell Elements (Sidebar, etc.) - If outside main, let browser menu show
      if (!target.closest('main')) {
        closeAll();
        return;
      }

      // 3. Custom Entries (Products/Folders) - They have their own reactive handlers with stopPropagation.
      // If the event reaches this global window listener, it's either a gap or was unhandled.
      if (
        target.closest('[data-folder-entry="true"]') ||
        target.closest('[data-product-entry="true"]')
      ) {
        // We close any open canvas menu, but don't prevent default here as the 
        // specialized handler should have already done it.
        if (!target.closest('[role="menu"]')) {
           setCanvasMenu({ open: false });
        }
        return;
      }

      // 4. Clicking ON the custom menu itself - Prevent browser menu, don't move anything
      if (target.closest('[role="menu"]') || target.closest('.fixed.z-50')) {
        e.preventDefault();
        return;
      }

      // If we got here, it's a click on the "canvas" background, header, or gap
      e.preventDefault();
      
      const x = e.clientX;
      const y = e.clientY;

      setFolderMenu({ open: false });
      setProductMenu({ open: false });
      setCanvasMenu({
        open: true,
        x,
        y,
        parentId: activeFolderId === 'all' ? null : activeFolderId,
      });
    };

    window.addEventListener('click', closeAll);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('contextmenu', handleGlobalContextMenu);

    return () => {
      window.removeEventListener('click', closeAll);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('contextmenu', handleGlobalContextMenu);
    };
  }, [activeFolderId]);

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
            id: f.id,
            name: f.name,
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

  const foldersById = useMemo(
    () => new Map(customFolders.map((folder) => [folder.id, folder])),
    [customFolders],
  );

  const folderTree = useMemo(
    () => {
      type TreeNode = {
        id: string;
        name: string;
        depth: number;
        parentId: string | null;
      };

      const childrenByParent = new Map<string | null, FolderEntry[]>();
      customFolders.forEach((folder) => {
        const key = folder.parentId ?? null;
        const arr = childrenByParent.get(key) ?? [];
        arr.push(folder);
        childrenByParent.set(key, arr);
      });

      const result: TreeNode[] = [];
      const visited = new Set<string>();

      const visit = (folder: FolderEntry, depth: number) => {
        if (visited.has(folder.id)) return;
        visited.add(folder.id);

        result.push({
          id: folder.id,
          name: folder.name,
          depth,
          parentId: folder.parentId,
        });

        const children = (childrenByParent.get(folder.id) ?? []).slice();
        children.sort((a, b) => a.name.localeCompare(b.name));
        children.forEach((child) => visit(child, depth + 1));
      };

      const roots = (childrenByParent.get(null) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      roots.forEach((root) => visit(root, 0));

      customFolders
        .filter((folder) => !visited.has(folder.id))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((folder) => visit(folder, 0));

      return result;
    },
    [customFolders],
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
        const folder = foldersById.get(currentId);
        if (!folder) break;

        path.unshift({ id: folder.id, name: folder.name });

        const parentId: string | null = folderParentById.get(currentId) ?? null;
        if (!parentId || parentId === currentId) break;
        currentId = parentId;
      }

      return path;
    },
    [activeFolderId, foldersById, folderParentById],
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
      let visible = [...filteredItems];

      if (stockFilter === 'onHand') {
        visible = visible.filter((row) => {
          const onHand = row.inventory?.quantityOnHand ?? 0;
          return onHand > 0;
        });
      } else if (stockFilter === 'inTransit') {
        visible = visible.filter((row) => {
          const inTransit = row.quantityInTransit ?? 0;
          return inTransit > 0;
        });
      } else if (stockFilter === 'zeroStock') {
        visible = visible.filter((row) => {
          const onHand = row.inventory?.quantityOnHand ?? 0;
          const inTransit = row.quantityInTransit ?? 0;
          return onHand <= 0 && inTransit <= 0;
        });
      }

      visible = visible.filter((row) =>
        activeFolderId === 'all'
          ? !row.product.folderId
          : row.product.folderId === activeFolderId,
      );

      visible.sort((a, b) => {
        switch (sortBy) {
          case 'nameDesc':
            return b.product.name.localeCompare(a.product.name);
          case 'onHandDesc':
            return (b.inventory?.quantityOnHand ?? 0) - (a.inventory?.quantityOnHand ?? 0)
              || a.product.name.localeCompare(b.product.name);
          case 'inTransitDesc':
            return (b.quantityInTransit ?? 0) - (a.quantityInTransit ?? 0)
              || a.product.name.localeCompare(b.product.name);
          case 'newest':
            return new Date(b.product.updatedAt).getTime() - new Date(a.product.updatedAt).getTime();
          case 'nameAsc':
          default:
            return a.product.name.localeCompare(b.product.name);
        }
      });

      return visible;
    },
    [filteredItems, activeFolderId, sortBy, stockFilter],
  );

  const childFolders = useMemo(
    () =>
      customFolders
        .filter((folder) => (activeFolderId === 'all' ? folder.parentId === null : folder.parentId === activeFolderId))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [activeFolderId, customFolders],
  );

  const currentFolderName = activeFolderId === 'all'
    ? 'My Drive'
    : foldersById.get(activeFolderId)?.name ?? 'Folder';

  const hasVisibleContent = childFolders.length > 0 || visibleItems.length > 0;

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

  const handleShopifySync = async () => {
    try {
      setSyncingShopify(true);
      setError(null);
      const res = await authenticatedFetch('/api/inventory/shopify-sync', {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to sync with Shopify. Make sure it is connected in Account settings.');
      }
      showToast(json.message || 'Shopify sync complete');
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync with Shopify');
    } finally {
      setSyncingShopify(false);
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

  const runDeleteProduct = async (product: Product) => {
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
      setConfirmState((current) =>
        current.type === 'deleteProduct' && current.product.id === product.id
          ? { type: 'none' }
          : current,
      );
    }
  };

  const handleDeleteProduct = (product: Product) => {
    setConfirmState({ type: 'deleteProduct', product });
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
    const parentId = activeFolderId === 'all' ? null : activeFolderId;
    setCreateFolderParentId(parentId);
    setIsCreatingFolder(true);
    setNewFolderName('');
    setFolderMenu({ open: false });
  };

  const handleStartChildFolder = (folderId: string) => {
    setCreateFolderParentId(folderId);
    setIsCreatingFolder(true);
    setNewFolderName('');
    setFolderMenu({ open: false });
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
        id: folder.id,
        name: folder.name,
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

  const runDeleteFolder = async (folderId: string) => {
    const folder = customFolders.find((f) => f.id === folderId);
    if (!folder) return;

    try {
      setDeletingFolderId(folderId);
      const res = await authenticatedFetch(
        `/api/folders?id=${encodeURIComponent(folderId)}`,
        {
          method: 'DELETE',
        },
      );
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || json?.success === false) {
        alert(json?.error || 'Failed to delete folder');
        return;
      }

      setCustomFolders((prev) => prev.filter((f) => f.id !== folderId && f.parentId !== folderId));
      if (activeFolderId === folderId || activeFolderPath.some((segment) => segment.id === folderId)) {
        setActiveFolderId('all');
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Failed to delete folder');
    } finally {
      setDeletingFolderId(null);
      setConfirmState((current) =>
        current.type === 'deleteFolder' && current.folderId === folderId
          ? { type: 'none' }
          : current,
      );
    }
  };

  const handleDeleteFolder = (folderId: string) => {
    const folder = customFolders.find((f) => f.id === folderId);
    if (!folder) return;
    setFolderMenu({ open: false });
    setConfirmState({ type: 'deleteFolder', folderId, folderName: folder.name });
  };

  const handleStartRenameFolder = (folderId: string) => {
    const folder = customFolders.find((entry) => entry.id === folderId);
    if (!folder) return;
    setFolderMenu({ open: false });
    setRenamingFolderId(folderId);
    setRenamingFolderName(folder.name);
  };

  const handleCancelRenameFolder = () => {
    setRenamingFolderId(null);
    setRenamingFolderName('');
    setRenamingFolderLoading(false);
  };

  const handleSubmitRenameFolder = async () => {
    if (!renamingFolderId) return;
    const name = renamingFolderName.trim();
    if (!name) return;

    try {
      setRenamingFolderLoading(true);
      const res = await authenticatedFetch('/api/folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: renamingFolderId, name }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(json.error || 'Failed to rename folder');
        return;
      }

      setCustomFolders((prev) =>
        prev.map((folder) => (folder.id === renamingFolderId ? { ...folder, name } : folder)),
      );
      handleCancelRenameFolder();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to rename folder');
    } finally {
      setRenamingFolderLoading(false);
    }
  };

  const openFolderMenu = (folderId: string, x: number, y: number) => {
    setCanvasMenu({ open: false });
    setProductMenu({ open: false });
    setFolderMenu({ open: true, folderId, x, y });
  };

  const handleFolderContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    folderId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openFolderMenu(folderId, event.clientX, event.clientY);
  };

  const handleFolderMenuButton = (
    event: ReactMouseEvent<HTMLElement>,
    folderId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openFolderMenu(folderId, Math.max(12, rect.right - 180), rect.bottom + 8);
  };

  const openCanvasMenu = (x: number, y: number, parentId: string | null) => {
    setFolderMenu({ open: false });
    setProductMenu({ open: false });
    setCanvasMenu({ open: true, x, y, parentId });
  };

  const handleCanvasContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    // Preserve standard browser context menu for inputs
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      target.closest('input') ||
      target.closest('textarea')
    ) {
      return;
    }

    event.preventDefault();
    if (target.closest('[data-folder-entry="true"]') || target.closest('[data-product-entry="true"]')) return;
    openCanvasMenu(event.clientX, event.clientY, activeFolderId === 'all' ? null : activeFolderId);
  };

  const openProductMenu = (product: Product, x: number, y: number) => {
    setFolderMenu({ open: false });
    setCanvasMenu({ open: false });
    setProductMenu({ open: true, product, x, y });
  };

  const handleProductContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    product: Product,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openProductMenu(product, event.clientX, event.clientY);
  };

  const handleProductMenuButton = (
    event: ReactMouseEvent<HTMLElement>,
    product: Product,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openProductMenu(product, Math.max(12, rect.right - 220), rect.bottom + 8);
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
    folder: FolderEntry,
  ) => {
    e.dataTransfer.setData('application/x-folder-id', folder.id);
    e.dataTransfer.effectAllowed = 'move';
    setIsDraggingFolder(true);
  };

  const handleAssignProductToFolder = async (productId: string, folderId: string) => {
    try {
      const targetFolderId = folderId === 'all' ? null : folderId;
      const res = await authenticatedFetch(
        `/api/inventory/product?id=${encodeURIComponent(productId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId: targetFolderId }),
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
            ? { ...row, product: { ...row.product, folderId: updated.folderId ?? null } }
            : row,
        ),
      );

      const destinationName = folderId === 'all'
        ? 'My Drive'
        : foldersById.get(folderId)?.name || folderId;
      showToast(`Moved to "${destinationName}"`);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Failed to move product to folder');
    }
  };

  const handleMoveFolder = async (folderDbId: string, targetFolderDbId: string | null) => {
    if (!folderDbId || folderDbId === targetFolderDbId) return;

    if (targetFolderDbId) {
      const mapByDbId = new Map<string, { parentId?: string | null }>();
      customFolders.forEach((f) => {
        mapByDbId.set(f.id, { parentId: f.parentId ?? null });
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
        prev.map((f) => (f.id === updated.id ? { ...f, parentId: updated.parentid } : f)),
      );
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Failed to move folder');
    }
  };

  const confirmDialogOpen = confirmState.type !== 'none';
  const confirmDialogTitle =
    confirmState.type === 'deleteProduct' ? 'Move product to bin?' : 'Delete folder?';
  const confirmDialogMessage =
    confirmState.type === 'deleteProduct'
      ? `Move "${confirmState.product.name}" to bin? You can empty it permanently from the bin page.`
      : confirmState.type === 'deleteFolder'
        ? `Delete "${confirmState.folderName}"? This cannot be undone.`
        : '';
  const confirmDialogLoading =
    confirmState.type === 'deleteProduct'
      ? deletingProductId === confirmState.product.id
      : confirmState.type === 'deleteFolder'
        ? deletingFolderId === confirmState.folderId
        : false;

  const handleConfirmDialogConfirm = () => {
    if (confirmState.type === 'deleteProduct') {
      void runDeleteProduct(confirmState.product);
      return;
    }
    if (confirmState.type === 'deleteFolder') {
      void runDeleteFolder(confirmState.folderId);
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
            <Link
              href="/inventory/import"
              title="Import CSV"
              className="inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="hidden sm:inline">Import CSV</span>
            </Link>
            <Link
              href="/inventory/shopify-sync"
              title="Sync Shopify Catalog & Inventory"
              className="inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors"
            >
              <img src="/Shopify_icon.svg" className="w-4 h-4 flex-shrink-0" alt="Shopify" />
              <span className="hidden sm:inline">Sync Shopify</span>
            </Link>
            <Link
              href="/inventory/bin"
              title="Open bin"
              className="inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12m-9 0V5.75c0-.41.34-.75.75-.75h4.5c.41 0 .75.34.75.75V7m-7 0v10.25c0 .41.34.75.75.75h6.5c.41 0 .75-.34.75-.75V7M10 10.5v4M14 10.5v4" />
              </svg>
              <span className="hidden sm:inline">Bin</span>
            </Link>
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
              className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${stockFilter === 'all'
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
              className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${stockFilter === 'onHand'
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
              className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${stockFilter === 'inTransit'
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
            <select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as 'all' | 'onHand' | 'inTransit' | 'zeroStock')}
              className="hidden sm:block rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-xs px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-600"
            >
              <option value="all">All stock</option>
              <option value="onHand">In hand only</option>
              <option value="inTransit">In transit only</option>
              <option value="zeroStock">Zero stock only</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'nameAsc' | 'nameDesc' | 'onHandDesc' | 'inTransitDesc' | 'newest')}
              className="hidden sm:block rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-xs px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-600"
            >
              <option value="newest">Sort: Recently added</option>
              <option value="nameAsc">Sort: Name A-Z</option>
              <option value="nameDesc">Sort: Name Z-A</option>
              <option value="onHandDesc">Sort: Most in hand</option>
              <option value="inTransitDesc">Sort: Most in transit</option>
            </select>
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
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'grid'
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
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'table'
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
          {/* Row 2: Breadcrumb (mobile stacks above controls) */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:order-1 sm:flex-shrink-0">
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
              <span className="uppercase tracking-wide text-[10px] text-stone-400 hidden sm:inline">Path</span>
              <span className="text-stone-400 hidden sm:inline">/</span>
              <button
                type="button"
                onClick={() => setActiveFolderId('all')}
                className={`px-2 py-0.5 rounded-md text-xs ${activeFolderId === 'all'
                  ? 'bg-amber-600 text-white'
                  : 'text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
                  }`}
              >
                My Drive
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
            {/* Mobile controls row */}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5 sm:hidden">
              <select
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value as 'all' | 'onHand' | 'inTransit' | 'zeroStock')}
                className="min-w-0 w-full rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-[11px] px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-600"
              >
                <option value="all">All</option>
                <option value="onHand">In hand</option>
                <option value="inTransit">Transit</option>
                <option value="zeroStock">Zero</option>
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'nameAsc' | 'nameDesc' | 'onHandDesc' | 'inTransitDesc' | 'newest')}
                className="min-w-0 w-full rounded-md bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-[11px] px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-600"
              >
                <option value="newest">Newest</option>
                <option value="nameAsc">A-Z</option>
                <option value="nameDesc">Z-A</option>
                <option value="onHandDesc">In hand</option>
                <option value="inTransitDesc">Transit</option>
              </select>
              <div className="inline-flex rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-0.5">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'grid'
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
                  className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'table'
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
                className="col-span-full w-full px-2.5 py-1.5 text-xs rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-700"
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
                  <span className="text-[10px] text-stone-400 dark:text-stone-500">Browse your folder tree</span>
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
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openCanvasMenu(event.clientX, event.clientY, null);
                  }}
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
                  className={`flex items-center justify-between w-full px-4 py-2.5 text-sm font-medium border-l-2 transition-colors transition-transform duration-150 ${activeFolderId === 'all' || dragOverFolderId === 'all'
                    ? 'border-amber-600 bg-stone-50 dark:bg-stone-800 text-stone-900 dark:text-stone-100 translate-x-0.5'
                    : isDraggingFolder
                      ? 'border-stone-300 bg-stone-50 dark:bg-stone-800 text-stone-900 dark:text-stone-100'
                      : 'border-transparent text-stone-800 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800'
                    }`}
                  data-folder-entry="true"
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
                    <span>My Drive</span>
                  </span>
                  {dragOverFolderId === 'all' ? (
                    <span className="ml-2 text-[10px] text-amber-500">Drop to move folder to top level</span>
                  ) : isDraggingFolder ? (
                    <span className="ml-2 text-[10px] text-stone-500">Drag here to move folder to top level</span>
                  ) : null}
                </button>

                <Link
                  href="/inventory/bin"
                  className="mt-1 flex items-center justify-between w-full px-4 py-2.5 text-sm font-medium border-l-2 border-transparent text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800"
                >
                  <span className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 items-center justify-center">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M6 7h12m-9 0V5.75c0-.41.34-.75.75-.75h4.5c.41 0 .75.34.75.75V7m-7 0v10.25c0 .41.34.75.75.75h6.5c.41 0 .75-.34.75-.75V7M10 10.5v4M14 10.5v4" />
                      </svg>
                    </span>
                    <span>Bin</span>
                  </span>
                </Link>

                <div className="mt-1 space-y-0 text-sm">
                  {folderTree.length === 0 ? (
                    <p className="text-[11px] text-stone-400 px-4 pt-1">
                      No folders yet. Create one to start building the explorer.
                    </p>
                  ) : (
                    folderTree.map((folder) => {
                      const paddingLeft = 20 + folder.depth * 14;
                      const hasChildren = folderTree.some((f) => f.parentId === folder.id);

                      if (hasCollapsedAncestor(folder.id)) {
                        return null;
                      }

                      return (
                        <div
                          key={`${folder.id}-${folder.depth}`}
                          draggable
                          data-folder-entry="true"
                          onContextMenu={(event) => handleFolderContextMenu(event, folder.id)}
                          onDragStart={(e) => {
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

                            if (folderDbId) {
                              const targetCustom = customFolders.find((f) => f.id === folder.id);
                              if (targetCustom && targetCustom.id !== folderDbId) {
                                handleMoveFolder(folderDbId, targetCustom.id);
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
                          className={`flex items-center justify-between w-full py-2.5 border-l-2 transition-colors transition-transform duration-150 ${activeFolderId === folder.id || dragOverFolderId === folder.id
                            ? 'border-amber-600 bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 translate-x-0.5'
                            : 'border-transparent text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
                            } cursor-move`}
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
                            {hasChildren && (
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
                                  className={`h-3 w-3 transform transition-transform ${collapsedFolders[folder.id] ? '' : 'rotate-90'
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
                            {(
                              <button
                                type="button"
                                onClick={(event) => handleFolderMenuButton(event, folder.id)}
                                disabled={deletingFolderId === folder.id}
                                className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded-full text-xs text-stone-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-50"
                                aria-label="Folder actions"
                              >
                                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
                                </svg>
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
          <div 
            className="flex-1 overflow-y-auto w-full px-3 sm:px-4 lg:px-6 py-4" 
            onScroll={(e) => {
              const el = e.currentTarget;
              setHeaderScrolled(el.scrollTop > 10);
            }}
          >
            {loading ? (
              <div className="flex items-center justify-center py-24">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-amber-600"></div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">{currentFolderName}</h2>
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      {childFolders.length} folders, {visibleItems.length} products
                    </p>
                  </div>
                </div>

                {childFolders.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {childFolders.map((folder) => {
                      const nestedCount = customFolders.filter((entry) => entry.parentId === folder.id).length;
                      const productCount = items.filter((row) => row.product.folderId === folder.id).length;

                      return (
                        <div
                          key={folder.id}
                          data-folder-entry="true"
                          onClick={() => setActiveFolderId(folder.id)}
                          onContextMenu={(event) => handleFolderContextMenu(event, folder.id)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            setDragOverFolderId(folder.id);
                          }}
                          onDragLeave={() => {
                            setDragOverFolderId((prev) => (prev === folder.id ? null : prev));
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const folderDbId = e.dataTransfer.getData('application/x-folder-id');
                            const productId =
                              e.dataTransfer.getData('application/x-product-id') ||
                              e.dataTransfer.getData('text/plain');

                            if (folderDbId && folderDbId !== folder.id) {
                              handleMoveFolder(folderDbId, folder.id);
                            } else if (productId) {
                              handleAssignProductToFolder(productId, folder.id);
                            }
                            setDragOverFolderId(null);
                            setIsDraggingFolder(false);
                          }}
                          className={`group flex items-start gap-3 rounded-2xl border p-4 text-left transition-all ${dragOverFolderId === folder.id
                            ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 shadow-sm'
                            : 'border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 hover:border-amber-400 hover:shadow-sm'
                            } cursor-pointer`}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setActiveFolderId(folder.id);
                            }
                          }}
                        >
                          <span className="mt-0.5 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-stone-100 dark:bg-stone-700 text-stone-700 dark:text-stone-200">
                            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none">
                              <path d="M4.5 8.5C4.5 7.67157 5.17157 7 6 7H9.5L11 8.5H18C18.8284 8.5 19.5 9.17157 19.5 10V16C19.5 16.8284 18.8284 17.5 18 17.5H6C5.17157 17.5 4.5 16.8284 4.5 16V8.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-stone-900 dark:text-stone-100">{folder.name}</span>
                            <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">
                              {nestedCount} folders • {productCount} products
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={(event) => handleFolderMenuButton(event, folder.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-700 dark:hover:text-stone-200"
                            aria-label={`Folder actions for ${folder.name}`}
                          >
                            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!hasVisibleContent ? (
                  <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg p-8 text-center text-sm text-stone-600 dark:text-stone-400">
                    This folder is empty.
                  </div>
                ) : visibleItems.length === 0 ? null : viewMode === 'table' ? (
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
                          data-product-entry="true"
                          className="hover:border-l-2 hover:border-l-amber-600 dark:hover:bg-stone-700/20 cursor-pointer transition-colors"
                          onContextMenu={(event) => handleProductContextMenu(event, row.product)}
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
                                handleProductMenuButton(e, row.product);
                              }}
                              disabled={deletingProductId === row.product.id}
                              className="inline-flex items-center justify-center p-1.5 rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                              aria-label="Item actions"
                            >
                              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${foldersPanelCollapsed ? 'lg:grid-cols-3 xl:grid-cols-4' : 'xl:grid-cols-3'
                }`}>
                {visibleItems.map((row) => {
                  const onHand = row.inventory?.quantityOnHand || 0;
                  const inTransit = row.quantityInTransit || 0;
                  const initials = row.product.name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'PR';

                  return (
                    <div
                      key={row.product.id}
                      data-product-entry="true"
                      className="group bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg overflow-hidden cursor-pointer hover:border-amber-600 dark:hover:border-amber-600 hover:shadow-sm transition-all duration-200 flex flex-col"
                      onContextMenu={(event) => handleProductContextMenu(event, row.product)}
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
                              handleProductMenuButton(e, row.product);
                            }}
                            disabled={deletingProductId === row.product.id}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded text-stone-300 hover:text-stone-700 hover:bg-stone-100 transition-all disabled:opacity-50 flex-shrink-0"
                            aria-label="Item actions"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
                            </svg>
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
            )}
          </div>
        </div>
      </div>

      {folderMenu.open && (
        <div
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-md border border-stone-200 bg-white py-1 shadow-2xl shadow-stone-300/30 dark:border-stone-700 dark:bg-stone-800 dark:shadow-black/30"
          style={{ left: folderMenu.x, top: folderMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setActiveFolderId(folderMenu.folderId);
              setMobileFoldersOpen(false);
              setFolderMenu({ open: false });
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4.5 8.5C4.5 7.67 5.17 7 6 7h3.5L11 8.5H18c.83 0 1.5.67 1.5 1.5V16c0 .83-.67 1.5-1.5 1.5H6A1.5 1.5 0 0 1 4.5 16V8.5Z" />
            </svg>
            Open folder
          </button>
          <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
          <button
            type="button"
            onClick={() => handleStartRenameFolder(folderMenu.folderId)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m4 20 4.5-1 9-9a1.75 1.75 0 0 0-2.47-2.47l-9 9L4 20Z" />
            </svg>
            Rename
          </button>
          <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
          <button
            type="button"
            onClick={() => {
              setCreateFolderParentId(folderMenu.folderId);
              setIsCreatingFolder(true);
              setNewFolderName('');
              setFolderMenu({ open: false });
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 5v14M5 12h14" />
            </svg>
            New folder inside
          </button>
          <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
          <button
            type="button"
            onClick={() => handleDeleteFolder(folderMenu.folderId)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 7h12m-9 0V5.75c0-.41.34-.75.75-.75h4.5c.41 0 .75.34.75.75V7m-7 0v10.25c0 .41.34.75.75.75h6.5c.41 0 .75-.34.75-.75V7M10 10.5v4M14 10.5v4" />
            </svg>
            Delete folder
          </button>
        </div>
      )}

      {canvasMenu.open && (
        <div
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-md border border-stone-200 bg-white py-1 shadow-2xl shadow-stone-300/30 dark:border-stone-700 dark:bg-stone-800 dark:shadow-black/30"
          style={{ left: canvasMenu.x, top: canvasMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setCreateFolderParentId(canvasMenu.parentId);
              setIsCreatingFolder(true);
              setNewFolderName('');
              setCanvasMenu({ open: false });
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 5v14M5 12h14" />
            </svg>
            New folder here
          </button>
          <button
            type="button"
            onClick={() => {
              setCanvasMenu({ open: false });
              router.push('/inventory/new');
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 6.75h8A1.25 1.25 0 0 1 17.25 8v8A1.25 1.25 0 0 1 16 17.25H8A1.25 1.25 0 0 1 6.75 16V8A1.25 1.25 0 0 1 8 6.75Z" />
            </svg>
            New item
          </button>
          <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
          <button
            type="button"
            onClick={() => {
              setCanvasMenu({ open: false });
              void handleRefresh();
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4.5 12a7.5 7.5 0 0 1 12.78-5.3M19.5 12a7.5 7.5 0 0 1-12.78 5.3M17.25 4.5v3.75H13.5m-3 7.5H6.75V19.5h3.75" />
            </svg>
            Refresh
          </button>
        </div>
      )}

      {productMenu.open && (
        <div
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-md border border-stone-200 bg-white py-1 shadow-2xl shadow-stone-300/30 dark:border-stone-700 dark:bg-stone-800 dark:shadow-black/30"
          style={{ left: productMenu.x, top: productMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              router.push(`/inventory/${productMenu.product.id}`);
              setProductMenu({ open: false });
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 6.75h8A1.25 1.25 0 0 1 17.25 8v8A1.25 1.25 0 0 1 16 17.25H8A1.25 1.25 0 0 1 6.75 16V8A1.25 1.25 0 0 1 8 6.75Z" />
            </svg>
            Open
          </button>
          <button
            type="button"
            onClick={() => {
              void handleAssignProductToFolder(productMenu.product.id, 'all');
              setProductMenu({ open: false });
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4.5 8.5C4.5 7.67 5.17 7 6 7h3.5L11 8.5H18c.83 0 1.5.67 1.5 1.5V16c0 .83-.67 1.5-1.5 1.5H6A1.5 1.5 0 0 1 4.5 16V8.5Z" />
            </svg>
            Move to My Drive
          </button>
          <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
          <button
            type="button"
            onClick={() => {
              setCreateFolderParentId(activeFolderId === 'all' ? null : activeFolderId);
              setIsCreatingFolder(true);
              setNewFolderName('');
              setProductMenu({ open: false });
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 5v14M5 12h14" />
            </svg>
            New folder here
          </button>
          <button
            type="button"
            onClick={() => {
              setProductMenu({ open: false });
              router.push('/inventory/new');
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-700"
          >
            <svg className="h-4 w-4 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 6.75h8A1.25 1.25 0 0 1 17.25 8v8A1.25 1.25 0 0 1 16 17.25H8A1.25 1.25 0 0 1 6.75 16V8A1.25 1.25 0 0 1 8 6.75Z" />
            </svg>
            New item
          </button>
          <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
          <button
            type="button"
            onClick={() => {
              handleDeleteProduct(productMenu.product);
              setProductMenu({ open: false });
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 7h12m-9 0V5.75c0-.41.34-.75.75-.75h4.5c.41 0 .75.34.75.75V7m-7 0v10.25c0 .41.34.75.75.75h6.5c.41 0 .75-.34.75-.75V7M10 10.5v4M14 10.5v4" />
            </svg>
            Move to bin
          </button>
        </div>
      )}

      {renamingFolderId && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-24" onClick={handleCancelRenameFolder}>
          <div
            className="w-full max-w-md rounded-xl border border-stone-200 bg-white p-4 shadow-2xl dark:border-stone-700 dark:bg-stone-800"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">Rename folder</p>
            <input
              value={renamingFolderName}
              onChange={(event) => setRenamingFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleSubmitRenameFolder();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  handleCancelRenameFolder();
                }
              }}
              autoFocus
              className="mt-3 w-full rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-amber-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelRenameFolder}
                className="rounded-md px-3 py-2 text-sm text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitRenameFolder()}
                disabled={renamingFolderLoading || !renamingFolderName.trim()}
                className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {renamingFolderLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

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
              <span className="text-[10px] text-stone-400 dark:text-stone-500">Browse your folder tree</span>
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
              onContextMenu={(event) => {
                event.preventDefault();
                openCanvasMenu(event.clientX, event.clientY, null);
              }}
              className={`flex items-center justify-between w-full px-4 py-2.5 text-sm font-medium border-l-2 transition-colors ${activeFolderId === 'all'
                ? 'border-amber-600 bg-stone-50 dark:bg-stone-800 text-stone-900 dark:text-stone-100'
                : 'border-transparent text-stone-800 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800'
                }`}
              data-folder-entry="true"
            >
              <span className="flex items-center gap-2">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <path d="M4 7.5C4 6.67157 4.67157 6 5.5 6H9l2 2h7.5C19.3284 8 20 8.67157 20 9.5V16.5C20 17.3284 19.3284 18 18.5 18H5.5C4.67157 18 4 17.3284 4 16.5V7.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                My Drive
              </span>
            </button>
            <Link
              href="/inventory/bin"
              className="mt-1 flex items-center justify-between w-full px-4 py-2.5 text-sm font-medium border-l-2 border-transparent text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800"
            >
              <span className="flex items-center gap-2">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M6 7h12m-9 0V5.75c0-.41.34-.75.75-.75h4.5c.41 0 .75.34.75.75V7m-7 0v10.25c0 .41.34.75.75.75h6.5c.41 0 .75-.34.75-.75V7M10 10.5v4M14 10.5v4" />
                </svg>
                Bin
              </span>
            </Link>
            <div className="mt-1 space-y-0 text-sm">
              {folderTree.length === 0 ? (
                <p className="text-[11px] text-stone-400 px-4 pt-1">No folders yet.</p>
              ) : (
                folderTree.map((folder) => {
                  if (hasCollapsedAncestor(folder.id)) return null;
                  const paddingLeft = 20 + folder.depth * 14;
                  const hasChildren = folderTree.some((f) => f.parentId === folder.id);
                  return (
                    <div
                      key={`mobile-${folder.id}-${folder.depth}`}
                      data-folder-entry="true"
                      className={`flex items-center justify-between w-full py-2.5 border-l-2 transition-colors ${activeFolderId === folder.id
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
                        {hasChildren && (
                          <button type="button" onClick={(e) => { e.stopPropagation(); toggleFolderCollapsed(folder.id); }} className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-amber-50">
                            <svg className={`h-3 w-3 transform transition-transform ${collapsedFolders[folder.id] ? '' : 'rotate-90'}`} viewBox="0 0 20 20" fill="none">
                              <path d="M7 5L12 10L7 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        )}
                        {(
                          <button type="button" onClick={(event) => handleFolderMenuButton(event, folder.id)} disabled={deletingFolderId === folder.id} className="inline-flex items-center justify-center h-5 w-5 rounded-full text-xs text-stone-400 hover:text-stone-700 hover:bg-stone-100 disabled:opacity-50">
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
                            </svg>
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

      <ConfirmDialog
        isOpen={confirmDialogOpen}
        title={confirmDialogTitle}
        message={confirmDialogMessage}
        confirmLabel={confirmState.type === 'deleteProduct' ? 'Move to bin' : 'Delete'}
        confirmTone={confirmState.type === 'deleteProduct' ? 'default' : 'danger'}
        isConfirming={confirmDialogLoading}
        onCancel={() => {
          if (!confirmDialogLoading) {
            setConfirmState({ type: 'none' });
          }
        }}
        onConfirm={handleConfirmDialogConfirm}
      />
    </div>
  );
}
