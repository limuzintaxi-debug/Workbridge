import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword } from './security.js';
import { nowIso } from './util.js';
import { CURRENCY_CATALOG, DEFAULT_CURRENCY } from './currency.js';
import {
  COLLECTION_TABLES,
  persistenceDriver,
  loadState,
  loadSettingsRow,
  saveSettingsRow,
  upsertRows,
  deleteRows
} from './supabase.js';

/**
 * Single data layer for the whole application.
 *
 * Driver `supabase`  — production: every collection is mirrored into Supabase
 *                      (see supabase/schema.sql) and this JSON file is only a
 *                      fast local cache.
 * Driver `local-json` — used when Supabase credentials are absent, and by the
 *                      automated test suite.
 *
 * Routes never touch the driver directly; they mutate `data()` and call
 * `persist()`.
 */

const DB_FILE = path.join(config.dataDir, 'db.json');

const COLLECTIONS = Object.keys(COLLECTION_TABLES);

export function defaultSettings() {
  return {
    commission: { enabled: false, rate: 0, payer: 'business' },
    currency: {
      default: DEFAULT_CURRENCY,
      enabled: CURRENCY_CATALOG.map((c) => c.code)
    },
    registration: { worker: 'auto', business: 'auto' },
    languages: { default: 'en', enabled: ['en', 'ar'] },
    support: { email: config.supportEmail }
  };
}

function blank() {
  const state = {
    meta: { version: 2, counters: { agreement: 1000, invoice: 1000 }, setup_required: false },
    settings: defaultSettings()
  };
  for (const collection of COLLECTIONS) state[collection] = [];
  return state;
}

let state = null;

export function data() {
  if (!state) throw new Error('store_not_initialised');
  return state;
}

/* --------------------------------------------------------------- settings */

export function getSettings() {
  return data().settings;
}

export function saveSettings(patch) {
  const settings = data().settings;
  data().settings = {
    ...settings,
    ...patch,
    currency: { ...settings.currency, ...(patch.currency || {}) },
    commission: { ...settings.commission, ...(patch.commission || {}) },
    registration: { ...settings.registration, ...(patch.registration || {}) },
    languages: { ...settings.languages, ...(patch.languages || {}) },
    support: { ...settings.support, ...(patch.support || {}) }
  };
  return data().settings;
}

/* ------------------------------------------------------------ persistence */

let syncing = false;
let syncDirty = false;
const lastSynced = new Map();
const syncStatus = { last_error: null, last_synced_at: null, pending: false };

function snapshot(rows) {
  const map = new Map();
  for (const row of rows || []) map.set(row.id, JSON.stringify(row));
  return map;
}

function writeLocal() {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(state));
  } catch (error) {
    console.error('[workbridge] could not write local cache:', error.message);
  }
}

async function flushToSupabase() {
  if (persistenceDriver() !== 'supabase') return;
  if (syncing) {
    syncDirty = true;
    return;
  }
  syncing = true;
  syncStatus.pending = true;
  try {
    for (const [collection, table] of Object.entries(COLLECTION_TABLES)) {
      const rows = state[collection] || [];
      const previous = lastSynced.get(collection) || new Map();
      const changed = rows.filter((row) => previous.get(row.id) !== JSON.stringify(row));
      const currentIds = new Set(rows.map((row) => row.id));
      const removed = [...previous.keys()].filter((id) => !currentIds.has(id));

      if (changed.length) await upsertRows(table, changed);
      if (removed.length) await deleteRows(table, removed);
      lastSynced.set(collection, snapshot(rows));
    }
    if (state.settings) await saveSettingsRow(state.settings);
    syncStatus.last_error = null;
    syncStatus.last_synced_at = nowIso();
  } catch (error) {
    syncStatus.last_error = error.message;
    console.error('[workbridge] Supabase sync failed:', error.message);
  } finally {
    syncing = false;
    syncStatus.pending = false;
    if (syncDirty) {
      syncDirty = false;
      setTimeout(flushToSupabase, 0);
    }
  }
}

export function persist() {
  if (!state) return;
  writeLocal();
  if (persistenceDriver() === 'supabase') {
    setTimeout(flushToSupabase, 0);
  }
}

export function nextCounter(name) {
  const counters = data().meta.counters;
  counters[name] = (counters[name] || 1000) + 1;
  return counters[name];
}

/* -------------------------------------------------------------- migrations */

function migrate(raw) {
  const base = blank();
  const merged = { ...base, ...raw };
  merged.meta = { ...base.meta, ...(raw.meta || {}) };
  merged.meta.counters = { ...base.meta.counters, ...(raw.meta?.counters || {}) };
  merged.settings = {
    ...base.settings,
    ...(raw.settings || {}),
    currency: { ...base.settings.currency, ...(raw.settings?.currency || {}) },
    commission: { ...base.settings.commission, ...(raw.settings?.commission || {}) },
    registration: { ...base.settings.registration, ...(raw.settings?.registration || {}) },
    languages: { ...base.settings.languages, ...(raw.settings?.languages || {}) },
    support: { ...base.settings.support, ...(raw.settings?.support || {}) }
  };
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(merged[collection])) merged[collection] = [];
  }
  return merged;
}

/* ------------------------------------------------------------------ admin */

export function adminExists() {
  return data().users.some((u) => u.role === 'admin');
}

export function createAdmin({ email, password, fullName, phone = '' }) {
  const user = {
    id: crypto.randomUUID(),
    role: 'admin',
    email: String(email).trim().toLowerCase(),
    password_hash: hashPassword(password),
    full_name: String(fullName || 'WORKBRIDGE Administrator').trim(),
    phone: String(phone || '').trim(),
    status: 'active',
    created_at: nowIso()
  };
  data().users.push(user);
  data().meta.setup_required = false;
  data().auditLog?.unshift?.({
    id: crypto.randomUUID(),
    actor_id: user.id,
    action: 'admin.created',
    target: user.email,
    at: nowIso()
  });
  persist();
  return user;
}

/* -------------------------------------------------------------- demo seed */

/**
 * Explicitly opt-in demo dataset (SEED_DEMO=1 or the test suite). The
 * production application never seeds demo accounts by itself.
 */
export function seedDemo() {
  const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
  state = blank();

  const admin = {
    id: 'u-admin',
    role: 'admin',
    email: 'admin@workbridge.test',
    password_hash: hashPassword('Admin#12345'),
    full_name: 'WORKBRIDGE Administrator',
    phone: '+10000000000',
    status: 'active',
    created_at: ago(2000)
  };
  const worker = {
    id: 'u-worker',
    role: 'worker',
    email: 'worker@workbridge.test',
    password_hash: hashPassword('Worker#12345'),
    full_name: 'Demo Worker',
    phone: '+10000000001',
    status: 'active',
    created_at: ago(1500)
  };
  const worker2 = {
    id: 'u-worker-2',
    role: 'worker',
    email: 'worker2@workbridge.test',
    password_hash: hashPassword('Worker#12345'),
    full_name: 'Sample Electrician',
    phone: '+10000000002',
    status: 'active',
    created_at: ago(1200)
  };
  const business = {
    id: 'u-business',
    role: 'business',
    email: 'business@workbridge.test',
    password_hash: hashPassword('Business#12345'),
    full_name: 'Demo Contracting LLC',
    phone: '+10000000003',
    status: 'active',
    created_at: ago(1400)
  };

  state.users = [admin, worker, worker2, business];
  state.workerProfiles = [
    {
      user_id: worker.id,
      category: 'Driver',
      aqama_masked: '•••• 0001',
      city: 'Industrial Area',
      experience_years: 5,
      skills: ['Heavy vehicle', 'Delivery routes'],
      bio: 'Demo profile for automated testing only.',
      available: true
    },
    {
      user_id: worker2.id,
      category: 'Electrician',
      aqama_masked: '•••• 0002',
      city: 'Port District',
      experience_years: 8,
      skills: ['Wiring', 'Panel boards'],
      bio: 'Demo profile for automated testing only.',
      available: true
    }
  ];
  state.businessProfiles = [
    {
      user_id: business.id,
      company_name: 'Demo Contracting LLC',
      contact_name: 'Demo Contact',
      phone: '+10000000003',
      country: 'Saudi Arabia',
      address: '1 Test Street, Demo City',
      website: '',
      about: 'Demo business account for automated testing only.'
    }
  ];
  state.institutions = [
    {
      id: 'i-1',
      name: 'Bridge Social Support Center',
      type: 'Social Support Organization',
      contact_name: 'Demo Contact',
      email: 'institution@workbridge.test',
      phone: '+10000000004',
      address: '2 Test Street, Demo City',
      description: 'Approved institution used for automated testing.',
      status: 'approved',
      review_note: 'Seeded test record.',
      created_at: ago(900),
      reviewed_at: ago(800)
    },
    {
      id: 'i-2',
      name: 'Community Aid Network',
      type: 'NGO',
      contact_name: 'Demo Contact',
      email: 'ngo@workbridge.test',
      phone: '+10000000005',
      address: '3 Test Street, Demo City',
      description: 'Pending institution used for automated testing.',
      status: 'pending',
      review_note: null,
      created_at: ago(20),
      reviewed_at: null
    }
  ];
  state.jobs = [
    {
      id: 'j-1',
      business_id: business.id,
      title: 'Site Driver for delivery route',
      category: 'Driver',
      description:
        'Daily delivery route between two warehouses. Valid licence required. Company vehicle provided.',
      location: 'Industrial Area 3',
      pay_amount: 180,
      pay_period: 'day',
      currency: 'SAR',
      requirements: 'Valid driving licence, 2 years experience',
      status: 'open',
      created_at: ago(2),
      closed_at: null
    },
    {
      id: 'j-2',
      business_id: business.id,
      title: 'Electrician for warehouse wiring',
      category: 'Electrician',
      description: 'Install and test lighting circuits in a 400 sqm warehouse. Materials supplied.',
      location: 'Port District',
      pay_amount: 55,
      pay_period: 'hour',
      currency: 'SAR',
      requirements: 'Electrical certification',
      status: 'open',
      created_at: ago(30),
      closed_at: null
    },
    {
      id: 'j-3',
      business_id: business.id,
      title: 'General laborer — moving crew',
      category: 'Laborer',
      description: 'Three day moving project. Loading, unloading and basic assembly.',
      location: 'City Center',
      pay_amount: 150,
      pay_period: 'day',
      currency: 'SAR',
      requirements: 'Able to lift 25kg',
      status: 'open',
      created_at: ago(60),
      closed_at: null
    },
    {
      id: 'j-4',
      business_id: business.id,
      title: 'Plumber for maintenance contract',
      category: 'Plumber',
      description: 'Monthly maintenance for a residential building. On-call twice per week.',
      location: 'Al Reem',
      pay_amount: 2400,
      pay_period: 'month',
      currency: 'SAR',
      requirements: 'Own tools',
      status: 'open',
      created_at: ago(100),
      closed_at: null
    }
  ];
  state.applications = [
    {
      id: 'a-1',
      job_id: 'j-2',
      worker_id: worker2.id,
      message: 'Certified electrician with panel experience.',
      status: 'pending',
      created_at: ago(20)
    }
  ];
  state.notifications = [
    {
      id: 'n-1',
      user_id: worker.id,
      title: 'New Driver listing',
      body: 'Site Driver for delivery route was posted.',
      link: '#/worker/jobs/j-1',
      read_at: null,
      created_at: ago(2)
    }
  ];
  state.reports = [];
  state.agreements = [];
  state.invoices = [];
  persist();
  return state;
}

/* ------------------------------------------------------------------ boot */

export async function initStore() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  let loaded = null;

  if (persistenceDriver() === 'supabase') {
    try {
      loaded = await loadState();
      if (!loaded) {
        const settingsRow = await loadSettingsRow().catch(() => null);
        if (settingsRow) loaded = { settings: settingsRow };
      }
      console.log('[workbridge] loaded state from Supabase.');
    } catch (error) {
      console.error(`[workbridge] Supabase load failed: ${error.message}`);
    }
  }

  if (!loaded && fs.existsSync(DB_FILE)) {
    try {
      loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
      console.error('[workbridge] local cache unreadable; starting from a clean state.');
    }
  }

  state = loaded ? migrate(loaded) : blank();

  if (process.env.SEED_DEMO === '1' && state.users.length === 0) {
    seedDemo();
    console.warn('[workbridge] SEED_DEMO=1 — demo accounts were created.');
  }

  if (!adminExists()) {
    if (config.adminEmail && config.adminPassword && config.adminPassword.length >= 8) {
      createAdmin({ email: config.adminEmail, password: config.adminPassword, fullName: 'Administrator' });
      console.log(`[workbridge] bootstrap admin created for ${config.adminEmail}.`);
    } else {
      state.meta.setup_required = true;
    }
  }

  if (!state.meta.counters) state.meta.counters = { agreement: 1000, invoice: 1000 };
  persist();
  return state;
}

export function resetForTests() {
  state = blank();
  persist();
  return state;
}

export const storeInfo = () => ({
  driver: persistenceDriver(),
  auth_driver: persistenceDriver() === 'supabase' && config.supabaseAnonKey ? 'supabase-auth' : 'local',
  file: persistenceDriver() === 'local-json' ? DB_FILE : null,
  sync: { ...syncStatus },
  initialised_at: nowIso()
});

export function audit(actorId, action, target, meta) {
  data().auditLog.unshift({
    id: crypto.randomUUID(),
    actor_id: actorId || null,
    action,
    target: target || null,
    meta: meta || null,
    at: nowIso()
  });
  if (data().auditLog.length > 2000) data().auditLog.length = 2000;
}
