# Contributing to XGrowth

Thanks for helping make open growth tooling better.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Ground rules

1. **No secrets in PRs** — never commit tokens, `.env` files, or live `.github/runtime/*` caches.
2. Prefer **small, testable** changes with a self-test when behavior changes.
3. Keep the product philosophy: **zero-waste X API spend**, inspectable decisions, bilingual peaks.
4. Report vulnerabilities privately via [SECURITY.md](SECURITY.md) — never in a public issue.

## Development setup

```bash
git clone https://github.com/Linus-Shyu/XGrowth.git
cd XGrowth

# Optional local OAuth smoke (never commit the filled file)
cp .env.oauth.local.example .env.oauth.local
```

Node.js **22+** is enough for CI parity. Bun works for local runs if you prefer it.

## Self-tests (required for PRs)

```bash
TWEET_SELF_TEST=local_fallback node .github/scripts/post-tweet.mjs
TWEET_SELF_TEST=cost_governor node .github/scripts/post-tweet.mjs
TWEET_SELF_TEST=learning_loop node .github/scripts/post-tweet.mjs
TWEET_SELF_TEST=hourly_load node .github/scripts/post-tweet.mjs
node .github/scripts/validate-dashboard-data.mjs --self-test
```

CI runs the same suite on every pull request.

## Security requirements for contributions

- Load real credentials only from environment variables / Actions secrets.
- Use clearly fake values in examples, fixtures, and sample JSON under `examples/`.
- Redact `Authorization` headers and refresh tokens from logs, exceptions, and screenshots.
- Review dependency and workflow diffs carefully; prefer pinned, reviewed Actions.
- Do not add automatic paid X reads under the default `$5` monthly budget path.

## Good first issues

- Docs clarity / Chinese translation of the `$5` success path
- New RSS sources with tier labels
- Dashboard copy that avoids forbidden “tweet vocabulary” in public JSON
- Extra self-tests for the credits circuit breaker

## Pull request checklist

- [ ] Self-tests pass locally
- [ ] No secrets or personal tokens
- [ ] README / `CHANGELOG.md` updated when behavior changes
- [ ] For strategy changes: explain sample-size impact (`n≥10` gate)
- [ ] For budget / OAuth / publishing changes: call it out for CODEOWNERS review

## Release notes

User-facing changes land in [CHANGELOG.md](CHANGELOG.md). Maintainers cut GitHub Releases from `main` when tagging.
