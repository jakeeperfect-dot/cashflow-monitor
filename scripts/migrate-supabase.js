'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY before importing.');
  }

  const dataPath = path.join(__dirname, '..', 'data.json');
  const payload = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  if (!Array.isArray(payload.branches) || !Array.isArray(payload.transactions) || !Array.isArray(payload.users)) {
    throw new Error('data.json does not have a valid KDCashflow data structure.');
  }
  payload.transactionEditRequests = Array.isArray(payload.transactionEditRequests) ? payload.transactionEditRequests : [];
  payload.transactionHistory = Array.isArray(payload.transactionHistory) ? payload.transactionHistory : [];

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await supabase
    .from('kdcashflow_state')
    .upsert({ id: 'primary', payload }, { onConflict: 'id' });
  if (error) throw new Error(`Supabase import failed: ${error.message}`);
  console.log('KDCashflow data imported into Supabase.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
