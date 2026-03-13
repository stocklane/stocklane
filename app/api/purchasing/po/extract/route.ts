import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { suggestInvoiceLineMatches, type MatchableProduct } from '@/lib/invoice-line-matching';

// Force Node.js runtime for pdf-parse
export const runtime = 'nodejs';

// Function to get current exchange rates
async function getExchangeRates(): Promise<{ [key: string]: number }> {
  try {
    // Using exchangerate-api.com free tier (no API key needed for basic usage)
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/GBP');
    if (!response.ok) {
      console.warn('Failed to fetch exchange rates, using fallback rates');
      return getFallbackRates();
    }
    const data = await response.json();
    // Convert to rates FROM other currencies TO GBP
    const rates: { [key: string]: number } = {};
    for (const [currency, rate] of Object.entries(data.rates)) {
      rates[currency] = 1 / (rate as number);
    }
    return rates;
  } catch (error) {
    console.warn('Error fetching exchange rates, using fallback:', error);
    return getFallbackRates();
  }
}

// Fallback exchange rates (approximate, updated Nov 2024)
// These are rates TO convert TO GBP (multiply foreign currency by this rate)
function getFallbackRates(): { [key: string]: number } {
  return {
    'GBP': 1.0,
    'USD': 0.79,      // 1 USD = 0.79 GBP
    'EUR': 0.85,      // 1 EUR = 0.85 GBP
    'JPY': 0.00493,   // 1 JPY = 0.00493 GBP (667,996 JPY = ~3,290 GBP)
    'AUD': 0.52,      // 1 AUD = 0.52 GBP
    'CAD': 0.57,      // 1 CAD = 0.57 GBP
    'CHF': 0.90,      // 1 CHF = 0.90 GBP
    'CNY': 0.11,      // 1 CNY = 0.11 GBP
    'SEK': 0.075,     // 1 SEK = 0.075 GBP
    'NZD': 0.48,      // 1 NZD = 0.48 GBP
  };
}

// Gemini prompt for structured data extraction
function getExtractionPrompt(exchangeRates: { [key: string]: number }): string {
  const ratesList = Object.entries(exchangeRates)
    .slice(0, 10)
    .map(([curr, rate]) => `${curr}: ${rate.toFixed(4)}`)
    .join(', ');

  return `You are an expert at extracting structured data from invoices and delivery notes.

Extract the following information from the invoice/delivery note image(s) and return it as a JSON object:

{
  "supplier": {
    "name": "Company name",
    "address": "Full address",
    "email": "Email if present",
    "phone": "Phone if present",
    "vatNumber": "VAT/Tax number if present"
  },
  "purchaseOrder": {
    "invoiceNumber": "Invoice or delivery note number",
    "invoiceDate": "Date in YYYY-MM-DD format",
    "originalCurrency": "Original currency code on invoice (e.g., GBP, USD, EUR)",
    "paymentTerms": "Payment terms if mentioned"
  },
  "poLines": [
    {
      "description": "Item description",
      "supplierSku": "Item code/SKU (alphanumeric product code, NOT the quantity)",
      "quantity": number,
      "unitCostExVAT": number,
      "lineTotalExVAT": number,
      "rrp": number
    }
  ],
  "totals": {
    "subtotal": number,
    "extras": number,
    "vat": number,
    "total": number
  }
}

**CURRENCY HANDLING - CRITICAL - READ CAREFULLY:**

Exchange rates the SERVER will use to convert TO GBP (for your reference ONLY, do not apply them yourself): ${ratesList}

**CURRENCY DETECTION:**
- Look for currency symbols: £ (GBP), $ (USD), € (EUR), ¥ (JPY/CNY), etc.
- Common currency indicators:
  * £ or GBP or "Pound" = GBP (no conversion needed)
  * $ or USD or "Dollar" = USD
  * € or EUR or "Euro" = EUR
  * ¥ or JPY or "Yen" = JPY (Japanese Yen)
  * ¥ or CNY or "Yuan" or "RMB" = CNY (Chinese Yuan)
- **IMPORTANT**: If you see ¥ symbol, check the supplier location/language:
  * Japanese text/supplier = JPY
  * Chinese text/supplier = CNY
- Store the ORIGINAL currency in "originalCurrency" field (e.g., "JPY", "USD", "EUR")

**NO CURRENCY CONVERSION BY YOU:**
- Do NOT convert any numbers to GBP.
- Always output all monetary values (unit costs, line totals, subtotal, extras, VAT, total) in the ORIGINAL invoice currency.
- The server will use the originalCurrency and the exchange rates above to convert everything to GBP.

**PACK SIZE & UNIT EXPANSION (CRITICAL):**
- You MUST detect if an item contains multiple units (e.g., "12 units at £9.99", "CDU (10)", "Case: 12").
- Check ALL columns (Description, RRP, Price, Units) for patterns like "X units" or "X items".
- If you see a pattern like "X units at £Y", then "X" is the pack size and "Y" is the RRP.
- You MUST multiply the invoice quantity by the pack size "X" to get the total individual units.
- **IMPORTANT**: Your final "quantity" should represent individual units.
- **Example**: Invoice says "Quantity: 1" and "12 units at £9.99". Your JSON: quantity: 12, rrp: 9.99, packSize: 12.
- **Example**: Invoice says "Quantity: 4" and "Description: CDU (10)". Your JSON: quantity: 40, packSize: 10.
- When you expand quantity, unitCostExVAT MUST be (lineTotal / quantity).

**RRP (Recommended Retail Price) Extraction:**
- ONLY extract the numeric currency value (e.g., 9.99).
- If no RRP price is found, return null.

**SKU/Item Code Extraction:**
- Extract product codes into "supplierSku". Do NOT use quantity or price as SKU.

**Totals:**
- Extract subtotal, extras (shipping), VAT, and grand total.

Combine all pages. Return ONLY valid JSON.`;
}

interface ExtractedData {
  supplier: {
    name: string;
    address?: string;
    email?: string;
    phone?: string;
    vatNumber?: string;
  };
  purchaseOrder: {
    invoiceNumber: string;
    invoiceDate: string;
    originalCurrency: string;
    paymentTerms?: string;
  };
  poLines: Array<{
    description: string;
    supplierSku?: string;
    quantity: number;
    packSize?: number | null;
    unitCostExVAT: number;
    lineTotalExVAT: number;
    rrp?: number | null;
  }>;
  totals: {
    subtotal: number;
    extras: number;
    vat: number;
    total: number;
  };
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function parseMoney(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLineMath(extractedData: ExtractedData): void {
  extractedData.poLines = (extractedData.poLines || []).map((line) => {
    let quantity = parseMoney(line.quantity);
    let unitCostExVAT = parseMoney(line.unitCostExVAT);
    let lineTotalExVAT = parseMoney(line.lineTotalExVAT);
    let rrp = typeof line.rrp === 'number' ? line.rrp : null;
    
    // --- HEURISTIC SAFETY NET ---
    const commonMultipliers = [6, 8, 10, 12, 18, 24, 30, 36, 40, 50, 60, 100];
    const desc = (line.description || '').toLowerCase();
    const hasPackKeywords = desc.includes('cdu') || desc.includes('box') || desc.includes('pack') || 
                            desc.includes('display') || desc.includes('units') || desc.includes('(') ||
                            desc.includes('collection');

    if (rrp !== null && commonMultipliers.includes(rrp) && quantity <= 10 && hasPackKeywords) {
      if (lineTotalExVAT > 0) {
        const isTotalPriceInUnit = Math.abs(unitCostExVAT - lineTotalExVAT) < 0.05;
        if (isTotalPriceInUnit || quantity < rrp) {
          quantity = quantity * rrp;
          unitCostExVAT = roundMoney(lineTotalExVAT / quantity);
          rrp = null; // Clear multiplier from RRP
        }
      }
    }

    // Force individual unit calculation if packSize was extracted or implied by keywords
    const pSize = typeof line.packSize === 'number' ? line.packSize : 1;
    let multiplier = pSize;

    // Special case for "Collection" items which are often 12 units at Esdevium
    if (multiplier === 1 && desc.includes('collection') && quantity === 1 && lineTotalExVAT > 60) {
      // If a single 'collection' bundle is > £60, it's almost certainly a box of units
      // Check if total / 12 ~= common unit price
      const impliedUnit = lineTotalExVAT / 12;
      if (impliedUnit > 4 && impliedUnit < 10) {
        multiplier = 12;
      }
    }

    if (multiplier > 1 && quantity < multiplier && quantity > 0 && quantity <= 10) {
      // AI likely put box count in quantity instead of units
      quantity = quantity * multiplier;
      unitCostExVAT = roundMoney(lineTotalExVAT / quantity);
    }

    if (quantity > 0) {
      if (lineTotalExVAT > 0) {
        unitCostExVAT = roundMoney(lineTotalExVAT / quantity);
      } else if (unitCostExVAT > 0) {
        lineTotalExVAT = roundMoney(unitCostExVAT * quantity);
      }
    }

    return {
      ...line,
      quantity,
      unitCostExVAT: roundMoney(Math.max(0, unitCostExVAT)),
      lineTotalExVAT: roundMoney(Math.max(0, lineTotalExVAT)),
      rrp
    };
  });

  if (extractedData.totals) {
    const computedSubtotal = roundMoney(
      extractedData.poLines.reduce((sum, line) => sum + (line.lineTotalExVAT || 0), 0),
    );
    const subtotal = parseMoney(extractedData.totals.subtotal);
    const subtotalDiff = Math.abs(subtotal - computedSubtotal);
    const subtotalTolerance = Math.max(1, roundMoney(computedSubtotal * 0.05));
    if (subtotal <= 0 || subtotalDiff > subtotalTolerance) {
      extractedData.totals.subtotal = computedSubtotal;
    }
  }
}

function convertToGBP(extractedData: ExtractedData, exchangeRates: { [key: string]: number }) {
  const originalCurrencyRaw = extractedData.purchaseOrder?.originalCurrency;
  if (!originalCurrencyRaw) {
    return;
  }

  const originalCurrency = originalCurrencyRaw.trim().toUpperCase();
  const rate = exchangeRates[originalCurrency];

  if (!rate || originalCurrency === 'GBP') {
    return;
  }

  const convert = (value: unknown): number => {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    if (isNaN(num)) return 0;
    return Number((num * rate).toFixed(2));
  };

  extractedData.poLines = extractedData.poLines.map((line) => {
    const quantity = typeof line.quantity === 'number'
      ? line.quantity
      : parseFloat(String(line.quantity)) || 0;

    const convertedUnit = convert(line.unitCostExVAT);
    const convertedLine = convert(line.lineTotalExVAT);

    let unitCostExVAT = convertedUnit;
    let lineTotalExVAT = convertedLine;

    if (quantity > 0) {
      if (convertedLine > 0) {
        // Prefer the line total as source of truth when present
        lineTotalExVAT = convertedLine;
        unitCostExVAT = roundMoney(convertedLine / quantity);
      } else if (convertedUnit > 0) {
        // Fallback: derive line total from unit cost
        unitCostExVAT = convertedUnit;
        lineTotalExVAT = roundMoney(convertedUnit * quantity);
      } else {
        unitCostExVAT = 0;
        lineTotalExVAT = 0;
      }
    }

    return {
      ...line,
      quantity,
      unitCostExVAT,
      lineTotalExVAT,
    };
  });

  if (extractedData.totals) {
    const { subtotal, extras, vat, total } = extractedData.totals;
    extractedData.totals = {
      subtotal: convert(subtotal),
      extras: convert(extras),
      vat: convert(vat),
      total: convert(total),
    };
  }
}

// POST endpoint to extract data from invoice (without saving)
export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    // SECURITY: Rate limit – AI extraction is expensive, but repeated review retries
    // are part of normal use during PO import, so keep enough headroom for that flow.
    const blocked = applyRateLimit(request, user.id, { limit: 30, windowMs: 60_000 });
    if (blocked) return blocked;

    // 1. Get API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Gemini API key not configured' },
        { status: 500 }
      );
    }

    // 2. Get uploaded files
    const formData = await request.formData();
    const fileCountRaw = parseInt(formData.get('fileCount') as string || '1');
    // SECURITY: Cap file count to prevent abuse
    const fileCount = Math.min(Math.max(1, fileCountRaw), 20);
    
    const files: File[] = [];
    for (let i = 0; i < fileCount; i++) {
      const file = formData.get(`file${i}`) as File;
      if (file) {
        files.push(file);
      }
    }

    // Fallback to single file if fileCount not provided
    if (files.length === 0) {
      const singleFile = formData.get('file') as File;
      if (singleFile) {
        files.push(singleFile);
      }
    }

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files uploaded' },
        { status: 400 }
      );
    }

    // 3. Get current exchange rates
    const exchangeRates = await getExchangeRates();

    // 4. Prepare all files for Gemini
    const fileParts = [];
    for (const file of files) {
      // Validate file type - images or PDF
      const isImage = file.type.startsWith('image/');
      const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      
      if (!isImage && !isPDF) {
        return NextResponse.json(
          { error: `Invalid file type: ${file.name}. Please upload image files (PNG, JPG) or PDFs.` },
          { status: 400 }
        );
      }

      // SECURITY: Cap individual file size to 20 MB
      const MAX_FILE_BYTES = 20 * 1024 * 1024;
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `File "${file.name}" exceeds the 20 MB size limit.` },
          { status: 400 }
        );
      }

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64Data = buffer.toString('base64');
      
      // Determine MIME type
      let mimeType = file.type;
      if (isPDF && !mimeType) {
        mimeType = 'application/pdf';
      }

      fileParts.push({
        inlineData: {
          data: base64Data,
          mimeType: mimeType,
        },
      });
    }

    // 5. Send to Gemini API v1 endpoint directly (bypass SDK)
    const extractionPrompt = getExtractionPrompt(exchangeRates);
    const prompt = extractionPrompt + `\n\nPlease analyze ${files.length === 1 ? 'this invoice document' : `these ${files.length} invoice documents (they are all part of the same order)`} and extract the data.`;
    
    const requestBody = {
      contents: [{
        parts: [
          { text: prompt },
          ...fileParts
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
        { error: `Failed to process files: ${error instanceof Error ? error.message : 'Unknown error'}` },
        { status: 500 }
      );
    }

    // 5. Parse JSON response from Gemini
    let extractedData: ExtractedData;
    try {
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(cleanedText);
    } catch (error) {
      console.error('JSON parsing error:', error);
      console.error('Raw response:', text);
      return NextResponse.json(
        { error: 'Failed to parse AI response as JSON' },
        { status: 500 }
      );
    }

    // 6. Convert all monetary values from original currency to GBP using live exchange rates
    convertToGBP(extractedData, exchangeRates);
    normalizeLineMath(extractedData);

    // 7. Sanity check: if sum of line totals is way off from the invoice total,
    //    the AI likely confused unit costs with line totals. Auto-correct.
    if (extractedData.totals?.total > 0 && extractedData.poLines.length > 0) {
      const lineSum = extractedData.poLines.reduce((s, l) => s + (l.lineTotalExVAT || 0), 0);
      const invoiceTotal = extractedData.totals.total;
      // If line items sum to more than 1.5× the invoice total, the prices were likely
      // line totals that the AI treated as unit costs (then multiplied by quantity again)
      if (lineSum > invoiceTotal * 1.5) {
        extractedData.poLines = extractedData.poLines.map((line) => {
          const qty = line.quantity || 1;
          // The current unitCostExVAT is actually the line total; fix it
          const correctedLineTotal = line.unitCostExVAT;
          const correctedUnit = Number((correctedLineTotal / qty).toFixed(2));
          return {
            ...line,
            unitCostExVAT: correctedUnit,
            lineTotalExVAT: Number(correctedLineTotal.toFixed(2)),
          };
        });
        // Recalculate subtotal
        const newSubtotal = extractedData.poLines.reduce((s, l) => s + l.lineTotalExVAT, 0);
        extractedData.totals.subtotal = roundMoney(newSubtotal);
      }
    }

    // 8. Return extracted data WITHOUT saving to database
    // Note: We allow incomplete data - user can fill in missing fields in the UI
    const { data: products } = await supabase
      .from('products')
      .select('id, name, primarysku, suppliersku, barcodes, aliases')
      .eq('user_id', user.id);

    const typedProducts = (products || []) as MatchableProduct[];

    const productOptions = typedProducts.map((product) => ({
      id: product.id as string,
      name: product.name as string,
      primarySku: product.primarysku ?? null,
      supplierSku: product.suppliersku ?? null,
    }));

    const lineMatches = suggestInvoiceLineMatches(
      extractedData.poLines.map((line) => ({
        description: line.description,
        supplierSku: line.supplierSku ?? null,
      })),
      typedProducts,
    );

    return NextResponse.json({
      success: true,
      data: extractedData,
      lineMatches,
      productOptions,
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
