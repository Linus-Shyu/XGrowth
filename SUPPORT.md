# Support

## How to get help

| Channel | Use for |
|---|---|
| [GitHub Discussions](https://github.com/Linus-Shyu/XGrowth/discussions) | Setup questions, fork showcases, design ideas |
| [GitHub Issues](https://github.com/Linus-Shyu/XGrowth/issues) | Bugs and actionable feature requests |
| [SECURITY.md](SECURITY.md) | Private vulnerability / secret-leak reports |
| [Live dashboard](https://linusshyu.dev/xbot-dashboard/) | Reference of a production `dashboard_only` sync |

## Before you open an issue

1. Confirm secrets are set (`OPENAI_API_KEY`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_OAUTH2_REFRESH_TOKEN`).
2. Run the CI self-tests locally (see [CONTRIBUTING.md](CONTRIBUTING.md)).
3. Prefer `dashboard_only` maintenance when debugging the board — it costs **$0** X credits.
4. Redact tokens and `.github/runtime/*` caches from logs before pasting.

## Maintained surface

- Supported line: `main`
- Runtime: Node.js 22+ (Bun optional for local runs)
- Host: GitHub Actions

Commercial growth agency support is **not** included — this is an open research/ops codebase.
