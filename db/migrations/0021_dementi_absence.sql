-- ---------------------------------------------------------------------------
-- On corrigeait l'appel ; on ne corrigeait pas la famille.
--
-- CE QUI A ÉTÉ TROUVÉ EN ÉPROUVANT L'APPEL DU MATIN. Deux enregistrements,
-- le même jour, la même classe — exactement ce que fait un surveillant quand
-- il s'est trompé :
--
--   07h45  Alizèta est marquée ABSENTE.
--          « Appel enregistré : 1 absence, 1 SMS envoyé pour 8 F. »
--          Sa mère reçoit : « Alizèta absent(e) le 27/07/2026. »
--
--   08h10  Alizèta est là — elle était aux latrines. Le surveillant la
--          repasse PRÉSENTE et valide.
--          « Appel enregistré : 0 absence, 0 SMS envoyé pour 0 F. »
--
-- Le registre dit maintenant « présente ». Le téléphone de sa mère dit
-- toujours « absente », et rien ne partira jamais pour la contredire. La mère
-- est sur la route de l'école.
--
-- La phrase que lit le surveillant est le pire des deux maux : « 0 absence,
-- 0 SMS ». Elle ne décrit pas une correction, elle décrit une journée où il
-- ne s'est rien passé. L'homme qui vient précisément de réparer son erreur
-- lit que l'affaire est close.
--
-- ET LA MÊME CHOSE, EN PIRE, POUR LES FAMILLES INJOIGNABLES. Une absence sans
-- numéro laisse une TÂCHE dans le registre des messages : « appelez cette
-- famille, voici ce qu'il fallait lui dire ». Après la correction, la tâche
-- est toujours là, avec son texte devenu faux. Quelqu'un décrochera et
-- annoncera à une famille une absence qui n'a pas eu lieu — et il le fera en
-- suivant le logiciel.
--
-- ---------------------------------------------------------------------------
-- LA RÈGLE. Un message qui est parti ne se reprend pas.
--
-- C'est la doctrine des reçus, mot pour mot : un paiement annulé produit un
-- reçu inverse, jamais une suppression. Un SMS démenti produit un SECOND SMS,
-- jamais une ligne effacée ni un statut réécrit. Le registre reste
-- append-only, et une école à qui l'on reproche d'avoir accusé un élève à
-- tort peut montrer les deux messages, dans l'ordre, avec leurs heures.
--
-- Trois conséquences, toutes visibles à l'écran :
--
--   1. corriger une absence déjà annoncée ENVOIE un démenti, tout de suite,
--      au même numéro. Cela coûte 16 F — deux segments, parce qu'un nom
--      d'établissement accentué fait basculer le message en UCS-2 et ramène
--      la limite de 160 caractères à 70. Le prix est dit ici pour qu'il ne
--      soit pas découvert sur un relevé, et il reste très inférieur à celui
--      d'une mère qui traverse Ouagadougou pour rien ;
--   2. la tâche « famille injoignable » devenue fausse est CLOSE, avec le
--      motif `sans_objet` — personne n'appellera pour annoncer une absence
--      qui n'existe plus ;
--   3. la confirmation NOMME le geste. « 0 absence » ne peut plus être toute
--      la phrase.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE.
--
--   * `sms_messages.attendance_record_id` — POURQUOI ce message est parti.
--     La table portait `student_id` et rien d'autre : pour retrouver le SMS
--     d'une absence précise il fallait deviner, en recoupant l'élève et une
--     date à l'intérieur du texte. On ne bâtit pas un démenti sur une
--     devinette ;
--   * `sms_messages.corrige_message_id` — ce message-ci dément celui-là. Le
--     lien va du démenti vers l'original, comme le reçu inverse pointe vers
--     le reçu qu'il annule, et un index unique interdit de démentir deux fois
--     le même message ;
--   * `attendance_records.sms_sent_at` — la colonne existait depuis le
--     premier schéma et PERSONNE NE L'ÉCRIVAIT. Elle dit l'heure à laquelle
--     la famille a été prévenue, et c'est elle qui permet à l'écran d'appel
--     d'avertir : « famille prévenue à 07h45 » — de sorte que le surveillant
--     sache, AVANT de cliquer, qu'une correction partira ;
--   * la résolution `sans_objet` ;
--   * le gabarit `ABSENCE_DEMENTI`.
-- ---------------------------------------------------------------------------

alter table sms_messages
  add column if not exists attendance_record_id uuid
    references attendance_records(id) on delete set null,
  add column if not exists corrige_message_id uuid
    references sms_messages(id) on delete set null;

comment on column sms_messages.attendance_record_id is
  'La ligne d''appel qui a provoqué ce message. Sans elle, retrouver le SMS '
  'd''une absence donnée demandait de recouper l''élève et une date lue dans '
  'le corps du texte — une devinette, sur laquelle on ne bâtit pas un '
  'démenti.';

comment on column sms_messages.corrige_message_id is
  'Ce message dément celui-là. Le registre est append-only : un SMS parti par '
  'erreur n''est ni effacé ni réécrit, il est suivi d''un second qui le '
  'contredit — exactement comme un reçu annulé produit un reçu inverse.';

-- PAS D'INDEX UNIQUE ICI, et il a fallu s'y reprendre à deux fois pour le
-- comprendre. Un démenti refusé par l'opérateur se RENVOIE, depuis le registre
-- des messages, comme n'importe quel message non remis — et la seconde
-- tentative porte le même `corrige_message_id` que la première. Un index
-- unique interdirait donc de rattraper précisément la famille qui croit
-- encore son enfant absent. Ce qu'on veut empêcher — qu'un second
-- enregistrement de l'appel déclenche un second démenti — est déjà garanti
-- par `message_a_dementir()`, qui ne rend rien dès qu'un démenti existe.
drop index if exists sms_messages_un_seul_dementi;

create index if not exists sms_messages_dementis
  on sms_messages (corrige_message_id)
  where corrige_message_id is not null;

create index if not exists sms_messages_par_ligne_appel
  on sms_messages (attendance_record_id)
  where attendance_record_id is not null;

comment on column attendance_records.sms_sent_at is
  'Quand la famille a été prévenue de cette absence. Écrite par l''appel du '
  'matin. Elle sert à deux choses : dire au surveillant, avant qu''il '
  'corrige, qu''un message est déjà parti ; et prouver plus tard que la '
  'famille l''a su le jour même.';

-- ---------------------------------------------------------------------------
-- `sans_objet` : la quatrième issue d'un message non remis.
--
-- Les trois premières supposent qu'il y a toujours quelque chose à dire à la
-- famille — on renvoie, on appelle, ou on renonce. Celle-ci dit qu'il n'y a
-- PLUS rien à dire : le fait que le message annonçait n'existe plus. C'est le
-- logiciel qui la pose, jamais un agent, et c'est pour cela qu'elle ne figure
-- pas parmi les boutons de l'écran.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'sms_messages_resolution_check'
  ) then
    alter table sms_messages drop constraint sms_messages_resolution_check;
  end if;
  alter table sms_messages
    add constraint sms_messages_resolution_check
    check (resolution is null
           or resolution in ('reessaye', 'appele', 'abandonne', 'sans_objet'));
end $$;

comment on column sms_messages.resolution is
  'Ce qui a été fait d''un message non remis : reessaye, appele, abandonne — '
  'trois gestes humains — ou sans_objet, posé par le logiciel quand le fait '
  'annoncé a été corrigé et qu''il n''y a plus rien à annoncer.';

-- ---------------------------------------------------------------------------
-- Le gabarit du démenti.
--
-- Il est court par nécessité : au-delà de 160 caractères le SMS compte double.
-- Il est explicite par honnêteté — « erreur de notre part » est le sujet de la
-- phrase, parce que c'en est une, et parce qu'une famille qui reçoit une
-- correction sans excuse conclut que l'école ne sait pas ce qu'elle fait.
--
-- Les gabarits étaient posés une seule fois, dans `seed_school_defaults`, au
-- milieu de cent vingt lignes. On les sort dans leur propre fonction : elle
-- sert à la fois à équiper les établissements existants et à équiper les
-- suivants, sans qu'il faille recopier le semeur entier à chaque gabarit
-- ajouté.
create or replace function seed_gabarits_sms(p_school_id uuid)
returns void language sql as $$
  insert into sms_templates (school_id, code, label, body) values
    (p_school_id, 'ABSENCE', 'Absence du jour',
     '{{ecole}}: {{eleve}} absent(e) le {{date}}. Contact: {{telephone}}.'),
    (p_school_id, 'ABSENCE_DEMENTI', 'Démenti d''absence',
     '{{ecole}}: erreur de notre part, {{eleve}} etait bien a l''ecole le '
     || '{{date}}. Message precedent annule.'),
    (p_school_id, 'BULLETIN', 'Bulletin disponible',
     '{{ecole}}: bulletin {{trimestre}} de {{eleve}} disponible. Moyenne '
     || '{{moyenne}}/20, rang {{rang}}/{{effectif}}.'),
    (p_school_id, 'RELANCE', 'Relance scolarité',
     '{{ecole}}: scolarite de {{eleve}}, reste {{montant}} FCFA a payer avant '
     || 'le {{echeance}}.')
  on conflict (school_id, code) do nothing;
$$;

comment on function seed_gabarits_sms(uuid) is
  'Installe les gabarits SMS manquants d''un établissement, sans toucher à '
  'ceux qu''il a modifiés (on conflict do nothing). Appelée à la création et '
  'par toute migration qui ajoute un gabarit.';

-- Les établissements DÉJÀ installés. Le contexte est posé école par école :
-- `sms_templates` porte `force row level security`, et le propriétaire des
-- tables y est soumis comme les autres.
do $$
declare e uuid;
begin
  for e in select id from schools loop
    perform set_config('fasoschool.school_id', e::text, true);
    perform seed_gabarits_sms(e);
  end loop;
  perform set_config('fasoschool.school_id', '', true);
end $$;

-- Et les suivants. On ne recopie pas `seed_school_defaults` : on ajoute
-- l'appel là où l'établissement naît.
create or replace function provision_school(
  p_name      text,
  p_sector    text,
  p_fee_zone  text default null,
  p_commune   text default null,
  p_region    text default null,
  p_effective date default current_date
) returns uuid as $$
declare
  v_id uuid := uuid_generate_v4();
begin
  perform set_config('fasoschool.school_id', v_id::text, true);

  insert into schools (id, name, sector, fee_zone, commune, region)
  values (v_id, p_name, p_sector, p_fee_zone, p_commune, p_region);

  perform seed_school_defaults(v_id, p_effective);
  perform seed_gabarits_sms(v_id);
  return v_id;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Ce qu'il faut démentir, et ce qui l'a été.

-- Le message parti pour cette ligne d'appel et pas encore contredit — ou null
-- s'il n'y a rien à reprendre. C'est la question que pose l'appel du matin
-- chaque fois qu'un « absent » cesse de l'être.
create or replace function message_a_dementir(p_record uuid)
returns uuid language sql stable as $$
  select m.id
    from sms_messages m
   where m.attendance_record_id = p_record
     and m.status in ('envoye', 'livre')
     and m.corrige_message_id is null
     and not exists (select 1 from sms_messages d
                      where d.corrige_message_id = m.id)
   order by m.queued_at
   limit 1;
$$;

comment on function message_a_dementir(uuid) is
  'Le SMS d''absence parti pour cette ligne d''appel et qu''aucun démenti '
  'n''a encore contredit. Null quand il n''y a rien à reprendre : rien '
  'd''envoyé, ou déjà démenti.';

-- La tâche devenue fausse : un message que personne n'a reçu, dont le fait
-- annoncé vient d'être corrigé. On la ferme, on ne l'efface pas.
create or replace function taches_sans_objet(p_record uuid)
returns setof uuid language sql stable as $$
  select m.id
    from sms_messages m
   where m.attendance_record_id = p_record
     and m.status in ('echoue', 'injoignable')
     and m.resolution is null
     -- UN DÉMENTI RATÉ N'EST JAMAIS SANS OBJET, et cette ligne est la plus
     -- importante du fichier. Le démenti porte la MÊME ligne d'appel que
     -- l'annonce qu'il corrige : sans ce filtre, corriger une absence fermait
     -- la tâche du démenti qui venait d'échouer — c'est-à-dire précisément la
     -- famille qui croit encore son enfant absent et que personne n'irait
     -- plus appeler. Éprouvé : l'assertion est tombée.
     and m.corrige_message_id is null;
$$;

comment on function taches_sans_objet(uuid) is
  'Les tâches ouvertes du registre des messages qui ANNONÇAIENT cette '
  'absence-là. Après correction, leur texte est faux : les laisser ouvertes '
  'ferait annoncer par téléphone une absence qui n''a pas eu lieu. Les '
  'démentis non remis en sont exclus : eux, il faut justement les rattraper.';

-- Ce message a-t-il été démenti, et par lequel ?
--
-- Un démenti peut avoir été tenté plusieurs fois : le premier refusé par
-- l'opérateur, le second renvoyé depuis le registre. On rend CELUI QUI EST
-- PASSÉ s'il y en a un, et sinon la dernière tentative — de sorte que l'écran
-- puisse dire « démenti à 08h10 » quand c'est vrai, et « démenti NON remis »
-- quand ça ne l'est pas. Les deux phrases décrivent des situations opposées ;
-- rendre l'une pour l'autre serait pire que ne rien dire.
create or replace function dementi_de(p_message uuid)
returns uuid language sql stable as $$
  select d.id from sms_messages d
   where d.corrige_message_id = p_message
   order by (d.status in ('envoye', 'livre')) desc, d.queued_at desc
   limit 1;
$$;

comment on function dementi_de(uuid) is
  'Le message qui dément celui-ci : celui qui est passé s''il y en a un, sinon '
  'la dernière tentative. Le registre garde tout — une école à qui l''on '
  'reproche d''avoir accusé un élève à tort doit pouvoir montrer ce qu''elle a '
  'envoyé ET ce qu''elle a corrigé.';
