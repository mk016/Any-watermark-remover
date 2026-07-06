import test from 'node:test';
import assert from 'node:assert/strict';

import { selectInitialWatermarkCandidate } from '../../src/core/pipelineInitialSelection.js';

function createBaseInput(selectCandidate) {
    return {
        originalImageData: { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alpha48: new Float32Array(48 * 48),
        alpha96: new Float32Array(96 * 96),
        alphaGainCandidates: [1],
        alphaPriorityGains: [1],
        selectCandidate
    };
}

test('selectInitialWatermarkCandidate should keep the first selected standard candidate', () => {
    const calls = [];
    const selectedTrial = { id: 'standard-trial' };
    const result = selectInitialWatermarkCandidate(createBaseInput((args) => {
        calls.push(args);
        return {
            selectedTrial,
            source: 'standard',
            decisionTier: 'direct-match'
        };
    }));

    assert.equal(result.selectedTrial, selectedTrial);
    assert.equal(result.source, 'standard');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].allowAutomaticSearch, false);
});

test('selectInitialWatermarkCandidate should use aggressive located fallback when standard selection skips', () => {
    const calls = [];
    const selectedTrial = { id: 'aggressive-trial' };
    const result = selectInitialWatermarkCandidate(createBaseInput((args) => {
        calls.push(args);
        return calls.length === 1
            ? { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' }
            : { selectedTrial, source: 'located', decisionTier: null };
    }));

    assert.equal(result.selectedTrial, selectedTrial);
    assert.equal(result.source, 'located+aggressive-located');
    assert.equal(result.decisionTier, 'direct-match');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].allowAutomaticSearch, true);
    assert.equal(calls[1].allowAggressiveStrongLocated, true);
});

test('selectInitialWatermarkCandidate should respect disabled aggressive fallback', () => {
    const calls = [];
    const result = selectInitialWatermarkCandidate({
        ...createBaseInput((args) => {
            calls.push(args);
            return { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' };
        }),
        aggressiveLocatedFallback: false
    });

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(calls.length, 1);
});
