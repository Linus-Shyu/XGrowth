#!/usr/bin/env bash
set -euo pipefail

DATA_FILE="${DASHBOARD_DATA_FILE:-.github/runtime/dashboard-data.json}"
SYNC_REPO="${DASHBOARD_SYNC_REPO:-Linus-Shyu/Linus-Shyu.github.io}"
SYNC_TOKEN_SOURCE=""
if [[ -n "${DASHBOARD_SYNC_GITHUB_TOKEN:-}" ]]; then
  SYNC_TOKEN="${DASHBOARD_SYNC_GITHUB_TOKEN}"
  SYNC_TOKEN_SOURCE="DASHBOARD_SYNC_GITHUB_TOKEN"
elif [[ -n "${TWEET_SYNC_GITHUB_TOKEN:-}" ]]; then
  SYNC_TOKEN="${TWEET_SYNC_GITHUB_TOKEN}"
  SYNC_TOKEN_SOURCE="TWEET_SYNC_GITHUB_TOKEN"
else
  SYNC_TOKEN=""
fi
SYNC_PATHS="${DASHBOARD_SYNC_PATHS:-xbot-dashboard/data.json,docs/xbot-dashboard/data.json}"
SYNC_REQUIRED="${DASHBOARD_SYNC_REQUIRED:-true}"

is_required() {
  case "$(printf '%s' "$SYNC_REQUIRED" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

stop_or_skip() {
  local message="$1"
  echo "$message"
  if is_required; then
    exit 1
  fi
  echo "Dashboard sync is optional; skipping."
  exit 0
}

if [[ -z "$SYNC_REPO" ]]; then
  stop_or_skip "DASHBOARD_SYNC_REPO is empty."
fi

echo "Dashboard sync target repo: ${SYNC_REPO}"
echo "Dashboard sync target paths: ${SYNC_PATHS}"

if [[ ! -s "$DATA_FILE" ]]; then
  echo "Dashboard data file not found or empty: $DATA_FILE"
  exit 1
fi

DATA_UPDATED_AT="$(python3 - "$DATA_FILE" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        print(json.load(fh).get("updatedAt", "unknown"))
except Exception:
    print("unknown")
PY
)"
echo "Dashboard data updatedAt: ${DATA_UPDATED_AT}"

echo "Validating dashboard data contract..."
node .github/scripts/validate-dashboard-data.mjs "$DATA_FILE"

if [[ -z "$SYNC_TOKEN" ]]; then
  echo "Missing DASHBOARD_SYNC_GITHUB_TOKEN."
  echo "Set it to a GitHub token with Contents: Read and write for ${SYNC_REPO}."
  stop_or_skip "Dashboard sync cannot continue without a token."
fi

SYNC_TOKEN="$(printf '%s' "$SYNC_TOKEN" | tr -d '[:space:]')"
echo "Dashboard sync token source: ${SYNC_TOKEN_SOURCE}"
echo "Dashboard sync token length after trimming: ${#SYNC_TOKEN}"

OWNER="${SYNC_REPO%%/*}"
REPO="${SYNC_REPO#*/}"
API_ROOT="https://api.github.com/repos/${OWNER}/${REPO}"

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
  echo "Fix DASHBOARD_SYNC_GITHUB_TOKEN in x_bot -> Settings -> Secrets -> Actions:"
  echo "  1. https://github.com/settings/personal-access-tokens/new"
  echo "  2. Fine-grained token"
  echo "  3. Resource owner: ${OWNER}"
  echo "  4. Repository access: ONLY ${SYNC_REPO}"
  echo "  5. Permissions: Contents -> Read and write"
  echo "  6. Save token to secret DASHBOARD_SYNC_GITHUB_TOKEN"
  echo ""
}

echo "Checking access to ${SYNC_REPO}..."
REPO_CHECK="$(github_api GET "$API_ROOT")"
REPO_CODE="$(parse_http_code "$REPO_CHECK")"
REPO_BODY="$(parse_body "$REPO_CHECK")"

if [[ "$REPO_CODE" != "200" ]]; then
  echo "Cannot access ${SYNC_REPO}: HTTP ${REPO_CODE}"
  echo "$REPO_BODY"
  print_pat_help
  stop_or_skip "Dashboard sync token cannot access ${SYNC_REPO}."
fi

DEFAULT_BRANCH="$(printf '%s' "$REPO_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('default_branch','master'))")"
COMMIT_MESSAGE="sync: x bot dashboard $(date -u +%Y-%m-%dT%H:%MZ)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Collect target paths once so both copies land in the same commit.
PATHS_FILE="${TMP_DIR}/paths.txt"
: > "$PATHS_FILE"
IFS=',' read -r -a paths <<< "$SYNC_PATHS"
for raw_path in "${paths[@]}"; do
  path="$(printf '%s' "$raw_path" | xargs)"
  [[ -n "$path" ]] || continue
  printf '%s\n' "$path" >> "$PATHS_FILE"
done

if [[ ! -s "$PATHS_FILE" ]]; then
  stop_or_skip "DASHBOARD_SYNC_PATHS is empty."
fi

REF_GET_URL="${API_ROOT}/git/ref/heads/${DEFAULT_BRANCH}"
REF_UPDATE_URL="${API_ROOT}/git/refs/heads/${DEFAULT_BRANCH}"
REF_RESP="$(github_api GET "$REF_GET_URL")"
REF_CODE="$(parse_http_code "$REF_RESP")"
REF_BODY="$(parse_body "$REF_RESP")"
if [[ "$REF_CODE" != "200" ]]; then
  echo "Failed to read ${DEFAULT_BRANCH} ref: HTTP ${REF_CODE}"
  echo "$REF_BODY"
  print_pat_help
  stop_or_skip "Dashboard sync cannot read ${SYNC_REPO} branch ref."
fi

BASE_COMMIT_SHA="$(printf '%s' "$REF_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['object']['sha'])")"
COMMIT_RESP="$(github_api GET "${API_ROOT}/git/commits/${BASE_COMMIT_SHA}")"
COMMIT_CODE="$(parse_http_code "$COMMIT_RESP")"
COMMIT_BODY="$(parse_body "$COMMIT_RESP")"
if [[ "$COMMIT_CODE" != "200" ]]; then
  echo "Failed to read base commit ${BASE_COMMIT_SHA}: HTTP ${COMMIT_CODE}"
  echo "$COMMIT_BODY"
  stop_or_skip "Dashboard sync cannot read base commit."
fi

BASE_TREE_SHA="$(printf '%s' "$COMMIT_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['tree']['sha'])")"

# Create one blob from the dashboard payload, then point every sync path at it.
BLOB_PAYLOAD="${TMP_DIR}/blob.json"
python3 - "$DATA_FILE" "$BLOB_PAYLOAD" <<'PY'
import base64, json, sys
data_file, out_file = sys.argv[1:3]
with open(data_file, "rb") as handle:
    content = base64.b64encode(handle.read()).decode("ascii")
with open(out_file, "w", encoding="utf-8") as handle:
    json.dump({"content": content, "encoding": "base64"}, handle, separators=(",", ":"))
PY

BLOB_RESP="$(github_api POST "${API_ROOT}/git/blobs" "@${BLOB_PAYLOAD}")"
BLOB_CODE="$(parse_http_code "$BLOB_RESP")"
BLOB_BODY="$(parse_body "$BLOB_RESP")"
if [[ "$BLOB_CODE" != "201" && "$BLOB_CODE" != "200" ]]; then
  echo "Failed to create blob: HTTP ${BLOB_CODE}"
  echo "$BLOB_BODY"
  print_pat_help
  stop_or_skip "Dashboard sync cannot create blob."
fi

BLOB_SHA="$(printf '%s' "$BLOB_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])")"

TREE_PAYLOAD="${TMP_DIR}/tree.json"
python3 - "$PATHS_FILE" "$BLOB_SHA" "$BASE_TREE_SHA" "$TREE_PAYLOAD" <<'PY'
import json, sys
paths_file, blob_sha, base_tree, out_file = sys.argv[1:5]
paths = [line.strip() for line in open(paths_file, encoding="utf-8") if line.strip()]
payload = {
    "base_tree": base_tree,
    "tree": [
        {"path": path, "mode": "100644", "type": "blob", "sha": blob_sha}
        for path in paths
    ],
}
with open(out_file, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"))
PY

TREE_RESP="$(github_api POST "${API_ROOT}/git/trees" "@${TREE_PAYLOAD}")"
TREE_CODE="$(parse_http_code "$TREE_RESP")"
TREE_BODY="$(parse_body "$TREE_RESP")"
if [[ "$TREE_CODE" != "201" && "$TREE_CODE" != "200" ]]; then
  echo "Failed to create tree: HTTP ${TREE_CODE}"
  echo "$TREE_BODY"
  stop_or_skip "Dashboard sync cannot create tree."
fi

TREE_SHA="$(printf '%s' "$TREE_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])")"

COMMIT_PAYLOAD="${TMP_DIR}/commit.json"
python3 - "$COMMIT_MESSAGE" "$TREE_SHA" "$BASE_COMMIT_SHA" "$COMMIT_PAYLOAD" <<'PY'
import json, sys
message, tree_sha, parent_sha, out_file = sys.argv[1:5]
payload = {
    "message": message,
    "tree": tree_sha,
    "parents": [parent_sha],
}
with open(out_file, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"))
PY

NEW_COMMIT_RESP="$(github_api POST "${API_ROOT}/git/commits" "@${COMMIT_PAYLOAD}")"
NEW_COMMIT_CODE="$(parse_http_code "$NEW_COMMIT_RESP")"
NEW_COMMIT_BODY="$(parse_body "$NEW_COMMIT_RESP")"
if [[ "$NEW_COMMIT_CODE" != "201" && "$NEW_COMMIT_CODE" != "200" ]]; then
  echo "Failed to create commit: HTTP ${NEW_COMMIT_CODE}"
  echo "$NEW_COMMIT_BODY"
  stop_or_skip "Dashboard sync cannot create commit."
fi

NEW_COMMIT_SHA="$(printf '%s' "$NEW_COMMIT_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])")"

REF_PAYLOAD="${TMP_DIR}/ref.json"
python3 - "$NEW_COMMIT_SHA" "$REF_PAYLOAD" <<'PY'
import json, sys
sha, out_file = sys.argv[1:3]
with open(out_file, "w", encoding="utf-8") as handle:
    json.dump({"sha": sha, "force": False}, handle, separators=(",", ":"))
PY

UPDATE_REF_RESP="$(github_api PATCH "$REF_UPDATE_URL" "@${REF_PAYLOAD}")"
UPDATE_REF_CODE="$(parse_http_code "$UPDATE_REF_RESP")"
UPDATE_REF_BODY="$(parse_body "$UPDATE_REF_RESP")"
if [[ "$UPDATE_REF_CODE" != "200" ]]; then
  echo "Failed to update ${DEFAULT_BRANCH}: HTTP ${UPDATE_REF_CODE}"
  echo "$UPDATE_REF_BODY"
  stop_or_skip "Dashboard sync cannot update branch ref."
fi

while read -r path; do
  [[ -n "$path" ]] || continue
  echo "Synced dashboard data to ${SYNC_REPO}:${path}"
done < "$PATHS_FILE"
echo "Dashboard sync commit: ${NEW_COMMIT_SHA}"
