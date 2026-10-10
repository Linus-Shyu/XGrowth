// Heartbeat guard: the #1 growth killer is a silently dead bot. This checks the
// tweet archive freshness and opens/closes a GitHub issue accordingly.
// Runs under node or bun; no Bun-only APIs.

const env = (name, fallback = "") => String(process.env[name] || "").trim() || fallback;

const ARCHIVE_FILE = env("HEARTBEAT_ARCHIVE_FILE", "archive/tweets.jsonl");
const STALE_HOURS = Number(env("HEARTBEAT_STALE_HOURS", "30"));
const REPO = env("HEARTBEAT_REPO", env("GITHUB_REPOSITORY", ""));
const TOKEN = env("GITHUB_TOKEN") || env("GH_TOKEN");
const ISSUE_TITLE_PREFIX = env("HEARTBEAT_ISSUE_TITLE_PREFIX", "[x_bot heartbeat]");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function ghFetch(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "x-bot-heartbeat",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function lastPostAgeHours() {
  const { readFile } = await import("node:fs/promises");
  let content = "";
  try {
    content = await readFile(ARCHIVE_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null; // archive missing entirely
    throw error;
  }
  const lines = content.trim().split("\n").filter(Boolean);
  let lastEntry = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.postedAt) {
        lastEntry = entry;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!lastEntry) return null;
  const ageHours = (Date.now() - Date.parse(lastEntry.postedAt)) / (60 * 60 * 1000);
  if (!Number.isFinite(ageHours)) return null;
  return {
    ageHours,
    lastEntry,
  };
}

async function findOpenAlertIssues() {
  if (!TOKEN || !REPO) return [];
  const { ok, status, data } = await ghFetch(
    `/repos/${REPO}/issues?state=open&per_page=100`,
  );
  if (!ok) {
    console.warn(`Issue listing returned ${status}; treating as no existing alerts.`);
    return [];
  }
  return (Array.isArray(data) ? data : []).filter(
    (issue) => !issue.pull_request && String(issue.title || "").startsWith(ISSUE_TITLE_PREFIX),
  );
}

async function main() {
  const fresh = await lastPostAgeHours();
  if (fresh == null) {
    console.warn(`No postedAt timestamps found in ${ARCHIVE_FILE}; treating as stale.`);
  } else {
    console.log(
      `Last post: ${fresh.lastEntry.url || fresh.lastEntry.id || "unknown"} (${fresh.lastEntry.postedAt}), ${fresh.ageHours.toFixed(1)}h ago.`,
    );
  }

  const stale = fresh == null || fresh.ageHours > STALE_HOURS;
  if (!stale) {
    console.log(`Heartbeat OK: bot posted within ${STALE_HOURS}h.`);
    if (!TOKEN || !REPO) return;
    const openIssues = await findOpenAlertIssues();
    for (const issue of openIssues) {
      await ghFetch(`/repos/${REPO}/issues/${issue.number}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: `✅ 已恢复发帖 (${new Date().toISOString()})。本次心跳检查通过, 自动关闭本告警。`,
        }),
      });
      await ghFetch(`/repos/${REPO}/issues/${issue.number}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      console.log(`Closed recovered heartbeat alert #${issue.number}.`);
    }
    return;
  }

  const ageText = fresh == null ? "archive 无可用时间戳" : `${fresh.ageHours.toFixed(1)} 小时`;
  console.warn(`HEARTBEAT STALE: bot has not posted for ${ageText} (threshold ${STALE_HOURS}h).`);

  if (!TOKEN || !REPO) {
    console.warn("GITHUB_TOKEN or GITHUB_REPOSITORY missing; cannot open an issue.");
    return;
  }
  const openIssues = await findOpenAlertIssues();
  if (openIssues.length) {
    console.log(`Alert already open: #${openIssues.map((issue) => issue.number).join(", ")}; skipping duplicate.`);
    return;
  }

  const { ok, status, data } = await ghFetch(`/repos/${REPO}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `${ISSUE_TITLE_PREFIX} x_bot 停更超过 ${STALE_HOURS} 小时`,
      body: [
        "## 自动告警:x_bot 疑似停更",
        "",
        `- 检查时间: ${new Date().toISOString()}`,
        fresh
          ? `- 最后发帖: ${fresh.lastEntry.url || fresh.lastEntry.id} (${fresh.lastEntry.postedAt}, 距今 ${ageText})`
          : "- 最后发帖: 未找到(archive 缺失或无 postedAt)",
        "- 常见原因: X refresh token 失效 / X credits 耗尽 / DeepSeek key 失效 / RSS 全挂 / GitHub Actions 被禁用",
        "",
        "修复后本告警会在下次心跳通过时自动关闭。",
      ].join("\n"),
    }),
  });
  if (ok && data?.number) {
    console.log(`Opened heartbeat alert issue #${data.number}.`);
  } else {
    console.warn(`Failed to open alert issue (${status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
