-- ---------------------------------------------------------------------------
-- « annulee » : un état que tout le produit respecte et qu'il ne peut pas
-- atteindre.
--
-- CE QUI A ÉTÉ TROUVÉ EN CHERCHANT QUI ÉCRIT CE STATUT. Onze endroits du code
-- le LISENT — `where i.status <> 'annulee'` — dans la scolarité, l'espace
-- famille, la fiche de l'élève, les relances, les bourses, le tableau de bord,
-- les frais. Aucun ne l'ÉCRIT. Le produit honore partout une décision qu'aucun
-- geste ne permet de prendre.
--
-- CE QUE CELA COÛTE, ET C'EST TOUS LES ANS. Un élève inscrit en septembre qui
-- ne revient pas en octobre — un déménagement, un transfert, un renoncement —
-- laisse une facture de 78 000 F que rien ne peut retirer. Éprouvé : on fait
-- partir un élève par `/transferts`, exactement comme le produit le prévoit, et
-- le « reste à recouvrer » de l'école compte toujours sa facture. Elle reste
-- dans les relances, dans les chiffres bloquants du tableau de bord, et dans
-- l'espace de sa famille.
--
-- Les seuls contournements sont pires que le mal : mettre le total à zéro —
-- aucun écran ne l'offre — ou enregistrer un versement fictif, ce qui
-- falsifierait le registre des reçus.
--
-- ET LA RÉÉMISSION RESSUSCITE. Si le statut était posé à la main, `frais.ts`
-- teste l'existence sur `status <> 'annulee'`, passe outre, puis retombe sur la
-- référence — qui appartient à la facture annulée :
--
--     on conflict (school_id, reference) do update
--       set status = 'ouverte', total_fcfa = excluded.total_fcfa
--
-- Éprouvé : la MÊME LIGNE revient à la vie, son total passe de 78 000 à 999,
-- ses tranches sont effacées et refaites, et l'annulation disparaît sans
-- trace — avec, le cas échéant, des reçus qui portent l'état figé d'une vie
-- que la facture n'a plus.
--
-- ---------------------------------------------------------------------------
-- LA RÈGLE. On n'annule pas en changeant un mot.
--
-- C'est la doctrine des reçus, étendue d'un cran : un paiement annulé produit
-- un reçu inverse, jamais une suppression ; une facture annulée porte QUI l'a
-- annulée, QUAND et POURQUOI, et la contrainte l'exige — le statut et sa trace
-- ne peuvent pas être dissociés. Une facture annulée reste visible, barrée,
-- avec son motif : une somme qui disparaît d'un tableau sans explication est
-- exactement ce qu'un contrôleur vient chercher.
--
-- ET ON N'ANNULE PAS UNE FACTURE SUR LAQUELLE DE L'ARGENT EST ENTRÉ. Le chemin
-- existe déjà et il est propre : contre-passer les versements un par un, ce qui
-- produit autant de reçus inverses, puis annuler la facture vide. Annuler par
-- le haut ferait disparaître d'un clic la contrepartie de reçus remis à des
-- familles.
--
-- ENFIN, RÉÉMETTRE CRÉE UNE NOUVELLE FACTURE. La référence porte un rang :
-- `F-2026-2027-WP-0001`, puis `-2`. Deux lignes, deux histoires, et la
-- première reste lisible avec son motif d'annulation.
-- ---------------------------------------------------------------------------

alter table invoices
  add column if not exists annulee_le timestamptz,
  add column if not exists annulee_par uuid references staff(id),
  add column if not exists motif_annulation text;

comment on column invoices.annulee_le is
  'Quand cette facture a été annulée. La contrainte ci-dessous lie ce champ au '
  'statut : on n''atteint plus « annulee » en changeant un mot.';
comment on column invoices.annulee_par is
  'Qui a annulé. Une somme qui disparaît d''un tableau sans nom est exactement '
  'ce qu''un contrôleur vient chercher.';
comment on column invoices.motif_annulation is
  'Pourquoi. Obligatoire : « élève jamais arrivé », « transféré en octobre », '
  '« double émission ». C''est la phrase que lira l''économe de l''an prochain.';

-- ---------------------------------------------------------------------------
-- LE STATUT ET SA TRACE SONT INDISSOCIABLES.
--
-- Sans cette contrainte, `update invoices set status = 'annulee'` suffirait —
-- et c'est précisément le geste sans trace qu'on refuse. Elle vaut dans les
-- deux sens : pas d'annulation muette, et pas de motif sur une facture vivante.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'invoices_annulation_tracee') then
    alter table invoices add constraint invoices_annulation_tracee
      check ((status = 'annulee') = (annulee_le is not null)
             and (annulee_le is null or coalesce(btrim(motif_annulation), '') <> ''));
  end if;
end $$;

create index if not exists invoices_annulees
  on invoices (school_id, annulee_le desc) where status = 'annulee';

-- ---------------------------------------------------------------------------
-- Cette facture peut-elle être annulée, et sinon pourquoi ?
--
-- La raison est rendue avec la réponse : un refus qui ne dit pas ce qui bloque
-- envoie l'économe chercher à l'aveugle.
create or replace function facture_annulable(p_invoice uuid)
returns table (possible boolean, raison text, verse integer)
language sql stable as $$
  select
    coalesce(i.status, '') <> 'annulee' and i.id is not null
      and coalesce(montant_regle(i.id), 0) = 0,
    case
      when i.id is null then 'Cette facture n''existe pas.'
      when i.status = 'annulee' then 'Elle est déjà annulée.'
      when montant_regle(i.id) <> 0 then
        'Des versements ont été encaissés sur cette facture ('
        || montant_regle(i.id)::text || ' F). Contre-passez-les d''abord, un '
        || 'par un : chacun produit un reçu inverse, et la famille garde la '
        || 'trace des deux. Annuler par le haut ferait disparaître d''un clic '
        || 'la contrepartie de reçus déjà remis.'
      else null
    end,
    coalesce(montant_regle(i.id), 0)::int
  from (select p_invoice as demandee) d
  left join invoices i on i.id = d.demandee
  limit 1;
$$;

comment on function facture_annulable(uuid) is
  'Dit si une facture peut être annulée, et sinon pourquoi — avec le montant '
  'déjà versé. Une facture sur laquelle de l''argent est entré se vide par '
  'contre-passation, jamais par le haut.';

-- ---------------------------------------------------------------------------
-- La référence de la prochaine facture de cet élève pour cette année.
--
-- Réémettre après annulation crée une NOUVELLE ligne : deux références, deux
-- histoires, et la première reste lisible avec son motif. L'ancien code
-- retombait sur la référence de la facture annulée et la ressuscitait.
create or replace function reference_facture(
  p_student uuid, p_year uuid, p_annee_label text)
returns text language sql stable as $$
  select 'F-' || p_annee_label || '-' || st.matricule
      || case when n.deja = 0 then '' else '-' || (n.deja + 1)::text end
    from students st,
         lateral (select count(*)::int as deja from invoices i
                   where i.student_id = p_student
                     and i.academic_year_id = p_year) n
   where st.id = p_student;
$$;

comment on function reference_facture(uuid, uuid, text) is
  'La référence de la prochaine facture de cet élève pour cette année : '
  '`F-<année>-<matricule>`, puis `-2`, `-3`. Le rang compte TOUTES les '
  'factures, annulées comprises — sinon la réémission retomberait sur la '
  'référence de l''annulée et la ressusciterait, ce qui est exactement ce qui '
  'arrivait.';

-- ---------------------------------------------------------------------------
-- Les élèves partis qui gardent une facture ouverte.
--
-- C'est la situation qui rend l'annulation nécessaire, et c'est elle que le
-- tableau de bord doit nommer — sinon le geste existe et personne ne sait
-- quand s'en servir.
create or replace function factures_d_eleves_partis()
returns table (student_id uuid, eleve text, invoice_id uuid,
               reference text, reste integer, statut text, parti_le date)
language sql stable as $$
  select st.id, st.last_name || ' ' || st.first_names, i.id, i.reference,
         (i.total_fcfa - montant_regle(i.id))::int, e.status, e.left_on
    from enrolments e
    join students st on st.id = e.student_id
    join invoices i on i.student_id = e.student_id
                   and i.academic_year_id = e.academic_year_id
   where e.academic_year_id = annee_en_cours()
     and e.status in ('transfere_sortant', 'radie', 'abandon')
     and i.status <> 'annulee'
     and i.total_fcfa - montant_regle(i.id) > 0
   order by st.last_name;
$$;

comment on function factures_d_eleves_partis() is
  'Les factures ouvertes d''élèves qui ont quitté l''établissement cette '
  'année. Elles pesaient éternellement sur le « reste à recouvrer » et dans '
  'les relances, sans aucun geste pour les solder : le statut « annulee » '
  'était lu par onze écrans et écrit par aucun.';
