'use client';

import { useState, useEffect } from 'react';
import { authenticatedFetch } from '@/lib/api-client';

interface Supplier {
  id: string;
  name: string;
}

interface POFormData {
  supplier: {
    name?: string;
    address?: string;
    email?: string;
    phone?: string;
    vatNumber?: string;
  };
  purchaseOrder: {
    invoiceNumber?: string;
    invoiceDate?: string;
    originalCurrency?: string;
    paymentTerms?: string;
    trackingNumber?: string;
    courier?: string;
    trackingStatus?: string;
  };
  poLines: Array<{
    description: string;
    supplierSku?: string;
    quantity: number;
    unitCostExVAT: number;
    lineTotalExVAT: number;
  }>;
  totals: {
    subtotal?: number;
    vat?: number;
    total?: number;
  };
}

interface PurchaseOrderFormProps {
  initialData?: POFormData;
  onSubmit: (data: POFormData) => Promise<void>;
  onCancel?: () => void;
  submitButtonText?: string;
  title?: string;
  description?: string;
  loading?: boolean;
  error?: string;
}

export default function PurchaseOrderForm({
  initialData,
  onSubmit,
  onCancel,
  submitButtonText = 'Save Purchase Order',
  title = 'Purchase Order Details',
  description,
  loading = false,
  error,
}: PurchaseOrderFormProps) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [formData, setFormData] = useState<POFormData>(
    initialData || {
      supplier: {},
      purchaseOrder: {},
      poLines: [],
      totals: {},
    }
  );

  useEffect(() => {
    fetchSuppliers();
  }, []);

  useEffect(() => {
    if (initialData) {
      setFormData(initialData);
    }
  }, [initialData]);

  const fetchSuppliers = async () => {
    try {
      const response = await authenticatedFetch('/api/purchasing/po/view');
      if (response.ok) {
        const data = await response.json();
        setSuppliers(data.suppliers || []);
      }
    } catch (err) {
      console.error('Failed to fetch suppliers:', err);
    }
  };

  const handleSupplierChange = (supplierId: string) => {
    setSelectedSupplierId(supplierId);
    if (supplierId) {
      const supplier = suppliers.find((s) => s.id === supplierId);
      if (supplier) {
        setFormData((prev) => ({
          ...prev,
          supplier: {
            ...prev.supplier,
            name: supplier.name,
          },
        }));
      }
    }
  };

  const handleSupplierFieldChange = (field: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      supplier: {
        ...prev.supplier,
        [field]: value,
      },
    }));
  };

  const handlePOFieldChange = (field: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      purchaseOrder: {
        ...prev.purchaseOrder,
        [field]: value,
      },
    }));
  };

  const handleLineItemChange = (index: number, field: string, value: any) => {
    setFormData((prev) => {
      const updated = { ...prev };
      const line = { ...updated.poLines[index], [field]: value };

      // Auto-calculate line total
      if (field === 'quantity' || field === 'unitCostExVAT') {
        line.lineTotalExVAT = line.quantity * line.unitCostExVAT;
      }

      updated.poLines[index] = line;

      // Recalculate totals
      const subtotal = updated.poLines.reduce((sum, item) => sum + item.lineTotalExVAT, 0);
      updated.totals = {
        ...updated.totals,
        subtotal,
        total: subtotal + (updated.totals?.vat || 0),
      };

      return updated;
    });
  };

  const handleAddLineItem = () => {
    setFormData((prev) => ({
      ...prev,
      poLines: [
        ...prev.poLines,
        {
          description: '',
          supplierSku: '',
          quantity: 1,
          unitCostExVAT: 0,
          lineTotalExVAT: 0,
        },
      ],
    }));
  };

  const handleRemoveLineItem = (index: number) => {
    if (formData.poLines.length > 1) {
      setFormData((prev) => {
        const updated = { ...prev };
        updated.poLines = updated.poLines.filter((_, i) => i !== index);

        // Recalculate totals
        const subtotal = updated.poLines.reduce((sum, item) => sum + item.lineTotalExVAT, 0);
        updated.totals = {
          ...updated.totals,
          subtotal,
          total: subtotal + (updated.totals?.vat || 0),
        };

        return updated;
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {description && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-600 rounded-lg p-4">
          <p className="text-sm text-stone-600 dark:text-stone-400">{description}</p>
        </div>
      )}

      {/* Supplier Details */}
      <div>
        <h4 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-3">{title}</h4>

        {/* Supplier Dropdown */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
            Supplier <span className="text-amber-600">*</span>
          </label>
          <select
            value={selectedSupplierId}
            onChange={(e) => handleSupplierChange(e.target.value)}
            className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600 mb-2 appearance-none"
          >
            <option value="">-- Select existing supplier or create new --</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>

          {!selectedSupplierId && (
            <input
              type="text"
              value={formData.supplier.name || ''}
              onChange={(e) => handleSupplierFieldChange('name', e.target.value)}
              placeholder="Or enter new supplier name"
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Email</label>
            <input
              type="email"
              value={formData.supplier.email || ''}
              onChange={(e) => handleSupplierFieldChange('email', e.target.value)}
              placeholder="supplier@example.com"
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Phone</label>
            <input
              type="tel"
              value={formData.supplier.phone || ''}
              onChange={(e) => handleSupplierFieldChange('phone', e.target.value)}
              placeholder="+44 20 1234 5678"
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">VAT Number</label>
            <input
              type="text"
              value={formData.supplier.vatNumber || ''}
              onChange={(e) => handleSupplierFieldChange('vatNumber', e.target.value)}
              placeholder="GB123456789"
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Address</label>
            <textarea
              value={formData.supplier.address || ''}
              onChange={(e) => handleSupplierFieldChange('address', e.target.value)}
              placeholder="Full address"
              rows={2}
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>
        </div>
      </div>

      {/* Purchase Order Details */}
      <div>
        <h4 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-3">Purchase Order Details</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Invoice Number</label>
            <input
              type="text"
              value={formData.purchaseOrder.invoiceNumber || ''}
              onChange={(e) => handlePOFieldChange('invoiceNumber', e.target.value)}
              placeholder="INV-001"
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Invoice Date</label>
            <input
              type="date"
              value={formData.purchaseOrder.invoiceDate || ''}
              onChange={(e) => handlePOFieldChange('invoiceDate', e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600 dark:[color-scheme:dark]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Payment Terms</label>
            <input
              type="text"
              value={formData.purchaseOrder.paymentTerms || ''}
              onChange={(e) => handlePOFieldChange('paymentTerms', e.target.value)}
              placeholder="Net 30"
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Courier</label>
            <select
              value={formData.purchaseOrder.courier || ''}
              onChange={(e) => handlePOFieldChange('courier', e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600 appearance-none"
            >
              <option value="">-- Select Courier --</option>
              <option value="DPD">DPD</option>
              <option value="FedEx">FedEx</option>
              <option value="UPS">UPS</option>
              <option value="Royal Mail">Royal Mail</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Tracking Number</label>
            <input
              type="text"
              value={formData.purchaseOrder.trackingNumber || ''}
              onChange={(e) => {
                const val = e.target.value;
                setFormData(prev => ({
                  ...prev,
                  purchaseOrder: {
                    ...prev.purchaseOrder,
                    trackingNumber: val,
                    trackingStatus: (val && prev.purchaseOrder.trackingStatus === 'pending') ? 'in_transit' : prev.purchaseOrder.trackingStatus
                  }
                }));
              }}
              placeholder="e.g. 1Z999..."
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">Status</label>
            <select
              value={formData.purchaseOrder.trackingStatus || 'pending'}
              onChange={(e) => handlePOFieldChange('trackingStatus', e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-800 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600 appearance-none"
            >
              <option value="pending">Pending</option>
              <option value="in_transit">In Transit</option>
              <option value="delivered">Delivered</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
      </div>

      {/* Line Items */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h4 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Line Items ({formData.poLines.length})</h4>
          <button
            type="button"
            onClick={handleAddLineItem}
            className="inline-flex items-center px-3 py-1 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600"
          >
            + Add Line Item
          </button>
        </div>

        <div className="bg-[#f9f9f8] dark:bg-stone-800/50 rounded-lg p-3 max-h-96 overflow-y-auto border border-stone-200 dark:border-stone-700">
          <table className="w-full text-sm">
            <thead className="text-xs text-stone-600 dark:text-stone-400 font-medium border-b border-stone-200 dark:border-stone-700 sticky top-0 bg-[#f9f9f8] dark:bg-stone-800">
              <tr>
                <th className="text-left pb-2">Description</th>
                <th className="text-left pb-2">SKU</th>
                <th className="text-right pb-2">Qty</th>
                <th className="text-right pb-2">Unit Price (GBP)</th>
                <th className="text-right pb-2">Total (GBP)</th>
                <th className="text-center pb-2">Actions</th>
              </tr>
            </thead>
            <tbody className="text-stone-900 dark:text-stone-100">
              {formData.poLines.map((line, lineIdx) => (
                <tr key={lineIdx} className="border-b border-stone-200 dark:border-stone-700 last:border-0">
                  <td className="py-2 pr-2">
                    <input
                      type="text"
                      value={line.description}
                      onChange={(e) => handleLineItemChange(lineIdx, 'description', e.target.value)}
                      placeholder="Item description"
                      className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      type="text"
                      value={line.supplierSku || ''}
                      onChange={(e) => handleLineItemChange(lineIdx, 'supplierSku', e.target.value)}
                      placeholder="SKU"
                      className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      type="number"
                      value={line.quantity}
                      onChange={(e) => handleLineItemChange(lineIdx, 'quantity', parseFloat(e.target.value) || 0)}
                      className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 rounded text-sm text-stone-900 dark:text-stone-100 text-right focus:outline-none focus:ring-1 focus:ring-amber-600"
                      min="0"
                      step="1"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      type="number"
                      value={line.unitCostExVAT}
                      onChange={(e) => handleLineItemChange(lineIdx, 'unitCostExVAT', parseFloat(e.target.value) || 0)}
                      className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 rounded text-sm text-stone-900 dark:text-stone-100 text-right focus:outline-none focus:ring-1 focus:ring-amber-600"
                      min="0"
                      step="0.01"
                    />
                  </td>
                  <td className="py-2 pr-2 text-right font-medium text-stone-900 dark:text-stone-100">{line.lineTotalExVAT.toFixed(2)}</td>
                  <td className="py-2 text-center">
                    <button
                      type="button"
                      onClick={() => handleRemoveLineItem(lineIdx)}
                      disabled={formData.poLines.length === 1}
                      className="text-amber-600 hover:text-amber-700 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Remove line"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex justify-end">
          <div className="text-base">
            <span className="text-stone-600 dark:text-stone-400 font-medium">Total: </span>
            <span className="font-bold text-amber-600">GBP {formData.totals?.total?.toFixed(2) || '0.00'}</span>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-end gap-3 pt-4 border-t border-stone-200 dark:border-stone-700">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-md hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600"
            disabled={loading}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm font-medium text-white bg-amber-600 border border-transparent rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Saving...' : submitButtonText}
        </button>
      </div>
    </form>
  );
}
