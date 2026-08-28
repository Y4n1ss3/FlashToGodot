# 🧪 Outils de test hors Adobe Animate

Ces scripts Node.js (indépendants de la chaîne JSFL) permettent de tester
`modules/godotBuilder.jsfl` et `modules/inspector.jsfl` **sans ouvrir
Adobe Animate**, à partir d'un `debug_data.json` déjà extrait d'un vrai
`.fla` (généré automatiquement par `main.jsfl` à chaque export, voir le
readme principal).

## Pourquoi

`_processElementNode` et le reste du pipeline de génération sont denses,
stateful, et sensibles à la précision numérique (géométrie, matrices de
gradient). Une régression y est facile à introduire et difficile à repérer
sans rouvrir Adobe Animate + Godot à chaque essai. Ce filet de sécurité a
été construit après une régression réelle (v4.12, voir l'historique des
versions plus bas dans ce readme) qui aurait été détectée immédiatement
avec cet outil.

## Utilisation

### 1. Réparer un vieux `debug_data.json` (si besoin)

Les `debug_data.json` générés **avant** la correction de `jsflStringify`
(voir "Historique des versions > main.jsfl" dans le readme principal) ne sont pas du JSON
strictement valide (caractères de contrôle non échappés dans du code
ActionScript collé). Un export **frais** n'a pas besoin de cette étape :

```
node tools/repair_debug_json.js chemin/vers/debug_data.json
```

Écrit `debug_data.repaired.json` à côté de l'original.

### 2. Comparer deux versions du pipeline

```
# 1. AVANT de modifier godotBuilder.jsfl/inspector.jsfl :
node tools/pipeline_snapshot.js debug_data.json /tmp/before

# 2. Faire la modification dans modules/...

# 3. APRÈS :
node tools/pipeline_snapshot.js debug_data.json /tmp/after

# 4. Comparer :
diff -rq /tmp/before /tmp/after
```

Toute différence doit être **explicable** par le changement voulu. Une
différence inattendue = régression détectée avant même d'ouvrir Godot.

### 3. Comparer contre une version historique (git)

```
git show <commit>:modules/godotBuilder.jsfl > /tmp/old_builder.jsfl
BUILDER_PATH=/tmp/old_builder.jsfl node tools/pipeline_snapshot.js debug_data.json /tmp/old_output
node tools/pipeline_snapshot.js debug_data.json /tmp/new_output
diff -rq /tmp/old_output /tmp/new_output
```

## Limites connues

- `nextId()` est rendu déterministe (compteur au lieu de `Math.random()`)
  pour permettre un diff octet-près-octet entre deux runs — sans ça, tous
  les IDs de ressources changeraient à chaque exécution même sans aucun
  changement de code.
- `FLfile.exists()` renvoie toujours `false` : aucun `project.godot` n'est
  simulé, donc `RES_PREFIX` reste `res://` (au lieu de
  `res://sous-dossier/` qu'un export réel dans un sous-dossier de projet
  calculerait). N'affecte que les chemins `ext_resource`, pas la structure
  des nodes — sans impact pour comparer deux versions du code entre elles.
- `FLfile.listFolder()` renvoie toujours `[]` : aucune texture PNG externe
  simulée. Les shapes utilisant `customTexPath` (bitmaps importés) ne sont
  pas exercées par ce harnais.
