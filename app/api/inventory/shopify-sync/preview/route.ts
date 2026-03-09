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
  
  matchType: 'exact_sku' | 'exact_barcode' | 'ai_suggested' | 'none';
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
      return NextResponse.json(
        { error: 'Shopify account not connected.' },
        { status: 400 }
      );
    }

    const { shopify_store_domain: domain, shopify_access_token: token } = settings;

    const shopifyHeaders = {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    };

    const graphqlQuery = `query getProducts($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            vendor
            productType
            variants(first: 50) {
              edges {
                node {
                  id
                  sku
                  barcode
                  price
                  inventoryQuantity
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
        }
      }
    }`;

    let hasNextPage = true;
    let cursor: string | null = null;
    
    // Fetch existing products to deduplicate and link
    const { data: existingProducts } = await supabase
      .from('products')
      .select('id, name, primarysku, suppliersku, barcodes')
      .eq('user_id', user.id);
    const products = (existingProducts as any[]) || [];

    const previewVariants: PreviewVariant[] = [];

    while (hasNextPage) {
      const response: any = await fetch(`https://${domain}/admin/api/2024-01/graphql.json`, {
        method: 'POST',
        headers: shopifyHeaders,
        body: JSON.stringify({ query: graphqlQuery, variables: { cursor } }),
      }).then(r => r.json());

      if (response.errors) {
        throw new Error(`Shopify GraphQL Error: ${JSON.stringify(response.errors)}`);
      }

      const productsPage = response.data?.products;
      if (!productsPage) break;

      for (const productEdge of productsPage.edges) {
        const p = productEdge.node;
        const variants = p.variants?.edges || [];

        for (const variantEdge of variants) {
          const v = variantEdge.node;
          
          const rawName = p.title || '';
          const primarySku = v.sku || null;
          const barcode = v.barcode || null;
          const price = parseFloat(v.price) || 0;
          const inventoryQuantity = Math.max(0, parseInt(v.inventoryQuantity) || 0);
          
          if (!rawName) continue;

          const previewItem: PreviewVariant = {
            shopifyProductId: p.id,
            shopifyVariantId: v.id,
            title: rawName,
            sku: primarySku,
            barcode: barcode,
            quantity: inventoryQuantity,
            price,
            vendor: p.vendor || null,
            category: p.productType || null,
            inventoryItemId: v.inventoryItem?.id || null,
            matchType: 'none',
            targetProductId: null,
            targetProductName: null,
            action: 'create', // default
          };

          // Try to match existing product exactly
          if (primarySku) {
            const skuLower = primarySku.toLowerCase();
            const skuMatch = products.find(
              (prod: any) =>
                (prod.primarysku && prod.primarysku.toLowerCase() === skuLower) ||
                (prod.suppliersku && prod.suppliersku.toLowerCase() === skuLower)
            );
            if (skuMatch) {
              previewItem.matchType = 'exact_sku';
              previewItem.targetProductId = skuMatch.id;
              previewItem.targetProductName = skuMatch.name;
              previewItem.action = 'update';
            }
          }

          if (previewItem.matchType === 'none' && barcode) {
            const barcodeMatch = products.find((prod: any) => {
              const existing = Array.isArray(prod.barcodes) ? prod.barcodes : [];
              return existing.some((b: string) => b.toLowerCase() === barcode.toLowerCase());
            });
            if (barcodeMatch) {
              previewItem.matchType = 'exact_barcode';
              previewItem.targetProductId = barcodeMatch.id;
              previewItem.targetProductName = barcodeMatch.name;
              previewItem.action = 'update';
            }
          }

          previewVariants.push(previewItem);
        }
      }

      hasNextPage = productsPage.pageInfo.hasNextPage;
      cursor = productsPage.pageInfo.endCursor;
    }

    // Step 2: For unmatched products, try Gemini AI match
    const unmatched = previewVariants.filter(v => v.matchType === 'none');
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && unmatched.length > 0 && products.length > 0) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash',
          generationConfig: { responseMimeType: 'application/json' },
        });

        // Batch if too many, but for now just send up to 100 unmatched
        const toMatch = unmatched.slice(0, 100).map(u => ({ id: u.shopifyVariantId, title: u.title }));
        const candidates = products.map(p => ({ id: p.id, name: p.name }));

        const prompt = `You are a product mapping assistant for an inventory system.
I have a list of Shopify products and a list of internal StockLane products.
Link the shopify products to stocklane products based on semantic similarity of their names, especially looking for identical items.
ONLY return links where you are highly confident they represent the exact same product. 
Often product names have slight prefix/suffixes like "- Large" or different casing, handle those smartly.

Shopify Products: ${JSON.stringify(toMatch)}
StockLane Products: ${JSON.stringify(candidates)}

Respond with a JSON array in exactly this format:
[{"shopifyVariantId": "...", "stocklaneProductId": "..."}]`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const mappings: { shopifyVariantId: string, stocklaneProductId: string }[] = JSON.parse(responseText);

        for (const mapping of mappings) {
          const item = previewVariants.find((v: any) => v.shopifyVariantId === mapping.shopifyVariantId);
          const target = products.find((p: any) => p.id === mapping.stocklaneProductId);
          if (item && target && item.matchType === 'none') {
            item.matchType = 'ai_suggested';
            item.targetProductId = target.id;
            item.targetProductName = target.name;
            item.action = 'update';
          }
        }
      } catch (aiErr) {
        console.error('AI Matching failed:', aiErr);
      }
    }

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
