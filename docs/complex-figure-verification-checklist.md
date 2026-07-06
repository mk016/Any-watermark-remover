# Complex Figure Verification Checklist

## Why this exists

Natural-photo samples are not enough.

Complex figures such as:

- paper figures
- infographics
- mixed text and photo layouts
- portrait-oriented composite images
- multi-image Gemini responses

can still fail even when ordinary photo samples pass.

Typical failure modes:

- canonical anchor replaced by a weak drift candidate
- preview replacement attached to the wrong image node
- preview and download using different processed outputs
- tests passing because residual metrics look acceptable in the wrong location

## Required verification surface

Every release candidate that changes selector logic, preview replacement, or download handling should verify all of the following:

1. local sample regressions
2. real-page preview visual mapping
3. real-page download output identity

## Local regression samples

Current high-value samples:

- src/assets/samples/debug1-source.png
  - download residual / conservative fallback case
- src/assets/samples/debug2-source.png
  - portrait mixed text/photo figure case

Expected behavior:

- debug1-source.png
  - should keep the canonical 48x48 anchor
  - should not fall back to a weaker conservative candidate
- debug2-source.png
  - should keep the canonical anchor
  - should not allow local drift to replace the canonical anchor on weak evidence

Run:

```bash
pnpm test
```

Key tests:

- tests/core/watermarkProcessor.test.js
- tests/core/candidateSelector.test.js
- tests/regression/sampleAssetsRemoval.test.js

## Real-page preview checks

Target shape:

- open the Gemini page with multiple generated images
- include at least one portrait-oriented complex figure or infographic-like output

Verify:

- the displayed preview reaches data-gwr-page-image-state=ready
- the displayed preview has a data-gwr-watermark-object-url
- the current displayed image and the processed overlay still correspond to the same content

Red flags:

- preview shows another image's content
- preview keeps the text/photo layout but the watermark position is visibly shifted
- multiple ready images exist but only some have stable non-empty source bindings

## Real-page download checks

Verify:

- clicking Download full-size image triggers the expected native chain
- the final downloaded file matches the userscript's processed result, not an older cached blob
- the downloaded output still aligns with the same image shown in preview

Red flags:

- download hash differs from the userscript's processed blob hash for the same source
- preview looks fixed but download keeps an older wrong result
- target page uses blob-only bindings with missing stable source mapping

## Hash and identity checks

When behavior is suspicious, compare:

1. original source hash
2. current displayed preview hash
3. processed overlay blob hash
4. userscript download-processed blob hash
5. final saved download file hash

If 3/4/5 diverge for the same action, treat that as a pipeline bug even if the page looks partially correct.

## Release gate

Do not treat a selector or request-layer change as safe until:

- local regression samples stay green
- fixed-profile userscript freshness is fresh
- at least one complex portrait figure passes preview and download verification
