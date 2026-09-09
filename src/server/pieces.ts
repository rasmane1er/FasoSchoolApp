/**
 * Les pièces justificatives du dossier de catégorisation.
 *
 * CE QUI ÉTAIT FAUX. `evidence_key` était un champ de texte libre, et l'écran
 * s'en servait pour classer un critère « justifié » ou « sans pièce ». Il
 * suffisait donc de TAPER quelque chose pour qu'un critère devienne justifié.
 * Rien n'était joint, rien n'était vérifié — et la démonstration semait des
 * valeurs comme `evidence/bati.pdf`, qui apprenaient à l'utilisateur que la
 * case voulait dire « un document est attaché ».
 *
 * Ce dossier décide du PLAFOND LÉGAL des frais de scolarité. Un dossier qui
 * s'annonce justifié à l'écran et se présente vide devant l'inspection fait
 * baisser le score, donc le plafond, sur une année déjà facturée.
 *
 * DÉSORMAIS : un critère est justifié s'il porte au moins un document réel.
 *
 * ---------------------------------------------------------------------------
 * TROIS RÈGLES SUR CE QU'ON ACCEPTE, ET POURQUOI.
 *
 * 1. **Liste blanche de types, pas liste noire.** PDF, JPEG, PNG, WebP. Une
 *    liste noire oublie toujours quelque chose ; une liste blanche se relit.
 *
 * 2. **Pas de SVG, alors que c'est une image.** Un SVG est un document XML qui
 *    peut porter du JavaScript. Servi depuis notre propre origine, il
 *    s'exécuterait avec le cookie de session du personnel qui l'ouvre — le
 *    directeur, précisément, puisque c'est lui qui relit le dossier. C'est du
 *    XSS stocké, déposé par un formulaire d'établissement.
 *
 * 3. **Le téléchargement est TOUJOURS une pièce jointe, jamais un affichage.**
 *    `Content-Disposition: attachment` et `X-Content-Type-Options: nosniff`.
 *    Même avec la liste blanche : le type déclaré vient du navigateur de celui
 *    qui envoie, donc de lui, et il ne décide pas de ce que le nôtre exécute.
 *    On ne fait pas confiance au fichier, on le rend.
 *
 * Le contenu est vérifié aussi par sa signature d'octets, pas seulement par
 * l'en-tête annoncé : un fichier nommé `.pdf` et déclaré `application/pdf` peut
 * être n'importe quoi.
 */

import { createHash } from "node:crypto";
import { withSchool } from "../lib/db.ts";
import { esc } from "./html.ts";
import type { SessionUser } from "./session.ts";
import type { UploadedFile } from "./multipart.ts";

export const TAILLE_MAX = 5 * 1024 * 1024;

/** Type déclaré → signature attendue en tête de fichier. */
const ACCEPTES: Array<{
  type: string; label: string; ext: string[];
  signature: (b: Buffer) => boolean;
}> = [
  { type: "application/pdf", label: "PDF", ext: [".pdf"],
    signature: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { type: "image/jpeg", label: "JPEG", ext: [".jpg", ".jpeg"],
    signature: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", label: "PNG", ext: [".png"],
    signature: (b) => b.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/webp", label: "WebP", ext: [".webp"],
    signature: (b) => b.subarray(0, 4).toString("latin1") === "RIFF"
                   && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

export const TYPES_ACCEPTES = ACCEPTES.map((a) => a.label).join(", ");

export interface Piece {
  id: string;
  label: string;
  type: string;
  taille: number;
  depose: string;
  parQui: string | null;
}

/** Les pièces d'un dossier, groupées par critère. */
export async function piecesParCritere(schoolId: string):
  Promise<Map<string, Piece[]>> {
  return withSchool(schoolId, async (c) => {
    const { rows } = await c.query(
      `select d.id, d.category_criterion_id as critere, d.label,
              d.content_type, d.byte_size,
              to_char(d.created_at, 'DD/MM/YYYY') as depose,
              u.full_name as par_qui
         from documents d
         left join users u on u.id = d.uploaded_by_user
        where d.category_criterion_id is not null and d.status = 'actif'
        order by d.created_at`);
    const m = new Map<string, Piece[]>();
    for (const r of rows) {
      const l = m.get(r.critere) ?? [];
      l.push({ id: r.id, label: r.label, type: r.content_type,
               taille: r.byte_size, depose: r.depose, parQui: r.par_qui });
      m.set(r.critere, l);
    }
    return m;
  });
}

const ko = (n: number) => n < 1024 ? `${n} o`
  : n < 1024 * 1024 ? `${Math.round(n / 1024)} Ko`
  : `${(n / (1024 * 1024)).toFixed(1)} Mo`;

export async function joindre(
  user: SessionUser, critereId: string, fichier: UploadedFile | undefined,
  label: string,
): Promise<{ flash?: string; error?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(critereId)) return { error: "Critère inconnu." };
  if (!fichier || fichier.bytes.length === 0) {
    return { error: "Aucun fichier n'a été choisi." };
  }
  if (fichier.bytes.length > TAILLE_MAX) {
    return { error: `Ce fichier fait ${ko(fichier.bytes.length)}. La limite est `
      + `${ko(TAILLE_MAX)} : au-delà, une sauvegarde ne tient plus sur une clé.` };
  }

  /* Le type annoncé et le nom sont ceux du navigateur de l'expéditeur. On
     regarde les octets. */
  const nom = fichier.filename.toLowerCase();
  const declare = (fichier.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const attendu = ACCEPTES.find((a) => a.type === declare)
    ?? ACCEPTES.find((a) => a.ext.some((e) => nom.endsWith(e)));

  if (!attendu) {
    return { error: `Ce type de fichier n'est pas accepté. Formats admis : `
      + `${TYPES_ACCEPTES}. (Pas de SVG : un SVG peut porter du code qui `
      + `s'exécuterait dans la session de celui qui l'ouvre.)` };
  }
  if (!attendu.signature(fichier.bytes)) {
    return { error: `Ce fichier s'annonce comme un ${attendu.label} mais son `
      + `contenu n'en est pas un. Il n'a pas été joint.` };
  }

  const sha = createHash("sha256").update(fichier.bytes).digest("hex");
  const titre = (label.trim() || fichier.filename).slice(0, 120);

  return withSchool(user.schoolId!, async (c) => {
    /* Le critère doit appartenir à cet établissement. Le RLS le garantit déjà
       — la lecture ne verra rien d'un autre — mais un insert sur un identifiant
       étranger échouerait alors sur la clé étrangère, avec une erreur brute.
       On préfère refuser en français. */
    const crit = (await c.query(
      `select id, code from category_criteria where id = $1`, [critereId])).rows[0];
    if (!crit) return { error: "Ce critère n'existe pas dans votre dossier." };

    const deja = (await c.query(
      `select label from documents
        where category_criterion_id = $1 and sha256 = $2 and status = 'actif'`,
      [critereId, sha])).rows[0];
    if (deja) {
      return { error: `Ce fichier est déjà joint à ${crit.code}, sous le nom `
        + `« ${deja.label} ».` };
    }

    await c.query(
      `insert into documents (school_id, category_criterion_id, label, doc_type,
                              content, content_type, byte_size, sha256,
                              uploaded_by_user)
       values (current_school_id(), $1, $2, 'declaration', $3, $4, $5, $6, $7)`,
      [critereId, titre, fichier.bytes, attendu.type,
       fichier.bytes.length, sha, user.userId]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'piece.depot', 'category_criterion', $2, $3)`,
      [user.userId, critereId,
       JSON.stringify({ label: titre, octets: fichier.bytes.length, sha256: sha })]);

    return { flash: `« ${titre} » est joint au critère ${crit.code} `
      + `(${ko(fichier.bytes.length)}).` };
  });
}

export async function retirer(user: SessionUser, id: string):
  Promise<{ flash?: string; error?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { error: "Référence inconnue." };

  return withSchool(user.schoolId!, async (c) => {
    const d = (await c.query(
      `select d.label, c.code from documents d
         join category_criteria c on c.id = d.category_criterion_id
        where d.id = $1 and d.status = 'actif'`, [id])).rows[0];
    if (!d) return { error: "Cette pièce n'existe plus." };

    /* Archivée, pas supprimée. Une pièce qui a servi à justifier un score
       déclaré au ministère ne doit pas pouvoir disparaître sans trace — c'est
       la même règle que pour les reçus. */
    await c.query(
      `update documents set status = 'archive' where id = $1`, [id]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'piece.retrait', 'document', $2, $3)`,
      [user.userId, id, JSON.stringify({ label: d.label, critere: d.code })]);

    return { flash: `« ${d.label} » est retiré du critère ${d.code}. `
      + `La pièce reste archivée, elle n'est pas effacée.` };
  });
}

export interface Telechargement {
  bytes: Buffer;
  type: string;
  nom: string;
}

export async function telecharger(user: SessionUser, id: string):
  Promise<Telechargement | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return withSchool(user.schoolId!, async (c) => {
    /* Aucun filtre sur school_id : c'est le RLS qui cloisonne. Une pièce d'un
       autre établissement ne remonte simplement pas, et l'appelant renvoie
       404 — pas 403, qui confirmerait l'existence de l'identifiant. */
    const { rows } = await c.query(
      `select content, content_type, label from documents
        where id = $1 and status = 'actif' and category_criterion_id is not null`,
      [id]);
    if (!rows[0]) return null;
    return { bytes: rows[0].content, type: rows[0].content_type,
             nom: rows[0].label };
  });
}

/** Le nom proposé au téléchargement, débarrassé de tout ce qui pourrait
 *  s'échapper de l'en-tête. */
export function nomSur(label: string, type: string): string {
  const ext = ACCEPTES.find((a) => a.type === type)?.ext[0] ?? "";
  const base = label.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, "-").slice(0, 80)
    || "piece";
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

/** Le bloc de pièces d'un critère, tel qu'il s'affiche dans le tableau. */
export function blocPieces(critereId: string, pieces: Piece[]): string {
  const liste = pieces.map((p) => `
    <div class="row" style="gap:6px;align-items:center;margin-bottom:3px">
      <a href="/categorisation/piece?id=${esc(p.id)}"
         style="font-size:13px">${esc(p.label)}</a>
      <span style="font-size:11.5px;color:var(--faint)">${ko(p.taille)}
        · ${esc(p.depose)}</span>
      <form method="post" action="/categorisation/piece/retirer" style="margin:0">
        <input type="hidden" name="id" value="${esc(p.id)}">
        <button class="btn ghost petit" type="submit">Retirer</button>
      </form>
    </div>`).join("");

  return `${liste}
    <form method="post" action="/categorisation/piece"
          enctype="multipart/form-data" class="row"
          style="gap:6px;align-items:center;margin-top:4px">
      <input type="hidden" name="critere" value="${esc(critereId)}">
      <input type="file" name="fichier" required
             accept=".pdf,.jpg,.jpeg,.png,.webp"
             style="font-size:12.5px;width:auto;height:auto;border:0;padding:0">
      <button class="btn ghost petit" type="submit">Joindre</button>
    </form>`;
}
