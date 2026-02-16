create table if not exists sessions (
  client_id text not null,
  wa_from text not null,
  lead jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (client_id, wa_from)
);

create table if not exists leads (
  id bigserial primary key,
  client_id text not null,
  wa_from text not null,
  name text,
  email text,
  need text,
  created_at timestamptz not null default now()
);

create index if not exists leads_client_id_idx on leads (client_id);
create index if not exists leads_created_at_idx on leads (created_at);