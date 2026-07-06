# Video Watermark Removal Progress

Updated: 2026-06-25

## Current direction

The video flow is now centered around a more explicit pipeline:

1. detect the watermark position and confidence
2. select a preset based on the detected geometry
3. apply local cleanup only when the evidence supports it
4. export the cleaned video with preserved audio when possible

## What has improved

- Better handling for relocated and inset watermark geometry.
- More conservative handling for low-confidence detections.
- Stronger separation between detection evidence and repair execution.
- Better progress reporting and export metadata for review.

## Remaining focus

- Keep the default path safe and conservative.
- Avoid turning video cleanup into a broad fallback heuristic.
- Continue validating against real samples before promoting any video path to a default release strategy.
