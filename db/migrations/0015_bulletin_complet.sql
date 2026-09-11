-- ---------------------------------------------------------------------------
-- Un bulletin doit dire sur quoi il a été calculé.
--
-- CE QUI ÉTAIT SILENCIEUX. Une discipline sans AUCUNE note sortait du calcul
-- de la moyenne générale — ni au numérateur, ni au dénominateur :
--
--     for (const s of subjects) {
--       if (s.moyenne === null) continue;      // <— ici
--       totalPoints += s.moyenne * s.coefficient;
--       totalCoefficients += s.coefficient;
--     }
--
-- La règle elle-même est JUSTE : une discipline non notée ne vaut pas zéro, et
-- la neutraliser est ce qu'il faut faire. Ce qui manquait, c'est de le DIRE.
--
-- Conséquences, toutes invisibles :
--
--   * le bulletin imprimait une moyenne générale parfaitement plausible,
--     calculée sur douze coefficients au lieu de quatorze ;
--   * le RANG comparait des élèves notés sur des ensembles de matières
--     DIFFÉRENTS — un élève à qui il manque les mathématiques, coefficient 3,
--     est classé contre des camarades qui les ont ;
--   * et rien n'empêchait de publier. La publication FIGE : le papier remis
--     aux familles portait ce rang-là.
--
-- Le cas n'a rien d'exotique. Il suffit qu'un enseignant n'ait pas fini sa
-- saisie le jour du conseil de classe — ou qu'il ait quitté l'établissement en
-- cours de trimestre.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE.
--
-- Le total des coefficients ATTENDUS, figé à la publication à côté de ceux
-- qui ont été RETENUS. Les deux ensemble disent l'écart, et le bulletin
-- réimprimé six mois plus tard dit le même : c'est le double qui fait foi.
-- ---------------------------------------------------------------------------

alter table bulletins
  add column if not exists total_coefficients_attendus numeric(6,2);

comment on column bulletins.total_coefficients_attendus is
  'Somme des coefficients de TOUTES les disciplines de la classe. '
  '`total_coefficients` ne compte que celles qui avaient une moyenne. '
  'Quand les deux diffèrent, le bulletin a été calculé sur une partie du '
  'programme, et il doit le dire.';

-- Les bulletins déjà publiés n'ont pas ce nombre : on ne l'invente pas.
-- `null` se lit « on ne sait pas », et l'écran l'affiche comme tel plutôt que
-- d'annoncer faussement un bulletin complet.

create or replace function bulletin_incomplet(p_bulletin uuid)
returns boolean language sql stable as $$
  select b.total_coefficients_attendus is not null
     and b.total_coefficients is not null
     and b.total_coefficients < b.total_coefficients_attendus
    from bulletins b where b.id = p_bulletin;
$$;

comment on function bulletin_incomplet(uuid) is
  'Vrai quand la moyenne générale a été calculée sur moins de coefficients '
  'que la classe n''en compte. Null-safe : un bulletin publié avant cette '
  'migration renvoie faux, faute de savoir.';
