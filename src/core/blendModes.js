/**
 * Reverse alpha blending module
 * Core algorithm for removing watermarks
 */

// Constants definition
const ALPHA_NOISE_FLOOR = 3 / 255; // Remove low-level quantization noise from alpha map
const ALPHA_THRESHOLD = 0.002;     // Ignore very small alpha values after noise floor removal
const MAX_ALPHA = 0.99;            // Avoid division by near-zero values
const LOGO_VALUE = 255;            // Color value for white watermark
const MAX_CHANNEL_DELTA = 40;      // Max per-channel change to prevent color blow-out

/**
 * Remove watermark using reverse alpha blending
 *
 * Principle:
 * Gemini adds watermark: watermarked = α × logo + (1 - α) × original
 * Reverse solve: original = (watermarked - α × logo) / (1 - α)
 *
 * Quality improvements:
 * - Per-channel delta clamping prevents color blow-out on low-alpha pixels
 * - Smooth alpha transition avoids hard edges at mask boundaries
 *
 * @param {ImageData} imageData - Image data to process (will be modified in place)
 * @param {Float32Array} alphaMap - Alpha channel data
 * @param {Object} position - Watermark position {x, y, width, height}
 * @param {Object} [options] - Optional settings
 * @param {number} [options.alphaGain=1] - Gain multiplier for alpha map strength
 */
export function removeWatermark(imageData, alphaMap, position, options = {}) {
    const { x, y, width, height } = position;
    const alphaGain = Number.isFinite(options.alphaGain) && options.alphaGain > 0
        ? options.alphaGain
        : 1;

    // Resolved logo color source precedence:
    //   options.logoColorMap  -> per-pixel RGB logo color (length 3 * width * height), generic detection
    //   options.logoColor     -> uniform RGB logo color [r,g,b]
    //   options.logoValue     -> uniform scalar (legacy Gemini white/dark via rawAlpha sign)
    const logoColorMap = options.logoColorMap instanceof Uint8ClampedArray
      || (options.logoColorMap instanceof Uint8Array && options.logoColorMap.length === width * height * 3)
        ? options.logoColorMap
        : null;
    const uniformLogoColor = Array.isArray(options.logoColor) && options.logoColor.length >= 3
      ? options.logoColor
      : null;

    // Determine max delta clamp; disable for the Gemini pipeline where the
    // alpha map is precise and the extra clamp could hurt quality.
    const maxDelta = logoColorMap ? MAX_CHANNEL_DELTA : Infinity;

    // Process each pixel in the watermark area
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            // Calculate index in original image (RGBA format, 4 bytes per pixel)
            const imgIdx = ((y + row) * imageData.width + (x + col)) * 4;

            // Calculate index in alpha map
            const alphaIdx = row * width + col;

            // Get alpha value. A negative alpha map marks a dark-polarity
            // watermark: same opacity mask, black logo value.
            const rawAlpha = alphaMap[alphaIdx];
            const alphaMagnitude = Math.abs(rawAlpha);
            const logoValue = Number.isFinite(options.logoValue)
                ? options.logoValue
                : (rawAlpha < 0 ? 0 : LOGO_VALUE);

            // Remove low-level alpha noise from compressed background capture.
            const signalAlpha = Math.max(0, alphaMagnitude - ALPHA_NOISE_FLOOR) * alphaGain;

            // Skip very small alpha values (noise)
            if (signalAlpha < ALPHA_THRESHOLD) {
                continue;
            }

            // Use original alpha for inverse solve; use denoised alpha as activation signal.
            const alpha = Math.min(alphaMagnitude * alphaGain, MAX_ALPHA);
            const oneMinusAlpha = 1.0 - alpha;

            // Apply reverse alpha blending to each RGB channel
            for (let c = 0; c < 3; c++) {
                const watermarked = imageData.data[imgIdx + c];
                const logoC = logoColorMap
                    ? logoColorMap[alphaIdx * 3 + c]
                    : (uniformLogoColor ? uniformLogoColor[c] : logoValue);

                // Reverse alpha blending formula
                const original = (watermarked - alpha * logoC) / oneMinusAlpha;

                // Clamp delta to prevent blow-out on noisy low-alpha pixels
                const delta = original - watermarked;
                const clampedOriginal = Math.abs(delta) > maxDelta
                    ? watermarked + Math.sign(delta) * maxDelta
                    : original;

                // Clip to [0, 255] range
                imageData.data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(clampedOriginal)));
            }

            // Alpha channel remains unchanged
            // imageData.data[imgIdx + 3] does not need modification
        }
    }
}
