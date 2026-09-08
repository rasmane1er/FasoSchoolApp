-- Test d'isolation multi-locataire.
-- Exécute chaque lecture dans le contexte de l'établissement A pendant que les
-- données de l'établissement B existent, et exige zéro ligne.
--
-- À LANCER PAR `scripts/epreuve-cloisonnement.sh`, JAMAIS À LA MAIN SUR UNE
-- BASE RÉELLE. Ce fichier écrit deux établissements de contrôle et prend le
-- rôle d'un compte jetable ; le script lui fabrique une base à usage unique et
-- la supprime après.
--
-- Il utilisait auparavant le nom du rôle applicatif de production,
-- `fasoschool_app`, et commençait par `drop role`. Sur une machine où le
-- produit est installé, cela échouait — le rôle porte des droits — et, s'il
-- avait réussi, il aurait supprimé le compte de l'application en service pour
-- le recréer avec le mot de passe « test ». Le test de sûreté du projet était
-- lui-même le geste le plus dangereux du dépôt.
--
-- IMPORTANT : la connexion applicative NE DOIT PAS être superutilisateur.
-- Un superutilisateur contourne entièrement le row-level security.

\set ON_ERROR_STOP on

-- Rôle jetable, nommé pour qu'on ne le confonde avec aucun compte réel.
drop role if exists fasoschool_rls_probe;
create role fasoschool_rls_probe login password 'epreuve';
grant usage on schema public to fasoschool_rls_probe;
grant select, insert, update, delete on all tables in schema public to fasoschool_rls_probe;
grant execute on function current_school_id() to fasoschool_rls_probe;

-- Deux établissements concurrents.
insert into schools (id, name, sector, fee_zone) values
  ('11111111-1111-1111-1111-111111111111', 'Ecole A', 'prive_laic', 'ouaga_bobo'),
  ('22222222-2222-2222-2222-222222222222', 'Ecole B', 'prive_catholique', 'ouaga_bobo');

insert into academic_years (id, school_id, label, starts_on, ends_on) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','2026-2027','2026-10-01','2027-07-15'),
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','2026-2027','2026-10-01','2027-07-15');

insert into students (id, school_id, matricule, last_name, first_names) values
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','A-001','OUEDRAOGO','Fatimata'),
  ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','B-001','SAWADOGO','Boukary');

insert into guardians (id, school_id, full_name, phone) values
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Tuteur A','70000001'),
  ('bbbbbbbb-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','Tuteur B','70000002');

-- Sessions des familles : le cloisonnement doit valoir aussi pour la porte
-- que le projet ouvre vers l'extérieur. C'est la table dont une fuite serait
-- la plus grave : elle donnerait accès au dossier d'un enfant.
insert into guardian_sessions (school_id, guardian_id, access_token_hash, expires_at) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000003',
   'jeton-a', now() + interval '1 hour'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000003',
   'jeton-b', now() + interval '1 hour');

-- Un agent et une session ouverte de chaque côté. Sans ces lignes, l'assertion
-- sur `auth_sessions` plus bas ne prouverait rien : compter zéro dans une table
-- vide n'est pas du cloisonnement.
insert into users (id, school_id, full_name, phone) values
  ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Agent A','70000011'),
  ('bbbbbbbb-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','Agent B','70000012');

insert into auth_sessions (user_id, school_id, access_token_hash, refresh_token_hash, expires_at) values
  ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
   'acces-a','refresh-a', now() + interval '1 hour'),
  ('bbbbbbbb-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222',
   'acces-b','refresh-b', now() + interval '1 hour');

\echo '--- contexte : établissement A ---'
set role fasoschool_rls_probe;
select set_config('fasoschool.school_id', '11111111-1111-1111-1111-111111111111', false);

-- Chaque assertion doit passer.
do $$
declare n int;
begin
  select count(*) into n from students;
  if n <> 1 then raise exception 'FAIL students: attendu 1, obtenu %', n; end if;

  select count(*) into n from students where school_id = '22222222-2222-2222-2222-222222222222';
  if n <> 0 then raise exception 'FUITE students: % lignes de B visibles depuis A', n; end if;

  select count(*) into n from guardians;
  if n <> 1 then raise exception 'FAIL guardians: attendu 1, obtenu %', n; end if;

  select count(*) into n from academic_years;
  if n <> 1 then raise exception 'FAIL academic_years: attendu 1, obtenu %', n; end if;

  select count(*) into n from schools;
  if n <> 1 then raise exception 'FAIL schools: attendu 1, obtenu %', n; end if;

  raise notice 'OK  lectures isolées';
end $$;

-- Les sessions de famille de l'établissement B sont invisibles depuis A.
do $$
declare n int;
begin
  select count(*) into n from guardian_sessions;
  if n <> 1 then
    raise exception 'FUITE guardian_sessions: % lignes visibles depuis A', n;
  end if;
  select count(*) into n from guardian_sessions where access_token_hash = 'jeton-b';
  if n <> 0 then
    raise exception 'FUITE GRAVE: le jeton d''une famille de B est lisible depuis A';
  end if;
end $$;

-- Écriture dans un autre établissement : doit être refusée par WITH CHECK.
do $$
begin
  begin
    insert into students (school_id, matricule, last_name, first_names)
    values ('22222222-2222-2222-2222-222222222222','X-999','PIRATE','Test');
    raise exception 'FUITE ECRITURE: insertion dans B acceptée depuis le contexte A';
  exception when insufficient_privilege then
    raise notice 'OK  écriture croisée refusée';
  end;
end $$;

-- Mise à jour croisée : doit toucher zéro ligne.
do $$
declare n int;
begin
  update students set last_name = 'HACKED'
    where school_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FUITE UPDATE: % lignes de B modifiées depuis A', n; end if;
  raise notice 'OK  update croisé sans effet';
end $$;

-- Suppression croisée : doit toucher zéro ligne.
do $$
declare n int;
begin
  delete from students where school_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FUITE DELETE: % lignes de B supprimées depuis A', n; end if;
  raise notice 'OK  delete croisé sans effet';
end $$;

-- Les sessions du PERSONNEL. Elles n'avaient aucune politique jusqu'à la
-- migration 0009, et rien ici ne l'avait vu : l'épreuve regardait les sessions
-- des familles et pas celles des agents. Une assertion n'existe que pour ce
-- qu'on a pensé à regarder.
set role fasoschool_rls_probe;
select set_config('fasoschool.school_id', '11111111-1111-1111-1111-111111111111', false);
do $$
declare n int;
begin
  select count(*) into n from auth_sessions;
  if n <> 1 then
    raise exception 'FUITE auth_sessions: % sessions visibles depuis A, attendu 1', n;
  end if;
  raise notice 'OK  sessions du personnel isolées';
end $$;

-- Sans contexte posé : on ne doit rien voir du tout.
select set_config('fasoschool.school_id', '', false);
do $$
declare n int;
begin
  select count(*) into n from students;
  if n <> 0 then raise exception 'FUITE SANS CONTEXTE: % élèves visibles sans school_id', n; end if;
  raise notice 'OK  aucun contexte = aucune ligne';
end $$;

reset role;
-- Le rôle jetable est supprimé par `epreuve-cloisonnement.sh`, APRÈS la base :
-- tant qu'elle existe il y porte des droits, et PostgreSQL refuse de le
-- supprimer. Le faire ici échouait à la dernière ligne d'une épreuve par
-- ailleurs entièrement réussie.
\echo '--- toutes les assertions ont passé ---'
