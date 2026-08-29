if (typeof fl !== "undefined") fl.trace(">>> godotBuilder_v4 LOADED <<<");

// Detailed version history (v4.6 -> v4.15): see readme.md, "Version
// History" section. Summary of the node-reduction passes currently active
// (in pipeline order):
//   v4.6  _bridgeHoles              - Polygon2D with holes as a single node
//   v4.7  (inline)                  - node itself = 1st element (no dedicated wrapper)
//   v4.9  _mergeSameColorSiblings   - cross-element same-color merging
//   v4.10 _flattenSingleChildGroups - flattening of empty single-child wrappers
//   v4.11 _bakeStaticShaderTints    - pre-tinting statically-colored shapes
//   v4.13 (bbox enabler)            - correct VisibleOnScreenEnabler2D rect
//   v4.15 (skipEnablerFor)          - a single enabler per animated subtree
// v4.12 (root promotion) was attempted then REVERTED (position bug
// confirmed in production): see readme.md for details.


// __log/safeNum/safeStr: defined in inspector.jsfl, loaded before this
// file by main.jsfl in the same JSFL global scope (fl.runScript doesn't
// create an isolated scope). Redefining them here would shadow them for
// the ENTIRE rest of the pipeline, including inspector.jsfl's own
// extraction (the two files share a single global namespace) -- which was
// the case until this cleanup: this copy used Number()/a plain falsy
// check instead of parseFloat()+3-decimal rounding and a null/undefined
// check, with a real risk of silent divergence (e.g. safeStr(false) used
// to return "" instead of "false").

var RES_PREFIX = "res://";

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
 * Bridge / keyhole: merges an outer contour and N holes into a single
 * vertex array, connecting each hole to the outer via a zero-width
 * "slit". The resulting Polygon2D natively renders the holes without any
 * custom triangulation.
 *
 * v2 - multi-hole robustness:
 *   - segment-segment non-crossing check (strict ccw): rejects any
 *     candidate whose bridge would cross an existing edge of work or of
 *     the hole.
 *   - exclusion of already-placed bridge endpoints (`br` flag): prevents
 *     two holes from sharing the SAME pair of points, which produced
 *     overlapping edges running in opposite directions (the most common
 *     cause of invisibility in Godot, since earcut gives up on
 *     self-intersection).
 *   - candidates sorted by distance + first-non-crossing: keeps bridges
 *     short while still guaranteeing topological validity.
 *   - maxCheck = 500 iterations to bound the worst case; falls back to
 *     the closest candidate if nothing clean is found.
 */

// Pure geometry helpers, shared by _bridgeHoles and _hasSelfIntersection.
// Hoisted to module scope: they capture no local variable, so recreating
// them on every call (the old nested-function pattern) was pure wasted
// allocation, repeated for every polygon-with-holes processed per frame.
// A single definition instead of two duplicated copies.
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
    // The raw outer contour can itself already be self-intersecting
    // (independent of any hole -- e.g. a dense/complex Flash shape).
    // _cleanupPolygonVertices's own repair pass never reaches this data
    // (it only sees whatever _bridgeHoles returns, and skips its own
    // repair above 500 vertices anyway): every candidate bridge built on
    // top of an already-self-intersecting outer necessarily also self-
    // intersects, so every hole silently ends up uncut. Repair the outer
    // FIRST, before it's ever used as a bridge base.
    if (work.length > 3 && _hasSelfIntersection(work)) {
        work = _removeSelfIntersections(work);
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
        // v4.21 found candidates[0] alone wasn't enough (see the retry loop
        // below); on dense multi-hole shapes even 50 nearest candidates can
        // ALL fail the full check, leaving that hole uncut. 200 clears
        // every remaining case found in a real project's library while
        // staying a bounded, cheap candidate pool (insertion-sort capped).
        var maxCand = 200;

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

        // Try candidates in order of proximity until one produces a fully
        // valid bridge -- not just the FIRST one that passes _bridgeBlocked
        // (which only checks the connecting segment itself against existing
        // edges). The comprehensive self-intersection check below also
        // covers the two eps-offset "return" points, which _bridgeBlocked
        // never sees; a candidate can pass _bridgeBlocked and still produce
        // a self-intersecting result once those are added. The BUG this
        // fixes: the old code picked only that first _bridgeBlocked-passing
        // candidate and, if ITS full result self-intersected, gave up on
        // the hole entirely (leaving it completely uncut) instead of
        // falling through to the next-closest candidate.
        // eps of 0.05 passed our OWN self-intersection check (strict
        // crossing only) but left the two "return" points of every bridge
        // only ~0.05 units apart -- a near-coincident pinch that a
        // topology-valid-but-degenerate-tolerant library (earcut) handles
        // fine, but that Godot's own Polygon2D triangulator can apparently
        // fail on SILENTLY (no error, just nothing drawn): confirmed on a
        // real multi-hole shape (13 holes) where every hole's bridge seam
        // sat at exactly this distance. 0.5 gives ear-clipping meaningfully
        // more room while staying visually negligible against shapes drawn
        // at Flash's native scale (thousands of units).
        var eps = 0.5;
        var maxCheck = candidates.length;
        var bridgeApplied = false;
        for (var c = 0; c < maxCheck; c++) {
            var ci = candidates[c].i;
            var cj = candidates[c].j;
            // A hole vertex already sitting (near-)exactly on top of an
            // outer-contour vertex is always the closest possible
            // candidate (distance ~0), so the loop would otherwise always
            // pick it first -- but that makes work[ci] and hole[cj] the
            // SAME point, duplicated in the bridged output at two
            // non-adjacent indices: a genuine zero-width pinch (distinct
            // from the eps-offset "return" points below, which stay a
            // real, non-zero distance apart). Confirmed on a real 13-hole
            // shape where every hole contributed exactly one such exact-
            // duplicate pair. _hasSelfIntersection's strict crossing-only
            // test doesn't flag a touch like this, but it's a classic
            // ear-clipping killer for Godot's own triangulator (silently
            // renders nothing, no error). Skip it and let the retry loop
            // fall through to the next-closest DISTINCT candidate instead.
            if (candidates[c].d < 1.0) continue;
            if (_bridgeBlocked(work[ci], hole[cj], work, ci, hole, cj)) continue;

            var dx = work[ci].x - hole[cj].x;
            var dy = work[ci].y - hole[cj].y;
            var len = Math.sqrt(dx*dx + dy*dy);
            var nx = 0, ny = 0;
            if (len > 0.0001) {
                nx = -(dy / len) * eps;
                ny = (dx / len) * eps;
            }

            var candidateWork = [];
            for (var k = 0; k <= ci; k++) candidateWork.push(work[k]);
            for (var k = 0; k < hole.length; k++) {
                var idx = (cj + k) % hole.length;
                var atBridgeStart = (k === 0);
                candidateWork.push({ x: hole[idx].x, y: hole[idx].y, br: atBridgeStart });
            }
            candidateWork.push({ x: hole[cj].x + nx, y: hole[cj].y + ny, br: true });
            candidateWork.push({ x: work[ci].x + nx, y: work[ci].y + ny, br: true });
            for (var k = ci + 1; k < work.length; k++) candidateWork.push(work[k]);

            if (_hasSelfIntersection(candidateWork)) continue;

            work[ci].br = true;
            work = candidateWork;
            bridgeApplied = true;
            break;
        }
        if (!bridgeApplied) continue;
    }

    return _nudgeCoincidentVertices(work);
}

// Standard ray-casting point-in-polygon test (odd-crossing rule).
function _pointInPolygon(pt, poly) {
    var inside = false;
    var n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
        var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        var intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Splits an outer polygon containing `holesArr` holes into an array of
// SIMPLE, hole-free polygon vertex-loops whose union reconstructs the
// original polygon-with-holes -- an alternative to _bridgeHoles's "merge
// everything into one contour via a near-zero-width channel" technique.
// Each hole is "vented" out via TWO real, well-separated cuts (not one
// near-zero-width one), splitting whichever current piece contains it
// into two honest simple polygons: no thin channels, no near-duplicate
// points, nothing for Godot's own Polygon2D triangulation to choke on
// (see _bridgeHoles's header for the failure this sidesteps). Preferred
// over bridging+precomputed-mesh: every resulting piece is a plain
// Polygon2D "polygons" entry, so shapes stay fully native (visible/
// editable like any other Polygon2D, no MeshInstance2D/custom script).
//
// Falls back to _bridgeHoles (merging into the SAME piece, single-cut)
// for any hole a clean 2-cut split can't be found for -- confirmed
// necessary on real shapes: a few holes are thin enough (near-degenerate
// slivers) that no valid non-self-intersecting 2-cut split exists at all,
// while a single thin bridge still works fine for them (its failure mode
// is different -- see _bridgeHoles's own extensive hardening). Never
// leaves a hole completely unaddressed as a last resort: if even that
// fails, the hole is returned in `unvented` and the CALLER decides
// whether to accept the shape uncut there or reject the whole polygon.
function _splitHoles(outerVerts, holesArr) {
    var pieces = [outerVerts.slice()];
    if (!holesArr || holesArr.length === 0) return { pieces: pieces, unvented: [] };

    var holes = holesArr.slice();
    holes.sort(function (a, b) { return _polyBBoxArea(b) - _polyBBoxArea(a); });

    var unvented = [];
    for (var h = 0; h < holes.length; h++) {
        var hole = holes[h];
        var pieceIdx = _findPieceContaining(pieces, hole);
        if (pieceIdx === -1) { unvented.push(hole); continue; }
        var split = _splitPieceByHole(pieces[pieceIdx], hole);
        if (split) {
            pieces.splice(pieceIdx, 1, split.pieceA, split.pieceB);
            continue;
        }
        var bridged = _bridgeHoles(pieces[pieceIdx], [hole]);
        if (bridged && !_hasSelfIntersection(bridged)) {
            pieces[pieceIdx] = bridged;
        } else {
            unvented.push(hole);
        }
    }
    return { pieces: pieces, unvented: unvented };
}

// How far the split pieces' total area is from the polygon-with-holes'
// own true area (outer minus every hole) -- the caller's signal for
// whether to trust this split or fall back to the old single-bridge
// technique for this one sub-polygon. Complements _splitHoles's own
// "unvented"/self-intersection safeguards: those catch outright failures,
// this catches a MECHANICALLY valid-looking split (every piece simple, no
// hole left unaddressed) that still ends up geometrically wrong -- e.g. a
// hole "vented" against the wrong piece, or into a piece with too little
// candidate density to find the truly nearest cut points (confirmed on
// real shapes with many holes close together).
function _splitAreaDeviation(polyData, pieces) {
    var outerArea = Math.abs(_signedAreaSum(polyData.vertices)) / 2;
    if (outerArea < 1e-6) return 0;
    var holeAreaSum = 0;
    for (var i = 0; i < polyData.holes.length; i++) {
        holeAreaSum += Math.abs(_signedAreaSum(polyData.holes[i])) / 2;
    }
    var expected = outerArea - holeAreaSum;
    if (expected < 1e-6) return 0;
    var totalArea = 0;
    for (var i = 0; i < pieces.length; i++) {
        totalArea += Math.abs(_signedAreaSum(pieces[i])) / 2;
    }
    return Math.abs(expected - totalArea) / expected;
}

function _polyBBoxArea(verts) {
    var minX = verts[0].x, maxX = verts[0].x, minY = verts[0].y, maxY = verts[0].y;
    for (var i = 1; i < verts.length; i++) {
        if (verts[i].x < minX) minX = verts[i].x; if (verts[i].x > maxX) maxX = verts[i].x;
        if (verts[i].y < minY) minY = verts[i].y; if (verts[i].y > maxY) maxY = verts[i].y;
    }
    return (maxX - minX) * (maxY - minY);
}

// Which of the current pieces geometrically contains this hole. Usually a
// plain point-in-polygon test on the hole's own first vertex; falls back
// to "piece with the nearest vertex" for a hole thin/degenerate enough
// (e.g. a hairline crack in the artwork) to fail strict containment
// against every piece -- confirmed on a real shape where a ~1-unit-tall
// sliver hole tested as outside its own outer polygon by every variant of
// point-in-polygon tried (ray-casting both axes, winding number) despite
// visibly belonging there.
function _findPieceContaining(pieces, hole) {
    for (var i = 0; i < pieces.length; i++) {
        if (_pointInPolygon(hole[0], pieces[i])) return i;
    }
    var best = -1, bestD = Infinity;
    for (var i = 0; i < pieces.length; i++) {
        for (var v = 0; v < pieces[i].length; v++) {
            var dx = pieces[i][v].x - hole[0].x, dy = pieces[i][v].y - hole[0].y;
            var d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
        }
    }
    return best;
}

// Splits ONE piece around ONE hole into two simple polygons via two
// cuts. Returns { pieceA, pieceB } or null if no valid split was found.
//
// A "cut1 doesn't cross anything, cut2 doesn't cross anything, cut1
// doesn't cross cut2" candidate pair is NECESSARY but not SUFFICIENT: if
// the hole-side endpoints end up paired with the "wrong" piece-side
// endpoints (Pa should connect to whichever hole point makes the walk
// non-crossing, not just whichever is nearest), neither cut crosses the
// other yet the ASSEMBLED piece still self-intersects (confirmed on a
// real single-hole shape). Verify the actual constructed pieces, not
// just the two candidate segments in isolation, and keep trying
// candidate pairs until both halves come out simple.
function _splitPieceByHole(piece, hole) {
    var m = piece.length, k = hole.length;
    var outerSign = _signedAreaSum(piece) > 0 ? 1 : -1;
    var holeSign = _signedAreaSum(hole) > 0 ? 1 : -1;
    var h = hole.slice();
    if (holeSign === outerSign) h.reverse();

    var candidates = [];
    var maxCand = 250;
    function addCandidate(pi, hi, d) {
        if (candidates.length < maxCand) {
            candidates.push({ pi: pi, hi: hi, d: d });
        } else {
            var worst = 0;
            for (var c = 1; c < candidates.length; c++) if (candidates[c].d > candidates[worst].d) worst = c;
            if (d < candidates[worst].d) candidates[worst] = { pi: pi, hi: hi, d: d };
        }
    }
    // A fixed "1 sample per ~60 vertices" step (the original version of
    // this line) is catastrophically coarse for a SMALL hole against a
    // LARGE piece: confirmed on a real 13-vertex hole against a
    // 1967-vertex piece, where only every 32nd piece vertex ever got
    // sampled -- the algorithm never even SAW the true nearest piece
    // point, picked a much farther one from the sparse sample instead,
    // and produced a valid-but-wrong split (204 piece vertices pulled
    // into a small hole's piece, overlapping a sibling piece with neither
    // half technically self-intersecting on its own). Match
    // _bridgeHoles's own candidate-density formula instead: full density
    // (step 1) unless work*hole exceeds 20000 comparisons, in which case
    // step scales with sqrt(ratio) -- keeps candidates dense whenever the
    // problem size allows it, at all.
    var totalLoops = m * k;
    var stepP = 1, stepH = 1;
    if (totalLoops > 20000) {
        var ratio = Math.sqrt(totalLoops / 20000);
        stepP = Math.ceil(ratio);
        stepH = Math.ceil(ratio);
    }
    for (var pi = 0; pi < m; pi += stepP) {
        for (var hi = 0; hi < k; hi += stepH) {
            var dx = piece[pi].x - h[hi].x, dy = piece[pi].y - h[hi].y;
            addCandidate(pi, hi, dx * dx + dy * dy);
        }
    }
    candidates.sort(function (a, b) { return a.d - b.d; });

    function segOk(A, B) {
        for (var i = 0; i < m; i++) {
            var ni = (i + 1) % m;
            if (_segCross(A, B, piece[i], piece[ni])) return false;
        }
        for (var i = 0; i < k; i++) {
            var ni = (i + 1) % k;
            if (_segCross(A, B, h[i], h[ni])) return false;
        }
        return true;
    }

    function walk(arr, from, to) {
        var out = [];
        var n = arr.length;
        var i = from;
        while (true) {
            out.push(arr[i]);
            if (i === to) break;
            i = (i + 1) % n;
        }
        return out;
    }

    var minSep = Math.max(1, Math.floor(k / 4));
    var validA = [];
    for (var c = 0; c < candidates.length; c++) {
        if (segOk(piece[candidates[c].pi], h[candidates[c].hi])) validA.push(candidates[c]);
        if (validA.length >= 12) break;
    }

    // Full self-intersection is O(n) here (grid-accelerated, see
    // _hasSelfIntersection) but still real work per attempt -- capped,
    // same rationale as _bridgeHoles's own candidate cap.
    var fullChecks = 0, maxFullChecks = 60;
    for (var ai = 0; ai < validA.length; ai++) {
        var candA = validA[ai];
        var triedB = 0;
        for (var c = 0; c < candidates.length && triedB < 12; c++) {
            var candB = candidates[c];
            var sep = Math.abs(candB.hi - candA.hi);
            sep = Math.min(sep, k - sep);
            if (sep < minSep) continue;
            if (candB.pi === candA.pi) continue;
            if (!segOk(piece[candB.pi], h[candB.hi])) continue;
            if (_segCross(piece[candA.pi], h[candA.hi], piece[candB.pi], h[candB.hi])) continue;
            triedB++;

            var Pa = candA.pi, Ha = candA.hi, Pb = candB.pi, Hb = candB.hi;
            var piece1 = walk(piece, Pa, Pb).concat(walk(h, Hb, Ha));
            var piece2 = walk(piece, Pb, Pa).concat(walk(h, Ha, Hb));
            fullChecks++;
            if (_hasSelfIntersection(piece1) || _hasSelfIntersection(piece2)) {
                if (fullChecks >= maxFullChecks) return null;
                continue;
            }

            return { pieceA: piece1, pieceB: piece2 };
        }
    }
    return null;
}

// A hole's own contour, as extracted from Flash, can already contain an
// exact (or near-exact) duplicate of one of its own vertices, or happen to
// touch the outer contour at a point other than wherever its bridge was
// connected -- independent of which candidate _bridgeHoles picked (see the
// candidates[c].d < 1.0 skip above, which only guards the CONNECTION point
// itself). Confirmed on a real 13-hole shape: skipping degenerate
// connection candidates alone left several such pairs behind. Either case
// leaves two NON-ADJACENT indices at the exact same position -- a
// zero-width pinch that Godot's own Polygon2D triangulator can silently
// fail on (no error, nothing drawn) even though it isn't a true
// self-intersection (_hasSelfIntersection's strict crossing-only test
// doesn't flag a touch). Nudge the later of each such pair a hair off its
// own local edge direction to break the exact coincidence -- but a naive
// nudge can just as easily push that point INTO a genuine crossing with a
// nearby edge on a dense contour (found on this exact real shape: the
// first, non-verifying version of this function introduced a real
// self-intersection where there had only been a touch before). Verify
// every attempted nudge against the whole array and only keep it if it
// doesn't create one; leave the pair untouched (accepting the lesser-risk
// touch) if none of the tried offsets work.
function _nudgeCoincidentVertices(verts) {
    var n = verts.length;
    if (n < 4) return verts;
    var threshold = 0.05; // linear distance; tight enough to only catch genuine coincidences, not legitimately dense/close artwork
    var cellSize = threshold * 8;
    var grid = {};
    function cellKey(x, y) { return Math.floor(x / cellSize) + "_" + Math.floor(y / cellSize); }
    for (var i = 0; i < n; i++) {
        var k = cellKey(verts[i].x, verts[i].y);
        if (!grid[k]) grid[k] = [];
        grid[k].push(i);
    }
    var pairs = [];
    for (var i = 0; i < n; i++) {
        var cx = Math.floor(verts[i].x / cellSize), cy = Math.floor(verts[i].y / cellSize);
        for (var dxp = -1; dxp <= 1; dxp++) {
            for (var dyp = -1; dyp <= 1; dyp++) {
                var arr = grid[(cx + dxp) + "_" + (cy + dyp)];
                if (!arr) continue;
                for (var a = 0; a < arr.length; a++) {
                    var j = arr[a];
                    if (j <= i) continue;
                    var dIdx = Math.min(Math.abs(j - i), n - Math.abs(j - i));
                    if (dIdx <= 1) continue;
                    var ddx = verts[i].x - verts[j].x, ddy = verts[i].y - verts[j].y;
                    if (ddx * ddx + ddy * ddy >= threshold * threshold) continue;
                    pairs.push(j);
                }
            }
        }
    }

    for (var p = 0; p < pairs.length; p++) {
        var j = pairs[p];
        var prev = verts[(j - 1 + n) % n], next = verts[(j + 1) % n];
        var ex = next.x - prev.x, ey = next.y - prev.y;
        var elen = Math.sqrt(ex * ex + ey * ey);
        if (elen > 0.0001) { ex /= elen; ey /= elen; } else { ex = 1; ey = 0; }
        var original = verts[j];
        // Perpendicular-to-local-tangent offsets are the least likely to
        // cross a neighboring edge on a dense contour, so tried first; a
        // fuller ring of directions (8 angles x 3 radii) is tried after in
        // case the local geometry near this particular point rules those
        // out too -- confirmed necessary on this real shape (a few pairs
        // needed the wider search).
        var candidates = [
            { x: original.x - ey * 0.5, y: original.y + ex * 0.5 },
            { x: original.x + ey * 0.5, y: original.y - ex * 0.5 },
            { x: original.x - ey * 1.5, y: original.y + ex * 1.5 },
            { x: original.x + ey * 1.5, y: original.y - ex * 1.5 }
        ];
        var radii = [0.5, 1.5, 3.0];
        for (var ri = 0; ri < radii.length; ri++) {
            for (var ang = 0; ang < 8; ang++) {
                var theta = (ang / 8) * Math.PI * 2;
                candidates.push({
                    x: original.x + Math.cos(theta) * radii[ri],
                    y: original.y + Math.sin(theta) * radii[ri]
                });
            }
        }
        for (var c = 0; c < candidates.length; c++) {
            verts[j] = { x: candidates[c].x, y: candidates[c].y, br: original.br };
            if (!_hasSelfIntersection(verts)) break;
            verts[j] = original;
        }
    }
    return verts;
}


/**
 * Detects and tries to fix a STRICT self-intersection (transverse crossing)
 * in a polygon via a search for a secant segment.
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
                    // BUG: this used to require ua/ub in (0.01, 0.99),
                    // excluding any crossing within 1% of either segment's
                    // endpoint from being "fixable" -- but _hasSelfIntersection
                    // (both the initial check above and the post-repair
                    // verification in _cleanupPolygonVertices) uses a
                    // STRICT, zero-tolerance crossing test (_segCross:
                    // d1*d2<0 && d3*d4<0, no threshold at all). A near-
                    // endpoint crossing landed in the gap between these two
                    // thresholds: flagged as a real problem, but never
                    // eligible for this repair -- Godot's earcut then fails
                    // to triangulate it (invisible/malformed Polygon2D).
                    // Narrowed to match _hasSelfIntersection's strictness
                    // (still excluding the true endpoints themselves, where
                    // the crossing IS the shared vertex -- not a real
                    // problem, and "fixing" it would be meaningless).
                    if (ua > 0.0001 && ua < 0.9999 && ub > 0.0001 && ub < 0.9999) {
                        // Instead of removing part of the shape (which causes holes),
                        // "un-twist" it by reversing the vertex order within the loop.
                        // This turns a crossed figure-8 into a simple polygon by
                        // unifying the winding direction, with NO point loss at all!
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
 * Detects a STRICT self-intersection (transverse crossing) in a closed
 * polygon. Used as a safety net after _bridgeHoles: if true, the bridged
 * result isn't used (pathological multi-hole case) to avoid an invisible
 * polygon in Godot (earcut fails on self-intersections).
 *
 * Spatial optimization: a uniform grid indexed on the bbox. For each edge
 * we only test the edges of the cells it crosses. Drastically reduces the
 * cost on polygons with lots of holes (~1000-2000 vertices).
 */
function _hasSelfIntersection(verts) {
    var n = verts.length;
    if (n < 4) return false;

    // _ccw / _segCross: see the module-scope definitions above _bridgeHoles
    // (same pure functions, no more duplicated copy here).

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
 * T-junction repair between adjacent polygons of the same shape.
 *
 * Problem: inspector.jsfl subdivides BÃ©zier curves independently for each
 * contour (fill). Two adjacent fills share the same curve as their
 * boundary, but Casteljau subdivision can produce slightly different
 * intermediate points on each side (~0.2 Flash unit). Result: a vertex V
 * of polygon A ends up ~0.2u from edge PQ of polygon B, creating a
 * visible triangular gap between the two Polygon2D in Godot.
 *
 * Fix: for each vertex V of a polygon A, if V is close to an edge PQ of
 * another polygon B (distance < tolerance), insert V into B between P and
 * Q. After the repair, the two polygons share the exact same vertices
 * along their common boundary â†’ no more gap.
 *
 * Complexity: O(V Ã— E Ã— P) where V = total vertices, E = edges per poly,
 * P = number of polys. For a typical shape (5-10 polys, 20-50 vertices),
 * that's ~50K iterations â€” instant.
 */


// Cleans up a contour of raw Flash vertices before Godot triangulation:
// - merges consecutive near-identical points (distanceÂ² < 1e-6),
// - eliminates degenerate back-and-forths (two consecutive segments that
//   nearly reverse direction, dot product < -0.99, typical of a BÃ©zier
//   subdivision tip folding back on itself),
// - removes the last point if it coincides with the first (contour
//   already explicitly closed),
// - repairs residual self-intersections (only on reasonably-sized
//   contours, â‰¤ 500 vertices: `_hasSelfIntersection` is O(VÂ²), useless/
//   costly beyond that).
// Pure function: depends only on its input, touches no state of
// _processElementNode.
function _cleanupPolygonVertices(effectiveVerts) {
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
        var repaired = _removeSelfIntersections(finalVerts);
        // _removeSelfIntersections never verifies its OWN result: its
        // "un-twist by reversing" loop is bounded to 10 internal
        // iterations, which isn't always enough on a complex multi-crossing
        // contour (e.g. one edge crossing two others near a cusp) -- it can
        // return with a residual crossing still in place (invisible
        // Polygon2D in Godot: earcut fails on self-intersections). Give it
        // a few more full passes; each call is a fresh attempt from where
        // the last one left off, and a run that makes no further progress
        // returns its input UNCHANGED (safe to detect via reference
        // equality) so this loop can't spin uselessly.
        var repairAttempts = 0;
        while (repairAttempts < 4 && _hasSelfIntersection(repaired)) {
            var next = _removeSelfIntersections(repaired);
            repairAttempts++;
            if (next === repaired) break;
            repaired = next;
        }
        finalVerts = repaired;
    }

    return finalVerts;
}

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

function _isFullyVectorizable(elements) {
    // Recursively checks that all "shape" elements (through nested groups)
    // have a complete vector representation (polygons or strokes). A
    // single member without a valid fill means at least one shape in this
    // group has no vector data at all (e.g. an unsupported effect) -> the
    // group must not be decomposed, or that content's positioning/bounds
    // context is lost when it ends up as its own disconnected element.
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
                // At least one member has no vector data -> keep the group
                // as a SINGLE opaque "shape" element (no polygons) instead
                // of decomposing it, so that non-vectorizable content isn't
                // separated from the rest of the group it belongs with.
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
        
        // Only instances benefit from distance-based matching.
        // Geometric shapes must keep their strict Z order, otherwise
        // crossing shape tweens will swap their nodes.
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
// Inserts the child at the desired stacking order (increasing rank = more
// "in front"/drawn last), without ever writing a z_index property: Godot's
// render order comes solely from position within children[].
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
// Compares keyframe values (number, Vector2-like, ExtResource-like).
// Pure function, hoisted to module scope: addTrackKey is called tens of
// thousands of times on a complex project, recreating this closure on
// every call was pure, repeated wasted allocation.
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
        
        if (tr.type === "method") {
            isStatic = false; // Never optimize method tracks
        } else if (propName.indexOf(":") !== -1 || propName.indexOf("/") !== -1) {
            isStatic = false; // Don't optimize sub-properties
        } else if (tr.keys.times[0] > 0.0005 && (propName === "points" || propName === "polygon" || propName === "polygons" || propName === "uv")) {
            // Only geometry arrays that appear late MUST stay dynamic.
            // Before their creation, Godot uses their .tscn state (empty). If we made
            // them static, we'd write their final shape into the .tscn, making them
            // visible prematurely! All OTHER properties (position, color...) can
            // however be optimized to regain FPS.
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
            
            // For animated tracks, apply the value at t=0 in the .tscn so
            // the scene looks right in the editor before playback.
            //
            // Exception: geometry arrays (polygon, points, uv) that DON'T
            // APPEAR at t=0 (times[0] > 0.0005) must stay out of the .tscn.
            // Before their creation frame, Godot uses the .tscn state
            // (empty); writing their final value there would make them
            // visible prematurely.
            //
            // HOWEVER, if the first geometry keyframe IS at t=0
            // (times[0] <= 0.0005), writing the value into the .tscn is
            // perfectly safe: it's exactly what the AnimationPlayer will
            // show from the start. Without this write, the Polygon2D stay
            // with an empty polygon in the .tscn â†’ they're transparent
            // when the scene is instanced in a parent scene before the
            // AnimationPlayer has played yet (e.g. opening it in the
            // editor).
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
            // Static track: erase it from the animation, BUT apply its value in the .tscn
            if (root && colonIdx !== -1) {
                var nodePath = tr.path.substring(0, colonIdx);
                var targetNode = root.getNodeOrNull(nodePath);
                if (targetNode) {
                    if (typeof firstVal === "boolean")          targetNode.properties[propName] = firstVal;
                    else if (typeof firstVal === "number") {
                        if (propName === "process_mode")   targetNode.properties[propName] = firstVal; // No decimals for enums!
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


// Builds the set of node paths (relative to root, "." for root itself)
// directly targeted by at least one AnimationPlayer value track -- method
// tracks (frame scripts, path === ".") are ignored since they imply no
// visual change to the targeted node. Used by `_flattenSingleChildGroups`
// (v4.10) and `_markBakeableShapes` (v4.9) as the same base criterion
// ("is this exact node animated?"), before each makes different use of it
// (propagation to the whole subtree for one, to the ancestor chain for
// the other).
function _buildAnimatedPathsSet(anim) {
    var animatedPaths = {};
    if (anim && anim.tracks) {
        for (var i = 0; i < anim.tracks.length; i++) {
            var tr = anim.tracks[i];
            if (tr.type === "method") continue;
            var colonIdx = tr.path.indexOf(":");
            var nodePath = (colonIdx !== -1) ? tr.path.substring(0, colonIdx) : tr.path;
            animatedPaths[nodePath] = true;
        }
    }
    return animatedPaths;
}

// Removes "empty" Node2D wrappers: a purely organizational container
// (folder/layer/mask) that has ONLY ONE child, no transform of its own
// (position/rotation/scale/skew), no "visible"/"material"/"groups"
// property, and whose ENTIRE SUBTREE is guaranteed non-animated (no
// AnimationPlayer track references it or any of its descendants). This
// last guarantee is essential: the Animation sub_resources (RESET/labels)
// are already serialized as text BEFORE this pass runs (NodePath("...")
// already hardcoded), so removing a node with an animated descendant
// would break those paths. By restricting to 100%-static subtrees, no
// existing NodePath can ever reference a node removed here. The single
// child moves up as-is (no transform recalculation needed, since the
// removed wrapper is guaranteed to be identity). Chains of nested empty
// wrappers are collapsed in a single pass (e.g. folder > layer > shape,
// if both wrappers are eligible).
function _flattenSingleChildGroups(root, anim) {
    var animatedPaths = _buildAnimatedPathsSet(anim);

    function markSubtreeAnimated(node) {
        var path = (node === root) ? "." : root.getPathTo(node);
        var subtreeAnimated = !!animatedPaths[path];
        for (var i = 0; i < node.children.length; i++) {
            if (markSubtreeAnimated(node.children[i])) subtreeAnimated = true;
        }
        node._subtreeAnimated = subtreeAnimated;
        return subtreeAnimated;
    }
    markSubtreeAnimated(root);

    var TRANSFORM_PROPS = ["position", "rotation", "scale", "skew"];
    function hasOwnTransform(n) {
        for (var i = 0; i < TRANSFORM_PROPS.length; i++) {
            if (n.properties[TRANSFORM_PROPS[i]] !== undefined) return true;
        }
        return false;
    }

    function isEmptyWrapper(n) {
        return n.type === "Node2D"
            && n !== root
            && n.children.length === 1
            && !n._subtreeAnimated
            && !hasOwnTransform(n)
            && n.properties["visible"] === undefined
            && n.properties["material"] === undefined
            && n.properties["groups"] === undefined;
    }

    function processContainer(node) {
        for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            while (isEmptyWrapper(child)) {
                var grandchild = child.children[0];
                child.removeChild(grandchild);
                node.removeChild(child);
                node.children.splice(i, 0, grandchild);
                grandchild.parent = node;
                node._childByName["$" + grandchild.name] = grandchild;
                child = grandchild;
            }
        }
        for (var k = 0; k < node.children.length; k++) {
            processContainer(node.children[k]);
        }
    }
    processContainer(root);
}

// For shapes tinted by Flash's "Advanced Color Effect" shader
// (color_mult/color_offset_255, see has_shader in _processElementNode):
// if the tint NEVER changes across this node's whole timeline (no real
// AnimationPlayer track, cf. optimizeTracks which ALWAYS excludes
// "material:shader_parameter/..." sub-properties from optimization), the
// shader's formula can be applied directly to the source gradient's
// colors at generation time, giving the node an already-tinted texture
// instead of the shader. The node then no longer needs a material at
// all, and becomes eligible for runtime baking (_markBakeableShapes).
// EXACT formula taken from flash_color_normal.gdshader:
//   COLOR = clamp(tex * color_mult + color_offset_255/255, 0, 1)
// Deliberate limitation: only the "normal" blend mode (flash_color_
// normal.gdshader, render_mode blend_mix). "add"/"multiply" depend on the
// content already present in the framebuffer at draw time (real-time GPU
// blending): impossible to reproduce by pre-tinting a texture, so those
// shapes keep their material and stay out of baking.
function _bakeStaticShaderTints(root, anim, subResources) {
    function findSubResource(id) {
        for (var i = 0; i < subResources.length; i++) {
            if (subResources[i].indexOf('id="' + id + '"') !== -1) return subResources[i];
        }
        return null;
    }
    function parseVec4(str) {
        if (!str) return null;
        var m = String(str).match(/Vector4\(([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/);
        if (!m) return null;
        return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
    }
    function parseColorArray(str) {
        if (!str) return null;
        var m = str.match(/PackedColorArray\(([^)]*)\)/);
        if (!m) return null;
        if (m[1].length === 0) return [];
        var nums = m[1].split(",").map(function(s) { return parseFloat(s); });
        var cols = [];
        for (var i = 0; i + 3 < nums.length; i += 4) cols.push([nums[i], nums[i + 1], nums[i + 2], nums[i + 3]]);
        return cols;
    }
    function findLine(block, prefix) {
        var lines = block.split("\n");
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf(prefix) === 0) return lines[i].substring(prefix.length);
        }
        return null;
    }
    function trackInfo(nodePath, propSuffix) {
        var fullPath = nodePath + ":" + propSuffix;
        for (var i = 0; i < anim.tracks.length; i++) {
            var tr = anim.tracks[i];
            if (tr.path !== fullPath) continue;
            var vals = tr.keys.values;
            var isStatic = true;
            for (var k = 1; k < vals.length; k++) {
                if (!_eq(vals[0], vals[k])) { isStatic = false; break; }
            }
            return { exists: true, isStatic: isStatic, value: vals[0], trackIndex: i };
        }
        return { exists: false };
    }

    var tracksToRemove = [];

    function walk(node) {
        for (var i = 0; i < node.children.length; i++) walk(node.children[i]);

        if (node.type !== "Polygon2D" || !node.properties["material"]) return;
        var matMatch = String(node.properties["material"]).match(/SubResource\("([^"]+)"\)/);
        if (!matMatch) return;
        var matBlock = findSubResource(matMatch[1]);
        if (!matBlock || matBlock.indexOf("flash_color_normal.gdshader") === -1) return;

        var nodePath = (node === root) ? "." : root.getPathTo(node);
        var offInfo = trackInfo(nodePath, "material:shader_parameter/color_offset_255");
        var mulInfo = trackInfo(nodePath, "material:shader_parameter/color_mult");
        if (!offInfo.exists || !mulInfo.exists) return;
        if (!offInfo.isStatic || !mulInfo.isStatic) return; // real animation: keep the shader

        var off = parseVec4(offInfo.value);
        var mul = parseVec4(mulInfo.value);
        if (!off || !mul) return;

        var texMatch = String(node.properties["texture"] || "").match(/SubResource\("([^"]+)"\)/);
        if (!texMatch) return;
        var texBlock = findSubResource(texMatch[1]);
        if (!texBlock) return;
        var gradMatch = (findLine(texBlock, "gradient = SubResource(\"") || "").match(/^([^"]+)/);
        if (!gradMatch) return;
        var gradBlock = findSubResource(gradMatch[1]);
        if (!gradBlock) return;
        var colorsLine = findLine(gradBlock, "colors = ");
        var offsetsLine = findLine(gradBlock, "offsets = ");
        var colors = parseColorArray(colorsLine);
        if (!colors || colors.length === 0) return;

        var tintedColors = colors.map(function(c) {
            return [
                Math.min(1, Math.max(0, c[0] * mul[0] + off[0] / 255.0)),
                Math.min(1, Math.max(0, c[1] * mul[1] + off[1] / 255.0)),
                Math.min(1, Math.max(0, c[2] * mul[2] + off[2] / 255.0)),
                Math.min(1, Math.max(0, c[3] * mul[3] + off[3] / 255.0))
            ];
        });

        var texTypeMatch = texBlock.match(/type="([^"]+)"/);
        var texType = texTypeMatch ? texTypeMatch[1] : "GradientTexture1D";

        var newGradId = "Gradient_" + nextId();
        var colorsStr = "PackedColorArray(" + tintedColors.map(function(c) {
            return _f(c[0]) + ", " + _f(c[1]) + ", " + _f(c[2]) + ", " + _f(c[3]);
        }).join(", ") + ")";
        var newGradStr = '[sub_resource type="Gradient" id="' + newGradId + '"]\n'
            + (offsetsLine ? ('offsets = ' + offsetsLine + '\n') : '')
            + 'colors = ' + colorsStr;
        subResources.push(newGradStr);

        var newTexId = "Texture_" + nextId();
        var newTexStr = '[sub_resource type="' + texType + '" id="' + newTexId + '"]\n'
            + 'gradient = SubResource("' + newGradId + '")\n'
            + (texType === "GradientTexture2D"
                ? 'fill = 1\nfill_from = Vector2(0.5, 0.5)\nfill_to = Vector2(1, 0.5)\n'
                : 'width = 1\n');
        subResources.push(newTexStr);

        node.properties["texture"] = 'SubResource("' + newTexId + '")';
        delete node.properties["material"];
        delete node.properties["use_parent_material"];

        tracksToRemove.push(offInfo.trackIndex, mulInfo.trackIndex);
    }
    walk(root);

    if (tracksToRemove.length > 0) {
        tracksToRemove.sort(function(a, b) { return b - a; });
        for (var i = 0; i < tracksToRemove.length; i++) {
            anim.tracks.splice(tracksToRemove[i], 1);
        }
    }
}

// Internally marks (node._mergeSafe, never serialized into the .tscn)
// every Polygon2D/Line2D that isn't targeted by ANY AnimationPlayer track
// (neither itself nor any of its ancestors in the same scene). Used
// solely as a safety criterion by `_mergeSameColorSiblings` (v4.9) to know
// which nodes can be merged without ever breaking an animation. Must be
// called AFTER anim.optimizeTracks(root), so anim.tracks only contains
// truly dynamic properties (the "static" single-value tracks have already
// been inlined into node.properties by optimizeTracks and removed from
// the list).
// Method tracks (frame script calls, path === ".") are ignored: they
// imply no visual change to the targeted node.
function _markBakeableShapes(root, anim) {
    var animatedPaths = _buildAnimatedPathsSet(anim);

    var markedAny = false;
    function walk(node, isAnimated, materialAncestor) {
        var path = (node === root) ? "." : root.getPathTo(node);
        var nodeAnimated = isAnimated || !!animatedPaths[path];
        // A merged Polygon2D/Line2D (v4.9) must keep EXACTLY the rendering
        // of its original nodes: a node with its own "material" (tint/
        // color transform shader, see has_shader above) OR that explicitly
        // opts out of inheriting the parent material
        // (use_parent_material=false, e.g. outline Line2D, deliberately
        // isolated from the fills' shader) can therefore never be merged
        // without losing/breaking its rendering. Same for any descendant
        // of an ancestor that itself has a real material.
        var hasOwnMaterial = !!node.properties["material"];
        var optsOut = (node.properties["use_parent_material"] === false
                    || node.properties["use_parent_material"] === "false");
        var unsafeForMerge = materialAncestor || hasOwnMaterial || optsOut;
        if (!nodeAnimated && !unsafeForMerge && node !== root && (node.type === "Polygon2D" || node.type === "Line2D")) {
            node._mergeSafe = true;
            markedAny = true;
        }
        var childMaterialAncestor = materialAncestor || hasOwnMaterial;
        for (var i = 0; i < node.children.length; i++) {
            walk(node.children[i], nodeAnimated, childMaterialAncestor);
        }
    }
    walk(root, false, false);
    return markedAny;
}

// Merges, between SIBLING nodes (same direct parent) and CONSECUTIVE in
// render order, the static Polygon2D (marked _mergeSafe by
// _markBakeableShapes) that share EXACTLY the same texture (= same
// SubResource, so the same color/gradient: gradCache already deduplicates
// identical solid colors to the same GradientTexture1D). Complementary to
// the already-existing intra-shape merge (polyGroups/sig, v4.6), which
// only merges the contours of A SINGLE Flash element; this one merges
// across different Flash elements (e.g. two instances of the same leaf on
// the same layer), reducing node count as early as the .tscn.
// Never touches the UV: each vertex keeps its original UV, correctly
// computed at initial generation time (regardless of the node's final
// position, including for a real gradient whose matrix differs per shape
// â€” only the "polygon" points need to be brought back into the parent's
// local space via the merged node's own transform).
// ONLY merges nodes already marked _mergeSafe (so guaranteed not targeted
// by any AnimationPlayer track) and without their own material, so as to
// never break an animation or a node-specific shader.
// Shared by _mergeSameColorSiblings and _mergeSameColorAcrossTree: parsing
// of already-serialized .tscn property strings back into plain numbers/
// points, and the eligibility test for a Polygon2D to be merge-safe at all.
function _parsePackedVec2(str) {
    if (!str) return [];
    var m = str.match(/PackedVector2Array\(([^)]*)\)/);
    if (!m || m[1].length === 0) return [];
    var nums = m[1].split(",");
    var pts = [];
    for (var i = 0; i + 1 < nums.length; i += 2) {
        pts.push({ x: parseFloat(nums[i]), y: parseFloat(nums[i + 1]) });
    }
    return pts;
}
function _parsePolygonsIndexGroups(str) {
    if (!str) return null;
    var groups = [];
    var re = /PackedInt32Array\(([^)]*)\)/g;
    var m;
    while ((m = re.exec(str)) !== null) {
        var idxStr = m[1];
        var idxs = [];
        if (idxStr.length > 0) {
            var parts = idxStr.split(",");
            for (var i = 0; i < parts.length; i++) idxs.push(parseInt(parts[i], 10));
        }
        groups.push(idxs);
    }
    return groups;
}
function _num(str, def) {
    if (str === undefined) return def;
    var v = parseFloat(str);
    return isNaN(v) ? def : v;
}
function _parseVec2Prop(str, defX, defY) {
    if (!str) return { x: defX, y: defY };
    var m = str.match(/Vector2\(([^,]+),\s*([^)]+)\)/);
    if (!m) return { x: defX, y: defY };
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}
function _isMergeCandidate(n) {
    return n.type === "Polygon2D"
        && n._mergeSafe === true
        && !!n.properties["texture"]
        && !!n.properties["polygon"]
        && n.properties["visible"] !== false
        && !n.properties["material"]
        // A Polygon2D "wrapper" (v4.7) can itself host Poly_1/Line_0
        // children (other color groups of the same shape): never
        // merge it, that would destroy those children without
        // transferring them.
        && n.children.length === 0;
}

// 2D affine helpers (a,b,c,d,tx,ty), consistent with the position/rotation/
// scale/skew -> matrix reconstruction already used above (and with
// _composeMatrix's M2*M1 = "M1 applied first, then M2" convention).
function _affineFromNode(node) {
    var pos = _parseVec2Prop(node.properties["position"], 0, 0);
    var scale = _parseVec2Prop(node.properties["scale"], 1, 1);
    var rot = _num(node.properties["rotation"], 0);
    var skew = _num(node.properties["skew"], 0);
    var cosR = Math.cos(rot), sinR = Math.sin(rot);
    var cosRS = Math.cos(rot + skew), sinRS = Math.sin(rot + skew);
    return {
        a: cosR * scale.x, b: sinR * scale.x,
        c: -sinRS * scale.y, d: cosRS * scale.y,
        tx: pos.x, ty: pos.y
    };
}
function _affineApplyPoint(M, x, y) {
    return { x: M.a * x + M.c * y + M.tx, y: M.b * x + M.d * y + M.ty };
}
function _affineInvert(M) {
    var det = M.a * M.d - M.b * M.c;
    if (Math.abs(det) < 1e-9) return null; // degenerate (zero scale) -- caller must skip
    var ia = M.d / det, ib = -M.b / det, ic = -M.c / det, id = M.a / det;
    return {
        a: ia, b: ib, c: ic, d: id,
        tx: -(ia * M.tx + ic * M.ty),
        ty: -(ib * M.tx + id * M.ty)
    };
}

function _mergeSameColorSiblings(root) {
    function mergeRun(parent, startIdx, endIdxExclusive) {
        var kids = parent.children.slice(startIdx, endIdxExclusive);
        var pointsParts = [];
        var uvParts = [];
        var polygonsParts = [];
        var vertexOffset = 0;

        for (var k = 0; k < kids.length; k++) {
            var kid = kids[k];
            var M = _affineFromNode(kid);

            var localPts = _parsePackedVec2(kid.properties["polygon"]);
            var localUv = _parsePackedVec2(kid.properties["uv"]);
            var idxGroups = _parsePolygonsIndexGroups(kid.properties["polygons"]);
            if (!idxGroups || idxGroups.length === 0) {
                var allIdx = [];
                for (var vi = 0; vi < localPts.length; vi++) allIdx.push(vi);
                idxGroups = [allIdx];
            }

            for (var vi = 0; vi < localPts.length; vi++) {
                var wp = _affineApplyPoint(M, localPts[vi].x, localPts[vi].y);
                pointsParts.push(_f(wp.x) + ", " + _f(wp.y));
                var uv = localUv[vi] || { x: 0, y: 0 };
                uvParts.push(_f(uv.x) + ", " + _f(uv.y));
            }
            for (var g = 0; g < idxGroups.length; g++) {
                var shifted = [];
                for (var ii = 0; ii < idxGroups[g].length; ii++) shifted.push(idxGroups[g][ii] + vertexOffset);
                polygonsParts.push("PackedInt32Array(" + shifted.join(", ") + ")");
            }
            vertexOffset += localPts.length;
        }

        var merged = new GNode(kids[0].name, "Polygon2D");
        merged.properties["polygon"] = "PackedVector2Array(" + pointsParts.join(", ") + ")";
        merged.properties["uv"] = "PackedVector2Array(" + uvParts.join(", ") + ")";
        if (polygonsParts.length > 1) merged.properties["polygons"] = "[" + polygonsParts.join(", ") + "]";
        merged.properties["texture"] = kids[0].properties["texture"];
        merged.properties["color"] = kids[0].properties["color"] || "Color(1, 1, 1, 1)";
        merged.properties["visible"] = true;

        var ownerRef = kids[0].owner;
        for (var k = kids.length - 1; k >= 0; k--) parent.removeChild(kids[k]);
        parent.children.splice(startIdx, 0, merged);
        merged.parent = parent;
        parent._childByName["$" + merged.name] = merged;
        merged.owner = ownerRef;
    }

    function processContainer(node) {
        var i = 0;
        while (i < node.children.length) {
            var child = node.children[i];
            if (_isMergeCandidate(child)) {
                var j = i + 1;
                while (j < node.children.length
                       && _isMergeCandidate(node.children[j])
                       && node.children[j].properties["texture"] === child.properties["texture"]) {
                    j++;
                }
                if (j - i > 1) {
                    mergeRun(node, i, j);
                    i++;
                    continue;
                }
            }
            i++;
        }
        for (var k = 0; k < node.children.length; k++) {
            processContainer(node.children[k]);
        }
    }

    processContainer(root);
}

// Generalizes _mergeSameColorSiblings across the WHOLE tree: candidates no
// longer need to be direct siblings, nor immediately consecutive under
// their parent. A run of same-texture _isMergeCandidate Polygon2D is
// merged as long as NOTHING else actually painted between them (in Godot's
// real paint order -- a preorder walk, since this pipeline never writes
// z_index) visually overlaps their combined bounding box: reordering two
// shapes that never touch anything drawn between them cannot change what
// ends up on top of what.
// Conservative by construction: a node whose bounds this function can't
// compute (Sprite2D, PackedScene, ColorRect...) is treated as an opaque,
// ALWAYS-blocking obstacle, and merging never crosses a CanvasGroup
// boundary (that changes compositing semantics for its whole subtree).
// Missing a possible merge is an acceptable cost; wrongly reordering
// visible content is not.
// Run AFTER _mergeSameColorSiblings (the strictly-safer same-parent pass)
// so it only has to pick up whatever that pass couldn't reach. Reuses its
// exact vertex/uv/texture composition, generalized to convert each
// candidate's LOCAL polygon into the destination parent's local space via
// full world-matrix composition + inversion instead of a single shared
// parent's space.
function _mergeSameColorAcrossTree(root) {
    var paintList = [];

    function localAABB(node) {
        if (node.type === "Polygon2D" && node.properties["polygon"]) {
            var pts = _parsePackedVec2(node.properties["polygon"]);
            if (pts.length === 0) return null;
            var minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
            for (var i = 1; i < pts.length; i++) {
                if (pts[i].x < minX) minX = pts[i].x;
                if (pts[i].x > maxX) maxX = pts[i].x;
                if (pts[i].y < minY) minY = pts[i].y;
                if (pts[i].y > maxY) maxY = pts[i].y;
            }
            return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
        }
        if (node.type === "Line2D" && node.properties["points"]) {
            var lp = _parsePackedVec2(node.properties["points"]);
            if (lp.length === 0) return null;
            var w = _num(node.properties["width"], 1) * 0.5 + 0.01;
            var minX2 = lp[0].x - w, maxX2 = lp[0].x + w, minY2 = lp[0].y - w, maxY2 = lp[0].y + w;
            for (var j = 1; j < lp.length; j++) {
                if (lp[j].x - w < minX2) minX2 = lp[j].x - w;
                if (lp[j].x + w > maxX2) maxX2 = lp[j].x + w;
                if (lp[j].y - w < minY2) minY2 = lp[j].y - w;
                if (lp[j].y + w > maxY2) maxY2 = lp[j].y + w;
            }
            return { minX: minX2, maxX: maxX2, minY: minY2, maxY: maxY2 };
        }
        return null; // unknown geometry -- caller treats as always-blocking
    }

    function worldAABB(local, M) {
        if (!local) return null;
        var c1 = _affineApplyPoint(M, local.minX, local.minY);
        var c2 = _affineApplyPoint(M, local.maxX, local.minY);
        var c3 = _affineApplyPoint(M, local.maxX, local.maxY);
        var c4 = _affineApplyPoint(M, local.minX, local.maxY);
        return {
            minX: Math.min(c1.x, c2.x, c3.x, c4.x), maxX: Math.max(c1.x, c2.x, c3.x, c4.x),
            minY: Math.min(c1.y, c2.y, c3.y, c4.y), maxY: Math.max(c1.y, c2.y, c3.y, c4.y)
        };
    }

    function walk(node, parentWorld, canvasGroupAncestor) {
        var worldM = _composeMatrix(parentWorld, _affineFromNode(node));
        var myCanvasGroupAncestor = (node.type === "CanvasGroup") ? node : canvasGroupAncestor;

        // Purely structural nodes draw nothing themselves and never affect
        // paint order -- skip entirely rather than recording them as an
        // (unknown-geometry, always-blocking) obstacle.
        var isStructural = (node === root) || node.type === "Node2D" || node.type === "CanvasGroup"
            || node.type === "AnimationPlayer" || node.type === "VisibleOnScreenEnabler2D";
        if (!isStructural) {
            paintList.push({
                node: node,
                parent: node.parent,
                worldMatrix: worldM,
                parentWorldMatrix: parentWorld,
                aabb: worldAABB(localAABB(node), worldM),
                canvasGroupAncestor: canvasGroupAncestor,
                texture: node.properties ? node.properties["texture"] : undefined,
                mergeable: _isMergeCandidate(node)
            });
        }
        for (var i = 0; i < node.children.length; i++) {
            walk(node.children[i], worldM, myCanvasGroupAncestor);
        }
    }
    walk(root, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, null);

    function aabbOverlap(a, b) {
        if (!a || !b) return true; // unknown bounds -> assume overlap (safe)
        var pad = 0.01;
        return !(a.maxX + pad < b.minX - pad || b.maxX + pad < a.minX - pad
               || a.maxY + pad < b.minY - pad || b.maxY + pad < a.minY - pad);
    }
    function aabbUnion(a, b) {
        return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
                 minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) };
    }
    function nodeInRun(run, n) {
        for (var q = 0; q < run.length; q++) if (paintList[run[q]].node === n) return true;
        return false;
    }

    function buildMergedRun(run) {
        var destEntry = paintList[run[0]];
        var destParent = destEntry.parent;
        var invDestParentWorld = _affineInvert(destEntry.parentWorldMatrix);
        if (!invDestParentWorld) return; // degenerate parent transform (extremely rare) -- skip, safe no-op

        var pointsParts = [];
        var uvParts = [];
        var polygonsParts = [];
        var vertexOffset = 0;

        for (var k = 0; k < run.length; k++) {
            var entry = paintList[run[k]];
            var kid = entry.node;
            var toDestLocal = _composeMatrix(invDestParentWorld, entry.worldMatrix);

            var localPts = _parsePackedVec2(kid.properties["polygon"]);
            var localUv = _parsePackedVec2(kid.properties["uv"]);
            var idxGroups = _parsePolygonsIndexGroups(kid.properties["polygons"]);
            if (!idxGroups || idxGroups.length === 0) {
                var allIdx = [];
                for (var vi = 0; vi < localPts.length; vi++) allIdx.push(vi);
                idxGroups = [allIdx];
            }
            for (var vi2 = 0; vi2 < localPts.length; vi2++) {
                var wp = _affineApplyPoint(toDestLocal, localPts[vi2].x, localPts[vi2].y);
                pointsParts.push(_f(wp.x) + ", " + _f(wp.y));
                var uv = localUv[vi2] || { x: 0, y: 0 };
                uvParts.push(_f(uv.x) + ", " + _f(uv.y));
            }
            for (var g = 0; g < idxGroups.length; g++) {
                var shifted = [];
                for (var ii = 0; ii < idxGroups[g].length; ii++) shifted.push(idxGroups[g][ii] + vertexOffset);
                polygonsParts.push("PackedInt32Array(" + shifted.join(", ") + ")");
            }
            vertexOffset += localPts.length;
        }

        var first = destEntry.node;
        var merged = new GNode(first.name, "Polygon2D");
        merged.properties["polygon"] = "PackedVector2Array(" + pointsParts.join(", ") + ")";
        merged.properties["uv"] = "PackedVector2Array(" + uvParts.join(", ") + ")";
        if (polygonsParts.length > 1) merged.properties["polygons"] = "[" + polygonsParts.join(", ") + "]";
        merged.properties["texture"] = first.properties["texture"];
        merged.properties["color"] = first.properties["color"] || "Color(1, 1, 1, 1)";
        merged.properties["visible"] = true;
        var ownerRef = first.owner;

        // Keep the merged node at run[0]'s relative position among
        // destParent's OTHER, untouched children: find the first sibling
        // after it that isn't itself part of this run.
        var siblingAfter = null;
        var idxInDest = destParent.children.indexOf(first);
        if (idxInDest !== -1) {
            for (var si = idxInDest + 1; si < destParent.children.length; si++) {
                if (!nodeInRun(run, destParent.children[si])) { siblingAfter = destParent.children[si]; break; }
            }
        }

        for (var k2 = 0; k2 < run.length; k2++) {
            var e2 = paintList[run[k2]];
            e2.parent.removeChild(e2.node);
        }

        var insertAt = siblingAfter ? destParent.children.indexOf(siblingAfter) : -1;
        if (insertAt === -1) insertAt = destParent.children.length;
        destParent.children.splice(insertAt, 0, merged);
        merged.parent = destParent;
        destParent._childByName["$" + merged.name] = merged;
        merged.owner = ownerRef;
    }

    // Group candidate paintList indices by texture (preserving paint
    // order); CanvasGroup-boundary and overlap checks happen inline below.
    var byTexture = {};
    var order = [];
    for (var idx = 0; idx < paintList.length; idx++) {
        var e = paintList[idx];
        if (!e.mergeable) continue;
        var key = "$" + e.texture;
        if (!byTexture[key]) { byTexture[key] = []; order.push(key); }
        byTexture[key].push(idx);
    }

    for (var oi = 0; oi < order.length; oi++) {
        var indices = byTexture[order[oi]];
        var i2 = 0;
        while (i2 < indices.length) {
            var run = [indices[i2]];
            var runBBox = paintList[indices[i2]].aabb;
            var j2 = i2 + 1;
            while (j2 < indices.length) {
                var candIdx = indices[j2];
                var cand = paintList[candIdx];
                var last = paintList[run[run.length - 1]];
                var blocked = (cand.canvasGroupAncestor !== last.canvasGroupAncestor)
                    || (runBBox === null) || (cand.aabb === null);
                if (!blocked) {
                    for (var p = run[run.length - 1] + 1; p < candIdx; p++) {
                        if (aabbOverlap(paintList[p].aabb, runBBox) || aabbOverlap(paintList[p].aabb, cand.aabb)) {
                            blocked = true; break;
                        }
                    }
                }
                if (blocked) break;
                run.push(candIdx);
                runBBox = aabbUnion(runBBox, cand.aabb);
                j2++;
            }
            if (run.length > 1) buildMergedRun(run);
            i2 = (j2 > i2 + 1) ? j2 : i2 + 1;
        }
    }
}

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
            // An element ends exactly when another element of the same variant starts.
            // 'true' must not be overwritten by 'false', or the element would become invisible!
        } else if (path.indexOf(":process_mode") !== -1 && tr.keys.values[exactMatchIdx] === 0 && value === 4) {
            // Same for process_mode: '0' (INHERIT) must not be overwritten by '4' (DISABLED)
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

function _postProcessMasks(root, sym, anim, exportDir, getExt, scaleFactor, extResources, extIdMap) {
    if (!sym.layers) return;

    function _findMaskSprite(layerNode) {
        for (var c = 0; c < layerNode.children.length; c++) {
            var wrapper = layerNode.children[c];
            if (wrapper.name === "AnimationPlayer") continue;
            // The wrapper IS directly the visual node (the normal case
            // since single-fill AND multi-fill shapes no longer have an
            // intermediate Node2D): no need to descend into its children.
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

    // Disambiguation of duplicate layer names, for REAL mask layers
    // (layerType === "mask"). Flash "guide" layers never publish visual
    // content and are never treated as masks: confirmed empirically that a
    // "guide" layer named "Time" can be a plain timing reference (read by
    // AS3), not a visual mask.
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
                    // clip_children masking needs a directly renderable
                    // shape (Sprite2D/Polygon2D), not a nested symbol
                    // instance -- nothing currently rewrites one into the
                    // other, so this mask layer is left unprocessed.
                    if (typeof fl !== "undefined") fl.trace("  -> [mask] skipping mask processing for " + sym.name + "/" + layer.name + " (mask is a symbol instance, not a shape)");
                    continue;
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

// When a track is first defined AFTER a slice's start, it's currently
// omitted from the slice (no lastVal, no keys in range). But Godot
// doesn't touch the property during playback -> the value inherited from
// a previous animation STAYS in place. For "shape data" (polygon, points,
// uv, width), this makes elements from previous animations visually
// persist (e.g. a "crying" mouth that stays displayed during "normal" on
// Layer_1/shape_0/shape, which is :visible=true but has no polygon
// tracks in "normal").
//
// Reproduces Flash's behavior: at frame 0 ("normal"), only the
// keyframe's own elements are drawn; absent polys/lines are empty.
//
// For transforms (position/rotation/scale/skew/modulate), the "carry
// over from the last animation" semantics stays correct because they
// don't create additional visible elements: they only change the
// appearance of already-rendered elements, and their wrapper already has
// its own :visible track that hides them when it shouldn't be visible.
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
    // The big anim's keys are rounded to 3 decimals by addTrackKey
    // (`Math.round(time * 1000) / 1000`), while labels are computed as
    // `kf.startFrame / frameRate` with no rounding. For frame 71 at 30fps:
    // label = 2.36666..., key = 2.367 -> a 0.33ms gap.
    // Without alignment, the Flash keyframe's real key lands at
    // slice_t=0.0003 instead of slice_t=0. The `nTimes[0] > 0.0001` check
    // then triggers the `lastVal` carry-over (previous animation's state),
    // inserting a ghost key at t=0. On a :visible track this produces 0.3ms
    // of an inherited element visible at the start of the label (e.g. a
    // `crying` mouth at the start of `star`), perceived visually as "the
    // previous anim's thing stuck around".
    //
    // By rounding start/end to the same precision as the keys, the real
    // keyframe key lands exactly at slice_t=0 and the carry-over is
    // removed.
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
            else if (p === "groups") nodeLine += ' groups=' + node.properties[p];
        }
        lines.push(nodeLine + ']');

        for (var p in node.properties) {
            if (p !== "instance" && p !== "groups") lines.push(p + ' = ' + node.properties[p]);
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

// Central pipeline function: converts ONE Flash element (shape or
// instance) present at ONE given keyframe into Godot node(s) + animation
// tracks. Deliberately not decomposed into sub-functions despite its
// size: almost all of its local state (node/wrapperNode, animPosX/Y,
// _matDec...) flows through the function from start to end, so splitting
// it would require threading 8-10 parameters everywhere without reducing
// the actual complexity -- just moving it around, with a real risk of a
// geometric regression (vertex precision, gradient matrices).
// Section markers (same lines on every call, one per element/keyframe):
//   1. Wrapper/node: lookup or creation (Polygon2D/Line2D/Sprite2D/PackedScene/Node2D)
//   2. Line2D -> Node2D demotion if a fill arrives on a later keyframe
//   3. Shape geometry: polyGroups, triangulation/cleanup, gradients/textures
//   4. Strokes -> Line2D, with the symmetric demotion of point 2
//   5. Cleanup of excess Poly_X/Line_X slots (inherited from a previous keyframe)
//   6. visible/process_mode tracks
//   7. Transform (position/rotation/scale/skew), wrapper init + animated
//   8. Color transform: shader (Advanced Color Effect) or plain modulate
// Demotes a Line2D node (created as a direct wrapper for a single stroke,
// v4.7) back to Node2D when a later keyframe ends up giving it several
// strokes OR a fill (this function's two callers). The existing stroke is
// relocated to a "Line_0" child, both properties AND existing animation
// tracks included (rewriting the paths already indexed in
// anim._trackIndex). Identical block in both original cases, factored out
// here.
function _demoteLine2DToNode2D(node, variantPathStr, anim) {
    // BUG (found via buildVariantScenes -- a real Flash animation almost
    // never hits it, but a variant "keyframe" jumping between unrelated
    // designs does): this function used to only rewrite the ANIMATION
    // TRACK paths below to "<path>/Line_0:...", assuming a Line_0 child
    // would get created by _processElementNode's own stroke loop later in
    // THIS SAME keyframe. That's only true if this keyframe ALSO has its
    // own stroke (elem.strokes.length > 0) to draw -- if it gained a fill
    // but lost its stroke in the very same transition, the stroke loop
    // never runs, Line_0 never gets created, and the rewritten tracks
    // dangle (Godot: "couldn't resolve track"). Create the real Line_0
    // child up front instead, carrying over whatever static state `node`
    // already had as a bare Line2D -- exactly the properties cleared below.
    var line0 = new GNode("Line_0", "Line2D");
    var carriedProps = ["joint_mode", "begin_cap_mode", "end_cap_mode", "use_parent_material", "points", "width", "default_color"];
    for (var c = 0; c < carriedProps.length; c++) {
        if (node.properties[carriedProps[c]] !== undefined) line0.properties[carriedProps[c]] = node.properties[carriedProps[c]];
    }
    node.addChild(line0);
    line0.owner = node.owner;

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
                    delete anim._trackIndex["$" + tr.path + "" + tr.type];
                    tr.path = variantPathStr + "/Line_0" + fixProps[f];
                    anim._trackIndex["$" + tr.path + "" + tr.type] = t;
                }
            }
        }
    }
}

// --- _processElementNode section 6, extracted: the two cleanup loops for
// excess Poly_X/Line_X slots (inherited from a previous keyframe that had
// more fills/strokes than this one) are identical apart from their
// parameters -- unified here. `useAnim` switches between writing an
// animation track (non-static layer) and directly assigning a property
// (static layer), the exact same values on both sides.
function _clearExcessNamedSlots(node, variantPathStr, anim, startIndex, prefix, expectedType, useAnim, startTime, resetProps) {
    var idx = startIndex;
    while (true) {
        var excessName = (idx === 0 && node.type === expectedType) ? "" : prefix + ((idx > 0 && node.type === expectedType) ? (idx - 1) : idx);
        var excessNode = (excessName === "") ? node : node.getNodeOrNull(excessName);
        if (!excessNode) break;

        if (excessName === "" && excessNode.type !== expectedType) {
            idx++;
            continue;
        }

        var excessPath = excessName === "" ? variantPathStr : variantPathStr + "/" + excessName;
        for (var p = 0; p < resetProps.length; p++) {
            if (useAnim) {
                anim.addTrackKey(excessPath + ":" + resetProps[p].name, "value", startTime, resetProps[p].value, 0.0);
            } else {
                excessNode.properties[resetProps[p].name] = resetProps[p].value;
            }
        }
        idx++;
    }
}

// --- _processElementNode section 1, extracted: lookup or creation of the
// Godot wrapper/node for THIS Flash element at THIS keyframe. Pure over
// its inputs (elem/parent/ownerRoot/wrapperName/shaderNeeds/
// modulateNeedsCanvasGroup/layerZIndex/getExt): its only side effects are
// creating/attaching the node itself (parent.addChildRanked, node.owner),
// never anim.tracks nor subResources -- so it can be extracted without
// threading the rest of _processElementNode's state.
function _resolveElementNode(elem, parent, ownerRoot, wrapperName, shaderNeeds, modulateNeedsCanvasGroup, layerZIndex, getExt, isStaticLayer) {
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
                if ((!isStaticLayer || elem._isTweenShape) && !elem._isOrientationVariant) {
                    // A genuine multi-keyframe shape tween: TweenShapeMeshConverter.gd
                    // (written unconditionally alongside FlashMovieClip.gd) swaps this
                    // Polygon2D for a pre-triangulated MeshInstance2D the first time this
                    // scene loads, using Godot's own Geometry2D.triangulate_polygon() --
                    // see that script for why this happens at runtime rather than here at
                    // export time. The ":polygon"/":uv"/":polygons"/":texture"/":color"/
                    // ":visible" tracks below are emitted exactly as for any other
                    // animated shape; nothing else about this node changes.
                    // elem._isOrientationVariant excludes the OTHER thing
                    // that also produces a 4-keyframe layer here: a
                    // variant scene's synthesized orientation "keyframes"
                    // (FRONT/BACK/LEFT/RIGHT), which are 4 unrelated
                    // snapshots, never a real polygon tween -- attaching
                    // this script there was pointless work every scene
                    // load (see _buildOrientationSynthSymbol, where the
                    // flag is set).
                    node.properties["script"] = "ExtResource(\"" + getExt("res://scripts/TweenShapeMeshConverter.gd", "Script") + "\")";
                }
            } else if (elem.elementType === "shape" && elem.strokes && elem.strokes.length > 0) {
                // Shape made only of strokes (no fill): the wrapper becomes
                // directly the first stroke's Line2D instead of a Node2D +
                // Line_0 child. Saves 1 node per "stroke-only" shape
                // (icons, hand-drawn outlines, etc.). If a later keyframe
                // of this same occurrence needs several strokes, the node
                // is "demoted" back to Node2D + Line_0..N children (see
                // below, symmetric to the mechanism already in place for
                // Polygon2D/Poly_N).
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

    return { node: node, wrapperNode: wrapperNode, isNewNode: isNewNode, isNewWrapper: isNewWrapper };
}

function _processElementNode(elem, parent, ownerRoot, anim, startTime, duration, frameRate,
                             wrapperName, exportDir, scaleFactor, symName, startFrameIndex,
                             maxTime, kfTransition, shaderNeeds, layerType,
                             getExt, subResources, isStaticLayer, modulateNeedsCanvasGroup, gradCache, layerZIndex) {
    // --- 1. Wrapper/node: lookup or creation -----------------------------
    var _resolved = _resolveElementNode(elem, parent, ownerRoot, wrapperName, shaderNeeds, modulateNeedsCanvasGroup, layerZIndex, getExt, isStaticLayer);
    var node = _resolved.node;
    var wrapperNode = _resolved.wrapperNode;
    var isNewNode = _resolved.isNewNode;
    var isNewWrapper = _resolved.isNewWrapper;

    var wrapperPathStr = ownerRoot.getPathTo(wrapperNode);
    var variantPathStr = ownerRoot.getPathTo(node);

    // --- 2. Line2D -> Node2D demotion if a fill arrives later ------------
    // Rare case: this pooled occurrence had been created as a direct
    // Line2D (stroke-only shape on its first keyframe), but the current
    // keyframe gives it a fill (non-empty elem.polygons). Demote to
    // Node2D and relocate the existing stroke to Line_0 before the
    // polygon logic below decides on its own nodes' naming.
    if (node.type === "Line2D" && elem.polygons && elem.polygons.length > 0) {
        _demoteLine2DToNode2D(node, variantPathStr, anim);
    }

    // --- 3. Shape geometry: polyGroups, triangulation, gradients/textures ---
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

            // NOTE: we no longer force a Polygon2D -> Node2D demotion when
            // polyGroups.length > 1. The node itself hosts group 0 (as in
            // the single-group case), with the following groups becoming
            // Poly_0, Poly_1... children (see the -1 offset right below).
            // This saves 1 Node2D per multi-color/gradient shape (e.g.
            // "shape_layer_X", which used to be just an empty container
            // around Poly_0/Poly_1). The excess-slot cleanup loops (excess
            // Poly_X and anim._maxPoly) apply the same -1 offset to stay
            // consistent with this naming.

            // Captured once, BEFORE the loop, and reused for every gIdx:
            // the Poly_N naming offset must stay based on what `node` WAS
            // when this element started, not be re-derived from
            // node.type mid-loop -- a past version of this code mutated
            // node.type for gIdx===0 partway through (an experiment since
            // reverted), which silently shifted gIdx===1's (and beyond)
            // names by one the moment gIdx===0 switched away from
            // Polygon2D (confirmed with a real 54-polygon shape: the
            // second group ended up "Poly_1" instead of "Poly_0").
            var rootIsPolygon2D = (node.type === "Polygon2D");
            for (var gIdx = 0; gIdx < polyGroups.length; gIdx++) {
                var group = polyGroups[gIdx];
                var polyNodeName = (gIdx === 0 && rootIsPolygon2D) ? "" : "Poly_" + ((gIdx > 0 && rootIsPolygon2D) ? (gIdx - 1) : gIdx);
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
                    var piecesToEmit;

                    if (polyData.holes && polyData.holes.length > 0) {
                        // Split into simple, hole-free pieces (real cuts,
                        // no thin channels) instead of bridging into one
                        // contour -- keeps every resulting shape a plain
                        // Polygon2D "polygons" entry, native/visible/
                        // editable like any other, with no dependency on
                        // Godot's own triangulation being able to handle a
                        // hole-bridged contour (see _splitHoles's header:
                        // that triangulation can silently produce ZERO
                        // triangles -- no error, nothing drawn -- on a
                        // real, valid, non-self-intersecting bridged
                        // polygon once it's complex enough).
                        var splitResult = _splitHoles(polyData.vertices, polyData.holes);
                        if (splitResult.unvented.length === 0 && _splitAreaDeviation(polyData, splitResult.pieces) <= 0.01) {
                            piecesToEmit = splitResult.pieces;
                        } else {
                            // Splitting couldn't cleanly account for every
                            // hole on this particular shape (rare -- a
                            // handful of real cases needed this out of the
                            // whole library) -- fall back to the OLD
                            // single-bridge technique for this ONE
                            // sub-polygon, exactly as this codebase did
                            // before _splitHoles existed. Whatever Godot's
                            // own Polygon2D triangulation makes of that is
                            // no worse than the pre-existing behavior this
                            // session started from -- never a NEW
                            // regression, only unfixed for this one case.
                            var bridged = _bridgeHoles(polyData.vertices, polyData.holes);
                            var effectiveVerts = (bridged && !_hasSelfIntersection(bridged)) ? bridged : polyData.vertices;
                            piecesToEmit = [effectiveVerts];
                        }
                    } else {
                        piecesToEmit = [polyData.vertices];
                    }

                    for (var pe = 0; pe < piecesToEmit.length; pe++) {
                        var finalVerts = _cleanupPolygonVertices(piecesToEmit[pe]);

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
                        // _colorFloats already handles this exact hex parsing
                        // (#RRGGBB[AA] -> formatted "r, g, b, a"), already used
                        // just below for gradient colors: same logic, no
                        // duplication. Only difference (cosmetic, no effect
                        // on Godot): its "no #" fallback returns "1, 1, 1, 1"
                        // instead of "1.0000, 1.0000, 1.0000, 1.0000" -- same
                        // float value, different literal.
                        var colorStr = _colorFloats(group.color);
                        
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
                // NOTE: polygonsParts.length, not group.polygons.length --
                // splitting a hole-bridged sub-polygon can turn ONE
                // group.polygons entry into SEVERAL accumulated
                // pointsParts/polygonsParts pieces (see _splitHoles
                // above), so the two can now legitimately disagree.
                if (isStaticLayer && !elem._isTweenShape) {
                    polyNode.properties["polygon"] = pointsStr;
                    if (polygonsParts.length > 1) {
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
                    if (polygonsParts.length > 1) {
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
            
        }

        // --- 4. Strokes -> Line2D -----------------------------------------
        var hasStrokes = elem.strokes && elem.strokes.length > 0;
        if (hasStrokes && (elem.elementType === "shape" || elem._inlineSprite)) {
            // Symmetric demotion of the Polygon2D/Poly_N case above: this
            // pooled occurrence had been created as a direct Line2D (a
            // single stroke on its first keyframe), but a later keyframe
            // needs several strokes. Convert the wrapper to Node2D and
            // move its existing properties/anim tracks to a Line_0 child.
            if (elem.strokes.length > 1 && node.type === "Line2D") {
                _demoteLine2DToNode2D(node, variantPathStr, anim);
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
                
                var pts = strokeData.pts || strokeData.path || [];
                var ptsParts = [];
                for (var v = 0; v < pts.length; v++) {
                    ptsParts.push(_f(pts[v].x * scaleFactor) + ", " + _f(pts[v].y * scaleFactor));
                }
                var ptsStr = "PackedVector2Array(" + ptsParts.join(", ") + ")";
                
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

        // --- 5. Cleanup of excess Poly_X/Line_X slots ---------------------
        // UNCONDITIONAL reset of Poly_X / Line_X slots not used by this
        // keyframe. Before the fix, these two loops were nested inside
        // `if (elem.polygons.length > 0)` and `if (hasStrokes)`
        // respectively, so a keyframe with 0 polygons didn't clean up the
        // Poly_X inherited from a previous keyframe (same for 0 strokes /
        // Line_X). Result in star: shape_1 (3 polys + 0 strokes in Flash)
        // showed 2 ghost lines inherited from fatig; shape_3 (0 polys + 2
        // strokes) showed 1 ghost polygon. These loops MUST run even when
        // the current count is 0, otherwise the slots keep their previous
        // state. This is exactly Flash's behavior: on every keyframe, only
        // the elements present in that keyframe are drawn; everything else
        // is empty.
        // The two loops (Poly_X/Polygon2D and Line_X/Line2D) are identical
        // apart from their parameters -- factored into _clearExcessNamedSlots
        // (the exact same reset values used identically on the animated-track
        // side and the static-property side).
        // ----------------------------------------------------------------
        var polyCount = polyGroups ? polyGroups.length : 0;
        var useAnimForSlots = !(isStaticLayer && !elem._isTweenShape);
        _clearExcessNamedSlots(node, variantPathStr, anim, polyCount, "Poly_", "Polygon2D", useAnimForSlots, startTime, [
            { name: "polygon", value: "PackedVector2Array()" },
            { name: "polygons", value: "[]" },
            { name: "uv", value: "PackedVector2Array()" },
            { name: "visible", value: false }
        ]);

        var strokeCount = (elem.strokes && elem.strokes.length) || 0;
        _clearExcessNamedSlots(node, variantPathStr, anim, strokeCount, "Line_", "Line2D", useAnimForSlots, startTime, [
            { name: "points", value: "PackedVector2Array()" },
            { name: "visible", value: false }
        ]);
    }

    // --- 6. visible/process_mode tracks -----------------------------------
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

    // --- 7. Transform (position/rotation/scale/skew) ----------------------
    // Matrix decomposition computed once (instead of twice with the same
    // arguments): it feeds both the wrapper's initial values (the
    // isNewWrapper block right below) and the animation key at startTime
    // (the "else if (elem.matrix)" block further down) â€” both use the
    // exact same elem.matrix.
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
        // A truly empty shape (no contours at all) can report left/top as
        // Flash's "no bounds" sentinel (observed: -107374182.4, i.e.
        // INT32_MIN twips / 20) instead of 0/undefined -- treat anything
        // wildly outside plausible stage coordinates as "no position data"
        // rather than propagate it. Normally harmless (an empty shape has
        // nothing to render), but this position can end up inherited by
        // real content pooled into the same node slot on another keyframe
        // (e.g. buildVariantScenes' cross-orientation pooling), displacing
        // it off-screen.
        var animPosX = (elem.left && Math.abs(elem.left) < 1e6) ? elem.left : 0;
        var animPosY = (elem.top  && Math.abs(elem.top)  < 1e6) ? elem.top  : 0;

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

    // --- 8. Color transform: shader (Advanced Color Effect) or plain modulate ---
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
            var shader_path = RES_PREFIX + "shaders/flash_color_normal.gdshader";
            if (elem.blendMode === "add")
                shader_path = RES_PREFIX + "shaders/flash_color_add.gdshader";
            else if (elem.blendMode === "multiply")
                shader_path = RES_PREFIX + "shaders/flash_color_mul.gdshader";

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

// Recursively walks the tree and, for each node whose children mix
// Polygon2D and Line2D, reorders the children so that all Polygon2D come
// before all Line2D. The relative order within each type is preserved
// (= lazy creation order across keyframes, identical to the Poly_0..N and
// Line_0..M slot order). Other node types (if any) stay at their original
// relative position before the Polys section.
function _reorderShapePolysAndLines(node, isTopLevel) {
    if (!node) return;
    var children = node.children;
    // Never group the direct children of the root node passed in: these
    // are shapes/objects independent of one another (each with its own
    // intended z-order), not the Poly_N/Line_N slots of a single
    // decomposed shape. Grouping only makes sense for the children of a
    // shape wrapper (see the recursive call further down).
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

// Builds the GNode tree + resource lists for one symbol, WITHOUT writing
// anything to disk. Split out of buildSceneForSymbol so the same rendering
// pipeline (shapes, gradients, shaders, masks, materials, reordering...)
// can be reused to build a subtree that gets embedded into a larger,
// hand-assembled scene (see buildVariantScenes) instead of always being
// serialized as its own standalone .tscn file.
function _buildSceneTree(sym, frameRate, exportDir, symbolMap, symbolContainsShader, skipEnablerFor) {
    if (!sym.safeName) sym.safeName = sanitizeForLookup(sym.name);
    var extResources = [];
    var extIdMap = {};
    var subResources = [];
    // Deduplication cache for Gradient/GradientTexture resources, scoped to
    // THIS .tscn file (one call = one output file). See the comment in
    // _processElementNode for the optimization details.
    var gradCache = {};

    function getExt(path, type) {
        if (!extIdMap[path]) {
            var id = (type === "Texture2D") ? "tex_" + nextId() : "inst_" + nextId();
            extIdMap[path] = id;
            extResources.push('[ext_resource type="' + type + '" path="' + path + '" id="' + id + '"]');
        }
        return extIdMap[path];
    }

    var actionScripts = []; // Array to store ActionScript

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
    } else if (skipEnablerFor && skipEnablerFor[sym.name]) {
        // v4.15: this symbol is ONLY ever instanced as a child of other
        // symbols (never placed directly by the main scene) -- the
        // animated ancestor that instances it already carries its own
        // VisibleOnScreenEnabler2D, which disables its ENTIRE subtree via
        // process_mode (so also this symbol's AnimationPlayer) when it
        // leaves the screen. An enabler here would be redundant: -1 node
        // per instantiation, with no real loss of culling. See the
        // `referencedBy`/`skipEnablerFor` computation in the caller.
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
        // v4.14-fix: the rect MUST cover the content's real extent (not
        // just its center in a fixed 20x20 box like before v4.13):
        // otherwise the node exits/re-enters the detection field on every
        // frame as soon as the animation moves a bit, triggering permanent
        // enable/disable thrashing -- worse for performance ("Process"
        // spikes) than having no enabler at all. Generous margin (50% of
        // the bbox size, 100px minimum) to absorb the typical movement of
        // an animation (position/rotation/scale) that this bbox, computed
        // ONLY from frame 0, doesn't capture.
        var enabler = new GNode("VisibilityEnabler", "VisibleOnScreenEnabler2D");
        if (hasBounds && minX <= maxX) {
            var bx0 = minX * localScaleFactor, by0 = minY * localScaleFactor;
            var bw = (maxX - minX) * localScaleFactor, bh = (maxY - minY) * localScaleFactor;
            var padX = Math.max(bw * 0.5, 100);
            var padY = Math.max(bh * 0.5, 100);
            enabler.properties["rect"] = "Rect2(" + _f(bx0 - padX) + ", " + _f(by0 - padY) + ", "
                + _f(bw + padX * 2) + ", " + _f(bh + padY * 2) + ")";
        } else {
            // No computable bounds (empty frame 0): a large fallback rect
            // instead of the original tiny 20x20.
            enabler.properties["rect"] = "Rect2(-200, -200, 400, 400)";
        }
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

                if (kf.actionScript && String(kf.actionScript).replace(/^\s+|\s+$/g, '') !== "") {
                    actionScripts.push({
                        time: st,
                        frame: kf.startFrame,
                        code: String(kf.actionScript)
                    });
                    hasAnimation = true;
                }

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
                    // 0.0001 tolerance for rounding errors
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
            var lastElemPositions = {};
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                var startTime = kf.startFrame / frameRate;
                var duration = (kf.duration || 1) / frameRate;
                var kfTransition = kf.tween ? 1.0 : 0.0;

                if (!kf.elements) continue;
                var occurrenceMap = {};
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

                    _processElementNode(elem, targetParent, root, anim, startTime, duration, frameRate,
                        uniqueNodeName, exportDir, scaleFactor, sym.name, kf.startFrame, maxTime,
                        kfTransition, shaderNeeds, layer.layerType, getExt, subResources, (layer.keyframes.length === 1), modulateNeedsCanvasGroup, gradCache, layerZIndex);
                }
                lastElemPositions = _recordElemPositions(_explodedMain, _stableMain);
            }
        }
    }

    _postProcessMasks(root, sym, anim, exportDir, getExt, scaleFactor, extResources, extIdMap);

    if (actionScripts.length > 0) {
        for (var asi = 0; asi < actionScripts.length; asi++) {
            var scriptObj = actionScripts[asi];
            anim.addTrackKey(".", "method", scriptObj.time, { method: "frame_" + scriptObj.frame, args: [] }, 0.0);
        }
    }

    if (hasAnimation) {
        anim.optimizeTracks(root);
        
        var hasStop = false;
        if (actionScripts.length > 0) {
            for (var asi = 0; asi < actionScripts.length; asi++) {
                if (/stop\s*\(\s*\)/.test(actionScripts[asi].code)) {
                    hasStop = true;
                    break;
                }
            }
        }

        var isSingleFrame = (maxTime <= (1.001 / frameRate));

        if (isSingleFrame) {
            root.removeChild(animPlayer);
            // Nothing to pause off-screen: the shape is static, RENDERING
            // culling is already handled natively by Godot. See enabler
            // creation further above.
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

                // "RESET + default only" can also happen here if the only
                // Flash label present is literally called "default" and
                // starts at t=0 (no synthetic unshift, sorted.length === 1).
                var onlyDefaultLabel = (sorted.length === 1 && _sanitize_name(sorted[0].name) === "default");

                for (var i = 0; i < sorted.length; i++) {
                    var lStart = sorted[i].time;
                    var lEnd = (i + 1 < sorted.length) ? sorted[i+1].time : maxTime;
                    var sliced = _sliceAnimation(anim, lStart, lEnd, true);
                    var isLooping = !hasStop && onlyDefaultLabel && (_sanitize_name(sorted[i].name) === "default");
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
                // Library reduced to RESET + default: nothing else to
                // chain into, so "default" loops natively instead of
                // stopping at the last frame (avoids having to handle
                // looping by hand on the gameplay side for this simple case).
                var isLooping = !hasStop;
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

    _flattenSingleChildGroups(root, anim);

    _bakeStaticShaderTints(root, anim, subResources);

    _setupMaterials(root, true);

    _markBakeableShapes(root, anim);
    _mergeSameColorSiblings(root);

    // ----------------------------------------------------------------
    // Reorder the children of `shape` nodes so that all Polygon2D come
    // before all Line2D. Without this, the order in the Godot scene is the
    // lazy CREATION order across keyframes (e.g. Line_0, Poly_0, Line_1,
    // Poly_1, ...), which places some lines BEHIND some polygons. In Flash,
    // strokes are drawn ON TOP OF fills within the same shape; Godot draws
    // children in their declaration order (back to front), so placing all
    // Poly_X before all Line_X reproduces Flash's behavior.
    // Ex symptom: in one asset, `Line_1` was behind `Poly_2` and `Poly_4`
    // because `Line_1` had been created before `Poly_2`/`Poly_4` while
    // processing an earlier keyframe.
    // ----------------------------------------------------------------
    _reorderShapePolysAndLines(root, true);

    // Runs LAST (after every other step that reshapes the tree) so its
    // paint-order analysis reflects the truly final structure -- see
    // _mergeSameColorAcrossTree's own header comment for the safety
    // reasoning (never crosses anything that visually overlaps).
    _mergeSameColorAcrossTree(root);

    return { root: root, extResources: extResources, subResources: subResources, actionScripts: actionScripts };
}

// Thin wrapper around _buildSceneTree: builds the tree then serializes it
// to its own standalone .tscn (+ .gd if it has ActionScript) under
// exportDir, exactly as before this function was split.
function buildSceneForSymbol(sym, frameRate, exportDir, symbolMap, symbolContainsShader, skipEnablerFor) {
    var built = _buildSceneTree(sym, frameRate, exportDir, symbolMap, symbolContainsShader, skipEnablerFor);
    var root = built.root;
    var extResources = built.extResources;
    var subResources = built.subResources;
    var actionScripts = built.actionScripts;

    var tscnText = serializeTscn(root, extResources, subResources);
    var scenePath;
    var gdPath;
    if (sym.isMainScene) {
        scenePath = exportDir + sym.safeName + ".tscn";
        FLfile.createFolder(exportDir + "scripts");
        gdPath = exportDir + "scripts/" + sym.safeName + ".gd";
    } else {
        var _spiOut = _symbolPathInfo(sym.name);
        var _subDir = _spiOut.subPath.substring(0, _spiOut.subPath.lastIndexOf("/"));
        var _accum = exportDir + "symbols";
        if (_subDir.length > 0) {
            var _dirParts = _subDir.split("/");
            for (var _di = 0; _di < _dirParts.length; _di++) {
                _accum += "/" + _dirParts[_di];
                FLfile.createFolder(_accum);
            }
        }
        scenePath = exportDir + "symbols/" + _spiOut.subPath + ".tscn";
        FLfile.createFolder(_accum + "/scripts");
        gdPath = _accum + "/scripts/" + _spiOut.subPath.substring(_spiOut.subPath.lastIndexOf("/") + 1) + ".gd";
    }

    // Post-process .tscn to attach script if we have actionScripts
    if (actionScripts.length > 0) {
        var gdContent = "extends FlashMovieClip\n\n";
        
        var methodsDone = {};
        for (var i = 0; i < actionScripts.length; i++) {
            var scr = actionScripts[i];
            var mName = "frame_" + scr.frame;
            if (methodsDone[mName]) continue;
            methodsDone[mName] = true;
            
            var translatedCode = scr.code;
            translatedCode = translatedCode.replace(/this\._visible/g, "visible");
            translatedCode = translatedCode.replace(/_parent\._parent/g, "get_parent().get_parent()");
            translatedCode = translatedCode.replace(/this\./g, "");
            translatedCode = translatedCode.replace(/\bthis\b/g, "self");
            translatedCode = translatedCode.replace(/;/g, "");
            translatedCode = translatedCode.replace(/\/\//g, "#");
            translatedCode = translatedCode.replace(/new\s+Date\(\)/g, "Time.get_datetime_dict_from_system()");
            translatedCode = translatedCode.replace(/\.getHours\(\)/g, ".hour");
            translatedCode = translatedCode.replace(/Math\.random\(\)/g, "randf()");
            translatedCode = translatedCode.replace(/Math\.floor\(/g, "floor(");
            translatedCode = translatedCode.replace(/Math\.round\(/g, "round(");
            translatedCode = translatedCode.replace(/Math\.ceil\(/g, "ceil(");
            translatedCode = translatedCode.replace(/Math\.abs\(/g, "abs(");
            translatedCode = translatedCode.replace(/Math\.max\(/g, "max(");
            translatedCode = translatedCode.replace(/Math\.min\(/g, "min(");
            translatedCode = translatedCode.replace(/Math\.PI/g, "PI");
            translatedCode = translatedCode.replace(/parseInt\(/g, "int(");
            
            var lines = translatedCode.split("\n");
            gdContent += "func " + mName + "():\n";
            gdContent += "\tpass\n";
            var hasContent = false;
            var declaredVars = {};
            for (var l = 0; l < lines.length; l++) {
                var line = lines[l].replace(/^\s+|\s+$/g, '');
                if (line.length > 0) {
                    // Strip ActionScript types (e.g. :Number)
                    line = line.replace(/:\s*[a-zA-Z0-9_]+/g, "");
                    
                    var isSafeAssignment = false;
                    
                    var varMatch = line.match(/^var\s+([a-zA-Z0-9_]+)/);
                    if (varMatch) {
                        var vName = varMatch[1];
                        if (declaredVars[vName]) {
                            // Already declared, remove 'var ' to avoid Godot error
                            line = line.replace(/^var\s+/, "");
                            isSafeAssignment = true;
                        } else {
                            declaredVars[vName] = true;
                        }
                    } else {
                        // Auto-add 'var ' if line looks like 'rd = random(20)'
                        var randMatch = line.match(/^([a-zA-Z0-9_]+)\s*=\s*.*(?:random|randf)/);
                        if (randMatch) {
                            var vName = randMatch[1];
                            if (!declaredVars[vName]) {
                                line = "var " + line;
                                declaredVars[vName] = true;
                            } else {
                                isSafeAssignment = true;
                            }
                        }
                    }
                    
                    var assignMatch = line.match(/^([a-zA-Z0-9_]+)\s*=/);
                    if (assignMatch && declaredVars[assignMatch[1]]) {
                        isSafeAssignment = true;
                    }
                    
                    if (
                        line.indexOf("stop()") === 0 ||
                        line.indexOf("play()") === 0 ||
                        line.indexOf("gotoAndStop(") === 0 ||
                        line.indexOf("gotoAndPlay(") === 0 ||
                        line.indexOf("nextFrame()") === 0 ||
                        line.indexOf("prevFrame()") === 0 ||
                        line.indexOf("var ") === 0 ||
                        line.indexOf("#") === 0 ||
                        line === "visible = true" ||
                        line === "visible = false" ||
                        isSafeAssignment
                    ) {
                        // Safe GDScript or comment
                        gdContent += "\t" + line + "\n";
                    } else {
                        // Unsafe / custom logic, comment it out to prevent parse errors
                        gdContent += "\t# " + line + "\n";
                    }
                    hasContent = true;
                }
            }
            if (!hasContent) gdContent += "\tpass\n";
            gdContent += "\n";
        }
        
        FLfile.write(gdPath, gdContent);
        
        // Add script to .tscn root node manually
        var resLocalPath = scenePath.replace(exportDir, RES_PREFIX);
        // Use the exact filename from gdPath for the resource to avoid case mismatch
        var gdFileName = gdPath.substring(gdPath.lastIndexOf("/") + 1);
        var gdLocalPath = resLocalPath.substring(0, resLocalPath.lastIndexOf("/") + 1) + "scripts/" + gdFileName;
        
        var scriptExtId = (extResources.length + 1) + "_script";
        var scriptExtStr = '[ext_resource type="Script" path="' + gdLocalPath + '" id="' + scriptExtId + '"]';
        
        // Insert after the last ext_resource or after [gd_scene ...]
        var linesTscn = tscnText.split('\n');
        var insertIdx = 1;
        for (var i = 0; i < linesTscn.length; i++) {
            if (linesTscn[i].indexOf('[ext_resource') === 0) insertIdx = i + 1;
        }
        linesTscn.splice(insertIdx, 0, scriptExtStr);
        
        // Find root node and attach script
        for (var i = 0; i < linesTscn.length; i++) {
            if (linesTscn[i].indexOf('[node name="' + root.name + '"') === 0) {
                linesTscn.splice(i + 1, 0, 'script = ExtResource("' + scriptExtId + '")');
                break;
            }
        }
        tscnText = linesTscn.join('\n');
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
                valsStr.push('{\n"args": [],\n"method": &"' + val.method + '"\n}');
            }
            else                                  valsStr.push(val);
        }
        L.push('"values": [' + valsStr.join(', ') + ']');
        L.push('}');
    }
    return L.join("\n");
}

function _buildSymbolMap(symbols) {
    var symbolMap = {};
    for (var i = 0; i < symbols.length; i++) {
        symbolMap[symbols[i].name] = symbols[i];
    }
    return symbolMap;
}

// Propagation of "this symbol needs a shader" (non-trivial color/blend, or
// it instances a symbol that itself needs one). This is a MONOTONE fixed
// point (a symbol marks the rest forever): the final result is unique
// regardless of the order/strategy used for propagation. Instead of
// re-scanning the WHOLE library on every iteration until stabilization
// (expensive on nested symbol hierarchies), we compute in a single pass
// (a) each symbol's direct need and (b) the reverse graph "which symbols
// instance this symbol", then propagate via worklist. Mathematically
// identical result, O(elements + symbols) complexity instead of
// O(passes * elements).
// Also returns `referencedBy` (the reverse-instancing graph), reused by
// buildGodotScenes for the v4.15 `skipEnablerFor` computation.
function _computeShaderNeedsAndReferences(symbols) {
    var symbolContainsShader = {};
    var directHasShader = {};
    var referencedBy = {};
    for (var i = 0; i < symbols.length; i++) {
        var sym = symbols[i];
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
    for (var i = 0; i < symbols.length; i++) {
        var symName = symbols[i].name;
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

    return { symbolContainsShader: symbolContainsShader, referencedBy: referencedBy };
}

// Walks UP from exportDir looking for a project.godot to determine the
// real RES_PREFIX (exportDir may be a subfolder of the actual Godot
// project root). Sets the module-level RES_PREFIX global (read by
// _processElementNode and friends when emitting ext_resource paths) and
// returns the detected project root (defaults to exportDir itself, with
// RES_PREFIX "res://", when no project.godot is found above it).
function _computeGodotProjectRoot(exportDir) {
    var uri = exportDir;
    if (uri.charAt(uri.length - 1) === "/") uri = uri.substring(0, uri.length - 1);
    var originalUri = uri;
    var godotProjectRoot = originalUri;
    RES_PREFIX = "res://";
    while (uri.indexOf("/") !== -1) {
        if (FLfile.exists(uri + "/project.godot")) {
            godotProjectRoot = uri;
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
    return godotProjectRoot;
}

// =============================================================================
//  Top-level export entry point
// =============================================================================
function buildGodotScenes(doc, data, exportDir) {
    var godotProjectRoot = _computeGodotProjectRoot(exportDir);

    FLfile.createFolder(exportDir + "symbols/");
    FLfile.createFolder(exportDir + "shaders/");
    FLfile.write(exportDir + "shaders/flash_color_normal.gdshader", SHADER_NORMAL);
    FLfile.write(exportDir + "shaders/flash_color_add.gdshader",    SHADER_ADD);
    FLfile.write(exportDir + "shaders/flash_color_mul.gdshader",    SHADER_MUL);

    var symbolMap = _buildSymbolMap(data.library.symbols);

    var _shaderNeeds = _computeShaderNeedsAndReferences(data.library.symbols);
    var symbolContainsShader = _shaderNeeds.symbolContainsShader;
    var referencedBy = _shaderNeeds.referencedBy;

    // v4.15: a symbol that is NEVER placed directly by the main scene, and
    // is ALWAYS instanced as a child of at least one other symbol, doesn't
    // need its own VisibleOnScreenEnabler2D -- the ancestor that instances
    // it already disables its whole subtree via process_mode when it goes
    // off-screen, including this symbol's AnimationPlayer (see the enabler
    // creation in buildSceneForSymbol). Reuses the `referencedBy` graph
    // already computed above for the shader worklist.
    // Accepted limitation: if ALL of a symbol's parents turn out to be
    // non-animated themselves (single-frame, so without their own enabler),
    // that symbol loses its individual culling for nothing -- a marginal
    // case in practice (having several internal animation frames, the
    // condition for carrying its own enabler, almost always implies a
    // parent that is itself animated).
    var mainSceneUsesSymbol = {};
    var _mainScene = data.scenes[0];
    if (_mainScene && _mainScene.layers) {
        for (var l = 0; l < _mainScene.layers.length; l++) {
            var layer = _mainScene.layers[l];
            if (!layer.keyframes) continue;
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                if (!kf.elements) continue;
                for (var e = 0; e < kf.elements.length; e++) {
                    if (kf.elements[e].symbolName) mainSceneUsesSymbol[kf.elements[e].symbolName] = true;
                }
            }
        }
    }
    var skipEnablerFor = {};
    for (var i = 0; i < data.library.symbols.length; i++) {
        var symName = data.library.symbols[i].name;
        if (referencedBy[symName] && referencedBy[symName].length > 0 && !mainSceneUsesSymbol[symName]) {
            skipEnablerFor[symName] = true;
        }
    }

    _preprocessTweens(data, symbolMap);

    for (var i = 0; i < data.library.symbols.length; i++) {
        var s = data.library.symbols[i];
        if (_isAutoTweenName(s.name)) continue;
        buildSceneForSymbol(s, data.document.frameRate || 25, exportDir, symbolMap, symbolContainsShader, skipEnablerFor);
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
    buildSceneForSymbol(pseudoMain, data.document.frameRate || 25, exportDir, symbolMap, symbolContainsShader);

    // Create FlashMovieClip.gd base class at the root of the Godot project
    var fmcContent = "extends Node2D\n" +
    "class_name FlashMovieClip\n\n" +
    "var _rng: RandomNumberGenerator\n" +
    "var undefined = null\n\n" +
    "func _ready():\n" +
    "\t_rng = RandomNumberGenerator.new()\n" +
    "\t_rng.seed = hash(Time.get_ticks_msec()) + hash(get_instance_id())\n\n" +
    "var _currentframe: int:\n" +
    "\tget:\n" +
    "\t\tif has_node(\"AnimationPlayer\") and $AnimationPlayer.current_animation != \"\":\n" +
    "\t\t\treturn int($AnimationPlayer.current_animation_position * 24.0)\n" +
    "\t\treturn 0\n\n" +
    "var _totalframes: int:\n" +
    "\tget:\n" +
    "\t\tif has_node(\"AnimationPlayer\") and $AnimationPlayer.current_animation != \"\":\n" +
    "\t\t\treturn int($AnimationPlayer.current_animation_length * 24.0)\n" +
    "\t\treturn 1\n\n" +
    "var _level0: Node:\n" +
    "\tget:\n" +
    "\t\treturn get_tree().root.get_child(0)\n\n" +
    "func random(max_val: int) -> int:\n" +
    "\treturn _rng.randi() % max_val\n\n" +
    "func gotoAndPlay(frame_or_name):\n" +
    "\tif not has_node(\"AnimationPlayer\"): return\n" +
    "\tif typeof(frame_or_name) == TYPE_STRING:\n" +
    "\t\t$AnimationPlayer.play(frame_or_name)\n" +
    "\telse:\n" +
    "\t\tif $AnimationPlayer.current_animation != \"\":\n" +
    "\t\t\t$AnimationPlayer.seek(frame_or_name / 24.0, true)\n" +
    "\t\t\t$AnimationPlayer.play($AnimationPlayer.current_animation)\n\n" +
    "func gotoAndStop(frame_or_name):\n" +
    "\tif not has_node(\"AnimationPlayer\"): return\n" +
    "\tif typeof(frame_or_name) == TYPE_STRING:\n" +
    "\t\t$AnimationPlayer.play(frame_or_name)\n" +
    "\t\t$AnimationPlayer.pause()\n" +
    "\t\t$AnimationPlayer.seek(0, true)\n" +
    "\telse:\n" +
    "\t\tif $AnimationPlayer.current_animation != \"\":\n" +
    "\t\t\t$AnimationPlayer.play($AnimationPlayer.current_animation)\n" +
    "\t\t\t$AnimationPlayer.pause()\n" +
    "\t\t\t$AnimationPlayer.seek(frame_or_name / 24.0, true)\n\n" +
    "func nextFrame():\n" +
    "\tgotoAndStop(_currentframe + 1)\n\n" +
    "func prevFrame():\n" +
    "\tgotoAndStop(_currentframe - 1)\n\n" +
    "func stop():\n" +
    "\tif has_node(\"AnimationPlayer\"):\n" +
    "\t\t$AnimationPlayer.pause()\n\n" +
    "func play():\n" +
    "\tif has_node(\"AnimationPlayer\") and $AnimationPlayer.current_animation != \"\":\n" +
    "\t\t$AnimationPlayer.play($AnimationPlayer.current_animation)\n";
    var scriptDir = godotProjectRoot + "/scripts";
    if (!FLfile.exists(scriptDir)) {
        FLfile.createFolder(scriptDir);
    }
    FLfile.write(scriptDir + "/FlashMovieClip.gd", fmcContent);

    // TweenShapeMesh.gd / TweenShapeMeshConverter.gd: written unconditionally
    // (shared, per-Godot-project scripts, same convention as
    // FlashMovieClip.gd above), used only by the Polygon2D shapes
    // _resolveElementNode attaches TweenShapeMeshConverter.gd to (a
    // multi-keyframe shape tween -- see there). Pre-triangulates each
    // keyframe ONCE at runtime, via Godot's own Geometry2D.
    // triangulate_polygon(), the first time each scene loads -- instead of
    // JSFL hand-triangulating at export time, which would mean re-porting
    // and re-verifying a triangulation algorithm outside of Godot itself.
    var tweenMeshContent = "extends MeshInstance2D\n" +
    "class_name TweenShapeMesh\n" +
    "## Lightweight multi-mesh holder: swaps `mesh` between a fixed list of\n" +
    "## pre-built ArrayMeshes via `mesh_index`. Populated once (via set_meshes),\n" +
    "## right after construction, by TweenShapeMeshConverter.gd -- this script\n" +
    "## itself does no triangulation or mesh building of its own.\n" +
    "\n" +
    "var _meshes: Array[ArrayMesh] = []\n" +
    "\n" +
    "var mesh_index: int = 0:\n" +
    "\tset(value):\n" +
    "\t\tmesh_index = value\n" +
    "\t\tif value >= 0 and value < _meshes.size() and _meshes[value] != null:\n" +
    "\t\t\tmesh = _meshes[value]\n" +
    "\n" +
    "func set_meshes(meshes: Array[ArrayMesh]) -> void:\n" +
    "\t_meshes = meshes\n" +
    "\tif mesh_index >= 0 and mesh_index < _meshes.size() and _meshes[mesh_index] != null:\n" +
    "\t\tmesh = _meshes[mesh_index]\n";
    FLfile.write(scriptDir + "/TweenShapeMesh.gd", tweenMeshContent);

    var tweenConverterContent = "extends Polygon2D\n" +
    "class_name TweenShapeMeshConverter\n" +
    "## Attached (by godotBuilder.jsfl) to any Polygon2D whose \"polygon\" fill is\n" +
    "## track-animated across more than one keyframe -- an organic Flash shape\n" +
    "## tween. Nothing about the normal animated-shape export changes: this node\n" +
    "## still gets the exact same \":polygon\"/\":uv\"/\":polygons\"/\":texture\"/\n" +
    "## \":color\"/\":visible\" tracks any other animated shape gets.\n" +
    "##\n" +
    "## At _ready(), this script reads those tracks straight off its own\n" +
    "## AnimationPlayer, triangulates each DISTINCT keyframe shape ONCE via\n" +
    "## Godot's own Geometry2D.triangulate_polygon() (never a hand-rolled\n" +
    "## triangulator), replaces itself with a TweenShapeMesh (a plain\n" +
    "## MeshInstance2D) holding one pre-built ArrayMesh per keyframe, and adds a\n" +
    "## new \":mesh_index\" int track driving that swap -- so at runtime Godot just\n" +
    "## swaps between pre-triangulated meshes instead of re-triangulating a raw\n" +
    "## \"polygon\" value on every keyframe change, every time the animation plays.\n" +
    "##\n" +
    "## Deliberately does NOT rename or remove the original \":polygon\"/\":uv\"/\n" +
    "## \":polygons\" tracks -- only disables them (Animation.track_set_enabled).\n" +
    "## Godot resource-caches each Animation sub-resource, so every instance of\n" +
    "## the same PackedScene shares the SAME Animation objects; keeping the\n" +
    "## source tracks intact (just disabled) means every instance can always\n" +
    "## independently re-derive the identical shapes/mesh order from them, with\n" +
    "## no dependency on which instance's _ready() happens to run first.\n" +
    "\n" +
    "func _ready() -> void:\n" +
    "\tvar root: Node = get_owner()\n" +
    "\tif root == null:\n" +
    "\t\troot = self\n" +
    "\tvar ap := _find_animation_player(root)\n" +
    "\tif ap == null:\n" +
    "\t\treturn  # No AnimationPlayer to read tracks from: nothing to optimize.\n" +
    "\n" +
    "\tvar my_path := root.get_path_to(self)\n" +
    "\tvar poly_track_name := \"%s:polygon\" % my_path\n" +
    "\tvar uv_track_name := \"%s:uv\" % my_path\n" +
    "\tvar polys_track_name := \"%s:polygons\" % my_path\n" +
    "\tvar mesh_index_track_name := \"%s:mesh_index\" % my_path\n" +
    "\n" +
    "\t# Pass 1 (read-only, deterministic): derive every distinct keyframe\n" +
    "\t# shape -- across every animation touching this node path, RESET\n" +
    "\t# included -- from the untouched source tracks. Since the source data\n" +
    "\t# never changes, this produces the exact same shapes/mesh_index mapping\n" +
    "\t# no matter which instance of this scene runs it, or how many times.\n" +
    "\tvar shapes: Array[PackedVector2Array] = []\n" +
    "\tvar shape_uvs: Array[PackedVector2Array] = []\n" +
    "\tvar shape_tris: Array[PackedInt32Array] = []\n" +
    "\tvar shape_index_by_key: Dictionary = {}\n" +
    "\tvar per_anim: Array = []\n" +
    "\n" +
    "\tfor anim_name in ap.get_animation_list():\n" +
    "\t\tvar anim := ap.get_animation(anim_name)\n" +
    "\t\tvar poly_idx := anim.find_track(poly_track_name, Animation.TYPE_VALUE)\n" +
    "\t\tif poly_idx == -1:\n" +
    "\t\t\tcontinue\n" +
    "\t\tvar key_count := anim.track_get_key_count(poly_idx)\n" +
    "\t\tif key_count <= 1:\n" +
    "\t\t\tcontinue  # A single static value: not worth converting.\n" +
    "\n" +
    "\t\tvar uv_idx := anim.find_track(uv_track_name, Animation.TYPE_VALUE)\n" +
    "\t\tvar polys_idx := anim.find_track(polys_track_name, Animation.TYPE_VALUE)\n" +
    "\t\tvar mesh_indices: Array[int] = []\n" +
    "\t\tmesh_indices.resize(key_count)\n" +
    "\n" +
    "\t\tfor k in range(key_count):\n" +
    "\t\t\tvar pts: PackedVector2Array = anim.track_get_key_value(poly_idx, k)\n" +
    "\t\t\tvar key_time: float = anim.track_get_key_time(poly_idx, k)\n" +
    "\t\t\t# NOT positional (uv_idx/polys_idx key `k`): addTrackKey (the\n" +
    "\t\t\t# JSFL exporter) skips inserting a key whose value repeats the\n" +
    "\t\t\t# previous one, so \":uv\"/\":polygons\" can end up with FEWER keys,\n" +
    "\t\t\t# at DIFFERENT times, than \":polygon\" -- reading them by the same\n" +
    "\t\t\t# index `k` can silently pair this keyframe's points with a\n" +
    "\t\t\t# stale, differently-sized groups/uv array from some other\n" +
    "\t\t\t# keyframe. Look up by time instead: whichever key was most\n" +
    "\t\t\t# recently in effect at this exact keyframe's own time, matching\n" +
    "\t\t\t# how discrete tracks are actually applied during playback.\n" +
    "\t\t\tvar uvs: PackedVector2Array = _value_at_time(anim, uv_idx, key_time, PackedVector2Array())\n" +
    "\t\t\tvar groups: Array = _value_at_time(anim, polys_idx, key_time, [])\n" +
    "\n" +
    "\t\t\tvar sig := _shape_signature(pts)\n" +
    "\t\t\tif shape_index_by_key.has(sig):\n" +
    "\t\t\t\tmesh_indices[k] = shape_index_by_key[sig]\n" +
    "\t\t\t\tcontinue\n" +
    "\n" +
    "\t\t\tvar idx := shapes.size()\n" +
    "\t\t\tshape_index_by_key[sig] = idx\n" +
    "\t\t\tshapes.append(pts)\n" +
    "\t\t\tshape_uvs.append(uvs)\n" +
    "\t\t\tshape_tris.append(_triangulate(pts, groups))\n" +
    "\t\t\tmesh_indices[k] = idx\n" +
    "\n" +
    "\t\tper_anim.append({\n" +
    "\t\t\t\"anim\": anim, \"poly_idx\": poly_idx, \"uv_idx\": uv_idx, \"polys_idx\": polys_idx,\n" +
    "\t\t\t\"times\": _key_times(anim, poly_idx), \"mesh_indices\": mesh_indices,\n" +
    "\t\t})\n" +
    "\n" +
    "\tif per_anim.is_empty():\n" +
    "\t\treturn  # Nothing animated (or already fully static): stay a plain Polygon2D.\n" +
    "\n" +
    "\t# Build this instance's own meshes (every instance builds its own --\n" +
    "\t# ArrayMesh/mesh state is never shared, only the Animation resource is).\n" +
    "\tvar meshes: Array[ArrayMesh] = []\n" +
    "\tmeshes.resize(shapes.size())\n" +
    "\tfor i in range(shapes.size()):\n" +
    "\t\tmeshes[i] = _build_mesh(shapes[i], shape_uvs[i], shape_tris[i])\n" +
    "\n" +
    "\t# Pass 2 (mutating, but idempotent): add the \":mesh_index\" track and\n" +
    "\t# disable the now-redundant source tracks, but only the FIRST time --\n" +
    "\t# later instances sharing this same Animation resource see it already\n" +
    "\t# converted and skip straight past.\n" +
    "\tfor entry in per_anim:\n" +
    "\t\tvar anim: Animation = entry[\"anim\"]\n" +
    "\t\tif anim.find_track(mesh_index_track_name, Animation.TYPE_VALUE) == -1:\n" +
    "\t\t\tvar mi_idx := anim.add_track(Animation.TYPE_VALUE)\n" +
    "\t\t\tanim.track_set_path(mi_idx, mesh_index_track_name)\n" +
    "\t\t\tanim.value_track_set_update_mode(mi_idx, Animation.UPDATE_DISCRETE)\n" +
    "\t\t\tvar times: Array = entry[\"times\"]\n" +
    "\t\t\tvar mesh_indices: Array = entry[\"mesh_indices\"]\n" +
    "\t\t\tfor k in range(times.size()):\n" +
    "\t\t\t\tanim.track_insert_key(mi_idx, times[k], mesh_indices[k])\n" +
    "\n" +
    "\t\t\tanim.track_set_enabled(entry[\"poly_idx\"], false)\n" +
    "\t\t\tvar uv_idx: int = entry[\"uv_idx\"]\n" +
    "\t\t\tif uv_idx != -1:\n" +
    "\t\t\t\tanim.track_set_enabled(uv_idx, false)\n" +
    "\t\t\tvar polys_idx: int = entry[\"polys_idx\"]\n" +
    "\t\t\tif polys_idx != -1:\n" +
    "\t\t\t\tanim.track_set_enabled(polys_idx, false)\n" +
    "\n" +
    "\t# Swap self for a TweenShapeMesh carrying the same transform/visuals --\n" +
    "\t# every instance does this, unconditionally, since nodes are never\n" +
    "\t# shared across instances the way the Animation resource above is.\n" +
    "\tvar mesh_node := TweenShapeMesh.new()\n" +
    "\tmesh_node.name = name\n" +
    "\tmesh_node.position = position\n" +
    "\tmesh_node.rotation = rotation\n" +
    "\tmesh_node.scale = scale\n" +
    "\tmesh_node.skew = skew\n" +
    "\tmesh_node.z_index = z_index\n" +
    "\tmesh_node.z_as_relative = z_as_relative\n" +
    "\tmesh_node.visible = visible\n" +
    "\tmesh_node.modulate = color\n" +
    "\tmesh_node.texture = texture\n" +
    "\tmesh_node.set_meshes(meshes)\n" +
    "\n" +
    "\t# The tree is still mid-setup while sibling _ready() calls are firing\n" +
    "\t# (this is one of them): add_child()/move_child()/owner all reject\n" +
    "\t# synchronous calls here (\"Parent node is busy setting up children\").\n" +
    "\t# Defer the whole swap to run once that batch finishes, and remove self\n" +
    "\t# BEFORE adding mesh_node (same name) so Godot never has to uniquify it\n" +
    "\t# against the still-present original -- which would break every\n" +
    "\t# NodePath the AnimationPlayer tracks above already point to.\n" +
    "\tcall_deferred(\"_finish_swap\", mesh_node, get_parent(), get_index(), owner)\n" +
    "\n" +
    "\n" +
    "func _finish_swap(mesh_node: Node, parent: Node, index: int, scene_owner: Node) -> void:\n" +
    "\tparent.remove_child(self)\n" +
    "\tparent.add_child(mesh_node)\n" +
    "\tparent.move_child(mesh_node, index)\n" +
    "\tmesh_node.owner = scene_owner\n" +
    "\tqueue_free()\n" +
    "\n" +
    "\n" +
    "# Triangulates one keyframe's fill. `groups`, when non-empty, is the raw\n" +
    "# value of that keyframe's \":polygons\" track key: one PackedInt32Array per\n" +
    "# disjoint sub-polygon, each listing which indices of `pts` belong to it\n" +
    "# (Polygon2D's own convention for several disconnected shapes sharing one\n" +
    "# vertex pool). Geometry2D.triangulate_polygon() expects a single simple\n" +
    "# polygon, so each sub-polygon is triangulated on its own and the resulting\n" +
    "# LOCAL indices are mapped back to `pts`' global indices before combining.\n" +
    "func _triangulate(pts: PackedVector2Array, groups: Array) -> PackedInt32Array:\n" +
    "\tif groups.size() <= 1:\n" +
    "\t\tif pts.size() < 3:\n" +
    "\t\t\treturn PackedInt32Array()\n" +
    "\t\treturn Geometry2D.triangulate_polygon(pts)\n" +
    "\n" +
    "\tvar combined := PackedInt32Array()\n" +
    "\tfor group in groups:\n" +
    "\t\tvar local_indices: PackedInt32Array = group\n" +
    "\t\tif local_indices.size() < 3:\n" +
    "\t\t\tcontinue\n" +
    "\t\tvar sub_pts := PackedVector2Array()\n" +
    "\t\tsub_pts.resize(local_indices.size())\n" +
    "\t\tfor i in range(local_indices.size()):\n" +
    "\t\t\tsub_pts[i] = pts[local_indices[i]]\n" +
    "\t\tvar sub_tris := Geometry2D.triangulate_polygon(sub_pts)\n" +
    "\t\tfor t in sub_tris:\n" +
    "\t\t\tcombined.append(local_indices[t])\n" +
    "\treturn combined\n" +
    "\n" +
    "\n" +
    "func _build_mesh(pts_2d: PackedVector2Array, uvs: PackedVector2Array, tri_indices: PackedInt32Array) -> ArrayMesh:\n" +
    "\tif pts_2d.size() < 3 or tri_indices.size() < 3:\n" +
    "\t\treturn null  # Degenerate keyframe: TweenShapeMesh leaves `mesh` unset for it.\n" +
    "\tvar pts_3d := PackedVector3Array()\n" +
    "\tpts_3d.resize(pts_2d.size())\n" +
    "\tfor v in range(pts_2d.size()):\n" +
    "\t\tpts_3d[v] = Vector3(pts_2d[v].x, pts_2d[v].y, 0.0)\n" +
    "\n" +
    "\tvar arrays := []\n" +
    "\tarrays.resize(Mesh.ARRAY_MAX)\n" +
    "\tarrays[Mesh.ARRAY_VERTEX] = pts_3d\n" +
    "\tif uvs.size() == pts_2d.size():\n" +
    "\t\tarrays[Mesh.ARRAY_TEX_UV] = uvs\n" +
    "\tarrays[Mesh.ARRAY_INDEX] = tri_indices\n" +
    "\n" +
    "\tvar array_mesh := ArrayMesh.new()\n" +
    "\tarray_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)\n" +
    "\treturn array_mesh\n" +
    "\n" +
    "\n" +
    "func _key_times(anim: Animation, track_idx: int) -> Array[float]:\n" +
    "\tvar times: Array[float] = []\n" +
    "\tfor k in range(anim.track_get_key_count(track_idx)):\n" +
    "\t\ttimes.append(anim.track_get_key_time(track_idx, k))\n" +
    "\treturn times\n" +
    "\n" +
    "\n" +
    "# The value in effect on `track_idx` at `time` -- i.e. the LAST key at or\n" +
    "# before `time` (keys are always stored in ascending time order by the\n" +
    "# exporter) -- or `default_value` if the track doesn't exist, has no keys\n" +
    "# yet at `time`, or `track_idx` is -1.\n" +
    "func _value_at_time(anim: Animation, track_idx: int, time: float, default_value):\n" +
    "\tif track_idx == -1:\n" +
    "\t\treturn default_value\n" +
    "\tvar result = default_value\n" +
    "\tfor k in range(anim.track_get_key_count(track_idx)):\n" +
    "\t\tif anim.track_get_key_time(track_idx, k) <= time + 0.0005:\n" +
    "\t\t\tresult = anim.track_get_key_value(track_idx, k)\n" +
    "\t\telse:\n" +
    "\t\t\tbreak\n" +
    "\treturn result\n" +
    "\n" +
    "\n" +
    "# AnimationPlayer is always a direct child of the symbol scene's own root\n" +
    "# in this exporter's convention -- checked by exact name first (the common\n" +
    "# case, one lookup), falling back to a plain scan of root's direct children\n" +
    "# by type if that name ever differs. Deliberately NOT a recursive/deep\n" +
    "# search: an instanced child scene (PackedScene) may have its own, unrelated\n" +
    "# AnimationPlayer further down the tree, which must never be picked up here.\n" +
    "func _find_animation_player(root: Node) -> AnimationPlayer:\n" +
    "\tvar direct := root.get_node_or_null(\"AnimationPlayer\")\n" +
    "\tif direct is AnimationPlayer:\n" +
    "\t\treturn direct\n" +
    "\tfor child in root.get_children():\n" +
    "\t\tif child is AnimationPlayer:\n" +
    "\t\t\treturn child\n" +
    "\treturn null\n" +
    "\n" +
    "\n" +
    "static func _shape_signature(pts: PackedVector2Array) -> String:\n" +
    "\tvar s := \"\"\n" +
    "\tfor p in pts:\n" +
    "\t\ts += \"%.2f,%.2f|\" % [p.x, p.y]\n" +
    "\treturn s\n";
    FLfile.write(scriptDir + "/TweenShapeMeshConverter.gd", tweenConverterContent);
}

// =============================================================================
//  Equipment variant scenes ("frame swap" folders, e.g. HAT/, ITEM/)
// =============================================================================
//
// Some FLA libraries pack multiple DESIGNS of the same piece of equipment
// as separate FRAMES of a handful of parallel clips, one clip per view, e.g.
// HAT/HAT_FRONT, HAT/HAT_BACK, HAT/HAT_LEFT, HAT/HAT_RIGHT: frame N of each
// is the SAME hat design, seen from a different angle. buildVariantScenes
// finds every such "<prefix>_<ORIENTATION>" group automatically and, for
// every frame N common to all of a group's parts, generates ONE combined
// scene "<N+1>.tscn" (Flash's 1-based frame numbering) containing:
//   - one child group per orientation, built through the exact same
//     rendering pipeline as any other symbol (_buildSceneTree: shapes,
//     gradients, shaders, masks...);
//   - an AnimationPlayer with one animation per orientation, each toggling
//     `visible` so only that orientation's parts show at a time -- gameplay
//     picks the view with AnimationPlayer.play("FRONT")/("BACK")/etc.
// Independent of buildGodotScenes: safe to run against the same
// debug_data.json/exportDir either before, after, or instead of a normal
// export (see tools/build_variant_scenes.js for the Node.js entry point).
var _VARIANT_ORIENTATIONS = ["FRONT", "BACK", "LEFT", "RIGHT", "PROFILE", "SIT"];

// Finds every symbol name of the form "<folder>/<prefix>_<ORIENTATION>" and
// groups them by "<folder>/<prefix>". A group needs at least 2 orientations
// to be worth generating (a single clip has nothing to switch between).
function _findVariantGroups(symbols) {
    var groups = {};
    var order = [];
    for (var i = 0; i < symbols.length; i++) {
        var name = symbols[i].name;
        var slashIdx = name.lastIndexOf("/");
        var folderPath = (slashIdx === -1) ? "" : name.substring(0, slashIdx);
        var baseName = (slashIdx === -1) ? name : name.substring(slashIdx + 1);
        for (var o = 0; o < _VARIANT_ORIENTATIONS.length; o++) {
            var orient = _VARIANT_ORIENTATIONS[o];
            var suffix = "_" + orient;
            if (baseName.length <= suffix.length) continue;
            if (baseName.substring(baseName.length - suffix.length) !== suffix) continue;
            var prefix = baseName.substring(0, baseName.length - suffix.length);
            var groupKey = folderPath + "/" + prefix;
            if (!groups[groupKey]) {
                groups[groupKey] = { prefix: prefix, parts: {} };
                order.push(groupKey);
            }
            groups[groupKey].parts[orient] = symbols[i];
            break;
        }
    }
    var result = [];
    for (var gi = 0; gi < order.length; gi++) {
        var g = groups[order[gi]];
        var count = 0;
        for (var o in g.parts) count++;
        if (count >= 2) result.push(g);
    }
    return result;
}

// How many frames a symbol covers, counting only its non-guide/non-folder
// layers (a guide layer's duration is a drawing aid, not real content).
function _symbolFrameCount(sym) {
    var count = 0;
    if (sym.layers) {
        for (var l = 0; l < sym.layers.length; l++) {
            var layer = sym.layers[l];
            if (layer.layerType === "guide" || layer.layerType === "folder") continue;
            if (!layer.keyframes) continue;
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                var extent = kf.startFrame + (kf.duration || 1);
                if (extent > count) count = extent;
            }
        }
    }
    return count;
}

// A symbol is safe to INLINE (draw its content directly into whatever
// instances it, instead of a PackedScene sub-scene reference) only if
// there's nothing about it a flat list of composed elements could lose:
// no animation across frames, no frame script, no mask/masked layer (mask
// clipping is handled by _buildSceneTree/_processElementNode's own mask
// machinery, which a naive flatten-all-layers here would bypass).
function _isInlineableStaticSymbol(sym) {
    if (!sym || _symbolFrameCount(sym) > 1) return false;
    if (!sym.layers) return true;
    for (var l = 0; l < sym.layers.length; l++) {
        var layer = sym.layers[l];
        if (layer.layerType === "mask" || layer.layerType === "masked") return false;
        if (!layer.keyframes) continue;
        for (var k = 0; k < layer.keyframes.length; k++) {
            var kf = layer.keyframes[k];
            if (kf.actionScript && String(kf.actionScript).replace(/^\s+|\s+$/g, '') !== "") return false;
        }
    }
    return true;
}

// Replaces any "instance" element pointing at an _isInlineableStaticSymbol
// with that symbol's OWN elements directly (recursively -- a decoration can
// itself instance another static decoration), composing the instance's
// matrix/colorTransform/blendMode/visible into each inlined element exactly
// like _preprocessTweens' auto-tween expansion does. An instanced symbol
// that ISN'T inlineable (animated, scripted, or masked) is left as a normal
// PackedScene instance.
// `chain` (a name -> true set of symbols currently being expanded) guards
// against a pathological/circular instance graph: revisiting a symbol
// already on the chain leaves it as a real instance instead of recursing
// forever.
function _inlineStaticInstances(elements, symbolMap, chain) {
    var out = [];
    for (var e = 0; e < elements.length; e++) {
        var elem = elements[e];
        var innerSym = (elem.elementType === "instance" && elem.symbolName) ? symbolMap[elem.symbolName] : null;
        if (!innerSym || chain[elem.symbolName] || !_isInlineableStaticSymbol(innerSym)) {
            out.push(elem);
            continue;
        }

        var innerElements = [];
        if (innerSym.layers) {
            // Reverse layer order: the rest of this pipeline treats layer
            // index 0 as the TOPMOST (frontmost) Flash layer -- see
            // layerZIndex = (sym.layers.length - 1 - i) * 1000 + e in the
            // main element loop, which gives layer 0 the HIGHEST z. A flat
            // array's own index doubles as ITS z-order (higher index =
            // more front, same convention), so layer 0's elements need to
            // end up LAST here, not first -- walking layers 0..N forward
            // (the original code) put the frontmost layer's content
            // FIRST, silently reversing the stacking of every multi-layer
            // instance this function inlines. Confirmed on a real 17-layer
            // symbol instanced inside a variant orientation (OUTFIT): its
            // inlined content rendered in exactly the wrong front-to-back
            // order.
            for (var l = innerSym.layers.length - 1; l >= 0; l--) {
                var layer = innerSym.layers[l];
                if (layer.layerType === "guide" || layer.layerType === "folder") continue;
                if (!layer.keyframes) continue;
                for (var k = 0; k < layer.keyframes.length; k++) {
                    var kf = layer.keyframes[k];
                    if (!kf.elements) continue;
                    for (var ke = 0; ke < kf.elements.length; ke++) {
                        innerElements.push(kf.elements[ke]);
                    }
                }
            }
        }
        chain[elem.symbolName] = true;
        var expandedInner = _inlineStaticInstances(_flattenGroups(innerElements), symbolMap, chain);
        delete chain[elem.symbolName];

        for (var ei = 0; ei < expandedInner.length; ei++) {
            var innerElem = _deepClone(expandedInner[ei]);

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
            if (elem.blendMode && elem.blendMode !== "normal") innerElem.blendMode = elem.blendMode;
            if (elem.visible !== undefined && innerElem.visible === undefined) {
                innerElem.visible = elem.visible;
            } else if (elem.visible !== undefined && innerElem.visible !== undefined) {
                innerElem.visible = elem.visible && innerElem.visible;
            }
            if (elem.name) innerElem.name = elem.name;

            out.push(innerElem);
        }
    }
    return out;
}

// Finds, in `sym`'s layers, the content-carrying (non-guide/non-folder)
// keyframe covering `frameIdx` for the layer named `layerName` (or null if
// that symbol has no such layer, or nothing there at that frame).
function _findCoveringKeyframe(sym, layerName, frameIdx) {
    if (!sym.layers) return null;
    for (var l = 0; l < sym.layers.length; l++) {
        var layer = sym.layers[l];
        if (layer.name !== layerName || layer.layerType === "guide" || layer.layerType === "folder") continue;
        if (!layer.keyframes) return null;
        for (var k = 0; k < layer.keyframes.length; k++) {
            var kf = layer.keyframes[k];
            var dur = kf.duration || 1;
            if (frameIdx >= kf.startFrame && frameIdx < kf.startFrame + dur) return kf;
        }
        return null;
    }
    return null;
}

// Builds a SYNTHETIC symbol combining all of a variant group's orientations
// (FRONT/BACK/LEFT/RIGHT/...) as consecutive KEYFRAMES of ONE frameIdx,
// rather than as separate parallel subtrees -- this lets it go through
// _buildSceneTree completely unmodified and get the exact same treatment as
// any real Flash symbol with frame labels: shapes that occupy the same
// "slot" across orientations are POOLED into the same node (wrapper-reuse
// by stable occurrence index, already used for real keyframe-to-keyframe
// animation) instead of each orientation getting its own full copy of the
// node tree, and _processElementNode's existing value-track machinery
// drives each pooled node's polygon/uv/texture/visible per orientation.
// buildSceneForSymbol's normal "has frame labels" path then splits this
// into a RESET + one named (FRONT/BACK/...) animation per orientation in
// the AnimationLibrary -- gameplay still just calls
// AnimationPlayer.play("FRONT") exactly as before, but the underlying tree
// is shared instead of duplicated four times over.
// Layers are combined by NAME (the union of every orientation's non-guide
// layer names, in first-seen order) rather than by index, so orientations
// with a slightly different layer count/order still combine correctly --
// an orientation missing a given layer just contributes an empty keyframe
// for its slot on that layer.
function _buildOrientationSynthSymbol(group, orientNames, frameIdx, symbolMap, rootName) {
    var layerNames = [];
    var seen = {};
    for (var o = 0; o < orientNames.length; o++) {
        var part = group.parts[orientNames[o]];
        if (!part.layers) continue;
        for (var l = 0; l < part.layers.length; l++) {
            var layer = part.layers[l];
            if (layer.layerType === "guide" || layer.layerType === "folder") continue;
            if (!seen[layer.name]) { seen[layer.name] = true; layerNames.push(layer.name); }
        }
    }

    var combinedLayers = [];
    for (var li = 0; li < layerNames.length; li++) {
        var lname = layerNames[li];
        var perOrientElements = [];
        for (var o2 = 0; o2 < orientNames.length; o2++) {
            var covering = _findCoveringKeyframe(group.parts[orientNames[o2]], lname, frameIdx);
            // _flattenGroups first: an "instance" element can be nested
            // inside a Flash "group" (el.members), where
            // _inlineStaticInstances's flat top-level scan wouldn't see it.
            var elements = (covering && covering.elements)
                ? _inlineStaticInstances(_flattenGroups(covering.elements), symbolMap, {})
                : [];
            perOrientElements.push(elements);
        }

        // The rest of this pipeline treats these per-orientation element
        // lists as if they were consecutive keyframes of one real Flash
        // tween: raw shapes all share the same generic occKey ("shape"),
        // so the pooled node a shape lands on is picked by its RANK among
        // only-the-shapes of its own orientation (see allocateOrExtendWrapper
        // + _getOccKey) -- the Nth shape of one orientation reuses the same
        // node as the Nth shape of another. That's correct for genuinely
        // parallel artwork (LEFT/RIGHT mirrors, a real tween's matching
        // shape across frames) -- but some variant groups flatten (via
        // _inlineStaticInstances) to structurally unrelated content per
        // orientation (e.g. FRONT=23 raw shapes vs. BACK=2 merged shapes),
        // where "shape rank 6" in FRONT and "shape rank 6" in LEFT are
        // unrelated shapes that happen to share a rank -- pooling them
        // mixes their state: not just fill/stroke composition (one
        // orientation's :visible reset stomping another's), but also
        // Z-ORDER, since the pooled node's sibling position (hence paint
        // order) is decided once, by whichever orientation creates it
        // first, and then imposed on every other orientation reusing that
        // slot -- confirmed on a real 23-vs-2-vs-17-vs-17 case where two
        // DIFFERENT-colored fills at the same rank (both "poly-only", so
        // type-compatible) ended up pooled together, silently importing
        // FRONT's paint order into LEFT/RIGHT's rendering of an unrelated
        // piece.
        // Guard against that WITHOUT giving up pooling wholesale: only
        // split a given shape rank into separate per-orientation nodes when
        // the orientations that reach it actually disagree on a cheap
        // content signature (fill/stroke composition, count, and color/
        // gradient style of the first fill and first stroke) -- ranks
        // every orientation agrees on (the common case) stay pooled
        // exactly as before. Not airtight (two genuinely different shapes
        // could coincidentally share this signature at the same rank and
        // still get wrongly pooled), but a large, cheap improvement over
        // type-only matching.
        var shapeRankIdx = []; // per orientation: [indexIntoPerOrientElements, ...] for its "shape" elements, in order
        for (var o3 = 0; o3 < perOrientElements.length; o3++) {
            var ranks = [];
            for (var e3 = 0; e3 < perOrientElements[o3].length; e3++) {
                if (perOrientElements[o3][e3].elementType === "shape") ranks.push(e3);
            }
            shapeRankIdx.push(ranks);
        }
        var maxRank = 0;
        for (var o3b = 0; o3b < shapeRankIdx.length; o3b++) {
            if (shapeRankIdx[o3b].length > maxRank) maxRank = shapeRankIdx[o3b].length;
        }
        function _orientShapeSig(sEl) {
            var hasPolys = sEl.polygons && sEl.polygons.length > 0;
            var hasStrokes = sEl.strokes && sEl.strokes.length > 0;
            var sig = (hasPolys ? "p" : "") + (hasStrokes ? "s" : "");
            if (hasPolys) {
                var p0 = sEl.polygons[0];
                sig += "|" + sEl.polygons.length + "|" + (p0.gradient ? ("G:" + p0.gradient.style) : ("C:" + p0.color));
            }
            if (hasStrokes) {
                sig += "|" + sEl.strokes.length + "|" + (sEl.strokes[0].color || "");
            }
            return sig;
        }
        for (var r = 0; r < maxRank; r++) {
            var sig = null, mismatch = false;
            for (var o4 = 0; o4 < shapeRankIdx.length; o4++) {
                if (r >= shapeRankIdx[o4].length) continue;
                var sEl = perOrientElements[o4][shapeRankIdx[o4][r]];
                var thisSig = _orientShapeSig(sEl);
                if (sig === null) sig = thisSig;
                else if (sig !== thisSig) mismatch = true;
            }
            if (!mismatch) continue;
            for (var o5 = 0; o5 < shapeRankIdx.length; o5++) {
                if (r >= shapeRankIdx[o5].length) continue;
                var idx5 = shapeRankIdx[o5][r];
                var sEl2 = perOrientElements[o5][idx5];
                if (sEl2.name) continue;
                var clone = _shallowClone(sEl2);
                clone.name = "_orient_" + orientNames[o5] + "_" + r;
                perOrientElements[o5][idx5] = clone;
            }
        }

        // These synthetic "keyframes" are 4 unrelated orientations, never a
        // real Flash shape tween -- but _resolveElementNode can't tell the
        // difference from isStaticLayer alone: a variant layer always has
        // keyframes.length===4 (one per orientation slice), the same shape
        // as a genuine 4-keyframe tween, so it was attaching
        // TweenShapeMeshConverter.gd to every shape here (confirmed:
        // pointless work on real variant scenes, since orientation
        // switching is a hard swap, never a smooth polygon interpolation).
        // Tag every element so _resolveElementNode can recognize and skip
        // that case specifically. Shallow-cloned first: elements that
        // didn't need cloning above (the common case) are still the SAME
        // object _inlineStaticInstances/_flattenGroups returned, which can
        // be a shared reference (e.g. straight from symbolMap) reused by
        // an unrelated, later processing path outside this function --
        // mutating it in place would leak the flag there too.
        for (var ot = 0; ot < perOrientElements.length; ot++) {
            for (var et = 0; et < perOrientElements[ot].length; et++) {
                var cloneT = _shallowClone(perOrientElements[ot][et]);
                cloneT._isOrientationVariant = true;
                perOrientElements[ot][et] = cloneT;
            }
        }

        var keyframes = [];
        for (var o5 = 0; o5 < orientNames.length; o5++) {
            keyframes.push({
                startFrame: o5,
                duration: 1,
                name: orientNames[o5], // becomes this slice's AnimationLibrary label
                elements: perOrientElements[o5]
            });
        }
        combinedLayers.push({ name: lname, layerType: "normal", index: li, keyframes: keyframes });
    }

    return { name: rootName, layers: combinedLayers };
}

// A variant part's frames can themselves instance OTHER library symbols
// (e.g. a decorative sub-shape nested inside one hat design). Those show up
// as "instance" elements, which _processElementNode turns into a PackedScene
// ext_resource pointing at exportDir/symbols/<path>.tscn -- exactly like any
// normal, full buildGodotScenes export would produce, since it's the same
// _symbolPathInfo/RES_PREFIX logic either way. buildVariantScenes builds
// ONLY the variant parts themselves (frame-sliced, never as their own full
// standalone scene), so anything THEY reference must be built separately or
// Godot fails to load the resulting .tscn ("Cannot open file ...") --
// EXCEPT symbols eligible for inlining (_isInlineableStaticSymbol), which
// _buildOrientationSynthSymbol draws directly instead and therefore never
// need one.
// Walks the "instance" elements of `rootNames`' full timelines (not just one
// sliced frame -- different frames can reference different nested symbols)
// and returns every non-inlineable symbol transitively reachable from them,
// EXCLUDING the roots themselves.
function _collectSymbolDependencies(rootNames, symbolMap) {
    var visited = {};
    var toVisit = rootNames.slice();

    while (toVisit.length > 0) {
        var name = toVisit.pop();
        if (visited[name]) continue;
        visited[name] = true;
        var sym = symbolMap[name];
        if (!sym || !sym.layers) continue;
        for (var l = 0; l < sym.layers.length; l++) {
            var layer = sym.layers[l];
            if (!layer.keyframes) continue;
            for (var k = 0; k < layer.keyframes.length; k++) {
                var kf = layer.keyframes[k];
                if (!kf.elements) continue;
                // _flattenGroups: an "instance" element can be nested
                // inside a Flash "group" (el.members) -- see the same note
                // in _buildOrientationSynthSymbol.
                var flatElements = _flattenGroups(kf.elements);
                for (var e = 0; e < flatElements.length; e++) {
                    var el = flatElements[e];
                    if (el.elementType === "instance" && el.symbolName && !visited[el.symbolName]) {
                        toVisit.push(el.symbolName);
                    }
                }
            }
        }
    }

    var deps = [];
    var rootSet = {};
    for (var i = 0; i < rootNames.length; i++) rootSet[rootNames[i]] = true;
    for (var depName in visited) {
        if (rootSet[depName]) continue;
        if (_isInlineableStaticSymbol(symbolMap[depName])) continue; // drawn inline, no standalone scene needed
        deps.push(depName);
    }
    return deps;
}

// Entry point: scans the whole library for variant groups (HAT, ITEM, ...)
// and generates their combined per-frame scenes under
// exportDir/variants/<prefix>/<N>.tscn.
function buildVariantScenes(data, exportDir) {
    var uri = exportDir;
    if (uri.charAt(uri.length - 1) !== "/") uri += "/";
    _computeGodotProjectRoot(uri);

    var frameRate = (data.document && data.document.frameRate) || 25;
    var symbolMap = _buildSymbolMap(data.library.symbols);
    var symbolContainsShader = _computeShaderNeedsAndReferences(data.library.symbols).symbolContainsShader;

    var rawGroups = _findVariantGroups(data.library.symbols);
    var validGroups = [];
    var partNames = [];
    for (var g = 0; g < rawGroups.length; g++) {
        var group = rawGroups[g];
        var orientNames = [];
        for (var o = 0; o < _VARIANT_ORIENTATIONS.length; o++) {
            if (group.parts[_VARIANT_ORIENTATIONS[o]]) orientNames.push(_VARIANT_ORIENTATIONS[o]);
        }
        if (orientNames.length < 2) continue;

        var frameCount = -1;
        for (var o = 0; o < orientNames.length; o++) {
            var fc = _symbolFrameCount(group.parts[orientNames[o]]);
            if (frameCount === -1 || fc < frameCount) frameCount = fc;
        }
        if (frameCount <= 0) continue;

        for (var o = 0; o < orientNames.length; o++) partNames.push(group.parts[orientNames[o]].name);
        validGroups.push({ prefix: group.prefix, parts: group.parts, orientNames: orientNames, frameCount: frameCount });
    }

    // Build a standalone symbols/<path>.tscn (the exact same file a normal
    // buildGodotScenes export would produce) for every symbol the variant
    // parts' frames instance internally, so the PackedScene ext_resource
    // references emitted below actually resolve in Godot. See
    // _collectSymbolDependencies.
    var deps = _collectSymbolDependencies(partNames, symbolMap);
    for (var d = 0; d < deps.length; d++) {
        var depSym = symbolMap[deps[d]];
        if (depSym) buildSceneForSymbol(depSym, frameRate, uri, symbolMap, symbolContainsShader, {});
    }
    if (typeof fl !== "undefined" && deps.length > 0) fl.trace("buildVariantScenes: built " + deps.length
        + " nested dependency symbol(s) referenced by variant parts");

    var variantsRoot = uri + "variants/";
    if (validGroups.length > 0) FLfile.createFolder(variantsRoot);

    for (var g = 0; g < validGroups.length; g++) {
        var group = validGroups[g];
        var orientNames = group.orientNames;
        var frameCount = group.frameCount;

        var groupFolderName = _sanitize_name(group.prefix);
        var groupDir = variantsRoot + groupFolderName + "/";
        FLfile.createFolder(groupDir);
        if (typeof fl !== "undefined") fl.trace("buildVariantScenes: " + group.prefix + " -> " + frameCount
            + " frame(s) x " + orientNames.length + " orientation(s) [" + orientNames.join(",") + "]");

        for (var n = 0; n < frameCount; n++) {
            // Orientations are combined as consecutive KEYFRAMES of one
            // synthetic symbol (see _buildOrientationSynthSymbol), not as
            // separate parallel subtrees: _buildSceneTree pools shapes that
            // occupy the same "slot" across orientations into shared nodes
            // (its existing keyframe-to-keyframe wrapper reuse) and its
            // normal "has frame labels" path splits the result into a
            // RESET + one named (FRONT/BACK/...) animation per orientation
            // -- exactly the same AnimationPlayer.play("FRONT") interface
            // as before, with a much smaller shared tree underneath.
            var synthSym = _buildOrientationSynthSymbol(group, orientNames, n, symbolMap, groupFolderName + "_" + (n + 1));
            // Same reasoning as v4.15's skipEnablerFor: a variant scene is
            // always attached as equipment to a character, never placed
            // standalone -- the character's own subtree already handles
            // on/off-screen culling, so a VisibleOnScreenEnabler2D here
            // would just be a redundant node repeated on every single
            // frame of every group (thousands of instances).
            var skipEnablerForSelf = {};
            skipEnablerForSelf[synthSym.name] = true;
            var built = _buildSceneTree(synthSym, frameRate, uri, symbolMap, symbolContainsShader, skipEnablerForSelf);
            var tscnText = serializeTscn(built.root, built.extResources, built.subResources);
            FLfile.write(groupDir + (n + 1) + ".tscn", tscnText);
        }
    }
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
