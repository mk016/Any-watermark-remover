import { assessWatermarkResidualVisibility } from './restorationMetrics.js';
import { createSelectionDebugSummary } from './selectionDebug.js';
import { calculateWatermarkPosition } from './watermarkConfig.js';
import { createAcceptedPipelineResultFromState } from './pipelineResult.js';

export function createAcceptedPipelineFinalResult({
    pipelineState = {},
    passState = {},
    traceState = {},
    resultContext = {},
    originalImageData = null,
    initialSelection = null,
    resolvedConfig = null
} = {}) {
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData: pipelineState.finalImageData,
        position: pipelineState.position,
        alphaMap: pipelineState.alphaMap
    });
    const selectionSource = resultContext.selectionSource ?? initialSelection?.source ?? null;
    const initialPosition = originalImageData && resolvedConfig
        ? calculateWatermarkPosition(
            originalImageData.width,
            originalImageData.height,
            resolvedConfig
        )
        : null;
    const selectionDebug = createSelectionDebugSummary({
        selectedTrial: resultContext.selectedTrial,
        selectionSource,
        initialConfig: resolvedConfig,
        initialPosition
    });

    return createAcceptedPipelineResultFromState({
        pipelineState,
        passState,
        traceState,
        resultContext: {
            ...resultContext,
            selectionSource
        },
        residualVisibility,
        selectionDebug
    });
}
