# Watermark Removal Algorithm Research and Refactor Plan

Updated: 2026-06-08

## Background

The issue exposed by the 20260608 sample was not an isolated parameter issue. The algorithm architecture was drifting away from the original mathematical model.

- Watermark removal is fundamentally inverse alpha compositing of a known white logo and alpha map.
- If the position, size, alpha map, and alpha gain are correct, the process should not need inpainting or aggressive cleanup.
- If the position or alpha is wrong, post-processing can hide the bad candidate and pollute candidate ranking.

The next refactor goal is to return to a clean pipeline of candidate localization, alpha selection, inverse scoring, and early exit. Cleanup should be removed or gated from the default core path.

## Key conclusions from external research

### 1. Similar Gemini projects follow reverse alpha blending

The common pattern is:

```text
watermarked = alpha * logo + (1 - alpha) * original
original = (watermarked - alpha * logo) / (1 - alpha)
```

The core idea is to estimate the watermark foreground and restore the original image from known geometry and alpha. Cleanup is supplementary, not the primary path.

### 2. The academic direction also supports localization and matting first

Visible watermark removal research is usually framed as localization, mask estimation, and background refinement. That is especially true for known watermark shapes with limited candidate positions.

### 3. Original exports and degraded inputs should be handled separately

Original Gemini exports should use the core inverse-alpha path. Screenshots, re-compressed images, or scaled copies should be treated as degraded inputs and either skipped or handled by a separate profile.

## Current architecture review

The current stack already has useful evidence metrics such as spatial correlation, gradient correlation, and damage penalties. The main problem is that detection and restoration are still intertwined in one selection flow.

The recommended structure is:

- detection stage: propose anchor and size candidates
- alpha stage: estimate alpha strength and shape
- repair stage: apply restoration only when the evidence is strong enough
- evaluation stage: score damage and rejection risks

That keeps the main path interpretable and safer.
