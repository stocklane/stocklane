import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env.local') });

async function debug() {
    const { getShopifyConfig, shopifyFetch } = await import('./lib/shopify/client');
    const config = await getShopifyConfig('471e3444-dcf4-4525-9310-9545349e888f');
    
    const data = await shopifyFetch(config, `
        query {
            inventoryItem(id: "gid://shopify/InventoryItem/45496325865546") {
                id
                inventoryLevels(first: 1) {
                    edges {
                        node {
                            location { name }
                            quantities(names: ["available", "on_hand", "reserved", "committed"]) { name quantity }
                        }
                    }
                }
            }
        }
    `);
    
    console.log('--- Current Quantities ---');
    console.log(JSON.stringify(data.inventoryItem.inventoryLevels.edges[0].node.quantities, null, 2));
}

debug().catch(console.error);
