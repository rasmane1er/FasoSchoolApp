-- Test d'isolation multi-locataire.
-- Exécute chaque lecture dans le contexte de l'établissement A pendant que les
-- données de l'établissement B existent, et exige zéro ligne.
--
-- À lancer en CI dès la première semaine, pas avant le lancement.
-- IMPORTANT : la connexion applicative NE DOIT PAS être superutilisateur.
-- Un superutilisateur contourne entièrement le row-level security.

\set ON_ERROR_STOP on

-- Rôle applicatif non privilégié.
drop role if exists fasoschool_app;
create role fasoschool_app login password 'test';
grant usage on schema public to fasoschool_app;
grant select, insert, update, delete on all tables in schema public to fasoschool_app;
grant execute on function current_school_id() to fasoschool_app;

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

\echo '--- contexte : établissement A ---'
set role fasoschool_app;
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
\echo '--- toutes les assertions ont passé ---'
