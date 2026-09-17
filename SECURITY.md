# Security Policy

## Supported versions

The `main` branch is the only supported line.

## Reporting a vulnerability

Email **0x11@linusshyu.dev** with:

- affected file / workflow
- reproduction steps
- whether tokens or user data were exposed

Please **do not** open a public issue for secret leaks.

## Secret handling

Never commit:

- `X_CLIENT_SECRET`
- `X_OAUTH2_REFRESH_TOKEN`
- `OPENAI_API_KEY`
- `.env.oauth.local`
- `.github/runtime/*` caches

If you fork XGrowth, assume your Actions logs may be public — redact aggressively.
