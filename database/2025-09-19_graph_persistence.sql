-- Persistence tables for LangGraph state (iq_*)
-- Run this in your Supabase SQL editor.

create table if not exists iq_summaries (
  session_id text primary key,
  summary jsonb,
  updated_at timestamptz default now()
);

create table if not exists iq_filters (
  session_id text primary key,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

create table if not exists iq_selections (
  session_id text not null,
  index int not null,
  line jsonb,
  item jsonb,
  updated_at timestamptz default now(),
  constraint iq_selections_pk primary key (session_id, index)
);

create table if not exists iq_quotations (
  session_id text primary key,
  items jsonb not null default '[]',
  total_estimate numeric not null default 0,
  updated_at timestamptz default now()
);

-- Optional: RLS
alter table iq_summaries enable row level security;
alter table iq_filters enable row level security;
alter table iq_selections enable row level security;
alter table iq_quotations enable row level security;

-- Public read/write for prototyping (tighten in prod)
drop policy if exists iq_summaries_all on iq_summaries;
create policy iq_summaries_all on iq_summaries for all using (true) with check (true);

drop policy if exists iq_filters_all on iq_filters;
create policy iq_filters_all on iq_filters for all using (true) with check (true);

drop policy if exists iq_selections_all on iq_selections;
create policy iq_selections_all on iq_selections for all using (true) with check (true);

drop policy if exists iq_quotations_all on iq_quotations;
create policy iq_quotations_all on iq_quotations for all using (true) with check (true);
