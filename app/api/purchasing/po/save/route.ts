import { NextRequest, NextResponse } from 'next/server';
import {
  findOrCreateSupplier,
  createPurchaseOrder,
  createPOLines,
  syncInventoryFromPurchaseOrder,
  createOrUpdateInvoiceForPurchaseOrder,
} from '@/lib/db';
import { uploadInvoiceImages } from '@/lib/storage';
import { requireAuth } from '@/lib/auth-helpers';
import { clearCache } from '@/lib/cache';
import { applyRateLimit } from '@/lib/rate-limit';

interface SavePORequest {
  supplier: {
    name: string;
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
    trackingPostcode?: string;
    courier?: string;
  };
  poLines: Array<{
    description: string;
    supplierSku?: string;
    quantity: number;
    unitCostExVAT: number;
    lineTotalExVAT: number;
    rrp?: number;
    reviewDecision?: {
      action: 'link' | 'create';
      targetProductId?: string | null;
      shopifyBound?: boolean;
    };
  }>;
  totals?: {
    subtotal?: number;
    extras?: number;
    vat?: number;
    total?: number;
  };
  notes?: string;
  imageFiles?: File[];
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeLineMath(lines: SavePORequest['poLines']): SavePORequest['poLines'] {
  return (lines || []).map((line) => {
    const quantity = typeof line.quantity === 'number' && line.quantity > 0 ? line.quantity : 0;
    let unitCostExVAT = typeof line.unitCostExVAT === 'number' ? line.unitCostExVAT : 0;
    let lineTotalExVAT = typeof line.lineTotalExVAT === 'number' ? line.lineTotalExVAT : 0;

    if (quantity > 0) {
      if (lineTotalExVAT > 0 && unitCostExVAT <= 0) {
        unitCostExVAT = roundMoney(lineTotalExVAT / quantity);
      } else if (unitCostExVAT > 0 && lineTotalExVAT <= 0) {
        lineTotalExVAT = roundMoney(unitCostExVAT * quantity);
      } else if (unitCostExVAT > 0 && lineTotalExVAT > 0) {
        const expectedTotal = roundMoney(unitCostExVAT * quantity);
        const diff = Math.abs(expectedTotal - lineTotalExVAT);
        const tolerance = Math.max(0.1, roundMoney(lineTotalExVAT * 0.01));
        if (diff > tolerance) {
          unitCostExVAT = roundMoney(lineTotalExVAT / quantity);
        }
      }
    }

    return {
      ...line,
      quantity,
      unitCostExVAT: roundMoney(Math.max(0, unitCostExVAT)),
      lineTotalExVAT: roundMoney(Math.max(0, lineTotalExVAT)),
    };
  });
}

// POST endpoint to save approved purchase order data
export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    // SECURITY: Rate limit – save is a write operation
    const blocked = applyRateLimit(request, user.id, { limit: 30, windowMs: 60_000 });
    if (blocked) return blocked;

    const contentType = request.headers.get('content-type');
    let data: SavePORequest;
    const imageFiles: File[] = [];

    if (contentType?.includes('multipart/form-data')) {
      const formData = await request.formData();
      const jsonData = formData.get('data') as string;
      data = JSON.parse(jsonData);
      
      const fileCount = parseInt(formData.get('fileCount') as string || '0');
      for (let i = 0; i < fileCount; i++) {
        const file = formData.get(`file${i}`) as File;
        if (file) {
          imageFiles.push(file);
        }
      }
    } else {
      data = await request.json();
    }

    // Validate required fields
    if (!data.supplier?.name) {
      return NextResponse.json(
        { error: 'Supplier name is required' },
        { status: 400 }
      );
    }

    if (!data.poLines || data.poLines.length === 0) {
      return NextResponse.json(
        { error: 'At least one line item is required' },
        { status: 400 }
      );
    }

    const hasReviewDecisions = data.poLines.some((line) => !!line.reviewDecision);
    if (hasReviewDecisions) {
      const invalidDecisionIndex = data.poLines.findIndex((line) => {
        if (!line.reviewDecision) return true;
        if (line.reviewDecision.action === 'link') {
          return !line.reviewDecision.targetProductId;
        }
        return line.reviewDecision.action !== 'create';
      });

      if (invalidDecisionIndex !== -1) {
        return NextResponse.json(
          { error: `Line ${invalidDecisionIndex + 1} must be reviewed before saving` },
          { status: 400 },
        );
      }
    }

    data.poLines = normalizeLineMath(data.poLines);

    // Save to database
    try {
      // Create or find supplier
      const supplierId = await findOrCreateSupplier({
        name: data.supplier.name,
        address: data.supplier.address || null,
        email: data.supplier.email || null,
        phone: data.supplier.phone || null,
        vatNumber: data.supplier.vatNumber || null,
        user_id: user.id,
      });

      const linkedTargetIds = Array.from(
        new Set(
          data.poLines
            .map((line) => line.reviewDecision?.targetProductId || null)
            .filter((value): value is string => !!value),
        ),
      );

      if (hasReviewDecisions && linkedTargetIds.length > 0) {
        const { data: linkedProducts } = await supabase
          .from('products')
          .select('id')
          .eq('user_id', user.id)
          .in('id', linkedTargetIds);

        const validTargetIds = new Set((linkedProducts || []).map((product: { id: string }) => product.id));
        const invalidTargetId = linkedTargetIds.find((id) => !validTargetIds.has(id));
        if (invalidTargetId) {
          return NextResponse.json(
            { error: 'One or more reviewed product links are invalid for this account' },
            { status: 400 },
          );
        }
      }

      // Create purchase order first (we need the ID for image upload)
      const purchaseOrderId = await createPurchaseOrder({
        supplierId,
        invoiceNumber: data.purchaseOrder.invoiceNumber || null,
        invoiceDate: data.purchaseOrder.invoiceDate || null,
        currency: 'GBP', // All prices are converted to GBP by AI
        paymentTerms: data.purchaseOrder.paymentTerms || null,
        imageUrl: null,
        imageUrls: null,
        notes: data.notes || null,
        subtotalExVAT: data.totals?.subtotal ?? null,
        extras: data.totals?.extras ?? null,
        vat: data.totals?.vat ?? null,
        totalAmount: data.totals?.total ?? null,
        trackingNumber: data.purchaseOrder.trackingNumber || null,
        trackingPostcode: data.purchaseOrder.trackingPostcode || null,
        courier: data.purchaseOrder.courier || null,
        trackingStatus: 'pending',
        user_id: user.id,
      });

      // Upload images if provided
      let imageUrls: string[] = [];
      if (imageFiles.length > 0) {
        try {
          imageUrls = await uploadInvoiceImages(imageFiles, purchaseOrderId);
          
          // Update PO with image URLs
          const { updatePurchaseOrder } = await import('@/lib/db');
          await updatePurchaseOrder(purchaseOrderId, {
            imageUrl: imageUrls[0] || null,
            imageUrls: imageUrls,
          });
        } catch (uploadError) {
          console.error('Failed to upload images:', uploadError);
        }
      }

      // Create or update invoice record linked to this purchase order
      const invoice = await createOrUpdateInvoiceForPurchaseOrder({
        purchaseOrderId,
        supplierId,
        invoiceNumber: data.purchaseOrder.invoiceNumber || null,
        invoiceDate: data.purchaseOrder.invoiceDate || null,
        currency: 'GBP',
      });

      // Create PO lines
      const poLines = await createPOLines(
        data.poLines.map((line) => ({
          purchaseOrderId,
          description: line.description,
          supplierSku: line.supplierSku || null,
          quantity: line.quantity,
          unitCostExVAT: line.unitCostExVAT,
          lineTotalExVAT: line.lineTotalExVAT,
          rrp: line.rrp || null,
        }))
      );

      // Mark all extracted items as in transit for inventory management
      const inventorySync = await syncInventoryFromPurchaseOrder({
        supplierId,
        purchaseOrderId,
        poLines,
        user_id: user.id,
        lineReviewDecisions: hasReviewDecisions
          ? poLines.map((line, index) => ({
              poLineId: line.id,
              decision: {
                action: data.poLines[index].reviewDecision!.action,
                targetProductId: data.poLines[index].reviewDecision!.targetProductId || null,
                shopifyBound: !!data.poLines[index].reviewDecision!.shopifyBound,
              },
            }))
          : undefined,
      });

      // Invalidate caches so the new PO appears immediately
      clearCache(`purchasing_po_view_v1_${user.id}`);
      clearCache(`inventory_snapshot_v1_${user.id}`);

      return NextResponse.json({
        success: true,
        data: {
          supplierId,
          purchaseOrderId,
          savedLines: poLines.length,
          inventorySync,
          invoice,
        },
      });
    } catch (error) {
      console.error('Database error:', error);
      return NextResponse.json(
        { error: 'Failed to save data to database' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
