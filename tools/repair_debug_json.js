// Répare un debug_data.json généré par une VERSION ANTÉRIEURE de
// jsflStringify (main.jsfl) qui n'échappait pas les caractères de contrôle
// autres que \n/\r (bug corrigé depuis). Un debug_data.json généré par
// exportation FRAÎCHE (post-fix) n'a pas besoin de ce script -- JSON.parse
// suffit directement.
//
// Usage : node repair_debug_json.js <chemin/vers/debug_data.json>
// Écrit un fichier <...>.repaired.json à côté de l'original.
"use strict";

function repairJson(text) {
    var out = [];
    var inString = false;
    var i = 0;
    var n = text.length;
    while (i < n) {
        var c = text[i];
        var code = text.charCodeAt(i);
        if (inString) {
            if (c === '\\') {
                if (text[i + 1] === 'u') {
                    out.push(text.substring(i, i + 6));
                    i += 6;
                    continue;
                } else {
                    out.push(text.substring(i, i + 2));
                    i += 2;
                    continue;
                }
            } else if (c === '"') {
                inString = false;
                out.push(c);
                i++;
                continue;
            } else if (code < 0x20) {
                var hex = code.toString(16);
                while (hex.length < 4) hex = "0" + hex;
                out.push("\\u" + hex);
                i++;
                continue;
            } else {
                out.push(c);
                i++;
                continue;
            }
        } else {
            if (c === '"') inString = true;
            out.push(c);
            i++;
        }
    }
    return out.join('');
}

module.exports = { repairJson: repairJson };

if (require.main === module) {
    const fs = require('fs');
    const path = process.argv[2];
    if (!path) {
        console.error('Usage: node repair_debug_json.js <chemin/vers/debug_data.json>');
        process.exit(1);
    }
    const text = fs.readFileSync(path, 'utf8');
    const repaired = repairJson(text);
    try {
        const data = JSON.parse(repaired);
        const outPath = path.replace(/\.json$/, '.repaired.json');
        fs.writeFileSync(outPath, repaired, 'utf8');
        console.log('OK : ' + data.library.symbols.length + ' symboles, ' + data.scenes.length + ' scène(s).');
        console.log('Écrit : ' + outPath);
    } catch (e) {
        console.error('Toujours invalide après réparation : ' + e.message);
        process.exitCode = 1;
    }
}
