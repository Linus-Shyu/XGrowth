#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env.oauth.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  echo "Loaded credentials from .env.oauth.local"
fi

if [[ -z "${X_CLIENT_ID:-}" || -z "${X_CLIENT_SECRET:-}" ]]; then
  cat <<'EOF'
缺少 X_CLIENT_ID 或 X_CLIENT_SECRET。

方式 A（推荐，不会进 git）:
  cp .env.oauth.local.example .env.oauth.local
  # 编辑 .env.oauth.local，填入 X Developer Portal 的 Client ID 和 Client Secret
  bash .github/scripts/authorize-x.sh

方式 B（一次性命令）:
  X_CLIENT_ID="你的ClientID" \
  X_CLIENT_SECRET="你的ClientSecret" \
  bash .github/scripts/authorize-x.sh

重要: 必须用 OAuth 2.0 Client ID / Client Secret，不是 API Key / Consumer Keys。

X Developer Portal → User authentication settings:
  - Callback URI: http://localhost:3000
  - App permissions: Read and write
  - Type: Web App / Automated App or Bot

授权成功后:
  1. 复制终端输出的 refresh_token
  2. 更新 GitHub Secrets: X_CLIENT_ID, X_CLIENT_SECRET, X_OAUTH2_REFRESH_TOKEN
  3. 只删除 Actions cache: x-bot-tokens-* （不要删 x-bot-learning-*）
EOF
  exit 1
fi

node .github/scripts/x-oauth-authorize.mjs
