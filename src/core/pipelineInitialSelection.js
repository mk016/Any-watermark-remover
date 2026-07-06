import { selectInitialCandidate } from './candidateSelector.js';

export function selectInitialWatermarkCandidate({
    originalImageData,
    config,
    position,
    alpha48,
    alpha96,
    alpha96Variants = null,
    getAlphaMap = null,
    allowAdaptiveSearch = true,
    aggressiveLocatedFallback = true,
    alphaGainCandidates,
    alphaPriorityGains,
    selectCandidate = selectInitialCandidate
} = {}) {
    let initialSelection = selectCandidate({
        originalImageData,
        config,
        position,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap,
        allowAdaptiveSearch,
        allowAutomaticSearch: false,
        alphaGainCandidates,
        alphaPriorityGains
    });

    if (
        !initialSelection.selectedTrial &&
        aggressiveLocatedFallback !== false
    ) {
        const aggressiveSelection = selectCandidate({
            originalImageData,
            config,
            position,
            alpha48,
            alpha96,
            alpha96Variants,
            getAlphaMap,
            allowAdaptiveSearch,
            allowAutomaticSearch: true,
            allowAggressiveStrongLocated: true,
            alphaGainCandidates,
            alphaPriorityGains
        });
        if (aggressiveSelection.selectedTrial) {
            initialSelection = {
                ...aggressiveSelection,
                source: aggressiveSelection.source.includes('aggressive-located')
                    ? aggressiveSelection.source
                    : `${aggressiveSelection.source}+aggressive-located`,
                decisionTier: aggressiveSelection.decisionTier || 'direct-match'
            };
        }
    }

    return initialSelection;
}
