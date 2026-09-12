-- ---------------------------------------------------------------------------
-- « En retard » voulait dire « doit quelque chose ».
--
-- CE QUI ÉTAIT FAUX. Dans `finance.ts`, une ligne :
--
--     const enRetard = rows.filter((r) => r.rest > 0);
--
-- et, juste à côté, la tuile qui l'affiche : « 9 familles en retard ». Or
-- `rest` est le solde de l'ANNÉE ENTIÈRE. Le jour où les factures sont émises,
-- avant qu'un seul franc ne soit dû, TOUTES les familles sont donc « en
-- retard », et leur ligne est peinte en rouge.
--
-- Mesuré sur le jeu de démonstration : neuf familles annoncées « en retard »,
-- dont quatre qui ont versé 40 000 F sur 78 000 — c'est-à-dire la première
-- tranche et une partie de la deuxième, en avance sur l'échéancier.
--
-- Ce n'est pas un mot mal choisi dans un coin d'écran. C'est le mot sur lequel
-- un établissement décide qui il renvoie à la maison.
--
-- ---------------------------------------------------------------------------
-- L'ÉCHÉANCIER EXISTAIT DÉJÀ, ET PERSONNE NE LE LISAIT.
--
-- `frais.ts` écrit `invoice_instalments` à chaque émission : une tranche par
-- trimestre, alignée sur les dates saisies par l'école. C'est la norme au
-- Burkina, et c'est la question quotidienne de l'économe — « qui n'a pas payé
-- la tranche d'octobre ? », jamais « qui doit encore quelque chose ? », à quoi
-- la réponse en mars est « tout le monde ».
--
-- Cette table n'était lue par AUCUNE requête de l'application. Les suites de
-- tests la sauvegardaient et la restauraient, une en sommait le total pour
-- vérifier qu'une bourse la rabote — et pas un écran ne la montrait.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE.
--
-- Deux fonctions, et un parti pris sur ce qu'on ne sait pas.
-- ---------------------------------------------------------------------------

create or replace function montant_echu(p_invoice uuid, p_jour date)
returns integer language sql stable as $$
  select case
    when not exists (
      select 1 from invoice_instalments where invoice_id = p_invoice)
    then null                    -- « on ne sait pas », voir le commentaire
    else coalesce((
      select sum(amount_fcfa)::int from invoice_instalments
       where invoice_id = p_invoice and due_on <= p_jour), 0)
  end;
$$;

comment on function montant_echu(uuid, date) is
  'Ce qui était exigible à cette date, d''après l''échéancier de la facture. '
  'NULL quand la facture n''a pas d''échéancier : on ne répond ni « tout » '
  '(toutes les familles seraient en retard dès l''émission) ni « rien » '
  '(aucune ne le serait jamais). Les écrans affichent ce null comme tel.';

create or replace function retard_de(p_invoice uuid, p_jour date)
returns integer language sql stable as $$
  select case
    when montant_echu(p_invoice, p_jour) is null then null
    else greatest(0, montant_echu(p_invoice, p_jour)
                     - montant_regle(p_invoice))::int
  end;
$$;

comment on function retard_de(uuid, date) is
  'Ce qui était exigible et n''a pas été versé, à cette date. Jamais négatif : '
  'une famille en avance n''est pas « en retard de moins que rien ». NULL se '
  'propage depuis montant_echu : sans échéancier, le retard est inconnu, pas '
  'nul.';

-- ---------------------------------------------------------------------------
-- LA PROCHAINE ÉCHÉANCE.
--
-- Ce qu'une famille a besoin de savoir n'est pas « vous devez 78 000 F » — un
-- chiffre qui effraie et qu'on ne peut pas verser d'un coup — mais « il vous
-- reste X à verser maintenant, et Y le 5 janvier ».
create or replace function prochaine_echeance(p_invoice uuid, p_jour date)
returns table (label text, amount_fcfa integer, due_on date)
language sql stable as $$
  select label, amount_fcfa, due_on
    from invoice_instalments
   where invoice_id = p_invoice and due_on > p_jour
   order by due_on limit 1;
$$;

comment on function prochaine_echeance(uuid, date) is
  'La première tranche à venir après cette date, s''il en reste une. Aucune '
  'ligne quand l''échéancier est épuisé ou absent.';

-- L'index existant (school_id, invoice_id, due_on) sert déjà ces trois
-- fonctions : elles filtrent toutes sur `invoice_id` puis sur `due_on`.
