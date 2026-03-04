import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';

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

**SKU/Item Code Extraction (VERY IMPORTANT):**
- Look for product codes in a dedicated column or field, often labeled: "SKU", "Item #", "Code", "Product Code", "Item Code", "Part #", "Ref", "Article No"
- SKUs are typically alphanumeric codes like: "TCG-001", "ABC123", "PROD-2024-001", "12345-A"
- SKUs are usually positioned BEFORE or AFTER the description, in their own column
- DO NOT extract the quantity as the SKU - quantity is always a simple number (1, 2, 10, etc.)
- DO NOT extract prices, dates, or invoice numbers as SKUs
- If you see a column with mixed alphanumeric codes next to descriptions, that's likely the SKU
- If no clear SKU column exists, leave supplierSku as empty string or null
- When in doubt, prefer leaving it empty rather than guessing incorrectly

**RRP (Recommended Retail Price) Extraction:**
- Look for columns labeled: "RRP", "Retail Price", "MSRP", "Recommended Price", "Selling Price", "List Price"
- RRP is usually higher than the unit cost and represents the suggested selling price
- Common on distributor invoices, especially for retail goods like trading cards, games, collectibles
- If multiple price columns exist, RRP is typically the highest price (excluding VAT)
- If no RRP is clearly indicated, set rrp to null - do NOT guess or use unit cost
- RRP should be in the same currency as other prices on the invoice
- Look for text like "RRP:" or "Retail:" followed by a price

**UNIT COST vs LINE TOTAL - CRITICAL:**
- Each line item has a quantity, a unit cost (price per single unit), and a line total (quantity × unit cost).
- Some invoices only show ONE price per line (not both unit cost and line total).
- If the table has BOTH a PRICE and TOTAL column, treat TOTAL as authoritative for lineTotalExVAT.
- In that case, compute unitCostExVAT = lineTotalExVAT / quantity (rounded to 2dp) if needed.
- If PRICE × quantity conflicts with TOTAL, prefer TOTAL and recompute unitCostExVAT from TOTAL.
- When only ONE price is shown per line, you MUST determine if it is the unit cost or line total:
  1. Sum ALL the single prices across all line items.
  2. Compare that sum to the invoice subtotal/total (ignoring shipping/extras/VAT).
  3. If the sum of prices ≈ the subtotal/total → the prices are LINE TOTALS. Calculate unit cost = price / quantity.
  4. If the sum of (price × quantity) ≈ the subtotal/total → the prices are UNIT COSTS. Calculate line total = price × quantity.
- Example: "5 Widget ¥53,500" with invoice total ≈ sum of all such prices → ¥53,500 is the LINE TOTAL, unit cost = ¥53,500 / 5 = ¥10,700.
- ALWAYS verify: the sum of all lineTotalExVAT values should approximately equal the subtotal.

**Other Important Rules:**
- If multiple files/pages are provided, they are ALL part of the SAME invoice/order - combine all data
- Extract ALL line items from ALL documents/pages
- **EXTRAS field**: Extract shipping, delivery, handling, freight, postage charges here (NOT part of poLines). Set to 0 if none.
- **SUBTOTAL**: Sum of all line items BEFORE extras and VAT
- **TOTAL**: subtotal + extras + VAT
- If a field is not present, use null or empty string (use 0 for numeric fields like extras)
- Ensure all numbers are numeric values, not strings
- Combine line items from all pages into a single poLines array`;
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
    unitCostExVAT: number;
    lineTotalExVAT: number;
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
    const quantityRaw = parseMoney(line.quantity);
    const quantity = quantityRaw > 0 ? quantityRaw : 0;
    let unitCostExVAT = parseMoney(line.unitCostExVAT);
    let lineTotalExVAT = parseMoney(line.lineTotalExVAT);

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
          // When OCR disagrees, prefer explicit line total and recompute unit.
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
    const { user } = await requireAuth(request);

    // SECURITY: Rate limit – AI extraction is expensive, allow 10 requests/min
    const blocked = applyRateLimit(request, user.id, { limit: 10, windowMs: 60_000 });
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
    return NextResponse.json({
      success: true,
      data: extractedData,
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
