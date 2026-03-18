import { supabase } from '@/lib/supabaseClient';
import type { ShopifyWebhookTopic } from './types';
import { inventoryDeltaForTopic, normalizeShopifyWebhookWork } from './normalize';
import { logWebhookEvent, resolveProductIdFromVariantOrSku } from './supabase';

type OrderInventoryEffect = {
  productId: string;
  quantityChange: number;
};

async function saveShopifyOrder(payload: any, effects: OrderInventoryEffect[]): Promise<string | null> {
  const shopifyOrderId = String(payload.id);
  
  const lineItems = (payload.line_items || []).map((item: any) => ({
    variant_id: item.variant_id,
    sku: item.sku,
    title: item.title,
    quantity: item.quantity,
    price: item.price,
  }));

  const customerName = payload.customer
    ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim()
    : null;

  const { data: order, error } = await supabase
    .from('shopify_orders')
    .upsert({
      shopify_order_id: shopifyOrderId,
      order_number: payload.order_number ? String(payload.order_number) : payload.name,
      channel: 'shopify',
      status: payload.cancelled_at ? 'cancelled' : 'active',
      financial_status: payload.financial_status,
      fulfillment_status: payload.fulfillment_status,
      customer_email: payload.email || payload.customer?.email,
      customer_name: customerName,
      total_price: parseFloat(payload.total_price) || 0,
      currency: payload.currency || 'GBP',
      line_items: lineItems,
      raw_payload: payload,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'shopify_order_id' })
    .select('id')
    .single();

  if (error || !order) {
    console.error('Failed to save order:', error);
    return null;
  }

  if (effects.length > 0) {
    const effectRows = effects.map(e => ({
      order_id: order.id,
      product_id: e.productId,
      quantity_change: e.quantityChange,
    }));

    await supabase.from('order_inventory_effects').insert(effectRows);
  }

  return order.id;
}

export type ProcessJobResult = {
  processed: number;
  succeeded: number;
  retried: number;
  dead: number;
};

function computeBackoffSeconds(attempts: number): number {
  const n = Math.max(1, attempts);
  const seconds = 5 * Math.pow(2, n - 1);
  return Math.min(60 * 30, Math.floor(seconds));
}

async function markJobSucceeded(jobId: string) {
  await supabase
    .from('shopify_webhook_jobs')
    .update({
      status: 'succeeded',
      locked_at: null,
      locked_by: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

async function requeueJob(jobId: string, attempts: number, error: unknown) {
  const delaySeconds = computeBackoffSeconds(attempts);
  const runAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  await supabase
    .from('shopify_webhook_jobs')
    .update({
      status: 'queued',
      run_at: runAt,
      locked_at: null,
      locked_by: null,
      last_error: error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

async function markJobDead(job: any, error: unknown) {
  await supabase
    .from('shopify_webhook_jobs')
    .update({
      status: 'dead',
      locked_at: null,
      locked_by: null,
      last_error: error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  await supabase.from('failed_webhook_jobs').insert({
    webhook_job_id: job.id,
    webhook_id: job.webhook_id,
    topic: job.topic,
    shop: job.shop,
    order_id: job.order_id,
    payload: job.payload,
    error: error ?? null,
    attempts: job.attempts,
    last_attempt_at: job.last_attempt_at,
  });
}

export async function processShopifyWebhookJobs(params: {
  workerId: string;
  maxJobs: number;
}): Promise<ProcessJobResult> {
  const result: ProcessJobResult = {
    processed: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
  };

  const { data: jobs, error } = await supabase.rpc('claim_shopify_webhook_jobs', {
    p_max_jobs: params.maxJobs,
    p_worker_id: params.workerId,
  });

  if (error) {
    throw new Error(`Failed to claim jobs: ${error.message}`);
  }

  const claimed = Array.isArray(jobs) ? jobs : [];
  for (const job of claimed) {
    result.processed++;

    try {
      const topic = job.topic as ShopifyWebhookTopic;
      const normalized = normalizeShopifyWebhookWork(topic, job.payload);
      const direction = inventoryDeltaForTopic(topic);

      const failures: Array<{ reason: string; variantId: number | null; sku: string | null }> = [];
      const appliedEffects: OrderInventoryEffect[] = [];

      for (const effect of normalized.effects) {
        const qty = Number(effect.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const productId = await resolveProductIdFromVariantOrSku(supabase, {
          shopifyVariantId: effect.variantId,
          sku: effect.sku,
        });

        if (!productId) {
          failures.push({
            reason: 'No mapping for variant_id/sku',
            variantId: effect.variantId,
            sku: effect.sku,
          });
          continue;
        }

        const delta = direction * qty;

        const { error: applyError } = await supabase.rpc('apply_shopify_inventory_effect_v2', {
          p_webhook_id: job.webhook_id,
          p_product_id: productId,
          p_delta: delta,
          p_context: {
            shop: job.shop,
            topic: job.topic,
            order_id: job.order_id,
            sku: effect.sku,
            shopify_variant_id: effect.variantId,
          },
        });

        if (applyError) {
          failures.push({
            reason: `Failed to apply inventory delta: ${applyError.message}`,
            variantId: effect.variantId,
            sku: effect.sku,
          });
        } else {
          appliedEffects.push({ productId, quantityChange: delta });
        }
      }

      if (failures.length > 0) {
        const err = {
          message: 'One or more line items could not be applied',
          failures,
        };

        await logWebhookEvent({
          webhookId: job.webhook_id,
          topic,
          shop: job.shop,
          orderId: job.order_id ?? null,
          payload: job.payload,
          status: 'failed',
          error: err,
        });

        if (job.attempts < job.max_attempts) {
          await requeueJob(job.id, job.attempts, err);
          result.retried++;
        } else {
          await markJobDead(job, err);
          result.dead++;
        }

        continue;
      }

      await saveShopifyOrder(job.payload, appliedEffects);

      await logWebhookEvent({
        webhookId: job.webhook_id,
        topic,
        shop: job.shop,
        orderId: job.order_id ?? null,
        payload: job.payload,
        status: 'processed',
      });

      await markJobSucceeded(job.id);
      result.succeeded++;
    } catch (e) {
      const topic = job.topic as ShopifyWebhookTopic;

      await logWebhookEvent({
        webhookId: job.webhook_id,
        topic,
        shop: job.shop,
        orderId: job.order_id ?? null,
        payload: job.payload,
        status: 'failed',
        error: {
          message: e instanceof Error ? e.message : 'Unknown error',
        },
      });

      if (job.attempts < job.max_attempts) {
        await requeueJob(job.id, job.attempts, {
          message: e instanceof Error ? e.message : 'Unknown error',
        });
        result.retried++;
      } else {
        await markJobDead(job, {
          message: e instanceof Error ? e.message : 'Unknown error',
        });
        result.dead++;
      }
    }
  }

  return result;
}
