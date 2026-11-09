create sequence if not exists change_seq;

create table if not exists lists (
  id uuid primary key,
  name text unique not null,
  doc jsonb not null,
  version bigint not null default 1,
  change_seq bigint not null,
  deleted_at timestamptz
);

create table if not exists notes (
  scope text primary key,
  doc jsonb not null,
  version bigint not null default 1,
  change_seq bigint not null
);

create table if not exists applied_ops (
  op_id uuid primary key,
  host text not null,
  source text not null,
  tool text not null,
  ok boolean not null,
  result jsonb,
  applied_at timestamptz not null default now()
);

create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  host text,
  source text,
  tool text,
  list text,
  todo_id text,
  payload jsonb
);

create table if not exists feed_messages (
  key text primary key,
  channel text not null,
  ts text not null,
  updated_at timestamptz
);

create table if not exists settings (
  key text primary key,
  value jsonb not null
);

create table if not exists tokens (
  id uuid primary key,
  machine text unique not null,
  hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists lists_change_seq on lists (change_seq);
create index if not exists notes_change_seq on notes (change_seq);
create index if not exists events_at on events (at);
