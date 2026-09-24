#!/usr/bin/env python3
"""Dessine les icônes de l'application.

POURQUOI UN SCRIPT ET PAS QUATRE PNG DÉPOSÉS À LA MAIN.

Un binaire versionné sans sa source est un fichier que plus personne ne sait
refaire. Six mois plus tard, changer le bleu de la marque veut dire ouvrir un
éditeur d'images qu'on n'a pas. Ici, la forme est du code : elle se relit, se
corrige et se régénère à l'identique.

    python3 scripts/dessiner-icones.py

LA MARQUE. Un « F » de monogramme, tracé en géométrie pure — aucune police,
donc aucune dépendance à ce qui est installé sur la machine. Le fût et le bras
supérieur sont blancs ; LE BRAS INFÉRIEUR EST EN LATÉRITE, le rouge du stylo
avec lequel un enseignant corrige une copie. C'est le seul ornement, et il
tient à 48 pixels — la taille réelle sur l'écran d'accueil d'un téléphone.

TROIS FICHIERS, TROIS CONTRAINTES DIFFÉRENTES.

  - `any` (192, 512) : coins arrondis dessinés, car certaines surfaces posent
    l'icône telle quelle, sans masque.
  - `maskable` (512) : plein bord, marque réduite à l'intérieur de la zone sûre
    d'Android (le cercle des 80 %). Android découpe en cercle, en goutte ou en
    écusson selon le constructeur : ce qui déborde est perdu.
  - `apple-touch` (180) : plein bord, sans arrondi et sans transparence — iOS
    applique son propre gabarit et rend le fond transparent en NOIR.
"""

from PIL import Image, ImageDraw

# Exactement la couleur de la barre latérale de l'application (--navy), et non
# l'indigo voisin : l'icône du lanceur, la barre d'état d'Android et le bandeau
# de gauche doivent être le MÊME bleu. Deux bleus presque identiques se voient.
NAVY = (34, 48, 92, 255)       # --navy   #22305C
LATERITE = (168, 64, 42, 255)  # --latérite #A8402A
BLANC = (255, 255, 255, 255)

SORTIE = "public/icones"

# Le tracé du F, en fractions du côté. Une seule définition : les quatre
# fichiers ne peuvent pas diverger.
FUT = (0.335, 0.225, 0.435, 0.775)      # le montant vertical
BRAS_HAUT = (0.335, 0.225, 0.700, 0.325)  # le bras long, en haut
# Le bras court part du bord DROIT du fût, pas de son bord gauche. Dessiné à
# partir du bord gauche — première version — le rouge traversait le blanc et le
# monogramme se lisait comme un « F » barré, c'est-à-dire comme une négation.
# Accolé au fût, il redevient le bras de la lettre.
BRAS_BAS = (0.435, 0.455, 0.645, 0.555)   # le bras court — celui en rouge


def dessiner(taille: int, marge: float, arrondi: bool) -> Image.Image:
    """`marge` réduit la marque ; `arrondi` arrondit le fond.

    On dessine à huit fois la taille demandée puis on réduit : c'est ce qui
    donne des bords nets à 48 pixels sans avoir à gérer l'anticrénelage
    soi-même.
    """
    facteur = 8
    n = taille * facteur
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if arrondi:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.18), fill=NAVY)
    else:
        d.rectangle([0, 0, n - 1, n - 1], fill=NAVY)

    def barre(boite, couleur):
        x0, y0, x1, y1 = boite
        # Recentrer la marque puis la réduire de `marge`.
        c = 0.5
        e = lambda v: (v - c) * (1 - marge) + c
        d.rounded_rectangle(
            [e(x0) * n, e(y0) * n, e(x1) * n, e(y1) * n],
            radius=int(n * 0.012), fill=couleur)

    barre(FUT, BLANC)
    barre(BRAS_HAUT, BLANC)
    barre(BRAS_BAS, LATERITE)

    return img.resize((taille, taille), Image.LANCZOS)


def aplatir(img: Image.Image) -> Image.Image:
    """iOS ne gère pas la transparence des icônes : elle devient noire."""
    fond = Image.new("RGB", img.size, NAVY[:3])
    fond.paste(img, mask=img.split()[3])
    return fond


def main() -> None:
    import os
    os.makedirs(SORTIE, exist_ok=True)

    fichiers = []

    for taille in (192, 512):
        img = dessiner(taille, marge=0.0, arrondi=True)
        chemin = f"{SORTIE}/schoolfaso-{taille}.png"
        img.save(chemin, "PNG", optimize=True)
        fichiers.append(chemin)

    # Zone sûre d'Android : la marque doit tenir dans les 80 % centraux.
    # 0.30 de marge la place confortablement à l'intérieur du cercle.
    masquable = dessiner(512, marge=0.30, arrondi=False)
    masquable.save(f"{SORTIE}/schoolfaso-512-masquable.png", "PNG", optimize=True)
    fichiers.append(f"{SORTIE}/schoolfaso-512-masquable.png")

    # Apple : plein bord, aplati, sans canal alpha.
    pomme = aplatir(dessiner(180, marge=0.06, arrondi=False))
    pomme.save(f"{SORTIE}/schoolfaso-apple-180.png", "PNG", optimize=True)
    fichiers.append(f"{SORTIE}/schoolfaso-apple-180.png")

    # L'onglet du navigateur.
    dessiner(32, marge=0.0, arrondi=True).save(
        f"{SORTIE}/schoolfaso-32.png", "PNG", optimize=True)
    fichiers.append(f"{SORTIE}/schoolfaso-32.png")

    for f in fichiers:
        print(f"{f}  {os.path.getsize(f)} octets")


if __name__ == "__main__":
    main()
