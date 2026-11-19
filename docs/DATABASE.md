# WORKBRIDGE — Database Setup (Supabase / Postgres)

This document describes the production database: the table contract, Row Level
Security policies, storage buckets, and how to verify the setup.

The application has a single data layer, `server/store.js`. It keeps an in-memory
state, writes a local JSON cache, and — when Supabase credentials are present —
mirrors every collection into Postgres and reads it back on boot.

```
Browser (ES modules, hash router)
        │  fetch /api/*  (httpOnly signed session cookie)
        ▼
Express server (server/index.js)
        │  role checks + ownership checks per route
        ▼
server/store.js  ──►  data/db.json      (fast local cache)
        │
        └────────►  Supabase Postgres  (source of truth)
                    Supabase Storage    (agreements/ and invoices/ PDFs)
                    Supabase Auth       (optional: sign-up, recovery)
```

## 1. Create the project

1. Create a project at <https://supabase.com>.
2. Open **SQL Editor** and run the entire contents of
   [`supabase/schema.sql`](../supabase/schema.sql). It is idempotent.
3. Copy the values from **Project Settings → API**:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server only)
   - `anon` key → `SUPABASE_ANON_KEY` (optional, enables Supabase Auth)

Set them as environment variables in the hosting dashboard (Settings →
Environment variables) or in `.env` for local development. **Never** put the
service-role key in client code or commit it.

## 2. Table contract

Every application collection is stored as one table with two columns:

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `text primary key` | Record id (same id the app uses) |
| `doc` | `jsonb not null` | The complete record |
| `created_at` / `updated_at` | `timestamptz` | Bookkeeping, maintained by trigger |

`doc` keeps the record exactly as the server produced it, so a schema change in the
application does not require a column migration. Generated columns are added on top
for indexing and RLS, and are always derived from `doc` — they never drift.

| Table | Generated columns used by RLS |
| --- | --- |
| `users` | `role`, `status`, `auth_id` |
| `worker_profiles` | `user_id`, `status` |
| `business_profiles` | `user_id`, `status` |
| `institutions` | `user_id`, `status` |
| `jobs` | `business_id`, `status` |
| `applications` | `job_id`, `worker_id`, `status` |
| `agreements` | `business_id`, `worker_id`, `status` |
| `invoices` | `business_id`, `worker_id`, `status`, `currency` |
| `notifications` | `user_id`, `read_at` |
| `reports` | `reporter_id`, `status` |
| `payments` | `business_id`, `worker_id`, `currency` |
| `password_reset_tokens` | `user_id` |
| `audit_log` | `actor_id`, `action` |
| `app_settings` | single row `id = 'global'`, settings in `doc` |

`app_settings` is written by the adapter as `{ id: 'global', doc }`; the admin
currency, registration and commission settings live there.

## 3. Row Level Security

RLS is enabled on **every** table. The server connects with the service-role key,
which bypasses RLS for trusted server logic; the policies below protect any access
made with the anon key (for example a future direct-from-browser client) and are the
safety net if a key is ever misused.

Policy matrix:

| Table | anon | authenticated owner | admin |
| --- | --- | --- | --- |
| `users` | none | read/update own row | full |
| `worker_profiles`, `business_profiles` | none | read/update own row | full |
| `institutions` | **names of approved rows only**, via the view | read/insert own row | full |
| `jobs` | none | business owns, worker reads `open` | full |
| `applications` | none | worker owns, business reads own listings' | full |
| `agreements`, `invoices` | none | the two parties only | full |
| `notifications` | none | read/update own | full |
| `reports` | none | insert own, read own | full |
| `payments` | none | the two parties | full |
| `password_reset_tokens` | none | none (server only) | server only |
| `audit_log` | none | none | read |
| `app_settings` | none | none | read/write |

Admin status is resolved through `public.is_admin()`, which reads the caller's role
from `users` by `auth.uid()`.

### Public institution directory

Addresses and contact details must never be public. The only public surface is the
view:

```sql
select * from public.institution_directory;   -- name, type, status = 'approved'
```

It exposes **name and type only**, filtered to approved rows. Worker and business
panels use this for the institution list.

## 4. Storage

Two **private** buckets are created by the schema:

| Bucket | Contents |
| --- | --- |
| `agreements` | generated agreement PDFs |
| `invoices` | generated invoice PDFs |

No client-side storage policy grants public or anonymous reads. The server uploads
with the service-role key and serves downloads through short-lived signed URLs
(`/api/documents/signed-url`, 10 minutes). If a bucket is missing, the API responds
`409 storage_unavailable` and the app still renders documents for printing.

## 5. Verifying the setup

```sql
-- tables present
select table_name from information_schema.tables
where table_schema = 'public' order by 1;

-- RLS enabled everywhere (expect zero rows)
select tablename from pg_tables
where schemaname = 'public' and not rowsecurity;

-- policies per table
select tablename, count(*) from pg_policies
where schemaname = 'public' group by 1 order by 1;

-- buckets
select id, public from storage.buckets;
```

In the application, `GET /api/health` reports the active persistence driver, and the
admin **Settings → Infrastructure** card shows whether Supabase persistence and auth
are configured and whether the last sync succeeded.

## 6. Migrations

Because records live in `doc`, additive changes need no migration. For a new
collection:

1. Add the table to `COLLECTION_TABLES` in `server/supabase.js`.
2. Add the matching `create table` + RLS block to `supabase/schema.sql`.
3. Re-run the schema file (idempotent) and deploy.

For a new generated column used by a policy, add it as
`generated always as (doc->>'field') stored`, then update the policy.

## 7. Moving data between environments

The local JSON cache and Postgres are interchangeable through the adapter:

- **JSON → Supabase:** configure the credentials and restart. On first boot the
  server loads an empty database, then flushes the current state on the next write;
  to migrate an existing local dataset, point `DATA_DIR` at the existing
  `db.json` and trigger any write (for example create an administrator).
- **Supabase → JSON:** remove the Supabase variables and restart with the last
  cache file in place, or export with
  `select doc from public.<table> order by created_at;`.

## 8. Backup and retention

- Supabase provides daily backups on paid tiers; use `pg_dump` for on-demand copies.
- Listings are never auto-deleted after 48 hours — they stay until the owner closes
  them or an admin removes them. Age is computed from `doc.created_at`.
- Audit rows in `audit_log` record administrative actions and are append-only.
