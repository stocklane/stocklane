import { getShopifyConfig, shopifyFetch } from './client';

interface DraftProductInput {
  name: string | null | undefined;
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
 * Syncs inventory quantity adjustment to Shopify
 */
export async function syncShopifyInventory(inventoryItemId: string, delta: number, userId: string) {
  if (delta === 0) return;

  await enableInventoryTracking(inventoryItemId, userId);
  await ensureInventoryLevel(inventoryItemId, userId);

  const { config, locationId } = await getPrimaryLocationId(userId);

  const mutation = `
    mutation inventoryAdjustQuantity($input: InventoryAdjustQuantityInput!) {
      inventoryAdjustQuantity(input: $input) {
        inventoryLevel {
          available
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
      inventoryItemId,
      locationId,
      availableDelta: delta
    }
  };

  const result = await shopifyFetch(config, mutation, variables);
  const userErrors = result.inventoryAdjustQuantity.userErrors;
  
  if (userErrors.length > 0) {
    throw new Error(`Shopify Inventory Sync Error: ${userErrors[0].message}`);
  }
}

/**
 * Updates a product variant price on Shopify
 */
export async function updateShopifyPrice(variantId: string, price: string, userId: string) {
  const config = await getShopifyConfig(userId);

  const mutation = `
    mutation productVariantUpdate($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant {
          id
          price
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
      id: variantId,
      price: price
    }
  };

  const result = await shopifyFetch(config, mutation, variables);
  const userErrors = result.productVariantUpdate.userErrors;

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
) {
  const config = await getShopifyConfig(userId);

  const mutation = `
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

  const variables = {
    input: {
      title: product.name,
      vendor: 'StockLane', // Generic vendor or fetch from suppliers table
      status: 'DRAFT'
    }
  };

  const result = await shopifyFetch(config, mutation, variables);
  const userErrors = result.productCreate.userErrors;

  if (userErrors.length > 0) {
    throw new Error(`Shopify Product Creation Error: ${userErrors[0].message}`);
  }

  const shopifyProduct = result.productCreate.product;
  const variant = shopifyProduct.variants.edges[0].node;

  const variantUpdateMutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          sku
          inventoryItem {
            id
          }
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
        id: variant.id,
        sku,
      },
    ],
  });
  const variantUpdateErrors = variantUpdateResult.productVariantsBulkUpdate.userErrors;

  if (variantUpdateErrors.length > 0) {
    throw new Error(`Shopify Variant Update Error: ${variantUpdateErrors[0].message}`);
  }

  const updatedVariant = variantUpdateResult.productVariantsBulkUpdate.productVariants[0];

  await enableInventoryTracking(updatedVariant.inventoryItem.id, userId);
  await ensureInventoryLevel(updatedVariant.inventoryItem.id, userId);

  return {
    productId: shopifyProduct.id,
    variantId: updatedVariant.id,
    inventoryItemId: updatedVariant.inventoryItem.id
  };
}
