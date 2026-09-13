-- ---------------------------------------------------------------------------
-- Un élève arrivé en janvier était « en retard » depuis octobre.
--
-- CE QUI A ÉTÉ TROUVÉ, EN TIRANT LE FIL DE LA MIGRATION PRÉCÉDENTE.
--
-- 0017 a donné un sens au mot « en retard » : ce qui était exigible d'après
-- l'échéancier, et qui n'a pas été versé. Reste une question que personne ne
-- posait — exigible DE QUI, et depuis quand ?
--
-- `frais.ts` émet la facture de l'année entière et pose une tranche au début
-- de chaque trimestre. Pour un élève inscrit à la rentrée, c'est juste. Pour un
-- enfant arrivé en janvier — transfert, déménagement, une famille qui a mis
-- trois mois à réunir les frais — la tranche d'octobre est exigible AVANT SON
-- ARRIVÉE. L'écran de la scolarité le compte « en retard », peint sa ligne en
-- rouge, et le tableau de bord réclame. Pour des mois où l'enfant n'était pas
-- là.
--
-- Ce n'est pas un cas rare au Burkina : les arrivées en cours d'année sont
-- ordinaires, et ce sont précisément les familles les plus fragiles.
--
-- ---------------------------------------------------------------------------
-- LA DATE EXISTAIT, ET ELLE ÉTAIT FAUSSE.
--
-- `enrolments.enrolled_on date not null default current_date` : la colonne est
-- là depuis le premier jour. Aucune ligne de code ne l'écrit ni ne la lit —
-- c'est le DÉFAUT de PostgreSQL qui la remplit, avec le jour où la ligne a été
-- insérée.
--
-- Autrement dit : une école qui importe sa liste en novembre inscrit tous ses
-- élèves « le 12 novembre », et son effectif entier devient une cohorte
-- d'arrivées en cours d'année. Personne ne s'en apercevait, puisque rien ne
-- lisait cette date.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION FAIT — ET CE QU'ELLE REFUSE DE FAIRE.
--
-- Elle ajoute la date de SORTIE, qui manquait entièrement : un départ ne
-- posait que le statut `transfere_sortant`, sans dire quand.
--
-- Elle ne touche PAS au calcul du retard. Savoir si un enfant arrivé en
-- janvier doit les tranches d'octobre et de janvier, une seule, ou une somme
-- négociée, est une RÈGLE D'ÉTABLISSEMENT : au Burkina elle varie d'une école
-- à l'autre, et aucun texte consulté ne la fixe. L'inventer ici reviendrait à
-- décider, dans un logiciel, ce qu'une famille doit — et la ligne rouge de
-- l'écran décide déjà de qui on renvoie à la maison.
--
-- Le produit fait donc ce qu'il sait faire : il DIT que des échéances
-- antérieures à l'arrivée sont comptées dans ce retard, et laisse
-- l'établissement trancher. La règle rejoint le tableau des règles à
-- confirmer, avec les six autres.
-- ---------------------------------------------------------------------------

alter table enrolments
  add column if not exists left_on date;

comment on column enrolments.enrolled_on is
  'Le jour où l''élève est arrivé. Écrit explicitement depuis 0019 : le défaut '
  'de la colonne posait la date d''INSERTION de la ligne, ce qui faisait d''une '
  'liste importée en novembre une classe entière d''arrivées tardives.';

comment on column enrolments.left_on is
  'Le jour du départ, pour un transfert sortant, une sortie ou une exclusion. '
  'Null tant que l''élève est là. Un départ ne posait auparavant qu''un statut, '
  'sans date : on ne pouvait pas dire depuis quand une place était libre.';

-- ---------------------------------------------------------------------------
-- Les échéances tombées AVANT l'arrivée de l'élève.
--
-- Le nombre, et leur somme. Le produit ne décide pas si elles sont dues : il
-- les compte, et le dit là où quelqu'un lit « en retard ».
create or replace function echeances_avant_arrivee(p_invoice uuid)
returns table (combien integer, montant integer, arrivee date)
language sql stable as $$
  -- Pure arithmétique : les tranches de CETTE facture tombées avant l'arrivée
  -- de CET élève. Aucune ligne quand il n'y en a pas — c'est-à-dire pour tout
  -- élève présent dès la rentrée, qui est le cas ordinaire et n'appelle aucune
  -- mention. On ne teste pas séparément « arrivé après l'ouverture de
  -- l'année » : les tranches se posent aux débuts de trimestre, donc un élève
  -- présent à la rentrée n'en a par construction aucune derrière lui, et une
  -- condition de plus n'ajouterait que des façons de se tromper.
  select count(ii.*)::int,
         coalesce(sum(ii.amount_fcfa), 0)::int,
         e.enrolled_on
    from invoices i
    join enrolments e on e.student_id = i.student_id
                     and e.academic_year_id = i.academic_year_id
    join invoice_instalments ii on ii.invoice_id = i.id
                               and ii.due_on < e.enrolled_on
   where i.id = p_invoice
   group by e.enrolled_on;
$$;

comment on function echeances_avant_arrivee(uuid) is
  'Combien de tranches de cette facture étaient exigibles avant que l''élève '
  'n''arrive, et pour quel montant. Aucune ligne quand l''élève était là dès '
  'l''ouverture de l''année : c''est le cas ordinaire, et il n''appelle aucune '
  'mention.';
