export interface InvoiceLineInput {
  description: string;
  supplierSku?: string | null;
}

export interface MatchableProduct {
  id: string;
  name: string;
  primarysku?: string | null;
  suppliersku?: string | null;
  barcodes?: string[] | null;
  aliases?: string[] | null;
}

export type InvoiceMatchType =
  | 'exact_primary_sku'
  | 'exact_supplier_sku'
  | 'exact_barcode'
  | 'exact_name'
  | 'alias'
  | 'fuzzy_name';

export interface InvoiceLineSuggestion {
  productId: string;
  productName: string;
  primarySku: string | null;
  supplierSku: string | null;
  matchType: InvoiceMatchType;
  confidence: number;
  reason: string;
}

export interface InvoiceLineMatchResult {
  suggestions: InvoiceLineSuggestion[];
  suggestedProductId: string | null;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string | null | undefined): string[] {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function computeTokenSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);

  let intersection = 0;
  aSet.forEach((token) => {
    if (bSet.has(token)) {
      intersection += 1;
    }
  });

  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function upsertSuggestion(
  suggestions: Map<string, InvoiceLineSuggestion>,
  suggestion: InvoiceLineSuggestion,
) {
  const existing = suggestions.get(suggestion.productId);
  if (!existing || suggestion.confidence > existing.confidence) {
    suggestions.set(suggestion.productId, suggestion);
  }
}

export function suggestInvoiceLineMatches(
  lines: InvoiceLineInput[],
  products: MatchableProduct[],
): InvoiceLineMatchResult[] {
  return lines.map((line) => {
    const suggestions = new Map<string, InvoiceLineSuggestion>();
    const normalizedSku = (line.supplierSku || '').trim().toLowerCase();
    const normalizedDescription = normalizeText(line.description);

    if (normalizedSku) {
      for (const product of products) {
        const primarySku = (product.primarysku || '').trim().toLowerCase();
        const supplierSku = (product.suppliersku || '').trim().toLowerCase();
        const barcodes = (product.barcodes || []).map((barcode) => barcode.trim().toLowerCase());

        if (primarySku && primarySku === normalizedSku) {
          upsertSuggestion(suggestions, {
            productId: product.id,
            productName: product.name,
            primarySku: product.primarysku ?? null,
            supplierSku: product.suppliersku ?? null,
            matchType: 'exact_primary_sku',
            confidence: 1,
            reason: `Exact StockLane SKU match on ${product.primarysku}`,
          });
        }

        if (supplierSku && supplierSku === normalizedSku) {
          upsertSuggestion(suggestions, {
            productId: product.id,
            productName: product.name,
            primarySku: product.primarysku ?? null,
            supplierSku: product.suppliersku ?? null,
            matchType: 'exact_supplier_sku',
            confidence: 0.99,
            reason: `Exact supplier SKU match on ${product.suppliersku}`,
          });
        }

        if (barcodes.includes(normalizedSku)) {
          upsertSuggestion(suggestions, {
            productId: product.id,
            productName: product.name,
            primarySku: product.primarysku ?? null,
            supplierSku: product.suppliersku ?? null,
            matchType: 'exact_barcode',
            confidence: 0.98,
            reason: `Barcode matches invoice SKU ${line.supplierSku}`,
          });
        }
      }
    }

    if (normalizedDescription) {
      for (const product of products) {
        const normalizedProductName = normalizeText(product.name);

        if (normalizedProductName && normalizedProductName === normalizedDescription) {
          upsertSuggestion(suggestions, {
            productId: product.id,
            productName: product.name,
            primarySku: product.primarysku ?? null,
            supplierSku: product.suppliersku ?? null,
            matchType: 'exact_name',
            confidence: 0.96,
            reason: 'Exact product name match',
          });
          continue;
        }

        const aliases = product.aliases || [];
        const matchedAlias = aliases.find((alias) => normalizeText(alias) === normalizedDescription);
        if (matchedAlias) {
          upsertSuggestion(suggestions, {
            productId: product.id,
            productName: product.name,
            primarySku: product.primarysku ?? null,
            supplierSku: product.suppliersku ?? null,
            matchType: 'alias',
            confidence: 0.94,
            reason: `Invoice description matches saved alias "${matchedAlias}"`,
          });
          continue;
        }

        const bestAliasSimilarity = aliases.reduce((best, alias) => {
          return Math.max(best, computeTokenSimilarity(line.description, alias));
        }, 0);
        const nameSimilarity = computeTokenSimilarity(line.description, product.name);
        const similarity = Math.max(nameSimilarity, bestAliasSimilarity);

        if (similarity >= 0.72) {
          upsertSuggestion(suggestions, {
            productId: product.id,
            productName: product.name,
            primarySku: product.primarysku ?? null,
            supplierSku: product.suppliersku ?? null,
            matchType: 'fuzzy_name',
            confidence: Number(similarity.toFixed(2)),
            reason: `Similar product name (${Math.round(similarity * 100)}% confidence)`,
          });
        }
      }
    }

    const rankedSuggestions = Array.from(suggestions.values()).sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return a.productName.localeCompare(b.productName);
    });

    return {
      suggestions: rankedSuggestions.slice(0, 3),
      suggestedProductId: rankedSuggestions[0]?.productId ?? null,
    };
  });
}
