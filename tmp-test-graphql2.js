const fs = require('fs');

const envLocal = fs.readFileSync('.env.local', 'utf8');
const env = envLocal.split('\n').reduce((acc, line) => {
    const [key, value] = line.split('=');
    if (key && value) {
        acc[key.trim()] = value.trim().replace(/^"|"$/g, '');
    }
    return acc;
}, {});

function queryRest(url) {
    return fetch(url, {
        method: 'GET',
        headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        }
    }).then(r => r.json());
}

async function testGraphQL() {
    const userId = '471e3444-dcf4-4525-9310-9545349e888f';

    const settings = await queryRest(env.SUPABASE_URL + '/rest/v1/user_settings?user_id=eq.' + userId);
    const domain = settings[0].shopify_store_domain;
    const token = settings[0].shopify_access_token;

    const endpoint = `https://${domain}/admin/api/2024-01/graphql.json`;

    const query = `
    query {
      products(first: 5) {
        edges {
          node {
            id
            title
            vendor
            productType
            variants(first: 5) {
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
    }
  `;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query }),
    });

    const body = await response.json();
    console.log(JSON.stringify(body, null, 2));
}

testGraphQL();
