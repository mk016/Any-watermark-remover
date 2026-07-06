import test from 'node:test';
import assert from 'node:assert/strict';

import { createAcceptedPipelineFinalResult } from '../../src/core/pipelineFinalization.js';
import {
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

test('createAcceptedPipelineFinalResult should finalize accepted result metadata from state', () => {
    const imageData = createPatternImageData(128, 128);
    const alphaMap = createSyntheticAlphaMap(48);
    const position = { x: 48, y: 48, width: 48, height: 48 };
    const result = createAcceptedPipelineFinalResult({
        pipelineState: {
            finalImageData: imageData,
            alphaMap,
            position,
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            alphaGain: 0.9,
            alphaMapSource: 'catalog',
            originalSpatialScore: 0.7,
            originalGradientScore: 0.6,
            finalProcessedSpatialScore: 0.08,
            finalProcessedGradientScore: 0.05,
            suppressionGain: 0.62,
            source: 'standard+fine-alpha'
        },
        passState: {
            passCount: 1,
            attemptedPassCount: 1,
            passStopReason: 'residual-low',
            passes: [{ index: 1 }]
        },
        traceState: {
            alphaAdjustmentStages: [{ stage: 'fine-alpha' }],
            alphaTrialEvents: [{ stage: 'fine-alpha', decision: 'accept' }]
        },
        resultContext: {
            debugTimings: { totalMs: 10 },
            selectedTrial: {
                config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
                position
            },
            adaptiveConfidence: 0.8,
            templateWarp: null,
            decisionTier: 'standard',
            subpixelShift: null
        },
        initialSelection: { source: 'standard' },
        originalImageData: imageData,
        resolvedConfig: { logoSize: 48, marginRight: 32, marginBottom: 32 }
    });

    assert.equal(result.imageData, imageData);
    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.source, 'standard+fine-alpha');
    assert.equal(result.meta.selectionDebug.candidateSource, 'standard');
    assert.equal(result.meta.selectionDebug.initialPosition.width, 48);
    assert.equal(typeof result.meta.detection.residualVisibility.visible, 'boolean');
    assert.equal(result.meta.decisionPath.alphaTrial.strategy, 'fine-alpha');
});
