import { GoogleGenerativeAI } from '@google/generative-ai';

interface Product {
  id: string;
  name: string;
  primarysku?: string | null;
  suppliersku?: string | null;
  barcodes?: string[];
}

interface NewProductInput {
  externalId: string;
  name: string;
  primarySku?: string | null;
  supplierSku?: string | null;
  barcodes?: string[];
}

export type MatchType = 'exact_sku' | 'exact_barcode' | 'exact_name' | 'ai_suggested' | 'none';

export interface MatchResult {
  externalId: string;
  targetProductId: string | null;
  matchType: MatchType;
  confidence?: number;
}

/**
 * Performs local exact matching (SKU, Barcode, Name) followed by AI semantic matching.
 */
export async function matchProducts(
  newItems: NewProductInput[],
  existingProducts: Product[],
  options: { useAI: boolean; apiKey?: string }
): Promise<MatchResult[]> {
  const results: MatchResult[] = [];
  const unmatched: NewProductInput[] = [];

  // Step 1: Local Exact Matching
  for (const item of newItems) {
    let matched: Product | null = null;
    let type: MatchType = 'none';

    // 1.1 Match by SKU
    const itemSkus = [item.primarySku, item.supplierSku].filter(Boolean).map(s => s!.toLowerCase());
    if (itemSkus.length > 0) {
      matched = existingProducts.find(p => 
        (p.primarysku && itemSkus.includes(p.primarysku.toLowerCase())) ||
        (p.suppliersku && itemSkus.includes(p.suppliersku.toLowerCase()))
      ) || null;
      if (matched) type = 'exact_sku';
    }

    // 1.2 Match by Barcode
    if (!matched && item.barcodes && item.barcodes.length > 0) {
      const barcodeSet = new Set(item.barcodes.map(b => b.toLowerCase()));
      matched = existingProducts.find(p => 
        p.barcodes?.some(b => barcodeSet.has(b.toLowerCase()))
      ) || null;
      if (matched) type = 'exact_barcode';
    }

    // 1.3 Match by Name
    if (!matched) {
      const nameLower = item.name.toLowerCase();
      matched = existingProducts.find(p => p.name.toLowerCase() === nameLower) || null;
      if (matched) type = 'exact_name';
    }

    if (matched) {
      results.push({ externalId: item.externalId, targetProductId: matched.id, matchType: type });
    } else {
      unmatched.push(item);
    }
  }

  // Step 2: AI Semantic Matching (Gemini)
  if (options.useAI && options.apiKey && unmatched.length > 0 && existingProducts.length > 0) {
    try {
      const genAI = new GoogleGenerativeAI(options.apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { responseMimeType: 'application/json' },
      });

      // Split into batches of 50 to avoid prompt limits
      const BATCH_SIZE = 50;
      for (let i = 0; i < unmatched.length; i += BATCH_SIZE) {
        const batch = unmatched.slice(i, i + BATCH_SIZE);
        const toMatchData = batch.map(u => ({ externalId: u.externalId, title: u.name }));
        const candidateData = existingProducts.map(p => ({ id: p.id, name: p.name }));

        const prompt = `You are a product mapping assistant. Match the "Incoming Products" to the "Existing Database" based on semantic similarity of their names.
ONLY return matches where you are 90%+ confident they are the exact same product, potentially with slightly different formatting or missing info.
Incoming Products: ${JSON.stringify(toMatchData)}
Existing Database: ${JSON.stringify(candidateData)}

Respond with a JSON array: [{"externalId": "...", "targetProductId": "..."}]`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const mappings: Array<{ externalId: string; targetProductId: string }> = JSON.parse(responseText);

        for (const mapping of mappings) {
          if (mapping.targetProductId) {
             results.push({
               externalId: mapping.externalId,
               targetProductId: mapping.targetProductId,
               matchType: 'ai_suggested'
             });
          }
        }
      }
    } catch (err) {
      console.error('AI Matching utility failed:', err);
    }
  }

  // Add final 'none' results for anything still missing
  const matchedExternalIds = new Set(results.map(r => r.externalId));
  for (const item of newItems) {
    if (!matchedExternalIds.has(item.externalId)) {
      results.push({ externalId: item.externalId, targetProductId: null, matchType: 'none' });
    }
  }

  return results;
}
