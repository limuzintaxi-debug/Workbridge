-- WORKBRIDGE migration 003 — the four collections that had no table yet.
--
-- The server writes ride_bookings, mall_vehicles, mall_shops and mall_products,
-- but those tables never existed in the database. loadState() tolerates a single
-- absent table (it returns it in `missing` instead of failing the whole load), so
-- those four collections were being kept in the JSON store only and were lost on
-- every redeploy. This migration creates them.
--
-- Safe to run more than once: every statement is "if not exists" and no existing
-- row is touched. Users, worker/business profiles, jobs, applications,
-- agreements, invoices, payments, commissions, notifications, chat messages,
-- push subscriptions and audit history are preserved exactly as they are.
--
-- Run this in the Supabase SQL Editor for project jpuzzowyvfzpuyitjmde, after
-- migration 002 (or after supabase/schema.sql on a fresh install).

-- ---------------------------------------------------------------------------
-- 1. Tables.
--
-- Same {id, doc, created_at} shape as every other WORKBRIDGE table, so the
-- server's Supabase adapter mirrors them without special cases:
--   loadState()  -> select id,doc order by created_at.asc
--   upsertRows() -> insert/merge {id, doc}
--   deleteRows() -> delete where id in (...)
-- The whole collection is read and filtered in memory, so no extra columns are
-- needed; keeping them out avoids duplicating data and keeps storage minimal.
-- ---------------------------------------------------------------------------

create table if not exists public.ride_bookings (
  id text primary key,
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ride_bookings_created_idx on public.ride_bookings (created_at);

create table if not exists public.mall_vehicles (
  id text primary key,
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mall_vehicles_created_idx on public.mall_vehicles (created_at);

create table if not exists public.mall_shops (
  id text primary key,
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mall_shops_created_idx on public.mall_shops (created_at);

create table if not exists public.mall_products (
  id text primary key,
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mall_products_created_idx on public.mall_products (created_at);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security.
--
-- These endpoints are only ever reached through the WORKBRIDGE server, which
-- decides who may read or write a booking or a listing. Direct browser access is
-- denied outright, exactly like chat_messages and push_subscriptions, so an anon
-- or authenticated token can never read another user's bookings or listings.
-- service_role (the server key) bypasses RLS and keeps working.
-- ---------------------------------------------------------------------------

alter table public.ride_bookings  enable row level security;
alter table public.mall_vehicles  enable row level security;
alter table public.mall_shops     enable row level security;
alter table public.mall_products  enable row level security;

drop policy if exists ride_bookings_no_client_access on public.ride_bookings;
create policy ride_bookings_no_client_access on public.ride_bookings
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists mall_vehicles_no_client_access on public.mall_vehicles;
create policy mall_vehicles_no_client_access on public.mall_vehicles
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists mall_shops_no_client_access on public.mall_shops;
create policy mall_shops_no_client_access on public.mall_shops
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists mall_products_no_client_access on public.mall_products;
create policy mall_products_no_client_access on public.mall_products
  for all to anon, authenticated
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 3. Privileges for the server key.
--
-- RLS is bypassed for service_role but table privileges are not, so they are
-- granted explicitly here as well as through the default privileges set in
-- migration 002. Without this the server would get
-- "permission denied for table ride_bookings" (HTTP 403).
-- ---------------------------------------------------------------------------

grant usage on schema public to service_role;
grant all on public.ride_bookings to service_role;
grant all on public.mall_vehicles to service_role;
grant all on public.mall_shops to service_role;
grant all on public.mall_products to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- ---------------------------------------------------------------------------
-- 4. Confirmation.
--
-- Run this afterwards to confirm all four tables exist and are writable:
--   select table_name from information_schema.tables
--    where table_schema = 'public'
--      and table_name in ('ride_bookings','mall_vehicles','mall_shops','mall_products');
-- It must return four rows. /api/health then reports storage.missing_tables as
-- empty (or omits it) instead of listing these four collections.
-- ---------------------------------------------------------------------------
