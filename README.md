# FasoSchool

Plateforme de gestion scolaire pour les établissements privés du Burkina Faso.

Trois choses, bien faites, avant toute autre :

1. **Éditer un bulletin de notes juste** — c'est ce que le censeur passe des
   semaines à produire chaque trimestre, et ce qu'un établissement achète.
2. **Prévenir les parents par SMS le jour de l'absence** — 8 FCFA, tous les
   opérateurs, aucune application à installer.
3. **Tenir la scolarité et le dossier de catégorisation** — l'arrêté
   n°2026-101 conditionne le plafond légal des frais au score de
   l'établissement sur 100 points.

Pas un système d'exploitation numérique pour écoles. Trois métiers.

---

## État

Ce dépôt repart de zéro le 6 septembre 2026. Le prototype précédent reste
consultable dans l'historique git :

| branche | contenu |
|---|---|
| `main` | le projet actuel |
| `baseline-prototype` | le prototype complet, 298 fichiers, intact |
| `salvage-reset` | ce même prototype après réduction de périmètre |

Rien n'a été poussé sur GitHub. **`git push --all origin` reste à faire** —
tant que ce n'est pas fait, tout tient sur un seul disque.

### Ce qui existe

- `db/migrations/0001_initial.sql` — le schéma. UUID, `school_id` partout,
  row-level security sur les 54 tables multi-locataires.
- `db/migrations/0002_reference_data.sql` — le référentiel national
  (CP1→Tle, séries du BAC, matières par champ disciplinaire, fonctions
  burkinabè) et `seed_school_defaults()`.
- `db/tests/rls_isolation.sql` — le test d'isolation contradictoire.
- `src/lib/bulletin.ts` — le moteur de calcul. 15 tests.
- `src/lib/db.ts` — accès base avec contexte d'établissement obligatoire.
- `src/lib/sms.ts` — canal SMS, adaptateur Orange Burkina.

### Ce qui n'existe pas encore

L'interface web, l'API, l'authentification par OTP, le rendu PDF du bulletin,
la saisie hors-ligne. Volontairement : la maquette des écrans est faite,
le code attend un vrai bulletin burkinabè.

---

## Démarrer

```bash
createdb fasoschool
createuser fasoschool_app --pwprompt        # PAS superutilisateur
export DATABASE_URL=postgres://fasoschool_app:...@localhost:5432/fasoschool

npm install
npm run db:migrate
npm run db:test:rls        # doit passer avant tout développement
npm test
```

---

## Les quatre règles à confirmer

Ces règles n'ont pas pu être établies depuis une source burkinabè publique.
Elles sont livrées comme **données**, avec leur provenance dans `source_note`,
et il faut les faire confirmer par un censeur avant tout usage réel.

| règle | valeur par défaut | provenance |
|---|---|---|
| pondération devoirs / composition | `(devoirs + compo × 2) / 3` | convention régionale, aucun texte burkinabè trouvé |
| table des coefficients | maths 3, français 3, autres 2 | réforme des **examens** 2026 ; usage sur bulletin interne non vérifié |
| seuils de mention | 10 / 12 / 14 / 16 | toutes les sources trouvées étaient françaises, sénégalaises, marocaines ou ivoiriennes |
| gabarit du bulletin | générique | aucun modèle officiel MENAPLN publié, aucun bulletin scanné trouvé |

Une matinée avec un censeur coopératif et une photocopieuse ferme les quatre.

---

## Ce qui est déjà encodé et vérifié

- **Redoublement interdit en CP1, CE1 et CM1** (arrêté 2019, première année de
  chaque sous-cycle du primaire). Passage automatique, quelle que soit la
  moyenne. Mesure contestée par le SYNAPEC : c'est une règle en base, pas une
  constante.
- **Coefficients réformés en 2026** : maths et français passent de 5 à 3,
  toutes les autres disciplines à 2, et l'éducation civique devient une
  matière à part entière avec sa propre ligne.
- **Le CEP et le concours d'entrée en sixième sont deux résultats distincts.**
  Réussir le CEP ne donne pas accès à la 6e.
- **Trimestres inégaux** : le T3 est tronqué par la session d'examens. Les
  bornes sont des dates saisies, jamais l'année divisée en trois.
- **Calendrier amendable par région** : Bobo-Dioulasso a terminé 2025-2026 le
  30 mai au lieu du 15 juillet pour la SNC.
- **Arrêté n°2026-101** : `fee_lines.cap_treatment` distingue plafonné,
  autorisé-supplémentaire et exclu. L'inscription est DANS le plafond ;
  l'hébergement en est exclu.

---

## Règles d'ingénierie

**Le cloisonnement passe par la base, pas par le code.** Toute requête
applicative passe par `withSchool()`. Sans `fasoschool.school_id` posé, le RLS
ne renvoie aucune ligne. L'utilisateur PostgreSQL applicatif ne doit jamais
être superutilisateur — un superutilisateur contourne le RLS entièrement.

**Les règles pédagogiques sont des données datées.** Le ministère a modifié
les coefficients ET la règle de redoublement en 2026. Un `if` dans le code
serait faux avant la fin de l'année scolaire.

**Une note ne dépend jamais du paiement.** Le module évaluation n'importe
rien du module scolarité. Le jour où un directeur demande de masquer les
bulletins des familles en retard, cela se fait à l'affichage, sans corrompre
le carnet de notes.

**Le hors-ligne se limite au strict nécessaire.** La saisie des notes et
l'appel, sur le poste de l'enseignant. Ni l'administration ni la comptabilité :
ces utilisateurs sont à un bureau.

---

## Prochaine étape

Elle n'est pas dans ce dépôt. Entre le **15 septembre** (rentrée
administrative) et le **1er octobre** (rentrée pédagogique), les censeurs sont
à leur bureau et n'enseignent pas encore. C'est la quinzaine la plus
accessible de l'année scolaire.

Rapporter un vrai bulletin. Le reste du moteur s'écrit ensuite en une semaine.
