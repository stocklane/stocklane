import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const OLD_URL = process.env.OLD_SUPABASE_URL || '';
const OLD_KEY = process.env.OLD_SUPABASE_SERVICE_KEY || '';

const oldClient = createClient(OLD_URL, OLD_KEY);

async function checkSchema() {
  const { data: tables, error: tableError } = await oldClient
    .from('sqlite_master') // This won't work on Postgres, use a different trick
    .select('*')
    .limit(1);

  // Instead, let's just try to select from a few tables and see their keys
  const tablesToCheck = ['products', 'invoices', 'profiles', 'activity_log'];
  
  for (const table of tablesToCheck) {
    const { data, error } = await oldClient.from(table).select('*').limit(1);
    if (error) {
      console.log(`❌ Table ${table}:`, error.message);
    } else {
      console.log(`✅ Table ${table} found. Columns:`, Object.keys(data[0] || {}).join(', '));
    }
  }
}

checkSchema();
