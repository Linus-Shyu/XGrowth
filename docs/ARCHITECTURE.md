# Architecture

XGrowth is a GitHub Actions–hosted growth control plane for X.

> For the operator-facing overview, start with the root [README](../README.md).  
> This document is the deeper control-loop reference for contributors.

## Control loops

1. **Compose loop** (`blank.yml` / `post-tweet.mjs`)
   - Rank RSS + build-in-public notes
   - Allocate content format
   - Generate + quality-gate
   - Publish only if cadence / runway / credits allow

2. **Learning loop** (`growth-maintenance.yml`)
   - Optional metrics backfill (paid reads, capped)
   - Evolve `growth-strategy.json` only when recent measured `n ≥ TWEET_GROWTH_MIN_SAMPLES`
   - Emit public reports + dashboard JSON

3. **Operator loop**
   - Manual reply drafts / route console when automation should not spend credits

## Hard guarantees we optimize for

- Prefer **zero live X search/read** for content selection
- Treat platform `402 credits depleted` as a first-class circuit breaker
- Keep image attach **off** until media ROI is measured
- Freeze weight mutations under low sample counts

## Key modules in `post-tweet.mjs`

| Area | Symbols |
|---|---|
| Credits breaker | `evaluateXCreditsCircuit`, `XCreditsDepletedError` |
| Format mix | `parseFormatBaseAllocation`, `selectContentFormats` |
| Evolution gate | `evolveGrowthStrategy` + `TWEET_GROWTH_MIN_SAMPLES` |
| Peaks | `peakZhUtcHours`, `peakEnUtcHours` |
| Media | `resolveImageAttachmentPlan`, `buildMediaRoiGate` |
