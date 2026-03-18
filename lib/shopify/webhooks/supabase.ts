import { supabase } from '@/lib/supabaseClient';
import type { ShopifyWebhookTopic } from './types';

export type EnqueueWebhookJobParams = {
  webhookId: string;
  topic: ShopifyWebhookTopic;
  shop: string;
  orderId: string | null;
  payload: unknown;
};

export async function ratelimitShopifyWebhook(params: {
  ip: string;
  limit: number;
  windowSeconds: number;
}): Promise<boolean> {
  const { data, error } = await supabase.rpc('ratelimit_shopify_webhook', {
    p_ip: params.ip,
    p_limit: params.limit,
    p_window_seconds: params.windowSeconds,
  });

  if (error) {
    return true;
  }

  return Boolean(data);
}

export async function insertProcessedWebhook(params: {
  webhookId: string;
  topic: ShopifyWebhookTopic;
  shop: string;
}): Promise<{ inserted: boolean }> {
  const { error } = await supabase.from('processed_webhooks').insert({
    webhook_id: params.webhookId,
    topic: params.topic,
    shop: params.shop,
  });

  if (!error) {
    return { inserted: true };
  }

  if ((error as any).code === '23505') {
    return { inserted: false };
  }

  throw new Error(`Failed to insert processed webhook: ${error.message}`);
}

export async function logWebhookEvent(params: {
  webhookId: string | null;
  topic: ShopifyWebhookTopic;
  shop: string;
  orderId: string | null;
  payload: unknown;
  status: string;
  error?: unknown;
}): Promise<void> {
  await supabase.from('webhook_logs').insert({
    webhook_id: params.webhookId,
    topic: params.topic,
    shop: params.shop,
    order_id: params.orderId,
    payload: params.payload,
    status: params.status,
    error: params.error ?? null,
  });
}

export async function enqueueWebhookJob(params: EnqueueWebhookJobParams): Promise<void> {
  const { error } = await supabase.from('shopify_webhook_jobs').insert({
    webhook_id: params.webhookId,
    topic: params.topic,
    shop: params.shop,
    order_id: params.orderId,
    payload: params.payload,
  });

  if (!error) return;

  if ((error as any).code === '23505') {
    return;
  }

  throw new Error(`Failed to enqueue webhook job: ${error.message}`);
}

export async function resolveProductIdFromVariantOrSku(
  supabaseClient: any,
  params: {
    shopifyVariantId: string | number | null;
    sku: string | null;
  }
): Promise<string | null> {
  const variantIdStr = params.shopifyVariantId ? String(params.shopifyVariantId).replace('gid://shopify/ProductVariant/', '') : null;
  const variantIdNum = variantIdStr ? parseInt(variantIdStr, 10) : null;

  if (variantIdNum && !isNaN(variantIdNum)) {
    // 1. Check legacy mapping table
    const { data: legacy } = await supabaseClient
      .from('shopify_variant_map')
      .select('product_id')
      .eq('shopify_variant_id', variantIdNum)
      .maybeSingle();

    if (legacy?.product_id) return legacy.product_id as string;

    // 2. Check modern product_integrations table (matching the ID at the end of the GID)
    const { data: modern } = await supabaseClient
      .from('product_integrations')
      .select('product_id')
      .filter('external_variant_id', 'ilike', `%/${variantIdNum}`)
      .limit(1)
      .maybeSingle();

    if (modern?.product_id) return modern.product_id as string;
  }

  const sku = typeof params.sku === 'string' ? params.sku.trim() : '';
  if (!sku) return null;

  const skuLower = sku.toLowerCase();

  const { data: products } = await supabaseClient.from('products').select('id, primarysku, suppliersku, barcodes');
  if (!products) return null;

  const match = products.find((p: any) => {
    const primary = (p.primarysku ?? '').toLowerCase();
    const supplier = (p.suppliersku ?? '').toLowerCase();
    const barcodes = Array.isArray(p.barcodes) ? p.barcodes : [];
    return (
      primary === skuLower ||
      supplier === skuLower ||
      barcodes.some((b: string) => String(b).toLowerCase() === skuLower)
    );
  });

  return match?.id ?? null;
}
