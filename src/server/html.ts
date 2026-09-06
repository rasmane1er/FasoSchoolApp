/**
 * Rendu HTML côté serveur.
 *
 * Pas de framework, pas de bundle JavaScript. Une page fait 15 à 30 Ko et
 * s'affiche sur un Android bon marché derrière une connexion lente — ce qui
 * est la réalité du marché visé. Un SPA React de 500 Ko ne l'est pas.
 *
 * Polices système uniquement : Google Fonts est une requête réseau de plus au
 * chargement, et l'application doit rester utilisable quand le réseau est
 * mauvais ou absent.
 */

import { can, type SessionUser } from "./session.ts";

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

/** 13.63 -> "13,63" ; null -> "—" */
export const fr = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined ? "—" : Number(n).toFixed(d).replace(".", ",");

/** 4180000 -> "4 180 000" */
export const fcfa = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : Math.round(Number(n)).toLocaleString("fr-FR").replace(/ | /g, " ");

/** Accord du pluriel : « 1 classe », « 3 classes ». */
export const plural = (n: number, singular: string, pluralForm?: string): string =>
  `${n} ${accord(n, singular, pluralForm)}`;

/** Le mot accordé, SANS le nombre : pour une phrase qui l'a déjà cité. */
export const accord = (n: number, singular: string, pluralForm?: string): string =>
  n <= 1 ? singular : (pluralForm ?? singular + "s");

export const ordinal = (n: number | null): string =>
  n === null ? "—" : n === 1 ? "1<sup>er</sup>" : `${n}<sup>e</sup>`;

const CSS = `
:root{
  --ground:#F4F2ED; --surface:#FFFFFF; --surface2:#FBFAF7;
  --ink:#1A1C2B; --muted:#5C6072; --faint:#7A7F90;
  --rule:#E2DED5; --rule2:#EFECE5; --line:#CFCAC0;
  --navy:#22305C; --indigo:#2C3F7C; --laterite:#A8402A;
  --ochre:#9A7115; --verdant:#3B6349;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:Georgia,"Times New Roman",serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55}
a{color:var(--indigo);text-decoration:none}
a:hover{text-decoration:underline}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
h1{font-family:var(--serif);font-size:25px;font-weight:700;margin:0 0 4px;letter-spacing:-.01em}
h2{font-family:var(--serif);font-size:17px;font-weight:600;margin:0}
.shell{display:flex;min-height:100vh}

/* barre latérale */
.side{width:232px;flex-shrink:0;background:var(--navy);color:#fff;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.brand{padding:20px;border-bottom:1px solid rgba(255,255,255,.12)}
.brand b{font-family:var(--serif);font-size:21px;font-weight:700;display:block}
.brand span{font-size:11.5px;color:rgba(255,255,255,.6)}
.side nav{display:flex;flex-direction:column;gap:2px;padding:14px 12px}
.side nav a{display:block;padding:11px 12px;border-radius:5px;font-size:14px;color:rgba(255,255,255,.78);text-decoration:none}
.side nav a:hover{background:rgba(255,255,255,.07);text-decoration:none}
.side nav a.on{background:rgba(255,255,255,.13);color:#fff;font-weight:500}
.navgroupe{padding:14px 12px 5px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,.42)}
.navgroupe:first-child{padding-top:4px}
.side .foot{margin-top:auto;padding:16px 20px;border-top:1px solid rgba(255,255,255,.12);font-size:11.5px;color:rgba(255,255,255,.6)}

/* colonne principale */
.main{flex-grow:1;min-width:0;display:flex;flex-direction:column}
.top{height:60px;background:var(--surface);border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:14px;padding:0 26px;flex-shrink:0}
.top .sep{width:1px;height:16px;background:var(--rule)}
.who{margin-left:auto;display:flex;align-items:center;gap:9px}
.avatar{width:31px;height:31px;border-radius:50%;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}
.content{padding:24px 26px 48px;display:flex;flex-direction:column;gap:18px}

/* blocs */
.card{background:var(--surface);border:1px solid var(--rule);border-radius:6px;overflow:hidden}
.card>header{padding:14px 17px;border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:12px}
.card>.body{padding:16px 17px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:15px}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:15px 16px}
.tile .k{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.tile .v{font-family:var(--mono);font-size:26px;font-weight:500;line-height:1.1;margin-top:7px}
.tile .n{font-size:12.5px;margin-top:5px;color:var(--muted)}
.note{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--indigo);border-radius:0 5px 5px 0;padding:13px 16px;font-size:13.5px;line-height:1.5}
.note.warn{border-left-color:var(--ochre)}
.note.bad{border-left-color:var(--laterite)}
.note.good{border-left-color:var(--verdant)}

/* tableaux */
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);font-weight:500;padding:11px 16px;border-bottom:1.5px solid var(--line);white-space:nowrap}
tbody td{padding:11px 16px;border-bottom:1px solid var(--rule2);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr.warn{background:#FBF6E9}
tbody tr.bad{background:#FCF3F0}
td.r,th.r{text-align:right}
.scroll{overflow-x:auto}

/* pastilles */
.pill{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:3px;white-space:nowrap}
.p-ok{background:#E4EDE6;color:var(--verdant)}
.p-warn{background:#F4EBD4;color:var(--ochre)}
.p-bad{background:#F6E3DE;color:var(--laterite)}
.p-info{background:#E3E6F1;color:var(--indigo)}
/* Une observation est une phrase : elle se lit en bas de casse et revient a
   la ligne. Tronquee dans une pastille, elle ne sert a rien. */
.dit{display:block;font-size:12.5px;line-height:1.45;margin-top:3px}
.dit.bad{color:var(--laterite)}
.dit.warn{color:var(--ochre)}

/* formulaires */
label{display:block;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);margin-bottom:6px}
input[type=text],input[type=tel],input[type=number],select{
  font:inherit;width:100%;height:44px;padding:0 12px;border:1px solid var(--line);
  border-radius:5px;background:var(--surface);color:var(--ink)}
input:focus,select:focus{outline:2px solid var(--indigo);outline-offset:-1px;border-color:var(--indigo)}
input.note-cell{height:38px;width:74px;text-align:center;font-family:var(--mono);font-variant-numeric:tabular-nums;padding:0 6px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;min-width:44px;
  padding:0 18px;border:0;border-radius:5px;background:var(--indigo);color:#fff;font:inherit;
  font-size:14px;font-weight:500;cursor:pointer}
.btn:hover{background:#24356B}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.btn.ghost:hover{background:var(--surface2)}
.btn.danger{background:var(--laterite)}
/* Un geste posé dans une cellule de tableau : assez grand pour un pouce sur
   un téléphone, assez discret pour ne pas dominer la ligne. */
.btn.petit{height:34px;padding:0 11px;font-size:13px}
.gestes{white-space:nowrap}
.gestes form{display:inline-block;margin:2px 3px 2px 0}
textarea{font:inherit;font-size:13.5px;width:100%;padding:10px 12px;border:1px solid var(--line);
  border-radius:5px;background:var(--surface);color:var(--ink);resize:vertical;line-height:1.5}
textarea:focus{outline:2px solid var(--indigo);outline-offset:-1px;border-color:var(--indigo)}
.sub{margin:0;font-size:14px;line-height:1.55;color:var(--muted);max-width:64ch}
.hint{margin:6px 0 0;font-size:12.5px;line-height:1.5;color:var(--faint)}
/* Le « ou » entre deux façons de faire la meme chose : deposer, ou coller. */
.ou{display:flex;align-items:center;gap:12px;margin:20px 0;color:var(--faint);font-size:12px;
  letter-spacing:.06em;text-transform:uppercase}
.ou::before,.ou::after{content:"";flex-grow:1;height:1px;background:var(--rule)}
code{font-family:var(--mono);font-size:.92em;background:var(--surface2);padding:1px 5px;border-radius:3px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.grow{flex-grow:1}
.trois{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.err{background:#F6E3DE;color:#7C2E1D;border-radius:5px;padding:11px 14px;font-size:13.5px}
.ok{background:#E4EDE6;color:#2C4A36;border-radius:5px;padding:11px 14px;font-size:13.5px}

@media (max-width:900px){
  .shell{flex-direction:column}
  .side{width:100%;height:auto;position:static;flex-direction:row;flex-wrap:wrap;align-items:center}
  .side nav{flex-direction:row;flex-wrap:wrap;padding:8px 12px}
  .side .foot{display:none}
  .content{padding:18px 14px 40px}
  .top{padding:0 14px}
}
`;

/*
 * La navigation ne montre QUE ce que l'utilisateur peut ouvrir.
 *
 * Une enseignante à qui l'on propose « Frais » et « Catégorisation » clique,
 * reçoit « Accès refusé », et en conclut que le logiciel est cassé. Chaque
 * entrée porte donc le droit qu'elle exige, et la barre est filtrée au rendu.
 * Le contrôle d'accès reste dans les routes : ceci n'est qu'une politesse,
 * jamais une protection.
 *
 * Le regroupement suit le métier de celui qui regarde, pas l'ordre dans lequel
 * les écrans ont été écrits : quinze liens à plat, personne ne les lit.
 */
type Droit = Parameters<typeof can>[1];

interface NavEntry { href: string; label: string; key: string; droit?: Droit }

const NAV: Array<{ titre: string | null; liens: NavEntry[] }> = [
  { titre: null, liens: [
    { href: "/", label: "Tableau de bord", key: "dashboard" },
  ] },
  { titre: "Enseignement", liens: [
    { href: "/notes", label: "Notes", key: "notes", droit: "voir_notes" },
    { href: "/bulletins", label: "Bulletins", key: "bulletins", droit: "voir_notes" },
    { href: "/absences", label: "Absences", key: "absences", droit: "faire_appel" },
    { href: "/conflits", label: "Notes divergentes", key: "conflits",
      droit: "publier_bulletins" },
    { href: "/conseil", label: "Conseil de classe", key: "conseil",
      droit: "publier_bulletins" },
  ] },
  { titre: "Vie scolaire", liens: [
    { href: "/inscriptions", label: "Inscriptions", key: "inscriptions", droit: "inscrire" },
    { href: "/transferts", label: "Transferts", key: "transferts", droit: "inscrire" },
    { href: "/communiques", label: "Communiqués", key: "communiques",
      droit: "publier_bulletins" },
    { href: "/messages", label: "Suivi des messages", key: "messages",
      droit: "suivre_messages" },
  ] },
  { titre: "Administration", liens: [
    { href: "/annee", label: "Année scolaire", key: "annee", droit: "parametrer" },
    { href: "/services", label: "Services", key: "services", droit: "parametrer" },
    { href: "/parametres", label: "Règles de notation", key: "parametres",
      droit: "parametrer" },
    { href: "/frais", label: "Frais", key: "frais", droit: "voir_scolarite" },
    { href: "/scolarite", label: "Scolarité", key: "scolarite", droit: "voir_scolarite" },
    { href: "/bourses", label: "Bourses et remises", key: "bourses",
      droit: "voir_scolarite" },
    { href: "/categorisation", label: "Catégorisation", key: "categorisation",
      droit: "voir_categorisation" },
  ] },
];

function navPour(user: SessionUser, active: string): string {
  return NAV.map((groupe) => {
    const liens = groupe.liens.filter((l) => !l.droit || can(user, l.droit));
    if (liens.length === 0) return "";
    return (groupe.titre ? `<div class="navgroupe">${esc(groupe.titre)}</div>` : "")
      + liens.map((l) =>
        `<a href="${l.href}"${l.key === active ? ' class="on"' : ""}>${esc(l.label)}</a>`
      ).join("\n      ");
  }).filter(Boolean).join("\n      ");
}

export interface PageChrome {
  user: SessionUser;
  active: string;
  schoolName: string;
  context?: string;
  smsCredit?: number;
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

export function page(chrome: PageChrome, title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — FasoSchool</title>
<style>${CSS}</style>
</head>
<body>
<div class="shell">
  <aside class="side">
    <div class="brand"><b>FasoSchool</b><span>${esc(chrome.schoolName)}</span></div>
    <nav>
      ${navPour(chrome.user, chrome.active)}
    </nav>
    <div class="foot">
      ${chrome.smsCredit !== undefined
        ? `Crédit SMS<br><b class="num" style="font-size:17px;color:#fff">${fcfa(chrome.smsCredit)}</b> messages`
        : ""}
      <div style="margin-top:12px"><a href="/deconnexion" style="color:rgba(255,255,255,.7)">Se déconnecter</a></div>
    </div>
  </aside>
  <div class="main">
    <div class="top">
      ${chrome.context ? `<span style="font-size:14px;font-weight:600">${esc(chrome.context)}</span>` : ""}
      <div class="who">
        <div class="avatar">${esc(initials(chrome.user.fullName))}</div>
        <div style="line-height:1.25">
          <div style="font-size:13px;font-weight:500">${esc(chrome.user.fullName)}</div>
          <div style="font-size:11.5px;color:var(--faint)">${esc(fonctionLabel(chrome.user.fonction))}</div>
        </div>
      </div>
    </div>
    <div class="content">${body}</div>
  </div>
</div>
</body>
</html>`;
}

export function fonctionLabel(f: string | null): string {
  const map: Record<string, string> = {
    proviseur: "Proviseur", directeur: "Directeur", censeur: "Censeur",
    surveillant_general: "Surveillant général", intendant: "Intendant",
    econome: "Économe", chef_des_travaux: "Chef des travaux",
    enseignant: "Enseignant", secretaire: "Secrétaire",
  };
  return f ? (map[f] ?? f) : "—";
}

/** Page de connexion — pas de barre latérale, pas de session. */
export function loginPage(opts: {
  phone?: string; step: "phone" | "code"; error?: string; devCode?: string;
}): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connexion — FasoSchool</title>
<style>${CSS}
.split{display:flex;min-height:100vh}
.left{width:44%;max-width:460px;background:var(--navy);color:#fff;padding:44px 42px;display:flex;flex-direction:column}
.right{flex-grow:1;display:flex;align-items:center;justify-content:center;padding:32px}
.form{width:100%;max-width:360px}
@media (max-width:820px){.split{flex-direction:column}.left{width:100%;max-width:none;padding:28px}}
</style>
</head>
<body>
<div class="split">
  <div class="left">
    <div>
      <div style="font-family:var(--serif);font-size:30px;font-weight:700">FasoSchool</div>
      <div style="font-size:13px;color:rgba(255,255,255,.62);margin-top:4px">Gestion scolaire — Burkina Faso</div>
    </div>
    <div style="margin-top:52px;font-family:var(--serif);font-size:24px;font-weight:600;line-height:1.35">
      Des bulletins justes,<br>des parents prévenus,<br>un dossier prêt.
    </div>
    <div style="margin-top:auto;font-size:12.5px;color:rgba(255,255,255,.6);line-height:1.6">
      Votre numéro de téléphone est votre identifiant.<br>Aucun mot de passe à retenir.
    </div>
  </div>
  <div class="right">
    <div class="form">
      <h1>Connexion</h1>
      ${opts.step === "phone"
        ? `<p style="color:var(--muted);margin:0 0 24px">Entrez votre numéro pour recevoir un code.</p>
           ${opts.error ? `<div class="err" style="margin-bottom:16px">${esc(opts.error)}</div>` : ""}
           <form method="post" action="/connexion">
             <label for="phone">Numéro de téléphone</label>
             <input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel"
                    placeholder="70 12 34 56" required value="${esc(opts.phone ?? "")}">
             <button class="btn" style="width:100%;margin-top:18px" type="submit">Recevoir le code</button>
           </form>`
        : `<p style="color:var(--muted);margin:0 0 24px">Code envoyé au <span class="num">${esc(opts.phone)}</span>.</p>
           ${opts.error ? `<div class="err" style="margin-bottom:16px">${esc(opts.error)}</div>` : ""}
           ${opts.devCode ? `<div class="note warn" style="margin-bottom:16px">Mode démonstration — code : <b class="num">${esc(opts.devCode)}</b></div>` : ""}
           <form method="post" action="/connexion/verifier">
             <input type="hidden" name="phone" value="${esc(opts.phone)}">
             <label for="code">Code à six chiffres</label>
             <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
                    pattern="[0-9]{6}" maxlength="6" required autofocus
                    style="font-family:var(--mono);font-size:22px;letter-spacing:.35em;text-align:center">
             <button class="btn" style="width:100%;margin-top:18px" type="submit">Se connecter</button>
           </form>
           <p style="margin-top:16px"><a href="/connexion">Changer de numéro</a></p>`}
    </div>
  </div>
</div>
</body>
</html>`;
}
