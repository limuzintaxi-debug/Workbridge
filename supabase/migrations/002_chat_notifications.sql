-- WORKBRIDGE migration 002 — booking chat, push subscriptions and the table
-- privileges the Node server needs.
--
-- Safe to run more than once. It creates only the two new tables and never
-- touches existing rows, so accounts, bookings, invoices and agreements are
-- preserved exactly as they are.
--
-- Run this in the Supabase SQL Editor for project jpuzzowyvfzpuyitjmde.

-- ---------------------------------------------------------------------------
-- 1. Tables (same {id, doc} shape as the rest of the schema, so the server's
--    Supabase adapter mirrors them without special cases).
-- ---------------------------------------------------------------------------

create table if not exists public.chat_messages (
  id text primary key,
  booking_id text,
  sender_id text,
  created_at timestamptz default now(),
  doc jsonb not null
);
create index if not exists chat_messages_booking_idx on public.chat_messages (booking_id);
create index if not exists chat_messages_sender_idx on public.chat_messages (sender_id);

create table if not exists public.push_subscriptions (
  id text primary key,
  user_id text,
  created_at timestamptz default now(),
  doc jsonb not null
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security.
--
-- Chat and push endpoints are only ever reached through the WORKBRIDGE server,
-- which decides who may read or write a booking conversation from the booking
-- record itself (the business that created it and the driver it selected).
-- Direct browser access to these two tables is therefore denied outright: a
-- browser token can never read another booking's messages.
-- ---------------------------------------------------------------------------

alter table public.chat_messages enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists chat_messages_no_client_access on public.chat_messages;
create policy chat_messages_no_client_access on public.chat_messages
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists push_subscriptions_no_client_access on public.push_subscriptions;
create policy push_subscriptions_no_client_access on public.push_subscriptions
  for all to anon, authenticated
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 3. Privileges for the server key.
--
-- This is what fixes "permission denied for table users/applications/
-- app_settings" (HTTP 403). RLS is bypassed for service_role, but table
-- privileges are not, so they must be granted explicitly.
-- ---------------------------------------------------------------------------

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
