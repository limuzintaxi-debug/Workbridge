# WORKBRIDGE — Inspection Report & Refactor Proposal

## 1. Inspection of the existing repository

| Item | Observed |
| --- | --- |
| Files in repository | `README.md` only |
| Framework | None (no `package.json`, no source directory) |
| Backend | None |
| Database / Supabase | Not connected (no `.env`, no client code, no migrations) |
| Tests / CI | None |
| Deployment config | None |

**Conclusion:** there is no application code to refactor. This is a *greenfield build inside the
already-connected repository*. The existing `README.md` is preserved (its description is accurate
and still matches the product) and extended with setup instructions.

Nothing is deleted. No second repository and no unrelated project is created.

### What must be created

1. A runnable server (API + static hosting of the client) on `0.0.0.0:$PORT`.
2. A mobile-first single-page client (hash router, no build step) for the public site and the
   Worker / Business / Admin panels.
3. A data layer with **one interface** so the local demo store can be replaced by Supabase
   without touching routes or views.
4. PWA assets (manifest, service worker, WR logo, circular app icon).
5. `supabase/schema.sql` with tables, constraints and Row Level Security policies.
6. Documentation: architecture, database setup, and this proposal.
7. An automated smoke check (`npm test`) that exercises the real workflows end to end.

## 2. Target architecture

```
Browser (PWA)
  public/index.html + app.js (hash router)
  public/views/{public,worker,business,admin,docs}.js
  public/api.js  ── fetch('/api/...') with cookie session
        │
        ▼
Node + Express server (single process, serves client + API)
  server/index.js      bootstrap, static, SPA fallback, error handler
  server/middleware.js cookie session → req.user
  server/security.js   scrypt password hashing, HMAC-signed session cookie
  server/routes.js     REST endpoints, role checks, validation
  server/store.js      data layer (collections + persistence)  ◄── swap point
  server/util.js       listing age buckets, Aqama masking, money rounding
        │
        ▼
  Local JSON store (now, demo mode)      Supabase Postgres + Auth (when connected)
```

### How frontend, backend and Supabase connect

- **Frontend → backend:** JSON over `/api/*`, `HttpOnly` cookie session (`wb_session`), signed
  with `SESSION_SECRET`. The browser never receives a database key.
- **Backend → Supabase (target state):** the server uses `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` (server-side only) for privileged writes, while end users
  authenticate through Supabase Auth and are additionally protected by RLS policies that key on
  `auth.uid()`. RLS is the second line of defence: even if a token leaks, Postgres refuses
  cross-tenant reads.
- **Today (no credentials):** `server/store.js` persists to `data/db.json` behind the same
  function surface, so switching to Supabase is a single-module change plus running
  `supabase/schema.sql`.

### Why the API is the only door

The brief requires private data protection, no service-role keys in frontend code, and
role-based access for Worker / Business / Admin. A thin API keeps every rule (who may post a job,
who may sign an agreement, which institution fields are public) in one testable place instead of
duplicated in client code.

## 3. Acceptance criteria

Each line is verifiable and is covered by `npm test` unless marked *manual*.

### Public site
1. `GET /` returns the app shell; the home page shows the WORKBRIDGE name, the exact tagline
   `Booking • Agreement • Institutional & Social Support • Invoice Maker`, the line
   `Connecting Workers, Businesses & Support Organizations`, and `Find Work • Make Agreements • Create Invoices`.
2. Two entry panels exist: WORKER (Sign Up / Sign In) and BUSINESS (Sign Up / Sign In).
3. Admin login is a separate route (`#/admin/signin`) with **no** public admin registration.
4. `POST /api/auth/register` with `role=admin` returns 403.
5. All interface text is English.

### Worker
6. Registration collects name, phone, Aqama number (stored masked, last 4 only), work
   category/skill, city, experience.
7. Available listings list with age badge: `New` (<24 h), `24 Hours Old` (24–48 h),
   `48 Hours Old` (48–72 h), `Older` (>72 h).
8. Listings are never auto-deleted; they persist until the owner closes them or an admin removes them.
9. A worker can open a listing, apply, and see the application status.
10. A worker receives a notification when a listing matching their category is posted.
11. Worker panel exposes Agreement and Invoice sections with a print/save-as-PDF view.

### Business
12. Registration + profile (company name, contact, phone, country, address).
13. Business can post a listing, close it, and see applications received.
14. Business can search workers by name/skill/category and view profiles (no Aqama data).
15. Business panel exposes Agreement and Invoice sections with a print/save-as-PDF view.

### Agreements
16. Agreement contains company details, worker details, work description, terms, dates and pay.
17. Both parties sign on a touch/mouse canvas; signatures are stored as image data.
18. Unique reference `WB-AGR-YYYYMMDD-NNNN` and a creation timestamp are generated server-side.
19. Status becomes `signed` only when both signatures exist; the other party is notified.
20. A print view renders the full agreement for PDF saving/printing.

### Invoices
21. Unique serial `WB-INV-YYYYMM-NNNN`, generated server-side.
22. Issuer company name, phone, address, country; line items with description, quantity, unit price.
23. Subtotal, VAT amount and total are computed **on the server** from `vat_rate`; client-sent
    totals are ignored.
24. Optional signature and stamp images render in the PDF view.

### Institutions & support
25. `POST /api/institutions` is public and always creates `status = pending`.
26. Only `approved` institutions are listed to Worker/Business, and only `id`, `name`, `type` are
    returned — never address, phone or email.
27. Admin can approve or reject with a note.
28. Help & Support shows exactly `Limuzin@196vip.si` — no phone support, no live chat.

### Admin
29. Admin routes require an admin session; worker/business sessions get 403.
30. Admin can list and suspend/activate workers and businesses.
31. Admin can close (`closed`) or remove (`removed`) listings and resolve reports.
32. Admin can list agreements and invoices.
33. Commission settings default to `enabled: false`; rates accept only 0, 1 or 2 percent with a
    payer of `business`, `worker` or `both`; nothing is ever added to a document total.

### Security & platform
34. Passwords are stored as scrypt hashes with per-user salt; sessions are HMAC-signed and expire.
35. `GET /api/jobs` without a session returns 401; a worker posting a job returns 403.
36. `supabase/schema.sql` enables RLS on every table with per-role policies.
37. No real personal data: all seed records are synthetic `*.test` demo accounts; Aqama values
    are masked to their last 4 characters before storage.
38. `manifest.webmanifest`, `sw.js` and 192/512 px icons are served, so the app is installable
    from a web link on Android.
39. No geolocation API is used anywhere in the client.

## 4. Tradeoffs and decisions

| Decision | Alternative | Why chosen | Cost / tradeoff |
| --- | --- | --- | --- |
| Vanilla ES-module SPA, no bundler | React/Vite | Zero build step, instant start, tiny payload, no lockfile churn; the panels are form-and-list heavy, not state-machine heavy | Manual DOM rendering; a large team would eventually want a component framework |
| Server-side rendering of HTML strings in `views/*.js` | Client templating library | Keeps markup readable in one file per panel and escapes through a single `esc()` helper | Must stay disciplined about escaping user input |
| Single Express process serving API + static files | Separate frontend/backend services | One deploy unit, same-origin cookies (no CORS, no token in localStorage) | Scales as a unit; fine for this stage |
| Cookie session signed with HMAC + server-side user lookup | JWT | Revocation is immediate (suspend a user and the session dies), no token in JS-accessible storage | Requires the secret to be set (`SESSION_SECRET`); sessions reset on restart if unset |
| Local JSON store now, Supabase adapter later | Wait for Supabase credentials | Delivers a functional app today and keeps one interface to swap | Demo data is per-instance and not shared between deployments; real auth/RLS arrives with credentials |
| Server computes VAT and totals | Trusting client totals | Prevents tampering and rounding disputes | Server owns the money math, so currency rules must live there |
| PDF via a print stylesheet + `window.print()` | Headless PDF service (Puppeteer/pdfkit) | No heavy dependency, works offline in the PWA, native "Save as PDF" on Android/iOS | Output is styled by the browser print dialog rather than a byte-exact PDF file |
| Masked Aqama (last 4 only) | Store full number | The brief forbids collecting real Aqama numbers in the prototype; masking makes that structurally true | Not production-complete identity verification — a documented follow-up |
| Commission settings stored but never applied | Wire commission into invoice totals | The brief says do not collect commission now | Enabling it later is a deliberate migration, not a silent behaviour change |
| Institutions list shows name + type only | Full institution directory | Privacy requirement in the brief | Workers cannot contact institutions directly; support goes through the email address |

## 5. Known limitations / follow-ups

1. **Supabase is not connected.** Auth and persistence run on the local demo store. When
   credentials are added: run `supabase/schema.sql`, then implement the Supabase adapter in
   `server/store.js` (documented in `docs/DATABASE.md`).
2. **PDF output is print-to-PDF**, not a generated binary file. A server-side PDF service is the
   upgrade path if byte-exact archives are needed.
3. **Approved design assets were not in the repository** (only a text README). The home page and
   logo/icon follow the written brand description — navy W, orange R, orange swoosh, red-and-white
   network globe, black-and-white handshake, circular icon without the wordmark. Drop the original
   artwork into `public/assets/` to replace the reconstructions without touching layout code.
4. **No file uploads**: signatures and stamps are captured as image data URLs inside the document
   record, which keeps the prototype dependency-free but is not where large assets belong.
5. **No deployment and no custom domain**, per instruction.
