import { createPipelineTraceRecorder } from './pipelineTrace.js';
import { createInitialPipelineContext } from './pipelineInitialContext.js';
import { selectInitialWatermarkCandidate } from './pipelineInitialSelection.js';
import { createRejectedPipelineResult } from './pipelineResult.js';
import { createAcceptedPipelineState } from './pipelineState.js';
import { createAcceptedPipelineRuntimeBootstrap } from './pipelineRuntimeBootstrap.js';
import { runAcceptedAlphaRepairPipeline } from './pipelineAcceptedExecutor.js';
import { createAcceptedPipelineExecutorRequest } from './pipelineAcceptedExecutorRequest.js';
import { createAcceptedPipelineFinalizationRequest } from './pipelineAcceptedFinalizationRequest.js';
import { createAcceptedPipelineFinalResult } from './pipelineFinalization.js';

export function runImageWatermarkPipeline({
    imageData,
    options = {},
    nowMs,
    cloneImageData,
    alphaGainCandidates,
    alphaPriorityGains,
    createAcceptedPipelineDependencies,
    cleanupConfig,
    visualPostProcessingEnabled = false,
    selectCandidate,
    runAcceptedPipeline = runAcceptedAlphaRepairPipeline,
    createRejectedResult = createRejectedPipelineResult,
    createAcceptedFinalResult = createAcceptedPipelineFinalResult
} = {}) {
    const totalStartedAt = nowMs();
    const debugTimingsEnabled = options.debugTimings === true;
    const debugTimings = debugTimingsEnabled ? {} : null;
    const {
        originalImageData,
        alpha48,
        alpha96,
        alphaGainCandidates: resolvedAlphaGainCandidates,
        alphaPriorityGains: resolvedAlphaPriorityGains,
        allowAdaptiveSearch,
        resolvedConfig,
        position
    } = createInitialPipelineContext({
        imageData,
        options,
        cloneImageData,
        alphaGainCandidates,
        alphaPriorityGains
    });
    const pipelineTraceRecorder = createPipelineTraceRecorder();

    const initialSelectionStartedAt = nowMs();
    const initialSelection = selectInitialWatermarkCandidate({
        originalImageData,
        config: resolvedConfig,
        position,
        alpha48,
        alpha96,
        alpha96Variants: options.alpha96Variants ?? null,
        getAlphaMap: options.getAlphaMap,
        allowAdaptiveSearch,
        aggressiveLocatedFallback: options.aggressiveLocatedFallback,
        alphaGainCandidates: resolvedAlphaGainCandidates,
        alphaPriorityGains: resolvedAlphaPriorityGains,
        selectCandidate
    });
    if (debugTimingsEnabled) {
        debugTimings.initialSelectionMs = nowMs() - initialSelectionStartedAt;
    }

    if (!initialSelection.selectedTrial) {
        if (debugTimingsEnabled) {
            debugTimings.totalMs = nowMs() - totalStartedAt;
        }
        return createRejectedResult({
            imageData: originalImageData,
            debugTimings,
            reason: 'no-watermark-detected',
            adaptiveConfidence: initialSelection.adaptiveConfidence,
            originalSpatialScore: initialSelection.standardSpatialScore,
            originalGradientScore: initialSelection.standardGradientScore,
            source: 'skipped',
            decisionTier: initialSelection.decisionTier ?? 'insufficient',
            selectionDebug: null
        });
    }

    const selectedTrial = initialSelection.selectedTrial;
    const acceptedPipelineState = createAcceptedPipelineState({ initialSelection });
    const runtimeBootstrap = createAcceptedPipelineRuntimeBootstrap({
        nowMs,
        acceptedPipelineState,
        selectedTrial,
        debugTimings,
        debugTimingsEnabled,
        cleanupConfig
    });
    const acceptedPipelineDependencies = createAcceptedPipelineDependencies();
    const acceptedPipelineRun = runAcceptedPipeline(createAcceptedPipelineExecutorRequest({
        nowMs,
        options,
        totalStartedAt,
        runtimeBootstrap,
        pipelineTraceRecorder,
        originalImageData,
        alpha96,
        debugTimings,
        debugTimingsEnabled,
        visualPostProcessingEnabled,
        templateWarp: acceptedPipelineState.templateWarp,
        subpixelShift: acceptedPipelineState.subpixelShift,
        acceptedPipelineDependencies
    }));

    return createAcceptedFinalResult(createAcceptedPipelineFinalizationRequest({
        acceptedPipelineRun,
        pipelineTraceRecorder,
        resultContext: {
            debugTimings,
            selectedTrial,
            selectionSource: initialSelection.source,
            adaptiveConfidence: acceptedPipelineState.adaptiveConfidence,
            templateWarp: acceptedPipelineState.templateWarp,
            decisionTier: acceptedPipelineState.decisionTier,
            subpixelShift: acceptedPipelineRun.subpixelShift
        },
        originalImageData,
        initialSelection,
        resolvedConfig
    }));
}
