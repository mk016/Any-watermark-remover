import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-after-rebalance.json'
);
const DEFAULT_REQUIRED_ANCHORS = Object.freeze([
    ['96/192/192/20260520', 40]
]);

function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        expectedTotal: 1000,
        minSuccessRate: 0.97,
        maxNewlyFailing: 0,
        minNewlyPassing: 21,
        requiredAnchors: [...DEFAULT_REQUIRED_ANCHORS]
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
        } else if (arg === '--expected-total') {
            parsed.expectedTotal = parseNumber(args.shift(), parsed.expectedTotal);
        } else if (arg === '--min-success-rate') {
            parsed.minSuccessRate = parseNumber(args.shift(), parsed.minSuccessRate);
        } else if (arg === '--max-newly-failing') {
            parsed.maxNewlyFailing = parseNumber(args.shift(), parsed.maxNewlyFailing);
        } else if (arg === '--min-newly-passing') {
            parsed.minNewlyPassing = parseNumber(args.shift(), parsed.minNewlyPassing);
        } else if (arg === '--require-anchor-pass') {
            const value = args.shift() || '';
            const [anchor, countText] = value.split('=');
            if (anchor && countText != null) {
                parsed.requiredAnchors.push([anchor, parseNumber(countText, 0)]);
            }
        } else if (arg === '--no-default-anchors') {
            parsed.requiredAnchors = [];
        }
    }

    return parsed;
}

function assertCondition(failures, condition, message) {
    if (!condition) failures.push(message);
}

function readAnchor(summary, key) {
    return summary?.byAnchor?.[key] ?? null;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(await readFile(args.reportPath, 'utf8'));
    const summary = report.summary ?? {};
    const total = Number(summary.total ?? 0);
    const passCount = Number(summary.passCount ?? 0);
    const successRate = total > 0 ? passCount / total : 0;
    const newlyPassing = Array.isArray(report.newlyPassing) ? report.newlyPassing.length : 0;
    const newlyFailing = Array.isArray(report.newlyFailing) ? report.newlyFailing.length : 0;
    const failures = [];

    assertCondition(
        failures,
        total === args.expectedTotal,
        `expected total ${args.expectedTotal}, got ${total}`
    );
    assertCondition(
        failures,
        successRate >= args.minSuccessRate,
        `expected successRate >= ${args.minSuccessRate}, got ${successRate.toFixed(4)}`
    );
    assertCondition(
        failures,
        newlyFailing <= args.maxNewlyFailing,
        `expected newlyFailing <= ${args.maxNewlyFailing}, got ${newlyFailing}`
    );
    assertCondition(
        failures,
        newlyPassing >= args.minNewlyPassing,
        `expected newlyPassing >= ${args.minNewlyPassing}, got ${newlyPassing}`
    );

    for (const [anchorKey, expectedPass] of args.requiredAnchors) {
        const anchor = readAnchor(summary, anchorKey);
        assertCondition(failures, Boolean(anchor), `required anchor ${anchorKey} is missing`);
        if (!anchor) continue;
        assertCondition(
            failures,
            anchor.pass >= expectedPass && anchor.fail === 0,
            `expected anchor ${anchorKey} pass >= ${expectedPass} and fail=0, got pass=${anchor.pass} fail=${anchor.fail}`
        );
    }

    const output = {
        ok: failures.length === 0,
        reportPath: args.reportPath,
        total,
        passCount,
        failCount: Number(summary.failCount ?? 0),
        successRate: Number(successRate.toFixed(4)),
        newlyPassing,
        newlyFailing,
        requiredAnchors: Object.fromEntries(args.requiredAnchors.map(([key]) => [
            key,
            readAnchor(summary, key)
        ])),
        failures
    };

    console.log(JSON.stringify(output, null, 2));
    if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
