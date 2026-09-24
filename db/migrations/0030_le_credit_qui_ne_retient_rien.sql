-- ---------------------------------------------------------------------------
-- « Le crédit SMS est épuisé : plus aucune famille n'est prévenue. »
-- Et l'appel suivant en prévient trois.
--
-- CE QUI A ÉTÉ TROUVÉ. Le tableau de bord porte ce point, en rouge, marqué
-- BLOQUANT, dès que le solde tombe à zéro. On vide le crédit, on fait l'appel
-- avec trois absents, et le produit répond :
--
--     « Appel enregistré : 3 absences, 3 SMS envoyés pour 24 F. »
--
-- Trois familles prévenues, vingt-quatre francs dépensés, et le solde passe à
-- MOINS TROIS. La phrase du tableau de bord était fausse au moment où elle
-- s'affichait.
--
-- C'est l'image inversée du défaut de l'écran des frais : là, l'écran nommait
-- une sanction et le bouton passait quand même ; ici, l'écran annonce une
-- conséquence qui n'arrive pas. Les deux enseignent la même chose à celui qui
-- lit — que le rouge ne veut rien dire — et c'est ce qui les rend graves, bien
-- plus que le franc dépensé.
--
-- TROIS DÉFAUTS DANS UN.
--
-- 1. UN SOLDE QUI DESCEND SOUS ZÉRO N'EST PAS UN SOLDE. Rien, dans le chemin
--    de l'appel, ne lisait le crédit avant de composer. L'école achète N
--    messages à l'opérateur ; au-delà, c'est l'opérateur qui refuse — et la
--    comptabilité du produit diverge alors de la sienne en silence. Avec le
--    canal simulé, tout « réussit » : la divergence est invisible à l'épreuve
--    et n'apparaît que le premier vrai matin.
--
-- 2. L'ÉCRAN DE L'APPEL NE DISAIT RIEN DU CRÉDIT. Le surveillant général, à
--    7 h 30, la classe devant lui, est la seule personne qui dépense ce
--    crédit — et la seule à qui on ne le disait pas. Le point d'attention est
--    sur l'écran d'accueil, que celui qui fait l'appel n'ouvre pas.
--
-- 3. ET RIEN NE DISAIT QUELLES FAMILLES N'AVAIENT PAS ÉTÉ PRÉVENUES. La
--    doctrine existe pourtant déjà, mot pour mot, pour la famille sans
--    numéro : « un message non remis n'est pas une ligne de journal, c'est une
--    tâche ». Elle n'avait pas été appliquée au cas où c'est l'école, et non
--    la famille, qui est hors d'atteinte.
--
-- ---------------------------------------------------------------------------
-- CE QU'ON NE FAIT PAS : refuser l'appel. Une absence se consigne même sans
-- crédit ; le registre est le document, le SMS est la politesse. Le produit
-- enregistre donc tout, envoie ce que le crédit couvre, et NOMME les familles
-- qu'il n'a pas pu prévenir. C'est la seule version qui ne ment à personne.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Le crédit, lu en un seul endroit.
--
-- Il était recalculé par un `sum(case when ...)` copié dans cinq modules —
-- l'en-tête des pages, les points d'attention, la clôture, les communiqués, la
-- discipline. Cinq copies d'une règle d'argent finissent par diverger ; celle
-- de l'en-tête comptait déjà les ajustements autrement que les autres.
create or replace function credit_sms()
returns table (solde integer, achetes integer, consommes integer)
language sql stable as $$
  select
    coalesce(sum(case when direction = 'achat' then messages
                      when direction = 'consommation' then -messages
                      else messages end), 0)::int,
    coalesce(sum(messages) filter (where direction = 'achat'), 0)::int,
    coalesce(sum(messages) filter (where direction = 'consommation'), 0)::int
  from sms_credit_ledger;
$$;

comment on function credit_sms() is
  'Le solde de messages, et de quoi il est fait. Une seule lecture pour tous '
  'les écrans : la même somme était recopiée dans cinq modules, et deux '
  'd''entre eux traitaient déjà les ajustements différemment.';

-- ---------------------------------------------------------------------------
-- Ce que l'appel du jour va coûter, AVANT de le faire.
--
-- Compte les élèves déjà marqués absents pour cette séance et joignables : un
-- message par famille joignable. Un élève sans numéro ne coûte rien — rien
-- n'est composé — et c'est déjà dit ailleurs.
create or replace function cout_de_l_appel(p_class uuid, p_date date)
returns table (absents integer, joignables integer, sans_numero integer)
language sql stable as $$
  with marques as (
    select ar.student_id
      from attendance_records ar
      join attendance_sessions s on s.id = ar.attendance_session_id
     where s.class_id = p_class and s.session_date = p_date
       and ar.status = 'absent'
  )
  select count(*)::int,
         count(*) filter (where exists (
           select 1 from student_guardians sg
             join guardians g on g.id = sg.guardian_id
            where sg.student_id = m.student_id and sg.receives_sms
              and g.phone is not null and g.phone <> ''))::int,
         count(*) filter (where not exists (
           select 1 from student_guardians sg
             join guardians g on g.id = sg.guardian_id
            where sg.student_id = m.student_id and sg.receives_sms
              and g.phone is not null and g.phone <> ''))::int
    from marques m;
$$;

comment on function cout_de_l_appel(uuid, date) is
  'Combien de familles l''appel déjà saisi de cette classe préviendrait, et '
  'combien n''ont aucun numéro. Sert à dire le coût AVANT le geste, à celui '
  'qui le fait — pas à celui qui ouvre le tableau de bord.';

-- ---------------------------------------------------------------------------
-- Les familles qu'on n'a pas prévenues faute de crédit.
--
-- Le statut existe déjà pour la famille sans numéro : `injoignable`. Ce cas-ci
-- est l'inverse — la famille est joignable, c'est l'école qui ne peut pas
-- composer — et le confondre avec l'autre enverrait quelqu'un vérifier un
-- numéro qui n'a rien.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sms_messages'::regclass
       and conname = 'sms_messages_status_check'
       and pg_get_constraintdef(oid) like '%sans_credit%'
  ) then
    alter table sms_messages drop constraint if exists sms_messages_status_check;
    alter table sms_messages add constraint sms_messages_status_check
      check (status in ('file', 'envoye', 'livre', 'echoue', 'annule',
                        'injoignable', 'sans_credit'));
  end if;
end $$;

comment on column sms_messages.status is
  '« sans_credit » : la famille était joignable et le message n''a pas été '
  'composé, faute de crédit. À ne pas confondre avec « injoignable », qui dit '
  'que c''est la FAMILLE qui n''a pas de numéro — les deux appellent des '
  'gestes opposés.';

-- ---------------------------------------------------------------------------
-- Les familles laissées sans nouvelle faute de crédit, et non rattrapées.
create or replace function familles_sans_credit()
returns table (message_id uuid, student_id uuid, eleve text, quand timestamptz,
               telephone text)
language sql stable as $$
  select m.id, m.student_id,
         st.last_name || ' ' || st.first_names, m.queued_at, m.to_phone
    from sms_messages m
    join students st on st.id = m.student_id
   where m.status = 'sans_credit'
     /* Rattrapée veut dire : un message PARTI pour la même absence. */
     and not exists (
       select 1 from sms_messages r
        where r.attendance_record_id = m.attendance_record_id
          and r.id <> m.id
          and r.status in ('envoye', 'livre'))
   order by m.queued_at desc;
$$;

comment on function familles_sans_credit() is
  'Les familles qu''on n''a pas prévenues faute de crédit et qu''on n''a pas '
  'rattrapées depuis. Un point d''attention doit pouvoir s''éteindre : celui-ci '
  's''éteint quand le message part enfin, pas quand quelqu''un le lit.';
