# Security Policy

## Supported versions

| Branch | Supported |
|---|---|
| `main` | Yes |
| Other branches / forks | Best-effort only |

## Reporting a vulnerability

Email **0x11@linusshyu.dev** with:

- affected file / workflow
- reproduction steps
- whether tokens or user data were exposed

Please **do not** open a public issue for secret leaks.

We aim to acknowledge reports within **72 hours**.

## Secret handling

Never commit:

- `X_CLIENT_SECRET`
- `X_OAUTH2_REFRESH_TOKEN`
- `OPENAI_API_KEY`
- `.env.oauth.local`
- `.github/runtime/*` caches

If you fork XGrowth, assume your Actions logs may be public — redact aggressively.

## Scope

In scope: credential handling, workflow permissions, dashboard sync tokens, and accidental publish of private analytics.

Out of scope: X / OpenAI platform outages, third-party RSS content, and social-engineering of your own secrets.
