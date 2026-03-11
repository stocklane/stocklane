import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-helpers';
import { applyRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

interface PreviewVariant {
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  quantity: number;
  price: number;
  vendor: string | null;
  category: string | null;
  inventoryItemId: string | null;
  
  matchType: 'exact_sku' | 'exact_barcode' | 'exact_name' | 'ai_suggested' | 'none';
  targetProductId: string | null;
  targetProductName: string | null;
  action: 'create' | 'update' | 'ignore';
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireAuth(request);

    // SECURITY: Rate limit
    const blocked = applyRateLimit(request, user.id, { limit: 5, windowMs: 60_000 });
    if (blocked) return blocked;

    // Get the user's Shopify credentials
    const { data: settings } = await supabase
      .from('user_settings')
      .select('shopify_store_domain, shopify_access_token')
      .eq('user_id', user.id)
      .single();

    if (!settings?.shopify_store_domain || !settings?.shopify_access_token) {
      return NextResponse.json({ error: 'Shopify account not connected.' }, { status: 400 });
    }

    const { shopify_store_domain: domain, shopify_access_token: token } = settings;
    const shopifyHeaders = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    const graphqlQuery = `query getProducts($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title vendor productType
            variants(first: 50) {
              edges {
                node {
                  id title sku barcode price inventoryQuantity
                  inventoryItem { id }
                }
              }
            }
          }
        }
      }
    }`;

    let hasNextPage = true;
    let cursor: string | null = null;
    
    // 1) Fetch existing products for lookup
    const { data: existingProducts } = await supabase
      .from('products')
      .select('id, name, primarysku, suppliersku, barcodes')
      .eq('user_id', user.id);
    const products = (existingProducts as any[]) || [];

    const rawVariants: any[] = [];
    while (hasNextPage) {
      const response: any = await fetch(`https://${domain}/admin/api/2024-01/graphql.json`, {
        method: 'POST',
        headers: shopifyHeaders,
        body: JSON.stringify({ query: graphqlQuery, variables: { cursor } }),
      }).then(r => r.json());

      if (response.errors) throw new Error(`Shopify GraphQL Error: ${JSON.stringify(response.errors)}`);
      const productsPage = response.data?.products;
      if (!productsPage) break;

      for (const productEdge of productsPage.edges) {
        const p = productEdge.node;
        for (const variantEdge of p.variants?.edges || []) {
          const v = variantEdge.node;
          rawVariants.push({
            pId: p.id,
            vId: v.id,
            title: v.title && v.title !== 'Default Title' ? `${p.title} (${v.title})` : p.title,
            sku: v.sku,
            barcode: v.barcode,
            qty: Math.max(0, parseInt(v.inventoryQuantity) || 0),
            price: parseFloat(v.price) || 0,
            vendor: p.vendor,
            type: p.productType,
            invId: v.inventoryItem?.id,
          });
        }
      }
      hasNextPage = productsPage.pageInfo.hasNextPage;
      cursor = productsPage.pageInfo.endCursor;
    }

    // 2) Batch Match using unified logic
    const { matchProducts } = await import('@/lib/ai-matching');
    const matchResults = await matchProducts(
      rawVariants.map(rv => ({
        externalId: rv.vId,
        name: rv.title,
        primarySku: rv.sku,
        barcodes: rv.barcode ? [rv.barcode] : [],
      })),
      products,
      { useAI: !!process.env.GEMINI_API_KEY, apiKey: process.env.GEMINI_API_KEY }
    );

    const resultsByVId = new Map(matchResults.map(r => [r.externalId, r]));
    const productsById = new Map(products.map(p => [p.id, p]));

    const previewVariants: PreviewVariant[] = rawVariants.map(rv => {
      const match = resultsByVId.get(rv.vId);
      const target = match?.targetProductId ? productsById.get(match.targetProductId) : null;

      return {
        shopifyProductId: rv.pId,
        shopifyVariantId: rv.vId,
        title: rv.title,
        sku: rv.sku,
        barcode: rv.barcode,
        quantity: rv.qty,
        price: rv.price,
        vendor: rv.vendor,
        category: rv.type,
        inventoryItemId: rv.invId,
        matchType: (match?.matchType === 'exact_name' ? 'none' : match?.matchType) as any || 'none', // Shopify preview UI expects specific types
        targetProductId: target?.id || null,
        targetProductName: target?.name || null,
        action: target ? 'update' : 'create',
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        variants: previewVariants,
        localProducts: products.map(p => ({ id: p.id, name: p.name, primarysku: p.primarysku }))
      }
    });

  } catch (error: any) {
    console.error('Shopify Sync Preview Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to generate sync preview' }, { status: 500 });
  }
}
