import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { clearCache } from '@/lib/cache';

interface BinProductRow {
  id: string;
  name: string;
  primarysku: string | null;
  suppliersku: string | null;
  imageurl: string | null;
  deleted_at: string | null;
  folderid: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const { data, error } = await supabase
      .from('products')
      .select('id, name, primarysku, suppliersku, imageurl, deleted_at, folderid')
      .eq('user_id', user.id)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false });

    if (error) {
      console.error('Get bin error:', error);
      return NextResponse.json({ error: 'Failed to load bin' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: (data as BinProductRow[] | null) ?? [] });
  } catch (error) {
    console.error('Get bin error:', error);
    return NextResponse.json({ error: 'Failed to load bin' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);
    const blocked = applyRateLimit(request, user.id, { limit: 10, windowMs: 60_000 });
    if (blocked) return blocked;

    const { data: deletedProducts, error: fetchError } = await supabase
      .from('products')
      .select('id')
      .eq('user_id', user.id)
      .not('deleted_at', 'is', null);

    if (fetchError) {
      console.error('Empty bin fetch error:', fetchError);
      return NextResponse.json({ error: 'Failed to load bin items' }, { status: 500 });
    }

    const productIds = ((deletedProducts ?? []) as { id: string }[]).map((row) => row.id);
    if (productIds.length === 0) {
      return NextResponse.json({ success: true, deletedCount: 0 });
    }

    const { error: deleteError } = await supabase
      .from('products')
      .delete()
      .eq('user_id', user.id)
      .not('deleted_at', 'is', null);

    if (deleteError) {
      console.error('Empty bin delete error:', deleteError);
      return NextResponse.json({ error: 'Failed to empty bin' }, { status: 500 });
    }

    clearCache(`inventory_snapshot_v1_${user.id}`);
    return NextResponse.json({ success: true, deletedCount: productIds.length });
  } catch (error) {
    console.error('Empty bin delete error:', error);
    return NextResponse.json({ error: 'Failed to empty bin' }, { status: 500 });
  }
}
