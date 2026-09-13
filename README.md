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
- `db/migrations/0004_message_suivi.sql` — l'issue d'un message non remis :
  renvoyé, famille appelée, ou abandon assumé.
- `db/migrations/0005_personnel.sql` — `auth_resolve` vérifie enfin
  `is_active`, et `chefs_en_exercice()` empêche d'écarter le dernier chef.
- `db/migrations/0006_annulation_paiement.sql` — la contrepassation d'un
  paiement, et `montant_regle()` : la seule définition du net encaissé.
- `db/migrations/0007_discipline.sql` — le vocabulaire des sanctions, et le
  retrait d'un incident sans effacement.
- `db/migrations/0008_justifications.sql` — justifier une absence, et la règle
  « une absence non justifiée compte zéro » sortie du code.
- `db/migrations/0009_auth_sessions_rls.sql` — le row-level security qui
  manquait sur les sessions du personnel.
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
- `src/server/attention.ts` — ce qui demande une action, en haut du tableau de
  bord, et rien d'autre.
- `src/server/services.ts` — répartition des services : qui enseigne quoi, à
  quelle classe, et ce que cela autorise.
- `src/server/cloture.ts` — publication des bulletins et clôture du trimestre :
  un document remis ne change pas tout seul.
- `src/server/frais.ts` — grille des frais et émission des factures, avec les
  deux garde-fous de l'arrêté.
- `src/server/communiques.ts` — SMS aux familles, coût annoncé avant l'envoi.
- `src/server/transferts.ts` — transferts, livret scolaire cumulatif et
  certificat de transfert imprimable.
- `src/server/bourses.ts` — bourses et remises, nominatives et cumulées
  correctement.
- `src/server/evaluations.ts` — création des évaluations : devoirs et
  interrogations par l'enseignant, compositions par le censeur seul.
- `src/server/messages.ts` — suivi des messages non remis : ce que les familles
  n'ont pas reçu, et ce qu'on en a fait.
- `src/server/personnel.ts` — les comptes du personnel : créer, changer de
  fonction, écarter sans effacer.
- `src/server/eleve.ts` — la fiche de l'élève : chercher, corriger l'identité,
  tenir les tuteurs et leurs numéros.
- `src/server/discipline.ts` — le registre de discipline du surveillant
  général, et la limite du pouvoir de sanctionner.
- `src/server/justifications.ts` — justifier une absence, de la journée ou
  d'une évaluation, avec son motif écrit.
- `src/lib/roster.ts` — lecture d'un fichier de liste (encodage, séparateur,
  intitulés, dates, numéros). 22 tests.
- `src/server/multipart.ts` — envoi de fichier, écrit à la main pour ne pas
  ajouter de dépendance.
- `src/server/sync.ts` — réception des saisies hors ligne, détection des
  divergences, écran d'arbitrage du censeur.
- `public/offline.js` — file d'attente des notes dans IndexedDB.
- `public/sw.js` — cache de l'écran de saisie.

**Exploitation**
- `scripts/preparer-base.sh` — préparer la base d'un serveur, et refuser de la
  déclarer prête tant que le cloisonnement n'est pas vérifié.
- `scripts/epreuve-cloisonnement.sh` — l'épreuve d'isolation, sur une base
  jetable qu'elle fabrique et supprime.
- `scripts/installer.ts` — installer un établissement et son premier compte.
- `scripts/sauvegarde.sh` — sauvegarde chiffrée, jamais écrite en clair.
- `scripts/restauration-verifiee.sh` — l'épreuve de restauration.

**Démonstration** — `npm run demo` crée un établissement, une 6<sup>e</sup> de
douze élèves, huit disciplines notées, la scolarité et un dossier de
catégorisation entamé, puis écrit les bulletins dans `out/`.

### Les cookies de session

Défaut trouvé le lendemain d'avoir construit l'envoi du lien aux familles :
**ni l'un ni l'autre des deux cookies de session ne portait `Secure`.**

`fs_session` ouvre l'application du personnel. `fs_famille` ouvre le dossier
d'un enfant — notes, absences, discipline, numéros de la famille. Sans
`Secure`, ces jetons partent en clair dès qu'une requête passe en http : une
adresse tapée sans « s », un lien mal formé, le portail captif d'un cybercafé.
Et le logiciel venait précisément de se mettre à **envoyer cette adresse par
SMS** à des parents qui l'ouvriront sur un téléphone, sur un réseau partagé.
Construire la fonctionnalité a rendu le défaut urgent avant qu'il ne soit
trouvé.

`Secure` est posé dès que la connexion est en https — directement, derrière un
reverse proxy qui l'annonce par `x-forwarded-proto`, ou parce que l'adresse
publique déclarée est en https. Il n'est **pas** posé en dur : cela
interdirait toute connexion en développement local, où l'on sert en http sur
127.0.0.1, et un développeur qui ne peut plus se connecter finit par retirer la
ligne.

Et prévenir les familles est désormais **refusé tant que l'adresse publique est
en http**. On ne demande pas à un parent d'ouvrir le dossier de son enfant en
clair sur le réseau. `localhost` reste accepté : c'est du développement, pas
une famille.

### L'épreuve de cloisonnement

Le cloisonnement multi-locataire est la promesse la plus lourde du produit :
une fuite, c'est le dossier d'un enfant dans les mains d'une autre école. Le
dépôt avait un test d'isolation depuis le premier jour. Deux choses n'allaient
pas, et une troisième s'est révélée en les corrigeant.

**On ne pouvait pas le lancer.** Le fichier SQL commençait par
`drop role if exists fasoschool_app` — le compte de l'application. Sur une
machine où le produit est installé, ce rôle porte des droits et PostgreSQL
refuse de le supprimer : la commande prescrite « avant tout développement »
échouait précisément là où elle aurait servi.

**Et s'il avait réussi, c'eût été pire.** Il aurait supprimé le compte de
l'application en service pour le recréer avec le mot de passe `test`. Le test
de sûreté du dépôt en était le geste le plus dangereux.

`epreuve-cloisonnement.sh` fabrique sa propre base, y applique les migrations,
fait passer l'épreuve avec un rôle jetable au nom sans ambiguïté, puis supprime
tout. Il ne touche à aucune base réelle et n'a besoin d'aucun rôle existant.

**L'épreuve avait aussi un angle mort** : elle regardait les sessions des
familles et pas celles du personnel — la table qui, précisément, n'avait aucune
politique. Une assertion n'existe que pour ce qu'on a pensé à regarder. Elle
vérifie désormais les deux.

Et parce qu'un test de sûreté qui n'échoue jamais ne prouve rien,
`test:cloisonnement` rejoue l'épreuve sur un schéma auquel il manque exactement
la migration 0009 et **exige qu'elle échoue**, en nommant la fuite.

### Le barème d'une évaluation

`evaluations.bareme` existait depuis le premier schéma. **Rien ne l'écrivait,
rien ne le lisait.** Trois conséquences, toutes silencieuses :

- une interrogation sur 10 était impossible à créer — et si elle l'avait été,
  le moteur aurait pris 8/10 pour 8/20, **divisant la note par deux** ;
- la saisie était bornée à 20 en dur, dans **trois fichiers différents** : le
  serveur, le validateur de synchronisation, et le script hors ligne ;
- et une valeur hors barème était rejetée **en silence**, dans les trois. Le
  commentaire du code le disait lui-même : « saisie rejetée en silence ». Une
  case qui s'efface sans un mot fait croire à l'enseignant qu'il a mal cliqué —
  ou pire, il ne s'en aperçoit pas et la note manque au bulletin. Hors ligne,
  le bandeau annonçait même « synchronisée » pendant que la valeur s'était
  volatilisée.

Une évaluation porte désormais son barème (entre 5 et 100, 20 par défaut). La
note est **stockée telle que l'enseignant l'a saisie** — son 10 sur 10 reste un
10 — et ramenée sur le barème de la règle de notation au moment du calcul, à un
seul endroit. La colonne annonce son barème quand il n'est pas 20, et la case le
porte pour que le navigateur valide exactement ce que le serveur valide.

**Plus aucun rejet muet.** Le serveur nomme l'élève et la valeur tapée ; le
chemin hors ligne marque la case en rouge et l'explique sans même aller au
serveur ; la synchronisation refuse avec son motif. La suite éprouve les trois
chemins et vérifie qu'un 10/10 compte bien 20/20 dans la moyenne.

Défaut trouvé en chemin : un `trimestre` vide dans un POST fabriqué remontait
une erreur PostgreSQL brute jusqu'à l'écran. Les identifiants sont maintenant
contrôlés avant d'atteindre la base.

### Dire aux familles que leur espace existe

L'espace des familles était construit, testé, et **muet** : rien, dans le
logiciel, n'avait jamais dit à une famille qu'il existait. Un parent aurait dû
l'apprendre de bouche à oreille puis taper une adresse sur un téléphone bon
marché. Autant dire que la fonction était morte.

Une fois les bulletins d'une classe publiés, le censeur peut prévenir les
familles d'un geste : un SMS par famille, **dédoublonné par numéro**, portant
l'adresse de l'espace. Le message ne nomme pas l'enfant, à dessein — un parent
de trois élèves reçoit un message, et le nommer obligerait à en envoyer trois
ou à mentir.

Deux refus, pour les mêmes raisons qu'ailleurs :

- **sans adresse publique configurée** (`FASOSCHOOL_PUBLIC_URL`), on n'envoie
  rien. Un SMS payé qui renvoie vers une adresse inexistante coûte de l'argent
  et de la crédibilité ;
- **crédit insuffisant : rien ne part.** La moitié des familles prévenue et
  l'autre qui attend est pire que le silence — c'est la règle déjà tenue par
  les communiqués.

Le bouton n'apparaît qu'une fois les bulletins figés : on n'annonce pas un
document qui n'existe pas.

### Justifier une absence

`is_justified` existait sur `attendance_records` **et** sur `grade_entries`
depuis le premier schéma. Aucune ligne de l'application ne l'avait jamais mise
à `true` — seul le jeu de démonstration en semait quelques-unes, ce qui rendait
le défaut invisible en démonstration et certain en production. Pourtant :

- le bulletin imprime « Absences justifiées » et « Absences non justifiées ».
  Dans une vraie école la première ligne valait zéro pour tout le monde, et la
  seconde portait toutes les absences — y compris celles pour lesquelles la
  famille avait apporté un certificat. C'est une **accusation imprimée sur un
  document officiel remis aux parents** ;
- l'espace des familles et le conseil de classe affichaient le même compte,
  toujours faux ;
- et surtout, le moteur de calcul compte **zéro** une absence non justifiée à
  une évaluation. Un élève malade le jour de la composition — coefficient 2 —
  voyait sa moyenne effondrée par un zéro que rien, dans le logiciel, ne
  pouvait lever. Avec certificat médical ou sans.

C'est le défaut le plus lourd trouvé jusqu'ici : il change des notes sur un
bulletin.

**La règle n'est plus un `if`.** `unjustifiedAbsenceCountsAsZero` était écrite
`true` en dur dans `repository.ts`, en contradiction avec le principe tenu
partout ailleurs. Elle vit maintenant dans `grading_policies`, avec sa date
d'effet, corrigeable par le censeur — et marquée non vérifiée comme les cinq
autres. La suite renverse la règle et mesure que la moyenne du bulletin change :
c'est la preuve qu'elle n'est plus dans le code.

**L'écran dit l'effet avant de faire cliquer.** Il affiche, en toutes lettres,
ce que justifier changera compte tenu de la règle en vigueur — on ne fait pas
signer un geste dont on cache la portée. Un motif écrit est exigé dans les deux
sens : « certificat médical du 12/11 » se vérifie trois mois plus tard,
« justifié » ne se vérifie pas, et retirer une justification rétablit une
absence non justifiée au dossier d'un élève.

La suite ne se contente pas de vérifier une case cochée : elle lit la **moyenne
affichée sur l'écran des bulletins** avant et après, et vérifie qu'elle a monté.

### Le registre de discipline

`behavior_incidents` dormait dans le schéma depuis le premier jour. Le
surveillant général — celui qui, dans un établissement burkinabè, tient le
cahier de discipline et convoque les parents — n'avait dans ce logiciel que
l'appel du matin.

**L'exclusion définitive n'appartient pas au surveillant.** Elle relève du
conseil de discipline, présidé par le chef d'établissement. Un logiciel qui la
met dans la même liste déroulante que « avertissement » déplace un pouvoir
réel d'une personne à une autre, en silence. Elle est refusée sur le chemin
d'écriture, pas seulement absente de la liste — la suite le force en postant à
la main.

**Une étiquette n'est pas un fait.** « Indiscipline » n'est opposable à
personne : ni au conseil de classe qui lira le registre, ni à l'élève à qui on
l'oppose. L'écran demande une phrase — ce qui s'est passé, où, quand — sans
pour autant exiger une rédaction : un surveillant écrit vite, entre deux cours,
et un contrôle trop dur ferait écrire n'importe quoi pour le franchir.

**On n'efface pas un incident, on le retire en le disant.** Une trace écrite
sur un enfant pèse sur une décision de passage. Elle doit pouvoir être réparée
— on se trompe d'élève, on écrit sous le coup de la colère — mais rien ne doit
disparaître en silence : effacer détruit aussi ce qui pouvait servir *en
faveur* de l'élève, et un registre qu'on peut vider ne prouve plus rien à
personne. Un fait retiré reste écrit, barré, avec le nom de qui l'a retiré et
son motif.

**La famille est prévenue par le même tuyau que les absences**, donc avec le
même suivi : si l'opérateur refuse, cela remonte dans les messages à traiter au
lieu de disparaître. Une exclusion temporaire que les parents découvrent le
soir, c'est un enfant dehors trois jours sans que personne le sache.

Une sanction n'est pas obligatoire : beaucoup de faits se consignent sans être
punis, et c'est précisément ce registre qui permet de dire, au conseil, qu'un
élève a été signalé quatre fois sans qu'on ait jamais rien fait.

### Installer un établissement

```bash
npm run installer -- --nom "Lycée Municipal de Koudougou" \
                     --secteur public --zone chef_lieu \
                     --commune Koudougou --region Centre-Ouest \
                     --chef "SAWADOGO Rasmane" --telephone 76900011 \
                     --fonction proviseur
```

C'est le seul geste qui ne peut **pas** se faire depuis l'application : il faut
être connecté pour ouvrir un écran, et il n'existe encore aucun compte à
connecter. Un écran public qui créerait des établissements serait par
construction ouvert à tout le monde. C'est aussi, honnêtement, une opération
d'éditeur et non d'école — une fois, avec le contrat sous les yeux.

L'établissement et son premier compte se créent **ensemble ou pas du tout**,
dans une seule transaction : un établissement sans compte est inaccessible pour
toujours, puisque personne ne peut s'y connecter et donc personne ne peut y
créer le premier compte. Le premier compte est forcément un chef
d'établissement, parce que c'est lui qui crée tous les autres. Un numéro déjà
pris est refusé en nommant son titulaire : `auth_lookup_user` s'arrête au
premier trouvé, et le second ne se connecterait jamais.

Tout le reste — année scolaire, classes, personnel, services, élèves, frais —
se fait ensuite depuis l'application, par l'établissement lui-même, sans qu'on
touche à sa base. L'installateur le rappelle en sortie, y compris que les
règles de notation restent **à confirmer** : tant qu'elles ne le sont pas,
toutes les moyennes calculées sont indicatives.

La suite `test:installer` installe un vrai second établissement dans la même
base et vérifie que le cloisonnement tient entre deux écoles réelles : la
nouvelle ne voit pas un élève, pas une note, pas un franc de l'autre.

### L'annulation d'un paiement

Un économe encaisse debout, devant une file de parents, en fin de mois. Il tape
50 000 au lieu de 5 000. Jusqu'ici rien ne pouvait le rattraper : le reçu était
émis, la facture soldée, et le seul recours était psql. C'est le genre d'erreur
qui arrive le premier jour.

**On n'efface pas un reçu, et on n'en diminue pas le montant.** Un reçu est un
document remis à une famille, et sa numérotation est une suite sans trou — c'est
ce qui la rend vérifiable ; un numéro sauté est la première chose qu'un contrôle
cherche. Une annulation est donc un **second reçu, de contrepartie** : même
montant, propre numéro dans la même suite, motif obligatoire. Les deux documents
circulent, et chacun se déclare — l'ancien porte « CE REÇU EST ANNULÉ » et le nom
de celui qui l'annule ; le nouveau porte « ANNULATION », le reçu visé, le motif,
et son montant en négatif.

Le motif est exigé parce qu'une annulation sans raison est exactement ce que
produirait un caissier malhonnête, et c'est la seule chose qu'un contrôle pourra
lire ensuite. On n'annule pas deux fois un même paiement — la facture
deviendrait créditrice — et on n'annule pas une annulation.

**Une seule définition du solde.** Sept requêtes calculaient chacune à sa façon
« ce qui a été payé sur cette facture ». C'est ainsi qu'elles finissent par ne
plus dire la même chose, et qu'un parent lit deux soldes différents sur deux
écrans du même logiciel. La somme est désormais écrite une fois, en base
(`montant_regle()`), et appelée par le guichet, la liste des factures, le
tableau de bord, la fiche de l'élève, l'espace des familles et le ciblage des
communiqués.

Un défaut trouvé en écrivant la suite : un refus d'annulation levé **avant**
d'avoir retrouvé la facture ne pouvait pas se réafficher, et l'économe lisait
« facture introuvable » à la place de la raison du refus. Le contrôle du motif
se fait maintenant après.

### La fiche de l'élève

Elle manquait, et son absence rendait fausse une phrase écrite ailleurs : le
suivi des messages annonce qu'un numéro erroné « se répare dans la fiche de
l'élève, au secrétariat ». Cette fiche n'existait pas — on ne pouvait ni
chercher un élève, ni voir ses tuteurs, ni corriger un chiffre.

**On cherche par le numéro autant que par le nom.** Quand un SMS revient en
échec, on tient un numéro et rien d'autre ; une recherche qui n'accepte que le
nom oblige à deviner de quel élève il s'agit. Le registre des messages mène
directement à la fiche : c'est la seule chose que cet écran-là ne peut pas
faire lui-même.

Trois choses que l'écran dit à voix haute, parce qu'elles ne se devinent pas :

- **Un tuteur est partagé entre ses enfants.** Corriger son numéro le corrige
  pour toute la fratrie. C'est juste, et c'est exactement ce qu'une secrétaire
  ne devine pas — la fiche l'annonce avant, pas après. Rattacher un numéro
  déjà connu rattache le tuteur existant au lieu de le recréer : une mère de
  trois élèves doit recevoir un communiqué, pas trois. Détacher un tuteur ne
  l'efface pas ; ses autres enfants le gardent, et ses messages passés le
  référencent.
- **Retirer le dernier numéro n'est pas interdit, il est annoncé.** Un élève
  peut réellement n'avoir aucun téléphone joignable ; le logiciel n'invente pas
  une contrainte que la vie n'a pas. Mais il dit que cette famille ne recevra
  plus rien, et le tableau de bord le rappelle.
- **Corriger un nom change une réimpression, pas l'exemplaire déjà remis.** Le
  matricule, lui, ne se corrige pas ici : il figure sur des documents délivrés
  et dans les états transmis, et le changer d'un clic ferait deux identités
  pour un enfant.

**Voir n'est pas corriger.** La fiche porte les numéros d'une famille : le
surveillant général la lit — il doit pouvoir appeler — mais seul le
secrétariat y écrit, et un enseignant n'y accède pas du tout. Quand il faut
joindre des parents, cela passe par la vie scolaire, qui en répond.

### Le personnel

C'est le premier geste d'une installation — avant l'année scolaire, avant les
classes, avant les élèves — et il n'existait pas. Une seule ligne du projet
créait un compte : `scripts/demo.ts`. Un établissement qui installait
FasoSchool ne pouvait inscrire ni son proviseur, ni son censeur, ni un seul de
ses enseignants sans ouvrir psql.

Un compte se crée avec un nom, un numéro à huit chiffres et une fonction. Le
numéro **est** l'identifiant : il n'y a pas de mot de passe, un code à usage
unique arrive par SMS. Deux comptes ne peuvent pas le partager — sinon l'un
des deux ne se connecterait jamais et personne ne comprendrait pourquoi.

**On n'efface personne.** Un membre du personnel porte des notes, des reçus,
des décisions de conseil ; le supprimer arracherait la signature au bas d'un
bulletin déjà remis. On l'écarte : son compte ne s'ouvre plus, et ce qu'il a
signé reste signé.

Deux verrous, tous deux posés parce que l'erreur qu'ils empêchent ne se
rattrape pas :

- **Le dernier chef d'établissement ne peut être ni écarté ni rétrogradé.**
  Sans lui, plus personne ne gère le personnel et il n'existe aucune console
  d'administration pour rattraper l'erreur : l'établissement serait fermé à
  clé. La règle est en base autant que dans l'écran, parce qu'un écran se
  contourne avec un formulaire fabriqué à la main.
- **Écarter quelqu'un ferme ses sessions ouvertes.** `auth_resolve` ne
  vérifiait pas `is_active` : désactiver un compte interdisait de *se
  reconnecter*, mais chaque session déjà ouverte vivait jusqu'à son
  expiration. Un établissement qui écarte une secrétaire soupçonnée d'avoir
  touché aux reçus lisait « désactivé » à l'écran pendant qu'elle continuait
  de travailler depuis son téléphone. Les sessions sont désormais révoquées,
  et le contrôle en base ferme la course entre les deux gestes.

### Les messages non remis

La deuxième des trois promesses du logiciel est : *la famille est prévenue le
jour même de l'absence*. Elle n'était vraie qu'à moitié. Un SMS refusé par
l'opérateur — numéro erroné, ligne résiliée — était écrit en base avec le
statut `echoue`, et **rien ne lisait jamais ce statut** : ni un écran, ni une
requête, ni un point d'attention. L'établissement croyait avoir prévenu. La
famille n'avait rien reçu. L'enfant passait la journée dehors.

Un échec n'est pas une ligne de journal : c'est une **tâche**. Quelqu'un doit
appeler la famille, corriger le numéro, ou renoncer en le sachant. Tant que
personne ne l'a fait, l'échec remonte au tableau de bord ; il ne s'efface pas
avec le temps.

Trois choses tiennent cet écran :

- **Un renvoi n'écrase pas la tentative ratée.** Le registre est append-only,
  comme les reçus. Une école qui doit prouver qu'elle a prévenu doit pouvoir
  montrer ce qu'elle a *essayé*, pas seulement ce qui a fini par marcher. Un
  renvoi qui échoue à son tour reparaît dans la liste — le problème ne
  disparaît pas parce qu'on a cliqué dessus.
- **« Famille appelée » est une issue de plein droit.** Quand le SMS ne passe
  pas, on téléphone. Sans cette case, la vie scolaire tiendrait son vrai
  registre sur un cahier et l'écran mentirait. Le logiciel la croit sur parole,
  le dit, et enregistre qui l'a déclarée.
- **Un message parti ne se « traite » pas.** Cocher « appelée » sur un SMS
  reçu ferait d'une case une preuve d'un appel qui n'a jamais eu lieu. Le
  refus est sur le chemin d'écriture, pas dans l'affichage : la suite le force
  en postant à la main.

Un défaut du même ordre a été corrigé dans les communiqués : la réponse de
l'opérateur y était ignorée et **toutes** les lignes étaient écrites
« envoyé ». Un communiqué à trois cents familles entièrement refusé était
enregistré comme trois cents envois, et trois cents messages débités du crédit.
Le statut vient désormais de l'opérateur, et seul ce qui part est débité.

### Les évaluations

Une note ne flotte pas : elle appartient à une évaluation datée, d'un type et
d'un barème donnés. Jusqu'ici les évaluations n'existaient que dans le jeu de
démonstration — un enseignant ne pouvait pas déclarer « j'ai donné un devoir
surveillé le 12 novembre », et tous les écrans de saisie en dépendaient. Il
peut désormais en ouvrir une depuis l'écran des notes, pour sa classe et sa
matière, et pour le trimestre en cours seulement.

**La composition n'appartient pas à l'enseignant.** C'est la différence
burkinabè à laquelle un logiciel importé ne pense pas : le sujet de composition
est *harmonisé*, arrêté au niveau du district, et passé le même jour dans
toutes les classes d'un niveau. L'écran le traduit littéralement — seul le
censeur ou le proviseur peut ouvrir une composition, et l'ouvrir la crée d'un
coup pour **toutes les classes du niveau**, pas seulement celle affichée. Un
enseignant qui essaie se voit refuser, avec la raison, pas un bouton grisé.

Une évaluation portant des notes ne se supprime pas : le logiciel dit combien
de notes elle porte et laisse l'enseignant les vider d'abord s'il le veut
vraiment. Après clôture du trimestre, plus rien ne s'ouvre ni ne se retire.

### Les transferts et le livret

Au Burkina Faso, un enfant change d'école pour des raisons qui n'ont rien de
scolaire : la famille déménage, l'école ferme, l'insécurité déplace un village
entier. L'enfant arrive dans un établissement qui ne sait rien de lui, souvent
sans un papier.

**Un enfant sans papiers s'inscrit quand même.** Refuser une inscription faute
de bulletin, c'est exactement le mécanisme qui met un enfant déplacé hors de
l'école pour de bon. Le logiciel accepte donc un parcours **déclaré par la
famille**, et le marque comme tel — une ligne déclarée et une ligne établie ici
ne se confondent jamais, parce que le censeur qui décide d'un placement doit
savoir sur quoi il s'appuie. Une année sans moyenne est acceptée : mieux vaut
une case vide qu'une moyenne inventée.

Dans l'autre sens, l'élève qui part emporte un **certificat de transfert**
imprimable portant son livret — années, niveaux, moyennes, décisions, et la
source de chaque ligne. C'est ce document qui permet à l'école suivante de le
placer correctement au lieu de le faire redoubler par défaut. Le certificat dit
lui-même qu'il ne préjuge pas de la décision d'accueil.

### Les communiqués aux familles

Le canal SMS servait déjà aux absences ; c'est le même tuyau, pour « réunion
des parents samedi 9 h » ou « reprise le 5 janvier ». Un directeur passe
aujourd'hui ces messages par les élèves eux-mêmes, et la moitié n'arrive
jamais.

Trois décisions font la valeur de cet écran, et toutes trois protègent la
trésorerie ou la parole de l'établissement :

- **Le coût est annoncé avant l'envoi.** Destinataires, segments, total, et ce
  qu'il restera de crédit. L'écran rappelle aussi qu'un accent fait tomber la
  limite de 160 à 70 caractères : écrire « Reunion » plutôt que « Réunion »
  divise la facture par deux, et c'est visible avant d'appuyer.
- **Un envoi partiel est pire que pas d'envoi.** Crédit insuffisant : l'envoi
  est refusé en bloc, plutôt que d'informer la moitié des familles et de
  laisser l'autre moitié se présenter le mauvais jour. Le brouillon n'est pas
  perdu pour autant.
- **Un tuteur de trois enfants reçoit un message**, pas trois. C'est de
  l'argent, et c'est aussi du respect.

### Les bourses et les remises

Un établissement privé burkinabè scolarise presque toujours des enfants qui ne
paient pas le plein tarif : orphelins, enfants du personnel, familles
déplacées, fratries, boursiers d'une association. Jusqu'ici rien ne
l'enregistrait — l'économe accordait la remise de tête, et personne ne savait
en fin d'année ce que l'établissement avait donné ni à qui.

- Une remise est **nominative, motivée et datée**. Le jour où un bailleur ou un
  conseil demande « combien, et pour qui », la réponse existe.
- **Deux remises de 50 % font 75 %, pas la gratuité.** Elles s'appliquent l'une
  après l'autre sur ce qui reste. C'est la faute qui coûte le plus cher, dans
  les deux sens : dix tests unitaires la surveillent.
- Le **total accordé est affiché en permanence**. Un établissement qui donne
  plus qu'il ne peut ferme ; celui qui n'ose plus rien donner trahit sa raison
  d'être. Les deux erreurs viennent de ne pas voir le total.
- Une facture déjà émise n'est **jamais rabotée en silence** : le décalage est
  signalé, et c'est un humain qui réémet.

### Les frais et les factures

L'encaissement existait ; rien ne permettait de créer ce qu'on encaisse. Un
établissement ne pouvait facturer personne — la grille et les factures ne
venaient que du script de démonstration.

Deux règles de l'arrêté n°2026-101 sont **appliquées**, pas seulement
documentées :

- Le plafond porte sur la somme des lignes marquées « comptées dans le
  plafond », comparée au plafond que l'établissement a lu dans le texte et
  inscrit à son dossier de catégorisation. Le dépassement est chiffré à
  l'écran. Le logiciel n'invente pas le plafond : il vient du dossier, saisi
  par un humain.
- Un **supplément autorisé exige la référence de l'autorisation
  ministérielle**. Sans elle, la ligne est refusée. C'est la différence entre
  un établissement en règle et un établissement qui apprend son irrégularité
  par une inspection.

Et une règle de prudence, la même que pour les bulletins : une facture émise
n'est jamais recalculée. Elle porte le montant du jour de son émission. Une
famille qui a payé 78 000 F ne doit pas découvrir qu'elle en doit 92 000 parce
qu'une ligne a bougé. Les échéances suivent les trimestres — au Burkina on ne
modélise pas un solde unique.

### La publication des bulletins

Un bulletin était jusqu'ici **recalculé à chaque affichage**. Un enseignant
corrigeait une note en février, et le bulletin de décembre déjà remis à la
famille n'était plus celui que le logiciel montrait. Personne ne mentait : les
deux documents disaient simplement des choses différentes, et c'est ainsi qu'un
établissement perd la confiance d'un parent.

Un bulletin remis est un **document**, pas une vue. Le publier fige la moyenne,
le rang, la mention et chaque ligne de discipline. C'est cette copie que la
famille lit dans son espace, et c'est elle qu'on réimprime en juin pour un
dossier de transfert.

Ce qui en découle :

- **Clôturer le trimestre** refuse toute nouvelle saisie, en ligne comme hors
  ligne. Une tablette restée trois semaines sans réseau voit ses notes refusées
  avec leur motif — et le bandeau de l'enseignant le dit, au lieu d'annoncer
  « synchronisée » une note que le serveur a écartée.
- **Rouvrir reste possible** : une vraie erreur doit pouvoir être corrigée.
  Mais c'est un acte, il est journalisé, et l'écran prévient que des bulletins
  circulent déjà.
- **Un écart n'est jamais corrigé en silence.** Si une note bouge après la
  remise, le censeur voit qui est concerné et les deux valeurs, puis décide de
  republier ou non. Le **rang** compte autant que la moyenne : corriger la note
  du premier reclasse toute la classe, et les autres bulletins portent alors un
  rang faux sans qu'une seule de leurs moyennes ait changé.

### La répartition des services

Jusqu'ici n'importe quel enseignant pouvait ouvrir n'importe quelle classe et
saisir des notes dans n'importe quelle discipline. Dans un établissement d'une
classe cela ne se voit pas ; dans un établissement de douze classes c'est
inacceptable.

Le périmètre est une **donnée**, pas un rôle : « enseignant » ne dit rien de ce
qu'on a le droit de toucher, `teacher_assignments` le dit. Le censeur, le
proviseur et le directeur ne sont pas filtrés — leur métier est de voir toute
la maison.

Et le filtre d'affichage n'est **jamais** la protection : la même règle est
appliquée à la lecture et à l'écriture. Le test envoie délibérément une note
sur l'évaluation d'un collègue, sans passer par le formulaire, et vérifie
qu'elle est refusée sans effacer la valeur en place.

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

### Ce que le conseil de classe voit désormais

Un conseil de classe burkinabè délibère sur **le travail, l'assiduité et la
conduite**. L'écran ne montrait que les moyennes : il faisait délibérer sur un
tiers du dossier. Chaque ligne porte maintenant les absences (dont les non
justifiées), les retards et les faits de discipline retenus — une exclusion est
signalée en rouge.

**Ces colonnes n'entrent dans aucun calcul, et c'est délibéré.** Aucun texte
burkinabè public ne fixe un nombre d'absences au-delà duquel un élève ne peut
plus passer ; l'inventer reviendrait à écrire une règle nationale dans un
logiciel privé, et à faire porter à un chiffre arbitraire une décision qui
change la vie d'un enfant. Au-delà de dix absences, ou après une exclusion, la
ligne est simplement mise en évidence : un repère de lecture, pas un seuil
réglementaire. La suite vérifie que la proposition est **exactement la même**
avec et sans incidents. Le jour où un texte ou un établissement fixe son seuil,
il deviendra une règle datée dans `promotion_rules`, comme les autres.

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

### Un élève arrivé en janvier était « en retard » depuis octobre

Trouvé en tirant le fil de la migration précédente. 0017 a donné un sens au mot
« en retard » : ce qui était exigible d'après l'échéancier, et qui n'a pas été
versé. Restait une question que personne ne posait — exigible **de qui**, et
depuis quand ?

`frais.ts` émet la facture de l'année entière et pose une tranche au début de
chaque trimestre. Pour un élève inscrit à la rentrée, c'est juste. Pour un enfant
arrivé en janvier — transfert, déménagement, une famille qui a mis trois mois à
réunir les frais — la tranche d'octobre est exigible **avant son arrivée**.
L'écran le compte « en retard », peint sa ligne en rouge, et le tableau de bord
réclame, pour des mois où l'enfant n'était pas là. Ce n'est pas un cas rare au
Burkina, et ce sont précisément les familles les plus fragiles.

**Et la date d'arrivée était fausse.** `enrolments.enrolled_on` existe depuis le
premier jour, avec `default current_date`. Aucune ligne de code ne l'écrivait ni
ne la lisait : c'est le jour de l'**import** qui s'y inscrivait. Une école qui
charge sa liste en novembre faisait de son effectif entier une cohorte d'arrivées
tardives — et depuis 0017, chacune serait annoncée en retard sur les tranches
d'octobre. Personne ne s'en apercevait, puisque rien ne lisait cette date.

Ce qui change :

* la date d'arrivée est **écrite**, et la règle tient en une ligne : un élève
  inscrit avant l'ouverture de l'année arrive **avec l'année** ; un élève inscrit
  alors qu'elle est commencée arrive aujourd'hui ;
* un départ pose enfin une **date** (`left_on`) et non plus le seul statut : on
  ne pouvait pas dire depuis quand une place était libre ;
* `echeances_avant_arrivee(facture)` compte les tranches tombées avant l'arrivée,
  et leur montant. Aucune ligne pour un élève présent dès la rentrée : le cas
  ordinaire n'appelle aucune mention ;
* l'écran de la scolarité et l'espace famille le **disent**, à côté du rouge.

**Et le logiciel ne tranche pas.** Savoir si un enfant arrivé en janvier doit les
tranches d'octobre, une seule, ou une somme négociée est une règle
d'établissement : au Burkina elle varie d'une école à l'autre, et aucun texte
consulté ne la fixe. Le retard n'est donc **pas** raboté — l'inventer reviendrait
à décider, dans un logiciel, ce qu'une famille doit, alors que la ligne rouge
décide déjà de qui on renvoie chez lui. La règle rejoint le tableau des règles à
confirmer, qui en compte désormais **sept**.

`tests/arrivee.e2e.mjs` : 16 assertions. Contrôle négatif fait — la mention
retirée, la ligne rouge parle de nouveau toute seule.

### Un reçu réimprimé disait autre chose que le papier de la famille

`receiptPage` fige bien le **montant reçu** — `receipts.amount_fcfa` — mais
calculait le cartouche de droite, « Total dû / Total payé / Reste », au moment
de l'impression :

```ts
montant_regle(i.id) as paye
const reste = Number(d.total_fcfa) - Number(d.paye);
```

Éprouvé, dans cet ordre :

1. une famille verse 10 000 F. Le reçu N°1 sort : « Total payé 10 000, Reste
   68 000 ». Elle le range dans un cahier, comme on fait ;
2. trois semaines plus tard elle verse le solde ;
3. l'économe réimprime **le même reçu N°1** — il affiche **« SCOLARITÉ
   SOLDÉE »**.

Deux papiers, un seul numéro, deux affirmations contradictoires sur ce qu'une
famille a payé. Et l'écart va dans les deux sens : qu'un paiement antérieur soit
annulé, et la réimpression montre un reste **plus grand** que celui que la
famille détient — le papier de la famille devient la pièce qui accuse l'école,
ou celle qui l'innocente, selon le jour où on l'imprime.

Le dépôt porte déjà cette règle pour les bulletins — « le bulletin remis ne
bouge pas », figé à la publication. Elle vaut pour tout ce qu'un papier affirme,
et un reçu est le document le plus opposable du produit.

Ce qui change :

* `receipts.total_du_fcfa` et `receipts.total_paye_fcfa`, écrits **une fois** à
  l'émission. Le reste s'en déduit et n'est donc pas stocké : un troisième
  nombre ne pourrait que contredire les deux autres ;
* le reçu de **contrepartie** d'une annulation porte l'état d'**après**
  l'annulation, et le reçu annulé garde le sien — un document annulé reste la
  preuve de ce qu'il affirmait ;
* un reçu **antérieur à la migration** ne restitue pas un solde inventé : il
  écrit « Solde non restituable », laisse le montant reçu faire foi, et renvoie
  à l'établissement. `montant_regle()` aujourd'hui ne dit pas ce que le papier
  disait à l'époque, et c'est exactement le défaut qu'on répare.

`tests/recu-fige.e2e.mjs` : 20 assertions. Contrôle négatif fait — le calcul
d'impression remis, le même reçu passe de « Reste 68 000 F » à « Reste 0 F ».

### « En retard » voulait dire « doit quelque chose »

Dans `finance.ts`, une ligne :

```ts
const enRetard = rows.filter((r) => r.rest > 0);
```

et, juste à côté, la tuile qui l'affiche : **« 9 familles en retard »**. Or
`rest` est le solde de l'**année entière**. Le jour où les factures sont émises,
avant qu'un seul franc ne soit exigible, cette ligne désignait donc **toutes**
les familles, et peignait leur ligne en rouge.

Mesuré sur le jeu de démonstration : neuf familles annoncées « en retard », dont
quatre ayant versé 40 000 F sur 78 000 — c'est-à-dire la première tranche et une
partie de la deuxième, **en avance** sur l'échéancier.

Ce n'est pas un mot mal choisi dans un coin d'écran. C'est le mot sur lequel un
établissement décide qui il renvoie à la maison.

**L'échéancier existait déjà, et personne ne le lisait.** `frais.ts` écrit
`invoice_instalments` à chaque émission : une tranche par trimestre, aux dates
saisies par l'école. C'est la norme au Burkina, et c'est la question quotidienne
de l'économe — « qui n'a pas payé la tranche d'octobre ? », jamais « qui doit
encore quelque chose ? », à quoi la réponse en mars est « tout le monde ». Cette
table n'était lue par **aucune** requête de l'application. Les suites de tests la
sauvegardaient et la restauraient ; une en sommait le total pour vérifier qu'une
bourse la rabote. Pas un écran ne la montrait.

Ce qui change :

* `montant_echu(facture, jour)` et `retard_de(facture, jour)` : ce qui était
  exigible, et ce qui l'était sans avoir été versé. Jamais négatif — une famille
  en avance n'est pas « en retard de moins que rien » ;
* **une facture sans échéancier renvoie `null`, pas zéro et pas le total.**
  Répondre « rien » rendrait toute famille éternellement à jour ; répondre
  « tout » les mettrait toutes en retard dès l'émission. L'écran affiche
  « échéancier absent » et explique comment en poser un — choisir à la place de
  l'école se verrait un jour sur la porte d'un élève ;
* la tuile « en retard » compte les retards réels et leur montant ; « reste à
  recouvrer » dit désormais qu'il porte sur l'année ; le rouge d'une ligne est
  réservé au retard, pas au solde ;
* **la famille voit ce qu'elle doit maintenant** — « À verser maintenant : 0 F,
  vous êtes à jour » puis « Tranche 2 : 26 000 F le 05/01 » — au lieu d'un
  « vous devez 78 000 F » qu'on ne verse pas d'un coup ;
* le tableau de bord compte les familles ayant **dépassé une échéance** ;
* le SMS de paiement dit ce qui reste **échu**, et le solde annuel ensuite.

**Et le même défaut de destinataire, un module plus loin.** La requête qui
choisit qui reçoit la confirmation de paiement prenait le tuteur principal
*même sans numéro*, masquant un second tuteur joignable — exactement ce qui
avait été trouvé sur l'appel du matin. Corrigé ici aussi, ainsi que la colonne
« tuteur » du tableau de la scolarité.

`tests/echeancier.e2e.mjs` : 26 assertions. Contrôle négatif fait — l'ancien
filtre remis, la tuile annonce de nouveau « 9 familles » au lieu d'une.

### Une variable d'environnement oubliée ouvrait le logiciel

Trouvé en éprouvant ce que l'écran du personnel promet : « un code à usage
unique arrive par SMS à chaque connexion ». La fabrique de canal se lisait :

```ts
return process.env.SMS_PROVIDER === "orange_bf"
  ? new OrangeBfSmsChannel() : new MockSmsChannel();
```

Toute valeur autre que la chaîne exacte `orange_bf` — variable absente, faute de
frappe, `orange`, `ORANGE_BF` — donnait l'adaptateur de **démonstration**, en
silence. Dans cet état :

* **aucun SMS ne part, jamais.** Ni absence, ni communiqué, ni bulletin. Mais
  `sms_messages` enregistre `envoye`, le registre de crédit débite de vrais
  francs, et l'appel du matin annonce « 2 SMS envoyés pour 16 F ». La deuxième
  des trois promesses du produit devient un décor ;
* **le code de connexion est renvoyé à la page, qui l'affiche.** Connaître le
  numéro d'un censeur suffisait à entrer dans le logiciel de son établissement.
  Sur la porte des familles, le code apparaissait sans même la mention « mode
  démonstration ».

Et sur le chemin réel, un troisième défaut : le résultat de l'envoi du code
était **ignoré**. Crédit épuisé, ligne résiliée, panne d'opérateur — la page
répondait « Code envoyé au 70 00 00 01 », rien n'arrivait, l'utilisateur
réessayait, et au bout de cinq essais la limitation de débit le mettait dehors
de son propre logiciel, sans un mot d'explication.

Ce qui change :

* **le serveur refuse de démarrer sans `SMS_PROVIDER` déclaré** — `orange_bf`
  ou `mock`, rien d'autre, et `orange_bf` sans ses identifiants est refusé lui
  aussi. C'est le même refus que `sauvegarde.sh` devant une phrase de passe
  manquante, et pour la même raison : le défaut ne se voit pas le jour de
  l'installation, il se voit six mois plus tard ;
* **le mode démonstration s'annonce partout** : bandeau sur la console, champ
  `simule` sur `/sante`, phrase sur les deux pages de connexion, et point
  **bloquant** sur le tableau de bord que le directeur ouvre chaque matin ;
* **le code n'est rendu que par l'adaptateur de démonstration** — plus par
  « tout ce qui n'est pas exactement `orange_bf` » ;
* **un envoi refusé n'est plus annoncé comme réussi** : la raison de l'opérateur
  est dite, le défi est annulé, et la limitation de débit n'est pas consommée —
  on ne punit pas un utilisateur d'une panne qui n'est pas la sienne.

**Au passage, `/sante` ne fonctionnait pas.** Il était placé **derrière** le mur
d'authentification : un appel non connecté était redirigé vers `/connexion`, et
`fetch` suivant la redirection, l'appelant recevait 200 et une page de
connexion. Une sonde, un répartiteur de charge ou un script d'exploitation
lisaient « en bonne santé » quel que soit l'état réel — base arrêtée comprise.
Les trente-six suites de ce dépôt attendaient ce point au démarrage ; elles
attendaient en fait la page de connexion. Il est désormais devant le mur, il
interroge vraiment la base, et il répond 503 quand elle ne répond pas.

`tests/canal.e2e.mjs` : 24 assertions, dont le refus de démarrer sur variable
absente, sur faute de frappe, et sur `orange_bf` incomplet.

### « Signalé quatre fois sans que rien n'ait été fait »

L'en-tête de `discipline.ts` porte cette phrase depuis le premier jour, et
l'écran la répète au directeur en sous-titre :

> Une description est obligatoire, une sanction ne l'est pas. Beaucoup de faits
> se consignent sans être punis, et c'est précisément ce registre qui permet de
> dire, **au conseil**, qu'un élève a été signalé quatre fois sans qu'on ait
> jamais rien fait.

Éprouvée, elle était fausse des deux côtés.

**Au conseil de classe**, la requête ne comptait que deux choses : le nombre de
faits, et le nombre d'exclusions. Deux élèves du jeu de démonstration, quatre
faits chacun — l'un jamais puni, l'autre convoqué quatre fois — affichaient
tous deux `4`, et rien d'autre. Le conseil décidait de leur passage sur ce
chiffre-là.

**Au registre**, cent vingt lignes chronologiques et aucun total par élève :
pour voir qu'un nom revient quatre fois, il fallait le compter à la main sur
une page entière.

**Et le sens est opposé.** « Quatre faits, quatre convocations » dit que
l'établissement a réagi et que la situation a persisté. « Quatre faits, aucune
suite » dit qu'il a été prévenu quatre fois et n'a rien fait : c'est une phrase
sur l'**école**, pas sur l'enfant. Le même `4` les confondait, au moment précis
où l'on décide de l'année de cet enfant.

Ce qui change :

* le conseil compte un troisième nombre — les faits restés **sans aucune
  suite** — et l'affiche : « aucune suite donnée », ou « dont *n* sans suite » ;
* la mention n'est **pas** en laterite, et le choix est délibéré : une pastille
  rouge ferait lire « quatre fautes impunies » là où il faut lire « l'école a
  été prévenue quatre fois ». Elle est en gris, du côté de l'établissement ;
* le registre ouvre sur **« Ce qui revient »** — un élève par ligne, ses faits,
  et ce qu'on en a fait : *toutes*, *aucune*, ou *n sur m*. Trié par ce qui est
  resté sans suite, parce que c'est là que l'établissement doit se prononcer ;
* un fait **retiré** ne compte dans aucun des deux — la règle du registre vaut
  ici aussi : il reste écrit et barré, mais il ne pèse plus.

Le seuil de récurrence est deux, et c'est un repère de lecture : rien ne s'y
déclenche, aucune sanction ne s'y attache, il décide seulement de ce qui remonte
en haut de l'écran. `tests/recurrence.e2e.mjs` : 18 assertions, dont la paire
décisive — le conseil distingue les deux dossiers, et ne marque pas « sans
suite » celui qui a reçu quatre convocations.

### Les tests mangeaient la démonstration

Trouvé en comptant, après avoir remarqué que le jeu de démonstration n'avait
plus le même nombre de lignes qu'à sa création. Deux suites emportaient à
chaque `check:all` des données qui ne leur appartenaient pas :

* `calendrier.e2e.mjs` purgeait « toute séance d'appel hors de l'année scolaire
  **ou** tombant dans cette liste de dates » — dont le 5 et le 10 octobre 2026.
  Or `npm run demo` sème l'assiduité tous les cinq jours **à partir du
  5 octobre**. Deux séances et vingt-quatre présences partaient à chaque
  exécution ;
* `pieces.e2e.mjs` purgeait `documents where category_criterion_id is not null`
  — c'est-à-dire aussi les deux pièces de la démonstration, la photo du bâtiment
  et les résultats au BEPC ;
* `envois.e2e.mjs` purgeait le 20 octobre, une autre date du semis ;
* `app.e2e.mjs` purgeait sa séance d'appel **en ouvrant** et la laissait en
  fermant : la démonstration gardait en permanence un treizième appel.

Aucune assertion ne tombait. Un bulletin se calcule aussi bien sur dix séances
que sur douze, et un dossier sans pièce jointe a l'air normal. Pire : les
assertions de `pieces.e2e.mjs` — « le compte est zéro », « il n'y en a qu'un »,
« le critère redevient sans pièce » — **ne tenaient que grâce à cette
érosion**. Le test travaillait sur un critère auquel la démonstration attache
déjà une pièce, et ne s'en apercevait pas parce qu'il commençait par l'effacer.

**La règle, posée une fois pour toutes.** Une suite ne supprime que ce qu'elle
a créé, et elle le reconnaît par une marque qu'elle a posée elle-même — jamais
par un prédicat qui décrit une famille de lignes (« tout ce qui ressemble à une
pièce », « toutes les dates de cette plage »). Un prédicat attrape aussi ce qui
n'est pas à lui. En pratique : chaque suite a ses propres jours, hors du semis
de démonstration et hors de ceux des autres suites, et chaque dépôt porte un
préfixe témoin.

**Et un témoin, parce qu'une règle sans mesure se perd.** `tests/fixture.e2e.mjs`
passe **en dernier** dans `check:all` et compte : douze élèves, 288 notes, douze
séances, 144 présences, deux pièces jointes avec leurs octets, onze tuteurs, zéro
SMS, zéro bulletin. Un écart nomme la table et le nombre manquant. C'est la seule
suite du dépôt qui n'écrit rien : un témoin qui déplace ce qu'il observe ne sert
à rien. Contrôle négatif fait — les purges d'origine remises, elle tombe sur
exactement les trois lignes attendues.

### Une famille qu'on n'a pas pu prévenir doit apparaître quelque part

Dans `saveAbsences`, une ligne :

```ts
const row = g.rows[0];
if (!row?.phone) continue;              // <— ici
```

L'élève est marqué absent, et pour sa famille il ne se passe **rien** : aucun
SMS, aucune ligne dans `sms_messages`, aucune tâche dans le registre, aucun nom
dans la confirmation. L'écran répondait, mot pour mot :

> Appel enregistré : 3 absences, 2 SMS envoyés pour 16 F.

Trois enfants absents, deux familles prévenues. La troisième n'est nulle part —
elle disparaît dans une soustraction que personne ne fait. C'est la **deuxième
des trois promesses du produit** qui tombe en silence, et qui retombera demain,
et tous les jours où cet élève sera absent.

Le reste du logiciel sait déjà le dire : `discipline.ts` (« Aucun numéro
joignable : prévenez la famille autrement, et corrigez le numéro dans la fiche
de l'élève »), `cloture.ts`, `eleve.ts`, `attention.ts`. Quatre écrans portent
la règle ; le cinquième — celui qui porte la promesse — l'avait oubliée.

Et le tableau de bord ne remplaçait pas ce qui manquait : il annonce un **état**
permanent (« trois élèves sans numéro »), jamais l'**événement** du jour (« ce
matin Boukary était absent, et personne n'a pu être prévenu »). Le second est
une tâche avec une heure ; le premier est une statistique.

**Le second défaut, plus discret.** La requête qui choisit le destinataire ne
filtrait pas sur le numéro : `order by sg.is_primary desc nulls last limit 1`.
Elle prend donc le tuteur **principal**, même sans numéro — et un principal sans
numéro **masque** un second tuteur joignable inscrit au même dossier. Éprouvé :
la tante au 70 99 98 88 n'a rien reçu, parce que le père listé en premier avait
changé de puce. Un père dont le numéro a changé et une mère inscrite en second,
c'est le cas ordinaire.

**Ce qui change.**

* un état `injoignable`, distinct de `echoue`, parce que le geste n'est pas le
  même : `echoue` veut dire que l'opérateur a refusé — on renvoie, ou on
  téléphone ; `injoignable` veut dire qu'il n'y avait **pas de numéro à
  composer** — on téléphone si on en trouve un, et surtout on corrige la fiche
  de l'élève, sinon demain sera identique ;
* la ligne porte **le texte qu'on aurait envoyé**, pour que celui qui appelle la
  famille sache quoi lui dire, et un `to_phone` vide, qui se lit « il n'y en
  avait pas » — pas un numéro inventé ;
* elle **ne coûte rien** : rien n'a été composé, rien n'est débité ;
* la confirmation la **nomme**, et dit le geste : « Une famille n'a aucun numéro
  au dossier : prévenez-la autrement, et corrigez le numéro dans la fiche de
  l'élève. Elle est listée dans le suivi des messages. » ;
* elle remonte au registre « à traiter » et au tableau de bord, sous son propre
  mot — **Sans numéro**, pas « Non remis » ;
* **« Renvoyer » n'est pas proposé** sur un message qui n'a aucun numéro où
  aller, et le POST fabriqué à la main est refusé lui aussi : un bouton qui ne
  peut pas marcher est pire qu'un bouton absent, il laisse croire qu'on a
  réessayé. « Famille appelée » et « Abandonné » restent offerts — ce sont les
  deux gestes qui ne demandent pas de numéro ;
* la requête de destinataire porte enfin le filtre que tout le reste du code
  écrit déjà, **à l'affichage comme à l'envoi**.

`tests/injoignable.e2e.mjs` : 31 assertions. Les contrôles négatifs ont été
faits — le silence restauré fait tomber douze assertions, le filtre retiré en
fait tomber quatre de plus, dont « ET IL PART CHEZ LA TANTE ».

### Un bulletin doit dire sur quoi il a été calculé

Une discipline sans **aucune** note sortait du calcul de la moyenne générale —
ni au numérateur, ni au dénominateur :

```js
if (s.moyenne === null) continue;
```

La règle est **juste** : une matière non notée ne vaut pas zéro, et la
neutraliser est ce qu'il faut faire. Ce qui manquait, c'est de le **dire**.

Conséquences, toutes invisibles :

- le bulletin imprimait une moyenne parfaitement plausible, calculée sur une
  partie du programme ;
- le **rang** comparait des élèves notés sur des ensembles de matières
  différents — un élève à qui il manque les mathématiques, coefficient 3, était
  classé contre des camarades qui les avaient ;
- et rien n'empêchait de publier. La publication **fige** : le papier remis aux
  familles portait ce rang-là.

Le cas n'a rien d'exotique : il suffit qu'un enseignant n'ait pas fini sa saisie
le jour du conseil, ou qu'il ait quitté l'établissement en cours de trimestre.

La publication **refuse** désormais une classe incomplète, en nommant les
disciplines vides — refus forçable, parce qu'un établissement peut légitimement
publier sans une matière dont l'enseignant est parti. Et s'il force, **le
bulletin le dit lui-même** : « Moyenne calculée sur 26 coefficients sur 28.
Anglais n'a aucune note ce trimestre. Une discipline non notée ne compte pas
zéro — elle est écartée du calcul. Le rang est donc établi sur un programme
partiel. » Le total attendu est figé à côté du total retenu, pour que le double
ressorti en juin dise la même chose.

`npm run test:bulletin-complet` — 21 assertions, dont la plus importante : la
moyenne obtenue est bien celle des matières **notées**, et **pas** celle qu'on
obtiendrait en comptant un zéro. La règle n'a pas changé ; c'est le silence qui
a disparu.

### Deux gardes sur les envois en masse

Trouvé en éprouvant l'envoi : **le même communiqué, envoyé deux fois de suite,
partait deux fois.** 11 familles × 2, 22 messages, 176 FCFA, et chaque parent
recevait le texte identique en double. Les deux envois annonçaient « 11 familles
prévenues » — le directeur ne voyait rien.

Ce n'est pas un cas tordu, c'est le **double-clic**. Sur une connexion lente — la
connexion visée — la page met plusieurs secondes à répondre, et cliquer une
seconde fois est le comportement humain normal. Le coût est double : le crédit,
et la crédibilité du canal. Une famille qui reçoit deux fois le même message
cesse de les lire, et c'est le SMS d'absence qui meurt avec.

Seconde garde, **l'heure** : rien n'empêchait un envoi en masse à 23 h. Un
communiqué scolaire qui réveille trois cents foyers est un incident, et c'est le
logiciel qu'on accuse. La fenêtre de silence est une donnée de l'établissement
(21 h → 6 h par défaut), et l'heure comparée est celle de **Ouagadougou**, pas
celle du serveur : le conteneur tourne en UTC et le Burkina est à UTC+0, ce qui
est exactement le genre de coïncidence qui casse le jour où la machine déménage.

**On compare le corps du message, pas un jeton de formulaire.** Un jeton attrape
le double-clic et rien d'autre ; le corps attrape aussi le retour arrière, le
rechargement, et le re-clic après une attente jugée trop longue — tous les gestes
qui produisent réellement un doublon. Et les deux refus sont **toujours
forçables** : une école peut vouloir renvoyer le même texte demain, et un mur
sans porte est un défaut.

**Ce que les gardes ne couvrent pas, volontairement.** Un SMS d'absence et une
confirmation de paiement répondent à un geste qui vient d'avoir lieu ; les
retenir jusqu'à 6 h du matin les rendrait faux. L'appel est déjà borné par le
calendrier scolaire.

`npm run test:envois` — 23 assertions. Le doublon est compté dans la base, pas
déduit ; la fenêtre qui traverse minuit est vérifiée heure par heure ; et une
assertion exige qu'un SMS d'absence parte **malgré** les heures de silence.

### Les résultats aux examens, et les chiffres du dossier

`students.cep_result` et `students.concours_6e_result` étaient dans le schéma
depuis la première migration, avec leurs contraintes de valeur. **Aucune ligne
de code ne les lisait ni ne les écrivait**, et aucun écran ne permettait de les
renseigner.

Ce n'est pas un détail. « Résultats aux examens » est le critère le plus lourd
de la moitié qualité de l'arrêté n°2026-101 — celle qui décide du plafond légal
des frais. C'est aussi l'argument central pour lequel un établissement achète un
logiciel plutôt qu'un tableur : **la grille réclame des chiffres qu'un système
de gestion produit comme sous-produit**, et qu'une école sans système rassemble
à la main chaque année. Un logiciel qui ne sait pas dire son taux de réussite
au BEPC ne soutient pas l'argument qui le vend.

Ajouté : le BEPC et le BAC (les deux colonnes existantes ne couvraient que la
fin du primaire — l'établissement de démonstration est un collège, qui ne passe
ni CEP ni concours d'entrée en 6e), un écran de saisie, et un panneau
« Ce que le logiciel établit déjà » sur le dossier de catégorisation.

**« Non présenté » n'est pas « refusé ».** Le dénominateur du taux est le nombre
de *présentés*. Confondre les deux ferait baisser un chiffre qui part au
ministère : dans le cas éprouvé par le test, 66,7 % deviendrait 50 %. Le calcul
vit dans `taux_reussite()`, une seule définition que l'écran, le dossier et les
tests lisent tous — trois copies d'un même calcul finissent par diverger, et
celle qui part au ministère est celle qu'on ne relit pas.

**Le logiciel n'attribue aucun point.** Il établit le chiffre et nomme le
critère auquel il se rapporte. La grille de l'arrêté n'a pas pu être obtenue ;
la deviner conduirait un établissement à facturer un montant illégal — c'est la
même règle que pour la catégorie et le plafond.

`npm run test:examens` — 20 assertions. Elle fabrique une 3e (la démonstration
n'a pas de classe d'examen), pose les deux calculs côte à côte, et vérifie que
le dossier affiche le taux **et** dit qu'il refuse de le noter.

### Ce que le conseil de classe décide, et que le bulletin n'imprimait pas

L'écran du conseil fait saisir, élève par élève, une **décision** et une
**appréciation** ; le censeur y passe la séance entière. Les deux partaient
dans `conseil_decisions` et s'y arrêtaient.

Le bulletin, lui, imprimait un cadre « Appréciation du conseil de classe »
contenant **deux lignes pointillées vides**. Le logiciel recueillait quarante
appréciations, puis imprimait quarante cadres vides que quelqu'un devait
recopier à la main — exactement le travail que ce produit prétend supprimer,
sur le document par lequel il sera jugé.

Le bulletin porte maintenant l'appréciation et la décision, celle-ci **en
toutes lettres** : `admis_par_compensation` n'a rien à faire sur un papier
remis à une famille. Un élève que le conseil n'a pas délibéré garde ses lignes
pointillées — on n'invente pas une appréciation que personne n'a écrite.

**Le professeur principal.** Le bulletin portait une ligne de signature « Le
professeur principal » sans nom. `classes.professeur_principal_id` existait
depuis le premier schéma, avec en commentaire « FK ajoutée plus bas » — elle ne
l'a jamais été, et aucun écran ne permettait de renseigner la colonne. La clé
étrangère existe désormais (sans elle, on pouvait y écrire l'identifiant du
personnel d'une AUTRE école, que le RLS rendait ensuite invisible), et la
répartition des services porte l'écran qui manquait.

**La publication fige, y compris ces trois valeurs.** Elles sont **copiées**
dans `bulletins`, pas jointes : un bulletin remis aux familles ne doit pas
changer parce qu'on a corrigé la source trois mois plus tard. Le double
ressorti en juin pour un dossier de transfert doit être la feuille de décembre,
mot pour mot — sinon les deux exemplaires diffèrent et c'est celui du parent
qui fait foi. Le nom du professeur principal est figé lui aussi : s'il quitte
l'établissement, le bulletin déjà signé continue de le porter.

`npm run test:conseil-bulletin` — 21 assertions, dont la corruption après coup :
on publie, on corrige l'appréciation et on retire le professeur principal, puis
on réimprime et on exige le texte d'origine.

### Les pièces du dossier de catégorisation

`category_criteria.evidence_key` était un champ de **texte libre**. L'écran
l'appelait « pièce justificative », comptait les critères « sans pièce », les
affichait en rouge, et annonçait le reste « justifié ». Il suffisait donc de
**taper** quelque chose dans la case pour qu'un critère devienne justifié. Rien
n'était joint, rien n'était vérifié — et la démonstration semait elle-même des
valeurs de la forme `evidence/bati.pdf`, qui ressemblent à des chemins de
fichiers et n'en étaient pas.

Ce dossier décide du **plafond légal des frais de scolarité** (arrêté
n°2026-101). Un dossier justifié à l'écran et vide devant l'inspection fait
baisser le score, donc le plafond, sur une année déjà facturée. Les points
accordés sans pièce sont d'ailleurs la première chose qu'une inspection retire.

Désormais un critère n'est justifié que s'il porte au moins un document réel.
`evidence_key` redevient ce qu'il aurait dû être : la **description** de la
pièce attendue, pour l'établissement lui-même.

**Les octets vont dans la base, pas sur le disque.** L'alternative était un
répertoire à côté — et alors la sauvegarde éprouvée ne couvre plus qu'une
moitié du dossier. Ce serait la seconde chose à sauvegarder, celle dont
personne ne se souvient le jour où le disque meurt. En `bytea`,
`pg_dump --format=custom` les emporte sans qu'on ajoute rien, et la
restauration déjà vérifiée les ramène. Un dossier complet, c'est une quinzaine
de photos : quelques mégaoctets.

**Trois règles sur ce qu'on accepte.** Liste blanche (PDF, JPEG, PNG, WebP), et
non liste noire — une liste noire oublie toujours quelque chose. **Pas de SVG**,
bien que ce soit une image : un SVG est un document XML qui peut porter du
JavaScript, et servi depuis notre origine il s'exécuterait avec le cookie de
session de celui qui l'ouvre — le directeur, précisément. Et le contenu est
vérifié **par sa signature d'octets**, pas par le type annoncé : un script HTML
nommé `rapport.pdf` est refusé. Le téléchargement est toujours une pièce jointe
(`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`), sous un
nom reconstruit — un nom d'origine contenant un guillemet s'échapperait de
l'en-tête.

**Défaut trouvé en écrivant le test.** `readMultipart` levait son erreur au
milieu du flux, dès le dépassement de taille, sans consommer le reste du corps.
Node répond, puis détruit la connexion parce qu'il reste des octets non lus
dessus ; le navigateur la garde ouverte et sa requête suivante reçoit un
`ECONNRESET`. Un directeur qui essayait de joindre un scan de 10 Mo obtenait un
refus poli, **puis un écran cassé au clic suivant**, sans rien pour l'expliquer.
Le corps est maintenant drainé jusqu'au bout.

`npm run test:pieces` — 35 assertions. Elle éprouve le défaut dans les deux
sens (taper ne justifie plus, joindre justifie), refuse un script déguisé en
PDF, force la réutilisation de la connexion pour reproduire l'`ECONNRESET`, et
**restaure une sauvegarde** pour vérifier que les octets survivent — c'est la
raison d'être du choix `bytea`, donc elle se prouve.

### Sur l'écran d'accueil

Web, et rien d'autre — c'est la décision arrêtée : *PWA d'abord, les trois
applications Expo gelées, pas supprimées.* Une seule ligne de publication.
On rouvrira la question des applications natives le jour où un établissement
dira que le web ne suffit pas. Aucun ne l'a dit ; aucun n'a encore essayé.

Mais « PWA » n'était pas vrai non plus. Il y avait un service worker et une
file hors ligne, et **aucun manifeste** : sans manifeste, aucun navigateur ne
propose « Ajouter à l'écran d'accueil ». Un enseignant devait retaper une
adresse, dans une cour, sur un téléphone. Et le service worker n'était
enregistré que par `offline.js`, chargé par le seul écran de saisie des notes
— le directeur, celui à qui on veut justement laisser une icône, n'en avait
donc jamais.

Ce qui existe maintenant :

- un manifeste, des icônes 192, 512 et **masquable** (Android découpe en
  cercle, en goutte ou en écusson selon le constructeur : ce qui sort du
  cercle des 80 % est perdu), et l'icône séparée que réclame iOS, qui ignore
  le manifeste ;
- le service worker enregistré par **toutes** les pages du personnel ;
- un raccourci « Saisir les notes » et un « Faire l'appel » au appui long ;
- les icônes sont **du code** — `scripts/dessiner-icones.py` les redessine à
  l'identique. Un binaire versionné sans sa source est un fichier que plus
  personne ne sait refaire.

**Ce que l'application montre quand on la lance sans réseau.** Une fois
installée, on touche l'icône : plus d'onglet, plus de barre d'adresse, rien
pour expliquer une page blanche. Il fallait donc une page — mais servir le
tableau de bord depuis le cache aurait affiché des effectifs et des impayés
d'avant-hier avec l'aplomb de chiffres justes. `/hors-ligne` est donc une page
**sans données** : elle dit ce qui marche encore, ce qui ne marche pas, et
pourquoi. Elle ne peut pas mentir, puisqu'elle n'affirme rien sur l'école.

L'espace des familles est délibérément tenu à l'écart de tout ceci : les
parents reçoivent des SMS, et une icône « FasoSchool » les ferait atterrir sur
l'écran de connexion du personnel.

`npm run test:pwa` — 51 assertions. Elle ouvre les PNG et vérifie qu'ils font
vraiment la taille annoncée, mesure le débordement hors de la zone sûre
d'Android, et **arrête le serveur** pour éprouver le lancement sans réseau
(l'émulation de coupure de Chromium ne survit pas au redémarrage du service
worker : le résultat changeait d'une navigation à l'autre). Deux témoins :
une image volontairement débordante, pour prouver que la mesure n'est pas
aveugle ; et `/famille`, exclu du repli, qui doit échouer *autrement* — sans
quoi rien ne dirait que la page hors-ligne vient bien de notre worker.

### Le calendrier scolaire

`calendar_events` existait depuis la migration 0001. **Aucune ligne du logiciel
ne l'avait jamais ouverte.** Pendant ce temps, l'appel acceptait n'importe quelle
date :

| ce qu'on tapait | ce qui se passait |
|---|---|
| `?date=xyz` | erreur PostgreSQL brute (22P02) à l'écran |
| `?date=` | idem |
| `?date=1999-01-01` | appel enregistré, sans un mot |
| `?date=2027-12-25` | accepté, six mois après la fin de l'année scolaire |
| `?date=2026-12-25` | accepté, le jour de Noël |

Ce n'est pas un défaut d'affichage : l'appel **envoie un SMS** à chaque famille
d'élève absent, à 8 FCFA. « Votre enfant est absent aujourd'hui » un dimanche ou
pendant les congés est le message le plus destructeur que ce produit puisse
émettre — le parent, lui, sait qu'il n'y avait pas école. Une fois suffit pour
que plus personne ne croie les suivants, et c'est tout le canal SMS qui meurt.

Trois sources décident maintenant, dans cet ordre : les bornes de l'**année
scolaire**, la **semaine de l'établissement** (`schools.school_days` — une
donnée, parce que certains travaillent le samedi), puis le **calendrier**.
`closes_school` sépare ce qui ferme l'école de ce qui l'occupe : une
composition est au calendrier et n'empêche pas l'appel.

**Les fêtes légales sont celles de la loi du 9 janvier 2026**, qui a ramené les
jours chômés et payés de 15 à 11 et séparé les fêtes légales des journées
commémoratives. Le 3 janvier, les 4 et 5 août, le 15 octobre, le 31 octobre et
le 1<sup>er</sup> novembre **ne ferment plus** l'école ; la Journée des coutumes
et traditions du 15 mai, oui. Toute liste antérieure à 2026 — y compris celle
qu'on croit connaître — est fausse aujourd'hui. Les commémorations restent
inscrites au calendrier, marquées « l'école travaille » : une date absente se
lit comme un oubli du logiciel.

**Les quatre fêtes mobiles ne sont pas devinées.** Ascension, Aïd el-Fitr,
Tabaski et Maouloud sont chômées, mais les deux dernières dépendent de
l'observation de la lune au Burkina et sont annoncées chaque année. L'écran les
**réclame** à l'établissement et dit lesquelles manquent — avec ce qu'il en
coûte de ne pas les saisir. Un logiciel qui ignore une date vaut mieux qu'un
logiciel qui en invente une, parce que le premier le dit.

`npm run test:calendrier` — 44 assertions. Chaque refus est forcé par un POST
fabriqué à la main, jamais par l'écran, et l'absence de SMS est **comptée dans
la base**, pas déduite. L'épreuve de cloisonnement couvre le cas à deux règles
du calendrier : les congés d'une école lui appartiennent, les fêtes nationales
(`school_id` nul) restent visibles de toutes.

### Ce qui n'existe pas encore

Orange Money et Moov Money, bloqués sur le RCCM. Les seuils de catégorisation
et les plafonds de frais par cycle, faute d'avoir pu obtenir les tables de
l'arrêté. Les retours statutaires au ministère, faute de leurs formulaires.

Volontairement : le reste attend un vrai bulletin burkinabè.

---

## Démarrer

```bash
npm install

# La base : migrations avec le rôle d'ADMINISTRATION, droits accordés au rôle
# applicatif, puis vérification du cloisonnement avant de déclarer la base prête.
ADMIN_DATABASE_URL='postgres://postgres@localhost/postgres' \
APP_ROLE=fasoschool_app APP_PASSWORD='...' \
./scripts/preparer-base.sh fasoschool

export DATABASE_URL=postgres://fasoschool_app:...@localhost:5432/fasoschool

# LE CANAL SMS EST UN CHOIX ÉCRIT, SANS DÉFAUT. Le serveur refuse de démarrer
# sans lui : une variable oubliée basculait l'installation en démonstration,
# où aucun message ne part et où le code de connexion s'affiche à l'écran.
export SMS_PROVIDER=mock        # démonstration : rien ne part, et tout le dit
# export SMS_PROVIDER=orange_bf # production, avec ORANGE_SMS_CLIENT_ID,
#                               # ORANGE_SMS_CLIENT_SECRET, ORANGE_SMS_SENDER

ADMIN_DATABASE_URL='postgres://postgres@localhost/postgres' \
npm run db:test:rls        # doit passer avant tout développement
npm run demo               # établissement de démonstration + bulletins
npm start                  # http://localhost:4180

curl -s localhost:4180/sante   # {"ok":true,"base":true,"sms":"mock","simule":true}
```

**`preparer-base.sh`, et non `db:migrate` à la main.** Le chemin d'installation
donné ici jusqu'à récemment ne fonctionnait pas, et personne ne l'avait exécuté
en entier. Il échouait de trois façons :

- `npm run db:migrate` lancé avec le rôle applicatif s'arrête à la première
  ligne : « permission denied to create extension "uuid-ossp" » ;
- si on lui accordait ce droit pour débloquer, il deviendrait **propriétaire des
  tables** — et un propriétaire peut supprimer les politiques de row-level
  security qui sont l'unique frontière entre deux établissements ;
- et rien n'accordait au rôle applicatif le moindre droit sur les tables : la
  première requête de l'application aurait échoué.

Le script fait les trois choses dans le bon ordre, refuse un rôle applicatif
superutilisateur, et **vérifie avant de rendre la main** qu'aucune table portant
`school_id` n'échappe au RLS, qu'aucune table n'appartient au rôle applicatif,
et que les politiques sont toutes là. C'est cette vérification qui a révélé que
`auth_sessions` — les sessions de tout le personnel, tous établissements
confondus — n'avait aucune politique (migration 0009).

Comptes de démonstration — le code s'affiche à l'écran, aucun SMS n'est envoyé :

| numéro | fonction |
|---|---|
| `70000001` | Censeur |
| `70000002` | Enseignante |
| `70000003` | Surveillant général |
| `70000004` | Économe |
| `70000005` | Directeur |

Vérifications : `npm run check:all` — typecheck strict, 60 tests unitaires, et
**quarante parcours**, chacun contre un vrai PostgreSQL et un vrai serveur.
Le tableau ci-dessous en détaille une partie ; les autres sont décrits, avec ce
qu'ils ont trouvé, dans les sections qui précèdent.

| suite | ce qu'elle prouve |
|---|---|
| `test:cookies` (13) | les deux cookies de session portent `Secure` derrière https et pas en local, et on refuse d'inviter une famille sur une adresse en http |
| `test:cloisonnement` (16) | l'épreuve d'isolation passe sur un schéma complet, **échoue** sur un schéma auquel il manque la migration 0009, et ne touche à aucune base réelle |
| `test:installation` (17) | le chemin du premier jour marche du disque nu à la première connexion, et aucune table portant `school_id` n'échappe au RLS |
| `test:sauvegarde` (15) | la sauvegarde refuse de tourner avec le rôle applicatif, ne laisse aucun fichier quand elle échoue, et son archive se restaure vraiment |
| `test:bareme` (21) | une note sur 10 compte pour 20/20 dans la moyenne, et aucun des trois chemins de saisie ne rejette plus en silence |
| `test:justifications` (24) | justifier une absence à une composition fait monter la moyenne du bulletin, et renverser la règle change le calcul |
| `test:discipline` (29) | l'exclusion définitive est refusée au surveillant même en postant à la main, et un incident retiré reste écrit et barré |
| `test:installer` (24) | un second établissement s'installe, son chef se connecte, et aucune des deux écoles ne voit les données de l'autre |
| `test:annulation` (28) | le reçu d'origine reste intact, l'annulation est un second reçu numéroté, et tous les écrans lisent le même solde |
| `test:eleve` (35) | on retrouve un élève par le numéro de son tuteur, un tuteur partagé se corrige pour la fratrie, et voir n'est pas corriger |
| `test:personnel` (29) | un établissement crée ses propres comptes ; le dernier chef ne peut être ni écarté ni rétrogradé ; écarter quelqu'un ferme ses sessions ouvertes |
| `test:messages` (26) | un refus de l'opérateur est enregistré avec sa raison, remonte au tableau de bord, et ne se referme que par un geste humain tracé |
| `test:arrivee` (16) | un élève arrivé en cours d'année n'est plus réputé en retard depuis la rentrée sans que l'écran le dise, et un départ porte une date |
| `test:recu-fige` (20) | un reçu réimprimé six mois plus tard dit exactement ce que disait le papier remis à la famille, annulation comprise |
| `test:echeancier` (26) | « en retard » veut dire en retard sur une échéance, pas « doit encore quelque chose sur l'année », et une facture sans échéancier ne bascule d'aucun côté |
| `test:canal` (24) | le serveur refuse de démarrer sans canal SMS déclaré, le mode démonstration s'annonce partout, et un code que l'opérateur refuse n'est plus annoncé comme envoyé |
| `test:recurrence` (18) | « quatre faits, quatre convocations » et « quatre faits, aucune suite » ne sont plus le même chiffre au conseil de classe, et le registre ouvre sur ce qui revient |
| `test:fixture` (16) | le jeu de démonstration sort de `check:all` exactement comme il y est entré : une suite qui emporte ce qui n'est pas à elle est nommée, avec la table et le nombre |
| `test:injoignable` (31) | un absent dont la famille n'a aucun numéro laisse une tâche nommée au lieu d'un silence, et un tuteur principal sans numéro ne masque plus un second tuteur joignable |
| `test:evaluations` (22) | un enseignant ouvre un devoir pour sa matière ; une composition ne s'ouvre que par le censeur, et pour tout le niveau |
| `test:transferts` (23) | un parcours déclaré est accepté et étiqueté, une moyenne inventée est refusée, le certificat porte sa réserve |
| `test:communiques` (17) | le coût est annoncé avant l'envoi, les tuteurs sont dédoublonnés, un crédit court refuse l'envoi en bloc |
| `test:bourses` (19) | les remises se cumulent sans atteindre la gratuité, une facture émise n'est pas rabotée |
| `test:frais` (21) | un supplément sans autorisation est refusé, un dépassement de plafond est chiffré, une facture émise n'est pas recalculée |
| `test:cloture` (32) | le bulletin remis ne bouge pas, l'écart est montré, le trimestre clos refuse les notes, et les familles apprennent que leur espace existe |
| `test:services` (14) | un enseignant ne voit et ne touche que ses classes — y compris en postant à la main |
| `test:rentree` (19) | un établissement ouvre son année, pose ses trimestres et crée ses classes sans intervention en base |
| `test:e2e` (53) | connexion, notes, bulletins, appel et SMS, encaissement, droits |
| `test:offline` (18) | le réseau est réellement coupé, l'onglet fermé puis rouvert ; rien n'est perdu, rien n'est écrasé |
| `test:categorisation` (20) | le dossier se saisit, les points hors barème sont refusés, et l'écran ne devine ni la catégorie ni le plafond |
| `test:famille` (22) | un parent voit ses enfants et personne d'autre ; les deux sessions ne communiquent pas ; la page tient sous 60 Ko sans JavaScript |
| `test:conseil` (24) | la proposition est motivée, la décision humaine prime, un redoublement interdit est refusé, et la conduite ne change pas la proposition |
| `test:import` (30) | un vrai fichier Windows-1252 est importé, corrigé dans l'aperçu, puis réimporté sans créer de doublon |

---

## Les sept règles à confirmer

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
| jours travaillés dans la semaine | lundi → vendredi | beaucoup d'établissements travaillent aussi le samedi matin ; se corrige dans l'écran **Calendrier** |
| facturation d'une arrivée en cours d'année | aucune — l'échéancier reste entier et l'écran le signale | la pratique varie d'un établissement à l'autre ; aucun texte consulté ne la fixe |

Une matinée avec un censeur coopératif et une photocopieuse ferme les sept.

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

## Sauvegarde

```bash
ADMIN_DATABASE_URL='postgres://postgres@localhost/fasoschool' \
FASOSCHOOL_PASSPHRASE='...' ./scripts/sauvegarde.sh /media/usb

ADMIN_DATABASE_URL='postgres://postgres@localhost/postgres' \
FASOSCHOOL_PASSPHRASE='...' \
./scripts/restauration-verifiee.sh /media/usb/fasoschool-20260906-1400.dump.gpg
```

`ADMIN_DATABASE_URL`, et **non** `DATABASE_URL` : le rôle applicatif est soumis
au row-level security, et `pg_dump` lancé avec lui échoue table par table
(« query would be affected by row-level security policy ») sans rien
sauvegarder. La sauvegarde se fait avec le propriétaire des tables, qui porte
`BYPASSRLS` et n'est jamais le rôle de l'application.

Ce n'est pas une précision de style : le script demandait `DATABASE_URL`
jusqu'à ce qu'on le lance pour de vrai. Un établissement suivant la
documentation à la lettre n'avait donc **aucune sauvegarde** — et un fichier de
soixante-dix octets, portant un nom parfaitement crédible, posé au milieu des
bonnes archives, pour le lui faire croire. Une sauvegarde ratée n'en laisse
désormais aucune trace, et une archive plus petite qu'un schéma vide est
refusée avant d'être nommée.

Le fichier produit contient les noms, les dates de naissance et les numéros des
familles de tout un établissement. Il est donc **chiffré au vol** : `pg_dump`
écrit sur la sortie standard et `gpg` chiffre dans le tuyau, le contenu en clair
ne touche jamais le disque. Le scénario réel n'est pas une attaque
sophistiquée — c'est l'ordinateur du secrétariat volé, ou la clé USB oubliée
dans un taxi.

**Une sauvegarde jamais restaurée n'est pas une sauvegarde.** Le mode d'échec
ordinaire n'est pas l'absence de sauvegarde : c'est une sauvegarde quotidienne,
fidèle, qui depuis huit mois écrit un fichier ne contenant que le schéma, et
dont personne ne le sait. `restauration-verifiee.sh` restaure réellement dans
une base jetable et échoue — code de sortie non nul — dans ces trois cas :

| cas | ce qui se passe |
|---|---|
| fichier abîmé sur le support | l'empreinte SHA-256 ne correspond plus |
| sauvegarde ne contenant que le schéma | toutes les tables vides → échec |
| politiques RLS perdues | moins de 50 politiques restaurées → échec |

Ce dernier point n'est pas théorique : une base restaurée sans son
row-level security serait ouverte à tous les établissements à la fois.

À lancer une fois par mois. Les trois cas ci-dessus ont été éprouvés en
fabriquant volontairement chacune des trois sauvegardes défectueuses.
`test:sauvegarde` refait le parcours complet à chaque `check:all` : refus sans
phrase de passe, refus sans URL d'administration, aucun fichier laissé quand
`pg_dump` échoue, archive chiffrée en 0600, puis restauration d'épreuve
réussie avec comptage des lignes.

---

## Ce que chacun voit

La barre latérale, les tuiles du tableau de bord et les points à traiter ne
montrent **que ce que l'utilisateur peut ouvrir**. Une enseignante à qui l'on
propose « Frais » clique, reçoit « Accès refusé », et en conclut que le
logiciel est cassé ; un censeur à qui l'on signale un dossier de catégorisation
qu'il ne peut pas ouvrir reçoit une inquiétude sans moyen d'agir.

Le contrôle d'accès reste dans les routes — ce filtrage n'est qu'une politesse,
jamais une protection. Le parcours principal vérifie qu'aucun lien de la barre
ne mène à un refus, pour chaque compte.

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

**Une configuration dangereuse n'a pas de valeur par défaut.** Le canal SMS se
déclare ou le serveur ne démarre pas ; la sauvegarde exige sa phrase de passe ou
elle refuse de tourner. Le point commun : dans les deux cas, le défaut ne se voit
pas le jour de l'installation — il se voit le jour où l'on en a besoin.

**Le hors-ligne se limite au strict nécessaire.** La saisie des notes et
l'appel, sur le poste de l'enseignant. Ni l'administration ni la comptabilité :
ces utilisateurs sont à un bureau.

**Une suite de tests possède les réglages dont dépendent ses assertions.**
Trois suites affirmaient que des messages partent, sans neutraliser la garde des
heures de silence : elles passaient en journée et échouaient le soir, sur des
assertions dont le message ne parlait pas d'horaire. Découvert en lançant
`check:all` à 21 h 27. Elles posent désormais une fenêtre de silence calculée
par PostgreSQL, dans le fuseau de l'école, pour exclure l'instant présent — et
la remettent en sortant.

**Une suite de tests ne supprime que ce qu'elle a créé.** Elle le reconnaît par
une marque qu'elle a posée elle-même, jamais par un prédicat qui décrit une
famille de lignes — un prédicat attrape aussi ce qui n'est pas à lui. Chaque
suite a ses propres jours, hors du semis de démonstration et hors de ceux des
autres ; chaque dépôt porte un préfixe témoin. `test:fixture` le vérifie en
dernier, en comptant.

---

## Prochaine étape

Elle n'est pas dans ce dépôt.

Tout ce qui pouvait être construit sans un établissement l'a été : un chef
d'établissement peut désormais ouvrir son année, créer ses classes, importer
sa liste d'élèves, répartir les services, saisir les notes — y compris hors
ligne —, faire l'appel, encaisser, délibérer, monter son dossier de
catégorisation, et ouvrir l'espace famille. Ce qui reste bloqué l'est sur des
choses qui ne s'écrivent pas : cinq règles à faire confirmer, un vrai bulletin
à photocopier, un RCCM à obtenir, et les tables de l'arrêté à se procurer.

Entre le **15 septembre** (rentrée administrative) et le **1er octobre**
(rentrée pédagogique), les censeurs sont à leur bureau et n'enseignent pas
encore. C'est la quinzaine la plus accessible de l'année scolaire, et c'est
maintenant.

Rapporter un vrai bulletin, et faire confirmer les cinq règles. Une matinée.
