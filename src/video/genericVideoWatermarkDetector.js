/**
 * Generic video watermark detector.
 *
 * Unlike the Gemini/VEO detector, this does not assume any specific logo shape,
 * size, or corner. It learns the watermark directly from the video frames using
 * the alpha-blend model:
 *
 *     I_t(x) = alpha(x) * Logo(x) + (1 - alpha(x)) * Content_t(x)
 *
 * A static, semi-transparent overlay compresses the per-pixel temporal dynamic
 * range by the factor (1 - alpha). We exploit that compression to localize the
 * watermark region anywhere in the frame, then estimate alpha(x) and Logo(x)
 * per pixel from the temporal min/max statistics.
 *
 * This is what lets the tool remove arbitrary watermarks (e.g. NotebookLM,
 * branded overlays) that the Gemini-only catalog can never match.
 */

const DEFAULT_DET_MAX_DIM = 512;
const DEFAULT_MAX_FRAMES = 48;
const DEFAULT_SCORE_THRESHOLD = 0.08;
const DEFAULT_MIN_CONFIDENCE = 0.10;
const DEFAULT_MARGIN_RATIO = 0.10;
const DEFAULT_BLUR_RADIUS = 18;
const DEFAULT_MIN_REGION_FRACTION = 0.0004;
const FEATHER_RADIUS = 4;

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

function lumaOf(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Box downscale of an RGBA ImageData to (dw, dh) via averaged blocks.
// Returns Float32Arrays rDet, gDet, bDet (length dw*dh).
function boxDownscale(imageData, dw, dh) {
    const { width: sw, height: sh, data } = imageData;
    const rDet = new Float32Array(dw * dh);
    const gDet = new Float32Array(dw * dh);
    const bDet = new Float32Array(dw * dh);
    const sxStep = sw / dw;
    const syStep = sh / dh;
    for (let dy = 0; dy < dh; dy++) {
        const y0 = Math.floor(dy * syStep);
        const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * syStep));
        for (let dx = 0; dx < dw; dx++) {
            const x0 = Math.floor(dx * sxStep);
            const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * sxStep));
            let sr = 0;
            let sg = 0;
            let sb = 0;
            let count = 0;
            for (let y = y0; y < y1; y++) {
                let idx = (y * sw + x0) * 4;
                for (let x = x0; x < x1; x++) {
                    sr += data[idx];
                    sg += data[idx + 1];
                    sb += data[idx + 2];
                    count++;
                    idx += 4;
                }
            }
            const inv = count > 0 ? 1 / count : 0;
            const o = dy * dw + dx;
            rDet[o] = sr * inv;
            gDet[o] = sg * inv;
            bDet[o] = sb * inv;
        }
    }
    return { rDet, gDet, bDet };
}

// Separable box blur (approximates Gaussian over several passes) on a Float32 map.
function boxBlur(src, w, h, radius) {
    if (radius <= 0) return src;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const r = Math.max(1, Math.round(radius));
    const norm = 1 / (2 * r + 1);
    // horizontal
    for (let y = 0; y < h; y++) {
        let acc = 0;
        const row = y * w;
        for (let i = -r; i <= r; i++) {
            const xx = Math.min(w - 1, Math.max(0, i));
            acc += src[row + xx];
        }
        for (let x = 0; x < w; x++) {
            tmp[row + x] = acc * norm;
            const addX = Math.min(w - 1, x + r + 1);
            const subX = Math.max(0, x - r);
            acc += src[row + addX] - src[row + subX];
        }
    }
    // vertical
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
            const yy = Math.min(h - 1, Math.max(0, i));
            acc += tmp[yy * w + x];
        }
        for (let y = 0; y < h; y++) {
            out[y * w + x] = acc * norm;
            const addY = Math.min(h - 1, y + r + 1);
            const subY = Math.max(0, y - r);
            acc += tmp[addY * w + x] - tmp[subY * w + x];
        }
    }
    return out;
}

function sampleBilinear(arr, w, h, fx, fy) {
    if (fx < 0) fx = 0;
    if (fy < 0) fy = 0;
    if (fx > w - 1) fx = w - 1;
    if (fy > h - 1) fy = h - 1;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = arr[y0 * w + x0];
    const b = arr[y0 * w + x1];
    const c = arr[y1 * w + x0];
    const d = arr[y1 * w + x1];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/**
 * Detect a generic (shape-agnostic) watermark from sampled video frames.
 *
 * @param {Object} args
 * @param {Array<{timestamp:number, imageData:ImageData}>} args.frames
 * @param {number} args.width  full-resolution frame width
 * @param {number} args.height full-resolution frame height
 * @param {Object} [args.options]
 * @returns {Object} detection compatible with processWatermarkRoiAsync
 */
export function detectGenericVideoWatermarkFromFrames({ frames, width, height, options = {} }) {
    const detMaxDim = Number.isFinite(options.detMaxDim) && options.detMaxDim > 0
        ? options.detMaxDim
        : DEFAULT_DET_MAX_DIM;
    const maxFrames = Number.isFinite(options.maxFrames) && options.maxFrames > 0
        ? options.maxFrames
        : DEFAULT_MAX_FRAMES;
    const scoreThreshold = Number.isFinite(options.scoreThreshold)
        ? options.scoreThreshold
        : DEFAULT_SCORE_THRESHOLD;
    const minConfidence = Number.isFinite(options.minConfidence)
        ? options.minConfidence
        : DEFAULT_MIN_CONFIDENCE;
    const marginRatio = Number.isFinite(options.marginRatio) ? options.marginRatio : DEFAULT_MARGIN_RATIO;
    const blurRadius = Number.isFinite(options.blurRadius) ? options.blurRadius : DEFAULT_BLUR_RADIUS;
    const minRegionFraction = Number.isFinite(options.minRegionFraction)
        ? options.minRegionFraction
        : DEFAULT_MIN_REGION_FRACTION;

    const notDetected = (reason) => ({
        detected: false,
        isConfident: false,
        confidence: 0,
        reason,
        framesAnalyzed: frames ? frames.length : 0,
        position: null,
        alphaMap: null,
        logoColorMap: null
    });

    if (!frames || frames.length < 2) {
        return notDetected('need-at-least-two-frames');
    }

    // Detection resolution (preserve aspect).
    let detW = width;
    let detH = height;
    const longest = Math.max(width, height);
    if (longest > detMaxDim) {
        const scale = detMaxDim / longest;
        detW = Math.max(8, Math.round(width * scale));
        detH = Math.max(8, Math.round(height * scale));
    }

    // Evenly subsample frames to bound cost on very long videos.
    const chosen = [];
    const stride = Math.max(1, Math.ceil(frames.length / maxFrames));
    for (let i = 0; i < frames.length; i += stride) {
        chosen.push(frames[i]);
    }
    if (chosen.length < 2) chosen.push(frames[frames.length - 1]);

    const detCount = detW * detH;
    const minLuma = new Float32Array(detCount).fill(Infinity);
    const maxLuma = new Float32Array(detCount).fill(-Infinity);
    const loR = new Float32Array(detCount).fill(0);
    const loG = new Float32Array(detCount).fill(0);
    const loB = new Float32Array(detCount).fill(0);

    for (const frame of chosen) {
        const { rDet, gDet, bDet } = boxDownscale(frame.imageData, detW, detH);
        for (let p = 0; p < detCount; p++) {
            const r = rDet[p];
            const g = gDet[p];
            const b = bDet[p];
            const lum = lumaOf(r, g, b);
            if (lum < minLuma[p]) {
                minLuma[p] = lum;
                loR[p] = r;
                loG[p] = g;
                loB[p] = b;
            }
            if (lum > maxLuma[p]) {
                maxLuma[p] = lum;
            }
        }
    }

    // Per-pixel temporal dynamic range (luma) of the observed frames.
    const drLuma = new Float32Array(detCount);
    for (let p = 0; p < detCount; p++) {
        drLuma[p] = Math.max(0, maxLuma[p] - minLuma[p]);
    }

    // Smoothed range estimates the neighborhood content range WITHOUT the watermark.
    const smooth = boxBlur(boxBlur(drLuma, detW, detH, blurRadius), detW, detH, blurRadius);

    const alphaMapDet = new Float32Array(detCount);
    const logoRDet = new Float32Array(detCount);
    const logoGDet = new Float32Array(detCount);
    const logoBDet = new Float32Array(detCount);
    const scoreMap = new Float32Array(detCount);

    let bestMeanLogo = 0;
    let bestLogoCount = 0;

    for (let p = 0; p < detCount; p++) {
        const neighborhoodRange = Math.max(smooth[p], 1);
        const compression = drLuma[p] / neighborhoodRange; // ~1 outside, <1 inside watermark
        // A genuine watermark both compresses the range AND sits below the local content range.
        const isCompressed = compression < 0.97 && drLuma[p] < neighborhoodRange * 0.97;
        const score = isCompressed ? clamp01(1 - compression) : 0;
        scoreMap[p] = score;
        if (score <= 0) continue;

        // Estimate alpha more carefully: use the ratio of observed range to
        // neighborhood range, then re-estimate by per-channel min/max spread.
        const alpha = clamp01(1 - compression);
        alphaMapDet[p] = alpha;

        // Recover the logo color under the watermark.
        const safeAlpha = Math.max(alpha, 0.04);
        const lr = clampByte(loR[p] / safeAlpha);
        const lg = clampByte(loG[p] / safeAlpha);
        const lb = clampByte(loB[p] / safeAlpha);
        logoRDet[p] = lr;
        logoGDet[p] = lg;
        logoBDet[p] = lb;
        bestMeanLogo += (lr + lg + lb) / 3;
        bestLogoCount++;
    }

    // Localize: bounding box of the strong-score region.
    let minX = detW;
    let minY = detH;
    let maxX = -1;
    let maxY = -1;
    let scoreSum = 0;
    let scoreCount = 0;
    for (let y = 0; y < detH; y++) {
        for (let x = 0; x < detW; x++) {
            const p = y * detW + x;
            if (scoreMap[p] < scoreThreshold) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            scoreSum += scoreMap[p];
            scoreCount++;
        }
    }

    if (scoreCount === 0) {
        return notDetected('no-watermark-region');
    }

    const regionWDet = maxX - minX + 1;
    const regionHDet = maxY - minY + 1;
    const frameArea = width * height;
    const regionAreaFull = (regionWDet / detW) * width * (regionHDet / detH) * height;
    if (regionAreaFull / frameArea < minRegionFraction) {
        return notDetected('region-too-small');
    }

    const marginX = Math.round(regionWDet * marginRatio);
    const marginY = Math.round(regionHDet * marginRatio);
    minX = Math.max(0, minX - marginX);
    minY = Math.max(0, minY - marginY);
    maxX = Math.min(detW - 1, maxX + marginX);
    maxY = Math.min(detH - 1, maxY + marginY);

    const scaleX = width / detW;
    const scaleY = height / detH;
    let xFull = Math.round(minX * scaleX);
    let yFull = Math.round(minY * scaleY);
    let regionW = Math.max(8, Math.round((maxX - minX + 1) * scaleX));
    let regionH = Math.max(8, Math.round((maxY - minY + 1) * scaleY));
    xFull = Math.min(Math.max(0, xFull), width - regionW);
    yFull = Math.min(Math.max(0, yFull), height - regionH);

    const regionCount = regionW * regionH;
    const rawAlphaMap = new Float32Array(regionCount);
    const logoColorMap = new Uint8ClampedArray(regionCount * 3);
    for (let ry = 0; ry < regionH; ry++) {
        const fy = ry / scaleY;
        for (let rx = 0; rx < regionW; rx++) {
            const fx = rx / scaleX;
            const a = clamp01(sampleBilinear(alphaMapDet, detW, detH, fx, fy));
            const lr = sampleBilinear(logoRDet, detW, detH, fx, fy);
            const lg = sampleBilinear(logoGDet, detW, detH, fx, fy);
            const lb = sampleBilinear(logoBDet, detW, detH, fx, fy);
            const o = ry * regionW + rx;
            rawAlphaMap[o] = a;
            logoColorMap[o * 3] = clampByte(lr);
            logoColorMap[o * 3 + 1] = clampByte(lg);
            logoColorMap[o * 3 + 2] = clampByte(lb);
        }
    }

    // Feather edges of the alpha map so removal blends seamlessly.
    const alphaMap = featherAlphaEdges(rawAlphaMap, regionW, regionH, FEATHER_RADIUS);

    const confidence = scoreCount > 0 ? scoreSum / scoreCount : 0;
    const meanLogo = bestLogoCount > 0 ? bestMeanLogo / bestLogoCount : 128;
    const polarity = meanLogo >= 128 ? 'light' : 'dark';

    return {
        detected: true,
        isConfident: confidence >= minConfidence,
        confidence,
        detector: 'generic-video',
        framesAnalyzed: chosen.length,
        position: {
            x: xFull,
            y: yFull,
            width: regionW,
            height: regionH,
            marginRight: width - xFull - regionW,
            marginBottom: height - yFull - regionH,
            videoWidth: width,
            videoHeight: height
        },
        alphaMap,
        logoColorMap,
        logoValue: polarity === 'dark' ? 0 : 255,
        polarity,
        alphaSeed: { seedGain: 1 },
        score: confidence
    };
}

/**
 * Feather the edges of an alpha map for smooth blending at region boundaries.
 * Box-blurs and then takes the max of original and blurred so the core of
 * the watermark stays full-strength while edges taper off.
 */
function featherAlphaEdges(alpha, w, h, radius) {
    if (radius <= 0) return alpha;
    const blurred = boxBlur(alpha, w, h, radius);
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) {
        out[i] = Math.max(alpha[i], blurred[i]);
    }
    return out;
}

export { boxDownscale, boxBlur, sampleBilinear, featherAlphaEdges };
