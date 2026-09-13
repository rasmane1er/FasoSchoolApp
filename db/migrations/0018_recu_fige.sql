-- ---------------------------------------------------------------------------
-- Un reçu réimprimé disait autre chose que le papier remis à la famille.
--
-- CE QUI ÉTAIT FAUX. `receiptPage` calcule le cartouche de droite — « Total dû
-- / Total payé / Reste » — AU MOMENT DE L'IMPRESSION :
--
--     montant_regle(i.id) as paye
--     ...
--     const reste = Number(d.total_fcfa) - Number(d.paye);
--
-- Le montant reçu, lui, est bien figé (`receipts.amount_fcfa`). Mais tout ce
-- qui l'entoure suit la facture en temps réel. Éprouvé, dans l'ordre :
--
--   1. une famille verse 10 000 F. Le reçu N°1 sort : « Total payé 10 000,
--      Reste 68 000 ». Elle le range dans un cahier ;
--   2. trois semaines plus tard elle verse le solde ;
--   3. l'économe réimprime LE MÊME REÇU N°1. Il affiche désormais
--      « SCOLARITÉ SOLDÉE ».
--
-- Deux papiers, un seul numéro, deux affirmations contradictoires sur ce
-- qu'une famille a payé. Et l'écart va dans les deux sens : si un paiement
-- antérieur est annulé, la réimpression montre un reste PLUS GRAND que celui
-- que la famille détient.
--
-- Le dépôt porte déjà cette règle pour les bulletins — « le bulletin remis ne
-- bouge pas », figé à la publication — et l'applique aux reçus pour le montant
-- seul. Elle vaut pour tout ce que le papier affirme.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE : l'état de la facture À L'INSTANT DU REÇU.
--
-- Deux nombres, écrits une fois, jamais recalculés. Le reste s'en déduit, donc
-- on ne le stocke pas : un troisième nombre qui pourrait diverger des deux
-- autres n'apporterait que des occasions de se contredire.
-- ---------------------------------------------------------------------------

alter table receipts
  add column if not exists total_du_fcfa    integer,
  add column if not exists total_paye_fcfa  integer;

comment on column receipts.total_du_fcfa is
  'Le total de la facture tel qu''il était quand ce reçu a été émis. Figé : '
  'un reçu réimprimé six mois plus tard doit dire exactement ce que disait le '
  'papier remis à la famille.';

comment on column receipts.total_paye_fcfa is
  'Le cumul versé sur cette facture À L''INSTANT de ce reçu, celui-ci compris. '
  'Le reste s''en déduit ; on ne le stocke pas, pour qu''il ne puisse pas '
  'contredire les deux autres.';

-- Les reçus émis avant cette migration n'ont pas ces nombres, et on ne les
-- invente pas : `montant_regle()` aujourd'hui ne dit pas ce que le papier
-- disait à l'époque, et c'est précisément le défaut qu'on répare. `null` se
-- lit « ce reçu ne peut plus restituer le solde du jour », et l'impression
-- l'écrit en toutes lettres plutôt que d'afficher un chiffre d'aujourd'hui
-- sous un numéro d'hier.

create or replace function recu_restituable(p_receipt uuid)
returns boolean language sql stable as $$
  select total_du_fcfa is not null and total_paye_fcfa is not null
    from receipts where id = p_receipt;
$$;

comment on function recu_restituable(uuid) is
  'Vrai quand ce reçu porte l''état de la facture au moment de son émission, '
  'et peut donc être réimprimé à l''identique. Faux pour les reçus antérieurs '
  'à la migration 0018.';
