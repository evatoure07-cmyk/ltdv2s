-- LTD Sandy Shores V5 — installation Supabase (à exécuter UNE SEULE FOIS)
-- Supabase > SQL Editor > New query > coller ce fichier > Run

create table if not exists public.ltd_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Toute la base passe par le serveur Render.
-- Aucune clé Supabase secrète n'est envoyée au navigateur.
alter table public.ltd_state enable row level security;
revoke all on table public.ltd_state from anon, authenticated;
grant select, insert, update, delete on table public.ltd_state to service_role;

-- La ligne principale est créée automatiquement par le site au premier enregistrement.
