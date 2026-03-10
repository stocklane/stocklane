import { NextRequest, NextResponse } from 'next/server';
import { createPurchaseOrder } from '@/lib/db';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { isValidUUID, sanitizeString } from '@/lib/validation';

// Force Node.js runtime for lowdb
export const runtime = 'nodejs';

// POST endpoint to create a new purchase order
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const poData = await request.json();

    // SECURITY: Validate UUID format for supplierId
    if (!isValidUUID(poData.supplierId)) {
      return NextResponse.json(
        { error: 'Supplier ID must be a valid UUID' },
        { status: 400 }
      );
    }

    const invoiceNumber = sanitizeString(poData.invoiceNumber, 200);
    if (!invoiceNumber) {
      return NextResponse.json(
        { error: 'Invoice number is required (max 200 characters)' },
        { status: 400 }
      );
    }

    const currency = sanitizeString(poData.currency, 10);
    if (!currency) {
      return NextResponse.json(
        { error: 'Currency is required' },
        { status: 400 }
      );
    }

    // Create the purchase order
    const purchaseOrderId = await createPurchaseOrder({
      supplierId: poData.supplierId,
      invoiceNumber: poData.invoiceNumber.trim(),
      invoiceDate: poData.invoiceDate || null,
      currency: poData.currency,
      paymentTerms: poData.paymentTerms || null,
      imageUrl: null,
      imageUrls: [],
      notes: poData.notes || null,
      subtotalExVAT: poData.subtotalExVAT ?? null,
      extras: poData.extras ?? null,
      vat: poData.vat ?? null,
      totalAmount: poData.totalAmount ?? null,
      trackingNumber: null,
      courier: null,
      trackingStatus: 'pending',
      user_id: user.id,
    });

    return NextResponse.json({
      success: true,
      message: 'Purchase order created successfully',
      data: { id: purchaseOrderId },
    });
  } catch (error) {
    console.error('Create PO error:', error);
    return NextResponse.json(
      { error: 'Failed to create purchase order' },
      { status: 500 }
    );
  }
}
