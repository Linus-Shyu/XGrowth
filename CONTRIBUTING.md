# Contributing to XGrowth

Thanks for helping make open growth tooling better.

## Ground rules

1. **No secrets in PRs** — no tokens, `.env`, or live runtime caches.
2. Prefer **small, testable** changes with a self-test when possible.
3. Keep the product philosophy: **zero-waste X API spend**, inspectable decisions, bilingual peaks.

## Dev loop

```bash
TWEET_SELF_TEST=local_fallback node .github/scripts/post-tweet.mjs
TWEET_SELF_TEST=cost_governor node .github/scripts/post-tweet.mjs
TWEET_SELF_TEST=learning_loop node .github/scripts/post-tweet.mjs
node .github/scripts/validate-dashboard-data.mjs --self-test
```

CI runs the same suite on every PR.

## Good first issues

- docs clarity / translation
- new RSS sources with tier labels
- dashboard copy that avoids forbidden “tweet vocabulary” in public JSON
- extra self-tests for credits circuit breaker

## PR checklist

- [ ] Self-tests pass locally
- [ ] No secrets or personal tokens
- [ ] README / comments updated if behavior changed
- [ ] For strategy changes: explain sample-size impact (`n≥10` gate)
