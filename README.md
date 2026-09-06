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

**Base**
- `db/migrations/0001_initial.sql` — le schéma. UUID, `school_id` partout,
  row-level security sur les 54 tables multi-locataires.
- `db/migrations/0002_reference_data.sql` — le référentiel national
  (CP1→Tle, séries du BAC, matières par champ disciplinaire, fonctions
  burkinabè), `seed_school_defaults()`, `provision_school()` et les quatre
  fonctions d'authentification.
- `db/migrations/0003_guardian_access.sql` — sessions des familles, séparées
  de celles du personnel, et leurs quatre fonctions d'authentification.
- `db/tests/rls_isolation.sql` — le test d'isolation contradictoire.

**Métier**
- `src/lib/bulletin.ts` — le moteur de calcul. 15 tests.
- `src/lib/repository.ts` — chargement d'une classe, règles choisies par date
  d'effet.
- `src/lib/render.ts` — bulletin A4 imprimable.
- `src/lib/db.ts` — accès base avec contexte d'établissement obligatoire.
- `src/lib/sms.ts` — canal SMS, adaptateur Orange Burkina.

**Application**
- `src/server/session.ts` — connexion par téléphone et code à usage unique.
- `src/server/html.ts` — mise en page et composants.
- `src/server/app.ts` — tableau de bord, saisie des notes, bulletins, appel
  et SMS, catégorisation.
- `src/server/settings.ts` — règles de notation, corrigeables par le censeur
  avec aperçu immédiat sur une classe réelle.
- `src/server/finance.ts` — encaissement au guichet et reçus numérotés.
- `src/server/rentree.ts` — année scolaire, trimestres et classes : un
  établissement s'installe seul, sans qu'on touche à sa base.
- `src/server/roster.ts` — import de la liste des élèves : aperçu, correction
  sur place, réinscription sans doublon.
- `src/server/conseil.ts` — conseil de classe : proposition motivée, décision
  humaine, livret scolaire cumulatif.
- `src/server/famille.ts` — espace des familles : une page, sans JavaScript,
  sur son propre cookie.
- `src/server/categorisation.ts` — dossier de catégorisation : critères, pièces
  justificatives, score sur 100.
- `src/lib/roster.ts` — lecture d'un fichier de liste (encodage, séparateur,
  intitulés, dates, numéros). 22 tests.
- `src/server/multipart.ts` — envoi de fichier, écrit à la main pour ne pas
  ajouter de dépendance.
- `src/server/sync.ts` — réception des saisies hors ligne, détection des
  divergences, écran d'arbitrage du censeur.
- `public/offline.js` — file d'attente des notes dans IndexedDB.
- `public/sw.js` — cache de l'écran de saisie.

**Démonstration** — `npm run demo` crée un établissement, une 6<sup>e</sup> de
douze élèves, huit disciplines notées, la scolarité et un dossier de
catégorisation entamé, puis écrit les bulletins dans `out/`.

### La rentrée

Le calendrier de l'établissement se saisit à l'écran : libellé de l'année,
bornes, et les **trois trimestres, dates réelles**. La validation porte les
deux règles du pays :

- Le troisième trimestre est **tronqué par la session d'examens**. Si les trois
  durées sortent égales à quelques jours près, l'écran le dit : c'est presque
  toujours quelqu'un qui a divisé l'année par trois, et les moyennes du T3
  porteront alors sur des évaluations qui n'ont pas eu lieu.
- Le calendrier est **amendable par région**. Une année close fin mai pour la
  Semaine nationale de la culture est acceptée sans réserve.

Les classes se créent au même endroit et prennent le nom qu'on leur donne
ici : `6e A` au post-primaire, `Tle D1` au secondaire. Une série ne s'attribue
qu'en seconde, première ou terminale.

### L'import de la liste des élèves

Un établissement possède déjà ses élèves, dans un classeur Excel. Personne ne
retapera quatre cents lignes : tant que cet écran n'existe pas, le logiciel ne
peut pas être essayé du tout.

Ce qui est traité, parce que c'est ce qui casse un import en vrai :

- **L'encodage.** Excel francophone sous Windows exporte en Windows-1252 avec
  des points-virgules. Lu en UTF-8, « Alizèta » devient « AlizÃ¨ta » — et
  l'erreur se retrouve ensuite sur chaque bulletin de l'année. Le fichier est
  décodé sur ses octets, jamais converti en chaîne avant découpage.
- **Les intitulés.** `Nom`, `NOM`, `Nom de famille`, `Prénom(s)`, `Né(e) le`,
  `Tél. tuteur` — reconnus tels qu'ils sont écrits. Une colonne unique
  `Nom et prénoms` convient : le nom de famille en capitales est reconnu.
- **Les dates.** `12/03/2014` est le 12 mars. Jamais le 3 décembre.
- **Les numéros.** `70 12 34 56`, `+226 70123456`, `00226-70-12-34-56` sont le
  même numéro, ramené à huit chiffres. Un numéro illisible ne crée pas de
  tuteur : mieux vaut pas de numéro qu'un mauvais numéro.

Et trois règles de conduite :

1. **Rien n'est écrit avant d'avoir été montré.** L'aperçu affiche chaque ligne
   telle qu'elle sera enregistrée. L'import n'a lieu qu'après confirmation.
2. **Une ligne douteuse se corrige dans l'aperçu**, pas dans Excel. Renvoyer le
   secrétaire à son fichier pour une date mal écrite, c'est perdre la matinée.
3. **Un élève déjà connu est réinscrit, jamais dupliqué.** À la rentrée, la
   liste contient les élèves de l'an dernier. Deux fiches pour le même enfant,
   et le bulletin de juin est faux. Quand la ligne n'a pas de date de naissance
   et que deux élèves portent ce nom, la ligne est **bloquée** plutôt que
   rattachée au hasard : rattacher un enfant à la fiche d'un homonyme est pire
   qu'un import incomplet.

### Le dossier de catégorisation

L'arrêté n°2026-101 conditionne le plafond légal des frais au score de
l'établissement sur 100 points. C'est le document le plus rentable de l'année
d'une école — et celui qu'on monte dans l'urgence à partir de bouts de papier.

L'écran tient les critères, leurs points, la pièce justificative de chacun, le
total par axe et ce qui manque encore. Un critère qui porte des points sans
pièce est signalé : c'est ce qu'une inspection retire en premier.

Ce que l'écran **refuse de faire** : déduire la catégorie et le plafond. Les
seuils et les tables de plafond par cycle n'ont pas pu être obtenus. Les
inventer produirait un écran d'apparence sérieuse conduisant un établissement à
facturer un montant illégal — l'erreur la plus chère que ce logiciel pourrait
commettre. L'établissement saisit donc les critères de son exemplaire de
l'arrêté, le logiciel additionne, et un humain lit la catégorie dans le texte.

### L'espace des familles

`/famille` — l'idée d'origine du projet. Un parent entre le numéro qu'il a
donné à l'établissement, reçoit un code, et voit les notes, les absences et la
scolarité de ses enfants. Une seule page, **sans JavaScript**, sous 60 Ko :
c'est un téléphone bon marché sur un réseau médiocre.

Trois décisions structurent cet écran :

- **Un tuteur n'est pas un membre du personnel, et n'en devient pas un.**
  Table de sessions séparée, cookie séparé limité à `/famille`, quatre
  fonctions d'authentification distinctes. Il n'existe aucun chemin de code qui
  transforme une session de famille en session du personnel — le test le
  vérifie dans les deux sens.
- **Le périmètre est l'enfant, pas l'établissement.** Ce qui s'affiche vient de
  `student_guardians`. Le test d'isolation vérifie qu'une session de famille
  d'un établissement est invisible depuis un autre : c'est la table dont une
  fuite serait la plus grave.
- **Un numéro inconnu reçoit exactement la même page qu'un numéro connu.**
  Répondre différemment ferait de cette page l'annuaire des familles de
  l'établissement.

Les chiffres affichés viennent du moteur de bulletin, sur la classe entière —
la famille lit exactement les nombres du bulletin, rang compris. Et une moyenne
calculée avec des règles encore non confirmées est annoncée comme indicative.

### Le conseil de classe

L'écran propose, le conseil dispose — et la distinction n'est pas décorative :
la composition du conseil et ses seuils de compensation n'ont pas pu être
établis depuis un texte burkinabè public. Le logiciel avance une proposition
**motivée**, et enregistre la décision que des humains ont prise.

Une règle est appliquée sans discussion, parce qu'elle est écrite : le
**redoublement est interdit en CP1, CE1 et CM1**. Dans ces classes l'option
n'est pas offerte, et un redoublement forcé par une requête directe est refusé
avec son motif — pas corrigé en silence. La mesure étant contestée par le
SYNAPEC, elle vit dans `promotion_rules` avec sa date d'effet.

Chaque décision alimente le **livret scolaire**, dossier cumulatif qui suit
l'élève d'un établissement à l'autre. Revenir sur une délibération corrige la
ligne ; elle n'est jamais dupliquée.

Deux garde-fous d'affichage : la moyenne annuelle est présentée comme une
moyenne simple dont la pondération n'est pas vérifiée, et une année dont tous
les trimestres ne portent pas de notes est signalée avant toute décision.

### La saisie hors ligne

C'est le point où un logiciel scolaire se perd au Burkina : l'enseignant
saisit quarante notes, le réseau tombe, tout est perdu. Ici :

1. La note est écrite dans **IndexedDB avant** toute tentative d'envoi. Si le
   réseau tombe entre les deux, rien n'est perdu — et la file survit à la
   fermeture de l'onglet.
2. Chaque saisie porte un `mutation_id` généré par l'appareil. Le rejeu de la
   même saisie répond `deja_applique` : renvoyer la file entière ne fait
   jamais de mal.
3. **Rien n'est écrasé en silence.** Si le serveur a bougé depuis la copie
   qu'avait l'appareil et que la valeur diffère, la saisie est marquée
   `conflit`, la valeur du serveur est conservée, et le censeur voit les deux
   côte à côte dans `/conflits` pour trancher. Une note qui disparaît sans
   trace détruit la confiance d'un établissement en une semaine.
4. Sans JavaScript, le formulaire se poste normalement. Le hors-ligne est une
   amélioration, jamais une dépendance.

### Ce qui n'existe pas encore

Orange Money et Moov Money, bloqués sur le RCCM. Les seuils de catégorisation
et les plafonds de frais par cycle, faute d'avoir pu obtenir les tables de
l'arrêté. Les retours statutaires au ministère, faute de leurs formulaires.

Volontairement : le reste attend un vrai bulletin burkinabè.

---

## Démarrer

```bash
createdb fasoschool
createuser fasoschool_app --pwprompt        # PAS superutilisateur
export DATABASE_URL=postgres://fasoschool_app:...@localhost:5432/fasoschool

npm install
npm run db:migrate
npm run db:test:rls        # doit passer avant tout développement
npm run demo               # établissement de démonstration + bulletins
npm start                  # http://localhost:4180
```

Comptes de démonstration — le code s'affiche à l'écran, aucun SMS n'est envoyé :

| numéro | fonction |
|---|---|
| `70000001` | Censeur |
| `70000002` | Enseignante |
| `70000003` | Surveillant général |
| `70000004` | Économe |
| `70000005` | Directeur |

Vérifications : `npm run check:all` — typecheck strict, 50 tests unitaires,
et trois parcours dans un vrai navigateur :

| suite | ce qu'elle prouve |
|---|---|
| `test:rentree` (19) | un établissement ouvre son année, pose ses trimestres et crée ses classes sans intervention en base |
| `test:e2e` (43) | connexion, notes, bulletins, appel et SMS, encaissement, droits |
| `test:offline` (18) | le réseau est réellement coupé, l'onglet fermé puis rouvert ; rien n'est perdu, rien n'est écrasé |
| `test:categorisation` (20) | le dossier se saisit, les points hors barème sont refusés, et l'écran ne devine ni la catégorie ni le plafond |
| `test:famille` (22) | un parent voit ses enfants et personne d'autre ; les deux sessions ne communiquent pas ; la page tient sous 60 Ko sans JavaScript |
| `test:conseil` (19) | la proposition est motivée, la décision humaine prime, un redoublement interdit est refusé et le livret n'est pas dupliqué |
| `test:import` (30) | un vrai fichier Windows-1252 est importé, corrigé dans l'aperçu, puis réimporté sans créer de doublon |

---

## Les cinq règles à confirmer

Ces règles n'ont pas pu être établies depuis une source burkinabè publique.
Elles sont livrées comme **données**, avec leur provenance dans `source_note`,
et il faut les faire confirmer par un censeur avant tout usage réel.

| règle | valeur par défaut | provenance |
|---|---|---|
| pondération devoirs / composition | `(devoirs + compo × 2) / 3` | convention régionale, aucun texte burkinabè trouvé |
| table des coefficients | maths 3, français 3, autres 2 | réforme des **examens** 2026 ; usage sur bulletin interne non vérifié |
| seuils de mention | 10 / 12 / 14 / 16 | toutes les sources trouvées étaient françaises, sénégalaises, marocaines ou ivoiriennes |
| gabarit du bulletin | générique | aucun modèle officiel MENAPLN publié, aucun bulletin scanné trouvé |
| pondération des trimestres | moyenne simple des trois | le T3 est plus court ; aucune règle nationale trouvée |

Une matinée avec un censeur coopératif et une photocopieuse ferme les cinq.

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
