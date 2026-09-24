-- ---------------------------------------------------------------------------
-- « La réponse au parent qui conteste une note » — et elle n'existait que
-- pour les notes saisies hors ligne.
--
-- CE QUI A ÉTÉ TROUVÉ. `grade_entry_revisions` porte, dans le code qui
-- l'alimente, ce commentaire : « Append-only : la réponse au parent qui
-- conteste une note. » Deux endroits l'écrivent, et les deux sont le chemin
-- HORS LIGNE — la synchronisation d'un appareil, et l'arbitrage d'un conflit.
-- Le chemin NORMAL, celui par lequel passe la quasi-totalité des notes d'une
-- année — un enseignant qui tape sur l'écran des notes — n'écrit rien.
--
-- Éprouvé sur le produit qui tourne :
--
--   * on remplace 14,50 par 19 : la note change, `grade_entry_revisions`
--     reste à ZÉRO ligne ;
--   * on vide la case : `delete from grade_entries`, la ligne DISPARAÎT, et
--     l'écran annonce « 0 note enregistrée » — le même message que lorsqu'il
--     ne s'est rien passé ;
--   * le journal garde `{"classe": "…", "saisies": 0}`. Un compte. Ni l'élève,
--     ni la matière, ni la valeur d'avant.
--
-- Le jeu de démonstration porte 288 notes et 0 révision. Une année entière.
--
-- ET LA CLÉ ÉTRANGÈRE ACHÈVE LE TRAVAIL :
--
--     grade_entry_id ... references grade_entries(id) ON DELETE CASCADE
--
-- L'histoire d'une note était donc câblée pour être détruite par le geste
-- même qu'elle existe pour documenter. Effacer la note effaçait la preuve
-- qu'elle avait existé.
--
-- POURQUOI C'EST LE DÉFAUT LE PLUS GRAVE DE CEUX TROUVÉS ICI. Une note est le
-- seul nombre de ce produit qu'une famille peut contester, et le seul dont un
-- établissement puisse avoir à rendre compte élève par élève. C'est aussi
-- celui qu'il est le plus tentant de changer : un redoublement, une bourse, un
-- rang se jouent à un demi-point. Un logiciel qui ne sait pas dire qu'une note
-- valait 08 hier ne protège ni la famille ni l'enseignant — et pas davantage
-- le chef d'établissement, qui n'a rien à opposer à une accusation.
--
-- ---------------------------------------------------------------------------
-- LA RÈGLE, ET POURQUOI ELLE EST POSÉE DANS LA BASE.
--
-- La correction évidente serait d'ajouter un `insert` à côté des trois
-- endroits qui écrivent une note. C'est exactement ce qui a produit le défaut :
-- deux des trois l'avaient. Une règle posée dans un fichier ne s'applique pas
-- d'elle-même au fichier d'à côté.
--
-- L'histoire est donc écrite par un DÉCLENCHEUR, comme le cloisonnement est
-- assuré par le RLS : aucun chemin d'écriture ne peut y échapper, pas même un
-- `psql` ouvert un dimanche soir. Le code applicatif ne fait plus qu'une
-- chose — DIRE D'OÙ IL PARLE, par un réglage de session, exactement comme il
-- dit déjà de quel établissement il parle.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. L'HISTOIRE SURVIT À LA SUPPRESSION DE LA NOTE.
--
-- On retire le `on delete cascade`, et on garde de quoi retrouver l'histoire
-- sans la ligne : l'évaluation et l'élève. C'est d'ailleurs par là qu'une
-- question arrive — « la note de mon fils au 2ᵉ devoir de maths » — jamais par
-- l'identifiant d'une ligne.
alter table grade_entry_revisions
  add column if not exists evaluation_id uuid references evaluations(id) on delete cascade,
  add column if not exists student_id    uuid references students(id) on delete cascade,
  add column if not exists action        text not null default 'ecriture',
  add column if not exists ancien_score     numeric(5,2),
  add column if not exists ancien_is_absent boolean;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'grade_entry_revisions_action_check') then
    alter table grade_entry_revisions add constraint grade_entry_revisions_action_check
      check (action in ('ecriture', 'suppression'));
  end if;
end $$;

update grade_entry_revisions r
   set evaluation_id = g.evaluation_id, student_id = g.student_id
  from grade_entries g
 where g.id = r.grade_entry_id
   and (r.evaluation_id is null or r.student_id is null);

alter table grade_entry_revisions
  drop constraint if exists grade_entry_revisions_grade_entry_id_fkey;

comment on column grade_entry_revisions.grade_entry_id is
  'La ligne de note concernée. N''est PLUS une clé étrangère : elle l''était '
  'avec « on delete cascade », ce qui câblait l''histoire d''une note pour '
  'être détruite par le geste même qu''elle existe pour documenter.';
comment on column grade_entry_revisions.action is
  '« ecriture » ou « suppression ». Vider une case supprimait la ligne sans '
  'laisser un mot, et l''écran annonçait « 0 note enregistrée » — le même '
  'message que lorsqu''il ne s''est rien passé.';
comment on column grade_entry_revisions.ancien_score is
  'La valeur d''avant. Une suite d''instantanés dit ce que la note est '
  'devenue ; on veut aussi pouvoir lire d''un coup d''œil ce qu''elle était.';

create index if not exists grade_entry_revisions_note
  on grade_entry_revisions (school_id, evaluation_id, student_id, recorded_at);

-- ---------------------------------------------------------------------------
-- 2. LE DÉCLENCHEUR.
--
-- D'OÙ PARLE LE CODE : `fasoschool.grade_source`, lu comme `school_id` l'est
-- déjà. Non posé, c'est « online » — le chemin normal, celui qui n'écrivait
-- rien. Un défaut d'oubli doit retomber sur la valeur la plus probable, pas
-- sur un refus.
create or replace function source_de_saisie()
returns text language sql stable as $$
  select case
    when coalesce(current_setting('fasoschool.grade_source', true), '') in
           ('online', 'offline', 'import', 'correction')
      then current_setting('fasoschool.grade_source', true)
    else 'online'
  end;
$$;

comment on function source_de_saisie() is
  'D''où vient la note qu''on écrit : le code le dit par un réglage de '
  'session, comme il dit déjà de quel établissement il parle. Non posé, '
  '« online ».';

create or replace function tracer_note()
returns trigger language plpgsql as $$
declare
  v_ancien_score    numeric(5,2) := null;
  v_ancien_absent   boolean := null;
begin
  if tg_op = 'DELETE' then
    insert into grade_entry_revisions
      (school_id, grade_entry_id, evaluation_id, student_id,
       score, is_absent, ancien_score, ancien_is_absent,
       action, source, device_id, recorded_by)
    values (old.school_id, old.id, old.evaluation_id, old.student_id,
            null, null, old.score, old.is_absent,
            'suppression', source_de_saisie(), old.device_id, old.recorded_by);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    v_ancien_score  := old.score;
    v_ancien_absent := old.is_absent;
    /* UNE RÉÉCRITURE À L'IDENTIQUE N'EST PAS UNE RÉVISION. Renvoyer la feuille
     * de notes d'une classe réécrit quarante lignes dont trente-neuf n'ont pas
     * bougé ; en garder l'histoire noierait la seule qui compte. `updated_at`
     * change à chaque envoi : on ne compare donc que ce qui est la note. */
    if old.score is not distinct from new.score
       and old.is_absent is not distinct from new.is_absent then
      return new;
    end if;
  end if;

  insert into grade_entry_revisions
    (school_id, grade_entry_id, evaluation_id, student_id,
     score, is_absent, ancien_score, ancien_is_absent,
     action, source, device_id, recorded_by)
  values (new.school_id, new.id, new.evaluation_id, new.student_id,
          new.score, new.is_absent, v_ancien_score, v_ancien_absent,
          'ecriture', source_de_saisie(), new.device_id, new.recorded_by);
  return new;
end $$;

comment on function tracer_note() is
  'Écrit l''histoire d''une note à chaque écriture et à chaque suppression, '
  'quel que soit le chemin. Posé dans la base et non dans le code, pour la '
  'même raison que le cloisonnement : deux des trois chemins d''écriture '
  'avaient l''insertion, le troisième — celui par lequel passent presque '
  'toutes les notes — ne l''avait pas.';

drop trigger if exists grade_entries_histoire on grade_entries;
create trigger grade_entries_histoire
  after insert or update or delete on grade_entries
  for each row execute function tracer_note();

-- ---------------------------------------------------------------------------
-- 3. LIRE L'HISTOIRE D'UNE NOTE.
--
-- Par (évaluation, élève), parce que c'est ainsi que la question se pose, et
-- parce que la ligne de note peut avoir été supprimée.
create or replace function histoire_d_une_note(p_evaluation uuid, p_student uuid)
returns table (quand timestamptz, action text, source text,
               ancien_score numeric, ancien_absent boolean,
               score numeric, absent boolean, par text)
language sql stable as $$
  select r.recorded_at, r.action, r.source,
         r.ancien_score, r.ancien_is_absent, r.score, r.is_absent,
         (select u.full_name from staff sa
            left join users u on u.id = sa.user_id
           where sa.id = r.recorded_by)
    from grade_entry_revisions r
   where r.evaluation_id = p_evaluation and r.student_id = p_student
   order by r.recorded_at, r.id;
$$;

comment on function histoire_d_une_note(uuid, uuid) is
  'Ce qu''on peut répondre au parent qui conteste : ce que la note a valu, '
  'quand, par quel chemin et de la main de qui.';

-- ---------------------------------------------------------------------------
-- 4. CE QUE LE PRODUIT NE SAIT PAS, ET QU'IL DOIT DIRE.
--
-- Les notes saisies AVANT ce déclencheur n'ont pas d'histoire, et une
-- histoire vide ressemble à « cette note n'a jamais bougé ». C'est
-- exactement le genre de silence que ce dépôt refuse : quand le produit ne
-- sait pas, il le dit.
create or replace function notes_sans_histoire()
returns table (combien integer, depuis timestamptz)
language sql stable as $$
  select count(*)::int,
         (select min(r.recorded_at) from grade_entry_revisions r)
    from grade_entries g
   where not exists (select 1 from grade_entry_revisions r
                      where r.evaluation_id = g.evaluation_id
                        and r.student_id = g.student_id);
$$;

comment on function notes_sans_histoire() is
  'Combien de notes existaient avant que leur histoire ne soit tenue. Une '
  'histoire vide ressemble à « cette note n''a jamais bougé » : l''écran doit '
  'dire laquelle des deux il montre.';
