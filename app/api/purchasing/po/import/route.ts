import { NextRequest, NextResponse } from 'next/server';
import {
  findOrCreateSupplier,
  createPurchaseOrder,
  createPOLines,
  type Totals,
  syncInventoryFromPurchaseOrder,
  createOrUpdateInvoiceForPurchaseOrder,
  updatePurchaseOrder,
} from '@/lib/db';
import { uploadInvoiceImages } from '@/lib/storage';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';

// Gemini prompt for structured data extraction
const EXTRACTION_PROMPT = `You are running inside the Google Gemini API.
Input: an invoice (PDF text). Output: a single valid JSON object in this schema:

{
  "supplier": {
    "name": "string",
    "address": "string | null",
    "email": "string | null",
    "phone": "string | null",
    "vatNumber": "string | null"
  },
  "purchaseOrder": {
    "invoiceNumber": "string",
    "invoiceDate": "YYYY-MM-DD | null",
    "originalCurrency": "ISO code (GBP, EUR, USD, etc.) - the currency shown on the invoice",
    "paymentTerms": "string | null"
  },
  "poLines": [
    {
      "description": "string",
      "supplierSku": "string | null",
      "quantity": number,
      "packSize": "number | null (e.g. 10 if CDU (10), 12 if Case (12))",
      "unitCostExVAT": number,
      "lineTotalExVAT": number,
      "rrp": "number | null"
    }
  ],
  "totals": {
    "subTotalExVAT": number | null,
    "vatTotal": number | null,
    "grandTotal": number | null
  }
}

Rules:
- Return valid JSON only, no commentary.
- Convert all prices to numeric values.
- **CRITICAL: If the invoice is NOT in GBP, you MUST convert ALL monetary values (unitCostExVAT, lineTotalExVAT, subTotalExVAT, vatTotal, grandTotal) to GBP using current exchange rates.**
- Store the original currency in "originalCurrency" field.
- After conversion, all prices should be in GBP.
- **PACK SIZE & UNIT EXPANSION**:
  - Many invoices list "Case quantity" or "Display items".
  - If you see "(12 units)", "CDU (10)", "Box of 6", OR if the invoice has a "Units per pack" column, put that number in "packSize".
  - **IMPORTANT**: Your "quantity" should represent the number of INDIVIDUAL UNITS. 
  - **Example**: If the invoice says "1 Display" and "CDU (10)", "quantity" should be 10 and "packSize" should be 10.
  - **Example**: If the invoice says "4 Displays" and "CDU (10)", "quantity" should be 40 and "packSize" should be 10.
  - If "quantity" is expanded, "unitCostExVAT" must be (lineTotal / expanded quantity).
- **RRP FIELD**:
  - ONLY extract the Recommended Retail Price if it's a currency value (e.g. 12.99).
  - **NEVER** put pack size (10, 12, etc.) in the RRP field unless it is explicitly labeled as the RRP price.
- If a field is missing, return null.

Here is the invoice text:

`;

interface ExtractedData {
  supplier: {
    name: string;
    address: string | null;
    email: string | null;
    phone: string | null;
    vatNumber: string | null;
  };
  purchaseOrder: {
    invoiceNumber: string;
    invoiceDate: string | null;
    originalCurrency: string;
    paymentTerms: string | null;
  };
  poLines: Array<{
    description: string;
    supplierSku: string | null;
    quantity: number;
    packSize?: number | null;
    unitCostExVAT: number;
    lineTotalExVAT: number;
    rrp: number | null;
  }>;
  totals?: {
    subTotalExVAT: number | null;
    vatTotal: number | null;
    grandTotal: number | null;
  };
}

function roundMoney(val: number): number {
  return Math.round(val * 100) / 100;
}

function normalizeLineMath(lines: ExtractedData['poLines']): ExtractedData['poLines'] {
  return (lines || []).map((line) => {
    let quantity = typeof line.quantity === 'number' && line.quantity > 0 ? line.quantity : 0;
    let unitCostExVAT = typeof line.unitCostExVAT === 'number' ? line.unitCostExVAT : 0;
    let lineTotalExVAT = typeof line.lineTotalExVAT === 'number' ? line.lineTotalExVAT : 0;
    let rrp = typeof line.rrp === 'number' ? line.rrp : null;
    const packSize = typeof line.packSize === 'number' ? line.packSize : 1;

    // --- HEURISTIC SAFETY NET ---
    // Detect if AI hallucinated a multiplier as an RRP (very common mistake for Gemini)
    // Common pack sizes: 6, 10, 12, 18, 24, 30, 36, 40, 50, 60, 100.
    const commonMultipliers = [6, 8, 10, 12, 18, 24, 30, 36, 40, 50, 60, 100];
    const desc = (line.description || '').toLowerCase();
    const hasPackKeywords = desc.includes('cdu') || desc.includes('box') || desc.includes('pack') || 
                            desc.includes('display') || desc.includes('units') || desc.includes('(') ||
                            desc.includes('collection');

    if (rrp !== null && commonMultipliers.includes(rrp) && quantity <= 10 && hasPackKeywords) {
      // If our heuristic catches a likely multiplier sitting in RRP, expand quantity
      if (lineTotalExVAT > 0) {
        const isTotalPriceInUnit = Math.abs(unitCostExVAT - lineTotalExVAT) < 0.05;
        // If the unit price is actually the box price (matches total), or quantity is 1
        if (isTotalPriceInUnit || quantity < rrp) {
          quantity = quantity * rrp;
          unitCostExVAT = roundMoney(lineTotalExVAT / quantity);
          rrp = null; // Clear it so it doesn't pollute the actual RRP data
        }
      }
    }

    // Ensure rounding and consistency
    if (quantity > 0) {
      if (lineTotalExVAT > 0) {
        // Line total is always the source of truth for cost
        unitCostExVAT = roundMoney(lineTotalExVAT / quantity);
      } else if (unitCostExVAT > 0) {
        lineTotalExVAT = roundMoney(unitCostExVAT * quantity);
      }
    }

    return {
      ...line,
      quantity: Math.max(0, quantity),
      unitCostExVAT: roundMoney(Math.max(0, unitCostExVAT)),
      lineTotalExVAT: roundMoney(Math.max(0, lineTotalExVAT)),
      rrp: rrp
    };
  });
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);

    // SECURITY: Rate limit – AI import is expensive, allow 10 requests/min
    const blocked = applyRateLimit(request, user.id, { limit: 10, windowMs: 60_000 });
    if (blocked) return blocked;

    // 1. Validate API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'GEMINI_API_KEY not configured in environment variables' },
        { status: 500 }
      );
    }

    // 2. Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Store original file for later upload
    const originalFile = file;

    // Validate file type - images or PDF
    const isImage = file.type.startsWith('image/');
    const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    
    if (!isImage && !isPDF) {
      return NextResponse.json(
        { error: 'Please upload an image file (PNG, JPG) or PDF.' },
        { status: 400 }
      );
    }

    // SECURITY: Cap file size to 20 MB
    const MAX_FILE_BYTES = 20 * 1024 * 1024;
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: 'File exceeds the 20 MB size limit.' },
        { status: 400 }
      );
    }

    // 3. Prepare file for Gemini
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Data = buffer.toString('base64');
    
    // Determine MIME type
    let mimeType = file.type;
    if (isPDF && !mimeType) {
      mimeType = 'application/pdf';
    }

    // 4. Send to Gemini API v1 endpoint directly (bypass SDK)
    const filePart = {
      inlineData: {
        data: base64Data,
        mimeType: mimeType,
      },
    };

    const prompt = EXTRACTION_PROMPT + `\n\nPlease analyze this invoice ${isPDF ? 'PDF' : 'image'} and extract the data.`;
    
    const requestBody = {
      contents: [{
        parts: [
          { text: prompt },
          filePart
        ]
      }]
    };

    let text;
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Gemini API error:', errorText);
        return NextResponse.json(
          { error: `Gemini API error: ${response.status} ${response.statusText}`, details: errorText },
          { status: 500 }
        );
      }

      const data = await response.json();
      text = data.candidates[0].content.parts[0].text;
    } catch (error) {
      console.error('Gemini API error:', error);
      return NextResponse.json(
        { error: `Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}` },
        { status: 500 }
      );
    }

    // 5. Parse JSON response from Gemini
    let extractedData: ExtractedData;
    try {
      // Remove markdown code blocks if present
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(cleanedText);
    } catch (error) {
      console.error('JSON parsing error:', error);
      console.error('Raw response:', text);
      return NextResponse.json(
        { error: 'Failed to parse Gemini response as JSON' },
        { status: 500 }
      );
    }

    // 6. Validate extracted data
    if (!extractedData.supplier?.name) {
      return NextResponse.json(
        { error: 'Failed to extract supplier name from invoice. Please ensure the image is clear and contains supplier information.' },
        { status: 400 }
      );
    }

    extractedData.poLines = normalizeLineMath(extractedData.poLines);

    // 7. Save to lowdb database
    try {
      // Create or find supplier
      const supplierId = await findOrCreateSupplier({
        name: extractedData.supplier.name,
        address: extractedData.supplier.address,
        email: extractedData.supplier.email,
        phone: extractedData.supplier.phone,
        vatNumber: extractedData.supplier.vatNumber,
        user_id: user.id,
      });

      // Create purchase order first (we need the ID for image upload)
      const purchaseOrderId = await createPurchaseOrder({
        supplierId,
        invoiceNumber: extractedData.purchaseOrder.invoiceNumber,
        invoiceDate: extractedData.purchaseOrder.invoiceDate,
        currency: 'GBP', // All prices are converted to GBP by AI
        paymentTerms: extractedData.purchaseOrder.paymentTerms,
        imageUrl: null,
        imageUrls: null,
        notes: null,
        subtotalExVAT: extractedData.totals?.subTotalExVAT ?? null,
        extras: null,
        vat: extractedData.totals?.vatTotal ?? null,
        totalAmount: extractedData.totals?.grandTotal ?? null,
        trackingNumber: null,
        courier: null,
        trackingStatus: 'pending',
        user_id: user.id,
      });

      // Upload invoice image to Supabase Storage
      let imageUrls: string[] = [];
      try {
        imageUrls = await uploadInvoiceImages([originalFile], purchaseOrderId);
        
        // Update PO with image URLs
        await updatePurchaseOrder(purchaseOrderId, {
          imageUrl: imageUrls[0] || null,
          imageUrls: imageUrls,
        });
      } catch (uploadError) {
        console.error('Failed to upload invoice image:', uploadError);
        // Continue even if image upload fails
      }

      // Create or update invoice record linked to this purchase order
      const invoice = await createOrUpdateInvoiceForPurchaseOrder({
        purchaseOrderId,
        supplierId,
        invoiceNumber: extractedData.purchaseOrder.invoiceNumber || null,
        invoiceDate: extractedData.purchaseOrder.invoiceDate || null,
        currency: 'GBP',
      });

      // Create PO lines
      const poLines = await createPOLines(
        extractedData.poLines.map((line) => ({
          purchaseOrderId,
          description: line.description,
          supplierSku: line.supplierSku,
          quantity: line.quantity,
          unitCostExVAT: line.unitCostExVAT,
          lineTotalExVAT: line.lineTotalExVAT,
          rrp: line.rrp ?? null,
        }))
      );

      // Mark all extracted items as in transit for inventory management
      const inventorySync = await syncInventoryFromPurchaseOrder({
        supplierId,
        purchaseOrderId,
        poLines,
        user_id: user.id,
      });

      // 8. Return success response with all data
      return NextResponse.json({
        success: true,
        data: {
          supplierId,
          purchaseOrderId,
          supplier: extractedData.supplier,
          purchaseOrder: {
            ...extractedData.purchaseOrder,
            currency: 'GBP', // Confirm all values are in GBP
          },
          poLines: extractedData.poLines,
          totals: extractedData.totals,
          savedLines: poLines.length,
          originalCurrency: extractedData.purchaseOrder.originalCurrency,
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
