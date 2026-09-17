#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_FILE="${TWEET_ARCHIVE_FILE:-archive/tweets.jsonl}"
SYNC_REPO="${TWEET_SYNC_REPO:-Linus-Shyu/Tweets}"
SYNC_TOKEN="${TWEET_SYNC_GITHUB_TOKEN:-}"
SYNC_PATH="${TWEET_SYNC_PATH:-tweets.jsonl}"
SYNC_BRANCH="${TWEET_SYNC_BRANCH:-}"

if [[ -z "$SYNC_REPO" ]]; then
  echo "TWEET_SYNC_REPO is not set. Skipping external archive sync."
  exit 0
fi

if [[ -z "$SYNC_TOKEN" ]]; then
  echo "Missing secret TWEET_SYNC_GITHUB_TOKEN. Skipping external archive sync."
  exit 0
fi

SYNC_TOKEN="$(printf '%s' "$SYNC_TOKEN" | tr -d '[:space:]')"

if [[ ! -s "$ARCHIVE_FILE" ]]; then
  echo "Archive file not found or empty: $ARCHIVE_FILE"
  exit 1
fi

OWNER="${SYNC_REPO%%/*}"
REPO="${SYNC_REPO#*/}"
API_ROOT="https://api.github.com/repos/${OWNER}/${REPO}"
CONTENTS_URL="${API_ROOT}/contents/${SYNC_PATH}"
CONTENTS_READ_URL="$CONTENTS_URL"
if [[ -n "$SYNC_BRANCH" ]]; then
  CONTENTS_READ_URL="${CONTENTS_URL}?ref=${SYNC_BRANCH}"
fi

github_api() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  if [[ -n "$data" ]]; then
    local data_arg=("-d" "$data")
    if [[ "$data" == @* ]]; then
      data_arg=("--data-binary" "$data")
    fi
    curl -sS -X "$method" \
      -H "Authorization: Bearer ${SYNC_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" \
      "${data_arg[@]}" \
      -w "\n__HTTP__%{http_code}" \
      "$url"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer ${SYNC_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -w "\n__HTTP__%{http_code}" \
      "$url"
  fi
}

parse_http_code() {
  printf '%s' "$1" | sed -n 's/.*__HTTP__\([0-9][0-9][0-9]\)$/\1/p'
}

parse_body() {
  printf '%s' "$1" | sed 's/__HTTP__[0-9][0-9][0-9]$//'
}

print_pat_help() {
  echo ""
  echo "Fix TWEET_SYNC_GITHUB_TOKEN in x_bot -> Settings -> Secrets -> Actions:"
  echo "  1. https://github.com/settings/personal-access-tokens/new"
  echo "  2. Fine-grained token"
  echo "  3. Resource owner: ${OWNER}"
  echo "  4. Repository access: ONLY ${SYNC_REPO}"
  echo "  5. Permissions: Contents -> Read and write"
  echo "  6. Save new token to secret TWEET_SYNC_GITHUB_TOKEN"
  echo ""
  echo "Classic token also works: enable the full 'repo' scope."
}

echo "Checking access to ${SYNC_REPO}..."
REPO_CHECK="$(github_api GET "$API_ROOT")"
REPO_CODE="$(parse_http_code "$REPO_CHECK")"
REPO_BODY="$(parse_body "$REPO_CHECK")"

if [[ "$REPO_CODE" == "404" ]]; then
  echo "Repository not found: ${SYNC_REPO}"
  echo "Create it first: https://github.com/new?name=${REPO}"
  exit 1
fi

if [[ "$REPO_CODE" != "200" ]]; then
  echo "Cannot access ${SYNC_REPO}: HTTP ${REPO_CODE}"
  echo "$REPO_BODY"
  print_pat_help
  exit 1
fi

echo "Repository access OK."

EXISTING="$(github_api GET "$CONTENTS_READ_URL")"
EXISTING_CODE="$(parse_http_code "$EXISTING")"
EXISTING_BODY="$(parse_body "$EXISTING")"
SHA=""
if [[ "$EXISTING_CODE" == "200" ]]; then
  SHA="$(printf '%s' "$EXISTING_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha',''))")"
elif [[ "$EXISTING_CODE" != "404" ]]; then
  echo "Failed to read ${SYNC_PATH}: HTTP ${EXISTING_CODE}"
  echo "$EXISTING_BODY"
  print_pat_help
  exit 1
fi

COMMIT_MESSAGE="sync: tweet archive $(date -u +%Y-%m-%dT%H:%MZ)"
PAYLOAD_FILE="$(mktemp)"
trap 'rm -f "$PAYLOAD_FILE"' EXIT
python3 - "$ARCHIVE_FILE" "$SHA" "$COMMIT_MESSAGE" "$SYNC_BRANCH" > "$PAYLOAD_FILE" <<'PY'
import base64
import json
import sys

archive_file, sha, message, branch = sys.argv[1:5]
with open(archive_file, "rb") as handle:
    content = base64.b64encode(handle.read()).decode("ascii")
payload = {
    "message": message,
    "content": content,
}
if sha.strip():
    payload["sha"] = sha
if branch.strip():
    payload["branch"] = branch
print(json.dumps(payload))
PY

UPLOAD="$(github_api PUT "$CONTENTS_URL" "@${PAYLOAD_FILE}")"
UPLOAD_CODE="$(parse_http_code "$UPLOAD")"
UPLOAD_BODY="$(parse_body "$UPLOAD")"

if [[ "$UPLOAD_CODE" != "200" && "$UPLOAD_CODE" != "201" ]]; then
  echo "Failed to upload ${SYNC_PATH} to ${SYNC_REPO}: HTTP ${UPLOAD_CODE}"
  echo "$UPLOAD_BODY"
  print_pat_help
  exit 1
fi

echo "Synced tweet archive to ${SYNC_REPO}:${SYNC_PATH}"
