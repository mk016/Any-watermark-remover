import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAcceptedPipelineResult,
    createAcceptedPipelineResultFromState,
    createRejectedPipelineResult
} from '../../src/core/pipelineResult.js';

test('createRejectedPipelineResult should preserve skipped result shape', () => {
    const imageData = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    const debugTimings = { totalMs: 3 };
    const result = createRejectedPipelineResult({
        imageData,
        debugTimings,
        adaptiveConfidence: 0.2,
        originalSpatialScore: 0.1,
        originalGradientScore: 0.05,
        decisionTier: 'insufficient'
    });

    assert.equal(result.imageData, imageData);
    assert.equal(result.debugTimings, debugTimings);
    assert.equal(result.meta.applied, false);
    assert.equal(result.meta.skipReason, 'no-watermark-detected');
    assert.equal(result.meta.source, 'skipped');
    assert.equal(result.meta.decisionTier, 'insufficient');
    assert.deepEqual(result.meta.detection, {
        adaptiveConfidence: 0.2,
        originalSpatialScore: 0.1,
        originalGradientScore: 0.05,
        processedSpatialScore: 0.1,
        processedGradientScore: 0.05,
        suppressionGain: 0,
        residualVisibility: null
    });
    assert.equal(result.meta.decisionPath.decision, 'reject');
    assert.equal(result.meta.decisionPath.evaluation.blockedGate, 'no-watermark-detected');
});

test('createAcceptedPipelineResult should preserve accepted result shape', () => {
    const imageData = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    const debugTimings = { totalMs: 12 };
    const result = createAcceptedPipelineResult({
        finalImageData: imageData,
        debugTimings,
        selectedTrial: {
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            position: { x: 10, y: 20, width: 48, height: 48 }
        },
        selectionSource: 'standard',
        position: { x: 10, y: 20, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        adaptiveConfidence: 0.9,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        finalProcessedSpatialScore: 0.1,
        finalProcessedGradientScore: 0.2,
        suppressionGain: 0.7,
        residualVisibility: { visibleSpatialResidual: false },
        templateWarp: { dx: 1 },
        alphaGain: 0.85,
        passCount: 1,
        attemptedPassCount: 2,
        passStopReason: 'clean',
        passes: [{ pass: 1 }],
        source: 'standard+fine-alpha',
        decisionTier: 'standard',
        subpixelShift: { dx: 0.25, dy: 0 },
        alphaAdjustmentStages: [{ stage: 'fine-alpha' }],
        alphaTrialEvents: [{ stage: 'fine-alpha', decision: 'accept' }],
        alphaMapSource: 'catalog',
        selectionDebug: { selected: true }
    });

    assert.equal(result.imageData, imageData);
    assert.equal(result.debugTimings, debugTimings);
    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.size, 48);
    assert.deepEqual(result.meta.detection, {
        adaptiveConfidence: 0.9,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        processedSpatialScore: 0.1,
        processedGradientScore: 0.2,
        suppressionGain: 0.7,
        residualVisibility: { visibleSpatialResidual: false }
    });
    assert.equal(result.meta.source, 'standard+fine-alpha');
    assert.equal(result.meta.alphaGain, 0.85);
    assert.deepEqual(result.meta.selectionDebug, { selected: true });
    assert.equal(result.meta.decisionPath.decision, 'accept');
    assert.equal(result.meta.decisionPath.alphaTrial.strategy, 'fine-alpha');
    assert.deepEqual(result.meta.decisionPath.alphaTrial.acceptedStrategies, [
        { stage: 'fine-alpha', decision: 'accept' }
    ]);
});

test('createAcceptedPipelineResultFromState should preserve accepted result mapping', () => {
    const imageData = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    const debugTimings = { totalMs: 15 };
    const result = createAcceptedPipelineResultFromState({
        pipelineState: {
            finalImageData: imageData,
            position: { x: 10, y: 20, width: 48, height: 48 },
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
            passCount: 2,
            attemptedPassCount: 2,
            passStopReason: 'located-aggressive-alpha',
            passes: [{ index: 1 }, { index: 2 }]
        },
        traceState: {
            alphaAdjustmentStages: [{ stage: 'fine-alpha' }],
            alphaTrialEvents: [{ stage: 'fine-alpha', decision: 'accept' }]
        },
        resultContext: {
            debugTimings,
            selectedTrial: {
                config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
                position: { x: 10, y: 20, width: 48, height: 48 }
            },
            selectionSource: 'standard',
            adaptiveConfidence: 0.8,
            templateWarp: { dx: 0 },
            decisionTier: 'standard',
            subpixelShift: { dx: 0.25, dy: 0 }
        },
        residualVisibility: { visible: false },
        selectionDebug: { selected: true }
    });

    assert.equal(result.imageData, imageData);
    assert.equal(result.debugTimings, debugTimings);
    assert.equal(result.meta.applied, true);
    assert.equal(result.meta.source, 'standard+fine-alpha');
    assert.equal(result.meta.alphaGain, 0.9);
    assert.equal(result.meta.passCount, 2);
    assert.equal(result.meta.attemptedPassCount, 2);
    assert.deepEqual(result.meta.detection, {
        adaptiveConfidence: 0.8,
        originalSpatialScore: 0.7,
        originalGradientScore: 0.6,
        processedSpatialScore: 0.08,
        processedGradientScore: 0.05,
        suppressionGain: 0.62,
        residualVisibility: { visible: false }
    });
    assert.deepEqual(result.meta.selectionDebug, { selected: true });
    assert.equal(result.meta.decisionPath.alphaTrial.strategy, 'fine-alpha');
});
