-- ============================================================================
-- WORKBRIDGE — Supabase schema, Row Level Security and policies
-- ----------------------------------------------------------------------------
-- Run this whole file once in the Supabase SQL Editor (or with `psql`) on a new
-- project. It is idempotent enough to re-run while developing.
--
-- Roles
--   worker   self-registers, applies for work, signs agreements, issues invoices
--   business self-registers, posts listings, reviews workers, issues invoices
--   admin    created only by an operator (never self-registered), sees everything
--
-- Security model
--   * Every table has RLS enabled and a policy for each allowed operation.
--   * `auth.uid()` identifies the caller; `public.is_admin()` gates admin work.
--   * The service role key stays on the server (never in the browser).
--   * Public institution data is exposed ONLY through the
--     `public.institution_directory` view (name + type, approved rows only).
--     Addresses and contact details are admin-only.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- helpers ---

create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role() = 'admin', false);
$$;

-- --------------------------------------------------------------- profiles ---

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        text not null default 'worker' check (role in ('worker', 'business', 'admin')),
  email       text not null,
  full_name   text not null default '',
  phone       text not null default '',
  status      text not null default 'active' check (status in ('active', 'suspended')),
  created_at  timestamptz not null default now()
);

create table if not exists public.worker_profiles (
  user_id          uuid primary key references public.profiles (id) on delete cascade,
  category         text not null default 'Other',
  -- Prototype only: store a masked Aqama reference, never the full number.
  aqama_masked     text not null default '',
  city             text not null default '',
  experience_years int  not null default 0 check (experience_years between 0 and 60),
  skills           text[] not null default '{}',
  bio              text not null default '',
  available        boolean not null default true,
  updated_at       timestamptz not null default now()
);

create table if not exists public.business_profiles (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  company_name text not null default '',
  contact_name text not null default '',
  phone        text not null default '',
  country      text not null default '',
  address      text not null default '',
  website      text not null default '',
  about        text not null default '',
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------- jobs ---

create table if not exists public.jobs (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.profiles (id) on delete cascade,
  title        text not null,
  category     text not null,
  description  text not null,
  location     text not null default '',
  pay_amount   numeric(12, 2) not null default 0 check (pay_amount >= 0),
  pay_period   text not null default 'day' check (pay_period in ('hour', 'day', 'week', 'month', 'project')),
  requirements text not null default '',
  status       text not null default 'open' check (status in ('open', 'closed', 'removed')),
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);

-- Listings are never deleted on a timer: they are closed by the owner or
-- removed by an admin. Age is derived at read time (see jobs_age_bucket).
create index if not exists jobs_status_created_idx on public.jobs (status, created_at desc);
create index if not exists jobs_business_idx on public.jobs (business_id);

create or replace function public.jobs_age_bucket(created_at timestamptz)
returns text
language sql
stable
as $$
  select case
    when now() - created_at < interval '24 hours' then 'new'
    when now() - created_at < interval '48 hours' then '24h'
    when now() - created_at < interval '72 hours' then '48h'
    else 'older'
  end;
$$;

-- ----------------------------------------------------------- applications ---

create table if not exists public.applications (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.jobs (id) on delete cascade,
  worker_id  uuid not null references public.profiles (id) on delete cascade,
  message    text not null default '',
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at timestamptz not null default now(),
  unique (job_id, worker_id)
);

create index if not exists applications_worker_idx on public.applications (worker_id);

-- ------------------------------------------------------------- agreements ---

create table if not exists public.agreements (
  id          uuid primary key default gen_random_uuid(),
  ref         text not null unique,
  business_id uuid not null references public.profiles (id) on delete cascade,
  worker_id   uuid not null references public.profiles (id) on delete cascade,
  job_id      uuid references public.jobs (id) on delete set null,
  scope       text not null,
  terms       text not null,
  start_date  date,
  end_date    date,
  pay_amount  numeric(12, 2) not null default 0 check (pay_amount >= 0),
  pay_period  text not null default 'day' check (pay_period in ('hour', 'day', 'week', 'month', 'project')),
  status      text not null default 'draft' check (status in ('draft', 'partially_signed', 'signed', 'cancelled')),
  signatures  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agreements_parties_idx on public.agreements (business_id, worker_id);

-- --------------------------------------------------------------- invoices ---

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  serial          text not null unique,
  issuer_user_id  uuid not null references public.profiles (id) on delete cascade,
  issuer_name     text not null default '',
  issuer_phone    text not null default '',
  issuer_address  text not null default '',
  issuer_country  text not null default '',
  client_name     text not null default '',
  client_phone    text not null default '',
  client_address  text not null default '',
  client_country  text not null default '',
  currency        text not null default 'AED',
  items           jsonb not null default '[]'::jsonb,
  vat_rate        numeric(5, 2) not null default 0 check (vat_rate >= 0 and vat_rate <= 100),
  subtotal        numeric(12, 2) not null default 0,
  vat_amount      numeric(12, 2) not null default 0,
  total           numeric(12, 2) not null default 0,
  notes           text not null default '',
  signature       text,
  stamp           text,
  created_at      timestamptz not null default now()
);

create index if not exists invoices_issuer_idx on public.invoices (issuer_user_id, created_at desc);

-- ----------------------------------------------------------- institutions ---

create table if not exists public.institutions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  type         text not null default 'Other',
  email        text not null,
  contact_name text not null default '',
  phone        text not null default '',
  address      text not null default '',
  description  text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_note   text not null default '',
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz,
  reviewed_by  uuid references public.profiles (id) on delete set null
);

-- Public directory: approved institutions, name and type only.
create or replace view public.institution_directory
with (security_invoker = false) as
  select id, name, type
  from public.institutions
  where status = 'approved';

revoke all on public.institution_directory from anon, authenticated;
grant select on public.institution_directory to anon, authenticated;

-- ---------------------------------------------------------- notifications ---

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  body       text not null default '',
  link       text not null default '',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------- reports ---

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_type text not null check (target_type in ('job', 'user', 'agreement', 'invoice')),
  target_id   text not null,
  reason      text not null,
  status      text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

-- --------------------------------------------------------------- settings ---

create table if not exists public.app_settings (
  id                 int primary key default 1 check (id = 1),
  commission_enabled boolean not null default false,
  commission_rate    int  not null default 1 check (commission_rate in (1, 2)),
  commission_payer   text not null default 'business' check (commission_payer in ('business', 'worker', 'split')),
  updated_at         timestamptz not null default now()
);

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.counters (
  name  text primary key,
  value bigint not null default 1000
);

-- ============================================================================
-- Signup: create the profile rows from auth metadata.
-- The requested role is honoured only for worker/business; admin can never be
-- obtained through public signup.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  requested   text  := coalesce(meta ->> 'role', 'worker');
  safe_role   text  := case when requested in ('worker', 'business') then requested else 'worker' end;
begin
  insert into public.profiles (id, role, email, full_name, phone)
  values (
    new.id,
    safe_role,
    coalesce(new.email, ''),
    coalesce(meta ->> 'full_name', ''),
    coalesce(meta ->> 'phone', '')
  )
  on conflict (id) do nothing;

  if safe_role = 'worker' then
    insert into public.worker_profiles (user_id, category, city)
    values (new.id, coalesce(meta ->> 'category', 'Other'), coalesce(meta ->> 'city', ''))
    on conflict (user_id) do nothing;
  else
    insert into public.business_profiles (user_id, company_name, contact_name, phone, country, address)
    values (
      new.id,
      coalesce(meta ->> 'company_name', meta ->> 'full_name', ''),
      coalesce(meta ->> 'full_name', ''),
      coalesce(meta ->> 'phone', ''),
      coalesce(meta ->> 'country', ''),
      coalesce(meta ->> 'address', '')
    )
    on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Nobody except an admin may change a role or an account status.
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Only an administrator can change an account role.';
    end if;
    if new.status is distinct from old.status then
      raise exception 'Only an administrator can change an account status.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profile_changes();

-- Institutional registrations always start pending, whatever the client sends.
create or replace function public.force_pending_institution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    new.status := 'pending';
    new.admin_note := '';
    new.reviewed_at := null;
    new.reviewed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists institutions_pending on public.institutions;
create trigger institutions_pending
  before insert on public.institutions
  for each row execute function public.force_pending_institution();

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.profiles        enable row level security;
alter table public.worker_profiles enable row level security;
alter table public.business_profiles enable row level security;
alter table public.jobs            enable row level security;
alter table public.applications    enable row level security;
alter table public.agreements      enable row level security;
alter table public.invoices        enable row level security;
alter table public.institutions    enable row level security;
alter table public.notifications   enable row level security;
alter table public.reports         enable row level security;
alter table public.app_settings    enable row level security;
alter table public.counters        enable row level security;

-- profiles ------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- worker_profiles -----------------------------------------------------------
-- Businesses may read worker profiles to search for staff (masked Aqama only).
drop policy if exists worker_profiles_read on public.worker_profiles;
create policy worker_profiles_read on public.worker_profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_admin()
    or public.current_role() = 'business'
  );

drop policy if exists worker_profiles_write on public.worker_profiles;
create policy worker_profiles_write on public.worker_profiles
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- business_profiles ---------------------------------------------------------
drop policy if exists business_profiles_read on public.business_profiles;
create policy business_profiles_read on public.business_profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.jobs j where j.business_id = business_profiles.user_id and j.status = 'open')
  );

drop policy if exists business_profiles_write on public.business_profiles;
create policy business_profiles_write on public.business_profiles
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- jobs ----------------------------------------------------------------------
drop policy if exists jobs_read on public.jobs;
create policy jobs_read on public.jobs
  for select to authenticated
  using (status = 'open' or business_id = auth.uid() or public.is_admin());

drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs
  for insert to authenticated
  with check (business_id = auth.uid() and public.current_role() = 'business');

drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs
  for update to authenticated
  using (business_id = auth.uid() or public.is_admin())
  with check (business_id = auth.uid() or public.is_admin());

drop policy if exists jobs_delete on public.jobs;
create policy jobs_delete on public.jobs
  for delete to authenticated
  using (public.is_admin());

-- applications --------------------------------------------------------------
drop policy if exists applications_read on public.applications;
create policy applications_read on public.applications
  for select to authenticated
  using (
    worker_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.jobs j where j.id = applications.job_id and j.business_id = auth.uid())
  );

drop policy if exists applications_insert on public.applications;
create policy applications_insert on public.applications
  for insert to authenticated
  with check (
    worker_id = auth.uid()
    and public.current_role() = 'worker'
    and exists (select 1 from public.jobs j where j.id = job_id and j.status = 'open')
  );

drop policy if exists applications_update on public.applications;
create policy applications_update on public.applications
  for update to authenticated
  using (
    worker_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.jobs j where j.id = applications.job_id and j.business_id = auth.uid())
  )
  with check (
    worker_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.jobs j where j.id = applications.job_id and j.business_id = auth.uid())
  );

-- agreements ----------------------------------------------------------------
drop policy if exists agreements_read on public.agreements;
create policy agreements_read on public.agreements
  for select to authenticated
  using (worker_id = auth.uid() or business_id = auth.uid() or public.is_admin());

drop policy if exists agreements_insert on public.agreements;
create policy agreements_insert on public.agreements
  for insert to authenticated
  with check (
    public.is_admin()
    or (business_id = auth.uid() and public.current_role() = 'business')
  );

drop policy if exists agreements_update on public.agreements;
create policy agreements_update on public.agreements
  for update to authenticated
  using (worker_id = auth.uid() or business_id = auth.uid() or public.is_admin())
  with check (worker_id = auth.uid() or business_id = auth.uid() or public.is_admin());

-- invoices ------------------------------------------------------------------
drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices
  for select to authenticated
  using (issuer_user_id = auth.uid() or public.is_admin());

drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices
  for insert to authenticated
  with check (issuer_user_id = auth.uid() or public.is_admin());

drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices
  for update to authenticated
  using (issuer_user_id = auth.uid() or public.is_admin())
  with check (issuer_user_id = auth.uid() or public.is_admin());

-- institutions --------------------------------------------------------------
-- Anyone (even signed out) may submit a registration, but it is forced to
-- 'pending' by the trigger above. Only admins can read or review the table.
drop policy if exists institutions_insert on public.institutions;
create policy institutions_insert on public.institutions
  for insert to anon, authenticated
  with check (true);

drop policy if exists institutions_admin_read on public.institutions;
create policy institutions_admin_read on public.institutions
  for select to authenticated
  using (public.is_admin());

drop policy if exists institutions_admin_update on public.institutions;
create policy institutions_admin_update on public.institutions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- notifications -------------------------------------------------------------
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- reports -------------------------------------------------------------------
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to authenticated
  with check (reporter_id = auth.uid());

drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports
  for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

drop policy if exists reports_update on public.reports;
create policy reports_update on public.reports
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- settings ------------------------------------------------------------------
drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings
  for select to anon, authenticated
  using (true);

drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- counters: server-side (service role) only — no policies on purpose.
-- RLS enabled with zero policies means anon/authenticated can read nothing.

-- ============================================================================
-- Table privileges: RLS filters rows, GRANT decides which verbs are reachable.
-- ============================================================================

revoke all on all tables in schema public from anon, authenticated;

grant select on public.institution_directory to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, update on public.worker_profiles to authenticated;
grant select, update on public.business_profiles to authenticated;
grant select, insert, update on public.jobs to authenticated;
grant select, insert, update on public.applications to authenticated;
grant select, insert, update on public.agreements to authenticated;
grant select, insert, update on public.invoices to authenticated;
grant insert on public.institutions to anon, authenticated;
grant select, update on public.institutions to authenticated;
grant select, update on public.notifications to authenticated;
grant select, insert on public.reports to authenticated;
grant update on public.reports to authenticated;
grant select on public.app_settings to anon, authenticated;
grant update on public.app_settings to authenticated;
grant execute on function public.current_role() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ============================================================================
-- Create the first administrator manually (SQL Editor / service role only).
-- Replace the UUID with the account created in Authentication → Users, then:
--
--   update public.profiles
--      set role = 'admin', full_name = 'WORKBRIDGE Administrator'
--    where id = '00000000-0000-0000-0000-000000000000';
--
-- There is deliberately no public path to an admin account.
-- ============================================================================
