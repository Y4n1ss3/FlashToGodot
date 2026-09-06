// Standalone generator for "equipment variant" scenes (see buildVariantScenes
// in modules/godotBuilder.jsfl for the full explanation): some FLA libraries
// pack multiple DESIGNS of the same piece of equipment as separate FRAMES of
// a handful of parallel clips, one clip per view -- e.g. HAT/HAT_FRONT,
// HAT/HAT_BACK, HAT/HAT_LEFT, HAT/HAT_RIGHT, where frame N of each is the
// SAME hat design seen from a different angle.
//
// This script finds every such group automatically and, for each frame N
// common to all of a group's parts, writes ONE combined scene
// <output_dir>/variants/<prefix>/<N>.tscn -- one child group per orientation,
// plus an AnimationPlayer with one animation per orientation that toggles
// `visible` (gameplay picks the view with AnimationPlayer.play("FRONT")).
// Any OTHER library symbol a variant part instances internally (e.g. a
// decorative sub-shape nested inside one hat design) is grafted directly
// into the generated scene instead of left as a separate symbols/<path>.tscn
// ext_resource reference (see _inlineInstancePlaceholders in
// godotBuilder.jsfl) -- each written <N>.tscn is fully self-contained, with
// no dependency on any OTHER generated file, since these variant scenes are
// meant to be served standalone over HTTP (see rooms_godot4's own
// ItemSceneCache.gd) rather than shipped as part of the game's own project.
//
// Runs entirely in Node.js, starting from a debug_data.json already
// extracted from a real .fla (see tools/README.md) -- no Adobe Animate
// needed. Reuses the exact same rendering pipeline as a normal export
// (shapes, gradients, shaders, masks...) via the shared modules/*.jsfl code,
// loaded into a sandbox.
//
// UNLIKE tools/pipeline_snapshot.js (a pure in-memory A/B diffing tool,
// where a fake export path is fine since only two runs of the SAME code are
// ever compared against each other), this script writes REAL files under a
// REAL output_dir and does REAL filesystem checks for FLfile.exists/
// listFolder -- output_dir may be a SUBFOLDER of an existing Godot project
// (a project.godot above it), exactly like a real Adobe Animate export:
// getting this wrong silently bakes the wrong `res://` prefix into every
// ext_resource path, which Godot then fails to load ("Cannot open file").
//
// Usage:
//   node tools/build_variant_scenes.js <debug_data.json> <output_dir>
"use strict";

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');

function loadData(jsonPath) {
    const text = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(text);
}

function runVariantBuilder(data, exportDir) {
    let fileCount = 0;

    const FLfile = {
        // REAL filesystem check: exportDir may be a subfolder of an
        // existing Godot project (project.godot above it) -- getting this
        // wrong bakes the wrong `res://` prefix into every ext_resource
        // path. See the header comment.
        exists: function(p) { return fs.existsSync(p); },
        listFolder: function(p, mode) {
            try {
                const entries = fs.readdirSync(p, { withFileTypes: true });
                if (mode === 'files') return entries.filter(e => e.isFile()).map(e => e.name);
                return entries.map(e => e.name);
            } catch (e) {
                return [];
            }
        },
        createFolder: function(p) {
            try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* already exists */ }
        },
        write: function(p, content, mode) {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            if (mode === 'append') {
                fs.appendFileSync(p, content, 'utf8');
            } else {
                fs.writeFileSync(p, content, 'utf8');
            }
            fileCount++;
        },
    };
    const flObj = {
        trace: function(msg) { console.log(String(msg)); },
        runScript: function() {
            throw new Error('fl.runScript must not be called from within godotBuilder.jsfl/inspector.jsfl themselves');
        },
    };

    const sandbox = { fl: flObj, FLfile: FLfile };
    vm.createContext(sandbox);

    // Loading order IDENTICAL to main.jsfl: inspector.jsfl then
    // godotBuilder.jsfl, in the same global scope.
    const inspectorSrc = fs.readFileSync(path.join(REPO_ROOT, 'modules', 'inspector.jsfl'), 'utf8');
    const builderSrc = fs.readFileSync(path.join(REPO_ROOT, 'modules', 'godotBuilder.jsfl'), 'utf8');
    vm.runInContext(inspectorSrc, sandbox, { filename: 'inspector.jsfl' });
    vm.runInContext(builderSrc, sandbox, { filename: 'godotBuilder.jsfl' });

    // Resource IDs use Math.random() by default (fine here: this script
    // writes real, final output, not something diffed byte-for-byte across
    // two runs like tools/pipeline_snapshot.js does).
    sandbox.__data = data;
    sandbox.__exportDir = exportDir;
    vm.runInContext('buildVariantScenes(__data, __exportDir);', sandbox, { filename: 'harness-call' });

    return fileCount;
}

function main() {
    const jsonPath = process.argv[2];
    const outDir = process.argv[3];
    if (!jsonPath || !outDir) {
        console.error('Usage: node tools/build_variant_scenes.js <debug_data.json> <output_dir>');
        process.exit(1);
    }

    console.log('Loading ' + jsonPath + ' ...');
    const data = loadData(jsonPath);

    // Real, absolute output path (forward slashes -- Node's fs functions
    // accept them fine on Windows too) so FLfile.exists() can correctly
    // walk UP from it looking for a project.godot, exactly like a real
    // Adobe Animate export would.
    let exportDir = path.resolve(outDir).replace(/\\/g, '/');
    if (!exportDir.endsWith('/')) exportDir += '/';
    fs.mkdirSync(exportDir, { recursive: true });

    const fileCount = runVariantBuilder(data, exportDir);
    console.log('Files written: ' + fileCount);
    console.log('Written to: ' + exportDir);
}

main();
