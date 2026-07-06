import test from 'node:test';
import assert from 'node:assert/strict';

import { runImageWatermarkPipeline } from '../../src/core/imageWatermarkPipeline.js';

function createImageData(width = 128, height = 128) {
    return {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
}

test('runImageWatermarkPipeline should return rejected result when initial selection skips', () => {
    const imageData = createImageData();
    const clonedImageData = createImageData();
    const alpha48 = new Float32Array(48 * 48);
    const alpha96 = new Float32Array(96 * 96);
    const nowValues = [100, 110, 125, 140];
    let rejectedPayload = null;

    const result = runImageWatermarkPipeline({
        imageData,
        options: {
            alpha48,
            alpha96,
            debugTimings: true
        },
        nowMs: () => nowValues.shift() ?? 200,
        cloneImageData: () => clonedImageData,
        alphaGainCandidates: [1],
        alphaPriorityGains: [1],
        createAcceptedPipelineDependencies: () => {
            throw new Error('accepted dependencies should not be created for rejected selection');
        },
        cleanupConfig: {},
        selectCandidate: () => ({
            selectedTrial: null,
            adaptiveConfidence: 0.25,
            standardSpatialScore: 0.3,
            standardGradientScore: 0.2,
            decisionTier: 'insufficient'
        }),
        createRejectedResult: (payload) => {
            rejectedPayload = payload;
            return { kind: 'rejected', payload };
        }
    });

    assert.equal(result.kind, 'rejected');
    assert.equal(rejectedPayload.imageData, clonedImageData);
    assert.deepEqual(rejectedPayload.debugTimings, {
        initialSelectionMs: 15,
        totalMs: 40
    });
    assert.equal(rejectedPayload.reason, 'no-watermark-detected');
    assert.equal(rejectedPayload.adaptiveConfidence, 0.25);
    assert.equal(rejectedPayload.originalSpatialScore, 0.3);
    assert.equal(rejectedPayload.originalGradientScore, 0.2);
    assert.equal(rejectedPayload.source, 'skipped');
    assert.equal(rejectedPayload.decisionTier, 'insufficient');
});

test('runImageWatermarkPipeline should orchestrate accepted executor and finalization', () => {
    const imageData = createImageData();
    const clonedImageData = createImageData();
    const alpha48 = new Float32Array(48 * 48).fill(0.5);
    const alpha96 = new Float32Array(96 * 96).fill(0.5);
    const nowValues = [100, 110, 120, 130, 140, 150];
    const dependencies = {
        metrics: {},
        gates: {},
        config: {},
        refiners: {}
    };
    let acceptedRequest = null;
    let finalizationRequest = null;

    const result = runImageWatermarkPipeline({
        imageData,
        options: {
            alpha48,
            alpha96,
            debugTimings: true,
            alpha96Variants: [{ source: 'variant' }],
            locatedAggressiveRemoval: true
        },
        nowMs: () => nowValues.shift() ?? 200,
        cloneImageData: () => clonedImageData,
        alphaGainCandidates: [0.8, 1],
        alphaPriorityGains: [1],
        createAcceptedPipelineDependencies: () => dependencies,
        cleanupConfig: {
            previewEdgeCleanupMaxSize: 48
        },
        visualPostProcessingEnabled: true,
        selectCandidate: ({ config, position, alpha48: selectedAlpha48 }) => ({
            selectedTrial: {
                imageData: clonedImageData,
                originalSpatialScore: 0.7,
                originalGradientScore: 0.4
            },
            config,
            position,
            alphaMap: selectedAlpha48,
            alphaGain: 1,
            source: 'standard',
            adaptiveConfidence: 0.9,
            templateWarp: { dx: 0 },
            decisionTier: 'standard'
        }),
        runAcceptedPipeline: (request) => {
            acceptedRequest = request;
            return {
                passState: request.passState,
                subpixelShift: { dx: 0.25, dy: 0 },
                readPipelineState: request.runtimeBootstrap.readPipelineState
            };
        },
        createAcceptedFinalResult: (request) => {
            finalizationRequest = request;
            return { kind: 'accepted', request };
        }
    });

    assert.equal(result.kind, 'accepted');
    assert.equal(acceptedRequest.originalImageData, clonedImageData);
    assert.equal(acceptedRequest.alpha96, alpha96);
    assert.equal(acceptedRequest.visualPostProcessingEnabled, true);
    assert.equal(acceptedRequest.alpha96Variants.length, 1);
    assert.equal(acceptedRequest.locatedAggressiveRemoval, true);
    assert.equal(acceptedRequest.metrics, dependencies.metrics);
    assert.equal(acceptedRequest.gates, dependencies.gates);
    assert.equal(acceptedRequest.config, dependencies.config);
    assert.equal(acceptedRequest.refiners, dependencies.refiners);
    assert.equal(finalizationRequest.passState, acceptedRequest.passState);
    assert.equal(finalizationRequest.originalImageData, clonedImageData);
    assert.equal(finalizationRequest.initialSelection.source, 'standard');
    assert.equal(finalizationRequest.resultContext.adaptiveConfidence, 0.9);
    assert.deepEqual(finalizationRequest.resultContext.templateWarp, { dx: 0 });
    assert.equal(finalizationRequest.resultContext.decisionTier, 'standard');
    assert.deepEqual(finalizationRequest.resultContext.subpixelShift, { dx: 0.25, dy: 0 });
    assert.equal(typeof finalizationRequest.resultContext.debugTimings.initialSelectionMs, 'number');
});
