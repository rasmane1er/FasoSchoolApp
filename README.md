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
- `src/lib/roster.ts` — lecture d'un fichier de liste (encodage, séparateur,
  intitulés, dates, numéros). 22 tests.
- `src/server/multipart.ts` — envoi de fichier, écrit à la main pour ne pas
  ajouter de dépendance.
- `src/server/sync.ts` — réception des saisies hors ligne, détection des
  divergences, écran d'arbitrage du censeur.
- `public/offline.js` — file d'attente des notes dans IndexedDB.
- `public/sw.js` — cache de l'écran de saisie.

**Exploitation**
- `scripts/installer.ts` — installer un établissement et son premier compte.
- `scripts/sauvegarde.sh` — sauvegarde chiffrée, jamais écrite en clair.
- `scripts/restauration-verifiee.sh` — l'épreuve de restauration.

**Démonstration** — `npm run demo` crée un établissement, une 6<sup>e</sup> de
douze élèves, huit disciplines notées, la scolarité et un dossier de
catégorisation entamé, puis écrit les bulletins dans `out/`.

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

Vérifications : `npm run check:all` — typecheck strict, 60 tests unitaires,
et vingt parcours dans un vrai navigateur :

| suite | ce qu'elle prouve |
|---|---|
| `test:discipline` (29) | l'exclusion définitive est refusée au surveillant même en postant à la main, et un incident retiré reste écrit et barré |
| `test:installer` (24) | un second établissement s'installe, son chef se connecte, et aucune des deux écoles ne voit les données de l'autre |
| `test:annulation` (28) | le reçu d'origine reste intact, l'annulation est un second reçu numéroté, et tous les écrans lisent le même solde |
| `test:eleve` (35) | on retrouve un élève par le numéro de son tuteur, un tuteur partagé se corrige pour la fratrie, et voir n'est pas corriger |
| `test:personnel` (29) | un établissement crée ses propres comptes ; le dernier chef ne peut être ni écarté ni rétrogradé ; écarter quelqu'un ferme ses sessions ouvertes |
| `test:messages` (26) | un refus de l'opérateur est enregistré avec sa raison, remonte au tableau de bord, et ne se referme que par un geste humain tracé |
| `test:evaluations` (22) | un enseignant ouvre un devoir pour sa matière ; une composition ne s'ouvre que par le censeur, et pour tout le niveau |
| `test:transferts` (23) | un parcours déclaré est accepté et étiqueté, une moyenne inventée est refusée, le certificat porte sa réserve |
| `test:communiques` (17) | le coût est annoncé avant l'envoi, les tuteurs sont dédoublonnés, un crédit court refuse l'envoi en bloc |
| `test:bourses` (19) | les remises se cumulent sans atteindre la gratuité, une facture émise n'est pas rabotée |
| `test:frais` (21) | un supplément sans autorisation est refusé, un dépassement de plafond est chiffré, une facture émise n'est pas recalculée |
| `test:cloture` (25) | le bulletin remis ne bouge pas, l'écart est montré, le trimestre clos refuse les notes en ligne comme hors ligne |
| `test:services` (14) | un enseignant ne voit et ne touche que ses classes — y compris en postant à la main |
| `test:rentree` (19) | un établissement ouvre son année, pose ses trimestres et crée ses classes sans intervention en base |
| `test:e2e` (50) | connexion, notes, bulletins, appel et SMS, encaissement, droits |
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

## Sauvegarde

```bash
FASOSCHOOL_PASSPHRASE='...' ./scripts/sauvegarde.sh /media/usb

ADMIN_DATABASE_URL='postgres://postgres@localhost/postgres' \
FASOSCHOOL_PASSPHRASE='...' \
./scripts/restauration-verifiee.sh /media/usb/fasoschool-20260906-1400.dump.gpg
```

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

**Le hors-ligne se limite au strict nécessaire.** La saisie des notes et
l'appel, sur le poste de l'enseignant. Ni l'administration ni la comptabilité :
ces utilisateurs sont à un bureau.

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
