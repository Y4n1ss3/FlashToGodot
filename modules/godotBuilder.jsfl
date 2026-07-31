if (typeof fl !== "undefined") fl.trace(">>> godotBuilder_v4 LOADED <<<");

/**
 * godotBuilder v4.7 - Réduction du nombre de nodes (wrappers Polygon2D/Line2D)
 *   - v4.7 : deux occurrences où le code créait un wrapper Node2D inutile
 *     alors qu'un mécanisme de nommage "node lui-même = 1er élément, Poly_0/
 *     Line_0.. = suivants" existait déjà mais restait inatteignable :
 *       1) Shape stroke-only (0 fill, ≥1 trait) : créait Node2D + Line_0 au
 *          lieu du Line2D directement comme wrapper. Corrigé (avec démotion
 *          symétrique vers Node2D si un keyframe ultérieur ajoute un 2e trait
 *          ou un fill à la même occurrence poolée).
 *       2) Shape multi-fill (≥2 groupes polygones, ex: gradient + solide) :
 *          une démotion Polygon2D -> Node2D était forcée inconditionnellement
 *          dès que polyGroups.length > 1, rendant mort le code qui aurait
 *          gardé le node en Polygon2D (groupe 0) avec Poly_0, Poly_1... en
 *          enfants (offset -1). Démotion supprimée ; les boucles de nettoyage
 *          des slots excédentaires (excess Poly_X, anim._maxPoly) corrigées
 *          pour utiliser le même offset -1. `_findMaskSprite` (masques)
 *          étendu pour reconnaître le wrapper lui-même comme node visuel,
 *          plus seulement ses enfants.
 *     Gain : -1 node par shape stroke-only, -1 node par shape multi-fill.
 * godotBuilder v4.6 - Polygon2D avec trous (bridge + safety net + T-junction repair)
 *   - Quand un polyData (entrée de elem.polygons) possède le champ `holes`,
 *     le builder fusionne outer + holes en un seul PackedVector2Array via
 *     `_bridgeHoles`. Résultat : UN SEUL node Polygon2D au lieu de N nodes
 *     empilés (un par contour Flash). Compatible static + animation.
 *   - v4.2 : algo de bridge robuste pour les cas multi-trous denses.
 *   - v4.3 : safety net via `_hasSelfIntersection` (grid spatial) en garde-fou.
 *   - v4.4 : VALIDATION PER-HOLE avec ROLLBACK.
 *   - v4.6 : RÉPARATION DES T-JONCTIONS (`_repairTJunctions`). inspector.jsfl
 *     subdivise les courbes Bézier indépendamment pour chaque contour (fill).
 *     Deux fills adjacents partagent la même courbe comme frontière, mais les
 *     points intermédiaires de subdivision diffèrent de ~0.2 unité Flash,
 *     créant des gaps triangulaires visibles entre Polygon2D adjacents. Le
 *     repair détecte les sommets d'un polygone proches d'une arête d'un autre
 *     polygone (distance < 0.5u) et les insère dans l'arête → les deux polys
 *     partagent exactement les mêmes sommets le long de leur frontière commune.
 *     Remplace l'ancien mécanisme d'inflation perpendiculaire (v4.5) qui
 *     bouchait les gaps par overlap mais déformait les petits polys.
 *   - La détection outer/holes est faite en amont dans inspector.jsfl v4
 *     (post-traitement de `s.polygons`). Voir _groupPolygonsWithHoles.
 *   - Désactivé automatiquement pour les shape tweens (topologie qui change
 *     entre frames -> casserait l'interpolation des PackedVector2Array).
 */


function __log(msg) {
    if (typeof fl !== "undefined" && fl.scriptURI) {
        var scriptDir = fl.scriptURI.substring(0, fl.scriptURI.lastIndexOf("/") + 1);
        var logURI = scriptDir + "debug_log.txt";
        FLfile.write(logURI, msg + "\n", "append");
    }
}

var RES_PREFIX = "res://";

function safeNum(n) { return isNaN(n) ? 0 : Number(n); }
function safeStr(s) { return s ? String(s) : ""; }

function _sanitize_name(name) {
    return safeStr(name).replace(/[^a-zA-Z0-9_]/g, "_");
}

function _symbolPathInfo(symName) {
    var raw = safeStr(symName);
    var segments = raw.split("/");
    var sanitized = [];
    for (var i = 0; i < segments.length; i++) {
        sanitized.push(_sanitize_name(segments[i]));
    }
    return {
        subPath:  sanitized.join("/"),
        baseName: sanitized[sanitized.length - 1]
    };
}

function sanitizeForLookup(name) {
    if (!name) return "Node";
    var s = name.replace(/ /g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
    if (s.match(/^[0-9]/)) s = "_" + s;
    return s;
}

function _f(n) {
    if (typeof n !== "number" || isNaN(n)) return "0.0000";
    var s = n.toFixed(4);
    if (s.indexOf(".") === -1) s += ".0000";
    return s;
}

function _vec2(x, y) {
    return "Vector2(" + _f(x) + ", " + _f(y) + ")";
}

function _vec4(x, y, z, w) {
    return "Vector4(" + _f(x) + ", " + _f(y) + ", " + _f(z) + ", " + _f(w) + ")";
}

function _colorFloats(c) {
    if (!c) return '1, 1, 1, 1';
    if (c.charAt(0) === '#') {
        var r = parseInt(c.substring(1,3), 16) / 255.0;
        var g = parseInt(c.substring(3,5), 16) / 255.0;
        var b = parseInt(c.substring(5,7), 16) / 255.0;
        var a = 1.0;
        if (c.length === 9) a = parseInt(c.substring(7,9), 16) / 255.0;
        return _f(r) + ', ' + _f(g) + ', ' + _f(b) + ', ' + _f(a);
    }
    return '1, 1, 1, 1';
}

/**
 * Bridge / keyhole : fusionne un contour extérieur et N trous en un seul tableau
 * de sommets, en reliant chaque trou à l'outer par une "fente" de largeur zéro.
 * Le Polygon2D résultant rend nativement les trous sans triangulation maison.
 *
 * v2 - robustesse multi-trous :
 *   - check de non-croisement segment-segment (ccw strict) : on rejette tout
 *     candidat dont le bridge croiserait une arête existante de work ou du hole.
 *   - exclusion des extrémités de bridges déjà posés (flag `br`) : empêche
 *     deux trous de partager le MÊME couple de points, ce qui produisait des
 *     arêtes superposées en sens opposés (cas le plus fréquent d'invisibilité
 *     en Godot, car earcut abandonne sur self-intersection).
 *   - tri des candidats par distance + first-non-crossing : on garde des
 *     bridges courts tout en garantissant la validité topologique.
 *   - maxCheck = 500 itérations pour borner le pire cas ; fallback sur le
 *     plus proche si rien de propre n'est trouvé.
 */

// Helpers géométriques purs, partagés par _bridgeHoles et _hasSelfIntersection.
// Hissés au scope module : ils ne capturent aucune variable locale, donc les
// recréer à chaque appel (l'ancien pattern de fonctions imbriquées) n'était
// que de l'allocation gratuite, répétée à chaque polygone-avec-trous traité
// par frame. Une seule définition au lieu de deux copies dupliquées.
function _signedAreaSum(v) {
    var s = 0;
    for (var i = 0; i < v.length; i++) {
        var j = (i + 1) % v.length;
        s += (v[j].x - v[i].x) * (v[j].y + v[i].y);
    }
    return s;
}
function _ccw(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function _segCross(p1, p2, p3, p4) {
    var d1 = _ccw(p3, p4, p1);
    var d2 = _ccw(p3, p4, p2);
    var d3 = _ccw(p1, p2, p3);
    var d4 = _ccw(p1, p2, p4);
    return (d1 * d2 < 0) && (d3 * d4 < 0);
}
function _bridgeBlocked(A, B, work, wi, hole, hj) {
    var nw = work.length;
    for (var k = 0; k < nw; k++) {
        if (k === wi || k === (wi - 1 + nw) % nw) continue;
        if (_segCross(A, B, work[k], work[(k + 1) % nw])) return true;
    }
    var nh = hole.length;
    for (var k = 0; k < nh; k++) {
        if (k === hj || k === (hj - 1 + nh) % nh) continue;
        if (_segCross(A, B, hole[k], hole[(k + 1) % nh])) return true;
    }
    return false;
}

function _bridgeHoles(outerVerts, holesArr) {
    var work = [];
    for (var i = 0; i < outerVerts.length; i++) {
        work.push({ x: outerVerts[i].x, y: outerVerts[i].y, br: false });
    }
    if (!holesArr || holesArr.length === 0) return work;

    var outerSign = _signedAreaSum(outerVerts) > 0 ? 1 : -1;

    var holes = [];
    for (var h = 0; h < holesArr.length; h++) {
        var hv = holesArr[h];
        var maxX = hv[0].x;
        for (var hi = 1; hi < hv.length; hi++) if (hv[hi].x > maxX) maxX = hv[hi].x;
        holes.push({ verts: hv, maxX: maxX });
    }
    holes.sort(function(a, b) { return b.maxX - a.maxX; });

    for (var h = 0; h < holes.length; h++) {
        var hole = [];
        for (var i = 0; i < holes[h].verts.length; i++) {
            hole.push({ x: holes[h].verts[i].x, y: holes[h].verts[i].y });
        }

        var holeSign = _signedAreaSum(hole) > 0 ? 1 : -1;
        if (holeSign === outerSign) hole.reverse();

        var topCandidates = [];
        var maxCand = 50; // Reduce max candidates to speed up insertion sort

        function addCandidate(ci, cj, cd) {
            if (topCandidates.length < maxCand) {
                topCandidates.push({i: ci, j: cj, d: cd});
                if (topCandidates.length === maxCand) {
                    topCandidates.sort(function(a, b) { return a.d - b.d; });
                }
            } else if (cd < topCandidates[maxCand - 1].d) {
                topCandidates[maxCand - 1].i = ci;
                topCandidates[maxCand - 1].j = cj;
                topCandidates[maxCand - 1].d = cd;
                for (var k = maxCand - 2; k >= 0; k--) {
                    if (topCandidates[k+1].d < topCandidates[k].d) {
                        var tmp = topCandidates[k];
                        topCandidates[k] = topCandidates[k+1];
                        topCandidates[k+1] = tmp;
                    } else {
                        break;
                    }
                }
            }
        }

        var totalLoops = work.length * hole.length;
        var stepW = 1;
        var stepH = 1;
        if (totalLoops > 20000) {
            var ratio = Math.sqrt(totalLoops / 20000);
            stepW = Math.ceil(ratio);
            stepH = Math.ceil(ratio);
        }

        for (var i = 0; i < work.length; i += stepW) {
            if (work[i].br) continue;
            for (var j = 0; j < hole.length; j += stepH) {
                var dx = work[i].x - hole[j].x;
                var dy = work[i].y - hole[j].y;
                addCandidate(i, j, dx * dx + dy * dy);
            }
        }
        
        if (topCandidates.length === 0) {
            // Fallback without steps if somehow empty
            for (var i = 0; i < work.length; i++) {
                if (work[i].br) continue;
                for (var j = 0; j < hole.length; j++) {
                    var dx = work[i].x - hole[j].x;
                    var dy = work[i].y - hole[j].y;
                    addCandidate(i, j, dx * dx + dy * dy);
                }
            }
        }
        
        if (topCandidates.length < maxCand) {
            topCandidates.sort(function(a, b) { return a.d - b.d; });
        }
        var candidates = topCandidates;

        var bestI = candidates[0].i;
        var bestJ = candidates[0].j;
        var maxCheck = candidates.length;
        for (var c = 0; c < maxCheck; c++) {
            var ci = candidates[c].i;
            var cj = candidates[c].j;
            if (!_bridgeBlocked(work[ci], hole[cj], work, ci, hole, cj)) {
                bestI = ci;
                bestJ = cj;
                break;
            }
        }

        var eps = 0.05;
        var dx = work[bestI].x - hole[bestJ].x;
        var dy = work[bestI].y - hole[bestJ].y;
        var len = Math.sqrt(dx*dx + dy*dy);
        var nx = 0, ny = 0;
        if (len > 0.0001) {
            nx = -(dy / len) * eps;
            ny = (dx / len) * eps;
        }

        var newWork = [];
        for (var k = 0; k <= bestI; k++) newWork.push(work[k]);
        for (var k = 0; k < hole.length; k++) {
            var idx = (bestJ + k) % hole.length;
            var atBridgeStart = (k === 0);
            newWork.push({ x: hole[idx].x, y: hole[idx].y, br: atBridgeStart });
        }
        newWork.push({ x: hole[bestJ].x + nx, y: hole[bestJ].y + ny, br: true });
        newWork.push({ x: work[bestI].x + nx, y: work[bestI].y + ny, br: true });
        for (var k = bestI + 1; k < work.length; k++) newWork.push(work[k]);

        if (_hasSelfIntersection(newWork)) {
            continue;
        }

        work[bestI].br = true;
        work = newWork;
    }

    return work;
}

/**
 * Détecte et tente de corriger une self-intersection STRICTE (croisement transverse) 
 * dans un polygone via une recherche de segment sécant.
 */
function _removeSelfIntersections(verts) {
    var fixed = true;
    var maxIter = 10;
    while (maxIter-- > 0) {
        fixed = true;
        var n = verts.length;
        if (n < 4) break;
        var intersectionFound = false;
        for (var i = 0; i < n; i++) {
            var A = verts[i], B = verts[(i+1)%n];
            for (var j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue;
                var C = verts[j], D = verts[(j+1)%n];
                var den = (D.y - C.y)*(B.x - A.x) - (D.x - C.x)*(B.y - A.y);
                if (Math.abs(den) > 0.0001) {
                    var ua = ((D.x - C.x)*(A.y - C.y) - (D.y - C.y)*(A.x - C.x)) / den;
                    var ub = ((B.x - A.x)*(A.y - C.y) - (B.y - A.y)*(A.x - C.x)) / den;
                    if (ua > 0.01 && ua < 0.99 && ub > 0.01 && ub < 0.99) {
                        // Au lieu de supprimer une partie de la forme (ce qui cause des trous),
                        // on la "dé-vrille" en inversant l'ordre des sommets dans la boucle.
                        // Cela transforme un 8 (croisé) en un simple polygone en unifiant
                        // le sens de tracé, sans AUCUNE perte de points !
                        var prefix = verts.slice(0, i + 1);
                        var loopToReverse = verts.slice(i + 1, j + 1);
                        var suffix = verts.slice(j + 1);
                        loopToReverse.reverse();
                        verts = prefix.concat(loopToReverse).concat(suffix);
                        
                        intersectionFound = true;
                        fixed = false;
                        break;
                    }
                }
            }
            if (intersectionFound) break;
        }
        if (fixed) break;
    }
    return verts;
}

/**
 * Détecte une self-intersection STRICTE (croisement transverse) dans un polygone
 * fermé. Utilisé en safety-net après _bridgeHoles : si vrai, on n'utilise pas
 * le résultat bridgé (cas pathologique multi-trous) pour éviter un polygone
 * invisible dans Godot (earcut échoue sur les self-intersections).
 *
 * Optim spatiale : grid uniforme indexé sur la bbox. Pour chaque arête on ne
 * teste que les arêtes des cellules qu'elle traverse. Réduit drastiquement
 * le coût sur les polygones avec beaucoup de trous (~1000-2000 sommets).
 */
function _hasSelfIntersection(verts) {
    var n = verts.length;
    if (n < 4) return false;

    // _ccw / _segCross : voir les définitions module-scope au-dessus de
    // _bridgeHoles (mêmes fonctions pures, plus de copie dupliquée ici).

    var minX = verts[0].x, maxX = verts[0].x;
    var minY = verts[0].y, maxY = verts[0].y;
    for (var i = 1; i < n; i++) {
        if (verts[i].x < minX) minX = verts[i].x;
        if (verts[i].x > maxX) maxX = verts[i].x;
        if (verts[i].y < minY) minY = verts[i].y;
        if (verts[i].y > maxY) maxY = verts[i].y;
    }
    var w = maxX - minX, h = maxY - minY;
    if (w === 0 && h === 0) return false;
    var dim = Math.ceil(Math.sqrt(n));
    if (dim < 4) dim = 4;
    var cellW = (w || 1) / dim;
    var cellH = (h || 1) / dim;

    var grid = {};
    function _cellsOfEdge(i) {
        var a = verts[i], b = verts[(i + 1) % n];
        var cx1 = Math.floor((a.x - minX) / cellW);
        var cy1 = Math.floor((a.y - minY) / cellH);
        var cx2 = Math.floor((b.x - minX) / cellW);
        var cy2 = Math.floor((b.y - minY) / cellH);
        if (cx1 > cx2) { var t = cx1; cx1 = cx2; cx2 = t; }
        if (cy1 > cy2) { var t = cy1; cy1 = cy2; cy2 = t; }
        if (cx1 < 0) cx1 = 0; if (cy1 < 0) cy1 = 0;
        if (cx2 >= dim) cx2 = dim - 1; if (cy2 >= dim) cy2 = dim - 1;
        var out = [];
        for (var cy = cy1; cy <= cy2; cy++) {
            for (var cx = cx1; cx <= cx2; cx++) {
                out.push(cx + cy * dim);
            }
        }
        return out;
    }

    for (var i = 0; i < n; i++) {
        var cells = _cellsOfEdge(i);
        for (var c = 0; c < cells.length; c++) {
            var key = cells[c];
            if (!grid[key]) grid[key] = [];
            grid[key].push(i);
        }
    }

    for (var i = 0; i < n; i++) {
        var a = verts[i], b = verts[(i + 1) % n];
        var cells = _cellsOfEdge(i);
        var seen = {};
        for (var c = 0; c < cells.length; c++) {
            var bucket = grid[cells[c]];
            if (!bucket) continue;
            for (var bi = 0; bi < bucket.length; bi++) {
                var j = bucket[bi];
                if (j <= i) continue;
                if (seen[j]) continue;
                seen[j] = 1;
                if (j === (i + 1) % n) continue;
                if (i === (j + 1) % n) continue;
                var c1 = verts[j], d = verts[(j + 1) % n];
                if (_segCross(a, b, c1, d)) return true;
            }
        }
    }
    return false;
}

/**
 * Réparation des T-jonctions entre polygones adjacents d'une même shape.
 *
 * Problème : inspector.jsfl subdivise les courbes Bézier indépendamment pour
 * chaque contour (fill). Deux fills adjacents partagent la même courbe comme
 * frontière, mais la subdivision de Casteljau peut produire des points
 * intermédiaires légèrement différents de chaque côté (~0.2 unité Flash).
 * Résultat : un sommet V du polygone A est à ~0.2u de l'arête PQ du polygone B,
 * créant un gap triangulaire visible entre les deux Polygon2D dans Godot.
 *
 * Fix : pour chaque sommet V d'un polygone A, si V est proche d'une arête PQ
 * d'un autre polygone B (distance < tolérance), on insère V dans B entre P et Q.
 * Après réparation, les deux polygones partagent exactement les mêmes sommets
 * le long de leur frontière commune → plus de gap.
 *
 * Complexité : O(V × E × P) où V = sommets totaux, E = arêtes par poly,
 * P = nombre de polys. Pour une shape typique (5-10 polys, 20-50 sommets),
 * c'est ~50K itérations — instantané.
 */


function _deepClone(v) {
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t === "number" || t === "string" || t === "boolean") return v;
    if (Object.prototype.toString.call(v) === "[object Array]") {
        var arr = [];
        for (var i = 0; i < v.length; i++) arr.push(_deepClone(v[i]));
        return arr;
    }
    if (t === "object") {
        var obj = {};
        for (var k in v) {
            if (v.hasOwnProperty(k)) {
                if (k === "polygons" || k === "strokes" || k === "vertices" || k === "holes" || k === "path" || k === "contours") {
                    obj[k] = v[k]; // Shallow copy / reference for massive read-only geometry data
                } else {
                    obj[k] = _deepClone(v[k]);
                }
            }
        }
        return obj;
    }
    return v;
}

function nextId() { return Math.floor(Math.random() * 1000000000) + 1; }

function _shallowClone(src) {
    var dst = {};
    for (var p in src) {
        if (src.hasOwnProperty(p)) dst[p] = src[p];
    }
    return dst;
}

function _parseHexChannel(hex, offset) {
    return parseInt(hex.substr(offset, 2), 16) / 255;
}

function _isAutoTweenName(name) {
    if (!name) return false;
    var slash = name.lastIndexOf("/");
    var base = slash === -1 ? name : name.substring(slash + 1);
    return /^Tween[ _]\d+$/.test(base);
}

var _FLASH_FRAGMENT = ''
    + 'void fragment() {\n'
    + '\tvec4 tex = texture(TEXTURE, UV);\n'
    + '\tvec4 flash = tex * color_mult + (color_offset_255 / 255.0);\n'
    + '\tCOLOR = clamp(flash, vec4(0.0), vec4(1.0));\n'
    + '}';

var _FLASH_FRAGMENT_POLY = ''
    + 'void fragment() {\n'
    + '\tvec4 tex = texture(TEXTURE, UV);\n'
    + '\tvec4 base_color = tex * COLOR;\n'
    + '\tvec4 flash = base_color * color_mult + (color_offset_255 / 255.0);\n'
    + '\tCOLOR = clamp(flash, vec4(0.0), vec4(1.0));\n'
    + '}';

var _FLASH_UNIFORMS = ''
    + 'uniform vec4 color_mult        = vec4(1.0, 1.0, 1.0, 1.0);\n'
    + 'uniform vec4 color_offset_255  = vec4(0.0, 0.0, 0.0, 0.0);\n';

function _makeFlashShader(blendMode) {
    return 'shader_type canvas_item;\nrender_mode blend_' + blendMode + ';\n\n'
        + _FLASH_UNIFORMS + '\n' + _FLASH_FRAGMENT;
}

var SHADER_NORMAL = _makeFlashShader("mix");
var SHADER_ADD    = _makeFlashShader("add");
var SHADER_MUL    = _makeFlashShader("mul");

function _decomposeMatrix(m, elem) {
    if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) {
        return { rotation: 0, skew: 0, scaleX: 1, scaleY: 1 };
    }
    
    var det = m.a * m.d - m.b * m.c;
    var sx = Math.sqrt(m.a * m.a + m.b * m.b);
    var sy = Math.sqrt(m.c * m.c + m.d * m.d);
    
    if (det < 0) {
        sx = -sx;
    }
    
    var rot = Math.atan2(m.b / sx, m.a / sx);
    var rot_plus_skew = Math.atan2(-m.c, m.d);
    var skew = rot_plus_skew - rot;
    
    while (skew > Math.PI) skew -= 2 * Math.PI;
    while (skew <= -Math.PI) skew += 2 * Math.PI;
    
    return {
        rotation: rot,
        skew: skew,
        scaleX: sx,
        scaleY: sy
    };
}

function _composeMatrix(M2, M1) {
    return {
        a:  M2.a * M1.a + M2.c * M1.b,
        b:  M2.b * M1.a + M2.d * M1.b,
        c:  M2.a * M1.c + M2.c * M1.d,
        d:  M2.b * M1.c + M2.d * M1.d,
        tx: M2.a * M1.tx + M2.c * M1.ty + M2.tx,
        ty: M2.b * M1.tx + M2.d * M1.ty + M2.ty
    };
}

function _extractColorTransform(ct) {
    if (!ct) return { rP: 1, gP: 1, bP: 1, aP: 1, rA: 0, gA: 0, bA: 0, aA: 0 };
    
    var rP = 100, gP = 100, bP = 100, aP = 100;
    var rA = 0, gA = 0, bA = 0, aA = 0;

    if (ct.colorMode === "brightness") {
        var b = ct.brightness !== undefined ? ct.brightness : 0;
        if (b > 0) {
            rP = gP = bP = 100 - b;
            rA = gA = bA = (b / 100) * 255;
        } else {
            rP = gP = bP = 100 + b;
            rA = gA = bA = 0;
        }
        aP = ct.colorAlphaPercent !== undefined ? ct.colorAlphaPercent : 100;
        aA = ct.colorAlphaAmount !== undefined ? ct.colorAlphaAmount : 0;
    } else if (ct.colorMode === "tint") {
        var tp = ct.tintPercent !== undefined ? ct.tintPercent : 0;
        var tc = ct.tintColor || "#000000";
        var hex = tc.replace("#", "");
        if (hex.length === 6) {
            var tr = parseInt(hex.substring(0, 2), 16);
            var tg = parseInt(hex.substring(2, 4), 16);
            var tb = parseInt(hex.substring(4, 6), 16);
            rP = gP = bP = 100 - tp;
            rA = (tp / 100) * tr;
            gA = (tp / 100) * tg;
            bA = (tp / 100) * tb;
        }
        aP = ct.colorAlphaPercent !== undefined ? ct.colorAlphaPercent : 100;
        aA = ct.colorAlphaAmount !== undefined ? ct.colorAlphaAmount : 0;
    } else {
        rP = ct.colorRedPercent   !== undefined ? ct.colorRedPercent   : 100;
        gP = ct.colorGreenPercent !== undefined ? ct.colorGreenPercent : 100;
        bP = ct.colorBluePercent  !== undefined ? ct.colorBluePercent  : 100;
        aP = ct.colorAlphaPercent !== undefined ? ct.colorAlphaPercent : 100;
        rA = ct.colorRedAmount    !== undefined ? ct.colorRedAmount    : 0;
        gA = ct.colorGreenAmount  !== undefined ? ct.colorGreenAmount  : 0;
        bA = ct.colorBlueAmount   !== undefined ? ct.colorBlueAmount   : 0;
        aA = ct.colorAlphaAmount  !== undefined ? ct.colorAlphaAmount  : 0;
    }

    return {
        rP: rP / 100, gP: gP / 100, bP: bP / 100, aP: aP / 100,
        rA: rA, gA: gA, bA: bA, aA: aA
    };
}

function _parsePngFilename(fileName) {
    var info = {
        useAbsoluteBounds: false,
        boundsX: 0.0, boundsY: 0.0,
        pngWidth: undefined, pngHeight: undefined,
        offsetDx: 0.0, offsetDy: 0.0,
        spriteScale: 1.0
    };
    var scaleMatch = fileName.match(/_SPRITESCALE_([0-9\.]+)/);
    if (scaleMatch) {
        info.spriteScale = parseFloat(scaleMatch[1]);
        fileName = fileName.replace(scaleMatch[0], "");
    }
    var parts = fileName.split("_BOUNDS_");
    if (parts.length > 1) {
        var boundAndSize = parts[1].replace(".png", "");
        var sizeSplit = boundAndSize.split("_SIZE_");
        var bp = sizeSplit[0].split("_");
        if (bp.length >= 2) {
            info.useAbsoluteBounds = true;
            info.boundsX = safeNum(parseFloat(bp[0]));
            info.boundsY = safeNum(parseFloat(bp[1]));
        }
        if (sizeSplit.length > 1) {
            var sp = sizeSplit[1].split("_");
            if (sp.length >= 2) {
                info.pngWidth  = safeNum(parseFloat(sp[0]));
                info.pngHeight = safeNum(parseFloat(sp[1]));
            }
        }
    } else if (fileName.indexOf("_OFFSET_") !== -1) {
        var parts2 = fileName.split("_OFFSET_");
        if (parts2.length > 1) {
            var op = parts2[1].replace(".png", "").split("_");
            if (op.length >= 2) {
                info.offsetDx = safeNum(parseFloat(op[0]));
                info.offsetDy = safeNum(parseFloat(op[1]));
            }
        }
    }
    return info;
}

function _isFullyVectorizable(elements) {
    // Verifie recursivement que tous les elements "shape" (a travers les
    // groupes imbriques) ont une representation vectorielle complete
    // (polygones ou traits). Un seul membre sans fill valide signifie que
    // exporterPNG.jsfl a exporte UN SEUL PNG composite pour le groupe entier
    // (un groupe sans contours directs est traite comme "fill invalide" par
    // needsPNG) -> le groupe ne doit pas etre decompose, sinon ce PNG devient
    // introuvable et le contenu non-vectorisable disparait silencieusement.
    if (!elements) return true;
    for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (el.elementType === "group" && el.members && el.members.length > 0) {
            if (!_isFullyVectorizable(el.members)) return false;
        } else if (el.elementType === "shape") {
            var hasPolys = el.polygons && el.polygons.length > 0;
            var hasStrokes = el.strokes && el.strokes.length > 0;
            if (!hasPolys && !hasStrokes) return false;
        }
    }
    return true;
}

function _flattenGroups(elements) {
    if (!elements) return elements;
    var result = [];
    for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (el.elementType === "group" && el.members && el.members.length > 0) {
            if (!_isFullyVectorizable(el.members)) {
                // Au moins un membre necessite un PNG -> on garde le groupe
                // comme UN SEUL element "shape" opaque (sans polygones), pour
                // que le mecanisme Sprite2D/customTex existant puisse encore
                // le retrouver, au lieu de le decomposer et perdre tout lien
                // avec le PNG deja exporte pour ce groupe.
                var asOneUnit = _shallowClone(el);
                asOneUnit.elementType = "shape";
                asOneUnit.isGroup = false;
                delete asOneUnit.members;
                delete asOneUnit.polygons;
                delete asOneUnit.strokes;
                result.push(asOneUnit);
                continue;
            }
            if ((el.shapes && el.shapes.length > 0) || (el.strokes && el.strokes.length > 0)) {
                var synthetic = _shallowClone(el);
                synthetic.elementType = "shape";
                synthetic.isGroup = false;
                delete synthetic.members;
                if (el.shapes && el.shapes.length > 0) synthetic.polygons = el.shapes;
                delete synthetic.shapes;
                // DO NOT delete matrix/rotation/scale/skew. The raw shape vertices
                // in group.contours need the group's transform applied to them.
                result.push(synthetic);
            }
            var flatMembers = _flattenGroups(el.members);
            for (var m = 0; m < flatMembers.length; m++) {
                var member = _shallowClone(flatMembers[m]);
                // JSFL already exports instance members with their absolute matrix
                // so we MUST NOT compose their matrix with the group's matrix.
                result.push(member);
            }
        } else {
            result.push(el);
        }
    }
    return result;
}


function _explodeTweenElements(elements, symbolMap) {
    if (!elements || !symbolMap) return elements;
    var result = [];
    for (var e = 0; e < elements.length; e++) {
        var elem = elements[e];
        if (elem.elementType === "instance" && elem.symbolName) {
            var targetSym = symbolMap[elem.symbolName];
            var isTween = elem.symbolName.indexOf("/Tween ") !== -1;

            if (isTween) {
                var tweenSym = targetSym;
                if (tweenSym && tweenSym.layers && tweenSym.layers.length > 0) {
                    var innerKf = tweenSym.layers[0].keyframes[0];
                    if (innerKf && innerKf.elements && innerKf.elements.length > 0) {
                        var hasShape = false;
                        for (var ie = 0; ie < innerKf.elements.length; ie++) {
                            if (innerKf.elements[ie].elementType === "shape") { hasShape = true; break; }
                        }
                        if (!hasShape) {
                            for (var ie = 0; ie < innerKf.elements.length; ie++) {
                                var inner = innerKf.elements[ie];
                                if (inner.elementType !== "instance") continue;
                                var cloned = _shallowClone(elem);
                                cloned.symbolName = inner.symbolName;
                                cloned.symbolType = inner.symbolType || cloned.symbolType;
                                if (elem.matrix && inner.matrix) {
                                    cloned.matrix = _composeMatrix(elem.matrix, inner.matrix);
                                }
                                delete cloned.skewX;
                                delete cloned.skewY;
                                delete cloned.scaleX;
                                delete cloned.scaleY;
                                delete cloned.rotation;
                                if (inner.name) cloned.name = inner.name;
                                result.push(cloned);
                            }
                            continue;
                        }
                    }
                }
            }
        }
        result.push(elem);
    }
    return result;
}

function _getOccKey(elem) {
    var occ = elem.name ? elem.name : elem.elementType;
    if (elem.symbolName) {
        occ += "_" + elem.symbolName;
    }
    return occ;
}


function _stabilizeOccurrenceIndices(elements, lastPositions) {
    if (!elements || !lastPositions) return {};
    var groups = {};
    for (var e = 0; e < elements.length; e++) {
        var elem = elements[e];
        var oKey = _getOccKey(elem);
        if (!groups[oKey]) groups[oKey] = [];
        groups[oKey].push({idx: e, elem: elem});
    }
    var result = {};
    for (var oKey in groups) {
        if (!groups.hasOwnProperty(oKey)) continue;
        var grp = groups[oKey];
        if (grp.length <= 1) continue;
        
        // Seules les instances bénéficient du matching par distance.
        // Les formes géométriques (shapes) doivent conserver leur ordre Z strict,
        // sinon les tweens de forme qui se croisent vont échanger leurs nœuds.
        if (oKey.indexOf("instance_") !== 0) continue;
        
        var prev = lastPositions[oKey];
        if (!prev || prev.length !== grp.length) continue;
        var usedPrev = {};
        for (var g = 0; g < grp.length; g++) {
            var el = grp[g].elem;
            var tx, ty;
            if (el.matrix) { tx = el.matrix.tx || 0; ty = el.matrix.ty || 0; }
            else            { tx = el.left || 0;     ty = el.top || 0;     }
            var bestDist = Infinity, bestOcc = g, bestP = -1;
            for (var p = 0; p < prev.length; p++) {
                if (usedPrev[p]) continue;
                var dx = tx - prev[p].tx, dy = ty - prev[p].ty;
                var d = dx * dx + dy * dy;
                if (d < bestDist) { bestDist = d; bestOcc = prev[p].occIdx; bestP = p; }
            }
            if (bestP >= 0) usedPrev[bestP] = true;
            result[grp[g].idx] = bestOcc;
        }
    }
    return result;
}

function _recordElemPositions(elements, stableIdx) {
    var positions = {};
    var counters = {};
    for (var e = 0; e < elements.length; e++) {
        var elem = elements[e];
        var oKey = _getOccKey(elem);
        if (!counters[oKey]) counters[oKey] = 0;
        var occIdx = (stableIdx && stableIdx[e] !== undefined) ? stableIdx[e] : counters[oKey];
        counters[oKey] = Math.max(counters[oKey], occIdx + 1);
        var tx, ty;
        if (elem.matrix) { tx = elem.matrix.tx || 0; ty = elem.matrix.ty || 0; }
        else              { tx = elem.left || 0;     ty = elem.top || 0;     }
        if (!positions[oKey]) positions[oKey] = [];
        positions[oKey].push({tx: tx, ty: ty, occIdx: occIdx});
    }
    return positions;
}

function GNode(name, type) {
    this.name = _sanitize_name(name);
    this.type = type;
    this.parent = null;
    this.children = [];
    this._childByName = {};
    this.properties = {};
    this.owner = null;
}
GNode.prototype.addChild = function(child) {
    if (child.parent) child.parent.removeChild(child);
    this.children.push(child);
    child.parent = this;
    this._childByName["$" + child.name] = child;
};
GNode.prototype.prependChild = function(child) {
    if (child.parent) child.parent.removeChild(child);
    this.children.unshift(child);
    child.parent = this;
    this._childByName["$" + child.name] = child;
};
// Insère l'enfant dans l'ordre de stacking voulu (rank croissant = plus
// "devant"/dernier dessiné), sans jamais écrire de propriété z_index :
// l'ordre de rendu Godot vient uniquement de la position dans children[].
GNode.prototype.addChildRanked = function(child, rank) {
    if (child.parent) child.parent.removeChild(child);
    child._renderRank = rank;
    var insertAt = this.children.length;
    if (rank !== undefined) {
        for (var idx = 0; idx < this.children.length; idx++) {
            var sibRank = this.children[idx]._renderRank;
            if (sibRank !== undefined && rank < sibRank) {
                insertAt = idx;
                break;
            }
        }
    }
    this.children.splice(insertAt, 0, child);
    child.parent = this;
    this._childByName["$" + child.name] = child;
};
GNode.prototype.removeChild = function(child) {
    var idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    if (this._childByName["$" + child.name] === child) delete this._childByName["$" + child.name];
    child.parent = null;
};
GNode.prototype.getNodeOrNull = function(pathStr) {
    if (!pathStr || pathStr === ".") return this;
    var parts = pathStr.split("/");
    var current = this;
    for (var i = 0; i < parts.length; i++) {
        var next = current._childByName["$" + parts[i]];
        if (!next) return null;
        current = next;
    }
    return current;
};
GNode.prototype.getPathTo = function(descendant) {
    var path = [];
    var curr = descendant;
    while (curr && curr !== this) {
        path.unshift(curr.name);
        curr = curr.parent;
    }
    if (curr !== this) return "";
    return path.join("/");
};

function GAnimation() {
    this.step = 0.04;
    this.length = 0.0;
    this.tracks = [];
    this._trackIndex = {};
}
GAnimation.prototype.findTrack = function(path, type) {
    var idx = this._trackIndex["$" + path + "\u0001" + type];
    return (idx === undefined) ? -1 : idx;
};
// Comparaison de valeurs de keyframe (nombre, Vector2-like, ExtResource-like).
// Fonction pure, hissée au scope module : addTrackKey est appelée des
// dizaines de milliers de fois sur un projet complexe, recréer cette
// fermeture à chaque appel était une allocation gratuite et répétée.
function _eq(v1, v2) {
    if (v1 === v2) return true;
    if (typeof v1 === "number" && typeof v2 === "number") return Math.abs(v1 - v2) < 0.001;
    if (v1 && v2 && typeof v1 === "object" && typeof v2 === "object") {
        if (v1.x !== undefined && v2.x !== undefined) return Math.abs(v1.x - v2.x) < 0.001 && Math.abs(v1.y - v2.y) < 0.001;
        if (v1.ext !== undefined && v2.ext !== undefined) return v1.ext === v2.ext;
        if (v1.method !== undefined && v2.method !== undefined) return v1.method === v2.method && v1.args === v2.args;
    }
    return false;
}

GAnimation.prototype.optimizeTracks = function(root) {
    var optimizedTracks = [];
    for (var i = 0; i < this.tracks.length; i++) {
        var tr = this.tracks[i];
        if (tr.keys.times.length === 0) continue;
        
        var firstVal = tr.keys.values[0];
        var isStatic = true;
        
        var colonIdx = tr.path.indexOf(":");
        var propName = (colonIdx !== -1) ? tr.path.substring(colonIdx + 1) : tr.path;
        
        if (propName.indexOf(":") !== -1 || propName.indexOf("/") !== -1) {
            isStatic = false; // Ne pas optimiser les sous-propriétés
        } else if (tr.keys.times[0] > 0.0005 && (propName === "points" || propName === "polygon" || propName === "polygons" || propName === "uv")) {
            // Seuls les tableaux de géométrie qui apparaissent tardivement DOIVENT rester dynamiques.
            // Avant leur création, Godot utilise leur état .tscn (vide). Si on les rendait statiques,
            // on écrirait leur forme finale dans le .tscn, les rendant visibles prématurément !
            // On peut par contre optimiser TOUTES les autres propriétés (position, couleur...) pour regagner nos FPS.
            isStatic = false;
        } else {
            for (var k = 1; k < tr.keys.values.length; k++) {
                if (!_eq(firstVal, tr.keys.values[k])) {
                    isStatic = false;
                    break;
                }
            }
        }
        
        if (!isStatic) {
            optimizedTracks.push(tr);
            
            // Pour les pistes animées, on applique la valeur à t=0 dans le .tscn
            // pour que la scène ait la bonne apparence dans l'éditeur avant lecture.
            //
            // Exception : les tableaux de géométrie (polygon, points, uv) qui
            // N'APPARAISSENT PAS à t=0 (times[0] > 0.0005) doivent rester hors .tscn.
            // Avant leur frame de création Godot utilise l'état .tscn (vide) ; y écrire
            // leur valeur finale les rendrait visibles prématurément.
            //
            // EN REVANCHE, si le premier keyframe de géométrie EST à t=0
            // (times[0] <= 0.0005), écrire la valeur dans le .tscn est parfaitement sûr :
            // c'est exactement ce que l'AnimationPlayer affichera dès le départ.
            // Sans cet écrit, les Polygon2D restent avec polygon vide dans le .tscn →
            // ils sont transparents quand la scène est instanciée dans une scène parente
            // sans que l'AnimationPlayer n'ait encore joué (ex: ouverture dans l'éditeur).
            var isLateGeometry = (propName === "polygon" || propName === "polygons"
                                  || propName === "points" || propName === "uv")
                                 && tr.keys.times[0] > 0.0005;
            if (root && colonIdx !== -1 && !isLateGeometry) {
                    var nodePath = tr.path.substring(0, colonIdx);
                    var targetNode = root.getNodeOrNull(nodePath);
                    if (targetNode) {
                        var valAtZero = firstVal;
                        for (var k = 0; k < tr.keys.times.length; k++) {
                            if (tr.keys.times[k] <= 0.0005) {
                                valAtZero = tr.keys.values[k];
                            }
                        }

                        if (typeof valAtZero === "boolean")          targetNode.properties[propName] = valAtZero;
                        else if (typeof valAtZero === "number") {
                            if (propName === "process_mode")   targetNode.properties[propName] = valAtZero;
                            else                               targetNode.properties[propName] = _f(valAtZero);
                        }
                        else if (valAtZero && valAtZero.x !== undefined)   targetNode.properties[propName] = _vec2(valAtZero.x, valAtZero.y);
                        else if (valAtZero && valAtZero.ext !== undefined) targetNode.properties[propName] = 'ExtResource("' + valAtZero.ext + '")';
                        else                                   targetNode.properties[propName] = valAtZero;
                    }
            }
        } else {
            // Piste statique : on l'efface de l'animation, MAIS on applique sa valeur dans le .tscn
            if (root && colonIdx !== -1) {
                var nodePath = tr.path.substring(0, colonIdx);
                var targetNode = root.getNodeOrNull(nodePath);
                if (targetNode) {
                    if (typeof firstVal === "boolean")          targetNode.properties[propName] = firstVal;
                    else if (typeof firstVal === "number") {
                        if (propName === "process_mode")   targetNode.properties[propName] = firstVal; // Pas de décimales pour les enums !
                        else                               targetNode.properties[propName] = _f(firstVal);
                    }
                    else if (firstVal && firstVal.x !== undefined)   targetNode.properties[propName] = _vec2(firstVal.x, firstVal.y);
                    else if (firstVal && firstVal.ext !== undefined) targetNode.properties[propName] = 'ExtResource("' + firstVal.ext + '")';
                    else                                   targetNode.properties[propName] = firstVal;
                              }
            }
            delete this._trackIndex["$" + tr.path + "\u0001" + tr.type];
        }
    }
    this.tracks = optimizedTracks;
};


GAnimation.prototype.addTrackKey = function(path, typeStr, time, value, transition) {
    var tIdx = this.findTrack(path, typeStr);
    if (tIdx === -1) {
        var updateMode = 0;
        var interp = 1;
        if (path.indexOf(":visible") !== -1 || path.indexOf(":texture") !== -1
                || typeStr === "object" || typeStr === "bool"
                || path.indexOf(":polygon") !== -1 || path.indexOf(":points") !== -1
                || path.indexOf(":uv") !== -1 || path.indexOf("/shape:position") !== -1
                || path.indexOf(":process_mode") !== -1) {
            updateMode = 1;
            interp = 0;
        } else if (path.indexOf(":rotation") !== -1 || path.indexOf(":skew") !== -1) {
            interp = 3;
        }

        this.tracks.push({
            path: path, type: typeStr, imported: false, enabled: true,
            interp: interp, loop_wrap: false,
            keys: { times: [], transitions: [], update: updateMode, values: [] }
        });
        tIdx = this.tracks.length - 1;
        this._trackIndex["$" + path + "\u0001" + typeStr] = tIdx;
    }

    var tr = this.tracks[tIdx];
    time = Math.round(time * 1000) / 1000;

    var exactMatchIdx = -1;
    for (var i = 0; i < tr.keys.times.length; i++) {
        if (Math.abs(tr.keys.times[i] - time) < 0.0005) { exactMatchIdx = i; break; }
    }

    var insertIdx = tr.keys.times.length;
    if (exactMatchIdx === -1) {
        for (var i = 0; i < tr.keys.times.length; i++) {
            if (tr.keys.times[i] > time) { insertIdx = i; break; }
        }
    }

    var prevIdx = exactMatchIdx !== -1 ? exactMatchIdx - 1 : insertIdx - 1;
    var trans = transition !== undefined ? transition : 1.0;
    if (prevIdx >= 0 && _eq(tr.keys.values[prevIdx], value)
            && Math.abs(tr.keys.transitions[prevIdx] - trans) < 0.001) {
        if (exactMatchIdx !== -1) {
            tr.keys.times.splice(exactMatchIdx, 1);
            tr.keys.transitions.splice(exactMatchIdx, 1);
            tr.keys.values.splice(exactMatchIdx, 1);
        }
        return;
    }

    if (exactMatchIdx !== -1) {
        if (path.indexOf(":visible") !== -1 && tr.keys.values[exactMatchIdx] === true && value === false) {
            // Un élément se termine exactement au moment où un autre élément de la même variante commence.
            // On ne doit pas écraser 'true' avec 'false', sinon l'élément devient invisible !
        } else if (path.indexOf(":process_mode") !== -1 && tr.keys.values[exactMatchIdx] === 0 && value === 4) {
            // Même chose pour process_mode : on ne doit pas écraser '0' (INHERIT) avec '4' (DISABLED)
        } else {
            tr.keys.values[exactMatchIdx] = value;
            tr.keys.transitions[exactMatchIdx] = trans;
        }
    } else {
        tr.keys.times.splice(insertIdx, 0, time);
        tr.keys.transitions.splice(insertIdx, 0, trans);
        tr.keys.values.splice(insertIdx, 0, value);
    }
};

function _isExtResourceUsedInNode(node, marker) {
    for (var p in node.properties) {
        var v = node.properties[p];
        if (typeof v === "string" && v.indexOf(marker) !== -1) return true;
    }
    for (var i = 0; i < node.children.length; i++) {
        if (_isExtResourceUsedInNode(node.children[i], marker)) return true;
    }
    return false;
}

function _isExtResourceUsedInAnim(anim, marker) {
    if (!anim || !anim.tracks) return false;
    for (var i = 0; i < anim.tracks.length; i++) {
        var tr = anim.tracks[i];
        if (!tr.keys || !tr.keys.values) continue;
        for (var k = 0; k < tr.keys.values.length; k++) {
            var v = tr.keys.values[k];
            if (typeof v === "string" && v.indexOf(marker) !== -1) return true;
            if (v && typeof v === "object" && v.ext && marker.indexOf('"' + v.ext + '"') !== -1) return true;
        }
    }
    return false;
}

function _removeOrphanExtResource(root, anim, id, extResources, extIdMap) {
    var marker = 'ExtResource("' + id + '")';
    if (_isExtResourceUsedInNode(root, marker)) return false;
    if (_isExtResourceUsedInAnim(anim, marker)) return false;

    var pattern = 'id="' + id + '"';
    for (var i = 0; i < extResources.length; i++) {
        if (extResources[i].indexOf(pattern) !== -1) {
            for (var path in extIdMap) {
                if (extIdMap[path] === id) { delete extIdMap[path]; break; }
            }
            extResources.splice(i, 1);
            return true;
        }
    }
    return false;
}

function _inlineMaskAsSprite(node, boundsLookup, exportDir, getExt, scaleFactor, root, anim, extResources, extIdMap) {
    if (!boundsLookup || !exportDir || !getExt) return false;
    if (!scaleFactor) scaleFactor = 1.0;

    var nodeName = node.name || "";
    var symPrefix = nodeName.indexOf("instance_") === 0 ? nodeName.substring(9) : nodeName;
    if (!symPrefix) return false;

    var matchedFile = null;
    for (var fn in boundsLookup) {
        if (fn.indexOf(symPrefix + "_") === 0 && fn.indexOf("_SHAPE_") !== -1 && fn.indexOf("_BOUNDS_") !== -1) {
            matchedFile = boundsLookup[fn];
            break;
        }
    }
    if (!matchedFile) {
        if (typeof fl !== "undefined") fl.trace("  -> [mask inline] no PNG found for " + symPrefix + ", clip_children won't hide the mask");
        return false;
    }

    var meta = _parsePngFilename(matchedFile);
    if (!meta.pngWidth || !meta.pngHeight) {
        if (typeof fl !== "undefined") fl.trace("  -> [mask inline] PNG " + matchedFile + " missing SIZE info");
        return false;
    }

    var instProp = node.properties["instance"] || "";
    var idMatch = instProp.match(/ExtResource\("([^"]+)"\)/);
    var orphanCandidateId = idMatch ? idMatch[1] : null;

    node.type = "Sprite2D";
    delete node.properties["instance"];

    var tex = RES_PREFIX + "img/" + matchedFile;
    node.properties["texture"] = "ExtResource(\"" + getExt(tex, "Texture2D") + "\")";
    node.properties["centered"] = true;

    var spriteScale = (meta.spriteScale !== undefined) ? meta.spriteScale : 1.0;
    var cx, cy;
    if (meta.useAbsoluteBounds) {
        cx = meta.boundsX * scaleFactor + (meta.pngWidth / 2.0) * spriteScale;
        cy = meta.boundsY * scaleFactor + (meta.pngHeight / 2.0) * spriteScale;
    } else {
        cx = (meta.pngWidth / 2.0) * spriteScale;
        cy = (meta.pngHeight / 2.0) * spriteScale;
    }
    node.properties["position"] = _vec2(cx, cy);
    if (spriteScale !== 1.0) {
        node.properties["scale"] = _vec2(spriteScale, spriteScale);
    }

    if (orphanCandidateId && root && extResources && extIdMap) {
        _removeOrphanExtResource(root, anim, orphanCandidateId, extResources, extIdMap);
    }

    if (typeof fl !== "undefined") fl.trace("  -> [mask inline] " + symPrefix + " PackedScene -> Sprite2D (tex=" + matchedFile + ")");
    return true;
}

function _postProcessMasks(root, sym, anim, boundsLookup, exportDir, getExt, scaleFactor, extResources, extIdMap) {
    if (!sym.layers) return;

    function _findMaskSprite(layerNode) {
        for (var c = 0; c < layerNode.children.length; c++) {
            var wrapper = layerNode.children[c];
            if (wrapper.name === "AnimationPlayer") continue;
            // Le wrapper EST directement le node visuel (cas normal depuis que
            // les shapes single-fill ET multi-fill n'ont plus de Node2D
            // intermédiaire) : pas besoin de descendre dans ses enfants.
            if (wrapper.type === "Sprite2D" || wrapper.type === "Polygon2D" || wrapper.type === "PackedScene") {
                return { sprite: wrapper, wrapper: wrapper };
            }
            for (var ic = 0; ic < wrapper.children.length; ic++) {
                var inner = wrapper.children[ic];
                if (inner.type === "Sprite2D" || inner.type === "Polygon2D" || inner.type === "PackedScene") {
                    return { sprite: inner, wrapper: wrapper };
                } else if (inner.type === "Node2D") {
                    for (var gc = 0; gc < inner.children.length; gc++) {
                        var gch = inner.children[gc];
                        if (gch.type === "Polygon2D" || gch.type === "Sprite2D") {
                            return { sprite: gch, wrapper: wrapper };
                        }
                    }
                }
            }
        }
        return null;
    }

    // Desambiguisation des noms de calques dupliques, pour les VRAIS calques
    // mask (layerType === "mask"). Les calques "guide" Flash ne publient
    // jamais de contenu visuel et ne sont jamais traites comme des masques :
    // confirme empiriquement qu'un calque "guide" nomme "Time" peut etre une
    // simple reference de timing (lue par de l'AS3), pas un masque visuel.
    var maskLayerNames = {};
    for (var i = 0; i < sym.layers.length; i++) {
        var l = sym.layers[i];
        if (l.layerType === "mask") {
            maskLayerNames[l.name] = l.unique_name;
        }
    }

    var maskDataMap = {}; // Maps layer.name to mask data object

    for (var i = 0; i < sym.layers.length; i++) {
        var layer = sym.layers[i];
        if (layer.layerType === "mask") {
            var layerName = _sanitize_name(layer.unique_name);
            var layerNode = root.getNodeOrNull(layerName);
            if (!layerNode) continue;
            
            var found = _findMaskSprite(layerNode);
            if (found) {
                var currentMaskSprite = found.sprite;
                var currentMaskWrapper = found.wrapper;
                
                if (currentMaskSprite.type === "PackedScene") {
                    var inlined = _inlineMaskAsSprite(currentMaskSprite, boundsLookup, exportDir, getExt, scaleFactor, root, anim, extResources, extIdMap);
                    if (!inlined) {
                        if (typeof fl !== "undefined") fl.trace("  -> [mask] skipping mask processing for " + sym.name + "/" + layer.name + " (inlining failed)");
                        continue;
                    }
                }
                
                currentMaskSprite.properties["clip_children"] = 1;
                var currentMaskWrapperPath = root.getPathTo(currentMaskWrapper);
                var maskSpritePath = root.getPathTo(currentMaskSprite);

                if (currentMaskWrapper.properties["modulate"] !== undefined) {
                    currentMaskSprite.properties["self_modulate"] = currentMaskWrapper.properties["modulate"];
                    delete currentMaskWrapper.properties["modulate"];
                }

                var maskPos = {x: 0, y: 0};
                var hasPosTrack = false;
                var maskPosTrackIdx = -1;
                var maskScale = {x: 1, y: 1};
                var hasScaleTrack = false;
                var maskScaleTrackIdx = -1;
                
                if (anim) {
                    for (var tIdx = 0; tIdx < anim.tracks.length; tIdx++) {
                        var trackPath = anim.tracks[tIdx].path;
                        if (trackPath === currentMaskWrapperPath + ":position") {
                            hasPosTrack = true;
                            maskPosTrackIdx = tIdx;
                            if (anim.tracks[tIdx].keys.values.length > 0) {
                                maskPos = anim.tracks[tIdx].keys.values[0];
                            }
                        } else if (trackPath === currentMaskWrapperPath + ":scale") {
                            hasScaleTrack = true;
                            maskScaleTrackIdx = tIdx;
                            if (anim.tracks[tIdx].keys.values.length > 0) {
                                maskScale = anim.tracks[tIdx].keys.values[0];
                            }
                        } else if (trackPath === currentMaskWrapperPath + ":modulate") {
                            anim.tracks[tIdx].path = maskSpritePath + ":self_modulate";
                        }
                    }
                }
                
                maskDataMap[layer.name] = {
                    sprite: currentMaskSprite,
                    wrapper: currentMaskWrapper,
                    pos: maskPos,
                    hasPosTrack: hasPosTrack,
                    posTrackIdx: maskPosTrackIdx,
                    scale: maskScale,
                    hasScaleTrack: hasScaleTrack,
                    scaleTrackIdx: maskScaleTrackIdx
                };
            }
        }
    }

    for (var i = 0; i < sym.layers.length; i++) {
        var layer = sym.layers[i];
        var isGuidedLayer = (layer.layerType === "masked")
            || (layer.layerType === "normal" && layer.parentLayerName && maskLayerNames[layer.parentLayerName] !== undefined);

        if (!isGuidedLayer) continue;
        
        var maskName = layer.parentLayerName;
        var maskData = maskDataMap[maskName];
        if (!maskData) continue;
        
        var currentMaskSprite = maskData.sprite;
        var currentMaskWrapper = maskData.wrapper;
        var maskPos = maskData.pos;
        var hasPosTrack = maskData.hasPosTrack;
        var maskPosTrackIdx = maskData.posTrackIdx;
        var maskScale = maskData.scale;
        var hasScaleTrack = maskData.hasScaleTrack;
        var maskScaleTrackIdx = maskData.scaleTrackIdx;
        var currentMaskLayerName = maskName;

        var layerName = _sanitize_name(layer.unique_name);
        var layerNode = root.getNodeOrNull(layerName);
        if (!layerNode) continue;
        
        var maskLayerNode = root.getNodeOrNull(_sanitize_name(maskLayerNames[currentMaskLayerName]));
        if (maskLayerNode && maskLayerNode.properties["visible"] === false) {
            delete maskLayerNode.properties["visible"];
        }

        var oldPath = root.getPathTo(layerNode);
        layerNode.parent.removeChild(layerNode);
        currentMaskSprite.prependChild(layerNode);
        layerNode.owner = root;

        var mx = maskPos.x, my = maskPos.y;
        var sx = 0, sy = 0;
        var ssx = 1.0, ssy = 1.0;
        if (currentMaskSprite !== currentMaskWrapper) {
            if (currentMaskSprite.properties["position"]) {
                var match = currentMaskSprite.properties["position"].match(/Vector2\(([^,]+),\s*([^)]+)\)/);
                if (match) { sx = parseFloat(match[1]); sy = parseFloat(match[2]); }
            }
        }
        if (currentMaskSprite.properties["scale"]) {
            var smatch = currentMaskSprite.properties["scale"].match(/Vector2\(([^,]+),\s*([^)]+)\)/);
            if (smatch) { ssx = parseFloat(smatch[1]); ssy = parseFloat(smatch[2]); }
        }
        
        if (hasScaleTrack) {
            ssx *= maskScale.x;
            ssy *= maskScale.y;
        }

        var invX = (-mx - sx) / ssx;
        var invY = (-my - sy) / ssy;
        layerNode.properties["position"] = _vec2(invX, invY);
        if (ssx !== 1.0 || ssy !== 1.0) {
            layerNode.properties["scale"] = _vec2(1.0 / ssx, 1.0 / ssy);
        }

        var newPath = root.getPathTo(currentMaskSprite) + "/" + layerNode.name;
        
        if (anim && hasPosTrack && maskPosTrackIdx !== -1) {
            var mTrack = anim.tracks[maskPosTrackIdx];
            for (var m = 0; m < mTrack.keys.times.length; m++) {
                var mTime = mTrack.keys.times[m];
                var mVal = mTrack.keys.values[m];
                var mTrans = mTrack.keys.transitions[m];
                var curScaleX = ssx;
                var curScaleY = ssy;
                
                if (hasScaleTrack && maskScaleTrackIdx !== -1) {
                    var sTrack = anim.tracks[maskScaleTrackIdx];
                    var scaleMatch = null;
                    for (var sm = 0; sm < sTrack.keys.times.length; sm++) {
                        if (sTrack.keys.times[sm] <= mTime) {
                            scaleMatch = sTrack.keys.values[sm];
                        } else { break; }
                    }
                    if (scaleMatch) {
                        curScaleX = scaleMatch.x;
                        curScaleY = scaleMatch.y;
                    }
                }
                
                var ivX = (-mVal.x - sx) / curScaleX;
                var ivY = (-mVal.y - sy) / curScaleY;
                anim.addTrackKey(newPath + ":position", "value", mTime, {x: ivX, y: ivY}, mTrans);
            }
        }
        
        if (anim && hasScaleTrack && maskScaleTrackIdx !== -1) {
            var sTrack = anim.tracks[maskScaleTrackIdx];
            for (var m = 0; m < sTrack.keys.times.length; m++) {
                var mTime = sTrack.keys.times[m];
                var mVal = sTrack.keys.values[m];
                var mTrans = sTrack.keys.transitions[m];
                var ivX = 1.0 / mVal.x;
                var ivY = 1.0 / mVal.y;
                anim.addTrackKey(newPath + ":scale", "value", mTime, {x: ivX, y: ivY}, mTrans);
            }
        }

        if (anim) {
            for (var tIdx = 0; tIdx < anim.tracks.length; tIdx++) {
                var trackPath = anim.tracks[tIdx].path;
                if (trackPath === oldPath
                        || trackPath.indexOf(oldPath + "/") === 0
                        || trackPath.indexOf(oldPath + ":") === 0) {
                    anim.tracks[tIdx].path = newPath + trackPath.substring(oldPath.length);
                }
            }
        }
    }
}

// Quand une track est définie pour la première fois APRÈS le début d'un slice,
// elle est actuellement omise du slice (pas de lastVal, pas de keys en range).
// Mais Godot ne touche pas à la propriété au playback -> la valeur héritée d'une
// animation précédente RESTE en place. Pour les "shape data" (polygon, points,
// uv, width), ça fait persister visuellement des éléments d'animations précédentes
// (ex: bouche "crying" qui reste affichée pendant "normal" sur Layer_1/shape_0/shape
// qui est :visible=true mais sans tracks polygon dans "normal").
//
// Reproduit le comportement Flash : à frame 0 ("normal"), seuls les éléments du
// keyframe sont dessinés ; les polys/lines absents sont vides.
//
// Pour les transforms (position/rotation/scale/skew/modulate), la sémantique
// "carry-over depuis la dernière anim" reste correcte parce qu'ils ne créent pas
// d'éléments visibles supplémentaires : ils ne modifient que l'apparence d'éléments
// déjà rendus, et leur wrapper a déjà sa propre piste :visible qui les masque
// quand il ne devrait pas être visible.
function _shapeDataReset(path) {
    var colonIdx = path.lastIndexOf(":");
    if (colonIdx === -1) return undefined;
    var propName = path.substring(colonIdx + 1);
    if (propName === "visible") return false;
    if (propName === "polygon") return "PackedVector2Array()";
    if (propName === "polygons") return "[]";
    if (propName === "points")  return "PackedVector2Array()";
    if (propName === "uv")      return "PackedVector2Array()";
    if (propName === "width")   return 0.0;
    if (propName === "shader_parameter/color_mult") return _vec4(1.0, 1.0, 1.0, 1.0);
    if (propName === "shader_parameter/color_offset_255") return _vec4(0.0, 0.0, 0.0, 0.0);
    return undefined;
}

function _sliceAnimation(anim, start, end, padShapeResets) {
    // Les keys de la big anim sont arrondies à 3 décimales par addTrackKey
    // (`Math.round(time * 1000) / 1000`), alors que les labels sont calculés
    // comme `kf.startFrame / frameRate` sans arrondi. Pour frame 71 à 30fps :
    // label = 2.36666..., key = 2.367 -> écart 0.33ms.
    // Sans alignement, la vraie key du keyframe Flash tombe à slice_t=0.0003
    // au lieu de slice_t=0. Le test `nTimes[0] > 0.0001` déclenche alors le
    // carry-over du `lastVal` (état de l'animation précédente), qui insère une
    // key fantôme à t=0. Sur une piste :visible ça donne 0.3ms d'élément hérité
    // visible au début du label (ex: bouche `crying` au début de `star`),
    // visuellement perçu comme "le truc de l'anim précédente est resté".
    //
    // En arrondissant start/end à la même précision que les keys, la vraie key
    // du keyframe tombe exactement à slice_t=0 et le carry-over est supprimé.
    start = Math.round(start * 1000) / 1000;
    end   = Math.round(end   * 1000) / 1000;

    var sliced = new GAnimation();
    sliced.step = anim.step;
    sliced.length = end - start;
    if (sliced.length <= 0) sliced.length = 0.001;

    for (var i = 0; i < anim.tracks.length; i++) {
        var tr = anim.tracks[i];
        var nTimes = [], nValues = [], nTrans = [];
        var lastVal = null, lastTrans = 1.0;

        for (var k = 0; k < tr.keys.times.length; k++) {
            var t = tr.keys.times[k];
            if (t <= start + 0.0001) {
                lastVal = tr.keys.values[k];
                lastTrans = tr.keys.transitions[k];
            }
            if (t >= start - 0.0001 && t < end - 0.0001) {
                nTimes.push(safeNum(t - start));
                nValues.push(tr.keys.values[k]);
                nTrans.push(tr.keys.transitions[k]);
            }
        }
        if (nTimes.length === 0 || nTimes[0] > 0.0001) {
            if (lastVal !== null) {
                nTimes.unshift(0);
                nValues.unshift(lastVal);
                nTrans.unshift(lastTrans);
            } else if (padShapeResets) {
                var resetVal = _shapeDataReset(tr.path);
                if (resetVal !== undefined) {
                    nTimes.unshift(0);
                    nValues.unshift(resetVal);
                    nTrans.unshift(1.0);
                }
            }
        }

        if (nTimes.length > 0) {
            sliced.tracks.push({
                path: tr.path, type: tr.type, imported: tr.imported, enabled: tr.enabled,
                interp: tr.interp, loop_wrap: tr.loop_wrap,
                keys: { times: nTimes, transitions: nTrans, update: tr.keys.update, values: nValues }
            });
        }
    }
    return sliced;
}

function serializeTscn(root, extResources, subResources) {
    var lines = [];
    lines.push('[gd_scene load_steps=' + (extResources.length + subResources.length + 1)
        + ' format=3 uid="uid://' + nextId() + '"]');
    lines.push('');
    for (var i = 0; i < extResources.length; i++) lines.push(extResources[i]);
    lines.push('');
    for (var i = 0; i < subResources.length; i++) lines.push(subResources[i]);
    lines.push('');

    function walk(node, parentPath) {
        var nodeLine = '[node name="' + node.name + '"';
        if (node.type && !node.properties["instance"]) nodeLine += ' type="' + node.type + '"';
        if (parentPath) nodeLine += ' parent="' + parentPath + '"';
        else if (node !== root) nodeLine += ' parent="."';

        for (var p in node.properties) {
            if (p === "instance") nodeLine += ' instance=' + node.properties[p];
        }
        lines.push(nodeLine + ']');

        for (var p in node.properties) {
            if (p !== "instance") lines.push(p + ' = ' + node.properties[p]);
        }
        lines.push('');

        var myPath = (node === root)
            ? "."
            : ((parentPath === "." || !parentPath) ? node.name : parentPath + "/" + node.name);
        for (var i = 0; i < node.children.length; i++) walk(node.children[i], myPath);
    }

    walk(root, null);
    return lines.join('\n');
}

function _setupMaterials(node, isRoot) {
    var hasSprite = false;
    if (node.type === "Sprite2D" || node.type === "PackedScene" || node.type === "Polygon2D") hasSprite = true;
    for (var i = 0; i < node.children.length; i++) {
        if (_setupMaterials(node.children[i], false)) hasSprite = true;
    }
    if (node.type === "Node2D" || node.type === "Sprite2D" || node.type === "ColorRect" || node.type === "PackedScene" || node.type === "Polygon2D") {
        if (node.properties["material"]) {
            node.properties["use_parent_material"] = false;
        } else if (node.parent && node.parent.type === "CanvasGroup") {
            node.properties["use_parent_material"] = false;
        } else {
            node.properties["use_parent_material"] = (hasSprite && !isRoot);
        }
    }
    return hasSprite;
}

function _processElementNode(elem, parent, ownerRoot, anim, startTime, duration, frameRate,
                             wrapperName, exportDir, scaleFactor, symName, startFrameIndex,
                             maxTime, kfTransition, shaderNeeds, customTexPath, layerType,
                             getExt, subResources, isStaticLayer, modulateNeedsCanvasGroup, gradCache, layerZIndex) {
    if (parent !== ownerRoot && !parent.parent) {
        ownerRoot.addChild(parent);
    }

    var skipWrapper = true; // User requested to remove wrapper nodes to optimize node count
    if (elem.elementType === "instance" && !shaderNeeds && modulateNeedsCanvasGroup) {
        skipWrapper = false; // We MUST use a wrapper if we need to change the node type to CanvasGroup
    }
    
    var wrapperNode, node;
    var isNewWrapper = false, isNewNode = false;

    if (skipWrapper) {
        node = parent.getNodeOrNull(wrapperName);
        if (!node) {
            isNewNode = true;
            isNewWrapper = true;
            if (elem.polygons && elem.polygons.length > 0) {
                node = new GNode(wrapperName, "Polygon2D");
                node.properties["color"] = "Color(1, 1, 1, 1)";
            } else if (elem.elementType === "shape" && elem.strokes && elem.strokes.length > 0) {
                // Shape uniquement composée de traits (pas de fill) : le wrapper
                // devient directement le Line2D du premier trait au lieu d'un
                // Node2D + Line_0 enfant. Économise 1 node par shape "stroke-only"
                // (icônes, contours dessinés à la main, etc.). Si un keyframe
                // ultérieur de cette même occurrence a besoin de plusieurs traits,
                // le node est "démoté" en Node2D + Line_0..N enfants (voir plus
                // bas, symétrique du mécanisme déjà en place pour Polygon2D/Poly_N).
                node = new GNode(wrapperName, "Line2D");
                node.properties["joint_mode"] = "2";
                node.properties["begin_cap_mode"] = "2";
                node.properties["end_cap_mode"] = "2";
                node.properties["use_parent_material"] = "false";
            } else if (elem._inlineSprite || elem.elementType === "shape") {
                node = new GNode(wrapperName, "Sprite2D");
                node.properties["centered"] = true;
            } else if (elem.elementType === "instance") {
                node = new GNode(wrapperName, "PackedScene");
                var _spi = _symbolPathInfo(elem.symbolName);
                var resPath = RES_PREFIX + "symbols/" + _spi.subPath + ".tscn";
                node.properties["instance"] = "ExtResource(\"" + getExt(resPath, "PackedScene") + "\")";
            } else {
                node = new GNode(wrapperName, "Node2D");
            }
            parent.addChildRanked(node, layerZIndex);
            node.owner = ownerRoot;
        }
        wrapperNode = node;
    } else {
        wrapperNode = parent.getNodeOrNull(wrapperName);
        if (!wrapperNode) {
            isNewWrapper = true;
            var wrapperType = (!shaderNeeds && modulateNeedsCanvasGroup) ? "CanvasGroup" : "Node2D";
            wrapperNode = new GNode(wrapperName, wrapperType);
            parent.addChildRanked(wrapperNode, layerZIndex);
            wrapperNode.owner = ownerRoot;
        }

        var variantName = elem._sharedVariantName ? elem._sharedVariantName : elem.elementType;
        if (!elem._sharedVariantName && elem.symbolName) variantName += "_" + elem.symbolName;
        variantName = _sanitize_name(variantName);

        node = wrapperNode.getNodeOrNull(variantName);
        if (!node) {
            isNewNode = true;
            if (elem.elementType === "instance") {
                node = new GNode(variantName, "PackedScene");
                var _spi = _symbolPathInfo(elem.symbolName);
                var resPath = RES_PREFIX + "symbols/" + _spi.subPath + ".tscn";
                node.properties["instance"] = "ExtResource(\"" + getExt(resPath, "PackedScene") + "\")";
            } else {
                node = new GNode(variantName, "Node2D");
            }
            wrapperNode.addChild(node);
            node.owner = ownerRoot;
        }
    }

    var wrapperPathStr = ownerRoot.getPathTo(wrapperNode);
    var variantPathStr = ownerRoot.getPathTo(node);

    // Cas rare : cette occurrence poolée avait été créée en Line2D direct
    // (shape stroke-only sur son premier keyframe) mais le keyframe courant
    // lui donne un fill (elem.polygons non vide). On démote vers Node2D et on
    // relocalise le trait existant en Line_0 avant que la logique polygone
    // ci-dessous ne décide du nommage de ses propres nodes.
    if (node.type === "Line2D" && elem.polygons && elem.polygons.length > 0) {
        node.type = "Node2D";
        delete node.properties["joint_mode"];
        delete node.properties["begin_cap_mode"];
        delete node.properties["end_cap_mode"];
        delete node.properties["use_parent_material"];
        delete node.properties["points"];
        delete node.properties["width"];
        delete node.properties["default_color"];
        if (typeof anim !== 'undefined' && anim && anim.tracks) {
            var fixLineProps = [":points", ":width", ":default_color"];
            for (var t = 0; t < anim.tracks.length; t++) {
                var tr = anim.tracks[t];
                for (var f = 0; f < fixLineProps.length; f++) {
                    if (tr.path === variantPathStr + fixLineProps[f]) {
                        delete anim._trackIndex["$" + tr.path + "\u0001" + tr.type];
                        tr.path = variantPathStr + "/Line_0" + fixLineProps[f];
                        anim._trackIndex["$" + tr.path + "\u0001" + tr.type] = t;
                    }
                }
            }
        }
    }

    var offsetDx = 0.0, offsetDy = 0.0;
    var useAbsoluteBounds = false;
    var boundsX = 0.0, boundsY = 0.0;
    var pngWidth, pngHeight;

    if (elem.elementType === "shape" || elem._inlineSprite) {
        var polyGroups = null;
        if (elem.polygons && elem.polygons.length > 0) {
            polyGroups = [];
            if (elem._isTweenShape) {
                for (var p = 0; p < elem.polygons.length; p++) {
                    polyGroups.push({
                        isGradient: !!elem.polygons[p].gradient,
                        gradient: elem.polygons[p].gradient,
                        color: elem.polygons[p].color,
                        polygons: [elem.polygons[p]]
                    });
                }
            } else {
                for (var p = 0; p < elem.polygons.length; p++) {
                    var polyData = elem.polygons[p];
                    var sig = "";
                    if (polyData.gradient) {
                        sig = "GRAD:" + (polyData.gradient.style || "") + "|";
                        if (polyData.gradient.colors) sig += polyData.gradient.colors.join(",") + "|";
                        if (polyData.gradient.pos) sig += polyData.gradient.pos.join(",") + "|";
                        if (polyData.gradient.matrix) {
                            var m = polyData.gradient.matrix;
                            sig += m.a + "," + m.b + "," + m.c + "," + m.d + "," + m.tx + "," + m.ty;
                        }
                    } else {
                        sig = "SOLID:" + polyData.color;
                    }

                    var bLeft = 999999, bRight = -999999, bTop = 999999, bBottom = -999999;
                    for (var v = 0; v < polyData.vertices.length; v++) {
                        var vx = polyData.vertices[v].x, vy = polyData.vertices[v].y;
                        if (vx < bLeft) bLeft = vx;
                        if (vx > bRight) bRight = vx;
                        if (vy < bTop) bTop = vy;
                        if (vy > bBottom) bBottom = vy;
                    }

                    var targetGroupIdx = -1;
                    for (var gIdx = polyGroups.length - 1; gIdx >= 0; gIdx--) {
                        var group = polyGroups[gIdx];
                        if (group.sig === sig) {
                            targetGroupIdx = gIdx;
                            break;
                        }
                        if (!(bLeft > group.bRight || bRight < group.bLeft || bTop > group.bBottom || bBottom < group.bTop)) {
                            break;
                        }
                    }

                    if (targetGroupIdx === -1) {
                        polyGroups.push({
                            sig: sig,
                            isGradient: !!polyData.gradient,
                            gradient: polyData.gradient,
                            color: polyData.color,
                            bLeft: bLeft, bRight: bRight, bTop: bTop, bBottom: bBottom,
                            polygons: [polyData]
                        });
                    } else {
                        var group = polyGroups[targetGroupIdx];
                        group.polygons.push(polyData);
                        if (bLeft < group.bLeft) group.bLeft = bLeft;
                        if (bRight > group.bRight) group.bRight = bRight;
                        if (bTop < group.bTop) group.bTop = bTop;
                        if (bBottom > group.bBottom) group.bBottom = bBottom;
                    }
                }
            }

            // NOTE : on NE force plus la démotion Polygon2D -> Node2D quand
            // polyGroups.length > 1. Le node lui-même héberge le groupe 0
            // (comme pour le cas single-group), les groupes suivants devenant
            // des enfants Poly_0, Poly_1... (voir l'offset -1 juste en dessous).
            // Ça économise 1 node Node2D par shape multi-couleurs/gradients
            // (ex: "shape_layer_X" qui n'était qu'un conteneur vide autour de
            // Poly_0/Poly_1). Les boucles de nettoyage des slots excédentaires
            // (excess Poly_X et anim._maxPoly) appliquent le même offset -1
            // pour rester cohérentes avec ce nommage.

            for (var gIdx = 0; gIdx < polyGroups.length; gIdx++) {
                var group = polyGroups[gIdx];
                var polyNodeName = (gIdx === 0 && node.type === "Polygon2D") ? "" : "Poly_" + ((gIdx > 0 && node.type === "Polygon2D") ? (gIdx - 1) : gIdx);
                var polyNode;
                
                if (polyNodeName === "") {
                    polyNode = node;
                } else {
                    polyNode = node.getNodeOrNull(polyNodeName);
                    if (!polyNode) {
                        polyNode = new GNode(polyNodeName, "Polygon2D");
                        polyNode.properties["color"] = "Color(1, 1, 1, 1)";
                        node.addChild(polyNode);
                        polyNode.owner = ownerRoot;
                    }
                }
                
                var pointsParts = [];
                var uvParts = [];
                var polygonsParts = [];
                var vertexOffset = 0;
                var hasUv = false;
                var invA, invB, invC, invD, invTx, invTy;
                
                if (!group) {
                    __log("ERROR: group is undefined! gIdx=" + gIdx + " length=" + polyGroups.length + " in elem=" + elem.name);
                    for (var dbg = 0; dbg < polyGroups.length; dbg++) {
                        __log("  polyGroups[" + dbg + "] = " + (polyGroups[dbg] ? "defined" : "undefined"));
                    }
                    continue; // Skip to avoid crash
                }
                
                if (group.isGradient && group.gradient && group.gradient.matrix) {
                    hasUv = true;
                    var m = group.gradient.matrix;
                    var det = m.a * m.d - m.b * m.c;
                    invA = m.d / det;
                    invB = -m.b / det;
                    invC = -m.c / det;
                    invD = m.a / det;
                    invTx = (m.c * m.ty - m.d * m.tx) / det;
                    invTy = (m.b * m.tx - m.a * m.ty) / det;
                } else if (group.color) {
                    hasUv = false;
                }

                for (var p = 0; p < group.polygons.length; p++) {
                    var polyData = group.polygons[p];
                    var effectiveVerts = polyData.vertices;
                    var isBridged = false;
                    if (polyData.holes && polyData.holes.length > 0) {
                        var bridged = _bridgeHoles(polyData.vertices, polyData.holes);
                        if (bridged && (bridged.length > 500 || !_hasSelfIntersection(bridged))) {
                            effectiveVerts = bridged;
                            isBridged = true;
                        } else {
                            effectiveVerts = polyData.vertices;
                        }
                    }

                    var finalVerts = [];
                    for (var v = 0; v < effectiveVerts.length; v++) {
                        var px = effectiveVerts[v].x;
                        var py = effectiveVerts[v].y;
                        if (finalVerts.length > 0) {
                            var lastV = finalVerts[finalVerts.length - 1];
                            var dx = px - lastV.x;
                            var dy = py - lastV.y;
                            if (dx*dx + dy*dy < 0.000001) continue; 
                        }
                        finalVerts.push(effectiveVerts[v]);
                        
                        while (finalVerts.length >= 3) {
                            var len = finalVerts.length;
                            var A = finalVerts[len - 3];
                            var B = finalVerts[len - 2];
                            var C = finalVerts[len - 1];
                            var v1x = B.x - A.x;
                            var v1y = B.y - A.y;
                            var v2x = C.x - B.x;
                            var v2y = C.y - B.y;
                            var l1 = Math.sqrt(v1x*v1x + v1y*v1y);
                            var l2 = Math.sqrt(v2x*v2x + v2y*v2y);
                            if (l1 > 0.001 && l2 > 0.001) {
                                var dot = (v1x*v2x + v1y*v2y) / (l1*l2);
                                if (dot < -0.99) {
                                    finalVerts.splice(len - 2, 1);
                                    continue;
                                }
                            }
                            break;
                        }
                    }
                    
                    if (finalVerts.length > 2) {
                        var firstV = finalVerts[0];
                        var lastV = finalVerts[finalVerts.length - 1];
                        var dx = firstV.x - lastV.x;
                        var dy = firstV.y - lastV.y;
                        if (dx*dx + dy*dy < 0.000001) {
                            finalVerts.pop();
                        }
                    }
                    
                    if (finalVerts.length > 3 && finalVerts.length <= 500 && _hasSelfIntersection(finalVerts)) {
                        finalVerts = _removeSelfIntersections(finalVerts);
                    }

                    var indices = [];
                    for (var v = 0; v < finalVerts.length; v++) {
                        var px = finalVerts[v].x;
                        var py = finalVerts[v].y;
                        pointsParts.push(_f(px * scaleFactor) + ", " + _f(py * scaleFactor));
                        indices.push(vertexOffset + v);
                        
                        if (hasUv) {
                            if (group.gradient) {
                                var gx = px * invA + py * invC + invTx;
                                var gy = px * invB + py * invD + invTy;
                                var u = (gx + 819.2) / 1638.4;
                                var v_uv = (gy + 819.2) / 1638.4;
                                if (group.gradient.style === "linearGradient") {
                                    u *= 256.0;
                                    v_uv = 0.5;
                                } else {
                                    u *= 64.0;
                                    v_uv *= 64.0;
                                }
                                uvParts.push(_f(u) + ", " + _f(v_uv));
                            } else {
                                uvParts.push(_f(px / 1000.0) + ", " + _f(py / 1000.0));
                            }
                        } else {
                            uvParts.push("0, 0");
                        }
                    }
                    polygonsParts.push("PackedInt32Array(" + indices.join(", ") + ")");
                    vertexOffset += finalVerts.length;
                }
                
                var pointsStr = "PackedVector2Array(" + pointsParts.join(", ") + ")";
                var uvsStr = "PackedVector2Array(" + uvParts.join(", ") + ")";
                var polygonsStr = "[" + polygonsParts.join(", ") + "]";

                var texIdStr = "";
                if (group.gradient) {
                    var gSig = "GRAD:" + (group.gradient.style || "") + "|"
                        + group.gradient.colors.join(",") + "|"
                        + group.gradient.pos.join(",");
                    if (gradCache && gradCache[gSig]) {
                        texIdStr = gradCache[gSig];
                    } else {
                        var gradId = "Gradient_" + nextId();
                        var colorsStr = "PackedColorArray(";
                        var offsetsStr = "PackedFloat32Array(";
                        
                        for (var gc = 0; gc < group.gradient.colors.length; gc++) {
                            colorsStr += _colorFloats(group.gradient.colors[gc]);
                            offsetsStr += _f(group.gradient.pos[gc] / 255.0);
                            if (gc < group.gradient.colors.length - 1) {
                                colorsStr += ", ";
                                offsetsStr += ", ";
                            }
                        }
                        colorsStr += ")";
                        offsetsStr += ")";
                        
                        var gradStr = '[sub_resource type="Gradient" id="' + gradId + '"]\n';
                        gradStr += 'offsets = ' + offsetsStr + '\n';
                        gradStr += 'colors = ' + colorsStr + '\n';
                        subResources.push(gradStr);
                        
                        var texType = group.gradient.style === "linearGradient" ? "GradientTexture1D" : "GradientTexture2D";
                        var texId = "Texture_" + nextId();
                        texIdStr = 'SubResource("' + texId + '")';
                        var texStr = '[sub_resource type="' + texType + '" id="' + texId + '"]\n';
                        texStr += 'gradient = SubResource("' + gradId + '")\n';
                        if (texType === "GradientTexture2D") {
                            texStr += 'fill = 1\n';
                            texStr += 'fill_from = Vector2(0.5, 0.5)\n';
                            texStr += 'fill_to = Vector2(1, 0.5)\n';
                        }
                        subResources.push(texStr);
                        if (gradCache) gradCache[gSig] = texIdStr;
                    }
                } else if (group.color) {
                    var cSig = "SOLID:" + group.color;
                    if (gradCache && gradCache[cSig]) {
                        texIdStr = gradCache[cSig];
                    } else {
                        var gradId = "Gradient_" + nextId();
                        var hex = group.color;
                        var r = 1, g = 1, b = 1, a = 1;
                        if (hex && hex.charAt(0) === '#') {
                            r = parseInt(hex.substring(1,3), 16) / 255.0;
                            g = parseInt(hex.substring(3,5), 16) / 255.0;
                            b = parseInt(hex.substring(5,7), 16) / 255.0;
                            if (hex.length === 9) a = parseInt(hex.substring(7,9), 16) / 255.0;
                        }
                        var colorStr = _f(r) + ", " + _f(g) + ", " + _f(b) + ", " + _f(a);
                        
                        var gradStr = '[sub_resource type="Gradient" id="' + gradId + '"]\n';
                        gradStr += 'offsets = PackedFloat32Array(0, 1)\n';
                        gradStr += 'colors = PackedColorArray(' + colorStr + ', ' + colorStr + ')\n';
                        subResources.push(gradStr);
                        
                        var texId = "Texture_" + nextId();
                        texIdStr = 'SubResource("' + texId + '")';
                        var texStr = '[sub_resource type="GradientTexture1D" id="' + texId + '"]\n';
                        texStr += 'gradient = SubResource("' + gradId + '")\n';
                        texStr += 'width = 1\n';
                        subResources.push(texStr);
                        if (gradCache) gradCache[cSig] = texIdStr;
                    }
                }
                
                var polyPath = variantPathStr + (polyNodeName ? "/" + polyNodeName : "");
                if (isStaticLayer && !elem._isTweenShape) {
                    polyNode.properties["polygon"] = pointsStr;
                    if (group.polygons.length > 1) {
                        polyNode.properties["polygons"] = polygonsStr;
                    } else {
                        delete polyNode.properties["polygons"];
                    }
                    if (elem._isMaskShape) {
                        polyNode.properties["color"] = "Color(1, 1, 1, 1)";
                        polyNode.properties["visible"] = true;
                    } else {
                        polyNode.properties["texture"] = texIdStr;
                        polyNode.properties["uv"] = uvsStr;
                        polyNode.properties["color"] = "Color(1, 1, 1, 1)";
                        polyNode.properties["visible"] = true;
                    }
                } else {
                    anim.addTrackKey(polyPath + ":polygon", "value", startTime, pointsStr, 0.0);
                    if (group.polygons.length > 1) {
                        anim.addTrackKey(polyPath + ":polygons", "value", startTime, polygonsStr, 0.0);
                    } else {
                        anim.addTrackKey(polyPath + ":polygons", "value", startTime, "[]", 0.0);
                    }
                    if (elem._isMaskShape) {
                        anim.addTrackKey(polyPath + ":color", "value", startTime, "Color(1, 1, 1, 1)", 0.0);
                        anim.addTrackKey(polyPath + ":visible", "value", startTime, true, 0.0);
                    } else {
                        anim.addTrackKey(polyPath + ":texture", "value", startTime, texIdStr, 0.0);
                        anim.addTrackKey(polyPath + ":uv", "value", startTime, uvsStr, 0.0);
                        anim.addTrackKey(polyPath + ":color", "value", startTime, "Color(1, 1, 1, 1)", 0.0);
                        anim.addTrackKey(polyPath + ":visible", "value", startTime, true, 0.0);
                    }
                }
            }
            
            if (!isStaticLayer || elem._isTweenShape) {
                if (!anim._maxPoly) anim._maxPoly = {};
                var prevMax = anim._maxPoly[variantPathStr] || 0;
                var curLen = polyGroups.length;
                for (var p = curLen; p < prevMax; p++) {
                    var polyNodeName = (p === 0 && node.type === "Polygon2D") ? "" : "Poly_" + ((p > 0 && node.type === "Polygon2D") ? (p - 1) : p);
                    var polyPath = variantPathStr + (polyNodeName ? "/" + polyNodeName : "");
                    anim.addTrackKey(polyPath + ":polygon", "value", startTime, "PackedVector2Array()", 0.0);
                    anim.addTrackKey(polyPath + ":polygons", "value", startTime, "[]", 0.0);
                    anim.addTrackKey(polyPath + ":uv", "value", startTime, "PackedVector2Array()", 0.0);
                    anim.addTrackKey(polyPath + ":visible", "value", startTime, false, 0.0);
                }
                anim._maxPoly[variantPathStr] = Math.max(prevMax, curLen);
            }
            
        } else if (!elem.strokes || elem.strokes.length === 0) {
            if (!elem._isTweenShape && customTexPath) {
                var fileName = customTexPath.substring(customTexPath.lastIndexOf("/") + 1);
                var meta = _parsePngFilename(fileName);
                useAbsoluteBounds = meta.useAbsoluteBounds;
                boundsX = meta.boundsX; boundsY = meta.boundsY;
                pngWidth = meta.pngWidth; pngHeight = meta.pngHeight;
                offsetDx = meta.offsetDx; offsetDy = meta.offsetDy;
            }

            var tex = null;
            if (customTexPath) {
                tex = RES_PREFIX + "img/" + customTexPath.substring(customTexPath.lastIndexOf("/") + 1);
            }

            if (isNewNode && tex) {
                node.properties["texture"] = "ExtResource(\"" + getExt(tex, "Texture2D") + "\")";
                node.properties["centered"] = true;
                if (pngWidth !== undefined && pngHeight !== undefined) {
                    var spriteScale = meta.spriteScale !== undefined ? meta.spriteScale : 1.0;
                    var cx0 = (pngWidth / 2.0) * spriteScale, cy0 = (pngHeight / 2.0) * spriteScale;
                    if (elem._inlineSprite) {
                        if (useAbsoluteBounds) {
                            cx0 = (boundsX * scaleFactor) + cx0;
                            cy0 = (boundsY * scaleFactor) + cy0;
                        } else {
                            cx0 = (elem._innerLeft * scaleFactor) + cx0;
                            cy0 = (elem._innerTop  * scaleFactor) + cy0;
                        }
                    }
                    node.properties["position"] = _vec2(cx0, cy0);
                    if (spriteScale !== 1.0) {
                        node.properties["scale"] = _vec2(spriteScale, spriteScale);
                    }
                }
            }

            if (tex) {
                anim.addTrackKey(variantPathStr + ":texture", "value", startTime,
                    {ext: getExt(tex, "Texture2D")}, kfTransition);
                if (pngWidth !== undefined && pngHeight !== undefined) {
                    var spriteScale = meta.spriteScale !== undefined ? meta.spriteScale : 1.0;
                    var cx = (pngWidth / 2.0) * spriteScale, cy = (pngHeight / 2.0) * spriteScale;
                    if (elem._inlineSprite) {
                        if (useAbsoluteBounds) {
                            cx = (boundsX * scaleFactor) + cx;
                            cy = (boundsY * scaleFactor) + cy;
                        } else {
                            cx = (elem._innerLeft * scaleFactor) + cx;
                            cy = (elem._innerTop  * scaleFactor) + cy;
                        }
                    }
                    anim.addTrackKey(variantPathStr + ":position", "value", startTime,
                        {x: cx, y: cy}, 0.0);
                    if (spriteScale !== 1.0) {
                        anim.addTrackKey(variantPathStr + ":scale", "value", startTime,
                            {x: spriteScale, y: spriteScale}, 0.0);
                    }
                }
            }
        }

        var hasStrokes = elem.strokes && elem.strokes.length > 0;
        if (hasStrokes && (elem.elementType === "shape" || elem._inlineSprite)) {
            // Démotion symétrique du cas Polygon2D/Poly_N ci-dessus : cette
            // occurrence poolée avait été créée en Line2D direct (1 seul trait
            // sur son premier keyframe), mais un keyframe ultérieur a besoin de
            // plusieurs traits. On convertit le wrapper en Node2D et on déplace
            // ses propriétés/anim tracks existantes vers un enfant Line_0.
            if (elem.strokes.length > 1 && node.type === "Line2D") {
                node.type = "Node2D";
                delete node.properties["joint_mode"];
                delete node.properties["begin_cap_mode"];
                delete node.properties["end_cap_mode"];
                delete node.properties["use_parent_material"];
                delete node.properties["points"];
                delete node.properties["width"];
                delete node.properties["default_color"];
                if (typeof anim !== 'undefined' && anim && anim.tracks) {
                    var fixProps = [":points", ":width", ":default_color"];
                    for (var t = 0; t < anim.tracks.length; t++) {
                        var tr = anim.tracks[t];
                        for (var f = 0; f < fixProps.length; f++) {
                            if (tr.path === variantPathStr + fixProps[f]) {
                                delete anim._trackIndex["$" + tr.path + "\u0001" + tr.type];
                                tr.path = variantPathStr + "/Line_0" + fixProps[f];
                                anim._trackIndex["$" + tr.path + "\u0001" + tr.type] = t;
                            }
                        }
                    }
                }
            }
            var strokeParent = node;
            for (var s = 0; s < elem.strokes.length; s++) {
                var strokeData = elem.strokes[s];
                var strokeNodeName = (s === 0 && node.type === "Line2D") ? "" : "Line_" + s;
                var strokeNode;
                if (strokeNodeName === "") {
                    strokeNode = node;
                } else {
                    strokeNode = strokeParent.getNodeOrNull(strokeNodeName);
                    if (!strokeNode) {
                        strokeNode = new GNode(strokeNodeName, "Line2D");
                        strokeNode.properties["joint_mode"] = "2";
                        strokeNode.properties["begin_cap_mode"] = "2";
                        strokeNode.properties["end_cap_mode"] = "2";
                        strokeNode.properties["use_parent_material"] = "false";
                        strokeParent.addChild(strokeNode);
                        strokeNode.owner = ownerRoot;
                    }
                }
                
                var ptsStr = "PackedVector2Array(";
                var pts = strokeData.pts || strokeData.path || [];
                for (var v = 0; v < pts.length; v++) {
                    ptsStr += _f(pts[v].x * scaleFactor) + ", " + _f(pts[v].y * scaleFactor);
                    if (v < pts.length - 1) ptsStr += ", ";
                }
                ptsStr += ")";
                
                var wStr = _f(strokeData.thickness * scaleFactor);
                var cStr = "Color(1, 1, 1, 1)";
                if (strokeData.color) {
                    var hex = strokeData.color;
                    if (hex && hex.charAt(0) === '#') {
                        var r = parseInt(hex.substring(1,3), 16) / 255.0;
                        var g = parseInt(hex.substring(3,5), 16) / 255.0;
                        var b = parseInt(hex.substring(5,7), 16) / 255.0;
                        cStr = "Color(" + _f(r) + ", " + _f(g) + ", " + _f(b) + ", 1)";
                    }
                }
                
                var strokePath = ownerRoot.getPathTo(strokeParent) + (strokeNodeName ? "/" + strokeNodeName : "");
                if (isStaticLayer && !elem._isTweenShape) {
                    strokeNode.properties["points"] = ptsStr;
                    strokeNode.properties["width"] = wStr;
                    strokeNode.properties["default_color"] = cStr;
                    strokeNode.properties["visible"] = true;
                } else {
                    anim.addTrackKey(strokePath + ":points", "value", startTime, ptsStr, 0.0);
                    anim.addTrackKey(strokePath + ":width", "value", startTime, wStr, 0.0);
                    anim.addTrackKey(strokePath + ":default_color", "value", startTime, cStr, 0.0);
                    anim.addTrackKey(strokePath + ":visible", "value", startTime, true, 0.0);
                }
            }
            
        }

        // ----------------------------------------------------------------
        // Reset INCONDITIONNEL des slots Poly_X / Line_X non utilisés par
        // ce keyframe. Avant fix, ces deux boucles étaient imbriquées dans
        // `if (elem.polygons.length > 0)` et `if (hasStrokes)` respectivement,
        // donc une keyframe avec 0 polygones ne nettoyait pas les Poly_X
        // hérités d'une keyframe précédente (idem pour 0 strokes / Line_X).
        // Résultat dans star : shape_1 (3 polys + 0 strokes en Flash) montrait
        // 2 lines fantômes héritées de fatig ; shape_3 (0 polys + 2 strokes)
        // montrait 1 polygone fantôme. Ces boucles DOIVENT tourner même
        // quand le compte courant est 0, sinon les slots gardent leur état
        // précédent. C'est exactement le comportement Flash : à chaque
        // keyframe, seuls les éléments présents dans ce keyframe sont
        // dessinés ; tout le reste est vide.
        // ----------------------------------------------------------------
        var polyCount = polyGroups ? polyGroups.length : 0;
        var pIndex = polyCount;
        while (true) {
            var excessName = (pIndex === 0 && node.type === "Polygon2D") ? "" : "Poly_" + ((pIndex > 0 && node.type === "Polygon2D") ? (pIndex - 1) : pIndex);
            var excessNode = (excessName === "") ? node : node.getNodeOrNull(excessName);
            if (!excessNode) break;
            
            if (excessName === "" && excessNode.type !== "Polygon2D") {
                pIndex++;
                continue;
            }
            
            var excessPath = excessName === "" ? variantPathStr : variantPathStr + "/" + excessName;
            if (!(isStaticLayer && !elem._isTweenShape)) {
                anim.addTrackKey(excessPath + ":polygon", "value", startTime, "PackedVector2Array()", 0.0);
                anim.addTrackKey(excessPath + ":polygons", "value", startTime, "[]", 0.0);
                anim.addTrackKey(excessPath + ":uv", "value", startTime, "PackedVector2Array()", 0.0);
                anim.addTrackKey(excessPath + ":visible", "value", startTime, false, 0.0);
            } else {
                excessNode.properties["polygon"] = "PackedVector2Array()";
                excessNode.properties["polygons"] = "[]";
                excessNode.properties["uv"] = "PackedVector2Array()";
                excessNode.properties["visible"] = false;
            }
            pIndex++;
        }

        var strokeCount = (elem.strokes && elem.strokes.length) || 0;
        var sIndex = strokeCount;
        while (true) {
            var excessName = (sIndex === 0 && node.type === "Line2D") ? "" : "Line_" + sIndex;
            var excessNode = (excessName === "") ? node : node.getNodeOrNull(excessName);
            if (!excessNode) break;
            
            if (excessName === "" && excessNode.type !== "Line2D") {
                sIndex++;
                continue;
            }
            
            var excessPath = (excessName === "") ? variantPathStr : variantPathStr + "/" + excessName;
            if (!(isStaticLayer && !elem._isTweenShape)) {
                anim.addTrackKey(excessPath + ":points", "value", startTime, "PackedVector2Array()", 0.0);
                anim.addTrackKey(excessPath + ":visible", "value", startTime, false, 0.0);
            } else {
                excessNode.properties["points"] = "PackedVector2Array()";
                excessNode.properties["visible"] = false;
            }
            sIndex++;
        }
    }

    var vis = elem.visible !== undefined ? elem.visible : true;
    var pathVis = variantPathStr + ":visible";
    var pathProc = variantPathStr + ":process_mode";
    
    if (isNewNode && startTime > 0.001) {
        anim.addTrackKey(pathVis, "value", 0.0, false, 0.0);
        anim.addTrackKey(pathProc, "value", 0.0, 4, 0.0); // 4 = PROCESS_MODE_DISABLED
    }
    
    anim.addTrackKey(pathVis, "value", startTime, vis, kfTransition);
    anim.addTrackKey(pathProc, "value", startTime, vis ? 0 : 4, kfTransition); // 0 = INHERIT
    
    if (startTime + duration < maxTime - 0.001) {
        anim.addTrackKey(pathVis, "value", startTime + duration, false, 0.0);
        anim.addTrackKey(pathProc, "value", startTime + duration, 4, 0.0);
    }

    // Décomposition de la matrice calculée une seule fois (au lieu de deux
    // fois avec les mêmes arguments) : elle alimente à la fois les valeurs
    // initiales du wrapper (bloc isNewWrapper juste en dessous) et la clé
    // d'animation à startTime (bloc "else if (elem.matrix)" plus bas) —
    // les deux utilisent exactement la même elem.matrix.
    var _matDec = elem.matrix ? _decomposeMatrix(elem.matrix, elem) : null;

    if (isNewWrapper && elem.matrix) {
        var m = elem.matrix;
        var initDec = _matDec;
        wrapperNode.properties["position"] = _vec2(m.tx * scaleFactor, m.ty * scaleFactor);
        wrapperNode.properties["rotation"] = _f(initDec.rotation);
        wrapperNode.properties["scale"]    = _vec2(initDec.scaleX, initDec.scaleY);
        if (initDec.skew !== 0.0) {
            wrapperNode.properties["skew"] = _f(initDec.skew);
        }
    }

    if (elem.elementType === "shape" && !elem._isTweenShape && (!elem.polygons || elem.polygons.length === 0) && (!elem.strokes || elem.strokes.length === 0)) {
        var animPosX, animPosY;
        if (useAbsoluteBounds) {
            animPosX = boundsX;
            animPosY = boundsY;
        } else {
            animPosX = (elem.left || 0) + offsetDx;
            animPosY = (elem.top  || 0) + offsetDy;
        }

        var rot = 0.0;
        var scX = 1.0;
        var scY = 1.0;
        var sk = 0.0;

        if (elem.matrix) {
            var m = elem.matrix;
            var nx = m.a * animPosX + m.c * animPosY + m.tx;
            var ny = m.b * animPosX + m.d * animPosY + m.ty;
            animPosX = nx * scaleFactor;
            animPosY = ny * scaleFactor;
            
            var dec = _matDec;
            rot = dec.rotation;
            scX = dec.scaleX;
            scY = dec.scaleY;
            sk = dec.skew;
        } else {
            animPosX *= scaleFactor;
            animPosY *= scaleFactor;
        }

        anim.addTrackKey(wrapperPathStr + ":position", "value", startTime, {x: animPosX, y: animPosY}, kfTransition);
        anim.addTrackKey(wrapperPathStr + ":rotation", "value", startTime, rot, kfTransition);
        anim.addTrackKey(wrapperPathStr + ":scale",    "value", startTime, {x: scX, y: scY}, kfTransition);
        if (sk !== 0.0) {
            anim.addTrackKey(wrapperPathStr + ":skew", "value", startTime, sk, kfTransition);
        }

        if (kfTransition <= 0.001 && duration > 0.001) {
            var holdTime = startTime + duration - 0.001;
            anim.addTrackKey(wrapperPathStr + ":position", "value", holdTime, {x: animPosX, y: animPosY}, 1.0);
            anim.addTrackKey(wrapperPathStr + ":rotation", "value", holdTime, rot, 1.0);
            anim.addTrackKey(wrapperPathStr + ":scale",    "value", holdTime, {x: scX, y: scY}, 1.0);
            if (sk !== 0.0) anim.addTrackKey(wrapperPathStr + ":skew", "value", holdTime, sk, 1.0);
        }

        if (isNewWrapper) {
            wrapperNode.properties["position"] = _vec2(animPosX, animPosY);
            wrapperNode.properties["rotation"] = _f(rot);
            wrapperNode.properties["scale"]    = _vec2(scX, scY);
            if (sk !== 0.0) wrapperNode.properties["skew"] = _f(sk);
        }
    } else if (elem.matrix) {
        var m2 = elem.matrix;
        var animDec = _matDec;
        anim.addTrackKey(wrapperPathStr + ":position", "value", startTime,
            {x: m2.tx * scaleFactor, y: m2.ty * scaleFactor}, kfTransition);
        anim.addTrackKey(wrapperPathStr + ":rotation", "value", startTime, animDec.rotation, kfTransition);
        anim.addTrackKey(wrapperPathStr + ":scale",    "value", startTime,
            {x: animDec.scaleX, y: animDec.scaleY}, kfTransition);
        anim.addTrackKey(wrapperPathStr + ":skew",     "value", startTime, animDec.skew, kfTransition);

        if (kfTransition <= 0.001 && duration > 0.001) {
            var holdTime = startTime + duration - 0.001;
            anim.addTrackKey(wrapperPathStr + ":position", "value", holdTime,
                {x: m2.tx * scaleFactor, y: m2.ty * scaleFactor}, 1.0);
            anim.addTrackKey(wrapperPathStr + ":rotation", "value", holdTime, animDec.rotation, 1.0);
            anim.addTrackKey(wrapperPathStr + ":scale",    "value", holdTime,
                {x: animDec.scaleX, y: animDec.scaleY}, 1.0);
            anim.addTrackKey(wrapperPathStr + ":skew",     "value", holdTime, animDec.skew, 1.0);
        }
    }

    var ctn = _extractColorTransform(elem.colorTransform);
    


    var r_pct = ctn.rP, g_pct = ctn.gP, b_pct = ctn.bP, a_pct = ctn.aP;
    var r_amt = ctn.rA, g_amt = ctn.gA, b_amt = ctn.bA, a_amt = ctn.aA;

    var has_offset       = (r_amt !== 0 || g_amt !== 0 || b_amt !== 0 || a_amt !== 0);
    var has_blend        = (elem.blendMode && elem.blendMode !== "normal");
    var has_negative_pct = (r_pct < 0 || g_pct < 0 || b_pct < 0 || a_pct < 0);

    var has_shader      = (has_offset || has_blend || has_negative_pct || shaderNeeds);
    var color_mul_v4    = "Vector4(" + _f(r_pct) + ", " + _f(g_pct) + ", " + _f(b_pct) + ", " + _f(a_pct) + ")";
    var color_mul_color = "Color("   + _f(r_pct) + ", " + _f(g_pct) + ", " + _f(b_pct) + ", " + _f(a_pct) + ")";
    var color_off       = "Vector4(" + _f(r_amt) + ", " + _f(g_amt) + ", " + _f(b_amt) + ", " + _f(a_amt) + ")";

    if (has_shader) {
        if (!wrapperNode.properties["material"]) {
            var shader_path;
            if (customTexPath && !elem.cacheAsBitmap) {
                shader_path = customTexPath.replace(".tscn", ".gdshader");
            } else {
                shader_path = RES_PREFIX + "shaders/flash_color_normal.gdshader";
                if (elem.blendMode === "add")
                    shader_path = RES_PREFIX + "shaders/flash_color_add.gdshader";
                else if (elem.blendMode === "multiply")
                    shader_path = RES_PREFIX + "shaders/flash_color_mul.gdshader";
            }

            var matId = "mat_" + nextId();
            subResources.push('[sub_resource type="ShaderMaterial" id="' + matId + '"]'
                + '\nshader = ExtResource("' + getExt(shader_path, "Shader") + '")'
                + '\nshader_parameter/color_offset_255 = ' + color_off
                + '\nshader_parameter/color_mult = ' + color_mul_v4);
            wrapperNode.properties["material"] = "SubResource(\"" + matId + "\")";
            wrapperNode.properties["use_parent_material"] = false;
        }

        var path_off  = wrapperPathStr + ":material:shader_parameter/color_offset_255";
        var path_mult = wrapperPathStr + ":material:shader_parameter/color_mult";
        anim.addTrackKey(path_off,  "value", startTime, color_off,    1.0);
        anim.addTrackKey(path_mult, "value", startTime, color_mul_v4, 1.0);
        if (kfTransition <= 0.001 && duration > 0.001) {
            anim.addTrackKey(path_off,  "value", startTime + duration - 0.001, color_off,    1.0);
            anim.addTrackKey(path_mult, "value", startTime + duration - 0.001, color_mul_v4, 1.0);
        }
    } else {
        var modProp = (wrapperNode.type === "CanvasGroup") ? "self_modulate" : "modulate";
        if (isNewWrapper) wrapperNode.properties[modProp] = color_mul_color;
        var path_mod = wrapperPathStr + ":" + modProp;
        anim.addTrackKey(path_mod, "value", startTime, color_mul_color, 1.0);
        if (kfTransition <= 0.001 && duration > 0.001) {
            anim.addTrackKey(path_mod, "value", startTime + duration - 0.001, color_mul_color, 1.0);
        }
    }
}

// Parcourt récursivement l'arbre et, pour chaque node dont les enfants
// contiennent un mélange de Polygon2D et Line2D, réordonne les enfants pour
// que tous les Polygon2D viennent avant tous les Line2D. L'ordre relatif au
// sein de chaque type est préservé (= ordre de création lazy à travers les
// keyframes, identique à l'ordre des slots Poly_0..N et Line_0..M). Autres
// types de nodes (s'il y en a) restent à leur position d'origine relative
// avant la section Polys.
function _reorderShapePolysAndLines(node, isTopLevel) {
    if (!node) return;
    var children = node.children;
    // On ne regroupe jamais les enfants directs du nœud racine passé en
    // entrée : ce sont des formes/objets indépendants les uns des autres
    // (chacun avec son propre ordre de z voulu), pas les slots Poly_N/Line_N
    // d'une seule et même forme décomposée. Le regroupement n'a de sens que
    // pour les enfants d'un wrapper de forme (cf. appel récursif plus bas).
    if (!isTopLevel && children && children.length > 1) {
        var hasPoly = false, hasLine = false;
        for (var i = 0; i < children.length; i++) {
            if (children[i].type === "Polygon2D") hasPoly = true;
            else if (children[i].type === "Line2D") hasLine = true;
            if (hasPoly && hasLine) break;
        }
        if (hasPoly && hasLine) {
            var polys = [], lines = [], others = [];
            for (var i = 0; i < children.length; i++) {
                var c = children[i];
                if (c.type === "Polygon2D") polys.push(c);
                else if (c.type === "Line2D") lines.push(c);
                else others.push(c);
            }
            node.children = others.concat(polys, lines);
        }
    }
    if (children) {
        for (var i = 0; i < node.children.length; i++) {
            _reorderShapePolysAndLines(node.children[i], false);
        }
    }
}

function buildSceneForSymbol(sym, frameRate, exportDir, boundsLookup, boundsIndex, symbolMap, symbolContainsShader) {
    if (!sym.safeName) sym.safeName = sanitizeForLookup(sym.name);
    var extResources = [];
    var extIdMap = {};
    var subResources = [];
    // Cache de déduplication des ressources Gradient/GradientTexture, scopé à
    // CE fichier .tscn (un appel = un fichier de sortie). Voir le commentaire
    // dans _processElementNode pour le détail de l'optimisation.
    var gradCache = {};

    function getExt(path, type) {
        if (!extIdMap[path]) {
            var id = (type === "Texture2D") ? "tex_" + nextId() : "inst_" + nextId();
            extIdMap[path] = id;
            extResources.push('[ext_resource type="' + type + '" path="' + path + '" id="' + id + '"]');
        }
        return extIdMap[path];
    }

    var root = new GNode(sym.isMainScene ? "main" : _sanitize_name(sym.name), "Node2D");
    if (sym.isMainScene) {
        var bg = new GNode("Background", "ColorRect");
        bg.properties["offset_right"]  = _f(safeNum(sym.docWidth));
        bg.properties["offset_bottom"] = _f(safeNum(sym.docHeight));
        var bgHex = sym.bgColor || "#FFFFFF";
        var r = _parseHexChannel(bgHex, 1);
        var g = _parseHexChannel(bgHex, 3);
        var b = _parseHexChannel(bgHex, 5);
        bg.properties["color"] = "Color(" + _f(r) + ", " + _f(g) + ", " + _f(b) + ", 1.0)";
        bg.properties["mouse_filter"] = 2;
        root.addChild(bg);
    } else {
        var localScaleFactor = 4.166667;
        var minX = 999999, maxX = -999999, minY = 999999, maxY = -999999;
        var hasBounds = false;
        if (sym.layers) {
            for (var l = 0; l < sym.layers.length; l++) {
                var layer = sym.layers[l];
                if (!layer.keyframes) continue;
                for (var k = 0; k < layer.keyframes.length; k++) {
                    var kf = layer.keyframes[k];
                    if (kf.startFrame !== 0) continue; // ONLY compute for the first frame
                    if (!kf.elements) continue;
                    for (var e = 0; e < kf.elements.length; e++) {
                        var el = kf.elements[e];
                        if (el.left !== undefined && el.width !== undefined) {
                            if (el.left < minX) minX = el.left;
                            if (el.left + el.width > maxX) maxX = el.left + el.width;
                            if (el.top < minY) minY = el.top;
                            if (el.top + el.height > maxY) maxY = el.top + el.height;
                            hasBounds = true;
                        } else if (el.polygons && el.polygons.length > 0) {
                            for (var p = 0; p < el.polygons.length; p++) {
                                var poly = el.polygons[p];
                                if (poly.vertices) {
                                    for (var v = 0; v < poly.vertices.length; v++) {
                                        var pt = poly.vertices[v];
                                        if (pt.x < minX) minX = pt.x;
                                        if (pt.x > maxX) maxX = pt.x;
                                        if (pt.y < minY) minY = pt.y;
                                        if (pt.y > maxY) maxY = pt.y;
                                        hasBounds = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        var cx = 0, cy = 0;
        if (hasBounds && minX <= maxX) {
            cx = (minX + maxX) / 2.0 * localScaleFactor;
            cy = (minY + maxY) / 2.0 * localScaleFactor;
        }
        var enabler = new GNode("VisibilityEnabler", "VisibleOnScreenEnabler2D");
        enabler.properties["rect"] = "Rect2(" + _f(cx - 10) + ", " + _f(cy - 10) + ", 20, 20)";
        root.addChild(enabler);
        enabler.owner = root;
    }

    var animPlayer = new GNode("AnimationPlayer", "AnimationPlayer");
    root.addChild(animPlayer);

    var maxTime = 0.0;
    var hasAnimation = false;
    var labels = {};
    var shaderNeedsMap = {};
    var modulateNeedsCanvasGroupMap = {};

    if (sym.layers) {
        var nameCount = {};
        for (var i = 0; i < sym.layers.length; i++) {
            var n = sym.layers[i].name;
            nameCount[n] = (nameCount[n] || 0) + 1;
        }
        var usedLayerNames = {};
        for (var i = 0; i < sym.layers.length; i++) {
            var layer = sym.layers[i];
            var baseName = layer.name;
            if (nameCount[baseName] > 1) {
                var idx = usedLayerNames[baseName] || 0;
                usedLayerNames[baseName] = idx + 1;
                layer.unique_name = baseName + "_" + idx;
            } else {
                layer.unique_name = baseName;
            }
        }
        var labels = {};
        for (var l = 0; l < sym.layers.length; l++) {
            var layer = sym.layers[l];
            if (layer.layerType !== "guide" && layer.layerType !== "folder") {
                if (!layer.keyframes) continue;
                for (var f = 0; f < layer.keyframes.length; f++) {
                    var fr = layer.keyframes[f];
                    if (fr.name) {
                        // Keep only the first label definition (from the topmost layer usually)
                        // to prevent bottom layers with duplicate labels from shifting the animations!
                        if (labels[fr.name] === undefined) {
                            labels[fr.name] = fr.startFrame / frameRate;
                        }
                    }
                }
            }
        }
        for (var i = 0; i < sym.layers.length; i++) {
            var layer = sym.layers[i];
            if (layer.layerType === "guide" || layer.layerType === "folder") continue;
            var layerName = sanitizeForLookup(layer.name);
            if (!layer.keyframes) continue;
            var _prePassLastPos = {};
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                var st = kf.startFrame / frameRate;
                var dur = (kf.duration || 1) / frameRate;
                if (st + dur > maxTime) maxTime = st + dur;
                if (kf.elements && kf.elements.length > 0) hasAnimation = true;
                if (kf.name && labels[kf.name] === undefined) labels[kf.name] = st;

                if (!kf.elements) continue;
                kf.elements = _flattenGroups(kf.elements);
                
                // (Sorting of elements to force shapes to the back was removed to preserve 
                // correct z-depth order from Flash, especially for Groups and Drawing Objects)
                
                var occMap = {};
                var kfTransition = 0.0;
                if (kf.tween) {
                    if (typeof kf.tween === "object" && kf.tween.tweenType && kf.tween.tweenType !== "none") {
                        kfTransition = 1.0;
                    } else if (typeof kf.tween === "string" && kf.tween !== "none") {
                        kfTransition = 1.0;
                    }
                    if (typeof kf.tween === "object" && kf.tween.tweenEasing !== undefined) {
                        var easeVal = kf.tween.tweenEasing / 100.0;
                        if (easeVal !== 0.0) {
                            if (easeVal > 0) kfTransition = 1.0 - (easeVal * 0.5);
                            else             kfTransition = 1.0 + (Math.abs(easeVal) * 1.5);
                        }
                    }
                }
                var _explodedPre = _explodeTweenElements(kf.elements, symbolMap);
                var _stablePrePass = _stabilizeOccurrenceIndices(_explodedPre, _prePassLastPos);
                for (var e = 0; e < _explodedPre.length; e++) {
                    var elem = _explodedPre[e];
                    var occKey = _getOccKey(elem);
                    if (!occMap[occKey]) occMap[occKey] = 0;
                    var occIdx;
                    if (_stablePrePass[e] !== undefined) {
                        occIdx = _stablePrePass[e];
                        if (occMap[occKey] <= occIdx) occMap[occKey] = occIdx + 1;
                    } else {
                        occIdx = occMap[occKey]++;
                    }

                    var rawNodeName = occKey + "_" + occIdx;
                    var fullOccKey = layerName + "/" + _sanitize_name(rawNodeName);
                    var hasOffset = false;
                    var hasModulate = false;
                    if (elem.colorTransform) {
                        var ct = elem.colorTransform;
                        if (ct.colorRedAmount || ct.colorGreenAmount || ct.colorBlueAmount || ct.colorAlphaAmount) hasOffset = true;
                        if (ct.colorRedPercent !== 100 || ct.colorGreenPercent !== 100 || ct.colorBluePercent !== 100 || ct.colorAlphaPercent !== 100) hasModulate = true;
                    }
                    if (hasOffset || (elem.blendMode && elem.blendMode !== "normal")) {
                        shaderNeedsMap[fullOccKey] = true;
                    }
                    if (hasModulate && elem.symbolName && symbolContainsShader && symbolContainsShader[elem.symbolName]) {
                        modulateNeedsCanvasGroupMap[fullOccKey] = true;
                    }
                }
                _prePassLastPos = _recordElemPositions(_explodedPre, _stablePrePass);
            }
        }
    }

    var anim = new GAnimation();
    anim.step = 1.0 / frameRate;
    var scaleFactor = 4.166667;

    if (sym.layers) {
        var globalWrapperPools = {};
        var assignedWrappers = {};
        function allocateOrExtendWrapper(parentName, occKey, fullLocalName, startF, endF, isInstance) {
            if (!globalWrapperPools[parentName]) globalWrapperPools[parentName] = {};
            if (!globalWrapperPools[parentName][occKey]) globalWrapperPools[parentName][occKey] = [];
            var pool = globalWrapperPools[parentName][occKey];
            
            if (assignedWrappers[fullLocalName]) {
                var assignedName = assignedWrappers[fullLocalName];
                for (var i = 0; i < pool.length; i++) {
                    if (pool[i].name === assignedName) {
                        pool[i].spans.push({start: startF, end: endF});
                        break;
                    }
                }
                return assignedName;
            }

            for (var i = 0; i < pool.length; i++) {
                var wrapperObj = pool[i];
                var conflict = false;
                for (var j = 0; j < wrapperObj.spans.length; j++) {
                    var span = wrapperObj.spans[j];
                    // Tolérance de 0.0001 pour les erreurs d'arrondi
                    if (!(startF >= span.end - 0.0001 || endF <= span.start + 0.0001)) {
                        conflict = true;
                        break;
                    }
                }
                if (!conflict) {
                    wrapperObj.spans.push({start: startF, end: endF});
                    if (isInstance) assignedWrappers[fullLocalName] = wrapperObj.name;
                    return wrapperObj.name;
                }
            }
            
            var newName = _sanitize_name(occKey + "_" + pool.length);
            var newObj = { name: newName, spans: [{start: startF, end: endF}] };
            pool.push(newObj);
            if (isInstance) assignedWrappers[fullLocalName] = newName;
            return newName;
        }

        var maskLayerNames = {};
        for (var i = 0; i < sym.layers.length; i++) {
            if (sym.layers[i].layerType === "mask") maskLayerNames[sym.layers[i].name] = sym.layers[i].unique_name;
        }
        
        var folderNodes = {};
        for (var i = 0; i < sym.layers.length; i++) {
            var layer = sym.layers[i];
            if (layer.layerType === "folder") {
                var folderName = _sanitize_name(layer.unique_name);
                var folderNode = new GNode(folderName, "Node2D");
                folderNodes[layer.name] = folderNode;
                var folderRank = (sym.layers.length - 1 - i) * 1000;
                
                var parentNode = root;
                if (layer.parentLayerName && folderNodes[layer.parentLayerName]) {
                    parentNode = folderNodes[layer.parentLayerName];
                }
                parentNode.addChildRanked(folderNode, folderRank);
                folderNode.owner = root;
            }
        }
        
        for (var i = 0; i < sym.layers.length; i++) {
            var layer = sym.layers[i];
            if (layer.layerType === "guide" || layer.layerType === "folder") continue;
            var layerName = _sanitize_name(layer.unique_name);
            var lookupLayerName = sanitizeForLookup(layer.unique_name);
            
            var targetParent = root;
            if (layer.parentLayerName && folderNodes[layer.parentLayerName]) {
                targetParent = folderNodes[layer.parentLayerName];
            }
            
            var isMaskLayer = (layer.layerType === "mask" || layer.layerType === "masked" || (layer.layerType === "normal" && layer.parentLayerName && maskLayerNames[layer.parentLayerName] !== undefined));
            var isGuidedLayer = (layer.layerType === "guide");
            if (isMaskLayer || isGuidedLayer || layer.layerType === "guide") {
                var layerNode = targetParent.getNodeOrNull(layerName);
                if (!layerNode) {
                    layerNode = new GNode(layerName, "Node2D");
                    if (layer.layerType === "guide") layerNode.properties["visible"] = false;
                    var layerZIndex = (sym.layers.length - 1 - i) * 1000;
                    targetParent.addChildRanked(layerNode, layerZIndex);
                    layerNode.owner = root;
                }
                targetParent = layerNode;
            }

            if (!layer.keyframes) continue;
            var lastShapeTextures = [];
            var lastShapeElems = [];
            var lastElemPositions = {};
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                var startTime = kf.startFrame / frameRate;
                var duration = (kf.duration || 1) / frameRate;
                var kfTransition = kf.tween ? 1.0 : 0.0;

                if (!kf.elements) continue;
                var occurrenceMap = {};
                var shapeCount2 = 0;
                var _explodedMain = _explodeTweenElements(kf.elements, symbolMap);
                var _stableMain = _stabilizeOccurrenceIndices(_explodedMain, lastElemPositions);
                var takenOccIndices = {};
                for (var e = 0; e < _explodedMain.length; e++) {
                    if (_stableMain[e] !== undefined) {
                        var oKey = _getOccKey(_explodedMain[e]);
                        if (!takenOccIndices[oKey]) takenOccIndices[oKey] = {};
                        takenOccIndices[oKey][_stableMain[e]] = true;
                    }
                }

                for (var e = 0; e < _explodedMain.length; e++) {
                    var elem = _explodedMain[e];
                    var occKey = _getOccKey(elem);
                    if (!occurrenceMap[occKey]) occurrenceMap[occKey] = 0;
                    var occIdx;
                    if (_stableMain[e] !== undefined) {
                        occIdx = _stableMain[e];
                        if (occurrenceMap[occKey] <= occIdx) occurrenceMap[occKey] = occIdx + 1;
                    } else {
                        while (takenOccIndices[occKey] && takenOccIndices[occKey][occurrenceMap[occKey]]) {
                            occurrenceMap[occKey]++;
                        }
                        occIdx = occurrenceMap[occKey]++;
                    }

                    var rawNodeName = _sanitize_name(occKey + "_" + occIdx);
                    var fullOccKey = layerName + "/" + rawNodeName;
                    var shaderNeeds = !!shaderNeedsMap[fullOccKey];
                    var modulateNeedsCanvasGroup = !!modulateNeedsCanvasGroupMap[fullOccKey];
                    
                    var layerZIndex = (sym.layers.length - 1 - i) * 1000 + e;
                    
                    var originalElem = elem;
                    if (layer.layerType === "mask" && elem.elementType === "instance" && symbolMap) {
                        var maskSym = symbolMap[elem.symbolName];
                        var shapeElem = null;
                        if (maskSym && maskSym.layers) {
                            for (var ml = 0; ml < maskSym.layers.length; ml++) {
                                var mlayer = maskSym.layers[ml];
                                if (mlayer.keyframes && mlayer.keyframes.length > 0) {
                                    for (var me = 0; me < mlayer.keyframes[0].elements.length; me++) {
                                        var candidate = mlayer.keyframes[0].elements[me];
                                        if (candidate.elementType === "shape" || candidate._inlineSprite) {
                                            shapeElem = candidate;
                                            break;
                                        }
                                    }
                                }
                                if (shapeElem) break;
                            }
                        }
                        if (shapeElem) {
                            elem = _deepClone(shapeElem);
                            elem._isMaskShape = true;
                            if (originalElem.matrix && shapeElem.matrix) {
                                elem.matrix = _composeMatrix(originalElem.matrix, shapeElem.matrix);
                            } else if (originalElem.matrix) {
                                elem.matrix = _deepClone(originalElem.matrix);
                            }
                            if (typeof fl !== "undefined") fl.trace("  -> [mask inline] inlined shape from " + originalElem.symbolName + " into mask layer " + layer.name);
                        }
                    }

                    var isInstance = (elem.elementType === "instance");
                    var poolKey = occKey + "_layer_" + layerName;
                    var uniqueNodeName = allocateOrExtendWrapper(targetParent.name, poolKey, fullOccKey, startTime, startTime + duration, isInstance);

                    var customTex = "";
                    if (elem.elementType === "shape" || elem._inlineSprite) {
                        var imgPath = "";

                        if (elem._isGuideLayer) {
                            imgPath = "";
                        } else if (elem._isTweenShape) {
                            imgPath = lastShapeTextures[shapeCount2] || "";
                        } else {
                            var sName  = elem._sourceSymbol !== undefined ? sanitizeForLookup(elem._sourceSymbol) : sanitizeForLookup(sym.name);
                            var sLayer = elem._sourceLayer  !== undefined ? sanitizeForLookup(elem._sourceLayer)  : lookupLayerName;
                            var sFrame = elem._sourceFrame  !== undefined ? elem._sourceFrame : kf.startFrame;
                            var sShapeIdx = elem.sourceShapeIndex !== undefined ? elem.sourceShapeIndex : shapeCount2;

                            var baseNoSpace  = sName + "_" + sLayer + "_" + sFrame;
                            var shapePrefix  = baseNoSpace + "_SHAPE_" + sShapeIdx + "_BOUNDS_";
                            var oldPrefix    = baseNoSpace + "_BOUNDS_";
                            var offsetPrefix = baseNoSpace + "_OFFSET_";

                            var candidates = boundsIndex["$" + baseNoSpace] || [];
                            for (var ci = 0; ci < candidates.length; ci++) {
                                var fn = candidates[ci];
                                if (fn.indexOf(shapePrefix) === 0) {
                                    imgPath = exportDir + "img/" + boundsLookup[fn];
                                    break;
                                }
                            }
                            if (imgPath === "") {
                                for (var ci = 0; ci < candidates.length; ci++) {
                                    var fn = candidates[ci];
                                    if (fn.indexOf(oldPrefix) === 0 || fn.indexOf(offsetPrefix) === 0 || fn === baseNoSpace) {
                                        imgPath = exportDir + "img/" + boundsLookup[fn];
                                        break;
                                    }
                                }
                            }

                            lastShapeTextures[shapeCount2] = imgPath;
                            lastShapeElems[shapeCount2] = elem;
                        }

                        customTex = imgPath;
                        shapeCount2++;
                    }

                    _processElementNode(elem, targetParent, root, anim, startTime, duration, frameRate,
                        uniqueNodeName, exportDir, scaleFactor, sym.name, kf.startFrame, maxTime,
                        kfTransition, shaderNeeds, customTex, layer.layerType, getExt, subResources, (layer.keyframes.length === 1), modulateNeedsCanvasGroup, gradCache, layerZIndex);
                }
                lastElemPositions = _recordElemPositions(_explodedMain, _stableMain);
            }
        }
    }

    _postProcessMasks(root, sym, anim, boundsLookup, exportDir, getExt, scaleFactor, extResources, extIdMap);

    if (hasAnimation) {
        anim.optimizeTracks(root);

        var isSingleFrame = (maxTime <= (1.001 / frameRate));

        if (isSingleFrame) {
            root.removeChild(animPlayer);
            // Rien à mettre en pause hors-écran : la shape est statique.
            // VisibleOnScreenEnabler2D ne fait rien économiser ici (le
            // culling de rendu est déjà géré nativement par Godot), donc
            // le node est pur surcoût. Voir création plus haut.
            if (enabler) root.removeChild(enabler);
        } else {
            var libId = "lib_" + nextId();
            var libLines = ['_data = {'];

            var resetAnim = _sliceAnimation(anim, 0.0, 0.0);
            var resetId = "anim_" + nextId();
            subResources.push('[sub_resource type="Animation" id="' + resetId + '"]'
                + '\nstep = ' + _f(resetAnim.step)
                + '\nlength = 0.001\n' + generateAnimTracksStr(resetAnim));
            libLines.push('"RESET": SubResource("' + resetId + '"),');

            var hasLabels = false;
            var numCustomAnims = 0;
            for (var ln in labels) { hasLabels = true; numCustomAnims++; }
            var forceNoLoop = (numCustomAnims > 2);
            var firstLabel = "default";

            if (hasLabels) {
                var sorted = [];
                for (var l in labels) sorted.push({name: l, time: labels[l]});
                sorted.sort(function(a, b){ return a.time - b.time; });

                if (sorted[0].time > 0.001) sorted.unshift({name: "default", time: 0.0});
                firstLabel = _sanitize_name(sorted[0].name);

                // "Que RESET + default" peut aussi arriver ici si le seul label
                // Flash présent s'appelle littéralement "default" et démarre à
                // t=0 (pas d'unshift synthétique, sorted.length === 1).
                var onlyDefaultLabel = (sorted.length === 1 && _sanitize_name(sorted[0].name) === "default");

                for (var i = 0; i < sorted.length; i++) {
                    var lStart = sorted[i].time;
                    var lEnd = (i + 1 < sorted.length) ? sorted[i+1].time : maxTime;
                    var sliced = _sliceAnimation(anim, lStart, lEnd, true);
                    var isLooping = onlyDefaultLabel && (_sanitize_name(sorted[i].name) === "default");
                    var aId = "anim_" + nextId();
                    subResources.push('[sub_resource type="Animation" id="' + aId + '"]'
                        + (isLooping ? '\nloop_mode = 1' : '')
                        + '\nstep = ' + _f(sliced.step)
                        + '\nlength = ' + _f(sliced.length) + '\n'
                        + generateAnimTracksStr(sliced));
                    libLines.push('"' + _sanitize_name(sorted[i].name) + '": SubResource("' + aId + '")'
                        + (i === sorted.length - 1 ? '' : ','));
                }
            } else {
                var aId = "anim_" + nextId();
                var slicedDefault = _sliceAnimation(anim, 0.0, maxTime, true);
                // Bibliothèque réduite à RESET + default : rien d'autre à
                // enchaîner, donc "default" boucle nativement au lieu de
                // s'arrêter à la dernière frame (évite d'avoir à gérer le
                // rebouclage à la main côté gameplay pour ce cas simple).
                var isLooping = true;
                subResources.push('[sub_resource type="Animation" id="' + aId + '"]'
                    + (isLooping ? '\nloop_mode = 1' : '')
                    + '\nstep = ' + _f(slicedDefault.step)
                    + '\nlength = ' + _f(maxTime) + '\n'
                    + generateAnimTracksStr(slicedDefault));
                libLines.push('"default": SubResource("' + aId + '")');
            }

            libLines.push('}');
            subResources.push('[sub_resource type="AnimationLibrary" id="' + libId + '"]\n' + libLines.join('\n'));

            animPlayer.properties["libraries"] = '{\n"": SubResource("' + libId + '")\n}';
            animPlayer.properties["autoplay"] = '"' + firstLabel + '"';
        }
    } else {
        root.removeChild(animPlayer);
        if (enabler) root.removeChild(enabler);
    }

    _setupMaterials(root, true);

    // ----------------------------------------------------------------
    // Réordonner les enfants des nodes `shape` pour que tous les Polygon2D
    // précèdent tous les Line2D. Sans ça, l'ordre dans la scène Godot est
    // l'ordre de CRÉATION lazy à travers les keyframes (ex: Line_0, Poly_0,
    // Line_1, Poly_1, ...), ce qui place certaines lines DERRIÈRE des
    // polygons. En Flash, les strokes sont dessinés PAR-DESSUS les fills
    // d'une même shape ; Godot dessine les enfants dans leur ordre de
    // déclaration (du fond vers le devant), donc placer tous les Poly_X
    // avant tous les Line_X reproduit le comportement Flash.
    // Ex symptôme : ayeur, `Line_1` était derrière `Poly_2` et `Poly_4`
    // parce que `Line_1` avait été créé avant `Poly_2`/`Poly_4` lors du
    // traitement d'une keyframe antérieure.
    // ----------------------------------------------------------------
    _reorderShapePolysAndLines(root, true);

    var tscnText = serializeTscn(root, extResources, subResources);
    var scenePath;
    if (sym.isMainScene) {
        scenePath = exportDir + "main.tscn";
    } else {
        var _spiOut = _symbolPathInfo(sym.name);
        var _subDir = _spiOut.subPath.substring(0, _spiOut.subPath.lastIndexOf("/"));
        if (_subDir.length > 0) {
            var _dirParts = _subDir.split("/");
            var _accum = exportDir + "symbols";
            for (var _di = 0; _di < _dirParts.length; _di++) {
                _accum += "/" + _dirParts[_di];
                FLfile.createFolder(_accum);
            }
        }
        scenePath = exportDir + "symbols/" + _spiOut.subPath + ".tscn";
    }
    FLfile.write(scenePath, tscnText);
}

function generateAnimTracksStr(animObj) {
    var L = [];
    for (var i = 0; i < animObj.tracks.length; i++) {
        var tr = animObj.tracks[i];
        L.push('tracks/' + i + '/type = "' + tr.type + '"');
        L.push('tracks/' + i + '/imported = false');
        L.push('tracks/' + i + '/enabled = true');
        L.push('tracks/' + i + '/path = NodePath("' + tr.path + '")');
        L.push('tracks/' + i + '/interp = ' + tr.interp);
        L.push('tracks/' + i + '/loop_wrap = false');
        L.push('tracks/' + i + '/keys = {');

        var timesStr = [];
        for (var ti = 0; ti < tr.keys.times.length; ti++) timesStr.push(_f(tr.keys.times[ti]));
        var transStr = [];
        for (var trI = 0; trI < tr.keys.transitions.length; trI++) transStr.push(_f(tr.keys.transitions[trI]));

        L.push('"times": PackedFloat32Array(' + timesStr.join(', ') + '),');
        L.push('"transitions": PackedFloat32Array(' + transStr.join(', ') + '),');
        if (tr.keys.update !== undefined) {
            L.push('"update": ' + tr.keys.update + ',');
        }

        var valsStr = [];
        for (var v = 0; v < tr.keys.values.length; v++) {
            var val = tr.keys.values[v];
            if (typeof val === "boolean")         valsStr.push(val ? "true" : "false");
            else if (typeof val === "number")     valsStr.push(_f(val));
            else if (val && val.x !== undefined)  valsStr.push(_vec2(val.x, val.y));
            else if (val && val.ext)              valsStr.push('ExtResource("' + val.ext + '")');
            else if (tr.type === "method" && val.method) {
                var argStr = val.args ? val.args : '[]';
                valsStr.push('{\n"args": ' + argStr + ',\n"method": &"' + val.method + '"\n}');
            }
            else                                  valsStr.push(val);
        }
        L.push('"values": [' + valsStr.join(', ') + ']');
        L.push('}');
    }
    return L.join("\n");
}

// =============================================================================
//  Top-level export entry point
// =============================================================================
function buildGodotScenes(doc, data, exportDir) {
    var uri = exportDir;
    if (uri.charAt(uri.length - 1) === "/") uri = uri.substring(0, uri.length - 1);
    var originalUri = uri;
    RES_PREFIX = "res://";
    while (uri.indexOf("/") !== -1) {
        if (FLfile.exists(uri + "/project.godot")) {
            var rel = originalUri.substring(uri.length);
            if (rel.charAt(0) === "/") rel = rel.substring(1);
            if (rel.length > 0 && rel.charAt(rel.length - 1) !== "/") rel += "/";
            RES_PREFIX = "res://" + rel;
            break;
        }
        var lastSlash = uri.lastIndexOf("/");
        if (lastSlash === -1) break;
        uri = uri.substring(0, lastSlash);
    }

    var boundsLookup = {};
    var allFiles = FLfile.listFolder(exportDir + "img/", "files") || [];
    var pngList = [];
    for (var i = 0; i < allFiles.length; i++) {
        var fnLower = allFiles[i].toLowerCase();
        if (fnLower.indexOf(".png") !== -1 && fnLower.indexOf(".import") === -1) {
            pngList.push(allFiles[i]);
        }
    }
    for (var i = 0; i < pngList.length; i++) {
        var fn = pngList[i];
        var noExt = fn.replace(/.png$/i, "");
        boundsLookup[noExt] = fn;
    }
    // Pre-build prefix index: group keys by their baseNoSpace prefix
    // (everything before _SHAPE_, _BOUNDS_, or _OFFSET_) for O(1) lookup.
    // Clés préfixées par "$" : un symbole/calque dont le nom sanitisé
    // composerait littéralement "constructor"/"toString"/etc. donnerait
    // sinon un faux résultat via les propriétés héritées d'Object.
    var boundsIndex = {};
    for (var fn in boundsLookup) {
        var sp = fn.indexOf("_SHAPE_");
        var bp = fn.indexOf("_BOUNDS_");
        var op = fn.indexOf("_OFFSET_");
        var base = (sp !== -1) ? fn.substring(0, sp) :
                   (bp !== -1) ? fn.substring(0, bp) :
                   (op !== -1) ? fn.substring(0, op) : fn;
        var bKey = "$" + base;
        if (!boundsIndex[bKey]) boundsIndex[bKey] = [];
        boundsIndex[bKey].push(fn);
    }
    fl.trace("DEBUG godotBuilder_v4: pngList length = " + (pngList ? pngList.length : "null")
        + ", boundsLookup count = " + pngList.length + " from path: " + exportDir + "img/*.png");

    FLfile.createFolder(exportDir + "symbols/");
    FLfile.createFolder(exportDir + "shaders/");
    FLfile.write(exportDir + "shaders/flash_color_normal.gdshader", SHADER_NORMAL);
    FLfile.write(exportDir + "shaders/flash_color_add.gdshader",    SHADER_ADD);
    FLfile.write(exportDir + "shaders/flash_color_mul.gdshader",    SHADER_MUL);

    var symbolMap = {};
    for (var i = 0; i < data.library.symbols.length; i++) {
        symbolMap[data.library.symbols[i].name] = data.library.symbols[i];
    }

    // Propagation "ce symbole a besoin d'un shader" (couleur/blend non triviaux,
    // ou il instancie un symbole qui en a lui-meme besoin). C'est un point fixe
    // MONOTONE (un symbole marque le reste pour toujours) : le resultat final
    // est unique quel que soit l'ordre/la strategie de propagation utilisee.
    // Au lieu de rebalayer TOUTE la bibliotheque a chaque iteration jusqu'a
    // stabilisation (couteux sur les hierarchies de symboles imbriquees), on
    // calcule en un seul passage (a) le besoin direct de chaque symbole et
    // (b) le graphe inverse "quels symboles instancient ce symbole", puis on
    // propage par worklist. Resultat mathematiquement identique, complexite
    // O(elements + symboles) au lieu de O(passes * elements).
    var symbolContainsShader = {};
    var directHasShader = {};
    var referencedBy = {};
    for (var i = 0; i < data.library.symbols.length; i++) {
        var sym = data.library.symbols[i];
        var hasShader = false;
        var usedChildren = {};
        if (sym.layers) {
            for(var l = 0; l < sym.layers.length; l++) {
                var layer = sym.layers[l];
                if (!layer.keyframes) continue;
                for(var k = 0; k < layer.keyframes.length; k++) {
                    var kf = layer.keyframes[k];
                    if (!kf.elements) continue;
                    for(var e = 0; e < kf.elements.length; e++) {
                        var elem = kf.elements[e];
                        if (elem.colorTransform) {
                            var ctn = _extractColorTransform(elem.colorTransform);
                            if (ctn.rA !== 0 || ctn.gA !== 0 || ctn.bA !== 0 || ctn.aA !== 0) hasShader = true;
                            if (ctn.rP < 0 || ctn.gP < 0 || ctn.bP < 0 || ctn.aP < 0) hasShader = true;
                        }
                        if (elem.blendMode && elem.blendMode !== "normal") hasShader = true;
                        if (elem.symbolName) usedChildren[elem.symbolName] = true;
                    }
                }
            }
        }
        directHasShader[sym.name] = hasShader;
        for (var childName in usedChildren) {
            if (!referencedBy[childName]) referencedBy[childName] = [];
            referencedBy[childName].push(sym.name);
        }
    }

    var shaderWorklist = [];
    for (var i = 0; i < data.library.symbols.length; i++) {
        var symName = data.library.symbols[i].name;
        if (directHasShader[symName]) {
            symbolContainsShader[symName] = true;
            shaderWorklist.push(symName);
        }
    }
    while (shaderWorklist.length > 0) {
        var curName = shaderWorklist.pop();
        var parents = referencedBy[curName];
        if (!parents) continue;
        for (var p = 0; p < parents.length; p++) {
            var parentName = parents[p];
            if (!symbolContainsShader[parentName]) {
                symbolContainsShader[parentName] = true;
                shaderWorklist.push(parentName);
            }
        }
    }

    _preprocessTweens(data, symbolMap);

    for (var i = 0; i < data.library.symbols.length; i++) {
        var s = data.library.symbols[i];
        if (_isAutoTweenName(s.name)) continue;
        buildSceneForSymbol(s, data.document.frameRate || 25, exportDir, boundsLookup, boundsIndex, symbolMap, symbolContainsShader);
    }

    var scene = data.scenes[0];
    var pseudoMain = {
        name: "Main",
        safeName: "main",
        layers: scene.layers,
        isMainScene: true,
        bgColor: data.document.backgroundColor || "#FFFFFF",
        docWidth: data.document.width || 1920,
        docHeight: data.document.height || 1080
    };
    buildSceneForSymbol(pseudoMain, data.document.frameRate || 25, exportDir, boundsLookup, boundsIndex, symbolMap, symbolContainsShader);
}

function _preprocessTweens(data, symbolMap) {

    function _expandTweens(elements) {
        var expanded = [];
        for (var e = 0; e < elements.length; e++) {
            var elem = elements[e];
            if (!(elem.elementType === "instance" && _isAutoTweenName(elem.symbolName))) {
                expanded.push(elem);
                continue;
            }
            var tweenSym = symbolMap[elem.symbolName];
            if (!(tweenSym && tweenSym.layers && tweenSym.layers.length > 0
                    && tweenSym.layers[0].keyframes && tweenSym.layers[0].keyframes.length > 0)) {
                expanded.push(elem);
                continue;
            }

            var innerKf = tweenSym.layers[0].keyframes[0];
            var innerElements = innerKf.elements || [];
            var expandedInner = _expandTweens(innerElements);

            var innerHasShape = false;
            for (var ii = 0; ii < expandedInner.length; ii++) {
                if (expandedInner[ii].elementType === "shape") { innerHasShape = true; break; }
            }

            if (innerHasShape) {
                var innerShape = null;
                for (var ii = 0; ii < expandedInner.length; ii++) {
                    if (expandedInner[ii].elementType === "shape") { innerShape = expandedInner[ii]; break; }
                }
                var outerClone = _deepClone(elem);
                outerClone.elementType = "shape";
                outerClone._isTweenShape = true;
                delete outerClone.symbolName;
                delete outerClone.instanceType;
                delete outerClone.symbolType;
                delete outerClone.sourceSymbol;
                delete outerClone.sourceLayer;
                delete outerClone.sourceFrame;
                
                if (innerShape) {
                    if (elem.matrix && innerShape.matrix) {
                        outerClone.matrix = _composeMatrix(elem.matrix, innerShape.matrix);
                    } else if (innerShape.matrix) {
                        outerClone.matrix = _deepClone(innerShape.matrix);
                    }
                    if (innerShape.polygons) {
                        outerClone.polygons = _deepClone(innerShape.polygons);
                    }
                    if (innerShape.strokes) {
                        outerClone.strokes = _deepClone(innerShape.strokes);
                    }
                }
                
                expanded.push(outerClone);
            } else {
                for (var k = 0; k < expandedInner.length; k++) {
                    var innerElem = _deepClone(expandedInner[k]);

                    if (elem.matrix && innerElem.matrix) {
                        innerElem.matrix = _composeMatrix(elem.matrix, innerElem.matrix);
                    } else if (elem.matrix) {
                        innerElem.matrix = _deepClone(elem.matrix);
                    }

                    delete innerElem.scaleX; delete innerElem.scaleY;
                    delete innerElem.rotation;
                    delete innerElem.skewX;  delete innerElem.skewY;

                    if (elem.colorTransform) {
                        if (!innerElem.colorTransform) innerElem.colorTransform = {};
                        var ct2 = _extractColorTransform(elem.colorTransform);
                        var ct1 = _extractColorTransform(innerElem.colorTransform);
                        innerElem.colorTransform.colorRedPercent   = ct1.rP * ct2.rP * 100;
                        innerElem.colorTransform.colorRedAmount    = ct1.rA * ct2.rP + ct2.rA;
                        innerElem.colorTransform.colorGreenPercent = ct1.gP * ct2.gP * 100;
                        innerElem.colorTransform.colorGreenAmount  = ct1.gA * ct2.gP + ct2.gA;
                        innerElem.colorTransform.colorBluePercent  = ct1.bP * ct2.bP * 100;
                        innerElem.colorTransform.colorBlueAmount   = ct1.bA * ct2.bP + ct2.bA;
                        innerElem.colorTransform.colorAlphaPercent = ct1.aP * ct2.aP * 100;
                        innerElem.colorTransform.colorAlphaAmount  = ct1.aA * ct2.aP + ct2.aA;
                    }

                    if (elem.blendMode && elem.blendMode !== "normal") {
                        innerElem.blendMode = elem.blendMode;
                    }
                    if (elem.visible !== undefined && innerElem.visible === undefined) {
                        innerElem.visible = elem.visible;
                    } else if (elem.visible !== undefined && innerElem.visible !== undefined) {
                        innerElem.visible = elem.visible && innerElem.visible;
                    }
                    if (elem.name) innerElem.name = elem.name;

                    expanded.push(innerElem);
                }
            }
        }
        return expanded;
    }

    function assignShapeIndices(layers) {
        if (!layers) return;
        for (var i = 0; i < layers.length; i++) {
            if (!layers[i].keyframes) continue;
            for (var j = 0; j < layers[i].keyframes.length; j++) {
                var kf = layers[i].keyframes[j];
                if (kf.elements) {
                    var rawShapeIdx = 0;
                    for (var e = 0; e < kf.elements.length; e++) {
                        if (kf.elements[e].elementType === "shape" || kf.elements[e].elementType === "shape object") {
                            kf.elements[e].sourceShapeIndex = rawShapeIdx++;
                        }
                    }
                }
            }
        }
    }

    function processLayers(layers) {
        if (!layers) return;
        for (var i = 0; i < layers.length; i++) {
            if (!layers[i].keyframes) continue;
            for (var j = 0; j < layers[i].keyframes.length; j++) {
                var kf = layers[i].keyframes[j];
                if (kf.elements) kf.elements = _expandTweens(kf.elements);
            }
        }
    }

    for (var i = 0; i < data.library.symbols.length; i++) {
        assignShapeIndices(data.library.symbols[i].layers);
    }
    for (var i = 0; i < data.scenes.length; i++) {
        assignShapeIndices(data.scenes[i].layers);
    }

    for (var i = 0; i < data.library.symbols.length; i++) {
        processLayers(data.library.symbols[i].layers);
    }
    for (var i = 0; i < data.scenes.length; i++) {
        processLayers(data.scenes[i].layers);
    }
}
