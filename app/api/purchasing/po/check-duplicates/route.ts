import { NextRequest, NextResponse } from 'next/server';
import { findDuplicatePurchaseOrders } from '@/lib/db';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { sanitizeString } from '@/lib/validation';

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);

    // SECURITY: Rate limit per IP + user
    const blocked = applyRateLimit(request, user.id);
    if (blocked) return blocked;

    const body = await request.json();

    const supplierName = sanitizeString(body?.supplierName, 500);
    const invoiceNumber = sanitizeString(body?.invoiceNumber, 200);
    const invoiceDate = sanitizeString(body?.invoiceDate, 20);
    const poLines = body?.poLines;

    // Validate required fields
    if (!supplierName) {
      return NextResponse.json(
        { error: 'Supplier name is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    if (!Array.isArray(poLines) || poLines.length === 0 || poLines.length > 500) {
      return NextResponse.json(
        { error: 'poLines must be an array with 1-500 items' },
        { status: 400 }
      );
    }

    // Check for duplicates
    const duplicates = await findDuplicatePurchaseOrders(
      supplierName,
      invoiceNumber || null,
      invoiceDate || null,
      poLines,
      user.id
    );

    return NextResponse.json({
      hasDuplicates: duplicates.length > 0,
      duplicates: duplicates.map(dup => ({
        id: dup.purchaseOrder.id,
        invoiceNumber: dup.purchaseOrder.invoiceNumber,
        invoiceDate: dup.purchaseOrder.invoiceDate,
        supplierName: dup.supplier.name,
        matchScore: Math.round(dup.matchScore),
        matchReasons: dup.matchReasons,
        lineCount: dup.lineCount,
        createdAt: dup.purchaseOrder.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    return NextResponse.json(
      { error: 'Failed to check for duplicates' },
      { status: 500 }
    );
  }
}
