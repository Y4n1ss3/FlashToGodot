// =============================================================================
// FLASH TO GODOT - FULL PIPELINE
// =============================================================================

(function() {
    var doc = fl.getDocumentDOM();
    if (!doc) {
        alert("No document open!");
        return;
    }

    fl.outputPanel.clear();
    fl.suppressAlerts = true;
    fl.showIdleMessage(false);
    fl.trace("=== STARTING FLASH TO GODOT EXPORT ===");

    // Determine paths
    var scriptURI = fl.scriptURI;
    var scriptDir = scriptURI.substring(0, scriptURI.lastIndexOf("/") + 1);
    var modulesDir = scriptDir + "modules/";
    var logURI = scriptDir + "debug_log.txt";

    FLfile.write(logURI, "=== SCRIPT START ===\n");
    function fileLog(msg) {
        FLfile.write(logURI, msg + "\n", "append");
        fl.trace(msg);
    }

    // Load modules
    fileLog("Loading inspector.jsfl...");
    fl.runScript(modulesDir + "inspector.jsfl");
    fileLog("Loading godotBuilder.jsfl...");
    fl.runScript(modulesDir + "godotBuilder.jsfl");
    fileLog("Modules loaded.");

    // Select the export folder
    var exportFolder = fl.browseForFolderURL("Select the root folder of the Godot project");
    if (!exportFolder) {
        fileLog("Cancelled.");
        return;
    }
    if (exportFolder.charAt(exportFolder.length - 1) !== '/') exportFolder += '/';

    // 1. Inspection (data extraction)
    fileLog("[DEBUG] STEP 1: buildInspectorData (Extraction)");
    var fullData = buildInspectorData(doc);
    fileLog("[DEBUG] buildInspectorData completed successfully!");

    if (!fullData) {
        alert("Error while inspecting the document.");
        return;
    }

    // Write fullData to a JSON file for debugging using custom stringify for JSFL compatibility
    //
    // jsonEscapeString: escapes a string so it becomes a JSON literal that
    // is VALID per the strict spec (RFC 8259) -- not just readable. The
    // JSON generated here sometimes embeds ActionScript code pasted as-is
    // (e.g. `actionScript`), which can contain real tabs or other control
    // characters (0x00-0x1F). A standard JSON parser (JSON.parse, Python
    // json.load...) REJECTS any unescaped control character inside a
    // string, even if the file "looks" fine to the eye -- \n and \r alone
    // are not enough.
    function jsonEscapeString(s) {
        return s.replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r')
                .replace(/\t/g, '\\t')
                .replace(/[\x00-\x1F]/g, function(c) {
                    var hex = c.charCodeAt(0).toString(16);
                    while (hex.length < 4) hex = "0" + hex;
                    return "\\u" + hex;
                });
    }
    function jsflStringify(obj, depth) {
        if (depth === undefined) depth = 0;
        var indent = "";
        var childIndent = "";
        for (var i = 0; i < depth; i++) indent += "  ";
        for (var i = 0; i < depth + 1; i++) childIndent += "  ";

        var t = typeof obj;
        if (t !== "object" || obj === null) {
            if (t === "string") return '"' + jsonEscapeString(obj) + '"';
            return String(obj);
        } else {
            var n, v, json = [], arr = (obj && obj.constructor === Array);
            for (n in obj) {
                v = obj[n]; t = typeof v;
                if (t !== "function" && t !== "undefined") {
                    if (t === "string") v = '"' + jsonEscapeString(v) + '"';
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

    // 2. Generate the .tscn files and shaders
    fileLog("[DEBUG] STEP 2: buildGodotScenes");
    buildGodotScenes(doc, fullData, exportFolder);

    fl.trace("=== EXPORT COMPLETED SUCCESSFULLY ===");
    alert("Flash to Godot export complete!\nFolder: " + exportFolder);
    fl.suppressAlerts = false;
    fl.showIdleMessage(true);
})();
