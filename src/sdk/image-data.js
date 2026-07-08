import { interpolateAlphaMap } from '../core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../core/embeddedAlphaMaps.js';
import {
    WatermarkEngine,
    calculateWatermarkPosition,
    detectWatermarkConfig,
    removeRepeatedWatermarkLayers
} from '../core/watermarkEngine.js';
import { processWatermarkImageData } from '../core/watermarkProcessor.js';
import {
    detectGenericImageWatermark,
    removeGenericImageWatermark
} from '../core/genericWatermarkDetector.js';

export async function createWatermarkEngine() {
    return WatermarkEngine.create();
}

function buildEmbeddedGetAlphaMap(alpha48, alpha96) {
    return (size) => {
        if (size === 48) return alpha48;
        if (size === 96) return alpha96;
        return interpolateAlphaMap(alpha96, 96, size);
    };
}

// Gemini-only pipeline result. Returns true when no Gemini watermark was acted on.
function geminiResultSkipped(result) {
    return !result || !result.meta || result.meta.source === 'skipped' || result.meta.applied === false;
}

export function removeWatermarkFromImageDataSync(imageData, options = {}) {
    const mode = options.mode || 'gemini';

    if (mode === 'generic') {
        return removeGenericImageWatermark(imageData, options);
    }

    const alpha48 = options.alpha48 || getEmbeddedAlphaMap(48);
    const alpha96 = options.alpha96 || getEmbeddedAlphaMap(96);
    const alpha96Variants = options.alpha96Variants || {
        '20260520': getEmbeddedAlphaMap('96-20260520')
    };

    const gemini = processWatermarkImageData(imageData, {
        ...options,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap: options.getAlphaMap || buildEmbeddedGetAlphaMap(alpha48, alpha96)
    });

    if (mode === 'auto' && geminiResultSkipped(gemini)) {
        return removeGenericImageWatermark(imageData, options);
    }
    return gemini;
}

export async function removeWatermarkFromImageData(imageData, options = {}) {
    const mode = options.mode || 'gemini';

    if (mode === 'generic') {
        return removeGenericImageWatermark(imageData, options);
    }

    const engine = options.engine instanceof WatermarkEngine
        ? options.engine
        : await createWatermarkEngine();
    const alpha48 = await engine.getAlphaMap(48);
    const alpha96 = await engine.getAlphaMap(96);
    const alpha96Variants = options.alpha96Variants || {
        '20260520': await engine.getAlphaMap('96-20260520')
    };

    const gemini = processWatermarkImageData(imageData, {
        ...options,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap: options.getAlphaMap || buildEmbeddedGetAlphaMap(alpha48, alpha96)
    });

    if (mode === 'auto' && geminiResultSkipped(gemini)) {
        return removeGenericImageWatermark(imageData, options);
    }
    return gemini;
}

export {
    WatermarkEngine,
    calculateWatermarkPosition,
    detectWatermarkConfig,
    removeRepeatedWatermarkLayers,
    detectGenericImageWatermark,
    removeGenericImageWatermark
};
