import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

type JsonRecord = Record<string, unknown>;

type TableConfig = {
  name: string;
  upsertConflict?: string;
  fetch: () => Promise<JsonRecord[]>;
  clearTarget?: () => Promise<void>;
  transform?: (row: JsonRecord) => JsonRecord | null;
};

const argv = new Set(process.argv.slice(2));

const DRY_RUN = argv.has('--dry-run') || process.env.DRY_RUN === '1';
const RESET_TARGET = argv.has('--reset-target') || process.env.RESET_TARGET === '1';
const COPY_STORAGE = !argv.has('--skip-storage') && process.env.COPY_STORAGE !== '0';

const OLD_URL = getRequiredEnv('OLD_SUPABASE_URL');
const OLD_KEY = getRequiredEnv('OLD_SUPABASE_SERVICE_ROLE_KEY', 'OLD_SUPABASE_SERVICE_KEY');
const NEW_URL = getRequiredEnv('NEW_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
const NEW_KEY = getRequiredEnv(
  'NEW_SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY'
);
const OLD_USER_ID = getRequiredEnv('OLD_SUPABASE_USER_ID');
const NEW_USER_ID = getRequiredEnv('NEW_SUPABASE_USER_ID');
const BUCKET_NAME = process.env.SUPABASE_MIGRATION_BUCKET || 'po-invoices';

const oldClient = createClient(OLD_URL, OLD_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const newClient = createClient(NEW_URL, NEW_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const copiedImagePaths = new Set<string>();
const migratedCounts = new Map<string, number>();

const DIRECT_USER_TABLES = [
  'user_settings',
  'folders',
  'suppliers',
  'products',
  'purchaseorders',
  'inventory',
  'transit',
  'invoices',
  'tasks',
  'shopify_orders',
  'activity_log',
  'product_integrations',
] as const;

function getRequiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  throw new Error(`Missing required environment variable. Tried: ${names.join(', ')}`);
}

function stripJoinData(row: JsonRecord, keys: string[]): JsonRecord {
  const next = { ...row };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function rewriteUserId(row: JsonRecord): JsonRecord {
  if ('user_id' in row) {
    return { ...row, user_id: NEW_USER_ID };
  }
  return row;
}

function getPublicStoragePrefix(projectUrl: string): string {
  return `${projectUrl.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET_NAME}/`;
}

function extractBucketPath(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;

  try {
    const parsed = new URL(url);
    const marker = `/storage/v1/object/public/${BUCKET_NAME}/`;
    const index = parsed.pathname.indexOf(marker);
    if (index === -1) return null;
    return decodeURIComponent(parsed.pathname.slice(index + marker.length));
  } catch {
    return null;
  }
}

function rewriteStorageUrl(url: unknown): string | null {
  const filePath = extractBucketPath(url);
  if (!filePath) return typeof url === 'string' ? url : null;
  copiedImagePaths.add(filePath);
  return `${getPublicStoragePrefix(NEW_URL)}${filePath}`;
}

async function ensureAuthUserExists(
  client: SupabaseClient,
  userId: string,
  label: 'source' | 'target'
) {
  const { data, error } = await client.auth.admin.getUserById(userId);
  if (error || !data.user) {
    throw new Error(`Could not find ${label} auth user ${userId}: ${error?.message || 'not found'}`);
  }
}

async function ensureTablesExist(tableNames: string[]) {
  for (const tableName of tableNames) {
    const { error } = await newClient.from(tableName).select('*', { head: true, count: 'exact' });
    if (error) {
      throw new Error(`Target table "${tableName}" is not ready: ${error.message}`);
    }
  }
}

async function fetchDirectUserRows(tableName: string): Promise<JsonRecord[]> {
  const { data, error } = await oldClient.from(tableName).select('*').eq('user_id', OLD_USER_ID);
  if (error) {
    throw new Error(`Failed to fetch ${tableName}: ${error.message}`);
  }
  return (data || []) as JsonRecord[];
}

async function fetchSingleRowByColumn(
  tableName: string,
  column: string,
  value: string
): Promise<JsonRecord[]> {
  const { data, error } = await oldClient.from(tableName).select('*').eq(column, value);
  if (error) {
    throw new Error(`Failed to fetch ${tableName}: ${error.message}`);
  }
  return (data || []) as JsonRecord[];
}

async function fetchPurchaseOrderIdsForUser(
  client: SupabaseClient,
  userId: string
): Promise<string[]> {
  const { data, error } = await client
    .from('purchaseorders')
    .select('id')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to fetch purchase order ids: ${error.message}`);
  }

  return (data || []).map((row) => row.id as string);
}

async function fetchShopifyOrderIdsForUser(
  client: SupabaseClient,
  userId: string
): Promise<string[]> {
  const { data, error } = await client.from('shopify_orders').select('id').eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to fetch Shopify order ids: ${error.message}`);
  }

  return (data || []).map((row) => row.id as string);
}

async function deleteByIds(tableName: string, column: string, ids: string[]) {
  if (ids.length === 0 || DRY_RUN || !RESET_TARGET) return;

  const CHUNK_SIZE = 200;
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    const chunk = ids.slice(index, index + CHUNK_SIZE);
    const { error } = await newClient.from(tableName).delete().in(column, chunk);
    if (error) {
      throw new Error(`Failed to clear ${tableName}: ${error.message}`);
    }
  }
}

async function clearDirectUserTable(tableName: string) {
  if (DRY_RUN || !RESET_TARGET) return;

  const { error } = await newClient.from(tableName).delete().eq('user_id', NEW_USER_ID);
  if (error) {
    throw new Error(`Failed to clear ${tableName}: ${error.message}`);
  }
}

function buildTableConfigs(): TableConfig[] {
  return [
    {
      name: 'profiles',
      upsertConflict: 'id',
      fetch: () => fetchSingleRowByColumn('profiles', 'id', OLD_USER_ID),
      transform: (row) => ({ ...row, id: NEW_USER_ID }),
    },
    {
      name: 'user_settings',
      upsertConflict: 'user_id',
      fetch: () => fetchDirectUserRows('user_settings'),
      clearTarget: () => clearDirectUserTable('user_settings'),
      transform: rewriteUserId,
    },
    {
      name: 'folders',
      fetch: () => fetchDirectUserRows('folders'),
      clearTarget: () => clearDirectUserTable('folders'),
      transform: rewriteUserId,
    },
    {
      name: 'suppliers',
      fetch: () => fetchDirectUserRows('suppliers'),
      clearTarget: () => clearDirectUserTable('suppliers'),
      transform: rewriteUserId,
    },
    {
      name: 'products',
      fetch: () => fetchDirectUserRows('products'),
      clearTarget: () => clearDirectUserTable('products'),
      transform: rewriteUserId,
    },
    {
      name: 'purchaseorders',
      fetch: () => fetchDirectUserRows('purchaseorders'),
      clearTarget: () => clearDirectUserTable('purchaseorders'),
      transform: (row) => {
        const next = rewriteUserId(row);
        const rewrittenImageUrl = rewriteStorageUrl(next.imageurl);
        const imageUrls = Array.isArray(next.imageurls)
          ? next.imageurls.map((value) => rewriteStorageUrl(value)).filter(Boolean)
          : next.imageurls;

        return {
          ...next,
          imageurl: rewrittenImageUrl,
          imageurls: imageUrls,
        };
      },
    },
    {
      name: 'polines',
      fetch: async () => {
        const { data, error } = await oldClient
          .from('polines')
          .select('*, purchaseorders!inner(user_id)')
          .eq('purchaseorders.user_id', OLD_USER_ID);

        if (error) {
          throw new Error(`Failed to fetch polines: ${error.message}`);
        }

        return (data || []) as JsonRecord[];
      },
      clearTarget: async () => {
        const poIds = await fetchPurchaseOrderIdsForUser(newClient, NEW_USER_ID);
        await deleteByIds('polines', 'purchaseorderid', poIds);
      },
      transform: (row) => stripJoinData(row, ['purchaseorders']),
    },
    {
      name: 'inventory',
      fetch: () => fetchDirectUserRows('inventory'),
      clearTarget: () => clearDirectUserTable('inventory'),
      transform: rewriteUserId,
    },
    {
      name: 'transit',
      fetch: () => fetchDirectUserRows('transit'),
      clearTarget: () => clearDirectUserTable('transit'),
      transform: rewriteUserId,
    },
    {
      name: 'invoices',
      fetch: () => fetchDirectUserRows('invoices'),
      clearTarget: () => clearDirectUserTable('invoices'),
      transform: rewriteUserId,
    },
    {
      name: 'tasks',
      fetch: () => fetchDirectUserRows('tasks'),
      clearTarget: () => clearDirectUserTable('tasks'),
      transform: rewriteUserId,
    },
    {
      name: 'shopify_orders',
      fetch: () => fetchDirectUserRows('shopify_orders'),
      clearTarget: () => clearDirectUserTable('shopify_orders'),
      transform: rewriteUserId,
    },
    {
      name: 'order_inventory_effects',
      fetch: async () => {
        const sourceOrderIds = await fetchShopifyOrderIdsForUser(oldClient, OLD_USER_ID);
        if (sourceOrderIds.length === 0) return [];

        const { data, error } = await oldClient
          .from('order_inventory_effects')
          .select('*')
          .in('order_id', sourceOrderIds);

        if (error) {
          throw new Error(`Failed to fetch order_inventory_effects: ${error.message}`);
        }

        return (data || []) as JsonRecord[];
      },
      clearTarget: async () => {
        const targetOrderIds = await fetchShopifyOrderIdsForUser(newClient, NEW_USER_ID);
        await deleteByIds('order_inventory_effects', 'order_id', targetOrderIds);
      },
    },
    {
      name: 'activity_log',
      fetch: () => fetchDirectUserRows('activity_log'),
      clearTarget: () => clearDirectUserTable('activity_log'),
      transform: rewriteUserId,
    },
    {
      name: 'product_integrations',
      fetch: () => fetchDirectUserRows('product_integrations'),
      clearTarget: () => clearDirectUserTable('product_integrations'),
      transform: rewriteUserId,
    },
  ];
}

async function upsertRows(tableName: string, rows: JsonRecord[], onConflict: string) {
  if (rows.length === 0) return;
  if (DRY_RUN) return;

  const BATCH_SIZE = 200;

  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    const { error } = await newClient.from(tableName).upsert(batch, { onConflict });
    if (error) {
      throw new Error(`Failed to upsert ${tableName}: ${error.message}`);
    }
    console.log(
      `   inserted batch ${Math.floor(index / BATCH_SIZE) + 1} (${batch.length} rows)`
    );
  }
}

async function syncTable(config: TableConfig) {
  console.log(`\n-> ${config.name}`);

  if (config.clearTarget) {
    await config.clearTarget();
    if (RESET_TARGET) {
      console.log('   cleared target rows');
    }
  }

  const sourceRows = await config.fetch();
  const transformedRows = sourceRows
    .map((row) => (config.transform ? config.transform(row) : row))
    .filter((row): row is JsonRecord => row !== null);

  migratedCounts.set(config.name, transformedRows.length);

  if (transformedRows.length === 0) {
    console.log('   no rows found');
    return;
  }

  console.log(`   found ${transformedRows.length} rows`);
  await upsertRows(config.name, transformedRows, config.upsertConflict || 'id');
}

async function copyStorageObjects() {
  if (!COPY_STORAGE) {
    console.log('\n-> storage copy skipped');
    return;
  }

  const paths = [...copiedImagePaths];
  console.log(`\n-> storage (${BUCKET_NAME})`);

  if (paths.length === 0) {
    console.log('   no invoice files referenced by purchase orders');
    return;
  }

  if (DRY_RUN) {
    console.log(`   would copy ${paths.length} files`);
    return;
  }

  for (const filePath of paths) {
    const { data, error } = await oldClient.storage.from(BUCKET_NAME).download(filePath);
    if (error || !data) {
      throw new Error(`Failed to download ${filePath}: ${error?.message || 'unknown error'}`);
    }

    const arrayBuffer = await data.arrayBuffer();
    const fileContents = new Uint8Array(arrayBuffer);

    const { error: uploadError } = await newClient.storage.from(BUCKET_NAME).upload(filePath, fileContents, {
      contentType: data.type || undefined,
      upsert: true,
    });

    if (uploadError) {
      throw new Error(`Failed to upload ${filePath}: ${uploadError.message}`);
    }

    console.log(`   copied ${filePath}`);
  }
}

async function run() {
  console.log('Supabase tenant migration');
  console.log(`source project: ${OLD_URL}`);
  console.log(`target project: ${NEW_URL}`);
  console.log(`source user:    ${OLD_USER_ID}`);
  console.log(`target user:    ${NEW_USER_ID}`);
  console.log(`dry run:        ${DRY_RUN ? 'yes' : 'no'}`);
  console.log(`reset target:   ${RESET_TARGET ? 'yes' : 'no'}`);
  console.log(`copy storage:   ${COPY_STORAGE ? 'yes' : 'no'}`);

  await ensureAuthUserExists(oldClient, OLD_USER_ID, 'source');
  await ensureAuthUserExists(newClient, NEW_USER_ID, 'target');
  await ensureTablesExist(['profiles', ...DIRECT_USER_TABLES, 'polines', 'order_inventory_effects']);

  const tableConfigs = buildTableConfigs();

  for (const config of tableConfigs) {
    await syncTable(config);
  }

  await copyStorageObjects();

  console.log('\nSummary');
  for (const [tableName, count] of migratedCounts.entries()) {
    console.log(`- ${tableName}: ${count}`);
  }
  console.log(`- storage files: ${copiedImagePaths.size}`);
}

run().catch((error) => {
  console.error('\nMigration failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
