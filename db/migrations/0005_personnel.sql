-- ---------------------------------------------------------------------------
-- Le personnel de l'établissement.
--
-- Jusqu'ici, une seule ligne du projet créait un compte : `scripts/demo.ts`.
-- Un établissement qui installait SchoolFaso ne pouvait donc inscrire ni son
-- proviseur, ni son censeur, ni un seul de ses enseignants — il fallait ouvrir
-- psql. C'est pourtant le tout PREMIER geste d'une installation, avant l'année
-- scolaire et avant les élèves.
--
-- DEUX CORRECTIONS DE SÛRETÉ VIENNENT AVEC :
--
-- 1. `auth_resolve` ne vérifiait pas `is_active`. Désactiver quelqu'un lui
--    interdisait de SE RECONNECTER, mais laissait vivre chaque session déjà
--    ouverte jusqu'à son expiration. Un établissement qui écarte un
--    enseignant, ou une secrétaire soupçonnée d'avoir touché aux reçus,
--    lisait « désactivé » à l'écran pendant que la personne continuait
--    d'écrire des notes depuis son téléphone. La désactivation révoque
--    désormais les sessions vivantes ; ce contrôle-ci ferme la course entre
--    les deux gestes.
--
-- 2. `staff_deactivate` refuse d'écarter le dernier chef d'établissement en
--    exercice. Sans ce garde-fou, un directeur qui se désactive par erreur
--    ferme l'établissement à clé : plus personne ne peut gérer le personnel,
--    et il n'existe aucune console d'administration pour le rattraper. La
--    règle est posée en base, pas dans l'écran, parce qu'un écran se
--    contourne avec un formulaire fabriqué à la main.
--
-- Migration additive : elle ne modifie aucune table.
-- ---------------------------------------------------------------------------

create or replace function auth_resolve(p_access_hash text)
returns table (user_id uuid, school_id uuid, full_name text,
               fonction text, roles text[])
security definer set search_path = public
as $$
  select u.id, s.school_id, u.full_name,
         (select st.fonction from staff st where st.user_id = u.id limit 1),
         coalesce((select array_agg(ur.role_code) from user_roles ur
                    where ur.user_id = u.id), array[]::text[])
    from auth_sessions s
    join users u on u.id = s.user_id
   where s.access_token_hash = p_access_hash
     and s.revoked_at is null
     and s.expires_at > now()
     -- Une session ouverte ne survit pas à la désactivation de son titulaire.
     and u.is_active
   limit 1;
$$ language sql stable;

/*
 * Combien de chefs d'établissement en exercice, hors celui qu'on s'apprête à
 * écarter. Utilisée par l'écran ET par la désactivation : l'écran s'en sert
 * pour expliquer, la désactivation pour refuser.
 */
create or replace function chefs_en_exercice(p_sauf uuid default null)
returns integer
language sql stable
as $$
  select count(*)::int
    from staff st
    join users u on u.id = st.user_id
   where st.school_id = current_school_id()
     and st.is_active and u.is_active
     and st.fonction in ('proviseur', 'directeur')
     and (p_sauf is null or st.id <> p_sauf);
$$;

comment on function chefs_en_exercice(uuid) is
  'Le dernier chef d''établissement ne peut pas être écarté : sans lui plus '
  'personne ne gère le personnel, et il n''existe aucune console '
  'd''administration pour rattraper l''erreur.';
