-- ---------------------------------------------------------------------------
-- Accès des familles.
--
-- C'est l'idée d'origine du projet : un parent qui voit les notes et les
-- absences de son enfant sans se déplacer au secrétariat.
--
-- Un tuteur N'EST PAS un utilisateur du personnel, et il n'en devient pas un.
-- Deux raisons, toutes deux de sûreté :
--
--   1. Une ligne dans `users` traverse `can()`, `auth_resolve()` et la
--      navigation du personnel. Un tuteur qui obtiendrait par accident un
--      rôle vide y verrait quand même des écrans qui ne le regardent pas.
--      Une session de tuteur ne peut pas se transformer en session de
--      personnel : ce sont deux tables, deux fonctions, deux cookies.
--   2. Le périmètre visible d'un tuteur se déduit de `student_guardians`,
--      pas d'un rôle. Le lier à un enfant est une opération de scolarité,
--      pas une attribution de droits.
--
-- Migration additive : elle ne modifie aucune table existante.
-- ---------------------------------------------------------------------------

create table if not exists guardian_sessions (
  id                  uuid primary key default uuid_generate_v4(),
  school_id           uuid not null references schools(id) on delete cascade,
  guardian_id         uuid not null references guardians(id) on delete cascade,
  access_token_hash   text not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  revoked_at          timestamptz
);
create index if not exists guardian_sessions_token on guardian_sessions (access_token_hash);
create index if not exists guardian_sessions_guardian on guardian_sessions (guardian_id);

alter table guardian_sessions enable row level security;
alter table guardian_sessions force row level security;
drop policy if exists guardian_sessions_tenant_isolation on guardian_sessions;
create policy guardian_sessions_tenant_isolation on guardian_sessions
  using (school_id = current_school_id())
  with check (school_id = current_school_id());

-- ---------------------------------------------------------------------------
-- Brèches nommées au RLS, pour le seul chemin d'authentification.
--
-- Comme pour le personnel : à la connexion, aucun établissement n'est encore
-- en contexte, donc un SELECT ordinaire ne renverrait rien. Ces fonctions
-- sont volontairement les plus étroites possibles.
--
-- Le propriétaire de ces fonctions doit porter BYPASSRLS et ne doit PAS être
-- le rôle applicatif.
-- ---------------------------------------------------------------------------

create or replace function auth_lookup_guardian(p_phone text)
returns table (id uuid, school_id uuid, full_name text)
security definer set search_path = public
as $$
  -- phone_alt : beaucoup de familles donnent le numéro du père et celui de la
  -- mère. Les deux doivent ouvrir le même dossier.
  select g.id, g.school_id, g.full_name
    from guardians g
   where g.phone = p_phone or g.phone_alt = p_phone
   order by (g.phone = p_phone) desc
   limit 1;
$$ language sql stable;

create or replace function guardian_create_session(
  p_guardian_id uuid, p_school_id uuid, p_access_hash text
) returns void
security definer set search_path = public
as $$
  insert into guardian_sessions (school_id, guardian_id, access_token_hash, expires_at)
  values (p_school_id, p_guardian_id, p_access_hash, now() + interval '12 hours');
$$ language sql;

create or replace function guardian_resolve(p_access_hash text)
returns table (guardian_id uuid, school_id uuid, full_name text)
security definer set search_path = public
as $$
  select g.id, s.school_id, g.full_name
    from guardian_sessions s
    join guardians g on g.id = s.guardian_id
   where s.access_token_hash = p_access_hash
     and s.revoked_at is null
     and s.expires_at > now()
   limit 1;
$$ language sql stable;

create or replace function guardian_revoke(p_access_hash text)
returns void
security definer set search_path = public
as $$
  update guardian_sessions set revoked_at = now()
   where access_token_hash = p_access_hash and revoked_at is null;
$$ language sql;

comment on function auth_lookup_guardian(text) is
  'Brèche volontaire au RLS, limitée au strict nécessaire de la connexion '
  'des familles. Le propriétaire doit porter BYPASSRLS et ne pas être le '
  'rôle applicatif.';

comment on table guardian_sessions is
  'Sessions des familles. Séparées de auth_sessions à dessein : une session '
  'de tuteur ne doit jamais pouvoir être résolue en session de personnel.';
