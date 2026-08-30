/**
 * SWF/FLA Inspector -> JSON Export (extended version)
 * JSFL script for Adobe Animate / Flash Professional
 *
 * v4.1 - Hole grouping restricted to cases where it actually matters:
 *   - Opposite-winding filter: a REAL Flash hole has a signed area of
 *     opposite sign to its outer (even-odd convention). Without this check
 *     we were grouping overlapping fills of the same fillKey as if they
 *     were holes.
 *   - Opacity filter: for opaque fills (alpha=255, no gradient), an
 *     overlapping outer + hole look visually the same as the outer alone,
 *     so the bridge adds nothing and only introduces earcut risk on the
 *     Godot side. We leave the sub-contours as separate polys -> identical
 *     rendering, zero risk. The bridge is applied ONLY to transparent
 *     fills (where alpha compositing would make the bridge necessary to
 *     avoid doubling the opacity in the hole area).
 *   - Degeneracy filter: area < 1 u² rejected (near-collinear 3-vertex
 *     Flash ghosts that were polluting the bridge with dozens of fake
 *     holes).
 *
 * v4 - Hole detection:
 *   - New `_groupPolygonsWithHoles` post-processing step after collecting
 *     contours. Polygons sharing the same fill (identical color or
 *     gradient) are grouped into outer -> holes relationships via:
 *       1. sort by descending area (the biggest = candidate outer),
 *       2. bbox containment test (cheap prefilter),
 *       3. point-in-polygon test on the candidate hole's centroid + first
 *          vertex.
 *     Output: `{ vertices: <outer>, holes: [[...], ...], color, gradient }`.
 *     Disabled for shape tweens (topology can change between frames).
 *   - The Godot builder uses `holes` via the bridge/keyhole technique to
 *     produce A SINGLE Polygon2D instead of N stacked nodes.
 *
 * v3 - Removed polygon fragmentation:
 *   - NO MORE _splitPolys: one Flash contour = one polygon, period. The
 *     recursive splitter would cut at the slightest detected
 *     self-intersection (often a false positive from discretization
 *     error), producing hundreds of fragments per scene and, worse,
 *     pieces that were STILL self-intersecting when the split failed
 *     (depth limit, 0.5px threshold ignored on near-tangent
 *     intersections). Every contour is now kept intact -> a Polygon2D
 *     faithful to the Flash shape.
 *   - Removed the _ccw, _intersect, _getIntersection, _splitPolys
 *     helpers.
 *
 * v2 - Polygon fixes:
 *   - Replaces linear sampling of Bézier curves (fixed ~5px step,
 *     100-step cap) with ADAPTIVE CASTELJAU SUBDIVISION based on
 *     flatness (perpendicular distance from the control point to the
 *     chord). 0.05px tolerance, 18 max depth -> polygons follow Flash
 *     curves exactly.
 *   - Simplified and reliable curve-direction detection (direct
 *     comparison of the endpoints to the starting vertex).
 *   - Removed _getT (imprecise numeric search) and cleaned up the dead
 *     code that depended on it.
 *   - Tightened the vertex deduplication threshold (0.0001 squared ≈
 *     0.01px) to only remove true duplicates.
 *   - MAX_EDGES raised to 10000 for very complex contours.
 *
 * Additions relative to the initial version (reminder):
 *  - Tweens (motion, shape, motion object) + custom easing
 *  - Frame scripts (actionScript) and label type
 *  - Frame sounds
 *  - Color transform (RGB + alpha + brightness + tint)
 *  - blendMode, cacheAsBitmap, 3D, instanceType, symbolType, loop graphic
 *  - text.textRuns + advanced props (lineType, anti-alias, etc.)
 *  - Shape elements (rect/oval primitives, drawing object, contour count)
 *  - Layer: locked/visible/outline/color/heightMultiplier/parentLayer
 *  - Library: bitmap (hPixels/vPixels/compression), sound (bits/sampleRate),
 *    video (fps/frameCount), symbol (scalingGrid/sourceFilePath)
 *  - Document: backgroundColor, asVersion, docClass
 *  - Accessibility, transformX/transformY, locked on element
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
// ADAPTIVE CASTELJAU SUBDIVISION FOR QUADRATIC BEZIER CURVES
// Subdivides a quadratic Bézier with a fixed step to guarantee perfectly
// symmetric circles. The adaptive Casteljau approach produced slightly
// asymmetric polygons because of floating-point rounding.
function _subdivideQuadratic(p1, p2, p3, outPoints, depth) {
    var dx1 = p2.x - p1.x;
    var dy1 = p2.y - p1.y;
    var dx2 = p3.x - p2.x;
    var dy2 = p3.y - p2.y;
    var len = Math.sqrt(dx1*dx1 + dy1*dy1) + Math.sqrt(dx2*dx2 + dy2*dy2);
    // =========================================================
    // CURVE QUALITY SETTING (vertex count)
    // Change this value to tune performance/visuals.
    // "High"   : Very round, lots of vertices (1 pt / 1.5 px)
    // "Medium" : Performance/visual balance (1 pt / 3 px)
    // "Low"    : Optimized, slightly polygonal shapes (1 pt / 10 px)
    // "VeryLow": Ultra-optimized for mobile/web (1 pt / 30 px)
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
    
    // Vital minimum for a curve to exist (3 steps = 1 point in the middle).
    // Going below 3 turns curves into straight lines.
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
        // Array accumulation + a single final join(), rather than
        // `text += ...` character by character: ExtendScript (unlike
        // modern JS engines that optimize concatenation via rope
        // structures) copies the whole string on every `+=`, so O(n²) for
        // n characters of text accumulated one at a time. Each "flat" text
        // run (outside tags) is also extracted with a SINGLE substring()
        // call per run instead of a charAt()+push() per character.
        var textParts = [];

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
                    textParts.push(src.substring(i + 9, ec3));
                    i = ec3 + 3;
                } else {
                    var child = parseElement();
                    if (child) children.push(child);
                }
            } else {
                var textRunStart = i;
                while (i < n && src.charAt(i) !== "<") i++;
                textParts.push(src.substring(textRunStart, i));
            }
        }

        if (children.length > 0) node.children = children;
        var trimmed = textParts.join("").replace(/^\s+|\s+$/g, "");
        if (trimmed && children.length === 0) node.text = decodeEntities(trimmed);

        return node;
    }

    skipPrologAndComments();
    return parseElement();
}


// Detects pairs of polygons that are THE SAME contour exported twice (same
// vertices) but with OPPOSITE windings, and keeps only the CCW one
// (signedArea > 0).
//
// Origin: in Flash, an edge has fillStyle1 on one side and fillStyle2 on
// the other. When the two sides have different fills (e.g. black on one
// side, white on the other), Flash extracts a SINGLE edge as TWO
// overlapping contours traversed in opposite directions. The CCW one
// carries the fill of the "inner" side (= the color actually visible on
// top of that edge), the CW one carries the fill of the "outer" side (=
// the color already provided by the enclosing shape: white sclera, black
// iris, etc).
//
// Without this fix, both get exported as distinct polygons at the exact
// same position. The poly on top overwrites the other depending on the
// children order in the Godot scene — hence "wrong side is visible"
// symptoms (e.g. vener Layer_4/shape_0, where the white Poly_6 contour on
// the iris's outer side covered the black iris Poly_5, resulting in a
// white iris).
//
// The CCW one is kept because it represents the "in-place" fill of that
// edge. The CW one is redundant: its content will be drawn by the
// enclosing polygon, which already shares that edge on its perimeter.
function _removeOppositeWindingDuplicates(polys) {
    if (polys.length < 2) return polys;

    // Index by "geometric key" = sorted + rounded vertices. Allows matching
    // two polygons that have the SAME vertices but possibly enumerated
    // starting from a different point and/or in the opposite direction.
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

    function _fillKeyForDedup(p) {
        if (p._noFillHole) return null; // never a legitimate "keep both" partner
        if (p.gradient) {
            var g = p.gradient;
            var k = "G:" + (g.style || "");
            if (g.colors) k += "|" + g.colors.join(",");
            return k;
        }
        return "C:" + (p.color || "");
    }

    var byKey = {};  // "$<key>" -> array of { idx, sa, fillKey }
    for (var i = 0; i < polys.length; i++) {
        var v = polys[i].vertices;
        if (!v || v.length < 3) continue;
        var key = "$" + _geomKey(v);
        var sa = _signedArea(v);
        if (!byKey[key]) byKey[key] = [];
        byKey[key].push({ idx: i, sa: sa, fillKey: _fillKeyForDedup(polys[i]) });
    }

    var toDrop = {};
    for (var k in byKey) {
        if (!byKey.hasOwnProperty(k)) continue;
        var group = byKey[k];
        if (group.length < 2) continue;
        // Look for a CCW (sa > 0) + CW (sa < 0) pair. Touch NOTHING if all
        // entries have the same sign (degenerate case or non-Flash
        // duplicate we'd rather preserve). Flash's own CW/CCW convention
        // for "which side is the noFill one" isn't consistent from one
        // boundary to the next (observed both ways on real shapes), so
        // which SIGN gets dropped is decided per-entry below, not fixed to
        // "always CW".
        var hasCCW = false, hasCW = false;
        for (var g = 0; g < group.length; g++) {
            if (group[g].sa > 0.001) hasCCW = true;
            else if (group[g].sa < -0.001) hasCW = true;
        }
        if (hasCCW && hasCW) {
            for (var g = 0; g < group.length; g++) {
                if (group[g].sa > -0.001 && group[g].sa < 0.001) continue; // degenerate, leave alone
                // The SAME closed loop can legitimately be needed on BOTH
                // sides at once: it's simultaneously the inner hole boundary
                // of one fill and the outer boundary of an ADJACENT,
                // DIFFERENTLY-colored one (e.g. concentric rings/gradient
                // bands, each color's own boundary shared with its
                // neighbor) -- not a redundant "same shape traced twice"
                // duplicate. Only drop an entry when there's an OPPOSITE-
                // signed counterpart in this group that's either the exact
                // same fillKey (a genuine same-position, same-color repeat
                // -- the original "shading layer hides the layer under it"
                // case this function targets) or this entry itself has no
                // fill of its own to lose (a noFillHole boundary, or the
                // true outermost edge with nothing beyond it). A
                // DIFFERENT-fillKey opposite-signed counterpart means both
                // sides are still needed, each for its own ring's pairing
                // below -- neither gets dropped in that case.
                var thisFillKey = group[g].fillKey;
                var safeToDrop = (thisFillKey === null);
                if (!safeToDrop) {
                    for (var g2 = 0; g2 < group.length; g2++) {
                        if (g2 === g) continue;
                        var oppositeSign = (group[g].sa > 0) !== (group[g2].sa > 0);
                        if (oppositeSign && group[g2].fillKey === thisFillKey) { safeToDrop = true; break; }
                    }
                }
                if (safeToDrop) toDrop[group[g].idx] = true;
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
    if (!polys || polys.length === 0) return polys;
    if (polys.length === 1) {
        // A single "no fill" contour with nothing else in this same shape
        // to pair it with as an outer -- e.g. a pure stroke-outline shape,
        // whose enclosed region is legitimately unfilled, not an actual cut
        // into some sibling shape's fill (each element's contours are only
        // ever grouped WITHIN that same element -- a hole and its outer
        // living in two different sibling shapes can't be paired here at
        // all). Drop it instead of letting it fall through as its own
        // spurious, colorless polygon.
        return polys[0]._noFillHole ? [] : polys;
    }
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
     * Real holes must always be "bridged" to become a single Polygon2D in
     * Godot (which has no native even-odd rule for filling multiple
     * polygons).
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
    // Perceptual luminance of a #RRGGBB hex color (Rec. 601 formula). Used
    // as a tie-breaker when several polygons have the SAME area (typical of
    // eye/iris/highlight shapes where a white area overlaps a black one of
    // the same size). Without a tie-breaker, the order depends on Flash's
    // `el.contours[]`, which is not the draw order and varies from one
    // keyframe to the next even for visually identical shapes. With this
    // tie-breaker, the darker one is drawn FIRST (underneath), the lighter
    // one ON TOP — a common Flash convention (highlights on top). Seen on
    // FACES: "black hides white" symptom on mijot shape_3 (3 polys [black,
    // white, black]) and vener Layer_4 shape_0 (white/black pairs sharing a
    // bbox).
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
                noFillHole: !!polys[i]._noFillHole,
                valid: true
            });
        }
    }

    var order = meta.slice();
    order.sort(function(a, b) {
        var d = b.area - a.area;
        // Distinct areas (within 0.01): sort by area DESC, unchanged.
        // Equal areas (eye/highlight case): the darker one goes first in
        // `order`, so first in the final `result` -> drawn underneath.
        // The lighter one ends up last -> drawn on top.
        if (Math.abs(d) > 0.01) return d;
        return a.lightness - b.lightness;
    });

    var assigned = {};
    var result = [];

    // Pass 1: let every REAL (non-noFillHole) polygon search for and claim
    // its holes first, regardless of area-sort order. `order` is sorted
    // purely by area -- nothing ties a "no fill" hole candidate to
    // appearing right after (or even near) the polygon it belongs to, so a
    // large noFillHole entry can easily be sorted BEFORE its real, smaller
    // owner. Skipping it here (instead of dropping it outright) leaves it
    // available for a later outer's inner search loop below to still find
    // and claim it as a genuine hole.
    for (var oi = 0; oi < order.length; oi++) {
        var oM = order[oi];
        if (oM.noFillHole) continue;
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

        // For opaque fills we skip hole detection entirely: no visual
        // value added (opaque overlap = identical rendering), and it
        // avoids earcut risk on complex bridges. Cf. _isOpaque. BUT we
        // still mark "hole" contours as assigned to keep them from showing
        // up as redundant polygons (e.g. Poly_5 lotus).
        for (var hi = 0; hi < order.length; hi++) {
            var hM = order[hi];
            if (assigned[hM.idx]) continue;
            if (hM.idx === oM.idx) continue;
            if (!hM.valid) continue;
            // Skip degenerate ghosts: Flash often exports near-collinear
            // 3-vertex contours (area ~ 0) that aren't real holes. Without
            // this filter we'd bridge them -> 80+ "holes" for the tiniest
            // fill, the multi-hole bridge chokes, and the safety net drops
            // everything. Threshold = 1 unit² covers the artifacts without
            // risking dropping a small real hole (real ones are typically
            // >> 5 u²).
            if (hM.area < 1.0) continue;
            if (hM.area >= oM.area) continue;
            // A "no fill" contour (Flash's OTHER way to represent a hole,
            // besides same-fill-opposite-winding) has no fillKey of its own
            // to compare, and no color that could make it a plausible
            // OVERLAPPING DECORATION either (unlike the same-fillKey case
            // below) -- by construction it can only ever be a genuine hole.
            // Skip both the fillKey AND winding checks for it: the bbox/
            // point-containment/coverage checks further down still fully
            // disambiguate which outer it belongs to.
            if (!hM.noFillHole && hM.fillKey !== oM.fillKey) continue;
            // A REAL Flash hole of the SAME-FILLKEY kind has a winding
            // OPPOSITE to its outer (even-odd convention: outer CCW, hole
            // CW, or vice versa). Two contours of the same fillKey with the
            // SAME area sign are overlapping fills (a layering effect in
            // Flash), not holes. Without this check we'd bridge polys that
            // shouldn't be, the self-touching result confuses earcut on the
            // Godot side, and the polygon becomes invisible. Typical case:
            // Rock1, where every shading layer has sign='-' (same winding).
            // Doesn't apply to a noFillHole candidate: _extractSubLoops
            // doesn't guarantee alternating winding when it splits a single
            // self-touching bridge path into separate loops, so a genuine
            // noFillHole/outer pair can legitimately share the same sign.
            if (!hM.noFillHole && hM.signedArea * oM.signedArea > 0) continue;

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
                // Second confirmation point, nudged 2% from the hole's first
                // vertex TOWARD its own centroid: a plain hVerts[0] can land
                // exactly ON the outer's boundary edge when the hole and its
                // outer share a seam (e.g. concentric/touching ring bands,
                // or a noFillHole boundary) -- floating-point ray-casting
                // right at a boundary is a well-known false-negative case
                // for point-in-polygon tests. Nudging inward keeps the
                // check meaningful (still near the hole's actual shape)
                // without the boundary-precision flakiness.
                var nudgeX = hVerts[0].x + (cx - hVerts[0].x) * 0.02;
                var nudgeY = hVerts[0].y + (cy - hVerts[0].y) * 0.02;
                if (!_pip({ x: nudgeX, y: nudgeY }, outerVerts)) continue;
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

            // Check whether the hole is covered by one or more other shapes.
            var isCovered = false;

            // If there are more than 50 polygons in total in the symbol,
            // skip the coverage check (isCovered) entirely. The O(N^3)
            // computation would take billions of iterations.
            if (order.length <= 50) {
                var cCandidates = [];
                for (var ci = 0; ci < order.length; ci++) {
                    var cM = order[ci];
                    if (!cM.valid || cM.idx === hM.idx || cM.idx === oM.idx) continue;
                    if (cM.signedArea * oM.signedArea > 0) { // solid contour
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

            // It's a real hole. Pass it to the bridge.
            // We need the bridge even for opaque shapes, otherwise we wouldn't
            // see the background through the hole (Godot would triangulate a solid circle).
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

    // Pass 2: any "no fill" contour still unassigned after every real
    // polygon above had its turn -- never claimed as anyone's hole -- has
    // no fill of its own, so drop it instead of falling through as its own
    // stray, colorless polygon.
    for (var oi2 = 0; oi2 < order.length; oi2++) {
        assigned[order[oi2].idx] = 1;
    }

    __log("  <- _groupPolygonsWithHoles DONE (" + result.length + " merged polys)");
    return result;
}

// Clone a gradient without using JSON.parse (incompatible with some Flash versions)
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

// Extract sub-loops (holes connected by zero-width bridges)
function _extractSubLoops(p) {
    var finalPolys = [];
    var current = [];

    var len = p.vertices.length;
    var grid = {};
    var cellSize = 10.0; // Cell large enough to catch 0.001
    function getCell(x, y) { return Math.floor(x/cellSize) + "_" + Math.floor(y/cellSize); }

    for (var i = 0; i < len; i++) {
        var v = p.vertices[i];
        var matchedIdx = -1;
        
        var cx = Math.floor(v.x/cellSize);
        var cy = Math.floor(v.y/cellSize);
        
        // Search the 9 adjacent cells
        var found = false;
        for(var ox = -1; ox <= 1 && !found; ox++) {
            for(var oy = -1; oy <= 1 && !found; oy++) {
                var cellKey = (cx+ox) + "_" + (cy+oy);
                var cell = grid[cellKey];
                if (cell) {
                    // Walk backwards to find the most recent one (though normally only one overlaps)
                    for (var cIdx = cell.length - 1; cIdx >= 0; cIdx--) {
                        var j = cell[cIdx];
                        if (j >= current.length - 2) continue; // Not the last 2
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
            if (p._noFillHole) loopPoly._noFillHole = true;
            finalPolys.push(loopPoly);
            
            // Clean the grid of points being removed from 'current'
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
        if (p._noFillHole) remainingPoly._noFillHole = true;
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
            // A noFill contour is only ever useful as a hole for some OTHER
            // contour's real fill in this SAME shape (see below) -- with no
            // real fill anywhere in the shape at all, every noFill contour
            // is guaranteed to end up dropped regardless (nothing to pair
            // it with). Checked here, cheaply (just contour.fill.style, no
            // vertex walking), so the expensive per-edge walk below can
            // skip noFill contours entirely in that case instead of fully
            // extracting geometry that's thrown away either way.
            var hasAnyRealFill = false;
            if (el.contours && el.contours.length > 0) {
                for (var c = 0; c < el.contours.length; c++) {
                    var fill = el.contours[c].fill;
                    if (fill) {
                        if (fill.style === "linearGradient" || fill.style === "radialGradient") hasGradient = true;
                        if (fill.style !== "noFill") hasAnyRealFill = true;
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

                        var isNoFillContour = false;
                        try {
                            if (!contour.fill || contour.fill.style === "noFill") {
                                // A hole cut into a fill can be represented by
                                // Flash as its own contour with NO fill of its
                                // own -- as opposed to the "same fill, opposite
                                // winding" case _groupPolygonsWithHoles already
                                // handles below. Discarding it outright (as
                                // before) throws away the hole's geometry
                                // entirely: the containing fill then renders
                                // solid, with no hole at all. Still collected
                                // below (flagged, no real color) so
                                // _groupPolygonsWithHoles can recognize and
                                // bridge it -- but only when that pass will
                                // actually run: for a shape tween, hole-
                                // grouping is disabled entirely (topology can
                                // change between frames -- see below), so an
                                // ungrouped noFill contour would just become
                                // its own stray, colorless polygon. Keep the
                                // original skip in that case -- also skip
                                // (same reasoning) when NOTHING in this
                                // shape has a real fill to pair this against
                                // in the first place: it would only ever be
                                // dropped by _groupPolygonsWithHoles's own
                                // "lone noFillHole, nothing to claim it"
                                // case, so extracting its full geometry here
                                // is wasted work.
                                if (isShapeTween || !hasAnyRealFill) continue;
                                isNoFillContour = true;
                            } else if (contour.fill.style === "linearGradient" || contour.fill.style === "radialGradient") {
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
                    
                    // PASS 1: Collect all raw geometric edges
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

                    // PASS 2: Perfect assembly (Flash gives edges in the reverse of geometric order)
                    // Simply reverse the array to get them in the correct continuous order!
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
                            if (isNoFillContour) currentPoly._noFillHole = true;
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

                // v4 - Hole detection: group contours of the same fill into
                // outer -> holes relationships. Disabled for shape tweens
                // (topology can change between frames -> would break interpolation).
                // Also runs for a SINGLE lone "no fill" polygon (nothing in
                // this same shape to pair it with as an outer) so
                // _groupPolygonsWithHoles can still drop it -- see there.
                var singleNoFillHole = (s.polygons.length === 1 && s.polygons[0]._noFillHole);
                if ((s.polygons.length > 1 || singleNoFillHole) && !isShapeTween) {
                    // Before hole-grouping: eliminate overlapping CCW/CW
                    // pairs (two fillStyles on each side of a shared edge
                    // exported as 2 distinct polys at the same position).
                    // Without this, the redundant CW hides the visible CCW.
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
            // A group can also have raw fills drawn directly within it
            // (accessible via el.contours on the group itself, not via
            // el.members). Extract them separately and store them in obj.shapes.
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
            // Flash eats '/' in the Item.name setter: assigning
            // "folder/item" to .name makes Flash treat it as the BASE NAME
            // only (the item stays in its current folder), and replaces the
            // invalid '/' with '-'. Symptom observed: for
            // "_GFX/_Moods/oeil mouillé" we ended up with an orphan
            // "_GFX/_Moods/_GFX-_Moods-oeil mouillé_tempGodotExportShapeTween"
            // in the library, and then itemExists()/deleteItem() missed the
            // cleanup (they looked for the expected path, not the mangled
            // one), leaving the original symbol empty in the JSON.
            // Fix: split path/base, assign ONLY the base name (no slash) to
            // Item.name, and keep the full path for library operations
            // (itemExists / editItem / deleteItem).
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
                selItems[0].name = _tempBaseName;   // BASE NAME ONLY (no slash)
                doc.library.editItem(tempName);     // full path for lookup
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

            // Skip orphan temp symbols left behind by earlier failed shape
            // tween baker runs (cf. the fix in inspectSymbolItem). Without
            // this skip, these (often empty) orphans pollute the JSON and
            // can even trigger a new recursive baking cycle.
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
// MODULE ENTRY POINT
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

    // Compose M2 (the removed instance's matrix, e.g. ev.originalEl.matrix)
    // with M1 (the child element's local matrix): the point is first
    // transformed by M1 (the child symbol's local space), then by M2 (the
    // instance's placement in the parent). Without this composition,
    // elements injected into SharedLayer_N keep their coordinates local to
    // the child symbol and end up misplaced on the parent layer.
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

        // getShift(frame) is called several times per keyframe/event;
        // instead of rescanning all of `expansions` on every call (O(n) per
        // call), sort once and precompute a cumulative sum, then do a
        // binary search (O(log n) per call). Identical result: the sum of
        // expandBy for frame < f doesn't depend on summation order
        // (addition is commutative), so sorting before summing doesn't
        // change the total.
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

        var eventLayerSigs = [];
        for (var e = 0; e < flattenEvents.length; e++) {
            eventLayerSigs[e] = [];
            var ev = flattenEvents[e];
            for (var i = 0; i < maxSharedLayers; i++) {
                if (i < ev.childSym.layers.length) {
                    var cL = ev.childSym.layers[i];
                    var type = cL.layerType || "normal";
                    var parentIdx = undefined;
                    if (cL.parentLayerName) {
                        for (var p = 0; p < ev.childSym.layers.length; p++) {
                            if (ev.childSym.layers[p].name === cL.parentLayerName) {
                                parentIdx = p;
                                break;
                            }
                        }
                    }
                    eventLayerSigs[e][i] = type + "|" + parentIdx;
                } else {
                    eventLayerSigs[e][i] = null;
                }
            }
        }

        var layerSignatures = [];
        for (var i = 0; i < maxSharedLayers; i++) {
            layerSignatures[i] = [];
            for (var e = 0; e < flattenEvents.length; e++) {
                var sig = eventLayerSigs[e][i];
                if (sig !== null) {
                    var found = false;
                    for (var s = 0; s < layerSignatures[i].length; s++) {
                        if (layerSignatures[i][s] === sig) { found = true; break; }
                    }
                    if (!found) {
                        layerSignatures[i].push(sig);
                    }
                }
            }
            if (layerSignatures[i].length === 0) {
                layerSignatures[i].push("normal|undefined");
            }
        }

        var sharedLayers = [];
        for (var i = 0; i < maxSharedLayers; i++) {
            for (var s = 0; s < layerSignatures[i].length; s++) {
                var sig = layerSignatures[i][s];
                var parts = sig.split("|");
                var type = parts[0];
                var parentIdx = parts[1] !== "undefined" ? parseInt(parts[1], 10) : undefined;
                
                var lName = (layerSignatures[i].length === 1) ? ("SharedLayer_" + i) : ("SharedLayer_" + i + "_s" + s);
                var sLayer = { name: lName, layerType: type, keyframes: [], _index: i, _sig: sig, _parentIdx: parentIdx };
                sharedLayers.push(sLayer);
            }
        }

        for (var i = 0; i < sharedLayers.length; i++) {
            var sLayer = sharedLayers[i];
            if (sLayer._parentIdx !== undefined) {
                var parentSig = null;
                for (var e = 0; e < flattenEvents.length; e++) {
                    if (eventLayerSigs[e][sLayer._index] === sLayer._sig) {
                        parentSig = eventLayerSigs[e][sLayer._parentIdx];
                        break;
                    }
                }
                if (parentSig) {
                    var pIndex = sLayer._parentIdx;
                    var pS = -1;
                    for (var k = 0; k < layerSignatures[pIndex].length; k++) {
                        if (layerSignatures[pIndex][k] === parentSig) {
                            pS = k;
                            break;
                        }
                    }
                    if (pS !== -1) {
                        var pName = (layerSignatures[pIndex].length === 1) ? ("SharedLayer_" + pIndex) : ("SharedLayer_" + pIndex + "_s" + pS);
                        sLayer.parentLayerName = pName;
                    }
                }
            }
        }

        for (var i = 0; i < sharedLayers.length; i++) {
            var sLayer = sharedLayers[i];
            var currentFrame = 0;
            
            for (var e = 0; e < flattenEvents.length; e++) {
                var ev = flattenEvents[e];
                
                if (ev.start > currentFrame) {
                    sLayer.keyframes.push({ startFrame: currentFrame, duration: ev.start - currentFrame, elements: [] });
                }
                
                if (sLayer._index < ev.childSym.layers.length && eventLayerSigs[e][sLayer._index] === sLayer._sig) {
                    var cLayer = ev.childSym.layers[sLayer._index];
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
            
            delete sLayer._index;
            delete sLayer._sig;
            delete sLayer._parentIdx;
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

    __log("[DEBUG]  -> Inspecting the FLA structure...");

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
