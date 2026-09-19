## Summary

<!-- What changed and why? Link related issues with `Fixes #123` when applicable. -->

## Test plan

- [ ] `TWEET_SELF_TEST=local_fallback node .github/scripts/post-tweet.mjs`
- [ ] `TWEET_SELF_TEST=cost_governor node .github/scripts/post-tweet.mjs`
- [ ] `TWEET_SELF_TEST=learning_loop node .github/scripts/post-tweet.mjs`
- [ ] `node .github/scripts/validate-dashboard-data.mjs --self-test` (if dashboard/contract touched)
- [ ] No secrets, tokens, `.env`, or live `.github/runtime/*` caches in the diff

## Notes for reviewers

<!-- Call out budget/credits impact, sample-size gates (`n≥10`), or dashboard contract changes. -->
