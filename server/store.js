import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword } from './security.js';
import { nowIso } from './util.js';

/**
 * Single data layer for the whole app.
 *
 * The app currently persists to a local JSON file so it runs without external
 * credentials. Everything the routes need is expressed as plain collections in
 * `data()`; replacing this module with a Supabase/Postgres implementation is
 * the documented migration path (see docs/DATABASE.md).
 */

const DB_FILE = path.join(config.dataDir, 'db.json');
const HOUR = 60 * 60 * 1000;

let state = null;

function blank() {
  return {
    meta: { version: 1, counters: { agreement: 1000, invoice: 1000 } },
    users: [],
    workerProfiles: [],
    businessProfiles: [],
    institutions: [],
    jobs: [],
    applications: [],
    agreements: [],
    invoices: [],
    notifications: [],
    reports: [],
    settings: {
      commission: { enabled: false, rate: 0, payer: 'business' }
    }
  };
}

export function data() {
  if (!state) throw new Error('store_not_initialised');
  return state;
}

export function persist() {
  if (!state) return;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
}

export function nextCounter(name) {
  const counters = data().meta.counters;
  counters[name] = (counters[name] || 1000) + 1;
  return counters[name];
}

function seed() {
  const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

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

  const jobs = [
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
      requirements: 'Valid driving licence, 2 years experience',
      status: 'open',
      created_at: ago(2)
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
      requirements: 'Electrical certification',
      status: 'open',
      created_at: ago(30)
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
      requirements: 'Able to lift 25kg',
      status: 'open',
      created_at: ago(60)
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
      requirements: 'Own tools',
      status: 'open',
      created_at: ago(100)
    }
  ];

  state = {
    ...blank(),
    users: [admin, worker, worker2, business],
    workerProfiles: [
      {
        user_id: worker.id,
        category: 'Driver',
        aqama_masked: '•••• 0001',
        city: 'Industrial Area',
        experience_years: 5,
        skills: ['Heavy vehicle', 'Delivery routes'],
        bio: 'Demo profile created for testing only.',
        available: true
      },
      {
        user_id: worker2.id,
        category: 'Electrician',
        aqama_masked: '•••• 0002',
        city: 'Port District',
        experience_years: 8,
        skills: ['Wiring', 'Panel boards'],
        bio: 'Demo profile created for testing only.',
        available: true
      }
    ],
    businessProfiles: [
      {
        user_id: business.id,
        company_name: 'Demo Contracting LLC',
        contact_name: 'Demo Contact',
        phone: '+10000000003',
        country: 'Demo Country',
        address: '1 Test Street, Demo City',
        website: '',
        about: 'Demo business account created for testing only.'
      }
    ],
    institutions: [
      {
        id: 'i-1',
        name: 'Bridge Social Support Center',
        type: 'Social Support Organization',
        contact_name: 'Demo Contact',
        email: 'institution@workbridge.test',
        phone: '+10000000004',
        address: '2 Test Street, Demo City',
        description: 'Demo institution record created for testing only.',
        status: 'approved',
        review_note: 'Seeded demo record.',
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
        description: 'Demo institution record awaiting review.',
        status: 'pending',
        review_note: null,
        created_at: ago(20),
        reviewed_at: null
      }
    ],
    jobs,
    applications: [
      {
        id: 'a-1',
        job_id: 'j-2',
        worker_id: worker2.id,
        message: 'Certified electrician with panel experience.',
        status: 'pending',
        created_at: ago(20)
      }
    ],
    notifications: [
      {
        id: 'n-1',
        user_id: worker.id,
        title: 'New Driver listing',
        body: 'Site Driver for delivery route was posted.',
        link: '#/worker/jobs/j-1',
        read_at: null,
        created_at: ago(2)
      }
    ],
    reports: [],
    settings: { commission: { enabled: false, rate: 0, payer: 'business' } }
  };

  persist();
}

export async function initStore() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      state.meta ||= { version: 1, counters: { agreement: 1000, invoice: 1000 } };
      state.meta.counters ||= { agreement: 1000, invoice: 1000 };
      state.settings ||= { commission: { enabled: false, rate: 0, payer: 'business' } };
      return state;
    } catch {
      console.warn('[workbridge] data file was unreadable, reseeding demo data.');
    }
  }
  seed();
  return state;
}

export function resetForTests() {
  state = blank();
  persist();
  return state;
}

export const storeInfo = () => ({
  driver: 'local-json',
  file: DB_FILE,
  initialised_at: nowIso()
});
