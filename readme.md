# 🎬 Flash to Godot — Export Pipeline

A suite of optimized **JSFL scripts** for **Adobe Animate / Flash Professional** that natively exports animations, symbols, and vector shapes directly to **Godot Engine 4** (`.tscn` files).

---

## 🚀 Features

* **Native Vector Extraction (`Polygon2D`)**: Automatically converts Flash shapes and gradients into native Godot `Polygon2D` nodes. Supports complex geometry with hole management (via bridges), T-junction repair, and utilizes adaptive Casteljau subdivision for perfectly smooth Bezier curves.
* **Animation Baking**: Converts Flash interpolations (Tweens) and keyframes directly into native tracks for Godot's `AnimationPlayer` (handles `position`, `rotation`, `scale`, `visible`, and `color`). Also manages timeline slicing via Flash labels.
* **Masks & Shaders**: Faithfully reproduces Flash clipping masks (`clip_children`), *ColorTransform* effects (color offsets), and blend modes (`add`, `multiply`) through the automatic generation of dedicated `.gdshader` files.
* **Group Safety**: Non-destructive process that temporarily converts static groups into symbols to preserve their absolute transformation matrices.

---
 
## 📁 Script Project Structure

For the pipeline to work correctly, you must keep the following folder structure:

```text
📂 flash-to-godot/
│
├── 📄 main.jsfl                  # Main script (UI entry point)
│
└── 📂 modules/
    ├── 📄 inspector.jsfl      # FLA metadata analyzer and extractor
    └── 📄 godotBuilder.jsfl   # .tscn scenes, shaders, and animations compiler
```

---

## ⚙️ Configuration & Installation

### Prerequisites
- Adobe Animate (or Flash Pro with JSFL API support).
- Godot Engine 4.x (generated files target Godot 4's standard scene format 3).

### Pipeline Usage
1. Open your animation or `.fla` document in Adobe Animate.
2. Go to the top menu: **Commands > Run Command...**
3. Select the `main.jsfl` file at the root of this folder.
4. A file explorer window will open: **select the root folder of your Godot project** (the folder containing the `project.godot` file).
5. The script automatically calculates relative paths, creates the necessary folder tree, and processes the elements. You can monitor the real-time progress in the **Output** panel of Adobe Animate.

---

## 📂 Exported File Structure in Godot

Once the pipeline has finished, the following files will be generated inside your Godot project:

```text
📂 YourGodotProject/
│
├── 📄 main.tscn                  # Reconstructed main scene (active Flash scene)
│
├── 📂 shaders/                   # CanvasItem shaders to reproduce Flash effects
│   ├── 🧪 flash_color_normal.gdshader   # ColorTransform support (Offsets)
│   ├── 🧪 flash_color_add.gdshader      # "Add" / "Screen" blend mode
│   └── 🧪 flash_color_mul.gdshader      # "Multiply" blend mode
│
└── 📂 symbols/                   # Godot sub-scenes (.tscn) generated for MovieClips
    ├── 📄 MyNestedSymbol.tscn
    └── ...
```
*(Files named `debug_data.json` and `debug_log.txt` will also be generated at the root to assist in troubleshooting).*

---

## ⚠️ Notes
* **Scripts (AS3/JS)**: Code is ignored; only visual properties and animations are exported.
* **Massive Vector Files**: Very complex shapes or those with an enormous amount of details may temporarily freeze Animate's UI during the export.
* **Guide Layers**: Guide Layers are respected and exported as hidden nodes (`visible = false`).

---

## 🧪 Tests hors Adobe Animate

Le dossier [`tools/`](tools/) contient des scripts Node.js pour tester le
pipeline (`inspector.jsfl` + `godotBuilder.jsfl`) sans ouvrir Adobe Animate,
à partir d'un `debug_data.json` déjà extrait d'un vrai `.fla`. Utile avant
tout changement dans `modules/` pour détecter une régression par simple
`diff` plutôt qu'en rouvrant Godot à chaque essai. Voir
[`tools/README.md`](tools/README.md) pour l'utilisation.

---

## 📜 Historique des versions

### main.jsfl — Échappement JSON invalide dans `jsflStringify`
- **Bug** : `debug_data.json` (généré à chaque export pour le debug) n'était
  pas du JSON strictement valide au sens de la spec (RFC 8259). La fonction
  maison `jsflStringify` échappait `\`, `"`, `\n` et `\r`, mais aucun autre
  caractère de contrôle (0x00-0x1F). Le champ `actionScript` embarque
  parfois du code AS3 collé tel quel, qui peut contenir de vraies
  tabulations ou d'autres caractères de contrôle — un parseur JSON standard
  (`JSON.parse`, Python `json.load`...) rejette le fichier entier dès le
  premier caractère non échappé rencontré, même si le fichier "a l'air"
  correct à l'oeil.
- **Corrigé** : nouvelle fonction `jsonEscapeString` (échappe tous les
  caractères 0x00-0x1F, dont `\t`, en `\uXXXX` sauf les formes courtes
  `\n`/`\r`/`\t`), utilisée aux deux endroits qui dupliquaient l'ancien
  échappement partiel.
- Pour réparer un `debug_data.json` déjà généré par l'ancienne version :
  `node tools/repair_debug_json.js chemin/vers/debug_data.json`.

### godotBuilder.jsfl

*(Notes de développement en français, conservées telles quelles depuis le code source.)*

### v4.15 - Un seul VisibleOnScreenEnabler2D par sous-arbre
- Un symbole qui n'est JAMAIS placé directement par la scène principale, et qui est TOUJOURS instancié comme enfant d'au moins un autre symbole, n'a plus son propre `VisibleOnScreenEnabler2D` : l'ancêtre qui l'instancie porte déjà le sien, qui désactive via `process_mode` TOUT son sous-arbre (donc aussi l'AnimationPlayer de ce symbole) quand il sort de l'écran — un enabler ici serait redondant. Calculé une fois pour tout le projet via le graphe `referencedBy` (symbole -> quels symboles l'instancient), déjà utilisé pour la propagation des besoins en shader.
- Sécurité : un symbole garde son enabler dès qu'il est placé directement par la scène principale AU MOINS UNE FOIS, même s'il est par ailleurs aussi nesté ailleurs (usage double = pas assez sûr pour le retirer). Limite acceptée : si TOUS les parents d'un symbole s'avèrent eux-mêmes non-animés (single-frame, donc sans enabler propre), ce symbole perd son culling individuel pour rien — cas marginal en pratique.

### v4.13 - Correction du rect de VisibleOnScreenEnabler2D
- BUG (présent avant même la session qui l'a corrigé) : le rect de détection de l'enabler ignorait la taille de la bounding box réellement calculée (minX/maxX/minY/maxY) et posait une boîte FIXE de 20x20px autour de son centre. Sur un symbole animé de taille normale, ce rect minuscule sort et rentre du champ de détection à chaque léger mouvement, ce qui bascule enabled/disabled en boucle sur le node — thrashing mesuré en profiling comme des pics répétés dans le temps de "Processus" (bien pires que l'absence totale d'enabler).
- Corrigé : le rect couvre maintenant la vraie étendue (bbox frame 0 × localScaleFactor) avec une marge généreuse (50% de la taille de la bbox, mini 100px) pour absorber le débattement typique d'une animation (position/rotation/scale) que cette bbox, calculée uniquement sur la frame 0, ne capture pas.
- Une suppression pure et simple du node (-1 node/scène animée) a été envisagée à la place du correctif ; mesuré en conditions réelles, ça fait disparaître les pics mais fait tourner en continu tous les AnimationPlayer même hors écran (FPS moyen en baisse sur une salle avec plusieurs instances) — d'où le choix final de corriger le rect plutôt que de retirer le mécanisme.

### v4.12 - REVERTÉ - Promotion de la racine de scène en shape unique
- Tentative : `_promoteRootSingleShapeChild` faisait adopter par la racine d'une scène symbole le type et les propriétés de son unique enfant Polygon2D/Line2D (même principe que le "node = 1er élément" de v4.7, appliqué au root lui-même) pour économiser un node.
- **Bug confirmé en production** : quand ce shape avait son propre position/rotation/scale (cas quasi systématique — les sommets d'un symbole Flash sont presque toujours définis loin de son point d'origine), cet offset se retrouvait sur la RACINE de la scène. Or toute scène instanciée ailleurs (ex: `torche_3.tscn` instanciant `torchemanche.tscn`) déclare son propre `position` sur le node d'instance, qui REMPLACE entièrement celle de la racine instanciée (Godot ne les additionne pas). L'offset interne du shape disparaissait donc purement et simplement, décalant l'élément à l'écran.
- Contrairement à v4.9 (`_mergeSameColorSiblings`), qui cuit le transform des nodes fusionnés directement dans les sommets (donc jamais exposé à un override externe), v4.12 laissait le transform en propriété de node sur la racine — la seule position exposée à un override par l'instancieur. Un correctif correct existe (cuire le transform du shape dans son polygon/uv avant promotion, comme le fait déjà v4.9) mais n'a pas été implémenté ; la fonction a été retirée entièrement en attendant.

### v4.11 - Pré-teinte des shapes à couleur statique (color transform)
- `_bakeStaticShaderTints` : pour toute shape utilisant le shader "Advanced Color Effect" de Flash (color_mult/color_offset_255) dont la teinte ne change JAMAIS sur toute la timeline (vérifié via anim.tracks, qui contient TOUJOURS ces sous-propriétés puisque optimizeTracks ne les optimise jamais automatiquement), applique la formule exacte du shader (`clamp(tex*mult + offset/255, 0, 1)`, reprise de `flash_color_normal.gdshader`) directement aux couleurs du Gradient source, et donne au node une texture déjà teintée à la place du shader. Le node n'a alors plus besoin de matériau, et devient éligible à la fusion cross-siblings (`_markBakeableShapes`/v4.9).
- Limité au blend mode "normal" (`flash_color_normal.gdshader`) : "add"/"multiply" dépendent du contenu du framebuffer au moment du dessin (blend GPU en temps réel), impossible à reproduire en pré-teintant une texture — ces shapes gardent leur shader et restent hors fusion.
- Tourne AVANT `_setupMaterials`/`_markBakeableShapes` : une fois le matériau retiré, le node est traité comme n'importe quel autre Polygon2D statique par le reste du pipeline (v4.9-v4.10).

### v4.10 - Aplatissement des wrappers Node2D vides à 1 enfant
- `_flattenSingleChildGroups` supprime les nodes Node2D purement organisationnels (folder/layer/masque) qui n'ont qu'UN SEUL enfant, aucun transform propre (position/rotation/scale/skew identité), et dont TOUT LE SOUS-ARBRE est garanti non-animé (aucune AnimationPlayer track ne référence lui-même ni aucun descendant). L'enfant unique remonte directement chez le grand-parent sans recalcul de transform nécessaire (le wrapper retiré étant garanti identité). Les chaînes de wrappers imbriqués (folder > layer > shape) sont réduites en une seule passe.
- Restriction volontaire au cas transform-identité uniquement (pas de composition rotation/scale/skew généralisée) : les sub_resources Animation (RESET/labels) sont déjà sérialisées en texte avec des NodePath("...") en dur AVANT cette passe, donc toute suppression devait garantir qu'aucun NodePath existant n'y référence — d'où la restriction aux sous-arbres 100% statiques plutôt qu'une fusion de transform généralisée (plus risquée sans pouvoir tester contre un vrai rendu Godot).
- Tourne AVANT `_markBakeableShapes`/`_mergeSameColorSiblings` : en remontant des shapes d'un niveau, elle peut faire apparaître de nouvelles opportunités de fusion cross-siblings (v4.9).

### v4.9 - Fusion cross-elements des Polygon2D statiques de même couleur
- `_mergeSameColorSiblings` fusionne, entre nodes FRÈRES et CONSÉCUTIFS dans l'ordre de rendu, les Polygon2D statiques (marquées par `_markBakeableShapes` : aucune AnimationPlayer track ne les cible, ni elles ni un de leurs ancêtres) qui partagent exactement le même `texture` (donc la même couleur/gradient, gradCache dédupliquant déjà les couleurs identiques vers la même SubResource). Complémentaire de la fusion intra-shape déjà existante (polyGroups/sig, v4.6) qui ne fusionnait que les contours d'UN SEUL élément Flash ; celle-ci fusionne à travers des éléments Flash différents (ex: deux instances de la même feuille sur le même calque), réduisant le nombre de nodes dès le .tscn (éditeur compris).
- Chaque node fusionné amène son propre transform (position/rotation/scale/skew) : les vertices "polygon" sont ramenés dans l'espace local du parent avant fusion, l'UV n'est jamais touché (déjà correct par construction, indépendant du transform du node).
- Sécurité : ne fusionne que des nodes déjà marqués comme statiques par `_markBakeableShapes` (garantis non ciblés par une AnimationPlayer track) et sans matériau propre.

### v4.7 - Réduction du nombre de nodes (wrappers Polygon2D/Line2D)
- Deux occurrences où le code créait un wrapper Node2D inutile alors qu'un mécanisme de nommage "node lui-même = 1er élément, Poly_0/Line_0.. = suivants" existait déjà mais restait inatteignable :
  1. Shape stroke-only (0 fill, ≥1 trait) : créait Node2D + Line_0 au lieu du Line2D directement comme wrapper. Corrigé (avec démotion symétrique vers Node2D si un keyframe ultérieur ajoute un 2e trait ou un fill à la même occurrence poolée).
  2. Shape multi-fill (≥2 groupes polygones, ex: gradient + solide) : une démotion Polygon2D -> Node2D était forcée inconditionnellement dès que `polyGroups.length > 1`, rendant mort le code qui aurait gardé le node en Polygon2D (groupe 0) avec Poly_0, Poly_1... en enfants (offset -1). Démotion supprimée ; les boucles de nettoyage des slots excédentaires (excess Poly_X, `anim._maxPoly`) corrigées pour utiliser le même offset -1. `_findMaskSprite` (masques) étendu pour reconnaître le wrapper lui-même comme node visuel, plus seulement ses enfants.
- Gain : -1 node par shape stroke-only, -1 node par shape multi-fill.

### v4.6 - Polygon2D avec trous (bridge + safety net + T-junction repair)
- Quand un polyData (entrée de `elem.polygons`) possède le champ `holes`, le builder fusionne outer + holes en un seul PackedVector2Array via `_bridgeHoles`. Résultat : UN SEUL node Polygon2D au lieu de N nodes empilés (un par contour Flash). Compatible static + animation.
- v4.2 : algo de bridge robuste pour les cas multi-trous denses.
- v4.3 : safety net via `_hasSelfIntersection` (grid spatial) en garde-fou.
- v4.4 : validation per-hole avec rollback.
- v4.6 : réparation des T-jonctions (`_repairTJunctions`). `inspector.jsfl` subdivise les courbes Bézier indépendamment pour chaque contour (fill). Deux fills adjacents partagent la même courbe comme frontière, mais les points intermédiaires de subdivision diffèrent de ~0.2 unité Flash, créant des gaps triangulaires visibles entre Polygon2D adjacents. Le repair détecte les sommets d'un polygone proches d'une arête d'un autre polygone (distance < 0.5u) et les insère dans l'arête → les deux polys partagent exactement les mêmes sommets le long de leur frontière commune. Remplace l'ancien mécanisme d'inflation perpendiculaire (v4.5) qui bouchait les gaps par overlap mais déformait les petits polys.
- La détection outer/holes est faite en amont dans `inspector.jsfl` v4 (post-traitement de `s.polygons`). Voir `_groupPolygonsWithHoles`.
- Désactivé automatiquement pour les shape tweens (topologie qui change entre frames -> casserait l'interpolation des PackedVector2Array).
