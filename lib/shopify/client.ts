import { serverSupabase } from '../supabase-server';
import { SHOPIFY_ADMIN_API_VERSION } from './api-version';

export interface ShopifyConfig {
  domain: string;
  accessToken: string;
}

export async function getShopifyConfig(userId: string): Promise<ShopifyConfig> {
  const { data, error } = await serverSupabase
    .from('user_settings')
    .select('shopify_store_domain, shopify_access_token')
    .eq('user_id', userId)
    .single();

  if (error || !data?.shopify_store_domain || !data?.shopify_access_token) {
    throw new Error('Shopify credentials not found or incomplete');
  }

  return {
    domain: data.shopify_store_domain,
    accessToken: data.shopify_access_token,
  };
}

export async function shopifyFetch(config: ShopifyConfig, query: string, variables: any = {}) {
  const response = await fetch(`https://${config.domain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json();

  if (body.errors) {
    console.error('Shopify GraphQL errors:', JSON.stringify(body.errors, null, 2));
    console.error('Failed Query Variables:', JSON.stringify(variables, null, 2));
    throw new Error(body.errors[0].message || 'Shopify GraphQL error');
  }

  return body.data;
}
