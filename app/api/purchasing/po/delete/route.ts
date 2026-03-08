import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { clearCache } from '@/lib/cache';
import { applyRateLimit } from '@/lib/rate-limit';
import { isValidUUID } from '@/lib/validation';

// DELETE endpoint to remove a purchase order and its line items
export async function DELETE(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    // Get the PO ID from query params
    const { searchParams } = new URL(request.url);
    const poId = searchParams.get('id');

    // SECURITY: Validate UUID format
    if (!isValidUUID(poId)) {
      return NextResponse.json(
        { error: 'Purchase order ID must be a valid UUID' },
        { status: 400 }
      );
    }

    // Check if PO exists and belongs to the user
    const { data: po, error: fetchError } = await supabase
      .from('purchaseorders')
      .select('*')
      .eq('id', poId)
      .eq('user_id', user.id)
      .single();

    if (fetchError || !po) {
      console.error('PO lookup failed:', { poId, fetchError: fetchError?.message, fetchErrorCode: fetchError?.code, po });
      // Clear cache even on 404 so stale data is removed from the view
      clearCache(`purchasing_po_view_v1_${user.id}`);
      clearCache(`inventory_snapshot_v1_${user.id}`);
      return NextResponse.json(
        { error: 'Purchase order not found' },
        { status: 404 }
      );
    }

    // Get count of associated line items before deletion
    const { count: deletedLines } = await supabase
      .from('polines')
      .select('*', { count: 'exact', head: true })
      .eq('purchaseorderid', poId);

    // CRITICAL WORKAROUND: There is a misconfigured database schema/trigger that
    // erroneously cascade-deletes the linked "supplier" when a "purchaseorder" is deleted.
    // If we sever the link before deleting, it saves the supplier from destruction 
    // and prevents the 409 Foreign Key violation on "products".
    await supabase
      .from('purchaseorders')
      .update({ supplierid: null })
      .eq('id', poId)
      .eq('user_id', user.id);

    // Delete the purchase order (cascade will handle line items)
    const { error: deleteError } = await supabase
      .from('purchaseorders')
      .delete()
      .eq('id', poId)
      .eq('user_id', user.id);

    if (deleteError) {
      console.error('Delete error from Supabase:', deleteError);
      
      if (deleteError.code === '23503') {
        return NextResponse.json(
          { 
            error: 'Cannot delete purchase order because it is linked to other active records (e.g. products or suppliers).', 
            details: deleteError.message 
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { error: 'Failed to delete purchase order' },
        { status: 500 }
      );
    }

    // Invalidate caches so the deleted PO disappears immediately
    clearCache(`purchasing_po_view_v1_${user.id}`);
    clearCache(`inventory_snapshot_v1_${user.id}`);

    return NextResponse.json({
      success: true,
      message: 'Purchase order deleted successfully',
      deleted: {
        purchaseOrder: po,
        lineItemsCount: deletedLines || 0,
      },
    });
  } catch (error) {
    console.error('Delete error:', error);
    return NextResponse.json(
      { error: 'Failed to delete purchase order' },
      { status: 500 }
    );
  }
}
