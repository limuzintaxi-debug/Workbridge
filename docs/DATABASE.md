# WORKBRIDGE — Database & Supabase Setup

The application ships with a **local demo data store** so it runs immediately without
credentials, and a **complete Supabase schema** for the real deployment.

```
Browser (PWA)
   │  fetch /api/*  (session cookie, httpOnly)
   ▼
Express server  ── server/routes.js ──► server/store.js ──► local JSON (demo mode)
                                          │
                                          └──► Supabase (Postgres + Auth)  ← migration target
```

## 1. What is already in the repository

| Path | Purpose |
| --- | --- |
| `supabase/schema.sql` | Full table������������������������������������������姤契合 profile |

##姤트 management |
|姫** — **`姉พาะ row 500姫1990. `姘嘴 of **up姹心 Supabase profile姹晰/area:姤词Node 0姹闭ịnh/Merge姞窗口7 |
| `server/store.js` | The single data-layer module. Swap point for Supabase. |
| `server/routes.js` | All REST endpoints, authorization and validation. |
| `.env.example` | Required environment variables. |

## 2. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run the entire contents of `supabase/schema.sql`.
   It creates tables, indexes, triggers and every Row Level Security policy.
3. In **Authentication → Providers**, keep Email enabled. Turn **off** "Enable sign-ups"
   only if you want to invite users manually; the app's own registration form
   calls `supabase.auth.signUp`.
4. Create your administrator:
   - **Authentication → Users → Add user** (email + password).
   - In SQL Editor, promote that account:
     ```sql
     update public.profiles
        set role = 'admin', full_name = 'WORKBRIDGE Administrator'
      where id = '<the user uuid>';
     ```
   There is **no public admin registration** anywhere in the UI or API.

## 3. Configure the server

Add these in **Settings → Environment variables** (never in client code):

| Variable | Where to find it | Exposure |
| --- | --- | --- |
| `SUPABASE_URL` | Project Settings → API → Project URL | public |
| `SUPABASE_ANON_KEY` | Project Settings → API → anon public key | public |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role key | **server only — never send to the browser** |
| `SESSION_SECRET` | Generate a long random string | server only |

The service-role key is only ever read by `server/config.js` on the server. The browser
talks to `/api/*` on the same origin and never receives a Supabase key.

## 4. Migration path (local store → Supabase)

`server/store.js` exposes exactly three functions to the rest of the server:

```js
data()               // returns the collections: users, workerProfiles, businessProfiles,
                     // jobs, applications, agreements, invoices, institutions,
                     // notifications, reports, settings, meta
persist()            // flushes pending writes
nextCounter(name)    // atomic serial numbers (agreements, invoices)
```

To move to Supabase, reimplement those three functions against Postgres
(`@supabase/supabase-js` with the service role key) and keep `server/routes.js`
unchanged. Every route already performs its own authorization check, so RLS is a
second, independent layer rather than the only one.

Recommended order:

1. Run `supabase/schema.sql`.
2. Create one worker, one business and one admin account.
3. Point `store.js` at Supabase.
4. Delete `data/db.json` and set `DATA_DIR` to a path you no longer use.
5. Re-run `npm test` — the smoke test is storage-agnostic.

## 5. Row Level Security summary

RLS is enabled on **every** table. Highlights:

- `profiles` — a user sees and edits only their own row; admins see all. A trigger
  blocks role/status changes by anyone who is not an admin.
- `worker_profiles` — workers own their row; businesses may read worker rows to
  search for staff; the Aqama number is stored **masked only** (`aqama_masked`).
- `jobs` — open listings are readable by all signed-in users; only the owning
  business (role `business`) can create; owner or admin can update; only admin deletes.
- `applications` — visible to the applying worker and the listing owner only.
- `agreements` / `invoices` — visible to the two parties / the issuer and admin.
- `institutions` — insert allowed for anyone but forced to `status = 'pending'`;
  the table itself is admin-only for reads. The public directory is the
  `institution_directory` view exposing **only** `id, name, type` for approved rows,
  so addresses and contact details are never public.
- `app_settings` — readable so the UI can show the commission state; writable by admin only.
- `counters` — no policies at all: only the service role can touch serial counters.

## 6. Rules honoured by the schema

- No live location tracking: no location columns are collected.
- No commission is collected: `commission_enabled` defaults to `false`; only 1% and 2%
  are allowed by the check constraint, and nothing is charged while it is off.
- Prototype data only: seed/demo accounts use `@workbridge.test` addresses and
  obviously fake Aqama numbers. Do not enter real Aqama numbers or signatures
  into this prototype.
