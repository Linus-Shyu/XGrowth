# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for public release tags.

## [Unreleased]

### Added

- Open-source community pack aligned with common OpenAI public-repo conventions:
  `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `SUPPORT.md`, PR template, issue contact links, and `CODEOWNERS`.

### Fixed

- Analytics retention now keeps the **newest** posts when over the 250-record cap, so archive seeds still appear in `last24h`.
- Free `dashboard_only` sync no longer surfaces expected budget/follower-cache skips as ops outages.

## [0.1.0] - 2026-09-18

### Added

- Public MIT release of the XGrowth GitHub Actions growth engine.
- `$5` / month success path with zero automatic paid X reads.
- Credits circuit recovery (`clear_credits_circuit`) and operator task writeback.
- Live dashboard demo and public growth report artifacts.
- CI self-tests: local fallback, cost governor, learning loop, hourly load, dashboard validator.
- Good-first-issue templates for docs, RSS feeds, and dashboard i18n.
