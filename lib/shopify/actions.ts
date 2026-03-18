import { getShopifyConfig, shopifyFetch } from './client';

interface DraftProductInput {
  name: string | null | undefined;
}

/**
 * Calculates the automated Shopify price based on the margin engine logic.
 */
export function calculateAutomatedPrice(params: {
  averageCost: number;
  postagePackaging: number;
  targetMargin: number;
  salesTaxPct: number;
  shopifyFeePct: number;
}) {
  const targetMarginPct = Number(params.targetMargin);
  if (targetMarginPct <= 0 || targetMarginPct >= 100) return null;

  const marginRate = targetMarginPct / 100;
  const taxRate = Math.max(0, params.salesTaxPct) / 100;
  const feeRate = Math.max(0, params.shopifyFeePct) / 100;
  const variableDeductions = taxRate + feeRate;

  if (marginRate >= 1 || variableDeductions >= 1) return null;

  const unitCost = Math.max(0, params.averageCost) + Math.max(0, params.postagePackaging);
  const requiredNet = unitCost / (1 - marginRate);
  const newPrice = requiredNet / (1 - variableDeductions);
  return Math.max(0, newPrice).toFixed(2);
}

async function getPrimaryLocationId(userId: string) {
  const config = await getShopifyConfig(userId);
  const locationData = await shopifyFetch(config, `
    query {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  `);

  const locationId = locationData.locations.edges[0]?.node.id;
  if (!locationId) {
    throw new Error('No Shopify location found');
  }

  return { config, locationId };
}

async function enableInventoryTracking(inventoryItemId: string, userId: string) {
  const config = await getShopifyConfig(userId);
  const mutation = `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
          tracked
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyFetch(config, mutation, {
    id: inventoryItemId,
    input: {
      tracked: true,
    },
  });
  const userErrors = result.inventoryItemUpdate.userErrors;
  if (userErrors.length > 0) {
    throw new Error(`Shopify Inventory Tracking Error: ${userErrors[0].message}`);
  }
}

async function ensureInventoryLevel(inventoryItemId: string, userId: string) {
  const { config, locationId } = await getPrimaryLocationId(userId);
  const mutation = `
    mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
        inventoryLevel {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyFetch(config, mutation, {
    inventoryItemId,
    locationId,
  });
  const userErrors = result.inventoryActivate.userErrors;
  if (userErrors.length > 0) {
    const message = userErrors[0].message || '';
    if (!message.toLowerCase().includes('already')) {
      throw new Error(`Shopify Inventory Activation Error: ${message}`);
    }
  }
}

/**
 * Sets inventory quantity on Shopify to an absolute value
 */
export async function syncShopifyInventory(inventoryItemId: string, quantity: number, userId: string) {
  await enableInventoryTracking(inventoryItemId, userId);
  await ensureInventoryLevel(inventoryItemId, userId);

  const { config, locationId } = await getPrimaryLocationId(userId);

  const mutation = `
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity: Math.max(0, quantity)
        }
      ]
    }
  };

  const result = await shopifyFetch(config, mutation, variables);
  const userErrors = result.inventorySetQuantities.userErrors;
  
  if (userErrors.length > 0) {
    throw new Error(`Shopify Inventory Sync Error: ${userErrors[0].message}`);
  }
}

/**
 * Updates a product metadata on Shopify
 */
export async function updateShopifyProduct(shopifyProductId: string, updates: { title?: string }, userId: string) {
  const config = await getShopifyConfig(userId);

  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyFetch(config, mutation, {
    input: {
      id: shopifyProductId,
      ...updates
    }
  });

  const userErrors = result.productUpdate.userErrors;
  if (userErrors.length > 0) {
    throw new Error(`Shopify Product Update Error: ${userErrors[0].message}`);
  }
}

/**
 * Updates a product variant price on Shopify
 */
export async function updateShopifyPrice(variantId: string, price: string, userId: string) {
  const config = await getShopifyConfig(userId);

  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // We need the productId to use bulkUpdate, so we might need to fetch it or change the signature.
  // However, for now, let's try the modern singular variant update if available, or fetch productId.
  // Actually, variantId in Shopify GID usually contains the variant numerical ID, but not product ID.
  
  // Let's use the older productVariantUpdate but check if it's actually removed. 
  // It was deprecated but might still work if we use the right version. 
  // Given the previous error "Field 'productVariantUpdate' doesn't exist on type 'Mutation'", 
  // it seems it IS removed in their specific environment/version.
  
  // We'll need to fetch the productId first if we only have variantId.
  const queryProduct = `
    query getVariantProduct($id: ID!) {
      productVariant(id: $id) {
        product {
          id
        }
      }
    }
  `;
  const productData = await shopifyFetch(config, queryProduct, { id: variantId });
  const productId = productData.productVariant.product.id;

  const variables = {
    productId,
    variants: [
      {
        id: variantId,
        price: price
      }
    ]
  };

  const result = await shopifyFetch(config, mutation, variables);
  const userErrors = result.productVariantsBulkUpdate.userErrors;

  if (userErrors.length > 0) {
    throw new Error(`Shopify Price Sync Error: ${userErrors[0].message}`);
  }
}

/**
 * Pushes a new product to Shopify as a draft and returns the created IDs
 */
export async function pushDraftProductToShopify(
  product: DraftProductInput,
  sku: string,
  userId: string,
  initialQuantity?: number,
) {
  const config = await getShopifyConfig(userId);

  // 1. Create the product (Shopify creates one default variant)
  const createMutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          variants(first: 1) {
            edges {
              node {
                id
                inventoryItem {
                  id
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const createResult = await shopifyFetch(config, createMutation, {
    input: {
      title: product.name,
      vendor: 'StockLane',
      status: 'DRAFT'
    }
  });

  const createErrors = createResult.productCreate.userErrors;
  if (createErrors.length > 0) {
    throw new Error(`Shopify Product Creation Error: ${createErrors[0].message}`);
  }

  const shopifyProduct = createResult.productCreate.product;
  const variantId = shopifyProduct.variants.edges[0].node.id;
  const inventoryItemId = shopifyProduct.variants.edges[0].node.inventoryItem.id;

  // 2. Update the variant with SKU and tracking
  const variantUpdateMutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variantUpdateResult = await shopifyFetch(config, variantUpdateMutation, {
    productId: shopifyProduct.id,
    variants: [
      {
        id: variantId,
        inventoryItem: {
          sku: sku,
          tracked: true
        }
      }
    ]
  });

  if (variantUpdateResult.productVariantsBulkUpdate.userErrors.length > 0) {
    throw new Error(`Shopify Variant Update Error: ${variantUpdateResult.productVariantsBulkUpdate.userErrors[0].message}`);
  }

  // 3. Activate at location
  await ensureInventoryLevel(inventoryItemId, userId);

  // 4. If we have initial quantity, sync it
  if (initialQuantity && initialQuantity > 0) {
    await syncShopifyInventory(inventoryItemId, initialQuantity, userId);
  }

  return {
    productId: shopifyProduct.id,
    variantId: variantId,
    inventoryItemId: inventoryItemId
  };
}
