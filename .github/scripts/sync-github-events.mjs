// Sync public GitHub activity into .github/content/build-in-public.jsonl so the
// tweet pipeline gets fresh first-party build-in-public material for free.
// Runs under bun or node; no Bun-only APIs.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

const env = (name, fallback = "") => String(process.env[name] || "").trim() || fallback;

const OWNER = env("GITHUB_EVENTS_OWNER", env("GITHUB_REPOSITORY_OWNER", ""));
const TOKEN = env("GITHUB_TOKEN") || env("GH_TOKEN");
const CONTENT_FILE = env("TWEET_BUILD_IN_PUBLIC_FILE", ".github/content/build-in-public.jsonl");
const SYNC_STATE_FILE = env("GITHUB_EVENTS_SYNC_FILE", ".github/runtime/github-events-sync.json");
const MAX_AGE_DAYS = Number(env("GITHUB_EVENTS_MAX_AGE_DAYS", "4"));
const LIMIT = Number(env("GITHUB_EVENTS_LIMIT", "8"));
const EXCLUDE_REPOS = new Set(
  env("GITHUB_EVENTS_EXCLUDE_REPOS", "x_bot")
    .split(/[,\s]+/)
    .map((repo) => repo.toLowerCase())
    .filter(Boolean),
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function ghFetch(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "x-bot-github-events-sync",
    },
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function clean(value, max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function noteFromEvent(event) {
  const repo = String(event.repo?.name || "").replace(`${OWNER}/`, "");
  if (EXCLUDE_REPOS.has(repo.toLowerCase())) return null;
  const createdAt = event.created_at || new Date().toISOString();
  const ageDays = (Date.now() - Date.parse(createdAt)) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays) || ageDays > MAX_AGE_DAYS) return null;

  const base = {
    id: `github:${event.id}`,
    product: repo,
    date: createdAt,
    tags: ["github", "build-in-public"],
    public: true,
  };

  if (event.type === "ReleaseEvent" && event.payload?.release) {
    const release = event.payload.release;
    const tag = clean(release.tag_name, 40);
    return {
      ...base,
      kind: "milestone",
      summary: `released ${tag} on ${repo}`,
      detail: clean(release.name || release.body, 700),
      evidence: `release: ${tag}`,
    };
  }

  if (event.type === "WatchEvent" && event.payload?.action === "started") {
    return {
      ...base,
      kind: "milestone",
      summary: `${repo} got a new GitHub star`,
      detail: `Someone starred ${repo}; total stars are climbing.`,
      evidence: "new star",
    };
  }

  if (event.type === "IssuesEvent" && event.payload?.action === "closed" && event.payload?.issue) {
    const issue = event.payload.issue;
    return {
      ...base,
      kind: "progress",
      summary: `closed issue in ${repo}: ${clean(issue.title, 120)}`,
      detail: clean(issue.body, 700),
      evidence: `issue #${issue.number} closed`,
    };
  }

  if (
    event.type === "PullRequestEvent" &&
    event.payload?.action === "closed" &&
    event.payload?.pull_request?.merged
  ) {
    const pr = event.payload.pull_request;
    return {
      ...base,
      kind: "progress",
      summary: `merged PR in ${repo}: ${clean(pr.title, 120)}`,
      detail: clean(pr.body, 700),
      evidence: `PR #${pr.number} merged`,
    };
  }

  if (event.type === "PushEvent" && Array.isArray(event.payload?.commits) && event.payload.commits.length) {
    const commits = event.payload.commits;
    return {
      ...base,
      kind: "progress",
      summary: `shipped ${commits.length} commit(s) to ${repo}`,
      detail: commits
        .slice(0, 3)
        .map((commit) => `- ${clean(commit.message, 160)}`)
        .join(" "),
      evidence: `branch: ${clean(event.payload.ref?.replace("refs/heads/", ""), 60) || "default"}`,
    };
  }

  return null;
}

async function main() {
  if (!TOKEN) {
    console.warn("GITHUB_TOKEN is not set; skipping GitHub events sync.");
    return;
  }
  if (!OWNER) {
    console.warn("GITHUB_EVENTS_OWNER / GITHUB_REPOSITORY_OWNER is not set; skipping GitHub events sync.");
    return;
  }

  const { ok, status, data: events } = await ghFetch(`/users/${OWNER}/events/public?per_page=100`);
  if (!ok || !Array.isArray(events)) {
    console.warn(`GitHub events API returned ${status}; skipping sync.`);
    return;
  }

  const notes = events
    .map(noteFromEvent)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))
    .slice(0, LIMIT);
  if (!notes.length) {
    console.log("No fresh GitHub events worth converting to build-in-public notes.");
    return;
  }

  const state = await readJsonFile(SYNC_STATE_FILE);
  const seenIds = new Set(Array.isArray(state.syncedEventIds) ? state.syncedEventIds : []);
  const existing = await readFile(CONTENT_FILE, "utf8").catch(() => "");
  const existingIds = new Set(
    existing
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line).id;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );

  const fresh = notes.filter((note) => !seenIds.has(note.id) && !existingIds.has(note.id));
  if (!fresh.length) {
    console.log("All GitHub event notes already synced.");
    return;
  }

  await mkdir(CONTENT_FILE.split("/").slice(0, -1).join("/"), { recursive: true });
  const lines = fresh.map((note) => `${JSON.stringify(note)}\n`).join("");
  await appendFile(CONTENT_FILE, lines);
  await mkdir(SYNC_STATE_FILE.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(
    SYNC_STATE_FILE,
    `${JSON.stringify(
      { updatedAt: new Date().toISOString(), syncedEventIds: [...seenIds, ...fresh.map((note) => note.id)].slice(-200) },
      null,
      2,
    )}\n`,
  );
  console.log(`Synced ${fresh.length} GitHub event(s) into ${CONTENT_FILE}:`);
  for (const note of fresh) {
    console.log(`  - ${note.product}: ${note.summary}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
