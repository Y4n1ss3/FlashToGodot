// =============================================================================
// FLASH TO GODOT - PIPELINE COMPLET
// =============================================================================

(function() {
    var doc = fl.getDocumentDOM();
    if (!doc) {
        alert("Aucun document ouvert !");
        return;
    }

    fl.outputPanel.clear();
    fl.suppressAlerts = true;
    fl.showIdleMessage(false);
    fl.trace("=== DEMARRAGE DE L'EXPORT FLASH VERS GODOT ===");

    // Détermination des chemins
    var scriptURI = fl.scriptURI;
    var scriptDir = scriptURI.substring(0, scriptURI.lastIndexOf("/") + 1);
    var modulesDir = scriptDir + "modules/";
    var logURI = scriptDir + "debug_log.txt";

    FLfile.write(logURI, "=== DEBUT DU SCRIPT ===\n");
    function fileLog(msg) {
        FLfile.write(logURI, msg + "\n", "append");
        fl.trace(msg);
    }

    // Chargement des modules
    fileLog("Loading inspector.jsfl...");
    fl.runScript(modulesDir + "inspector.jsfl");
    fileLog("Loading godotBuilder.jsfl...");
    fl.runScript(modulesDir + "godotBuilder.jsfl");
    fileLog("Modules loaded.");

    // Sélection du dossier d'export
    var exportFolder = fl.browseForFolderURL("Sélectionnez le dossier racine du projet Godot");
    if (!exportFolder) {
        fileLog("Annulé.");
        return;
    }
    if (exportFolder.charAt(exportFolder.length - 1) !== '/') exportFolder += '/';

    // 1. Inspection (Extraction de la donnée)
    fileLog("[DEBUG] ETAPE 1: buildInspectorData (Extraction)");
    var fullData = buildInspectorData(doc);
    fileLog("[DEBUG] buildInspectorData termine avec succes !");

    if (!fullData) {
        alert("Erreur lors de l'inspection du document.");
        return;
    }

    // Write fullData to a JSON file for debugging using custom stringify for JSFL compatibility
    function jsflStringify(obj, depth) {
        if (depth === undefined) depth = 0;
        var indent = "";
        var childIndent = "";
        for (var i = 0; i < depth; i++) indent += "  ";
        for (var i = 0; i < depth + 1; i++) childIndent += "  ";

        var t = typeof obj;
        if (t !== "object" || obj === null) {
            if (t === "string") return '"' + obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
            return String(obj);
        } else {
            var n, v, json = [], arr = (obj && obj.constructor === Array);
            for (n in obj) {
                v = obj[n]; t = typeof v;
                if (t !== "function" && t !== "undefined") {
                    if (t === "string") v = '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
                    else if (t === "object" && v !== null) v = jsflStringify(v, depth + 1);
                    json.push(childIndent + (arr ? "" : '"' + n + '": ') + String(v));
                }
            }
            if (json.length === 0) return arr ? "[]" : "{}";
            return (arr ? "[\n" : "{\n") + json.join(",\n") + "\n" + indent + (arr ? "]" : "}");
        }
    }
    var jsonDebugPath = exportFolder + "debug_data.json";
    FLfile.write(jsonDebugPath, jsflStringify(fullData));

    // 2. Génération des fichiers .tscn et shaders
    fileLog("[DEBUG] ETAPE 2: buildGodotScenes");
    buildGodotScenes(doc, fullData, exportFolder);

    fl.trace("=== EXPORT TERMINE AVEC SUCCES ===");
    alert("Exportation Flash vers Godot terminée !\nDossier : " + exportFolder);
    fl.suppressAlerts = false;
    fl.showIdleMessage(true);
})();
