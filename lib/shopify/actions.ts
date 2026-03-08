import { getShopifyConfig, shopifyFetch } from './client';

/**
 * Syncs inventory quantity adjustment to Shopify
 */
export async function syncShopifyInventory(inventoryItemId: string, delta: number, userId: string) {
  if (delta === 0) return;

  const config = await getShopifyConfig(userId);
  
  // Need location ID for adjustments. For now we assume the primary location.
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
  if (!locationId) throw new Error('No Shopify location found');

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
export async function pushDraftProductToShopify(product: any, sku: string, userId: string) {
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
      status: 'DRAFT',
      variants: [
        {
          sku: sku,
          inventoryItem: {
            tracked: true
          }
        }
      ]
    }
  };

  const result = await shopifyFetch(config, mutation, variables);
  const userErrors = result.productCreate.userErrors;

  if (userErrors.length > 0) {
    throw new Error(`Shopify Product Creation Error: ${userErrors[0].message}`);
  }

  const shopifyProduct = result.productCreate.product;
  const variant = shopifyProduct.variants.edges[0].node;

  return {
    productId: shopifyProduct.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id
  };
}
