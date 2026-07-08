/**
 * Generic image watermark detector + removal.
 *
 * Unlike the Gemini path, this does not assume a known logo shape or size. It
 * assumes the watermark is a semi-transparent overlay (alpha blend) anchored to
 * a border zone of the image, which covers the overwhelming majority of real
 * watermarks (corner / edge logos, studio bugs, branded overlays).
 *
 * For a single still image there is no temporal signal, so we:
 *   1. Propose border-anchored candidate regions at several sizes.
 *   2. Estimate the smooth background behind the overlay (heavy box blur).
 *   3. For a white-logo and a dark-logo hypothesis, solve the per-pixel alpha
 *      and recovered logo color, then score how coherent the result is.
 *   4. Keep the best-scoring region and feed its learned alpha map + logo color
 *      into the same inverse-alpha solver used everywhere else.
 *
 * Note: a watermark centered over busy content on a single image is not
 * generally recoverable without outpainting; this detector targets the common
 * border-anchored case, which is what "auto-detect where it is" needs.
 */

import { removeWatermark } from './blendModes.js';

const DEFAULT_MIN_CONFIDENCE = 0.12;
const DEFAULT_SIZE_FRACTIONS = Object.freeze([0.08, 0.12, 0.14, 0.2, 0.28, 0.38]);
const DEFAULT_MIN_REGION = 16;
const DEFAULT_MAX_REGION = 640;
const FEATHER_RADIUS = 3;
const ANCHORS = Object.freeze([
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
    'top-center',
    'bottom-center',
    'left-center',
    'right-center',
    'center'
]);

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function splitChannels(imageData) {
    const { width, height, data } = imageData;
    const n = width * height;
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const idx = i * 4;
        r[i] = data[idx];
        g[i] = data[idx + 1];
        b[i] = data[idx + 2];
    }
    return { r, g, b, width, height };
}

function boxBlurSingle(src, w, h, radius) {
    if (radius <= 0) return src;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const rr = Math.max(1, Math.round(radius));
    const norm = 1 / (2 * rr + 1);
    for (let y = 0; y < h; y++) {
        let acc = 0;
        const row = y * w;
        for (let i = -rr; i <= rr; i++) acc += src[row + clamp(i, 0, w - 1)];
        for (let x = 0; x < w; x++) {
            tmp[row + x] = acc * norm;
            acc += src[row + clamp(x + rr + 1, 0, w - 1)] - src[row + clamp(x - rr, 0, w - 1)];
        }
    }
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -rr; i <= rr; i++) acc += tmp[clamp(i, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
            out[y * w + x] = acc * norm;
            acc += tmp[clamp(y + rr + 1, 0, h - 1) * w + x] - tmp[clamp(y - rr, 0, h - 1) * w + x];
        }
    }
    return out;
}

function anchorRect(anchor, w, h, size, margin) {
    const m = margin;
    switch (anchor) {
        case 'top-left': return { x: m, y: m, width: size, height: size };
        case 'top-right': return { x: w - size - m, y: m, width: size, height: size };
        case 'bottom-left': return { x: m, y: h - size - m, width: size, height: size };
        case 'bottom-right': return { x: w - size - m, y: h - size - m, width: size, height: size };
        case 'top-center': return { x: Math.round((w - size) / 2), y: m, width: size, height: size };
        case 'bottom-center': return { x: Math.round((w - size) / 2), y: h - size - m, width: size, height: size };
        case 'left-center': return { x: m, y: Math.round((h - size) / 2), width: size, height: size };
        case 'right-center': return { x: w - size - m, y: Math.round((h - size) / 2), width: size, height: size };
        case 'center': return { x: Math.round((w - size) / 2), y: Math.round((h - size) / 2), width: size, height: size };
        default: return null;
    }
}

/**
 * Feather the edges of an alpha map so removal blends smoothly into the
 * surrounding image. This avoids hard seams at the mask boundary.
 */
function featherAlphaMap(alphaMap, rw, rh, radius) {
    if (radius <= 0) return alphaMap;
    // Box-blur the alpha map in-place (approximation of Gaussian feather).
    const tmp = new Float32Array(rw * rh);
    const out = new Float32Array(rw * rh);
    const r = Math.max(1, Math.round(radius));
    const norm = 1 / (2 * r + 1);
    // horizontal pass
    for (let y = 0; y < rh; y++) {
        let acc = 0;
        const row = y * rw;
        for (let i = -r; i <= r; i++) acc += alphaMap[row + clamp(i, 0, rw - 1)];
        for (let x = 0; x < rw; x++) {
            tmp[row + x] = acc * norm;
            acc += alphaMap[row + clamp(x + r + 1, 0, rw - 1)] - alphaMap[row + clamp(x - r, 0, rw - 1)];
        }
    }
    // vertical pass
    for (let x = 0; x < rw; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += tmp[clamp(i, 0, rh - 1) * rw + x];
        for (let y = 0; y < rh; y++) {
            out[y * rw + x] = acc * norm;
            acc += tmp[clamp(y + r + 1, 0, rh - 1) * rw + x] - tmp[clamp(y - r, 0, rh - 1) * rw + x];
        }
    }
    // Use the maximum of the original and blurred value so the core stays
    // strong while the edges taper off smoothly.
    for (let i = 0; i < alphaMap.length; i++) {
        out[i] = Math.max(alphaMap[i], out[i]);
    }
    return out;
}

function evaluateCandidate(channels, rect, hypothesis) {
    const { r, g, b, width: w, height: h } = channels;
    const { x, y, width: rw, height: rh } = rect;
    const n = rw * rh;
    const blurRadius = Math.max(4, Math.round(Math.max(rw, rh) * 0.22));
    const bgR = boxBlurSingle(r, w, h, blurRadius);
    const bgG = boxBlurSingle(g, w, h, blurRadius);
    const bgB = boxBlurSingle(b, w, h, blurRadius);

    const alphaMap = new Float32Array(n);
    const logoR = new Float32Array(n);
    const logoG = new Float32Array(n);
    const logoB = new Float32Array(n);

    let coverage = 0;
    let alphaSum = 0;
    let lSum = 0;
    let lSumSq = 0;
    let lCount = 0;
    let edgeAlphaSum = 0;
    let edgeCount = 0;

    for (let yy = 0; yy < rh; yy++) {
        for (let xx = 0; xx < rw; xx++) {
            const si = (y + yy) * w + (x + xx);
            const o = yy * rw + xx;
            const ir = r[si];
            const ig = g[si];
            const ib = b[si];
            const br = bgR[si];
            const bg = bgG[si];
            const bb = bgB[si];

            // Per-channel alpha for the chosen hypothesis.
            let ar;
            let ag;
            let ab;
            if (hypothesis === 'dark') {
                ar = clamp(ir / Math.max(br, 1), 0, 1);
                ag = clamp(ig / Math.max(bg, 1), 0, 1);
                ab = clamp(ib / Math.max(bb, 1), 0, 1);
            } else {
                ar = clamp((255 - ir) / Math.max(255 - br, 1), 0, 1);
                ag = clamp((255 - ig) / Math.max(255 - bg, 1), 0, 1);
                ab = clamp((255 - ib) / Math.max(255 - bb, 1), 0, 1);
            }
            const alpha = (ar + ag + ab) / 3;
            alphaMap[o] = alpha;
            if (alpha >= 0.03 && alpha <= 0.92) coverage++;
            alphaSum += alpha;

            // Track edge alpha to penalize candidates where the region edge is
            // opaque (sign it's part of the image, not a watermark).
            const isEdge = xx <= 1 || yy <= 1 || xx >= rw - 2 || yy >= rh - 2;
            if (isEdge) {
                edgeAlphaSum += alpha;
                edgeCount++;
            }

            const safeA = Math.max(alpha, 0.05);
            const lr = clamp((ir - (1 - alpha) * br) / safeA, 0, 255);
            const lg = clamp((ig - (1 - alpha) * bg) / safeA, 0, 255);
            const lb = clamp((ib - (1 - alpha) * bb) / safeA, 0, 255);
            logoR[o] = lr;
            logoG[o] = lg;
            logoB[o] = lb;
            const lMean = (lr + lg + lb) / 3;
            lSum += lMean;
            lSumSq += lMean * lMean;
            lCount++;
        }
    }

    const coverageFrac = coverage / n;
    const meanAlpha = alphaSum / n;
    const meanL = lCount > 0 ? lSum / lCount : 128;
    const varL = lCount > 0 ? Math.max(0, lSumSq / lCount - meanL * meanL) : 0;
    const stdL = Math.sqrt(varL);
    const logoConsistency = clamp(1 - stdL / 100, 0, 1);

    // Penalize if edges of the region have high alpha (likely image content).
    const meanEdgeAlpha = edgeCount > 0 ? edgeAlphaSum / edgeCount : 0;
    const edgePenalty = clamp(1 - meanEdgeAlpha * 2, 0.2, 1);

    // A real watermark region has a coherent, non-empty overlay.
    const magnitudeScore = clamp(meanAlpha / 0.2, 0, 1);
    const score = coverageFrac * logoConsistency * magnitudeScore * edgePenalty;
    return { score, coverageFrac, meanAlpha, meanL, alphaMap, logoR, logoG, logoB, rect, hypothesis };
}

/**
 * Detect a generic (shape-agnostic) watermark on a single image.
 * @returns {Object} { detected, position, alphaMap, logoColorMap, logoValue, polarity, confidence }
 */
export function detectGenericImageWatermark(imageData, options = {}) {
    const w = imageData.width;
    const h = imageData.height;
    const minConfidence = Number.isFinite(options.minConfidence)
        ? options.minConfidence
        : DEFAULT_MIN_CONFIDENCE;
    const sizeFractions = Array.isArray(options.sizeFractions) && options.sizeFractions.length
        ? options.sizeFractions
        : DEFAULT_SIZE_FRACTIONS;
    const margin = Number.isFinite(options.margin) ? options.margin : Math.round(Math.min(w, h) * 0.02);
    const minSpan = Math.min(w, h);

    const notDetected = (reason) => ({
        detected: false,
        isConfident: false,
        confidence: 0,
        reason,
        position: null,
        alphaMap: null,
        logoColorMap: null
    });

    if (minSpan < DEFAULT_MIN_REGION + margin * 2) {
        return notDetected('image-too-small');
    }

    const channels = splitChannels(imageData);
    let best = null;
    for (const anchor of ANCHORS) {
        for (const frac of sizeFractions) {
            let size = Math.round(minSpan * frac);
            size = clamp(size, DEFAULT_MIN_REGION, DEFAULT_MAX_REGION);
            const rect = anchorRect(anchor, w, h, size, margin);
            if (!rect || rect.x < 0 || rect.y < 0 || rect.x + rect.width > w || rect.y + rect.height > h) {
                continue;
            }
            for (const hypothesis of ['light', 'dark']) {
                const cand = evaluateCandidate(channels, rect, hypothesis);
                if (cand.coverageFrac < 0.12) continue;
                if (!best || cand.score > best.score) {
                    best = cand;
                }
            }
        }
    }

    if (!best || best.score < minConfidence) {
        return notDetected('no-watermark-region');
    }

    const { rect, alphaMap: rawAlphaMap, logoR, logoG, logoB } = best;
    const n = rect.width * rect.height;

    // Feather alpha map edges for seamless blending into surrounding image.
    const alphaMap = featherAlphaMap(rawAlphaMap, rect.width, rect.height, FEATHER_RADIUS);

    const logoColorMap = new Uint8ClampedArray(n * 3);
    for (let i = 0; i < n; i++) {
        logoColorMap[i * 3] = logoR[i];
        logoColorMap[i * 3 + 1] = logoG[i];
        logoColorMap[i * 3 + 2] = logoB[i];
    }

    return {
        detected: true,
        isConfident: true,
        confidence: best.score,
        detector: 'generic-image',
        position: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            marginRight: w - rect.x - rect.width,
            marginBottom: h - rect.y - rect.height
        },
        alphaMap,
        logoColorMap,
        logoValue: best.hypothesis === 'dark' ? 0 : 255,
        polarity: best.hypothesis,
        alphaSeed: { seedGain: 1 },
        score: best.score
    };
}

/**
 * Remove a generic watermark from an image using the learned overlay.
 * Applies multi-pass removal with edge blending for quality preservation.
 * @param {ImageData} imageData mutated in place
 * @returns {Object} { imageData, meta }
 */
export function removeGenericImageWatermark(imageData, options = {}) {
    const detection = options.detection || detectGenericImageWatermark(imageData, options);
    if (!detection || !detection.detected) {
        return {
            imageData,
            meta: {
                detected: false,
                reason: detection?.reason || 'no-watermark',
                detector: 'generic-image'
            }
        };
    }

    const { position, alphaMap, logoColorMap, logoValue } = detection;
    const alphaGain = Number.isFinite(options.alphaGain) && options.alphaGain > 0 ? options.alphaGain : 1;

    // Pass 1: primary inverse-alpha removal
    const region = extractRegion(imageData, position);
    removeWatermark(region, alphaMap, {
        x: 0,
        y: 0,
        width: region.width,
        height: region.height
    }, {
        alphaGain,
        logoColorMap,
        logoValue
    });

    // Pass 2: edge-aware color matching — blend boundary pixels with their
    // outside neighbors so the transition from restored to untouched is smooth.
    blendRegionEdges(region, alphaMap, imageData, position);

    writeRegion(imageData, region, position);
    return {
        imageData,
        meta: {
            detected: true,
            detector: 'generic-image',
            position,
            confidence: detection.confidence
        }
    };
}

/**
 * Blend the boundary of the restored region with the surrounding image so
 * there is no visible seam. Pixels near the mask edge are averaged with
 * their unmask-adjacent neighbors weighted by their alpha proximity.
 */
function blendRegionEdges(region, alphaMap, fullImage, position) {
    const { width: rw, height: rh } = region;
    const { x: px, y: py, width: pw, height: ph } = position;
    const fullW = fullImage.width;
    const fullH = fullImage.height;
    const blendRadius = 2;
    const alphaEdgeMax = 0.15; // only blend low-alpha edge pixels

    for (let ry = 0; ry < rh; ry++) {
        for (let rx = 0; rx < rw; rx++) {
            const a = alphaMap[ry * rw + rx];
            if (a <= 0.005 || a > alphaEdgeMax) continue;

            let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
            for (let dy = -blendRadius; dy <= blendRadius; dy++) {
                for (let dx = -blendRadius; dx <= blendRadius; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = px + rx + dx;
                    const ny = py + ry + dy;
                    if (nx < 0 || ny < 0 || nx >= fullW || ny >= fullH) continue;
                    // Prefer neighbors outside the watermark region
                    const inRegion = nx >= px && nx < px + pw && ny >= py && ny < py + ph;
                    let neighborAlpha = 0;
                    if (inRegion) {
                        neighborAlpha = alphaMap[(ny - py) * rw + (nx - px)] || 0;
                    }
                    if (neighborAlpha > 0.1) continue; // skip watermark-affected neighbors
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const w = 1 / dist;
                    const fi = (ny * fullW + nx) * 4;
                    sumR += fullImage.data[fi] * w;
                    sumG += fullImage.data[fi + 1] * w;
                    sumB += fullImage.data[fi + 2] * w;
                    sumW += w;
                }
            }
            if (sumW <= 0) continue;

            const blend = clamp(a / alphaEdgeMax, 0, 0.7); // gentle blend
            const ri = (ry * rw + rx) * 4;
            region.data[ri] = Math.round(region.data[ri] * (1 - blend) + (sumR / sumW) * blend);
            region.data[ri + 1] = Math.round(region.data[ri + 1] * (1 - blend) + (sumG / sumW) * blend);
            region.data[ri + 2] = Math.round(region.data[ri + 2] * (1 - blend) + (sumB / sumW) * blend);
        }
    }
}

function extractRegion(imageData, position) {
    const { x, y, width, height } = position;
    const out = typeof ImageData !== 'undefined'
        ? new ImageData(width, height)
        : { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let ry = 0; ry < height; ry++) {
        for (let rx = 0; rx < width; rx++) {
            const si = ((y + ry) * imageData.width + (x + rx)) * 4;
            const di = (ry * width + rx) * 4;
            out.data[di] = imageData.data[si];
            out.data[di + 1] = imageData.data[si + 1];
            out.data[di + 2] = imageData.data[si + 2];
            out.data[di + 3] = imageData.data[si + 3];
        }
    }
    return out;
}

function writeRegion(imageData, region, position) {
    const { x, y, width, height } = position;
    for (let ry = 0; ry < height; ry++) {
        for (let rx = 0; rx < width; rx++) {
            const si = (ry * width + rx) * 4;
            const di = ((y + ry) * imageData.width + (x + rx)) * 4;
            imageData.data[di] = region.data[si];
            imageData.data[di + 1] = region.data[si + 1];
            imageData.data[di + 2] = region.data[si + 2];
            imageData.data[di + 3] = region.data[si + 3];
        }
    }
}

export { splitChannels, boxBlurSingle, anchorRect, featherAlphaMap };
