/**
 * Lecture de `multipart/form-data`, juste ce qu'il faut pour un envoi de
 * fichier depuis un formulaire HTML.
 *
 * Écrit à la main plutôt qu'importé : l'alternative pèse plusieurs mégaoctets
 * de dépendances pour une fonctionnalité utilisée sur un seul écran, et le
 * dépôt tient volontairement sur `pg` seul.
 *
 * Le découpage se fait sur les octets, jamais sur une chaîne. Un fichier en
 * Windows-1252 converti en chaîne UTF-8 avant découpage perd ses accents de
 * façon irréversible — et c'est justement l'encodage que les écoles envoient.
 */

import type { IncomingMessage } from "node:http";

export interface UploadedFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface MultipartBody {
  fields: URLSearchParams;
  files: Map<string, UploadedFile>;
}

const CRLF = Buffer.from("\r\n");

/** Position de `needle` dans `hay` à partir de `from`, ou -1. */
const find = (hay: Buffer, needle: Buffer, from: number): number => hay.indexOf(needle, from);

function parseHeaders(raw: string): { name: string; filename?: string; type: string } {
  let name = "", filename: string | undefined, type = "application/octet-stream";
  for (const line of raw.split("\r\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "content-type") type = value;
    if (key === "content-disposition") {
      // name="liste"; filename="eleves 6e.csv"
      const n = value.match(/;\s*name="([^"]*)"/i);
      const f = value.match(/;\s*filename="([^"]*)"/i);
      if (n) name = n[1]!;
      if (f) filename = f[1]!;
    }
  }
  return { name, filename, type };
}

/** `true` si la requête est un envoi multipart. */
export const isMultipart = (req: IncomingMessage): boolean =>
  (req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data");

export async function readMultipart(
  req: IncomingMessage,
  maxBytes = 8_000_000,
): Promise<MultipartBody> {
  const ct = req.headers["content-type"] ?? "";
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw new Error("Envoi sans délimiteur : formulaire mal formé.");
  const boundary = (m[1] ?? m[2] ?? "").trim();
  if (!boundary) throw new Error("Envoi sans délimiteur : formulaire mal formé.");

  /* LIRE JUSQU'AU BOUT, MÊME QUAND C'EST TROP GROS.
   *
   * La première version levait l'erreur au milieu du flux, dès le dépassement.
   * Le refus s'affichait correctement — et la requête SUIVANTE du même
   * utilisateur échouait par une erreur réseau du navigateur, sans rien à
   * l'écran pour l'expliquer.
   *
   * La raison : le corps de la requête n'était pas consommé. Node répond, puis
   * détruit la connexion parce qu'il reste des octets non lus dessus ; le
   * navigateur, qui la garde ouverte (keep-alive), envoie sa requête suivante
   * dedans et reçoit un ECONNRESET. Un directeur qui essaie de joindre un scan
   * de 10 Mo obtient donc un refus poli, puis un écran cassé au clic suivant.
   *
   * On continue donc de LIRE, sans plus rien garder : les octets arrivent de
   * toute façon, le client les a déjà mis sur le fil. Au-delà d'un plafond
   * absolu on coupe pour de bon — à ce stade ce n'est plus un envoi maladroit,
   * et il n'y a plus de politesse à préserver. */
  const PLAFOND_ABSOLU = Math.max(maxBytes * 4, 64_000_000);

  const chunks: Buffer[] = [];
  let size = 0;
  let trop = false;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) {
      if (!trop) { trop = true; chunks.length = 0; }   // on libère ce qu'on avait
      if (size > PLAFOND_ABSOLU) { req.destroy(); break; }
      continue;                                        // on lit et on jette
    }
    chunks.push(c as Buffer);
  }
  if (trop) {
    throw new Error(
      `Fichier trop volumineux : ${Math.round(maxBytes / 1e6)} Mo au maximum.`);
  }
  const body = Buffer.concat(chunks);

  const sep = Buffer.from(`--${boundary}`);
  const fields = new URLSearchParams();
  const files = new Map<string, UploadedFile>();

  let pos = find(body, sep, 0);
  if (pos < 0) throw new Error("Envoi illisible : délimiteur introuvable.");

  while (pos >= 0) {
    let start = pos + sep.length;
    // « -- » après le délimiteur ferme l'envoi.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    start = find(body, CRLF, start);
    if (start < 0) break;
    start += CRLF.length;

    const headEnd = find(body, Buffer.from("\r\n\r\n"), start);
    if (headEnd < 0) break;
    const head = parseHeaders(body.subarray(start, headEnd).toString("latin1"));
    const dataStart = headEnd + 4;

    const next = find(body, sep, dataStart);
    if (next < 0) break;
    // Le CRLF qui précède le délimiteur appartient au protocole, pas au fichier.
    const dataEnd = next - CRLF.length;
    const data = body.subarray(dataStart, Math.max(dataStart, dataEnd));

    if (head.filename !== undefined) {
      if (head.filename !== "" || data.length > 0) {
        files.set(head.name, {
          filename: head.filename,
          contentType: head.type,
          bytes: Buffer.from(data),
        });
      }
    } else if (head.name) {
      fields.append(head.name, data.toString("utf-8"));
    }

    pos = next;
  }

  return { fields, files };
}
