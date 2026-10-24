create extension if not exists pgcrypto;

create type public.event_mode as enum ('single_bill', 'trip_event');
create type public.event_role as enum ('owner', 'cohost', 'participant');
create type public.event_state as enum ('open', 'settlement_preview', 'settled');
create type public.split_method as enum ('item_claim', 'host_assignment', 'equal', 'custom');
create type public.settlement_method as enum ('original_payers', 'optimized_direct', 'coordinator');
create type public.payment_state as enum ('pending', 'sent', 'confirmed');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  mode public.event_mode not null,
  currency char(3) not null default 'MYR',
  state public.event_state not null default 'open',
  owner_user_id uuid not null references auth.users(id),
  invite_token_hash text not null unique,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create table public.event_members (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 50),
  role public.event_role not null default 'participant',
  joined_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table public.expenses (
  id uuid primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  creator_user_id uuid not null references auth.users(id),
  payer_user_id uuid not null references auth.users(id),
  description text not null check (char_length(description) between 1 and 120),
  category text not null default 'other',
  expense_date date not null,
  total_cents bigint not null check (total_cents >= 0),
  split_method public.split_method not null,
  claiming_closed boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.expense_items (
  id uuid primary key,
  expense_id uuid not null references public.expenses(id) on delete cascade,
  description text not null,
  quantity integer not null default 1 check (quantity > 0),
  total_cents bigint not null check (total_cents >= 0),
  sort_order integer not null default 0
);

create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  item_id uuid references public.expense_items(id) on delete cascade,
  participant_user_id uuid not null references auth.users(id),
  amount_cents bigint not null check (amount_cents >= 0),
  source text not null check (source in ('self_claim', 'expense_creator', 'cohost', 'owner', 'calculated')),
  unique nulls not distinct (expense_id, item_id, participant_user_id)
);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.events(id) on delete cascade,
  method public.settlement_method not null,
  coordinator_user_id uuid references auth.users(id),
  confirmed_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null default now()
);

create table public.settlement_balances (
  settlement_id uuid not null references public.settlements(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  paid_cents bigint not null,
  owed_cents bigint not null,
  net_cents bigint not null,
  primary key (settlement_id, user_id)
);

create table public.settlement_transfers (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.settlements(id) on delete cascade,
  payer_user_id uuid not null references auth.users(id),
  receiver_user_id uuid not null references auth.users(id),
  amount_cents bigint not null check (amount_cents > 0),
  state public.payment_state not null default 'pending',
  updated_at timestamptz not null default now()
);

create table public.payment_details (
  event_id uuid not null references public.events(id) on delete cascade,
  receiver_user_id uuid not null references auth.users(id),
  preferred_method text not null check (preferred_method in ('qr', 'bank')),
  qr_storage_path text,
  bank_name text,
  account_holder_name text,
  account_number text,
  payment_reference text,
  delete_after timestamptz,
  primary key (event_id, receiver_user_id),
  check (qr_storage_path is not null or account_number is not null)
);

create table public.activity_log (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id),
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
