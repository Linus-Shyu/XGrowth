#!/usr/bin/env bash
set -euo pipefail

# Delete GitHub Actions caches for OAuth tokens.
# Learning caches (x-bot-learning-*) are intentionally not purged.
# Also deletes legacy mixed caches (x-bot-runtime-*) that bundled tokens + learning.
# Requires GITHUB_TOKEN with actions:write and GITHUB_REPOSITORY (owner/repo).

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
PREFIXES="${RUNTIME_CACHE_KEY_PREFIXES:-x-bot-tokens,x-bot-runtime}"
API="https://api.github.com/repos/${REPO}/actions/caches"

deleted=0

echo "Purging Actions caches in ${REPO} with key prefixes: ${PREFIXES}"
echo "Learning caches with prefix x-bot-learning- are kept."

IFS=',' read -r -a prefix_list <<< "${PREFIXES}"

for PREFIX in "${prefix_list[@]}"; do
  PREFIX="$(printf '%s' "$PREFIX" | tr -d '[:space:]')"
  if [ -z "$PREFIX" ] || [ "$PREFIX" = "x-bot-learning" ]; then
    continue
  fi

  page=1
  while true; do
    response="$(curl -fsS \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "${API}?per_page=100&page=${page}")"

    mapfile -t ids < <(printf '%s' "$response" | jq -r --arg prefix "$PREFIX" \
      '.actions_caches[]? | select(.key | startswith($prefix)) | .id')

    if ((${#ids[@]} == 0)); then
      break
    fi

    for id in "${ids[@]}"; do
      key="$(printf '%s' "$response" | jq -r --arg id "$id" \
        '.actions_caches[] | select(.id == ($id | tonumber)) | .key')"
      if [[ "$key" == x-bot-learning* ]]; then
        echo "Skipping learning cache id=${id} key=${key}"
        continue
      fi
      curl -fsS -X DELETE \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${API}/${id}" >/dev/null
      echo "Deleted cache id=${id} key=${key}"
      deleted=$((deleted + 1))
    done

    total_count="$(printf '%s' "$response" | jq -r '.total_count // 0')"
    if ((${#ids[@]} < 100)) || ((page * 100 >= total_count)); then
      break
    fi
    page=$((page + 1))
  done
done

if ((deleted == 0)); then
  echo "No matching token/legacy runtime caches found."
else
  echo "Purged ${deleted} token/legacy cache entr$( ((deleted == 1)) && echo y || echo ies )."
fi
