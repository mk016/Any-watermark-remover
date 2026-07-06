# Image Watermark Pipeline Refactor Live Notes

Updated: 2026-06-25

## Phase 1 status

Status: complete.

Completed work:

- Added a lightweight decision-path structure in the candidate evaluation layer.
- Added structured decision records for accepted and rejected candidates.
- Ensured skipped paths emit explicit rejection metadata.
- Wrapped accepted paths as detection, alpha, repair, and evaluation stages.

Evidence:

- Core tests passed.
- A build completed successfully.
- Online benchmark coverage reached the expected percentage.
- The decision-path report covered all sampled cases.

## Phase 2 status

Status: major migration complete.

Completed work:

- Structured alpha-trial variants for the new-margin and known-48 profile paths.
- Recorded alpha-trial transitions and supporting metrics for interpretation.
- Began migrating aggressive alpha strategies into explainable trial events.

The focus is now on making each stage observable and testable without changing the pixel behavior of the default path.
