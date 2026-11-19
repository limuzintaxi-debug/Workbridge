/**
 * Supabase production adapter.
 *
 * Two responsibilities:
 *  1. Persistence — the app's collections are mirrored into Supabase tables as
 *     `{ id, doc }` rows (see supabase/schema.sql). `doc` holds the record, and
 *     generated columns expose role/status/user_id for RLS and indexes.
 *  2. Auth — Supabase Auth (GoTrue) handles sign-up, sign-in, password recovery
 *     and password updates when SUPABASE_ANON_KEY is configured.
 *
 * The service-role key is only ever used server-side; it is never sent to the
 * browser.
 */

import { config, supabaseConfigured } from './config.js';

const TABLE_BY_COLLECTION = {
  users: 'users',
  workerProfiles: 'worker_profiles',
  businessProfiles: 'business_profiles',
  institutions: 'institutions',
  jobs: 'jobs',
  applications: 'applications',
  agreements: 'agreements',
  invoices: 'invoices',
  notifications: 'notifications',
  reports: 'reports',
  resetTokens: 'password_reset_tokens',
  auditLog: 'audit_log',
  payments: 'payments'
};

export const COLLECTION_TABLES = TABLE_BY_COLLECTION;

export function persistenceDriver() {
  return supabaseConfigured() ? 'supabase' : 'local-json';
}

export function authDriver() {
  return supabaseConfigured() && config.supabaseAnonKey ? 'supabase-auth' : 'local';
}

function headers(extra = {}) {
  return {
    apikey: config.supabaseServiceKey,
    Authorization: `Bearer ${config.supabaseServiceKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function request(path, { method = 'GET', body, extraHeaders } = {}) {
  const url = `${config.supabaseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    method,
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error_description || payload?.error || response.statusText;
    const error = new Error(`supabase_${response.status}: ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** Loads every collection from Supabase. Returns null when the schema is empty. */
export async function loadState() {
  const entries = await Promise.all(
    Object.entries(TABLE_BY_COLLECTION).map(async ([collection, table]) => {
      try {
        const rows = await request(`/rest/v1/${table}?select=id,doc&order=created_at.asc&limit=10000`);
        return [collection, (rows || []).map((row) => row.doc)];
      } catch (error) {
        if (error.status === 404 || /relation .* does not exist/i.test(String(error.message))) {
          return [collection, null];
        }
        throw error;
      }
    })
  );

  const missing = entries.filter(([, rows]) => rows === null).map(([collection]) => collection);
  if (missing.length) {
    throw new Error(
      `supabase_schema_missing: run supabase/schema.sql (missing tables for: ${missing.join(', ')})`
    );
  }

  const state = Object.fromEntries(entries);
  const hasData = Object.values(state).some((rows) => rows.length > 0);
  return hasData ? state : null;
}

export async function upsertRows(table, rows) {
  if (!rows.length) return;
  const payload = rows.map((row) => ({ id: row.id, doc: row }));
  await request(`/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    body: payload,
    extraHeaders: { Prefer: 'resolution=merge-duplicates,return=minimal' }
  });
}

export async function deleteRows(table, ids) {
  if (!ids.length) return;
  const list = ids.map((id) => `"${id}"`).join(',');
  await request(`/rest/v1/${table}?id=in.(${list})`, {
    method: 'DELETE',
    extraHeaders: { Prefer: 'return=minimal' }
  });
}

export async function loadSettingsRow() {
  const rows = await request('/rest/v1/app_settings?select=doc&limit=1');
  return rows?.[0]?.doc || null;
}

export async function saveSettingsRow(doc) {
  await request('/rest/v1/app_settings?on_conflict=id', {
    method: 'POST',
    body: [{ id: 'global', doc }],
    extraHeaders: { Prefer: 'resolution=merge-duplicates,return=minimal' }
  });
}

/** Uploads a generated document to Supabase Storage and returns its object path. */
export async function uploadDocument(bucket, objectPath, buffer, contentType) {
  const url = `${config.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${objectPath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: config.supabaseServiceKey,
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`supabase_storage_${response.status}: ${text.slice(0, 200)}`);
  }
  return `${bucket}/${objectPath}`;
}

/** Short-lived signed URL for a private document (default 10 minutes). */
export async function signedDocumentUrl(bucket, objectPath, expiresIn = 600) {
  const payload = await request(`/storage/v1/object/sign/${bucket}/${objectPath}`, {
    method: 'POST',
    body: { expiresIn }
  });
  return payload?.signedURL ? `${config.supabaseUrl.replace(/\/$/, '')}${payload.signedURL}` : null;
}

async function authRequest(path, { method = 'POST', body, accessToken } = {}) {
  const url = `${config.supabaseUrl.replace(/\/$/, '')}/auth/v1${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${accessToken || config.supabaseAnonKey}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    const error = new Error(payload?.msg || payload?.message || payload?.error_description || 'auth_failed');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const auth = {
  signUp: (email, password) => authRequest('/signup', { body: { email, password } }),
  signIn: (email, password) =>
    authRequest('/token?grant_type=password', { body: { email, password } }),
  recover: (email) =>
    authRequest('/recover', { body: { email } }),
  verifyRecovery: (email, token) =>
    authRequest('/verify', { body: { type: 'recovery', email, token } }),
  updatePassword: (accessToken, password) =>
    authRequest('/user', { method: 'PUT', body: { password }, accessToken }),
  adminDelete: (uid) => authRequest(`/admin/users/${uid}`, { method: 'DELETE' }),
  adminCreate: (email, password, emailConfirmed = true) =>
    authRequest('/admin/users', { body: { email, password, email_confirm: emailConfirmed } })
};

export { supabaseConfigured };
