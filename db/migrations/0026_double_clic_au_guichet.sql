-- ---------------------------------------------------------------------------
-- La serrure était posée. La clé était refaite à chaque tour.
--
-- CE QUI A ÉTÉ TROUVÉ EN CLIQUANT DEUX FOIS SUR « ENCAISSER ». Deux POST
-- identiques lancés ensemble — le double-clic, sur une connexion lente, c'est
-- le geste humain normal — et voici la base :
--
--     paiements : 2 · reçus : 2 · réglé : 20 000 F
--     R-2026-0025  10 000 F   « total payé : 10 000 »
--     R-2026-0026  10 000 F   « total payé : 10 000 »
--
-- Un billet de dix mille remis au guichet, vingt mille portés au crédit de la
-- famille, deux numéros de reçu tirés du registre, et une caisse qui manque de
-- dix mille francs au soir. Un troisième POST — la touche F5 sur l'écran de
-- confirmation — en ajoute un troisième.
--
-- ET LES DEUX PAPIERS SE CONTREDISENT AVEC LA COMPTABILITÉ. Chacun porte
-- « total payé : 10 000 » : tous deux ont lu la facture avant qu'aucun n'ait
-- écrit. L'état figé introduit en 0018 — celui qui garantit qu'un reçu
-- réimprimé dit la même chose que le papier remis — est lui-même faux ici,
-- parce que la course a eu lieu en amont de lui.
--
-- ---------------------------------------------------------------------------
-- LA SERRURE EXISTAIT DEPUIS LE PREMIER SCHÉMA.
--
--     idempotency_key   text not null,
--     ...
--     unique (school_id, idempotency_key)
--
-- Une contrainte d'unicité, réelle, posée par PostgreSQL. Et le code la
-- nourrissait ainsi :
--
--     `guichet:${invoiceId}:${Date.now()}`
--
-- Une clé neuve à chaque milliseconde. La serrure n'a jamais refusé personne :
-- on lui présentait une clé différente à chaque fois. C'est la forme la plus
-- discrète de défaut — le dispositif est là, il est correct, il est même
-- vérifié par la base, et la valeur qu'on lui donne l'annule.
--
-- Le verrou d'avis (`pg_advisory_xact_lock`) qui sérialise la NUMÉROTATION,
-- lui, fonctionne parfaitement : les deux reçus ont des numéros distincts et
-- consécutifs. Il ne fait qu'une chose, et c'est de rendre le doublon net.
--
-- ---------------------------------------------------------------------------
-- LA RÈGLE, DÉJÀ ÉCRITE EN 0014 POUR LES ENVOIS EN MASSE :
--
--     « Ce n'est pas un cas tordu. C'est le double-clic. Sur une connexion
--       lente — la connexion visée — la page met plusieurs secondes à
--       répondre, et cliquer une deuxième fois est le comportement humain
--       normal. »
--
-- Elle n'avait pas été appliquée au chemin de l'argent.
--
-- ON COMPARE LE GESTE, PAS UN JETON. Même raisonnement qu'en 0014 : un jeton
-- de formulaire attrape le double-clic et rien d'autre. Le geste — cette
-- facture, ce montant, ce moyen, ce guichetier — attrape aussi le retour
-- arrière, le rechargement, et le re-clic après une attente jugée trop longue.
--
-- ET UNE FENÊTRE, PARCE QU'UN VERSEMENT PEUT LÉGITIMEMENT SE RÉPÉTER. Une
-- famille qui verse deux fois cinq mille francs sur la même facture le même
-- jour existe. Deux fois le même montant sur la même facture DANS LA MÊME
-- MINUTE n'existe pas : c'est un clic de trop. La fenêtre est donc courte, et
-- c'est un réglage de l'établissement, pas une constante du code.
-- ---------------------------------------------------------------------------

alter table schools
  add column if not exists fenetre_double_clic_secondes integer not null default 90;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'schools_fenetre_double_clic_valide') then
    alter table schools add constraint schools_fenetre_double_clic_valide
      check (fenetre_double_clic_secondes between 0 and 3600);
  end if;
end $$;

comment on column schools.fenetre_double_clic_secondes is
  'Pendant combien de secondes deux encaissements identiques sur la même '
  'facture sont tenus pour UN SEUL geste. Zéro désactive la garde — ce qui se '
  'fait, mais se décide. Quatre-vingt-dix secondes par défaut : le temps '
  'qu''une page mette à répondre sur une connexion lente, plus la patience '
  'd''un guichetier.';

-- ---------------------------------------------------------------------------
-- La clé d'un encaissement : le GESTE et son RANG, jamais l'instant.
--
-- PREMIÈRE VERSION, ET POURQUOI ELLE ÉTAIT FAUSSE. La clé portait d'abord un
-- créneau de temps — `epoch / fenêtre` — et l'épreuve l'a renversée en deux
-- coups :
--
--   * un versement LÉGITIME, dix minutes plus tard, était refusé : son geste
--     tombait dans le même créneau absolu que le précédent ;
--   * et la fenêtre mise à zéro ne désactivait rien, le créneau continuant de
--     confondre deux clics de la même seconde.
--
-- Un découpage absolu du temps ne dit pas « ces deux gestes sont le même » ; il
-- dit « ces deux gestes sont tombés dans la même case », ce qui n'est pas la
-- question. On compte donc le RANG : combien de versements identiques ont déjà
-- été acceptés sur cette facture. Le premier clic calcule 0, le second clic
-- simultané calcule 0 aussi — même clé, la contrainte tranche — et le vrai
-- second versement, plus tard, calcule 1.
--
-- Déterministe, sans horloge, et la contrainte d'unicité fait enfin un travail
-- réel : elle départage deux requêtes VRAIMENT simultanées, celles que le
-- verrou d'avis n'aurait pas séparées si deux serveurs répondaient.
create or replace function cle_encaissement(
  p_invoice uuid, p_montant integer, p_methode text,
  p_agent uuid, p_rang integer)
returns text language sql immutable as $$
  select 'guichet:' || p_invoice::text
      || ':' || p_montant::text
      || ':' || p_methode
      || ':' || coalesce(p_agent::text, 'sans-agent')
      || ':' || p_rang::text;
$$;

comment on function cle_encaissement(uuid, integer, text, uuid, integer) is
  'La clé d''idempotence d''un encaissement : le geste — cette facture, ce '
  'montant, ce moyen, ce guichetier — et son rang parmi les versements '
  'identiques déjà acceptés. Elle remplace `guichet:<facture>:<Date.now()>`, '
  'neuve à chaque milliseconde, qui rendait inopérante la contrainte '
  'd''unicité posée sur cette colonne depuis le premier schéma.';

-- Combien de versements identiques ont déjà été acceptés sur cette facture ?
-- C'est le rang que prendra le prochain.
create or replace function rang_encaissement(
  p_invoice uuid, p_montant integer, p_methode text, p_agent uuid)
returns integer language sql stable as $$
  select count(*)::int from payments p
   where p.invoice_id = p_invoice
     and p.amount_fcfa = p_montant
     and p.method = p_methode
     and p.recorded_by is not distinct from p_agent
     and p.reverses_payment_id is null;
$$;

comment on function rang_encaissement(uuid, integer, text, uuid) is
  'Le rang qu''occupera le prochain versement identique. Deux clics simultanés '
  'le calculent pareil — c''est ce qui les rend détectables ; un vrai second '
  'versement, plus tard, en obtient un autre.';

-- ---------------------------------------------------------------------------
-- Un encaissement identique vient-il d'avoir lieu ?
--
-- La fenêtre glissante : c'est ELLE qui décide si deux gestes identiques n'en
-- font qu'un. La clé et sa contrainte d'unicité ne font que départager deux
-- requêtes vraiment simultanées, que le verrou d'avis n'aurait pas séparées si
-- deux serveurs répondaient.
--
-- Elle rend le reçu DÉJÀ ÉMIS, pour que le second clic retombe sur la même
-- confirmation au lieu d'un refus : un guichetier qui voit « erreur » après
-- avoir cliqué deux fois ne sait pas si l'argent est passé, et recommence.
create or replace function encaissement_deja_enregistre(
  p_invoice uuid, p_montant integer, p_methode text, p_agent uuid)
returns table (payment_id uuid, receipt_number text, quand timestamptz)
language sql stable as $$
  select p.id, r.receipt_number, p.initiated_at
    from payments p
    left join receipts r on r.payment_id = p.id
   where p.invoice_id = p_invoice
     and p.amount_fcfa = p_montant
     and p.method = p_methode
     and p.recorded_by is not distinct from p_agent
     and p.status = 'confirme'
     and p.reverses_payment_id is null
     and p.initiated_at > now() - make_interval(
           secs => (select fenetre_double_clic_secondes from schools limit 1))
   order by p.initiated_at desc
   limit 1;
$$;

comment on function encaissement_deja_enregistre(uuid, integer, text, uuid) is
  'Le versement identique déjà enregistré sur cette facture dans la fenêtre — '
  'et son numéro de reçu, pour que le second clic retombe sur la même '
  'confirmation. Un guichetier à qui l''on répond « erreur » ne sait pas si '
  'l''argent est passé, et recommence.';

create index if not exists payments_doublon_recent
  on payments (school_id, invoice_id, initiated_at desc)
  where status = 'confirme' and reverses_payment_id is null;
