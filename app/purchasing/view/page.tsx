'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/contexts/AuthContext';
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

interface PurchaseOrder {
  id: string;
  supplierId: string;
  invoiceNumber: string;
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
  rrp: number | null;
}

type TransitStatus = 'in_transit' | 'partially_received' | 'received';

interface TransitRecord {
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

interface DatabaseData {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  poLines: POLine[];
   transit: TransitRecord[];
}

export default function ViewDataPage() {
  const [data, setData] = useState<DatabaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingPO, setEditingPO] = useState<PurchaseOrder | null>(null);
  const [editFormData, setEditFormData] = useState({
    invoiceNumber: '',
    invoiceDate: '',
    currency: 'USD',
    paymentTerms: '',
    notes: '',
  });
  const [editingLines, setEditingLines] = useState<POLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [receivingLineId, setReceivingLineId] = useState<string | null>(null);
  const [receivingPOId, setReceivingPOId] = useState<string | null>(null);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<'in_transit' | 'received'>('in_transit');
  const [expandedImages, setExpandedImages] = useState<Record<string, boolean>>({});
  const [showNotesModal, setShowNotesModal] = useState(false);
  const [selectedNotes, setSelectedNotes] = useState<{poId: string, notes: string, supplierName: string, invoiceNumber: string} | null>(null);
  const [headerScrolled, setHeaderScrolled] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (editingPO) {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    } else {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    }
    
    return () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, [editingPO]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const response = await authenticatedFetch('/api/purchasing/po/view?refresh=true');

      if (!response.ok) {
        throw new Error('Failed to fetch data');
      }

      const result = await response.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const getSupplierName = (supplierId: string) => {
    const supplier = data?.suppliers.find(s => s.id === supplierId);
    return supplier?.name || 'Unknown Supplier';
  };

  const getPOLines = (purchaseOrderId: string) => {
    return data?.poLines.filter(line => line.purchaseOrderId === purchaseOrderId) || [];
  };

  const getLineReceiveStatus = (line: POLine) => {
    if (!data?.transit || data.transit.length === 0) {
      return {
        status: 'not_received' as const,
        receivedQuantity: 0,
        remainingQuantity: line.quantity,
      };
    }

    const records = data.transit.filter((t) => t.poLineId === line.id);
    if (records.length === 0) {
      return {
        status: 'not_received' as const,
        receivedQuantity: 0,
        remainingQuantity: line.quantity,
      };
    }

    const totalQuantity = records.reduce((sum, r) => sum + (r.quantity || 0), 0);
    const totalRemaining = records.reduce((sum, r) => sum + (r.remainingQuantity || 0), 0);
    const receivedQuantity = Math.max(totalQuantity - totalRemaining, 0);

    let status: 'not_received' | 'partial' | 'received';
    if (receivedQuantity <= 0) {
      status = 'not_received';
    } else if (totalRemaining <= 0) {
      status = 'received';
    } else {
      status = 'partial';
    }

    return { status, receivedQuantity, remainingQuantity: totalRemaining };
  };

  const getPOReceiveSummary = (purchaseOrderId: string) => {
    const lines = getPOLines(purchaseOrderId);
    let totalOrdered = 0;
    let totalReceived = 0;
    let totalRemaining = 0;

    for (const line of lines) {
      const status = getLineReceiveStatus(line);
      totalOrdered += line.quantity;
      totalReceived += status.receivedQuantity;
      totalRemaining += status.remainingQuantity;
    }

    return { totalOrdered, totalReceived, totalRemaining };
  };

  const getPOStatus = (purchaseOrderId: string): 'received' | 'in_transit' => {
    const summary = getPOReceiveSummary(purchaseOrderId);
    return summary.totalRemaining <= 0 ? 'received' : 'in_transit';
  };

  const filterPOsByStatus = (pos: PurchaseOrder[]) => {
    return pos.filter(po => getPOStatus(po.id) === statusFilter);
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  };

  const formatCurrency = (amount: number, currency: string) => {
    return `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GBP`;
  };

  const getPOSortDate = (po: PurchaseOrder) => {
    return new Date(po.createdAt).getTime();
  };

  const groupPOsByMonth = () => {
    if (!data) return {};

    const grouped: { [key: string]: PurchaseOrder[] } = {};

    data.purchaseOrders.forEach(po => {
      const date = po.createdAt;
      const monthYear = new Date(date).toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long' 
      });
      
      if (!grouped[monthYear]) {
        grouped[monthYear] = [];
      }
      grouped[monthYear].push(po);
    });

    Object.keys(grouped).forEach((key) => {
      grouped[key] = grouped[key].sort((a, b) => getPOSortDate(b) - getPOSortDate(a));
    });

    // Sort by import date (most recent first)
    return Object.keys(grouped)
      .sort((a, b) => getPOSortDate(grouped[b][0]) - getPOSortDate(grouped[a][0]))
      .reduce((acc, key) => {
        acc[key] = grouped[key];
        return acc;
      }, {} as { [key: string]: PurchaseOrder[] });
  };

  const handleExportClick = () => {
    setShowExportModal(true);
    // Pre-select all months
    const allMonths = Object.keys(groupPOsByMonth());
    setSelectedMonths(allMonths);
  };

  const handleMonthToggle = (month: string) => {
    setSelectedMonths(prev => 
      prev.includes(month) 
        ? prev.filter(m => m !== month)
        : [...prev, month]
    );
  };

  const handleSelectAllMonths = () => {
    const allMonths = Object.keys(groupPOsByMonth());
    setSelectedMonths(allMonths);
  };

  const handleDeselectAllMonths = () => {
    setSelectedMonths([]);
  };

  const exportToCSV = (monthsToExport?: string[]) => {
    const groupedPOs = groupPOsByMonth();
    const monthsToInclude = monthsToExport || Object.keys(groupedPOs);

    const escapeCSV = (val: string) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const headers = ['Month', 'Invoice #', 'Supplier', 'Date', 'Currency', 'Description', 'SKU', 'Qty', 'Unit Cost (ex VAT)', 'RRP', 'Line Total (ex VAT)'];
    const rows: string[][] = [];

    Object.entries(groupedPOs)
      .filter(([month]) => monthsToInclude.includes(month))
      .forEach(([month, pos]) => {
        for (const po of pos) {
          const lines = getPOLines(po.id);
          if (lines.length === 0) {
            rows.push([
              month,
              po.invoiceNumber || 'N/A',
              getSupplierName(po.supplierId),
              formatDate(po.invoiceDate),
              po.currency,
              '', '', '', '', '', '',
            ]);
          } else {
            for (const line of lines) {
              rows.push([
                month,
                po.invoiceNumber || 'N/A',
                getSupplierName(po.supplierId),
                formatDate(po.invoiceDate),
                po.currency,
                line.description || '',
                line.supplierSku || '',
                String(line.quantity),
                line.unitCostExVAT.toFixed(2),
                line.rrp != null ? line.rrp.toFixed(2) : '',
                line.lineTotalExVAT.toFixed(2),
              ]);
            }
          }
        }
      });

    const csvContent = [headers, ...rows].map(row => row.map(escapeCSV).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `purchase-orders-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (poId: string) => {
    if (!confirm('Are you sure you want to delete this purchase order? This will also delete all associated line items.')) {
      return;
    }

    setDeleting(poId);
    try {
      const response = await authenticatedFetch(`/api/purchasing/po/delete?id=${poId}`, {
        method: 'DELETE',
      });

      if (!response.ok && response.status !== 404) {
        throw new Error('Failed to delete purchase order');
      }

      // Refresh data after deletion (including 404 - already deleted)
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(null);
    }
  };

  const handleEdit = (po: PurchaseOrder) => {
    const poLines = data?.poLines.filter(line => line.purchaseOrderId === po.id) || [];
    setEditingPO(po);
    setEditingLines([...poLines]);
    setEditFormData({
      invoiceNumber: po.invoiceNumber || '',
      invoiceDate: po.invoiceDate || '',
      currency: po.currency,
      paymentTerms: po.paymentTerms || '',
      notes: po.notes || '',
    });
  };

  const handleSave = async () => {
    if (!editingPO) return;

    const previousNotes = (editingPO.notes || '').trim();
    const nextNotes = (editFormData.notes || '').trim();
    if (previousNotes && !nextNotes) {
      const confirmed = window.confirm(
        'This will remove the existing note from this purchase order. Continue?',
      );
      if (!confirmed) {
        return;
      }
    }

    setSaving(true);
    try {
      // 1. Update the PO itself
      const poResponse = await authenticatedFetch(`/api/purchasing/po/update?id=${editingPO.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(editFormData),
      });

      if (!poResponse.ok) {
        throw new Error('Failed to update purchase order');
      }

      // 2. Get original lines for comparison
      const originalLines = data?.poLines.filter(line => line.purchaseOrderId === editingPO.id) || [];

      // 3. Handle line item updates, additions, and deletions
      const originalLineIds = originalLines.map(line => line.id);
      const currentLineIds = editingLines.map(line => line.id);

      // Lines to delete (in original but not in current)
      const linesToDelete = originalLineIds.filter(id => !currentLineIds.includes(id));

      // Lines to add (in current but not in original)
      const linesToAdd = editingLines.filter(line => !originalLineIds.includes(line.id));

      // Lines to update (in both, but may have changes)
      const linesToUpdate = editingLines.filter(line => {
        const original = originalLines.find(ol => ol.id === line.id);
        if (!original) return false;
        return JSON.stringify(original) !== JSON.stringify(line);
      });

      // Delete removed lines
      for (const lineId of linesToDelete) {
        await authenticatedFetch(`/api/purchasing/po/lines?id=${lineId}`, {
          method: 'DELETE',
        });
      }

      // Add new lines
      for (const line of linesToAdd) {
        await authenticatedFetch('/api/purchasing/po/lines/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(line),
        });
      }

      // Update modified lines
      for (const line of linesToUpdate) {
        await authenticatedFetch(`/api/purchasing/po/lines?id=${line.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            description: line.description,
            supplierSku: line.supplierSku,
            quantity: line.quantity,
            unitCostExVAT: line.unitCostExVAT,
            lineTotalExVAT: line.lineTotalExVAT,
          }),
        });
      }

      // Refresh data after successful update
      await fetchData();
      setEditingPO(null);
      setEditingLines([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleAddLineItem = () => {
    const newLine: POLine = {
      id: `temp-${Date.now()}`, // Temporary ID for new lines
      purchaseOrderId: editingPO!.id,
      description: '',
      supplierSku: null,
      quantity: 1,
      unitCostExVAT: 0,
      lineTotalExVAT: 0,
      rrp: null,
    };
    setEditingLines(prev => [...prev, newLine]);
  };

  const handleRemoveLineItem = (lineId: string) => {
    setEditingLines(prev => prev.filter(line => line.id !== lineId));
  };

  const handleUpdateLineItem = (lineId: string, field: keyof POLine, value: any) => {
    setEditingLines(prev => prev.map(line => {
      if (line.id === lineId) {
        const updatedLine = { ...line, [field]: value };
        // Auto-calculate line total if quantity or unit cost changes
        if (field === 'quantity' || field === 'unitCostExVAT') {
          updatedLine.lineTotalExVAT = updatedLine.quantity * updatedLine.unitCostExVAT;
        }
        return updatedLine;
      }
      return line;
    }));
  };

  const handleReceiveFullPO = async (po: PurchaseOrder) => {
    if (!data) return;

    const lines = getPOLines(po.id);
    const linesWithRemaining = lines.filter((line) => {
      const status = getLineReceiveStatus(line);
      return status.remainingQuantity > 0;
    });

    if (linesWithRemaining.length === 0) {
      alert('This purchase order is already fully received.');
      return;
    }

    const totalRemaining = linesWithRemaining.reduce((sum, line) => {
      const status = getLineReceiveStatus(line);
      return sum + status.remainingQuantity;
    }, 0);

    if (
      !window.confirm(
        `Mark all remaining quantities as received for this purchase order? This will receive ${totalRemaining} unit(s) across ${linesWithRemaining.length} line(s).`,
      )
    ) {
      return;
    }

    try {
      setReceivingPOId(po.id);

      for (const line of linesWithRemaining) {
        const lineStatus = getLineReceiveStatus(line);
        if (lineStatus.remainingQuantity <= 0) {
          continue;
        }

        const transitRecord = data.transit.find(
          (t) => t.poLineId === line.id && t.remainingQuantity > 0,
        );

        if (!transitRecord) {
          continue;
        }

        const res = await authenticatedFetch('/api/inventory/receive-line', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            productId: transitRecord.productId,
            poLineId: line.id,
            quantity: lineStatus.remainingQuantity,
          }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || 'Failed to receive stock for one or more lines');
        }
      }

      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to receive stock for purchase order');
    } finally {
      setReceivingPOId(null);
    }
  };

  const handleReceiveLine = async (line: POLine) => {
    if (!data) return;

    const lineStatus = getLineReceiveStatus(line);
    if (lineStatus.remainingQuantity <= 0) {
      return;
    }

    const raw = receiveQuantities[line.id] ?? String(lineStatus.remainingQuantity);
    const quantityToReceive = Number(raw);

    if (!Number.isFinite(quantityToReceive) || quantityToReceive <= 0) {
      alert('Please enter a valid quantity to receive.');
      return;
    }

    if (quantityToReceive > lineStatus.remainingQuantity) {
      alert(`You can receive at most ${lineStatus.remainingQuantity} units for this line.`);
      return;
    }

    const transitRecord = data.transit.find(
      (t) => t.poLineId === line.id && t.remainingQuantity > 0,
    );

    if (!transitRecord) {
      alert('No in-transit quantity available for this line.');
      return;
    }

    if (
      !window.confirm(
        `Mark ${quantityToReceive} unit(s) as received for "${line.description}"? (In transit: ${lineStatus.remainingQuantity})`,
      )
    ) {
      return;
    }

    try {
      setReceivingLineId(line.id);
      const res = await authenticatedFetch('/api/inventory/receive-line', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          productId: transitRecord.productId,
          poLineId: line.id,
          quantity: quantityToReceive,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to receive stock');
      }
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to receive stock');
    } finally {
      setReceivingLineId(null);
    }
  };

  const handleShowNotes = (po: PurchaseOrder) => {
    if (!po.notes || !po.notes.trim()) {
      handleEdit(po);
      return;
    }

    setSelectedNotes({
      poId: po.id,
      notes: po.notes,
      supplierName: getSupplierName(po.supplierId),
      invoiceNumber: po.invoiceNumber || 'N/A'
    });
    setShowNotesModal(true);
  };

  const handleCloseNotesModal = () => {
    setShowNotesModal(false);
    setSelectedNotes(null);
  };

  if (error && !data) {
    return (
      <div className="min-h-screen bg-[#f9f9f8] dark:bg-stone-900 py-12 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-600">Error: {error}</p>
          </div>
        </div>
      </div>
    );
  }

  const isEmpty = !loading && (!data || (data.suppliers.length === 0 && data.purchaseOrders.length === 0));

  return (
    <div className="h-full flex flex-col bg-[#f9f9f8] dark:bg-stone-900 overflow-hidden">
      {/* Sticky top section */}
      <div className="flex-none px-3 sm:px-4 lg:px-6 pt-3 sm:pt-6 pb-3 space-y-3 sm:space-y-4 border-b border-stone-200 dark:border-stone-800 bg-[#f9f9f8] dark:bg-stone-900">
        {/* Navigation Header */}
        <div className="flex flex-row items-center justify-between gap-2">
          <div>
            <h1 className="text-xl sm:text-3xl font-bold text-stone-900 dark:text-stone-100">
              Purchase Orders
            </h1>
            <p className="hidden sm:block text-sm sm:text-base text-stone-600 dark:text-stone-400 mt-1">
              View all imported invoices and suppliers
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportClick}
              disabled={!data || data.purchaseOrders.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export CSV
            </button>
            <button
              onClick={fetchData}
              disabled={loading}
              title="Refresh"
              className="inline-flex items-center justify-center w-9 h-9 border border-transparent rounded-md text-white bg-amber-600 hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Stats Cards - collapsible on mobile when scrolled */}
        <div className={`transition-all duration-300 ease-in-out sm:block ${headerScrolled ? 'max-h-0 overflow-hidden opacity-0 sm:max-h-none sm:overflow-visible sm:opacity-100 -mt-3 sm:mt-0' : 'max-h-56 overflow-visible opacity-100'}`}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 px-0.5 pb-0.5">
          <div className="flex flex-col justify-between bg-stone-50 dark:bg-stone-800 rounded-xl border border-stone-200 dark:border-stone-700 p-3 sm:p-4 text-left shadow-sm">
            <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">Total Value</p>
            {loading ? (
              <div className="h-6 sm:h-7 w-28 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
            ) : (
              <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">£{(data?.poLines.reduce((sum, line) => sum + line.lineTotalExVAT, 0) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            )}
          </div>

          <div className="flex flex-col justify-between bg-stone-50 dark:bg-stone-800 rounded-xl border border-stone-200 dark:border-stone-700 p-3 sm:p-4 text-left shadow-sm">
            <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">Orders</p>
            {loading ? (
              <div className="h-6 sm:h-7 w-12 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
            ) : (
              <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">{(data?.purchaseOrders.length || 0).toLocaleString()}</p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setStatusFilter('in_transit')}
            className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${
              statusFilter === 'in_transit'
                ? 'border-amber-600 bg-amber-50 dark:bg-amber-900/20 scale-[1.02]'
                : 'bg-stone-50 dark:bg-stone-800 border-stone-200 dark:border-stone-700 hover:border-amber-600'
            }`}
          >
            <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">In Transit</p>
            {loading ? (
              <div className="h-6 sm:h-7 w-12 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
            ) : (
              <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">
                {(data?.purchaseOrders.filter((po) => getPOStatus(po.id) === 'in_transit').length || 0).toLocaleString()}
              </p>
            )}
          </button>

          <button
            type="button"
            onClick={() => setStatusFilter('received')}
            className={`flex flex-col justify-between rounded-xl border p-3 sm:p-4 text-left transition-all shadow-sm ${
              statusFilter === 'received'
                ? 'border-amber-600 bg-amber-50 dark:bg-amber-900/20 scale-[1.02]'
                : 'bg-stone-50 dark:bg-stone-800 border-stone-200 dark:border-stone-700 hover:border-amber-600'
            }`}
          >
            <p className="text-[10px] sm:text-xs font-medium tracking-wide text-stone-600 dark:text-stone-400 uppercase">Received</p>
            {loading ? (
              <div className="h-6 sm:h-7 w-12 bg-stone-100 dark:bg-stone-700 rounded animate-pulse mt-1" />
            ) : (
              <p className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100 mt-1">
                {(data?.purchaseOrders.filter((po) => getPOStatus(po.id) === 'received').length || 0).toLocaleString()}
              </p>
            )}
          </button>
        </div>
        </div>
      </div>{/* end sticky top */}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6" onScroll={(e) => {
        const el = e.currentTarget;
        setHeaderScrolled(el.scrollTop > 10);
      }}>

        {/* Empty State */}
        {isEmpty && (
          <div className="bg-white dark:bg-stone-800 rounded-lg shadow p-12 text-center border border-stone-200 dark:border-stone-700">
            <svg className="mx-auto h-12 w-12 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h3 className="mt-2 text-lg font-medium text-stone-900 dark:text-stone-100">No data yet</h3>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Upload your first PDF invoice to see data here.
            </p>
            <div className="mt-6">
              <a
                href="/purchasing/import"
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-amber-600 hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600"
              >
                Upload Invoice
              </a>
            </div>
          </div>
        )}

        {/* Purchase Orders List - Grouped by Month */}
        {!isEmpty && (loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-amber-600"></div>
          </div>
        ) : (
          <div className="space-y-8">
            {Object.entries(groupPOsByMonth()).map(([month, pos]) => {
              const filteredPOs = filterPOsByStatus(pos);
              if (filteredPOs.length === 0) return null;
              return (
              <div key={month} className="space-y-4">
                {/* Month Header */}
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-bold text-stone-900 dark:text-stone-100">{month}</h2>
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-stone-100 dark:bg-stone-800 text-amber-600">
                    {filteredPOs.length} PO{filteredPOs.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* POs for this month */}
                <div className="space-y-6">
                  {filteredPOs.map((po) => {
                    const lines = getPOLines(po.id);
                    const lineTotalSum = lines.reduce((sum, line) => sum + line.lineTotalExVAT, 0);
                    const subtotal = po.subtotalExVAT != null ? po.subtotalExVAT : lineTotalSum;
                    const extras = po.extras ?? 0;
                    const vat = po.vat ?? 0;
                    const totalAmount = po.totalAmount != null ? po.totalAmount : (subtotal + extras + vat);
                    const receiveSummary = getPOReceiveSummary(po.id);

                    return (
                      <div 
                        key={po.id} 
                        className="bg-white dark:bg-stone-800 rounded-lg shadow overflow-hidden transition-all border border-stone-200 dark:border-stone-700"
                      >
                  {/* PO Header */}
                  <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-stone-200 dark:border-stone-700">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2 sm:gap-4">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-base sm:text-xl font-bold text-stone-900 dark:text-stone-100 truncate">
                          {po.invoiceNumber}
                        </h3>
                        <p className="text-stone-500 dark:text-stone-400 text-xs sm:text-sm mt-0.5 sm:mt-1 truncate">
                          {getSupplierName(po.supplierId)}
                        </p>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-2 sm:gap-4">
                        <div className="text-left sm:text-right">
                          <p className="text-lg sm:text-2xl font-bold text-stone-900 dark:text-stone-100">
                            {formatCurrency(totalAmount, po.currency)}
                          </p>
                          <p className="text-stone-400 dark:text-stone-500 text-[10px] sm:text-sm">Total (GBP)</p>
                        </div>
                        <div className="flex gap-1 sm:gap-2">
                          <button
                            onClick={() => handleShowNotes(po)}
                            className="border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 p-2 rounded-lg transition-colors"
                            title={po.notes && po.notes.trim() ? 'View Notes' : 'Add Note'}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleEdit(po)}
                            className="border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 p-2 rounded-lg transition-colors"
                            title="Edit Purchase Order"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDelete(po.id)}
                            disabled={deleting === po.id}
                            className="border border-stone-200 dark:border-stone-700 hover:bg-red-50 dark:hover:bg-red-900/20 text-stone-400 dark:text-stone-500 hover:text-red-500 hover:border-red-200 p-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            title="Delete Purchase Order"
                          >
                            {deleting === po.id ? (
                              <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                            ) : (
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* PO Details */}
                  <div className="px-3 sm:px-6 py-3 sm:py-4 bg-[#f9f9f8] dark:bg-stone-900 border-b border-stone-200 dark:border-stone-700">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
                      <div>
                        <p className="text-xs text-stone-500 dark:text-stone-400 uppercase tracking-wide">Invoice Date</p>
                        <p className="text-sm font-medium text-stone-900 dark:text-stone-100 mt-1">
                          {formatDate(po.invoiceDate)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-stone-500 dark:text-stone-400 uppercase tracking-wide">Currency</p>
                        <p className="text-sm font-medium text-stone-900 dark:text-stone-100 mt-1">{po.currency}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-stone-500 dark:text-stone-400 uppercase tracking-wide">Payment Terms</p>
                        <p className="text-sm font-medium text-stone-900 dark:text-stone-100 mt-1 truncate">
                          {po.paymentTerms || 'N/A'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-stone-500 dark:text-stone-400 uppercase tracking-wide">Line Items</p>
                        <p className="text-sm font-medium text-stone-900 dark:text-stone-100 mt-1">{lines.length}</p>
                      </div>
                    </div>
                  </div>

                  {/* Invoice Images - Expandable */}
                  {po.imageUrls && po.imageUrls.length > 0 && (
                    <div className="px-3 sm:px-6 py-3 sm:py-4 bg-[#f9f9f8] dark:bg-stone-900 border-b border-stone-200 dark:border-stone-700">
                      <button
                        onClick={() => setExpandedImages(prev => ({ ...prev, [po.id]: !prev[po.id] }))}
                        className="flex items-center justify-between w-full text-left group"
                      >
                        <h4 className="text-xs sm:text-sm font-semibold text-stone-900 dark:text-stone-100 group-hover:text-amber-600 transition-colors">
                          Original Invoice Images ({po.imageUrls.length})
                        </h4>
                        <svg 
                          className={`w-5 h-5 text-stone-500 transition-transform ${expandedImages[po.id] ? 'rotate-180' : ''}`}
                          fill="none" 
                          viewBox="0 0 24 24" 
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      
                      {expandedImages[po.id] && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
                          {po.imageUrls.map((imageUrl, idx) => (
                            <a
                              key={idx}
                              href={imageUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group relative aspect-[3/4] bg-white rounded-lg overflow-hidden border-2 border-stone-200 hover:border-amber-600 transition-colors"
                            >
                              <img
                                src={imageUrl}
                                alt={`Invoice page ${idx + 1}`}
                                className="w-full h-full object-contain"
                              />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
                                <svg className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                                </svg>
                              </div>
                              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                                <p className="text-xs text-white font-medium">Page {idx + 1}</p>
                              </div>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Line Items */}
                  <div className="px-3 sm:px-6 py-3 sm:py-4 overflow-hidden">
                    <h4 className="text-xs sm:text-sm font-semibold text-stone-900 dark:text-stone-100 mb-2 sm:mb-3">Line Items</h4>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-stone-200 dark:divide-stone-700 text-xs sm:text-sm">
                        <thead>
                          <tr>
                            <th className="px-2 sm:px-3 py-2 text-left text-[10px] sm:text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                              Description
                            </th>
                            <th className="hidden sm:table-cell px-3 py-2 text-left text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                              SKU
                            </th>
                            <th className="px-2 sm:px-3 py-2 text-left text-[10px] sm:text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                              Status
                            </th>
                            <th className="hidden sm:table-cell px-3 py-2 text-right text-xs font-medium text-stone-400 dark:text-stone-500 uppercase tracking-wider">
                            </th>
                            <th className="px-2 sm:px-3 py-2 text-right text-[10px] sm:text-xs font-medium text-stone-400 dark:text-stone-500 uppercase tracking-wider">
                              Qty
                            </th>
                            <th className="hidden sm:table-cell px-3 py-2 text-right text-xs font-medium text-stone-400 dark:text-stone-500 uppercase tracking-wider whitespace-nowrap">
                              Unit
                            </th>
                            <th className="hidden sm:table-cell px-3 py-2 text-right text-xs font-medium text-stone-400 dark:text-stone-500 uppercase tracking-wider whitespace-nowrap">
                              RRP
                            </th>
                            <th className="px-2 sm:px-3 py-2 text-right text-[10px] sm:text-xs font-medium text-stone-400 dark:text-stone-500 uppercase tracking-wider whitespace-nowrap">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                          {lines.map((line) => {
                            const lineStatus = getLineReceiveStatus(line);
                            const isReceived = lineStatus.status === 'received';
                            const isPartial = lineStatus.status === 'partial';
                            const isLongDescription = (line.description || '').length > 60;

                            return (
                              <tr
                                key={line.id}
                                className={`hover:border-l-2 hover:border-l-amber-600/60 dark:hover:bg-stone-700/20 ${
                                  isReceived
                                    ? 'bg-green-50 dark:bg-green-900/20'
                                    : isPartial
                                    ? 'bg-amber-50 dark:bg-amber-900/20'
                                    : ''
                                }`}
                              >
                                <td
                                  className={`px-2 sm:px-3 py-2 sm:py-3 text-stone-900 dark:text-stone-100 ${
                                    isLongDescription
                                      ? 'text-[11px] sm:text-xs leading-snug'
                                      : 'text-xs sm:text-sm'
                                  }`}
                                >
                                  <span className="break-words">{line.description}</span>
                                </td>
                                <td className="hidden sm:table-cell px-3 py-3 text-sm text-stone-500 dark:text-stone-400 font-mono">
                                  {line.supplierSku || '-'}
                                </td>
                                <td className="px-2 sm:px-3 py-2 sm:py-3 text-xs sm:text-sm">
                                  {lineStatus.status === 'received' && (
                                    <span className="inline-flex items-center px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[11px] font-medium bg-green-50 text-green-700 border border-green-200 whitespace-nowrap">
                                      <span className="hidden sm:inline">Received</span>
                                      <span className="sm:hidden"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></span>
                                    </span>
                                  )}
                                  {lineStatus.status === 'partial' && (
                                    <span className="inline-flex items-center px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
                                      <span className="hidden sm:inline">Partial ({lineStatus.receivedQuantity}/{line.quantity})</span>
                                      <span className="sm:hidden">{lineStatus.receivedQuantity}/{line.quantity}</span>
                                    </span>
                                  )}
                                  {lineStatus.status === 'not_received' && (
                                    <span className="inline-flex items-center px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[11px] font-medium bg-[#f9f9f8] dark:bg-stone-800 text-stone-600 dark:text-stone-400 border border-stone-200 dark:border-stone-700 whitespace-nowrap">
                                      <span className="hidden sm:inline">Not received</span>
                                      <span className="sm:hidden">—</span>
                                    </span>
                                  )}
                                </td>
                                <td className="hidden sm:table-cell px-3 py-3 text-sm text-right">
                                  {lineStatus.remainingQuantity > 0 && (
                                    <div className="flex items-center justify-end gap-2">
                                      <input
                                        type="number"
                                        min={1}
                                        max={lineStatus.remainingQuantity}
                                        value={
                                          receiveQuantities[line.id] ??
                                          String(lineStatus.remainingQuantity)
                                        }
                                        onChange={(e) =>
                                          setReceiveQuantities((prev) => ({
                                            ...prev,
                                            [line.id]: e.target.value,
                                          }))
                                        }
                                        className="w-16 rounded-md bg-[#f9f9f8] dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 text-xs px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => handleReceiveLine(line)}
                                        disabled={receivingLineId === line.id}
                                        className="inline-flex items-center px-2.5 py-1 text-[11px] rounded-md border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700 hover:text-stone-800 dark:hover:text-stone-200 disabled:opacity-50 font-medium"
                                      >
                                        {receivingLineId === line.id
                                          ? 'Saving...'
                                          : lineStatus.status === 'not_received'
                                          ? 'Receive'
                                          : 'Receive'}
                                      </button>
                                    </div>
                                  )}
                                </td>
                                <td className="px-2 sm:px-3 py-2 sm:py-3 text-xs sm:text-sm text-stone-900 dark:text-stone-100 text-right">
                                  {line.quantity}
                                </td>
                                <td className="hidden sm:table-cell px-3 py-3 text-xs sm:text-sm text-stone-900 dark:text-stone-100 text-right font-mono whitespace-nowrap">
                                  {formatCurrency(line.unitCostExVAT, po.currency)}
                                </td>
                                <td className="hidden sm:table-cell px-3 py-3 text-xs sm:text-sm text-stone-900 dark:text-stone-100 text-right font-mono whitespace-nowrap">
                                  {line.rrp ? formatCurrency(line.rrp, po.currency) : '-'}
                                </td>
                                <td className="px-2 sm:px-3 py-2 sm:py-3 text-xs sm:text-sm font-medium text-stone-900 dark:text-stone-100 text-right font-mono whitespace-nowrap">
                                  {formatCurrency(line.lineTotalExVAT, po.currency)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Totals Breakdown */}
                  {(po.subtotalExVAT != null || extras > 0 || vat > 0) && (
                    <div className="px-3 sm:px-6 py-3 sm:py-4 bg-[#f9f9f8] dark:bg-stone-900 border-t border-stone-200 dark:border-stone-700">
                      <div className="flex justify-end">
                        <div className="w-full sm:w-72 space-y-1.5 text-xs sm:text-sm">
                          <div className="flex justify-between text-stone-500 dark:text-stone-400">
                            <span>Subtotal (ex VAT)</span>
                            <span className="font-mono text-stone-900 dark:text-stone-100">{formatCurrency(subtotal, po.currency)}</span>
                          </div>
                          {extras > 0 && (
                            <div className="flex justify-between text-stone-500 dark:text-stone-400">
                              <span>Extras (Shipping, etc.)</span>
                              <span className="font-mono text-stone-900 dark:text-stone-100">{formatCurrency(extras, po.currency)}</span>
                            </div>
                          )}
                          {vat > 0 && (
                            <div className="flex justify-between text-stone-500 dark:text-stone-400">
                              <span>VAT</span>
                              <span className="font-mono text-stone-900 dark:text-stone-100">{formatCurrency(vat, po.currency)}</span>
                            </div>
                          )}
                          <div className="flex justify-between pt-1.5 border-t border-stone-200 dark:border-stone-700 font-semibold text-stone-900 dark:text-stone-100">
                            <span>Total</span>
                            <span className="font-mono">{formatCurrency(totalAmount, po.currency)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Footer with metadata */}
                  <div className="px-3 sm:px-6 py-2 sm:py-3 bg-[#f9f9f8] dark:bg-stone-900 border-t border-stone-200 dark:border-stone-700 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <p className="text-[10px] sm:text-xs text-stone-500 dark:text-stone-400 truncate">
                      Imported: {formatDate(po.createdAt)}
                    </p>
                    <button
                      onClick={() => handleReceiveFullPO(po)}
                      disabled={receivingPOId === po.id || receiveSummary.totalRemaining <= 0}
                      className="inline-flex items-center justify-center px-3 py-1.5 text-[11px] sm:text-sm rounded-lg border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700 hover:text-stone-800 dark:hover:text-stone-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                      title="Mark all remaining quantities on this PO as received"
                    >
                      {receivingPOId === po.id ? 'Receiving...' : 'Mark all received'}
                    </button>
                  </div>
                </div>
                    );
                  })}
                </div>
              </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Edit PO Modal */}
      {editingPO && (
        <div className="fixed inset-0 bg-black/70 overflow-y-auto h-full w-full z-50">
          <div className="relative top-3 sm:top-6 mx-auto w-[95vw] max-w-6xl border border-stone-200 dark:border-stone-700 shadow-lg rounded-xl bg-white dark:bg-stone-800 max-h-[92vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="px-4 sm:px-6 py-4 sm:py-5">
              <div className="flex items-center justify-between gap-3 mb-5">
                <div>
                  <h3 className="text-lg sm:text-xl font-semibold text-stone-900 dark:text-stone-100">Edit Purchase Order</h3>
                  <p className="text-xs sm:text-sm text-stone-500 dark:text-stone-400">Update header details and line items before saving.</p>
                </div>
                <button
                  onClick={() => {
                    setEditingPO(null);
                    setEditingLines([]);
                  }}
                  className="text-stone-500 hover:text-amber-600"
                >
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* PO Header and Images Side-by-Side */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
                {/* Left: PO Details */}
                <div className="bg-[#f9f9f8] dark:bg-stone-900 p-4 sm:p-5 rounded-xl border border-stone-200 dark:border-stone-700">
                  <h4 className="text-base sm:text-lg font-semibold text-stone-900 dark:text-stone-100 mb-4">Purchase Order Details</h4>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-stone-600 dark:text-stone-400 mb-1">
                        Invoice Number
                      </label>
                      <input
                        type="text"
                        value={editFormData.invoiceNumber}
                        onChange={(e) => setEditFormData(prev => ({ ...prev, invoiceNumber: e.target.value }))}
                        className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-600 text-stone-900 dark:text-stone-100 bg-[#f9f9f8] dark:bg-stone-800"
                        placeholder="Enter invoice number"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-stone-600 dark:text-stone-400 mb-1">
                        Invoice Date
                      </label>
                      <input
                        type="date"
                        value={editFormData.invoiceDate}
                        onChange={(e) => setEditFormData(prev => ({ ...prev, invoiceDate: e.target.value }))}
                        className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-600 text-stone-900 dark:text-stone-100 bg-[#f9f9f8] dark:bg-stone-800"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-stone-600 dark:text-stone-400 mb-1">
                        Currency
                      </label>
                      <select
                        value={editFormData.currency}
                        onChange={(e) => setEditFormData(prev => ({ ...prev, currency: e.target.value }))}
                        className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-600 text-stone-900 dark:text-stone-100 bg-[#f9f9f8] dark:bg-stone-800"
                      >
                        <option value="USD">USD</option>
                        <option value="EUR">EUR</option>
                        <option value="GBP">GBP</option>
                        <option value="CAD">CAD</option>
                        <option value="AUD">AUD</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-stone-600 dark:text-stone-400 mb-1">
                        Payment Terms
                      </label>
                      <input
                        type="text"
                        value={editFormData.paymentTerms}
                        onChange={(e) => setEditFormData(prev => ({ ...prev, paymentTerms: e.target.value }))}
                        className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-600 text-stone-900 dark:text-stone-100 bg-[#f9f9f8] dark:bg-stone-800"
                        placeholder="e.g., Net 30, Due on Receipt"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-stone-600 dark:text-stone-400 mb-1">
                        Notes
                      </label>
                      <textarea
                        value={editFormData.notes}
                        onChange={(e) => setEditFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={4}
                        className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-600 text-stone-900 dark:text-stone-100 bg-[#f9f9f8] dark:bg-stone-800 resize-y"
                        placeholder="Add internal notes for this purchase order"
                      />
                    </div>
                  </div>
                </div>

                {/* Right: Invoice Images */}
                {editingPO.imageUrls && editingPO.imageUrls.length > 0 ? (
                  <div className="bg-[#f9f9f8] dark:bg-stone-900 p-4 sm:p-5 rounded-xl border border-stone-200 dark:border-stone-700">
                    <h4 className="text-base sm:text-lg font-semibold text-stone-900 dark:text-stone-100 mb-4">Original Invoice Images</h4>
                    <div className="grid grid-cols-2 gap-3">
                      {editingPO.imageUrls.map((imageUrl, idx) => (
                        <a
                          key={idx}
                          href={imageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group relative aspect-[3/4] bg-white rounded-lg overflow-hidden border-2 border-stone-200 hover:border-amber-600 transition-colors"
                        >
                          <img
                            src={imageUrl}
                            alt={`Invoice page ${idx + 1}`}
                            className="w-full h-full object-contain"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
                            <svg className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                          </div>
                          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                            <p className="text-xs text-white font-medium">Page {idx + 1}</p>
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="bg-[#f9f9f8] dark:bg-stone-900 p-4 sm:p-5 rounded-xl border border-stone-200 dark:border-stone-700 flex items-center justify-center">
                    <p className="text-sm text-stone-500 dark:text-stone-400">No invoice images available</p>
                  </div>
                )}
              </div>

              {/* Line Items Section */}
              <div className="bg-[#f9f9f8] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-xl p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4">
                  <div>
                    <h4 className="text-base sm:text-lg font-semibold text-stone-900 dark:text-stone-100">Line Items</h4>
                    <p className="text-xs sm:text-sm text-stone-500 dark:text-stone-400">Edit quantities, prices, or remove lines.</p>
                  </div>
                  <button
                    onClick={handleAddLineItem}
                    className="inline-flex items-center justify-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-amber-600 hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600"
                  >
                    <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Line Item
                  </button>
                </div>

                <div className="sm:hidden space-y-3">
                  {editingLines.map((line) => (
                    <div key={line.id} className="border border-stone-200 dark:border-stone-700 rounded-lg p-3 space-y-3 bg-stone-50 dark:bg-stone-800">
                      <div>
                        <label className="block text-[10px] font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wide mb-1">
                          Description
                        </label>
                        <input
                          type="text"
                          value={line.description}
                          onChange={(e) => handleUpdateLineItem(line.id, 'description', e.target.value)}
                          className="w-full px-2 py-2 border border-stone-200 dark:border-stone-700 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900"
                          placeholder="Item description"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1">
                            SKU
                          </label>
                          <input
                            type="text"
                            value={line.supplierSku || ''}
                            onChange={(e) => handleUpdateLineItem(line.id, 'supplierSku', e.target.value || null)}
                            className="w-full px-2 py-2 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                            placeholder="SKU"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1">
                            Quantity
                          </label>
                          <input
                            type="number"
                            value={line.quantity}
                            onChange={(e) => handleUpdateLineItem(line.id, 'quantity', parseFloat(e.target.value) || 0)}
                            className="w-full px-2 py-2 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                            min="0"
                            step="1"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1">
                            Unit Price
                          </label>
                          <input
                            type="number"
                            value={line.unitCostExVAT}
                            onChange={(e) => handleUpdateLineItem(line.id, 'unitCostExVAT', parseFloat(e.target.value) || 0)}
                            className="w-full px-2 py-2 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                            min="0"
                            step="0.01"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1">
                            RRP
                          </label>
                          <input
                            type="number"
                            value={line.rrp || ''}
                            onChange={(e) => handleUpdateLineItem(line.id, 'rrp', parseFloat(e.target.value) || null)}
                            className="w-full px-2 py-2 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                            min="0"
                            step="0.01"
                            placeholder="Optional"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1">
                          Total
                        </label>
                        <div className="px-2 py-2 border border-stone-200 rounded text-sm text-stone-900 bg-white">
                          £{(line.lineTotalExVAT || 0).toFixed(2)} GBP
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveLineItem(line.id)}
                        className="inline-flex items-center justify-center w-full px-3 py-2 text-sm font-medium text-amber-600 border border-stone-200 dark:border-stone-700 rounded-md hover:bg-stone-50 dark:hover:bg-stone-700"
                      >
                        Remove Line Item
                      </button>
                    </div>
                  ))}
                </div>

                <div className="hidden sm:block overflow-x-auto">
                  <table className="min-w-full divide-y divide-stone-200">
                    <thead className="bg-white">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">
                          Description
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">
                          SKU
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">
                          Quantity
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">
                          Unit Price
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">
                          RRP
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">
                          Total
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-[#f9f9f8] divide-y divide-stone-200">
                      {editingLines.map((line) => (
                        <tr key={line.id} className="hover:bg-stone-50 dark:hover:bg-stone-700/20">
                          <td className="px-3 py-3">
                            <input
                              type="text"
                              value={line.description}
                              onChange={(e) => handleUpdateLineItem(line.id, 'description', e.target.value)}
                              className="w-full px-2 py-1 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                              placeholder="Item description"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <input
                              type="text"
                              value={line.supplierSku || ''}
                              onChange={(e) => handleUpdateLineItem(line.id, 'supplierSku', e.target.value || null)}
                              className="w-full px-2 py-1 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                              placeholder="SKU"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <input
                              type="number"
                              value={line.quantity}
                              onChange={(e) => handleUpdateLineItem(line.id, 'quantity', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                              min="0"
                              step="1"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <input
                              type="number"
                              value={line.unitCostExVAT}
                              onChange={(e) => handleUpdateLineItem(line.id, 'unitCostExVAT', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                              min="0"
                              step="0.01"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <input
                              type="number"
                              value={line.rrp || ''}
                              onChange={(e) => handleUpdateLineItem(line.id, 'rrp', parseFloat(e.target.value) || null)}
                              className="w-full px-2 py-1 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-600 text-stone-900 bg-white"
                              min="0"
                              step="0.01"
                              placeholder="Optional"
                            />
                          </td>
                          <td className="px-3 py-3 text-sm font-medium text-stone-900">
                            £{(line.lineTotalExVAT || 0).toFixed(2)} GBP
                          </td>
                          <td className="px-3 py-3">
                            <button
                              onClick={() => handleRemoveLineItem(line.id)}
                              className="text-amber-600 hover:text-amber-700 text-sm font-medium"
                              title="Remove line item"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {editingLines.length === 0 && (
                  <div className="text-center py-8 text-stone-500">
                    No line items. Click "Add Line Item" to get started.
                  </div>
                )}
              </div>

              <div className="flex flex-col sm:flex-row justify-end gap-3 mt-6">
                <button
                  onClick={() => {
                    setEditingPO(null);
                    setEditingLines([]);
                  }}
                  className="px-4 py-2 text-sm font-medium text-stone-900 bg-stone-100 border border-stone-300 rounded-md hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600"
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium text-white bg-amber-600 border border-transparent rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <span className="flex items-center">
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Saving...
                    </span>
                  ) : (
                    'Save Changes'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Export Month Selection Modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border border-stone-200 w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-stone-900">Select Months to Export</h3>
                <button
                  onClick={() => setShowExportModal(false)}
                  className="text-stone-500 hover:text-amber-600"
                >
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="mb-4 flex gap-2">
                <button
                  onClick={handleSelectAllMonths}
                  className="px-3 py-1 text-xs font-medium text-white bg-amber-600 rounded hover:bg-amber-700"
                >
                  Select All
                </button>
                <button
                  onClick={handleDeselectAllMonths}
                  className="px-3 py-1 text-xs font-medium text-stone-900 bg-stone-100 rounded hover:bg-stone-200"
                >
                  Deselect All
                </button>
              </div>

              <div className="space-y-2 max-h-96 overflow-y-auto">
                {Object.entries(groupPOsByMonth()).map(([month, pos]) => (
                  <label
                    key={month}
                    className="flex items-center p-3 border border-stone-200 rounded-lg hover:bg-stone-100 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMonths.includes(month)}
                      onChange={() => handleMonthToggle(month)}
                      className="h-4 w-4 text-amber-600 focus:ring-amber-600 border-stone-200 rounded"
                    />
                    <div className="ml-3 flex-1">
                      <span className="text-sm font-medium text-stone-900">{month}</span>
                      <span className="ml-2 text-xs text-stone-500">
                        ({pos.length} PO{pos.length !== 1 ? 's' : ''})
                      </span>
                    </div>
                  </label>
                ))}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowExportModal(false)}
                  className="px-4 py-2 text-sm font-medium text-stone-900 bg-stone-100 border border-stone-300 rounded-md hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (selectedMonths.length > 0) {
                      exportToCSV(selectedMonths);
                      setShowExportModal(false);
                    }
                  }}
                  disabled={selectedMonths.length === 0}
                  className="px-4 py-2 text-sm font-medium text-white bg-amber-600 border border-transparent rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Export {selectedMonths.length > 0 && `(${selectedMonths.length} month${selectedMonths.length !== 1 ? 's' : ''})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Notes Modal */}
      {showNotesModal && selectedNotes && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto border border-stone-200">
            <div className="flex items-center justify-between p-6 border-b border-stone-200">
              <div>
                <h3 className="text-lg font-semibold text-stone-900">Purchase Order Notes</h3>
                <p className="text-sm text-stone-500 mt-1">
                  {selectedNotes.supplierName} - {selectedNotes.invoiceNumber}
                </p>
              </div>
              <button
                onClick={handleCloseNotesModal}
                className="text-stone-500 hover:text-stone-800 transition-colors"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="p-6">
              <div className="bg-[#f9f9f8] rounded-lg p-4 border border-stone-200">
                <h4 className="text-sm font-semibold text-stone-600 mb-3">Notes & Instructions</h4>
                <div className="text-sm text-stone-900 whitespace-pre-wrap leading-relaxed">
                  {selectedNotes.notes}
                </div>
              </div>
            </div>
            
            <div className="flex justify-end p-6 border-t border-stone-200">
              <button
                onClick={handleCloseNotesModal}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
