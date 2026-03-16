import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

// Load env from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const OLD_URL = process.env.OLD_SUPABASE_URL;
const OLD_KEY = process.env.OLD_SUPABASE_SERVICE_KEY;
const NEW_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const NEW_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!OLD_URL || !OLD_KEY || !NEW_URL || !NEW_KEY) {
  console.error('Missing required environment variables in .env.local');
  process.exit(1);
}

const oldClient = createClient(OLD_URL, OLD_KEY, {
  auth: { persistSession: false }
});

const newClient = createClient(NEW_URL, NEW_KEY, {
  auth: { persistSession: false }
});

// NATHAN'S OLD USER ID (Source)
const OLD_USER_ID = 'a9193b1e-799e-4895-81e6-31e2d9273cf9';
// STOCKLANE28'S NEW USER ID (Target)
const NEW_USER_ID = '37d5dc2a-1242-4ab8-9d3c-a2c8af8e9a16';

// Tables in order of dependency
const TABLES = [
  'suppliers',
  'products',
  'purchaseorders',
  'polines',
  'inventory',
  'transit',
  'invoices',
  'tasks',
  'folders',
  'shopify_orders',
  'order_inventory_effects',
  'invoices'
];

async function syncTable(tableName: string) {
  console.log(`\n📦 Cleaning and Syncing table: ${tableName}...`);

  // 0. Wipe target table fresh
  try {
    const { error: deleteError } = await newClient
      .from(tableName)
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete everything
    if (deleteError) console.log(`Note: Wipe on ${tableName} maybe slow or restricted.`);
  } catch (e) {}

  // 1. Fetch data from old, FILTERED by user_id
  let query = oldClient.from(tableName).select('*');
  
  // Tables with direct user_id
  const tablesWithUserId = ['suppliers', 'products', 'purchaseorders', 'invoices', 'tasks', 'folders', 'shopify_orders'];
  
  if (tablesWithUserId.includes(tableName)) {
    query = query.eq('user_id', OLD_USER_ID);
  } else if (tableName === 'polines') {
    // Polines link to purchaseorders which have user_id
    query = query.select('*, purchaseorders!inner(user_id)').eq('purchaseorders.user_id', OLD_USER_ID);
  } else if (tableName === 'inventory' || tableName === 'transit') {
    // Inventory and transit link to products which have user_id
    query = query.select('*, products!inner(user_id)').eq('products.user_id', OLD_USER_ID);
  }

  const { data: oldData, error: fetchError } = await query;

  if (fetchError) {
    console.error(`❌ Error fetching from ${tableName}:`, fetchError.message);
    return;
  }

  if (!oldData || oldData.length === 0) {
    console.log(`🟡 No data found in ${tableName}.`);
    return;
  }

  console.log(`📖 Found ${oldData.length} rows in ${tableName}.`);

  // 1b. Correct data: Assign to the newest user in the new project
  const correctedData = oldData.map((row: any) => {
    // Strip out join data if it exists from the !inner queries
    const { products, purchaseorders, ...rest } = row;
    const newRow = { ...rest };
    
    if ('user_id' in newRow) {
      newRow.user_id = NEW_USER_ID;
    }
    // For profiles, 'id' IS the user_id
    if (tableName === 'profiles' && 'id' in newRow) {
      newRow.id = NEW_USER_ID;
    }
    return newRow;
  });

  // 2. Insert into new
  // Split into batches of 100 to avoid request limits
  const BATCH_SIZE = 100;
  for (let i = 0; i < correctedData.length; i += BATCH_SIZE) {
    const batch = correctedData.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await newClient
      .from(tableName)
      .upsert(batch, { onConflict: 'id' });

    if (insertError) {
      console.error(`❌ Error inserting into ${tableName}:`, insertError.message);
      if (insertError.message.includes('foreign key constraint')) {
        console.error('Hint: Make sure dependent tables are synced first.');
      }
    } else {
      console.log(`✅ Synced batch ${i / BATCH_SIZE + 1} (${batch.length} rows)`);
    }
  }
}

async function runMain() {
  console.log('🚀 Starting Database Migration...');
  console.log(`From: ${OLD_URL}`);
  console.log(`To:   ${NEW_URL}`);

  for (const table of TABLES) {
    try {
      await syncTable(table);
    } catch (e) {
      console.error(`💥 Fatal error syncing ${table}:`, e);
    }
  }

  console.log('\n✨ Migration Complete!');
}

runMain();
