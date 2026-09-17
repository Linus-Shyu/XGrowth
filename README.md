# XGrowth

<p align="center">
  <strong>Open-source autonomous growth engine for X (Twitter)</strong><br/>
  Zero-waste API spend · bilingual peak posting · self-evolving hooks · live dashboard
</p>

<p align="center">
  <a href="https://github.com/Linus-Shyu/XGrowth/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Linus-Shyu/XGrowth/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
  <a href="https://linusshyu.dev/xbot-dashboard/"><img alt="Live Dashboard" src="https://img.shields.io/badge/Live-Dashboard-0A66C2"></a>
  <a href="https://x.com/Linus_Shyu"><img alt="Follow on X" src="https://img.shields.io/badge/X-@Linus__Shyu-black"></a>
</p>

> 用 GitHub Actions 跑的 **X 增长操作系统**：热点选题 → 钩子生成 → 峰时发帖 → 指标回填 → 策略自进化。  
> 设计目标不是“多发”，而是 **在有限 X API credits 下，把每一次写入都变成可学习的增长实验**。

**Live ops dashboard:** [linusshyu.dev/xbot-dashboard](https://linusshyu.dev/xbot-dashboard/)  
**Author:** [Linus Shyu](https://linusshyu.dev/portfolio/)

---

## Why this exists

Most “AI Twitter bots” burn quota on search/read APIs, post generic news rewrites, and never close the learning loop.

XGrowth is different:

| Principle | What it means |
|---|---|
| **Zero-read growth** | Prefer RSS + cached analytics over paid X search/read |
| **Credits-aware** | Local budget runway + real `402 credits depleted` circuit breaker |
| **Format bandit** | Bias toward proven hooks (`prediction` ~65%) with controlled exploration |
| **Bilingual peaks** | ZH / EN tracks at data-backed UTC windows |
| **Operator console** | Manual reply routes when automation should not spend credits |
| **Public proof** | Growth reports + live dashboard, not screenshots-only marketing |

If you want a black-box “set and forget spam machine”, this is not it.  
If you want a **production-grade, inspectable growth lab** that runs on GitHub Actions — star this and fork it.

---

## Feature highlights

- **Scheduled bilingual posting** with cadence guards (EN primary, ZH support)
- **DeepSeek / OpenAI-compatible** generation with quality gates
- **Self-evolving strategy** (`reports/growth-strategy.json`) — mutations freeze until `n≥10` measured samples
- **Media ROI gate** (images off by default until lift is proven)
- **Occasional OSS promo footer** — high-scoring posts can append `github.com/Linus-Shyu/XGrowth` (~28%, score ≥ 170)
- **Free dashboard sync** — `dashboard_only` rebuilds + publishes `data.json` with **0 X reads**; paid `live_snapshot` / `metrics_report` are manual
- **Credits-aligned API remaining** — when X returns `402 credits depleted`, available remaining is forced to `$0` while the local ledger stays visible
- **Growth maintenance**: metrics backfill, manual reply drafts, dashboard sync
- **Self-tests in CI**: local fallback, cost governor, learning loop, hourly load, dashboard validator

---

## Quickstart

### 1. Fork & clone

```bash
git clone https://github.com/Linus-Shyu/XGrowth.git
cd XGrowth
```

### 2. Configure GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions**

| Secret | Purpose |
|---|---|
| `OPENAI_API_KEY` | DeepSeek / OpenAI-compatible key |
| `X_CLIENT_ID` | X OAuth 2.0 client id |
| `X_CLIENT_SECRET` | X OAuth 2.0 client secret |
| `X_OAUTH2_REFRESH_TOKEN` | User-context refresh token |

Optional: `PEXELS_API_KEY` only if you enable images.

> Do **not** use an app-only Bearer token. Posting requires user-context OAuth with `tweet.read tweet.write users.read offline.access`.

### 3. Authorize X once

```bash
cp .env.oauth.local.example .env.oauth.local
# fill X_CLIENT_ID / X_CLIENT_SECRET
./.github/scripts/authorize-x.sh
```

Put the resulting refresh token into `X_OAUTH2_REFRESH_TOKEN`.

### 4. Enable schedules (after secrets)

Public template ships **dispatch-only** workflows so forks don’t fail without keys.  
Copy cron blocks from the README appendix (or your private runner) into:

- `.github/workflows/blank.yml` — posting windows  
- `.github/workflows/growth-maintenance.yml` — dashboard + metrics

Recommended posting windows (UTC) — language is locked to each slot:

```text
ZH: 12          # Beijing 20:00 evening prime
EN: 13, 16, 21  # US East morning / lunch / evening commute
```

### 5. Run self-tests locally

```bash
TWEET_SELF_TEST=local_fallback node .github/scripts/post-tweet.mjs
TWEET_SELF_TEST=cost_governor node .github/scripts/post-tweet.mjs
TWEET_SELF_TEST=learning_loop node .github/scripts/post-tweet.mjs
```

---

## Architecture (one screen)

```text
RSS / Build-in-public notes
        │
        ▼
  Story ranking + verdict cache
        │
        ▼
  Format allocation (prediction / decision_rule / brutal_truth / …)
        │
        ▼
  LLM draft + quality gate
        │
        ├─ credits / runway / cadence OK ──► create tweet (X write)
        │                                         │
        │                                         ▼
        │                                   archive + analytics
        │                                         │
        └─ blocked ──► skip / manual route console ◄─┘
                              │
                              ▼
                     growth-strategy evolve (n≥10)
                              │
                              ▼
                     public dashboard JSON
```

Core script: [`.github/scripts/post-tweet.mjs`](.github/scripts/post-tweet.mjs)

---

## Repository layout

```text
.github/
  scripts/           # posting, OAuth, dashboard validators
  workflows/         # CI self-tests + optional posting/maintenance
  config/            # RSS feed list
  content/           # build-in-public JSONL seeds
examples/            # sanitized analytics + tweet samples
reports/             # latest public growth artifacts (demo)
docs/                # architecture notes
```

---

## $5 / month success path

Designed to work on a hard **$5 X API** monthly cap with **zero automatic paid reads**.

| Do this | Cost | Notes |
|---|---|---|
| Fork → secrets → authorize once | $0 | Steps 1–3 above |
| Keep maintenance on `dashboard_only` | **$0** | Rebuilds reports + dashboard from cache |
| Post only in peak slots (ZH `12`, EN `13/16/21` UTC) | write only | Language is slot-locked |
| Complete **3 manual route replies** from the dashboard Tasks panel | **$0** | Browser paste; no X search/read API |
| Fix active-conn count with `TWEET_FOLLOWERS_OVERRIDE` | **$0** | Never auto-run `USER_ME` just to refresh the number |
| Keep weekly control arm = `decision_rule` | $0 extra | Treatment formats compare against this baseline |
| Run `live_snapshot` / `metrics_report` **manually only** | paid | Only when you consciously spend remaining credits |

Default guardrails shipped for this budget:

- `X_API_MONTHLY_BUDGET_USD=5`
- `X_API_BUDGET_SAFETY_RATIO=0.85`
- `DASHBOARD_EXPERIMENT_POST_SLOTS=2`
- `TWEET_WEEKLY_CONTROL_FORMAT_ID=decision_rule`
- Hotspot radar / auto-reply remain **off**

If credits return `402`, the dashboard forces available remaining to `$0` and the Tasks panel still gives you a zero-read day plan.

---

## Defaults that matter

| Knob | Public default | Why |
|---|---|---|
| `X_API_MONTHLY_BUDGET_USD` | `5` | Hard monthly spend ceiling |
| `X_API_BUDGET_SAFETY_RATIO` | `0.85` | Leave headroom under the $5 cap |
| `TWEET_WEEKLY_CONTROL_FORMAT_ID` | `decision_rule` | Fixed weekly control arm |
| `TWEET_CONTENT_FORMAT_IDS` | `prediction,decision_rule,brutal_truth,sharp_question` | Match measured winners |
| `TWEET_FORMAT_BASE_ALLOCATION` | `0.65 / 0.20 / 0.12 / 0.03` | Stable mix, not vibes |
| `TWEET_GROWTH_MIN_SAMPLES` | `10` | Stop fake “self-evolution” |
| `TWEET_IMAGE_ENABLED` | `false` | No image spend until ROI exists |
| `TWEET_AUTO_REPLY_*` | off / 0 | Credits go to posts + metrics |
| `TWEET_OSS_PROMO_*` | on / ~28% / score≥170 | Occasional repo footer without burning reads |
| `TWEET_MAINTENANCE_MODE` | `dashboard_only` | Free dashboard publish; paid modes are manual |
| `X_API_CREDITS_CIRCUIT_BREAKER_ENABLED` | `true` | Survive real `402` |

---

## Live demo artifacts

- Dashboard: https://linusshyu.dev/xbot-dashboard/
- Strategy snapshot: [`reports/growth-strategy.json`](reports/growth-strategy.json)
- Growth report: [`reports/growth-report.md`](reports/growth-report.md)
- Sample analytics: [`examples/tweet-analytics.sample.json`](examples/tweet-analytics.sample.json)

---

## Roadmap (help wanted)

- [ ] First-class Homebrew / one-click template repo
- [ ] Pluggable LLM providers beyond OpenAI-compatible APIs
- [ ] Verified media attachment audit (planned vs attached)
- [ ] Multi-account workspace mode
- [ ] Browser extension for one-click “paste route reply”

Open an issue with label `idea` or `good first issue`.

---

## Security

- Never commit `.env.oauth.local`, refresh tokens, or `.github/runtime/*`
- Rotate X client secrets if they ever leaked
- Treat growth reports as public analytics — strip anything private before publishing forks

See [SECURITY.md](SECURITY.md).

---

## License

[MIT](LICENSE) © 2026 Linus Shyu

---

## Star this if…

- you’re tired of bots that ignore API economics  
- you want an inspectable growth system, not a prompt pastebin  
- you believe open tooling beats closed “AI growth agencies”

<p align="center">
  <a href="https://github.com/Linus-Shyu/XGrowth">⭐ Star XGrowth on GitHub</a>
  ·
  <a href="https://linusshyu.dev/portfolio/">View Linus Shyu’s portfolio</a>
</p>
