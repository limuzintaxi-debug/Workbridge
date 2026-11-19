# Workbridge
Digital Employment and Business Platform

WORKBRIDGE connects **workers, businesses and support organizations**: find work,
make agreements, create invoices, and let institutions offer social support — as a
mobile-first, installable Progressive Web App.

- Tagline: **Booking • Agreement • Institutional & Social Support • Invoice Maker**
- **Connecting Workers, Businesses & Support Organizations**
- **Find Work • Make Agreements • Create Invoices**

## Quick start

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end smoke test (23 checks)
```

The app runs immediately with a local demo data store. No credentials required.
Copy `.env.example` to `.env` to override the port or to prepare Supabase.

### Demo accounts (dummy data only)

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@workbridge.test` | `Admin#12345` |
| Worker | `worker@workbridge.test` | `Worker#12345` |
| Business | `business@workbridge.test` | `Business#12345` |

Admin sign-in lives at `/#/admin/signin` and is linked only from the footer.
There is no public admin registration.

## What is implemented

**Public home (`/`)** — WORKBRIDGE logo and name, the exact tagline and subtitle
lines, two panels (WORKER / BUSINESS, each with Sign Up and Sign In), the
red-and-white network globe with the black-and-white handshake, approved support
organizations, and a Help & Support section using **Limuzin@196vip.si** only.

**Worker panel** — registration with name, phone, Aqama number and skill category
(Driver, Laborer, Electrician, Plumber and more); browse work listings; view details
and apply; notifications for relevant new listings; applications; agreements and
invoices with print/PDF output; profile editing.

**Business panel** — registration and profile; post, edit and close work
opportunities; search workers by name, category and city; review and accept or
reject applications; create agreements and invoices with print/PDF output.

**Listings** are labelled **New**, **24 Hours Old**, **48 Hours Old** or **Older** and
are **never deleted automatically** — only the owner closes them or an admin removes them.

**Agreements** — company and worker details, work description and terms, unique
reference (`WB-AGR-YYYYMMDD-NNNN`), date and time, touchscreen signature pads for
both parties, and a print-ready document.

**Invoice maker** — automatic serial (`WB-INV-YYYYMM-NNNN`), company name, phone,
address and country, service lines, price, VAT rate, server-computed totals,
optional signature and company stamp, print/PDF output.

**Institutional & social support** — public institution registration that always
enters the Admin Panel as *pending*; only approved **names and types** appear in the
worker and business panels. Addresses and contact details are never shown publicly.

**Admin panel** — separate protected login; overview counters; manage and suspend
workers and businesses; approve or reject institutions; moderate listings (close,
remove) and reported content; review agreements and invoices; commission settings
**off by default** with 1% or 2% rates and a payer selection. Nothing is charged.

**PWA** — manifest, maskable icons, service worker, installable from a browser link
on Android. No live location tracking.

## Project structure

```
server/            Express API (single origin, serves the PWA too)
  config.js        Environment and runtime configuration
  security.js      scrypt hashing, HMAC-signed session cookies
  middleware.js    Session resolution and profile lookup
  routes.js        All REST endpoints, validation and authorization
  store.js         Data layer (local JSON now, Supabase migration point)
  util.js          Age buckets, Aqama masking, money rounding, categories
public/            Client: hash router, views, styles, PWA assets
  views/           public, worker, business, admin, docs (agreement/invoice)
supabase/          schema.sql — tables, triggers, RLS policies
scripts/           smoke.test.js — end-to-end API test
docs/              REFACTOR_PROPOSAL.md, DATABASE.md
```

## Architecture in one paragraph

One Node/Express server serves both the JSON API and the static PWA on the same
origin, so the session cookie is `httpOnly` + `SameSite=Lax` and no token ever
reaches JavaScript. The browser never holds a Supabase key. All authorization is
enforced in `server/routes.js` by role; `supabase/schema.sql` adds RLS as an
independent second layer once Supabase is connected. The data layer is isolated in
`server/store.js`, so moving from the demo store to Supabase touches one module.

## Documentation

- `docs/REFACTOR_PROPOSAL.md` — inspection report, planned architecture, acceptance
  criteria and tradeoffs.
- `docs/DATABASE.md` — Supabase setup, RLS summary and the migration path.

## Prototype limits (deliberate)

- Supabase is **not connected** yet: the app runs on the local demo store until
  `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are configured
  and `server/store.js` is pointed at Postgres.
- PDF output uses the browser's print-to-PDF dialog rather than a PDF library, so no
  extra dependency is needed and every phone can save or print the document.
- Test/demo data only. Do not enter real Aqama numbers or signatures.
- Nothing is deployed and no custom domain is configured, as requested.
