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
      "unitCostExVAT": number,
      "lineTotalExVAT": number
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
- If both unit price and line total are visible, treat line total as authoritative and ensure:
  unitCostExVAT = lineTotalExVAT / quantity (rounded to 2dp).
- If unitCostExVAT * quantity conflicts with lineTotalExVAT, correct unitCostExVAT from lineTotalExVAT.
- If a field is missing, return null.
- Merge lines across multiple pages.

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
    unitCostExVAT: number;
    lineTotalExVAT: number;
  }>;
  totals: Totals;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeLineMath(lines: ExtractedData['poLines']): ExtractedData['poLines'] {
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
          rrp: null, // RRP not extracted from AI yet, will be added later
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
