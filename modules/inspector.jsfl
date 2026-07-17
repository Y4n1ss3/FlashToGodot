/**
 * SWF/FLA Inspector -> Export JSON (version étendue)
 * Script JSFL pour Adobe Animate / Flash Professional
 *
 * v4.1 - Grouping trous restreint aux cas où ça compte vraiment :
 *   - Filtre winding opposé : un VRAI trou Flash a un signed area de signe
 *     opposé à son outer (convention even-odd). Sans ce check on groupait
 *     des fills superposés du même fillKey comme s'ils étaient des trous.
 *   - Filtre opacité : pour les fills opaques (alpha=255, pas de gradient),
 *     outer + hole superposés donnent visuellement la même chose que l'outer
 *     seul, donc le bridge n'apporte rien et n'introduit que du risque earcut
 *     côté Godot. On laisse les sous-contours en polys séparés -> rendu
 *     identique, zéro risque. Le bridge n'est appliqué QUE sur fills
 *     transparents (où le compositing alpha rendrait le bridge nécessaire
 *     pour ne pas doubler l'opacité dans la zone du trou).
 *   - Filtre dégénérescence : aire < 1 u² rejetée (ghosts Flash 3-sommets
 *     quasi-colinéaires qui polluaient le bridge avec dizaines de faux trous).
 *
 * v4 - Détection des trous (holes) :
 *   - Nouveau post-traitement `_groupPolygonsWithHoles` après collecte des contours.
 *     Les polygones d'un même fill (couleur ou gradient identique) sont regroupés
 *     en relations outer -> holes via :
 *       1. tri par aire décroissante (le plus grand = outer candidat),
 *       2. test de bbox containment (cheap prefilter),
 *       3. test point-in-polygon sur centroïde + premier sommet du candidat hole.
 *     Sortie : `{ vertices: <outer>, holes: [[...], ...], color, gradient }`.
 *     Désactivé pour les shape tweens (topologie qui peut changer entre frames).
 *   - Le builder Godot exploite `holes` via la technique du bridge / keyhole pour
 *     produire UN SEUL Polygon2D au lieu de N nodes empilés.
 *
 * v3 - Suppression du fragmentage des polygones :
 *   - PLUS de _splitPolys : un contour Flash = un polygone, point.
 *     Le splitter recursif découpait à la moindre auto-intersection
 *     détectée (souvent fausse, due aux erreurs de discrétisation),
 *     ce qui produisait des centaines de fragments par scène et,
 *     pire, des morceaux toujours auto-intersectants quand le split
 *     échouait (limite de profondeur, seuil de 0.5 px ignoré sur les
 *     intersections quasi-tangentes). On laisse maintenant chaque
 *     contour intact -> Polygon2D fidèle à la forme Flash.
 *   - Helpers _ccw, _intersect, _getIntersection, _splitPolys retirés.
 *
 * v2 - Correction des polygones :
 *   - Remplace l'échantillonnage linéaire des courbes Bézier (pas fixe ~5 px,
 *     plafond 100 étapes) par une SUBDIVISION ADAPTATIVE DE CASTELJAU basée
 *     sur la planéité (perpendiculaire du point de contrôle à la corde).
 *     Tolérance de 0.05 px, profondeur max 18 -> les polygones suivent
 *     exactement les courbes Flash.
 *   - Détection de direction de la courbe simplifiée et fiable
 *     (comparaison directe des extrémités au sommet de début).
 *   - Suppression de _getT (recherche numérique imprécise) et nettoyage
 *     du code mort qui en dépendait.
 *   - Seuil de déduplication des sommets resserré (0.0001 au carré ≈ 0.01 px)
 *     pour ne supprimer que les vrais doublons.
 *   - MAX_EDGES porté à 10000 pour les contours très complexes.
 *
 * Ajouts par rapport à la version initiale (rappel) :
 *  - Tweens (motion, shape, motion object) + easing custom
 *  - Frame scripts (actionScript) et label type
 *  - Sons sur image
 *  - Transformation de couleur (RGB + alpha + brightness + tint)
 *  - blendMode, cacheAsBitmap, 3D, instanceType, symbolType, loop graphic
 *  - text.textRuns + props avancé (lineType, anti-alias, etc.)
 *  - Shape elements (primitives rect/oval, drawing object, contour count)
 *  - Layer : locked/visible/outline/color/heightMultiplier/parentLayer
 *  - Library : bitmap (hPixels/vPixels/compression), sound (bits/sampleRate),
 *    video (fps/frameCount), symbol (scalingGrid/sourceFilePath)
 *  - Document : backgroundColor, asVersion, docClass
 *  - Accessibilité, transformX/transformY, locked sur element
 */


function __log(msg) {
    if (typeof fl !== "undefined" && fl.scriptURI) {
        var scriptDir = fl.scriptURI.substring(0, fl.scriptURI.lastIndexOf("/") + 1);
        var logURI = scriptDir + "debug_log.txt";
        FLfile.write(logURI, msg + "\n", "append");
    }
}

function safeStr(v) {
    if (v === null || v === undefined) return "";
    return String(v);
}

function safeNum(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 1000) / 1000;
}

function safeBool(v) {
    return v === true;
}

function colorToHex(c) {
    if (c === null || c === undefined) return "#000000";
    if (typeof c === "string") {
        return c.charAt(0) === "#" ? c.toUpperCase() : "#" + c.toUpperCase();
    }
    var h = c.toString(16);
    while (h.length < 6) h = "0" + h;
    return "#" + h.toUpperCase();
}

function matrixToObj(m) {
    if (!m) return null;
    return {
        a:  safeNum(m.a),   b: safeNum(m.b),
        c:  safeNum(m.c),   d: safeNum(m.d),
        tx: safeNum(m.tx),  ty: safeNum(m.ty)
    };
}

function getFilters(element) {
    var result = [];
    try {
        if (element.filters && element.filters.length > 0) {
            for (var i = 0; i < element.filters.length; i++) {
                var f = element.filters[i];
                var obj = { name: safeStr(f.name) };
                var props = [
                    "blurX","blurY","strength","quality","angle","distance",
                    "color","highlightColor","shadowColor","knockout","inner",
                    "hideObject","type","saturation","hue","contrast","brightness"
                ];
                for (var j = 0; j < props.length; j++) {
                    try {
                        if (f[props[j]] !== undefined) {
                            if (props[j] === "color" || props[j] === "highlightColor" || props[j] === "shadowColor") {
                                obj[props[j]] = colorToHex(f[props[j]]);
                            } else {
                                obj[props[j]] = f[props[j]];
                            }
                        }
                    } catch(e) {}
                }

                try {
                    if (f.colors && f.colors.length !== undefined) {
                        var colors = [];
                        for (var c = 0; c < f.colors.length; c++) colors.push(colorToHex(f.colors[c]));
                        obj.colors = colors;
                    }
                } catch(e) {}
                try {
                    if (f.alphas && f.alphas.length !== undefined) {
                        var alphas = [];
                        for (var a = 0; a < f.alphas.length; a++) alphas.push(safeNum(f.alphas[a]));
                        obj.alphas = alphas;
                    }
                } catch(e) {}
                try {
                    if (f.ratios && f.ratios.length !== undefined) {
                        var ratios = [];
                        for (var r = 0; r < f.ratios.length; r++) ratios.push(safeNum(f.ratios[r]));
                        obj.ratios = ratios;
                    }
                } catch(e) {}

                result.push(obj);
            }
        }
    } catch(e) {}
    return result;
}

function getColorTransform(el) {
    var ct = null;
    try {
        if (!el.colorMode || el.colorMode === "none") return null;
    } catch(e) { return null; }

    ct = {};
    try { ct.colorMode = safeStr(el.colorMode); } catch(e) {}

    var numProps = [
        "colorRedAmount", "colorRedPercent",
        "colorGreenAmount", "colorGreenPercent",
        "colorBlueAmount", "colorBluePercent",
        "colorAlphaAmount", "colorAlphaPercent",
        "brightness", "tintPercent"
    ];
    for (var i = 0; i < numProps.length; i++) {
        try {
            var v = el[numProps[i]];
            if (v !== undefined) ct[numProps[i]] = safeNum(v);
        } catch(e) {}
    }
    try {
        if (el.tintColor !== undefined) ct.tintColor = colorToHex(el.tintColor);
    } catch(e) {}

    return ct;
}

// -----------------------------------------------------------------------------
// SUBDIVISION ADAPTATIVE DE CASTELJAU POUR COURBES BEZIER QUADRATIQUES
// Subdivise une Bézier quadratique avec un pas fixe pour garantir une symétrie parfaite
// des cercles. L'approche adaptative de Casteljau générait des polygones légèrement
// asymétriques à cause des arrondis flottants.
function _subdivideQuadratic(p1, p2, p3, outPoints, depth) {
    var dx1 = p2.x - p1.x;
    var dy1 = p2.y - p1.y;
    var dx2 = p3.x - p2.x;
    var dy2 = p3.y - p2.y;
    var len = Math.sqrt(dx1*dx1 + dy1*dy1) + Math.sqrt(dx2*dx2 + dy2*dy2);
    // =========================================================
    // RÉGLAGE DE LA QUALITÉ DES COURBES (Nombre de sommets)
    // Changez cette valeur pour ajuster les performances/visuels.
    // "High"   : Très rond, beaucoup de sommets (1 pt / 1.5 px)
    // "Medium" : Équilibre performance/visuel (1 pt / 3 px)
    // "Low"    : Optimisé, formes légèrement polygonales (1 pt / 10 px)
    // "VeryLow": Ultra optimisé pour mobile/web (1 pt / 30 px)
    // =========================================================
    var CURVE_QUALITY = "Medium"; 
    
    var divisor = 3.0;
    if (CURVE_QUALITY === "High") divisor = 1.5;
    else if (CURVE_QUALITY === "Medium") divisor = 3.0;
    else if (CURVE_QUALITY === "Low") divisor = 10.0;
    else if (CURVE_QUALITY === "VeryLow") divisor = 30.0;
    
    var steps = Math.ceil(len / divisor);
    
    // SAFETY LIMIT: Corrupted curves with Infinity/NaN coordinates or massive length.
    if (!isFinite(steps) || isNaN(steps)) steps = 3;
    if (steps > 100) steps = 100; // Limit max subdivision per curve to prevent memory/cpu freeze
    
    // Minimum vital pour qu'une courbe existe (3 pas = 1 point au milieu).
    // Si on descend en dessous de 3, les courbes deviennent des lignes droites.
    if (steps < 3) steps = 3;
    
    for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        var invT = 1.0 - t;
        var px = invT * invT * p1.x + 2 * invT * t * p2.x + t * t * p3.x;
        var py = invT * invT * p1.y + 2 * invT * t * p2.y + t * t * p3.y;
        
        // SAFETY: Ignore infinite/NaN points to prevent crashes later
        if (!isFinite(px) || !isFinite(py) || isNaN(px) || isNaN(py)) continue;
        
        outPoints.push({ x: px, y: py });
    }
}

function getAccessibility(el) {
    var acc = null;
    var accProps = ["accName","description","silent","forceSimple","tabIndex","shortcut"];
    for (var i = 0; i < accProps.length; i++) {
        try {
            var v = el[accProps[i]];
            if (v !== undefined && v !== "" && v !== null) {
                if (!acc) acc = {};
                acc[accProps[i]] = v;
            }
        } catch(e) {}
    }
    return acc;
}                                                                     

function parseXML(xmlStr) {
    if (!xmlStr) return null;
    var src = String(xmlStr);
    var i = 0;
    var n = src.length;

    function isSpace(c) { return c === " " || c === "\t" || c === "\n" || c === "\r"; }
    function skipSpace() { while (i < n && isSpace(src.charAt(i))) i++; }

    function decodeEntities(s) {
        return s
            .replace(/&lt;/g,  "<")
            .replace(/&gt;/g,  ">")
            .replace(/&quot;/g,'"')
            .replace(/&apos;/g,"'")
            .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(parseInt(d, 10)); })
            .replace(/&#x([0-9A-Fa-f]+);/g, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
            .replace(/&amp;/g, "&");
    }

    function skipPrologAndComments() {
        while (i < n) {
            skipSpace();
            if (src.substr(i, 5) === "<?xml") {
                var e1 = src.indexOf("?>", i);
                if (e1 < 0) { i = n; return; }
                i = e1 + 2;
            } else if (src.substr(i, 4) === "<!--") {
                var e2 = src.indexOf("-->", i);
                if (e2 < 0) { i = n; return; }
                i = e2 + 3;
            } else if (src.substr(i, 2) === "<!") {
                var e3 = src.indexOf(">", i);
                if (e3 < 0) { i = n; return; }
                i = e3 + 1;
            } else { break; }
        }
    }

    function parseAttrs() {
        var attrs = {};
        var has = false;
        while (i < n) {
            skipSpace();
            var c = src.charAt(i);
            if (c === ">" || c === "/" || c === "?" || c === "") break;
            var ns = i;
            while (i < n && src.charAt(i) !== "=" && !isSpace(src.charAt(i))
                   && src.charAt(i) !== ">" && src.charAt(i) !== "/") i++;
            var name = src.substring(ns, i);
            if (!name) break;
            skipSpace();
            if (src.charAt(i) !== "=") { attrs[name] = ""; has = true; continue; }
            i++;
            skipSpace();
            var q = src.charAt(i);
            if (q !== '"' && q !== "'") { attrs[name] = ""; has = true; continue; }
            i++;
            var vs = i;
            while (i < n && src.charAt(i) !== q) i++;
            attrs[name] = decodeEntities(src.substring(vs, i));
            has = true;
            if (i < n) i++;
        }
        return has ? attrs : null;
    }

    function parseElement() {
        skipSpace();
        if (i >= n || src.charAt(i) !== "<") return null;
        i++;

        var ns = i;
        while (i < n && !isSpace(src.charAt(i))
               && src.charAt(i) !== ">" && src.charAt(i) !== "/") i++;
        var name = src.substring(ns, i);

        var node = { name: name };
        var attrs = parseAttrs();
        if (attrs) node.attrs = attrs;

        skipSpace();
        if (src.charAt(i) === "/") {
            i++; if (src.charAt(i) === ">") i++;
            return node;
        }
        if (src.charAt(i) === ">") i++;

        var children = [];
        var text = "";

        while (i < n) {
            if (src.charAt(i) === "<") {
                if (src.charAt(i + 1) === "/") {
                    var ec = src.indexOf(">", i);
                    if (ec < 0) { i = n; break; }
                    i = ec + 1;
                    break;
                } else if (src.substr(i, 4) === "<!--") {
                    var ec2 = src.indexOf("-->", i);
                    if (ec2 < 0) { i = n; break; }
                    i = ec2 + 3;
                } else if (src.substr(i, 9) === "<![CDATA[") {
                    var ec3 = src.indexOf("]]>", i);
                    if (ec3 < 0) { i = n; break; }
                    text += src.substring(i + 9, ec3);
                    i = ec3 + 3;
                } else {
                    var child = parseElement();
                    if (child) children.push(child);
                }
            } else {
                text += src.charAt(i);
                i++;
            }
        }

        if (children.length > 0) node.children = children;
        var trimmed = text.replace(/^\s+|\s+$/g, "");
        if (trimmed && children.length === 0) node.text = decodeEntities(trimmed);

        return node;
    }

    skipPrologAndComments();
    return parseElement();
}


// Détecte les paires de polygones qui sont LE MÊME contour exporté deux fois
// (mêmes vertices) mais avec des windings OPPOSÉS, et garde seulement celui
// en CCW (signedArea > 0).
//
// Origine : en Flash, un edge a fillStyle1 d'un côté et fillStyle2 de l'autre.
// Quand les deux côtés ont des fills différents (ex: noir d'un côté, blanc de
// l'autre), Flash extrait UN seul edge en DEUX contours superposés parcourus
// en sens opposé. Le CCW porte la fill du côté "intérieur" (= la couleur
// réellement visible au-dessus de cet edge), le CW porte la fill du côté
// "extérieur" (= la couleur déjà fournie par le shape englobant : sclera
// blanche, iris noir, etc).
//
// Sans ce fix, on exporte les deux comme polygones distincts à exactement la
// même position. Le poly du dessus écrase l'autre selon l'ordre des children
// dans la scene Godot — d'où des symptômes "le mauvais côté est visible"
// (ex: vener Layer_4/shape_0 où le contour blanc Poly_6 du côté extérieur
// de l'iris recouvrait l'iris noir Poly_5 et donnait un iris blanc).
//
// Le CCW est gardé car il représente la fill "in-place" de ce edge. Le CW est
// redondant : son contenu sera dessiné par le polygone englobant qui partage
// déjà cet edge sur son périmètre.
function _removeOppositeWindingDuplicates(polys) {
    if (polys.length < 2) return polys;

    // Index par "clé géométrique" = vertices triés + arrondis. Permet de
    // matcher deux polygones qui ont les MÊMES vertices mais éventuellement
    // énumérés à partir d'un point de départ différent et/ou en sens opposé.
    function _geomKey(verts) {
        var pts = [];
        for (var i = 0; i < verts.length; i++) {
            pts.push(Math.round(verts[i].x * 1000) + ":" + Math.round(verts[i].y * 1000));
        }
        pts.sort();
        return pts.join("|");
    }
    function _signedArea(verts) {
        var s = 0, n = verts.length;
        for (var i = 0; i < n; i++) {
            var j = (i + 1) % n;
            s += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
        }
        return s / 2;
    }

    var byKey = {};  // "$<key>" -> array of { idx, sa }
    for (var i = 0; i < polys.length; i++) {
        var v = polys[i].vertices;
        if (!v || v.length < 3) continue;
        var key = "$" + _geomKey(v);
        var sa = _signedArea(v);
        if (!byKey[key]) byKey[key] = [];
        byKey[key].push({ idx: i, sa: sa });
    }

    var toDrop = {};
    for (var k in byKey) {
        if (!byKey.hasOwnProperty(k)) continue;
        var group = byKey[k];
        if (group.length < 2) continue;
        // Cherche une paire CCW (sa > 0) + CW (sa < 0). Si trouvée, on droppe
        // les CW. On ne touche RIEN si toutes les entrées sont du même sens
        // (cas dégénéré ou doublon non-Flash qu'on préfère préserver).
        var hasCCW = false, hasCW = false;
        for (var g = 0; g < group.length; g++) {
            if (group[g].sa > 0.001) hasCCW = true;
            else if (group[g].sa < -0.001) hasCW = true;
        }
        if (hasCCW && hasCW) {
            for (var g = 0; g < group.length; g++) {
                if (group[g].sa < -0.001) toDrop[group[g].idx] = true;
            }
        }
    }

    var dropped = 0;
    var result = [];
    for (var i = 0; i < polys.length; i++) {
        if (toDrop[i]) { dropped++; continue; }
        result.push(polys[i]);
    }
    if (dropped > 0) {
        __log("  -> _removeOppositeWindingDuplicates dropped " + dropped + " CW duplicate polys");
    }
    return result;
}

function _groupPolygonsWithHoles(polys) {
    if (!polys || polys.length <= 1) return polys;
    __log("  -> _groupPolygonsWithHoles on " + polys.length + " polys...");

    function _sa(verts) {
        var sum = 0;
        for (var i = 0; i < verts.length; i++) {
            var j = (i + 1) % verts.length;
            sum += (verts[j].x - verts[i].x) * (verts[j].y + verts[i].y);
        }
        return sum * 0.5;
    }
    function _bbox(verts) {
        var minX = verts[0].x, minY = verts[0].y, maxX = verts[0].x, maxY = verts[0].y;
        for (var i = 1; i < verts.length; i++) {
            var v = verts[i];
            if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
        }
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }
    /**
     * Les vrais trous doivent toujours être "bridgés" pour devenir un Polygon2D
     * unique dans Godot (qui n'a pas de règle even-odd native pour le remplissage
     * de multiples polygones).
     */
    function _pip(pt, verts) {
        var x = pt.x, y = pt.y;
        var inside = false;
        var n = verts.length;
        for (var i = 0, j = n - 1; i < n; j = i++) {
            var xi = verts[i].x, yi = verts[i].y;
            var xj = verts[j].x, yj = verts[j].y;
            if (((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }
    function _fillKey(p) {
        if (p.gradient) {
            var g = p.gradient;
            var k = "G:" + (g.style || "");
            if (g.colors) k += "|" + g.colors.join(",");
            if (g.pos) k += "|" + g.pos.join(",");
            if (g.matrix) {
                var m = g.matrix;
                k += "|" + m.a + "," + m.b + "," + m.c + "," + m.d + "," + m.tx + "," + m.ty;
            }
            return k;
        }
        return "C:" + (p.color || "");
    }
    // Luminance perceptuelle d'un hex #RRGGBB (formule Rec. 601). Sert de
    // tie-breaker quand plusieurs polygones ont la MÊME aire (typique des
    // formes œil/iris/highlight où une zone blanche se superpose à une
    // zone noire de même taille). Sans tie-breaker, l'ordre dépend de
    // `el.contours[]` de Flash, qui n'est pas l'ordre de dessin et varie
    // d'une keyframe à l'autre même pour des shapes visuellement identiques.
    // Avec ce tie-breaker, le plus sombre est dessiné EN PREMIER (dessous),
    // le plus clair PAR-DESSUS — convention Flash courante (highlights
    // par-dessus). Vu sur FACES : symptôme "noir cache blanc" sur mijot
    // shape_3 (3 polys [black, white, black]) et vener Layer_4 shape_0
    // (paires (white, black) à même bbox).
    function _hexLightness(hex) {
        if (!hex || typeof hex !== "string" || hex.charAt(0) !== '#') return 0;
        var r = parseInt(hex.substring(1, 3), 16) / 255.0;
        var g = parseInt(hex.substring(3, 5), 16) / 255.0;
        var b = parseInt(hex.substring(5, 7), 16) / 255.0;
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }
    function _polyLightness(p) {
        if (p.gradient && p.gradient.colors && p.gradient.colors.length > 0) {
            var sum = 0, n = p.gradient.colors.length;
            for (var i = 0; i < n; i++) sum += _hexLightness(p.gradient.colors[i]);
            return sum / n;
        }
        return _hexLightness(p.color);
    }

    var meta = [];
    for (var i = 0; i < polys.length; i++) {
        var v = polys[i].vertices;
        if (!v || v.length < 3) {
            meta.push({ idx: i, area: 0, valid: false, fillKey: "DEG:" + i, lightness: 0 });
        } else {
            var sa = _sa(v);
            meta.push({
                idx: i,
                area: Math.abs(sa),
                signedArea: sa,
                bbox: _bbox(v),
                fillKey: _fillKey(polys[i]),
                lightness: _polyLightness(polys[i]),
                valid: true
            });
        }
    }

    var order = meta.slice();
    order.sort(function(a, b) {
        var d = b.area - a.area;
        // Aires distinctes (à 0.01 près) : tri par aire DESC inchangé.
        // Aires égales (cas œil/highlight) : le plus sombre passe en
        // premier dans `order` donc dans `result` final -> dessiné dessous.
        // Le plus clair finit en queue -> dessiné par-dessus.
        if (Math.abs(d) > 0.01) return d;
        return a.lightness - b.lightness;
    });

    var assigned = {};
    var result = [];

    for (var oi = 0; oi < order.length; oi++) {
        var oM = order[oi];
        if (assigned[oM.idx]) continue;
        if (!oM.valid) {
            result.push(polys[oM.idx]);
            assigned[oM.idx] = 1;
            continue;
        }

        var outerPoly = polys[oM.idx];
        var outerVerts = outerPoly.vertices;
        var ob = oM.bbox;
        var holesVerts = [];

        // Pour les fills opaques on saute la recherche de trous : aucune
        // valeur ajoutée visuellement (superposition opaque = même rendu), et
        // ça évite le risque earcut sur les bridges complexes. Cf. _isOpaque.
        // MAIS on marque quand même les contours "trou" comme assigned pour
        // éviter qu'ils apparaissent comme polygones redondants (ex: Poly_5 lotus).
        for (var hi = 0; hi < order.length; hi++) {
            var hM = order[hi];
            if (assigned[hM.idx]) continue;
            if (hM.idx === oM.idx) continue;
            if (!hM.valid) continue;
            // Skip ghosts dégénérés : Flash exporte souvent des contours
            // 3-sommets quasi-colinéaires (area ~ 0) qui ne sont pas de vrais
            // trous. Sans ce filtre on les fait bridger -> 80+ "trous" pour le
            // moindre fill, le bridge multi-trous chie, et le safety-net jette
            // tout. Seuil = 1 unité² couvre les artefacts sans risquer de
            // virer un petit vrai trou (les vrais font typiquement >> 5 u²).
            if (hM.area < 1.0) continue;
            if (hM.area >= oM.area) continue;
            if (hM.fillKey !== oM.fillKey) continue;
            // Un VRAI trou Flash a un winding OPPOSÉ à son outer (convention
            // even-odd : outer CCW, trou CW, ou vice-versa). Deux contours du
            // même fillKey avec le MÊME signe d'aire sont des fills qui se
            // superposent (effet de couches dans Flash), pas des trous. Sans
            // ce check on bridge des polys qui ne devraient pas l'être, le
            // résultat self-touch confuse earcut côté Godot et le polygone
            // devient invisible. Cas typique : Rock1 où toutes les couches de
            // shading ont sign='-' (même winding).
            if (hM.signedArea * oM.signedArea > 0) continue;

            var hb = hM.bbox;
            if (hb.minX < ob.minX || hb.minY < ob.minY ||
                hb.maxX > ob.maxX || hb.maxY > ob.maxY) continue;

            var hVerts = polys[hM.idx].vertices;
            var cx = 0, cy = 0;
            for (var ci = 0; ci < hVerts.length; ci++) { cx += hVerts[ci].x; cy += hVerts[ci].y; }
            cx /= hVerts.length; cy /= hVerts.length;
            
            // SAFETY LIMIT: If outerVerts is huge, skip the precise point-in-polygon check.
            if (outerVerts.length <= 300) {
                if (!_pip({ x: cx, y: cy }, outerVerts)) continue;
                if (!_pip(hVerts[0], outerVerts)) continue;
            }

            // Even-odd nesting
            var insideExistingHole = false;
            for (var ehi = 0; ehi < holesVerts.length; ehi++) {
                if (holesVerts[ehi].length <= 300) {
                    if (_pip({ x: cx, y: cy }, holesVerts[ehi])) {
                        insideExistingHole = true;
                        break;
                    }
                }
            }
            if (insideExistingHole) continue;

            // Vérifier si le trou est recouvert par une ou plusieurs autres formes.
            var isCovered = false;
            
            // Si on a plus de 50 polygones au total dans le symbole, on zappe
            // completement la verification de recouvrement (isCovered).
            // Le calcul O(N^3) prendrait des milliards d'iterations.
            if (order.length <= 50) {
                var cCandidates = [];
                for (var ci = 0; ci < order.length; ci++) {
                    var cM = order[ci];
                    if (!cM.valid || cM.idx === hM.idx || cM.idx === oM.idx) continue;
                    if (cM.signedArea * oM.signedArea > 0) { // contour plein
                        if (hb.maxX >= cM.bbox.minX && hb.minX <= cM.bbox.maxX &&
                            hb.maxY >= cM.bbox.minY && hb.minY <= cM.bbox.maxY) {
                            cCandidates.push(cM);
                        }
                    }
                }

                if (cCandidates.length > 0 && cCandidates.length <= 5 && hVerts.length <= 300) {
                    var coveredCount = 0;
                    var step = Math.max(1, Math.floor(hVerts.length / 20));
                    var samples = 0;
                    for (var vi = 0; vi < hVerts.length; vi += step) {
                        samples++;
                        var hv = hVerts[vi];
                        var pointCovered = false;
                        for (var ci = 0; ci < cCandidates.length; ci++) {
                            var cM = cCandidates[ci];
                            var cVerts = polys[cM.idx].vertices;
                            
                            if (cVerts.length > 300) continue; 
                            
                            var isClose = false;
                            for (var k = 0; k < cVerts.length; k++) {
                                var dx = hv.x - cVerts[k].x;
                                var dy = hv.y - cVerts[k].y;
                                if (dx * dx + dy * dy < 2.0) { 
                                    isClose = true; break;
                                }
                            }
                            if (isClose) {
                                pointCovered = true;
                                break;
                            }
                        }
                        if (pointCovered) coveredCount++;
                    }
                    if (coveredCount >= samples * 0.8) {
                        isCovered = true;
                    }
                }
            }

            if (isCovered) {
                assigned[hM.idx] = 1;
                continue;
            }

            // C'est un vrai trou. On le passe en bridge.
            // On a besoin du bridge même pour les formes opaques, sinon on ne verrait pas
            // le fond à travers le trou (Godot triangulera le cercle plein).
            holesVerts.push(hVerts);
            assigned[hM.idx] = 1;
        }

        assigned[oM.idx] = 1;

        var entry = { vertices: outerPoly.vertices };
        if (outerPoly.color !== undefined) entry.color = outerPoly.color;
        if (outerPoly.gradient) entry.gradient = outerPoly.gradient;
        if (holesVerts.length > 0) entry.holes = holesVerts;
        result.push(entry);
    }

    __log("  <- _groupPolygonsWithHoles DONE (" + result.length + " merged polys)");
    return result;
}

// Cloner un gradient sans utiliser JSON.parse (incompatible avec certaines versions de Flash)
function _cloneGradient(grad) {
    if (!grad) return undefined;
    var g = { style: grad.style, colors: [], pos: [] };
    if (grad.colors) { for (var i = 0; i < grad.colors.length; i++) g.colors.push(grad.colors[i]); }
    if (grad.pos) { for (var i = 0; i < grad.pos.length; i++) g.pos.push(grad.pos[i]); }
    if (grad.matrix) {
        g.matrix = {
            a: grad.matrix.a, b: grad.matrix.b, c: grad.matrix.c,
            d: grad.matrix.d, tx: grad.matrix.tx, ty: grad.matrix.ty
        };
    }
    return g;
}

// Extraction des sous-boucles (trous connectés par ponts zéro-largeur)
function _extractSubLoops(p) {
    var finalPolys = [];
    var current = [];
    
    var len = p.vertices.length;
    var grid = {};
    var cellSize = 10.0; // Cellule assez grande pour capturer 0.001
    function getCell(x, y) { return Math.floor(x/cellSize) + "_" + Math.floor(y/cellSize); }

    for (var i = 0; i < len; i++) {
        var v = p.vertices[i];
        var matchedIdx = -1;
        
        var cx = Math.floor(v.x/cellSize);
        var cy = Math.floor(v.y/cellSize);
        
        // Chercher dans les 9 cellules adjacentes
        var found = false;
        for(var ox = -1; ox <= 1 && !found; ox++) {
            for(var oy = -1; oy <= 1 && !found; oy++) {
                var cellKey = (cx+ox) + "_" + (cy+oy);
                var cell = grid[cellKey];
                if (cell) {
                    // Parcourir à l'envers pour trouver le plus récent (bien que normalement un seul chevauche)
                    for (var cIdx = cell.length - 1; cIdx >= 0; cIdx--) {
                        var j = cell[cIdx];
                        if (j >= current.length - 2) continue; // Pas les 2 derniers
                        var cand = current[j];
                        var dx = cand.x - v.x;
                        var dy = cand.y - v.y;
                        if (dx*dx + dy*dy <= 0.000001) {
                            matchedIdx = j;
                            found = true;
                            break;
                        }
                    }
                }
            }
        }
        
        if (matchedIdx !== -1) {
            var loopPoly = { vertices: current.slice(matchedIdx), color: p.color };
            if (p.gradient) loopPoly.gradient = _cloneGradient(p.gradient);
            finalPolys.push(loopPoly);
            
            // Nettoyer la grille des points qui sont retirés de 'current'
            for(var k = matchedIdx; k < current.length; k++) {
                var kv = current[k];
                var kKey = getCell(kv.x, kv.y);
                if (grid[kKey]) {
                    var idxInCell = -1;
                    for(var ci=0; ci<grid[kKey].length; ci++) { if(grid[kKey][ci] === k) { idxInCell = ci; break; } }
                    if (idxInCell !== -1) grid[kKey].splice(idxInCell, 1);
                }
            }
            
            current.length = matchedIdx;
        }
        
        var cellKey = getCell(v.x, v.y);
        if (!grid[cellKey]) grid[cellKey] = [];
        grid[cellKey].push(current.length);
        
        current.push(v);
    }
    
    if (current.length > 2) {
        var remainingPoly = { vertices: current, color: p.color };
        if (p.gradient) remainingPoly.gradient = _cloneGradient(p.gradient);
        finalPolys.push(remainingPoly);
    }
    
    return finalPolys;
}

function inspectShape(el, isShapeTween, forceExtract) {
    var s = {};
    try { s.isGroup = safeBool(el.isGroup); } catch(e) {}
    try { s.isDrawingObject = safeBool(el.isDrawingObject); } catch(e) {}
    try { s.isRectangleObject = safeBool(el.isRectangleObject); } catch(e) {}
    try { s.isOvalObject = safeBool(el.isOvalObject); } catch(e) {}

    try {
        if (el.contours) {
            s.contourCount = el.contours.length;
            var isMassive = (el.width > 300 || el.height > 300);
            var isValidFill = true;
            var hasGradient = false;
            if (el.contours && el.contours.length > 0) {
                for (var c = 0; c < el.contours.length; c++) {
                    var fill = el.contours[c].fill;
                    if (fill) {
                        if (fill.style === "linearGradient" || fill.style === "radialGradient") hasGradient = true;
                        if (fill.style !== "solid" && fill.style !== "noFill" && fill.style !== "linearGradient" && fill.style !== "radialGradient") {
                            isValidFill = false;
                            break;
                        }
                    }
                }
            } else {
                isValidFill = false;
            }
            var forcePolygon = isValidFill;

            if ((isShapeTween || forcePolygon) && (!s.isGroup || el.contours)) {
                s.polygons = [];
                var contours = el.contours;
                if (contours && contours.length > 50) __log("          -> Inspecting shape with " + contours.length + " contours...");
                for (var c = 0; c < (contours ? contours.length : 0); c++) {
                    if (c > 0 && c % 100 === 0) __log("            ... processed " + c + " contours");
                    var contour = contours[c];
                        var he = contour.getHalfEdge();
                        if (!he) continue;
                        var startHe = he;
                        var poly = { vertices: [], color: "#FFFFFF" };
                        
                        try {
                            if (!contour.fill || contour.fill.style === "noFill") {
                                continue; // Skip holes or strokes with no fill
                            }
                            if (contour.fill.style === "linearGradient" || contour.fill.style === "radialGradient") {
                            poly.gradient = {
                                style: contour.fill.style,
                                colors: [],
                                pos: []
                            };
                            if (contour.fill.colorArray) {
                                for (var ca = 0; ca < contour.fill.colorArray.length; ca++) {
                                    var hc = contour.fill.colorArray[ca];
                                    if (typeof hc === "string" && hc.charAt(0) !== "#") hc = "#" + hc;
                                    poly.gradient.colors.push(hc);
                                }
                            }
                            if (contour.fill.posArray) {
                                for (var pa = 0; pa < contour.fill.posArray.length; pa++) {
                                    poly.gradient.pos.push(contour.fill.posArray[pa]);
                                }
                            }
                            if (contour.fill.matrix) {
                                poly.gradient.matrix = {
                                    a: contour.fill.matrix.a,
                                    b: contour.fill.matrix.b,
                                    c: contour.fill.matrix.c,
                                    d: contour.fill.matrix.d,
                                    tx: contour.fill.matrix.tx,
                                    ty: contour.fill.matrix.ty
                                };
                            }
                        } else if (contour.fill.color) {
                            poly.color = contour.fill.color;
                        }
                    } catch(e) {}


                    var rawEdges = [];
                    var MAX_EDGES = 10000;
                    var edgeCount = 0;
                    
                    // PASS 1: Collecter toutes les arêtes géométriques brutes
                    do {
                        var v = he.getVertex();
                        var edge = he.getEdge();
                        
                        if (edge && v) {
                            var pt0 = edge.getControl(0);
                            var ptEnd = edge.getControl(2) || edge.getControl(1);
                            
                            if (pt0 && ptEnd) {
                                var d0 = (pt0.x - v.x)*(pt0.x - v.x) + (pt0.y - v.y)*(pt0.y - v.y);
                                var dE = (ptEnd.x - v.x)*(ptEnd.x - v.x) + (ptEnd.y - v.y)*(ptEnd.y - v.y);

                                var startP, endP;
                                if (d0 <= dE) {
                                    startP = pt0; endP = ptEnd;
                                } else {
                                    startP = ptEnd; endP = pt0;
                                }

                                var pts = [];
                                pts.push({x: startP.x, y: startP.y});

                                if (!edge.isLine) {
                                    var pt1 = edge.getControl(1);
                                    if (pt1) {
                                        var curvePts = [];
                                        _subdivideQuadratic(startP, pt1, endP, curvePts, 0);
                                        for (var sp = 0; sp < curvePts.length - 1; sp++) {
                                            pts.push({x: curvePts[sp].x, y: curvePts[sp].y});
                                        }
                                    }
                                }
                                pts.push({x: endP.x, y: endP.y});
                                
                                rawEdges.push({
                                    start: {x: startP.x, y: startP.y},
                                    end: {x: endP.x, y: endP.y},
                                    pts: pts,
                                    used: false
                                });
                            }
                        }

                        he = he.getNext();
                        edgeCount++;
                    } while (he && he.id !== startHe.id && edgeCount < MAX_EDGES);

                    // PASS 2: Assemblage parfait (Flash donne les arêtes dans le sens inverse de la géométrie)
                    // On inverse simplement le tableau pour les avoir dans le bon ordre continu !
                    rawEdges.reverse();


                    var currentPoly = null;
                    var currentEnd = null;

                    for (var i = 0; i < rawEdges.length; i++) {
                        var edgeData = rawEdges[i];

                        var isJump = false;
                        if (currentEnd != null) {
                            var dx = currentEnd.x - edgeData.start.x;
                            var dy = currentEnd.y - edgeData.start.y;
                            if (dx*dx + dy*dy > 1.0) isJump = true;
                        }

                        if (currentPoly == null || isJump) {
                            if (currentPoly != null && currentPoly.vertices.length > 2) {
                                var subPolys = _extractSubLoops(currentPoly);
                                for (var spIdx = 0; spIdx < subPolys.length; spIdx++) {
                                    s.polygons.push(subPolys[spIdx]);
                                }
                            }
                            
                            currentPoly = { vertices: [], color: poly.color };
                            if (poly.gradient) currentPoly.gradient = _cloneGradient(poly.gradient);
                            currentEnd = null;
                        }

                        if (currentPoly.vertices.length === 0) {
                            currentPoly.vertices.push(edgeData.pts[0]);
                        }
                        
                        for (var p = 1; p < edgeData.pts.length; p++) {
                            var lastV = currentPoly.vertices[currentPoly.vertices.length - 1];
                            var pt = edgeData.pts[p];
                            var ddx = pt.x - lastV.x;
                            var ddy = pt.y - lastV.y;
                            if (ddx*ddx + ddy*ddy >= 0.0001) currentPoly.vertices.push(pt);
                        }

                        currentEnd = edgeData.end;
                    }

                    if (currentPoly != null && currentPoly.vertices.length > 2) {
                        var subPolys = _extractSubLoops(currentPoly);
                        for (var spIdx = 0; spIdx < subPolys.length; spIdx++) {
                            s.polygons.push(subPolys[spIdx]);
                        }
                    }
                }

                // v4 - Détection des trous : on regroupe les contours d'un même fill
                // en relations outer -> holes. Désactivé pour les shape tweens
                // (topologie qui peut changer entre frames -> casserait l'interpolation).
                if (s.polygons.length > 1 && !isShapeTween) {
                    // Avant le hole-grouping : éliminer les paires CCW/CW
                    // superposées (deux fillStyles de chaque côté d'un edge
                    // partagé exportés comme 2 polys distincts à même position).
                    // Sans ça, le CW redondant cache le CCW visible.
                    s.polygons = _removeOppositeWindingDuplicates(s.polygons);
                    s.polygons = _groupPolygonsWithHoles(s.polygons);
                }
            }
        }
    } catch(e) {}

    try {
        if (el.edges && el.edges.length > 0) {
            var rawStrokes = [];
            __log("    -> Inspecting " + el.edges.length + " edges for strokes...");
            
            if (el.edges.length > 10000) {
                __log("    [WARNING] Too many edges (" + el.edges.length + "). Skipping stroke extraction to prevent freeze.");
            } else {
                for (var i = 0; i < el.edges.length; i++) {
                    var edge = el.edges[i];
                    if (edge.stroke && edge.stroke.color) {
                        var pts = [];
                    var p0 = edge.getControl(0);
                    pts.push({x: p0.x, y: p0.y});
                    var p2 = edge.getControl(2);
                    if (!edge.isLine) {
                        var p1 = edge.getControl(1);
                        if (p1) {
                            var curvePts = [];
                            _subdivideQuadratic(p0, p1, p2, curvePts, 0);
                            for (var sp = 0; sp < curvePts.length - 1; sp++) {
                                pts.push({x: curvePts[sp].x, y: curvePts[sp].y});
                            }
                        }
                    }
                    pts.push({x: p2.x, y: p2.y});
                    
                    rawStrokes.push({
                        color: colorToHex(edge.stroke.color),
                        thickness: edge.stroke.thickness || 1,
                        pts: pts
                    });
                }
            }
            } // Close 'else' block
            
            if (rawStrokes.length > 0) {
                __log("    -> Grouping " + rawStrokes.length + " stroke segments...");
                
                // SAFETY LIMIT: If there are too many stroke segments, skip grouping.
                // Grouping is O(N^2) and will freeze JSFL. Ungrouped strokes will just
                // be drawn as individual Line2Ds, which is fine.
                if (rawStrokes.length > 1000) {
                    __log("      [WARNING] Too many stroke segments (" + rawStrokes.length + "). Skipping grouping to prevent freeze.");
                    s.strokes = rawStrokes;
                } else {
                    var strokeGroups = {};
                    for (var i = 0; i < rawStrokes.length; i++) {
                        var key = rawStrokes[i].color + "_" + rawStrokes[i].thickness;
                        if (!strokeGroups[key]) strokeGroups[key] = { color: rawStrokes[i].color, thickness: rawStrokes[i].thickness, segments: [] };
                        strokeGroups[key].segments.push(rawStrokes[i]);
                    }
                    
                    s.strokes = [];
                    for (var key in strokeGroups) {
                        var group = strokeGroups[key];
                        var segments = group.segments;
                        var used = [];
                        for(var i=0; i<segments.length; i++) used[i] = false;
                        
                        for (var i = 0; i < segments.length; i++) {
                            if (used[i]) continue;
                            used[i] = true;
                            var polyline = segments[i].pts.slice();
                            
                            var growing = true;
                            while(growing) {
                                growing = false;
                                var startPt = polyline[0];
                                var endPt = polyline[polyline.length - 1];
                                
                                for (var j = 0; j < segments.length; j++) {
                                    if (used[j]) continue;
                                    var sPts = segments[j].pts;
                                    var sStart = sPts[0];
                                    var sEnd = sPts[sPts.length - 1];
                                    
                                    var dx1 = endPt.x - sStart.x, dy1 = endPt.y - sStart.y;
                                    if (dx1*dx1 + dy1*dy1 < 0.01) {
                                        for(var k=1; k<sPts.length; k++) polyline.push(sPts[k]);
                                        used[j] = true; growing = true; break;
                                    }
                                    var dx2 = endPt.x - sEnd.x, dy2 = endPt.y - sEnd.y;
                                    if (dx2*dx2 + dy2*dy2 < 0.01) {
                                        for(var k=sPts.length-2; k>=0; k--) polyline.push(sPts[k]);
                                        used[j] = true; growing = true; break;
                                    }
                                    var dx3 = startPt.x - sEnd.x, dy3 = startPt.y - sEnd.y;
                                    if (dx3*dx3 + dy3*dy3 < 0.01) {
                                        for(var k=sPts.length-2; k>=0; k--) polyline.unshift(sPts[k]);
                                        used[j] = true; growing = true; break;
                                    }
                                    var dx4 = startPt.x - sStart.x, dy4 = startPt.y - sStart.y;
                                    if (dx4*dx4 + dy4*dy4 < 0.01) {
                                        for(var k=1; k<sPts.length; k++) polyline.unshift(sPts[k]);
                                        used[j] = true; growing = true; break;
                                    }
                                }
                            }
                            
                            var simplified = [polyline[0]];
                            for (var p = 1; p < polyline.length; p++) {
                                var lastV = simplified[simplified.length - 1];
                                var pt = polyline[p];
                                var ddx = pt.x - lastV.x, ddy = pt.y - lastV.y;
                                if (ddx*ddx + ddy*ddy >= 0.0001) simplified.push(pt);
                            }
                            
                            s.strokes.push({
                                color: group.color,
                                thickness: group.thickness,
                                pts: simplified
                            });
                        }
                    }
                }
                __log("    <- Stroke grouping DONE (" + s.strokes.length + " merged lines)");
            }
        }
    } catch(e) {}

    if (s.isRectangleObject) {
        var rectProps = ["topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius","lockFlag"];
        for (var i = 0; i < rectProps.length; i++) {
            try { if (el[rectProps[i]] !== undefined) s[rectProps[i]] = el[rectProps[i]]; } catch(e) {}
        }
    }

    if (s.isOvalObject) {
        var ovalProps = ["startAngle","endAngle","innerRadius","closePath"];
        for (var i = 0; i < ovalProps.length; i++) {
            try { if (el[ovalProps[i]] !== undefined) s[ovalProps[i]] = el[ovalProps[i]]; } catch(e) {}
        }
    }
    
    __log("    <- inspectShape DONE");
    return s;
}

function inspectInstance(el) {
    var ins = {};
    try { ins.instanceType = safeStr(el.instanceType); } catch(e) {}
    try { ins.symbolName = safeStr(el.libraryItem ? el.libraryItem.name : ""); } catch(e) {}
    try { ins.symbolType = safeStr(el.symbolType); } catch(e) {}
    try { ins.blendMode = safeStr(el.blendMode); } catch(e) {}
    try { if (el.cacheAsBitmap !== undefined) ins.cacheAsBitmap = safeBool(el.cacheAsBitmap); } catch(e) {}

    try { if (el.loop !== undefined) ins.loop = safeStr(el.loop); } catch(e) {}
    try { if (el.firstFrame !== undefined) ins.firstFrame = safeNum(el.firstFrame); } catch(e) {}
    try { if (el.loopMode !== undefined) ins.loopMode = safeStr(el.loopMode); } catch(e) {}


    var props3D = ["rotationX","rotationY","rotationZ","transformX","transformY","transformZ"];
    for (var i = 0; i < props3D.length; i++) {
        try {
            var v = el[props3D[i]];
            if (v !== undefined && v !== 0) ins[props3D[i]] = safeNum(v);
        } catch(e) {}
    }
    try {
        if (el.matrix3D) {
            ins.matrix3D = {};
            var keys3D = ["a","b","c","d","e","f","g","h","i","j","k","l","tx","ty","tz"];
            for (var k = 0; k < keys3D.length; k++) {
                try {
                    if (el.matrix3D[keys3D[k]] !== undefined) ins.matrix3D[keys3D[k]] = safeNum(el.matrix3D[keys3D[k]]);
                } catch(e) {}
            }
        }
    } catch(e) {}

    return ins;
}

function inspectTextRuns(textEl) {
    var runs = [];
    try {
        if (!textEl.textRuns) return runs;
        for (var i = 0; i < textEl.textRuns.length; i++) {
            var r = textEl.textRuns[i];
            var run = { characters: safeStr(r.characters), attrs: {} };
            try {
                var a = r.textAttrs;
                if (a) {
                    var attrProps = [
                        "face","size","fillColor","letterSpacing","alignment",
                        "indent","leftMargin","rightMargin","lineSpacing",
                        "alias","autoKern","bold","italic",
                        "characterPosition","rotation","target","url"
                    ];
                    for (var j = 0; j < attrProps.length; j++) {
                        try {
                            var v = a[attrProps[j]];
                            if (v === undefined) continue;
                            if (attrProps[j] === "fillColor") run.attrs.fillColor = colorToHex(v);
                            else run.attrs[attrProps[j]] = v;
                        } catch(e) {}
                    }
                }
            } catch(e) {}
            runs.push(run);
        }
    } catch(e) {}
    return runs;
}

function inspectText(el) {
    var t = {};
    try { t.textType = safeStr(el.textType); } catch(e) {}
    try { t.rawText = safeStr(el.getTextString()); } catch(e) {}
    try { t.fontName = safeStr(el.face); } catch(e) {}
    try { t.fontSize = safeNum(el.size); } catch(e) {}
    try { t.fontColor = colorToHex(el.fillColor); } catch(e) {}

    var props = [
        "lineType","orientation","scrollable","selectable","renderAsHTML",
        "border","useDeviceFonts","maxCharacters","password","variableName",
        "antiAliasSharpness","antiAliasThickness","fontRenderingMode",
        "embeddedCharacters","embedRanges","letterSpacing","lineSpacing"
    ];
    for (var i = 0; i < props.length; i++) {
        try {
            var v = el[props[i]];
            if (v !== undefined && v !== "" && v !== null) t[props[i]] = v;
        } catch(e) {}
    }

    t.textRuns = inspectTextRuns(el);
    return t;
}

function inspectElement(el, depth, isShapeTween, forceExtract) {
    if (!el) return null;
    depth = depth || 0;

    var obj = {
        elementType:   safeStr(el.elementType),
        name:          safeStr(el.name),
        depth:         depth
    };

    try {
        obj.x = safeNum(el.x); obj.y = safeNum(el.y);
        obj.width = safeNum(el.width); obj.height = safeNum(el.height);
        obj.left = safeNum(el.left); obj.top = safeNum(el.top);
        obj.rotation = safeNum(el.rotation);
        obj.scaleX = safeNum(el.scaleX); obj.scaleY = safeNum(el.scaleY);
        obj.skewX = safeNum(el.skewX); obj.skewY = safeNum(el.skewY);
        obj.transformX = safeNum(el.transformX); obj.transformY = safeNum(el.transformY);
        obj.matrix = matrixToObj(el.matrix);
    } catch(e) {}

    try { obj.visible = el.visible; } catch(e) {}
    try { obj.locked = safeBool(el.locked); } catch(e) {}

    var ct = getColorTransform(el);
    if (ct) obj.colorTransform = ct;

    obj.filters = getFilters(el);

    var acc = getAccessibility(el);
    if (acc) obj.accessibility = acc;

    if (el.elementType === "instance") {
        var ins = inspectInstance(el);
        for (var k in ins) if (ins.hasOwnProperty(k)) obj[k] = ins[k];
    } else if (el.elementType === "text") {
        var tx = inspectText(el);
        for (var k2 in tx) if (tx.hasOwnProperty(k2)) obj[k2] = tx[k2];
    } else if (el.elementType === "shape") {
        if (el.isGroup && el.members && el.members.length > 0) {
            obj.elementType = "group";
            obj.isGroup = true;
            obj.members = [];
            for (var m = 0; m < el.members.length; m++) {
                try {
                    var member = inspectElement(el.members[m], depth + 1, isShapeTween, true);
                    if (member) obj.members.push(member);
                } catch(e) {}
            }
            // Un groupe peut aussi avoir des raw fills dessinés directement en son sein
            // (accessibles via el.contours sur le groupe lui-même, pas via el.members).
            // On les extrait séparément et on les stocke dans obj.shapes.
            try {
                if (el.contours && el.contours.length > 0) {
                    var grpSh = inspectShape(el, isShapeTween, true);
                    if (grpSh.polygons && grpSh.polygons.length > 0) obj.shapes = grpSh.polygons;
                    if (grpSh.strokes && grpSh.strokes.length > 0) obj.strokes = grpSh.strokes;
                }
            } catch(e) {}
        } else {
            var sh = inspectShape(el, isShapeTween, forceExtract);
            for (var k3 in sh) if (sh.hasOwnProperty(k3)) obj[k3] = sh[k3];
        }
    }

    return obj;
}
                                                                           

function inspectTween(kf) {
    var t = {};
    try { t.tweenType = safeStr(kf.tweenType); } catch(e) { t.tweenType = "none"; }
    if (t.tweenType === "none" || t.tweenType === "") return t;

    try { t.tweenEasing = safeNum(kf.tweenEasing); } catch(e) {}
    try { t.hasCustomEase = safeBool(kf.hasCustomEase); } catch(e) {}
    try { t.useSingleEaseCurve = safeBool(kf.useSingleEaseCurve); } catch(e) {}

    if (t.tweenType === "motion") {
        try { t.motionTweenSnap = safeBool(kf.motionTweenSnap); } catch(e) {}
        try { t.motionTweenSync = safeBool(kf.motionTweenSync); } catch(e) {}
        try { t.motionTweenOrientToPath = safeBool(kf.motionTweenOrientToPath); } catch(e) {}
        try { t.motionTweenRotate = safeStr(kf.motionTweenRotate); } catch(e) {}
        try { t.motionTweenRotateTimes = safeNum(kf.motionTweenRotateTimes); } catch(e) {}
        try { t.motionTweenScale = safeBool(kf.motionTweenScale); } catch(e) {}
    } else if (t.tweenType === "shape") {
        try { t.shapeTweenBlend = safeStr(kf.shapeTweenBlend); } catch(e) {}
    } else if (t.tweenType === "motion object") {
        try {
            var xml = null;
            if (typeof kf.getMotionObjectXML === "function") {
                xml = kf.getMotionObjectXML();
            } else if (kf.motionObjectXML !== undefined) {
                xml = kf.motionObjectXML;
            }
            if (xml) {
                var parsed = parseXML(xml);
                if (parsed) {
                    t.motionObject = parsed;
                } else {
                    t.motionObjectXML = safeStr(xml);
                }
            }
        } catch(e) {}
        try { if (kf.hasMotionPath !== undefined) t.hasMotionPath = safeBool(kf.hasMotionPath); } catch(e) {}
    }

    if (t.hasCustomEase) {
        try {
            var easeProps = t.useSingleEaseCurve
                ? ["all"]
                : ["position","rotation","scale","color","filters"];
            t.customEase = {};
            for (var i = 0; i < easeProps.length; i++) {
                try {
                    var pts = kf.getCustomEase(easeProps[i]);
                    if (pts && pts.length) {
                        var arr = [];
                        for (var j = 0; j < pts.length; j++) {
                            arr.push({ x: safeNum(pts[j].x), y: safeNum(pts[j].y) });
                        }
                        t.customEase[easeProps[i]] = arr;
                    }
                } catch(e) {}
            }
        } catch(e) {}
    }

    return t;
}

function inspectFrameSound(kf) {
    try {
        if (kf.soundLibraryItem) {
            return {
                libraryItemName: safeStr(kf.soundLibraryItem.name),
                soundName: safeStr(kf.soundName),
                sync: safeStr(kf.soundSync),
                effect: safeStr(kf.soundEffect),
                loop: safeNum(kf.soundLoop),
                loopMode: safeStr(kf.soundLoopMode)
            };
        }
    } catch(e) {}
    return null;
}                                                                          

function inspectKeyframe(kf, absFrame, layer, timeline, isBakedShapeTweenLayer) {
    if (!kf) return null;
    var isShapeTween = (kf.tweenType === "shape") || isBakedShapeTweenLayer;
    var obj = {
        startFrame: isShapeTween ? absFrame : kf.startFrame,
        duration: isShapeTween ? 1 : kf.duration,
        name: safeStr(kf.name),
        elements: []
    };

    try { obj.labelType = safeStr(kf.labelType); } catch(e) {}

    try {
        var as = safeStr(kf.actionScript);
        if (as) obj.actionScript = as;
    } catch(e) {}

    var tw = inspectTween(kf);
    if (tw && tw.tweenType && tw.tweenType !== "none" && tw.tweenType !== "") {
        if (isShapeTween) tw.tweenType = "none";
        obj.tween = tw;
    }

    var snd = inspectFrameSound(kf);
    if (snd) obj.sound = snd;

    try {
        var elementsToInspect = kf.elements;
        if (isShapeTween && layer && layer.frames && layer.frames[absFrame]) {
            elementsToInspect = layer.frames[absFrame].elements;
        }

        if (elementsToInspect && elementsToInspect.length > 0) {
            if (elementsToInspect.length > 100) __log("          -> Inspecting " + elementsToInspect.length + " elements...");
            for (var i = 0; i < elementsToInspect.length; i++) {
                if (i > 0 && i % 500 === 0) __log("            ... processed " + i + " elements");
                obj.elements.push(inspectElement(elementsToInspect[i], 0, isShapeTween));
            }
        }
    } catch(e) {}

    return obj;
}

function inspectLayer(layer, idx, timeline, isBakedShapeTweenLayer) {
    if (!layer) return null;
    var obj = {
        name: safeStr(layer.name),
        layerType: safeStr(layer.layerType),
        index: idx,
        keyframes: []
    };

    try { obj.locked = safeBool(layer.locked); } catch(e) {}
    try { obj.visible = safeBool(layer.visible); } catch(e) {}
    try { obj.outline = safeBool(layer.outline); } catch(e) {}
    try { if (layer.color !== undefined) obj.color = colorToHex(layer.color); } catch(e) {}
    try { if (layer.heightMultiplier !== undefined) obj.heightMultiplier = safeNum(layer.heightMultiplier); } catch(e) {}
    try { if (layer.animationType) obj.animationType = safeStr(layer.animationType); } catch(e) {}
    try {
        if (layer.parentLayer) obj.parentLayerName = safeStr(layer.parentLayer.name);
    } catch(e) {}

    try {
        if (layer.layers && layer.layers.length > 0) {
            obj.childLayers = [];
                        for (var c = 0; c < layer.layers.length; c++) {
                obj.childLayers.push(inspectLayer(layer.layers[c], c, timeline, isBakedShapeTweenLayer));
            }
        }
    } catch(e) {}

    try {
        var frames = layer.frames;
        var visited = {};
        for (var f = 0; f < frames.length; f++) {
            var fr = frames[f];
            var isShapeTween = (fr && fr.tweenType === "shape") || isBakedShapeTweenLayer;
            var key = isShapeTween ? f : (fr ? fr.startFrame : f);
            if (fr && !visited[key]) {
                visited[key] = true;
                if (isShapeTween && timeline) {
                    try { timeline.currentFrame = f; } catch(e) {}
                }
                if (f % 50 === 0) __log("        -> Layer '" + obj.name + "', Frame " + f);
                obj.keyframes.push(inspectKeyframe(fr, f, layer, timeline, isBakedShapeTweenLayer));
            }
        }
    } catch(e) {}

    return obj;
}                                                                       

function safeFileName(name) {
    if (!name) return "Node";
    var s = name.replace(/ /g, "_");
    s = s.replace(/-/g, "_");
    s = s.replace(/\./g, "_");
    s = s.replace(/\//g, "_");
    return s;
}

function inspectSymbolItem(item, base) {
    var symObj = {
        name: base.name, symbolType: safeStr(item.itemType),
        linkage: base.linkage, baseClass: "", layers: [],
        safeName: safeFileName(base.name),
        isLeaf: true,
        renderKind: "leaf-static"
    };
    try { symObj.baseClass = safeStr(item.linkageBaseClass); } catch(e) {}
    try { if (item.sourceFilePath) symObj.sourceFilePath = safeStr(item.sourceFilePath); } catch(e) {}
    try { if (item.sourceLibraryName) symObj.sourceLibraryName = safeStr(item.sourceLibraryName); } catch(e) {}

    try {
        if (item.scalingGrid) {
            symObj.scalingGrid = true;
            if (item.scalingGridRect) {
                symObj.scalingGridRect = {
                    left:   safeNum(item.scalingGridRect.left),
                    top:    safeNum(item.scalingGridRect.top),
                    right:  safeNum(item.scalingGridRect.right),
                    bottom: safeNum(item.scalingGridRect.bottom)
                };
            }
        }
    } catch(e) {}

    try {
        var doc = fl.getDocumentDOM();
        var tl = item.timeline;
        var wasEdited = false;
        var hasShapeTween = false;

        if (tl) {
            for (var l = 0; l < tl.layers.length; l++) {
                var lay = tl.layers[l];
                for (var f = 0; f < lay.frames.length; f++) {
                    if (lay.frames[f].tweenType === "shape") {
                        hasShapeTween = true; break;
                    }
                }
                if (hasShapeTween) break;
            }
        }

        var originalTl = doc ? doc.currentTimeline : 0;
        var tempName = item.name;
        var bakedLayers = {};
        
        if (hasShapeTween && doc) {
            __log("        [DEBUG] Baking Shape Tweens for symbol: " + item.name);
            // Flash mange les '/' dans Item.name setter : si on assigne
            // "folder/item" à .name, Flash traite ça comme le NOM DE BASE
            // seulement (l'item reste dans son dossier courant), et remplace
            // les '/' invalides par '-'. Symptôme observé : pour
            // "_GFX/_Moods/oeil mouillé" on se retrouvait avec un orphelin
            // "_GFX/_Moods/_GFX-_Moods-oeil mouillé_tempGodotExportShapeTween"
            // dans la library, puis itemExists()/deleteItem() rataient le
            // cleanup (ils cherchaient le chemin attendu, pas le mangled),
            // et le symbol original restait vide dans le JSON.
            // Fix : on splitte path/base, on assigne SEULEMENT le base name
            // (sans slash) à Item.name, et on garde le full path pour les
            // opérations library (itemExists / editItem / deleteItem).
            var _slashIdx = item.name.lastIndexOf("/");
            var _folderPath = _slashIdx !== -1 ? item.name.substring(0, _slashIdx + 1) : "";
            var _baseName = _slashIdx !== -1 ? item.name.substring(_slashIdx + 1) : item.name;
            var _tempBaseName = _baseName + "_tempGodotExportShapeTween";
            tempName = _folderPath + _tempBaseName;

            if (doc.library.itemExists(tempName)) doc.library.deleteItem(tempName);
            
            doc.library.selectItem(item.name);
            doc.library.duplicateItem();
            var selItems = doc.library.getSelectedItems();
            if (selItems && selItems.length > 0) {
                selItems[0].name = _tempBaseName;   // BASE NAME ONLY (pas de slash)
                doc.library.editItem(tempName);     // full path pour le lookup
                tl = doc.getTimeline();
                wasEdited = true;
                
                for (var i = 0; i < tl.layers.length; i++) {
                    var layerHasShapeTween = false;
                    for (var f = 0; f < tl.layers[i].frames.length; f++) {
                        if (tl.layers[i].frames[f].tweenType === "shape") {
                            layerHasShapeTween = true; break;
                        }
                    }
                    if (layerHasShapeTween) {
                        bakedLayers[i] = true;
                        __log("          -> Baking layer " + i + "...");
                        tl.setSelectedLayers(i, true);
                        tl.setSelectedFrames(0, tl.layers[i].frameCount, true);
                        tl.convertToKeyframes();
                    }
                }
            } else {
                // Fallback
                doc.library.editItem(item.name);
                tl = doc.getTimeline();
                wasEdited = true;
            }
        } else {
            if (doc) {
                doc.library.editItem(item.name);
                tl = doc.getTimeline();
                wasEdited = true;
            }
        }

        if (tl) {
            symObj.isLeaf = false;
            symObj.renderKind = "container";

            for (var l = 0; l < tl.layers.length; l++) {
                symObj.layers.push(inspectLayer(tl.layers[l], l, tl, bakedLayers[l] || false));
            }
        }

        if (wasEdited && doc) {
            __log("        [DEBUG] Restoring timeline...");
            doc.currentTimeline = originalTl;
            if (hasShapeTween && doc.library.itemExists(tempName)) {
                doc.library.deleteItem(tempName);
            }
        }
    } catch(e) {}

    __log("        [DEBUG] inspectSymbolItem DONE for " + symObj.name);
    return symObj;
}

function inspectBitmapItem(item, base) {
    var b = { name: base.name, linkage: base.linkage };
    var props = ["hPixels","vPixels","bitsPerPixel","compressionType",
                 "allowSmoothing","useImportedJPEGQuality","useDeflateCompression","quality"];
    for (var i = 0; i < props.length; i++) {
        try { if (item[props[i]] !== undefined) b[props[i]] = item[props[i]]; } catch(e) {}
    }
    try { if (item.sourceFilePath) b.sourceFilePath = safeStr(item.sourceFilePath); } catch(e) {}
    return b;
}

function inspectSoundItem(item, base) {
    var s = { name: base.name, linkage: base.linkage };
    var props = ["bits","sampleRate","channels","compressionType","bitRate",
                 "quality","useImportedMP3Quality"];
    for (var i = 0; i < props.length; i++) {
        try { if (item[props[i]] !== undefined) s[props[i]] = item[props[i]]; } catch(e) {}
    }
    try { if (item.sourceFilePath) s.sourceFilePath = safeStr(item.sourceFilePath); } catch(e) {}
    return s;
}

function inspectVideoItem(item, base) {
    var v = { name: base.name, linkage: base.linkage };
    var props = ["fps","frameCount","videoType"];
    for (var i = 0; i < props.length; i++) {
        try { if (item[props[i]] !== undefined) v[props[i]] = item[props[i]]; } catch(e) {}
    }
    try { if (item.sourceFilePath) v.sourceFilePath = safeStr(item.sourceFilePath); } catch(e) {}
    return v;
}

function inspectLibrary(lib) {
    var result = {
        symbols: [], bitmaps: [], sounds: [], videos: [], fonts: [], components: []
    };

    var items = lib.items;
    __log("[DEBUG]      Total items in library: " + items.length);
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        __log("[DEBUG]      -> Inspecting item " + i + " / " + items.length + ": " + item.name);

        try {
            var type = safeStr(item.itemType);
            var baseName = "";
            try { baseName = safeStr(item.name); } catch(e) {}

            if (type === "folder") continue;

            // Skip orphan temp symbols laissés par d'anciens runs ratés du
            // baker de shape tween (cf. fix dans inspectSymbolItem). Sans
            // ce skip, ces orphelins (souvent vides) polluent le JSON et
            // peuvent en plus déclencher un nouveau cycle de baking récursif.
            if (baseName.indexOf("_tempGodotExportShapeTween") !== -1) {
                __log("[DEBUG]      Skip orphan temp symbol: " + baseName);
                continue;
            }

            if (type === "font") {
                result.fonts.push({ name: baseName });
                continue;
            }

            var base = { name: baseName, itemType: type, linkage: "", importedFrom: "" };
            try { base.linkage = safeStr(item.linkageIdentifier); } catch(e){}
            try { base.importedFrom = safeStr(item.sourceFilePath); } catch(e){}

            if (type === "movie clip" || type === "button" || type === "graphic") {
                result.symbols.push(inspectSymbolItem(item, base));
            } else if (type === "bitmap") {
                result.bitmaps.push(inspectBitmapItem(item, base));
            } else if (type === "sound") {
                result.sounds.push(inspectSoundItem(item, base));
            } else if (type === "video") {
                result.videos.push(inspectVideoItem(item, base));
            } else if (type === "component") {
                result.components.push({ name: base.name, linkage: base.linkage });
            }
        } catch (globalErr) {}
    }

    return result;
}                                                                             

function inspectLinkedClasses(lib) {
    var classes = [];
    var items = lib.items;
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        try {
            var type = safeStr(item.itemType);
            if (type === "folder" || type === "font") continue;

            var id = "";
            var bc = "";

            try { id = safeStr(item.linkageIdentifier); } catch(e){}
            try { bc = safeStr(item.linkageBaseClass); } catch(e){}

            if (id || bc) {
                classes.push({
                    libraryItem: safeStr(item.name),
                    identifier: id,
                    baseClass: bc
                });
            }
        } catch(e) {}
    }
    return classes;
}                                                                            

function inspectScenes(doc) {
    var scenes = [];
    var tl = doc.getTimeline();
    var scene = { name: safeStr(tl.name), frameCount: tl.frameCount, layers: [] };
    for (var l = 0; l < tl.layers.length; l++) {
        scene.layers.push(inspectLayer(tl.layers[l], l));
    }
    scenes.push(scene);
    return scenes;
}

function inspectDocumentMeta(doc) {
    var meta = {
        name: safeStr(doc.name),
        width: safeNum(doc.width),
        height: safeNum(doc.height),
        frameRate: safeNum(doc.frameRate)
    };
    try { if (doc.backgroundColor !== undefined) meta.backgroundColor = colorToHex(doc.backgroundColor); } catch(e) {}
    try { if (doc.asVersion !== undefined) meta.asVersion = doc.asVersion; } catch(e) {}
    try { if (doc.docClass) meta.docClass = safeStr(doc.docClass); } catch(e) {}
    try { if (doc.path) meta.path = safeStr(doc.path); } catch(e) {}
    return meta;
}

// =============================================================================
// =============================================================================
// POINT D'ENTREE DU MODULE
// =============================================================================

function _flattenLabeledAnimations(library, scenes) {
    __log("[DEBUG]    -> Flattening labeled nested animations and expanding timelines...");
    
    var libMap = {};
    if (library && library.symbols) {
        for (var i = 0; i < library.symbols.length; i++) {
            var item = library.symbols[i];
            if (item.symbolType === "movie clip" || item.symbolType === "graphic") {
                libMap[item.name] = item;
                if (item.safeName) libMap[item.safeName] = item;
            }
        }
    }

    function _deepClone(obj) {
        if (obj === null || typeof obj !== "object") return obj;
        if (obj instanceof Array) {
            var copy = [];
            for (var i = 0, len = obj.length; i < len; i++) {
                copy[i] = _deepClone(obj[i]);
            }
            return copy;
        }
        var copy = {};
        for (var attr in obj) {
            if (obj.hasOwnProperty(attr)) {
                copy[attr] = _deepClone(obj[attr]);
            }
        }
        return copy;
    }

    // Compose M2 (matrice de l'instance retirée, ex: ev.originalEl.matrix) avec
    // M1 (matrice locale de l'élément enfant) : le point est d'abord transformé
    // par M1 (espace local du symbole enfant), puis par M2 (placement de
    // l'instance dans le parent). Sans cette composition, les éléments injectés
    // dans les SharedLayer_N gardent leurs coordonnées locales au symbole
    // enfant et se retrouvent mal placés sur le calque parent.
    function _composeMatrix(M2, M1) {
        M2 = M2 || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
        M1 = M1 || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
        return {
            a:  M2.a * M1.a + M2.c * M1.b,
            b:  M2.b * M1.a + M2.d * M1.b,
            c:  M2.a * M1.c + M2.c * M1.d,
            d:  M2.b * M1.c + M2.d * M1.d,
            tx: M2.a * M1.tx + M2.c * M1.ty + M2.tx,
            ty: M2.b * M1.tx + M2.d * M1.ty + M2.ty
        };
    }

    function processTimeline(timelineObj) {
        if (!timelineObj || !timelineObj.layers) return;
        
        var tName = timelineObj.name || "MAIN_SCENE";
        // To avoid spam, only log if we find labels
        var hasLabels = false;
        var maxSharedLayers = 0;
        var expansionsMap = {};
        
        for (var l = 0; l < timelineObj.layers.length; l++) {
            for (var k = 0; k < timelineObj.layers[l].keyframes.length; k++) {
                if (timelineObj.layers[l].keyframes[k].name) hasLabels = true;
            }
        }
        
        if (hasLabels) {
            __log("DEBUG: Processing timeline: " + tName);
        }
        
        var expansions = [];
        var flattenEvents = [];
        var maxSharedLayers = 0;
        
        function __getLabels(sym) {
            var res = {};
            if (sym && sym.layers) {
                for (var l=0; l<sym.layers.length; l++) {
                    if (sym.layers[l].keyframes) {
                        for (var k=0; k<sym.layers[l].keyframes.length; k++) {
                            var kf = sym.layers[l].keyframes[k];
                            if (kf.name) res[kf.name.replace(/^\s+|\s+$/g, '')] = true;
                        }
                    }
                }
            }
            return res;
        }

        for (var l = 0; l < timelineObj.layers.length; l++) {
            var layer = timelineObj.layers[l];
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                if (kf.name) {
                    var kfLabel = kf.name.replace(/^\s+|\s+$/g, '');
                    __log("DEBUG: Found label '" + kfLabel + "' at frame " + kf.startFrame);
                    var foundTargets = [];
                    
                    for (var sl = 0; sl < timelineObj.layers.length; sl++) {
                        var sLayer = timelineObj.layers[sl];
                        for (var sk = 0; sk < sLayer.keyframes.length; sk++) {
                            var sKf = sLayer.keyframes[sk];
                            if (Math.abs(sKf.startFrame - kf.startFrame) <= 1) {
                                if (sKf.elements) {
                                    for (var ei = 0; ei < sKf.elements.length; ei++) {
                                        var el = sKf.elements[ei];
                                        if (el.elementType === "instance" && (el.symbolType === "movie clip" || el.symbolType === "graphic")) {
                                            var childSym = libMap[el.symbolName];
                                            if (childSym) {
                                                if ((el.name && el.name.toLowerCase() === kfLabel.toLowerCase()) || 
                                                    el.symbolName.toLowerCase().indexOf(kfLabel.toLowerCase()) !== -1) {
                                                    foundTargets.push({ kf: sKf, labelKf: kf, el: el, layerObj: sLayer, childSym: childSym, elIndex: ei });
                                                    __log("DEBUG: -> Found target matching label '" + kfLabel + "': " + el.symbolName);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    if (foundTargets.length === 0) {
                        __log("DEBUG: -> FAILED to find any nested MovieClip matching label " + kfLabel);
                    } else {
                        for (var ft = 0; ft < foundTargets.length; ft++) {
                            var target = foundTargets[ft];
                            var childSym = target.childSym;
                            var childDuration = 1;
                            for (var cLayIdx = 0; cLayIdx < childSym.layers.length; cLayIdx++) {
                                var cLay = childSym.layers[cLayIdx];
                                if (cLay.keyframes && cLay.keyframes.length > 0) {
                                    var lastKf = cLay.keyframes[cLay.keyframes.length - 1];
                                    childDuration = Math.max(childDuration, lastKf.startFrame + (lastKf.duration || 1));
                                }
                            }
                            var kfDuration = target.labelKf.duration || 1;
                            var diff = childDuration - kfDuration;
                            
                            if (expansionsMap[target.labelKf.startFrame] === undefined) {
                                expansionsMap[target.labelKf.startFrame] = diff;
                            } else {
                                expansionsMap[target.labelKf.startFrame] = Math.max(expansionsMap[target.labelKf.startFrame], diff);
                            }
                            
                            maxSharedLayers = Math.max(maxSharedLayers, childSym.layers.length);
                            flattenEvents.push({
                                originalStart: target.kf.startFrame,
                                originalDuration: kfDuration,
                                childDuration: childDuration,
                                childSym: childSym,
                                originalKf: target.kf,
                                originalEl: target.el
                            });
                        }
                    }
                }
            }
        }
        
        var expansions = [];
        for (var fr in expansionsMap) {
            var diff = expansionsMap[fr];
            if (diff !== 0) {
                expansions.push({ frame: parseInt(fr, 10), expandBy: diff });
            }
        }
        
        if (maxSharedLayers === 0) return;

        // getShift(frame) est appelée plusieurs fois par keyframe/événement ;
        // au lieu de rescanner tout `expansions` a chaque appel (O(n) par
        // appel), on trie une fois et on precalcule une somme cumulative,
        // puis on fait une recherche binaire (O(log n) par appel). Resultat
        // identique : la somme des expandBy pour frame < f ne depend pas de
        // l'ordre de sommation (addition commutative), donc trier avant de
        // sommer ne change rien au total.
        var sortedExpansions = expansions.slice().sort(function(a, b) { return a.frame - b.frame; });
        var expansionFrames = [];
        var expansionCumShift = [0];
        var _runningShift = 0;
        for (var se = 0; se < sortedExpansions.length; se++) {
            expansionFrames.push(sortedExpansions[se].frame);
            _runningShift += sortedExpansions[se].expandBy;
            expansionCumShift.push(_runningShift);
        }
        function getShift(frame) {
            var lo = 0, hi = expansionFrames.length;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (expansionFrames[mid] < frame) lo = mid + 1; else hi = mid;
            }
            return expansionCumShift[lo];
        }
        function newFrame(frame) {
            return frame + getShift(frame);
        }

        for (var l = 0; l < timelineObj.layers.length; l++) {
            var layer = timelineObj.layers[l];
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                var oldStart = kf.startFrame;
                var oldEnd = kf.startFrame + (kf.duration || 1);
                kf.startFrame = newFrame(oldStart);
                kf.duration = newFrame(oldEnd) - newFrame(oldStart);
            }
        }
        
        for (var e = 0; e < flattenEvents.length; e++) {
            var ev = flattenEvents[e];
            ev.start = newFrame(ev.originalStart);
            var oldEnd = ev.originalStart + ev.originalDuration;
            ev.duration = newFrame(oldEnd) - newFrame(ev.originalStart);
            
            var idx = ev.originalKf.elements.indexOf(ev.originalEl);
            if (idx !== -1) {
                ev.originalKf.elements.splice(idx, 1);
            }
        }
        
        flattenEvents.sort(function(a, b) { return a.start - b.start; });

        var totalTimelineDuration = 0;
        for (var l = 0; l < timelineObj.layers.length; l++) {
            var layer = timelineObj.layers[l];
            if (layer.keyframes && layer.keyframes.length > 0) {
                var lastKf = layer.keyframes[layer.keyframes.length - 1];
                totalTimelineDuration = Math.max(totalTimelineDuration, lastKf.startFrame + (lastKf.duration || 1));
            }
        }

        var sharedLayers = [];
        for (var i = 0; i < maxSharedLayers; i++) {
            var sLayer = { name: "SharedLayer_" + i, layerType: "normal", keyframes: [] };
            var currentFrame = 0;
            
            for (var e = 0; e < flattenEvents.length; e++) {
                var ev = flattenEvents[e];
                
                if (ev.start > currentFrame) {
                    sLayer.keyframes.push({ startFrame: currentFrame, duration: ev.start - currentFrame, elements: [] });
                }
                
                if (i < ev.childSym.layers.length) {
                    var cLayer = ev.childSym.layers[i];
                    for (var ck = 0; ck < cLayer.keyframes.length; ck++) {
                        var cKf = _deepClone(cLayer.keyframes[ck]);
                        cKf.startFrame += ev.start;
                        
                        if (cKf.elements) {
                            for (var ce = 0; ce < cKf.elements.length; ce++) {
                                var cEl = cKf.elements[ce];
                                cEl.matrix = _composeMatrix(ev.originalEl.matrix, cEl.matrix);
                            }
                        }
                        if (ev.originalEl.colorTransform && cKf.elements) {
                            for (var ce = 0; ce < cKf.elements.length; ce++) {
                                var cEl = cKf.elements[ce];
                                if (!cEl.colorTransform) {
                                    cEl.colorTransform = _deepClone(ev.originalEl.colorTransform);
                                }
                            }
                        }
                        if (ev.originalEl.blendMode && ev.originalEl.blendMode !== "normal" && cKf.elements) {
                            for (var ce = 0; ce < cKf.elements.length; ce++) {
                                var cEl = cKf.elements[ce];
                                if (!cEl.blendMode || cEl.blendMode === "normal") {
                                    cEl.blendMode = ev.originalEl.blendMode;
                                }
                            }
                        }
                        
                        sLayer.keyframes.push(cKf);
                    }
                    
                    var cLastKf = cLayer.keyframes.length > 0 ? cLayer.keyframes[cLayer.keyframes.length - 1] : null;
                    var cEnd = cLastKf ? cLastKf.startFrame + (cLastKf.duration || 1) : 0;
                    if (cEnd < ev.duration) {
                        sLayer.keyframes.push({ startFrame: ev.start + cEnd, duration: ev.duration - cEnd, elements: [] });
                    }
                } else {
                    sLayer.keyframes.push({ startFrame: ev.start, duration: ev.duration, elements: [] });
                }
                
                currentFrame = ev.start + ev.duration;
            }
            
            if (currentFrame < totalTimelineDuration) {
                sLayer.keyframes.push({ startFrame: currentFrame, duration: totalTimelineDuration - currentFrame, elements: [] });
            }
            
            sharedLayers.push(sLayer);
        }
        
        for (var i = 0; i < sharedLayers.length; i++) {
            timelineObj.layers.push(sharedLayers[i]);
        }
    }

    if (library && library.symbols) {
        for (var i = 0; i < library.symbols.length; i++) {
            processTimeline(library.symbols[i]);
        }
    }
    for (var i = 0; i < scenes.length; i++) {
        processTimeline(scenes[i]);
    }
}

function buildInspectorData(doc) {
    if (!doc) return null;

    __log("[DEBUG]  -> Inspection de la structure du FLA...");

    __log("[DEBUG]    -> inspectDocumentMeta...");
    var meta = inspectDocumentMeta(doc);
    __log("[DEBUG]    -> inspectLibrary...");
    var library = inspectLibrary(doc.library);
    __log("[DEBUG]    -> inspectScenes...");
    var scenes = inspectScenes(doc);
    __log("[DEBUG]    -> inspectLinkedClasses...");
    var linkedClasses = inspectLinkedClasses(doc.library);

    _flattenLabeledAnimations(library, scenes); // Re-enabled with massive bugfixes for targeting and color inheritance

    var fullData = {
        exportedAt: new Date().toString(),
        document: meta,
        library: library,
        scenes: scenes,
        linkedClasses: linkedClasses
    };

    return fullData;
}
