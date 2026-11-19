# WORKBRIDGE

Digital employment and business platform for workers, businesses and support
organizations — booking, electronic agreements, institutional & social support,
and an invoice maker — delivered as a mobile-first, installable Progressive Web
App.

- Tagline: **Booking • Agreement • Institutional & Social Support • Invoice Maker**
- **Connecting Workers, Businesses & Support Organizations**
- **Find Work • Make Agreements • Create Invoices**

Interface languages: **English** and **Arabic** (full RTL layout).

## Stack

| Layer | Choice |
| --- | --- |
| Server | Node.js 22+, Express, single process serving API + client on `0.0.0.0:$PORT` |
| Client | Dependency-free ES modules, hash router, no build step |
| Auth | httpOnly signed session cookies, scrypt password hashing, role-based access |
| Data | Supabase (Postgres + Auth + Storage) in production; local JSON store for development |
| Documents | Server-generated PDF (agreements and invoices), private storage + signed URLs |

## Quick start

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end smoke test (24 checks)
```

With no credentials the app runs on the local JSON store (`data/db.json`), which is
the development fallback. Nothing is seeded automatically.

### First run — create the administrator

1. Open `/#/setup`.
2. Enter the administrator email, name and a password of at least 10 characters.
3. This screen closes permanently once an administrator exists.

Admin sign-in is `/#/admin/signin`. There is **no public admin registration**: the
API rejects `role: "admin"` on `/api/auth/register` with `403 role_not_allowed`.

Workers and businesses register themselves from the public home page panels.

## What is implemented

### Public site
- WORKBRIDGE logo and name, approved tagline and subtitle lines.
- Two panels: **WORKER** and **BUSINESS**, each with Sign Up and Sign In.
- Red-and-white network globe with the black-and-white handshake (approved
  Design No. 2), circular WR app icon.
- Approved support organizations only (name and type; never address or contact).
- Help & Support: **Limuzin@196vip.si** only — no phone support, no live chat.
- Institution registration form, routed to the admin queue as `pending`.
- Language switcher (EN / AR) in the top bar.

### Worker panel
- Registration with name, phone, Aqama number (stored masked only) and skill
  category (Driver, Laborer, Electrician, Plumber, …).
- Available listings with age status: **New**, **24 Hours Old**, **48 Hours Old**,
  **Older**. Listings are never auto-deleted; they stay until the owner closes them
  or an admin removes them.
- Job details, apply, application management, notifications for new listings.
- Agreements and invoices with PDF download and print.
- Profile management, account page, password change.

### Business panel
- Registration and business profile.
- Post listings, close listings, review applications, select workers.
- Worker search across registered workers.
- Create agreements, issue invoices, PDF download and print.

### Agreements
- Company/contractor and worker details, work description and terms.
- Unique agreement reference (`WB-AG-…`), date and time.
- **Two-party electronic signing**: both the business and the worker sign on their
  own touchscreen; the server rejects a missing or empty signature image.
- Downloadable PDF, printable, status tracking (`pending` → `signed`).

### Invoice maker
- Automatic serial number (`WB-INV-…`).
- Company name, phone, address and country; service description.
- Price, VAT rate and total computed **on the server**; optional signature and stamp.
- PDF download and print.

### Multi-currency
- SAR, USD, EUR, AED, GBP, PKR, INR, BDT, PHP, EGP and more (30 in the catalog).
- Admin selects the platform default and which currencies are enabled.
- The default propagates to agreements, invoices, listings and every money display;
  currency is never hardcoded in the interface.

### Admin panel
- Separate protected login, no public registration.
- Overview, worker and business management, account suspension.
- Institution review: approve or reject; only approved names become public.
- Listing moderation, reported content, agreements and invoices.
- Platform settings: default/enabled currencies, registration mode
  (`auto` or `review`) per role, commission settings **off by default** with 1% or
  2% rates and payer selection. No commission is collected.

## Configuration

Copy `.env.example` to `.env` (or set these in the hosting dashboard):

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | platform | Port to listen on (hosting provides it) |
| `SESSION_SECRET` | production | Signs session cookies (32+ random characters) |
| `SUPABASE_URL` | production | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | production | Server-side Postgres/Storage access — never expose |
| `SUPABASE_ANON_KEY` | optional | Enables Supabase Auth for sign-up/recovery |
| `APP_URL` | production | Public base URL used in recovery links |
| `SETUP_TOKEN` | recommended | Required once for `POST /api/setup/admin` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | optional | Non-interactive admin bootstrap |
| `DATA_DIR` | optional | Local cache directory (default `./data`) |
| `SEED_DEMO` | optional | `1` seeds throwaway demo rows for development only |

Secrets are read from the environment only. No key is ever written to source or sent
to the browser.

## Supabase (production database)

Full instructions: [`docs/DATABASE.md`](docs/DATABASE.md).

1. Create a Supabase project.
2. Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor — tables,
   indexes, triggers, RLS policies for every table, the public institution view and
   the two private storage buckets.
3. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_ANON_KEY` for
   Supabase Auth), then restart.

The server checks the schema on boot and reports
`supabase_schema_missing` with the exact tables to create if the SQL was not run.

## Tests

`npm test` boots the real server on a throwaway data directory and exercises 24
checks: setup, registration, role rules, masked Aqama, listing lifecycle and age
buckets, applications, agreements with two signatures, invoice VAT totals,
institution approval and public visibility, admin moderation, commission settings,
session suspension, per-role document scoping and PWA assets.

## Deployment

The repository includes a `Dockerfile` that installs production dependencies and
starts the server on the platform port. The server binds `0.0.0.0` and reads
`PORT`, so it works behind the platform proxy without extra configuration.

Health check: `GET /api/health`.

### Custom domain

Connecting a custom domain requires a paid AppJet plan (Starter or Pro, Settings →
Billing). On the Free plan the app is served on its AppJet URL only.

### Durable data

The Free hosting plan has no persistent disk, so `data/db.json` is cleared when a
new release is rolled out. For durable production data configure Supabase (above):
the server then mirrors every collection into Postgres and only keeps the JSON file
as a fast local cache.

## Security notes

- Passwords: scrypt with per-user salt; never logged or returned.
- Sessions: signed, httpOnly, SameSite=Lax cookies with expiry and server-side
  revocation when an account is suspended.
- Aqama numbers: stored masked (`••••1234`) only — full numbers are never persisted.
- Authorization is enforced per route by role, and documents are scoped to the two
  parties involved (admins excepted).
- Supabase RLS is enabled on every table; the service-role key stays server-side.
- Institutional contact details are never returned by any public endpoint.
- Rate limiting protects authentication and write endpoints.

## Limitations

- No live location tracking (by design).
- Prototype policy: do not enter real Aqama numbers or real signatures; the UI and
  docs state this.
- Email delivery for password recovery depends on Supabase Auth (or the configured
  SMTP provider); without it, recovery links are surfaced only to the server log in
  development.
