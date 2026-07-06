import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import sharp from 'sharp';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack');
const BACKGROUND = '#171717';
const ROW_GAP = 14;
const VALID_VERDICTS = Object.freeze([
    'trueVisibleResidual',
    'backgroundStructure',
    'contentCollision',
    'acceptableResidual',
    'needsModelInvestigation'
]);
const VALID_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
const GOLD_BLOCKING_VERDICTS = Object.freeze([
    'trueVisibleResidual',
    'needsModelInvestigation'
]);
const FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS = Object.freeze([
    'alphagain',
    'alphagainsweep',
    'alphamap',
    'alphamappath',
    'alphaprofile',
    'alphaprofilemidboost124',
    'midboost',
    'productionprofile',
    'profileadjustment',
    'profilecandidate',
    'profileoverride',
    'profilevariant',
    'renderprofile',
    'watermarkprofile'
]);
const ALLOWED_DECISION_FIELD_KEYS = Object.freeze([
    'clusterId',
    'cropPath',
    'decisionArrayIndex',
    'file',
    'humanConfidence',
    'humanNotes',
    'humanVerdict',
    'index',
    'metrics',
    'profileLine',
    'reviewStatus',
    'sourceSet',
    'suggestedConfidence',
    'suggestedNotes',
    'suggestedVerdict',
    'visibleReasons'
]);
const ALLOWED_DECISION_INPUT_ROOT_KEYS = Object.freeze([
    'decisions',
    'instructions',
    'reviewManifestSha256',
    'schemaVersion'
]);

function parseArgs(argv) {
    const parsed = {
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        outputDir: DEFAULT_OUTPUT_DIR
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
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

async function sha256File(filePath) {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function sanitizeFileName(value) {
    return String(value)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120);
}

function countBy(items, getKey) {
    const counts = {};
    for (const item of items) {
        const key = getKey(item);
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

function normalizeReasons(reasons) {
    return [...new Set(reasons ?? [])].sort((left, right) => left.localeCompare(right));
}

function clusterIdFor({ sourceSet, profileLine, visibleReasons }) {
    return `${sourceSet}::${profileLine}::${normalizeReasons(visibleReasons).join('+')}`;
}

async function renderSheet({ records, outputPath }) {
    if (!Array.isArray(records) || records.length === 0) return null;
    const rows = [];
    for (const record of records) {
        if (!record.cropPath) continue;
        const metadata = await sharp(record.cropPath).metadata();
        rows.push({
            input: record.cropPath,
            width: metadata.width,
            height: metadata.height
        });
    }
    if (rows.length === 0) return null;

    const width = Math.max(...rows.map((row) => row.width));
    const height = rows.reduce((sum, row) => sum + row.height, 0) + ROW_GAP * (rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.input, left: 0, top });
        top += row.height + ROW_GAP;
    }
    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);

    return {
        outputPath,
        count: rows.length,
        width,
        height
    };
}

function buildDecisionTemplate(records, { sourceSet, note, reviewManifestSha256, suggestedVerdict = false } = {}) {
    return {
        schemaVersion: 1,
        reviewManifestSha256,
        instructions: {
            verdicts: VALID_VERDICTS,
            confidence: VALID_CONFIDENCE,
            note
        },
        decisions: records.map((record, index) => ({
            index,
            sourceSet,
            file: record.file,
            profileLine: record.review?.profileLine ?? 'unknown',
            visibleReasons: record.metrics?.visibleReasons ?? [],
            clusterId: clusterIdFor({
                sourceSet,
                profileLine: record.review?.profileLine ?? 'unknown',
                visibleReasons: record.metrics?.visibleReasons ?? []
            }),
            metrics: record.metrics,
            cropPath: record.cropPath,
            suggestedVerdict: suggestedVerdict ? record.review?.verdict ?? null : null,
            suggestedConfidence: suggestedVerdict ? record.review?.confidence ?? null : null,
            suggestedNotes: suggestedVerdict ? record.review?.notes ?? '' : '',
            reviewStatus: suggestedVerdict ? record.review?.reviewStatus ?? 'needs-human-confirmation' : undefined,
            humanVerdict: null,
            humanConfidence: null,
            humanNotes: ''
        }))
    };
}

function buildReviewInputContract({
    reviewManifestPath,
    reviewManifestSha256,
    pendingRecords,
    candidateRecords,
    decisionsTemplatePath,
    decisionsPath,
    goldCandidateConfirmationsTemplatePath,
    goldCandidateConfirmationsPath
}) {
    return {
        schemaVersion: 1,
        reviewManifestPath,
        reviewManifestSha256,
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            alphaProfileProductionRequiresHumanConfirmedGold: true
        },
        allowedHumanVerdicts: VALID_VERDICTS,
        allowedHumanConfidence: VALID_CONFIDENCE,
        blockingVerdictsRequireHumanNotes: GOLD_BLOCKING_VERDICTS,
        requiredHumanFields: [
            'humanVerdict',
            'humanConfidence'
        ],
        optionalHumanFields: [
            'humanNotes'
        ],
        allowedDecisionInputRootFields: [...ALLOWED_DECISION_INPUT_ROOT_KEYS].sort(),
        allowedDecisionFields: [...ALLOWED_DECISION_FIELD_KEYS].sort(),
        forbiddenAlphaProfileFieldKeys: [...FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS].sort(),
        immutableDecisionFields: [
            'index',
            'sourceSet',
            'file',
            'profileLine',
            'visibleReasons',
            'clusterId',
            'metrics',
            'cropPath'
        ],
        decisionSets: [
            {
                name: 'visibleTopPending',
                templatePath: decisionsTemplatePath,
                inputPath: decisionsPath,
                expectedCount: pendingRecords.length,
                requiresHumanConfirmation: true
            },
            {
                name: 'metricPassVisible',
                templatePath: goldCandidateConfirmationsTemplatePath,
                inputPath: goldCandidateConfirmationsPath,
                expectedCount: candidateRecords.length,
                requiresHumanConfirmation: true
            }
        ]
    };
}

function hasHumanInput(payload) {
    return (payload?.decisions ?? []).some((decision) => (
        typeof decision.humanVerdict === 'string' && decision.humanVerdict.length > 0
    ) || (
        typeof decision.humanConfidence === 'string' && decision.humanConfidence.length > 0
    ) || (
        typeof decision.humanNotes === 'string' && decision.humanNotes.trim().length > 0
    ));
}

async function writeJsonIfMissing(filePath, payload) {
    if (existsSync(filePath)) {
        const existing = JSON.parse(stripBom(await readFile(filePath, 'utf8')));
        if (
            existing &&
            typeof existing === 'object' &&
            typeof existing.reviewManifestSha256 !== 'string' &&
            typeof payload.reviewManifestSha256 === 'string'
        ) {
            await writeFile(
                filePath,
                `${JSON.stringify({
                    ...existing,
                    reviewManifestSha256: payload.reviewManifestSha256
                }, null, 2)}\n`,
                'utf8'
            );
            return { path: filePath, preservedExisting: true, reviewManifestSha256Added: true };
        }
        if (
            existing &&
            typeof existing === 'object' &&
            typeof existing.reviewManifestSha256 === 'string' &&
            typeof payload.reviewManifestSha256 === 'string' &&
            existing.reviewManifestSha256 !== payload.reviewManifestSha256 &&
            !hasHumanInput(existing)
        ) {
            await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            return {
                path: filePath,
                preservedExisting: false,
                reviewManifestSha256Added: false,
                staleEmptyInputReplaced: true
            };
        }
        return { path: filePath, preservedExisting: true, reviewManifestSha256Added: false };
    }
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return {
        path: filePath,
        preservedExisting: false,
        reviewManifestSha256Added: false,
        staleEmptyInputReplaced: false
    };
}

function buildMarkdownIndex({
    manifest,
    pendingRecords,
    candidateRecords,
    groupedSheets,
    allPendingSheetPath,
    goldCandidateSheetPath
}) {
    const lines = [];
    lines.push('# Visible Residual Human Review Pack');
    lines.push('');
    lines.push('This directory is for human confirmation of `visibleTopPending` samples and `metricPassVisible` gold candidates; it will not automatically modify the formal `gold-manifest.json`, nor will it promote any alpha/profile variant to production.');
    lines.push('');
    lines.push('Humans should edit only `humanVerdict`, `humanConfidence`, and `humanNotes` in `review-decisions.json` and `gold-candidate-confirmations.json`; the other fields are generated by the script for provenance and structural validation.');
    lines.push('');
    lines.push('Do not add decision fields such as `alphaGain`, `profileVariant`, `renderProfile`, or `cleanupMode`; validation treats extra fields as structural errors.');
    lines.push('');
    lines.push('## Files');
    lines.push('');
    lines.push(`- all pending sheet: \`${path.basename(allPendingSheetPath)}\``);
    lines.push(`- gold candidate sheet: \`${path.basename(goldCandidateSheetPath)}\``);
    lines.push('- grouped sheets: `by-profile/*.png`');
    lines.push('- decision template: `review-decisions.template.json`');
    lines.push('- human decision input: `review-decisions.json`');
    lines.push('- gold candidate confirmation template: `gold-candidate-confirmations.template.json`');
    lines.push('- gold candidate confirmation input: `gold-candidate-confirmations.json`');
    lines.push('- machine-readable input contract: `review-input-contract.json`');
    lines.push('- focused current edit batch: `review-focused-batch.json`');
    lines.push('- current visual handoff: `review-handoff.md`');
    lines.push('');
    lines.push('## Review Workflow');
    lines.push('');
    lines.push('- Run `rtk pnpm visible-residual:review-status` to see current machine-readable progress, `reviewBatches`, and `goldCandidateReviewBatches`.');
    lines.push('- Open `review-handoff.md` first; it embeds the current cluster sheets and per-decision crop previews for the focused batch.');
    lines.push('- Use `review-focused-batch.json` for the current small edit batch. Edit only `humanVerdict` / `humanConfidence` / `humanNotes`; do not edit locator, metric, crop, profile, or source fields.');
    lines.push('- Allowed `humanVerdict` values: `trueVisibleResidual`, `backgroundStructure`, `contentCollision`, `acceptableResidual`, `needsModelInvestigation`.');
    lines.push('- Allowed `humanConfidence` values: `high`, `medium`, `low`; `trueVisibleResidual` and `needsModelInvestigation` require `humanNotes`.');
    lines.push('- After filling the focused batch, run `rtk pnpm visible-residual:apply-focused-batch --dry-run` first, then `rtk pnpm visible-residual:apply-focused-batch` if the dry run succeeds.');
    lines.push('- Run `rtk pnpm visible-residual:review-worksheet` to refresh `review-worksheet.md` and `review-table.csv` from the current cluster report.');
    lines.push('- Fill `review-decisions.json` for `visibleTopPending` batches.');
    lines.push('- Fill `gold-candidate-confirmations.json` for `metricPassVisible` gold candidate batches before creating a formal `gold-manifest.json`.');
    lines.push('- Run `rtk pnpm visible-residual:validate-human-review` after editing the two JSON files.');
    lines.push('');
    lines.push('## Counts');
    lines.push('');
    lines.push(`- pending total: ${pendingRecords.length}`);
    lines.push(`- gold candidate total: ${candidateRecords.length}`);
    lines.push(`- source review manifest: \`${manifest.sourceRenderSummaryPath ?? 'unknown'}\``);
    lines.push('');
    lines.push('### Pending By Profile');
    lines.push('');
    for (const [profile, count] of Object.entries(countBy(pendingRecords, (record) => record.review?.profileLine ?? 'unknown'))) {
        lines.push(`- ${profile}: ${count}`);
    }
    lines.push('');
    lines.push('### Gold Candidate By Verdict');
    lines.push('');
    for (const [verdict, count] of Object.entries(countBy(candidateRecords, (record) => record.review?.verdict ?? 'unknown'))) {
        lines.push(`- ${verdict}: ${count}`);
    }
    lines.push('');
    lines.push('### Pending By Visible Reason');
    lines.push('');
    for (const [reason, count] of Object.entries(countReasons(pendingRecords))) {
        lines.push(`- ${reason}: ${count}`);
    }
    lines.push('');
    lines.push('## Verdict Guide');
    lines.push('');
    lines.push('- `trueVisibleResidual`: visually confirm that the residual is an algorithm failure and write `humanNotes`.');
    lines.push('- `backgroundStructure`: the metric hit is primarily due to background structure and should not trigger algorithm fixes.');
    lines.push('- `contentCollision`: the residual overlaps with text, borders, or high-contrast content and should first enter gold tolerance discussion.');
    lines.push('- `acceptableResidual`: visible but weak, and humans consider it acceptable.');
    lines.push('- `needsModelInvestigation`: this is clearly not a simple threshold or gain issue and requires further model/profile research; write `humanNotes`.');
    lines.push('');
    lines.push('## Gate Policy');
    lines.push('');
    lines.push('- `review-input-contract.json` declares editable fields, non-editable fields, allowed verdict/confidence values, and expected count.');
    lines.push('- validation, admission, and formal gold migration all validate contract provenance.');
    lines.push('- Before all confirmation items are complete, `gold-manifest.json` must remain ungenerated.');
    lines.push('');
    lines.push('## Group Sheets');
    lines.push('');
    for (const [profile, sheet] of Object.entries(groupedSheets)) {
        lines.push(`- ${profile}: \`${path.relative(path.dirname(allPendingSheetPath), sheet.outputPath).replace(/\\/g, '/')}\` (${sheet.count})`);
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const manifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(manifestText);
    const manifest = JSON.parse(manifestText);
    const pendingRecords = manifest.groups?.visibleTopPending ?? [];
    const candidateRecords = manifest.groups?.metricPassVisible ?? [];
    await mkdir(args.outputDir, { recursive: true });
    await mkdir(path.join(args.outputDir, 'by-profile'), { recursive: true });

    const allPendingSheet = await renderSheet({
        records: pendingRecords,
        outputPath: path.join(args.outputDir, 'all-pending.png')
    });
    const goldCandidateSheet = await renderSheet({
        records: candidateRecords,
        outputPath: path.join(args.outputDir, 'gold-candidates.png')
    });

    const groupedRecords = Map.groupBy
        ? Map.groupBy(pendingRecords, (record) => record.review?.profileLine ?? 'unknown')
        : groupByPolyfill(pendingRecords, (record) => record.review?.profileLine ?? 'unknown');
    const groupedSheets = {};
    for (const [profile, groupRecords] of groupedRecords.entries()) {
        groupedSheets[profile] = await renderSheet({
            records: groupRecords,
            outputPath: path.join(args.outputDir, 'by-profile', `${sanitizeFileName(profile)}.png`)
        });
    }

    const decisionTemplate = buildDecisionTemplate(pendingRecords, {
        sourceSet: 'visibleTopPending',
        reviewManifestSha256,
        note: 'Fill in humanVerdict / humanConfidence / humanNotes. Do not modify file / metrics / cropPath; this file is the human confirmation input for pending samples and will not automatically write formal gold.'
    });
    const decisionsPath = path.join(args.outputDir, 'review-decisions.template.json');
    await writeFile(decisionsPath, `${JSON.stringify(decisionTemplate, null, 2)}\n`, 'utf8');
    const humanDecisionsPath = path.join(args.outputDir, 'review-decisions.json');
    const humanDecisionsWrite = await writeJsonIfMissing(humanDecisionsPath, decisionTemplate);

    const goldCandidateConfirmations = buildDecisionTemplate(candidateRecords, {
        sourceSet: 'metricPassVisible',
        reviewManifestSha256,
        note: 'Confirm or correct suggestedVerdict / suggestedConfidence. Do not modify file / metrics / cropPath; these Codex pre-review candidates must be confirmed by a human before entering formal gold.',
        suggestedVerdict: true
    });
    const goldCandidateConfirmationsPath = path.join(args.outputDir, 'gold-candidate-confirmations.template.json');
    await writeFile(goldCandidateConfirmationsPath, `${JSON.stringify(goldCandidateConfirmations, null, 2)}\n`, 'utf8');
    const humanGoldCandidateConfirmationsPath = path.join(args.outputDir, 'gold-candidate-confirmations.json');
    const humanGoldCandidateConfirmationsWrite = await writeJsonIfMissing(
        humanGoldCandidateConfirmationsPath,
        goldCandidateConfirmations
    );

    const reviewInputContractPath = path.join(args.outputDir, 'review-input-contract.json');
    const reviewInputContract = buildReviewInputContract({
        reviewManifestPath: args.reviewManifestPath,
        reviewManifestSha256,
        pendingRecords,
        candidateRecords,
        decisionsTemplatePath: decisionsPath,
        decisionsPath: humanDecisionsPath,
        goldCandidateConfirmationsTemplatePath: goldCandidateConfirmationsPath,
        goldCandidateConfirmationsPath: humanGoldCandidateConfirmationsPath
    });
    const reviewInputContractText = `${JSON.stringify(reviewInputContract, null, 2)}\n`;
    await writeFile(reviewInputContractPath, reviewInputContractText, 'utf8');

    const readmePath = path.join(args.outputDir, 'README.md');
    await writeFile(readmePath, buildMarkdownIndex({
        manifest,
        pendingRecords,
        candidateRecords,
        groupedSheets,
        allPendingSheetPath: allPendingSheet.outputPath,
        goldCandidateSheetPath: goldCandidateSheet.outputPath
    }), 'utf8');

    const groupedSheetHashes = {};
    for (const [profile, sheet] of Object.entries(groupedSheets)) {
        groupedSheetHashes[profile] = {
            outputPath: sheet.outputPath,
            sha256: await sha256File(sheet.outputPath)
        };
    }
    const artifactHashes = {
        readmeSha256: await sha256File(readmePath),
        decisionsTemplateSha256: await sha256File(decisionsPath),
        decisionsSha256: await sha256File(humanDecisionsPath),
        goldCandidateConfirmationsTemplateSha256: await sha256File(goldCandidateConfirmationsPath),
        goldCandidateConfirmationsSha256: await sha256File(humanGoldCandidateConfirmationsPath),
        reviewInputContractSha256: await sha256File(reviewInputContractPath),
        allPendingSheetSha256: await sha256File(allPendingSheet.outputPath),
        goldCandidateSheetSha256: await sha256File(goldCandidateSheet.outputPath),
        groupedSheets: groupedSheetHashes
    };

    const summary = {
        generatedAt: new Date().toISOString(),
        reviewManifestPath: args.reviewManifestPath,
        reviewManifestSha256,
        outputDir: args.outputDir,
        pendingTotal: pendingRecords.length,
        goldCandidateTotal: candidateRecords.length,
        profileCounts: countBy(pendingRecords, (record) => record.review?.profileLine ?? 'unknown'),
        goldCandidateVerdictCounts: countBy(candidateRecords, (record) => record.review?.verdict ?? 'unknown'),
        reasonCounts: countReasons(pendingRecords),
        allPendingSheet,
        goldCandidateSheet,
        groupedSheets,
        decisionsTemplatePath: decisionsPath,
        decisionsPath: humanDecisionsPath,
        decisionsInputPreservedExisting: humanDecisionsWrite.preservedExisting,
        decisionsInputReviewManifestSha256Added: humanDecisionsWrite.reviewManifestSha256Added,
        decisionsInputStaleEmptyReplaced: humanDecisionsWrite.staleEmptyInputReplaced === true,
        goldCandidateConfirmationsTemplatePath: goldCandidateConfirmationsPath,
        goldCandidateConfirmationsPath: humanGoldCandidateConfirmationsPath,
        goldCandidateConfirmationsInputPreservedExisting: humanGoldCandidateConfirmationsWrite.preservedExisting,
        goldCandidateConfirmationsInputReviewManifestSha256Added:
            humanGoldCandidateConfirmationsWrite.reviewManifestSha256Added,
        goldCandidateConfirmationsInputStaleEmptyReplaced:
            humanGoldCandidateConfirmationsWrite.staleEmptyInputReplaced === true,
        reviewInputContractPath,
        reviewInputContractSha256: sha256Text(reviewInputContractText),
        readmePath,
        artifactHashes
    };
    const summaryPath = path.join(args.outputDir, 'summary.json');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({
        summaryPath,
        pendingTotal: summary.pendingTotal,
        goldCandidateTotal: summary.goldCandidateTotal,
        allPendingSheet: allPendingSheet?.outputPath ?? null,
        goldCandidateSheet: goldCandidateSheet?.outputPath ?? null,
        decisionsTemplatePath: decisionsPath,
        decisionsPath: humanDecisionsPath,
        decisionsInputPreservedExisting: humanDecisionsWrite.preservedExisting,
        decisionsInputReviewManifestSha256Added: humanDecisionsWrite.reviewManifestSha256Added,
        decisionsInputStaleEmptyReplaced: humanDecisionsWrite.staleEmptyInputReplaced === true,
        goldCandidateConfirmationsTemplatePath: goldCandidateConfirmationsPath,
        goldCandidateConfirmationsPath: humanGoldCandidateConfirmationsPath,
        goldCandidateConfirmationsInputPreservedExisting: humanGoldCandidateConfirmationsWrite.preservedExisting,
        goldCandidateConfirmationsInputReviewManifestSha256Added:
            humanGoldCandidateConfirmationsWrite.reviewManifestSha256Added,
        goldCandidateConfirmationsInputStaleEmptyReplaced:
            humanGoldCandidateConfirmationsWrite.staleEmptyInputReplaced === true,
        reviewInputContractPath,
        reviewInputContractSha256: summary.reviewInputContractSha256,
        readmePath
    }, null, 2));
}

function groupByPolyfill(items, getKey) {
    const grouped = new Map();
    for (const item of items) {
        const key = getKey(item);
        const group = grouped.get(key) ?? [];
        group.push(item);
        grouped.set(key, group);
    }
    return grouped;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
