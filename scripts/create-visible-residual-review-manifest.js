import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_RENDER_SUMMARY_PATH = path.resolve('.artifacts/visible-residual-crops/latest/summary.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');

const INITIAL_REVIEW_OVERRIDES = Object.freeze({
    'sample2/Gemini_Generated_Image_a1d2x6a1d2x6a1d2.png': {
        verdict: 'trueVisibleResidual',
        confidence: 'high',
        residualClasses: ['positiveHalo', 'centerGrayShadow'],
        profileLine: '48px-large-margin',
        severity: 'medium',
        suggestedNextStep: 'investigate-48-large-margin-alpha-profile',
        notes: 'Stable star-shaped gray center shadow is visible in the after ROI raw and contrast views; it looks more like profile/alpha under-subtraction than a background false positive.'
    },
    'sample2/Gemini_Generated_Image_6mry9p6mry9p6mry.png': {
        verdict: 'trueVisibleResidual',
        confidence: 'high',
        residualClasses: ['positiveHalo', 'centerGrayShadow'],
        profileLine: '48px-large-margin',
        severity: 'medium',
        suggestedNextStep: 'investigate-48-large-margin-alpha-profile',
        notes: 'A full star-shaped gray shadow is still visible on the pink highlighted background; edge cleanup has been run, but the center remains.'
    },
    '2026-06-09/2064246191004061696-source.png': {
        verdict: 'needsModelInvestigation',
        confidence: 'high',
        residualClasses: ['positiveHalo', 'v2CenterGrayShadow'],
        profileLine: '36px-v2-small',
        severity: 'medium',
        suggestedNextStep: 'investigate-v2-36-forward-render-model',
        notes: 'After V2 36 edge cleanup, the edge metrics pass, but the center gray shadow is still visible; do not continue to strengthen edge cleanup.'
    },
    '2026-06-08/2064131568774942720-source.png': {
        verdict: 'contentCollision',
        confidence: 'medium',
        residualClasses: ['positiveHalo', 'contentEdgeCollision'],
        profileLine: '96px-standard',
        severity: 'medium',
        suggestedNextStep: 'mark-gold-tolerance-before-algorithm-change',
        notes: 'The residual overlaps with manga lines, speech bubbles, and text edges; a visible watermark shape exists, but gold labeling is needed to distinguish failure from tolerable content collision.'
    },
    '2026-06-08/2064131957880524800-source.png': {
        verdict: 'contentCollision',
        confidence: 'medium',
        residualClasses: ['positiveHalo', 'contentEdgeCollision'],
        profileLine: '96px-standard',
        severity: 'medium',
        suggestedNextStep: 'mark-gold-tolerance-before-algorithm-change',
        notes: 'It is similar to 2064131568774942720 and may be a duplicate or near-duplicate sample; classify it as a content collision first and do not push algorithm changes on its own.'
    },
    '2026-06-09/2064190955333881856-source.png': {
        verdict: 'contentCollision',
        confidence: 'medium',
        residualClasses: ['positiveHalo', 'contentEdgeCollision', 'largeScaledAnchor'],
        profileLine: '192px-scaled-anchor',
        severity: 'low-medium',
        suggestedNextStep: 'mark-gold-tolerance-before-algorithm-change',
        notes: 'The watermark region sits over large bold text and high-contrast backgrounds; the metric is a positive halo, but the visual judgment strongly depends on content structure.'
    }
});

function parseArgs(argv) {
    const parsed = {
        renderSummaryPath: DEFAULT_RENDER_SUMMARY_PATH,
        outputPath: DEFAULT_OUTPUT_PATH
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--summary') {
            parsed.renderSummaryPath = path.resolve(args.shift() || parsed.renderSummaryPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
        }
    }

    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

function toFixedNumber(value, digits = 3) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function collectVisibleReasons(residualVisibility) {
    if (!residualVisibility?.visible) return [];
    return [
        residualVisibility.visiblePositiveHalo ? 'positiveHalo' : null,
        residualVisibility.visibleGradientResidual ? 'gradientResidual' : null,
        residualVisibility.visibleSpatialResidual ? 'spatialResidual' : null
    ].filter(Boolean);
}

function normalizeRecord(record, groupName, review = null) {
    const residualVisibility = record.residualVisibility ?? null;
    return {
        file: record.file,
        group: groupName,
        bucket: record.bucket,
        source: record.source,
        config: record.config ?? null,
        cropPath: record.cropPath,
        metrics: {
            positiveHaloLum: toFixedNumber(residualVisibility?.positiveHaloLum, 3),
            haloVisibility: toFixedNumber(residualVisibility?.haloVisibility, 3),
            gradientResidual: toFixedNumber(residualVisibility?.gradientResidual, 3),
            spatialResidual: toFixedNumber(residualVisibility?.spatialResidual, 3),
            visibleReasons: collectVisibleReasons(residualVisibility)
        },
        review: review ?? {
            verdict: 'pending',
            confidence: 'unknown',
            residualClasses: [],
            profileLine: inferProfileLine(record.config),
            severity: 'unknown',
            suggestedNextStep: 'human-review',
            notes: ''
        }
    };
}

function inferProfileLine(config) {
    if (!config) return 'unknown';
    if (config.logoSize === 36 && config.alphaVariant === 'v2') return '36px-v2-small';
    if (config.logoSize === 48 && config.marginRight === 96 && config.marginBottom === 96) return '48px-large-margin';
    if (config.logoSize === 48 && config.marginRight === 32 && config.marginBottom === 32) return '48px-standard-margin';
    if (config.logoSize === 96 && config.marginRight === 64 && config.marginBottom === 64) return '96px-standard';
    if (config.logoSize === 96 && config.marginRight === 192 && config.marginBottom === 192) return '96px-large-margin';
    if (config.logoSize >= 128) return `${config.logoSize}px-scaled-anchor`;
    return `${config.logoSize}px-other`;
}

function buildReviewManifest(renderSummary, { renderSummaryPath, renderSummarySha256 } = {}) {
    const metricPassVisibleRecords = renderSummary.groups?.metricPassVisible?.records ?? [];
    const visibleTopRecords = renderSummary.groups?.visibleTop?.records ?? [];
    const reviewedFiles = new Set(metricPassVisibleRecords.map((record) => record.file));

    const metricPassVisible = metricPassVisibleRecords.map((record) => {
        const override = INITIAL_REVIEW_OVERRIDES[record.file] ?? null;
        return normalizeRecord(record, 'metricPassVisible', override ? {
            ...override,
            reviewedBy: 'codex-initial-pass',
            reviewStatus: 'needs-human-confirmation'
        } : null);
    });

    const visibleTopPending = visibleTopRecords
        .filter((record) => !reviewedFiles.has(record.file))
        .map((record) => normalizeRecord(record, 'visibleTop'));

    return {
        generatedAt: new Date().toISOString(),
        inputs: {
            renderSummaryPath,
            renderSummarySha256
        },
        sourceRenderSummaryPath: renderSummary.summaryPath ?? DEFAULT_RENDER_SUMMARY_PATH,
        sourceSampleRoot: renderSummary.sampleRoot ?? null,
        reviewSchema: {
            verdicts: [
                'trueVisibleResidual',
                'backgroundStructure',
                'contentCollision',
                'acceptableResidual',
                'needsModelInvestigation',
                'pending'
            ],
            confidence: ['high', 'medium', 'low', 'unknown'],
            note: 'codex-initial-pass is a prefilled judgment, not formal gold; it requires human confirmation before entering the gold manifest.'
        },
        summary: {
            metricPassVisibleReviewed: metricPassVisible.length,
            visibleTopPending: visibleTopPending.length,
            verdictCounts: countVerdicts(metricPassVisible),
            reviewedProfileCounts: countBy(metricPassVisible, (record) => record.review?.profileLine ?? 'unknown'),
            pendingProfileCounts: countBy(visibleTopPending, (record) => record.review?.profileLine ?? 'unknown'),
            pendingReasonCounts: countReasons(visibleTopPending)
        },
        groups: {
            metricPassVisible,
            visibleTopPending
        },
        workQueues: {
            modelInvestigation: metricPassVisible.filter((record) => (
                record.review?.verdict === 'trueVisibleResidual' ||
                record.review?.verdict === 'needsModelInvestigation'
            )),
            goldToleranceDiscussion: metricPassVisible.filter((record) => (
                record.review?.verdict === 'contentCollision' ||
                record.review?.verdict === 'acceptableResidual'
            )),
            humanReviewNext: visibleTopPending.slice(0, 10)
        },
        nextActions: [
            'Manually confirm the 6 prefilled metricPassVisible judgments.',
            'Move trueVisibleResidual and needsModelInvestigation samples into the model research queue.',
            'Move contentCollision samples to gold tolerance discussion first instead of directly pushing algorithm adjustments.',
            'After confirmation, move the stable fields to the formal sample gold manifest.'
        ]
    };
}

function countVerdicts(records) {
    const counts = {};
    for (const record of records) {
        const verdict = record.review?.verdict ?? 'pending';
        counts[verdict] = (counts[verdict] ?? 0) + 1;
    }
    return counts;
}

function countBy(records, resolveKey) {
    const counts = {};
    for (const record of records) {
        const key = resolveKey(record);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

function countReasons(records) {
    const counts = {};
    for (const record of records) {
        for (const reason of record.metrics?.visibleReasons ?? []) {
            counts[reason] = (counts[reason] ?? 0) + 1;
        }
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const renderSummaryText = stripBom(await readFile(args.renderSummaryPath, 'utf8'));
    const renderSummarySha256 = sha256Text(renderSummaryText);
    const renderSummary = JSON.parse(renderSummaryText);
    const manifest = buildReviewManifest(renderSummary, {
        renderSummaryPath: args.renderSummaryPath,
        renderSummarySha256
    });
    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: manifest.summary
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
