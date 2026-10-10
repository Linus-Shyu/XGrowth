# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for public release tags.

## [Unreleased]

### Added

- Weekly auto `metrics_report` schedule (Sun 23:20 UTC, ~$0.05) with account-snapshot off by default for the $5 path.
- Open-source community pack aligned with common OpenAI public-repo conventions:
  `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `SUPPORT.md`, PR template, issue contact links, and `CODEOWNERS`.
- Growth levers beyond the posting loop:
  - `engagement` maintenance mode + workflow: one whitelist quote per run inside the X API budget (~$0.115/run, cron commented out by default).
  - `heartbeat` workflow: opens an issue after `HEARTBEAT_STALE_HOURS` (30h) without posts; auto-closes on recovery.
  - `sync-github-events.mjs`: turns commits / merged PRs / releases / stars into build-in-public notes.
  - Weekly auto-thread: replies to the best-scoring post (score ≥ baseline × `TWEET_AUTO_THREAD_MIN_SCORE_MULTIPLIER`) with one continuation.
  - Weekly prediction receipts: posts only when fresh news clearly confirms or refutes a `prediction` post.
  - Weekly platform variants: rewrites the best post for LinkedIn / Jike / Zhihu into `reports/platform-variants.md`.
  - `newsletter-digest.mjs`: writes `reports/newsletter-digest.md`; sends email via Resend when `RESEND_API_KEY` / `NEWSLETTER_FROM` / `NEWSLETTER_TO` are set.
  - Follower delta rows (`follower_delta`) in `growth-evolution.jsonl` + a report section; growth report now also compares "OSS promo vs organic" post performance.
- LLM cost controls: `TWEET_STORY_VERDICT_MODE=auto` (skip AI story verdicts when images are off), `TWEET_PROMPT_LEAN_CONTEXT=true`, static-first prompt ordering for DeepSeek context-cache hits, `OPENAI_MAX_TOKENS`, tighter context defaults (`TWEET_CANDIDATE_COUNT=2`, `NEWS_MAX_ITEMS=3`, `TWEET_STORY_PICK_MAX=2`, history context cap `4`).
- Weekly `self-tests` workflow; self-tests removed from the posting path to cut cold-start latency, and `setup-bun` pinned to `1.4.2`.
- Lean v2 panel payload: `panel-data.json` (~3 KB) replaces the 1.8 MB dashboard JSON as the public panel source; auto-synced to `xbot-dashboard/panel.json`, validated by a v2 contract with a 300 KB size guard.

### Changed

- `TWEET_AI_QUALITY_GATE_ENABLED` now defaults to `true` (one cheap call per run; falls back to the top local candidate when it rejects).
- Draft reuse defaults extended (`TWEET_FOLLOWUP_DRAFT_REUSE_HOURS` / `TWEET_REPLY_DRAFT_REUSE_HOURS` 20 → 48), follow-up drafts capped at 1 per run, `TWEET_BUILD_IN_PUBLIC_RATIO` 0.35 → 0.55.
- Story verdict budget: `TWEET_STORY_PICK_MAX` default 5 → 2; hybrid content kind is decided before spending AI verdict calls.
- Dashboard sync now ships the lean `panel.json` payload (v2 contract) instead of the full v1 `data.json`.

### Fixed

- Analytics retention now keeps the **newest** posts when over the 250-record cap, so archive seeds still appear in `last24h`.
- Free `dashboard_only` sync no longer surfaces expected budget/follower-cache skips as ops outages.
- Empty GitHub language bar: un-vendor `.github/scripts` and `.github/workflows` for Linguist.

## [0.1.0] - 2026-09-18

### Added

- Public MIT release of the XGrowth GitHub Actions growth engine.
- `$5` / month success path with zero automatic paid X reads.
- Credits circuit recovery (`clear_credits_circuit`) and operator task writeback.
- Live dashboard demo and public growth report artifacts.
- CI self-tests: local fallback, cost governor, learning loop, hourly load, dashboard validator.
- Good-first-issue templates for docs, RSS feeds, and dashboard i18n.
