-- ---------------------------------------------------------------------------
-- L'annulation d'un paiement.
--
-- Un économe encaisse debout, devant une file de parents, en fin de mois. Il
-- tape 50 000 au lieu de 5 000. Jusqu'ici, rien ne pouvait le rattraper : le
-- reçu était émis, la facture soldée, et le seul recours était psql. C'est le
-- genre d'erreur qui arrive le premier jour.
--
-- ON N'EFFACE PAS UN REÇU. Un reçu est un document remis à une famille, et sa
-- numérotation est une suite sans trou — c'est ce qui la rend vérifiable. Le
-- supprimer, ou même diminuer le montant du paiement, détruirait la preuve
-- qu'un contrôle cherche justement. Une annulation est donc un SECOND
-- paiement, de contrepartie : même montant, signe opposé à la lecture, son
-- propre numéro de reçu, et un motif obligatoire. Les deux lignes restent.
--
-- `payments.amount_fcfa > 0` est une contrainte du premier schéma que cette
-- migration ne lève pas : c'est `reverses_payment_id` qui porte le sens, pas
-- le signe. Toute lecture doit donc soustraire les contrepassations — et
-- comme la même somme était écrite de sept façons différentes dans le code,
-- elle est désormais écrite UNE fois, ici, et appelée partout.
--
-- Migration additive.
-- ---------------------------------------------------------------------------

alter table payments
  add column if not exists reverses_payment_id uuid references payments(id),
  add column if not exists reversal_reason     text;

-- Un paiement ne s'annule qu'une fois : deux contrepassations rendraient la
-- facture créditrice et l'établissement débiteur d'une famille.
create unique index if not exists payments_une_seule_annulation
  on payments (reverses_payment_id)
  where reverses_payment_id is not null;

comment on column payments.reverses_payment_id is
  'Renseignée, cette ligne est la contrepassation du paiement visé : son '
  'montant se SOUSTRAIT. Le paiement d''origine et son reçu restent intacts.';
comment on column payments.reversal_reason is
  'Le motif de l''annulation. Obligatoire : une annulation sans raison est '
  'exactement ce que produirait un caissier malhonnête.';

/*
 * Ce qui a réellement été réglé sur une facture, contrepassations déduites.
 *
 * Une seule définition, appelée par tous les écrans. Sept requêtes séparées
 * calculaient cette somme chacune à sa façon ; c'est ainsi qu'elles finissent
 * par ne plus dire la même chose, et qu'un parent lit deux soldes différents
 * sur deux écrans du même logiciel.
 */
create or replace function montant_regle(p_invoice uuid)
returns integer
language sql stable
as $$
  select coalesce(sum(
           case when p.reverses_payment_id is null
                then p.amount_fcfa else -p.amount_fcfa end), 0)::int
    from payments p
   where p.invoice_id = p_invoice
     and p.status in ('confirme', 'rapproche');
$$;

create or replace function reste_a_payer(p_invoice uuid)
returns integer
language sql stable
as $$
  select greatest(0, (select i.total_fcfa from invoices i where i.id = p_invoice)
                     - montant_regle(p_invoice))::int;
$$;

comment on function montant_regle(uuid) is
  'Le net encaissé sur une facture : paiements confirmés moins '
  'contrepassations. La seule définition — aucun écran ne refait cette somme.';
