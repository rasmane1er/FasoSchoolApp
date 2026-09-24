# Mettre FasoSchool en ligne

Ce document est une **procédure**, pas une présentation. Chaque commande est
faite pour être copiée telle quelle. Ce qui demande une décision humaine est
signalé par un encadré **DÉCISION**, et ce que le logiciel ne peut pas
vérifier lui-même est dit à voix haute.

Le chemin décrit ici est : **Railway** pour l'application et la base,
**Cloudflare** pour le nom de domaine et le pare-feu. Tout le reste
— sauvegardes chiffrées, installation sur les téléphones, envoi des SMS —
est déjà dans le dépôt et se configure par variables d'environnement.

---

## 0. Ce que ce déploiement ne fait pas

Il faut le lire avant, pas après.

1. **Aucun SMS ne part tant qu'`ORANGE_SMS_*` n'est pas rempli.** Le serveur
   refuse de démarrer si `SMS_PROVIDER` n'est pas posé — une configuration
   dangereuse n'a pas de valeur par défaut — et en `mock` il l'écrit sur tous
   les écrans. L'API Orange Burkina SMS 2.0 s'obtient en libre-service sur
   `developer.orange.com` ; comptez ~8 FCFA le message.
2. **Aucun paiement Mobile Money.** Ni Orange Money ni Moov n'ont d'API
   publique au Burkina ; le chemin réaliste est un agrégateur (LigdiCash,
   PayDunya) et **tous exigent un RCCM**. `PAYMENT_PROVIDER=none` est le seul
   réglage honnête avant d'avoir l'entreprise enregistrée.
3. **Les sept règles non vérifiées restent non vérifiées.** Barème,
   coefficients, bandes de mention, modèle de bulletin, pondération des
   trimestres, semaine scolaire, facturation d'une arrivée en cours d'année :
   le logiciel les affiche avec leur avertissement tant qu'un censeur ne les
   a pas confirmées. Mettre en ligne ne les confirme pas.
4. **Les seuils de l'arrêté n°2026-101 ne sont pas encodés** — ni les paliers
   de catégorie, ni les plafonds par cycle. L'établissement les lit dans son
   exemplaire et les saisit ; le logiciel compare, il n'invente pas.

---

## 1. La base de données

**DÉCISION — un seul établissement ou plusieurs ?**
L'architecture est multi-établissement par le RLS depuis le premier jour :
une base, une ligne par école, et aucune requête applicative ne filtre sur
`school_id` elle-même. Pour un pilote, une base Railway suffit et tiendra des
dizaines d'écoles. Recommandé : **une seule base**.

Dans Railway : `New Project` → `Provision PostgreSQL`. Notez l'URL interne
(`postgres://postgres:…@postgres.railway.internal:5432/railway`).

### 1.1 Le rôle applicatif n'est pas superutilisateur

C'est la règle la plus importante de tout ce document. **Un superutilisateur
contourne entièrement le row-level security** : le cloisonnement entre
établissements disparaît sans qu'aucun test ne le dise.

Connectez-vous à la base (`Railway → PostgreSQL → Connect → psql`) et lancez :

```sql
-- Le rôle qui fera tourner l'application. Pas de SUPERUSER, pas de CREATEDB,
-- pas de BYPASSRLS.
create role fasoschool_app login password 'UN-MOT-DE-PASSE-LONG-ET-ALEATOIRE';

-- Le propriétaire des tables, qui applique les migrations. Lui seul porte
-- BYPASSRLS, et il ne sert JAMAIS à servir une requête d'écran.
create role fasoschool_owner login password 'UN-AUTRE-MOT-DE-PASSE'
  bypassrls createdb;
```

Vérifiez, et gardez la sortie :

```sql
select rolname, rolsuper, rolbypassrls
  from pg_roles where rolname like 'fasoschool%';
-- fasoschool_app    | f | f     <- les deux colonnes DOIVENT être f
-- fasoschool_owner  | f | t
```

> Si `rolsuper` vaut `t` pour `fasoschool_app`, arrêtez-vous ici. Rien de ce
> qui suit n'a de sens : `epreuve-cloisonnement.sh` le vérifie aussi, et il
> refusera.

### 1.2 Appliquer les migrations

Depuis votre machine, avec l'URL **publique** de la base Railway :

```bash
export ADMIN_DATABASE_URL='postgres://fasoschool_owner:…@…rlwy.net:PORT/railway'
bash scripts/preparer-base.sh railway
```

Le script est idempotent : chaque migration peut être rejouée sans effet de
bord. Il est aussi rejoué à chaque déploiement par la commande de release de
Railway (`preDeployCommand` dans `railway.json`).

### 1.3 L'épreuve de cloisonnement

Avant de mettre le moindre élève réel dedans :

```bash
ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL" bash scripts/epreuve-cloisonnement.sh
```

Il crée deux établissements, tente de lire l'un depuis l'autre par tous les
chemins, et échoue bruyamment si une seule ligne passe. **Il sait aussi
échouer** — une assertion vérifie que l'épreuve elle-même n'est pas devenue
aveugle.

---

## 2. L'application

Dans le même projet Railway : `New` → `GitHub Repo` → `FasoSchoolApp`.
Railway lit `railway.json` et construit avec le `Dockerfile`.

### 2.1 Les variables d'environnement

| Variable | Valeur | Pourquoi |
|---|---|---|
| `DATABASE_URL` | `postgres://fasoschool_app:…@postgres.railway.internal:5432/railway` | **le rôle applicatif**, pas l'owner |
| `PGPOOL_MAX` | `10` | tenir sous la limite de connexions du plan |
| `SMS_PROVIDER` | `mock` puis `orange_bf` | le serveur refuse de démarrer sans |
| `SMS_COST_FCFA` | `8` | ce que le canal facture réellement |
| `ORANGE_SMS_CLIENT_ID` | (Orange) | vide tant que `mock` |
| `ORANGE_SMS_CLIENT_SECRET` | (Orange) | idem |
| `ORANGE_SMS_SENDER` | (Orange) | l'expéditeur affiché sur le téléphone |
| `PAYMENT_PROVIDER` | `none` | pas avant le RCCM |
| `FASOSCHOOL_PUBLIC_URL` | `https://votre-domaine` | pose `Secure` sur les cookies et sert de base aux liens envoyés par SMS |
| `FASOSCHOOL_PASSPHRASE` | (long, aléatoire) | `sauvegarde.sh` refuse de tourner sans : **une sauvegarde en clair est une fuite qui attend son heure** |
| `NODE_ENV` | `production` | |

Railway pose `PORT` lui-même ; ne le forcez pas.

> **`FASOSCHOOL_PUBLIC_URL` n'est pas cosmétique.** Sans lui, et derrière un
> proxy qui ne poserait pas `x-forwarded-proto`, les cookies de session
> partiraient sans `Secure`. Celui des familles ouvre le dossier d'un enfant.

### 2.2 Premier démarrage

Le healthcheck est `/sante`. Il répond `200` seulement si la base répond, et
il dit lequel des deux canaux SMS est actif :

```bash
curl -s https://votre-service.up.railway.app/sante
# {"ok":true,"service":"fasoschool","base":true,"sms":"mock","simule":true}
```

`"simule": true` signifie **aucun SMS ne part**. C'est le bon état tant que
vous n'avez pas les identifiants Orange, et les écrans le disent aux
utilisateurs.

### 2.3 Installer le premier établissement

Avec le rôle **applicatif** — l'installateur n'a besoin d'aucun privilège
particulier, et il vaut mieux qu'il n'en ait pas :

```bash
DATABASE_URL='postgres://fasoschool_app:…@…rlwy.net:PORT/railway' \
  npm run installer -- \
    --nom       "Complexe scolaire Wend-Panga" \
    --secteur   prive_laic \
    --zone      ouaga_bobo \
    --commune   Ouagadougou \
    --region    Centre \
    --chef      "KABORÉ Paul" \
    --telephone 70000005 \
    --fonction  directeur
```

`--zone` décide du plafond de frais applicable au titre de l'arrêté : elle
n'est pas cosmétique. `--telephone` est l'**identifiant de connexion** du chef
d'établissement ; c'est ce numéro qui recevra le code.

Il imprime le code de première connexion. **Ne mettez jamais la base de
démonstration en production** : `npm run demo` crée un établissement entier
avec des comptes dont le code s'affiche à l'écran.

---

## 3. Le nom de domaine et Cloudflare

**DÉCISION — proxy Cloudflare ou DNS seul ?**
Recommandé : **proxy activé** (nuage orange). Il apporte le cache des
fichiers statiques, un pare-feu applicatif, et la protection contre les
inondations — trois choses utiles pour un service que des écoles ouvriront
toutes à 7 h 30.

1. Dans Railway : `Settings` → `Domains` → `Custom Domain`, entrez
   `ecole.votredomaine.bf`. Railway donne une cible `CNAME`.
2. Dans Cloudflare, sur la zone : `DNS` → `Add record`
   - Type `CNAME`, nom `ecole`, cible celle de Railway, **Proxied** (orange).
3. `SSL/TLS` → `Overview` → **Full (strict)**. Jamais « Flexible » : elle
   sert en clair entre Cloudflare et Railway, et rend `Secure` mensonger.
4. `SSL/TLS` → `Edge Certificates` → **Always Use HTTPS** activé.
   L'application pose déjà HSTS ; ne posez pas le HSTS de Cloudflare
   par-dessus tant que vous n'êtes pas certain du domaine.

### 3.1 Règles de cache

L'application pose `cache-control: no-store` sur **toutes** les pages : elles
portent des notes, des absences et des numéros de famille, et aucune ne doit
dormir dans un cache partagé. Ne créez donc **aucune** règle de cache sur
`/*`.

Une seule règle, pour les fichiers qui ne changent qu'avec une version :

- `Caching` → `Cache Rules` → `Create rule`
- Nom : `Statiques FasoSchool`
- Si : `URI Path` `starts with` `/icones/` **ou** `URI Path` `equals`
  `/app.js` **ou** `/offline.js` **ou** `/manifest.webmanifest`
- Alors : `Eligible for cache`, `Edge TTL: 1 day`

> Ne mettez **jamais** `/sw.js` en cache long. Un service worker figé est un
> produit figé : les utilisateurs continueraient de charger l'ancienne
> version après chaque mise en ligne.

### 3.2 Pare-feu

`Security` → `WAF` → `Rate limiting rules` :

- Nom : `Connexion`
- Si : `URI Path` `equals` `/connexion` et `Method` `equals` `POST`
- Alors : 10 requêtes / minute / IP → `Block` 1 minute

L'application a déjà sa propre limitation par numéro de téléphone
(`auth_rate_limits`) ; celle-ci protège en amont, contre une machine qui
essaierait des milliers de numéros.

---

## 4. Les sauvegardes

`scripts/sauvegarde.sh` **refuse de tourner sans `FASOSCHOOL_PASSPHRASE`**.
C'est voulu : une sauvegarde d'école en clair contient les notes, les
absences, les numéros des familles et la comptabilité.

**DÉCISION — où les stocker ?**
Recommandé : un stockage objet hors de Railway (Cloudflare R2, Backblaze B2).
Une sauvegarde chez l'hébergeur de la base ne protège pas de la perte du
compte.

Sur Railway, créez un service `Cron` (`New` → `Empty Service` →
`Settings` → `Cron Schedule`), avec la même image et :

```
0 2 * * *   bash scripts/sauvegarde.sh /sauvegardes
```

> **`ADMIN_DATABASE_URL`, et non `DATABASE_URL`.** Le rôle applicatif est
> soumis au row-level security : `pg_dump` lancé avec lui échoue table par
> table (« query would be affected by row-level security policy ») et produit
> une sauvegarde **vide sans le dire**. Le service de sauvegarde reçoit donc
> `ADMIN_DATABASE_URL` (le rôle propriétaire) et `FASOSCHOOL_PASSPHRASE`, et
> rien d'autre.

Et — ceci est la partie que tout le monde saute — **restaurez-en une** :

```bash
ADMIN_DATABASE_URL='postgres://fasoschool_owner:…@…/postgres' \
FASOSCHOOL_PASSPHRASE='…' \
  bash scripts/restauration-verifiee.sh sauvegardes/fasoschool-20260924-0200.dump.gpg
```

Le script restaure dans une base jetable, recompte les élèves, les factures
et les bulletins, et vous dit si le chiffre correspond. Une sauvegarde qu'on
n'a jamais restaurée n'est pas une sauvegarde, c'est un fichier.

---

## 5. Les téléphones : web, Android, iOS

Il n'y a **pas d'application à installer depuis un magasin**, et c'est une
décision d'architecture, pas un raccourci.

FasoSchool est du HTML rendu au serveur, sans bundle JavaScript. Une page
pèse quelques dizaines de kilooctets et s'ouvre sur un téléphone d'entrée de
gamme en EDGE. Une application native ferait l'inverse : 20 à 40 Mo à
télécharger avant la première utilisation, un magasin à traverser à chaque
correction, et deux bases de code de plus à tenir.

Le produit s'installe quand même sur l'écran d'accueil, via la **PWA** —
`manifest.webmanifest`, icônes, service worker et page hors-ligne sont dans
le dépôt et vérifiés par `npm run test:pwa`.

**Android (Chrome)** — ouvrir l'adresse, menu ⋮, « Installer l'application ».
Chrome la propose souvent de lui-même à la deuxième visite.

**iOS (Safari)** — ouvrir l'adresse, bouton Partager, « Sur l'écran
d'accueil ». Safari n'affiche pas d'invite automatique ; il faut le dire aux
utilisateurs, et l'écran d'accueil du produit le dit.

**Ce qui marche hors ligne** : la saisie des notes. Les notes tapées sans
réseau sont mises en file et remontent à la reconnexion, avec arbitrage
explicite si le serveur a changé entre-temps (`/conflits`). Le reste — appel,
encaissement, bulletins — exige le réseau, volontairement : ce sont des
gestes qui engagent de l'argent ou un SMS à une famille.

**Firebase n'est pas utilisé et n'est pas nécessaire.** L'authentification
est par code SMS à usage unique, contre la base ; le canal vers les familles
est le SMS, parce qu'il atteint tous les téléphones du pays et pas seulement
ceux qui ont un compte Google. Si un jour les notifications push valent la
peine — pour économiser des SMS aux familles équipées de smartphones —, elles
s'ajouteront à côté du SMS, jamais à sa place.

---

## 6. Après la mise en ligne, les trois vérifications

```bash
# 1. Le service répond, et dit s'il envoie vraiment des SMS.
curl -s https://votre-domaine/sante

# 2. Les en-têtes de sécurité sont bien posés par-dessus Cloudflare.
curl -sI https://votre-domaine/connexion | grep -iE \
  'content-security-policy|strict-transport|x-frame|referrer'

# 3. Le cloisonnement tient sur la base de production.
ADMIN_DATABASE_URL=… bash scripts/epreuve-cloisonnement.sh
```

Puis, sur l'écran d'accueil du produit, lisez les **points d'attention** :
ils disent ce qui manque avant que l'établissement ne s'en aperçoive — règles
non confirmées, niveaux sans règle de passage, grille au-dessus du plafond,
familles injoignables, dossier de catégorisation non déclaré.

---

## 7. Ce qui reste, et qui n'est pas de l'informatique

- le **modèle de bulletin officiel** de la région, pour que le papier remis
  aux familles soit celui qu'elles attendent ;
- le **RCCM**, sans lequel aucun agrégateur Mobile Money n'ouvre de compte ;
- les **sept règles à confirmer**, avec un censeur, une heure, et l'arrêté
  sur la table ;
- les **paliers et plafonds de l'arrêté n°2026-101**, lus dans le texte.

Le logiciel ne les inventera pas. C'est l'erreur la plus chère qu'il pourrait
commettre : un écran d'apparence sérieuse qui conduit un établissement à
facturer un montant illégal.
