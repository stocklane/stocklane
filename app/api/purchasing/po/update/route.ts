import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { clearCache } from '@/lib/cache';
import { applyRateLimit } from '@/lib/rate-limit';
import { isValidUUID } from '@/lib/validation';

// Force Node.js runtime for lowdb
export const runtime = 'nodejs';

// PUT endpoint to update a purchase order
export async function PUT(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const { searchParams } = new URL(request.url);
    const poId = searchParams.get('id');

    // SECURITY: Validate UUID format
    if (!isValidUUID(poId)) {
      return NextResponse.json(
        { error: 'Purchase order ID must be a valid UUID' },
        { status: 400 }
      );
    }

    // Parse the request body
    const updates = await request.json();

    // Validate the updates (basic validation)
    const allowedFields = ['supplierId', 'invoiceNumber', 'invoiceDate', 'currency', 'paymentTerms', 'notes', 'trackingNumber', 'courier', 'trackingStatus'];
    const invalidFields = Object.keys(updates).filter(field => !allowedFields.includes(field));

    if (invalidFields.length > 0) {
      return NextResponse.json(
        { error: `Invalid fields: ${invalidFields.join(', ')}` },
        { status: 400 }
      );
    }

    // Map camelCase fields to DB column names
    const mappedUpdates: Record<string, any> = {};
    if (updates.supplierId !== undefined) mappedUpdates.supplierid = updates.supplierId;
    if (updates.invoiceNumber !== undefined) mappedUpdates.invoicenumber = updates.invoiceNumber;
    if (updates.invoiceDate !== undefined) mappedUpdates.invoicedate = updates.invoiceDate;
    if (updates.currency !== undefined) mappedUpdates.currency = updates.currency;
    if (updates.paymentTerms !== undefined) mappedUpdates.paymentterms = updates.paymentTerms;
    if (updates.notes !== undefined) mappedUpdates.notes = updates.notes;
    if (updates.trackingNumber !== undefined) mappedUpdates.tracking_number = updates.trackingNumber;
    if (updates.courier !== undefined) mappedUpdates.courier = updates.courier;
    if (updates.trackingStatus !== undefined) mappedUpdates.tracking_status = updates.trackingStatus;

    // Update the PO using the authenticated supabase client
    const { data, error } = await supabase
      .from('purchaseorders')
      .update(mappedUpdates)
      .eq('id', poId)
      .select()
      .single();

    if (error || !data) {
      console.error('Update PO DB error:', error);
      return NextResponse.json(
        { error: 'Purchase order not found' },
        { status: 404 }
      );
    }

    clearCache(`purchasing_po_view_v1_${user.id}`);
    clearCache(`inventory_snapshot_v1_${user.id}`);

    return NextResponse.json({
      success: true,
      message: 'Purchase order updated successfully',
      data,
    });
  } catch (error) {
    console.error('Update PO error:', error);
    return NextResponse.json(
      { error: 'Failed to update purchase order' },
      { status: 500 }
    );
  }
}
