// Filet de sécurité pour tester godotBuilder.jsfl/inspector.jsfl SANS
// Adobe Animate : exécute le pipeline complet (buildGodotScenes) dans un
// sandbox Node.js, à partir d'un debug_data.json déjà extrait d'un vrai
// .fla (voir readme.md, "debug_data.json" est généré par main.jsfl à
// chaque export), et écrit chaque fichier "généré" sur disque pour pouvoir
// être diffé entre deux versions du code.
//
// Usage :
//   node tools/pipeline_snapshot.js <debug_data.json> <dossier_snapshot_sortie>
//
// Flux de travail pour valider un changement dans modules/godotBuilder.jsfl
// ou modules/inspector.jsfl SANS toucher Adobe Animate :
//   1. AVANT de modifier le code : générer un snapshot de référence.
//        node tools/pipeline_snapshot.js debug_data.json /tmp/before
//   2. Faire la modification.
//   3. APRÈS : régénérer dans un autre dossier.
//        node tools/pipeline_snapshot.js debug_data.json /tmp/after
//   4. Comparer :
//        diff -rq /tmp/before /tmp/after
//      Toute différence doit être EXPLICABLE par le changement voulu. Une
//      différence inattendue = régression détectée avant même d'ouvrir
//      Godot.
//
// Si debug_data.json a été généré par une version antérieure de
// jsflStringify (main.jsfl), JSON.parse peut échouer sur des caractères de
// contrôle non échappés (bug corrigé depuis) -- passer d'abord par
// tools/repair_debug_json.js dans ce cas.
"use strict";

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');

function loadData(jsonPath) {
    const text = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(text);
}

function runPipeline(data, exportDir, builderPathOverride) {
    const written = {}; // relPath -> content

    function toRel(p) {
        if (p.indexOf(exportDir) === 0) return p.substring(exportDir.length);
        return p;
    }

    const FLfile = {
        // Pas de project.godot simulé : RES_PREFIX reste "res://" (au lieu
        // du res://<sous-dossier>/ qu'un vrai export calculerait si le
        // dossier choisi est un sous-dossier du projet Godot). N'affecte
        // que les chemins ext_resource, pas la structure des nodes -- sans
        // impact pour comparer deux versions du CODE entre elles.
        exists: function() { return false; },
        // Pas de PNG externes simulés : les shapes utilisant customTexPath
        // ne seront pas exercées par ce harnais.
        listFolder: function() { return []; },
        createFolder: function() { /* no-op, capturé implicitement via write */ },
        write: function(p, content, mode) {
            const rel = toRel(p);
            if (mode === 'append' && written[rel] !== undefined) {
                written[rel] += content;
            } else {
                written[rel] = content;
            }
        },
    };
    const flObj = {
        trace: function() { /* silencieux ; mettre console.log pour debug */ },
        runScript: function() {
            throw new Error('fl.runScript ne doit pas être appelé depuis godotBuilder.jsfl/inspector.jsfl eux-mêmes');
        },
    };

    const sandbox = { fl: flObj, FLfile: FLfile };
    vm.createContext(sandbox);

    // Ordre de chargement IDENTIQUE à main.jsfl : inspector.jsfl puis
    // godotBuilder.jsfl, dans le même scope global (comme fl.runScript le
    // fait réellement en JSFL -- pas d'isolation de module).
    const inspectorSrc = fs.readFileSync(path.join(REPO_ROOT, 'modules', 'inspector.jsfl'), 'utf8');
    const builderSrc = fs.readFileSync(builderPathOverride || path.join(REPO_ROOT, 'modules', 'godotBuilder.jsfl'), 'utf8');
    vm.runInContext(inspectorSrc, sandbox, { filename: 'inspector.jsfl' });
    vm.runInContext(builderSrc, sandbox, { filename: 'godotBuilder.jsfl' });

    // nextId() utilise Math.random() en production (des IDs de ressource
    // uniques suffisent, pas besoin d'être stables) -- mais comparer deux
    // runs octet près octet demande du déterminisme. Un compteur simple
    // reproduit le même flux d'IDs à chaque exécution, tant que le code
    // appelle nextId() dans le même ordre pour les mêmes données en entrée.
    let idCounter = 1;
    sandbox.nextId = function() { return idCounter++; };

    sandbox.__data = data;
    sandbox.__exportDir = exportDir;
    vm.runInContext('buildGodotScenes(null, __data, __exportDir);', sandbox, { filename: 'harness-call' });

    return written;
}

function main() {
    const jsonPath = process.argv[2];
    const outDir = process.argv[3];
    const builderPathOverride = process.env.BUILDER_PATH; // pour comparer contre une version historique (git show <rev>:modules/godotBuilder.jsfl > /tmp/old.jsfl)
    if (!jsonPath || !outDir) {
        console.error('Usage: node tools/pipeline_snapshot.js <debug_data.json> <dossier_sortie>');
        process.exit(1);
    }

    const data = loadData(jsonPath);
    const exportDir = 'C:/fake_export/';
    const written = runPipeline(data, exportDir, builderPathOverride);

    const fileNames = Object.keys(written).sort();
    console.log('Fichiers générés par le pipeline : ' + fileNames.length);

    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const rel of fileNames) {
        const dest = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, written[rel], 'utf8');
    }
    console.log('Snapshot écrit dans : ' + outDir);

    let totalBytes = 0;
    for (const rel of fileNames) totalBytes += written[rel].length;
    console.log('Total : ' + totalBytes + ' octets sur ' + fileNames.length + ' fichiers.');
}

main();
