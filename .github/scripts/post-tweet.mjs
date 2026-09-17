import {
  chooseHybridContent,
  formatHybridContentContext,
  growthFewShotExamples,
  hybridQualityIssues,
  loadBuildInPublicNotes,
  systemPromptForLanguage,
} from "./tweet-content-pipeline.mjs";

// OpenAI-compatible LLM endpoint. Defaults to DeepSeek to keep tweet generation cheap.
const DEFAULT_LLM_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_LLM_MODEL_ID = "deepseek-v4-flash";
const PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search";
const X_OAUTH2_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_CREATE_TWEET_URL = "https://api.x.com/2/tweets";
const X_TWEETS_LOOKUP_URL = "https://api.x.com/2/tweets";
const X_RECENT_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
const X_ME_URL = "https://api.x.com/2/users/me";
const X_MEDIA_INIT_URL = "https://api.x.com/2/media/upload/initialize";
const MAX_TWEET_LENGTH = 280;

function llmChatCompletionsUrl() {
  return optionalEnv("OPENAI_API_URL", DEFAULT_LLM_CHAT_COMPLETIONS_URL);
}

function llmModelId() {
  return optionalEnv("OPENAI_MODEL_ID", DEFAULT_LLM_MODEL_ID);
}

function llmThinkingEnabled() {
  // DeepSeek V4 enables thinking by default; keep it off unless explicitly requested.
  return isTruthy(optionalEnv("OPENAI_THINKING_ENABLED", "false"));
}

async function callOpenAIChat({ messages, responseFormat, temperature, purpose = "chat" }) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = llmModelId();
  const apiUrl = llmChatCompletionsUrl();
  await evaluateOpenAIBudgetBeforeCall(purpose);

  const buildBody = (includeTemperature) => {
    const body = { model, messages };
    if (responseFormat) body.response_format = responseFormat;
    if (includeTemperature && temperature != null) {
      body.temperature = temperature;
    }
    if (/deepseek/i.test(apiUrl) || /deepseek/i.test(model)) {
      body.thinking = { type: llmThinkingEnabled() ? "enabled" : "disabled" };
    }
    return body;
  };

  const request = async (includeTemperature) => {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(includeTemperature)),
    });
    const data = await response.json().catch(() => ({}));
    await recordOpenAIUsage({
      purpose,
      model,
      status: response.status,
      ok: response.ok,
      usage: data?.usage,
    });
    return { response, data };
  };

  let { response, data } = await request(temperature != null);
  const temperatureRejected =
    !response.ok &&
    temperature != null &&
    /temperature/i.test(String(data?.error?.message || ""));

  if (temperatureRejected) {
    console.warn("LLM model rejected custom temperature; retrying with provider default.");
    ({ response, data } = await request(false));
  }

  return { response, data };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function numberEnv(name, fallback, min, max) {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function integerEnv(name, fallback, min, max) {
  return Math.trunc(numberEnv(name, fallback, min, max));
}

function listEnv(name) {
  return optionalEnv(name)
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isTruthy(value) {
  return ["1", "true", "yes", "y"].includes(String(value || "").toLowerCase());
}

function compactSecret(value) {
  return String(value || "").replace(/\s+/g, "");
}

function logSecretShape(name, rawValue, normalizedValue) {
  console.log(`${name} length: ${normalizedValue.length}`);
  console.log(`${name} contained whitespace: ${/\s/.test(rawValue)}`);
}

function maskGitHubSecret(value) {
  const normalized = compactSecret(value);
  if (normalized && process.env.GITHUB_ACTIONS) {
    console.log(`::add-mask::${normalized}`);
  }
}

async function ensureParentDirectory(filePath) {
  const directory = filePath.split("/").slice(0, -1).join("/");
  if (!directory) return;

  if (typeof Bun !== "undefined") {
    const process = Bun.spawn(["mkdir", "-p", directory]);
    const exitCode = await process.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to create directory: ${directory}`);
    }
    return;
  }

  const { mkdirSync } = await import("node:fs");
  mkdirSync(directory, { recursive: true });
}

async function writeTextFile(filePath, content) {
  await ensureParentDirectory(filePath);
  if (typeof Bun !== "undefined") {
    await Bun.write(filePath, content);
    return;
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(filePath, content);
}

async function persistXRefreshToken(refreshToken) {
  const normalized = compactSecret(refreshToken);
  const outputFile = optionalEnv("X_REFRESH_TOKEN_OUT_FILE");
  if (!normalized || !outputFile) return;

  maskGitHubSecret(normalized);
  await ensureParentDirectory(outputFile);
  await Bun.write(outputFile, `${normalized}\n`);
  console.log(`Persisted X OAuth2 refresh token to ${outputFile}.`);
}

async function deleteFileIfExists(filePath) {
  if (!filePath) return;
  const file = Bun.file(filePath);
  if (!(await file.exists())) return;

  const process = Bun.spawn(["rm", "-f", filePath]);
  await process.exited;
}

async function appendGitHubOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;

  const { appendFileSync } = await import("node:fs");
  appendFileSync(outputFile, `${name}=${value}\n`);
}

async function markRuntimeCachePurge(reason) {
  await appendGitHubOutput("purge_runtime_cache", "true");
  console.warn(`Marked Actions runtime cache for purge: ${reason}`);
}

async function discardCachedXRefreshToken(reason = "cached refresh token rejected by X") {
  const outputFile = optionalEnv("X_REFRESH_TOKEN_OUT_FILE");
  await deleteFileIfExists(outputFile);
  await deleteFileIfExists(
    optionalEnv("X_ACCESS_TOKEN_CACHE_FILE", ".github/runtime/x-access-token.json"),
  );

  const markerFile = ".github/runtime/x-refresh-token.invalid.json";
  await ensureParentDirectory(markerFile);
  await Bun.write(
    markerFile,
    `${JSON.stringify({ invalidatedAt: new Date().toISOString(), reason }, null, 2)}\n`,
  );
  await markRuntimeCachePurge(reason);
  console.warn("Discarded cached X OAuth2 refresh token because X rejected it.");
}

async function readTextFileIfExists(filePath) {
  if (!filePath) return "";
  if (typeof Bun === "undefined") {
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf8");
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) return "";
  return await file.text();
}

async function readJsonFileIfExists(filePath, fallback) {
  try {
    const content = await readTextFileIfExists(filePath);
    if (!content.trim()) return fallback;
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

const TITLE_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "are",
  "was",
  "will",
  "has",
  "have",
  "into",
  "about",
  "after",
  "before",
  "your",
  "their",
  "its",
  "how",
  "why",
  "what",
  "when",
  "who",
]);

async function readNewsPickerState() {
  const stateFile = optionalEnv("RSS_STATE_FILE");
  if (!stateFile) {
    return { recentStoryLinks: [], lastSelected: null };
  }

  const state = await readJsonFileIfExists(stateFile, {});
  const recentStoryLinks = Array.isArray(state.recentStoryLinks)
    ? state.recentStoryLinks.map((link) => String(link || "").trim()).filter(Boolean)
    : [];
  return {
    recentStoryLinks,
    lastSelected: state.lastSelected || null,
  };
}

async function persistNewsPickerState(selectedItem) {
  const stateFile = optionalEnv("RSS_STATE_FILE");
  if (!stateFile || !selectedItem?.link) return;

  const previous = await readNewsPickerState();
  const maxRecent = integerEnv("NEWS_RECENT_STORY_MAX", 20, 5, 100);
  const recentStoryLinks = [
    selectedItem.link,
    ...previous.recentStoryLinks.filter((link) => link !== selectedItem.link),
  ].slice(0, maxRecent);

  await ensureParentDirectory(stateFile);
  await Bun.write(
    stateFile,
    `${JSON.stringify(
      {
        recentStoryLinks,
        lastSelected: {
          title: selectedItem.title,
          link: selectedItem.link,
          source: selectedItem.source,
          published: selectedItem.published,
          hotScore: selectedItem.hotScore,
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function readLastTweetLanguage() {
  const stateFile = optionalEnv(
    "TWEET_LANGUAGE_STATE_FILE",
    ".github/runtime/tweet-language-state.json",
  );
  const state = await readJsonFileIfExists(stateFile, {});
  const code = String(state.lastLanguage || "").toLowerCase();
  if (code === "zh" || code === "en") return code;
  return null;
}

async function persistTweetLanguage(languageCode) {
  const stateFile = optionalEnv(
    "TWEET_LANGUAGE_STATE_FILE",
    ".github/runtime/tweet-language-state.json",
  );
  if (!stateFile || !languageCode) return;

  await ensureParentDirectory(stateFile);
  await Bun.write(
    stateFile,
    `${JSON.stringify(
      {
        lastLanguage: languageCode,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function isChineseText(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || ""));
}

function normalizeLanguageCode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value.startsWith("en")) return "en";
  if (value.startsWith("zh")) return "zh";
  return value === "en" || value === "zh" ? value : "";
}

const DEFAULT_TWEET_STYLE_ZH =
  "技术爆款风。首句必须是打破常识的暴论或高能数据。输出极具信息差的底层干货，营造“不收藏就亏”的压迫感。极度自信，拒绝中庸废话。限120字。";

const DEFAULT_TWEET_STYLE_EN =
  "Viral builder tone. Contrarian hook first. Expose an engineering secret or brutally honest tradeoff. Dense, aggressive, bookmark-worthy. No fluff. Max 220 chars. Drop the mic.";

function languageProfile(code) {
  const unifiedStyle = optionalEnv("TWEET_STYLE_PROMPT");

  if (code === "en") {
    return {
      code: "en",
      label: "English",
      style: optionalEnv("TWEET_STYLE_PROMPT_EN", unifiedStyle || DEFAULT_TWEET_STYLE_EN),
    };
  }

  return {
    code: "zh",
    label: "Simplified Chinese (zh-CN)",
    style: optionalEnv("TWEET_STYLE_PROMPT_ZH", unifiedStyle || DEFAULT_TWEET_STYLE_ZH),
  };
}

const CONTENT_FORMATS = [
  {
    id: "not_x_but_y",
    label: "Not X But Y",
    instruction:
      "Reframe the story as 'not X, but Y': reject the obvious feature-level reading and name the workflow/business shift underneath.",
  },
  {
    id: "second_order",
    label: "Second Order",
    instruction:
      "Lead with the second-order effect most people are missing, especially what changes for developers, teams, pricing, distribution, or user behavior.",
  },
  {
    id: "prediction",
    label: "Near-term Prediction",
    instruction:
      "Make one concrete near-term prediction tied to the story. Include who wins, who loses, or what workflow becomes default without forcing a formulaic 6-12 month frame.",
  },
  {
    id: "operator_pain",
    label: "Operator Pain",
    instruction:
      "Translate the story into an operator/developer pain point: what gets easier, what gets more annoying, and who now has a new job to do.",
  },
  {
    id: "contrarian_cost",
    label: "Contrarian Cost",
    instruction:
      "Open with the hidden cost or tradeoff, not the benefit. The take should be debatable but defensible.",
  },
  {
    id: "sharp_question",
    label: "Sharp Question",
    instruction:
      "End with one precise question that a knowledgeable reader can answer, without generic 'what do you think' engagement bait.",
  },
  {
    id: "playbook",
    label: "Playbook",
    instruction:
      "Turn the story into a practical playbook: what builders/operators should do next, what to stop doing, or which default to change.",
  },
  {
    id: "decision_rule",
    label: "Decision Rule",
    instruction:
      "Give a simple decision rule readers can reuse: if X is true, do Y; otherwise wait, ignore, or budget differently.",
  },
  {
    id: "brutal_truth",
    label: "Brutal Truth",
    instruction:
      "Open with a blunt truth-bomb most people avoid saying. State it as fact, back it with the source's concrete detail, and let the tension pull replies.",
  },
  {
    id: "massive_value_drop",
    label: "Massive Value Drop",
    instruction:
      "Give away a dense, bookmark-worthy playbook or config: exact steps, numbers, or an obscure setting others miss. So useful the reader must save it.",
  },
  {
    id: "myth_busting",
    label: "Myth Busting",
    instruction:
      "Name the belief 90% of people get wrong about this, then deliver the 10% truth with the evidence from the source. Dunk on the myth, not a person.",
  },
  {
    id: "the_hard_way",
    label: "The Hard Way",
    instruction:
      "Frame it as a costly lesson learned the hard way: what broke, what it cost (time/money/latency), and the cheat code you'd use next time.",
  },
];

function configuredContentFormats() {
  const configured = listEnv("TWEET_CONTENT_FORMAT_IDS");
  if (!configured.length) return CONTENT_FORMATS;
  const allowed = new Set(configured);
  const formats = CONTENT_FORMATS.filter((format) => allowed.has(format.id));
  return formats.length ? formats : CONTENT_FORMATS;
}

function angleLoadRouterFormatIds(angleLoadRouter = null, formats = configuredContentFormats()) {
  if (!angleLoadRouter) return [];
  const allowed = new Set(formats.map((format) => format.id));
  const ids = [];
  const push = (id, status = "") => {
    if (!id || !allowed.has(id) || status === "hold" || ids.includes(id)) return;
    ids.push(id);
  };

  push(angleLoadRouter.activeSlot?.formatId, angleLoadRouter.activeSlot?.status);
  for (const lane of angleLoadRouter.lanes || []) {
    push(lane.formatId || lane.id, lane.status);
  }
  return ids;
}

function parseFormatBaseAllocation(formats) {
  const configured = optionalEnv("TWEET_FORMAT_BASE_ALLOCATION");
  const byId = new Map(formats.map((format) => [format.id, 0]));
  if (!configured) {
    // Data-backed default mix when callers leave allocation unset.
    const defaults = {
      prediction: 0.65,
      decision_rule: 0.2,
      brutal_truth: 0.12,
      sharp_question: 0.03,
    };
    for (const format of formats) {
      byId.set(format.id, defaults[format.id] ?? (1 / Math.max(1, formats.length)));
    }
  } else {
    for (const part of configured.split(/[,;]+/)) {
      const [rawId, rawWeight] = part.split("=").map((value) => value.trim());
      if (!rawId || !byId.has(rawId)) continue;
      const weight = Number(rawWeight);
      if (Number.isFinite(weight) && weight > 0) byId.set(rawId, weight);
    }
  }
  const total = [...byId.values()].reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries([...byId.entries()].map(([id, weight]) => [id, weight / total]));
}

function hashStringToUnit(value) {
  let hash = 2166136261;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function pickFormatByAllocation(formats, allocation, seed) {
  const ranked = formats
    .map((format) => ({ format, weight: allocation[format.id] || 0 }))
    .filter((item) => item.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.format.id.localeCompare(right.format.id));
  if (!ranked.length) return formats[0];
  let cursor = hashStringToUnit(seed);
  for (const item of ranked) {
    cursor -= item.weight;
    if (cursor <= 0) return item.format;
  }
  return ranked[0].format;
}

function selectContentFormats({
  performanceInsights,
  count = 1,
  contentBanditAllocator = null,
  angleLoadRouter = null,
  growthOpportunityScorer = null,
  growthStrategy = null,
} = {}) {
  const formats = configuredContentFormats();
  const fixed = optionalEnv("TWEET_CONTENT_FORMAT_ID");
  if (fixed) {
    const format = formats.find((item) => item.id === fixed) || formats[0];
    return Array.from({ length: count }, () => format);
  }

  const allocation = parseFormatBaseAllocation(formats);
  const rotationOffset = Math.trunc(Date.now() / (60 * 60 * 1000));
  const allocationSeed = `${new Date().toISOString().slice(0, 13)}:${Object.keys(allocation).join(",")}`;
  const allocationPick = pickFormatByAllocation(formats, allocation, allocationSeed);
  const routerIds = angleLoadRouterFormatIds(angleLoadRouter, formats);
  const opportunityIds = [
    growthOpportunityScorer?.activeOpportunity?.formatId,
    ...(growthOpportunityScorer?.lanes || []).map((lane) => lane.formatId),
  ].filter(Boolean);
  const strategyIds = rankFormatIdsByGrowthStrategy(growthStrategy, formats);
  const holdIds = new Set((growthStrategy?.holdFormats || []).map((row) => row.id).filter(Boolean));
  const bandit = contentBanditAllocator ||
    (performanceInsights?.records?.length ? buildContentBanditAllocator({ insights: performanceInsights }) : null);
  if (bandit?.rankedFormatIds?.length || routerIds.length || opportunityIds.length || strategyIds.length) {
    const byId = new Map(formats.map((format) => [format.id, format]));
    const selected = [];
    // Self-evolving strategy ranks first so daily winners beat the static base mix.
    const rankedIds = [
      ...strategyIds,
      allocationPick?.id,
      growthStrategy?.exploreFormatId || optionalEnv("TWEET_GROWTH_EXPLORE_FORMAT_ID", "brutal_truth"),
      ...opportunityIds,
      ...routerIds,
      ...(bandit?.rankedFormatIds || []),
    ];
    for (const id of rankedIds) {
      const format = byId.get(id);
      if (!format || selected.some((item) => item.id === format.id)) continue;
      if (holdIds.has(format.id)) continue;
      selected.push(format);
      if (selected.length >= count) break;
    }
    while (selected.length < count) {
      const fill = formats[(rotationOffset + selected.length) % formats.length];
      if (!selected.some((item) => item.id === fill.id)) {
        selected.push(fill);
        continue;
      }
      const next = formats.find((format) => !selected.some((item) => item.id === format.id));
      if (!next) break;
      selected.push(next);
    }
    return selected;
  }

  const experimentRows = performanceInsights?.records?.length
    ? experimentFormatRows(performanceInsights)
    : [];
  const experimentRank = new Map(
    experimentRows.map((row, index) => {
      const actionWeight = { exploit: 30, test: 20, explore: 12, hold: -20 }[row.action] ?? 0;
      return [row.id, actionWeight + Math.max(0, 10 - index)];
    }),
  );
  const routerRank = new Map(routerIds.map((id, index) => [id, 32 - index * 5]));
  const ranked = formats
    .map((format, index) => {
      const bucket = performanceInsights?.templates?.[format.id];
      const lift = performanceLift(bucket, performanceInsights || { minSamples: 999, baselineScore: 0 }, 0.5);
      const exploration = ((rotationOffset + index) % formats.length) / formats.length;
      return {
        format,
        rankScore:
          (allocation[format.id] || 0) * 40 +
          (routerRank.get(format.id) || 0) +
          (experimentRank.get(format.id) || 0) +
          lift * 10 +
          exploration,
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore);

  const selected = [];
  for (const item of ranked) {
    selected.push(item.format);
    if (selected.length >= count) break;
  }
  while (selected.length < count) {
    selected.push(formats[(rotationOffset + selected.length) % formats.length]);
  }
  return selected;
}

function growthPromptRules(language, contentFormat) {
  const format = contentFormat || selectContentFormats({ count: 1 })[0];
  const isZh = String(language || "").toLowerCase().includes("chinese");
  return [
    "- Optimize for reposts and replies, not for sounding comprehensive.",
    `- Content format (${format.id}): ${format.instruction}`,
    "- First line must work as a standalone hook; do not open with \"I think\" or a news recap.",
    isZh
      ? "- Chinese first line is a 暴论, belief-kill, or shocking real number; about 18-72 characters; do not paste or lightly rewrite the RSS title."
      : "- English first line is a scroll-stopper (FOMO, belief-kill, or shocking result); 38-118 characters; do not paste or lightly rewrite the RSS title.",
    "- Name a concrete company, product, or model when possible (OpenAI, Meta, Llama, Anthropic, Hugging Face, Nvidia, etc.). Explainers still need a named player.",
    isZh
      ? "- Convert the primary input into bookmark bait: a pitfall, obscure config, or constraint others miss; dunk on a bloated old approach, not a person."
      : "- Convert the primary input into a bookmarkable playbook: a named villain, exact number/tool/constraint, and one polarizing-but-evidenced take.",
    "- Make the reader feel following this account saves time or gives better operating judgment.",
    "- Prefer useful frameworks, operating rules, checklists, or concrete implications over clever wording.",
    "- Avoid repeating the same 6-12 month framing unless timing is the actual core insight.",
    "- Avoid pure summaries, launch announcements, corporate phrasing, generic AI hype, and 'what do you think' bait.",
    "- Forbidden hype words/phrases: 重磅, 颠覆, 引爆, 全新变革, 主宰市场, 超高效率, 不可忽视, game changer, revolutionary.",
    isZh
      ? "- Keep the main body under 120 Chinese characters before hashtags."
      : "- Keep the main body under 220 characters before hashtags.",
    isZh
      ? "- Write as Linus Shyu: 流量黑客与技术布道者. Absolute confidence, implicit CTA, no 可能/或许/你怎么看."
      : "- Write as Linus Shyu on Tech Twitter: arrogant-but-helpful builder. Optimize for bookmarks and quote tweets, not completeness.",
    "- One opinion only. No hedging, no \"on the one hand\".",
  ];
}

function parseUtcHourList(envName, defaultValue) {
  const raw = optionalEnv(envName, defaultValue);
  return [
    ...new Set(
      String(raw || "")
        .split(/[,;\s]+/)
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23),
    ),
  ].sort((left, right) => left - right);
}

function tweetLanguageMode() {
  const configured = optionalEnv("TWEET_LANGUAGE_MODE", "timezone");
  if (configured) return configured.trim().toLowerCase();
  if (isTruthy(optionalEnv("TWEET_ALTERNATE_LANGUAGES", "false"))) return "alternate";
  return "fixed";
}

function peakZhUtcHours() {
  // China evening prime only: Beijing 20:00 (UTC+8). Keep ZH off EN windows.
  return parseUtcHourList("TWEET_PEAK_ZH_UTC_HOURS", "12");
}

function peakEnUtcHours() {
  // US English traffic stack (EDT ≈ UTC-4):
  // 13 = 09:00 ET morning, 16 = 12:00 ET lunch, 21 = 17:00 ET / 14:00 PT.
  return parseUtcHourList("TWEET_PEAK_EN_UTC_HOURS", "13,16,21");
}

function peakRegionLabel(hour) {
  const normalized = Number(hour);
  if (!Number.isInteger(normalized)) return null;
  if (peakZhUtcHours().includes(normalized)) return "China evening";
  if (normalized === 13) return "US East morning";
  if (normalized === 16) return "US East lunch";
  if (normalized === 21) return "US East evening commute / West afternoon";
  if (normalized === 0 || normalized === 1) return "US East evening";
  if (peakEnUtcHours().includes(normalized)) return "US English peak";
  return null;
}

function peakPostingUtcHours() {
  const configured = optionalEnv("TWEET_PEAK_UTC_HOURS");
  if (configured) return parseUtcHourList("TWEET_PEAK_UTC_HOURS", configured);
  return [...new Set([...peakZhUtcHours(), ...peakEnUtcHours()])].sort(
    (left, right) => left - right,
  );
}

function formatUtcHourList(hours) {
  return hours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ");
}

function resolveTimezoneLanguage(hour = new Date().getUTCHours()) {
  const zhHours = peakZhUtcHours();
  const enHours = peakEnUtcHours();
  const inZh = zhHours.includes(hour);
  const inEn = enHours.includes(hour);
  const region = peakRegionLabel(hour);

  if (inZh && !inEn) {
    return {
      code: "zh",
      region,
      reason: `UTC ${String(hour).padStart(2, "0")}:00 matches ${region || "China"} peak (${formatUtcHourList(zhHours)} UTC → zh).`,
    };
  }
  if (inEn && !inZh) {
    return {
      code: "en",
      region,
      reason: `UTC ${String(hour).padStart(2, "0")}:00 matches ${region || "US"} peak (${formatUtcHourList(enHours)} UTC → en).`,
    };
  }
  if (inZh && inEn) {
    return {
      code: "zh",
      region: region || "China",
      reason: `UTC ${String(hour).padStart(2, "0")}:00 is in both zh/en windows; preferring zh for China.`,
    };
  }
  return null;
}

function parseCronUtcHour(cronExpression) {
  const parts = String(cronExpression || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  const hour = Number.parseInt(parts[1], 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function scheduledUtcHour() {
  return parseCronUtcHour(optionalEnv("GITHUB_EVENT_SCHEDULE"));
}

function evaluatePeakPostingWindow() {
  const eventName = optionalEnv("GITHUB_EVENT_NAME");

  // Cron already defines posting slots. GitHub schedule runs can start late and
  // cross an hour boundary, so never reject a scheduled run based on wall clock.
  if (eventName === "schedule") {
    const scheduledHour = scheduledUtcHour();
    const cron = optionalEnv("GITHUB_EVENT_SCHEDULE") || "unknown";
    const timezoneLanguage =
      scheduledHour != null
        ? resolveTimezoneLanguage(scheduledHour)
        : resolveTimezoneLanguage();
    return {
      allowed: true,
      scheduledHour: scheduledHour ?? new Date().getUTCHours(),
      reason:
        scheduledHour != null
          ? `Scheduled cron ${cron} (UTC ${String(scheduledHour).padStart(2, "0")}:00 slot).`
          : `Scheduled cron run (${cron}).`,
      languageCode: timezoneLanguage?.code || null,
    };
  }

  if (eventName === "workflow_dispatch") {
    const hour = new Date().getUTCHours();
    const timezoneLanguage = resolveTimezoneLanguage(hour);
    return {
      allowed: true,
      scheduledHour: hour,
      reason: "Manual workflow run.",
      languageCode: timezoneLanguage?.code || null,
    };
  }

  if (!isTruthy(optionalEnv("TWEET_PEAK_POSTING_ENABLED", "false"))) {
    return { allowed: true, reason: "Peak posting filter disabled." };
  }

  const hour = new Date().getUTCHours();
  const allowedHours = peakPostingUtcHours();
  if (!allowedHours.includes(hour)) {
    return {
      allowed: false,
      scheduledHour: hour,
      reason: `Outside peak posting windows (${formatUtcHourList(allowedHours)} UTC; current ${String(hour).padStart(2, "0")}:00 UTC).`,
    };
  }

  const timezoneLanguage = resolveTimezoneLanguage(hour);
  return {
    allowed: true,
    scheduledHour: hour,
    reason: timezoneLanguage?.reason || `UTC ${String(hour).padStart(2, "0")}:00 is in peak window.`,
    languageCode: timezoneLanguage?.code || null,
  };
}

async function resolveAlternateTweetLanguage(history) {
  const lastLanguage = await readLastTweetLanguage();
  if (lastLanguage) {
    const nextCode = lastLanguage === "zh" ? "en" : "zh";
    console.log(
      `Alternating language: last=${lastLanguage}, this run=${nextCode}.`,
    );
    return languageProfile(nextCode);
  }

  if (history?.length) {
    const inferred = isChineseText(history[0]) ? "zh" : "en";
    const nextCode = inferred === "zh" ? "en" : "zh";
    console.log(
      `Bootstrapping language alternation from history: inferred last=${inferred}, this run=${nextCode}.`,
    );
    return languageProfile(nextCode);
  }

  const first = normalizeLanguageCode(optionalEnv("TWEET_FIRST_LANGUAGE", "en")) || "en";
  console.log(`First language for alternation: ${first}.`);
  return languageProfile(first);
}

async function resolveNextTweetLanguage(history, utcHour = new Date().getUTCHours(), forcedCode = null) {
  const forced = normalizeLanguageCode(forcedCode);
  if (forced) {
    const region = peakRegionLabel(utcHour);
    console.log(
      `Forced timezone language: ${forced}${region ? ` (${region})` : ""} at UTC ${String(utcHour).padStart(2, "0")}:00.`,
    );
    return languageProfile(forced);
  }

  const mode = tweetLanguageMode();

  if (mode === "fixed") {
    const fixed = normalizeLanguageCode(optionalEnv("TWEET_LANGUAGE", "en")) || "en";
    return languageProfile(fixed);
  }

  if (mode === "timezone") {
    const timezoneLanguage = resolveTimezoneLanguage(utcHour);
    if (timezoneLanguage) {
      console.log(`Timezone language: ${timezoneLanguage.code} (${timezoneLanguage.reason})`);
      return languageProfile(timezoneLanguage.code);
    }
    console.log("Outside zh/en peak windows; falling back to alternation.");
    return resolveAlternateTweetLanguage(history);
  }

  return resolveAlternateTweetLanguage(history);
}

async function readTweetHistory() {
  const historyFile = optionalEnv("TWEET_HISTORY_FILE");
  const maxHistory = integerEnv("TWEET_HISTORY_MAX", 12, 0, 100);
  if (!historyFile || maxHistory === 0) return [];

  const parsed = await readJsonFileIfExists(historyFile, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => String(item?.text || item || "").trim())
    .filter(Boolean)
    .slice(0, maxHistory);
}

async function persistTweetHistory(tweet) {
  const historyFile = optionalEnv("TWEET_HISTORY_FILE");
  const maxHistory = integerEnv("TWEET_HISTORY_MAX", 12, 1, 100);
  if (!historyFile) return;

  const previous = await readTweetHistory();
  const next = [tweet, ...previous.filter((item) => item !== tweet)].slice(0, maxHistory);
  await ensureParentDirectory(historyFile);
  await Bun.write(historyFile, `${JSON.stringify(next, null, 2)}\n`);
}

function tweetAnalyticsEnabled() {
  return isTruthy(optionalEnv("TWEET_ANALYTICS_ENABLED", "true"));
}

function tweetAnalyticsFile() {
  return optionalEnv("TWEET_ANALYTICS_FILE", ".github/runtime/tweet-analytics.json");
}

function tweetAnalyticsPublicFile() {
  if (optionalEnv("TWEET_SELF_TEST")) return "";
  return optionalEnv("TWEET_ANALYTICS_PUBLIC_FILE", "reports/tweet-analytics.json");
}

function measuredAnalyticsSnapshotCount(record) {
  const snapshots = Array.isArray(record?.metricsSnapshots) ? record.metricsSnapshots.length : 0;
  return snapshots + (record?.latestMetrics ? 1 : 0);
}

function mergeTweetAnalyticsStates(runtime, published) {
  if (!runtime || typeof runtime !== "object") return published && typeof published === "object" ? published : null;
  if (!published || typeof published !== "object") return runtime;
  const byId = new Map();
  for (const record of [...(published.tweets || []), ...(runtime.tweets || [])]) {
    if (!record?.id) continue;
    const id = String(record.id);
    const existing = byId.get(id);
    if (!existing || measuredAnalyticsSnapshotCount(record) >= measuredAnalyticsSnapshotCount(existing)) {
      byId.set(id, record);
    }
  }
  const snapshotKey = (item) => String(item?.checkedAt || item?.capturedAt || "");
  const snapshots = [];
  const seenSnapshots = new Set();
  for (const item of [...(published.accountSnapshots || []), ...(runtime.accountSnapshots || [])]) {
    const key = snapshotKey(item);
    if (!key || seenSnapshots.has(key)) continue;
    seenSnapshots.add(key);
    snapshots.push(item);
  }
  const runtimeMs = Date.parse(runtime.updatedAt || "") || 0;
  const publishedMs = Date.parse(published.updatedAt || "") || 0;
  return {
    ...published,
    ...runtime,
    updatedAt: runtimeMs >= publishedMs ? runtime.updatedAt : published.updatedAt,
    tweets: [...byId.values()],
    accountSnapshots: snapshots.slice(-100),
  };
}

function xApiUsageFile() {
  return optionalEnv("X_API_USAGE_FILE", ".github/runtime/x-api-usage.json");
}

function xApiUsageTrackingEnabled() {
  return isTruthy(optionalEnv("X_API_USAGE_TRACKING_ENABLED", "true"));
}

function openAIUsageFile() {
  return optionalEnv("OPENAI_USAGE_FILE", ".github/runtime/openai-usage.json");
}

function openAIUsageTrackingEnabled() {
  return isTruthy(optionalEnv("OPENAI_USAGE_TRACKING_ENABLED", "true"));
}

function emptyTweetAnalyticsState() {
  return {
    version: 1,
    updatedAt: null,
    accountSnapshots: [],
    tweets: [],
    rssHealth: { updatedAt: null, feeds: {} },
    runEvents: [],
    hotspotRadar: { updatedAt: null, items: [] },
    trendVelocityRadar: { updatedAt: null, items: [], summary: null },
    followUpDrafts: [],
    manualReplyDrafts: [],
    autoReplies: { updatedAt: null, records: [] },
  };
}

function normalizeMetricObject(value) {
  if (!value || typeof value !== "object") return {};
  const normalized = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = Number(raw);
    if (Number.isFinite(number)) normalized[key] = number;
  }
  return normalized;
}

function normalizeAnalyticsState(parsed) {
  const state = emptyTweetAnalyticsState();
  if (!parsed || typeof parsed !== "object") return state;

  state.updatedAt = parsed.updatedAt || null;
  state.accountSnapshots = Array.isArray(parsed.accountSnapshots)
    ? parsed.accountSnapshots.filter((item) => item && typeof item === "object").slice(-100)
    : [];
  state.rssHealth =
    parsed.rssHealth && typeof parsed.rssHealth === "object"
      ? {
          updatedAt: parsed.rssHealth.updatedAt || null,
          feeds:
            parsed.rssHealth.feeds && typeof parsed.rssHealth.feeds === "object"
              ? parsed.rssHealth.feeds
              : {},
        }
      : { updatedAt: null, feeds: {} };
  state.runEvents = Array.isArray(parsed.runEvents)
    ? parsed.runEvents
        .filter((item) => item && typeof item === "object")
        .slice(-integerEnv("TWEET_RUN_EVENTS_MAX", 200, 20, 1000))
    : [];
  state.hotspotRadar =
    parsed.hotspotRadar && typeof parsed.hotspotRadar === "object"
      ? {
          updatedAt: parsed.hotspotRadar.updatedAt || null,
          items: Array.isArray(parsed.hotspotRadar.items)
            ? parsed.hotspotRadar.items.filter((item) => item && typeof item === "object").slice(0, 100)
            : [],
        }
      : { updatedAt: null, items: [] };
  state.trendVelocityRadar =
    parsed.trendVelocityRadar && typeof parsed.trendVelocityRadar === "object"
      ? {
          updatedAt: parsed.trendVelocityRadar.updatedAt || null,
          summary:
            parsed.trendVelocityRadar.summary && typeof parsed.trendVelocityRadar.summary === "object"
              ? parsed.trendVelocityRadar.summary
              : null,
          items: Array.isArray(parsed.trendVelocityRadar.items)
            ? parsed.trendVelocityRadar.items.filter((item) => item && typeof item === "object").slice(0, 50)
            : [],
        }
      : { updatedAt: null, items: [], summary: null };
  state.followUpDrafts = Array.isArray(parsed.followUpDrafts)
    ? parsed.followUpDrafts.filter((item) => item && typeof item === "object").slice(0, 30)
    : [];
  state.manualReplyDrafts = Array.isArray(parsed.manualReplyDrafts)
    ? parsed.manualReplyDrafts.filter((item) => item && typeof item === "object").slice(0, 30)
    : [];
  state.autoReplies =
    parsed.autoReplies && typeof parsed.autoReplies === "object"
      ? {
          updatedAt: parsed.autoReplies.updatedAt || null,
          records: Array.isArray(parsed.autoReplies.records)
            ? parsed.autoReplies.records.filter((item) => item && typeof item === "object").slice(-200)
            : [],
        }
      : { updatedAt: null, records: [] };
  state.tweets = Array.isArray(parsed.tweets)
    ? parsed.tweets
        .filter((item) => item?.id)
        .map((item) => ({
          ...item,
          id: String(item.id),
          metricsSnapshots: Array.isArray(item.metricsSnapshots)
            ? item.metricsSnapshots.filter((snapshot) => snapshot && typeof snapshot === "object").slice(-24)
            : [],
          latestMetrics:
            item.latestMetrics && typeof item.latestMetrics === "object"
              ? item.latestMetrics
              : null,
        }))
        .slice(0, integerEnv("TWEET_ANALYTICS_MAX_RECORDS", 250, 20, 2000))
    : [];

  return state;
}

async function readTweetAnalytics() {
  if (!tweetAnalyticsEnabled()) return emptyTweetAnalyticsState();
  const runtime = await readJsonFileIfExists(tweetAnalyticsFile(), null);
  const published = tweetAnalyticsPublicFile()
    ? await readJsonFileIfExists(tweetAnalyticsPublicFile(), null)
    : null;
  const merged = mergeTweetAnalyticsStates(runtime, published) || emptyTweetAnalyticsState();
  return seedTweetAnalyticsFromArchive(normalizeAnalyticsState(merged));
}

async function persistTweetAnalytics(state) {
  if (!tweetAnalyticsEnabled()) return;
  // Runtime only. Public reports/tweet-analytics.json is copied by the
  // maintenance workflow after rebase so tracked files stay clean mid-run.
  const file = tweetAnalyticsFile();
  const normalized = normalizeAnalyticsState({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  await ensureParentDirectory(file);
  await Bun.write(file, `${JSON.stringify(normalized, null, 2)}\n`);
}

function classifyRunEvent(message, type = "info") {
  const text = `${type} ${message || ""}`.toLowerCase();
  if (/oauth|refresh token|access token|unauthorized|client secret/.test(text)) return "x_auth";
  if (/openai|quota|model|empty tweet/.test(text)) return "openai";
  if (/rss|feed|story|no post-worthy|weak story/.test(text)) return "content";
  if (/budget|spend|cost/.test(text)) return "budget";
  if (/quality|rejected|gate/.test(text)) return "quality";
  if (/x create|tweet post|media|upload|api/.test(text)) return "x_api";
  if (/peak|window|schedule/.test(text)) return "schedule";
  return "other";
}

async function recordRunEvent(type, message, details = {}) {
  if (!tweetAnalyticsEnabled() || dryRunEnabled()) return;
  try {
    const state = await readTweetAnalytics();
    const event = {
      type,
      category: details.category || classifyRunEvent(message, type),
      message: String(message || "").slice(0, 500),
      details,
      createdAt: new Date().toISOString(),
      workflowRunUrl: workflowRunUrl(),
    };
    const maxEvents = integerEnv("TWEET_RUN_EVENTS_MAX", 200, 20, 1000);
    state.runEvents = [...(state.runEvents || []), event].slice(-maxEvents);
    await persistTweetAnalytics(state);
  } catch (error) {
    console.warn(`Run event tracking skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeRssHealthEntry(entry = {}) {
  return {
    url: entry.url || null,
    source: entry.source || null,
    consecutiveFailures: Number(entry.consecutiveFailures) || 0,
    totalFailures: Number(entry.totalFailures) || 0,
    totalSuccesses: Number(entry.totalSuccesses) || 0,
    lastItemCount: Number(entry.lastItemCount) || 0,
    lastStatus: entry.lastStatus || null,
    lastError: entry.lastError || null,
    lastSuccessAt: entry.lastSuccessAt || null,
    lastFailureAt: entry.lastFailureAt || null,
    updatedAt: entry.updatedAt || null,
  };
}

async function recordRssHealth(updates) {
  if (!tweetAnalyticsEnabled() || dryRunEnabled() || !updates?.length) return;
  if (!isTruthy(optionalEnv("NEWS_RSS_HEALTH_ENABLED", "true"))) return;

  try {
    const state = await readTweetAnalytics();
    const feeds = { ...(state.rssHealth?.feeds || {}) };
    const now = new Date().toISOString();
    for (const update of updates) {
      if (!update?.url) continue;
      const previous = normalizeRssHealthEntry(feeds[update.url]);
      const next = {
        ...previous,
        url: update.url,
        source: update.source || previous.source || null,
        updatedAt: now,
      };

      if (update.ok) {
        next.consecutiveFailures = 0;
        next.totalSuccesses += 1;
        next.lastItemCount = Number(update.itemCount) || 0;
        next.lastStatus = update.status || "ok";
        next.lastError = null;
        next.lastSuccessAt = now;
      } else {
        next.consecutiveFailures += 1;
        next.totalFailures += 1;
        next.lastStatus = update.status || "error";
        next.lastError = String(update.error || "unknown error").slice(0, 240);
        next.lastFailureAt = now;
      }

      feeds[update.url] = next;
    }

    state.rssHealth = { updatedAt: now, feeds };
    await persistTweetAnalytics(state);
  } catch (error) {
    console.warn(`RSS health tracking skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function currentUsageDay() {
  return new Date().toISOString().slice(0, 10);
}

function estimatedEndpointCost(endpoint) {
  const normalized = String(endpoint || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const specific = optionalEnv(`X_API_COST_${normalized}`);
  if (specific) return Number(specific) || 0;
  if (/MEDIA_INITIALIZE/i.test(endpoint)) return numberEnv("X_API_COST_MEDIA_UPLOAD", 0.015, 0, 10);
  if (/CREATE_(TWEET|REPLY|QUOTE)/i.test(endpoint)) return numberEnv("X_API_COST_TWEET_CREATE", 0.015, 0, 10);
  return numberEnv("X_API_COST_READ", 0.05, 0, 10);
}

async function readXApiUsageState() {
  const state = await readJsonFileIfExists(xApiUsageFile(), {});
  if (state.month !== currentBudgetMonth()) {
    return { month: currentBudgetMonth(), days: {}, endpoints: {}, totalEstimatedUsd: 0 };
  }
  return {
    month: state.month,
    days: state.days && typeof state.days === "object" ? state.days : {},
    endpoints: state.endpoints && typeof state.endpoints === "object" ? state.endpoints : {},
    totalEstimatedUsd: Number(state.totalEstimatedUsd) || 0,
    updatedAt: state.updatedAt || null,
  };
}

function parseTimestampMs(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function classifyXApiCooldownStatus(status) {
  const code = normalizedStatusCode(status);
  if (code === 429) return "rate_limit";
  if (code === 402) return "credits_depleted";
  if (code >= 500) return "backend_fault";
  return null;
}

function xApiCreditsCircuitBreakerEnabled() {
  return isTruthy(optionalEnv("X_API_CREDITS_CIRCUIT_BREAKER_ENABLED", "true"));
}

function isXCreditsDepletedPayload(status, data = {}) {
  const code = normalizedStatusCode(status);
  if (code === 402) return true;
  const blob = JSON.stringify(data || {}).toLowerCase();
  return blob.includes("credits depleted") || blob.includes("credits-depleted");
}

class XCreditsDepletedError extends Error {
  constructor(message, { endpoint = null, status = 402, data = null } = {}) {
    super(message);
    this.name = "XCreditsDepletedError";
    this.endpoint = endpoint;
    this.status = status;
    this.data = data;
  }
}

function xApiCreditsCircuitTtlHours() {
  return numberEnv("X_API_CREDITS_CIRCUIT_TTL_HOURS", 24, 1, 168);
}

function endpointCreditsFailureMs(value = {}, usage = {}) {
  return (
    parseTimestampMs(value?.lastFailureAt) ||
    parseTimestampMs(value?.lastCalledAt) ||
    // Summarized usage snapshots sometimes keep lastStatus=402 but drop per-call
    // timestamps; fall back to the usage ledger clock so the circuit still trips.
    parseTimestampMs(usage?.updatedAt)
  );
}

function evaluateXCreditsCircuit(usage = {}, now = new Date()) {
  if (!xApiCreditsCircuitBreakerEnabled()) {
    return { active: false, reason: "Credits circuit breaker disabled." };
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now || "");
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ttlHours = xApiCreditsCircuitTtlHours();
  let latest = null;

  for (const [endpoint, value] of Object.entries(usage?.endpoints || {})) {
    const status = normalizedStatusCode(value?.lastStatus);
    if (status !== 402 && classifyXApiCooldownStatus(status) !== "credits_depleted") continue;
    const failureMs = endpointCreditsFailureMs(value, usage);
    if (!failureMs) continue;
    if (currentMs - failureMs > ttlHours * 3600 * 1000) continue;
    const candidate = {
      active: true,
      endpoint,
      status,
      since: new Date(failureMs).toISOString(),
      until: new Date(failureMs + ttlHours * 3600 * 1000).toISOString(),
      remainingHours: Math.max(1, Math.ceil((failureMs + ttlHours * 3600 * 1000 - currentMs) / 3600000)),
    };
    if (!latest || Date.parse(candidate.since) > Date.parse(latest.since)) latest = candidate;
  }

  if (!latest) return { active: false, reason: "No recent X credits-depleted signal." };
  return {
    ...latest,
    reason: `X API credits depleted on ${latest.endpoint} (HTTP ${latest.status}); pausing paid X writes/reads for ~${latest.remainingHours}h until ${latest.until}.`,
  };
}

function xApiCooldownMinutesForStatus(status) {
  const kind = classifyXApiCooldownStatus(status);
  if (kind === "rate_limit") {
    return integerEnv("X_API_RATE_LIMIT_COOLDOWN_MINUTES", 360, 5, 1440);
  }
  if (kind === "credits_depleted") {
    return integerEnv("X_API_CREDITS_CIRCUIT_TTL_HOURS", 24, 1, 168) * 60;
  }
  if (kind === "backend_fault") {
    return integerEnv("X_API_BACKEND_COOLDOWN_MINUTES", 30, 5, 360);
  }
  return 0;
}

function evaluateXApiCooldown(usage = {}, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now || "");
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  let active = null;

  for (const [endpoint, value] of Object.entries(usage?.endpoints || {})) {
    const status = normalizedStatusCode(value?.lastStatus);
    const kind = classifyXApiCooldownStatus(status);
    if (!kind) continue;

    const lastFailureMs =
      kind === "credits_depleted"
        ? endpointCreditsFailureMs(value, usage)
        : parseTimestampMs(value?.lastFailureAt) || parseTimestampMs(value?.lastCalledAt);
    if (!lastFailureMs) continue;

    const cooldownMinutes = xApiCooldownMinutesForStatus(status);
    const untilMs = lastFailureMs + cooldownMinutes * 60 * 1000;
    if (untilMs <= currentMs) continue;

    const candidate = {
      active: true,
      reasonCode: kind,
      severity: "danger",
      endpoint,
      status,
      since: new Date(lastFailureMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      remainingMinutes: Math.max(1, Math.ceil((untilMs - currentMs) / 60000)),
      cooldownMinutes,
      readGate: "closed",
    };

    if (!active || Date.parse(candidate.until) > Date.parse(active.until)) {
      active = candidate;
    }
  }

  if (!active) {
    const creditsCircuit = evaluateXCreditsCircuit(usage, now instanceof Date ? now : new Date(now || Date.now()));
    if (creditsCircuit.active) {
      active = {
        active: true,
        reasonCode: "credits_depleted",
        severity: "danger",
        endpoint: creditsCircuit.endpoint || null,
        status: creditsCircuit.status || 402,
        since: creditsCircuit.since || null,
        until: creditsCircuit.until || null,
        remainingMinutes: Math.max(1, Math.ceil((Number(creditsCircuit.remainingHours) || 1) * 60)),
        cooldownMinutes: xApiCreditsCircuitTtlHours() * 60,
        readGate: "closed",
      };
    }
  }

  if (!active) {
    return {
      active: false,
      reasonCode: "none",
      severity: "ok",
      endpoint: null,
      status: null,
      since: null,
      until: null,
      remainingMinutes: 0,
      cooldownMinutes: 0,
      readGate: "cached_only",
      reason: "No active X API cooldown.",
    };
  }

  const label =
    active.reasonCode === "rate_limit"
      ? "rate limit"
      : active.reasonCode === "credits_depleted"
        ? "credits depleted"
        : "backend fault";
  return {
    ...active,
    reason: `X API ${label} (${active.status}) on ${active.endpoint}; live X reads are paused for ~${active.remainingMinutes} min until ${active.until}.`,
  };
}

function xApiRunwayGuardEnabled() {
  return isTruthy(optionalEnv("X_API_RUNWAY_GUARD_ENABLED", "true"));
}

function plannedDailyPostTarget() {
  const enConfigured = optionalEnv("TWEET_CADENCE_DAILY_POST_TARGET_EN");
  const zhConfigured = optionalEnv("TWEET_CADENCE_DAILY_POST_TARGET_ZH");
  if (enConfigured || zhConfigured) {
    return (
      integerEnv("TWEET_CADENCE_DAILY_POST_TARGET_EN", 1, 0, 20) +
      integerEnv("TWEET_CADENCE_DAILY_POST_TARGET_ZH", 1, 0, 20)
    );
  }
  return integerEnv("TWEET_CADENCE_DAILY_POST_TARGET", 1, 0, 20);
}

function evaluateXApiRunwayGuard({ usage = {}, budgetState = {}, projectedCost = 0, now = new Date() } = {}) {
  const budget = monthlyBudgetUsd();
  if (!xApiRunwayGuardEnabled() || budget <= 0) {
    return {
      active: false,
      enabled: xApiRunwayGuardEnabled(),
      reasonCode: budget <= 0 ? "budget_disabled" : "disabled",
      reason: budget <= 0
        ? "X API runway guard is disabled because budget tracking is disabled."
        : "X API runway guard disabled by configuration.",
    };
  }

  const safeCap = budget * budgetSafetyRatio();
  const trackedSpend = Math.max(
    Number(usage?.totalEstimatedUsd) || 0,
    Number(budgetState?.spentUsd) || 0,
  );
  const safeRemaining = Math.max(0, safeCap - trackedSpend);
  const lookbackDays = integerEnv("X_API_RUNWAY_LOOKBACK_DAYS", 7, 1, 31);
  const series = xApiDailySeries(usage, lookbackDays);
  const recentSpend = series.reduce((sum, day) => sum + (Number(day.usd) || 0), 0);
  const activeSpendDays = series.filter((day) => Number(day.usd) > 0).length;
  const month = budgetMonthProgress(now instanceof Date ? now.toISOString() : now);
  const observedDailyBurn = recentSpend > 0
    ? recentSpend / Math.max(1, activeSpendDays || Math.min(lookbackDays, month.daysElapsed))
    : 0;
  const plannedDailyBurn =
    estimatedPostCost(false) * plannedDailyPostTarget() +
    (Number(projectedCost) || 0) * integerEnv("X_API_RUNWAY_MAINTENANCE_RUNS_PER_DAY", 1, 0, 24);
  const dailyBurn = Math.max(observedDailyBurn, plannedDailyBurn);
  const projectedSpend = trackedSpend + (Number(projectedCost) || 0);
  const monthEndProjectedSpend = projectedSpend + dailyBurn * month.daysRemaining;
  const runwayDays = dailyBurn > 0
    ? Math.max(0, safeRemaining - (Number(projectedCost) || 0)) / dailyBurn
    : null;
  const minRunwayDays = integerEnv("X_API_RUNWAY_MIN_DAYS", 3, 0, 31);
  const monthEndUnsafe = month.daysRemaining > 0 && monthEndProjectedSpend > safeCap;
  const runwayTooShort = runwayDays !== null && runwayDays < Math.min(minRunwayDays, Math.max(1, month.daysRemaining));
  const active = monthEndUnsafe || runwayTooShort || projectedSpend > safeCap;

  return {
    active,
    enabled: true,
    reasonCode: active ? "runway_guard" : "inside_runway",
    severity: active ? "warn" : "ok",
    readGate: active ? "cached_only" : "open",
    budgetUsd: roundUsd(budget),
    safeCapUsd: roundUsd(safeCap),
    trackedSpendUsd: roundUsd(trackedSpend),
    projectedCostUsd: roundUsd(Number(projectedCost) || 0),
    safeRemainingUsd: roundUsd(safeRemaining),
    observedDailyBurnUsd: roundUsd(observedDailyBurn),
    plannedDailyBurnUsd: roundUsd(plannedDailyBurn),
    projectedDailyBurnUsd: roundUsd(dailyBurn),
    monthDay: month.day,
    daysRemaining: month.daysRemaining,
    monthEndProjectedSpendUsd: roundUsd(monthEndProjectedSpend),
    monthEndSafe: !monthEndUnsafe && projectedSpend <= safeCap,
    runwayDays: runwayDays === null ? null : Number(runwayDays.toFixed(1)),
    reason: active
      ? `X API runway guard paused live reads: $${trackedSpend.toFixed(3)} tracked + ~$${(Number(projectedCost) || 0).toFixed(3)} projected now, daily burn ~$${dailyBurn.toFixed(3)}, month-end projection $${monthEndProjectedSpend.toFixed(3)} > $${safeCap.toFixed(2)} safe cap.`
      : `X API runway guard clear: daily burn ~$${dailyBurn.toFixed(3)}, projected month-end $${monthEndProjectedSpend.toFixed(3)} / $${safeCap.toFixed(2)} safe cap.`,
  };
}

async function estimateMaintenanceReadCost() {
  const state = await readTweetAnalytics();
  return estimateMaintenanceReadCostFromState(state);
}

function estimateMaintenanceReadCostFromState(state = emptyTweetAnalyticsState()) {
  let projectedCost = 0;
  if (
    isTruthy(optionalEnv("TWEET_ACCOUNT_SNAPSHOT_ENABLED", "true")) &&
    shouldRefreshAccountSnapshot(state)
  ) {
    projectedCost += estimatedEndpointCost("USER_ME_LOOKUP");
  }

  const maxPosts = integerEnv("TWEET_METRICS_MAX_POSTS", 5, 1, 100);
  const dueMetricRecords = state.tweets
    .filter((record) => record.id && shouldRefreshTweetMetrics(record))
    .slice(0, maxPosts);
  if (dueMetricRecords.length) {
    projectedCost += estimatedEndpointCost("TWEET_METRICS_LOOKUP");
  }

  if (hotspotRadarEnabled()) {
    const queryCount = hotspotRadarQueries()
      .filter(Boolean)
      .slice(0, integerEnv("TWEET_HOTSPOT_RADAR_MAX_QUERIES", 4, 1, 10)).length;
    projectedCost += queryCount * estimatedEndpointCost("RECENT_SEARCH");
  }

  if (autoReplyEnabled()) {
    projectedCost += estimatedEndpointCost("USER_ME_LOOKUP");
    projectedCost +=
      integerEnv("TWEET_AUTO_REPLY_MAX_QUERIES", 2, 1, 5) *
      estimatedEndpointCost("AUTO_REPLY_SEARCH");
  }

  return Number(projectedCost.toFixed(3));
}

async function evaluateMaintenanceReadBudget() {
  const usage = await readXApiUsageState();
  const budgetState = await readApiBudgetState();
  const projectedCost = await estimateMaintenanceReadCost();
  const cooldown = evaluateXApiCooldown(usage);
  if (projectedCost > 0 && cooldown.active) {
    return {
      allowed: false,
      category: "cooldown",
      projectedCost,
      spent: Number(usage.totalEstimatedUsd) || 0,
      safeCap: monthlyBudgetUsd() * budgetSafetyRatio(),
      cooldown,
      runway: null,
      reason: cooldown.reason,
    };
  }

  const budget = monthlyBudgetUsd();
  if (budget <= 0) return { allowed: true, projectedCost, cooldown, runway: null, reason: "X API budget tracking disabled." };

  const safeCap = budget * budgetSafetyRatio();
  const spent = Math.max(Number(usage.totalEstimatedUsd) || 0, Number(budgetState.spentUsd) || 0);

  if (spent + projectedCost > safeCap) {
    return {
      allowed: false,
      category: "budget",
      projectedCost,
      spent,
      safeCap,
      cooldown,
      runway: null,
      reason: `Maintenance X read budget would exceed safe cap ($${spent.toFixed(3)} spent + ~$${projectedCost.toFixed(3)} reads > $${safeCap.toFixed(2)} safe cap).`,
    };
  }

  const runway = evaluateXApiRunwayGuard({ usage, budgetState, projectedCost });
  if (projectedCost > 0 && runway.active) {
    return {
      allowed: false,
      category: "runway",
      projectedCost,
      spent,
      safeCap,
      cooldown,
      runway,
      reason: runway.reason,
    };
  }

  return { allowed: true, projectedCost, spent, safeCap, cooldown, runway };
}

async function persistXApiUsageState(state) {
  const file = xApiUsageFile();
  await ensureParentDirectory(file);
  await Bun.write(
    file,
    `${JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function recordXApiUsage({ endpoint, status, ok, costUsd }) {
  if (!xApiUsageTrackingEnabled()) return;
  try {
    const state = await readXApiUsageState();
    const day = currentUsageDay();
    const now = new Date().toISOString();
    const cost = Number(costUsd) || 0;
    const endpointKey = endpoint || "unknown";
    const dayState = state.days[day] || { calls: 0, failures: 0, estimatedUsd: 0 };
    const endpointState = state.endpoints[endpointKey] || {
      calls: 0,
      failures: 0,
      estimatedUsd: 0,
      statuses: {},
    };

    dayState.calls += 1;
    endpointState.calls += 1;
    if (!ok) {
      dayState.failures += 1;
      endpointState.failures += 1;
      dayState.lastFailureAt = now;
      dayState.lastFailureStatus = status;
      endpointState.lastFailureAt = now;
      endpointState.lastFailureStatus = status;
    }
    dayState.estimatedUsd += cost;
    endpointState.estimatedUsd += cost;
    endpointState.lastStatus = status;
    dayState.lastStatus = status;
    dayState.lastCalledAt = now;
    endpointState.lastCalledAt = now;
    endpointState.statuses[String(status)] = (endpointState.statuses[String(status)] || 0) + 1;

    state.days[day] = dayState;
    state.endpoints[endpointKey] = endpointState;
    state.totalEstimatedUsd = (Number(state.totalEstimatedUsd) || 0) + cost;
    await persistXApiUsageState(state);
  } catch (error) {
    console.warn(`X API usage tracking skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function openAITokenUsage(rawUsage = {}) {
  const inputTokens = Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens) || 0;
  const outputTokens = Number(rawUsage.completion_tokens ?? rawUsage.output_tokens) || 0;
  const totalTokens = Number(rawUsage.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function estimatedOpenAICostUsd(rawUsage = {}) {
  const usage = openAITokenUsage(rawUsage);
  const inputPer1k = numberEnv("OPENAI_COST_INPUT_1K_USD", 0, 0, 100);
  const outputPer1k = numberEnv("OPENAI_COST_OUTPUT_1K_USD", 0, 0, 100);
  const requestCost = numberEnv("OPENAI_COST_REQUEST_USD", 0, 0, 10);
  return requestCost + (usage.inputTokens / 1000) * inputPer1k + (usage.outputTokens / 1000) * outputPer1k;
}

async function readOpenAIUsageState() {
  const state = await readJsonFileIfExists(openAIUsageFile(), {});
  if (state.month !== currentBudgetMonth()) {
    return { month: currentBudgetMonth(), days: {}, purposes: {}, models: {}, totalEstimatedUsd: 0 };
  }
  return {
    month: state.month,
    days: state.days && typeof state.days === "object" ? state.days : {},
    purposes: state.purposes && typeof state.purposes === "object" ? state.purposes : {},
    models: state.models && typeof state.models === "object" ? state.models : {},
    totalEstimatedUsd: Number(state.totalEstimatedUsd) || 0,
    updatedAt: state.updatedAt || null,
  };
}

async function persistOpenAIUsageState(state) {
  const file = openAIUsageFile();
  await ensureParentDirectory(file);
  await Bun.write(
    file,
    `${JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function addOpenAIUsageToBucket(bucket, { ok, status, costUsd, usage }) {
  bucket.calls = (Number(bucket.calls) || 0) + 1;
  bucket.failures = (Number(bucket.failures) || 0) + (ok ? 0 : 1);
  bucket.estimatedUsd = (Number(bucket.estimatedUsd) || 0) + costUsd;
  bucket.inputTokens = (Number(bucket.inputTokens) || 0) + usage.inputTokens;
  bucket.outputTokens = (Number(bucket.outputTokens) || 0) + usage.outputTokens;
  bucket.totalTokens = (Number(bucket.totalTokens) || 0) + usage.totalTokens;
  bucket.lastStatus = status;
  bucket.lastCalledAt = new Date().toISOString();
  return bucket;
}

async function recordOpenAIUsage({ purpose, model, status, ok, usage: rawUsage }) {
  if (!openAIUsageTrackingEnabled()) return;
  try {
    const state = await readOpenAIUsageState();
    const day = currentUsageDay();
    const usage = openAITokenUsage(rawUsage || {});
    const costUsd = estimatedOpenAICostUsd(rawUsage || {});
    const purposeKey = purpose || "chat";
    const modelKey = model || "unknown";

    state.days[day] = addOpenAIUsageToBucket(state.days[day] || {}, {
      ok,
      status,
      costUsd,
      usage,
    });
    state.purposes[purposeKey] = addOpenAIUsageToBucket(state.purposes[purposeKey] || {}, {
      ok,
      status,
      costUsd,
      usage,
    });
    state.models[modelKey] = addOpenAIUsageToBucket(state.models[modelKey] || {}, {
      ok,
      status,
      costUsd,
      usage,
    });
    state.totalEstimatedUsd = (Number(state.totalEstimatedUsd) || 0) + costUsd;
    await persistOpenAIUsageState(state);
  } catch (error) {
    console.warn(`OpenAI usage tracking skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function evaluateOpenAIBudgetBeforeCall(purpose = "chat") {
  const budget = numberEnv("OPENAI_MONTHLY_BUDGET_USD", 0, 0, 1000);
  if (budget <= 0 || !openAIUsageTrackingEnabled()) return { allowed: true };

  const usage = await readOpenAIUsageState();
  const safeCap = budget * numberEnv("OPENAI_BUDGET_SAFETY_RATIO", 0.9, 0.5, 1);
  const spent = Number(usage.totalEstimatedUsd) || 0;
  if (spent >= safeCap) {
    throw new Error(
      `OpenAI budget guard blocked ${purpose}: $${spent.toFixed(3)} tracked >= $${safeCap.toFixed(2)} safe cap.`,
    );
  }
  return { allowed: true, spent, safeCap };
}

async function xFetch(endpoint, url, options = {}, { costUsd = estimatedEndpointCost(endpoint) } = {}) {
  const response = await fetch(url, options);
  await recordXApiUsage({
    endpoint,
    status: response.status,
    ok: response.ok,
    costUsd,
  });
  return response;
}

async function seedTweetAnalyticsFromArchive(state) {
  const existingIds = new Set((state.tweets || []).map((record) => String(record.id)));
  const archiveFile = optionalEnv("TWEET_ARCHIVE_FILE", "archive/tweets.jsonl");
  const content = await readTextFileIfExists(archiveFile);
  if (!content.trim()) return state;

  const seeds = [];
  for (const line of content.trim().split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.id || existingIds.has(String(entry.id))) continue;
      existingIds.add(String(entry.id));
      seeds.push({
        id: String(entry.id),
        text: entry.text || "",
        language: entry.language || null,
        postedAt: entry.postedAt || null,
        url: entry.url || `https://x.com/i/web/status/${entry.id}`,
        characterCount: entry.characterCount ?? countCharacters(entry.text || ""),
        hasMedia: Boolean(entry.mediaId) && Boolean(entry.hasMedia),
        mediaId: entry.mediaId || null,
        mediaAttached: Boolean(entry.mediaId),
        newsTitle: entry.newsTitle || null,
        newsLink: entry.newsLink || null,
        newsSource: entry.newsSource || null,
        newsSourceTier: entry.newsSourceTier || sourceTier(entry.newsSource),
        newsHotScore: entry.newsHotScore ?? null,
        templateId: entry.templateId || null,
        candidateScore: entry.candidateScore ?? null,
        hashtags: extractHashtags(entry.text || ""),
        metricsSnapshots: [],
        latestMetrics: null,
        workflowRunUrl: entry.workflowRunUrl || null,
        createdAt: new Date().toISOString(),
        seededFromArchive: true,
      });
    } catch {
      continue;
    }
  }

  if (!seeds.length) return state;
  return normalizeAnalyticsState({
    ...state,
    tweets: [...state.tweets, ...seeds],
  });
}

function publicMetricScore(metrics = {}) {
  const impressions = Number(metrics.impression_count) || 0;
  const likes = Number(metrics.like_count) || 0;
  const reposts = Number(metrics.retweet_count) || 0;
  const quotes = Number(metrics.quote_count) || 0;
  const replies = Number(metrics.reply_count) || 0;
  const bookmarks = Number(metrics.bookmark_count) || 0;
  return impressions * 0.01 + likes * 2 + reposts * 5 + quotes * 4 + replies * 3 + bookmarks * 3;
}

function privateMetricScore(metrics = {}) {
  const profileClicks = Number(metrics.user_profile_clicks) || 0;
  const urlClicks = Number(metrics.url_link_clicks) || 0;
  const detailExpands = Number(metrics.detail_expands) || 0;
  return profileClicks * 4 + urlClicks * 2 + detailExpands * 0.3;
}

function tweetGrowthScore(snapshot = {}) {
  return (
    publicMetricScore(snapshot.publicMetrics) +
    privateMetricScore(snapshot.nonPublicMetrics) +
    privateMetricScore(snapshot.organicMetrics)
  );
}

function engagementRate(snapshot = {}) {
  const metrics = snapshot.publicMetrics || {};
  const impressions = Number(metrics.impression_count) || 0;
  if (!impressions) return 0;
  const engagements =
    (Number(metrics.like_count) || 0) +
    (Number(metrics.retweet_count) || 0) +
    (Number(metrics.quote_count) || 0) +
    (Number(metrics.reply_count) || 0) +
    (Number(metrics.bookmark_count) || 0);
  return engagements / impressions;
}

function latestTweetSnapshot(record) {
  if (record?.latestMetrics) return record.latestMetrics;
  const snapshots = Array.isArray(record?.metricsSnapshots) ? record.metricsSnapshots : [];
  return snapshots[snapshots.length - 1] || null;
}

function recordGrowthScore(record) {
  const snapshot = latestTweetSnapshot(record);
  if (!snapshot) return Number(record?.initialGrowthScore) || 0;
  return tweetGrowthScore(snapshot);
}

function bucketStats(records, keyFn) {
  const buckets = {};
  for (const record of records) {
    const key = keyFn(record);
    if (!key) continue;
    const score = recordGrowthScore(record);
    const bucket = buckets[key] || { count: 0, totalScore: 0, avgScore: 0 };
    bucket.count += 1;
    bucket.totalScore += score;
    bucket.avgScore = bucket.totalScore / bucket.count;
    buckets[key] = bucket;
  }
  return buckets;
}

function extractHashtags(text) {
  return [...String(text || "").matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)].map((match) =>
    match[2].toLowerCase(),
  );
}

function inferHashtags(text, story, language = null) {
  const haystack = `${text || ""} ${story?.title || ""} ${story?.summary || ""}`.toLowerCase();
  const tags = [];
  const add = (tag) => {
    const normalized = tag.replace(/^#/, "");
    if (!tags.includes(normalized.toLowerCase())) tags.push(normalized);
  };

  if (/(openai|gpt|llm|\bai\b|artificial intelligence|claude|gemini|deepmind|cursor|agent|nvidia)/i.test(haystack)) add("AI");
  if (/(apple|google|microsoft|meta|amazon|tesla|nvidia|youtube|tiktok|x platform|twitter)/i.test(haystack)) add("BigTech");
  if (/(developer|devtools|github|code|coding|ide|cursor|v0|api|工程|开发|编程)/i.test(haystack)) add("DevTools");
  if (/(ios|iphone|ipad|apple|app store|android|mobile|app\b|apps\b|wearable|headset|移动端|手机)/i.test(haystack)) add("ConsumerTech");
  if (/(security|cve|breach|cyber|privacy|安全|隐私)/i.test(haystack)) add("Cybersecurity");
  if (/(startup|funding|producthunt|founder|创业|融资)/i.test(haystack)) add("Startups");
  if (/(robot|hardware|chip|gpu|nvidia|device|芯片|机器人)/i.test(haystack)) add("Hardware");
  if (/(cloud|aws|azure|gcp|cloudflare|vercel|database|databricks|kubernetes)/i.test(haystack)) add("Cloud");

  if (!tags.length) {
    add("AI");
    add("BigTech");
  }
  if (tags.length === 1) {
    if (tags[0].toLowerCase() === "ai") add("BigTech");
    else add("AI");
  }
  return tags;
}

function canonicalHashtag(tag) {
  const key = String(tag || "").replace(/^#/, "").trim().toLowerCase();
  const canonical = {
    ai: "AI",
    bigtech: "BigTech",
    consumertech: "ConsumerTech",
    cybersecurity: "Cybersecurity",
    startups: "Startups",
    cloud: "Cloud",
    devtools: "DevTools",
    hardware: "Hardware",
  };
  return canonical[key] || null;
}

function hashtagScore(tag, performanceInsights = null) {
  const key = String(tag || "").replace(/^#/, "").toLowerCase();
  const bucket = performanceInsights?.tags?.[key];
  if (!bucket) return 0;
  const baseline = Math.max(1, Number(performanceInsights?.baselineScore) || 0);
  const samples = Number(bucket.count) || 0;
  const lift = ((Number(bucket.avgScore) || 0) - baseline) / baseline;
  return Math.max(-1, Math.min(2, lift)) * 10 + Math.min(6, samples);
}

function selectHashtags({ text, story, language = null, performanceInsights = null, targetCount = 2 }) {
  const inferred = inferHashtags(text, story, language);
  const learnedTags = Object.entries(performanceInsights?.tags || {})
    .map(([tag, bucket]) => ({
      tag,
      score: hashtagScore(tag, performanceInsights),
      samples: Number(bucket?.count) || 0,
    }))
    .filter((item) => item.samples >= Math.max(1, Number(performanceInsights?.minSamples) || 1))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.tag);
  const allowed = new Set(inferred.map((tag) => tag.toLowerCase()));
  const ordered = [
    ...learnedTags.filter((tag) => allowed.has(String(tag).toLowerCase())),
    ...inferred,
  ];
  const selected = [];
  for (const tag of ordered) {
    const normalized = String(tag || "").replace(/^#/, "").trim();
    if (!normalized) continue;
    if (selected.some((item) => item.toLowerCase() === normalized.toLowerCase())) continue;
    selected.push(normalized);
    if (selected.length >= targetCount) break;
  }
  return selected;
}

function ensureTweetHashtags(text, story, language = null, performanceInsights = null) {
  const trimmed = trimTweet(text);
  if (!isTruthy(optionalEnv("TWEET_HASHTAGS_ENABLED", "true"))) return trimmed;

  const targetCount = integerEnv("TWEET_HASHTAG_COUNT", 2, 1, 5);
  const existing = extractHashtags(trimmed)
    .map(canonicalHashtag)
    .filter(Boolean);
  const uniqueExisting = uniqueStrings(existing, targetCount);

  const inferred = selectHashtags({
    text: trimmed,
    story,
    language,
    performanceInsights,
    targetCount,
  })
    .map((tag) => canonicalHashtag(tag) || tag)
    .filter((tag) => !uniqueExisting.some((existingTag) => existingTag.toLowerCase() === String(tag).toLowerCase()))
    .slice(0, targetCount - uniqueExisting.length);
  if (!uniqueExisting.length && !inferred.length) return trimmed;

  const tagLine = [
    ...uniqueExisting.map((tag) => `#${tag}`),
    ...inferred.map((tag) => `#${tag}`),
  ]
    .slice(0, targetCount)
    .join(" ");
  const body = trimmed.replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, "").trim();
  const maxBodyLength = MAX_TWEET_LENGTH - countCharacters(tagLine) - 1;
  const safeBody =
    countCharacters(body) > maxBodyLength
      ? Array.from(body).slice(0, Math.max(0, maxBodyLength - 1)).join("").trimEnd() + "…"
      : body;
  return trimTweet(`${safeBody}\n${tagLine}`);
}

function openSourcePromoEnabled() {
  if (optionalEnv("TWEET_SELF_TEST")) return false;
  return isTruthy(optionalEnv("TWEET_OSS_PROMO_ENABLED", "true"));
}

function openSourcePromoUrl() {
  return optionalEnv("TWEET_OSS_PROMO_URL", "github.com/Linus-Shyu/XGrowth").replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function openSourcePromoAllowedLanguage(language = null) {
  const configured = listEnv("TWEET_OSS_PROMO_LANGUAGES");
  if (!configured.length) return true;
  const code = String(language?.code || language || "en").toLowerCase();
  return configured.map((value) => value.toLowerCase()).includes(code);
}

function shouldAttachOpenSourcePromo({ score = null, language = null, seed = "" } = {}) {
  if (!openSourcePromoEnabled()) return false;
  if (!openSourcePromoAllowedLanguage(language)) return false;
  const minScore = numberEnv("TWEET_OSS_PROMO_MIN_SCORE", 170, 0, 1000);
  if (score != null && Number.isFinite(Number(score)) && Number(score) < minScore) return false;
  const probability = numberEnv("TWEET_OSS_PROMO_PROBABILITY", 0.28, 0, 1);
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  const unit = hashStringToUnit(`oss-promo:${seed || new Date().toISOString().slice(0, 13)}`);
  return unit < probability;
}

function maybeAppendOpenSourcePromo(text, { score = null, language = null, seed = "" } = {}) {
  // Keep newline before the promo footer. Do not run trimTweet() on the final
  // string — it collapses whitespace and would glue the link onto the last line.
  const trimmed = trimTweet(text);
  if (!shouldAttachOpenSourcePromo({ score, language, seed })) return trimmed;

  const promo = openSourcePromoUrl();
  if (!promo) return trimmed;
  if (new RegExp(escapeRegExp(promo), "i").test(trimmed)) return trimmed;
  if (/https?:\/\/|github\.com\//i.test(trimmed)) return trimmed;

  const suffix = `\n${promo}`;
  const maxBody = MAX_TWEET_LENGTH - countCharacters(suffix);
  if (maxBody < 40) return trimmed;
  const body =
    countCharacters(trimmed) > maxBody
      ? `${Array.from(trimmed).slice(0, Math.max(0, maxBody - 1)).join("").trimEnd()}…`
      : trimmed;
  return `${body}${suffix}`;
}

const AUDIENCE_SEGMENTS = [
  {
    id: "ai_platform",
    label: "AI / Agent Stack",
    targetShare: 0.3,
    broadness: 1.08,
    pattern: /(openai|anthropic|claude|gemini|deepmind|llm|\bai\b|agent|model|cursor|copilot|nvidia|huggingface|机器学习|人工智能)/i,
    directive: "Tie the story to model adoption, workflow lock-in, or operator cost.",
  },
  {
    id: "big_tech_platform",
    label: "Big Tech Platform",
    targetShare: 0.22,
    broadness: 1.18,
    pattern: /(apple|google|microsoft|meta|amazon|tesla|youtube|tiktok|x platform|twitter|app store|play store|platform|苹果|谷歌|微软)/i,
    directive: "Frame the platform shift as distribution, margin, privacy, or default-control leverage.",
  },
  {
    id: "consumer_apps",
    label: "Consumer Apps",
    targetShare: 0.18,
    broadness: 1.25,
    pattern: /(iphone|ipad|ios|android|mobile|app\b|apps\b|wearable|headset|social|creator|consumer|instagram|spotify|netflix|用户|应用|手机)/i,
    directive: "Translate the story into a consumer behavior or distribution habit change.",
  },
  {
    id: "devtools_infra",
    label: "DevTools / Infra",
    targetShare: 0.16,
    broadness: 0.94,
    pattern: /(developer|devtools|github|code|coding|ide|api|sdk|cloudflare|vercel|database|postgres|kubernetes|rust|python|javascript|工程|开发|编程)/i,
    directive: "Expose the operational tradeoff for builders: migration, reliability, cost, or lock-in.",
  },
  {
    id: "security_cloud",
    label: "Security / Cloud",
    targetShare: 0.09,
    broadness: 0.98,
    pattern: /(security|privacy|cve|breach|cyber|cloud|aws|azure|gcp|zero trust|encryption|auth|compliance|安全|隐私|云)/i,
    directive: "Lead with risk transfer, trust boundaries, or incident-response consequences.",
  },
  {
    id: "startup_business",
    label: "Startups / Markets",
    targetShare: 0.05,
    broadness: 1.02,
    pattern: /(startup|funding|founder|producthunt|launch|pricing|revenue|market|saas|ipo|acquisition|创业|融资|商业化)/i,
    directive: "Convert the news into a market timing, pricing, or go-to-market lesson.",
  },
];

const FALLBACK_AUDIENCE_SEGMENT = {
  id: "general_tech",
  label: "General Tech",
  targetShare: 0,
  broadness: 0.86,
  directive: "Use a broad tech framing with one concrete company, product, or user behavior.",
};

const NARRATIVE_PILLARS = [
  {
    id: "operator_leverage",
    label: "Operator Leverage",
    targetShare: 0.3,
    broadness: 1.12,
    pattern: /(workflow|operator|ops|automation|agent|permission|eval|rollback|incident|tooling|developer|devtools|api|sdk|github|cursor|vercel|cloudflare|工程|开发|自动化|工具|权限|回滚)/i,
    directive: "Translate the story into how builders and operators gain or lose leverage.",
    lexicon: ["workflow", "operator", "permission", "rollback", "tooling", "incident", "automation"],
  },
  {
    id: "platform_control",
    label: "Platform Control",
    targetShare: 0.24,
    broadness: 1.18,
    pattern: /(apple|google|microsoft|meta|amazon|youtube|tiktok|app store|browser|os|platform|default|distribution|policy|privacy|苹果|谷歌|微软|平台|默认|分发|隐私)/i,
    directive: "Frame the story as a shift in defaults, distribution, margin, privacy, or control.",
    lexicon: ["default", "distribution", "margin", "policy", "privacy", "control", "lock-in"],
  },
  {
    id: "consumer_behavior",
    label: "Consumer Behavior",
    targetShare: 0.18,
    broadness: 1.22,
    pattern: /(consumer|user|creator|iphone|android|mobile|app\b|apps\b|social|notification|ranking|onboarding|retention|用户|消费者|创作者|手机|应用|通知|留存)/i,
    directive: "Show how a product, app, or device changes user behavior or distribution habits.",
    lexicon: ["users", "creators", "notifications", "onboarding", "retention", "habit", "ranking"],
  },
  {
    id: "risk_boundary",
    label: "Risk Boundary",
    targetShare: 0.14,
    broadness: 1.02,
    pattern: /(security|privacy|breach|cve|auth|compliance|encryption|trust|cloud|aws|azure|gcp|incident|安全|隐私|信任|合规|云)/i,
    directive: "Lead with risk transfer, trust boundaries, compliance cost, or incident response.",
    lexicon: ["risk", "trust", "auth", "compliance", "incident", "privacy", "security"],
  },
  {
    id: "market_timing",
    label: "Market Timing",
    targetShare: 0.14,
    broadness: 1.08,
    pattern: /(startup|founder|pricing|revenue|market|funding|launch|saas|ipo|acquisition|open source|创业|融资|商业化|定价|市场)/i,
    directive: "Convert the news into a timing, pricing, GTM, or business-model lesson.",
    lexicon: ["pricing", "market", "timing", "distribution", "revenue", "GTM", "business model"],
  },
];

const FALLBACK_NARRATIVE_PILLAR = {
  id: "tech_signal",
  label: "Tech Signal",
  targetShare: 0,
  broadness: 0.86,
  directive: "Keep the story grounded in one concrete tech signal and one reusable operating rule.",
  lexicon: ["signal", "rule", "tradeoff", "default", "cost"],
};

function audienceSegmentDefinitions() {
  return [...AUDIENCE_SEGMENTS, FALLBACK_AUDIENCE_SEGMENT];
}

function audienceSegmentDefinition(id) {
  return audienceSegmentDefinitions().find((segment) => segment.id === id) || FALLBACK_AUDIENCE_SEGMENT;
}

function audienceHaystack(item) {
  if (typeof item === "string") return item;
  return [
    item?.text,
    item?.title,
    item?.summary,
    item?.newsTitle,
    item?.newsSource,
    item?.source,
    Array.isArray(item?.hashtags) ? item.hashtags.join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function audienceSegmentMatches(item) {
  const haystack = audienceHaystack(item);
  const matches = AUDIENCE_SEGMENTS
    .map((segment) => {
      const matched = segment.pattern.test(haystack);
      if (!matched) return null;
      const sourceBonus = String(haystack).toLowerCase().includes(segment.id.split("_")[0]) ? 0.1 : 0;
      return {
        ...segment,
        matchScore: Number((segment.broadness + sourceBonus).toFixed(2)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.matchScore - left.matchScore);
  return matches.length ? matches : [{ ...FALLBACK_AUDIENCE_SEGMENT, matchScore: 0.5 }];
}

function primaryAudienceSegment(item) {
  return audienceSegmentMatches(item)[0] || FALLBACK_AUDIENCE_SEGMENT;
}

function narrativePillarDefinitions() {
  return [...NARRATIVE_PILLARS, FALLBACK_NARRATIVE_PILLAR];
}

function narrativePillarDefinition(id) {
  return narrativePillarDefinitions().find((pillar) => pillar.id === id) || FALLBACK_NARRATIVE_PILLAR;
}

function narrativeHaystack(item) {
  if (typeof item === "string") return item;
  return [
    item?.text,
    item?.title,
    item?.summary,
    item?.newsTitle,
    item?.newsSource,
    item?.source,
    item?.candidateReason,
    item?.angle,
    Array.isArray(item?.hashtags) ? item.hashtags.join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function narrativePillarMatches(item) {
  const haystack = narrativeHaystack(item);
  const matches = NARRATIVE_PILLARS
    .map((pillar) => {
      const matched = pillar.pattern.test(haystack);
      if (!matched) return null;
      const lower = String(haystack).toLowerCase();
      const lexiconHits = (pillar.lexicon || []).filter((word) => lower.includes(String(word).toLowerCase())).length;
      return {
        ...pillar,
        matchScore: Number((pillar.broadness + Math.min(0.28, lexiconHits * 0.04)).toFixed(2)),
        lexiconHits,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.matchScore - left.matchScore);
  return matches.length ? matches : [{ ...FALLBACK_NARRATIVE_PILLAR, matchScore: 0.5, lexiconHits: 0 }];
}

function primaryNarrativePillar(item) {
  return narrativePillarMatches(item)[0] || FALLBACK_NARRATIVE_PILLAR;
}

function deriveAnalyticsInsights(state) {
  const minSamples = integerEnv("TWEET_GROWTH_MIN_SAMPLES", 2, 1, 20);
  const records = (state.tweets || []).filter((record) => latestTweetSnapshot(record));
  const scores = records.map((record) => recordGrowthScore(record));
  const baselineScore = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : 0;

  const templates = bucketStats(records, (record) => record.templateId || "unknown");
  const sources = bucketStats(records, (record) => record.newsSource || "");
  const sourceTiers = bucketStats(records, (record) => record.newsSourceTier || "");
  const languages = bucketStats(records, (record) => record.language || "");
  const media = bucketStats(records, (record) => (record.hasMedia ? "with_media" : "text_only"));
  const audienceSegments = bucketStats(records, (record) => record.audienceSegment || primaryAudienceSegment(record).id);
  const tags = {};
  for (const record of records) {
    for (const tag of extractHashtags(record.text)) {
      const bucket = tags[tag] || { count: 0, totalScore: 0, avgScore: 0 };
      bucket.count += 1;
      bucket.totalScore += recordGrowthScore(record);
      bucket.avgScore = bucket.totalScore / bucket.count;
      tags[tag] = bucket;
    }
  }

  return {
    records,
    minSamples,
    baselineScore,
    templates,
    sources,
    sourceTiers,
    languages,
    media,
    audienceSegments,
    tags,
  };
}

function growthStrategyEnabled() {
  return isTruthy(optionalEnv("TWEET_GROWTH_STRATEGY_ENABLED", "true"));
}

function growthStrategyFile() {
  return optionalEnv("TWEET_GROWTH_STRATEGY_FILE", ".github/runtime/growth-strategy.json");
}

function growthStrategyPublicFile() {
  return optionalEnv("GROWTH_STRATEGY_PUBLIC_FILE", "reports/growth-strategy.json");
}

function growthEvolutionFile() {
  return optionalEnv("GROWTH_EVOLUTION_FILE", ".github/runtime/growth-evolution.jsonl");
}

function growthEvolutionPublicFile() {
  return optionalEnv("GROWTH_EVOLUTION_PUBLIC_FILE", "reports/growth-evolution.jsonl");
}

function utcDayStampFromValue(value) {
  const ms = timestampMs(value, NaN);
  if (!Number.isFinite(ms)) return String(value || "").slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyGrowthStrategy(now = new Date().toISOString()) {
  return {
    version: 2,
    generatedAt: now,
    mode: "cold_start",
    status: "warming",
    source: "cached tweet analytics",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    confidence: "low",
    baselineScore: 0,
    sampleCount: 0,
    formatWeights: {},
    exploreFormatId: null,
    dailyDigest: null,
    evolution: null,
    promotedFormats: [],
    holdFormats: [],
    preferredHashtags: ["AI", "BigTech"],
    blockedOpeners: [
      {
        id: "decision_rule_for",
        pattern: "^(decision rule for|playbook for)\\b",
        reason: "Template opener became repetitive and too headline-adjacent.",
      },
      {
        id: "zh_judgment_standard",
        pattern: "( 的判断标准很简单|真正的问题是：它减少了操作成本)",
        reason: "Chinese fallback opener reads like a template instead of a fresh take.",
      },
      {
        id: "operator_cost_question",
        pattern: "raises the real question: does this reduce operator work",
        reason: "Repeated question framing underperforms as an opening line.",
      },
    ],
    promptDirectives: [
      "Never begin with 'Decision rule for ...' or repeat the article title as the subject.",
      "Lead with one concrete company/product/entity and one non-obvious operator, user, platform, or market consequence.",
      "Prefer a reusable take that invites replies; avoid summaries, headline rewrites, and generic hype.",
    ],
    quality: {
      headlineSimilarityBlock: 0.62,
      headlineSimilarityWarn: 0.45,
      blockGenericHashtags: true,
    },
    nextAction: "Collect more measured posts, then mutate format allocation from cached outcomes.",
  };
}

function preferFresherGrowthStrategy(runtime, published) {
  if (!runtime || typeof runtime !== "object") return published && typeof published === "object" ? published : null;
  if (!published || typeof published !== "object") return runtime;
  const runtimeMs = timestampMs(runtime.generatedAt, 0);
  const publishedMs = timestampMs(published.generatedAt, 0);
  return publishedMs > runtimeMs ? published : runtime;
}

async function readGrowthStrategy() {
  if (!growthStrategyEnabled()) return null;
  const runtime = await readJsonFileIfExists(growthStrategyFile(), null);
  const published = await readJsonFileIfExists(growthStrategyPublicFile(), null);
  const strategy = preferFresherGrowthStrategy(runtime, published);
  if (!strategy || typeof strategy !== "object") return null;
  return {
    ...strategy,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
  };
}

async function persistGrowthStrategy(strategy) {
  if (!growthStrategyEnabled() || !strategy) return;
  // Only write the runtime cache here. The maintenance workflow copies it into
  // reports/ after rebase so the git worktree stays clean for commit/push.
  const file = growthStrategyFile();
  await writeTextFile(file, `${JSON.stringify(strategy, null, 2)}\n`);
  console.log(`Wrote self-evolving growth strategy to ${file}.`);
}

async function appendGrowthEvolutionLog(strategy) {
  if (!growthStrategyEnabled() || !strategy) return;
  const row = {
    generatedAt: strategy.generatedAt,
    utcDay: utcDayStampFromValue(strategy.generatedAt),
    status: strategy.status || null,
    confidence: strategy.confidence || null,
    mutations: strategy.evolution?.mutations || [],
    promotedFormatIds: (strategy.promotedFormats || []).map((item) => item.id).filter(Boolean),
    holdFormatIds: (strategy.holdFormats || []).map((item) => item.id).filter(Boolean),
    exploreFormatId: strategy.exploreFormatId || null,
    formatWeights: strategy.formatWeights || {},
    languagePrimary: strategy.languageBias?.primary || null,
    digest: strategy.dailyDigest || null,
  };
  const line = `${JSON.stringify(row)}\n`;
  const file = growthEvolutionFile();
  const existing = await readTextFileIfExists(file);
  const kept = existing
    ? existing.split("\n").filter(Boolean).slice(-89).join("\n")
    : "";
  await writeTextFile(file, kept ? `${kept}\n${line}` : line);
}

function recentMeasuredRecords(state, hours = 24 * 14, now = Date.now()) {
  return recordsSince(state, hours, now).filter((record) => latestTweetSnapshot(record));
}

function averageRecordScore(records) {
  if (!records?.length) return 0;
  return records.reduce((sum, record) => sum + recordGrowthScore(record), 0) / records.length;
}

function compactStrategyBucket(id, bucket, action, baselineScore) {
  const avgScore = Number(bucket?.avgScore) || 0;
  const samples = Number(bucket?.count) || 0;
  const liftPct = baselineScore > 0 ? ((avgScore - baselineScore) / baselineScore) * 100 : 0;
  return {
    id,
    action,
    avgScore: Number(avgScore.toFixed(1)),
    samples,
    liftPct: Number(liftPct.toFixed(1)),
  };
}

function clampFormatWeight(value, min = 0.4, max = 1.8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(max, Math.max(min, Number(n.toFixed(3))));
}

function defaultFormatWeights() {
  const allocation = parseFormatBaseAllocation(configuredContentFormats());
  return Object.fromEntries(
    configuredContentFormats().map((format) => [
      format.id,
      clampFormatWeight(1 + ((allocation[format.id] || 0) - 1 / Math.max(1, configuredContentFormats().length)) * 2),
    ]),
  );
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recordFirstLine(record, limit = 140) {
  return String(record?.text || "").split(/\n/)[0].replace(/\s+/g, " ").trim().slice(0, limit);
}

function digestMetricWindow(records) {
  const list = Array.isArray(records) ? records : [];
  const measured = list.filter((record) => latestTweetSnapshot(record));
  return {
    posts: list.length,
    measuredPosts: measured.length,
    impressions: sumTweetMetric(list, "impression_count"),
    likes: sumTweetMetric(list, "like_count"),
    replies: sumTweetMetric(list, "reply_count"),
    avgScore: Number(averageRecordScore(measured).toFixed(1)),
  };
}

function formatRowsFromRecords(records, baselineScore, allowedIds = null) {
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const filtered = (records || []).filter((record) => {
    if (!record?.templateId) return false;
    if (allowed && !allowed.has(record.templateId)) return false;
    return true;
  });
  return rankedBucketEntries(bucketStats(filtered, (record) => record.templateId), {
    minSamples: 1,
    excludeUnknown: true,
  }).map(([id, bucket]) => compactStrategyBucket(id, bucket, "watch", baselineScore));
}

function hookRowsFromRecords(records) {
  return [...(records || [])]
    .filter((record) => recordFirstLine(record))
    .sort((left, right) => recordGrowthScore(right) - recordGrowthScore(left))
    .map((record) => ({
      formatId: record.templateId || null,
      score: Number(recordGrowthScore(record).toFixed(1)),
      impressions: metricValue(record, "impression_count"),
      firstLine: recordFirstLine(record),
    }));
}

function languageRowsFromRecords(records, baselineScore) {
  return rankedBucketEntries(
    bucketStats(records || [], (record) => normalizeLanguageCode(record.language) || "unknown"),
    { minSamples: 1, excludeUnknown: true },
  ).map(([id, bucket]) => compactStrategyBucket(id, bucket, "watch", baselineScore));
}

function blockedOpenerFromHook(hook) {
  const firstLine = String(hook?.firstLine || "").trim();
  if (firstLine.length < 18) return null;
  const snippet = firstLine.slice(0, 48);
  const patternSeed = snippet.slice(0, 24);
  return {
    id: `losing_hook_${snippet.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32)}`,
    pattern: `^${escapeRegExp(patternSeed)}`,
    reason: `Losing 24h opener underperformed: ${snippet}`,
  };
}

function buildDailyTrafficDigest({ state, insights, now = new Date().toISOString() } = {}) {
  const allowedIds = configuredContentFormats().map((format) => format.id);
  const last24h = recordsSince(state || { tweets: [] }, 24, now);
  const last7d = recordsSince(state || { tweets: [] }, 24 * 7, now);
  const measured24h = last24h.filter((record) => latestTweetSnapshot(record));
  const measured7d = last7d.filter((record) => latestTweetSnapshot(record));
  const baselineScore = Number(insights?.baselineScore) || averageRecordScore(measured7d.length ? measured7d : measured24h);
  const format24h = formatRowsFromRecords(measured24h, baselineScore, allowedIds);
  const format7d = formatRowsFromRecords(measured7d, baselineScore, allowedIds);
  const hooks = hookRowsFromRecords(measured24h);
  return {
    utcDay: utcDayStampFromValue(now),
    last24h: digestMetricWindow(last24h),
    last7d: digestMetricWindow(last7d),
    bestFormat: format24h[0] || format7d[0] || null,
    worstFormat: format24h.length
      ? format24h[format24h.length - 1]
      : format7d.length
        ? format7d[format7d.length - 1]
        : null,
    formatRows24h: format24h.slice(0, 8),
    formatRows7d: format7d.slice(0, 8),
    languageRows: languageRowsFromRecords(measured7d.length ? measured7d : measured24h, baselineScore).slice(0, 4),
    winningHooks: hooks.slice(0, 2),
    losingHooks: hooks.length > 1 ? hooks.slice(-2).reverse() : [],
    baselineScore: Number((baselineScore || 0).toFixed(1)),
  };
}

function shouldFreezeDailyEvolution(previous, now) {
  if (!previous || typeof previous !== "object") return false;
  if (!dashboardOnlyMaintenanceMode()) return false;
  const previousDay = previous.evolution?.utcDay || utcDayStampFromValue(previous.generatedAt);
  return Boolean(previousDay) && previousDay === utcDayStampFromValue(now);
}

function rankFormatIdsByGrowthStrategy(growthStrategy, formats = configuredContentFormats()) {
  if (!growthStrategy) return [];
  const hasSignal =
    (growthStrategy.formatWeights && Object.keys(growthStrategy.formatWeights).length) ||
    (growthStrategy.promotedFormats || []).length ||
    growthStrategy.exploreFormatId;
  if (!hasSignal) return [];
  const weights = growthStrategy.formatWeights || {};
  const promoted = new Set((growthStrategy.promotedFormats || []).map((row) => row.id).filter(Boolean));
  const hold = new Set((growthStrategy.holdFormats || []).map((row) => row.id).filter(Boolean));
  const explore = growthStrategy.exploreFormatId;
  return [...formats]
    .map((format, index) => ({
      id: format.id,
      score:
        clampFormatWeight(weights[format.id] ?? 1) * 25 +
        (promoted.has(format.id) ? 40 : 0) +
        (format.id === explore ? 16 : 0) +
        (hold.has(format.id) ? -60 : 0) -
        index,
    }))
    .sort((left, right) => right.score - left.score)
    .map((row) => row.id);
}

function strategyRowForId(id, action, rows = []) {
  const row = rows.find((item) => item.id === id);
  return row
    ? { ...row, action }
    : { id, action, avgScore: null, samples: 0, liftPct: null };
}

function evolveGrowthStrategy({
  previous = null,
  digest,
  state,
  insights,
  generationStack = null,
  now = new Date().toISOString(),
} = {}) {
  const safeInsights = insights || {};
  const records = Array.isArray(safeInsights.records) ? safeInsights.records : [];
  const recent = recentMeasuredRecords(state || { tweets: [] }, 24 * 14, now);
  const recent7d = recentMeasuredRecords(state || { tweets: [] }, 24 * 7, now);
  const baselineScore = Number(digest?.baselineScore) || Number(safeInsights.baselineScore) || averageRecordScore(records);
  const recentScore = averageRecordScore(recent7d);
  const minSamples = Math.max(2, Number(safeInsights.minSamples) || 2);
  const formats = configuredContentFormats();
  const formatIds = formats.map((format) => format.id);
  const formatRows = rankedBucketEntries(safeInsights.templates, { minSamples: 1, excludeUnknown: true })
    .map(([id, bucket]) => compactStrategyBucket(id, bucket, "watch", baselineScore));
  const learnedTags = rankedBucketEntries(safeInsights.tags, { minSamples: 1, excludeUnknown: true })
    .map(([tag]) => canonicalHashtag(tag))
    .filter(Boolean);
  const preferredHashtags = uniqueStrings([...learnedTags, "AI", "BigTech", "ConsumerTech", "DevTools"], 5);
  const repeatedFormulaicRecords = recent
    .filter((record) => formulaicGrowthTemplateOpening(record.text || "") || headlineFrameSimilarity(record.text || "", { title: record.newsTitle }) >= 0.62)
    .slice(0, 5)
    .map((record) => ({
      id: record.id,
      templateId: record.templateId || null,
      score: Number(recordGrowthScore(record).toFixed(1)),
      firstLine: recordFirstLine(record, 160),
    }));
  const languageEntries = (digest?.languageRows?.length
    ? digest.languageRows
    : rankedBucketEntries(safeInsights.languages, { minSamples: 1, excludeUnknown: true })
      .map(([id, bucket]) => compactStrategyBucket(id, bucket, "watch", baselineScore)));
  const primaryLanguage = languageEntries[0] || null;
  const stack = generationStack || (safeInsights.records ? buildGenerationLearningStack(safeInsights) : {});
  const seed = previous && typeof previous === "object" ? previous : emptyGrowthStrategy(now);
  const weights = { ...defaultFormatWeights(), ...(seed.formatWeights || {}) };
  for (const id of formatIds) {
    weights[id] = clampFormatWeight(weights[id]);
  }

  const mutations = [];
  const best = digest?.bestFormat && formatIds.includes(digest.bestFormat.id) ? digest.bestFormat : null;
  const worst = digest?.worstFormat && formatIds.includes(digest.worstFormat.id) ? digest.worstFormat : null;
  const measured24h = Number(digest?.last24h?.measuredPosts) || 0;
  const mutationEligible = recent7d.length >= minSamples;

  if (!mutationEligible) {
    mutations.push({
      type: "wait",
      formatId: null,
      reason: `Need ${minSamples}+ measured posts in the last 7d before mutating weights (have ${recent7d.length}).`,
    });
  }

  if (mutationEligible && best && measured24h > 0 && (best.avgScore || 0) >= baselineScore * 1.05) {
    const before = weights[best.id];
    weights[best.id] = clampFormatWeight(before * 1.18);
    mutations.push({
      type: "promote",
      formatId: best.id,
      from: before,
      to: weights[best.id],
      reason: `24h winner score ${best.avgScore} vs baseline ${Number(baselineScore.toFixed(1))}`,
    });
  }
  if (mutationEligible && worst && worst.id !== best?.id && measured24h > 0 && (worst.avgScore || 0) <= baselineScore * 0.9) {
    const before = weights[worst.id];
    weights[worst.id] = clampFormatWeight(before * 0.85);
    mutations.push({
      type: "hold",
      formatId: worst.id,
      from: before,
      to: weights[worst.id],
      reason: `24h loser score ${worst.avgScore} vs baseline ${Number(baselineScore.toFixed(1))}`,
    });
  }

  const best7d = (digest?.formatRows7d || []).find((row) => formatIds.includes(row.id));
  if (mutationEligible && best7d && best7d.samples >= minSamples && best7d.id !== best?.id && (best7d.avgScore || 0) >= baselineScore * 1.08) {
    const before = weights[best7d.id];
    weights[best7d.id] = clampFormatWeight(before * 1.08);
    mutations.push({
      type: "reinforce",
      formatId: best7d.id,
      from: before,
      to: weights[best7d.id],
      reason: `7d support ${best7d.id}`,
    });
  }

  if (!mutations.length) {
    mutations.push({
      type: measured24h === 0 ? "wait" : "hold_steady",
      formatId: best?.id || null,
      reason: measured24h === 0
        ? "No measured posts in the last 24h; keep current weights."
        : "Last 24h scores are too close to baseline to mutate weights.",
    });
  }

  const preferredExplore = optionalEnv("TWEET_GROWTH_EXPLORE_FORMAT_ID", "brutal_truth");
  const exploreCandidates = formats
    .map((format) => ({
      id: format.id,
      samples: (digest?.formatRows7d || []).find((row) => row.id === format.id)?.samples || 0,
    }))
    .filter((row) => row.id !== best?.id)
    .sort((left, right) => left.samples - right.samples || left.id.localeCompare(right.id));
  const exploreFormatId =
    (formatIds.includes(preferredExplore) && preferredExplore !== best?.id ? preferredExplore : null) ||
    exploreCandidates[0]?.id ||
    null;
  if (mutationEligible && exploreFormatId) {
    const before = weights[exploreFormatId];
    const next = clampFormatWeight(Math.max(before, 0.95));
    if (next !== before) {
      weights[exploreFormatId] = next;
      mutations.push({
        type: "explore",
        formatId: exploreFormatId,
        from: before,
        to: next,
        reason: "Keep one under-sampled format in the pool.",
      });
    }
  }

  const allTimePromoted = formatRows
    .filter((row) => formatIds.includes(row.id) && row.samples >= minSamples && row.avgScore >= baselineScore * 1.08)
    .slice(0, 4);
  const allTimeHold = formatRows
    .filter((row) => formatIds.includes(row.id) && row.samples >= minSamples && row.avgScore <= baselineScore * 0.9)
    .slice(-5);
  const promotedIds = uniqueStrings([
    mutations.some((item) => item.type === "promote") ? best?.id : null,
    best?.id,
    allTimePromoted[0]?.id,
    stack.contentBanditAllocator?.recommendedLane?.id,
    stack.growthOpportunityScorer?.activeOpportunity?.formatId,
    stack.learningAutopilot?.primaryFormat?.id,
    ...(seed.promotedFormats || []).map((row) => row.id),
  ].filter((id) => id && formatIds.includes(id) && id !== worst?.id), 3);
  const holdIds = uniqueStrings([
    mutations.some((item) => item.type === "hold") ? worst?.id : null,
    ...allTimeHold.map((row) => row.id),
    ...(stack.learningAutopilot?.holdFormats || []).map((row) => row.id),
    ...(seed.holdFormats || []).map((row) => row.id),
  ].filter((id) => id && formatIds.includes(id) && !promotedIds.includes(id) && id !== exploreFormatId), 4);

  const losingOpener = blockedOpenerFromHook((digest?.losingHooks || [])[0]);
  const blockedOpeners = [
    ...(seed.blockedOpeners || emptyGrowthStrategy(now).blockedOpeners),
    losingOpener,
  ].filter(Boolean);
  const blockedById = new Map();
  for (const opener of blockedOpeners) {
    if (!opener?.id || blockedById.has(opener.id)) continue;
    blockedById.set(opener.id, opener);
  }

  const confidence =
    records.length >= 80 ? "high" :
      records.length >= 25 ? "medium" :
        records.length >= 8 ? "low" : "cold_start";
  const trajectory =
    recent7d.length >= minSamples && baselineScore > 0
      ? recentScore >= baselineScore * 1.15
        ? "improving"
        : recentScore <= baselineScore * 0.85
          ? "declining"
          : "flat"
      : "insufficient_recent_samples";
  const winningHook = digest?.winningHooks?.[0]?.firstLine || "";
  const strategy = emptyGrowthStrategy(now);

  return {
    ...strategy,
    ...seed,
    version: 2,
    generatedAt: now,
    mode: "self_evolving_daily_traffic",
    status: trajectory,
    confidence,
    baselineScore: Number(baselineScore.toFixed(1)),
    recent7dScore: Number(recentScore.toFixed(1)),
    sampleCount: records.length,
    recentSampleCount: recent7d.length,
    formatWeights: Object.fromEntries(formatIds.map((id) => [id, clampFormatWeight(weights[id])])),
    exploreFormatId,
    dailyDigest: digest || null,
    promotedFormats: promotedIds.map((id) => strategyRowForId(id, "promote", [...(digest?.formatRows24h || []), ...formatRows])),
    holdFormats: holdIds.map((id) => strategyRowForId(id, "hold", [...(digest?.formatRows24h || []), ...formatRows])),
    preferredHashtags,
    languageBias: {
      primary: primaryLanguage?.id || null,
      rows: languageEntries.slice(0, 4),
      promptOnly: true,
      note: "Language mode stays timezone; this bias only shapes hook style in the prompt.",
    },
    repeatedFormulaicRecords,
    blockedOpeners: [...blockedById.values()].slice(0, 8),
    promptDirectives: uniqueStrings([
      ...strategy.promptDirectives,
      measured24h > 0 && best
        ? `Yesterday's traffic winner is ${best.id} (score ${best.avgScore}, ${best.samples} samples). Bias candidates toward it.`
        : null,
      holdIds.length ? `Hold weak formats unless the story has exceptional fit: ${holdIds.join(", ")}.` : null,
      exploreFormatId ? `Keep one controlled exploration slot for ${exploreFormatId}.` : null,
      winningHook ? `Reuse the winning hook shape, not the same sentence: ${winningHook}` : null,
      primaryLanguage?.id
        ? `Language mode is unchanged; when writing ${primaryLanguage.id}, make the first line sharper because that lane currently scores higher.`
        : null,
      preferredHashtags.length ? `Use only high-signal hashtags from this set when tags are enabled: ${preferredHashtags.join(", ")}.` : null,
      trajectory === "declining"
        ? "Recent score is below baseline: make the first line sharper, more specific, and less title-like."
        : null,
    ], 10),
    quality: {
      ...strategy.quality,
      ...(seed.quality || {}),
      blockedFallbackAllowed: false,
      minSpecificity: "company_or_product_plus_consequence",
    },
    evolution: {
      utcDay: digest?.utcDay || utcDayStampFromValue(now),
      frozen: false,
      parentGeneratedAt: seed.generatedAt || null,
      mutations,
    },
    nextAction:
      trajectory === "declining"
        ? "Tighten hook specificity and hold repeated low-reward formats for the next posting cycle."
        : promotedIds[0]
          ? `Exploit ${promotedIds[0]} while keeping one controlled exploration candidate${exploreFormatId ? ` (${exploreFormatId})` : ""}.`
          : "Continue controlled exploration until enough cached outcomes identify a winner.",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
  };
}

function buildSelfEvolvingGrowthStrategy({
  state,
  insights,
  generationStack = null,
  previous = null,
  now = new Date().toISOString(),
} = {}) {
  if (!growthStrategyEnabled()) return null;
  const digest = buildDailyTrafficDigest({ state, insights, now });
  if (shouldFreezeDailyEvolution(previous, now) && previous?.formatWeights) {
    return {
      ...previous,
      dailyDigest: digest,
      evolution: {
        ...(previous.evolution || {}),
        utcDay: previous.evolution?.utcDay || digest.utcDay,
        frozen: true,
        mutations: previous.evolution?.mutations || [],
      },
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
    };
  }
  return evolveGrowthStrategy({ previous, digest, state, insights, generationStack, now });
}

function formatSelfEvolvingGrowthStrategyContext(strategy) {
  if (!strategy) return "";
  const promoted = (strategy.promotedFormats || []).map((row) => row.id).filter(Boolean).join(", ");
  const hold = (strategy.holdFormats || []).map((row) => row.id).filter(Boolean).join(", ");
  const tags = (strategy.preferredHashtags || []).join(", ");
  const digest = strategy.dailyDigest;
  const mutations = (strategy.evolution?.mutations || [])
    .slice(0, 6)
    .map((item) => `${item.type}${item.formatId ? `:${item.formatId}` : ""}`)
    .join(", ");
  const weights = Object.entries(strategy.formatWeights || {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([id, weight]) => `${id}=${weight}`)
    .join(", ");
  return [
    "CODEX SELF-EVOLVING GROWTH STRATEGY (daily traffic mutations, 0 extra X reads)",
    `mode: ${strategy.mode || "unknown"}; status: ${strategy.status || "unknown"}; confidence: ${strategy.confidence || "low"}; samples: ${formatNumber(strategy.sampleCount)}; utc_day: ${strategy.evolution?.utcDay || digest?.utcDay || "-"}`,
    digest
      ? `daily_digest_24h: posts=${formatNumber(digest.last24h?.posts)} measured=${formatNumber(digest.last24h?.measuredPosts)} impressions=${formatNumber(digest.last24h?.impressions)} likes=${formatNumber(digest.last24h?.likes)} replies=${formatNumber(digest.last24h?.replies)}`
      : null,
    digest?.bestFormat ? `best_format_24h: ${digest.bestFormat.id} score=${digest.bestFormat.avgScore}` : null,
    digest?.worstFormat ? `worst_format_24h: ${digest.worstFormat.id} score=${digest.worstFormat.avgScore}` : null,
    promoted ? `promote_formats: ${promoted}` : null,
    hold ? `hold_formats: ${hold}` : null,
    strategy.exploreFormatId ? `explore_format: ${strategy.exploreFormatId}` : null,
    weights ? `format_weights: ${weights}` : null,
    mutations ? `mutations: ${mutations}` : null,
    tags ? `preferred_hashtags: ${tags}` : null,
    "MUST FOLLOW:",
    ...(strategy.promptDirectives || []).slice(0, 8).map((directive) => `- ${directive}`),
  ].filter(Boolean).join("\n");
}

function scoreSelfEvolvingStrategyCompliance(candidate, { growthStrategy = null, story = null } = {}) {
  if (!growthStrategy) return { delta: 0, reasons: [] };
  const reasons = [];
  let delta = 0;
  const templateId = candidate?.templateId || "";
  const promoted = new Set((growthStrategy.promotedFormats || []).map((row) => row.id).filter(Boolean));
  const hold = new Set((growthStrategy.holdFormats || []).map((row) => row.id).filter(Boolean));
  if (promoted.has(templateId)) {
    delta += 8;
    reasons.push("self-evolving promote");
  }
  if (hold.has(templateId)) {
    delta -= 14;
    reasons.push("self-evolving hold");
  }
  const text = candidate?.text || "";
  for (const opener of growthStrategy.blockedOpeners || []) {
    try {
      if (new RegExp(opener.pattern, "i").test(text)) {
        delta -= 30;
        reasons.push(`self-evolving blocked opener:${opener.id || "pattern"}`);
      }
    } catch {
      // Ignore malformed persisted patterns rather than breaking posting.
    }
  }
  const headlineBlock = Number(growthStrategy.quality?.headlineSimilarityBlock) || 0.62;
  if (headlineFrameSimilarity(text, story) >= headlineBlock) {
    delta -= 24;
    reasons.push("self-evolving headline block");
  }
  const preferredTags = new Set((growthStrategy.preferredHashtags || []).map((tag) => String(tag).toLowerCase()));
  const tags = extractHashtags(text).map((tag) => canonicalHashtag(tag) || tag);
  if (tags.some((tag) => preferredTags.has(String(tag).toLowerCase()))) {
    delta += 3;
    reasons.push("self-evolving tag match");
  }
  if (tags.some((tag) => /^(tech|technews|technology)$/i.test(tag))) {
    delta -= 6;
    reasons.push("self-evolving generic tag");
  }
  return { delta, reasons };
}

function qualityIssuesFromGrowthStrategy(text, story, growthStrategy) {
  const issues = [];
  if (!growthStrategy) return issues;
  for (const opener of growthStrategy.blockedOpeners || []) {
    try {
      if (new RegExp(opener.pattern, "i").test(text)) {
        issues.push({ severity: "block", reason: `strategy_blocked_opener:${opener.id || "pattern"}` });
      }
    } catch {
      // Persisted strategy is defensive; bad patterns should not break the run.
    }
  }
  const headlineBlock = Number(growthStrategy.quality?.headlineSimilarityBlock) || 0.62;
  const headlineWarn = Number(growthStrategy.quality?.headlineSimilarityWarn) || 0.45;
  const similarity = headlineFrameSimilarity(text, story);
  if (similarity >= headlineBlock) {
    issues.push({ severity: "block", reason: "strategy_headline_similarity" });
  } else if (similarity >= headlineWarn) {
    issues.push({ severity: "warn", reason: "strategy_headline_similarity_risk" });
  }
  return issues;
}

function growthStrategyReport(strategy) {
  if (!strategy) return "### Self-Evolving Growth Strategy\n\n_Disabled._";
  const digest = strategy.dailyDigest;
  const mutations = strategy.evolution?.mutations || [];
  const weights = Object.entries(strategy.formatWeights || {})
    .sort((left, right) => right[1] - left[1])
    .map(([id, weight]) => `${id}=${weight}`)
    .join(", ");
  const rows = [
    ["Mode", strategy.mode || "-"],
    ["Status", strategy.status || "-"],
    ["Confidence", strategy.confidence || "-"],
    ["UTC day", strategy.evolution?.utcDay || digest?.utcDay || "-"],
    ["Frozen", strategy.evolution?.frozen ? "yes (hourly digest only)" : "no"],
    ["Samples", `${formatNumber(strategy.sampleCount)} measured · ${formatNumber(strategy.recentSampleCount)} recent`],
    ["24h traffic", digest
      ? `${formatNumber(digest.last24h?.posts)} posts · ${formatNumber(digest.last24h?.impressions)} impressions · ${formatNumber(digest.last24h?.likes)} likes`
      : "-"],
    ["Next action", strategy.nextAction || "-"],
  ];
  return [
    "### Self-Evolving Growth Strategy",
    "",
    "_Daily traffic mutations from cached analytics. Hourly dashboard_only refreshes the digest without changing weights. X reads: 0._",
    "",
    "| Field | Value |",
    "|---|---|",
    ...rows.map(([key, value]) => `| ${markdownCell(key)} | ${markdownCell(value)} |`),
    "",
    strategy.promotedFormats?.length ? `Promote: ${strategy.promotedFormats.map((row) => `${row.id}(${formatNumber(row.avgScore, 1)})`).join(", ")}` : "Promote: collecting samples.",
    strategy.holdFormats?.length ? `Hold: ${strategy.holdFormats.map((row) => row.id).join(", ")}` : "Hold: none.",
    strategy.exploreFormatId ? `Explore: ${strategy.exploreFormatId}` : null,
    weights ? `Weights: ${weights}` : null,
    strategy.preferredHashtags?.length ? `Hashtags: ${strategy.preferredHashtags.join(", ")}` : null,
    mutations.length
      ? `Mutations: ${mutations.map((item) => item.formatId ? `${item.type}:${item.formatId}` : item.type).join(", ")}`
      : null,
    "",
    "Directives:",
    ...(strategy.promptDirectives || []).slice(0, 8).map((directive) => `- ${directive}`),
  ].filter((line) => line != null).join("\n");
}

function performanceLift(bucket, insights, maxLift = 0.45) {
  if (!bucket || bucket.count < insights.minSamples || insights.baselineScore <= 0) return 0;
  const lift = (bucket.avgScore - insights.baselineScore) / Math.max(1, insights.baselineScore);
  return Math.max(-0.3, Math.min(maxLift, lift));
}

function audienceExpansionEnabled() {
  return isTruthy(optionalEnv("TWEET_AUDIENCE_EXPANSION_ENABLED", "true"));
}

function audienceSegmentShare(bucket, sampleCount) {
  return sampleCount > 0 ? (Number(bucket?.count) || 0) / sampleCount : 0;
}

function audienceLiftForSegment(segment, insights = {}) {
  if (!audienceExpansionEnabled()) return 0;
  const minSamples = integerEnv("TWEET_AUDIENCE_MIN_SAMPLES", 2, 1, 50);
  const explorationBoost = numberEnv("TWEET_AUDIENCE_EXPLORATION_BOOST", 0.08, 0, 0.5);
  const bucket = insights?.audienceSegments?.[segment.id];
  const sampleCount = Math.max(1, Number(insights?.records?.length) || 0);
  const share = audienceSegmentShare(bucket, sampleCount);
  const targetShare = Number(segment.targetShare) || 0;
  const underTarget = targetShare > 0 && share < targetShare * 0.65;
  const measuredLift = performanceLift(bucket, insights || { minSamples, baselineScore: 0 }, 0.34);
  const sampleBoost = !bucket || bucket.count < minSamples ? explorationBoost * (segment.broadness || 1) : 0;
  const balanceBoost = underTarget ? explorationBoost * 0.75 : 0;
  return Math.max(-0.25, Math.min(0.42, measuredLift + sampleBoost + balanceBoost));
}

function audienceExpansionLift(item, insights = {}) {
  const segment = primaryAudienceSegment(item);
  return audienceLiftForSegment(segment, insights);
}

function buildAudienceExpansionRouter({ insights = {}, now = null } = {}) {
  const enabled = audienceExpansionEnabled();
  const minSamples = integerEnv("TWEET_AUDIENCE_MIN_SAMPLES", 2, 1, 50);
  const sampleCount = Math.max(0, Number(insights?.records?.length) || 0);
  const baseline = Number(insights?.baselineScore) || 0;
  const segments = audienceSegmentDefinitions().map((definition) => {
    const bucket = insights?.audienceSegments?.[definition.id] || null;
    const samples = Number(bucket?.count) || 0;
    const avgScore = Number(bucket?.avgScore) || 0;
    const share = audienceSegmentShare(bucket, Math.max(1, sampleCount));
    const lift = baseline > 0 && samples >= minSamples ? (avgScore - baseline) / baseline : 0;
    const audienceLift = audienceLiftForSegment(definition, insights);
    const belowTarget = definition.targetShare > 0 && share < definition.targetShare * 0.65;
    const score = Math.max(
      0,
      (avgScore || baseline || 1) * (1 + audienceLift) +
        (belowTarget ? 1.2 : 0) +
        (definition.broadness || 1) * 0.35,
    );
    let action = "probe";
    if (!enabled) action = "disabled";
    else if (samples >= minSamples && lift > 0.12) action = "exploit";
    else if (belowTarget) action = "expand";
    else if (samples >= minSamples && lift < -0.18) action = "hold";

    return {
      id: definition.id,
      label: definition.label,
      action,
      score: Number(score.toFixed(2)),
      avgScore: Number(avgScore.toFixed(2)),
      samples,
      sharePct: Number((share * 100).toFixed(1)),
      targetSharePct: Number(((definition.targetShare || 0) * 100).toFixed(1)),
      liftPct: samples >= minSamples && baseline > 0 ? Number((lift * 100).toFixed(1)) : null,
      audienceLiftPct: Number((audienceLift * 100).toFixed(1)),
      directive: definition.directive,
      reason: belowTarget
        ? `Below target share (${Number((share * 100).toFixed(1))}% / ${Number(((definition.targetShare || 0) * 100).toFixed(1))}%).`
        : samples >= minSamples
          ? `Measured avg ${formatNumber(avgScore, 1)} from ${samples} posts.`
          : `Needs ${minSamples}+ measured posts; use controlled exploration.`,
    };
  });

  const ranked = segments.sort((left, right) => {
    const priority = { exploit: 3, expand: 2, probe: 1, hold: 0, disabled: -1 };
    const delta = (priority[right.action] ?? 0) - (priority[left.action] ?? 0);
    if (delta) return delta;
    return right.score - left.score;
  });
  const primary = ranked.find((segment) => segment.action !== "hold" && segment.action !== "disabled") || ranked[0] || null;
  return {
    enabled,
    generatedAt: now || new Date().toISOString(),
    zeroExtraXReads: true,
    source: "cached tweet analytics + RSS classifier",
    mode: enabled ? "wide_tech_router" : "disabled",
    confidence: sampleCount >= 30 ? "high" : sampleCount >= 8 ? "medium" : "low",
    sampleCount,
    baselineScore: Number(baseline.toFixed(2)),
    primarySegment: primary,
    segments: ranked,
    promptDirectives: ranked
      .filter((segment) => ["exploit", "expand", "probe"].includes(segment.action))
      .slice(0, 4)
      .map((segment) => `${segment.action.toUpperCase()} ${segment.label}: ${segment.directive}`),
    nextAction: primary
      ? `${primary.action} ${primary.label}: ${primary.directive}`
      : "Keep broad technology coverage until enough audience telemetry exists.",
  };
}

function formatAudienceExpansionContext(router) {
  if (!router?.segments?.length) return "Audience expansion router: no segment data yet.";
  const rows = router.segments
    .slice(0, 4)
    .map((segment) =>
      `${segment.label}: action=${segment.action}, avg=${formatNumber(segment.avgScore, 1)}, n=${segment.samples}, share=${formatNumber(segment.sharePct, 1)}%, lift=${formatNumber(segment.audienceLiftPct, 1)}%`,
    );
  return [
    `Audience expansion router (${router.mode}, ${router.confidence}, 0 extra X reads): ${router.nextAction}`,
    `Audience segments: ${rows.join("; ")}`,
    ...(router.promptDirectives || []).slice(0, 3),
  ].join("\n");
}

const HOOK_PATTERN_LIBRARY = [
  {
    id: "decision_rule",
    label: "Decision Rule",
    statusBias: 1.15,
    detector: /\b(if|when|rule|playbook|checklist|should|must|default|standard|decision)\b|判断标准|如果|当.*就|先看|该做|别急/i,
    directive: "Open with a rule the reader can apply today.",
    nextHook: "If the default changes, the winner is not the loudest feature. It is the team that owns the new route.",
  },
  {
    id: "contrast_reframe",
    label: "Contrast Reframe",
    statusBias: 1.12,
    detector: /not .+ but |isn['’]?t .+ it['’]?s |instead of|不是.+而是|与其.+不如|真正的/i,
    directive: "Start with a clean not-X-but-Y reframe.",
    nextHook: "The story is not the launch. The story is who loses distribution when this becomes the default.",
  },
  {
    id: "operator_pain",
    label: "Operator Pain",
    statusBias: 1.08,
    detector: /\b(teams?|developers?|operators?|engineers?|platform teams?|workflow|rollback|permissions?|evals?|logs?|incident|migration)\b|团队|开发者|工程师|迁移|权限|回滚|工作流/i,
    directive: "Translate the news into a concrete workflow tax for builders or operators.",
    nextHook: "Every model jump creates a second job: retune prompts, evals, permissions, and rollback before anyone ships faster.",
  },
  {
    id: "cost_tradeoff",
    label: "Cost Tradeoff",
    statusBias: 1.06,
    detector: /\b(hidden cost|cost|budget|tradeoff|risk|margin|pricing|lock-?in|churn|tax|support burden)\b|成本|代价|预算|风险|锁定|取舍/i,
    directive: "Lead with the hidden cost, budget tradeoff, or margin transfer.",
    nextHook: "The hidden cost is not the subscription. It is the migration work every team has to redo before the gain shows up.",
  },
  {
    id: "prediction",
    label: "Near-Term Prediction",
    statusBias: 1,
    detector: /\b(will|next|becomes|turns into|default|standard|within|2026|2027|months?)\b|接下来|未来|会变成|默认|标配|半年|一年/i,
    directive: "Make a concrete near-term prediction tied to a platform or user behavior.",
    nextHook: "The next shift is boring but brutal: this moves from feature to default, then everyone else pays the distribution tax.",
  },
  {
    id: "sharp_question",
    label: "Sharp Question",
    statusBias: 0.96,
    detector: /[?？]|\b(real question|what changes|who pays|who owns|worth it)\b|真正的问题|谁来买单/i,
    directive: "Use one debate-worthy question only when it creates replies.",
    nextHook: "The real question is not whether the tool works. It is who owns the failure path when it does.",
  },
  {
    id: "entity_led",
    label: "Entity-Led",
    statusBias: 0.92,
    detector: /\b(OpenAI|Anthropic|Claude|Gemini|Google|Apple|Microsoft|Meta|Amazon|Nvidia|GitHub|Cursor|Vercel|Cloudflare|Tesla|TikTok|YouTube)\b/i,
    directive: "Name the company or product in the first line, then make a non-obvious claim.",
    nextHook: "OpenAI is not just shipping a model here. It is moving the workflow boundary closer to the operating system.",
  },
  {
    id: "weak_recap",
    label: "Weak News Recap",
    statusBias: 0.35,
    hold: true,
    detector: /^(today|according to|breaking|news|reportedly|new:|近日|据报道|消息|新闻)\b|值得关注|不容错过|重磅|exciting news/i,
    directive: "Do not recap the headline. Replace it with a take, rule, or tradeoff.",
    nextHook: "Skip the recap. Start with the consequence.",
  },
];

function firstTweetLine(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line && !/^#[\p{L}\p{N}_]+/u.test(line)) || "";
}

function classifyHookPattern(text) {
  const firstLine = firstTweetLine(text);
  const haystack = `${firstLine} ${String(text || "")}`.trim();
  const matches = HOOK_PATTERN_LIBRARY.filter((pattern) => pattern.detector.test(haystack));
  const weak = matches.find((pattern) => pattern.hold && pattern.detector.test(firstLine));
  const selected = weak || matches.find((pattern) => !pattern.hold) || HOOK_PATTERN_LIBRARY.find((pattern) => pattern.id === "entity_led");
  const ids = matches.length ? matches.map((pattern) => pattern.id) : [selected.id];
  return {
    primaryId: selected.id,
    primaryLabel: selected.label,
    patternIds: [...new Set(ids)],
    firstLine,
  };
}

function addHookBucketSample(bucket, record, pattern, classification) {
  const score = recordGrowthScore(record);
  bucket.count += 1;
  bucket.totalScore += score;
  bucket.avgScore = bucket.totalScore / bucket.count;
  const example = {
    text: classification.firstLine || firstTweetLine(record.text),
    score: Number(score.toFixed(1)),
    url: record.url || xTweetUrl(record.id),
    postedAt: record.postedAt || null,
  };
  bucket.examples = [...bucket.examples, example]
    .filter((item) => item.text)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
  if (classification.primaryId === pattern.id) bucket.primaryCount += 1;
}

function buildHookPatternReactor({ insights = {}, now = null } = {}) {
  const records = Array.isArray(insights?.records) ? insights.records.filter((record) => record?.text) : [];
  const sampleCount = records.length;
  const minSamples = Math.max(2, Math.min(Number(insights?.minSamples) || 2, 5));
  const baseline = Number(insights?.baselineScore) || 0;
  const buckets = Object.fromEntries(
    HOOK_PATTERN_LIBRARY.map((pattern) => [
      pattern.id,
      {
        id: pattern.id,
        label: pattern.label,
        count: 0,
        primaryCount: 0,
        totalScore: 0,
        avgScore: 0,
        examples: [],
      },
    ]),
  );

  for (const record of records) {
    const classification = classifyHookPattern(record.text);
    for (const id of classification.patternIds) {
      const pattern = HOOK_PATTERN_LIBRARY.find((item) => item.id === id);
      if (!pattern || !buckets[id]) continue;
      addHookBucketSample(buckets[id], record, pattern, classification);
    }
  }

  const patterns = HOOK_PATTERN_LIBRARY.map((pattern) => {
    const bucket = buckets[pattern.id];
    const lift = baseline > 0 && bucket.count >= minSamples ? (bucket.avgScore - baseline) / baseline : 0;
    const exploration = bucket.count < minSamples && !pattern.hold ? 0.75 : 0;
    const holdPenalty = pattern.hold ? 8 : 0;
    const score = Math.max(0, (bucket.avgScore || baseline || 1) * pattern.statusBias + exploration - holdPenalty);
    let status = "probe";
    if (pattern.hold) status = "hold";
    else if (bucket.count >= minSamples && lift > 0.12) status = "exploit";
    else if (bucket.count >= minSamples && lift < -0.16) status = "hold";
    return {
      id: pattern.id,
      label: pattern.label,
      status,
      score: Number(score.toFixed(2)),
      avgScore: Number(bucket.avgScore.toFixed(2)),
      samples: bucket.count,
      primarySamples: bucket.primaryCount,
      liftPct: bucket.count >= minSamples && baseline > 0 ? Number((lift * 100).toFixed(1)) : null,
      directive: pattern.directive,
      nextHook: pattern.nextHook,
      examples: bucket.examples,
      reason: bucket.count >= minSamples
        ? `Measured avg ${formatNumber(bucket.avgScore, 1)} from ${bucket.count} posts.`
        : `Needs ${minSamples}+ measured posts; use controlled exploration.`,
    };
  }).sort((left, right) => {
    const priority = { exploit: 3, probe: 2, hold: 0 };
    const delta = (priority[right.status] ?? 0) - (priority[left.status] ?? 0);
    if (delta) return delta;
    return right.score - left.score;
  });

  const recommendedPattern =
    patterns.find((pattern) => pattern.status === "exploit") ||
    patterns.find((pattern) => pattern.status === "probe" && pattern.id !== "weak_recap") ||
    patterns.find((pattern) => pattern.id === "decision_rule") ||
    null;
  const avoidPatterns = patterns
    .filter((pattern) => pattern.status === "hold" || pattern.id === "weak_recap")
    .slice(0, 3);
  const promptPatch = recommendedPattern
    ? [
        `First line hook pattern: ${recommendedPattern.label}.`,
        recommendedPattern.directive,
        `Example shape: ${recommendedPattern.nextHook}`,
        avoidPatterns.length ? `Avoid: ${avoidPatterns.map((pattern) => pattern.label).join(", ")}.` : null,
      ].filter(Boolean).join(" ")
    : "Use a concrete decision rule or hidden cost hook in the first line.";

  return {
    generatedAt: now || new Date().toISOString(),
    mode: "cached_hook_pattern_reactor",
    zeroExtraXReads: true,
    source: "cached tweet analytics first-line classifier",
    confidence: sampleCount >= 40 ? "high" : sampleCount >= 12 ? "medium" : "low",
    sampleCount,
    baselineScore: Number(baseline.toFixed(2)),
    recommendedPattern,
    avoidPatterns,
    patterns,
    promptPatch,
    nextAction: recommendedPattern
      ? `Apply ${recommendedPattern.label}: ${recommendedPattern.directive}`
      : "Collect more measured posts, then bias first-line hooks.",
    guardrails: [
      "Do not open with a news recap.",
      "Do not copy the headline structure.",
      "First line must create a rule, tradeoff, or reframe.",
      "This reactor uses cached analytics only; it adds 0 X reads.",
    ],
  };
}

function formatHookPatternReactorContext(reactor) {
  if (!reactor?.patterns?.length) return "Hook pattern reactor: unavailable.";
  const rows = reactor.patterns
    .slice(0, 5)
    .map((pattern) =>
      `${pattern.label}: status=${pattern.status}, avg=${formatNumber(pattern.avgScore, 1)}, n=${pattern.samples}, lift=${pattern.liftPct == null ? "na" : `${formatNumber(pattern.liftPct, 1)}%`}`,
    );
  return [
    `Hook pattern reactor (${reactor.mode}, ${reactor.confidence}, 0 extra X reads): ${reactor.nextAction}`,
    `MUST apply first-line prompt patch: ${reactor.promptPatch}`,
    `Hook telemetry: ${rows.join("; ")}`,
    reactor.avoidPatterns?.length
      ? `Avoid hook patterns: ${reactor.avoidPatterns.map((pattern) => pattern.label).join(", ")}`
      : null,
  ].filter(Boolean).join("\n");
}

function buildContentBanditAllocator({ insights = {}, hookPatternReactor = null, now = null } = {}) {
  const formats = configuredContentFormats();
  const rows = experimentFormatRows(insights || { templates: {}, minSamples: 2, baselineScore: 0 });
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const sampleCount = Array.isArray(insights?.records) ? insights.records.length : 0;
  const baseline = Number(insights?.baselineScore) || 0;
  const minSamples = Math.max(1, Number(insights?.minSamples) || 1);
  const totalSamples = Math.max(1, rows.reduce((sum, row) => sum + (Number(row.samples) || 0), 0));
  const exploreFloor = numberEnv("TWEET_BANDIT_EXPLORE_FLOOR", 0.16, 0, 0.5);
  const confidence = sampleCount >= 60 ? "high" : sampleCount >= 16 ? "medium" : "low";
  const recommendedHook = hookPatternReactor?.recommendedPattern?.label || "first-line fire-control";
  const rewardSignals = banditRewardSignals(insights);
  const rewardById = new Map(rewardSignals.rows.map((row) => [row.id, row]));

  const rawLanes = formats.map((format, index) => {
    const row = rowById.get(format.id) || { id: format.id, label: format.label, action: "explore", avgScore: 0, samples: 0, lift: 0 };
    const reward = rewardById.get(format.id) || null;
    const samples = Number(row.samples) || 0;
    const avgScore = Number(row.avgScore) || 0;
    const observedMean = avgScore || baseline || 1;
    const liftPct = baseline > 0 && samples >= minSamples ? ((observedMean - baseline) / baseline) * 100 : null;
    const uncertainty = Math.sqrt(Math.log(totalSamples + 1) / (samples + 1));
    const explorationScore = uncertainty * 18 + (samples < minSamples ? 10 : 0);
    const exploitScore = observedMean * 9 + Math.max(0, Number(row.lift) || 0) * 70;
    const rewardMomentum = reward?.recentSamples >= minSamples && reward.recentAvgReward > Math.max(baseline, reward.avgReward)
      ? Math.min(12, (reward.recentAvgReward - Math.max(baseline, reward.avgReward)) * 4)
      : 0;
    const regretPenalty = reward?.recentSamples >= minSamples
      ? Math.min(16, Number(reward.recentRegret || reward.regret || 0) * 3)
      : 0;
    const actionBias = { exploit: 22, test: 11, explore: 16, hold: -35 }[row.action] ?? 0;
    const recencyJitter = ((Math.trunc(Date.now() / (60 * 60 * 1000)) + index) % formats.length) / formats.length;
    const allocationScore = Math.max(0, exploitScore + explorationScore + rewardMomentum + actionBias + recencyJitter - regretPenalty - index * 0.02);
    const laneStatus =
      row.action === "hold"
        ? "hold"
        : samples < minSamples
          ? "explore"
          : allocationScore >= (baseline || 1) * 9 + 26
            ? "exploit"
            : "test";
    return {
      id: format.id,
      label: format.label,
      status: laneStatus,
      action: row.action || "explore",
      allocationScore: Number(allocationScore.toFixed(2)),
      avgScore: Number(observedMean.toFixed(2)),
      samples,
      liftPct: liftPct == null ? null : Number(liftPct.toFixed(1)),
      uncertainty: Number(uncertainty.toFixed(3)),
      explorationScore: Number(explorationScore.toFixed(2)),
      exploitScore: Number(exploitScore.toFixed(2)),
      rewardMomentum: Number(rewardMomentum.toFixed(2)),
      regretPenalty: Number(regretPenalty.toFixed(2)),
      instruction: format.instruction,
      nextAction:
        laneStatus === "exploit"
          ? `Exploit ${format.label} with ${recommendedHook}.`
          : laneStatus === "explore"
            ? `Collect more samples for ${format.label}; keep first line concrete.`
            : laneStatus === "hold"
              ? `Hold ${format.label} unless story-fit is unusually strong.`
              : `Keep ${format.label} in controlled rotation.`,
      reason: row.reason || "Ranked by cached UCB-style allocator.",
    };
  });

  const ranked = rawLanes.sort((left, right) => {
    const priority = { exploit: 3, explore: 2, test: 1, hold: 0 };
    const delta = (priority[right.status] ?? 0) - (priority[left.status] ?? 0);
    if (delta) return delta;
    return right.allocationScore - left.allocationScore;
  });
  const active = ranked.filter((lane) => lane.status !== "hold");
  const totalScore = Math.max(1, active.reduce((sum, lane) => sum + lane.allocationScore, 0));
  const lanes = ranked.map((lane, index) => {
    const rawPct = lane.status === "hold" ? 0 : (lane.allocationScore / totalScore) * (100 - exploreFloor * 100);
    const allocationPct = lane.status === "explore" ? Math.max(exploreFloor * 100 / Math.max(1, active.length), rawPct) : rawPct;
    return {
      ...lane,
      rank: index + 1,
      allocationPct: Number(Math.max(0, Math.min(100, allocationPct)).toFixed(1)),
    };
  });
  const rankedFormatIds = lanes
    .filter((lane) => lane.status !== "hold")
    .sort((left, right) => right.allocationScore - left.allocationScore)
    .map((lane) => lane.id);
  const recommendedLane = lanes.find((lane) => lane.status === "exploit") || lanes.find((lane) => lane.status !== "hold") || lanes[0] || null;
  const exploreLane = lanes.find((lane) => lane.status === "explore") || lanes.find((lane) => lane.action === "explore") || null;
  const promptPatch = [
    "CODEX CONTENT BANDIT PATCH",
    "mode: cached_ucb_allocator",
    "zero_extra_x_reads: true",
    `confidence: ${confidence}`,
    `primary_format: ${recommendedLane?.id || "-"}`,
    exploreLane ? `exploration_lane: ${exploreLane.id}` : null,
    `hook_bias: ${recommendedHook}`,
    "Rule: prefer primary_format unless the selected story strongly fits the exploration_lane.",
  ].filter(Boolean).join("\n");

  return {
    generatedAt: now || new Date().toISOString(),
    mode: "cached_ucb_content_bandit",
    zeroExtraXReads: true,
    source: "cached tweet analytics template buckets",
    confidence,
    sampleCount,
    baselineScore: Number(baseline.toFixed(2)),
    exploreFloorPct: Number((exploreFloor * 100).toFixed(1)),
    recommendedLane,
    exploreLane,
    rankedFormatIds,
    lanes,
    promptPatch,
    nextAction: recommendedLane
      ? `Allocate next candidates toward ${recommendedLane.label}; reserve ${exploreLane?.label || "one controlled exploration lane"} for sample growth.`
      : "Collect more measured posts before trusting the bandit allocator.",
    guardrails: [
      "Uses cached analytics only; 0 X read ops.",
      "Fixed TWEET_CONTENT_FORMAT_ID still overrides allocator.",
      "Hold lanes can only be used when story-fit is unusually strong.",
      "Keep at least one exploration route while sample confidence is low.",
    ],
  };
}

function compactLearningContractArm(lane = null, fallback = null) {
  const source = lane || fallback || null;
  if (!source) return null;
  const id = source.id || source.formatId || source.primaryFormatId || source.name || "";
  return {
    id,
    label: source.label || source.formatLabel || compactBucketName(id || "unknown"),
    status: source.status || source.action || "watch",
    allocationPct: source.allocationPct == null ? null : Number(Number(source.allocationPct).toFixed(1)),
    avgScore: source.avgScore == null ? null : Number(Number(source.avgScore).toFixed(1)),
    samples: Number(source.samples) || 0,
    liftPct: source.liftPct == null ? null : Number(Number(source.liftPct).toFixed(1)),
    uncertainty: source.uncertainty == null ? null : Number(Number(source.uncertainty).toFixed(3)),
    nextAction: source.nextAction || source.directive || source.reason || "",
  };
}

function buildLearningLoopContract({
  insights = {},
  learningAutopilot = null,
  contentBanditAllocator = null,
  contentBanditSettlement = null,
  growthOpportunityScorer = null,
  cachedGenerationPolicy = null,
  generationDecisionTrace = null,
  now = new Date().toISOString(),
} = {}) {
  const autopilot = learningAutopilot || {};
  const bandit = contentBanditAllocator || {};
  const settlement = contentBanditSettlement || {};
  const policy = cachedGenerationPolicy || {};
  const trace = generationDecisionTrace || {};
  const lanes = Array.isArray(bandit.lanes) ? bandit.lanes : [];
  const primaryArm = compactLearningContractArm(
    bandit.recommendedLane || lanes.find((lane) => lane.status === "exploit") || null,
    autopilot.primaryFormat || (autopilot.exploitFormats || [])[0] || (autopilot.testFormats || [])[0] || {
      id: policy.primaryFormatId,
      label: policy.primaryFormatLabel,
      status: "policy",
    },
  );
  const exploreArm = compactLearningContractArm(
    bandit.exploreLane || lanes.find((lane) => lane.status === "explore") || null,
    (autopilot.exploreFormats || [])[0] || { id: policy.exploreFormatId, status: "explore" },
  );
  const holdArms = [
    ...lanes.filter((lane) => lane.status === "hold").map((lane) => compactLearningContractArm(lane)).filter(Boolean),
    ...(autopilot.holdFormats || []).map((row) => compactLearningContractArm(row)).filter(Boolean),
  ].filter((arm, index, list) => arm.id && list.findIndex((item) => item.id === arm.id) === index).slice(0, 4);
  const sampleCount = Number(bandit.sampleCount ?? autopilot.sampleCount ?? insights?.records?.length ?? 0) || 0;
  const confidence = policy.confidence || bandit.confidence || autopilot.confidence || "low";
  const activeOpportunity = growthOpportunityScorer?.activeOpportunity || null;
  const selectedCandidate =
    trace.selectedCandidate ||
    (Array.isArray(trace.candidates) ? trace.candidates.find((candidate) => candidate?.selected) : null) ||
    null;
  const selectedTrace = {
    templateId: trace.selectedTemplateId || selectedCandidate?.templateId || null,
    score: trace.selectedScore ?? selectedCandidate?.score ?? null,
    policyScore: selectedCandidate?.cachedGenerationPolicyScore ?? null,
    banditScore: selectedCandidate?.contentBanditScore ?? null,
    source: selectedCandidate?.generationSource || trace.localFallback?.mode || "cached_policy",
  };
  const rankedFormatIds = uniqueStrings([
    policy.primaryFormatId,
    ...(policy.rankedFormatIds || []),
    ...(bandit.rankedFormatIds || []),
  ], 8);
  const avoidFormatIds = uniqueStrings([
    ...(policy.avoidFormatIds || []),
    ...holdArms.map((arm) => arm.id),
  ], 8);
  const status = sampleCount >= 16 ? "online" : sampleCount > 0 ? "warming" : "cold_start";
  const nextAction =
    activeOpportunity?.directive ||
    growthOpportunityScorer?.primaryCommand ||
    bandit.nextAction ||
    policy.directives?.[0] ||
    "Collect more measured packets before increasing allocator confidence.";
  const primaryValue = primaryArm?.id || policy.primaryFormatId || "-";
  const policyValue = policy.primaryFormatId || primaryArm?.id || "-";

  return {
    generatedAt: now,
    mode: "cached_learning_contract",
    status,
    confidence,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    source: "cached analytics, bandit allocator, generation trace",
    sampleCount,
    baselineScore: Number(Number(insights?.baselineScore ?? autopilot.baselineScore ?? bandit.baselineScore ?? 0).toFixed(1)),
    primaryArm,
    exploreArm,
    holdArms,
    activeOpportunity: activeOpportunity
      ? {
          id: activeOpportunity.id || null,
          label: activeOpportunity.label || null,
          score: activeOpportunity.score == null ? null : Number(Number(activeOpportunity.score).toFixed(1)),
          status: activeOpportunity.status || activeOpportunity.severity || "watch",
          directive: activeOpportunity.directive || activeOpportunity.reason || "",
        }
      : null,
    settlement: {
      mode: settlement.mode || null,
      status: settlement.status || null,
      sampleCount: Number(settlement.sampleCount ?? settlement.totalSamples ?? sampleCount) || sampleCount,
      winnerArmId: settlement.winnerArm?.id || settlement.primaryArm?.id || primaryArm?.id || null,
    },
    selectedTrace,
    policy: {
      mode: policy.mode || "cached_generation_policy",
      confidence,
      primaryFormatId: policy.primaryFormatId || primaryArm?.id || null,
      primaryFormatLabel: policy.primaryFormatLabel || primaryArm?.label || null,
      exploreFormatId: policy.exploreFormatId || exploreArm?.id || null,
      rankedFormatIds,
      avoidFormatIds,
      promptBias: (policy.directives || []).filter(Boolean).slice(0, 4),
      promptBlock: policy.promptBlock || bandit.promptPatch || null,
      zeroExtraXReads: true,
    },
    cells: [
      { id: "sample_ledger", label: "SAMPLE_LEDGER", value: sampleCount, status: sampleCount > 0 ? "ok" : "warn", detail: `${formatNumber(sampleCount)} cached packets` },
      { id: "primary_arm", label: "PRIMARY_ARM", value: primaryValue, status: primaryArm?.status === "hold" ? "warn" : "ok", detail: primaryArm?.label || "-" },
      { id: "read_gate", label: "READ_GATE", value: "0 X reads", status: "ok", detail: "cached-only learning bus" },
      { id: "policy_patch", label: "POLICY_PATCH", value: policyValue, status: policyValue === "-" ? "warn" : "ok", detail: confidence },
    ],
    nextAction,
    guardrails: [
      "Cached analytics only; 0 X search/read ops.",
      "No auto-replies, no scraping, no rate-limit bypass.",
      "Manual route work stays human-reviewed.",
      "Cost gates and cadence holds override allocator pressure.",
    ],
  };
}

function formatContentBanditAllocatorContext(allocator) {
  if (!allocator?.lanes?.length) return "Content bandit allocator: unavailable.";
  const rows = allocator.lanes
    .slice(0, 5)
    .map((lane) =>
      `${lane.label}: status=${lane.status}, alloc=${formatNumber(lane.allocationPct, 1)}%, avg=${formatNumber(lane.avgScore, 1)}, n=${lane.samples}, u=${formatNumber(lane.uncertainty, 2)}`,
    );
  return [
    `Content bandit allocator (${allocator.mode}, ${allocator.confidence}, 0 extra X reads): ${allocator.nextAction}`,
    `Ranked content formats: ${(allocator.rankedFormatIds || []).slice(0, 5).join(", ")}`,
    `MUST apply allocator patch: ${allocator.promptPatch}`,
    `Bandit lanes: ${rows.join("; ")}`,
  ].join("\n");
}

function banditRewardSignals(insights = {}) {
  const records = Array.isArray(insights?.records) ? insights.records.filter((record) => record?.templateId) : [];
  const minSamples = Math.max(1, Number(insights?.minSamples) || 1);
  const baseline = Number(insights?.baselineScore) || 0;
  const recentLimit = integerEnv("TWEET_BANDIT_RECENT_SETTLEMENT_POSTS", 30, 5, 200);
  const byFormat = new Map();
  const ensure = (format) => {
    const id = format.id || format;
    if (!byFormat.has(id)) {
      byFormat.set(id, {
        id,
        label: format.label || compactBucketName(id),
        samples: 0,
        totalReward: 0,
        avgReward: 0,
        recentSamples: 0,
        recentTotalReward: 0,
        recentAvgReward: 0,
      });
    }
    return byFormat.get(id);
  };
  for (const format of configuredContentFormats()) ensure(format);

  for (const record of records) {
    const format = configuredContentFormats().find((item) => item.id === record.templateId) || { id: record.templateId, label: compactBucketName(record.templateId) };
    const row = ensure(format);
    const reward = recordGrowthScore(record);
    row.samples += 1;
    row.totalReward += reward;
    row.avgReward = row.totalReward / row.samples;
  }

  const recentRecords = [...records]
    .sort((left, right) => Date.parse(right.postedAt || right.createdAt || "") - Date.parse(left.postedAt || left.createdAt || ""))
    .slice(0, recentLimit);
  for (const record of recentRecords) {
    const row = ensure({ id: record.templateId, label: compactBucketName(record.templateId) });
    const reward = recordGrowthScore(record);
    row.recentSamples += 1;
    row.recentTotalReward += reward;
    row.recentAvgReward = row.recentTotalReward / row.recentSamples;
  }

  const settledRows = [...byFormat.values()];
  const eligibleBest = settledRows.filter((row) => row.samples >= minSamples && row.avgReward > 0);
  const bestReward = Math.max(
    0,
    baseline,
    ...(eligibleBest.length ? eligibleBest : settledRows).map((row) => Number(row.avgReward) || 0),
  );
  for (const row of settledRows) {
    row.bestReward = Number(bestReward.toFixed(2));
    row.regret = Number(Math.max(0, bestReward - (Number(row.avgReward) || 0)).toFixed(2));
    row.recentRegret = Number(Math.max(0, bestReward - (Number(row.recentAvgReward) || 0)).toFixed(2));
    row.rewardIndex = bestReward > 0 ? Number((((Number(row.avgReward) || 0) / bestReward) * 100).toFixed(1)) : 0;
    row.baselineLiftPct = baseline > 0 && row.samples >= minSamples
      ? Number((((Number(row.avgReward) || 0) - baseline) / baseline * 100).toFixed(1))
      : null;
  }
  return {
    records,
    rows: settledRows,
    recentRecords,
    baseline,
    minSamples,
    bestReward,
  };
}

function buildContentBanditSettlement({ insights = {}, contentBanditAllocator = null, now = null } = {}) {
  const signals = banditRewardSignals(insights);
  const laneById = new Map((contentBanditAllocator?.lanes || []).map((lane) => [lane.id, lane]));
  const totalSamples = Math.max(1, signals.rows.reduce((sum, row) => sum + (Number(row.samples) || 0), 0));
  const arms = signals.rows
    .map((row) => {
      const lane = laneById.get(row.id) || {};
      const actualSharePct = (Number(row.samples) || 0) / totalSamples * 100;
      const allocationPct = Number(lane.allocationPct) || 0;
      const overAllocated = allocationPct > 0 && actualSharePct > allocationPct * 1.45;
      const underAllocated = allocationPct > 0 && actualSharePct < allocationPct * 0.45;
      let status = "collect";
      if (row.samples >= signals.minSamples && row.rewardIndex >= 92) status = "winner";
      else if (row.samples >= signals.minSamples && row.baselineLiftPct !== null && row.baselineLiftPct < -18) status = "regret";
      else if (overAllocated) status = "over";
      else if (underAllocated) status = "under";
      return {
        id: row.id,
        label: row.label,
        status,
        samples: row.samples,
        recentSamples: row.recentSamples,
        avgReward: Number((Number(row.avgReward) || 0).toFixed(2)),
        recentAvgReward: Number((Number(row.recentAvgReward) || 0).toFixed(2)),
        rewardIndex: row.rewardIndex,
        regret: row.regret,
        recentRegret: row.recentRegret,
        baselineLiftPct: row.baselineLiftPct,
        allocationPct: Number(allocationPct.toFixed(1)),
        actualSharePct: Number(actualSharePct.toFixed(1)),
        laneStatus: lane.status || null,
        nextAction:
          status === "winner"
            ? `Settle ${row.label} as a winning arm; keep exploit pressure.`
            : status === "regret"
              ? `Reduce ${row.label} until a story is a perfect fit.`
              : status === "over"
                ? `Actual share is above allocator target; cool down ${row.label}.`
                : status === "under"
                  ? `Under-sampled versus allocation; schedule a clean test.`
                  : `Collect more reward samples for ${row.label}.`,
      };
    })
    .sort((left, right) => {
      const priority = { winner: 4, under: 3, collect: 2, over: 1, regret: 0 };
      return (priority[right.status] || 0) - (priority[left.status] || 0) || right.rewardIndex - left.rewardIndex;
    });

  const bestArm = arms.find((arm) => arm.status === "winner") || [...arms].sort((left, right) => right.rewardIndex - left.rewardIndex)[0] || null;
  const regretArms = arms.filter((arm) => arm.status === "regret" || arm.status === "over").slice(0, 3);
  const recentSettlements = signals.recentRecords.slice(0, 10).map((record) => {
    const reward = recordGrowthScore(record);
    const predicted = record.generationDecisionTrace?.contentBandit?.recommendedLane?.id || null;
    return {
      id: record.id || null,
      url: record.url || xTweetUrl(record.id),
      formatId: record.templateId || "-",
      reward: Number(reward.toFixed(1)),
      regret: Number(Math.max(0, signals.bestReward - reward).toFixed(1)),
      predictedPrimary: predicted,
      matchedPrimary: predicted ? predicted === record.templateId : null,
      postedAt: record.postedAt || record.createdAt || null,
      text: firstTweetLine(record.text),
    };
  });
  const avgRegret = recentSettlements.length
    ? recentSettlements.reduce((sum, item) => sum + (Number(item.regret) || 0), 0) / recentSettlements.length
    : 0;

  return {
    generatedAt: now || new Date().toISOString(),
    mode: "cached_bandit_reward_settlement",
    zeroExtraXReads: true,
    source: "cached tweet metrics by template arm",
    confidence: signals.records.length >= 60 ? "high" : signals.records.length >= 16 ? "medium" : "low",
    sampleCount: signals.records.length,
    baselineScore: Number(signals.baseline.toFixed(2)),
    bestReward: Number(signals.bestReward.toFixed(2)),
    avgRecentRegret: Number(avgRegret.toFixed(2)),
    bestArm,
    regretArms,
    arms,
    recentSettlements,
    nextAction: bestArm
      ? `Settle reward toward ${bestArm.label}; ${regretArms.length ? `cool ${regretArms.map((arm) => arm.label).join(", ")}` : "keep exploration floor active"}.`
      : "Wait for measured tweet rewards before settling bandit arms.",
    guardrails: [
      "Settlement uses cached metrics only; 0 X read ops.",
      "Do not overfit arms below the minimum sample floor.",
      "Regret cools content formats; it never triggers auto-replies or scraping.",
    ],
  };
}

function formatContentBanditSettlementContext(settlement) {
  if (!settlement?.arms?.length) return "Bandit reward settlement: unavailable.";
  const rows = settlement.arms.slice(0, 5).map((arm) =>
    `${arm.label}: status=${arm.status}, reward=${formatNumber(arm.avgReward, 1)}, regret=${formatNumber(arm.regret, 1)}, alloc=${formatNumber(arm.allocationPct, 1)}%, actual=${formatNumber(arm.actualSharePct, 1)}%`,
  );
  return [
    `Bandit reward settlement (${settlement.mode}, ${settlement.confidence}, 0 extra X reads): ${settlement.nextAction}`,
    `Best reward=${formatNumber(settlement.bestReward, 1)}, avg_recent_regret=${formatNumber(settlement.avgRecentRegret, 1)}.`,
    `Settlement arms: ${rows.join("; ")}`,
  ].join("\n");
}

function formatActiveConnConversionOptimizerContext(optimizer) {
  if (!optimizer?.lanes?.length) return "Active-conn conversion optimizer: unavailable.";
  const rows = optimizer.lanes.slice(0, 5).map((lane) =>
    `${lane.label}: ${lane.kind}/${lane.status}/score=${formatNumber(lane.conversionScore, 1)}/conn1k=${formatNumber(lane.expectedConnPer1k, 2)}/n=${formatNumber(lane.samples)}`,
  );
  return [
    `Active-conn conversion optimizer (${optimizer.mode}, ${optimizer.severity}, 0 extra X reads): ${optimizer.nextAction}`,
    `Observed conn/1k=${formatNumber(optimizer.observedConversionPer1k, 2)}; fallback conn/1k=${formatNumber(optimizer.fallbackConversionPer1k, 2)}; profile-click proxy=${formatNumber(optimizer.profileClickPer1k, 2)}/1k.`,
    `Conversion lanes: ${rows.join("; ")}`,
    ...(optimizer.promptDirectives || []).slice(0, 3).map((item) => `Directive: ${item}`),
  ].join("\n");
}

function formatNarrativeResonanceContext(controller) {
  if (!controller?.pillars?.length) return "Narrative resonance controller: unavailable.";
  const rows = controller.pillars.slice(0, 5).map((pillar) =>
    `${pillar.label}: ${pillar.status}/score=${formatNumber(pillar.score, 1)}/share=${formatNumber(pillar.sharePct, 1)}%/avg=${formatNumber(pillar.avgScore, 1)}/n=${formatNumber(pillar.samples)}`,
  );
  return [
    `Narrative resonance controller (${controller.mode}, ${controller.severity}, 0 extra X reads): ${controller.nextAction}`,
    `Account promise: ${controller.accountPromise}`,
    `Narrative pillars: ${rows.join("; ")}`,
    ...(controller.promptDirectives || []).slice(0, 4).map((item) => `Directive: ${item}`),
  ].join("\n");
}

function formatTopicTimingRouterContext(router) {
  if (!router?.lanes?.length) return "Topic timing router: unavailable.";
  const lanes = router.lanes.slice(0, 5)
    .map((lane) =>
      `${lane.windowLabel}/${lane.pillarLabel}/${lane.formatId || "-"} score=${formatNumber(lane.score, 1)} load=${formatNumber(lane.loadScore, 1)} n=${formatNumber(lane.samples)}`,
    )
    .join("; ");
  return [
    `Topic timing router (${router.mode}, ${router.severity}, 0 extra X reads): ${router.nextAction}`,
    router.activeLane
      ? `Active timing lane: ${router.activeLane.windowLabel} UTC -> ${router.activeLane.pillarLabel} / ${router.activeLane.formatLabel}; score=${formatNumber(router.activeLane.score, 1)}.`
      : null,
    lanes ? `Timing lanes: ${lanes}.` : null,
    ...(router.promptDirectives || []).slice(0, 4).map((item) => `Timing directive: ${item}`),
  ].filter(Boolean).join("\n");
}

function buildGrowthOpportunityScorer({
  insights = null,
  adaptiveAngleScheduler = null,
  hourlyLoadBalancer = null,
  angleLoadRouter = null,
  contentBanditAllocator = null,
  narrativeResonanceController = null,
  topicTimingRouter = null,
  rateLimitGovernor = null,
  cadence = null,
  now = new Date().toISOString(),
} = {}) {
  const records = Array.isArray(insights?.records) ? insights.records : [];
  const sampleCount = records.length;
  const buckets = new Map();
  const currentHour = new Date(Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now()).getUTCHours();
  const readGate = rateLimitGovernor?.gates?.read || "cached_only";
  const publishGate = rateLimitGovernor?.gates?.publish || cadence?.publishGate || (cadence?.publishAllowed ? "open" : "review");

  const keyFor = ({ hour = null, pillarId = null, formatId = null }) =>
    `${hour == null ? "any" : hour}:${pillarId || "any"}:${formatId || "any"}`;
  const addLane = ({
    source,
    weight = 1,
    score = 0,
    status = "watch",
    formatId = null,
    formatLabel = null,
    pillarId = null,
    pillarLabel = null,
    hour = null,
    windowLabel = null,
    action = "route",
    reason = "",
    directive = "",
    samples = 0,
    active = false,
  } = {}) => {
    if (!source) return;
    const key = keyFor({ hour, pillarId, formatId });
    const lane = buckets.get(key) || {
      id: key,
      formatId,
      formatLabel,
      pillarId,
      pillarLabel,
      hour,
      windowLabel,
      action,
      status,
      sources: [],
      evidence: [],
      promptDirectives: [],
      weightedScore: 0,
      totalWeight: 0,
      samples: 0,
      activeSignals: 0,
    };
    lane.formatId ||= formatId;
    lane.formatLabel ||= formatLabel || (formatId ? compactBucketName(formatId) : null);
    lane.pillarId ||= pillarId;
    lane.pillarLabel ||= pillarLabel || pillarId;
    lane.hour ??= hour;
    lane.windowLabel ||= windowLabel || (Number.isFinite(Number(hour)) ? utcHourLabel(Number(hour)) : null);
    lane.action ||= action;
    lane.status = lane.status === "hot" || lane.status === "exploit" ? lane.status : status || lane.status;
    lane.weightedScore += boundedPercent(Number(score) || 0) * Math.max(0.1, Number(weight) || 1);
    lane.totalWeight += Math.max(0.1, Number(weight) || 1);
    lane.samples += Number(samples) || 0;
    if (active) lane.activeSignals += 1;
    if (!lane.sources.includes(source)) lane.sources.push(source);
    if (reason) lane.evidence.push(reason);
    if (directive) lane.promptDirectives.push(directive);
    buckets.set(key, lane);
  };

  for (const lane of (topicTimingRouter?.lanes || []).slice(0, 8)) {
    addLane({
      source: "topic_timing",
      weight: lane === topicTimingRouter.activeLane ? 1.55 : 1.2,
      score: Number(lane.score || 0) * 0.82 + Number(topicTimingRouter.routerScore || 0) * 0.18,
      status: lane.status || "watch",
      formatId: lane.formatId,
      formatLabel: lane.formatLabel,
      pillarId: lane.pillarId,
      pillarLabel: lane.pillarLabel,
      hour: lane.hour,
      windowLabel: lane.windowLabel,
      action: lane.status === "hot" ? "exploit" : "route",
      reason: lane.reason || lane.directive || "",
      directive: lane.directive || "",
      samples: lane.samples,
      active: lane === topicTimingRouter.activeLane,
    });
  }

  for (const lane of (contentBanditAllocator?.lanes || []).slice(0, 8)) {
    const statusBoost = lane.status === "exploit" ? 20 : lane.status === "explore" ? 11 : lane.status === "hold" ? -18 : 5;
    addLane({
      source: "content_bandit",
      weight: lane === contentBanditAllocator.recommendedLane ? 1.25 : 0.85,
      score: Math.min(100, Number(lane.allocationPct || 0) * 0.45 + Number(lane.avgScore || 0) * 7 + statusBoost),
      status: lane.status || "test",
      formatId: lane.id,
      formatLabel: lane.label,
      action: lane.status === "exploit" ? "exploit" : lane.status === "hold" ? "hold" : "rotate",
      reason: lane.reason || lane.nextAction || "",
      directive: lane.nextAction || "",
      samples: lane.samples,
      active: lane === contentBanditAllocator.recommendedLane,
    });
  }

  if (angleLoadRouter?.activeSlot) {
    const slot = angleLoadRouter.activeSlot;
    addLane({
      source: "angle_load",
      weight: 1.2,
      score: Number(slot.score || 0) * 0.74 + Number(slot.loadScore || 0) * 0.26,
      status: slot.status || "watch",
      formatId: slot.formatId,
      formatLabel: slot.label,
      hour: slot.hour,
      windowLabel: slot.windowLabel,
      action: slot.action || "route",
      reason: slot.reason || angleLoadRouter.activeCommand || "",
      directive: angleLoadRouter.activeCommand || "",
      active: true,
    });
  }
  for (const lane of (angleLoadRouter?.lanes || []).slice(0, 6)) {
    addLane({
      source: "angle_load",
      weight: 0.75,
      score: Number(lane.score || 0) * 0.7 + Number(lane.loadScore || 0) * 0.3,
      status: lane.status || "probe",
      formatId: lane.formatId || lane.id,
      formatLabel: lane.label,
      hour: lane.hour,
      windowLabel: lane.windowLabel,
      action: lane.action || "route",
      reason: lane.reason || "",
      directive: lane.angle || "",
      samples: lane.samples,
    });
  }

  for (const pillar of (narrativeResonanceController?.pillars || []).slice(0, 6)) {
    addLane({
      source: "narrative_resonance",
      weight: pillar === narrativeResonanceController.primaryPillar ? 1.05 : 0.7,
      score: Number(pillar.score || 0),
      status: pillar.status || "watch",
      pillarId: pillar.id,
      pillarLabel: pillar.label,
      action: pillar.status === "exploit" ? "exploit" : "route",
      reason: pillar.reason || pillar.directive || "",
      directive: pillar.directive || "",
      samples: pillar.samples,
      active: pillar === narrativeResonanceController.primaryPillar,
    });
  }

  for (const angle of (adaptiveAngleScheduler?.nextAngles || []).slice(0, 4)) {
    addLane({
      source: "adaptive_scheduler",
      weight: 0.8,
      score: Number(angle.weight || angle.score || 0),
      status: angle.action || "watch",
      formatId: angle.formatId,
      formatLabel: angle.label,
      hour: angle.hour,
      windowLabel: angle.windowLabel,
      action: angle.action || "route",
      reason: angle.reason || "",
      directive: angle.angle || "",
      samples: angle.samples,
    });
  }

  const nextWindow = hourlyLoadBalancer?.nextWindow || hourlyLoadBalancer?.currentHour || null;
  if (nextWindow) {
    addLane({
      source: "hourly_load",
      weight: 0.55,
      score: Number(nextWindow.loadScore || 0),
      status: nextWindow.status || "watch",
      hour: nextWindow.hour,
      windowLabel: nextWindow.windowLabel || nextWindow.label,
      action: "schedule",
      reason: hourlyLoadBalancer?.nextAction || "",
      directive: `Prefer ${nextWindow.windowLabel || nextWindow.label || utcHourLabel(nextWindow.hour)} UTC if cadence allows.`,
      samples: nextWindow.posts || nextWindow.samples,
    });
  }

  const lanes = [...buckets.values()]
    .map((lane) => {
      const sourceBoost = Math.min(18, Math.max(0, lane.sources.length - 1) * 4.5);
      const sampleBoost = Math.min(8, Math.log1p(Math.max(0, lane.samples)) * 1.7);
      const activeBoost = Math.min(12, lane.activeSignals * 5);
      const rawScore = lane.totalWeight > 0 ? lane.weightedScore / lane.totalWeight : 0;
      const score = boundedPercent(rawScore + sourceBoost + sampleBoost + activeBoost);
      const label = [
        lane.windowLabel ? `${lane.windowLabel} UTC` : null,
        lane.pillarLabel,
        lane.formatLabel,
      ].filter(Boolean).join(" / ") || "cached traffic lane";
      return {
        id: lane.id,
        label,
        formatId: lane.formatId || null,
        formatLabel: lane.formatLabel || null,
        pillarId: lane.pillarId || null,
        pillarLabel: lane.pillarLabel || null,
        hour: lane.hour == null ? null : Number(lane.hour),
        windowLabel: lane.windowLabel || null,
        action: lane.action || "route",
        status: score >= 76 ? "hot" : score >= 58 ? "watch" : lane.status || "probe",
        score: Number(score.toFixed(1)),
        confidence: lane.sources.length >= 3 && sampleCount >= 24 ? "high" : lane.sources.length >= 2 ? "medium" : "low",
        sources: lane.sources,
        samples: lane.samples,
        evidence: lane.evidence.slice(0, 4),
        promptDirectives: lane.promptDirectives.filter(Boolean).slice(0, 4),
      };
    })
    .sort((left, right) => right.score - left.score || right.sources.length - left.sources.length)
    .slice(0, 10);

  const activeOpportunity = lanes[0] || null;
  const opportunityScore = activeOpportunity?.score || 0;
  const sourceBreakdownMap = new Map();
  for (const lane of lanes) {
    for (const source of lane.sources || []) {
      const row = sourceBreakdownMap.get(source) || {
        source,
        lanes: 0,
        scoreTotal: 0,
        samples: 0,
        hot: 0,
      };
      row.lanes += 1;
      row.scoreTotal += Number(lane.score) || 0;
      row.samples += Number(lane.samples) || 0;
      if (lane.status === "hot") row.hot += 1;
      sourceBreakdownMap.set(source, row);
    }
  }
  const sourceBreakdown = [...sourceBreakdownMap.values()]
    .map((row) => ({
      source: row.source,
      lanes: row.lanes,
      avgScore: Number((row.scoreTotal / Math.max(1, row.lanes)).toFixed(1)),
      samples: row.samples,
      hotLanes: row.hot,
    }))
    .sort((left, right) => right.avgScore - left.avgScore || right.hotLanes - left.hotLanes || right.lanes - left.lanes);
  const confidence =
    !activeOpportunity ? "low" : activeOpportunity.confidence === "high" ? "high" : sampleCount >= 16 ? "medium" : "low";
  const severity = opportunityScore >= 76 ? "ok" : opportunityScore >= 52 ? "warn" : "danger";
  const primaryCommand = activeOpportunity
    ? `Bias the next post toward ${activeOpportunity.label}; use cached signals only.`
    : "Keep collecting measured posts before trusting opportunity scoring.";
  const directives = [
    activeOpportunity?.formatId ? `Primary format: ${activeOpportunity.formatId}.` : null,
    activeOpportunity?.pillarLabel ? `Primary narrative: ${activeOpportunity.pillarLabel}.` : null,
    activeOpportunity?.windowLabel ? `Preferred UTC window: ${activeOpportunity.windowLabel}.` : null,
    activeOpportunity?.promptDirectives?.[0] || null,
    "No live X search/read calls are required for this opportunity score.",
  ].filter(Boolean);

  return {
    generatedAt: now,
    mode: lanes.length ? "cached_opportunity_fusion" : "opportunity_fusion_warmup",
    severity,
    confidence,
    source: "cached topic timing + content bandit + angle load + narrative resonance",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    sampleCount,
    opportunityScore: Number(opportunityScore.toFixed(1)),
    readGate,
    publishGate,
    primaryCommand,
    activeOpportunity,
    lanes,
    scoreBreakdown: {
      formula: "weighted cached signals + source diversity + sample depth + active-lane boost",
      activeSources: activeOpportunity?.sources || [],
      sources: sourceBreakdown,
    },
    promptDirectives: directives.slice(0, 6),
    guardrails: [
      "Cached analytics only; do not spend X search/read calls to calculate this score.",
      "Do not bypass cadence, OAuth, budget, or rate-limit gates.",
      "Manual distribution routes remain human-in-the-loop.",
    ],
  };
}

function buildNextWindowAngleCommander({
  cadence = null,
  topicTimingRouter = null,
  growthOpportunityScorer = null,
  hourlyLoadBalancer = null,
  angleLoadRouter = null,
  adaptiveAngleScheduler = null,
  budgetAllocationOptimizer = null,
  dailyExecutionConsole = null,
  now = new Date().toISOString(),
} = {}) {
  const currentHour = new Date(Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now()).getUTCHours();
  const timingLane = topicTimingRouter?.activeLane || null;
  const opportunity = growthOpportunityScorer?.activeOpportunity || null;
  const angleSlot = angleLoadRouter?.activeSlot || null;
  const loadWindow = hourlyLoadBalancer?.nextWindow || hourlyLoadBalancer?.currentHour || null;
  const schedulerAngle = (adaptiveAngleScheduler?.nextAngles || [])[0] || null;
  const activeHour = Number.isFinite(Number(timingLane?.hour))
    ? Number(timingLane.hour)
    : Number.isFinite(Number(opportunity?.hour))
      ? Number(opportunity.hour)
      : Number.isFinite(Number(angleSlot?.hour))
        ? Number(angleSlot.hour)
        : Number.isFinite(Number(loadWindow?.hour))
          ? Number(loadWindow.hour)
          : currentHour;
  const windowLabel =
    timingLane?.windowLabel ||
    opportunity?.windowLabel ||
    angleSlot?.windowLabel ||
    loadWindow?.windowLabel ||
    loadWindow?.label ||
    utcHourLabel(activeHour);
  const hoursFromNow = Number.isFinite(Number(timingLane?.hoursFromNow))
    ? Number(timingLane.hoursFromNow)
    : Number.isFinite(Number(opportunity?.hoursFromNow))
      ? Number(opportunity.hoursFromNow)
      : Number.isFinite(Number(angleSlot?.hoursFromNow))
        ? Number(angleSlot.hoursFromNow)
        : hourDelta(currentHour, activeHour);
  const formatId =
    opportunity?.formatId ||
    timingLane?.formatId ||
    angleSlot?.formatId ||
    schedulerAngle?.formatId ||
    "decision_rule";
  const formatLabel =
    opportunity?.formatLabel ||
    timingLane?.formatLabel ||
    angleSlot?.label ||
    schedulerAngle?.label ||
    compactBucketName(formatId);
  const pillarId = opportunity?.pillarId || timingLane?.pillarId || null;
  const pillarLabel = opportunity?.pillarLabel || timingLane?.pillarLabel || "Tech Signals";
  const opportunityScore = Number(growthOpportunityScorer?.opportunityScore ?? opportunity?.score ?? 0) || 0;
  const timingScore = Number(topicTimingRouter?.routerScore ?? timingLane?.score ?? 0) || 0;
  const loadScore = Number(angleSlot?.loadScore ?? timingLane?.loadScore ?? loadWindow?.loadScore ?? 0) || 0;
  const cadenceScore = cadence?.publishAllowed ? 12 : cadence?.reasonCode === "topic_timing_wait" ? 5 : -12;
  const budgetLane = budgetAllocationOptimizer?.lanes?.find((lane) => lane.id === budgetAllocationOptimizer.recommendedLaneId) ||
    budgetAllocationOptimizer?.lanes?.[0] ||
    null;
  const commanderScore = boundedPercent(
    opportunityScore * 0.44 +
      timingScore * 0.28 +
      loadScore * 0.18 +
      Math.min(10, Number(opportunity?.sources?.length || 0) * 2.5) +
      cadenceScore,
  );
  const publishGate = cadence?.willBlockPublish
    ? "blocked"
    : cadence?.publishAllowed
      ? "open"
      : "manual_route_only";
  const readGate = "cached_only";
  const severity = publishGate === "blocked"
    ? "danger"
    : commanderScore >= 72 && publishGate === "open"
      ? "ok"
      : commanderScore >= 48
        ? "warn"
        : "danger";
  const manualRoute = (dailyExecutionConsole?.routes || [])[0] || (dailyExecutionConsole?.steps || [])[0] || null;
  const manualLinks = manualReplySearchLinks();
  const routeUrl = manualRoute?.routeUrl || manualRoute?.url || xSearchUrl(manualLinks[0]?.query || "(AI OR tech) -is:retweet lang:en");
  const publishDirective = publishGate === "open"
    ? `Publish one ${formatLabel} packet around ${windowLabel} UTC; lead with ${pillarLabel}.`
    : `Hold the standalone post; run one manual route op and keep the ${formatLabel} angle warm for ${windowLabel} UTC.`;
  const promptBias = [
    `Format=${formatId}`,
    `Pillar=${pillarLabel}`,
    `Window=${windowLabel} UTC`,
    "Hook must state a rule, cost, prediction, or sharp question in the first line.",
    "No headline recap; no generic AI phrasing.",
  ];
  const gates = [
    {
      id: "x_read_partition",
      label: "X read partition",
      status: "ok",
      value: "0 ops",
      detail: "Commander uses cached analytics, RSS state, and manual web route links only.",
    },
    {
      id: "cadence",
      label: "Cadence",
      status: publishGate === "open" ? "ok" : publishGate === "blocked" ? "danger" : "warn",
      value: publishGate,
      detail: cadence?.reason || "No cadence controller output.",
    },
    {
      id: "budget",
      label: "cost partition",
      status: budgetLane?.gate === "blocked" ? "danger" : "ok",
      value: budgetLane?.safeSlots == null ? "safe" : `${formatNumber(budgetLane.safeSlots)} slots`,
      detail: budgetAllocationOptimizer?.runbook || budgetLane?.nextAction || "No budget allocator output.",
    },
  ];
  const lanes = [
    opportunity
      ? {
          id: "opportunity",
          label: opportunity.label || "Opportunity lane",
          score: Number(Number(opportunity.score || opportunityScore).toFixed(1)),
          status: opportunity.status || "watch",
          source: (opportunity.sources || []).join(" + ") || "opportunity",
          detail: (opportunity.evidence || [])[0] || (opportunity.promptDirectives || [])[0] || growthOpportunityScorer?.primaryCommand || "",
        }
      : null,
    timingLane
      ? {
          id: "timing",
          label: `${timingLane.windowLabel || utcHourLabel(timingLane.hour)} UTC / ${timingLane.pillarLabel || timingLane.pillarId || "-"} / ${timingLane.formatLabel || timingLane.formatId || "-"}`,
          score: Number(Number(timingLane.score || timingScore).toFixed(1)),
          status: timingLane.status || "watch",
          source: "topic_timing",
          detail: timingLane.reason || timingLane.directive || topicTimingRouter?.nextAction || "",
        }
      : null,
    angleSlot
      ? {
          id: "angle_load",
          label: `${angleSlot.windowLabel || utcHourLabel(angleSlot.hour)} UTC / ${angleSlot.label || angleSlot.formatId || "-"}`,
          score: Number(Number(angleSlot.score || 0).toFixed(1)),
          status: angleSlot.status || "probe",
          source: "angle_load",
          detail: angleSlot.reason || angleLoadRouter?.activeCommand || "",
        }
      : null,
  ].filter(Boolean);
  const checklist = [
    publishGate === "open"
      ? `Post one standalone ${formatLabel} packet inside/near ${windowLabel} UTC.`
      : "Do not force a standalone post while cadence/budget gates are in review.",
    `Use this prompt bias: ${promptBias.slice(0, 3).join(" · ")}.`,
    "Open one prepared X web route and paste one useful reply; stop after a real contribution.",
    "After metrics refresh, let cached learning update the next command.",
  ];
  const copyBlock = [
    "NEXT WINDOW COMMANDER",
    `Score: ${formatNumber(commanderScore, 1)} / Gate: ${publishGate} / X reads: 0`,
    `Window: ${windowLabel} UTC (${formatNumber(hoursFromNow, 1)}h from now)`,
    `Angle: ${formatLabel} / ${pillarLabel}`,
    `Command: ${publishDirective}`,
    "Prompt bias:",
    ...promptBias.map((item) => `- ${item}`),
  ].join("\n");

  return {
    generatedAt: now,
    mode: "zero_read_next_window_commander",
    severity,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    source: "cached cadence + topic timing + opportunity scorer + angle load",
    commanderScore: Number(commanderScore.toFixed(1)),
    publishGate,
    readGate,
    activeWindow: {
      hour: activeHour,
      windowLabel,
      hoursFromNow: Number(hoursFromNow.toFixed(2)),
      loadScore: Number(loadScore.toFixed(1)),
    },
    window: {
      hour: activeHour,
      label: windowLabel,
      windowLabel,
      hoursFromNow: Number(hoursFromNow.toFixed(2)),
      loadScore: Number(loadScore.toFixed(1)),
    },
    activeAngle: {
      formatId,
      formatLabel,
      pillarId,
      pillarLabel,
      opportunityScore: Number(opportunityScore.toFixed(1)),
      timingScore: Number(timingScore.toFixed(1)),
    },
    command: publishDirective,
    promptBias,
    routeUrl,
    gates,
    lanes,
    checklist,
    copyBlock,
    guardrails: [
      "0 X search/read ops; no scraping, no rate-limit bypass.",
      "Cadence, OAuth, budget, and platform gates are hard stops.",
      "Manual route work stays human-reviewed and context-specific.",
    ],
  };
}

function buildL7FireWindowRouter({
  nextWindowAngleCommander = null,
  topicTimingRouter = null,
  temporalAngleMatrix = null,
  angleLoadRouter = null,
  hourlyLoadBalancer = null,
  growthOpportunityScorer = null,
  cadence = null,
  rateLimitGovernor = null,
  budgetAllocationOptimizer = null,
  now = new Date().toISOString(),
} = {}) {
  const commander = nextWindowAngleCommander || {};
  const activeWindow = commander.window || commander.activeWindow || {};
  const activeAngle = commander.activeAngle || {};
  const readGate = commander.readGate || rateLimitGovernor?.gates?.read || "cached_only";
  const publishGate =
    commander.publishGate ||
    rateLimitGovernor?.gates?.publish ||
    cadence?.publishGate ||
    (cadence?.publishAllowed ? "open" : "review");
  const safeLeft = Number(rateLimitGovernor?.budget?.safeRemainingUsd ?? budgetAllocationOptimizer?.safeRemainingUsd);
  const dashboardSafeText = (value, fallback = "-") => String(value || fallback)
    .replace(/\bfollowers?\b/gi, "active conns")
    .replace(/\bimpressions?\b/gi, "L7 events")
    .replace(/\bviews\b/gi, "L7 events")
    .replace(/\berrors?\b/gi, "HTTP status triage")
    .replace(/\btweets?\b/gi, "packets")
    .replace(/\bpost(?:s|ing)?\b/gi, "packets");
  const laneMap = new Map();
  const addLane = (source, lane = {}, weight = 0) => {
    const hour = Number(lane.hour ?? activeWindow.hour);
    const windowLabel =
      lane.windowLabel ||
      lane.label ||
      activeWindow.windowLabel ||
      activeWindow.label ||
      (Number.isFinite(hour) ? utcHourLabel(hour) : "-");
    const formatId = lane.formatId || activeAngle.formatId || lane.id || "decision_rule";
    const pillarId = lane.pillarId || activeAngle.pillarId || "tech_signals";
    const key = `${windowLabel}:${formatId}:${pillarId}:${source}`;
    const score = boundedPercent(
      Number(lane.score ?? lane.routerScore ?? commander.commanderScore ?? 0) * 0.76 +
        Number(lane.loadScore ?? activeWindow.loadScore ?? hourlyLoadBalancer?.nextWindow?.loadScore ?? 0) * 0.18 +
        weight,
    );
    laneMap.set(key, {
      id: key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
      source,
      hour: Number.isFinite(hour) ? hour : null,
      windowLabel,
      hoursFromNow: Number(Number(lane.hoursFromNow ?? activeWindow.hoursFromNow ?? 0).toFixed(1)),
      loadScore: Number(Number(lane.loadScore ?? activeWindow.loadScore ?? 0).toFixed(1)),
      formatId,
      formatLabel: dashboardSafeText(lane.formatLabel || lane.label || activeAngle.formatLabel || compactBucketName(formatId)),
      pillarId,
      pillarLabel: dashboardSafeText(lane.pillarLabel || activeAngle.pillarLabel || "Tech Signals"),
      status: score >= 76 ? "hot" : score >= 58 ? "watch" : lane.status || "seed",
      score: Number(score.toFixed(1)),
      sampleCount: Number(lane.samples ?? lane.sampleCount ?? 0) || 0,
      l7Events: Number(lane.l7Events ?? lane.impressions ?? 0) || 0,
      directive: dashboardSafeText(lane.directive || lane.reason || commander.command, "Route the next packet through the cached L7 fire window."),
    });
  };

  for (const lane of topicTimingRouter?.lanes || []) addLane("topic_timing", lane, 8);
  for (const lane of temporalAngleMatrix?.slots || []) addLane("temporal_matrix", lane, 5);
  for (const lane of angleLoadRouter?.lanes || []) addLane("angle_load", lane, 3);
  for (const lane of growthOpportunityScorer?.lanes || []) addLane("opportunity", lane, 4);
  if (activeWindow.windowLabel || activeWindow.label) {
    addLane("commander", { ...activeWindow, ...activeAngle, score: commander.commanderScore }, 10);
  }
  for (const window of hourlyLoadBalancer?.bestHours || []) addLane("hourly_load", window, 1);

  const lanes = [...laneMap.values()]
    .sort((left, right) => right.score - left.score || left.hoursFromNow - right.hoursFromNow)
    .slice(0, 9);
  const activeLane = lanes[0] || null;
  const routerScore = boundedPercent(
    Number(activeLane?.score || commander.commanderScore || 0) * 0.72 +
      Math.min(16, lanes.length * 1.8) +
      (readGate === "cached_only" ? 7 : readGate === "closed" ? -18 : 2) +
      (publishGate === "open" ? 5 : publishGate === "closed" ? -10 : 0),
  );
  const severity = readGate === "closed" || publishGate === "closed"
    ? "danger"
    : routerScore >= 70
      ? "ok"
      : routerScore >= 45
        ? "warn"
        : "danger";
  const firingMode = publishGate === "open"
    ? "armed_packet_window"
    : cadence?.willBlockPublish
      ? "manual_route_holding"
      : "manual_route_warmup";

  return {
    generatedAt: now,
    mode: "zero_read_l7_fire_window_router",
    firingMode,
    severity,
    source: "cached packet analytics + cadence + topic timing",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    readGate,
    publishGate,
    routerScore: Number(routerScore.toFixed(1)),
    activeLane,
    lanes,
    safeCostLeftUsd: Number.isFinite(safeLeft) ? roundUsd(Math.max(0, safeLeft)) : null,
    nextAction: activeLane
      ? `${publishGate === "open" ? "Arm" : "Hold"} ${activeLane.formatLabel} / ${activeLane.pillarLabel} for ${activeLane.windowLabel} UTC; keep live X reads at 0.`
      : "Collect more cached packet telemetry before trusting fire-window routing.",
    cells: [
      { id: "read", label: "X read partition", value: readGate, status: readGate === "closed" ? "danger" : "ok" },
      { id: "publish", label: "packet gate", value: publishGate, status: publishGate === "open" ? "ok" : publishGate === "closed" ? "danger" : "warn" },
      { id: "window", label: "fire window", value: activeLane?.windowLabel ? `${activeLane.windowLabel} UTC` : "-", status: activeLane?.status || "warn" },
      { id: "cost", label: "cost partition", value: Number.isFinite(safeLeft) ? `$${formatNumber(Math.max(0, safeLeft), 2)}` : "cached", status: Number.isFinite(safeLeft) && safeLeft <= 0 ? "danger" : "ok" },
    ],
    guardrails: [
      "Use cached telemetry only; no live trend scraping.",
      "Do not override cost, auth, cadence, or rate-limit gates.",
      "Manual route loop stays human-in-the-loop.",
    ],
  };
}

function formatGrowthOpportunityScorerContext(scorer) {
  if (!scorer?.lanes?.length) return "Opportunity fusion reactor: unavailable.";
  const lanes = scorer.lanes.slice(0, 5)
    .map((lane) =>
      `${lane.label} score=${formatNumber(lane.score, 1)} status=${lane.status} src=${lane.sources.join("+")}`,
    )
    .join("; ");
  const sources = (scorer.scoreBreakdown?.sources || []).slice(0, 4)
    .map((source) => `${source.source}:avg=${formatNumber(source.avgScore, 1)}/n=${formatNumber(source.samples)}`)
    .join("; ");
  return [
    `Opportunity fusion reactor (${scorer.mode}, ${scorer.confidence}, 0 extra X reads): ${scorer.primaryCommand}`,
    scorer.activeOpportunity
      ? `Active opportunity: ${scorer.activeOpportunity.label}; score=${formatNumber(scorer.activeOpportunity.score, 1)}; sources=${scorer.activeOpportunity.sources.join("+")}.`
      : null,
    lanes ? `Opportunity lanes: ${lanes}.` : null,
    sources ? `Score breakdown: ${sources}.` : null,
    ...(scorer.promptDirectives || []).slice(0, 5).map((item) => `Opportunity directive: ${item}`),
  ].filter(Boolean).join("\n");
}

function buildGenerationLearningStack(insights = {}) {
  const learningAutopilot = buildLearningAutopilot(insights || {});
  const adaptiveAngleScheduler = buildAdaptiveAngleScheduler(insights || {}, { learningAutopilot });
  const hourlyLoadBalancer = buildHourlyLoadBalancer({ insights });
  const temporalAngleMatrix = buildTemporalAngleMatrix({ insights, adaptiveAngleScheduler, hourlyLoadBalancer });
  const angleLoadRouter = buildAngleLoadRouter({
    temporalAngleMatrix,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    learningAutopilot,
  });
  const learningWriteback = buildLearningWriteback({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
  });
  const angleMutationReactor = buildAngleMutationReactor({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    learningWriteback,
  });
  const hookPatternReactor = buildHookPatternReactor({ insights });
  const contentBanditAllocator = buildContentBanditAllocator({ insights, hookPatternReactor });
  const contentBanditSettlement = buildContentBanditSettlement({ insights, contentBanditAllocator });
  const audienceExpansionRouter = buildAudienceExpansionRouter({ insights });
  const activeConnConversionOptimizer = buildActiveConnConversionOptimizer({
    insights,
    contentBanditAllocator,
    audienceExpansionRouter,
  });
  const narrativeResonanceController = buildNarrativeResonanceController({
    insights,
    activeConnConversionOptimizer,
    audienceExpansionRouter,
    contentBanditAllocator,
  });
  const topicTimingRouter = buildTopicTimingRouter({
    insights,
    hourlyLoadBalancer,
    temporalAngleMatrix,
    contentBanditAllocator,
    narrativeResonanceController,
  });
  const growthOpportunityScorer = buildGrowthOpportunityScorer({
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    angleLoadRouter,
    contentBanditAllocator,
    narrativeResonanceController,
    topicTimingRouter,
  });
  return {
    learningAutopilot,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    temporalAngleMatrix,
    angleLoadRouter,
    learningWriteback,
    angleMutationReactor,
    hookPatternReactor,
    contentBanditAllocator,
    contentBanditSettlement,
    audienceExpansionRouter,
    activeConnConversionOptimizer,
    narrativeResonanceController,
    topicTimingRouter,
    growthOpportunityScorer,
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function uniqueStrings(values, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function formatPolicyName(id, fallback = "") {
  return compactBucketName(firstNonEmpty(fallback, id, "cached policy"));
}

function buildCachedGenerationPolicy({
  generationStack = null,
  contentFormats = [],
  story = null,
  language = null,
  growthStrategy = null,
  now = new Date().toISOString(),
} = {}) {
  const stack = generationStack || {};
  const formats = Array.isArray(contentFormats) ? contentFormats : [];
  const formatById = new Map(formats.map((format) => [format.id, format]));
  const opportunity = stack.growthOpportunityScorer?.activeOpportunity || null;
  const banditLane = stack.contentBanditAllocator?.recommendedLane || null;
  const exploreLane = stack.contentBanditAllocator?.exploreLane || null;
  const angleSlot = stack.angleLoadRouter?.activeSlot || null;
  const timingLane = stack.topicTimingRouter?.activeLane || null;
  const mutation = stack.angleMutationReactor?.primaryMutation || null;
  const hookPattern = stack.hookPatternReactor?.recommendedPattern || null;
  const narrativePillar = stack.narrativeResonanceController?.primaryPillar || null;

  const primaryFormatId = firstNonEmpty(
    opportunity?.formatId,
    growthStrategy?.promotedFormats?.[0]?.id,
    banditLane?.id,
    angleSlot?.formatId,
    timingLane?.formatId,
    mutation?.after,
    formats[0]?.id,
  );
  const primaryFormat = formatById.get(primaryFormatId) || banditLane || angleSlot || timingLane || {};
  const primaryFormatLabel = firstNonEmpty(
    primaryFormat.label,
    opportunity?.formatLabel,
    angleSlot?.label,
    timingLane?.formatLabel,
    primaryFormatId,
  );
  const avoidFormats = uniqueStrings(
    [
      ...(stack.contentBanditAllocator?.lanes || [])
        .filter((lane) => lane?.status === "hold" || lane?.action === "hold")
        .map((lane) => lane.id || lane.formatId),
      ...(stack.learningAutopilot?.holdFormats || []).map((row) => row.id),
      ...(growthStrategy?.holdFormats || []).map((row) => row.id),
    ],
    6,
  );
  const rankedFormatIds = uniqueStrings(
    [
      primaryFormatId,
      growthStrategy?.exploreFormatId,
      ...(growthStrategy?.promotedFormats || []).map((row) => row.id),
      ...(stack.growthOpportunityScorer?.promptDirectives || [])
        .map((directive) => String(directive || "").match(/Primary format:\s*([a-z0-9_\-]+)/i)?.[1]),
      ...(stack.angleLoadRouter?.rankedFormatIds || []),
      ...(angleLoadRouterFormatIds(stack.angleLoadRouter) || []),
      ...(stack.contentBanditAllocator?.rankedFormatIds || []),
      ...formats.map((format) => format.id),
    ],
    6,
  );
  const activeWindow = firstNonEmpty(
    opportunity?.windowLabel && `${opportunity.windowLabel} UTC`,
    timingLane?.windowLabel && `${timingLane.windowLabel} UTC`,
    angleSlot?.windowLabel && `${angleSlot.windowLabel} UTC`,
  );
  const source = story?.source ? compactBucketName(story.source) : "";
  const storyLabel = story?.title ? String(story.title).slice(0, 120) : "";
  const confidence = firstNonEmpty(
    stack.growthOpportunityScorer?.confidence,
    stack.contentBanditAllocator?.confidence,
    stack.angleMutationReactor?.confidence,
    stack.hookPatternReactor?.confidence,
    "low",
  );
  const directives = uniqueStrings(
    [
      primaryFormatId
        ? `Primary format bias: ${primaryFormatId} (${formatPolicyName(primaryFormatId, primaryFormatLabel)}). Use this unless the selected story strongly fits another listed format.`
        : null,
      hookPattern
        ? `First-line hook: ${hookPattern.label}. ${hookPattern.directive || stack.hookPatternReactor?.promptPatch || ""}`
        : stack.hookPatternReactor?.promptPatch,
      opportunity
        ? `Opportunity lane: ${opportunity.label || formatPolicyName(opportunity.formatId)}; sources=${(opportunity.sources || []).join("+") || "cached"}; score=${formatNumber(opportunity.score || 0, 1)}.`
        : null,
      narrativePillar
        ? `Narrative pillar: ${narrativePillar.label || narrativePillar.id}; ${narrativePillar.directive || narrativePillar.reason || "keep the account promise tight"}.`
        : null,
      activeWindow ? `Timing bias: write for the ${activeWindow} learned traffic window; do not mention the window in the post.` : null,
      exploreLane && exploreLane.id !== primaryFormatId
        ? `Controlled exploration: ${exploreLane.id} is allowed only if it is a better fit for this exact story.`
        : null,
      stack.angleMutationReactor?.nextPromptBias
        ? `Mutation bias: ${stack.angleMutationReactor.nextPromptBias}`
        : null,
      avoidFormats.length ? `Avoid low-reward formats unless unavoidable: ${avoidFormats.join(", ")}.` : null,
      ...(growthStrategy?.promptDirectives || []).slice(0, 4).map((directive) => `Persisted strategy: ${directive}`),
      source ? `Source bias: turn ${source} into an operator rule, cost, default shift, or distribution consequence.` : null,
      "Generate candidates that already satisfy this policy; do not rely on downstream scoring to rescue weak summaries.",
      "No live X search/read calls, no auto-replies, no rate-limit circumvention, no URLs, no headline recap.",
    ],
    12,
  );

  return {
    generatedAt: now,
    mode: "cached_generation_policy",
    source: "cached analytics learning stack",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    confidence,
    language: language?.code || null,
    storyTitle: storyLabel,
    storySource: story?.source || null,
    primaryFormatId: primaryFormatId || null,
    primaryFormatLabel: primaryFormatLabel || null,
    exploreFormatId: growthStrategy?.exploreFormatId || exploreLane?.id || null,
    rankedFormatIds,
    avoidFormatIds: avoidFormats,
    hookPattern: hookPattern
      ? {
          id: hookPattern.id || null,
          label: hookPattern.label || null,
          directive: hookPattern.directive || null,
          nextHook: hookPattern.nextHook || null,
        }
      : null,
    narrativePillar: narrativePillar
      ? {
          id: narrativePillar.id || null,
          label: narrativePillar.label || null,
          directive: narrativePillar.directive || null,
        }
      : null,
    opportunity: opportunity
      ? {
          id: opportunity.id || null,
          label: opportunity.label || null,
          score: opportunity.score ?? null,
          sources: opportunity.sources || [],
          promptDirectives: opportunity.promptDirectives || [],
        }
      : null,
    growthStrategy: growthStrategy
      ? {
          mode: growthStrategy.mode || null,
          status: growthStrategy.status || null,
          confidence: growthStrategy.confidence || null,
          promotedFormats: (growthStrategy.promotedFormats || []).slice(0, 5),
          holdFormats: (growthStrategy.holdFormats || []).slice(0, 5),
          exploreFormatId: growthStrategy.exploreFormatId || null,
          formatWeights: growthStrategy.formatWeights || {},
          utcDay: growthStrategy.evolution?.utcDay || growthStrategy.dailyDigest?.utcDay || null,
          preferredHashtags: (growthStrategy.preferredHashtags || []).slice(0, 6),
          nextAction: growthStrategy.nextAction || null,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    directives,
    promptBlock: [
      "CODEX CACHED GENERATION POLICY (hard constraints, 0 extra X reads)",
      `mode: cached_generation_policy`,
      `confidence: ${confidence}`,
      primaryFormatId ? `primary_format: ${primaryFormatId}` : null,
      rankedFormatIds.length ? `ranked_formats: ${rankedFormatIds.join(", ")}` : null,
      avoidFormats.length ? `avoid_formats: ${avoidFormats.join(", ")}` : null,
      storyLabel ? `selected_story: ${storyLabel}` : null,
      "",
      "MUST FOLLOW:",
      ...directives.map((directive) => `- ${directive}`),
    ].filter((line) => line != null).join("\n"),
  };
}

function formatCachedGenerationPolicyContext(policy) {
  if (!policy) return "";
  return policy.promptBlock || [
    "CODEX CACHED GENERATION POLICY (hard constraints, 0 extra X reads)",
    ...(policy.directives || []).map((directive) => `- ${directive}`),
  ].join("\n");
}

function formatPerformanceContext(insights, generationStack = null) {
  if (!insights?.records?.length) {
    return "No post performance history yet. Explore strong hooks and record outcomes.";
  }

  const topEntries = (buckets, limit = 4) =>
    Object.entries(buckets || {})
      .filter(([, bucket]) => bucket.count >= insights.minSamples)
      .sort((left, right) => right[1].avgScore - left[1].avgScore)
      .slice(0, limit)
      .map(([key, bucket]) => `${key}: avg=${bucket.avgScore.toFixed(1)}, n=${bucket.count}`);

  const parts = [
    `Baseline growth score: ${insights.baselineScore.toFixed(1)} from ${insights.records.length} measured posts.`,
  ];
  const templates = topEntries(insights.templates);
  const sources = topEntries(insights.sources);
  const sourceTiers = topEntries(insights.sourceTiers);
  const tags = topEntries(insights.tags, 6);
  if (templates.length) parts.push(`Best content formats: ${templates.join("; ")}`);
  if (sources.length) parts.push(`Best sources: ${sources.join("; ")}`);
  if (sourceTiers.length) parts.push(`Best source tiers: ${sourceTiers.join("; ")}`);
  if (tags.length) parts.push(`Best hashtags/topics: ${tags.join("; ")}`);
  parts.push(formatAudienceExpansionContext(buildAudienceExpansionRouter({ insights })));
  const {
    learningAutopilot,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    temporalAngleMatrix,
    angleLoadRouter,
    angleMutationReactor,
    hookPatternReactor,
    contentBanditAllocator,
    contentBanditSettlement,
    activeConnConversionOptimizer,
    narrativeResonanceController,
    topicTimingRouter,
    growthOpportunityScorer,
  } = generationStack || buildGenerationLearningStack(insights);
  parts.push(formatLearningAutopilotContext(learningAutopilot));
  parts.push(formatAdaptiveAngleSchedulerContext(adaptiveAngleScheduler));
  parts.push(formatHourlyLoadBalancerContext(hourlyLoadBalancer));
  parts.push(formatTemporalAngleMatrixContext(temporalAngleMatrix));
  parts.push(formatAngleLoadRouterContext(angleLoadRouter));
  parts.push(formatAngleMutationReactorContext(angleMutationReactor));
  parts.push(formatHookPatternReactorContext(hookPatternReactor));
  parts.push(formatContentBanditAllocatorContext(contentBanditAllocator));
  parts.push(formatContentBanditSettlementContext(contentBanditSettlement));
  parts.push(formatActiveConnConversionOptimizerContext(activeConnConversionOptimizer));
  parts.push(formatNarrativeResonanceContext(narrativeResonanceController));
  parts.push(formatTopicTimingRouterContext(topicTimingRouter));
  parts.push(formatGrowthOpportunityScorerContext(growthOpportunityScorer));
  return parts.join("\n");
}

function buildLearningAutopilot(insights = {}, { experimentPlan = null, now = null } = {}) {
  const rows = Array.isArray(experimentPlan?.rows) && experimentPlan.rows.length
    ? experimentPlan.rows
    : experimentFormatRows(insights || { templates: {}, minSamples: 2, baselineScore: 0 });
  const sampleCount = Array.isArray(insights?.records) ? insights.records.length : 0;
  const baselineScore = Number(insights?.baselineScore) || 0;
  const exploitFormats = rows.filter((row) => row.action === "exploit").slice(0, 3);
  const testFormats = rows.filter((row) => row.action === "test").slice(0, 2);
  const exploreFormats = rows.filter((row) => row.action === "explore").slice(0, 2);
  const holdFormats = rows.filter((row) => row.action === "hold").slice(0, 3);
  const sourceBias = rankedBucketEntries(insights?.sources, { minSamples: Math.min(Number(insights?.minSamples) || 2, 2) })
    .slice(0, 3)
    .map(([name, bucket]) => ({
      name,
      avgScore: Number((Number(bucket?.avgScore) || 0).toFixed(1)),
      samples: Number(bucket?.count) || 0,
    }));
  const tagBias = rankedBucketEntries(insights?.tags, { minSamples: 1, excludeUnknown: true })
    .slice(0, 4)
    .map(([name, bucket]) => ({
      name,
      avgScore: Number((Number(bucket?.avgScore) || 0).toFixed(1)),
      samples: Number(bucket?.count) || 0,
    }));
  const mode = sampleCount < 10
    ? "sample_discovery"
    : exploitFormats.length
      ? "exploit_winners"
      : testFormats.length
        ? "controlled_test"
        : "explore_formats";
  const confidence = sampleCount >= 50 && exploitFormats.length
    ? "high"
    : sampleCount >= 10
      ? "medium"
      : "low";
  const primaryFormat = exploitFormats[0] || testFormats[0] || exploreFormats[0] || rows[0] || null;
  const primarySource = sourceBias[0] || null;
  const directives = [
    primaryFormat
      ? `Lead with ${primaryFormat.id}: ${primaryFormat.reason || "best current format signal."}`
      : "Lead with a concrete decision rule or practical operator takeaway.",
    primarySource
      ? `Prefer stories from ${primarySource.name} or adjacent sources when the topic is timely.`
      : "Prefer high-signal AI, Big Tech, apps, cloud, security, and startup stories.",
    holdFormats.length
      ? `Avoid weak formats unless story-fit is unusually strong: ${holdFormats.map((row) => row.id).join(", ")}.`
      : "Avoid generic summaries, vague predictions, and corporate launch language.",
    exploreFormats.length
      ? `Reserve one candidate for sample discovery: ${exploreFormats.map((row) => row.id).join(", ")}.`
      : "Keep exploration small; exploit the best-performing rule first.",
  ];

  return {
    generatedAt: now || new Date().toISOString(),
    mode,
    confidence,
    baselineScore: Number(baselineScore.toFixed(1)),
    sampleCount,
    exploitFormats,
    testFormats,
    exploreFormats,
    holdFormats,
    sourceBias,
    tagBias,
    primaryFormat: primaryFormat
      ? { id: primaryFormat.id, label: primaryFormat.label, action: primaryFormat.action, avgScore: primaryFormat.avgScore, samples: primaryFormat.samples }
      : null,
    directives,
  };
}

function formatAutopilotRows(rows) {
  return (rows || []).map((row) => `${row.id || row.name}(${row.action || "bias"} avg=${formatNumber(row.avgScore, 1)} n=${formatNumber(row.samples)})`).join(", ");
}

function formatLearningAutopilotContext(autopilot) {
  if (!autopilot) return "Learning autopilot: unavailable.";
  return [
    "Learning autopilot:",
    `Mode: ${autopilot.mode}; confidence=${autopilot.confidence}; baseline=${formatNumber(autopilot.baselineScore, 1)}; samples=${formatNumber(autopilot.sampleCount)}.`,
    autopilot.exploitFormats?.length ? `Exploit formats: ${formatAutopilotRows(autopilot.exploitFormats)}.` : null,
    autopilot.testFormats?.length ? `Test formats: ${formatAutopilotRows(autopilot.testFormats)}.` : null,
    autopilot.exploreFormats?.length ? `Explore formats: ${formatAutopilotRows(autopilot.exploreFormats)}.` : null,
    autopilot.holdFormats?.length ? `Hold formats: ${formatAutopilotRows(autopilot.holdFormats)}.` : null,
    autopilot.sourceBias?.length ? `Source bias: ${formatAutopilotRows(autopilot.sourceBias)}.` : null,
    autopilot.tagBias?.length ? `Topic/hashtag bias: ${formatAutopilotRows(autopilot.tagBias)}.` : null,
    "Autopilot directives:",
    ...(autopilot.directives || []).map((directive) => `- ${directive}`),
  ]
    .filter(Boolean)
    .join("\n");
}

const ANGLE_LIBRARY = {
  operator_pain: {
    label: "Operator Pain",
    angle: "operator pain / hidden workflow tax",
    keywords: ["operator", "operators", "migration", "rollback", "budget", "permissions", "evals", "maintenance", "platform team"],
  },
  decision_rule: {
    label: "Decision Rule",
    angle: "decision rule / what to do next",
    keywords: ["if ", "when ", "rule", "default", "checklist", "playbook", "budget", "wait", "switch"],
  },
  second_order: {
    label: "Second Order",
    angle: "second-order distribution or business consequence",
    keywords: ["second-order", "distribution", "default", "incentive", "pricing", "platform", "workflow", "behavior"],
  },
  sharp_question: {
    label: "Sharp Question",
    angle: "sharp debate question",
    keywords: ["?", "real question", "what changes", "who pays", "who owns", "worth it"],
  },
  playbook: {
    label: "Playbook",
    angle: "builder playbook / practical next move",
    keywords: ["playbook", "checklist", "do next", "stop", "ship", "review", "monitor", "measure"],
  },
  prediction: {
    label: "Near-term Prediction",
    angle: "near-term prediction / default shift",
    keywords: ["prediction", "next", "2026", "default", "standard", "within", "months"],
  },
  contrarian_cost: {
    label: "Contrarian Cost",
    angle: "contrarian hidden cost",
    keywords: ["hidden cost", "tradeoff", "expensive", "cost", "lock-in", "churn", "tax"],
  },
  not_x_but_y: {
    label: "Not X But Y",
    angle: "reframe / not the feature, the shift",
    keywords: ["not ", "but ", "instead", "underneath", "really", "shift"],
  },
  brutal_truth: {
    label: "Brutal Truth",
    angle: "truth-bomb / unpopular but evidenced take",
    keywords: ["truth", "wrong", "actually", "stop", "default", "real"],
  },
  massive_value_drop: {
    label: "Massive Value Drop",
    angle: "bookmarkable playbook / exact config",
    keywords: ["config", "ci", "cache", "latency", "cost", "steps", "save", "bookmark"],
  },
  myth_busting: {
    label: "Myth Busting",
    angle: "90% wrong / 10% truth",
    keywords: ["myth", "wrong", "actually", "not", "instead", "truth"],
  },
  the_hard_way: {
    label: "The Hard Way",
    angle: "costly lesson / cheat code",
    keywords: ["lesson", "cost", "hours", "burned", "next time", "hard way", "cheat"],
  },
};

function formatRowWeight(row, baseline) {
  const lift = Number(row?.lift);
  const avgScore = Number(row?.avgScore) || 0;
  const samples = Number(row?.samples) || 0;
  const baselineScore = Number(baseline) || 0;
  if (Number.isFinite(lift) && lift) return lift * 100;
  if (baselineScore > 0 && avgScore > 0) return ((avgScore - baselineScore) / baselineScore) * 100;
  return Math.min(10, samples * 2);
}

function slotStatusForAction(action) {
  if (action === "exploit") return "hot";
  if (action === "test") return "watch";
  if (action === "explore") return "probe";
  if (action === "hold") return "hold";
  return "queue";
}

function rowToAngleSlot(row, { slot, baselineScore, mode, fallbackReason } = {}) {
  if (!row) return null;
  const config = ANGLE_LIBRARY[row.id] || {
    label: row.label || compactBucketName(row.id || "Angle"),
    angle: `${row.label || row.id || "growth"} angle`,
    keywords: [row.id || ""],
  };
  const action = row.action || "test";
  const weightBase = 50 + formatRowWeight(row, baselineScore);
  const modeBoost = mode === "surge_exploit" && action === "exploit"
    ? 12
    : mode === "sample_discovery" && action === "explore"
      ? 10
      : mode === "recovery_route" && (row.id === "decision_rule" || row.id === "playbook")
        ? 8
        : action === "hold"
          ? -18
          : 0;
  return {
    slot,
    formatId: row.id,
    label: row.label || config.label,
    angle: config.angle,
    action,
    status: slotStatusForAction(action),
    weight: Number(Math.max(0, Math.min(100, weightBase + modeBoost)).toFixed(1)),
    avgScore: Number(Number(row.avgScore || 0).toFixed(1)),
    samples: Number(row.samples) || 0,
    reason: row.reason || fallbackReason || "Scheduled from current learning telemetry.",
    keywords: config.keywords,
  };
}

function buildAdaptiveAngleScheduler(
  insights = {},
  { state = null, experimentPlan = null, learningAutopilot = null, distributionOps = null, usage = null, now = null } = {},
) {
  const analyticsState = state || emptyTweetAnalyticsState();
  const recent24h = recordsSince(analyticsState, 24);
  const recent7d = recordsSince(analyticsState, 24 * 7);
  const impressions24h = sumTweetMetric(recent24h, "impression_count");
  const impressions7d = sumTweetMetric(recent7d, "impression_count");
  const sampleCount = Array.isArray(insights?.records) ? insights.records.length : 0;
  const baselineScore = Number(insights?.baselineScore) || 0;
  const rows = Array.isArray(experimentPlan?.rows) && experimentPlan.rows.length
    ? experimentPlan.rows
    : experimentFormatRows(insights || { templates: {}, minSamples: 2, baselineScore: 0 });
  const preferredRows = [
    ...(learningAutopilot?.exploitFormats || []),
    ...(experimentPlan?.recommendedFormats || []),
    ...(learningAutopilot?.testFormats || []),
    ...(learningAutopilot?.exploreFormats || []),
    ...rows,
  ];
  const holdIds = new Set((learningAutopilot?.holdFormats || []).map((row) => row.id));
  const uniqueRows = [];
  const seen = new Set();
  for (const row of preferredRows) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    uniqueRows.push(row);
  }

  const bucketPoints = tweetMetricSeries(recent24h, {
    hours: 24,
    buckets: 6,
    metricKey: "impression_count",
  });
  const peakBucket = bucketPoints.reduce((best, point) => (point.value > (best?.value ?? -1) ? point : best), bucketPoints[0] || null);
  const quietBucket = bucketPoints.reduce((best, point) => (point.value < (best?.value ?? Infinity) ? point : best), bucketPoints[0] || null);
  const avgBucket = bucketPoints.length
    ? bucketPoints.reduce((sum, point) => sum + (Number(point.value) || 0), 0) / bucketPoints.length
    : 0;
  const safeBudgetLeft = Math.max(0, monthlyBudgetUsd() * budgetSafetyRatio() - (Number(usage?.totalEstimatedUsd) || 0));
  const routeReady = Number(distributionOps?.readyMissions) || 0;
  const mode = sampleCount < Math.max(6, Number(insights?.minSamples) * 2 || 4)
    ? "sample_discovery"
    : peakBucket && peakBucket.value > Math.max(12, avgBucket * 1.5)
      ? "surge_exploit"
      : routeReady > 0 && impressions24h < Math.max(25, impressions7d / 12)
        ? "recovery_route"
        : "controlled_rotation";
  const confidence = sampleCount >= 50
    ? "high"
    : sampleCount >= Math.max(10, Number(insights?.minSamples) * 4 || 8)
      ? "medium"
      : "low";

  const candidates = uniqueRows
    .map((row, index) => ({
      row,
      rank:
        ({ exploit: 80, test: 58, explore: 46, hold: 10 }[row.action] || 34) +
        formatRowWeight(row, baselineScore) +
        (mode === "surge_exploit" && row.action === "exploit" ? 22 : 0) +
        (mode === "sample_discovery" && row.action === "explore" ? 18 : 0) +
        (mode === "recovery_route" && ["decision_rule", "playbook", "operator_pain"].includes(row.id) ? 18 : 0) -
        (holdIds.has(row.id) ? 35 : 0) -
        index * 0.03,
    }))
    .sort((left, right) => right.rank - left.rank);

  const nextAngles = candidates
    .slice(0, integerEnv("TWEET_ANGLE_SCHEDULER_SLOTS", 4, 2, 6))
    .map((item, index) =>
      rowToAngleSlot(item.row, {
        slot: index + 1,
        baselineScore,
        mode,
        fallbackReason: "Ranked by format lift, sample confidence, and current traffic load.",
      }),
    )
    .filter(Boolean);

  const preferredFormatIds = nextAngles
    .filter((slot) => slot.action !== "hold")
    .map((slot) => slot.formatId);
  const preferredAngleKeywords = [
    ...new Set(nextAngles.flatMap((slot) => slot.keywords || []).filter(Boolean)),
  ].slice(0, 16);
  const primary = nextAngles[0] || null;
  const promptDirectives = [
    primary
      ? `Next angle slot: ${primary.formatId} (${primary.angle}); ${primary.reason}`
      : "Next angle slot: use a practical decision rule with a concrete company/product.",
    mode === "surge_exploit"
      ? "Traffic load is spiking; exploit the strongest proven angle and avoid experiments."
      : mode === "recovery_route"
        ? "Traffic load is soft; write a useful reply-ready angle that earns manual distribution."
        : mode === "sample_discovery"
          ? "Sample count is low; reserve one candidate for an under-tested format without lowering quality."
          : "Use controlled rotation: one proven angle first, one test angle only if story-fit is strong.",
    holdIds.size
      ? `Do not use held formats unless the story is a perfect fit: ${[...holdIds].join(", ")}.`
      : "Avoid summary-only takes; make the angle useful enough to paste as a route output.",
  ];

  return {
    generatedAt: now || new Date().toISOString(),
    mode,
    confidence,
    zeroExtraXReads: true,
    sampleCount,
    baselineScore: Number(baselineScore.toFixed(1)),
    load: {
      impressions24h,
      impressions7d,
      avgBucket: Number(avgBucket.toFixed(1)),
      peakBucket: peakBucket
        ? { label: peakBucket.label, value: peakBucket.value, posts: peakBucket.posts, startsAt: peakBucket.startsAt, endsAt: peakBucket.endsAt }
        : null,
      quietBucket: quietBucket
        ? { label: quietBucket.label, value: quietBucket.value, posts: quietBucket.posts, startsAt: quietBucket.startsAt, endsAt: quietBucket.endsAt }
        : null,
    },
    safeBudgetLeftUsd: roundUsd(safeBudgetLeft),
    nextAngles,
    promptDirectives,
    scoringBias: {
      preferredFormatIds,
      preferredAngleKeywords,
      holdFormatIds: [...holdIds],
    },
  };
}

function formatAdaptiveAngleSchedulerContext(scheduler) {
  if (!scheduler) return "Adaptive angle scheduler: unavailable.";
  const slots = (scheduler.nextAngles || [])
    .map((slot) => `${slot.slot}:${slot.formatId}/${slot.action}/w=${formatNumber(slot.weight, 1)} (${slot.angle})`)
    .join("; ");
  return [
    "Adaptive angle scheduler:",
    `Mode: ${scheduler.mode}; confidence=${scheduler.confidence}; 24h_load=${formatNumber(scheduler.load?.impressions24h)}; peak=${scheduler.load?.peakBucket?.label || "n/a"}.`,
    slots ? `Next slots: ${slots}.` : "Next slots: none.",
    "Scheduler directives:",
    ...(scheduler.promptDirectives || []).map((directive) => `- ${directive}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatHourlyLoadBalancerContext(balancer) {
  if (!balancer) return "Hourly load balancer: unavailable.";
  const best = (balancer.bestHours || [])
    .map((hour) => `${hour.label}(score=${formatNumber(hour.loadScore, 1)}, posts=${formatNumber(hour.posts)}, impr=${formatNumber(hour.impressions)})`)
    .join(", ");
  return [
    "Hourly load balancer:",
    `Mode: ${balancer.mode}; confidence=${balancer.confidence}; current=${balancer.currentHour?.label || "n/a"} score=${formatNumber(balancer.currentHour?.loadScore, 1)}.`,
    balancer.nextWindow ? `Next learned window: ${balancer.nextWindow.label} UTC in ${formatNumber(balancer.nextWindow.hoursFromNow, 1)}h; score=${formatNumber(balancer.nextWindow.loadScore, 1)}.` : null,
    best ? `Best UTC post windows: ${best}.` : null,
    `Cadence hint: ${balancer.nextAction || "Use existing cadence guard."}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTemporalAngleMatrixContext(matrix) {
  if (!matrix) return "Temporal angle matrix: unavailable.";
  const slots = (matrix.slots || [])
    .map((slot) => `${slot.windowLabel}/${slot.formatId}/score=${formatNumber(slot.score, 1)}/${slot.action}`)
    .join("; ");
  return [
    "Temporal angle matrix:",
    `Mode: ${matrix.mode}; confidence=${matrix.confidence}; source=${matrix.source}.`,
    slots ? `UTC angle windows: ${slots}.` : "UTC angle windows: none.",
    matrix.nextAction ? `Matrix directive: ${matrix.nextAction}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAngleLoadRouter({
  temporalAngleMatrix = null,
  adaptiveAngleScheduler = null,
  hourlyLoadBalancer = null,
  learningAutopilot = null,
  rateLimitGovernor = null,
  cadence = null,
  now = new Date().toISOString(),
} = {}) {
  const slots = Array.isArray(temporalAngleMatrix?.slots) ? temporalAngleMatrix.slots : [];
  const nextWindow = hourlyLoadBalancer?.nextWindow || null;
  const currentHour = hourlyLoadBalancer?.currentHour || null;
  const currentSlot = slots.find((slot) => Number(slot.hour) === Number(currentHour?.hour)) || null;
  const nextSlot = slots.find((slot) => Number(slot.hour) === Number(nextWindow?.hour)) || slots[0] || null;
  const schedulerSlot = (adaptiveAngleScheduler?.nextAngles || [])[0] || null;
  const activeSlot = nextSlot || currentSlot || schedulerSlot || null;
  const readGate = rateLimitGovernor?.gates?.read || "cached_only";
  const publishGate = rateLimitGovernor?.gates?.publish || cadence?.publishGate || (cadence?.publishAllowed ? "open" : "review");
  const activeLoad = Number(activeSlot?.loadScore ?? nextWindow?.loadScore ?? currentHour?.loadScore ?? 0) || 0;
  const activeScore = Number(activeSlot?.score ?? schedulerSlot?.weight ?? activeLoad) || 0;
  const explorationOpen = activeLoad < 62 && readGate !== "closed";
  const command = activeSlot
    ? [
        `Route ${activeSlot.label || compactBucketName(activeSlot.formatId || "decision_rule")} at ${activeSlot.windowLabel || nextWindow?.label || currentHour?.label || "next"} UTC.`,
        activeLoad >= 76
          ? "Exploit the strongest proven angle; do not dilute the packet with experiments."
          : explorationOpen
            ? "Keep one controlled exploration lane open, but ship the primary proven angle first."
            : "Use manual distribution first and let cached writeback update the next run.",
      ].join(" ")
    : "Hold angle mutation until the scheduler has a valid cached slot.";
  const lanes = slots.slice(0, 5).map((slot, index) => {
    const score = Number(slot.score) || 0;
    return {
      id: slot.formatId || `angle:${index + 1}`,
      slot: index + 1,
      windowLabel: slot.windowLabel || "-",
      hoursFromNow: Number(Number(slot.hoursFromNow || 0).toFixed(1)),
      label: slot.label || compactBucketName(slot.formatId || "angle"),
      formatId: slot.formatId || null,
      action: slot.action || "test",
      angle: slot.angle || "",
      status: score >= 76 ? "hot" : score >= 58 ? "watch" : slot.action === "hold" ? "hold" : "probe",
      score: Number(score.toFixed(1)),
      loadScore: Number(Number(slot.loadScore || 0).toFixed(1)),
      samples: Number(slot.samples) || 0,
      avgScore: Number(Number(slot.avgScore || 0).toFixed(1)),
      reason: slot.reason || "cached temporal scheduler route",
    };
  });
  const gates = [
    { id: "read", label: "X_READ_PARTITION", value: readGate, status: readGate === "closed" ? "danger" : "ok" },
    { id: "publish", label: "PUBLISH_GATE", value: publishGate, status: publishGate === "open" ? "ok" : "warn" },
    { id: "explore", label: "EXPLORATION_LANE", value: explorationOpen ? "open" : "guarded", status: explorationOpen ? "ok" : "warn" },
    { id: "writeback", label: "WRITEBACK_BUS", value: learningAutopilot?.confidence || adaptiveAngleScheduler?.confidence || "low", status: (learningAutopilot?.sampleCount || adaptiveAngleScheduler?.sampleCount || 0) > 0 ? "ok" : "warn" },
  ];

  return {
    generatedAt: now,
    mode: "cached_angle_load_router",
    source: "hourly load balancer + temporal angle matrix + adaptive scheduler",
    zeroExtraXReads: true,
    severity: activeScore >= 76 ? "ok" : activeScore >= 52 ? "warn" : "danger",
    activeCommand: command,
    activeSlot: activeSlot
      ? {
          windowLabel: activeSlot.windowLabel || nextWindow?.label || currentHour?.label || "-",
          hour: Number(activeSlot.hour ?? nextWindow?.hour ?? currentHour?.hour),
          formatId: activeSlot.formatId || schedulerSlot?.formatId || null,
          label: activeSlot.label || schedulerSlot?.label || compactBucketName(activeSlot.formatId || "angle"),
          angle: activeSlot.angle || schedulerSlot?.angle || "",
          score: Number(activeScore.toFixed(1)),
          loadScore: Number(activeLoad.toFixed(1)),
          action: activeSlot.action || schedulerSlot?.action || "test",
          status: activeScore >= 76 ? "hot" : activeScore >= 52 ? "watch" : "probe",
          reason: activeSlot.reason || adaptiveAngleScheduler?.nextAction || temporalAngleMatrix?.nextAction || "",
        }
      : null,
    gates,
    lanes,
    directives: [
      command,
      ...(adaptiveAngleScheduler?.promptDirectives || []),
      temporalAngleMatrix?.nextAction || null,
    ].filter(Boolean).slice(0, 5),
  };
}

function formatAngleLoadRouterContext(router) {
  if (!router) return "Angle load router: unavailable.";
  const lanes = (router.lanes || [])
    .map((lane) => `${lane.windowLabel}/${lane.formatId || lane.id}/score=${formatNumber(lane.score, 1)}/load=${formatNumber(lane.loadScore, 1)}/${lane.status}`)
    .join("; ");
  return [
    "Angle load router:",
    `Mode: ${router.mode}; severity=${router.severity}; source=${router.source}; 0 extra X reads.`,
    router.activeSlot
      ? `Active slot: ${router.activeSlot.windowLabel} UTC -> ${router.activeSlot.formatId || router.activeSlot.label}; score=${formatNumber(router.activeSlot.score, 1)}; load=${formatNumber(router.activeSlot.loadScore, 1)}.`
      : "Active slot: none.",
    router.activeCommand ? `Router command: ${router.activeCommand}` : null,
    lanes ? `Router lanes: ${lanes}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function tweetMetricsUrl(ids, includePrivateFields = true) {
  const url = new URL(X_TWEETS_LOOKUP_URL);
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set(
    "tweet.fields",
    includePrivateFields
      ? "created_at,lang,public_metrics,non_public_metrics,organic_metrics"
      : "created_at,lang,public_metrics",
  );
  return url;
}

async function fetchTweetMetrics(accessToken, ids) {
  if (!ids.length) return [];

  const request = async (includePrivateFields) => {
    const response = await xFetch("TWEET_METRICS_LOOKUP", tweetMetricsUrl(ids, includePrivateFields), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  let { response, data } = await request(true);
  if (!response.ok && /field|permission|forbidden|unauthorized/i.test(JSON.stringify(data))) {
    console.warn("X private tweet metrics unavailable; falling back to public metrics only.");
    ({ response, data } = await request(false));
  }

  if (!response.ok) {
    throw new Error(`X tweet metrics lookup failed (${response.status}): ${JSON.stringify(data)}`);
  }

  return Array.isArray(data.data) ? data.data : [];
}

async function fetchAccountSnapshot(accessToken) {
  const url = new URL(X_ME_URL);
  url.searchParams.set("user.fields", "public_metrics");
  const response = await xFetch("USER_ME_LOOKUP", url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`X user metrics lookup failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return {
    checkedAt: new Date().toISOString(),
    userId: data?.data?.id || null,
    username: data?.data?.username || null,
    publicMetrics: normalizeMetricObject(data?.data?.public_metrics),
  };
}

function accountSnapshotMaxAgeHours() {
  return numberEnv("TWEET_ACCOUNT_SNAPSHOT_MAX_AGE_HOURS", 6, 0, 168);
}

function latestAccountSnapshot(state = emptyTweetAnalyticsState()) {
  const snapshots = Array.isArray(state?.accountSnapshots) ? state.accountSnapshots : [];
  return snapshots
    .filter((snapshot) => snapshot?.checkedAt)
    .sort((left, right) => Date.parse(right.checkedAt || "") - Date.parse(left.checkedAt || ""))[0] || null;
}

function accountSnapshotAgeHours(state = emptyTweetAnalyticsState(), now = new Date()) {
  const latest = latestAccountSnapshot(state);
  const checkedAt = Date.parse(latest?.checkedAt || "");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now || "");
  if (!Number.isFinite(checkedAt) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, (nowMs - checkedAt) / (60 * 60 * 1000));
}

function shouldRefreshAccountSnapshot(state = emptyTweetAnalyticsState(), now = new Date()) {
  const maxAgeHours = accountSnapshotMaxAgeHours();
  if (maxAgeHours <= 0) return true;
  const ageHours = accountSnapshotAgeHours(state, now);
  return ageHours === null || ageHours >= maxAgeHours;
}

function buildAccountSnapshotCache(state = emptyTweetAnalyticsState(), now = new Date()) {
  const enabled = isTruthy(optionalEnv("TWEET_ACCOUNT_SNAPSHOT_ENABLED", "true"));
  const maxAgeHours = accountSnapshotMaxAgeHours();
  const latest = latestAccountSnapshot(state);
  const ageHours = accountSnapshotAgeHours(state, now);
  const due = enabled && shouldRefreshAccountSnapshot(state, now);
  const readCostUsd = estimatedEndpointCost("USER_ME_LOOKUP");
  const generatedDate = now instanceof Date ? now : new Date(now || Date.now());
  const generatedAt = Number.isFinite(generatedDate.getTime()) ? generatedDate.toISOString() : new Date().toISOString();
  const checkedAt = latest?.checkedAt || null;
  const checkedMs = Date.parse(checkedAt || "");
  const nextRefreshAt =
    enabled && checkedAt && maxAgeHours > 0 && Number.isFinite(checkedMs)
      ? new Date(checkedMs + maxAgeHours * 60 * 60 * 1000).toISOString()
      : null;

  return {
    generatedAt,
    enabled,
    mode: !enabled
      ? "disabled"
      : due
        ? "refresh_due"
        : "cache_hit",
    status: !enabled ? "warn" : due ? "warn" : "ok",
    zeroExtraXReads: !due,
    readGate: due ? "sampled" : "cached_only",
    latestCheckedAt: checkedAt,
    nextRefreshAt,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    maxAgeHours,
    fresh: enabled && !due,
    due,
    followers: latest?.publicMetrics?.followers_count ?? null,
    estimatedRefreshCostUsd: due ? roundUsd(readCostUsd) : 0,
    savedReadCostUsd: enabled && !due ? roundUsd(readCostUsd) : 0,
    directive: !enabled
      ? "Account snapshot refresh is disabled; use the latest cached follower telemetry."
      : due
        ? "Account snapshot TTL expired; next maintenance may spend one USER_ME_LOOKUP read."
        : "Account snapshot cache is fresh; skip USER_ME_LOOKUP and preserve X read budget.",
  };
}

function metricsSnapshotFromTweet(tweet) {
  const snapshot = {
    checkedAt: new Date().toISOString(),
    publicMetrics: normalizeMetricObject(tweet.public_metrics),
    nonPublicMetrics: normalizeMetricObject(tweet.non_public_metrics),
    organicMetrics: normalizeMetricObject(tweet.organic_metrics),
  };
  snapshot.growthScore = tweetGrowthScore(snapshot);
  snapshot.engagementRate = engagementRate(snapshot);
  return snapshot;
}

function shouldRefreshTweetMetrics(record) {
  const postedAt = Date.parse(record?.postedAt || "");
  if (!Number.isFinite(postedAt)) return false;
  const ageHours = (Date.now() - postedAt) / (60 * 60 * 1000);
  if (ageHours < numberEnv("TWEET_METRICS_MIN_AGE_MINUTES", 20, 0, 360) / 60) return false;
  if (ageHours > numberEnv("TWEET_METRICS_MAX_AGE_DAYS", 30, 1, 365) * 24) return false;

  const latest = latestTweetSnapshot(record);
  if (!latest?.checkedAt) return true;
  const elapsedHours = (Date.now() - Date.parse(latest.checkedAt)) / (60 * 60 * 1000);
  if (ageHours <= 6) return elapsedHours >= 1;
  if (ageHours <= 48) return elapsedHours >= 3;
  if (ageHours <= 168) return elapsedHours >= 12;
  return elapsedHours >= 24;
}

async function refreshTweetAnalytics(accessToken) {
  if (!tweetAnalyticsEnabled()) return;

  try {
    const state = await readTweetAnalytics();
    const maxPosts = integerEnv("TWEET_METRICS_MAX_POSTS", 5, 1, 100);
    const dueRecords = state.tweets
      .filter((record) => record.id && shouldRefreshTweetMetrics(record))
      .slice(0, maxPosts);

    const accountSnapshotEnabled = isTruthy(optionalEnv("TWEET_ACCOUNT_SNAPSHOT_ENABLED", "true"));
    const accountSnapshotDue = accountSnapshotEnabled && shouldRefreshAccountSnapshot(state);
    const accountSnapshot = accountSnapshotDue
      ? await fetchAccountSnapshot(accessToken).catch((error) => {
          console.warn(`Account metrics skipped: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
      : null;
    if (accountSnapshotEnabled && !accountSnapshotDue) {
      const latest = latestAccountSnapshot(state);
      const ageHours = accountSnapshotAgeHours(state);
      const maxAgeHours = accountSnapshotMaxAgeHours();
      const followers = latest?.publicMetrics?.followers_count;
      console.log(
        `Account metrics cache fresh: ${followers == null ? "followers unknown" : `${followers} followers`}, age=${formatNumber(ageHours, 1)}h / ${formatNumber(maxAgeHours, 1)}h TTL.`,
      );
    }
    if (accountSnapshot) {
      state.accountSnapshots = [...state.accountSnapshots, accountSnapshot].slice(-100);
      const followers = accountSnapshot.publicMetrics.followers_count;
      if (followers != null) console.log(`X account followers: ${followers}.`);
    }

    if (!dueRecords.length) {
      await persistTweetAnalytics(state);
      console.log("No tweet metrics due for refresh.");
      return;
    }

    const ids = dueRecords.map((record) => record.id);
    const metrics = await fetchTweetMetrics(accessToken, ids);
    const byId = new Map(metrics.map((tweet) => [String(tweet.id), tweet]));
    for (const record of dueRecords) {
      const tweet = byId.get(String(record.id));
      if (!tweet) continue;
      const snapshot = metricsSnapshotFromTweet(tweet);
      record.latestMetrics = snapshot;
      record.metricsSnapshots = [...(record.metricsSnapshots || []), snapshot].slice(-24);
      record.updatedAt = new Date().toISOString();
      console.log(
        `Metrics ${record.id}: score=${snapshot.growthScore.toFixed(1)}, engagement=${(snapshot.engagementRate * 100).toFixed(2)}%.`,
      );
    }

    await persistTweetAnalytics(state);
  } catch (error) {
    console.warn(`Tweet analytics refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hotspotRadarEnabled() {
  return isTruthy(optionalEnv("TWEET_HOTSPOT_RADAR_ENABLED", "false"));
}

function hotspotRadarQueries() {
  const configured = listEnv("TWEET_HOTSPOT_RADAR_QUERIES");
  if (configured.length) return configured;
  return [
    '(OpenAI OR Anthropic OR Gemini OR DeepMind OR Nvidia) (AI OR model OR agent OR chip) -is:retweet lang:en',
    '(Apple OR Google OR Microsoft OR Meta OR Amazon OR Tesla) (product OR platform OR device OR privacy OR AI) -is:retweet lang:en',
    '("consumer tech" OR iPhone OR Android OR app OR "App Store" OR YouTube OR TikTok) -is:retweet lang:en',
    '(startup OR cybersecurity OR cloud OR GitHub OR Vercel OR Cloudflare OR "developer tools") -is:retweet lang:en',
  ];
}

function hotspotRadarScore(tweet) {
  const metrics = normalizeMetricObject(tweet.public_metrics);
  const publishedMs = Date.parse(tweet.created_at) || Date.now();
  const recency = recencyScore(publishedMs, Date.now());
  const publicScore = publicMetricScore(metrics);
  return recency * (1 + publicScore / 20);
}

function xTweetUrl(id) {
  return `https://x.com/i/web/status/${id}`;
}

function radarItemFromTweet(tweet, query) {
  const text = String(tweet.text || "").replace(/\s+/g, " ").trim();
  return {
    title: text.slice(0, 120),
    link: xTweetUrl(tweet.id),
    summary: text.slice(0, 280),
    published: tweet.created_at || null,
    publishedMs: Date.parse(tweet.created_at) || Date.now(),
    source: "x.com",
    sourceTier: "radar",
    sourceUrl: `x-search:${query}`,
    itemIndex: 0,
    crossSourceEchoes: 0,
    hotScore: hotspotRadarScore(tweet),
    learnedLift: 0,
    publicMetrics: normalizeMetricObject(tweet.public_metrics),
    radarQuery: query,
  };
}

async function fetchHotspotRadarQuery(accessToken, query) {
  const url = new URL(X_RECENT_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(integerEnv("TWEET_HOTSPOT_RADAR_RESULTS", 10, 10, 100)));
  url.searchParams.set("tweet.fields", "created_at,lang,public_metrics");
  const response = await xFetch("RECENT_SEARCH", url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`X recent search failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return Array.isArray(data.data) ? data.data.map((tweet) => radarItemFromTweet(tweet, query)) : [];
}

async function refreshHotspotRadar(accessToken) {
  if (!hotspotRadarEnabled()) return;

  try {
    const queries = hotspotRadarQueries().slice(0, integerEnv("TWEET_HOTSPOT_RADAR_MAX_QUERIES", 4, 1, 10));
    const results = await mapPool(queries, 2, async (query) => {
      try {
        const items = await fetchHotspotRadarQuery(accessToken, query);
        console.log(`Hotspot radar fetched ${items.length} X posts for query: ${query}`);
        return items;
      } catch (error) {
        console.warn(`Hotspot radar query skipped: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    const byLink = new Map();
    for (const item of results.flat()) {
      const previous = byLink.get(item.link);
      if (!previous || item.hotScore > previous.hotScore) byLink.set(item.link, item);
    }
    const items = [...byLink.values()]
      .sort((left, right) => right.hotScore - left.hotScore)
      .slice(0, integerEnv("TWEET_HOTSPOT_RADAR_MAX_ITEMS", 30, 5, 100));

    const state = await readTweetAnalytics();
    state.hotspotRadar = {
      updatedAt: new Date().toISOString(),
      queries,
      items,
    };
    await persistTweetAnalytics(state);
    console.log(`Hotspot radar stored ${items.length} ranked X posts.`);
  } catch (error) {
    console.warn(`Hotspot radar refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cachedHotspotItems(analyticsState) {
  if (!hotspotRadarEnabled()) return [];
  const maxAgeHours = numberEnv("TWEET_HOTSPOT_RADAR_MAX_AGE_HOURS", 12, 1, 168);
  const updatedAt = Date.parse(analyticsState?.hotspotRadar?.updatedAt || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAgeHours * 60 * 60 * 1000) {
    return [];
  }
  return Array.isArray(analyticsState.hotspotRadar.items)
    ? analyticsState.hotspotRadar.items.map((item, index) => ({
        ...item,
        itemIndex: index,
        sourceTier: item.sourceTier || "radar",
        source: item.source || "x.com",
      }))
    : [];
}

function autoReplyEnabled() {
  return isTruthy(optionalEnv("TWEET_AUTO_REPLY_ENABLED", "false"));
}

function autoReplyMode() {
  return optionalEnv("TWEET_AUTO_REPLY_MODE", "mentions").toLowerCase();
}

function normalizeHandle(handle) {
  return String(handle || "").replace(/^@/, "").trim();
}

const DEFAULT_AUTO_REPLY_WHITELIST =
  "karpathy,sama,paulg,levelsio,gregisenberg,rauchg,amasad,dabit3,svpino,nearcyan";
const DEFAULT_REPLY_DRAFT_SEARCH_TERMS =
  "AI OR tech OR Apple OR Google OR Microsoft OR startup OR cloud OR security OR app OR product";

function autoReplyWhitelistAction() {
  return optionalEnv("TWEET_AUTO_REPLY_WHITELIST_ACTION", "quote").toLowerCase();
}

function autoReplyWhitelistHandles() {
  const configured = optionalEnv("TWEET_AUTO_REPLY_WHITELIST", DEFAULT_AUTO_REPLY_WHITELIST);
  return configured
    .split(/[\n,;]+/)
    .map(normalizeHandle)
    .filter(Boolean)
    .slice(0, 20);
}

function manualReplyTargetHandles() {
  const configured = optionalEnv(
    "TWEET_REPLY_DRAFT_TARGET_HANDLES",
    optionalEnv("TWEET_AUTO_REPLY_WHITELIST", DEFAULT_AUTO_REPLY_WHITELIST),
  );
  return configured
    .split(/[\n,;]+/)
    .map(normalizeHandle)
    .filter(Boolean)
    .slice(0, 20);
}

function manualReplySearchTerms() {
  return optionalEnv("TWEET_REPLY_DRAFT_SEARCH_TERMS", DEFAULT_REPLY_DRAFT_SEARCH_TERMS);
}

function manualReplySearchQuery() {
  const configured = optionalEnv("TWEET_REPLY_DRAFT_SEARCH_QUERY");
  if (configured) return configured;

  const handles = manualReplyTargetHandles().slice(0, 12);
  const terms = manualReplySearchTerms();
  if (!handles.length) return `(${terms}) -is:retweet lang:en`;
  const froms = handles.map((handle) => `from:${handle}`).join(" OR ");
  return `(${froms}) (${terms}) -is:retweet lang:en`;
}

function xSearchUrl(query) {
  return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
}

const TREND_ROUTE_SEGMENT_TERMS = {
  ai_platform: ["AI", "agent", "model", "OpenAI", "Anthropic"],
  big_tech_platform: ["Apple", "Google", "Microsoft", "Meta", "Amazon"],
  consumer_apps: ["iPhone", "Android", "app", "YouTube", "TikTok"],
  devtools_infra: ["GitHub", "developer", "API", "cloud", "Vercel"],
  security_cloud: ["security", "privacy", "cloud", "AWS", "Microsoft"],
  startup_business: ["startup", "founder", "product", "SaaS", "funding"],
  general_tech: ["tech", "AI", "product", "software", "platform"],
};

function trendRouteTerms(item) {
  const segment = primaryAudienceSegment(item);
  const titleTokens = tokenizeTitle(`${item?.title || ""} ${item?.summary || ""}`)
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, 8);
  const sourceToken = String(item?.source || "").split(".")[0];
  const terms = [
    ...titleTokens,
    sourceToken && sourceToken.length > 2 ? sourceToken : null,
    ...(TREND_ROUTE_SEGMENT_TERMS[segment.id] || TREND_ROUTE_SEGMENT_TERMS.general_tech),
  ]
    .filter(Boolean)
    .map((term) => String(term).trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms)].slice(0, integerEnv("TWEET_TREND_ROUTE_TERM_COUNT", 6, 3, 10));
}

function quoteXSearchTerm(term) {
  const clean = String(term || "").replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

function trendRouteQuery(item) {
  const terms = trendRouteTerms(item).map(quoteXSearchTerm).filter(Boolean);
  const minFaves = integerEnv("TWEET_TREND_ROUTE_MIN_FAVES", 5, 0, 1000);
  const queryCore = terms.length ? `(${terms.join(" OR ")})` : "(AI OR tech OR product)";
  const faves = minFaves > 0 ? ` min_faves:${minFaves}` : "";
  return `${queryCore} -is:retweet lang:en${faves}`;
}

function trendReplyAngle(item) {
  const segment = primaryAudienceSegment(item);
  const title = String(item?.title || "this shift").replace(/\s+/g, " ").trim();
  return [
    `Reply angle: ${segment.directive}`,
    `Use the story as evidence, not a recap: ${title}`,
    "Format: one concrete operating rule, one cost/tradeoff, one sharp question.",
  ].join("\n");
}

function manualReplySearchUrl() {
  return xSearchUrl(manualReplySearchQuery());
}

function manualReplySearchLinks() {
  return [
    {
      label: "Target Accounts",
      query: manualReplySearchQuery(),
      when: "Use this first; it borrows distribution from high-signal tech accounts.",
    },
    {
      label: "AI / DevTools",
      query:
        '(OpenAI OR Anthropic OR Cursor OR Gemini OR Nvidia OR "AI coding" OR agents) (AI OR model OR API OR developer OR cloud) -is:retweet lang:en',
      when: "Use this for model launches, coding agents, chips, and AI platform threads.",
    },
    {
      label: "Big Tech / Consumer Tech",
      query:
        '(Apple OR Google OR Microsoft OR Meta OR Amazon OR Tesla) (AI OR app OR product OR privacy OR security OR cloud) -is:retweet lang:en',
      when: "Use this for broader tech posts beyond the AI-builder bubble.",
    },
    {
      label: "Startups / Product",
      query:
        '(startup OR founder OR product OR SaaS OR "developer tools" OR cloud) (AI OR software OR growth OR security) -is:retweet lang:en',
      when: "Use this when you want replies that reach founders and operators.",
    },
  ];
}

function autoReplySearchQueries(account) {
  const configured = listEnv("TWEET_AUTO_REPLY_QUERIES");
  if (configured.length) return configured;

  const username = normalizeHandle(account?.username);
  const queries = [];
  const mode = autoReplyMode();
  if (username && mode !== "whitelist") {
    queries.push(`(@${username} OR to:${username}) -from:${username} -is:retweet`);
  }

  const whitelist = autoReplyWhitelistHandles();
  if ((mode === "whitelist" || mode === "mentions_and_whitelist") && whitelist.length) {
    const froms = whitelist.map((handle) => `from:${handle}`).join(" OR ");
    queries.push(
      `(${froms}) (AI OR tech OR Apple OR Google OR Microsoft OR startup OR cloud OR security OR app OR product) -is:retweet lang:en`,
    );
  }

  return queries;
}

function autoReplyUnsafeReason(text) {
  const value = String(text || "");
  if (!value.trim()) return "empty";
  if (/(giveaway|airdrop|promo code|discount code|book now|sponsored|onlyfans|casino|betting|crypto giveaway)/i.test(value)) {
    return "ad_or_giveaway";
  }
  if (/(kill yourself|racial slur|nazi|terrorist|genocide|shooting|war crime)/i.test(value)) {
    return "high_risk_topic";
  }
  if (/(democrat|republican|biden|trump|election|israel|palestine|ukraine|russia|china sanctions)/i.test(value)) {
    return "political_or_geopolitical";
  }
  if (/(follow me|follow back|like and repost|retweet to win)/i.test(value)) {
    return "engagement_bait";
  }
  return null;
}

function autoReplyRecordKey(targetTweetId) {
  return String(targetTweetId || "");
}

function autoReplyAlreadyHandled(state, targetTweetId) {
  const key = autoReplyRecordKey(targetTweetId);
  return Boolean(
    key &&
      (state.autoReplies?.records || []).some(
        (record) => autoReplyRecordKey(record.targetTweetId) === key,
      ),
  );
}

function autoRepliesPostedToday(state) {
  const today = currentUtcDate();
  return (state.autoReplies?.records || []).filter(
    (record) =>
      (record.status === "replied" || record.status === "quoted") &&
      String(record.createdAt || "").startsWith(today),
  ).length;
}

async function recordAutoReply(record) {
  if (!tweetAnalyticsEnabled()) return;
  const state = await readTweetAnalytics();
  const records = state.autoReplies?.records || [];
  const nextRecord = {
    ...record,
    createdAt: record.createdAt || new Date().toISOString(),
    workflowRunUrl: workflowRunUrl(),
  };
  state.autoReplies = {
    updatedAt: new Date().toISOString(),
    records: [...records, nextRecord].slice(-integerEnv("TWEET_AUTO_REPLY_RECORDS_MAX", 200, 20, 1000)),
  };
  await persistTweetAnalytics(state);
}

function autoReplyCandidateFromTweet(tweet, usersById, query) {
  const author = usersById.get(String(tweet.author_id)) || {};
  const text = String(tweet.text || "").replace(/\s+/g, " ").trim();
  const sourceKind = /(^|\s|\()(@\w+|to:\w+)/i.test(query) ? "mention" : "whitelist";
  return {
    id: String(tweet.id),
    text,
    authorId: String(tweet.author_id || ""),
    authorUsername: author.username || null,
    authorName: author.name || null,
    createdAt: tweet.created_at || null,
    conversationId: tweet.conversation_id || null,
    metrics: normalizeMetricObject(tweet.public_metrics),
    query,
    sourceKind,
    url: xTweetUrl(tweet.id),
    score: hotspotRadarScore(tweet),
  };
}

async function fetchAutoReplyQuery(accessToken, query) {
  const url = new URL(X_RECENT_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(integerEnv("TWEET_AUTO_REPLY_SEARCH_RESULTS", 10, 10, 100)));
  url.searchParams.set("tweet.fields", "author_id,conversation_id,created_at,lang,public_metrics,referenced_tweets");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,verified");
  const response = await xFetch("AUTO_REPLY_SEARCH", url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`X auto-reply search failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const usersById = new Map(
    (data.includes?.users || []).map((user) => [String(user.id), user]),
  );
  return Array.isArray(data.data)
    ? data.data.map((tweet) => autoReplyCandidateFromTweet(tweet, usersById, query))
    : [];
}

async function fetchAutoReplyCandidates(accessToken, account) {
  const queries = autoReplySearchQueries(account)
    .filter(Boolean)
    .slice(0, integerEnv("TWEET_AUTO_REPLY_MAX_QUERIES", 2, 1, 5));
  if (!queries.length) return [];

  const results = await mapPool(queries, 1, async (query) => {
    try {
      const items = await fetchAutoReplyQuery(accessToken, query);
      console.log(`Auto-reply search fetched ${items.length} X posts for query: ${query}`);
      return items;
    } catch (error) {
      console.warn(`Auto-reply search skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });

  const byId = new Map();
  for (const item of results.flat()) {
    const previous = byId.get(item.id);
    if (!previous || item.score > previous.score) byId.set(item.id, item);
  }

  const maxAgeHours = numberEnv("TWEET_AUTO_REPLY_MAX_AGE_HOURS", 36, 1, 168);
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  return [...byId.values()]
    .filter((item) => {
      const createdAt = Date.parse(item.createdAt || "");
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    })
    .sort((left, right) => {
      if (left.sourceKind !== right.sourceKind) {
        return left.sourceKind === "mention" ? -1 : 1;
      }
      return right.score - left.score;
    })
    .slice(0, integerEnv("TWEET_AUTO_REPLY_CANDIDATES_PER_RUN", 5, 1, 20));
}

function cleanReplyText(text) {
  return trimTweet(
    String(text || "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function replyQualityIssue(text) {
  const value = String(text || "").trim();
  if (!value) return "empty";
  if (countCharacters(value) > 240) return "too_long";
  if (/https?:\/\//i.test(value)) return "contains_url";
  if (/(^|\s)#[\p{L}\p{N}_]+/u.test(value)) return "contains_hashtag";
  if (/(thanks for sharing|great point|interesting|love this|as an ai|i think this is)/i.test(value)) {
    return "generic_reply";
  }
  if (/[?？]{2,}/.test(value)) return "engagement_bait";
  return null;
}

async function composeAutoInteraction(candidate, action) {
  const isQuote = action === "quote";
  const { response, data } = await callOpenAIChat({
    purpose: `auto_${isQuote ? "quote" : "reply"}`,
    messages: [
      {
        role: "system",
        content:
          'You write concise English X interactions for a broad-tech account. Return JSON only: {"text":"post","reason":"short"}. No links, no hashtags, no emoji, no generic praise, no sales pitch.',
      },
      {
        role: "user",
        content: [
          `Author: ${candidate.authorUsername ? `@${candidate.authorUsername}` : "unknown"}`,
          isQuote ? "Post to quote:" : "Post to reply to:",
          candidate.text,
          "",
          isQuote
            ? "Write one useful quote-post text under 220 characters. Add a concrete implication, tradeoff, or decision rule. It must stand alone, sound human, and not look like a reply."
            : "Write one useful reply under 220 characters. Add a concrete implication, tradeoff, or decision rule. It must stand alone and sound human. Do not ask for engagement.",
        ].join("\n"),
      },
    ],
    responseFormat: { type: "json_object" },
  });

  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI auto-reply failed (${response.status})`);
  }
  const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
  return {
    text: cleanReplyText(parsed.text || ""),
    reason: String(parsed.reason || "").trim(),
  };
}

async function postReply(text, targetTweetId, accessToken) {
  const body = {
    text,
    reply: { in_reply_to_tweet_id: String(targetTweetId) },
  };
  const response = await xFetch("CREATE_REPLY", X_CREATE_TWEET_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`X create reply failed: ${JSON.stringify(data)}`);
  return data;
}

async function postQuote(text, targetTweetId, accessToken) {
  const body = {
    text,
    quote_tweet_id: String(targetTweetId),
  };
  const response = await xFetch("CREATE_QUOTE", X_CREATE_TWEET_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`X create quote failed: ${JSON.stringify(data)}`);
  return data;
}

function autoReplyActionForCandidate(candidate) {
  if (candidate.sourceKind === "whitelist") {
    const action = autoReplyWhitelistAction();
    return action === "reply" ? "reply" : "quote";
  }
  return "reply";
}

async function runAutoReplies(accessToken) {
  if (!autoReplyEnabled()) {
    console.log("Auto-reply disabled.");
    return;
  }
  if (dryRunEnabled()) {
    console.log("Dry run enabled; skipping auto-replies.");
    return;
  }

  const account = await fetchAccountSnapshot(accessToken);
  const state = await readTweetAnalytics();
  const maxPerDay = integerEnv("TWEET_AUTO_REPLY_MAX_PER_DAY", 1, 0, 20);
  const maxPerRun = integerEnv("TWEET_AUTO_REPLY_MAX_PER_RUN", 1, 0, 10);
  let remaining = Math.min(maxPerRun, Math.max(0, maxPerDay - autoRepliesPostedToday(state)));
  if (remaining <= 0) {
    console.log(`Auto-reply daily quota reached (${maxPerDay}/day).`);
    return;
  }

  const candidates = await fetchAutoReplyCandidates(accessToken, account);
  let posted = 0;
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    if (autoReplyAlreadyHandled(state, candidate.id)) continue;
    if (normalizeHandle(candidate.authorUsername).toLowerCase() === normalizeHandle(account.username).toLowerCase()) {
      continue;
    }

    const unsafe = autoReplyUnsafeReason(candidate.text);
    if (unsafe) {
      await recordAutoReply({
        status: "skipped",
        reason: unsafe,
        targetTweetId: candidate.id,
        targetUrl: candidate.url,
        targetText: candidate.text.slice(0, 280),
        authorUsername: candidate.authorUsername,
      });
      continue;
    }

    const action = autoReplyActionForCandidate(candidate);
    let draft;
    try {
      draft = await composeAutoInteraction(candidate, action);
    } catch (error) {
      await recordAutoReply({
        status: "skipped",
        reason: error instanceof Error ? error.message : String(error),
        targetTweetId: candidate.id,
        targetUrl: candidate.url,
        targetText: candidate.text.slice(0, 280),
        authorUsername: candidate.authorUsername,
      });
      continue;
    }

    const issue = replyQualityIssue(draft.text);
    if (issue) {
      await recordAutoReply({
        status: "skipped",
        reason: issue,
        targetTweetId: candidate.id,
        targetUrl: candidate.url,
        targetText: candidate.text.slice(0, 280),
        draftText: draft.text,
        authorUsername: candidate.authorUsername,
      });
      continue;
    }

    const budget = await evaluatePostBudget(false);
    if (!budget.allowed) {
      console.log(`Skipping auto-reply to protect X API budget: ${budget.reason}`);
      await recordRunEvent("skip", `auto-reply budget skip: ${budget.reason}`, {
        category: "budget",
      });
      break;
    }

    let result;
    try {
      result =
        action === "quote"
          ? await postQuote(draft.text, candidate.id, accessToken)
          : await postReply(draft.text, candidate.id, accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordAutoReply({
        status: "skipped",
        reason: message.slice(0, 240),
        action,
        targetTweetId: candidate.id,
        targetUrl: candidate.url,
        targetText: candidate.text.slice(0, 280),
        draftText: draft.text,
        authorUsername: candidate.authorUsername,
      });
      console.warn(`Auto-${action} skipped: ${message}`);
      continue;
    }
    const replyId = result?.data?.id || null;
    await recordApiSpend(budget.projectedCost, false);
    await recordAutoReply({
      status: action === "quote" ? "quoted" : "replied",
      reason: draft.reason || `auto ${action} posted`,
      action,
      targetTweetId: candidate.id,
      targetUrl: candidate.url,
      targetText: candidate.text.slice(0, 280),
      authorUsername: candidate.authorUsername,
      replyId,
      replyUrl: replyId ? xTweetUrl(replyId) : null,
      replyText: draft.text,
    });
    await recordRunEvent("auto_reply", `auto-${action} posted: ${replyId || "unknown id"}`, {
      category: "x_api",
      targetTweetId: candidate.id,
      replyId,
      action,
    });
    console.log(`Auto-${action} posted: ${replyId || "unknown id"} -> ${candidate.url}`);
    posted += 1;
    remaining -= 1;
  }

  if (!posted) {
    console.log("No auto-reply posted this run.");
  }
}

function followUpDraftsEnabled() {
  return isTruthy(optionalEnv("TWEET_FOLLOWUP_DRAFTS_ENABLED", "true"));
}

function latestDraftCreatedAt(drafts) {
  return maxIsoTimestamp((drafts || []).map((draft) => draft?.createdAt));
}

function draftsFreshEnough(drafts, hours) {
  if (!Array.isArray(drafts) || !drafts.length) return false;
  if (hours <= 0) return false;
  const latest = Date.parse(latestDraftCreatedAt(drafts) || "");
  if (!Number.isFinite(latest)) return false;
  return Date.now() - latest < hours * 60 * 60 * 1000;
}

function followUpCandidateRecords(state, insights) {
  const minAgeHours = numberEnv("TWEET_FOLLOWUP_MIN_AGE_HOURS", 6, 1, 168);
  const maxAgeHours = numberEnv("TWEET_FOLLOWUP_MAX_AGE_HOURS", 72, 6, 720);
  const baseline = insights.baselineScore || 0;
  return (state.tweets || [])
    .filter((record) => {
      const postedAt = Date.parse(record.postedAt || "");
      if (!Number.isFinite(postedAt)) return false;
      const ageHours = (Date.now() - postedAt) / (60 * 60 * 1000);
      if (ageHours < minAgeHours || ageHours > maxAgeHours) return false;
      const score = recordGrowthScore(record);
      if (!score) return false;
      return baseline <= 0 || score >= baseline * numberEnv("TWEET_FOLLOWUP_MIN_SCORE_MULTIPLIER", 1.2, 0.5, 10);
    })
    .sort((left, right) => recordGrowthScore(right) - recordGrowthScore(left))
    .slice(0, integerEnv("TWEET_FOLLOWUP_MAX_DRAFTS", 3, 1, 10));
}

async function generateFollowUpDraftForRecord(record) {
  const { response, data } = await callOpenAIChat({
    purpose: "followup_draft",
    messages: [
      {
        role: "system",
        content:
          'You write follow-up X posts for a tech account. Return JSON only: {"text":"draft follow-up tweet","reason":"why this extends the conversation"}. Do not include URLs. Do not say "follow-up". Never publish or imply automation.',
      },
      {
        role: "user",
        content: [
          "Original tweet:",
          record.text,
          `Original topic: ${record.newsTitle || "unknown"}`,
          `Performance score: ${recordGrowthScore(record).toFixed(1)}`,
          "Write one concise follow-up that adds a second insight, useful example, or sharper prediction. It should work as a reply/thread continuation, not a duplicate.",
        ].join("\n"),
      },
    ],
    responseFormat: { type: "json_object" },
  });

  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI follow-up draft failed (${response.status})`);
  }
  const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
  return {
    tweetId: record.id,
    originalUrl: record.url || xTweetUrl(record.id),
    text: trimTweet(parsed.text || ""),
    reason: String(parsed.reason || "").trim(),
    sourceScore: recordGrowthScore(record),
    createdAt: new Date().toISOString(),
  };
}

async function generateFollowUpDrafts(state, insights) {
  if (!followUpDraftsEnabled()) return [];
  const reuseHours = numberEnv("TWEET_FOLLOWUP_DRAFT_REUSE_HOURS", 20, 0, 168);
  if (draftsFreshEnough(state.followUpDrafts, reuseHours)) {
    console.log(`Reusing ${state.followUpDrafts.length} follow-up draft(s); newest is within ${reuseHours}h.`);
    return state.followUpDrafts;
  }

  const records = followUpCandidateRecords(state, insights);
  if (!records.length) {
    state.followUpDrafts = [];
    await persistTweetAnalytics(state);
    console.log("No high-performing tweets eligible for follow-up drafts.");
    return [];
  }

  const drafts = [];
  for (const record of records) {
    try {
      const draft = await generateFollowUpDraftForRecord(record);
      if (draft.text) drafts.push(draft);
    } catch (error) {
      console.warn(`Follow-up draft skipped for ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  state.followUpDrafts = drafts;
  await persistTweetAnalytics(state);
  console.log(`Generated ${drafts.length} follow-up draft(s); drafts are not published automatically.`);
  return drafts;
}

function manualReplyDraftsEnabled() {
  return isTruthy(optionalEnv("TWEET_REPLY_DRAFTS_ENABLED", "true"));
}

function manualReplyDraftThemes() {
  const configured = listEnv("TWEET_REPLY_DRAFT_THEMES");
  if (configured.length) return configured.slice(0, 12);
  return [
    "AI product launches",
    "Big Tech platform shifts",
    "consumer apps and distribution",
    "cloud and developer platforms",
    "cybersecurity and privacy",
    "startup strategy",
  ];
}

function recentTweetContextForDrafts(state) {
  return (state.tweets || [])
    .slice(0, 8)
    .map((record, index) => `${index + 1}. ${String(record.text || "").replace(/\s+/g, " ").slice(0, 180)}`)
    .join("\n") || "No recent account posts available.";
}

async function generateManualReplyDrafts(state, insights) {
  if (!manualReplyDraftsEnabled()) {
    state.manualReplyDrafts = [];
    await persistTweetAnalytics(state);
    return [];
  }

  const count = integerEnv("TWEET_REPLY_DRAFT_COUNT", 5, 1, 10);
  const reuseHours = numberEnv("TWEET_REPLY_DRAFT_REUSE_HOURS", 20, 0, 168);
  if (
    state.manualReplyDrafts?.length >= count &&
    draftsFreshEnough(state.manualReplyDrafts, reuseHours)
  ) {
    console.log(`Reusing ${state.manualReplyDrafts.length} manual route output(s); newest is within ${reuseHours}h.`);
    return state.manualReplyDrafts.slice(0, count);
  }

  const themes = manualReplyDraftThemes();
  const targetHandles = manualReplyTargetHandles().slice(0, 10).map((handle) => `@${handle}`).join(", ");
  const { response, data } = await callOpenAIChat({
    purpose: "manual_reply_drafts",
    messages: [
      {
        role: "system",
        content:
          'You write reusable manual X reply drafts for a broad-tech account. Return JSON only: {"drafts":[{"text":"reply","useWhen":"where to use it","angle":"short"}]}. No URLs, no hashtags, no emoji, no generic praise.',
      },
      {
        role: "user",
        content: [
          `Write exactly ${count} reply drafts that the account owner can manually paste under relevant tech posts.`,
          "Audience: English broad-tech readers: AI, Big Tech, apps, startups, cloud, security, hardware, software.",
          `Suggested accounts to manually scan: ${targetHandles || "any relevant tech account"}.`,
          `Themes to cover: ${themes.join(", ")}.`,
          "Recent account posts for voice/context:",
          recentTweetContextForDrafts(state),
          "Performance memory:",
          formatPerformanceContext(insights),
          "Rules:",
          "- Each reply must be under 220 characters.",
          "- Do not mention a specific person unless the draft can work broadly.",
          "- Make each reply useful on its own: hidden cost, decision rule, user impact, business impact, or contrarian tradeoff.",
          "- Do not ask for likes, follows, or engagement.",
        ].join("\n"),
      },
    ],
    responseFormat: { type: "json_object" },
  });

  if (!response.ok) {
    console.warn(data?.error?.message || `Manual reply draft generation failed (${response.status})`);
    return [];
  }

  let drafts = [];
  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    drafts = (Array.isArray(parsed.drafts) ? parsed.drafts : [])
      .map((draft) => ({
        text: cleanReplyText(draft.text || ""),
        useWhen: String(draft.useWhen || draft.context || "").trim(),
        angle: String(draft.angle || draft.reason || "").trim(),
        createdAt: new Date().toISOString(),
      }))
      .filter((draft) => draft.text && !replyQualityIssue(draft.text))
      .slice(0, count);
  } catch (error) {
    console.warn(`Manual reply drafts were not parseable: ${error instanceof Error ? error.message : String(error)}`);
  }

  state.manualReplyDrafts = drafts;
  await persistTweetAnalytics(state);
  console.log(`Generated ${drafts.length} manual route output(s); drafts are not published automatically.`);
  return drafts;
}

function formatNumber(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function timestampMs(value, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function recordsSince(state, hours, now = Date.now()) {
  const nowMs = timestampMs(now);
  const cutoff = nowMs - hours * 60 * 60 * 1000;
  return (state.tweets || [])
    .filter((record) => {
      const postedAt = Date.parse(record.postedAt || "");
      return Number.isFinite(postedAt) && postedAt >= cutoff && postedAt <= nowMs;
    })
    .sort((left, right) => recordGrowthScore(right) - recordGrowthScore(left));
}

function recordsOnUtcDay(state, now = Date.now()) {
  const nowMs = timestampMs(now);
  const dayStamp = new Date(nowMs).toISOString().slice(0, 10);
  return (state.tweets || [])
    .filter((record) => {
      const postedAt = Date.parse(record.postedAt || "");
      if (!Number.isFinite(postedAt) || postedAt > nowMs) return false;
      return new Date(postedAt).toISOString().slice(0, 10) === dayStamp;
    })
    .sort((left, right) => recordGrowthScore(right) - recordGrowthScore(left));
}

function metricValue(record, key) {
  const snapshot = latestTweetSnapshot(record);
  return Number(snapshot?.publicMetrics?.[key]) || 0;
}

function reportTable(records, limit = 8) {
  if (!records.length) return "_No measured tweets in this window._";
  return [
    "| Ranker | L7 Traffic | ACKs | Reposts | Thread ACKs | Template | Source | Packet |",
    "|---:|---:|---:|---:|---:|---|---|---|",
    ...records.slice(0, limit).map((record) => {
      const text = String(record.text || "").replace(/\s+/g, " ").slice(0, 90);
      const link = record.url || xTweetUrl(record.id);
      return [
        formatNumber(recordGrowthScore(record), 1),
        formatNumber(metricValue(record, "impression_count")),
        formatNumber(metricValue(record, "like_count")),
        formatNumber(metricValue(record, "retweet_count")),
        formatNumber(metricValue(record, "reply_count")),
        record.templateId || "-",
        record.newsSource || "-",
        `[${text}](${link})`,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |");
    }),
  ].join("\n");
}

function bucketReport(title, buckets, insights, limit = 6) {
  const rows = Object.entries(buckets || {})
    .filter(([, bucket]) => bucket.count >= insights.minSamples)
    .sort((left, right) => right[1].avgScore - left[1].avgScore)
    .slice(0, limit);
  if (!rows.length) return `### ${title}\n\n_Not enough samples yet._`;
  return [
    `### ${title}`,
    "",
    "| Bucket | Avg Score | Samples |",
    "|---|---:|---:|",
    ...rows.map(([key, bucket]) => `| ${key} | ${formatNumber(bucket.avgScore, 1)} | ${bucket.count} |`),
  ].join("\n");
}

function followerDelta(state) {
  const snapshots = state.accountSnapshots || [];
  if (snapshots.length < 2) return null;
  const latest = snapshots[snapshots.length - 1];
  const previous = snapshots[snapshots.length - 2];
  const latestFollowers = Number(latest.publicMetrics?.followers_count);
  const previousFollowers = Number(previous.publicMetrics?.followers_count);
  if (!Number.isFinite(latestFollowers) || !Number.isFinite(previousFollowers)) return null;
  return {
    latestFollowers,
    delta: latestFollowers - previousFollowers,
    latestAt: latest.checkedAt,
  };
}

function hotspotReport(state) {
  const items = state.hotspotRadar?.items || [];
  if (!items.length) return "### Hotspot Radar\n\n_No cached X hotspot radar items yet._";
  return [
    "### Hotspot Radar",
    "",
    `Updated: ${state.hotspotRadar.updatedAt || "unknown"}`,
    "",
    "| Score | Topic |",
    "|---:|---|",
    ...items.slice(0, 8).map((item) => {
      const title = String(item.title || item.summary || "").replace(/\s+/g, " ").slice(0, 110);
      return `| ${formatNumber(item.hotScore, 1)} | [${title}](${item.link}) |`;
    }),
  ].join("\n");
}

function followUpDraftReport(state) {
  const drafts = state.followUpDrafts || [];
  if (!drafts.length) return "### Follow-up Drafts\n\n_No follow-up drafts generated._";
  return [
    "### Follow-up Drafts",
    "",
    ...drafts.map((draft, index) =>
      [
        `**${index + 1}. Source score ${formatNumber(draft.sourceScore, 1)}**`,
        draft.originalUrl ? `Original: ${draft.originalUrl}` : null,
        "",
        "```txt",
        draft.text,
        "```",
        draft.reason ? `Reason: ${draft.reason}` : null,
      ]
        .filter((line) => line != null)
        .join("\n"),
    ),
  ].join("\n\n");
}

function autoReplyReport(state) {
  const records = (state.autoReplies?.records || [])
    .filter((record) => record && typeof record === "object")
    .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""));
  if (!records.length) return "### Auto Replies\n\n_No auto-reply activity recorded._";

  return [
    "### Auto Replies",
    "",
    `Updated: ${state.autoReplies?.updatedAt || "unknown"}`,
    "",
    "| Time | Status | Target | Output | Reason |",
    "|---|---|---|---|---|",
    ...records.slice(0, 12).map((record) =>
      [
        `| ${markdownCell(record.createdAt || "-")}`,
        markdownCell(record.status || "-"),
        record.targetUrl
          ? `[${markdownCell(record.authorUsername ? `@${record.authorUsername}` : record.targetTweetId || "target")}](${record.targetUrl})`
          : markdownCell(record.targetTweetId || "-"),
        record.replyUrl
          ? `[${markdownCell(record.action || record.status || "output")}](${record.replyUrl})`
          : markdownCell(record.draftText || record.replyText || "-").slice(0, 90),
        markdownCell(record.reason || "-").slice(0, 120),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function manualReplyDraftReport(state) {
  const drafts = state.manualReplyDrafts || [];
  if (!drafts.length) return "### Manual Route Outputs\n\n_No manual route outputs generated._";

  return [
    "### Manual Route Outputs",
    "",
    "_Copy one of these under a relevant high-signal tech post. These are drafts only; nothing is auto-published._",
    "",
    ...drafts.map((draft, index) =>
      [
        `**${index + 1}. ${draft.useWhen || draft.angle || "Use under a relevant tech post"}**`,
        "",
        "```txt",
        draft.text,
        "```",
        draft.angle ? `Angle: ${draft.angle}` : null,
      ]
        .filter((line) => line != null)
        .join("\n"),
    ),
  ].join("\n\n");
}

function fallbackManualReplyDrafts() {
  return [
    {
      useWhen: "AI product launch posts, model releases, agent tooling",
      text: "The real moat is not the model announcement. It is whether customers can hand it permissions, tests, logs, and rollback without a meeting. That is where demos become workflow.",
      angle: "hidden cost",
    },
    {
      useWhen: "Big Tech policy changes, app stores, browsers, OS defaults",
      text: "Platform shifts usually start as policy tweaks, then become margin transfers. If the default route changes, every app has to re-price acquisition, retention, and support.",
      angle: "business impact",
    },
    {
      useWhen: "Consumer apps, social products, mobile distribution",
      text: "Consumer apps do not lose distribution all at once. They lose one default, one notification surface, one ranking rule at a time. The winning teams instrument those edges early.",
      angle: "distribution rule",
    },
    {
      useWhen: "Cloud platforms, developer tools, hosting, CI/CD",
      text: "Cloud dev platforms are becoming operating systems for teams. The lock-in is not compute; it is CI history, secrets, preview URLs, observability, and who owns the incident path.",
      angle: "contrarian lock-in",
    },
    {
      useWhen: "Cybersecurity, privacy, data strategy",
      text: "Privacy is turning into a product constraint, not a legal footer. The startup tradeoff: collect less and move slower on personalization, or collect more and inherit breach risk.",
      angle: "startup tradeoff",
    },
  ];
}

function dailyReplyDrafts(state) {
  const generated = Array.isArray(state.manualReplyDrafts)
    ? state.manualReplyDrafts.filter((draft) => draft?.text)
    : [];
  return (generated.length ? generated : fallbackManualReplyDrafts()).slice(0, 5);
}

function tweetSummary(record) {
  return {
    id: record.id,
    text: String(record.text || "").replace(/\s+/g, " ").trim(),
    url: record.url || xTweetUrl(record.id),
    score: Number(recordGrowthScore(record).toFixed(1)),
    impressions: metricValue(record, "impression_count"),
    likes: metricValue(record, "like_count"),
    reposts: metricValue(record, "retweet_count"),
    replies: metricValue(record, "reply_count"),
    template: record.templateId || "-",
    source: record.newsSource || "-",
    postedAt: record.postedAt || null,
    candidateScore: record.candidateScore ?? null,
    candidateReason: record.candidateReason || null,
    angleMutationScore: record.angleMutationScore ?? null,
    angleMutationDiagnostics: record.angleMutationDiagnostics || [],
    hookPatternScore: record.hookPatternScore ?? null,
    hookPatternDiagnostics: record.hookPatternDiagnostics || [],
    hookPattern: record.hookPattern || null,
    contentBanditScore: record.contentBanditScore ?? null,
    contentBanditDiagnostics: record.contentBanditDiagnostics || [],
    narrativeResonanceScore: record.narrativeResonanceScore ?? null,
    narrativeResonanceDiagnostics: record.narrativeResonanceDiagnostics || [],
    narrativePillar: record.narrativePillar || null,
    topicTimingScore: record.topicTimingScore ?? null,
    topicTimingDiagnostics: record.topicTimingDiagnostics || [],
    topicTimingLane: record.topicTimingLane || null,
    generationDecisionTrace: record.generationDecisionTrace || null,
  };
}

function sumTweetMetric(records, key) {
  return records.reduce((sum, record) => sum + metricValue(record, key), 0);
}

function dashboardPeriodStats(records) {
  return {
    posts: records.length,
    impressions: sumTweetMetric(records, "impression_count"),
    likes: sumTweetMetric(records, "like_count"),
    reposts: sumTweetMetric(records, "retweet_count"),
    replies: sumTweetMetric(records, "reply_count"),
    topPosts: records.map(tweetSummary),
  };
}

function nextUtcWindow(hours, now = new Date().toISOString()) {
  const currentHour = new Date(Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now()).getUTCHours();
  const normalized = [...new Set((hours || []).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))]
    .sort((left, right) => left - right);
  if (!normalized.length) return null;
  const ranked = normalized
    .map((hour) => ({
      hour,
      label: `${utcHourLabel(hour)} UTC`,
      hoursFromNow: hourDelta(currentHour, hour),
    }))
    .sort((left, right) => left.hoursFromNow - right.hoursFromNow);
  return ranked[0] || null;
}

function languageDailyTarget(code) {
  const normalized = normalizeLanguageCode(code);
  const envName = normalized ? `TWEET_CADENCE_DAILY_POST_TARGET_${normalized.toUpperCase()}` : "";
  return envName && optionalEnv(envName)
    ? integerEnv(envName, 1, 1, 20)
    : integerEnv("TWEET_CADENCE_DAILY_POST_TARGET", 1, 1, 20);
}

function languageTrackStats(records, code, windowHours, now = new Date().toISOString()) {
  const nowMs = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
  const cutoff = nowMs - windowHours * 60 * 60 * 1000;
  return (records || [])
    .filter((record) => normalizeLanguageCode(record.language) === code)
    .filter((record) => {
      const postedAt = Date.parse(record.postedAt || "");
      return Number.isFinite(postedAt) && postedAt >= cutoff && postedAt <= nowMs;
    })
    .sort((left, right) => recordGrowthScore(right) - recordGrowthScore(left));
}

function buildLanguageTracks(state, insights = {}, now = new Date().toISOString()) {
  const records = state?.tweets || [];
  const definitions = [
    {
      id: "zh",
      label: "ZH",
      locale: "zh-CN",
      windowLabel: "China evening prime (Beijing 20:00)",
      utcHours: peakZhUtcHours(),
    },
    {
      id: "en",
      label: "EN",
      locale: "en",
      windowLabel: "US East morning + lunch + evening commute",
      utcHours: peakEnUtcHours(),
    },
  ];

  return {
    mode: tweetLanguageMode(),
    generatedAt: now,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    tracks: definitions.map((track) => {
      const last24h = languageTrackStats(records, track.id, 24, now);
      const last7d = languageTrackStats(records, track.id, 24 * 7, now);
      const dailyTarget = languageDailyTarget(track.id);
      const nextWindow = nextUtcWindow(track.utcHours, now);
      const measured7d = last7d.filter((record) => latestTweetSnapshot(record));
      const traffic7d = sumTweetMetric(last7d, "impression_count");
      const ack7d =
        sumTweetMetric(last7d, "like_count") +
        sumTweetMetric(last7d, "retweet_count") +
        sumTweetMetric(last7d, "reply_count");
      const status = last24h.length >= dailyTarget
        ? "done"
        : nextWindow && nextWindow.hoursFromNow <= 2
          ? "ready"
          : "scheduled";
      return {
        id: track.id,
        label: track.label,
        locale: track.locale,
        windowLabel: track.windowLabel,
        utcHours: track.utcHours,
        nextWindow,
        dailyTarget,
        packetsLast24h: last24h.length,
        packetsLast7d: last7d.length,
        measuredPackets: measured7d.length,
        traffic7d,
        ack7d,
        avgScore: Number(averageRecordScore(last7d).toFixed(1)),
        topPackets: last7d.slice(0, 3).map(tweetSummary),
        latestPacketAt: maxIsoTimestamp(last7d.map((record) => record.postedAt)),
        status,
        nextAction: status === "done"
          ? `Daily ${track.label} track target reached; use manual route ops until tomorrow.`
          : `Next ${track.label} slot is ${nextWindow?.label || "not scheduled"}; cadence is scoped to this language track.`,
      };
    }),
  };
}

function reviewDecisionForRecord(record, baselineScore = 0) {
  const score = recordGrowthScore(record);
  const impressions = metricValue(record, "impression_count");
  const replies = metricValue(record, "reply_count");
  const reposts = metricValue(record, "retweet_count");
  const likes = metricValue(record, "like_count");
  const hasMetrics = Boolean(latestTweetSnapshot(record));
  if (!hasMetrics) return { action: "wait_metrics", status: "watch", reason: "No metrics snapshot yet." };
  if (score >= Math.max(8, baselineScore * 1.6) || reposts || replies >= 2) {
    return { action: "follow_up", status: "hot", reason: "Strong relative score or conversation signal; write a follow-up angle." };
  }
  if (score >= Math.max(4, baselineScore * 1.05) || likes >= 2) {
    return { action: "continue_topic", status: "ok", reason: "Above baseline; keep the topic but vary the hook." };
  }
  if (impressions > 0 && score < Math.max(2, baselineScore * 0.65)) {
    return { action: "reframe", status: "warn", reason: "Got distribution but weak ACK; change the angle before repeating." };
  }
  return { action: "drop", status: "danger", reason: "Low signal; do not spend another standalone slot on this angle." };
}

function buildPacketReviewWindow({ state, insights, hours, now = new Date().toISOString(), limit = 6 }) {
  const nowMs = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
  const cutoff = nowMs - hours * 60 * 60 * 1000;
  const records = (state.tweets || [])
    .filter((record) => {
      const postedAt = Date.parse(record.postedAt || "");
      return Number.isFinite(postedAt) && postedAt >= cutoff;
    })
    .sort((left, right) => Date.parse(right.postedAt || "") - Date.parse(left.postedAt || ""));
  const baseline = Number(insights?.baselineScore) || 0;
  const reviewed = records.slice(0, limit).map((record) => {
    const decision = reviewDecisionForRecord(record, baseline);
    return {
      id: record.id,
      url: record.url || xTweetUrl(record.id),
      text: String(record.text || "").replace(/\s+/g, " ").trim(),
      language: normalizeLanguageCode(record.language) || null,
      postedAt: record.postedAt || null,
      score: Number(recordGrowthScore(record).toFixed(1)),
      impressions: metricValue(record, "impression_count"),
      likes: metricValue(record, "like_count"),
      reposts: metricValue(record, "retweet_count"),
      replies: metricValue(record, "reply_count"),
      template: record.templateId || null,
      hashtags: extractHashtags(record.text || ""),
      ...decision,
    };
  });
  const counts = reviewed.reduce((totals, item) => {
    totals[item.action] = (totals[item.action] || 0) + 1;
    return totals;
  }, {});
  return {
    hours,
    generatedAt: now,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    baselineScore: Number(baseline.toFixed(1)),
    total: records.length,
    counts,
    items: reviewed,
  };
}

function buildRunFailureStats(state, now = new Date().toISOString()) {
  const nowMs = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
  const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  const events = (state.runEvents || [])
    .filter((event) => {
      const createdAt = Date.parse(event?.createdAt || "");
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    });
  const buckets = {};
  for (const event of events) {
    const message = String(event.message || "").toLowerCase();
    const category = event.category || "other";
    const reason =
      /quality|gate|weak|post-worthy|low value/.test(message) ? "quality_gate" :
      /budget|runway|safe cap/.test(message) ? "budget_guard" :
      /oauth|auth|token/.test(message) ? "x_auth" :
      /cadence|daily target|interval|peak/.test(message) ? "cadence" :
      /rss|feed|story|news/.test(message) ? "source_ingest" :
      category;
    const bucket = buckets[reason] || { reason, count: 0, lastAt: null, samples: [] };
    bucket.count += 1;
    bucket.lastAt = !bucket.lastAt || Date.parse(event.createdAt || "") > Date.parse(bucket.lastAt || "") ? event.createdAt : bucket.lastAt;
    if (bucket.samples.length < 3) bucket.samples.push(String(event.message || event.type || reason).slice(0, 160));
    buckets[reason] = bucket;
  }
  const ranked = Object.values(buckets).sort((left, right) => right.count - left.count);
  return {
    generatedAt: now,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    lookbackDays: 7,
    totalEvents: events.length,
    topReasons: ranked.slice(0, 8),
    primaryReason: ranked[0] || null,
  };
}

function bestPerformingLanguage(languageTracks = {}) {
  const tracks = Array.isArray(languageTracks.tracks) ? languageTracks.tracks : [];
  const ranked = tracks
    .map((track) => ({
      id: track.id,
      label: track.label || String(track.id || "").toUpperCase(),
      avgScore: Number(track.avgScore) || 0,
      measuredPackets: Number(track.measuredPackets) || 0,
      traffic7d: Number(track.traffic7d) || 0,
      ack7d: Number(track.ack7d) || 0,
      nextWindow: track.nextWindow || null,
    }))
    .sort((left, right) =>
      (right.measuredPackets ? right.avgScore : 0) - (left.measuredPackets ? left.avgScore : 0) ||
      right.traffic7d - left.traffic7d,
    );
  return ranked[0] || null;
}

function buildLanguageMixDecision(languageTracks = {}) {
  const tracks = Array.isArray(languageTracks.tracks) ? languageTracks.tracks : [];
  const en = tracks.find((track) => track.id === "en") || {};
  const zh = tracks.find((track) => track.id === "zh") || {};
  const enScore = Number(en.avgScore) || 0;
  const zhScore = Number(zh.avgScore) || 0;
  const enSamples = Number(en.measuredPackets) || 0;
  const zhSamples = Number(zh.measuredPackets) || 0;
  const primary = !zhSamples || (enSamples && enScore >= zhScore * 0.9) ? "en" : "zh";
  const confidence = enSamples + zhSamples >= 8 ? "measured" : enSamples + zhSamples >= 3 ? "early" : "low_samples";
  return {
    generatedAt: languageTracks.generatedAt || new Date().toISOString(),
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    primary,
    confidence,
    recommendation: primary === "en"
      ? "Keep English as the main growth rail; use Chinese as a focused support rail unless ZH starts outperforming."
      : "Chinese is outperforming in cached data; keep one EN packet for global reach and prioritize ZH follow-ups.",
    targets: {
      en: languageDailyTarget("en"),
      zh: languageDailyTarget("zh"),
    },
    scores: {
      en: Number(enScore.toFixed(1)),
      zh: Number(zhScore.toFixed(1)),
      enSamples,
      zhSamples,
    },
  };
}

function topLearnedHashtags(insights, limit = 4) {
  return Object.entries(insights?.tags || {})
    .map(([name, bucket]) => ({
      name,
      avgScore: Number(bucket?.avgScore) || 0,
      samples: Number(bucket?.count) || 0,
    }))
    .filter((item) => item.samples >= Math.max(1, Number(insights?.minSamples) || 1))
    .sort((left, right) => right.avgScore - left.avgScore)
    .slice(0, limit);
}

function buildLowCostExperimentPlan({ insights, experimentPlan, languageTracks, now = new Date().toISOString() }) {
  const formats = (experimentPlan?.recommendedFormats || []).slice(0, 2);
  const tags = topLearnedHashtags(insights, 4);
  const languagePrimary = buildLanguageMixDecision(languageTracks).primary;
  const arms = [
    {
      id: "hook_format",
      label: "Hook format A/B",
      armA: formats[0]?.id || "operator_pain",
      armB: formats[1]?.id || "decision_rule",
      metric: "24h score + replies",
      nextAction: "Alternate the first line pattern inside the same language rail; do not add X reads.",
    },
    {
      id: "hashtag_pair",
      label: "Hashtag pair A/B",
      armA: tags.slice(0, 2).map((tag) => `#${tag.name}`).join(" ") || "#AI #DevTools",
      armB: tags.slice(2, 4).map((tag) => `#${tag.name}`).join(" ") || "#BigTech #Cloud",
      metric: "24h traffic and ACK rate",
      nextAction: "Keep exactly two tags; rotate only when the story fits.",
    },
    {
      id: "language_mix",
      label: "Language mix guard",
      armA: languagePrimary === "en" ? "EN primary" : "ZH primary",
      armB: "1 EN + 1 ZH control",
      metric: "72h active-conversion proxy",
      nextAction: "Do not increase volume yet; compare rails with the same daily cap.",
    },
  ];
  return {
    generatedAt: now,
    mode: "zero_read_low_cost_ab",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    cadence: "use existing scheduled slots only",
    arms,
  };
}

function buildTodayGrowthDecision({
  state,
  insights,
  usage,
  budgetState,
  languageTracks,
  cadence,
  opportunities,
  experimentPlan,
  now = new Date().toISOString(),
}) {
  const languageMix = buildLanguageMixDecision(languageTracks);
  const primaryTrack = (languageTracks.tracks || []).find((track) => track.id === languageMix.primary);
  const bestTrack = primaryTrack || bestPerformingLanguage(languageTracks) || { id: languageMix.primary, label: languageMix.primary?.toUpperCase() };
  const nextTrack = primaryTrack?.nextWindow
    ? primaryTrack
    : (languageTracks.tracks || [])
    .filter((track) => track.nextWindow)
    .sort((left, right) => Number(left.nextWindow?.hoursFromNow) - Number(right.nextWindow?.hoursFromNow))[0] || bestTrack;
  const projectedTextCost = estimatedPostCost(false);
  const budget = monthlyBudgetUsd();
  const spent = Math.max(Number(usage?.totalEstimatedUsd) || 0, Number(budgetState?.spentUsd) || 0);
  const safeRemaining = budget > 0 ? Math.max(0, budget * budgetSafetyRatio() - spent) : null;
  const canPost = safeRemaining == null || safeRemaining >= projectedTextCost;
  const tags = topLearnedHashtags(insights, 2).map((tag) => `#${tag.name}`);
  const fallbackTags = languageMix.primary === "zh" ? ["#AI", "#DevTools"] : ["#AI", "#BigTech"];
  const selectedTags = (tags.length >= 2 ? tags : fallbackTags).slice(0, 2);
  const route = opportunities?.[0] || null;
  const summary = canPost
    ? `Today: prioritize ${String(bestTrack.id || languageMix.primary || "en").toUpperCase()} at ${nextTrack.nextWindow?.label || "next scheduled slot"}; use ${selectedTags.join(" ")} when story-fit allows.`
    : `Today: skip standalone packets; safe X API budget is too low. Use manual route outputs only.`;
  return {
    generatedAt: now,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    mode: canPost ? "publish_or_route" : "route_only",
    summary,
    primaryLanguage: languageMix.primary,
    nextSlot: nextTrack.nextWindow || null,
    selectedTags,
    canPost,
    budgetSafeRemainingUsd: safeRemaining == null ? null : roundUsd(safeRemaining),
    cadenceReason: cadence?.reason || null,
    nextRoute: route
      ? {
          label: route.label,
          routeLabel: route.routeLabel,
          routeUrl: route.routeUrl,
          draftText: route.draftText || null,
          reason: route.reason || route.evidence || null,
        }
      : null,
    experiment: {
      primaryFormat: experimentPlan?.recommendedFormats?.[0]?.id || null,
      secondaryFormat: experimentPlan?.recommendedFormats?.[1]?.id || null,
    },
  };
}

function buildGrowthDecision({ state, insights, usage, budgetState, languageTracks, cadence, opportunities, experimentPlan, now }) {
  const review24h = buildPacketReviewWindow({ state, insights, hours: 24, now });
  const review72h = buildPacketReviewWindow({ state, insights, hours: 72, now });
  const languageMix = buildLanguageMixDecision(languageTracks);
  const failureStats = buildRunFailureStats(state, now);
  const abPlan = buildLowCostExperimentPlan({ insights, experimentPlan, languageTracks, now });
  const today = buildTodayGrowthDecision({
    state,
    insights,
    usage,
    budgetState,
    languageTracks,
    cadence,
    opportunities,
    experimentPlan,
    now,
  });
  return {
    generatedAt: now,
    mode: "zero_read_growth_decision_layer",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    today,
    review24h,
    review72h,
    languageMix,
    failureStats,
    abPlan,
  };
}

function topDashboardBuckets(buckets, insights, limit = 5) {
  return Object.entries(buckets || {})
    .filter(([, bucket]) => bucket.count >= insights.minSamples)
    .sort((left, right) => right[1].avgScore - left[1].avgScore)
    .slice(0, limit)
    .map(([name, bucket]) => ({
      name,
      avgScore: Number(bucket.avgScore.toFixed(1)),
      samples: bucket.count,
    }));
}

function compactBucketName(name) {
  return String(name || "-").replace(/_/g, " ");
}

function rankedBucketEntries(buckets, { minSamples = 1, excludeUnknown = false } = {}) {
  return Object.entries(buckets || {})
    .filter(([name, bucket]) => {
      if (!bucket || bucket.count < minSamples) return false;
      if (excludeUnknown && (!name || name === "unknown" || name === "-")) return false;
      return true;
    })
    .sort((left, right) => right[1].avgScore - left[1].avgScore);
}

function dashboardLearningBucket(entry) {
  if (!entry) return null;
  const [name, bucket] = entry;
  return {
    name,
    avgScore: Number(bucket.avgScore.toFixed(1)),
    samples: bucket.count,
  };
}

function learningConfidence(insights, bestHook) {
  if ((insights.records || []).length >= 50 && (bestHook?.samples || 0) >= insights.minSamples) {
    return { en: "high confidence", zh: "高置信度" };
  }
  if ((insights.records || []).length >= 10) return { en: "medium confidence", zh: "中等置信度" };
  return { en: "low confidence", zh: "低置信度" };
}

function buildLearningInsights(insights) {
  const templateRows = rankedBucketEntries(insights.templates, {
    minSamples: 1,
    excludeUnknown: true,
  });
  const qualifiedTemplates = templateRows.filter(([, bucket]) => bucket.count >= insights.minSamples);
  const rankedTemplates = qualifiedTemplates.length ? qualifiedTemplates : templateRows;
  const bestHook = dashboardLearningBucket(rankedTemplates[0]);
  const worstEntry = [...templateRows]
    .filter(([name]) => name !== bestHook?.name)
    .sort((left, right) => left[1].avgScore - right[1].avgScore)[0];
  const worstFormat = dashboardLearningBucket(worstEntry);
  const bestSource = dashboardLearningBucket(
    rankedBucketEntries(insights.sources, { minSamples: Math.min(insights.minSamples, 2) })[0],
  );
  const confidence = learningConfidence(insights, bestHook);
  const bestName = compactBucketName(bestHook?.name || "decision_rule");
  const worstName = compactBucketName(worstFormat?.name || "low-confidence formats");
  const sourceName = bestSource?.name || "high-signal tech sources";

  return {
    bestHook,
    worstFormat,
    bestSource,
    confidence: confidence.en,
    confidenceZh: confidence.zh,
    nextExperiment: `Double down on ${bestName} posts from ${sourceName}; avoid ${worstName} unless the take is concrete enough to argue with.`,
    nextExperimentZh: `继续加码 ${bestName}，优先使用 ${sourceName} 这类来源；少用 ${worstName}，除非观点足够具体、能引发讨论。`,
  };
}

function experimentFormatRows(insights) {
  const baseline = Number(insights?.baselineScore) || 0;
  const minSamples = Math.max(1, Number(insights?.minSamples) || 1);
  return configuredContentFormats()
    .map((format, index) => {
      const bucket = insights?.templates?.[format.id] || null;
      const samples = Number(bucket?.count) || 0;
      const avgScore = Number(bucket?.avgScore) || 0;
      const lift = performanceLift(bucket, insights || { minSamples: 999, baselineScore: 0 }, 0.75);
      const sampleRatio = Math.min(1, samples / minSamples);
      const needsSamples = samples < minSamples;
      const underBaseline = samples >= minSamples && baseline > 0 && avgScore < baseline * 0.82;
      const aboveBaseline = samples >= minSamples && (baseline <= 0 || avgScore >= baseline * 1.08);
      const action = needsSamples ? "explore" : underBaseline ? "hold" : aboveBaseline ? "exploit" : "test";
      const priorityScore = lift * 100 + sampleRatio * 12 + (needsSamples ? 4 : 0) - index * 0.01;
      return {
        id: format.id,
        label: format.label,
        action,
        avgScore: Number(avgScore.toFixed(1)),
        samples,
        lift: Number(lift.toFixed(3)),
        priorityScore: Number(priorityScore.toFixed(2)),
        reason:
          action === "explore"
            ? `Needs ${Math.max(0, minSamples - samples)} more sample(s) before the bot trusts it.`
            : action === "hold"
              ? `Under baseline ${formatNumber(baseline, 1)}; use only when the story strongly fits.`
              : action === "exploit"
                ? `Above baseline ${formatNumber(baseline, 1)} with enough samples.`
                : `Near baseline; keep in controlled rotation.`,
      };
    })
    .sort((left, right) => {
      const actionRank = { exploit: 0, test: 1, explore: 2, hold: 3 };
      if (actionRank[left.action] !== actionRank[right.action]) {
        return actionRank[left.action] - actionRank[right.action];
      }
      return right.priorityScore - left.priorityScore;
    });
}

function buildExperimentPlan({ insights, usage, budgetState } = {}) {
  const requestedSlots = integerEnv("DASHBOARD_EXPERIMENT_POST_SLOTS", 3, 1, 12);
  const exploreRate = numberEnv("DASHBOARD_EXPERIMENT_EXPLORE_RATE", 0.25, 0, 0.8);
  const rows = experimentFormatRows(insights || { templates: {}, minSamples: 2, baselineScore: 0 });
  const apiCap = monthlyBudgetUsd();
  const safeCap = apiCap * budgetSafetyRatio();
  const trackedSpend = Number(usage?.totalEstimatedUsd ?? budgetState?.spentUsd) || 0;
  const textCost = estimatedPostCost(false);
  const remaining = apiCap > 0 ? Math.max(0, safeCap - trackedSpend) : null;
  const budgetSafeSlots =
    remaining == null || textCost <= 0
      ? requestedSlots
      : Math.max(0, Math.min(requestedSlots, Math.floor(remaining / textCost)));
  const exploreSlots = budgetSafeSlots > 1 ? Math.min(Math.max(1, Math.round(budgetSafeSlots * exploreRate)), budgetSafeSlots) : 0;
  const exploitSlots = Math.max(0, budgetSafeSlots - exploreSlots);
  const exploitPool = rows.filter((row) => row.action === "exploit" || row.action === "test");
  const explorePool = rows.filter((row) => row.action === "explore");
  const recommended = [
    ...exploitPool.slice(0, exploitSlots),
    ...explorePool.slice(0, exploreSlots),
  ];
  while (recommended.length < budgetSafeSlots) {
    const next = rows.find((row) => !recommended.some((item) => item.id === row.id) && row.action !== "hold");
    if (!next) break;
    recommended.push(next);
  }

  return {
    slots: requestedSlots,
    budgetSafeSlots,
    exploreSlots,
    exploitSlots,
    textPostCostUsd: roundUsd(textCost),
    safeRemainingUsd: remaining == null ? null : roundUsd(remaining),
    baselineScore: Number((Number(insights?.baselineScore) || 0).toFixed(1)),
    minSamples: Number(insights?.minSamples) || 0,
    recommendedFormats: recommended.map((row, index) => ({
      slot: index + 1,
      id: row.id,
      label: row.label,
      action: row.action,
      avgScore: row.avgScore,
      samples: row.samples,
      reason: row.reason,
    })),
    rows: rows.slice(0, 8).map((row) => ({
      id: row.id,
      label: row.label,
      action: row.action,
      avgScore: row.avgScore,
      samples: row.samples,
      lift: row.lift,
      reason: row.reason,
    })),
    holdFormats: rows
      .filter((row) => row.action === "hold")
      .slice(0, 3)
      .map((row) => ({ id: row.id, label: row.label, avgScore: row.avgScore, samples: row.samples })),
    decision: budgetSafeSlots <= 0
      ? "Budget guard blocks new post experiments; keep manual route ops only."
      : `Run ${budgetSafeSlots} post experiment(s): ${recommended.map((row) => row.id).join(", ") || "manual route ops only"}.`,
  };
}

function bucketScore(bucket, insights) {
  const avg = Number(bucket?.avgScore) || 0;
  const baseline = Math.max(1, Number(insights?.baselineScore) || 0);
  const samples = Number(bucket?.count) || 0;
  const sampleFactor = Math.min(1, samples / Math.max(1, Number(insights?.minSamples) || 1));
  return Number(Math.max(0, avg * (0.72 + sampleFactor * 0.28) + (avg - baseline) * 0.35).toFixed(1));
}

function opportunityConfidence(bucket, insights) {
  const samples = Number(bucket?.count) || 0;
  if (samples >= Math.max(6, insights.minSamples * 3)) return "high";
  if (samples >= insights.minSamples) return "medium";
  return "low";
}

function opportunityEvidence(bucket, prefix) {
  if (!bucket) return prefix;
  return `${prefix}: avg ${formatNumber(bucket.avgScore, 1)}, n=${bucket.count}`;
}

function searchActionForOpportunity(actions, preferredIndex = 0) {
  return actions[Math.min(Math.max(0, preferredIndex), Math.max(0, actions.length - 1))] || actions[0] || null;
}

function buildMissionOperatorProtocol({ mission, index, dailyReplyTarget }) {
  const targetReplies = Number(mission?.targetReplies) || Math.max(1, Math.ceil((Number(dailyReplyTarget) || 3) / 3));
  const slaMinutes = Number(mission?.operatorSlaMinutes) || 10 + index * 10;
  const routeLabel = mission?.routeLabel || mission?.label || `Route ${index + 1}`;
  return {
    mode: "manual_zero_read_route_loop",
    zeroExtraXReads: true,
    objective: `Borrow live distribution from ${routeLabel} without spending X search/read API budget.`,
    steps: [
      {
        id: "open",
        label: "open.route",
        detail: `Open the X web route and sort by live recency; do not call X search/read API.`,
      },
      {
        id: "filter",
        label: "filter.thread",
        detail: "Pick a technical conversation with visible exchange, clear topic fit, and preferably less than 2h age.",
      },
      {
        id: "paste",
        label: "paste.output",
        detail: `Paste ${targetReplies} useful route op${targetReplies === 1 ? "" : "s"} within ${slaMinutes} minutes; edit only for factual fit.`,
      },
      {
        id: "observe",
        label: "observe.feedback",
        detail: "Stop after the target count; let the next metrics refresh write engagement back into the learning layer.",
      },
    ],
    stopConditions: [
      "Stop immediately if the thread is political, giveaway-driven, ragebait, or unrelated to tech.",
      "Stop if the output would require a claim the source story does not support.",
      "Stop after the target route ops; do not chase every adjacent thread.",
    ],
    writeback: "Next growth maintenance run refreshes metrics and updates format/source/topic scoring.",
  };
}

function compactOpportunityTitle(value, maxLength = 86) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function trendOpportunityReplyDraft(item, fallbackDraft) {
  if (!item?.title && fallbackDraft?.text) return fallbackDraft.text;
  const title = compactOpportunityTitle(item?.title || "this tech shift", 74);
  const segment = item?.audienceLabel ? ` for ${item.audienceLabel}` : "";
  const text = `On ${title}: the useful question is whether this changes a default workflow${segment}. If yes, the winner is whoever owns distribution, fallback risk, and switching cost.`;
  return text.length <= 260 ? text : `On ${title}: the useful question is whether this changes a default workflow. If yes, watch distribution, fallback risk, and switching cost.`;
}

function trendOpportunityScore(item, insights) {
  const baseline = Math.max(1, Number(insights?.baselineScore) || 1);
  const velocity = Number(item?.velocityScore) || 0;
  const stageBoost = item?.stage === "breakout" ? 1.4 : item?.stage === "rising" ? 0.8 : item?.stage === "early" ? 0.35 : 0;
  return Number(Math.max(baseline + 0.4, Math.min(12, velocity / 10 + stageBoost)).toFixed(1));
}

function trendVelocityOpportunities({ state, drafts, insights }) {
  const radarItems = Array.isArray(state?.trendVelocityRadar?.items) ? state.trendVelocityRadar.items : [];
  const availableDrafts = Array.isArray(drafts) ? drafts : [];
  const count = integerEnv("DASHBOARD_TREND_OPPORTUNITY_COUNT", 2, 0, 5);
  const minVelocity = numberEnv("DASHBOARD_TREND_OPPORTUNITY_MIN_VELOCITY", 50, 0, 100);
  if (!count || !radarItems.length) return [];

  return radarItems
    .filter((item) => item?.routeUrl && (Number(item.velocityScore) >= minVelocity || ["breakout", "rising"].includes(item.stage)))
    .slice(0, count)
    .map((item, index) => {
      const fallbackDraft = availableDrafts[Math.min(index, Math.max(0, availableDrafts.length - 1))] || availableDrafts[0] || null;
      const score = trendOpportunityScore(item, insights);
      const age = item.ageHours === null || item.ageHours === undefined ? "unknown age" : `${formatNumber(item.ageHours, 1)}h old`;
      const title = compactOpportunityTitle(item.title || "Untitled trend", 72);
      return {
        id: `trend:${item.rank || index + 1}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "topic"}`,
        label: `Velocity route: ${title}`,
        kind: "trend",
        priority: index + 1,
        score,
        confidence: item.stage === "breakout" || item.stage === "rising" ? "high" : "medium",
        routeLabel: `${item.stage || "watch"} X route`,
        routeUrl: item.routeUrl,
        draftIndex: index,
        draftText: trendOpportunityReplyDraft(item, fallbackDraft),
        draftAngle: item.replyAngle || fallbackDraft?.angle || "",
        reason: item.routeReason || "RSS velocity flagged this topic; open X web search and paste one useful manual route op under a live conversation.",
        evidence: `velocity ${formatNumber(item.velocityScore, 1)}, ${age}, ${formatNumber(item.echoes)} echoes, ${item.source || "RSS"}`,
        zeroExtraXReads: true,
        source: item.source || null,
        stage: item.stage || "watch",
      };
    });
}

function buildDashboardOpportunities({ insights, drafts, actions, state }) {
  const learning = buildLearningInsights(insights);
  const templateEntry = rankedBucketEntries(insights.templates, { minSamples: 1, excludeUnknown: true })[0] || null;
  const sourceEntry = rankedBucketEntries(insights.sources, { minSamples: Math.min(insights.minSamples, 2) })[0] || null;
  const tagEntry = rankedBucketEntries(insights.tags, { minSamples: Math.min(insights.minSamples, 2), excludeUnknown: true })[0] || null;
  const topPost = recordsSince(state, 24 * 7)[0] || null;
  const primaryAction = searchActionForOpportunity(actions, 0);
  const aiAction = searchActionForOpportunity(actions, 1);
  const broadAction = searchActionForOpportunity(actions, 2);
  const opportunities = [];
  opportunities.push(...trendVelocityOpportunities({ state, drafts, insights }));

  const pushOpportunity = ({
    id,
    label,
    kind,
    action,
    draftIndex = 0,
    bucket = null,
    reason,
    evidence,
  }) => {
    if (!label || !action) return;
    const draft = drafts[Math.min(Math.max(0, draftIndex), Math.max(0, drafts.length - 1))] || drafts[0] || null;
    const score = bucket ? bucketScore(bucket, insights) : Number((Number(topPost ? recordGrowthScore(topPost) : insights.baselineScore) || 0).toFixed(1));
    opportunities.push({
      id,
      label,
      kind,
      priority: opportunities.length + 1,
      score,
      confidence: bucket ? opportunityConfidence(bucket, insights) : learning.confidence,
      routeLabel: action.label,
      routeUrl: action.url,
      draftIndex,
      draftText: draft?.text || "",
      draftAngle: draft?.angle || "",
      reason,
      evidence,
      zeroExtraXReads: true,
    });
  };

  if (templateEntry) {
    const [name, bucket] = templateEntry;
    pushOpportunity({
      id: `template:${name}`,
      label: `${compactBucketName(name)} replies`,
      kind: "format",
      action: primaryAction,
      draftIndex: 0,
      bucket,
      reason: `Reuse the current winning format and paste it under active high-signal tech conversations.`,
      evidence: opportunityEvidence(bucket, "format"),
    });
  }

  if (sourceEntry) {
    const [name, bucket] = sourceEntry;
    pushOpportunity({
      id: `source:${name}`,
      label: `Source watch: ${name}`,
      kind: "source",
      action: aiAction,
      draftIndex: 1,
      bucket,
      reason: `Stories from this source have outperformed baseline; look for fresh related discussions before posting more standalone takes.`,
      evidence: opportunityEvidence(bucket, "source"),
    });
  }

  if (tagEntry) {
    const [name, bucket] = tagEntry;
    pushOpportunity({
      id: `topic:${name}`,
      label: `Topic route: #${name}`,
      kind: "topic",
      action: broadAction,
      draftIndex: 2,
      bucket,
      reason: `This topic has enough historical signal to deserve a manual distribution pass today.`,
      evidence: opportunityEvidence(bucket, "topic"),
    });
  }

  if (topPost) {
    pushOpportunity({
      id: `post:${topPost.id || "top"}`,
      label: `Follow-up window: ${compactBucketName(topPost.templateId || "best post")}`,
      kind: "follow_up",
      action: primaryAction,
      draftIndex: 3,
      reason: `Use the best recent post as the angle anchor, then join adjacent conversations instead of repeating the same main post.`,
      evidence: `top post score ${formatNumber(recordGrowthScore(topPost), 1)} from ${topPost.newsSource || "unknown source"}`,
    });
  }

  return opportunities
    .sort((left, right) => right.score - left.score)
    .slice(0, integerEnv("DASHBOARD_OPPORTUNITY_COUNT", 4, 1, 8))
    .map((item, index) => ({ ...item, priority: index + 1 }));
}

function operatorFollowerOverride() {
  const raw = optionalEnv("TWEET_FOLLOWERS_OVERRIDE");
  if (!raw) return null;
  const followers = Number(raw);
  if (!Number.isFinite(followers) || followers < 0) return null;
  return Math.trunc(followers);
}

function latestFollowerCount(state) {
  const override = operatorFollowerOverride();
  if (override != null) return override;
  const latestSnapshot = (state.accountSnapshots || [])[state.accountSnapshots.length - 1] || null;
  const followers = Number(latestSnapshot?.publicMetrics?.followers_count);
  return Number.isFinite(followers) ? followers : null;
}

function ensureOperatorFollowerSnapshot(state, now = new Date()) {
  const override = operatorFollowerOverride();
  if (override == null) return state;
  const snapshots = Array.isArray(state?.accountSnapshots) ? [...state.accountSnapshots] : [];
  const latest = snapshots[snapshots.length - 1] || null;
  const latestFollowers = Number(latest?.publicMetrics?.followers_count);
  const checkedAt = now instanceof Date ? now.toISOString() : new Date(now || Date.now()).toISOString();
  if (Number.isFinite(latestFollowers) && latestFollowers === override && latest?.source === "operator_confirmed") {
    return state;
  }
  snapshots.push({
    checkedAt,
    userId: latest?.userId || null,
    username: latest?.username || null,
    source: "operator_confirmed",
    publicMetrics: {
      ...(latest?.publicMetrics || {}),
      followers_count: override,
    },
  });
  return {
    ...state,
    accountSnapshots: snapshots.slice(-integerEnv("TWEET_ACCOUNT_SNAPSHOT_MAX", 60, 5, 365)),
  };
}

function nextFollowerMilestone(current, target) {
  const milestones = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
  return milestones.find((milestone) => milestone > current) || target;
}

function buildGrowthGoal(state) {
  const currentFollowers = latestFollowerCount(state);
  const fallbackTarget = Math.max(1000, (currentFollowers || 0) + 1);
  const targetFollowers = integerEnv("DASHBOARD_TARGET_FOLLOWERS", fallbackTarget, 1, 1000000);
  const dailyReplies = integerEnv("DASHBOARD_DAILY_REPLY_TARGET", 3, 1, 20);
  const dailyPosts = integerEnv("DASHBOARD_DAILY_POST_TARGET", 1, 1, 10);
  const current = currentFollowers || 0;
  return {
    targetFollowers,
    currentFollowers,
    nextMilestone: Math.min(targetFollowers, nextFollowerMilestone(current, targetFollowers)),
    dailyReplies,
    dailyPosts,
  };
}

function roundUsd(value) {
  return Number((Number(value) || 0).toFixed(3));
}

function dayStartMs(date = new Date()) {
  return Date.parse(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function utcDayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function chartPointLabel(startMs, bucketMs, index, mode) {
  const start = new Date(startMs + bucketMs * index);
  if (mode === "day") return start.toISOString().slice(0, 10);
  return start.toISOString().slice(11, 16);
}

function tweetMetricSeries(records, { hours, buckets, metricKey, mode = "time", now = Date.now() } = {}) {
  const nowMs = timestampMs(now);

  if (mode === "day") {
    const lastDay = utcDayStamp(nowMs);
    const firstDay = utcDayStamp(nowMs - hours * 60 * 60 * 1000);
    const firstStartMs = Date.parse(`${firstDay}T00:00:00.000Z`);
    const lastStartMs = Date.parse(`${lastDay}T00:00:00.000Z`);
    const dayCount = Math.max(1, Math.round((lastStartMs - firstStartMs) / 86400000) + 1);
    const points = Array.from({ length: dayCount }, (_, index) => {
      const dayStartMs = firstStartMs + index * 86400000;
      const day = utcDayStamp(dayStartMs);
      return {
        index,
        startsAt: `${day}T00:00:00.000Z`,
        endsAt: new Date(dayStartMs + 86400000).toISOString(),
        label: day,
        value: 0,
        posts: 0,
      };
    });
    const byDay = new Map(points.map((point) => [point.label, point]));
    for (const record of records || []) {
      const postedAt = Date.parse(record.postedAt || "");
      if (!Number.isFinite(postedAt) || postedAt > nowMs) continue;
      const day = utcDayStamp(postedAt);
      const point = byDay.get(day) || (postedAt < firstStartMs ? points[0] : null);
      if (!point) continue;
      point.value += metricValue(record, metricKey);
      point.posts += 1;
    }
    return points;
  }

  const startMs = nowMs - hours * 60 * 60 * 1000;
  const bucketMs = Math.max(1, (nowMs - startMs) / buckets);
  const points = Array.from({ length: buckets }, (_, index) => ({
    index,
    startsAt: new Date(startMs + bucketMs * index).toISOString(),
    endsAt: new Date(startMs + bucketMs * (index + 1)).toISOString(),
    label: chartPointLabel(startMs, bucketMs, index, mode),
    value: 0,
    posts: 0,
  }));

  for (const record of records || []) {
    const postedAt = Date.parse(record.postedAt || "");
    if (!Number.isFinite(postedAt) || postedAt < startMs || postedAt > nowMs) continue;
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((postedAt - startMs) / bucketMs)));
    points[index].value += metricValue(record, metricKey);
    points[index].posts += 1;
  }

  return points;
}

function utcHourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function hourDelta(fromHour, toHour) {
  return (toHour - fromHour + 24) % 24;
}

function buildHourlyLoadBalancer({ state = null, insights = null, now = new Date().toISOString() } = {}) {
  const nowDate = new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();
  const currentHour = new Date(nowMs).getUTCHours();
  const lookbackDays = integerEnv("TWEET_HOURLY_LOAD_DAYS", 30, 3, 180);
  const minSamples = integerEnv("TWEET_HOURLY_LOAD_MIN_SAMPLES", Math.max(2, Number(insights?.minSamples) || 2), 1, 24);
  const cutoff = nowMs - lookbackDays * 24 * 60 * 60 * 1000;
  const sourceRecords = Array.isArray(insights?.records) && insights.records.length
    ? insights.records
    : (state?.tweets || []).filter((record) => latestTweetSnapshot(record));
  const records = sourceRecords.filter((record) => {
    const postedAt = Date.parse(record?.postedAt || "");
    return Number.isFinite(postedAt) && postedAt >= cutoff && postedAt <= nowMs;
  });
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: utcHourLabel(hour),
    posts: 0,
    impressions: 0,
    likes: 0,
    reposts: 0,
    replies: 0,
    scoreTotal: 0,
    avgScore: 0,
    loadScore: 0,
    status: "dark",
    current: hour === currentHour,
  }));

  for (const record of records) {
    const postedAt = Date.parse(record.postedAt || "");
    const hour = new Date(postedAt).getUTCHours();
    const bucket = buckets[hour];
    bucket.posts += 1;
    bucket.impressions += metricValue(record, "impression_count");
    bucket.likes += metricValue(record, "like_count");
    bucket.reposts += metricValue(record, "retweet_count");
    bucket.replies += metricValue(record, "reply_count");
    bucket.scoreTotal += recordGrowthScore(record);
  }

  const maxImpressions = Math.max(1, ...buckets.map((bucket) => bucket.impressions));
  const maxScore = Math.max(1, ...buckets.map((bucket) => bucket.posts ? bucket.scoreTotal / bucket.posts : 0));
  const baselineScore = Math.max(1, Number(insights?.baselineScore) || 0);
  for (const bucket of buckets) {
    bucket.avgScore = bucket.posts ? bucket.scoreTotal / bucket.posts : 0;
    const impressionNorm = bucket.impressions / maxImpressions;
    const scoreNorm = bucket.avgScore / maxScore;
    const liftNorm = Math.max(0, Math.min(1.25, bucket.avgScore / baselineScore)) / 1.25;
    const sampleNorm = Math.min(1, bucket.posts / minSamples);
    bucket.loadScore = boundedPercent(
      bucket.posts
        ? 8 + impressionNorm * 34 + scoreNorm * 28 + liftNorm * 18 + sampleNorm * 12
        : 0,
    );
    bucket.status = bucket.loadScore >= 75
      ? "hot"
      : bucket.loadScore >= 52
        ? "warm"
        : bucket.loadScore >= 20
          ? "cool"
          : "dark";
    bucket.avgScore = Number(bucket.avgScore.toFixed(1));
    bucket.loadScore = Number(bucket.loadScore.toFixed(1));
    delete bucket.scoreTotal;
  }

  const rankedHours = [...buckets]
    .filter((bucket) => bucket.posts > 0)
    .sort((left, right) => right.loadScore - left.loadScore || right.avgScore - left.avgScore || right.impressions - left.impressions);
  const bestHours = rankedHours.slice(0, 4).map((bucket) => ({
    hour: bucket.hour,
    label: bucket.label,
    loadScore: bucket.loadScore,
    posts: bucket.posts,
    impressions: bucket.impressions,
    avgScore: bucket.avgScore,
    status: bucket.status,
  }));
  const viableHours = rankedHours.filter((bucket) => bucket.loadScore >= numberEnv("TWEET_HOURLY_LOAD_WARM_SCORE", 52, 0, 100));
  const nextWindow = (viableHours.length ? viableHours : rankedHours)
    .map((bucket) => ({ ...bucket, hoursFromNow: hourDelta(currentHour, bucket.hour) }))
    .sort((left, right) => left.hoursFromNow - right.hoursFromNow || right.loadScore - left.loadScore)[0] || null;
  const currentBucket = buckets[currentHour];
  const maxWaitHours = numberEnv("TWEET_CADENCE_MAX_WAIT_FOR_HOT_HOUR", 3, 0, 12);
  const currentIsWarm = currentBucket.loadScore >= numberEnv("TWEET_HOURLY_LOAD_PUBLISH_NOW_SCORE", 55, 0, 100);
  const waitForPeak = Boolean(nextWindow && !currentIsWarm && nextWindow.hoursFromNow > 0 && nextWindow.hoursFromNow <= maxWaitHours);
  const mode = !records.length
    ? "bootstrap"
    : currentIsWarm
      ? "publish_now"
      : waitForPeak
        ? "wait_for_peak"
        : "manual_distribution";
  const confidence = records.length >= Math.max(48, minSamples * 8)
    ? "high"
    : records.length >= Math.max(12, minSamples * 3)
      ? "medium"
      : "low";
  const nextAction = mode === "publish_now"
    ? `Current UTC hour ${currentBucket.label} is inside a learned warm window.`
    : mode === "wait_for_peak"
      ? `Hold the standalone post for ${formatNumber(nextWindow.hoursFromNow, 1)}h until ${nextWindow.label} UTC; use manual route ops now.`
      : mode === "manual_distribution"
        ? `No near-term learned peak; use manual distribution now and schedule the next post near ${bestHours[0]?.label || "the next measured peak"} UTC.`
        : "Not enough hourly samples; publish only when the story is strong and keep collecting telemetry.";

  return {
    generatedAt: now,
    source: "tweet_analytics.postedAt + tweet_metrics",
    lookbackDays,
    sampleCount: records.length,
    minSamples,
    confidence,
    mode,
    zeroExtraXReads: true,
    currentHour: {
      hour: currentBucket.hour,
      label: currentBucket.label,
      loadScore: currentBucket.loadScore,
      posts: currentBucket.posts,
      impressions: currentBucket.impressions,
      avgScore: currentBucket.avgScore,
      status: currentBucket.status,
    },
    nextWindow: nextWindow
      ? {
          hour: nextWindow.hour,
          label: nextWindow.label,
          hoursFromNow: Number(nextWindow.hoursFromNow.toFixed(1)),
          loadScore: nextWindow.loadScore,
          posts: nextWindow.posts,
          impressions: nextWindow.impressions,
          avgScore: nextWindow.avgScore,
          status: nextWindow.status,
        }
      : null,
    bestHours,
    nextAction,
    hours: buckets,
  };
}

function buildTemporalAngleMatrix({
  state = null,
  insights = null,
  adaptiveAngleScheduler = null,
  hourlyLoadBalancer = null,
  now = new Date().toISOString(),
} = {}) {
  const scheduler = adaptiveAngleScheduler || buildAdaptiveAngleScheduler(insights || {}, { state, now });
  const balancer = hourlyLoadBalancer || buildHourlyLoadBalancer({ state, insights, now });
  const lookbackDays = integerEnv("TWEET_TEMPORAL_ANGLE_DAYS", Number(balancer?.lookbackDays) || 30, 3, 180);
  const nowMs = Date.parse(now);
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoff = currentMs - lookbackDays * 24 * 60 * 60 * 1000;
  const sourceRecords = Array.isArray(insights?.records) && insights.records.length
    ? insights.records
    : (state?.tweets || []).filter((record) => latestTweetSnapshot(record));
  const records = sourceRecords.filter((record) => {
    const postedAt = Date.parse(record?.postedAt || "");
    return Number.isFinite(postedAt) && postedAt >= cutoff && postedAt <= currentMs;
  });
  const byHourTemplate = new Map();
  for (const record of records) {
    const postedAt = Date.parse(record.postedAt || "");
    const templateId = record.templateId || "unknown";
    if (!Number.isFinite(postedAt) || !templateId || templateId === "unknown") continue;
    const hour = new Date(postedAt).getUTCHours();
    const key = `${hour}:${templateId}`;
    const bucket = byHourTemplate.get(key) || {
      hour,
      templateId,
      posts: 0,
      impressions: 0,
      likes: 0,
      replies: 0,
      reposts: 0,
      totalScore: 0,
      avgScore: 0,
    };
    bucket.posts += 1;
    bucket.impressions += metricValue(record, "impression_count");
    bucket.likes += metricValue(record, "like_count");
    bucket.replies += metricValue(record, "reply_count");
    bucket.reposts += metricValue(record, "retweet_count");
    bucket.totalScore += recordGrowthScore(record);
    bucket.avgScore = bucket.posts ? bucket.totalScore / bucket.posts : 0;
    byHourTemplate.set(key, bucket);
  }

  const rowMap = new Map();
  for (const slot of scheduler?.nextAngles || []) {
    if (!slot?.formatId) continue;
    rowMap.set(slot.formatId, { ...slot, id: slot.formatId });
  }
  for (const row of experimentFormatRows(insights || { templates: {}, minSamples: 2, baselineScore: 0 })) {
    if (!row?.id || rowMap.has(row.id)) continue;
    rowMap.set(row.id, rowToAngleSlot(row, {
      slot: rowMap.size + 1,
      baselineScore: Number(insights?.baselineScore) || 0,
      mode: scheduler?.mode,
      fallbackReason: row.reason,
    }));
  }
  const candidates = [...rowMap.values()].filter((row) => row?.formatId || row?.id);
  const fallbackWindow = balancer?.currentHour || { hour: new Date(currentMs).getUTCHours(), label: utcHourLabel(new Date(currentMs).getUTCHours()), loadScore: 0, posts: 0, impressions: 0, status: "dark" };
  const windowMap = new Map();
  for (const window of [balancer?.nextWindow, ...(balancer?.bestHours || []), fallbackWindow].filter(Boolean)) {
    const hour = Number(window.hour);
    if (!Number.isFinite(hour) || windowMap.has(hour)) continue;
    windowMap.set(hour, {
      hour,
      label: window.label || utcHourLabel(hour),
      loadScore: Number(window.loadScore) || 0,
      posts: Number(window.posts) || 0,
      impressions: Number(window.impressions) || 0,
      status: window.status || "dark",
      hoursFromNow: Number.isFinite(Number(window.hoursFromNow)) ? Number(window.hoursFromNow) : hourDelta(new Date(currentMs).getUTCHours(), hour),
    });
  }
  const windows = [...windowMap.values()]
    .sort((left, right) => right.loadScore - left.loadScore || left.hoursFromNow - right.hoursFromNow)
    .slice(0, integerEnv("TWEET_TEMPORAL_ANGLE_WINDOWS", 5, 2, 8));
  const baseline = Math.max(1, Number(insights?.baselineScore) || 0);
  const usedFormats = new Set();
  const slots = windows.map((window, index) => {
    const ranked = candidates
      .map((candidate, candidateIndex) => {
        const formatId = candidate.formatId || candidate.id;
        const bucket = byHourTemplate.get(`${window.hour}:${formatId}`) || null;
        const avgScore = Number(bucket?.avgScore ?? candidate.avgScore ?? 0) || 0;
        const sampleBoost = bucket ? Math.min(14, bucket.posts * 4) : candidate.action === "explore" ? 5 : 0;
        const impressionBoost = bucket ? Math.min(14, bucket.impressions / Math.max(8, window.impressions || 8) * 14) : 0;
        const liftBoost = avgScore > 0 ? Math.max(-16, Math.min(22, ((avgScore - baseline) / baseline) * 24)) : 0;
        const actionBoost = { exploit: 10, test: 4, explore: 1, hold: -26 }[candidate.action] || 2;
        const repeatPenalty = usedFormats.has(formatId) ? 8 : 0;
        const score = boundedPercent(
          window.loadScore * 0.38 +
          (Number(candidate.weight) || 45) * 0.38 +
          sampleBoost +
          impressionBoost +
          liftBoost +
          actionBoost -
          repeatPenalty -
          candidateIndex * 0.04,
        );
        return { candidate, bucket, score };
      })
      .sort((left, right) => right.score - left.score);
    const best = ranked[0] || { candidate: candidates[index % Math.max(1, candidates.length)] || {}, bucket: null, score: window.loadScore };
    const candidate = best.candidate || {};
    const formatId = candidate.formatId || candidate.id || "decision_rule";
    usedFormats.add(formatId);
    const config = ANGLE_LIBRARY[formatId] || {};
    return {
      slot: index + 1,
      hour: window.hour,
      windowLabel: window.label,
      hoursFromNow: Number(window.hoursFromNow.toFixed(1)),
      loadScore: Number(window.loadScore.toFixed(1)),
      formatId,
      label: candidate.label || config.label || compactBucketName(formatId),
      angle: candidate.angle || config.angle || `${compactBucketName(formatId)} angle`,
      action: candidate.action || "test",
      status: best.score >= 76 ? "hot" : best.score >= 58 ? "watch" : candidate.status || "probe",
      score: Number(best.score.toFixed(1)),
      avgScore: Number(Number(best.bucket?.avgScore ?? candidate.avgScore ?? 0).toFixed(1)),
      samples: Number(best.bucket?.posts ?? candidate.samples ?? 0) || 0,
      impressions: Number(best.bucket?.impressions ?? 0) || 0,
      reason: best.bucket
        ? `${formatId} has ${formatNumber(best.bucket.posts)} sample(s) in this UTC hour with avg score ${formatNumber(best.bucket.avgScore, 1)}.`
        : `No hour-specific sample yet; routed from adaptive scheduler weight ${formatNumber(candidate.weight, 1)}.`,
    };
  });
  const confidence = records.length >= 48 && slots.some((slot) => slot.samples >= Math.max(1, Number(insights?.minSamples) || 2))
    ? "high"
    : records.length >= 12
      ? "medium"
      : "low";
  const first = slots[0] || null;
  const mode = balancer?.mode === "wait_for_peak"
    ? "peak_angle_wait"
    : scheduler?.mode === "surge_exploit"
      ? "surge_angle_exploit"
      : "temporal_rotation";

  return {
    generatedAt: now,
    mode,
    confidence,
    source: "cached tweet analytics only",
    zeroExtraXReads: true,
    lookbackDays,
    sampleCount: records.length,
    nextAction: first
      ? `Use ${first.label} at ${first.windowLabel} UTC; ${first.reason}`
      : "Keep collecting analytics before trusting temporal angle routing.",
    slots,
  };
}

function buildTopicTimingRouter({
  insights = null,
  hourlyLoadBalancer = null,
  temporalAngleMatrix = null,
  contentBanditAllocator = null,
  narrativeResonanceController = null,
  now = new Date().toISOString(),
} = {}) {
  const records = Array.isArray(insights?.records) ? insights.records : [];
  const baseline = Math.max(1, Number(insights?.baselineScore) || 0);
  const minSamples = Math.max(1, Number(insights?.minSamples) || 2);
  const currentHour = new Date(Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now()).getUTCHours();
  const windowMap = new Map();
  for (const window of [
    hourlyLoadBalancer?.nextWindow,
    ...(hourlyLoadBalancer?.bestHours || []),
    ...(temporalAngleMatrix?.slots || []),
    hourlyLoadBalancer?.currentHour,
  ].filter(Boolean)) {
    const hour = Number(window.hour);
    if (!Number.isFinite(hour) || windowMap.has(hour)) continue;
    windowMap.set(hour, {
      hour,
      windowLabel: window.windowLabel || window.label || utcHourLabel(hour),
      hoursFromNow: Number.isFinite(Number(window.hoursFromNow)) ? Number(window.hoursFromNow) : hourDelta(currentHour, hour),
      loadScore: Number(window.loadScore) || 0,
      status: window.status || "watch",
      posts: Number(window.posts) || Number(window.samples) || 0,
      impressions: Number(window.impressions) || 0,
    });
  }
  if (!windowMap.size) {
    windowMap.set(currentHour, {
      hour: currentHour,
      windowLabel: utcHourLabel(currentHour),
      hoursFromNow: 0,
      loadScore: 0,
      status: "watch",
      posts: 0,
      impressions: 0,
    });
  }

  const pillarMap = new Map();
  for (const pillar of narrativeResonanceController?.pillars || []) {
    if (pillar?.id) pillarMap.set(pillar.id, pillar);
  }
  for (const definition of narrativePillarDefinitions()) {
    if (!pillarMap.has(definition.id)) {
      pillarMap.set(definition.id, {
        ...definition,
        score: 18,
        samples: 0,
        avgScore: 0,
        sharePct: 0,
        targetSharePct: Number(definition.targetShare || 0) * 100,
        status: definition.id === FALLBACK_NARRATIVE_PILLAR.id ? "watch" : "probe",
      });
    }
  }
  const pillars = [...pillarMap.values()].filter((pillar) => pillar.id !== FALLBACK_NARRATIVE_PILLAR.id || pillar.samples > 0);

  const formatMap = new Map();
  for (const lane of contentBanditAllocator?.lanes || []) {
    if (!lane?.id) continue;
    formatMap.set(lane.id, {
      id: lane.id,
      label: lane.label || compactBucketName(lane.id),
      status: lane.status || lane.action || "test",
      score: Number(lane.allocationScore ?? lane.avgScore ?? 0) || 0,
      allocationPct: Number(lane.allocationPct) || 0,
      samples: Number(lane.samples) || 0,
    });
  }
  for (const slot of temporalAngleMatrix?.slots || []) {
    const id = slot?.formatId || slot?.id;
    if (!id || formatMap.has(id)) continue;
    formatMap.set(id, {
      id,
      label: slot.label || compactBucketName(id),
      status: slot.action || slot.status || "test",
      score: Number(slot.score) || 0,
      allocationPct: 0,
      samples: Number(slot.samples) || 0,
    });
  }
  if (!formatMap.size) {
    formatMap.set("decision_rule", {
      id: "decision_rule",
      label: compactBucketName("decision_rule"),
      status: "test",
      score: baseline,
      allocationPct: 0,
      samples: 0,
    });
  }
  const formats = [...formatMap.values()].slice(0, 8);

  const buckets = new Map();
  for (const record of records) {
    const postedAt = Date.parse(record?.postedAt || "");
    if (!Number.isFinite(postedAt)) continue;
    const hour = new Date(postedAt).getUTCHours();
    const pillar = primaryNarrativePillar(record);
    const formatId = record.templateId || record.template || record.formatId || "unknown";
    const key = `${hour}:${pillar.id}:${formatId}`;
    const bucket = buckets.get(key) || {
      hour,
      pillarId: pillar.id,
      formatId,
      samples: 0,
      impressions: 0,
      engagements: 0,
      scoreTotal: 0,
    };
    bucket.samples += 1;
    bucket.impressions += metricValue(record, "impression_count");
    bucket.engagements +=
      metricValue(record, "like_count") +
      metricValue(record, "retweet_count") +
      metricValue(record, "quote_count") +
      metricValue(record, "reply_count") +
      metricValue(record, "bookmark_count");
    bucket.scoreTotal += recordGrowthScore(record);
    buckets.set(key, bucket);
  }

  const priority = { exploit: 5, expand: 4, hot: 4, probe: 3, explore: 3, watch: 2, test: 2, hold: -2, regret: -2 };
  const lanes = [];
  for (const window of [...windowMap.values()].slice(0, 6)) {
    for (const pillar of pillars.slice(0, 6)) {
      for (const format of formats.slice(0, 6)) {
        const bucket = buckets.get(`${window.hour}:${pillar.id}:${format.id}`) || null;
        const avgScore = bucket?.samples ? bucket.scoreTotal / bucket.samples : Number(pillar.avgScore) || 0;
        const engagementRate = bucket?.impressions ? (bucket.engagements / bucket.impressions) * 100 : Number(pillar.engagementRate) || 0;
        const observedBoost = bucket
          ? Math.min(22, bucket.samples * 5 + Math.min(12, bucket.impressions / Math.max(8, window.impressions || 8) * 12))
          : 0;
        const liftBoost = avgScore > 0 ? Math.max(-16, Math.min(20, ((avgScore - baseline) / baseline) * 18)) : 0;
        const underShareBoost = Number(pillar.targetSharePct) > 0 && Number(pillar.sharePct) < Number(pillar.targetSharePct) * 0.75 ? 5 : 0;
        const statusBoost = (priority[pillar.status] || 0) * 3 + (priority[format.status] || 0) * 2;
        const score = boundedPercent(
          10 +
            Number(window.loadScore || 0) * 0.26 +
            Number(pillar.score || 0) * 0.34 +
            Math.min(20, Number(format.score || format.allocationPct || 0) * 0.2 + Number(format.allocationPct || 0) * 0.12) +
            Math.min(12, engagementRate * 2.5) +
            observedBoost +
            liftBoost +
            underShareBoost +
            statusBoost,
        );
        lanes.push({
          id: `${window.hour}:${pillar.id}:${format.id}`,
          hour: window.hour,
          windowLabel: window.windowLabel,
          hoursFromNow: Number(Number(window.hoursFromNow || 0).toFixed(1)),
          loadScore: Number(Number(window.loadScore || 0).toFixed(1)),
          pillarId: pillar.id,
          pillarLabel: pillar.label || pillar.id,
          pillarStatus: pillar.status || "watch",
          formatId: format.id,
          formatLabel: format.label || compactBucketName(format.id),
          formatStatus: format.status || "test",
          score: Number(score.toFixed(1)),
          samples: Number(bucket?.samples || 0),
          avgScore: Number(Number(avgScore || 0).toFixed(1)),
          impressions: Number(bucket?.impressions || 0),
          engagementRate: Number(Number(engagementRate || 0).toFixed(2)),
          observed: Boolean(bucket),
          status: score >= 76 ? "hot" : score >= 58 ? "watch" : bucket ? "probe" : "seed",
          directive: `${pillar.directive || "Keep one durable Tech Signals memory."} Use ${format.label || compactBucketName(format.id)} around ${window.windowLabel} UTC.`,
          reason: bucket
            ? `${format.id} x ${pillar.label || pillar.id} has ${formatNumber(bucket.samples)} sample(s) at ${window.windowLabel} UTC with avg ${formatNumber(avgScore, 1)}.`
            : `Seed ${pillar.label || pillar.id} via ${format.label || compactBucketName(format.id)} in a learned ${window.windowLabel} UTC load window.`,
        });
      }
    }
  }

  lanes.sort((left, right) => {
    const statusDelta = (priority[right.status] || 0) - (priority[left.status] || 0);
    if (statusDelta) return statusDelta;
    return right.score - left.score || right.samples - left.samples || left.hoursFromNow - right.hoursFromNow;
  });
  const unique = [];
  const seen = new Set();
  for (const lane of lanes) {
    const key = `${lane.hour}:${lane.pillarId}:${lane.formatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(lane);
    if (unique.length >= 12) break;
  }
  const activeLane = unique[0] || null;
  const routerScore = boundedPercent(
    12 +
      Math.min(44, Number(activeLane?.score || 0) * 0.52) +
      Math.min(20, records.length * 0.45) +
      Math.min(14, unique.filter((lane) => lane.observed).length * 2.5) +
      Math.min(10, unique.filter((lane) => lane.status === "hot").length * 4),
  );
  const severity = routerScore >= 68 ? "ok" : routerScore >= 44 ? "warn" : "danger";
  return {
    generatedAt: now,
    mode: severity === "ok" ? "topic_timing_exploit" : severity === "warn" ? "topic_timing_seed" : "topic_timing_starved",
    severity,
    source: "cached hourly load + narrative resonance + content bandit",
    zeroExtraXReads: true,
    sampleCount: records.length,
    routerScore: Number(routerScore.toFixed(1)),
    activeLane,
    lanes: unique,
    nextAction: activeLane
      ? `Schedule the next standalone packet for ${activeLane.windowLabel} UTC as ${activeLane.pillarLabel} / ${activeLane.formatLabel}.`
      : "Collect more measured packets before trusting topic timing.",
    promptDirectives: [
      activeLane ? `Topic timing: ${activeLane.windowLabel} UTC -> ${activeLane.pillarLabel} using ${activeLane.formatLabel}.` : null,
      activeLane?.directive || null,
      "If posting outside the selected UTC window, keep the same pillar but tighten the hook.",
      "0 extra X reads; no live trend scraping required for this timing route.",
    ].filter(Boolean).slice(0, 5),
    guardrails: [
      "Cached analytics only; do not spend X search/read calls to fill the lane.",
      "Do not override cost gates, auth gates, or cadence hold rules.",
      "Avoid pure recap; each lane must map to one account-memory pillar.",
    ],
  };
}

function buildCachedTopicTimingRouterForCadence({
  state = null,
  insights = null,
  usage = null,
  experimentPlan = null,
  hourlyLoadBalancer = null,
  now = new Date().toISOString(),
} = {}) {
  const plan = experimentPlan || buildExperimentPlan({ insights, usage, budgetState: null });
  const learningAutopilot = buildLearningAutopilot(insights || {}, { experimentPlan: plan, now });
  const adaptiveAngleScheduler = buildAdaptiveAngleScheduler(insights || {}, {
    state,
    experimentPlan: plan,
    learningAutopilot,
    usage,
    now,
  });
  const temporalAngleMatrix = buildTemporalAngleMatrix({
    state,
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    now,
  });
  const hookPatternReactor = buildHookPatternReactor({ insights, now });
  const contentBanditAllocator = buildContentBanditAllocator({ insights, hookPatternReactor, now });
  const narrativeResonanceController = buildNarrativeResonanceController({
    insights,
    contentBanditAllocator,
    now,
  });
  return buildTopicTimingRouter({
    insights,
    hourlyLoadBalancer,
    temporalAngleMatrix,
    contentBanditAllocator,
    narrativeResonanceController,
    now,
  });
}

function buildLearningWriteback({
  insights = null,
  learningAutopilot = null,
  adaptiveAngleScheduler = null,
  temporalAngleMatrix = null,
  experimentPlan = null,
  rateLimitGovernor = null,
  now = new Date().toISOString(),
} = {}) {
  const scheduler = adaptiveAngleScheduler || {};
  const autopilot = learningAutopilot || {};
  const matrix = temporalAngleMatrix || {};
  const plan = experimentPlan || {};
  const primarySlot = (scheduler.nextAngles || [])[0] || autopilot.primaryFormat || (plan.recommendedFormats || [])[0] || null;
  const temporalSlot = (matrix.slots || [])[0] || null;
  const holdIds = [
    ...new Set([
      ...(autopilot.holdFormats || []).map((row) => row.id).filter(Boolean),
      ...(scheduler.scoringBias?.holdFormatIds || []).filter(Boolean),
    ]),
  ];
  const preferredIds = [
    ...new Set([
      ...(scheduler.scoringBias?.preferredFormatIds || []),
      ...(plan.recommendedFormats || []).map((row) => row.id).filter(Boolean),
    ]),
  ].slice(0, 4);
  const sampleCount = Number(autopilot.sampleCount ?? scheduler.sampleCount ?? matrix.sampleCount ?? insights?.records?.length ?? 0) || 0;
  const baselineScore = Number(autopilot.baselineScore ?? scheduler.baselineScore ?? plan.baselineScore ?? insights?.baselineScore ?? 0) || 0;
  const readGate = rateLimitGovernor?.gates?.read || "cached_only";
  const safeSlots = Number(plan.budgetSafeSlots ?? rateLimitGovernor?.budget?.safeTextSlots ?? 0) || 0;
  const confidence = scheduler.confidence || autopilot.confidence || matrix.confidence || "low";
  const activeRule = primarySlot
    ? {
        id: primarySlot.formatId || primarySlot.id || "decision_rule",
        label: primarySlot.label || compactBucketName(primarySlot.formatId || primarySlot.id || "decision_rule"),
        action: primarySlot.action || "test",
        weight: Number(Number(primarySlot.weight ?? primarySlot.score ?? primarySlot.avgScore ?? 0).toFixed(1)),
        avgScore: Number(Number(primarySlot.avgScore || 0).toFixed(1)),
        samples: Number(primarySlot.samples) || 0,
        reason: primarySlot.reason || "Selected by the adaptive angle scheduler.",
      }
    : null;
  const mode = readGate === "closed"
    ? "guarded_cached_writeback"
    : scheduler.mode === "surge_exploit"
      ? "surge_rule_writeback"
      : scheduler.mode === "sample_discovery"
        ? "sample_writeback"
        : "controlled_rule_writeback";
  const nextWriteback = activeRule
    ? `Promote ${activeRule.label} into the next prompt route; keep ${holdIds.length ? holdIds.join(", ") : "weak formats"} behind the hold gate.`
    : "Keep collecting cached analytics before mutating the next prompt route.";
  const mutations = [
    {
      id: "primary_rule",
      label: "primary rule",
      before: "baseline rotation",
      after: activeRule?.id || "decision_rule",
      status: activeRule?.action === "exploit" ? "ok" : activeRule?.action === "hold" ? "danger" : "warn",
      score: activeRule?.weight || 0,
      reason: activeRule?.reason || "No active scheduler rule yet.",
    },
    {
      id: "temporal_slot",
      label: "UTC fire-control",
      before: "current cadence",
      after: temporalSlot ? `${temporalSlot.windowLabel} UTC / ${temporalSlot.formatId}` : "collect samples",
      status: temporalSlot?.status === "hot" ? "ok" : temporalSlot ? "warn" : "neutral",
      score: Number(Number(temporalSlot?.score || 0).toFixed(1)),
      reason: temporalSlot?.reason || matrix.nextAction || "No temporal slot selected yet.",
    },
    {
      id: "hold_gate",
      label: "hold filter",
      before: "all formats",
      after: holdIds.length ? holdIds.join(", ") : "none",
      status: holdIds.length ? "warn" : "ok",
      score: holdIds.length,
      reason: holdIds.length
        ? "Under-baseline formats stay out of default generation."
        : "No format is currently below the hold threshold.",
    },
    {
      id: "cost_gate",
      label: "cost boundary",
      before: "optional live reads",
      after: readGate,
      status: readGate === "closed" ? "danger" : readGate === "cached_only" ? "ok" : "warn",
      score: safeSlots,
      reason: rateLimitGovernor?.runbook || "Writeback uses cached analytics and does not add X read/search operations.",
    },
  ];
  const directives = [
    ...(scheduler.promptDirectives || []),
    ...(autopilot.directives || []),
  ].filter(Boolean).slice(0, 5);

  return {
    generatedAt: now,
    source: "cached tweet analytics + adaptive scheduler + cost governor",
    zeroExtraXReads: true,
    mode,
    confidence,
    epoch: now.slice(0, 16),
    sampleCount,
    baselineScore: Number(baselineScore.toFixed(1)),
    activeRule,
    preferredFormatIds: preferredIds,
    holdFormatIds: holdIds,
    nextWriteback,
    cells: [
      { id: "samples", label: "sample ledger", value: sampleCount, status: sampleCount >= 10 ? "ok" : "warn" },
      { id: "baseline", label: "baseline score", value: Number(baselineScore.toFixed(1)), status: baselineScore > 0 ? "ok" : "warn" },
      { id: "safe_slots", label: "safe slots", value: safeSlots, status: safeSlots > 0 ? "ok" : "danger" },
      { id: "read_gate", label: "read gate", value: readGate, status: readGate === "closed" ? "danger" : "ok" },
    ],
    mutations,
    directives,
  };
}

function xApiDailySeries(usage, days = 14) {
  const todayStart = dayStartMs();
  return Array.from({ length: days }, (_, index) => {
    const dayMs = todayStart - (days - 1 - index) * 24 * 60 * 60 * 1000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const day = usage?.days?.[date] || {};
    return {
      index,
      date,
      label: date.slice(5),
      value: Number(day.calls) || 0,
      calls: Number(day.calls) || 0,
      failures: Number(day.failures) || 0,
      usd: roundUsd(day.estimatedUsd),
    };
  });
}

function xApiEndpointSeries(usage, metric = "calls") {
  return Object.entries(usage?.endpoints || {})
    .sort((left, right) => (Number(right[1]?.calls) || 0) - (Number(left[1]?.calls) || 0))
    .map(([name, value], index) => {
      const calls = Number(value?.calls) || 0;
      const failures = Number(value?.failures) || 0;
      const usd = roundUsd(value?.estimatedUsd);
      return {
        index,
        endpoint: name,
        label: name.replace(/_/g, ".").toLowerCase(),
        value: metric === "usd" ? usd : calls,
        calls,
        failures,
        usd,
      };
    });
}

function dashboardChart(points, { label, unit, source }) {
  const values = points.map((point) => Number(point.value) || 0);
  return {
    label,
    unit,
    source,
    aggregate: "sum",
    pointCount: points.length,
    total: values.reduce((sum, value) => sum + value, 0),
    current: values[values.length - 1] || 0,
    points,
  };
}

function buildDashboardCharts({ last24h, last7d, usage, now = Date.now() }) {
  const apiDays = xApiDailySeries(usage, integerEnv("DASHBOARD_API_SERIES_DAYS", 14, 7, 31));
  const endpointCallPoints = xApiEndpointSeries(usage, "calls");
  const endpointSpendPoints = xApiEndpointSeries(usage, "usd");
  const apiDayCallTotal = apiDays.reduce((sum, point) => sum + (Number(point.value) || 0), 0);
  const apiDaySpendTotal = apiDays.reduce((sum, point) => sum + (Number(point.usd) || 0), 0);
  const xApiCallPoints = apiDayCallTotal > 0 || !endpointCallPoints.length ? apiDays : endpointCallPoints;
  const xApiSpendPoints = apiDaySpendTotal > 0 || !endpointSpendPoints.length
    ? apiDays.map((point) => ({ ...point, value: point.usd }))
    : endpointSpendPoints;
  return {
    impressions24h: dashboardChart(
      tweetMetricSeries(last24h, {
        hours: 24,
        buckets: integerEnv("DASHBOARD_24H_SERIES_BUCKETS", 12, 4, 24),
        metricKey: "impression_count",
        now,
      }),
      {
        label: "24h L7 traffic load",
        unit: "L7 events",
        source: "tweet_metrics",
      },
    ),
    impressions7d: dashboardChart(
      tweetMetricSeries(last7d, {
        hours: 24 * 7,
        buckets: 7,
        metricKey: "impression_count",
        mode: "day",
        now,
      }),
      {
        label: "7d ingestion throughput",
        unit: "L7 events",
        source: "tweet_metrics",
      },
    ),
    xApiCallsDaily: dashboardChart(xApiCallPoints, {
      label: "X API ops",
      unit: "ops",
      source: xApiCallPoints === apiDays ? "x_api_usage.days" : "x_api_usage.endpoints",
    }),
    xApiSpendDaily: dashboardChart(xApiSpendPoints, {
      label: "X API spend",
      unit: "usd",
      source: xApiSpendPoints === endpointSpendPoints ? "x_api_usage.endpoints" : "x_api_usage.days",
    }),
  };
}

function buildDashboardAutomation({ drafts, actions, usage, budgetState, mediaRoiGate = null }) {
  const apiCap = monthlyBudgetUsd();
  const safeCap = apiCap * budgetSafetyRatio();
  const trackedSpend = Number(usage?.totalEstimatedUsd) || 0;
  const postBudgetSpend = Number(budgetState?.spentUsd) || 0;
  const autoReply = autoReplyEnabled();
  const manualDrafts = manualReplyDraftsEnabled();
  const hotspot = hotspotRadarEnabled();
  const textPostCost = estimatedPostCost(false);
  const imagePostCost = estimatedPostCost(true);
  const readCost = estimatedEndpointCost("RECENT_SEARCH");
  const safeRemaining = Math.max(0, safeCap - trackedSpend);

  return {
    publishMode: autoReply ? "auto_reply_enabled" : "manual_paste",
    zeroWasteManualMode: !autoReply && manualDrafts,
    autoReplyEnabled: autoReply,
    autoReplyMode: autoReplyMode(),
    hotspotRadarEnabled: hotspot,
    manualReplyDraftsEnabled: manualDrafts,
    manualReplyDraftsReady: drafts.length,
    manualRoutesReady: actions.length,
    extraXReadsForManualReplies: 0,
    projectedManualReplyUsd: 0,
    projectedAutoReplyReadUsd: autoReply ? readCost : 0,
    projectedTextPostUsd: textPostCost,
    projectedImagePostUsd: imagePostCost,
    mediaRoiGate,
    budgetGuard: {
      month: usage?.month || currentBudgetMonth(),
      capUsd: roundUsd(apiCap),
      safetyRatio: budgetSafetyRatio(),
      safeCapUsd: roundUsd(safeCap),
      trackedSpendUsd: roundUsd(trackedSpend),
      trackedSafeRemainingUsd: roundUsd(safeRemaining),
      publishBudgetSpendUsd: roundUsd(postBudgetSpend),
      publishSafeRemainingUsd: roundUsd(Math.max(0, safeCap - postBudgetSpend)),
      estimatedReadUsd: roundUsd(readCost),
      estimatedTextPostUsd: roundUsd(textPostCost),
      estimatedImagePostUsd: roundUsd(imagePostCost),
      recommendedTextPostsLeft: textPostCost > 0 ? Math.floor(safeRemaining / textPostCost) : null,
    },
  };
}

function cadenceControllerEnabled() {
  return isTruthy(optionalEnv("TWEET_CADENCE_CONTROLLER_ENABLED", "true"));
}

function cadenceEnforcementMode() {
  return optionalEnv("TWEET_CADENCE_ENFORCEMENT", "budget_guard").toLowerCase();
}

function cadenceTelemetryAgeMinutes(state, now = new Date().toISOString()) {
  const checkedAt = maxIsoTimestamp([
    latestTweetMetricsCheckedAt(state),
    (state.accountSnapshots || [])[state.accountSnapshots.length - 1]?.checkedAt,
  ]);
  const checkedMs = Date.parse(checkedAt || "");
  const nowMs = Date.parse(now || "");
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  return {
    checkedAt,
    ageMinutes: Number.isFinite(checkedMs)
      ? Math.max(0, Math.round((safeNowMs - checkedMs) / 60000))
      : null,
  };
}

function buildCadenceCheck(id, ok, label, value, detail) {
  return {
    id,
    ok: Boolean(ok),
    label,
    value,
    detail,
  };
}

function buildGrowthCadenceController({
  state,
  insights,
  usage,
  budgetState,
  experimentPlan,
  hourlyLoadBalancer = null,
  topicTimingRouter = null,
  fixedText = false,
  languageCode = null,
  now = new Date().toISOString(),
} = {}) {
  const enabled = cadenceControllerEnabled();
  const enforcement = cadenceEnforcementMode();
  const last24h = recordsSince(state || emptyTweetAnalyticsState(), 24, now);
  // Daily targets use the UTC calendar day so midnight regional slots (e.g. US East evening)
  // are not blocked by the previous day's posts still inside a rolling 24h window.
  const postsToday = recordsOnUtcDay(state || emptyTweetAnalyticsState(), now);
  const normalizedLanguageCode = normalizeLanguageCode(languageCode);
  const languagePostsToday = normalizedLanguageCode
    ? postsToday.filter((record) => normalizeLanguageCode(record.language) === normalizedLanguageCode)
    : postsToday;
  const languageLast24h = normalizedLanguageCode
    ? last24h.filter((record) => normalizeLanguageCode(record.language) === normalizedLanguageCode)
    : last24h;
  const growthGoal = buildGrowthGoal(state || emptyTweetAnalyticsState());
  const languageTargetEnv = normalizedLanguageCode
    ? `TWEET_CADENCE_DAILY_POST_TARGET_${normalizedLanguageCode.toUpperCase()}`
    : "";
  const dailyTarget = languageTargetEnv && optionalEnv(languageTargetEnv)
    ? integerEnv(languageTargetEnv, 1, 1, 20)
    : integerEnv("TWEET_CADENCE_DAILY_POST_TARGET", growthGoal.dailyPosts || 1, 1, 20);
  const budget = monthlyBudgetUsd();
  const safeCap = budget * budgetSafetyRatio();
  const trackedSpend = Math.max(
    Number(usage?.totalEstimatedUsd) || 0,
    Number(budgetState?.spentUsd) || 0,
  );
  const textCost = estimatedPostCost(false);
  const safeRemaining = budget > 0 ? Math.max(0, safeCap - trackedSpend) : null;
  const safeTextPostsLeft =
    safeRemaining == null || textCost <= 0
      ? null
      : Math.max(0, Math.floor(safeRemaining / textCost));
  const fallbackMinHours = numberEnv("X_API_MIN_HOURS_BETWEEN_POSTS", 0, 0, 168);
  const minHours = numberEnv("TWEET_CADENCE_MIN_HOURS_BETWEEN_POSTS", fallbackMinHours, 0, 168);
  const nowMs = Date.parse(now || "");
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lastPostedAt = budgetState?.lastPostedAt || maxIsoTimestamp((state?.tweets || []).map((record) => record.postedAt));
  const lastPostMs = Date.parse(lastPostedAt || "");
  const hoursSinceLastPost = Number.isFinite(lastPostMs)
    ? Math.max(0, (safeNowMs - lastPostMs) / 36e5)
    : null;
  const telemetry = cadenceTelemetryAgeMinutes(state || emptyTweetAnalyticsState(), now);
  const maxTelemetryAgeHours = numberEnv("TWEET_CADENCE_MAX_TELEMETRY_AGE_HOURS", 36, 1, 24 * 14);
  const telemetryFresh =
    telemetry.ageMinutes == null || telemetry.ageMinutes <= maxTelemetryAgeHours * 60;
  const experimentSlots = Number(experimentPlan?.budgetSafeSlots);
  const budgetSlotsSafe = !Number.isFinite(experimentSlots) || experimentSlots > 0;
  const hourlyLoad = hourlyLoadBalancer || buildHourlyLoadBalancer({ state, insights, now });
  const hourlyWindowOk = !hourlyLoad?.nextWindow || hourlyLoad.mode !== "wait_for_peak";
  const topicTimingLane = topicTimingRouter?.activeLane || null;
  const topicTimingWindowHours = numberEnv("TWEET_CADENCE_TOPIC_TIMING_WINDOW_HOURS", 1.5, 0, 24);
  const rawTopicTimingHoursFromNow = topicTimingLane
    ? Number.isFinite(Number(topicTimingLane.hoursFromNow))
      ? Number(topicTimingLane.hoursFromNow)
      : Number.isFinite(Number(topicTimingLane.hour))
        ? hourDelta(new Date(Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now()).getUTCHours(), Number(topicTimingLane.hour))
        : null
    : null;
  const topicTimingHoursFromNow = Number.isFinite(rawTopicTimingHoursFromNow)
    ? rawTopicTimingHoursFromNow
    : null;
  const topicTimingTrusted = Boolean(topicTimingLane) && topicTimingRouter?.severity !== "danger";
  const topicTimingWindowOk =
    !topicTimingTrusted ||
    topicTimingHoursFromNow == null ||
    topicTimingHoursFromNow <= topicTimingWindowHours;
  const topicTimingWindowLabel = topicTimingLane
    ? `${topicTimingLane.windowLabel || utcHourLabel(topicTimingLane.hour)} UTC / ${topicTimingLane.pillarLabel || topicTimingLane.pillarId || "-"} / ${topicTimingLane.formatLabel || topicTimingLane.formatId || "-"}`
    : "no active lane";

  const checks = [
    buildCadenceCheck(
      "budget",
      safeTextPostsLeft == null || safeTextPostsLeft > 0,
      "Budget",
      safeTextPostsLeft == null ? "unlimited" : `${safeTextPostsLeft} text posts left`,
      safeRemaining == null
        ? "Monthly X API budget tracking is disabled."
        : `$${formatNumber(safeRemaining, 3)} safe remaining; text post costs ~$${formatNumber(textCost, 3)}.`,
    ),
    buildCadenceCheck(
      "interval",
      hoursSinceLastPost == null || minHours <= 0 || hoursSinceLastPost >= minHours,
      "Interval",
      hoursSinceLastPost == null ? "no prior post" : `${formatNumber(hoursSinceLastPost, 1)}h since post`,
      minHours > 0 ? `Minimum interval is ${formatNumber(minHours, 1)}h.` : "No minimum interval configured.",
    ),
    buildCadenceCheck(
      "daily_target",
      languagePostsToday.length < dailyTarget,
      "Daily target",
      `${languagePostsToday.length}/${dailyTarget} ${normalizedLanguageCode || "all"} posts today (UTC)`,
      normalizedLanguageCode
        ? `This target is scoped to ${normalizedLanguageCode} on the current UTC day; the other language track has its own cadence.`
        : "When target is reached, distribution work should take priority over another standalone post.",
    ),
    buildCadenceCheck(
      "telemetry",
      telemetryFresh,
      "Telemetry",
      telemetry.ageMinutes == null ? "unknown age" : `${telemetry.ageMinutes} min old`,
      telemetry.checkedAt
        ? `Latest checked telemetry: ${telemetry.checkedAt}.`
        : "No checked tweet/account telemetry found yet.",
    ),
    buildCadenceCheck(
      "experiments",
      budgetSlotsSafe,
      "Experiment slots",
      Number.isFinite(experimentSlots)
        ? `${experimentPlan.budgetSafeSlots}/${experimentPlan.slots} slots`
        : "not allocated",
      experimentPlan?.decision || "No experiment allocation available.",
    ),
    buildCadenceCheck(
      "hourly_window",
      hourlyWindowOk,
      "Learned UTC window",
      hourlyLoad?.currentHour
        ? `${hourlyLoad.currentHour.label} score ${formatNumber(hourlyLoad.currentHour.loadScore, 1)}`
        : "unknown",
      hourlyLoad?.nextAction || "No hourly load advice available.",
    ),
    buildCadenceCheck(
      "topic_timing",
      topicTimingWindowOk,
      "Topic timing",
      topicTimingLane
        ? `${topicTimingWindowLabel}${topicTimingHoursFromNow == null ? "" : ` in ${formatNumber(topicTimingHoursFromNow, 1)}h`}`
        : "not routed",
      topicTimingTrusted
        ? topicTimingRouter.nextAction || "Topic timing router selected a cached topic/format window."
        : "No trusted topic timing gate; cadence will not block on this signal.",
    ),
  ];

  const blockingCandidates = [
    safeTextPostsLeft != null && safeTextPostsLeft <= 0
      ? {
          reasonCode: "budget_safe_cap",
          mode: "manual_distribution_only",
          severity: "danger",
          reason: "Budget guard has no safe text-post slots left.",
          nextAction: "Generate or use manual route outputs only; do not publish another X post.",
        }
      : null,
    hoursSinceLastPost != null && minHours > 0 && hoursSinceLastPost < minHours
      ? {
          reasonCode: "min_interval",
          mode: "wait",
          severity: "warn",
          reason: `Minimum post interval not reached; wait about ${formatNumber(minHours - hoursSinceLastPost, 1)}h.`,
          nextAction: "Hold the main post and use manual distribution routes.",
        }
      : null,
    languagePostsToday.length >= dailyTarget
      ? {
          reasonCode: "daily_target_reached",
          mode: "manual_distribution_only",
          severity: "warn",
          reason: normalizedLanguageCode
            ? `Daily ${normalizedLanguageCode} post target reached (${languagePostsToday.length}/${dailyTarget} UTC day).`
            : `Daily post target reached (${postsToday.length}/${dailyTarget} UTC day).`,
          nextAction: normalizedLanguageCode
            ? `Hold the ${normalizedLanguageCode} standalone post; the other language track can still publish in its own window.`
            : "Spend the next growth loop on route ops under high-signal tech conversations.",
        }
      : null,
    !telemetryFresh
      ? {
          reasonCode: "telemetry_stale",
          mode: "refresh_metrics_first",
          severity: "warn",
          reason: `Telemetry is older than ${formatNumber(maxTelemetryAgeHours, 1)}h.`,
          nextAction: "Run growth maintenance or dashboard-only report before trusting the next post decision.",
        }
      : null,
    !budgetSlotsSafe
      ? {
          reasonCode: "no_experiment_slots",
          mode: "manual_distribution_only",
          severity: "warn",
          reason: "Experiment allocation has no budget-safe post slots.",
          nextAction: "Keep manual route ops only until budget or allocation changes.",
        }
      : null,
    !hourlyWindowOk
      ? {
          reasonCode: "learned_peak_wait",
          mode: "wait_for_learned_peak",
          severity: "warn",
          reason: hourlyLoad.nextAction,
          nextAction: "Use manual route ops now; post the standalone take in the learned UTC window.",
        }
      : null,
    !topicTimingWindowOk
      ? {
          reasonCode: "topic_timing_wait",
          mode: "wait_for_topic_timing",
          severity: "warn",
          reason: `Topic timing router prefers ${topicTimingWindowLabel} in ${formatNumber(topicTimingHoursFromNow, 1)}h.`,
          nextAction: "Use manual route ops now; publish the standalone packet inside the selected topic timing lane.",
        }
      : null,
  ].filter(Boolean);

  const blocking = blockingCandidates[0] || null;
  const manualOverride = Boolean(fixedText);
  const publishAllowed =
    !enabled ||
    !blocking ||
    (manualOverride && !["budget_safe_cap", "min_interval"].includes(blocking.reasonCode));
  const mode = !enabled
    ? "disabled"
    : publishAllowed
      ? manualOverride
        ? "manual_override"
        : "publish_experiment"
      : blocking.mode;
  const reason = !enabled
    ? "Cadence controller disabled."
    : publishAllowed
      ? manualOverride && blocking
        ? `Manual TWEET_TEXT override; advisory issue: ${blocking.reason}`
        : "Cadence allows the next post."
      : blocking.reason;
  const nextAction = publishAllowed
    ? "Proceed with the next post candidate under the current budget guard."
    : blocking.nextAction;
  const enforcingReasons =
    enforcement === "full"
      ? blockingCandidates.map((candidate) => candidate.reasonCode)
    : enforcement === "window" || enforcement === "learned_window" || enforcement === "topic_timing" || enforcement === "timing"
        ? ["budget_safe_cap", "min_interval", "daily_target_reached", "learned_peak_wait", "topic_timing_wait"]
      : ["budget_safe_cap", "min_interval", "daily_target_reached"];
  const willBlockPublish =
    enabled &&
    !publishAllowed &&
    !["off", "false", "advisory"].includes(enforcement) &&
    enforcingReasons.includes(blocking?.reasonCode);

  return {
    enabled,
    enforcement,
    generatedAt: now,
    mode,
    publishAllowed,
    willBlockPublish,
    manualOverride,
    reasonCode: blocking?.reasonCode || "ok",
    severity: blocking?.severity || "ok",
    reason,
    nextAction,
    languageCode: normalizedLanguageCode || null,
    dailyPostTarget: dailyTarget,
    postsLast24h: languageLast24h.length,
    postsUtcDay: languagePostsToday.length,
    allLanguagePostsLast24h: last24h.length,
    allLanguagePostsUtcDay: postsToday.length,
    safeTextPostsLeft,
    safeRemainingUsd: safeRemaining == null ? null : roundUsd(safeRemaining),
    textPostCostUsd: roundUsd(textCost),
    minHoursBetweenPosts: minHours,
    hoursSinceLastPost: hoursSinceLastPost == null ? null : Number(hoursSinceLastPost.toFixed(2)),
    telemetryAgeMinutes: telemetry.ageMinutes,
    latestTelemetryAt: telemetry.checkedAt,
    experimentSlots: Number.isFinite(experimentSlots) ? experimentPlan.budgetSafeSlots : null,
    hourlyLoad,
    cadenceWindow: hourlyLoad
      ? {
          mode: hourlyLoad.mode,
          confidence: hourlyLoad.confidence,
          currentHour: hourlyLoad.currentHour,
          nextWindow: hourlyLoad.nextWindow,
          bestHours: hourlyLoad.bestHours,
          nextAction: hourlyLoad.nextAction,
          zeroExtraXReads: true,
        }
      : null,
    topicTimingWindow: topicTimingRouter
      ? {
          mode: topicTimingRouter.mode,
          severity: topicTimingRouter.severity,
          routerScore: topicTimingRouter.routerScore,
          trusted: topicTimingTrusted,
          windowHours: topicTimingWindowHours,
          hoursFromNow: topicTimingHoursFromNow == null ? null : Number(topicTimingHoursFromNow.toFixed(2)),
          activeLane: topicTimingLane,
          nextAction: topicTimingRouter.nextAction,
          zeroExtraXReads: Boolean(topicTimingRouter.zeroExtraXReads),
        }
      : null,
    checks,
  };
}

function shouldEnforceCadence(controller) {
  if (!controller?.enabled || controller.publishAllowed) return false;
  const mode = controller.enforcement || "budget_guard";
  if (["off", "false", "advisory"].includes(mode)) return false;
  if (mode === "full") return true;
  if (mode === "window" || mode === "learned_window" || mode === "topic_timing" || mode === "timing") {
    return ["budget_safe_cap", "min_interval", "daily_target_reached", "learned_peak_wait", "topic_timing_wait"].includes(controller.reasonCode);
  }
  return ["budget_safe_cap", "min_interval", "daily_target_reached"].includes(controller.reasonCode);
}

function usageEndpointTotals(usage) {
  return Object.values(usage?.endpoints || {}).reduce(
    (totals, endpoint) => ({
      calls: totals.calls + (Number(endpoint?.calls) || 0),
      failures: totals.failures + (Number(endpoint?.failures) || 0),
    }),
    { calls: 0, failures: 0 },
  );
}

function normalizedStatusCode(status) {
  const code = Number.parseInt(String(status ?? ""), 10);
  return Number.isFinite(code) ? code : null;
}

function endpointStatusCounts(endpoint = {}) {
  const counts = {};
  for (const [status, count] of Object.entries(endpoint.statuses || {})) {
    const code = normalizedStatusCode(status);
    if (!code) continue;
    counts[String(code)] = (counts[String(code)] || 0) + (Number(count) || 0);
  }

  if (!Object.keys(counts).length) {
    const code = normalizedStatusCode(endpoint.lastStatus);
    if (code) {
      const fallbackCount = code >= 400
        ? Math.max(1, Number(endpoint.failures) || 0)
        : Math.max(1, Number(endpoint.calls) || 0);
      counts[String(code)] = fallbackCount;
    }
  }

  return counts;
}

function buildDashboardStatusTriage(usage = {}) {
  const incidents = [];
  const statusBuckets = {
    success2xx: { id: "success2xx", label: "2xx success", count: 0, endpoints: new Map() },
    client4xx: { id: "client4xx", label: "4xx client", count: 0, endpoints: new Map() },
    auth4xx: { id: "auth4xx", label: "401/403 auth", count: 0, endpoints: new Map() },
    rateLimit429: { id: "rateLimit429", label: "429 rate-limit", count: 0, endpoints: new Map() },
    backend5xx: { id: "backend5xx", label: "5xx backend", count: 0, endpoints: new Map() },
  };
  const totals = {
    totalCalls: 0,
    totalFailures: 0,
    success2xx: 0,
    rateLimit429: 0,
    backendFault5xx: 0,
    authFault4xx: 0,
    clientFault4xx: 0,
    activeRateLimit429: 0,
    activeBackendFault5xx: 0,
    activeAuthFault4xx: 0,
    activeClientFault4xx: 0,
  };
  const addStatusBucket = (bucketId, endpoint, count) => {
    const bucket = statusBuckets[bucketId];
    const value = Number(count) || 0;
    if (!bucket || value <= 0) return;
    bucket.count += value;
    bucket.endpoints.set(endpoint, (bucket.endpoints.get(endpoint) || 0) + value);
  };

  for (const [endpoint, value] of Object.entries(usage?.endpoints || {})) {
    const calls = Number(value?.calls) || 0;
    const failures = Number(value?.failures) || 0;
    const statuses = endpointStatusCounts(value);
    const endpointTotals = {
      rateLimit429: 0,
      backendFault5xx: 0,
      authFault4xx: 0,
      clientFault4xx: 0,
      activeRateLimit429: 0,
      activeBackendFault5xx: 0,
      activeAuthFault4xx: 0,
      activeClientFault4xx: 0,
    };

    totals.totalCalls += calls;
    totals.totalFailures += failures;
    const latestCode = normalizedStatusCode(value?.lastStatus);
    if (latestCode === 429) {
      totals.activeRateLimit429 += 1;
      endpointTotals.activeRateLimit429 += 1;
    } else if (latestCode >= 500) {
      totals.activeBackendFault5xx += 1;
      endpointTotals.activeBackendFault5xx += 1;
    } else if (latestCode === 401 || latestCode === 403) {
      totals.activeAuthFault4xx += 1;
      endpointTotals.activeAuthFault4xx += 1;
    } else if (latestCode >= 400) {
      totals.activeClientFault4xx += 1;
      endpointTotals.activeClientFault4xx += 1;
    }

    for (const [status, countValue] of Object.entries(statuses)) {
      const count = Number(countValue) || 0;
      const code = normalizedStatusCode(status);
      if (!code || count <= 0) continue;
      if (code >= 200 && code < 300) {
        totals.success2xx += count;
        addStatusBucket("success2xx", endpoint, count);
      }
      if (code === 429) {
        totals.rateLimit429 += count;
        endpointTotals.rateLimit429 += count;
        addStatusBucket("rateLimit429", endpoint, count);
      } else if (code >= 500) {
        totals.backendFault5xx += count;
        endpointTotals.backendFault5xx += count;
        addStatusBucket("backend5xx", endpoint, count);
      } else if (code === 401 || code === 403) {
        totals.authFault4xx += count;
        endpointTotals.authFault4xx += count;
        addStatusBucket("auth4xx", endpoint, count);
      } else if (code >= 400) {
        totals.clientFault4xx += count;
        endpointTotals.clientFault4xx += count;
        addStatusBucket("client4xx", endpoint, count);
      }
    }

    if (
      failures > 0 ||
      endpointTotals.rateLimit429 > 0 ||
      endpointTotals.backendFault5xx > 0 ||
      endpointTotals.authFault4xx > 0 ||
      endpointTotals.clientFault4xx > 0
    ) {
      const hasActiveDanger = endpointTotals.activeRateLimit429 > 0 || endpointTotals.activeBackendFault5xx > 0;
      const hasActiveFault =
        hasActiveDanger ||
        endpointTotals.activeAuthFault4xx > 0 ||
        endpointTotals.activeClientFault4xx > 0;
      const severity = hasActiveDanger
        ? "danger"
        : hasActiveFault
          ? "warn"
          : "cached";
      incidents.push({
        endpoint,
        severity,
        active: hasActiveFault,
        calls,
        failures,
        lastStatus: value?.lastStatus || null,
        lastCalledAt: value?.lastCalledAt || null,
        lastFailureAt: value?.lastFailureAt || null,
        statuses,
        rateLimit429: endpointTotals.rateLimit429,
        backendFault5xx: endpointTotals.backendFault5xx,
        authFault4xx: endpointTotals.authFault4xx,
        clientFault4xx: endpointTotals.clientFault4xx,
        activeRateLimit429: endpointTotals.activeRateLimit429,
        activeBackendFault5xx: endpointTotals.activeBackendFault5xx,
        activeAuthFault4xx: endpointTotals.activeAuthFault4xx,
        activeClientFault4xx: endpointTotals.activeClientFault4xx,
      });
    }
  }

  const failureRate = totals.totalCalls > 0 ? (totals.totalFailures / totals.totalCalls) * 100 : 0;
  const severity = totals.activeRateLimit429 > 0 || totals.activeBackendFault5xx > 0
    ? "danger"
    : totals.activeAuthFault4xx > 0 || totals.activeClientFault4xx > 0
      ? "warn"
      : totals.totalFailures > 0
        ? "cached"
      : "ok";
  const summary = severity === "ok"
    ? `0 rate-limit / backend faults across ${totals.totalCalls} X API ops.`
    : `${totals.rateLimit429} rate-limit, ${totals.backendFault5xx} backend, ${totals.authFault4xx} auth, ${totals.clientFault4xx} client faults across ${totals.totalCalls} X API ops.`;
  const action = totals.activeRateLimit429 > 0
    ? "Hold live search/read jobs and let cadence/backoff drain before more X reads."
    : totals.activeBackendFault5xx > 0
      ? "Retry later with exponential backoff; keep manual drafts and cached telemetry active."
      : totals.activeAuthFault4xx > 0
        ? "Check OAuth scopes/tokens before the next publish or live read."
        : totals.activeClientFault4xx > 0
          ? "Inspect endpoint payloads and keep cached telemetry fallback active."
          : totals.totalFailures > 0
            ? "Historical X API failures are recorded, but the latest endpoint states are clear."
          : "No 429 or 503-class faults; budget guard remains the limiting partition.";
  const statusMatrix = Object.values(statusBuckets)
    .map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      count: bucket.count,
      sharePct: totals.totalCalls > 0 ? Number(((bucket.count / totals.totalCalls) * 100).toFixed(1)) : 0,
      endpoints: [...bucket.endpoints.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([endpoint, count]) => ({ endpoint, count })),
    }));
  const topFaultEndpoints = incidents
    .map((incident) => ({
      endpoint: incident.endpoint,
      severity: incident.severity,
      active: incident.active,
      failures: incident.failures,
      lastStatus: incident.lastStatus,
      totalFaults:
        (Number(incident.rateLimit429) || 0) +
        (Number(incident.backendFault5xx) || 0) +
        (Number(incident.authFault4xx) || 0) +
        (Number(incident.clientFault4xx) || 0),
    }))
    .sort((left, right) => {
      const activeDelta = Number(Boolean(right.active)) - Number(Boolean(left.active));
      if (activeDelta) return activeDelta;
      const faultDelta = (Number(right.totalFaults) || 0) - (Number(left.totalFaults) || 0);
      if (faultDelta) return faultDelta;
      return (Number(right.failures) || 0) - (Number(left.failures) || 0);
    })
    .slice(0, 5);

  return {
    ...totals,
    severity,
    failureRate: Number(failureRate.toFixed(2)),
    summary,
    action,
    statusMatrix,
    topFaultEndpoints,
    incidents: incidents
      .sort((left, right) => {
        const severityDelta = (right.severity === "danger" ? 2 : 1) - (left.severity === "danger" ? 2 : 1);
        if (severityDelta) return severityDelta;
        if (left.active !== right.active) return right.active ? 1 : -1;
        return (right.failures || 0) - (left.failures || 0);
      })
      .slice(0, 6),
  };
}

function boundedPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function summarizeXApiPartition(usage = {}, endpoints = []) {
  const names = endpoints.filter(Boolean);
  const summary = {
    endpoints: names,
    calls: 0,
    failures: 0,
    usd: 0,
    statusCounts: {},
    lastStatus: null,
    lastEndpoint: null,
    lastCalledAt: null,
    lastFailureAt: null,
    activeFault: false,
    activeRateLimit429: 0,
    activeBackendFault5xx: 0,
    activeAuthFault4xx: 0,
    activeClientFault4xx: 0,
  };

  for (const name of names) {
    const endpoint = usage?.endpoints?.[name];
    if (!endpoint) continue;

    summary.calls += Number(endpoint.calls) || 0;
    summary.failures += Number(endpoint.failures) || 0;
    summary.usd += Number(endpoint.estimatedUsd) || 0;

    const statusCounts = endpointStatusCounts(endpoint);
    for (const [status, count] of Object.entries(statusCounts)) {
      summary.statusCounts[status] = (summary.statusCounts[status] || 0) + (Number(count) || 0);
    }

    const lastCalledMs = parseTimestampMs(endpoint.lastCalledAt);
    const currentLastMs = parseTimestampMs(summary.lastCalledAt);
    if (lastCalledMs && (!currentLastMs || lastCalledMs > currentLastMs)) {
      summary.lastStatus = endpoint.lastStatus || null;
      summary.lastEndpoint = name;
      summary.lastCalledAt = endpoint.lastCalledAt || null;
    }

    const lastFailureMs = parseTimestampMs(endpoint.lastFailureAt);
    const currentFailureMs = parseTimestampMs(summary.lastFailureAt);
    if (lastFailureMs && (!currentFailureMs || lastFailureMs > currentFailureMs)) {
      summary.lastFailureAt = endpoint.lastFailureAt || null;
    }
  }

  const latestCode = normalizedStatusCode(summary.lastStatus);
  summary.activeRateLimit429 = latestCode === 429 ? 1 : 0;
  summary.activeBackendFault5xx = latestCode >= 500 ? 1 : 0;
  summary.activeAuthFault4xx = latestCode === 401 || latestCode === 403 ? 1 : 0;
  summary.activeClientFault4xx = latestCode >= 400 && latestCode < 500 && latestCode !== 401 && latestCode !== 403 && latestCode !== 429 ? 1 : 0;
  summary.activeFault =
    summary.activeRateLimit429 > 0 ||
    summary.activeBackendFault5xx > 0 ||
    summary.activeAuthFault4xx > 0 ||
    summary.activeClientFault4xx > 0;
  summary.failureRatePct = summary.calls > 0 ? Number(((summary.failures / summary.calls) * 100).toFixed(1)) : 0;
  summary.usd = roundUsd(summary.usd);
  return summary;
}

function circuitPartitionStatus({ summary, gate, protectedGate = false } = {}) {
  if (gate === "closed" || summary?.activeRateLimit429 || summary?.activeBackendFault5xx) return "danger";
  if (protectedGate || gate === "cached_only" || gate === "review" || summary?.activeAuthFault4xx || summary?.activeClientFault4xx) return "warn";
  if ((Number(summary?.failures) || 0) > 0) return "cached";
  return "ok";
}

function buildCircuitPartitionMatrix({
  usage,
  readGate,
  publishGate,
  activeRunwayGuard,
  safeTextSlots,
  accountSnapshotCache = null,
} = {}) {
  const specs = [
    {
      id: "read_search",
      label: "READ_SEARCH",
      endpoints: ["RECENT_SEARCH", "AUTO_REPLY_SEARCH"],
      gate: readGate,
      directive: readGate === "closed"
        ? "Live search sealed; use cached radar and manual X web routes."
        : readGate === "cached_only"
          ? "No paid search reads; route from cached opportunities."
          : "Live search may run only when cadence explicitly opens.",
    },
    {
      id: "metrics",
      label: "METRICS",
      endpoints: ["TWEET_METRICS_LOOKUP"],
      gate: readGate === "closed" ? "closed" : activeRunwayGuard ? "cached_only" : "sampled",
      directive: activeRunwayGuard
        ? "Skip optional refreshes and keep last known telemetry."
        : "Refresh only due metrics; no exploratory reads.",
    },
    {
      id: "account_snapshot",
      label: "ACCOUNT_SNAPSHOT",
      endpoints: ["USER_ME_LOOKUP"],
      gate: readGate === "closed"
        ? "closed"
        : accountSnapshotCache?.due
          ? "sampled"
          : "cached_only",
      directive: accountSnapshotCache?.directive ||
        "Use account snapshot TTL before spending USER_ME_LOOKUP reads.",
      cache: accountSnapshotCache,
    },
    {
      id: "write",
      label: "WRITE_PATH",
      endpoints: ["CREATE_TWEET", "CREATE_REPLY", "CREATE_QUOTE"],
      gate: publishGate,
      directive: publishGate === "closed"
        ? "Publishing sealed until safe budget returns."
        : publishGate === "open"
          ? "Standalone post path open; replies remain manual unless mentioned."
          : "Human review required before writes.",
    },
    {
      id: "media",
      label: "MEDIA_UPLOAD",
      endpoints: ["MEDIA_INITIALIZE", "MEDIA_APPEND", "MEDIA_FINALIZE"],
      gate: safeTextSlots === 0 ? "closed" : "roi_guard",
      directive: "Spend media calls only when cached ROI gate proves lift.",
    },
    {
      id: "auth",
      label: "OAUTH",
      endpoints: ["OAUTH_REFRESH"],
      gate: "warm",
      directive: "Keep refresh token warm; auth faults block write/read partitions.",
    },
  ];

  return specs.map((spec) => {
    const summary = summarizeXApiPartition(usage, spec.endpoints);
    const protectedGate = spec.gate === "cached_only" || spec.gate === "review" || spec.gate === "roi_guard";
    const pressurePct = boundedPercent(
      (summary.activeRateLimit429 ? 48 : 0) +
      (summary.activeBackendFault5xx ? 34 : 0) +
      (summary.activeAuthFault4xx ? 24 : 0) +
      (summary.activeClientFault4xx ? 16 : 0) +
      Math.min(24, Number(summary.failureRatePct) * 2) +
      (protectedGate ? 10 : 0),
    );
    return {
      id: spec.id,
      label: spec.label,
      endpoints: spec.endpoints,
      gate: spec.gate,
      status: circuitPartitionStatus({ summary, gate: spec.gate, protectedGate }),
      cache: spec.cache || null,
      calls: summary.calls,
      failures: summary.failures,
      failureRatePct: summary.failureRatePct,
      usd: summary.usd,
      lastStatus: summary.lastStatus,
      lastEndpoint: summary.lastEndpoint,
      pressurePct: Number(pressurePct.toFixed(1)),
      directive: spec.directive,
    };
  });
}

function buildCircuitCooldownTimeline({ activeCooldown, readGate, activeRunwayGuard, severity } = {}) {
  return [
    {
      id: "detect",
      label: "DETECT",
      status: activeCooldown?.active ? "danger" : "ok",
      value: activeCooldown?.active
        ? `${activeCooldown.status || "fault"} @ ${activeCooldown.endpoint || "x_api"}`
        : "clear",
      detail: activeCooldown?.reasonCode || "none",
    },
    {
      id: "seal",
      label: "SEAL",
      status: readGate === "closed" ? "danger" : readGate === "cached_only" ? "warn" : "ok",
      value: readGate || "cached_only",
      detail: readGate === "closed" ? "live reads blocked" : "paid reads minimized",
    },
    {
      id: "route",
      label: "CACHE",
      status: "ok",
      value: "manual routes",
      detail: "cached opportunities + web links",
    },
    {
      id: "recover",
      label: "RECOVER",
      status: activeCooldown?.active || activeRunwayGuard ? "warn" : severity || "ok",
      value: activeCooldown?.active ? `${Number(activeCooldown.remainingMinutes || 0)}m` : activeRunwayGuard ? "runway" : "now",
      detail: activeCooldown?.until || (activeRunwayGuard ? "budget runway guard" : "all partitions nominal"),
    },
  ];
}

function buildRateLimitGovernor({
  usage,
  budgetState,
  cadence,
  controlPlane,
  statusTriage,
  cooldown,
  runwayGuard,
  accountSnapshotCache,
  now,
} = {}) {
  const cap = monthlyBudgetUsd();
  const safeCap = cap * budgetSafetyRatio();
  const usageSpend = Number(usage?.totalEstimatedUsd) || 0;
  const publishSpend = Number(budgetState?.spentUsd) || 0;
  const trackedSpend = Math.max(usageSpend, publishSpend);
  const safeRemaining = cap > 0 ? Math.max(0, safeCap - trackedSpend) : null;
  const safeRemainingRatio = safeCap > 0 && safeRemaining != null ? safeRemaining / safeCap : 1;
  const textPostCost = estimatedPostCost(false);
  const safeTextSlots =
    safeRemaining == null || textPostCost <= 0
      ? null
      : Math.max(0, Math.floor(safeRemaining / textPostCost));
  const triage = statusTriage || buildDashboardStatusTriage(usage || {});
  const activeCooldown = cooldown || evaluateXApiCooldown(usage || {}, now ? new Date(now) : new Date());
  const active429 = Number(triage.activeRateLimit429 || 0);
  const active503 = Number(triage.activeBackendFault5xx || 0);
  const activeRunwayGuard = Boolean(runwayGuard?.active);
  const readGate =
    activeCooldown.active || active429 > 0 || active503 > 0 || controlPlane?.readGate === "closed"
      ? "closed"
      : activeRunwayGuard
        ? "cached_only"
        : controlPlane?.readGate || "cached_only";
  const publishGate =
    safeTextSlots === 0
      ? "closed"
      : controlPlane?.publishGate || (cadence?.publishAllowed ? "open" : "review");
  const severity =
    readGate === "closed" || activeCooldown.active || active429 > 0 || active503 > 0
      ? "danger"
      : activeRunwayGuard || publishGate === "closed" || (safeTextSlots != null && safeTextSlots <= 2)
        ? "warn"
        : "ok";
  const reactorFillPct = boundedPercent(safeRemainingRatio * 100);
  const status =
    severity === "danger"
      ? "read gate sealed"
      : severity === "warn"
        ? "boundary watch"
        : "reactor nominal";
  const runbook =
    severity === "danger"
      ? "Seal live search/read partitions. Use cached telemetry and manual outputs until cooldown clears."
      : severity === "warn"
        ? "Hold optional reads, route through prepared web targets, and let the cost boundary recover."
        : "Cached routing is clear. Keep live X reads at zero unless the cadence gate explicitly opens.";
  const partitionMatrix = buildCircuitPartitionMatrix({
    usage,
    readGate,
    publishGate,
    activeRunwayGuard,
    safeTextSlots,
    accountSnapshotCache,
  });
  const partitionPressure = partitionMatrix.length
    ? partitionMatrix.reduce((max, partition) => Math.max(max, Number(partition.pressurePct) || 0), 0)
    : 0;
  const budgetPressure = boundedPercent((1 - safeRemainingRatio) * 38);
  const circuitPressurePct = boundedPercent(
    partitionPressure +
      (activeCooldown.active ? 24 : 0) +
      (activeRunwayGuard ? 16 : 0) +
      (safeTextSlots === 0 ? 26 : safeTextSlots != null && safeTextSlots <= 2 ? 12 : 0) +
      budgetPressure,
  );
  const cooldownTimeline = buildCircuitCooldownTimeline({
    activeCooldown,
    readGate,
    activeRunwayGuard,
    severity,
  });
  const nextAction =
    severity === "danger"
      ? "Keep X read/search partitions sealed; publish only manual/cached outputs after auth and cooldown are clear."
      : severity === "warn"
        ? "Run cached routing and manual paste; avoid optional metrics/search calls until runway pressure drops."
        : "Stay in cached-first mode; spend X API only on scheduled write paths and due metrics.";

  return {
    generatedAt: now || new Date().toISOString(),
    status,
    severity,
    reactorFillPct: Number(reactorFillPct.toFixed(1)),
    circuit: {
      pressurePct: Number(circuitPressurePct.toFixed(1)),
      mode:
        severity === "danger"
          ? "circuit_closed"
          : severity === "warn"
            ? "guarded_cached_only"
            : "nominal_cached_first",
      hottestPartition:
        [...partitionMatrix].sort((left, right) => (Number(right.pressurePct) || 0) - (Number(left.pressurePct) || 0))[0]?.id || null,
      zeroExtraXReads: true,
    },
    zeroExtraXReads: true,
    gates: {
      read: readGate,
      publish: publishGate,
      cadence: cadence?.mode || null,
    },
    budget: {
      capUsd: roundUsd(cap),
      safeCapUsd: roundUsd(safeCap),
      trackedSpendUsd: roundUsd(trackedSpend),
      safeRemainingUsd: safeRemaining == null ? null : roundUsd(safeRemaining),
      safeTextSlots,
      textPostCostUsd: roundUsd(textPostCost),
    },
    partitions: {
      rateLimit429: Number(triage.rateLimit429 || 0),
      backendFault5xx: Number(triage.backendFault5xx || 0),
      activeRateLimit429: active429,
      activeBackendFault5xx: active503,
      failureRatePct: Number(triage.failureRate || 0),
    },
    runwayGuard: runwayGuard || null,
    partitionMatrix,
    cooldownTimeline,
    cooldown: {
      active: Boolean(activeCooldown.active),
      remainingMinutes: Number(activeCooldown.remainingMinutes || 0),
      until: activeCooldown.until || null,
      reasonCode: activeCooldown.reasonCode || "none",
      endpoint: activeCooldown.endpoint || null,
      reason: activeCooldown.reason || "No active X API cooldown.",
    },
    cells: [
      { id: "read", label: "read gate", value: readGate, status: readGate === "closed" ? "danger" : "ok" },
      { id: "publish", label: "post gate", value: publishGate, status: publishGate === "open" ? "ok" : publishGate === "closed" ? "danger" : "warn" },
      { id: "rate_limit", label: "429 partition", value: active429, status: active429 > 0 ? "danger" : "ok" },
      { id: "backend", label: "503 partition", value: active503, status: active503 > 0 ? "danger" : "ok" },
      {
        id: "account_snapshot",
        label: "account snapshot",
        value: accountSnapshotCache?.due
          ? "refresh_due"
          : accountSnapshotCache?.enabled === false
            ? "disabled"
            : "cache_hit",
        status: accountSnapshotCache?.due
          ? "warn"
          : accountSnapshotCache?.enabled === false
            ? "warn"
            : "ok",
      },
      {
        id: "runway",
        label: "runway guard",
        value: activeRunwayGuard ? "cached_only" : "clear",
        status: activeRunwayGuard ? "warn" : "ok",
      },
      {
        id: "month_end",
        label: "month-end projection",
        value: runwayGuard?.monthEndProjectedSpendUsd == null ? "-" : `$${formatNumber(runwayGuard.monthEndProjectedSpendUsd, 3)}`,
        status: runwayGuard?.monthEndSafe === false ? "warn" : "ok",
      },
      { id: "safe_cap", label: "safe cap", value: `$${formatNumber(safeCap, 3)}`, status: "neutral" },
      {
        id: "safe_left",
        label: "safe left",
        value: safeRemaining == null ? "unlimited" : `$${formatNumber(safeRemaining, 3)}`,
        status: safeRemaining == null || safeRemaining > 0.5 ? "ok" : safeRemaining > 0 ? "warn" : "danger",
      },
    ],
    accountSnapshotCache: accountSnapshotCache || null,
    runbook,
    nextAction,
  };
}

function budgetMonthProgress(now = new Date().toISOString()) {
  const date = new Date(now);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const year = safeDate.getUTCFullYear();
  const month = safeDate.getUTCMonth();
  const day = safeDate.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    day,
    daysInMonth,
    daysElapsed: Math.max(1, day),
    daysRemaining: Math.max(0, daysInMonth - day),
    progressPct: Number(((day / daysInMonth) * 100).toFixed(1)),
  };
}

function buildBudgetBurnReactor({ usage, budgetState, cadence, operatorSlo, mediaRoiGate, now = new Date().toISOString() } = {}) {
  const cap = monthlyBudgetUsd();
  const safeCap = cap * budgetSafetyRatio();
  const trackedSpend = Math.max(Number(usage?.totalEstimatedUsd) || 0, Number(budgetState?.spentUsd) || 0);
  const safeRemaining = Math.max(0, safeCap - trackedSpend);
  const series = xApiDailySeries(usage, integerEnv("DASHBOARD_BUDGET_BURN_DAYS", 14, 7, 31));
  const recent7 = series.slice(-7);
  const recentSpend = recent7.reduce((sum, day) => sum + (Number(day.usd) || 0), 0);
  const activeSpendDays = recent7.filter((day) => Number(day.usd) > 0).length;
  const observedDailyBurn = recentSpend > 0 ? recentSpend / Math.max(1, activeSpendDays || recent7.length) : 0;
  const plannedDailyBurn = estimatedPostCost(false) * integerEnv("DASHBOARD_DAILY_POST_TARGET", 1, 0, 10);
  const dailyBurn = Math.max(observedDailyBurn, plannedDailyBurn);
  const runwayDays = dailyBurn > 0 ? safeRemaining / dailyBurn : null;
  const month = budgetMonthProgress(now);
  const burnPct = safeCap > 0 ? Math.min(140, (trackedSpend / safeCap) * 100) : 0;
  const monthEndSpend = trackedSpend + dailyBurn * month.daysRemaining;
  const monthEndSafe = cap <= 0 || monthEndSpend <= safeCap;
  const safeTextSlots = estimatedPostCost(false) > 0 ? Math.floor(safeRemaining / estimatedPostCost(false)) : 0;
  const safeMediaSlots = estimatedPostCost(true) > 0 ? Math.floor(safeRemaining / estimatedPostCost(true)) : 0;
  const readGate = cadence?.publishAllowed === false || safeRemaining <= 0 ? "sealed" : "cached_only";
  const mediaDecision = mediaRoiGate?.decision || "hold";

  const severity = safeRemaining <= 0 || burnPct >= 100
    ? "danger"
    : !monthEndSafe || (runwayDays !== null && runwayDays < Math.max(1, month.daysRemaining))
      ? "warn"
      : "ok";
  const runbook = severity === "danger"
    ? "Seal optional X spend. Keep manual web routes and cached dashboard only until budget resets."
    : severity === "warn"
      ? "Throttle standalone posts, keep media disabled, and route growth through zero-read manual route ops."
      : "Budget burn is inside the safe envelope. Preserve images behind ROI gate and keep live reads at zero.";

  return {
    generatedAt: now,
    zeroExtraXReads: true,
    source: "x_api_usage ledger + publish budget ledger",
    severity,
    mode: severity === "ok" ? "inside_safe_envelope" : severity === "warn" ? "burn_rate_watch" : "cost_partition_sealed",
    capUsd: roundUsd(cap),
    safeCapUsd: roundUsd(safeCap),
    spendUsd: roundUsd(trackedSpend),
    safeRemainingUsd: roundUsd(safeRemaining),
    burnPct: Number(burnPct.toFixed(1)),
    observedDailyBurnUsd: roundUsd(observedDailyBurn),
    plannedDailyBurnUsd: roundUsd(plannedDailyBurn),
    projectedDailyBurnUsd: roundUsd(dailyBurn),
    runwayDays: runwayDays === null ? null : Number(runwayDays.toFixed(1)),
    monthDay: month.day,
    daysInMonth: month.daysInMonth,
    daysRemaining: month.daysRemaining,
    monthProgressPct: month.progressPct,
    monthEndProjectedSpendUsd: roundUsd(monthEndSpend),
    monthEndSafe,
    safeTextSlots,
    safeMediaSlots,
    readGate,
    publishGate: cadence?.publishAllowed === false ? "guarded" : "review",
    mediaGate: mediaDecision,
    manualReplyCostUsd: Number(operatorSlo?.budgetUsdPerReply) || 0,
    runbook,
    cells: [
      { id: "burn", label: "safe burn", value: `${formatNumber(burnPct, 1)}%`, status: severity },
      { id: "runway", label: "runway", value: runwayDays === null ? "unlimited" : `${formatNumber(runwayDays, 1)}d`, status: severity === "danger" ? "danger" : monthEndSafe ? "ok" : "warn" },
      { id: "text_slots", label: "safe text slots", value: safeTextSlots, status: safeTextSlots > 3 ? "ok" : safeTextSlots > 0 ? "warn" : "danger" },
      { id: "media_slots", label: "safe media slots", value: safeMediaSlots, status: mediaDecision === "allow" && safeMediaSlots > 0 ? "ok" : "warn" },
    ],
    partitions: [
      { id: "manual_routes", label: "manual route lanes", value: "$0.000", status: "ok", detail: "operator paste loop" },
      { id: "text_publish", label: "text publish", value: `$${formatNumber(estimatedPostCost(false), 3)}`, status: safeTextSlots > 0 ? "ok" : "danger", detail: `${safeTextSlots} safe slots` },
      { id: "media_publish", label: "media publish", value: `$${formatNumber(estimatedPostCost(true), 3)}`, status: mediaDecision === "allow" && safeMediaSlots > 0 ? "ok" : "warn", detail: mediaRoiGate?.reason || "held behind ROI gate" },
      { id: "live_reads", label: "live X reads", value: "0 ops", status: readGate === "sealed" ? "danger" : "ok", detail: readGate },
    ],
    series,
  };
}

function budgetAllocationLane({
  id,
  label,
  costUsd,
  safeSlots,
  expectedLiftPct,
  gate,
  status,
  detail,
  nextAction,
  xReadOps = 0,
  priorityBoost = 0,
}) {
  const cost = Number(costUsd) || 0;
  const lift = Number(expectedLiftPct) || 0;
  const zeroCostBonus = cost <= 0 ? 62 : 0;
  const slotBonus = safeSlots == null ? 16 : Math.min(22, Math.max(0, Number(safeSlots)) * 3);
  const gatePenalty = gate === "sealed" ? 48 : gate === "guarded" ? 18 : 0;
  const readPenalty = xReadOps > 0 ? Math.min(30, xReadOps * 8) : 0;
  const efficiencyScore = boundedPercent(
    18 +
      zeroCostBonus +
      Math.min(32, lift * 0.42) +
      slotBonus +
      priorityBoost -
      gatePenalty -
      readPenalty,
  );
  return {
    id,
    label,
    costUsd: roundUsd(cost),
    safeSlots: safeSlots == null ? null : Math.max(0, Math.floor(Number(safeSlots) || 0)),
    expectedLiftPct: Number(lift.toFixed(1)),
    gate,
    status,
    efficiencyScore: Number(efficiencyScore.toFixed(1)),
    detail,
    nextAction,
    xReadOps,
    zeroExtraXReads: xReadOps === 0,
  };
}

function buildBudgetAllocationOptimizer({
  usage,
  budgetState,
  budgetBurnReactor,
  cadence,
  operatorSlo,
  routeAmplifier,
  growthKinetics,
  viralFlywheel,
  mediaRoiGate,
  now = new Date().toISOString(),
} = {}) {
  const cap = monthlyBudgetUsd();
  const safeCap = cap * budgetSafetyRatio();
  const spend = Math.max(Number(usage?.totalEstimatedUsd) || 0, Number(budgetState?.spentUsd) || 0);
  const safeRemaining = cap > 0 ? Math.max(0, safeCap - spend) : Number.POSITIVE_INFINITY;
  const textCost = estimatedPostCost(false);
  const mediaCost = estimatedPostCost(true);
  const readCost = estimatedEndpointCost("RECENT_SEARCH");
  const metricsCost = estimatedEndpointCost("TWEET_METRICS_LOOKUP");
  const textSlots = Number.isFinite(safeRemaining) && textCost > 0 ? Math.floor(safeRemaining / textCost) : null;
  const mediaSlots = Number.isFinite(safeRemaining) && mediaCost > 0 ? Math.floor(safeRemaining / mediaCost) : null;
  const metricsSlots = Number.isFinite(safeRemaining) && metricsCost > 0 ? Math.floor(safeRemaining / metricsCost) : null;
  const routeLift = Number(operatorSlo?.expectedLiftPct ?? routeAmplifier?.topRouteExpectedLiftPct ?? routeAmplifier?.expectedLiftPct ?? viralFlywheel?.expectedLiftPct ?? 0) || 0;
  const routeReady = Number(operatorSlo?.readyMissions ?? routeAmplifier?.readyLanes ?? routeAmplifier?.laneCount ?? 0) || 0;
  const velocity = Number(viralFlywheel?.velocityScore ?? growthKinetics?.kineticScore ?? 0) || 0;
  const textLift = Math.max(routeLift * 0.55, velocity * 0.28, Number(growthKinetics?.expectedLiftPct) || 0);
  const mediaLift = Number(mediaRoiGate?.mediaLiftPct);
  const telemetryAge = Number(cadence?.telemetryAgeMinutes);
  const telemetryStale = Number.isFinite(telemetryAge) && telemetryAge > 36 * 60;
  const publishGate = cadence?.publishAllowed === false ? "guarded" : "open";
  const mediaGate =
    mediaRoiGate?.attachImageAllowed && (mediaSlots == null || mediaSlots > 0)
      ? "open"
      : "guarded";
  const readGate = budgetBurnReactor?.readGate === "sealed" || safeRemaining <= 0 ? "sealed" : "cached_only";

  const lanes = [
    budgetAllocationLane({
      id: "manual_route_burst",
      label: "manual route burst",
      costUsd: 0,
      safeSlots: routeReady || null,
      expectedLiftPct: Math.max(routeLift, 18),
      gate: "open",
      status: routeReady ? "ok" : "warn",
      detail: "Operator paste loop uses prepared X web routes and spends no X search/read API.",
      nextAction: routeAmplifier?.nextAction || operatorSlo?.nextAction || "Execute the top manual route packet before buying more X API operations.",
      xReadOps: 0,
      priorityBoost: 10,
    }),
    budgetAllocationLane({
      id: "text_post_experiment",
      label: "text post experiment",
      costUsd: textCost,
      safeSlots: textSlots,
      expectedLiftPct: textLift,
      gate: publishGate,
      status: publishGate === "open" && (textSlots == null || textSlots > 0) ? "ok" : "warn",
      detail: cadence?.reason || "Cadence controller decides whether the next standalone post should publish.",
      nextAction: cadence?.nextAction || "Publish only inside the cadence and budget boundary.",
      xReadOps: 0,
      priorityBoost: publishGate === "open" ? 2 : -6,
    }),
    budgetAllocationLane({
      id: "media_post_surge",
      label: "media post surge",
      costUsd: mediaCost,
      safeSlots: mediaSlots,
      expectedLiftPct: Number.isFinite(mediaLift) ? mediaLift : 0,
      gate: mediaGate,
      status: mediaGate === "open" ? "ok" : "warn",
      detail: mediaRoiGate?.reason || "Image spend stays behind the cached media ROI gate.",
      nextAction: mediaRoiGate?.nextAction || "Keep images disabled until cached outcomes prove lift.",
      xReadOps: 0,
      priorityBoost: mediaGate === "open" ? 1 : -12,
    }),
    budgetAllocationLane({
      id: "metrics_refresh",
      label: "metrics refresh",
      costUsd: metricsCost,
      safeSlots: metricsSlots,
      expectedLiftPct: telemetryStale ? 8 : 2,
      gate: telemetryStale ? "guarded" : "closed",
      status: telemetryStale && (metricsSlots == null || metricsSlots > 0) ? "warn" : "ok",
      detail: telemetryStale
        ? `Telemetry age ${formatNumber(telemetryAge / 60, 1)}h; one measured refresh can improve writeback confidence.`
        : "Cached telemetry is fresh enough; do not spend a read just to make the dashboard prettier.",
      nextAction: telemetryStale ? "Run maintenance once, then return to cached-only operation." : "Hold metrics reads.",
      xReadOps: 1,
      priorityBoost: telemetryStale ? -2 : -18,
    }),
    budgetAllocationLane({
      id: "live_x_search",
      label: "live X search",
      costUsd: readCost,
      safeSlots: 0,
      expectedLiftPct: 0,
      gate: readGate === "sealed" ? "sealed" : "closed",
      status: "danger",
      detail: "Use browser/web search links instead; the bot should not burn X search/read quota for manual targeting.",
      nextAction: "Keep this partition sealed unless you explicitly switch out of the low-cost mode.",
      xReadOps: 1,
      priorityBoost: -40,
    }),
  ];

  const ranked = [...lanes].sort((left, right) => {
    const statusWeight = { ok: 2, warn: 1, danger: 0 };
    return (
      (statusWeight[right.status] || 0) - (statusWeight[left.status] || 0) ||
      right.efficiencyScore - left.efficiencyScore
    );
  });
  const recommended = ranked[0] || lanes[0];
  const severity = recommended?.id === "manual_route_burst"
    ? "ok"
    : recommended?.status || "warn";
  const monthlyRunway = Number(budgetBurnReactor?.runwayDays);

  return {
    generatedAt: now,
    mode: "zero_read_budget_allocator",
    zeroExtraXReads: true,
    source: "cached cost ledger + route amplifier + cadence controller",
    severity,
    recommendedLaneId: recommended?.id || null,
    recommendedAction: recommended?.nextAction || "Use manual routes before paid X operations.",
    safeRemainingUsd: Number.isFinite(safeRemaining) ? roundUsd(safeRemaining) : null,
    capUsd: roundUsd(cap),
    safeCapUsd: roundUsd(safeCap),
    monthRunwayDays: Number.isFinite(monthlyRunway) ? Number(monthlyRunway.toFixed(1)) : null,
    lanes,
    rankedLaneIds: ranked.map((lane) => lane.id),
    cells: [
      { id: "recommended", label: "top allocation", value: recommended?.label || "-", status: recommended?.status || "warn" },
      { id: "safe_left", label: "safe left", value: Number.isFinite(safeRemaining) ? `$${formatNumber(safeRemaining, 3)}` : "unlimited", status: safeRemaining > 0.5 ? "ok" : safeRemaining > 0 ? "warn" : "danger" },
      { id: "text_slots", label: "text slots", value: textSlots == null ? "unlimited" : textSlots, status: textSlots == null || textSlots > 0 ? "ok" : "danger" },
      { id: "x_reads", label: "live X reads", value: "sealed", status: "danger" },
    ],
    runbook: `Allocate the next growth loop to ${recommended?.label || "manual routes"}; keep live X reads sealed and spend only when cadence/ROI gates are open.`,
  };
}

function buildGrowthRunwaySimulator({
  growthGoal = null,
  growthKinetics = null,
  routeAmplifier = null,
  budgetAllocationOptimizer = null,
  operatorSlo = null,
  viralFlywheel = null,
  cadence = null,
  learningWriteback = null,
  growthMissionControl = null,
  now = new Date().toISOString(),
} = {}) {
  const currentFollowers = Number(growthKinetics?.currentFollowers ?? growthGoal?.currentFollowers) || 0;
  const nextMilestone = Number(growthKinetics?.nextMilestone ?? growthGoal?.nextMilestone) || nextFollowerMilestone(currentFollowers, Number(growthGoal?.targetFollowers) || 1000);
  const remainingToMilestone = Math.max(0, Number(growthKinetics?.remainingToMilestone ?? (nextMilestone - currentFollowers)) || 0);
  const conversionPer1k = Math.max(0, Number(growthKinetics?.effectiveConversionPer1k) || 0);
  const dailyThroughput = Number(growthKinetics?.impressions7d) > 0
    ? Number(growthKinetics.impressions7d) / 7
    : Number(growthKinetics?.impressions24h) || 0;
  const projected = Number(growthKinetics?.projectedDaysToMilestone);
  const derivedDailyNewFollowers = dailyThroughput > 0 && conversionPer1k > 0
    ? (dailyThroughput * conversionPer1k) / 1000
    : 0;
  const baseDays = Number.isFinite(projected) && projected >= 0
    ? projected
    : remainingToMilestone > 0 && derivedDailyNewFollowers > 0
      ? remainingToMilestone / derivedDailyNewFollowers
      : null;
  const baselineRunwayLabel = baseDays == null
    ? "collect samples"
    : `${formatNumber(baseDays, baseDays > 30 ? 0 : 1)}d`;
  const sampleCount = Number(learningWriteback?.sampleCount ?? operatorSlo?.learningSamples ?? 0) || 0;
  const routeLift = Number(routeAmplifier?.topRouteExpectedLiftPct ?? routeAmplifier?.expectedLiftPct ?? operatorSlo?.expectedLiftPct ?? 0) || 0;
  const flywheelVelocity = Number(viralFlywheel?.velocityScore ?? growthMissionControl?.velocityScore ?? 0) || 0;
  const publishGate = cadence?.publishAllowed === false ? "guarded" : "open";
  const sourceLanes = Array.isArray(budgetAllocationOptimizer?.lanes)
    ? budgetAllocationOptimizer.lanes
    : [];
  const fallbackLanes = [
    budgetAllocationLane({
      id: "manual_route_burst",
      label: "manual route burst",
      costUsd: 0,
      safeSlots: Number(routeAmplifier?.readyLanes ?? operatorSlo?.readyMissions ?? 0) || null,
      expectedLiftPct: Math.max(routeLift, 18),
      gate: "open",
      status: Number(routeAmplifier?.readyLanes ?? operatorSlo?.readyMissions ?? 0) > 0 ? "ok" : "warn",
      detail: "Operator route ops use cached drafts and X web links without search/read API spend.",
      nextAction: routeAmplifier?.nextAction || operatorSlo?.nextAction || "Execute the highest leverage manual route before spending on paid operations.",
      xReadOps: 0,
      priorityBoost: 10,
    }),
    budgetAllocationLane({
      id: "text_post_experiment",
      label: "text post experiment",
      costUsd: estimatedPostCost(false),
      safeSlots: null,
      expectedLiftPct: Math.max(Number(growthKinetics?.expectedLiftPct) || 0, flywheelVelocity * 0.24),
      gate: publishGate,
      status: publishGate === "open" ? "ok" : "warn",
      detail: cadence?.reason || "Cadence gate controls standalone packets.",
      nextAction: cadence?.nextAction || "Publish only inside learned cadence windows.",
      xReadOps: 0,
      priorityBoost: publishGate === "open" ? 2 : -6,
    }),
  ];
  const lanes = (sourceLanes.length ? sourceLanes : fallbackLanes).map((lane, index) => {
    const status = ["ok", "warn", "danger"].includes(lane.status) ? lane.status : "warn";
    const gate = lane.gate || "open";
    const xReadOps = Math.max(0, Number(lane.xReadOps) || 0);
    const blocked = status === "danger" || gate === "closed" || gate === "sealed" || xReadOps > 0;
    const expectedLiftPct = blocked ? 0 : Math.max(0, Number(lane.expectedLiftPct) || 0);
    const projectedDays = baseDays == null
      ? null
      : blocked
        ? baseDays
        : baseDays / (1 + expectedLiftPct / 100);
    const savedDays = baseDays == null || projectedDays == null ? 0 : Math.max(0, baseDays - projectedDays);
    const confidenceScore = boundedPercent(
      22 +
        (status === "ok" ? 22 : status === "warn" ? 10 : -10) +
        Math.min(22, Number(lane.efficiencyScore) * 0.22) +
        Math.min(18, expectedLiftPct * 0.28) +
        Math.min(10, sampleCount * 1.4) +
        (xReadOps === 0 ? 6 : -18),
    );
    return {
      id: lane.id || `runway_lane:${index + 1}`,
      label: lane.label || lane.id || `lane ${index + 1}`,
      rank: index + 1,
      gate,
      status,
      blocked,
      zeroExtraXReads: xReadOps === 0,
      xReadOps,
      costUsd: roundUsd(lane.costUsd),
      safeSlots: lane.safeSlots == null ? null : Math.max(0, Number(lane.safeSlots) || 0),
      expectedLiftPct: Number(expectedLiftPct.toFixed(1)),
      efficiencyScore: Number((Number(lane.efficiencyScore) || 0).toFixed(1)),
      confidence: confidenceScore >= 72 ? "high" : confidenceScore >= 48 ? "medium" : "low",
      confidenceScore: Number(confidenceScore.toFixed(1)),
      projectedDays: projectedDays == null ? null : Number(projectedDays.toFixed(1)),
      savedDays: Number(savedDays.toFixed(1)),
      detail: lane.detail || "cached allocation lane",
      nextAction: lane.nextAction || "Use this lane only when its gate is open.",
    };
  });
  const ranked = [...lanes].sort((left, right) => {
    const leftBlocked = left.blocked ? 1 : 0;
    const rightBlocked = right.blocked ? 1 : 0;
    return (
      leftBlocked - rightBlocked ||
      right.savedDays - left.savedDays ||
      right.efficiencyScore - left.efficiencyScore ||
      right.expectedLiftPct - left.expectedLiftPct
    );
  });
  const recommended = ranked.find((lane) => !lane.blocked && lane.xReadOps === 0) || ranked[0] || null;
  const projectedDays = recommended?.projectedDays ?? baseDays;
  const savedDays = baseDays == null || projectedDays == null ? 0 : Math.max(0, baseDays - projectedDays);
  const severity = remainingToMilestone <= 0
    ? "ok"
    : baseDays == null
      ? "warn"
      : recommended?.status === "ok" && savedDays > 0
        ? "ok"
        : recommended?.status || "warn";
  const mode = baseDays == null
    ? "sample_starved"
    : recommended?.id === "manual_route_burst"
      ? "route_acceleration"
      : recommended?.id === "text_post_experiment"
        ? "cadence_acceleration"
        : recommended?.id === "media_post_surge"
          ? "roi_guarded_surge"
          : "budget_containment";
  const savedDaysLabel = baseDays == null
    ? "-"
    : `${formatNumber(savedDays, savedDays > 30 ? 0 : 1)}d`;
  const projectedDaysLabel = projectedDays == null
    ? "collect samples"
    : `${formatNumber(projectedDays, projectedDays > 30 ? 0 : 1)}d`;
  const recommendedAction = recommended?.nextAction || "Collect fresh cached telemetry before changing the control loop.";

  return {
    generatedAt: now,
    mode,
    source: "cached traffic kinetics + route amplifier + budget allocation optimizer",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    severity,
    currentFollowers,
    nextMilestone,
    remainingToMilestone,
    dailyThroughput: Number(dailyThroughput.toFixed(1)),
    conversionPer1k: Number(conversionPer1k.toFixed(2)),
    baseline: {
      projectedDays: baseDays == null ? null : Number(baseDays.toFixed(1)),
      dailyThroughput: Number(dailyThroughput.toFixed(1)),
      dailyNewFollowers: Number(derivedDailyNewFollowers.toFixed(2)),
      conversionPer1k: Number(conversionPer1k.toFixed(2)),
    },
    recommendedLaneId: recommended?.id || null,
    recommendedAction,
    projectedLiftPct: Number((recommended?.expectedLiftPct || 0).toFixed(1)),
    projectedDaysToMilestone: projectedDays == null ? null : Number(projectedDays.toFixed(1)),
    savedDays: Number(savedDays.toFixed(1)),
    confidence: recommended?.confidence || (baseDays == null ? "low" : "medium"),
    deckScore: Number(boundedPercent((recommended?.efficiencyScore || 0) * 0.62 + (recommended?.confidenceScore || 0) * 0.38).toFixed(1)),
    cells: [
      { id: "baseline_days", label: "baseline runway", value: baselineRunwayLabel, status: baseDays == null ? "warn" : baseDays <= 14 ? "ok" : baseDays <= 45 ? "warn" : "danger" },
      { id: "projected_days", label: "simulated runway", value: projectedDaysLabel, status: severity },
      { id: "saved_days", label: "days compressed", value: savedDaysLabel, status: savedDays > 0 ? "ok" : "warn" },
      { id: "x_reads", label: "X read ops", value: "0", status: "ok" },
    ],
    lanes,
    rankedLaneIds: ranked.map((lane) => lane.id),
    runbook: [
      `Dispatch ${recommended?.label || "manual route burst"} first; it has the best cached efficiency under the zero-read constraint.`,
      "Keep live X search/read partitions sealed; use prepared web routes and cached telemetry for the operator loop.",
      baseDays == null
        ? "Refresh metrics through scheduled maintenance only when telemetry is stale; otherwise keep collecting conversion samples."
        : `Current model estimates ${projectedDaysLabel} to ${formatNumber(nextMilestone)} active conns after the recommended lane.`,
    ],
  };
}

function buildOperatorFlightDeck({
  distributionOps = null,
  operatorDispatchPacket = null,
  routeAmplifier = null,
  growthRunwaySimulator = null,
  growthMissionControl = null,
  rateLimitGovernor = null,
  budgetAllocationOptimizer = null,
  learningWriteback = null,
  cadence = null,
  now = new Date().toISOString(),
} = {}) {
  const missions = Array.isArray(distributionOps?.missions) ? distributionOps.missions : [];
  const packets = Array.isArray(operatorDispatchPacket?.packets) ? operatorDispatchPacket.packets : [];
  const lanes = Array.isArray(routeAmplifier?.lanes) ? routeAmplifier.lanes : [];
  const firstReadyPacket = packets.find((packet) => packet?.ready && packet?.routeUrl && packet?.draftText) || packets.find((packet) => packet?.routeUrl || packet?.draftText) || packets[0] || null;
  const topRouteLane = lanes.find((lane) => lane?.ready) || lanes[0] || null;
  const routeLabel = firstReadyPacket?.routeLabel || topRouteLane?.label || distributionOps?.primaryRoute?.label || "manual route queue";
  const routeUrl = firstReadyPacket?.routeUrl || topRouteLane?.routeUrl || distributionOps?.primaryRoute?.url || null;
  const draftText = firstReadyPacket?.draftText || missions.find((mission) => mission?.draftText)?.draftText || "";
  const targetReplies = Math.max(
    1,
    Number(operatorDispatchPacket?.targetReplies) ||
      Number(distributionOps?.manualReplyTarget) ||
      Number(growthMissionControl?.targetReplies) ||
      3,
  );
  const readyPackets = Number(operatorDispatchPacket?.readyPackets ?? distributionOps?.readyMissions) || 0;
  const totalPackets = Number(operatorDispatchPacket?.totalPackets ?? distributionOps?.missionCount ?? packets.length ?? missions.length) || 0;
  const safeRemainingUsd = Number(
    operatorDispatchPacket?.safeRemainingUsd ??
      budgetAllocationOptimizer?.safeRemainingUsd ??
      rateLimitGovernor?.budget?.safeRemainingUsd,
  );
  const readGate = rateLimitGovernor?.gates?.read || growthMissionControl?.readGate || "cached_only";
  const publishGate = rateLimitGovernor?.gates?.publish || cadence?.publishGate || (cadence?.publishAllowed === false ? "guarded" : "review");
  const runwayLane = (growthRunwaySimulator?.lanes || []).find((lane) => lane?.id === growthRunwaySimulator?.recommendedLaneId) || (growthRunwaySimulator?.lanes || [])[0] || null;
  const runwayDays = Number(growthRunwaySimulator?.projectedDaysToMilestone);
  const savedDays = Number(growthRunwaySimulator?.savedDays) || 0;
  const ampScore = Number(topRouteLane?.score ?? routeAmplifier?.topRouteScore ?? 0) || 0;
  const expectedLiftPct = Number(
    runwayLane?.expectedLiftPct ??
      growthRunwaySimulator?.projectedLiftPct ??
      operatorDispatchPacket?.expectedLiftPct ??
      topRouteLane?.expectedLiftPct ??
      0,
  ) || 0;
  const routeReadyPct = totalPackets ? (readyPackets / totalPackets) * 100 : readyPackets ? 100 : 0;
  const budgetReady = !Number.isFinite(safeRemainingUsd) || safeRemainingUsd > 0;
  const readGateHealthy = readGate !== "closed";
  const learningSamples = Number(learningWriteback?.sampleCount) || 0;
  const commandScore = boundedPercent(
    18 +
      Math.min(24, routeReadyPct * 0.24) +
      Math.min(20, ampScore * 0.2) +
      Math.min(18, expectedLiftPct * 0.28) +
      Math.min(12, savedDays * 0.08) +
      Math.min(8, learningSamples * 0.8) +
      (budgetReady ? 8 : -18) +
      (readGateHealthy ? 6 : -10),
  );
  const severity = !draftText || !routeUrl || !budgetReady
    ? readyPackets ? "warn" : "danger"
    : commandScore >= 62
      ? "ok"
      : "warn";
  const commandMode = severity === "ok"
    ? "armed_manual_dispatch"
    : severity === "warn"
      ? "operator_review"
      : "route_queue_fault";
  const primaryCommand = routeUrl && draftText
    ? `Open ${routeLabel}, paste the paired output once, then continue until ${formatNumber(targetReplies)} useful route ops are complete.`
    : "Repair the route URL/output pair before dispatching the manual loop.";
  const copyBlock = [
    "CODEX OPERATOR FLIGHT DECK",
    `Generated: ${now}`,
    `Mode: ${commandMode}`,
    "Cost guard: 0 extra X search/read API ops",
    `Route: ${routeLabel}`,
    routeUrl ? `Open: ${routeUrl}` : null,
    `Target: ${formatNumber(targetReplies)} useful route ops`,
    Number.isFinite(runwayDays) ? `Runway model: ${formatNumber(runwayDays, runwayDays > 30 ? 0 : 1)}d to next milestone · ${formatNumber(savedDays, savedDays > 30 ? 0 : 1)}d compressed` : null,
    "",
    "Command:",
    primaryCommand,
    "",
    "Output:",
    draftText || "MISSING_OUTPUT",
    "",
    "Stop conditions: no politics, no giveaways, no ragebait, no unsupported claims, no weak tech fit.",
  ].filter(Boolean).join("\n");

  return {
    generatedAt: now,
    mode: "zero_read_operator_flight_deck",
    commandMode,
    source: "operator dispatch packet + route amplifier + growth runway simulator",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    severity,
    commandScore: Number(commandScore.toFixed(1)),
    primaryCommand,
    targetReplies,
    readyPackets,
    totalPackets,
    routeLabel,
    routeUrl,
    draftText,
    copyBlock,
    runway: {
      recommendedLaneId: growthRunwaySimulator?.recommendedLaneId || null,
      projectedDaysToMilestone: Number.isFinite(runwayDays) ? Number(runwayDays.toFixed(1)) : null,
      savedDays: Number(savedDays.toFixed(1)),
      projectedLiftPct: Number(expectedLiftPct.toFixed(1)),
    },
    gates: [
      { id: "read", label: "read gate", value: readGate, status: readGateHealthy ? "ok" : "danger" },
      { id: "publish", label: "publish gate", value: publishGate, status: publishGate === "open" ? "ok" : "warn" },
      { id: "budget", label: "safe cost partition", value: Number.isFinite(safeRemainingUsd) ? `$${formatNumber(safeRemainingUsd, 3)}` : "cache-only", status: budgetReady ? "ok" : "danger" },
      { id: "writeback", label: "learning samples", value: formatNumber(learningSamples), status: learningSamples > 0 ? "ok" : "warn" },
    ],
    phases: [
      { id: "arm", label: "ARM_ROUTE", status: routeUrl ? "ok" : "danger", detail: routeUrl ? routeLabel : "missing route URL" },
      { id: "paste", label: "PASTE_OUTPUT", status: draftText ? "ok" : "danger", detail: draftText ? "paired output ready" : "missing output payload" },
      { id: "stop", label: "STOP_AT_TARGET", status: "ok", detail: `${formatNumber(targetReplies)} useful route ops max` },
      { id: "learn", label: "WRITEBACK", status: "ok", detail: "next maintenance run updates scoring" },
    ],
    packets: packets.slice(0, 3).map((packet, index) => ({
      id: packet.id || `flight:${index + 1}`,
      priority: packet.priority || index + 1,
      routeLabel: packet.routeLabel || packet.label || `Route ${index + 1}`,
      routeUrl: packet.routeUrl || null,
      ready: Boolean(packet.ready && packet.routeUrl && packet.draftText),
      confidence: packet.confidence || "low",
      operatorSlaMinutes: Math.max(5, Number(packet.operatorSlaMinutes) || 10 + index * 10),
      targetReplies: Math.max(1, Number(packet.targetReplies) || 1),
      expectedLiftPct: Number((Number(packet.expectedLiftPct) || 0).toFixed(1)),
    })),
  };
}

function buildGrowthControlPlane({
  state,
  insights,
  usage,
  cadence,
  statusTriage,
  cooldown,
  experimentPlan,
  opportunities,
  drafts,
  actions,
  now,
} = {}) {
  const recent24h = recordsSince(state || emptyTweetAnalyticsState(), 24);
  const recent7d = recordsSince(state || emptyTweetAnalyticsState(), 24 * 7);
  const apiCap = monthlyBudgetUsd();
  const safeCap = apiCap * budgetSafetyRatio();
  const trackedSpend = Number(usage?.totalEstimatedUsd) || 0;
  const safeRemaining = apiCap > 0 ? Math.max(0, safeCap - trackedSpend) : null;
  const safeRemainingRatio = safeCap > 0 && safeRemaining != null ? safeRemaining / safeCap : 1;
  const textPostCost = estimatedPostCost(false);
  const safeTextPostsLeft =
    safeRemaining == null || textPostCost <= 0
      ? null
      : Math.max(0, Math.floor(safeRemaining / textPostCost));
  const draftCount = Array.isArray(drafts) ? drafts.length : 0;
  const routeCount = Array.isArray(actions) ? actions.length : 0;
  const slots = Number(experimentPlan?.budgetSafeSlots) || 0;
  const topOpportunity = Array.isArray(opportunities) ? opportunities[0] : null;
  const topFormat = Array.isArray(experimentPlan?.recommendedFormats)
    ? experimentPlan.recommendedFormats[0]
    : null;
  const triage = statusTriage || buildDashboardStatusTriage(usage || {});
  const activeCooldown = cooldown || evaluateXApiCooldown(usage || {}, now ? new Date(now) : new Date());

  let mode = "scale_experiment";
  let severity = "ok";
  let decision = "Publish the next controlled post experiment, then distribute it manually.";
  let nextAction = cadence?.nextAction || "Proceed under the current budget guard.";
  let publishGate = cadence?.publishAllowed ? "open" : "guarded";
  let readGate = "cached_only";

  if (activeCooldown.active) {
    mode = "cooldown";
    severity = "danger";
    decision = "Live X read/search gates are closed until the cooldown expires; cached dashboard and manual route ops stay online.";
    nextAction = activeCooldown.reason;
    publishGate = "guarded";
    readGate = "closed";
  } else if ((triage.activeAuthFault4xx || 0) > 0) {
    mode = "auth_repair";
    severity = "warn";
    decision = "Keep manual web routing online, but repair OAuth before enabling automated write paths.";
    nextAction = triage.action;
    publishGate = cadence?.publishAllowed ? "review" : "guarded";
    readGate = "cached_only";
  } else if (safeTextPostsLeft != null && safeTextPostsLeft <= 0) {
    mode = "budget_guard";
    severity = "danger";
    decision = "No budget-safe text post slots remain; shift all growth work to zero-read manual distribution.";
    nextAction = "Use manual route outputs and cached dashboard telemetry only.";
    publishGate = "closed";
  } else if (cadence?.willBlockPublish || cadence?.publishAllowed === false || slots <= 0) {
    mode = "manual_distribution";
    severity = cadence?.severity === "danger" ? "danger" : "warn";
    decision = "Spend this loop on manual route ops under high-signal conversations before another standalone post.";
    nextAction = cadence?.nextAction || experimentPlan?.decision || "Use manual route lanes first.";
    publishGate = cadence?.willBlockPublish ? "closed" : "review";
  } else if (!draftCount || !routeCount) {
    mode = "queue_starved";
    severity = "warn";
    decision = "Draft or route queues are thin; generate manual route assets before pushing distribution.";
    nextAction = "Run growth maintenance to refresh reply drafts and manual route targets.";
    publishGate = "review";
  }

  const pressureScore = boundedPercent(
    20 +
      Math.min(28, Number(topOpportunity?.score || insights?.baselineScore || 0) * 3.2) +
      Math.min(16, draftCount * 3) +
      Math.min(12, routeCount * 4) +
      Math.min(12, slots * 4) +
      safeRemainingRatio * 12 -
      (severity === "danger" ? 38 : severity === "warn" ? 16 : 0),
  );
  const distributionGate = draftCount && routeCount ? "ready" : "starved";
  const budgetGate = safeTextPostsLeft == null
    ? "unlimited"
    : safeTextPostsLeft > 0
      ? `${safeTextPostsLeft} safe text slots`
      : "closed";
  const currentLoad = sumTweetMetric(recent24h, "impression_count");
  const sevenDayLoad = sumTweetMetric(recent7d, "impression_count");

  return {
    generatedAt: now || new Date().toISOString(),
    mode,
    severity,
    pressureScore: Number(pressureScore.toFixed(1)),
    decision,
    nextAction,
    publishGate,
    readGate,
    distributionGate,
    budgetGate,
    zeroExtraXReads: true,
    queueDepth: {
      drafts: draftCount,
      routes: routeCount,
      experimentSlots: slots,
      postsLast24h: recent24h.length,
    },
    topRoute: topOpportunity
      ? {
          label: topOpportunity.routeLabel || topOpportunity.label,
          url: topOpportunity.routeUrl || null,
          score: topOpportunity.score || null,
          reason: topOpportunity.reason || "",
        }
      : null,
    topFormat: topFormat
      ? {
          id: topFormat.id,
          label: topFormat.label,
          action: topFormat.action,
          avgScore: topFormat.avgScore,
          samples: topFormat.samples,
        }
      : null,
    topDraft: drafts?.[0]?.text || "",
    pulses: [
      {
        id: "publish",
        label: "publish gate",
        value: publishGate,
        status: publishGate === "open" ? "ok" : publishGate === "closed" ? "danger" : "warn",
        detail: cadence?.reason || decision,
      },
      {
        id: "read",
        label: "X read gate",
        value: activeCooldown.active ? `${activeCooldown.remainingMinutes} min cooldown` : readGate,
        status: readGate === "closed" ? "danger" : "ok",
        detail: activeCooldown.active
          ? activeCooldown.reason
          : `${triage.activeRateLimit429 || 0} active rate-limit / ${triage.activeBackendFault5xx || 0} active backend faults`,
      },
      {
        id: "budget",
        label: "cost partition",
        value: safeRemaining == null ? "unlimited" : `$${formatNumber(safeRemaining, 2)}`,
        status: safeTextPostsLeft == null || safeTextPostsLeft > 2 ? "ok" : safeTextPostsLeft > 0 ? "warn" : "danger",
        detail: budgetGate,
      },
      {
        id: "distribution",
        label: "manual route queue",
        value: `${draftCount}/${routeCount}`,
        status: distributionGate === "ready" ? "ok" : "warn",
        detail: "drafts/routes ready; 0 extra X reads",
      },
      {
        id: "learning",
        label: "learning load",
        value: formatNumber(currentLoad),
        status: currentLoad > 0 || sevenDayLoad > 0 ? "ok" : "warn",
        detail: `${formatNumber(sevenDayLoad)} L7 events in 7d feedback window`,
      },
    ],
    safeguards: [
      "No automated replies outside mention/engagement policy.",
      "No live X search/read when 429 or 5xx faults are active.",
      "Manual web routes spend 0 X API read budget.",
      "Cadence and safe-cap gates can block standalone posts.",
    ],
  };
}

function buildDistributionOps({ opportunities, actions, drafts, insights, cadence, controlPlane, now } = {}) {
  const dailyReplyTarget = integerEnv("DASHBOARD_DAILY_REPLY_TARGET", 3, 1, 20);
  const baseline = Math.max(1, Number(insights?.baselineScore) || 1);
  const source = Array.isArray(opportunities) && opportunities.length
    ? opportunities
    : (actions || []).map((action, index) => ({
        id: `route:${action.label || index + 1}`,
        label: action.label,
        kind: "route",
        priority: index + 1,
        score: baseline,
        confidence: "low",
        routeLabel: action.label,
        routeUrl: action.url,
        draftIndex: action.draftIndex ?? index,
        reason: action.reason,
        evidence: action.reason,
        zeroExtraXReads: true,
      }));

  const missions = source.slice(0, 3).map((item, index) => {
    const draft = item.draftText
      ? { text: item.draftText, angle: item.draftAngle || "" }
      : (drafts || [])[Math.min(Math.max(0, item.draftIndex ?? index), Math.max(0, (drafts || []).length - 1))] || (drafts || [])[0] || {};
    const score = Number(item.score) || baseline;
    const expectedLift = Math.max(0, (score - baseline) / baseline);
    const replies = Math.max(1, Math.ceil(dailyReplyTarget / Math.max(1, Math.min(3, source.length || 1))));
    const mission = {
      id: item.id || `mission:${index + 1}`,
      priority: item.priority || index + 1,
      label: item.label || item.routeLabel || `Route ${index + 1}`,
      kind: item.kind || "route",
      routeLabel: item.routeLabel || item.label || `Route ${index + 1}`,
      routeUrl: item.routeUrl || null,
      routeReason: item.reason || item.evidence || "",
      evidence: item.evidence || "",
      score: Number(score.toFixed(1)),
      expectedLiftPct: Number((expectedLift * 100).toFixed(1)),
      confidence: item.confidence || "low",
      targetReplies: replies,
      operatorSlaMinutes: 10 + index * 10,
      draftText: draft.text || "",
      draftAngle: draft.angle || "",
      zeroExtraXReads: true,
      costEfficiency: {
        mode: "manual_web_route",
        xReadOps: 0,
        incrementalXApiUsd: 0,
        label: "0 incremental X API spend",
      },
    };
    return {
      ...mission,
      operatorProtocol: buildMissionOperatorProtocol({ mission, index, dailyReplyTarget }),
    };
  });

  const readyMissions = missions.filter((mission) => mission.routeUrl && mission.draftText).length;
  const topMission = missions[0] || null;
  const queueHealth = readyMissions >= Math.min(2, missions.length || 1)
    ? "ok"
    : readyMissions > 0
      ? "warn"
      : "danger";
  const mode = controlPlane?.mode || cadence?.mode || "manual_distribution";

  return {
    generatedAt: now || new Date().toISOString(),
    mode,
    queueHealth,
    zeroExtraXReads: true,
    manualReplyTarget: dailyReplyTarget,
    readyMissions,
    missionCount: missions.length,
    primaryRoute: topMission
      ? {
          label: topMission.routeLabel,
          url: topMission.routeUrl,
          score: topMission.score,
          confidence: topMission.confidence,
        }
      : null,
    opsMetrics: [
      { id: "target", label: "route target", value: `${dailyReplyTarget}/day`, status: "ok" },
      { id: "queue", label: "route queue", value: `${readyMissions}/${missions.length}`, status: queueHealth },
      { id: "budget", label: "X read burn", value: "0 ops", status: "ok" },
      {
        id: "learning",
        label: "writeback",
        value: `${formatNumber(Number(insights?.records?.length) || 0)} packets`,
        status: Number(insights?.records?.length) > 0 ? "ok" : "warn",
      },
    ],
    runbook: [
      "Open the top route in X web.",
      `Paste ${dailyReplyTarget} useful route ops under fresh, high-signal conversations.`,
      "Prefer posts less than 2 hours old with active technical debate.",
      "Let the next maintenance run write engagement back into the learning layer.",
    ],
    missions,
  };
}

function buildOperatorDispatchPacket({
  distributionOps,
  opportunities,
  drafts,
  actions,
  operatorSlo = null,
  viralFlywheel = null,
  controlPlane = null,
  budgetBurnReactor = null,
  now = new Date().toISOString(),
} = {}) {
  const sourceMissions = Array.isArray(distributionOps?.missions) ? distributionOps.missions : [];
  const fallbackMissions = !sourceMissions.length && Array.isArray(actions)
    ? actions.slice(0, 3).map((action, index) => {
        const draft = (drafts || [])[Math.min(Math.max(0, action.draftIndex ?? index), Math.max(0, (drafts || []).length - 1))] || (drafts || [])[0] || {};
        return {
          id: `manual:${index + 1}`,
          priority: index + 1,
          label: action.label || `Route ${index + 1}`,
          routeLabel: action.label || `Route ${index + 1}`,
          routeUrl: action.url || null,
          routeReason: action.reason || "",
          evidence: action.reason || "",
          score: Number(operatorSlo?.baselineScore) || 1,
          expectedLiftPct: 0,
          targetReplies: 1,
          operatorSlaMinutes: 10 + index * 10,
          draftText: draft.text || "",
          draftAngle: draft.angle || "",
          zeroExtraXReads: true,
          costEfficiency: { label: "0 incremental X API spend", xReadOps: 0, incrementalXApiUsd: 0 },
        };
      })
    : [];
  const missions = (sourceMissions.length ? sourceMissions : fallbackMissions).slice(0, 5);
  const readyPackets = missions.filter((mission) => mission.routeUrl && mission.draftText);
  const targetReplies = missions.reduce((sum, mission) => sum + Math.max(0, Number(mission.targetReplies) || 0), 0) ||
    Number(distributionOps?.manualReplyTarget) ||
    integerEnv("DASHBOARD_DAILY_REPLY_TARGET", 3, 1, 20);
  const expectedLiftPct = missions.length
    ? missions.reduce((sum, mission) => sum + (Number(mission.expectedLiftPct) || 0), 0) / missions.length
    : 0;
  const apiRemaining = Number(operatorSlo?.safeRemainingUsd ?? budgetBurnReactor?.safeRemainingUsd);
  const safeRemainingLabel = Number.isFinite(apiRemaining) ? `$${formatNumber(apiRemaining, 2)}` : "cache-only";
  const bestRoute = missions[0] || null;
  const severity = readyPackets.length >= Math.min(2, missions.length || 1)
    ? "ok"
    : readyPackets.length
      ? "warn"
      : "danger";
  const mode = controlPlane?.mode || viralFlywheel?.mode || distributionOps?.mode || "manual_zero_read_dispatch";
  const nextAction = readyPackets.length
    ? `Open ${bestRoute?.routeLabel || bestRoute?.label || "the top route"} in X web, paste the first ready output, then stop at ${formatNumber(targetReplies)} useful route ops.`
    : "Generate or refresh manual route outputs before dispatching.";
  const packets = missions.map((mission, index) => {
    const draft = mission.draftText || (drafts || [])[Math.min(index, Math.max(0, (drafts || []).length - 1))]?.text || "";
    const routeLabel = mission.routeLabel || mission.label || `Route ${index + 1}`;
    return {
      id: mission.id || `dispatch:${index + 1}`,
      priority: mission.priority || index + 1,
      label: mission.label || routeLabel,
      routeLabel,
      routeUrl: mission.routeUrl || null,
      reason: mission.routeReason || mission.evidence || "",
      evidence: mission.evidence || mission.routeReason || "",
      draftText: draft,
      draftAngle: mission.draftAngle || "",
      targetReplies: Math.max(1, Number(mission.targetReplies) || 1),
      operatorSlaMinutes: Math.max(5, Number(mission.operatorSlaMinutes) || 10 + index * 10),
      expectedLiftPct: Number((Number(mission.expectedLiftPct) || 0).toFixed(1)),
      confidence: mission.confidence || "low",
      zeroExtraXReads: mission.zeroExtraXReads !== false,
      ready: Boolean(mission.routeUrl && draft),
    };
  });
  const copyBlock = [
    "CODEX DAILY DISPATCH PACKET",
    `Generated: ${now}`,
    `Mode: ${mode}`,
    `Cost guard: 0 extra X search/read API ops · safe budget ${safeRemainingLabel}`,
    `Target: ${formatNumber(targetReplies)} useful manual route ops · expected lift +${formatNumber(expectedLiftPct, 1)}%`,
    "",
    "Protocol:",
    "1. Open the top X web route; use live recency in the browser only.",
    "2. Pick technical conversations with active exchange and clear topic fit.",
    "3. Paste one useful route op, lightly edit for context, then move to the next route.",
    "4. Stop at the target count; metrics write back on the next maintenance run.",
    "",
    "Packets:",
    ...packets.slice(0, 5).flatMap((packet) => [
      `${packet.priority}. ${packet.routeLabel} · SLA ${formatNumber(packet.operatorSlaMinutes)}m · target ${formatNumber(packet.targetReplies)} · ${packet.ready ? "READY" : "MISSING_ROUTE_OR_DRAFT"}`,
      packet.reason ? `Why: ${packet.reason}` : null,
      packet.routeUrl ? `Route: ${packet.routeUrl}` : null,
      packet.draftText ? `Reply: ${packet.draftText}` : null,
      "",
    ].filter(Boolean)),
    "Stop conditions: skip politics, giveaways, ragebait, unsupported claims, and weak tech fit.",
  ].join("\n");

  return {
    generatedAt: now,
    mode,
    severity,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    safeRemainingUsd: Number.isFinite(apiRemaining) ? roundUsd(apiRemaining) : null,
    targetReplies,
    readyPackets: readyPackets.length,
    totalPackets: packets.length,
    expectedLiftPct: Number(expectedLiftPct.toFixed(1)),
    bestRouteLabel: bestRoute?.routeLabel || bestRoute?.label || null,
    nextAction,
    copyBlock,
    checks: [
      { id: "x_reads", label: "X read partition", value: "0 ops", status: "ok", detail: "Manual web routes do not call recent_search." },
      { id: "budget", label: "cost boundary", value: safeRemainingLabel, status: Number.isFinite(apiRemaining) && apiRemaining <= 0 ? "danger" : "ok", detail: "No incremental X API cost for the dispatch packet." },
      { id: "queue", label: "route queue", value: `${readyPackets.length}/${packets.length}`, status: severity, detail: "Ready means route URL and reply text are both present." },
      { id: "writeback", label: "learning writeback", value: "next maintenance", status: "ok", detail: "Engagement metrics rebalance formats, sources, and topics." },
    ],
    packets,
    steps: [
      { id: "open", label: "open.live.route", detail: "Open X in the browser from the dashboard link; no X API search/read call." },
      { id: "select", label: "select.thread", detail: "Choose a fresh technical thread with visible discussion and avoid low-signal bait." },
      { id: "paste", label: "paste.output", detail: "Paste the paired reply and edit only nouns/context that must fit the thread." },
      { id: "stop", label: "stop.at.target", detail: "Stop after the target replies so budget and account behavior stay controlled." },
      { id: "learn", label: "learn.writeback", detail: "Next maintenance refresh writes results into scoring without extra manual work." },
    ],
    opportunities: Array.isArray(opportunities)
      ? opportunities.slice(0, 3).map((item) => ({
          id: item.id || item.label,
          label: item.label,
          score: item.score,
          evidence: item.evidence || item.reason || "",
          routeLabel: item.routeLabel || item.label,
        }))
      : [],
  };
}

function buildDailyExecutionConsole({
  operatorDispatchPacket = null,
  routeAmplifier = null,
  manualReplyTargetAtlas = null,
  distributionOps = null,
  cadence = null,
  growthOpportunityScorer = null,
  now = new Date().toISOString(),
} = {}) {
  const packets = Array.isArray(operatorDispatchPacket?.packets) ? operatorDispatchPacket.packets : [];
  const atlasTargets = Array.isArray(manualReplyTargetAtlas?.targets) ? manualReplyTargetAtlas.targets : [];
  const missions = Array.isArray(distributionOps?.missions) ? distributionOps.missions : [];
  const lanes = Array.isArray(routeAmplifier?.lanes) ? routeAmplifier.lanes : [];
  const source = packets.length ? packets : atlasTargets.length ? atlasTargets : missions;
  const targetReplies =
    Number(operatorDispatchPacket?.targetReplies) ||
    Number(manualReplyTargetAtlas?.totalTargetReplies) ||
    Number(distributionOps?.manualReplyTarget) ||
    integerEnv("DASHBOARD_DAILY_REPLY_TARGET", 3, 1, 20);
  const rows = source.slice(0, 5).map((item, index) => {
    const matchingLane =
      lanes.find((lane) => lane.id === item.id || lane.routeUrl === item.routeUrl || lane.label === item.routeLabel) ||
      lanes[index] ||
      null;
    const routeLabel = item.routeLabel || item.label || matchingLane?.label || `Route ${index + 1}`;
    const routeUrl = item.routeUrl || matchingLane?.routeUrl || null;
    const replyText = item.draftText || item.replyText || "";
    const ready = Boolean(routeUrl && replyText);
    const status = ready ? (matchingLane?.status || item.status || "ok") : "warn";
    return {
      id: item.id || `execution:${index + 1}`,
      priority: Number(item.priority || item.rank || index + 1),
      status,
      ready,
      routeLabel,
      routeUrl,
      replyText,
      replyAngle: item.draftAngle || item.replyAngle || item.angle || "",
      reason: item.reason || item.evidence || matchingLane?.reason || "",
      targetReplies: Math.max(1, Number(item.targetReplies) || Number(matchingLane?.targetReplies) || 1),
      operatorSlaMinutes: Math.max(5, Number(item.operatorSlaMinutes) || Number(matchingLane?.operatorSlaMinutes) || 10 + index * 10),
      expectedLiftPct: Number((Number(item.expectedLiftPct ?? matchingLane?.expectedLiftPct) || 0).toFixed(1)),
      score: Number((Number(item.score ?? matchingLane?.score) || 0).toFixed(1)),
      stopCondition: "Stop after one useful reply unless the thread is already giving signal.",
    };
  });
  const readyRows = rows.filter((row) => row.ready);
  const severity = readyRows.length >= Math.min(3, rows.length || 1) ? "ok" : readyRows.length ? "warn" : "danger";
  const primary = readyRows[0] || rows[0] || null;
  const topOpportunity = growthOpportunityScorer?.activeOpportunity || null;
  const nextAction =
    operatorDispatchPacket?.nextAction ||
    routeAmplifier?.nextAction ||
    manualReplyTargetAtlas?.nextAction ||
    cadence?.nextAction ||
    "Open the top route, paste one useful reply, then stop at the target count.";
  const copyBlock = [
    "CODEX DAILY EXECUTION CONSOLE",
    `Generated: ${now}`,
    `Mode: ${cadence?.mode || operatorDispatchPacket?.mode || distributionOps?.mode || "manual_zero_read_dispatch"}`,
    `Target: ${formatNumber(targetReplies)} manual route ops`,
    "X API: 0 live search/read ops; browser-only execution",
    "",
    "Do this now:",
    ...rows.slice(0, 3).flatMap((row) => [
      `${row.priority}. OPEN: ${row.routeLabel}${row.routeUrl ? ` - ${row.routeUrl}` : ""}`,
      `   PASTE: ${row.replyText || "missing output; use the next ready draft"}`,
      `   SLA: ${formatNumber(row.operatorSlaMinutes)}m · target ${formatNumber(row.targetReplies)} · lift +${formatNumber(row.expectedLiftPct, 1)}%`,
    ]),
    "",
    `Primary command: ${nextAction}`,
    "Stop: skip politics, giveaways, ragebait, weak tech fit, and any thread older than the useful window.",
  ].join("\n");

  return {
    generatedAt: now,
    mode: "zero_read_daily_execution_console",
    severity,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    targetReplies,
    readyRows: readyRows.length,
    totalRows: rows.length,
    primaryRouteLabel: primary?.routeLabel || null,
    primaryRouteUrl: primary?.routeUrl || null,
    primaryReplyText: primary?.replyText || null,
    nextAction,
    activeOpportunity: topOpportunity
      ? {
          label: topOpportunity.label || topOpportunity.id || null,
          formatId: topOpportunity.formatId || null,
          pillarId: topOpportunity.pillarId || null,
          score: topOpportunity.score ?? null,
        }
      : null,
    guardrails: [
      "Manual browser execution only; no auto-search, auto-like, auto-follow, or auto-reply.",
      "No X search/read API calls for route selection.",
      "Stop at target count and let maintenance write results back.",
    ],
    rows,
    copyBlock,
  };
}

function buildOperatorPasteQueue({
  dailyExecutionConsole = null,
  operatorDispatchPacket = null,
  manualReplyTargetAtlas = null,
  routeAmplifier = null,
  distributionOps = null,
  now = new Date().toISOString(),
} = {}) {
  const rows = Array.isArray(dailyExecutionConsole?.rows) ? dailyExecutionConsole.rows : [];
  const packets = Array.isArray(operatorDispatchPacket?.packets) ? operatorDispatchPacket.packets : [];
  const targets = Array.isArray(manualReplyTargetAtlas?.targets) ? manualReplyTargetAtlas.targets : [];
  const lanes = Array.isArray(routeAmplifier?.lanes) ? routeAmplifier.lanes : [];
  const missions = Array.isArray(distributionOps?.missions) ? distributionOps.missions : [];
  const source = rows.length ? rows : packets.length ? packets : targets.length ? targets : lanes.length ? lanes : missions;
  const targetReplies =
    Number(dailyExecutionConsole?.targetReplies) ||
    Number(operatorDispatchPacket?.targetReplies) ||
    Number(manualReplyTargetAtlas?.totalTargetReplies) ||
    Number(distributionOps?.manualReplyTarget) ||
    integerEnv("DASHBOARD_DAILY_REPLY_TARGET", 3, 1, 20);
  const tasks = source.slice(0, 5).map((item, index) => {
    const lane =
      lanes.find((entry) => entry.id === item.id || entry.routeUrl === item.routeUrl || entry.label === item.routeLabel) ||
      lanes[index] ||
      null;
    const routeLabel = item.routeLabel || item.label || lane?.label || `Route ${index + 1}`;
    const pastePayload = item.pastePayload || item.replyText || item.draftText || item.copyBlock || "";
    const openUrl = item.openUrl || item.routeUrl || lane?.routeUrl || null;
    const targetCount = Math.max(1, Number(item.targetReplies) || Number(lane?.targetReplies) || 1);
    const slaMinutes = Math.max(5, Number(item.operatorSlaMinutes) || Number(lane?.operatorSlaMinutes) || 10 + index * 10);
    const ready = Boolean(openUrl && pastePayload);
    return {
      id: item.id || `paste:${index + 1}`,
      priority: Number(item.priority || item.rank || index + 1),
      routeLabel,
      openUrl,
      pastePayload,
      status: ready ? (item.status || lane?.status || "ok") : "warn",
      ready,
      targetReplies: targetCount,
      operatorSlaMinutes: slaMinutes,
      expectedLiftPct: Number((Number(item.expectedLiftPct ?? lane?.expectedLiftPct) || 0).toFixed(1)),
      reason: item.reason || item.evidence || lane?.reason || "Use the highest-signal fresh technical exchange in this route.",
      editRule: "Only edit nouns, timing, and one concrete reference needed by the target exchange.",
      skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
      doneSignal: "One useful manual response pasted, or this route skipped for quality.",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
    };
  });
  const readyTasks = tasks.filter((task) => task.ready);
  const severity = readyTasks.length >= Math.min(3, tasks.length || 1) ? "ok" : readyTasks.length ? "warn" : "danger";
  const primary = readyTasks[0] || tasks[0] || null;
  const copyBlock = [
    "CODEX OPERATOR PASTE QUEUE",
    `Generated: ${now}`,
    "Mode: manual_paste_queue",
    "Cost guard: 0 live X search/read ops",
    `Target: ${formatNumber(targetReplies)} manual route ops`,
    "",
    "Steps:",
    "1. Open the route link in X web.",
    "2. Choose one fresh technical exchange with visible discussion.",
    "3. Paste the paired payload, edit only for context, then move on.",
    "4. Stop at the target count; maintenance writes learning back later.",
    "",
    "Queue:",
    ...tasks.slice(0, 5).flatMap((task) => [
      `${formatNumber(task.priority)}. ${task.routeLabel} · ${task.ready ? "READY" : "MISSING_ROUTE_OR_PAYLOAD"} · SLA ${formatNumber(task.operatorSlaMinutes)}m · target ${formatNumber(task.targetReplies)}`,
      task.openUrl ? `OPEN: ${task.openUrl}` : null,
      task.pastePayload ? `PASTE: ${task.pastePayload}` : null,
      `EDIT: ${task.editRule}`,
      `SKIP: ${task.skipRule}`,
      "",
    ].filter(Boolean)),
    "Done signal: stop after the target count or when route quality drops.",
  ].join("\n");

  return {
    generatedAt: now,
    mode: "manual_paste_queue",
    severity,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    targetReplies,
    readyTasks: readyTasks.length,
    totalTasks: tasks.length,
    primaryRouteLabel: primary?.routeLabel || null,
    primaryOpenUrl: primary?.openUrl || null,
    primaryPastePayload: primary?.pastePayload || null,
    nextAction: primary?.ready
      ? `Open ${primary.routeLabel}, paste one useful payload, then continue down the queue.`
      : "Refresh manual route payloads before running the paste queue.",
    operatorMode: "human_in_loop",
    readGate: "browser_only",
    guardrails: [
      "Manual browser execution only; no automated outbound actions.",
      "Use route links; X search/read API stays at 0.",
      "Stop at target count and let maintenance write learning back.",
    ],
    tasks,
    steps: [
      { id: "open_route", label: "open.route", detail: "Open the queued route link in X web." },
      { id: "select_exchange", label: "select.exchange", detail: "Pick a fresh technical exchange with visible discussion." },
      { id: "paste_payload", label: "paste.payload", detail: "Paste once, edit only context, then move to the next route." },
      { id: "stop_gate", label: "stop.gate", detail: "Stop at the target count or when quality drops." },
    ],
    copyBlock,
  };
}

function buildRouteOpportunityMatrix({
  operatorPasteQueue = null,
  dailyExecutionConsole = null,
  operatorDispatchPacket = null,
  routeAmplifier = null,
  manualReplyTargetAtlas = null,
  growthOpportunityScorer = null,
  nextWindowAngleCommander = null,
  budgetAllocationOptimizer = null,
  rssSourceMesh = null,
  now = new Date().toISOString(),
} = {}) {
  const routeLanes = Array.isArray(routeAmplifier?.lanes) ? routeAmplifier.lanes : [];
  const tasks = Array.isArray(operatorPasteQueue?.tasks) ? operatorPasteQueue.tasks : [];
  const rows = Array.isArray(dailyExecutionConsole?.rows) ? dailyExecutionConsole.rows : [];
  const packets = Array.isArray(operatorDispatchPacket?.packets) ? operatorDispatchPacket.packets : [];
  const targets = Array.isArray(manualReplyTargetAtlas?.targets) ? manualReplyTargetAtlas.targets : [];
  const opportunities = Array.isArray(growthOpportunityScorer?.lanes) ? growthOpportunityScorer.lanes : [];
  const rssLanes = Array.isArray(rssSourceMesh?.lanes) ? rssSourceMesh.lanes : [];
  const budgetLane = (budgetAllocationOptimizer?.lanes || []).find((lane) => lane.id === "manual_route_burst") || null;
  const activeOpportunity = growthOpportunityScorer?.activeOpportunity || opportunities[0] || null;
  const activeWindow = nextWindowAngleCommander?.activeWindow || nextWindowAngleCommander?.window || null;
  const seen = new Set();
  const candidates = [];

  const matchRouteLane = (item, index) =>
    routeLanes.find((lane) =>
      lane.id === item?.id ||
      (lane.routeUrl && lane.routeUrl === (item?.openUrl || item?.routeUrl)) ||
      (lane.label && lane.label === (item?.routeLabel || item?.label)),
    ) ||
    routeLanes[index] ||
    null;

  const addCandidate = (source, item, index) => {
    if (!item || typeof item !== "object") return;
    const lane = matchRouteLane(item, index);
    const routeLabel = item.routeLabel || item.label || lane?.label || `Route ${index + 1}`;
    const openUrl = item.openUrl || item.routeUrl || lane?.routeUrl || nextWindowAngleCommander?.routeUrl || null;
    const pastePayload = item.pastePayload || item.replyText || item.draftText || item.copyBlock || "";
    const dedupeKey = `${routeLabel}::${openUrl || item.id || index}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const ready = Boolean(openUrl && pastePayload);
    const targetReplies = Math.max(
      1,
      Number(item.targetReplies) ||
        Number(lane?.targetReplies) ||
        Number(operatorPasteQueue?.targetReplies) ||
        Number(dailyExecutionConsole?.targetReplies) ||
        1,
    );
    const slaMinutes = Math.max(
      5,
      Number(item.operatorSlaMinutes) ||
        Number(lane?.operatorSlaMinutes) ||
        Number(nextWindowAngleCommander?.operatorSlaMinutes) ||
        10 + index * 10,
    );
    const routeScore = Number(item.score ?? lane?.score ?? routeAmplifier?.topRouteScore ?? routeAmplifier?.avgScore ?? 0) || 0;
    const opportunityScore = Number(activeOpportunity?.score ?? growthOpportunityScorer?.opportunityScore ?? 0) || 0;
    const commanderScore = Number(nextWindowAngleCommander?.commanderScore ?? 0) || 0;
    const expectedLift = Number(item.expectedLiftPct ?? lane?.expectedLiftPct ?? budgetLane?.expectedLiftPct ?? 0) || 0;
    const budgetOpen = Number(budgetAllocationOptimizer?.safeRemainingUsd ?? operatorDispatchPacket?.safeRemainingUsd ?? 0) > 0;
    const sourceWeight =
      source === "paste_queue" ? 16 :
        source === "daily_console" ? 14 :
          source === "dispatch_packet" ? 12 :
            source === "route_amplifier" ? 10 :
              source === "target_atlas" ? 8 :
                5;
    const score = boundedPercent(
      18 +
        sourceWeight +
        (ready ? 20 : -18) +
        Math.min(24, routeScore * 0.24) +
        Math.min(18, opportunityScore * 0.18) +
        Math.min(10, commanderScore * 0.1) +
        Math.min(14, expectedLift * 0.65) +
        Math.min(10, targetReplies * 2.8) +
        Math.max(0, 12 - slaMinutes / 5) +
        (budgetOpen ? 6 : -16),
    );
    const status = !ready ? "danger" : score >= 76 ? "hot" : score >= 58 ? "ok" : score >= 40 ? "watch" : "hold";
    const relatedRss = rssLanes.find((rssLane) =>
      String(routeLabel).toLowerCase().includes(String(rssLane.source || rssLane.host || "").toLowerCase()) ||
      String(pastePayload).toLowerCase().includes(String(rssLane.source || rssLane.host || "").toLowerCase()),
    ) || rssLanes[0] || null;
    candidates.push({
      id: item.id || `${source}:${index + 1}`,
      source,
      rank: candidates.length + 1,
      label: routeLabel,
      routeLabel,
      openUrl,
      pastePayload,
      status,
      ready,
      score: Number(score.toFixed(1)),
      routeScore: Number(routeScore.toFixed(1)),
      opportunityScore: Number(opportunityScore.toFixed(1)),
      expectedLiftPct: Number(expectedLift.toFixed(1)),
      targetReplies,
      operatorSlaMinutes: slaMinutes,
      confidence: item.confidence || lane?.confidence || growthOpportunityScorer?.confidence || "low",
      windowLabel: activeWindow?.windowLabel || activeWindow?.label || activeOpportunity?.windowLabel || null,
      formatId: activeOpportunity?.formatId || null,
      formatLabel: activeOpportunity?.formatLabel || null,
      pillarId: activeOpportunity?.pillarId || null,
      pillarLabel: activeOpportunity?.pillarLabel || null,
      relatedSource: relatedRss?.source || relatedRss?.host || null,
      routeReason:
        item.reason ||
        item.evidence ||
        lane?.reason ||
        activeOpportunity?.evidence?.[0] ||
        "Use the strongest cached route; choose only a live technical exchange in the browser.",
      editRule: item.editRule || "Edit nouns, timing, and one concrete reference only.",
      skipRule: item.skipRule || "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
      doneSignal: item.doneSignal || "One useful route op completed or the lane skipped for quality.",
      readGate: "browser_only",
      operatorMode: "human_in_loop",
      manualOnly: true,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
    });
  };

  tasks.forEach((item, index) => addCandidate("paste_queue", item, index));
  rows.forEach((item, index) => addCandidate("daily_console", item, index));
  packets.forEach((item, index) => addCandidate("dispatch_packet", item, index));
  routeLanes.forEach((item, index) => addCandidate("route_amplifier", item, index));
  targets.forEach((item, index) => addCandidate("target_atlas", item, index));

  const lanes = candidates
    .sort((left, right) => Number(right.ready) - Number(left.ready) || right.score - left.score || left.operatorSlaMinutes - right.operatorSlaMinutes)
    .slice(0, 6)
    .map((lane, index) => ({ ...lane, rank: index + 1 }));
  const readyLanes = lanes.filter((lane) => lane.ready);
  const topLane = readyLanes[0] || lanes[0] || null;
  const avgScore = lanes.length ? lanes.reduce((sum, lane) => sum + lane.score, 0) / lanes.length : 0;
  const expectedLiftPct = lanes.length ? lanes.reduce((sum, lane) => sum + Number(lane.expectedLiftPct || 0), 0) / lanes.length : 0;
  const severity = readyLanes.length >= Math.min(2, lanes.length || 1) && avgScore >= 58
    ? "ok"
    : readyLanes.length
      ? "warn"
      : "danger";
  const copyBlock = [
    "CODEX ROUTE OPPORTUNITY MATRIX",
    `Generated: ${now}`,
    "Mode: zero_read_route_opportunity_matrix",
    "Cost guard: 0 extra X search/read ops · $0 incremental X API",
    `Ready lanes: ${formatNumber(readyLanes.length)}/${formatNumber(lanes.length)} · avg score ${formatNumber(avgScore, 1)}`,
    "",
    "Protocol:",
    "1. Open the top browser route.",
    "2. Pick one fresh technical exchange with real discussion.",
    "3. Paste the paired payload and edit only context.",
    "4. Stop at the target count or when route quality drops.",
    "",
    ...lanes.slice(0, 5).flatMap((lane) => [
      `${lane.rank}. ${lane.routeLabel} · ${lane.status.toUpperCase()} · score ${formatNumber(lane.score, 1)} · SLA ${formatNumber(lane.operatorSlaMinutes)}m`,
      lane.openUrl ? `OPEN: ${lane.openUrl}` : "OPEN: missing browser route",
      lane.pastePayload ? `PASTE: ${lane.pastePayload}` : "PASTE: missing payload",
      `SKIP: ${lane.skipRule}`,
      "",
    ]),
  ].join("\n");

  return {
    generatedAt: now,
    mode: "zero_read_route_opportunity_matrix",
    severity,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    operatorMode: "human_in_loop",
    readGate: "browser_only",
    manualOnly: true,
    readyLanes: readyLanes.length,
    totalLanes: lanes.length,
    avgScore: Number(avgScore.toFixed(1)),
    expectedLiftPct: Number(expectedLiftPct.toFixed(1)),
    topRouteLabel: topLane?.routeLabel || null,
    primaryOpenUrl: topLane?.openUrl || null,
    primaryPastePayload: topLane?.pastePayload || null,
    nextAction: topLane?.ready
      ? `Open ${topLane.routeLabel}, paste one useful payload, then mark the lane done or skipped.`
      : "Repair the top route payload before opening X web.",
    summary: {
      topRouteLabel: topLane?.routeLabel || null,
      topScore: topLane?.score || 0,
      topStatus: topLane?.status || "hold",
      routeBudget: "$0 incremental X API",
      readOps: 0,
      manualTarget: Number(operatorPasteQueue?.targetReplies || dailyExecutionConsole?.targetReplies || 0) || readyLanes.length,
      activeWindow: activeWindow?.windowLabel || activeOpportunity?.windowLabel || null,
      activeAngle: activeOpportunity?.formatLabel || activeOpportunity?.label || null,
    },
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "ready", label: "READY_LANES", value: `${formatNumber(readyLanes.length)}/${formatNumber(lanes.length)}`, status: severity },
      { id: "score", label: "ROUTE_SCORE", value: formatNumber(avgScore, 1), status: avgScore >= 76 ? "ok" : avgScore >= 58 ? "warn" : "danger" },
      { id: "lift", label: "LIFT_MODEL", value: `+${formatNumber(expectedLiftPct, 1)}%`, status: expectedLiftPct > 0 ? "ok" : "warn" },
    ],
    lanes,
    guardrails: [
      "Manual browser execution only; no automated outbound actions.",
      "No X search/read API calls for route selection.",
      "No rate-limit circumvention; use normal backoff and cached telemetry.",
      "Stop at target count and let maintenance write learning back.",
    ],
    copyBlock,
  };
}

function routeConfidenceWeight(confidence) {
  const text = String(confidence || "").toLowerCase();
  if (text === "high") return 16;
  if (text === "medium") return 10;
  if (text === "low") return 5;
  return 7;
}

function buildRouteAmplifier({
  operatorDispatchPacket = null,
  distributionOps = null,
  insights = null,
  cadence = null,
  viralFlywheel = null,
  growthKinetics = null,
  budgetBurnReactor = null,
  now = new Date().toISOString(),
} = {}) {
  const packets = Array.isArray(operatorDispatchPacket?.packets)
    ? operatorDispatchPacket.packets
    : Array.isArray(distributionOps?.missions)
      ? distributionOps.missions
      : [];
  const baseline = Math.max(1, Number(insights?.baselineScore || operatorDispatchPacket?.baselineScore) || 1);
  const flywheelVelocity = Number(viralFlywheel?.velocityScore) || 0;
  const routeCoverage = Number(growthKinetics?.routeReadinessPct) || 0;
  const safeBudget = Number(operatorDispatchPacket?.safeRemainingUsd ?? budgetBurnReactor?.safeRemainingUsd);
  const budgetComponent = Number.isFinite(safeBudget)
    ? safeBudget > 1
      ? 14
      : safeBudget > 0
        ? 8
        : -18
    : 10;
  const cadencePenalty = cadence?.publishAllowed === false && cadence?.enforcement === "strict" ? -5 : 0;

  const lanes = packets.slice(0, 5).map((packet, index) => {
    const routeLabel = packet.routeLabel || packet.label || `Route ${index + 1}`;
    const routeScore = Number(packet.score) || baseline;
    const expectedLift = Number(packet.expectedLiftPct) || Math.max(0, ((routeScore - baseline) / baseline) * 100);
    const targetReplies = Math.max(1, Number(packet.targetReplies) || 1);
    const slaMinutes = Math.max(5, Number(packet.operatorSlaMinutes) || 10 + index * 10);
    const ready = packet.ready !== false && Boolean(packet.routeUrl && packet.draftText);
    const score = boundedPercent(
      16 +
        Math.min(24, (routeScore / baseline) * 10) +
        Math.min(18, expectedLift / 3) +
        Math.min(14, targetReplies * 4) +
        Math.max(0, 14 - slaMinutes / 4) +
        routeConfidenceWeight(packet.confidence) +
        Math.min(12, flywheelVelocity * 0.12) +
        Math.min(8, routeCoverage * 0.08) +
        budgetComponent +
        cadencePenalty -
        (ready ? 0 : 22),
    );
    const status = !ready ? "danger" : score >= 72 ? "ok" : score >= 48 ? "warn" : "danger";
    const action = !ready
      ? "Repair missing route URL or reply output before opening X."
      : score >= 72
        ? "Execute first; this route has the strongest distribution leverage."
        : score >= 48
          ? "Use after the top route or when the live thread quality is better."
          : "Hold unless the top routes are stale.";
    return {
      id: packet.id || `route_amp:${index + 1}`,
      rank: index + 1,
      label: routeLabel,
      routeUrl: packet.routeUrl || null,
      status,
      ready,
      score: Number(score.toFixed(1)),
      expectedLiftPct: Number(expectedLift.toFixed(1)),
      targetReplies,
      operatorSlaMinutes: slaMinutes,
      confidence: packet.confidence || "low",
      xReadOps: 0,
      incrementalXApiUsd: 0,
      action,
      reason: packet.evidence || packet.reason || "manual route packet scored from cached reply readiness, expected lift, SLA, and budget guard",
    };
  });
  const topLane = lanes[0] || null;
  const avgScore = lanes.length ? lanes.reduce((sum, lane) => sum + lane.score, 0) / lanes.length : 0;
  const readyLanes = lanes.filter((lane) => lane.ready).length;
  const severity = readyLanes >= Math.min(2, lanes.length || 1) && avgScore >= 48
    ? "ok"
    : readyLanes
      ? "warn"
      : "danger";

  return {
    generatedAt: now,
    mode: "cached_route_amplifier",
    zeroExtraXReads: true,
    severity,
    avgScore: Number(avgScore.toFixed(1)),
    readyLanes,
    totalLanes: lanes.length,
    topRouteLabel: topLane?.label || null,
    topRouteScore: topLane?.score || 0,
    nextAction: topLane?.action || "Build at least one ready route packet before dispatch.",
    formula: "readiness + historical score + expected lift + SLA pressure + flywheel velocity + cost guard",
    cells: [
      { id: "ready", label: "route readiness", value: `${formatNumber(readyLanes)}/${formatNumber(lanes.length)}`, status: severity },
      { id: "score", label: "amplifier score", value: formatNumber(avgScore, 1), status: avgScore >= 72 ? "ok" : avgScore >= 48 ? "warn" : "danger" },
      { id: "x_reads", label: "X read ops", value: "0", status: "ok" },
      { id: "budget", label: "safe cost partition", value: Number.isFinite(safeBudget) ? `$${formatNumber(safeBudget, 2)}` : "cache-only", status: Number.isFinite(safeBudget) && safeBudget <= 0 ? "danger" : "ok" },
    ],
    lanes,
  };
}

function routeAtlasQueryClass(routeUrl = "") {
  let decoded = String(routeUrl || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw route when X or copied URLs contain malformed percent escapes.
  }
  if (/from:/i.test(decoded)) return "target_account_mesh";
  if (/OpenAI|Anthropic|Cursor|Gemini|Nvidia|AI coding|agents/i.test(decoded)) return "ai_platform_load";
  if (/Apple|Google|Microsoft|Meta|Amazon|Tesla/i.test(decoded)) return "big_tech_load";
  if (/startup|founder|SaaS|developer tools|cloud|GitHub|Vercel|Cloudflare/i.test(decoded)) return "operator_builder_load";
  return "broad_tech_load";
}

function buildManualReplyTargetAtlas({
  operatorDispatchPacket = null,
  routeAmplifier = null,
  distributionOps = null,
  now = new Date().toISOString(),
} = {}) {
  const packets = Array.isArray(operatorDispatchPacket?.packets) ? operatorDispatchPacket.packets : [];
  const lanes = Array.isArray(routeAmplifier?.lanes) ? routeAmplifier.lanes : [];
  const missions = Array.isArray(distributionOps?.missions) ? distributionOps.missions : [];
  const source = packets.length ? packets : missions;
  const laneByRoute = new Map();
  for (const lane of lanes) {
    if (lane.routeUrl) laneByRoute.set(lane.routeUrl, lane);
    if (lane.label) laneByRoute.set(lane.label, lane);
  }
  const targets = source.slice(0, 6).map((packet, index) => {
    const routeLabel = packet.routeLabel || packet.label || `Route ${index + 1}`;
    const lane = laneByRoute.get(packet.routeUrl) || laneByRoute.get(routeLabel) || lanes[index] || null;
    const draftText = packet.draftText || "";
    const targetReplies = Math.max(1, Number(packet.targetReplies) || 1);
    const slaMinutes = Math.max(5, Number(packet.operatorSlaMinutes) || 10 + index * 10);
    const ready = Boolean(packet.routeUrl && draftText);
    const score = Number(lane?.score ?? packet.score ?? 0) || 0;
    const queryClass = routeAtlasQueryClass(packet.routeUrl);
    const status = !ready ? "danger" : score >= 72 ? "ok" : score >= 48 ? "warn" : "probe";
    const freshnessWindowMinutes = Math.max(15, Math.min(120, slaMinutes * 3));
    return {
      id: packet.id || `target:${index + 1}`,
      rank: Number(packet.priority) || index + 1,
      label: routeLabel,
      queryClass,
      routeUrl: packet.routeUrl || null,
      status,
      ready,
      score: Number(score.toFixed(1)),
      confidence: packet.confidence || lane?.confidence || "low",
      targetReplies,
      operatorSlaMinutes: slaMinutes,
      freshnessWindowMinutes,
      expectedLiftPct: Number((Number(packet.expectedLiftPct ?? lane?.expectedLiftPct) || 0).toFixed(1)),
      xReadOps: 0,
      incrementalXApiUsd: 0,
      draftText,
      draftAngle: packet.draftAngle || "",
      evidence: packet.evidence || packet.reason || lane?.reason || "",
      useWhen: [
        "post is fresh",
        "thread has real technical exchange",
        "reply can add a decision rule or cost angle",
      ],
      skipWhen: [
        "giveaway, politics, or ragebait",
        "no visible technical argument",
        "draft would require unsupported claims",
      ],
      copyBlock: [
        `ROUTE ${index + 1}: ${routeLabel}`,
        `Class: ${queryClass} · target ${formatNumber(targetReplies)} · SLA ${formatNumber(slaMinutes)}m · X reads 0`,
        packet.routeUrl ? `Open: ${packet.routeUrl}` : "Open: missing route URL",
        packet.evidence || packet.reason ? `Why: ${packet.evidence || packet.reason}` : null,
        "",
        draftText,
      ].filter((line) => line != null).join("\n"),
    };
  });
  const readyTargets = targets.filter((target) => target.ready).length;
  const totalTargetReplies = targets.reduce((sum, target) => sum + target.targetReplies, 0) ||
    Number(operatorDispatchPacket?.targetReplies) ||
    Number(distributionOps?.manualReplyTarget) ||
    0;
  const topTarget = targets.find((target) => target.ready) || targets[0] || null;
  const severity = readyTargets >= Math.min(2, targets.length || 1)
    ? "ok"
    : readyTargets
      ? "warn"
      : "danger";
  const copyBlock = [
    "CODEX MANUAL REPLY TARGET ATLAS",
    `Generated: ${now}`,
    "Mode: zero_read_web_targeting · X search/read API: 0",
    `Ready targets: ${formatNumber(readyTargets)}/${formatNumber(targets.length)} · reply target ${formatNumber(totalTargetReplies)}`,
    "",
    "Protocol:",
    "1. Open the top route in X web.",
    "2. Choose a fresh technical thread with real replies.",
    "3. Paste the paired output, edit nouns/context only, then move on.",
    "4. Stop at the target count and let metrics write back later.",
    "",
    ...targets.slice(0, 5).flatMap((target) => [
      `${target.rank}. ${target.label} · ${target.queryClass} · score ${formatNumber(target.score, 1)} · target ${formatNumber(target.targetReplies)}`,
      target.routeUrl ? `Open: ${target.routeUrl}` : "Open: missing route URL",
      `Reply: ${target.draftText || "-"}`,
      "",
    ]),
  ].join("\n");
  return {
    generatedAt: now,
    mode: "zero_read_web_target_atlas",
    severity,
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    readyTargets,
    totalTargets: targets.length,
    totalTargetReplies,
    topRouteLabel: topTarget?.label || null,
    topQueryClass: topTarget?.queryClass || null,
    nextAction: topTarget
      ? `Open ${topTarget.label}, paste the paired output under ${formatNumber(topTarget.targetReplies)} fresh high-signal thread(s), then stop.`
      : "Refresh daily route outputs before manual distribution.",
    queryPolicy: "Use X web links manually; no recent_search/read API calls for this atlas.",
    guardrails: [
      "No auto-replies, auto-likes, or auto-follows.",
      "Skip politics, giveaways, ragebait, and unsupported claims.",
      "Prefer fresh technical threads with visible exchange.",
      "Stop at the target count; learning writes back on maintenance.",
    ],
    copyBlock,
    targets,
  };
}

function buildAngleMutationReactor({
  insights = null,
  learningAutopilot = null,
  adaptiveAngleScheduler = null,
  temporalAngleMatrix = null,
  learningWriteback = null,
  routeAmplifier = null,
  operatorDispatchPacket = null,
  now = new Date().toISOString(),
} = {}) {
  const baseline = Math.max(
    1,
    Number(insights?.baselineScore) ||
      Number(learningWriteback?.baselineScore) ||
      Number(learningAutopilot?.baselineScore) ||
      1,
  );
  const sampleCount = Number(
    learningWriteback?.sampleCount ??
      learningAutopilot?.sampleCount ??
      adaptiveAngleScheduler?.sampleCount ??
      insights?.records?.length ??
      0,
  ) || 0;
  const activeRule =
    learningWriteback?.activeRule ||
    (adaptiveAngleScheduler?.nextAngles || [])[0] ||
    learningAutopilot?.primaryFormat ||
    null;
  const bestFormat = rankedBucketEntries(insights?.templates, { minSamples: 1, excludeUnknown: true })[0] || null;
  const bestSource = rankedBucketEntries(insights?.sources, { minSamples: 1, excludeUnknown: true })[0] || null;
  const bestTag = rankedBucketEntries(insights?.tags, { minSamples: 1, excludeUnknown: true })[0] || null;
  const temporalSlot = (temporalAngleMatrix?.slots || [])[0] || null;
  const routeLane = (routeAmplifier?.lanes || [])[0] || null;
  const dispatchPacket = (operatorDispatchPacket?.packets || [])[0] || null;
  const writebackMutations = Array.isArray(learningWriteback?.mutations) ? learningWriteback.mutations : [];

  const formatId = activeRule?.formatId || activeRule?.id || bestFormat?.[0] || "decision_rule";
  const formatLabel = activeRule?.label || compactBucketName(formatId);
  const formatScore = Number(
    activeRule?.weight ??
      activeRule?.score ??
      activeRule?.avgScore ??
      bestFormat?.[1]?.avgScore ??
      baseline,
  ) || baseline;
  const sourceLabel = bestSource?.[0] || learningAutopilot?.sourceBias?.[0]?.name || "high-signal tech sources";
  const sourceScore = Number(bestSource?.[1]?.avgScore ?? learningAutopilot?.sourceBias?.[0]?.avgScore ?? baseline) || baseline;
  const tagLabel = bestTag?.[0] || learningAutopilot?.tagBias?.[0]?.name || "AI / platforms / developer tools";
  const tagScore = Number(bestTag?.[1]?.avgScore ?? learningAutopilot?.tagBias?.[0]?.avgScore ?? baseline) || baseline;
  const hasRouteSignal = Boolean(routeLane || dispatchPacket);
  const routeLabel = routeLane?.label || dispatchPacket?.routeLabel || "standalone post generation lane";
  const routeScore = Number(routeLane?.score ?? dispatchPacket?.score ?? baseline) || baseline;
  const temporalScore = Number(temporalSlot?.score ?? adaptiveAngleScheduler?.nextAngles?.[0]?.weight ?? baseline) || baseline;
  const confidence = learningWriteback?.confidence || adaptiveAngleScheduler?.confidence || learningAutopilot?.confidence || "low";
  const score = boundedPercent(
    18 +
      Math.min(22, (formatScore / baseline) * 9) +
      Math.min(18, temporalScore * 0.18) +
      Math.min(18, routeScore * 0.18) +
      Math.min(14, sourceScore / baseline * 5) +
      Math.min(10, tagScore / baseline * 4) +
      Math.min(16, sampleCount * 0.7) +
      (confidence === "high" ? 8 : confidence === "medium" ? 4 : 0),
  );
  const severity = score >= 72 ? "ok" : score >= 48 ? "warn" : "danger";
  const temporalBias = temporalSlot
    ? `${temporalSlot.windowLabel} UTC / ${temporalSlot.label || compactBucketName(temporalSlot.formatId)}`
    : "next learned peak window";
  const nextPromptBias = `Exploit ${formatLabel}; source=${compactBucketName(sourceLabel)}; topic=${compactBucketName(tagLabel)}; window=${temporalBias}; route=${routeLabel}.`;
  const guardrails = [
    "No automatic replies, likes, follows, or unsolicited bulk actions.",
    "No X search/read API calls for manual route selection.",
    "No rate-limit circumvention; use cached telemetry and normal backoff only.",
    "No headline recap, unsupported claims, ragebait, giveaways, or politics bait.",
  ];
  const promptPatch = [
    "CODEX ANGLE MUTATION PATCH",
    `mode: cached_angle_mutation_reactor`,
    `zero_extra_x_reads: true`,
    `mutation_score: ${formatNumber(score, 1)}`,
    `primary_rule: ${formatLabel} (${activeRule?.action || "test"})`,
    `source_bias: ${compactBucketName(sourceLabel)}`,
    `topic_bias: ${compactBucketName(tagLabel)}`,
    `temporal_window: ${temporalBias}`,
    `route_bias: ${routeLabel}`,
    "",
    "DO:",
    `- Lead with a concrete ${formatLabel} operating rule.`,
    "- Name the real company/product and translate the story into cost, leverage, or workflow impact.",
    "- End with a sharp question or decision rule that invites a technical reply.",
    "",
    "AVOID:",
    "- Headline recap, generic optimism, unsupported claims, outrage bait, and extra X read/search API calls.",
  ].join("\n");
  const mutations = [
    {
      id: "prompt_rule",
      label: "prompt rule",
      before: "baseline rotation",
      after: formatId,
      status: severity,
      score: Number(score.toFixed(1)),
      reason: activeRule?.reason || "Primary rule selected from cached learning writeback and adaptive angle schedule.",
      promptBias: `Lead with ${formatLabel}.`,
    },
    {
      id: "temporal_bias",
      label: "UTC fire-control",
      before: "flat cadence",
      after: temporalBias,
      status: temporalSlot?.status === "hot" ? "ok" : temporalSlot ? "warn" : "neutral",
      score: Number(temporalScore.toFixed(1)),
      reason: temporalSlot?.reason || temporalAngleMatrix?.nextAction || "Use cached hourly throughput until more samples exist.",
      promptBias: `Prefer ${temporalBias}.`,
    },
    {
      id: "route_bias",
      label: "manual route amplifier",
      before: hasRouteSignal ? "random browsing" : "no route bias",
      after: routeLabel,
      status: routeLane?.status || (routeLane ? "warn" : "neutral"),
      score: Number(routeScore.toFixed(1)),
      reason: routeLane?.reason || routeAmplifier?.nextAction || "Generation route uses cached learning when no manual dispatch packet is present.",
      promptBias: hasRouteSignal
        ? `Open ${routeLabel}; paste only when thread fit is strong.`
        : `Use ${routeLabel}; optimize the standalone post angle.`,
    },
    {
      id: "source_topic_bias",
      label: "source/topic bias",
      before: "broad tech",
      after: `${compactBucketName(sourceLabel)} / ${compactBucketName(tagLabel)}`,
      status: sourceScore >= baseline || tagScore >= baseline ? "ok" : "warn",
      score: Number(Math.max(sourceScore, tagScore).toFixed(1)),
      reason: "Source and topic are ranked from cached tweet analytics buckets.",
      promptBias: `Prefer ${compactBucketName(sourceLabel)} stories with ${compactBucketName(tagLabel)} angle.`,
    },
    ...writebackMutations
      .filter((mutation) => mutation?.id === "hold_gate" || mutation?.id === "cost_gate")
      .slice(0, 2)
      .map((mutation) => ({
        id: mutation.id,
        label: mutation.label,
        before: mutation.before,
        after: mutation.after,
        status: mutation.status,
        score: Number(mutation.score) || 0,
        reason: mutation.reason,
        promptBias: `${mutation.label}: ${mutation.after}`,
      })),
  ];

  return {
    generatedAt: now,
    mode: "cached_angle_mutation_reactor",
    source: "cached learning writeback + route amplifier + temporal matrix",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    severity,
    confidence,
    mutationScore: Number(score.toFixed(1)),
    baselineScore: Number(baseline.toFixed(1)),
    sampleCount,
    primaryMutation: mutations[0] || null,
    nextPromptBias,
    promptPatch,
    consumers: [
      "composeTweet.performanceContext",
      "manual_reply_drafts.performanceContext",
      "growth_report",
      "dashboard",
    ],
    cells: [
      { id: "score", label: "mutation score", value: formatNumber(score, 1), status: severity },
      { id: "samples", label: "sample base", value: formatNumber(sampleCount), status: sampleCount >= 10 ? "ok" : "warn" },
      { id: "source", label: "source bias", value: compactBucketName(sourceLabel), status: sourceScore >= baseline ? "ok" : "warn" },
      { id: "route", label: "route bias", value: routeLabel, status: routeLane?.status || "warn" },
      { id: "window", label: "UTC window", value: temporalBias, status: temporalSlot?.status || "warn" },
      { id: "x_reads", label: "X read ops", value: "0", status: "ok" },
    ],
    mutations,
    guardrails,
  };
}

function buildOperatorSlo({ distributionOps, insights, usage, budgetState, cadence, now } = {}) {
  const missions = Array.isArray(distributionOps?.missions) ? distributionOps.missions : [];
  const readyMissions = Number(distributionOps?.readyMissions) || 0;
  const missionCount = Number(distributionOps?.missionCount) || missions.length;
  const manualReplyTarget = Math.max(1, Number(distributionOps?.manualReplyTarget) || integerEnv("DASHBOARD_DAILY_REPLY_TARGET", 3, 1, 20));
  const baseline = Math.max(1, Number(insights?.baselineScore) || 1);
  const totalTargetReplies = missions.reduce((sum, mission) => sum + Math.max(0, Number(mission.targetReplies) || 0), 0) || manualReplyTarget;
  const completionBudgetMinutes = missions.reduce((sum, mission) => sum + Math.max(0, Number(mission.operatorSlaMinutes) || 0), 0);
  const weightedLift = missions.reduce((sum, mission) => {
    const replies = Math.max(1, Number(mission.targetReplies) || 1);
    return sum + (Number(mission.expectedLiftPct) || 0) * replies;
  }, 0);
  const expectedLiftPct = totalTargetReplies ? weightedLift / totalTargetReplies : 0;
  const weightedScore = missions.reduce((sum, mission) => {
    const replies = Math.max(1, Number(mission.targetReplies) || 1);
    return sum + (Number(mission.score) || baseline) * replies;
  }, 0);
  const expectedScore = totalTargetReplies ? weightedScore / totalTargetReplies : baseline;
  const apiSpend = Number(usage?.totalEstimatedUsd) || 0;
  const safeCap = Number(budgetState?.safeCapUsd) || monthlyBudgetUsd() * budgetSafetyRatio();
  const safeRemainingUsd = Math.max(0, safeCap - apiSpend);
  const routeReadyPct = missionCount ? (readyMissions / missionCount) * 100 : 0;
  const latencyMinutes = completionBudgetMinutes || manualReplyTarget * 10;
  const learningSamples = Number(insights?.records?.length) || 0;
  const status = readyMissions >= Math.min(2, missionCount || 1) && safeRemainingUsd > 0
    ? "ok"
    : readyMissions > 0
      ? "warn"
      : "danger";

  const lanes = missions.slice(0, 4).map((mission, index) => {
    const targetReplies = Math.max(1, Number(mission.targetReplies) || 1);
    const routeScore = Number(mission.score) || baseline;
    const expectedLift = Number(mission.expectedLiftPct) || 0;
    const operatorSlaMinutes = Math.max(5, Number(mission.operatorSlaMinutes) || 10 + index * 10);
    return {
      id: mission.id || `slo:${index + 1}`,
      label: mission.label || mission.routeLabel || `Route ${index + 1}`,
      routeLabel: mission.routeLabel || mission.label || `Route ${index + 1}`,
      routeUrl: mission.routeUrl || null,
      priority: mission.priority || index + 1,
      status: mission.routeUrl && mission.draftText ? "ok" : mission.routeUrl || mission.draftText ? "warn" : "danger",
      targetReplies,
      operatorSlaMinutes,
      expectedLiftPct: Number(expectedLift.toFixed(1)),
      score: Number(routeScore.toFixed(1)),
      confidence: mission.confidence || "low",
      xReadOps: Number(mission.costEfficiency?.xReadOps) || 0,
      incrementalXApiUsd: Number(mission.costEfficiency?.incrementalXApiUsd) || 0,
      efficiencyLabel: mission.costEfficiency?.label || "0 incremental X API spend",
    };
  });

  return {
    generatedAt: now || new Date().toISOString(),
    mode: "manual_zero_read_slo",
    status,
    zeroExtraXReads: true,
    budgetUsdPerReply: 0,
    targetReplies: totalTargetReplies,
    readyMissions,
    missionCount,
    completionBudgetMinutes: latencyMinutes,
    expectedLiftPct: Number(expectedLiftPct.toFixed(1)),
    expectedScore: Number(expectedScore.toFixed(1)),
    baselineScore: Number(baseline.toFixed(1)),
    safeRemainingUsd: roundUsd(safeRemainingUsd),
    currentWindow: cadence?.nextWindow?.label || cadence?.currentWindow?.label || null,
    sloCards: [
      {
        id: "route_readiness",
        label: "route readiness",
        value: `${formatNumber(readyMissions)}/${formatNumber(missionCount || lanes.length)}`,
        status,
        detail: `${formatNumber(routeReadyPct, 0)}% of manual distribution lanes armed`,
      },
      {
        id: "reply_latency",
        label: "operator SLA",
        value: `${formatNumber(latencyMinutes)} min`,
        status: latencyMinutes <= 45 ? "ok" : latencyMinutes <= 75 ? "warn" : "danger",
        detail: `${formatNumber(totalTargetReplies)} route ops inside the daily traffic loop`,
      },
      {
        id: "x_read_burn",
        label: "X read burn",
        value: "0 ops",
        status: "ok",
        detail: "manual web routes do not consume X search/read budget",
      },
      {
        id: "learning_writeback",
        label: "learning writeback",
        value: `${formatNumber(learningSamples)} packets`,
        status: learningSamples >= Math.max(10, Number(insights?.minSamples) || 2) ? "ok" : "warn",
        detail: `baseline score ${formatNumber(baseline, 1)} -> expected ${formatNumber(expectedScore, 1)}`,
      },
    ],
    lanes,
    rules: [
      "Open routes in X web; do not call recent_search for manual route ops.",
      "Paste only useful route ops under active technical threads; stop at target count.",
      "Metrics write back on the next maintenance run and rebalance route weights.",
    ],
  };
}

function buildViralFlywheel({ state, insights, opportunities, drafts, actions, controlPlane, distributionOps, learningAutopilot, experimentPlan, usage, now } = {}) {
  const recent24h = recordsSince(state || emptyTweetAnalyticsState(), 24);
  const recent7d = recordsSince(state || emptyTweetAnalyticsState(), 24 * 7);
  const baseline = Math.max(1, Number(insights?.baselineScore) || 1);
  const topOpportunity = Array.isArray(opportunities) && opportunities.length ? opportunities[0] : null;
  const bestScore = Number(topOpportunity?.score) || baseline;
  const expectedLiftPct = Math.max(0, ((bestScore - baseline) / baseline) * 100);
  const draftCount = Array.isArray(drafts) ? drafts.length : 0;
  const routeCount = Array.isArray(actions) ? actions.length : 0;
  const readyMissions = Number(distributionOps?.readyMissions) || 0;
  const missionCount = Number(distributionOps?.missionCount) || 0;
  const experimentSlots = Number(experimentPlan?.budgetSafeSlots) || 0;
  const measuredPosts = Number(insights?.records?.length) || 0;
  const impressions24h = sumTweetMetric(recent24h, "impression_count");
  const impressions7d = sumTweetMetric(recent7d, "impression_count");
  const ackTotal24h = engagementTotal(recent24h);
  const ackTotal7d = engagementTotal(recent7d);
  const ackRate24h = impressions24h > 0 ? (ackTotal24h / impressions24h) * 100 : 0;
  const ackRate7d = impressions7d > 0 ? (ackTotal7d / impressions7d) * 100 : 0;
  const safeBudgetLeft = Math.max(0, monthlyBudgetUsd() * budgetSafetyRatio() - (Number(usage?.totalEstimatedUsd) || 0));
  const readGateClosed = controlPlane?.readGate === "closed";
  const publishClosed = controlPlane?.publishGate === "closed";
  const targetRouteOps = Number(distributionOps?.manualReplyTarget) || integerEnv("DASHBOARD_DAILY_REPLY_TARGET", 3, 1, 20);
  const routeCoveragePct = missionCount > 0 ? (readyMissions / missionCount) * 100 : readyMissions > 0 ? 100 : 0;
  const swarmCoveragePct = targetRouteOps > 0 ? (draftCount / targetRouteOps) * 100 : 0;
  const mode = readGateClosed
    ? "cooldown_cache_only"
    : publishClosed
      ? "manual_distribution"
      : readyMissions
        ? "reply_burst"
        : "queue_build";
  const velocityScore = boundedPercent(
    12 +
      Math.min(24, expectedLiftPct / 4) +
      Math.min(18, draftCount * 3) +
      Math.min(16, routeCount * 5) +
      Math.min(12, experimentSlots * 4) +
      Math.min(10, measuredPosts / 8) +
      Math.min(8, safeBudgetLeft * 2) -
      (readGateClosed ? 26 : 0) -
      (!readyMissions ? 12 : 0),
  );
  const loopCoefficient = Number((
    1 +
    Math.min(0.9, velocityScore / 118) +
    Math.min(0.45, expectedLiftPct / 220) +
    Math.min(0.24, ackRate7d / 24)
  ).toFixed(2));
  const bottleneck = readGateClosed
    ? { id: "read_partition", label: "X read partition sealed", severity: "danger", action: "Stay cache-only; run manual web route ops until cooldown clears." }
    : !draftCount
      ? { id: "swarm_output", label: "Swarm output empty", severity: "danger", action: "Generate manual route outputs before opening another route." }
      : !readyMissions
        ? { id: "route_queue", label: "Route queue starved", severity: "danger", action: "Arm at least one manual web route with a matching output." }
        : expectedLiftPct <= 0
          ? { id: "ranker_lift", label: "Ranker lift flat", severity: "warn", action: "Use the current learning writeback rule before spending on new discovery." }
          : measuredPosts < Math.max(10, Number(insights?.minSamples) || 2)
            ? { id: "learning_samples", label: "Learning sample ledger thin", severity: "warn", action: "Keep the route loop small and let maintenance collect outcomes." }
            : safeBudgetLeft <= 0.5
              ? { id: "cost_boundary", label: "Cost boundary tight", severity: "warn", action: "Keep text-only packets and do not run optional reads." }
              : { id: "none", label: "No hard bottleneck", severity: "ok", action: "Execute the top route burst, then let maintenance write outcomes back." };

  const stages = [
    {
      id: "ingress",
      label: "signal ingress",
      value: `${formatNumber(recent7d.length)} pkts`,
      status: recent7d.length ? "ok" : "warn",
      detail: `${formatNumber(impressions7d)} L7 events in 7d telemetry`,
    },
    {
      id: "ranker",
      label: "ranker lift",
      value: `+${formatNumber(expectedLiftPct, 1)}%`,
      status: expectedLiftPct > 25 ? "ok" : expectedLiftPct > 0 ? "warn" : "danger",
      detail: topOpportunity
        ? `${topOpportunity.label} over baseline ${formatNumber(baseline, 1)}`
        : "No scored opportunity over baseline yet",
    },
    {
      id: "swarm",
      label: "swarm output",
      value: `${formatNumber(draftCount)} outputs`,
      status: draftCount >= 3 ? "ok" : draftCount ? "warn" : "danger",
      detail: learningAutopilot?.primaryFormat?.id
        ? `primary rule ${learningAutopilot.primaryFormat.id}`
        : "waiting for primary rule",
    },
    {
      id: "route",
      label: "route queue",
      value: `${formatNumber(readyMissions)}/${formatNumber(missionCount)}`,
      status: readyMissions >= Math.min(2, missionCount || 1) ? "ok" : readyMissions ? "warn" : "danger",
      detail: "manual web actions spend 0 X read ops",
    },
    {
      id: "writeback",
      label: "learning writeback",
      value: `${formatNumber(measuredPosts)} packets`,
      status: measuredPosts >= Math.max(10, Number(insights?.minSamples) || 2) ? "ok" : "warn",
      detail: `${formatNumber(impressions24h)} L7 events in 24h feedback window`,
    },
  ];
  const edges = [
    {
      id: "ingress_ranker",
      from: "INGRESS",
      to: "RANKER",
      load: `${formatNumber(impressions7d)} L7`,
      status: impressions7d ? "ok" : "warn",
      detail: `${formatNumber(recent7d.length)} packets scored`,
    },
    {
      id: "ranker_swarm",
      from: "RANKER",
      to: "SWARM",
      load: `+${formatNumber(expectedLiftPct, 1)}%`,
      status: expectedLiftPct > 25 ? "ok" : expectedLiftPct > 0 ? "warn" : "danger",
      detail: `baseline ${formatNumber(baseline, 1)}`,
    },
    {
      id: "swarm_route",
      from: "SWARM",
      to: "ROUTE",
      load: `${formatNumber(draftCount)}/${formatNumber(targetRouteOps)}`,
      status: swarmCoveragePct >= 100 ? "ok" : swarmCoveragePct > 0 ? "warn" : "danger",
      detail: "paste-ready outputs",
    },
    {
      id: "route_writeback",
      from: "ROUTE",
      to: "WRITEBACK",
      load: `${formatNumber(routeCoveragePct, 0)}%`,
      status: routeCoveragePct >= 80 ? "ok" : routeCoveragePct > 0 ? "warn" : "danger",
      detail: "manual route coverage",
    },
    {
      id: "writeback_ingress",
      from: "WRITEBACK",
      to: "INGRESS",
      load: `${formatNumber(ackRate7d, 2)}% ACK`,
      status: ackRate7d >= 3 ? "ok" : ackRate7d > 0 ? "warn" : "danger",
      detail: "learning signal density",
    },
  ];

  return {
    generatedAt: now || new Date().toISOString(),
    mode,
    zeroExtraXReads: true,
    velocityScore: Number(velocityScore.toFixed(1)),
    loopCoefficient,
    expectedLiftPct: Number(expectedLiftPct.toFixed(1)),
    baselineScore: Number(baseline.toFixed(1)),
    safeBudgetLeftUsd: Number(safeBudgetLeft.toFixed(3)),
    bottleneck,
    ackRate24h: Number(ackRate24h.toFixed(2)),
    ackRate7d: Number(ackRate7d.toFixed(2)),
    routeCoveragePct: Number(routeCoveragePct.toFixed(1)),
    swarmCoveragePct: Number(swarmCoveragePct.toFixed(1)),
    nextBurst: {
      label: topOpportunity?.label || distributionOps?.primaryRoute?.label || "Build route queue",
      routeLabel: topOpportunity?.routeLabel || distributionOps?.primaryRoute?.label || null,
      routeUrl: topOpportunity?.routeUrl || distributionOps?.primaryRoute?.url || null,
      draftText: topOpportunity?.draftText || drafts?.[0]?.text || "",
      targetReplies: targetRouteOps,
      expectedLiftPct: Number(expectedLiftPct.toFixed(1)),
    },
    stages,
    edges,
    constraints: [
      { id: "read", label: "X read partition", value: controlPlane?.readGate || "cached_only", status: readGateClosed ? "danger" : "ok" },
      { id: "publish", label: "publish partition", value: controlPlane?.publishGate || "review", status: publishClosed ? "danger" : controlPlane?.publishGate === "open" ? "ok" : "warn" },
      { id: "budget", label: "safe cost partition", value: `$${formatNumber(safeBudgetLeft, 2)}`, status: safeBudgetLeft > 0.5 ? "ok" : safeBudgetLeft > 0 ? "warn" : "danger" },
    ],
    rules: [
      topOpportunity?.reason || "Exploit the highest scored format/source route before posting another standalone take.",
      learningAutopilot?.directives?.[0] || "Bias the next prompt toward the current highest-confidence content rule.",
      "Keep discovery, inference output, routing, and learning online without adding X search/read spend.",
    ].filter(Boolean),
  };
}

function engagementTotal(records = []) {
  return (
    sumTweetMetric(records, "like_count") +
    sumTweetMetric(records, "retweet_count") +
    sumTweetMetric(records, "reply_count")
  );
}

function recordPrivateMetricValue(record, key) {
  const snapshot = latestTweetSnapshot(record) || {};
  return (
    (Number(snapshot.nonPublicMetrics?.[key]) || 0) +
    (Number(snapshot.organicMetrics?.[key]) || 0)
  );
}

function buildConversionBucketLanes(records = [], {
  kind = "template",
  keyFn,
  labelFn,
  minSamples = 2,
  observedConversionPer1k = 0,
  fallbackConversionPer1k = 0.8,
} = {}) {
  const buckets = new Map();
  for (const record of records) {
    const id = keyFn(record);
    if (!id) continue;
    const label = labelFn(record, id);
    const bucket = buckets.get(id) || {
      id,
      kind,
      label,
      samples: 0,
      impressions: 0,
      engagements: 0,
      profileClicks: 0,
      totalScore: 0,
      lastPostedAt: null,
      examples: [],
    };
    const impressions = metricValue(record, "impression_count");
    const engagements =
      metricValue(record, "like_count") +
      metricValue(record, "retweet_count") +
      metricValue(record, "quote_count") +
      metricValue(record, "reply_count") +
      metricValue(record, "bookmark_count");
    const profileClicks = recordPrivateMetricValue(record, "user_profile_clicks");
    const score = recordGrowthScore(record);
    bucket.samples += 1;
    bucket.impressions += impressions;
    bucket.engagements += engagements;
    bucket.profileClicks += profileClicks;
    bucket.totalScore += score;
    if (!bucket.lastPostedAt || Date.parse(record.postedAt || "") > Date.parse(bucket.lastPostedAt || "")) {
      bucket.lastPostedAt = record.postedAt || bucket.lastPostedAt;
    }
    if (bucket.examples.length < 2) {
      bucket.examples.push({
        id: record.id || null,
        text: String(record.text || "").replace(/\s+/g, " ").slice(0, 120),
        url: record.url || (record.id ? xTweetUrl(record.id) : null),
        score: Number(score.toFixed(1)),
      });
    }
    buckets.set(id, bucket);
  }

  return [...buckets.values()].map((bucket) => {
    const avgScore = bucket.samples ? bucket.totalScore / bucket.samples : 0;
    const engagementRate = bucket.impressions > 0 ? (bucket.engagements / bucket.impressions) * 100 : 0;
    const profileClickPer1k = bucket.impressions > 0 ? (bucket.profileClicks / bucket.impressions) * 1000 : 0;
    const recencyHours = bucket.lastPostedAt ? (Date.now() - Date.parse(bucket.lastPostedAt)) / (60 * 60 * 1000) : null;
    const recencyBonus = recencyHours != null && recencyHours <= 72 ? 8 : recencyHours != null && recencyHours <= 168 ? 4 : 0;
    const sampleConfidence = bucket.samples >= Math.max(8, minSamples * 4)
      ? "high"
      : bucket.samples >= Math.max(3, minSamples * 2)
        ? "medium"
        : "low";
    const conversionScore = boundedPercent(
      12 +
        Math.min(26, avgScore * 4.2) +
        Math.min(18, engagementRate * 3.4) +
        Math.min(20, profileClickPer1k * 7) +
        Math.min(16, bucket.samples * 1.8) +
        recencyBonus,
    );
    const expectedConnPer1k = observedConversionPer1k > 0
      ? observedConversionPer1k * (0.58 + conversionScore / 100)
      : fallbackConversionPer1k * (0.65 + conversionScore / 85);
    const status = bucket.samples < minSamples
      ? conversionScore >= 48 ? "probe" : "hold"
      : conversionScore >= 70
        ? "exploit"
        : conversionScore >= 46
          ? "watch"
          : "hold";
    return {
      id: `${kind}:${bucket.id}`,
      bucketId: bucket.id,
      kind,
      label: bucket.label || compactBucketName(bucket.id),
      status,
      sampleConfidence,
      samples: bucket.samples,
      impressions: bucket.impressions,
      engagements: bucket.engagements,
      profileClicks: bucket.profileClicks,
      avgScore: Number(avgScore.toFixed(1)),
      engagementRate: Number(engagementRate.toFixed(2)),
      profileClickPer1k: Number(profileClickPer1k.toFixed(2)),
      expectedConnPer1k: Number(expectedConnPer1k.toFixed(2)),
      conversionScore: Number(conversionScore.toFixed(1)),
      lastPostedAt: bucket.lastPostedAt,
      examples: bucket.examples,
      nextAction: status === "exploit"
        ? `Exploit ${bucket.label || bucket.id}; it has the strongest active-conn conversion proxy.`
        : status === "probe"
          ? `Probe ${bucket.label || bucket.id} once more to confirm conversion signal.`
          : status === "watch"
            ? `Use ${bucket.label || bucket.id} only when story-fit is strong.`
            : `Hold ${bucket.label || bucket.id} unless the news fit is exceptional.`,
    };
  });
}

function buildGrowthKinetics({
  state = null,
  insights = null,
  distributionOps = null,
  operatorSlo = null,
  viralFlywheel = null,
  growthGoal = null,
  now = new Date().toISOString(),
} = {}) {
  const analyticsState = state || emptyTweetAnalyticsState();
  const recent24h = recordsSince(analyticsState, 24);
  const recent7d = recordsSince(analyticsState, 24 * 7);
  const impressions24h = sumTweetMetric(recent24h, "impression_count");
  const impressions7d = sumTweetMetric(recent7d, "impression_count");
  const engagements24h = engagementTotal(recent24h);
  const engagements7d = engagementTotal(recent7d);
  const engagementRate24h = impressions24h > 0 ? (engagements24h / impressions24h) * 100 : 0;
  const engagementRate7d = impressions7d > 0 ? (engagements7d / impressions7d) * 100 : 0;
  const snapshotDelta = followerDelta(analyticsState);
  const followerDeltaValue = Number(snapshotDelta?.delta) || 0;
  const currentFollowers = Number(growthGoal?.currentFollowers ?? latestFollowerCount(analyticsState) ?? 0) || 0;
  const nextMilestone = Number(growthGoal?.nextMilestone) || nextFollowerMilestone(currentFollowers, Number(growthGoal?.targetFollowers) || 1000);
  const remainingToMilestone = Math.max(0, nextMilestone - currentFollowers);
  const observedConversionPer1k = impressions7d > 0 && followerDeltaValue > 0
    ? (followerDeltaValue / impressions7d) * 1000
    : 0;
  const fallbackConversionPer1k = numberEnv("DASHBOARD_GROWTH_FALLBACK_CONVERSION_PER_1K", 0.8, 0.05, 25);
  const effectiveConversionPer1k = observedConversionPer1k > 0 ? observedConversionPer1k : fallbackConversionPer1k;
  const impressionsToMilestone = remainingToMilestone > 0 && effectiveConversionPer1k > 0
    ? (remainingToMilestone / effectiveConversionPer1k) * 1000
    : 0;
  const dailyThroughput = impressions7d > 0 ? impressions7d / 7 : impressions24h;
  const projectedDaysToMilestone = dailyThroughput > 0 && impressionsToMilestone > 0
    ? impressionsToMilestone / dailyThroughput
    : null;
  const readyMissions = Number(distributionOps?.readyMissions) || 0;
  const missionCount = Number(distributionOps?.missionCount) || 0;
  const targetReplies = Number(operatorSlo?.targetReplies || growthGoal?.dailyReplies || 3) || 3;
  const routeReadinessPct = missionCount > 0 ? (readyMissions / missionCount) * 100 : readyMissions ? 100 : 0;
  const replyCoveragePct = targetReplies > 0 ? (readyMissions / targetReplies) * 100 : 0;
  const viralVelocity = Number(viralFlywheel?.velocityScore) || 0;
  const score = boundedPercent(
    8 +
      Math.min(22, impressions24h / 12) +
      Math.min(18, engagementRate24h * 2.2) +
      Math.min(16, routeReadinessPct * 0.16) +
      Math.min(14, replyCoveragePct * 0.14) +
      Math.min(14, viralVelocity * 0.14) +
      (followerDeltaValue > 0 ? Math.min(10, followerDeltaValue * 4) : followerDeltaValue < 0 ? -10 : 0),
  );
  const mode = score >= 78
    ? "compounding"
    : score >= 58
      ? "acceleration"
      : score >= 34
        ? "ignition"
        : "starved";
  const status = score >= 58 ? "ok" : score >= 34 ? "warn" : "danger";
  const projectedDaysLabel = projectedDaysToMilestone == null
    ? "collect samples"
    : `${formatNumber(projectedDaysToMilestone, projectedDaysToMilestone > 30 ? 0 : 1)}d`;
  const nextAction = status === "ok"
    ? `Keep the current route loop hot; ${formatNumber(readyMissions)}/${formatNumber(targetReplies)} manual distribution lanes are armed.`
    : routeReadinessPct < 50
      ? `Arm ${formatNumber(Math.max(1, targetReplies - readyMissions))} manual route lane(s) before the next standalone post.`
      : engagementRate24h < Math.max(1, engagementRate7d * 0.7)
        ? "Use the next swarm output as a reply-first packet; standalone posting is not the current bottleneck."
        : "Keep collecting conversion samples and bias toward the active rule from learning writeback.";

  return {
    generatedAt: now,
    source: "cached tweet metrics + follower snapshots",
    zeroExtraXReads: true,
    mode,
    status,
    score: Number(score.toFixed(1)),
    currentFollowers,
    followerDelta: followerDeltaValue,
    followerCheckedAt: snapshotDelta?.latestAt || null,
    nextMilestone,
    remainingToMilestone,
    impressions24h,
    impressions7d,
    engagements24h,
    engagements7d,
    engagementRate24h: Number(engagementRate24h.toFixed(2)),
    engagementRate7d: Number(engagementRate7d.toFixed(2)),
    observedConversionPer1k: Number(observedConversionPer1k.toFixed(2)),
    effectiveConversionPer1k: Number(effectiveConversionPer1k.toFixed(2)),
    projectedDaysToMilestone: projectedDaysToMilestone == null ? null : Number(projectedDaysToMilestone.toFixed(1)),
    routeReadinessPct: Number(routeReadinessPct.toFixed(1)),
    replyCoveragePct: Number(replyCoveragePct.toFixed(1)),
    nextAction,
    cells: [
      { id: "throughput", label: "L7 throughput", value: impressions24h, status: impressions24h > 100 ? "ok" : impressions24h > 20 ? "warn" : "danger" },
      { id: "engagement", label: "ACK rate", value: `${formatNumber(engagementRate24h, 1)}%`, status: engagementRate24h >= 4 ? "ok" : engagementRate24h >= 1.5 ? "warn" : "danger" },
      { id: "conversion", label: "conn / 1k events", value: formatNumber(effectiveConversionPer1k, 2), status: observedConversionPer1k > 0 ? "ok" : "warn" },
      { id: "runway", label: "milestone runway", value: projectedDaysLabel, status: projectedDaysToMilestone == null ? "warn" : projectedDaysToMilestone <= 14 ? "ok" : projectedDaysToMilestone <= 45 ? "warn" : "danger" },
    ],
    lanes: [
      {
        id: "ingress",
        label: "ingress throughput",
        value: impressions24h,
        score: boundedPercent(impressions24h / Math.max(1, (impressions7d / 7) || 1) * 50),
        status: impressions24h > 100 ? "ok" : impressions24h > 20 ? "warn" : "danger",
        detail: `${formatNumber(impressions7d)} L7 events over 7d`,
      },
      {
        id: "ack",
        label: "ACK reactor",
        value: `${formatNumber(engagementRate24h, 1)}%`,
        score: boundedPercent(engagementRate24h * 12),
        status: engagementRate24h >= 4 ? "ok" : engagementRate24h >= 1.5 ? "warn" : "danger",
        detail: `${formatNumber(engagements24h)} ACKs in 24h`,
      },
      {
        id: "conversion",
        label: "conn conversion",
        value: `${formatNumber(effectiveConversionPer1k, 2)}/1k`,
        score: boundedPercent(effectiveConversionPer1k * 30),
        status: observedConversionPer1k > 0 ? "ok" : "warn",
        detail: observedConversionPer1k > 0 ? `${formatNumber(followerDeltaValue, 0)} active conn delta` : "using fallback conversion prior",
      },
      {
        id: "route",
        label: "route amplifier",
        value: `${formatNumber(readyMissions)}/${formatNumber(targetReplies)}`,
        score: boundedPercent(replyCoveragePct),
        status: replyCoveragePct >= 100 ? "ok" : replyCoveragePct >= 50 ? "warn" : "danger",
        detail: "manual lanes preserve 0 X read ops",
      },
    ],
  };
}

function buildL7SurgeSentinel({
  state = null,
  growthKinetics = null,
  routeOpportunityMatrix = null,
  rateLimitGovernor = null,
  budgetBurnReactor = null,
  trendVelocityRadar = null,
  hourlyLoadBalancer = null,
  viralFlywheel = null,
  now = new Date().toISOString(),
} = {}) {
  const analyticsState = state || emptyTweetAnalyticsState();
  const recent24h = recordsSince(analyticsState, 24)
    .slice()
    .sort((left, right) => new Date(left.postedAt || left.createdAt || 0) - new Date(right.postedAt || right.createdAt || 0));
  const recent7d = recordsSince(analyticsState, 24 * 7);
  const l7Events24h = Math.max(0, Number(growthKinetics?.impressions24h) || sumTweetMetric(recent24h, "impression_count"));
  const l7Events7d = Math.max(0, Number(growthKinetics?.impressions7d) || sumTweetMetric(recent7d, "impression_count"));
  const ackRate24h = Math.max(0, Number(growthKinetics?.engagementRate24h) || 0);
  const ackRate7d = Math.max(0, Number(growthKinetics?.engagementRate7d) || 0);
  const dailyBaseline = l7Events7d > 0 ? l7Events7d / 7 : l7Events24h;
  const surgeRatio = dailyBaseline > 0 ? l7Events24h / dailyBaseline : 0;
  const readyRoutes = Math.max(0, Number(routeOpportunityMatrix?.readyLanes) || 0);
  const totalRoutes = Math.max(0, Number(routeOpportunityMatrix?.totalLanes) || 0);
  const routeCoveragePct = totalRoutes > 0 ? (readyRoutes / totalRoutes) * 100 : readyRoutes ? 100 : 0;
  const routeScore = Math.max(0, Number(routeOpportunityMatrix?.avgScore) || 0);
  const budgetRemaining = Number(
    budgetBurnReactor?.safeRemainingUsd ??
      rateLimitGovernor?.budget?.safeRemainingUsd ??
      routeOpportunityMatrix?.safeRemainingUsd,
  );
  const budgetScore = Number.isFinite(budgetRemaining)
    ? budgetRemaining > 1
      ? 100
      : budgetRemaining > 0
        ? Math.max(18, budgetRemaining * 82)
        : 0
    : 100;
  const readGate = ["closed", "sealed"].includes(rateLimitGovernor?.gates?.read || budgetBurnReactor?.readGate)
    ? "closed"
    : "cached_only";
  const trendSummary = trendVelocityRadar?.summary || {};
  const breakoutCount = Math.max(0, Number(trendSummary.breakoutCount) || 0);
  const avgVelocity = Math.max(0, Number(trendSummary.avgVelocity) || 0);
  const activeWindow = (hourlyLoadBalancer?.hours || [])
    .slice()
    .sort((left, right) => Number(right.loadScore || right.score || 0) - Number(left.loadScore || left.score || 0))[0] || null;
  const windowLoad = Math.max(0, Number(activeWindow?.loadScore ?? activeWindow?.score) || 0);
  const flywheelScore = Math.max(0, Number(viralFlywheel?.velocityScore) || 0);
  const traceValues = recent24h
    .map((record) => Math.max(0, metricValue(record, "impression_count")))
    .filter((value) => Number.isFinite(value));
  const trace = (traceValues.length ? traceValues : [l7Events24h]).slice(-18);
  const traceMax = Math.max(1, ...trace);
  const l7LoadScore = boundedPercent(dailyBaseline > 0 ? surgeRatio * 52 : l7Events24h / 4);
  const ackScore = boundedPercent(ackRate24h * 16 + Math.max(0, ackRate24h - ackRate7d) * 10);
  const trendScore = boundedPercent(Math.min(70, avgVelocity) + breakoutCount * 7);
  const routeReadinessScore = boundedPercent(routeCoveragePct * 0.72 + routeScore * 0.28);
  const costPressurePenalty = readGate === "closed" ? 22 : Math.max(0, 24 - budgetScore * 0.24);
  const sentinelScore = boundedPercent(
    8 +
      l7LoadScore * 0.23 +
      ackScore * 0.18 +
      trendScore * 0.17 +
      routeReadinessScore * 0.22 +
      Math.min(12, windowLoad * 0.12) +
      Math.min(10, flywheelScore * 0.1) -
      costPressurePenalty,
  );
  const severity = readGate === "closed" || budgetScore <= 0
    ? "danger"
    : sentinelScore >= 68 && routeCoveragePct >= 50
      ? "ok"
      : sentinelScore >= 40
        ? "warn"
        : "danger";
  const mode = severity === "ok"
    ? (surgeRatio >= 1.35 ? "surge_capture" : "route_acceleration")
    : severity === "warn"
      ? "route_repair"
      : "containment";
  const runbook = severity === "ok"
    ? "Exploit the active load window with one manual route packet; keep live X reads sealed."
    : severity === "warn"
      ? "Repair route coverage and use cached swarm output before buying any read operation."
      : "Seal paid read partitions, hold optional spend, and recover the manual route loop first.";
  const lanes = [
    {
      id: "l7_load",
      label: "L7_LOAD",
      value: formatNumber(l7Events24h),
      score: Number(l7LoadScore.toFixed(1)),
      status: l7LoadScore >= 64 ? "hot" : l7LoadScore >= 38 ? "watch" : "danger",
      detail: `${formatNumber(dailyBaseline, 1)} baseline/day · ${formatNumber(surgeRatio, 2)}x`,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
    },
    {
      id: "ack_rate",
      label: "ACK_RATE",
      value: `${formatNumber(ackRate24h, 1)}%`,
      score: Number(ackScore.toFixed(1)),
      status: ackScore >= 64 ? "hot" : ackScore >= 34 ? "watch" : "danger",
      detail: `${formatNumber(ackRate7d, 1)}% 7d baseline`,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
    },
    {
      id: "route_mesh",
      label: "ROUTE_MESH",
      value: `${formatNumber(readyRoutes)}/${formatNumber(totalRoutes)}`,
      score: Number(routeReadinessScore.toFixed(1)),
      status: routeReadinessScore >= 72 ? "hot" : routeReadinessScore >= 42 ? "watch" : "danger",
      detail: `${formatNumber(routeScore, 1)} avg matrix score`,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
    },
    {
      id: "trend_heat",
      label: "TREND_HEAT",
      value: formatNumber(avgVelocity, 1),
      score: Number(trendScore.toFixed(1)),
      status: trendScore >= 70 ? "hot" : trendScore >= 36 ? "watch" : "ok",
      detail: `${formatNumber(breakoutCount)} cached breakout lanes`,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
    },
    {
      id: "cost_boundary",
      label: "COST_BOUNDARY",
      value: Number.isFinite(budgetRemaining) ? `$${formatNumber(budgetRemaining, 3)}` : "unlimited",
      score: Number(budgetScore.toFixed(1)),
      status: budgetScore >= 60 ? "ok" : budgetScore > 0 ? "watch" : "danger",
      detail: `${readGate} read gate`,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
    },
  ];
  return {
    generatedAt: now,
    mode: "zero_read_l7_surge_sentinel",
    severity,
    source: "cached packet metrics + route matrix + cost governor",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    operatorMode: "human_in_loop",
    readGate,
    manualOnly: true,
    sentinelScore: Number(sentinelScore.toFixed(1)),
    l7Events24h,
    l7Events7d,
    dailyBaseline: Number(dailyBaseline.toFixed(1)),
    surgeRatio: Number(surgeRatio.toFixed(2)),
    ackRate24h: Number(ackRate24h.toFixed(2)),
    ackRate7d: Number(ackRate7d.toFixed(2)),
    routeCoveragePct: Number(routeCoveragePct.toFixed(1)),
    routeScore: Number(routeScore.toFixed(1)),
    breakoutCount,
    avgVelocity: Number(avgVelocity.toFixed(1)),
    activeWindow: activeWindow
      ? {
          hour: Number(activeWindow.hour),
          label: activeWindow.label || activeWindow.windowLabel || `${String(activeWindow.hour).padStart(2, "0")}:00`,
          loadScore: Number(windowLoad.toFixed(1)),
        }
      : null,
    primaryRouteLabel: routeOpportunityMatrix?.topRouteLabel || null,
    primaryOpenUrl: routeOpportunityMatrix?.primaryOpenUrl || null,
    primaryPastePayload: routeOpportunityMatrix?.primaryPastePayload || null,
    nextAction: runbook,
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "l7_24h", label: "L7_24H", value: formatNumber(l7Events24h), status: l7LoadScore >= 64 ? "ok" : l7LoadScore >= 38 ? "warn" : "danger" },
      { id: "surge_ratio", label: "SURGE_RATIO", value: `${formatNumber(surgeRatio, 2)}x`, status: surgeRatio >= 1.35 ? "ok" : surgeRatio >= 0.75 ? "warn" : "danger" },
      { id: "route_ready", label: "ROUTE_READY", value: `${formatNumber(readyRoutes)}/${formatNumber(totalRoutes)}`, status: routeCoveragePct >= 75 ? "ok" : routeCoveragePct >= 35 ? "warn" : "danger" },
      { id: "cost_gate", label: "COST_GATE", value: readGate, status: readGate === "cached_only" ? "ok" : "danger" },
    ],
    lanes,
    trace,
    traceMax,
    guardrails: [
      "Cached telemetry only; 0 X search/read API operations.",
      "Manual browser execution only; no automated outbound actions.",
      "Normal backoff only; no rate-limit circumvention.",
    ],
  };
}

function buildActiveConnConversionOptimizer({
  state = null,
  insights = null,
  growthKinetics = null,
  contentBanditAllocator = null,
  audienceExpansionRouter = null,
  routeAmplifier = null,
  now = new Date().toISOString(),
} = {}) {
  const records = Array.isArray(insights?.records) ? insights.records : [];
  const minSamples = Math.max(1, Number(insights?.minSamples) || 2);
  const observedConversionPer1k = Number(growthKinetics?.observedConversionPer1k) || 0;
  const fallbackConversionPer1k = Number(growthKinetics?.effectiveConversionPer1k) || numberEnv("DASHBOARD_GROWTH_FALLBACK_CONVERSION_PER_1K", 0.8, 0.05, 25);
  const activeConnDelta = Number(growthKinetics?.followerDelta) || Number(followerDelta(state || emptyTweetAnalyticsState())?.delta) || 0;
  const templateLanes = buildConversionBucketLanes(records, {
    kind: "format",
    minSamples,
    observedConversionPer1k,
    fallbackConversionPer1k,
    keyFn: (record) => record.templateId || "unknown",
    labelFn: (record, id) => configuredContentFormats().find((format) => format.id === id)?.label || compactBucketName(id),
  });
  const audienceLanes = buildConversionBucketLanes(records, {
    kind: "audience",
    minSamples,
    observedConversionPer1k,
    fallbackConversionPer1k,
    keyFn: (record) => record.audienceSegment || primaryAudienceSegment(record).id,
    labelFn: (record, id) => audienceSegmentDefinition(id).label || compactBucketName(id),
  });
  const sourceLanes = buildConversionBucketLanes(records, {
    kind: "source",
    minSamples,
    observedConversionPer1k,
    fallbackConversionPer1k,
    keyFn: (record) => record.newsSourceTier || record.newsSource || "",
    labelFn: (record, id) => compactBucketName(id),
  });
  const banditPrimaryId = contentBanditAllocator?.recommendedLane?.id || contentBanditAllocator?.primaryFormatId || null;
  const audiencePrimaryId = audienceExpansionRouter?.primarySegmentId || audienceExpansionRouter?.segments?.[0]?.id || null;
  const lanes = [...templateLanes, ...audienceLanes, ...sourceLanes]
    .map((lane) => {
      const banditBoost = lane.bucketId === banditPrimaryId ? 8 : 0;
      const audienceBoost = lane.bucketId === audiencePrimaryId ? 6 : 0;
      const routeBoost = routeAmplifier?.topRouteLabel && String(lane.label).toLowerCase().includes(String(routeAmplifier.topRouteLabel).toLowerCase()) ? 4 : 0;
      const adjustedScore = boundedPercent((Number(lane.conversionScore) || 0) + banditBoost + audienceBoost + routeBoost);
      return {
        ...lane,
        conversionScore: Number(adjustedScore.toFixed(1)),
        expectedConnPer1k: Number((Number(lane.expectedConnPer1k || fallbackConversionPer1k) * (1 + (banditBoost + audienceBoost + routeBoost) / 120)).toFixed(2)),
        boosters: [
          banditBoost ? "bandit" : null,
          audienceBoost ? "audience_router" : null,
          routeBoost ? "route_amplifier" : null,
        ].filter(Boolean),
      };
    })
    .sort((left, right) => {
      const statusRank = { exploit: 4, probe: 3, watch: 2, hold: 1 };
      return (statusRank[right.status] || 0) - (statusRank[left.status] || 0) ||
        right.conversionScore - left.conversionScore ||
        right.samples - left.samples;
    })
    .slice(0, 9);
  const primaryLane = lanes.find((lane) => lane.status === "exploit") || lanes.find((lane) => lane.status === "probe") || lanes[0] || null;
  const exploitCount = lanes.filter((lane) => lane.status === "exploit").length;
  const profileClicks7d = records.reduce((sum, record) => sum + recordPrivateMetricValue(record, "user_profile_clicks"), 0);
  const totalImpressions = records.reduce((sum, record) => sum + metricValue(record, "impression_count"), 0);
  const profileClickPer1k = totalImpressions > 0 ? (profileClicks7d / totalImpressions) * 1000 : 0;
  const score = boundedPercent(
    16 +
      Math.min(26, Number(primaryLane?.conversionScore) || 0) * 0.42 +
      Math.min(20, profileClickPer1k * 8) +
      Math.min(16, exploitCount * 5) +
      Math.min(12, records.length / 8) +
      (activeConnDelta > 0 ? Math.min(10, activeConnDelta * 4) : activeConnDelta < 0 ? -8 : 0),
  );
  const severity = score >= 64 ? "ok" : score >= 38 ? "warn" : "danger";
  const mode = severity === "ok" ? "conversion_exploit" : severity === "warn" ? "conversion_probe" : "conversion_starved";
  const nextAction = primaryLane
    ? `${primaryLane.status === "hold" ? "Do not force" : "Bias next packet toward"} ${primaryLane.label}; expected ${formatNumber(primaryLane.expectedConnPer1k, 2)} active conns / 1k L7 events.`
    : "Collect more measured packets before trusting conversion allocation.";
  return {
    generatedAt: now,
    mode,
    severity,
    zeroExtraXReads: true,
    source: "cached tweet metrics + follower snapshots + private profile-click metrics when available",
    conversionScore: Number(score.toFixed(1)),
    observedConversionPer1k: Number(observedConversionPer1k.toFixed(2)),
    fallbackConversionPer1k: Number(fallbackConversionPer1k.toFixed(2)),
    activeConnDelta,
    sampleCount: records.length,
    profileClicks: profileClicks7d,
    profileClickPer1k: Number(profileClickPer1k.toFixed(2)),
    primaryLaneId: primaryLane?.id || null,
    primaryLane,
    nextAction,
    promptDirectives: [
      primaryLane ? `Lead with ${primaryLane.label}; write for follow-worthy utility, not raw impressions.` : null,
      contentBanditAllocator?.recommendedLane?.id ? `Keep content format aligned with bandit lane ${contentBanditAllocator.recommendedLane.id}.` : null,
      audienceExpansionRouter?.nextAction || null,
      "Make the first line a reusable rule, cost, or prediction a tech-curious reader would follow for.",
    ].filter(Boolean).slice(0, 4),
    gates: [
      { id: "x_reads", label: "X read ops", value: "0", status: "ok" },
      { id: "samples", label: "conversion samples", value: formatNumber(records.length), status: records.length >= Math.max(12, minSamples * 4) ? "ok" : "warn" },
      { id: "profile_clicks", label: "profile-click proxy", value: formatNumber(profileClicks7d), status: profileClicks7d > 0 ? "ok" : "warn" },
      { id: "active_delta", label: "active conn delta", value: `${activeConnDelta >= 0 ? "+" : ""}${formatNumber(activeConnDelta)}`, status: activeConnDelta > 0 ? "ok" : activeConnDelta < 0 ? "danger" : "warn" },
    ],
    lanes,
  };
}

function buildGrowthLeakProfiler({
  growthKinetics = null,
  l7SurgeSentinel = null,
  activeConnConversionOptimizer = null,
  routeOpportunityMatrix = null,
  budgetAllocationOptimizer = null,
  growthMissionControl = null,
  rateLimitGovernor = null,
  now = new Date().toISOString(),
} = {}) {
  const laneById = new Map((l7SurgeSentinel?.lanes || []).map((lane) => [lane.id, lane]));
  const stageStatus = (score) => score >= 65 ? "ok" : score >= 38 ? "warn" : "danger";
  const stage = ({ id, label, value, score, detail, nextAction }) => {
    const boundedScore = boundedPercent(score);
    return {
      id,
      label,
      value,
      score: Number(boundedScore.toFixed(1)),
      status: stageStatus(boundedScore),
      leakPct: Number((100 - boundedScore).toFixed(1)),
      detail,
      nextAction,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
    };
  };

  const readGate = ["closed", "sealed"].includes(rateLimitGovernor?.gates?.read || l7SurgeSentinel?.readGate)
    ? "closed"
    : "cached_only";
  const l7Events24h = Math.max(0, Number(l7SurgeSentinel?.l7Events24h ?? growthKinetics?.l7Events24h ?? growthKinetics?.impressions24h) || 0);
  const ackRate24h = Math.max(0, Number(l7SurgeSentinel?.ackRate24h ?? growthKinetics?.ackRate24h ?? growthKinetics?.engagementRate24h) || 0);
  const readyRoutes = Math.max(0, Number(routeOpportunityMatrix?.readyLanes) || 0);
  const totalRoutes = Math.max(0, Number(routeOpportunityMatrix?.totalLanes) || 0);
  const routeCoveragePct = totalRoutes > 0 ? (readyRoutes / totalRoutes) * 100 : readyRoutes ? 100 : 0;
  const routeScore = Number(routeOpportunityMatrix?.avgScore ?? laneById.get("route_mesh")?.score) || 0;
  const profileClickPer1k = Math.max(0, Number(activeConnConversionOptimizer?.profileClickPer1k) || 0);
  const sampleCount = Math.max(0, Number(activeConnConversionOptimizer?.sampleCount) || 0);
  const observedConnPer1k = Math.max(0, Number(activeConnConversionOptimizer?.observedConversionPer1k) || 0);
  const fallbackConnPer1k = Math.max(0, Number(activeConnConversionOptimizer?.fallbackConversionPer1k) || 0);
  const activeConnDelta = Number(activeConnConversionOptimizer?.activeConnDelta) || 0;
  const conversionScore = Math.max(0, Number(activeConnConversionOptimizer?.conversionScore) || 0);
  const remainingUsd = Number(
    budgetAllocationOptimizer?.safeRemainingUsd ??
      growthMissionControl?.safeRemainingUsd ??
      rateLimitGovernor?.budget?.safeRemainingUsd ??
      l7SurgeSentinel?.cells?.find((cell) => cell.id === "cost_boundary")?.value,
  );
  const budgetScore = readGate === "closed"
    ? 0
    : Number.isFinite(remainingUsd)
      ? remainingUsd > 1
        ? 100
        : remainingUsd > 0
          ? Math.max(18, remainingUsd * 82)
          : 0
      : Number(laneById.get("cost_boundary")?.score) || 100;

  const stages = [
    stage({
      id: "l7_input",
      label: "L7_INPUT",
      value: formatNumber(l7Events24h),
      score: Number(laneById.get("l7_load")?.score) || Number(l7SurgeSentinel?.sentinelScore) || 0,
      detail: `${formatNumber(Number(l7SurgeSentinel?.surgeRatio) || 0, 2)}x cached load ratio`,
      nextAction: "Route one cached high-signal packet inside an active technical exchange before generating more standalone output.",
    }),
    stage({
      id: "ack_layer",
      label: "ACK_LAYER",
      value: `${formatNumber(ackRate24h, 1)}%`,
      score: Number(laneById.get("ack_rate")?.score) || boundedPercent(ackRate24h * 16),
      detail: "reaction layer from cached packet metrics",
      nextAction: "Tighten the first line into one decision rule; make the payload useful enough for a senior operator to save.",
    }),
    stage({
      id: "profile_proxy",
      label: "PROFILE_PROXY",
      value: `${formatNumber(profileClickPer1k, 2)}/1k`,
      score: boundedPercent(profileClickPer1k * 18 + Math.min(24, sampleCount * 1.4) + conversionScore * 0.18),
      detail: `${formatNumber(sampleCount)} measured packets in cache`,
      nextAction: "Make the payload promise repeatable tech utility and place it under a credible account exchange.",
    }),
    stage({
      id: "active_conn",
      label: "ACTIVE_CONN",
      value: `${activeConnDelta >= 0 ? "+" : ""}${formatNumber(activeConnDelta)}`,
      score: boundedPercent(
        activeConnDelta > 0
          ? 62 + Math.min(28, activeConnDelta * 6) + Math.min(10, observedConnPer1k * 6)
          : activeConnDelta < 0
            ? 18 + Math.min(14, fallbackConnPer1k * 4)
            : 34 + Math.min(22, observedConnPer1k * 12) + Math.min(12, fallbackConnPer1k * 5),
      ),
      detail: `${formatNumber(observedConnPer1k, 2)}/1k observed · ${formatNumber(fallbackConnPer1k, 2)}/1k prior`,
      nextAction: "Run the strongest route lane and make the account promise explicit in the first sentence.",
    }),
    stage({
      id: "route_mesh",
      label: "ROUTE_MESH",
      value: `${formatNumber(readyRoutes)}/${formatNumber(totalRoutes)}`,
      score: boundedPercent(routeCoveragePct * 0.7 + routeScore * 0.3),
      detail: `${formatNumber(routeScore, 1)} avg route score`,
      nextAction: "Open the ready route lane, paste one useful payload, then mark done or skipped.",
    }),
    stage({
      id: "cost_gate",
      label: "COST_GATE",
      value: readGate,
      score: budgetScore,
      detail: "cached-only X read partition",
      nextAction: "Keep live reads sealed; operate from cached telemetry and manual browser routes.",
    }),
  ];

  const primaryLeak = stages
    .slice()
    .sort((left, right) => left.score - right.score || right.leakPct - left.leakPct)[0] || null;
  const avgScore = stages.length ? stages.reduce((sum, item) => sum + item.score, 0) / stages.length : 0;
  const leakScore = boundedPercent(avgScore * 0.62 + (primaryLeak ? primaryLeak.score * 0.38 : 0));
  const severity = readGate === "closed" || primaryLeak?.status === "danger"
    ? "danger"
    : primaryLeak?.status === "warn" || leakScore < 66
      ? "warn"
      : "ok";

  return {
    generatedAt: now,
    mode: "zero_read_growth_leak_profiler",
    severity,
    source: "cached packet metrics + active conn proxy + route matrix",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    operatorMode: "human_in_loop",
    readGate,
    manualOnly: true,
    leakScore: Number(leakScore.toFixed(1)),
    primaryLeakId: primaryLeak?.id || null,
    primaryLeak: primaryLeak
      ? {
          id: primaryLeak.id,
          label: primaryLeak.label,
          status: primaryLeak.status,
          score: primaryLeak.score,
          leakPct: primaryLeak.leakPct,
          nextAction: primaryLeak.nextAction,
        }
      : null,
    nextAction: primaryLeak?.nextAction || "Keep the cached route loop active and protect the read partition.",
    stages,
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "primary_leak", label: "PRIMARY_LEAK", value: primaryLeak?.label || "-", status: severity },
      { id: "active_conn", label: "ACTIVE_CONN_DELTA", value: `${activeConnDelta >= 0 ? "+" : ""}${formatNumber(activeConnDelta)}`, status: activeConnDelta > 0 ? "ok" : activeConnDelta < 0 ? "danger" : "warn" },
      { id: "profile_proxy", label: "PROFILE_PROXY", value: `${formatNumber(profileClickPer1k, 2)}/1k`, status: profileClickPer1k > 0 ? "ok" : "warn" },
      { id: "route_ready", label: "ROUTE_READY", value: `${formatNumber(readyRoutes)}/${formatNumber(totalRoutes)}`, status: readyRoutes > 0 ? "ok" : "danger" },
      { id: "cost_gate", label: "COST_GATE", value: readGate, status: readGate === "cached_only" ? "ok" : "danger" },
    ],
    guardrails: [
      "Cached telemetry only; 0 X search/read API operations.",
      "Manual browser execution only; no automated outbound actions.",
      "Normal backoff only; no rate-limit circumvention.",
    ],
  };
}

function buildCommandPacketDock({
  operatorPasteQueue = null,
  routeOpportunityMatrix = null,
  growthLeakProfiler = null,
  nextWindowAngleCommander = null,
  l7SurgeSentinel = null,
  activeConnConversionOptimizer = null,
  now = new Date().toISOString(),
} = {}) {
  const routeLanes = Array.isArray(routeOpportunityMatrix?.lanes) ? routeOpportunityMatrix.lanes : [];
  const queueTasks = Array.isArray(operatorPasteQueue?.tasks) ? operatorPasteQueue.tasks : [];
  const readyLane =
    routeLanes.find((lane) => lane.ready && lane.openUrl && lane.pastePayload) ||
    queueTasks.find((task) => task.ready && task.openUrl && task.pastePayload) ||
    routeLanes[0] ||
    queueTasks[0] ||
    null;
  const primaryLeak = growthLeakProfiler?.primaryLeak || null;
  const leakScore = Number(growthLeakProfiler?.leakScore) || 0;
  const routeScore = Number(readyLane?.score ?? routeOpportunityMatrix?.avgScore) || 0;
  const conversionScore = Number(activeConnConversionOptimizer?.conversionScore) || 0;
  const l7Score = Number(l7SurgeSentinel?.sentinelScore) || 0;
  const commandScore = boundedPercent(
    10 +
      Math.min(30, routeScore * 0.3) +
      Math.min(20, leakScore * 0.2) +
      Math.min(18, conversionScore * 0.18) +
      Math.min(14, l7Score * 0.14) +
      (readyLane?.ready ? 16 : -18),
  );
  const severity = !readyLane?.ready
    ? "danger"
    : primaryLeak?.status === "danger"
      ? "warn"
      : commandScore >= 70
        ? "ok"
        : commandScore >= 42
          ? "warn"
          : "danger";
  const routeLabel = readyLane?.routeLabel || readyLane?.label || operatorPasteQueue?.primaryRouteLabel || routeOpportunityMatrix?.topRouteLabel || "Route lane";
  const openUrl = readyLane?.openUrl || operatorPasteQueue?.primaryOpenUrl || routeOpportunityMatrix?.primaryOpenUrl || nextWindowAngleCommander?.routeUrl || null;
  const pastePayload = readyLane?.pastePayload || operatorPasteQueue?.primaryPastePayload || routeOpportunityMatrix?.primaryPastePayload || "";
  const operatorSlaMinutes = Math.max(5, Number(readyLane?.operatorSlaMinutes) || 10);
  const targetOps = Math.max(1, Number(readyLane?.targetReplies) || Number(operatorPasteQueue?.targetReplies) || 1);
  const nextAction = readyLane?.ready
    ? `Open ${routeLabel}, select one fresh technical exchange, paste the payload, then stop after ${formatNumber(targetOps)} route op${targetOps > 1 ? "s" : ""}.`
    : "Repair route and payload readiness before opening X web.";
  const copyBlock = [
    "CODEX COMMAND PACKET DOCK",
    `Generated: ${now}`,
    "Mode: zero_read_command_packet_dock",
    "Cost guard: 0 X search/read API operations",
    `Command score: ${formatNumber(commandScore, 1)}`,
    `Primary route: ${routeLabel}`,
    primaryLeak?.label ? `Primary leak: ${primaryLeak.label}` : null,
    "",
    "Operator protocol:",
    openUrl ? `OPEN: ${openUrl}` : "OPEN: repair route link first",
    pastePayload ? `PASTE: ${pastePayload}` : "PASTE: repair payload first",
    `EDIT: ${readyLane?.editRule || "Edit nouns, timing, and one concrete reference only."}`,
    `SKIP: ${readyLane?.skipRule || "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges."}`,
    `DONE: ${readyLane?.doneSignal || "One useful route op completed or skipped for quality."}`,
  ].filter(Boolean).join("\n");

  return {
    generatedAt: now,
    mode: "zero_read_command_packet_dock",
    severity,
    source: "cached route matrix + leak profiler + paste queue",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    operatorMode: "human_in_loop",
    readGate: "browser_only",
    manualOnly: true,
    commandScore: Number(commandScore.toFixed(1)),
    routeLabel,
    openUrl,
    pastePayload,
    targetOps,
    operatorSlaMinutes,
    primaryLeakId: primaryLeak?.id || growthLeakProfiler?.primaryLeakId || null,
    primaryLeakLabel: primaryLeak?.label || null,
    primaryLeakStatus: primaryLeak?.status || null,
    nextAction,
    primaryPacket: {
      id: readyLane?.id || null,
      label: routeLabel,
      status: readyLane?.ready ? "ready" : "repair",
      openUrl,
      pastePayload,
      score: Number(routeScore.toFixed(1)),
      operatorSlaMinutes,
      targetOps,
      editRule: readyLane?.editRule || "Edit nouns, timing, and one concrete reference only.",
      skipRule: readyLane?.skipRule || "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
      doneSignal: readyLane?.doneSignal || "One useful route op completed or skipped for quality.",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
    },
    steps: [
      { id: "open_route", label: "OPEN_ROUTE", status: openUrl ? "ok" : "danger", detail: "Open the X web route from this dock." },
      { id: "select_exchange", label: "SELECT_EXCHANGE", status: "ok", detail: "Choose one fresh technical exchange with visible discussion." },
      { id: "paste_payload", label: "PASTE_PAYLOAD", status: pastePayload ? "ok" : "danger", detail: "Paste once, edit only context, then leave the lane." },
      { id: "stop_gate", label: "STOP_GATE", status: "ok", detail: `Stop after ${formatNumber(targetOps)} route op${targetOps > 1 ? "s" : ""} or when quality drops.` },
    ],
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "route", label: "ROUTE", value: routeLabel, status: readyLane?.ready ? "ok" : "danger" },
      { id: "sla", label: "OPERATOR_SLA", value: `${formatNumber(operatorSlaMinutes)}m`, status: operatorSlaMinutes <= 20 ? "ok" : "warn" },
      { id: "leak", label: "PRIMARY_LEAK", value: primaryLeak?.label || "-", status: primaryLeak?.status || "warn" },
      { id: "payload", label: "PAYLOAD", value: pastePayload ? "armed" : "repair", status: pastePayload ? "ok" : "danger" },
    ],
    guardrails: [
      "Manual browser execution only; no automated outbound actions.",
      "Use X web route links; search/read API operations stay at 0.",
      "No rate-limit circumvention; use normal cooldown and cached telemetry.",
    ],
    copyBlock,
  };
}

function buildIdentityConversionFirewall({
  narrativeResonanceController = null,
  activeConnConversionOptimizer = null,
  growthLeakProfiler = null,
  commandPacketDock = null,
  growthMissionControl = null,
  growthKinetics = null,
  now = new Date().toISOString(),
} = {}) {
  const statusFor = (score) => score >= 70 ? "ok" : score >= 42 ? "warn" : "danger";
  const makeCheck = ({ id, label, value, score, detail, nextAction }) => {
    const boundedScore = boundedPercent(score);
    return {
      id,
      label,
      value,
      score: Number(boundedScore.toFixed(1)),
      status: statusFor(boundedScore),
      detail,
      nextAction,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
    };
  };

  const accountPromise = String(
    narrativeResonanceController?.accountPromise ||
      "Tech Signals: explain how AI, platforms, apps, cloud, security, and startups change operator leverage, defaults, distribution, and risk.",
  ).replace(/\s+/g, " ").trim();
  const primaryPillar = narrativeResonanceController?.primaryPillar || null;
  const routeLabel = commandPacketDock?.routeLabel || commandPacketDock?.primaryPacket?.label || "Route lane";
  const routeReady = commandPacketDock?.primaryPacket?.status === "ready" && Boolean(commandPacketDock?.openUrl || commandPacketDock?.primaryPacket?.openUrl);
  const resonanceScore = Number(narrativeResonanceController?.resonanceScore) || 0;
  const commandScore = Number(commandPacketDock?.commandScore) || 0;
  const leakScore = Number(growthLeakProfiler?.leakScore) || 0;
  const conversionScore = Number(activeConnConversionOptimizer?.conversionScore) || 0;
  const sampleCount = Math.max(0, Number(activeConnConversionOptimizer?.sampleCount) || 0);
  const profileClickPer1k = Math.max(0, Number(activeConnConversionOptimizer?.profileClickPer1k) || 0);
  const activeConnDelta = Number(activeConnConversionOptimizer?.activeConnDelta) || 0;
  const l7Events24h = Math.max(0, Number(growthKinetics?.l7Events24h ?? growthKinetics?.impressions24h) || 0);
  const missionScore = Number(growthMissionControl?.missionScore) || 0;
  const primaryLeak = growthLeakProfiler?.primaryLeak || null;

  const promiseScore = boundedPercent(
    resonanceScore * 0.74 +
      (primaryPillar?.label ? 12 : -8) +
      Math.min(10, sampleCount * 0.45) +
      (accountPromise.length >= 80 ? 4 : -4),
  );
  const activeConnScore = boundedPercent(
    conversionScore * 0.54 +
      (activeConnDelta > 0 ? 28 + Math.min(14, activeConnDelta * 4) : activeConnDelta < 0 ? -16 : 6) +
      Math.min(12, profileClickPer1k * 5),
  );
  const profileProxyScore = boundedPercent(
    Math.min(36, profileClickPer1k * 20) +
      Math.min(22, sampleCount * 1.6) +
      conversionScore * 0.32 +
      (activeConnDelta >= 0 ? 6 : -10),
  );
  const routeProofScore = boundedPercent(commandScore * 0.82 + (routeReady ? 14 : -18) + Math.min(8, missionScore * 0.08));
  const leakRepairScore = boundedPercent(leakScore * 0.82 + (primaryLeak?.status === "ok" ? 8 : primaryLeak?.status === "danger" ? -12 : 0));
  const costBoundaryScore =
    commandPacketDock?.zeroExtraXReads === true &&
    Number(commandPacketDock?.estimatedXReadOps) === 0 &&
    Number(commandPacketDock?.estimatedIncrementalXApiUsd) === 0
      ? 100
      : 0;

  const checks = [
    makeCheck({
      id: "promise_match",
      label: "PROMISE_MATCH",
      value: primaryPillar?.label || "unarmed",
      score: promiseScore,
      detail: "account memory vs cached narrative lane",
      nextAction: primaryPillar?.label
        ? `Make the next packet prove ${primaryPillar.label} inside the first line.`
        : "Select one account memory lane before routing another packet.",
    }),
    makeCheck({
      id: "active_conn",
      label: "ACTIVE_CONN",
      value: `${activeConnDelta >= 0 ? "+" : ""}${formatNumber(activeConnDelta)}`,
      score: activeConnScore,
      detail: "active conn delta from cached account snapshots",
      nextAction: activeConnDelta > 0
        ? "Keep the same promise and route lane; do not widen the topic surface yet."
        : "Route one proof packet that makes the account promise obvious before asking for attention.",
    }),
    makeCheck({
      id: "profile_proxy",
      label: "PROFILE_PROXY",
      value: `${formatNumber(profileClickPer1k, 2)}/1k`,
      score: profileProxyScore,
      detail: `${formatNumber(sampleCount)} cached packets in the conversion buffer`,
      nextAction: "Turn the first sentence into a reason to inspect the operator behind the packet.",
    }),
    makeCheck({
      id: "route_proof",
      label: "ROUTE_PROOF",
      value: routeReady ? "armed" : "repair",
      score: routeProofScore,
      detail: `${routeLabel} command dock lane`,
      nextAction: routeReady
        ? `Open ${routeLabel}, paste one useful payload, then stop at the manual gate.`
        : "Repair the command dock route before adding another standalone packet.",
    }),
    makeCheck({
      id: "leak_repair",
      label: "LEAK_REPAIR",
      value: primaryLeak?.label || "scan",
      score: leakRepairScore,
      detail: "lowest-scoring cached loop partition",
      nextAction: primaryLeak?.nextAction || "Repair the weakest cached loop partition before widening distribution.",
    }),
    makeCheck({
      id: "cost_boundary",
      label: "COST_BOUNDARY",
      value: "0 ops",
      score: costBoundaryScore,
      detail: "read partition sealed to cached telemetry",
      nextAction: "Keep identity tuning inside cached data and manual browser execution.",
    }),
  ];

  const identityScore = boundedPercent(
    checks.reduce((sum, check) => sum + check.score, 0) / Math.max(1, checks.length) +
      Math.min(7, l7Events24h / 200) +
      (routeReady ? 3 : -5),
  );
  const weakestCheck = checks.slice().sort((left, right) => left.score - right.score)[0] || null;
  const severity = weakestCheck?.status === "danger" || identityScore < 42
    ? "danger"
    : weakestCheck?.status === "warn" || identityScore < 70
      ? "warn"
      : "ok";
  const nextAction = weakestCheck?.nextAction || "Keep the identity loop armed with cached telemetry and manual route execution.";
  const copyBlock = [
    "CODEX IDENTITY CONVERSION FIREWALL",
    `Mode: zero_read_identity_conversion_firewall`,
    "Cost guard: 0 X search/read API operations",
    `Identity score: ${formatNumber(identityScore, 1)}`,
    `Account promise: ${accountPromise}`,
    `Primary lane: ${primaryPillar?.label || "-"}`,
    `Route: ${routeLabel}`,
    `Action: ${nextAction}`,
  ].join("\n");

  return {
    generatedAt: now,
    mode: "zero_read_identity_conversion_firewall",
    severity,
    source: "cached account promise + active conn proxy + route dock",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    operatorMode: "human_in_loop",
    readGate: "cached_only",
    manualOnly: true,
    identityScore: Number(identityScore.toFixed(1)),
    accountPromise,
    primaryPillarId: primaryPillar?.id || null,
    primaryPillarLabel: primaryPillar?.label || null,
    routeLabel,
    activeConnDelta,
    profileClickPer1k: Number(profileClickPer1k.toFixed(2)),
    weakestCheckId: weakestCheck?.id || null,
    weakestCheckLabel: weakestCheck?.label || null,
    nextAction,
    checks,
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "identity_score", label: "IDENTITY_SCORE", value: formatNumber(identityScore, 1), status: severity },
      { id: "promise", label: "PROMISE", value: primaryPillar?.label || "repair", status: promiseScore >= 70 ? "ok" : promiseScore >= 42 ? "warn" : "danger" },
      { id: "active_conn", label: "ACTIVE_CONN_DELTA", value: `${activeConnDelta >= 0 ? "+" : ""}${formatNumber(activeConnDelta)}`, status: activeConnDelta > 0 ? "ok" : activeConnDelta < 0 ? "danger" : "warn" },
      { id: "route", label: "ROUTE_PROOF", value: routeReady ? "armed" : "repair", status: routeReady ? "ok" : "danger" },
      { id: "weakest", label: "WEAKEST_GATE", value: weakestCheck?.label || "-", status: weakestCheck?.status || "warn" },
    ],
    profileRunbook: [
      "Lead every packet with one operator-grade rule before any recap.",
      `Keep the visible account memory aligned to ${primaryPillar?.label || "one durable tech lane"}.`,
      `Route through ${routeLabel}; stop after the manual ACK gate.`,
      "Write the outcome back through maintenance before widening the topic surface.",
    ],
    guardrails: [
      "Cached telemetry only; 0 X search/read API operations.",
      "Manual browser execution only; no automated outbound actions.",
      "Normal cooldown only; no rate-limit shortcuts.",
    ],
    copyBlock,
  };
}

function buildGrowthLoopTrace({
  trendVelocityRadar = null,
  rssSourceMesh = null,
  cachedGenerationPolicy = null,
  growthOpportunityScorer = null,
  commandPacketDock = null,
  identityConversionFirewall = null,
  learningLoopContract = null,
  learningWriteback = null,
  modelInferenceStream = null,
  growthKinetics = null,
  rateLimitGovernor = null,
  now = new Date().toISOString(),
} = {}) {
  const statusFor = (score) => score >= 70 ? "ok" : score >= 42 ? "warn" : "danger";
  const activeSource = rssSourceMesh?.activeSource || trendVelocityRadar?.selected || null;
  const sourceLabel = activeSource?.source || activeSource?.host || "cached RSS";
  const cachedSignals = Math.max(
    0,
    Number(trendVelocityRadar?.summary?.totalItems) ||
      Number(trendVelocityRadar?.items?.length) ||
      Number(rssSourceMesh?.summary?.totalItems) ||
      0,
  );
  const rssScore = boundedPercent(
    Number(activeSource?.priorityScore) ||
      Number(activeSource?.velocityScore) ||
      Number(trendVelocityRadar?.summary?.avgVelocity) ||
      0,
  );
  const policyFormats = Array.isArray(cachedGenerationPolicy?.formats)
    ? cachedGenerationPolicy.formats.length
    : Array.isArray(cachedGenerationPolicy?.selectedFormats)
      ? cachedGenerationPolicy.selectedFormats.length
      : 0;
  const inferenceTokens = Number(modelInferenceStream?.totalTokens) || Number(modelInferenceStream?.tokens) || 0;
  const inferenceCost = Number(modelInferenceStream?.estimatedUsd) || Number(modelInferenceStream?.costUsd) || 0;
  const policyScore = boundedPercent(
    Number(cachedGenerationPolicy?.policyScore) ||
      Number(cachedGenerationPolicy?.score) ||
      Number(growthOpportunityScorer?.opportunityScore) ||
      Number(growthOpportunityScorer?.score) ||
      (policyFormats ? 68 + Math.min(12, policyFormats * 2) : 46),
  );
  const packet = commandPacketDock?.primaryPacket || {};
  const payload = String(commandPacketDock?.pastePayload || packet.pastePayload || "");
  const payloadReady = Boolean(payload.trim());
  const draftScore = boundedPercent(
    Number(commandPacketDock?.commandScore) * 0.72 +
      (payloadReady ? 18 : -18) +
      Math.min(10, payload.length / 32),
  );
  const routeReady = packet.status === "ready" && Boolean(commandPacketDock?.openUrl || packet.openUrl);
  const routeScore = boundedPercent(
    Number(commandPacketDock?.commandScore) * 0.46 +
      Number(identityConversionFirewall?.identityScore) * 0.42 +
      (routeReady ? 14 : -18),
  );
  const measuredPackets = Number(learningLoopContract?.sampleCount) ||
    Number(learningWriteback?.sampleCount) ||
    Number(growthKinetics?.measuredPackets) ||
    0;
  const learnScore = boundedPercent(
    Number(learningLoopContract?.contractScore) ||
      Number(learningWriteback?.writebackScore) ||
      Number(learningWriteback?.learningScore) ||
      (measuredPackets ? 52 + Math.min(28, measuredPackets * 0.7) : 34),
  );
  const readGateClosed = rateLimitGovernor?.gates?.read === "closed";
  const cooldownActive = Boolean(rateLimitGovernor?.cooldown?.active);
  const manualGate = commandPacketDock?.operatorMode === "human_in_loop" && commandPacketDock?.manualOnly === true;

  const rawStages = [
    {
      id: "rss_ingest",
      label: "RSS_INGEST",
      subsystem: "RSS",
      score: rssScore,
      durationMs: Math.round(1200 + Math.max(0, 100 - rssScore) * 18 + cachedSignals * 4),
      input: `${formatNumber(rssSourceMesh?.summary?.totalSources || 0)} cached sources`,
      output: `${formatNumber(cachedSignals)} cached signals`,
      detail: `${sourceLabel} feeds the route loop without X read ops.`,
      nextAction: activeSource ? `Keep ${sourceLabel} hot until its cached velocity cools.` : "Wait for the next normal RSS refresh window.",
    },
    {
      id: "swarm_rank",
      label: "SWARM_RANK",
      subsystem: "AI",
      score: policyScore,
      durationMs: Math.round(1800 + Math.max(0, 100 - policyScore) * 22 + Math.min(2800, inferenceTokens / 18)),
      input: `${formatNumber(cachedSignals)} signal candidates`,
      output: `${formatNumber(Math.max(1, policyFormats))} angle lanes`,
      detail: inferenceCost > 0
        ? `Model inference stream spent $${formatNumber(inferenceCost, 3)} on cached ranking.`
        : "Cached rank policy selected the next angle lane.",
      nextAction: "Keep the winning angle lane pinned until maintenance writes new evidence.",
    },
    {
      id: "packet_draft",
      label: "PACKET_DRAFT",
      subsystem: "TXT",
      score: draftScore,
      durationMs: Math.round(900 + Math.max(0, 100 - draftScore) * 16 + Math.min(1800, payload.length * 4)),
      input: commandPacketDock?.routeLabel || packet.label || "route lane",
      output: payloadReady ? "payload armed" : "payload repair",
      detail: payloadReady ? "Operator packet is ready for manual paste." : "Payload buffer needs repair before route execution.",
      nextAction: payloadReady ? "Copy one payload and preserve the operator-grade first line." : "Repair payload before opening any route lane.",
    },
    {
      id: "manual_route",
      label: "MANUAL_ROUTE",
      subsystem: "X",
      score: routeScore,
      durationMs: Math.round(2400 + Math.max(0, 100 - routeScore) * 24 + (manualGate ? 0 : 1400)),
      input: commandPacketDock?.routeLabel || packet.label || "route lane",
      output: routeReady ? "browser route armed" : "route gate closed",
      detail: routeReady ? "Manual X web route is armed; API read partition stays sealed." : "Route gate is not ready for operator execution.",
      nextAction: routeReady
        ? commandPacketDock?.nextAction || "Open the browser route, paste once, then stop at the ACK gate."
        : "Repair route readiness before any distribution attempt.",
      readGate: "browser_only",
    },
    {
      id: "learn_writeback",
      label: "LEARN_WRITEBACK",
      subsystem: "ML",
      score: learnScore,
      durationMs: Math.round(1500 + Math.max(0, 100 - learnScore) * 20 + Math.min(2400, measuredPackets * 6)),
      input: `${formatNumber(measuredPackets)} packet samples`,
      output: "angle weights updated",
      detail: "Maintenance writes cached packet outcomes into the next angle decision.",
      nextAction: "Let maintenance refresh metrics before widening the topic surface.",
    },
  ];
  let cursorMs = 0;
  const stages = rawStages.map((stage) => {
    const durationMs = Math.max(250, Number(stage.durationMs) || 250);
    const result = {
      ...stage,
      score: Number(boundedPercent(stage.score).toFixed(1)),
      status: statusFor(stage.score),
      durationMs,
      startMs: cursorMs,
      endMs: cursorMs + durationMs,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: stage.readGate === "browser_only" ? "human_in_loop" : "cached_only",
      readGate: stage.readGate || "cached_only",
    };
    cursorMs += durationMs;
    return result;
  });
  const totalLatencyMs = stages.reduce((sum, stage) => sum + stage.durationMs, 0);
  const stagesWithPct = stages.map((stage) => ({
    ...stage,
    startPct: Number(((stage.startMs / Math.max(1, totalLatencyMs)) * 100).toFixed(2)),
    widthPct: Number(((stage.durationMs / Math.max(1, totalLatencyMs)) * 100).toFixed(2)),
  }));
  const traceScore = boundedPercent(
    stagesWithPct.reduce((sum, stage) => sum + stage.score, 0) / Math.max(1, stagesWithPct.length) +
      (manualGate ? 4 : -8) +
      (readGateClosed || cooldownActive ? -10 : 0),
  );
  const bottleneck = stagesWithPct.slice().sort((left, right) => left.score - right.score)[0] || null;
  const severity = bottleneck?.status === "danger" || traceScore < 42
    ? "danger"
    : bottleneck?.status === "warn" || traceScore < 70
      ? "warn"
      : "ok";
  const nextAction = bottleneck?.nextAction || "Keep the cached route trace armed and wait for the next maintenance writeback.";
  const edges = stagesWithPct.slice(1).map((stage, index) => {
    const previous = stagesWithPct[index];
    const edgeScore = boundedPercent((previous.score + stage.score) / 2);
    return {
      id: `${previous.id}->${stage.id}`,
      from: previous.id,
      to: stage.id,
      label: `${previous.subsystem}->${stage.subsystem}`,
      status: statusFor(edgeScore),
      score: Number(edgeScore.toFixed(1)),
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
    };
  });
  const savedReadOps = Math.max(0, stagesWithPct.length);
  const copyBlock = [
    "CODEX GROWTH LOOP TRACE",
    "Mode: zero_read_growth_loop_trace",
    "Cost guard: 0 X search/read API operations",
    `Trace score: ${formatNumber(traceScore, 1)}`,
    `Bottleneck: ${bottleneck?.label || "-"}`,
    `Latency budget: ${formatNumber(totalLatencyMs / 1000, 1)}s derived`,
    `Action: ${nextAction}`,
  ].join("\n");

  return {
    generatedAt: now,
    mode: "zero_read_growth_loop_trace",
    severity,
    source: "cached RSS + generation policy + command dock + learning contract",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    operatorMode: "human_in_loop",
    readGate: "cached_only",
    manualOnly: true,
    traceScore: Number(traceScore.toFixed(1)),
    totalLatencyMs,
    savedReadOps,
    activeSource: sourceLabel,
    bottleneckStageId: bottleneck?.id || null,
    bottleneckStageLabel: bottleneck?.label || null,
    nextAction,
    stages: stagesWithPct,
    edges,
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "trace_score", label: "TRACE_SCORE", value: formatNumber(traceScore, 1), status: severity },
      { id: "bottleneck", label: "BOTTLENECK", value: bottleneck?.label || "-", status: bottleneck?.status || "warn" },
      { id: "latency", label: "TRACE_LATENCY", value: `${formatNumber(totalLatencyMs / 1000, 1)}s`, status: totalLatencyMs <= 12000 ? "ok" : "warn" },
      { id: "saved_reads", label: "SAVED_READ_OPS", value: `${formatNumber(savedReadOps)} ops`, status: "ok" },
      { id: "manual_gate", label: "MANUAL_GATE", value: manualGate ? "armed" : "repair", status: manualGate ? "ok" : "danger" },
    ],
    guardrails: [
      "Cached telemetry only; 0 X search/read API operations.",
      "Manual browser route only; no automated outbound actions.",
      "Normal cooldown only; no rate-limit shortcuts.",
    ],
    copyBlock,
  };
}

function buildRouteFireDrill({
  routeOpportunityMatrix = null,
  commandPacketDock = null,
  identityConversionFirewall = null,
  growthLoopTrace = null,
  l7SurgeSentinel = null,
  growthKinetics = null,
  budgetBurnReactor = null,
  operatorPasteQueue = null,
  now = new Date().toISOString(),
} = {}) {
  const statusFor = (score) => score >= 72 ? "ok" : score >= 44 ? "warn" : "danger";
  const lanes = Array.isArray(routeOpportunityMatrix?.lanes) ? routeOpportunityMatrix.lanes : [];
  const readyLanes = lanes.filter((lane) => lane.ready);
  const packet = commandPacketDock?.primaryPacket || {};
  const l7Base = Math.max(
    0,
    Number(l7SurgeSentinel?.l7Events24h) ||
      Number(growthKinetics?.l7Events24h ?? growthKinetics?.impressions24h) ||
      0,
  );
  const activeConnProxy = Math.max(0.05, Number(identityConversionFirewall?.profileClickPer1k) || Number(growthKinetics?.effectiveConversionPer1k) || 0.8);
  const traceScore = Number(growthLoopTrace?.traceScore) || 0;
  const commandScore = Number(commandPacketDock?.commandScore) || 0;
  const identityScore = Number(identityConversionFirewall?.identityScore) || 0;
  const safeRemainingUsd = Number(
    budgetBurnReactor?.safeRemainingUsd ??
      budgetBurnReactor?.remainingUsd ??
      routeOpportunityMatrix?.safeRemainingUsd,
  );
  const budgetOpen = Number.isFinite(safeRemainingUsd) ? safeRemainingUsd > 0 : true;
  const baseCandidates = [
    ...readyLanes,
    ...lanes.filter((lane) => !readyLanes.some((ready) => ready.id === lane.id)),
  ];
  const fallbackLane = {
    id: packet.id || "command_packet",
    routeLabel: commandPacketDock?.routeLabel || packet.label || routeOpportunityMatrix?.topRouteLabel || "Route lane",
    label: commandPacketDock?.routeLabel || packet.label || routeOpportunityMatrix?.topRouteLabel || "Route lane",
    openUrl: commandPacketDock?.openUrl || packet.openUrl || routeOpportunityMatrix?.primaryOpenUrl || null,
    pastePayload: commandPacketDock?.pastePayload || packet.pastePayload || routeOpportunityMatrix?.primaryPastePayload || "",
    score: commandScore,
    expectedLiftPct: 0,
    targetReplies: Number(commandPacketDock?.targetOps || packet.targetOps || operatorPasteQueue?.targetReplies) || 1,
    operatorSlaMinutes: Number(commandPacketDock?.operatorSlaMinutes || packet.operatorSlaMinutes) || 10,
    confidence: "medium",
    ready: Boolean((commandPacketDock?.openUrl || packet.openUrl || routeOpportunityMatrix?.primaryOpenUrl) && (commandPacketDock?.pastePayload || packet.pastePayload || routeOpportunityMatrix?.primaryPastePayload)),
    routeReason: commandPacketDock?.nextAction || "Use the current command dock packet.",
    editRule: packet.editRule || "Edit nouns, timing, and one concrete reference only.",
    skipRule: packet.skipRule || "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
    doneSignal: packet.doneSignal || "One useful route op completed or skipped for quality.",
  };
  const candidates = baseCandidates.length ? baseCandidates : [fallbackLane];
  const scenarioDefs = [
    { id: "alpha", label: "ALPHA_FIRE", mode: "highest_score", bias: 1.16, targetBoost: 1, description: "Execute the strongest ready route first." },
    { id: "bravo", label: "BRAVO_FAST", mode: "fast_ack", bias: 1.02, targetBoost: 0, description: "Use the shortest SLA lane when the top route is stale." },
    { id: "charlie", label: "CHARLIE_REPAIR", mode: "repair_gate", bias: 0.86, targetBoost: -1, description: "Hold or repair if route quality drops below the manual gate." },
  ];
  const sortedByScore = candidates.slice().sort((left, right) => Number(right.ready) - Number(left.ready) || Number(right.score) - Number(left.score));
  const sortedBySpeed = candidates.slice().sort((left, right) => Number(right.ready) - Number(left.ready) || Number(left.operatorSlaMinutes || 99) - Number(right.operatorSlaMinutes || 99));
  const sortedByRepair = candidates.slice().sort((left, right) => Number(left.ready) - Number(right.ready) || Number(left.score) - Number(right.score));
  const pickFor = (index) =>
    index === 0 ? sortedByScore[0] || fallbackLane :
      index === 1 ? sortedBySpeed[0] || sortedByScore[1] || fallbackLane :
        sortedByRepair[0] || sortedByScore[2] || fallbackLane;
  const scenarios = scenarioDefs.map((definition, index) => {
    const lane = pickFor(index);
    const routeScore = Number(lane.score ?? lane.routeScore ?? commandScore) || 0;
    const expectedLiftPct = Math.max(0, Number(lane.expectedLiftPct) || (routeScore > 0 ? Math.max(0, routeScore - 50) / 2.4 : 0));
    const targetOps = Math.max(1, Number(lane.targetReplies) || Number(operatorPasteQueue?.targetReplies) || 1);
    const adjustedTargetOps = Math.max(1, targetOps + definition.targetBoost);
    const slaMinutes = Math.max(5, Number(lane.operatorSlaMinutes) || Number(commandPacketDock?.operatorSlaMinutes) || 10 + index * 10);
    const ready = Boolean(lane.ready && (lane.openUrl || lane.routeUrl) && (lane.pastePayload || lane.replyText || lane.draftText));
    const readinessScore = ready ? 24 : -28;
    const drillScore = boundedPercent(
      14 +
        routeScore * 0.33 +
        traceScore * 0.18 +
        identityScore * 0.16 +
        Math.min(18, expectedLiftPct * 0.72) +
        Math.max(0, 14 - slaMinutes / 4) +
        Math.min(8, adjustedTargetOps * 2) +
        readinessScore +
        (budgetOpen ? 6 : -18),
    ) * definition.bias;
    const boundedScore = boundedPercent(drillScore);
    const projectedL7Events = Math.max(0, Math.round((l7Base || 20) * (1 + expectedLiftPct / 100) + adjustedTargetOps * Math.max(2, routeScore / 12)));
    const projectedActiveConns = Number(((projectedL7Events / 1000) * activeConnProxy).toFixed(2));
    const openUrl = lane.openUrl || lane.routeUrl || null;
    const pastePayload = lane.pastePayload || lane.replyText || lane.draftText || "";
    return {
      id: definition.id,
      label: definition.label,
      mode: definition.mode,
      status: ready ? statusFor(boundedScore) : "danger",
      drillScore: Number(boundedScore.toFixed(1)),
      routeLabel: lane.routeLabel || lane.label || `Route ${index + 1}`,
      openUrl,
      pastePayload,
      targetOps: adjustedTargetOps,
      operatorSlaMinutes: slaMinutes,
      expectedLiftPct: Number(expectedLiftPct.toFixed(1)),
      projectedL7Events,
      projectedActiveConns,
      confidence: lane.confidence || "low",
      detail: definition.description,
      routeReason: lane.routeReason || lane.reason || "Use cached route evidence and inspect only one fresh exchange in browser.",
      editRule: lane.editRule || "Edit nouns, timing, and one concrete reference only.",
      skipRule: lane.skipRule || "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
      stopRule: lane.doneSignal || `Stop after ${formatNumber(adjustedTargetOps)} route op${adjustedTargetOps > 1 ? "s" : ""} or when quality drops.`,
      ready,
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "browser_only",
      manualOnly: true,
    };
  });
  const primaryScenario = scenarios.find((scenario) => scenario.ready && scenario.status === "ok") ||
    scenarios.find((scenario) => scenario.ready) ||
    scenarios[0] ||
    null;
  const drillScore = boundedPercent(
    scenarios.reduce((sum, scenario) => sum + Number(scenario.drillScore || 0), 0) / Math.max(1, scenarios.length) +
      (primaryScenario?.ready ? 4 : -10),
  );
  const severity = primaryScenario?.ready
    ? drillScore >= 72
      ? "ok"
      : drillScore >= 44
        ? "warn"
        : "danger"
    : "danger";
  const copyBlock = [
    "CODEX ROUTE FIRE DRILL",
    "Mode: zero_read_route_fire_drill",
    "Cost guard: 0 X search/read API operations",
    `Primary: ${primaryScenario?.label || "-"} · ${primaryScenario?.routeLabel || "-"}`,
    `Score: ${formatNumber(drillScore, 1)} · projected L7 ${formatNumber(primaryScenario?.projectedL7Events || 0)}`,
    "",
    primaryScenario?.openUrl ? `OPEN: ${primaryScenario.openUrl}` : "OPEN: repair route link first",
    primaryScenario?.pastePayload ? `PASTE: ${primaryScenario.pastePayload}` : "PASTE: repair payload first",
    `EDIT: ${primaryScenario?.editRule || "-"}`,
    `SKIP: ${primaryScenario?.skipRule || "-"}`,
    `STOP: ${primaryScenario?.stopRule || "-"}`,
  ].join("\n");
  return {
    generatedAt: now,
    mode: "zero_read_route_fire_drill",
    severity,
    source: "cached route matrix + command dock + growth loop trace",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    operatorMode: "human_in_loop",
    readGate: "browser_only",
    manualOnly: true,
    drillScore: Number(drillScore.toFixed(1)),
    primaryScenarioId: primaryScenario?.id || null,
    primaryRouteLabel: primaryScenario?.routeLabel || null,
    primaryOpenUrl: primaryScenario?.openUrl || null,
    primaryPastePayload: primaryScenario?.pastePayload || null,
    nextAction: primaryScenario?.ready
      ? `Run ${primaryScenario.label} on ${primaryScenario.routeLabel}, then stop at the ACK gate.`
      : "Repair route URL and payload before opening X web.",
    scenarios,
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "drill_score", label: "DRILL_SCORE", value: formatNumber(drillScore, 1), status: severity },
      { id: "primary", label: "PRIMARY_FIRE", value: primaryScenario?.label || "-", status: primaryScenario?.status || "warn" },
      { id: "projected_l7", label: "PROJECTED_L7", value: formatNumber(primaryScenario?.projectedL7Events || 0), status: primaryScenario?.ready ? "ok" : "danger" },
      { id: "active_conn", label: "ACTIVE_CONN_PROXY", value: formatNumber(primaryScenario?.projectedActiveConns || 0, 2), status: Number(primaryScenario?.projectedActiveConns || 0) > 0 ? "ok" : "warn" },
      { id: "manual_gate", label: "MANUAL_GATE", value: primaryScenario?.ready ? "armed" : "repair", status: primaryScenario?.ready ? "ok" : "danger" },
    ],
    guardrails: [
      "Cached telemetry only; 0 X search/read API operations.",
      "Manual browser execution only; no automated outbound actions.",
      "Stop at the ACK gate; no automated outbound actions.",
    ],
    copyBlock,
  };
}

function buildNarrativeResonanceController({
  insights = null,
  activeConnConversionOptimizer = null,
  audienceExpansionRouter = null,
  contentBanditAllocator = null,
  now = new Date().toISOString(),
} = {}) {
  const records = Array.isArray(insights?.records) ? insights.records : [];
  const sampleCount = records.length;
  const baseline = Number(insights?.baselineScore) || 0;
  const minSamples = Math.max(1, Number(insights?.minSamples) || 2);
  const accountPromise = optionalEnv(
    "TWEET_ACCOUNT_PROMISE",
    "Tech Signals: explain how AI, platforms, apps, cloud, security, and startups change operator leverage, defaults, distribution, and risk.",
  );
  const buckets = new Map();
  for (const definition of narrativePillarDefinitions()) {
    buckets.set(definition.id, {
      ...definition,
      samples: 0,
      totalScore: 0,
      impressions: 0,
      engagements: 0,
      examples: [],
    });
  }

  for (const record of records) {
    const pillar = primaryNarrativePillar(record);
    const bucket = buckets.get(pillar.id) || {
      ...pillar,
      samples: 0,
      totalScore: 0,
      impressions: 0,
      engagements: 0,
      examples: [],
    };
    const impressions = metricValue(record, "impression_count");
    const engagements =
      metricValue(record, "like_count") +
      metricValue(record, "retweet_count") +
      metricValue(record, "quote_count") +
      metricValue(record, "reply_count") +
      metricValue(record, "bookmark_count");
    const score = recordGrowthScore(record);
    bucket.samples += 1;
    bucket.totalScore += score;
    bucket.impressions += impressions;
    bucket.engagements += engagements;
    if (bucket.examples.length < 2) {
      bucket.examples.push({
        id: record.id || null,
        url: record.url || (record.id ? xTweetUrl(record.id) : null),
        text: String(record.text || "").replace(/\s+/g, " ").slice(0, 130),
        score: Number(score.toFixed(1)),
      });
    }
    buckets.set(pillar.id, bucket);
  }

  const connPrimaryText = `${activeConnConversionOptimizer?.primaryLane?.label || ""} ${activeConnConversionOptimizer?.nextAction || ""}`;
  const audiencePrimaryText = `${audienceExpansionRouter?.primarySegment?.label || ""} ${audienceExpansionRouter?.nextAction || ""}`;
  const banditText = `${contentBanditAllocator?.recommendedLane?.label || ""} ${contentBanditAllocator?.nextAction || ""}`;
  const totalSamples = Math.max(1, sampleCount);
  const pillars = [...buckets.values()]
    .map((bucket) => {
      const avgScore = bucket.samples ? bucket.totalScore / bucket.samples : 0;
      const share = bucket.samples / totalSamples;
      const targetShare = Number(bucket.targetShare) || 0;
      const underTarget = targetShare > 0 && share < targetShare * 0.72;
      const liftPct = baseline > 0 && bucket.samples >= minSamples ? ((avgScore - baseline) / baseline) * 100 : null;
      const engagementRate = bucket.impressions > 0 ? (bucket.engagements / bucket.impressions) * 100 : 0;
      const text = `${bucket.id} ${bucket.label} ${bucket.directive} ${(bucket.lexicon || []).join(" ")}`.toLowerCase();
      const connBoost = connPrimaryText && tokenizeTitle(connPrimaryText).some((token) => token.length > 2 && text.includes(token.toLowerCase())) ? 6 : 0;
      const audienceBoost = audiencePrimaryText && tokenizeTitle(audiencePrimaryText).some((token) => token.length > 2 && text.includes(token.toLowerCase())) ? 5 : 0;
      const banditBoost = banditText && tokenizeTitle(banditText).some((token) => token.length > 2 && text.includes(token.toLowerCase())) ? 3 : 0;
      const score = boundedPercent(
        18 +
          Math.min(30, (avgScore || baseline || 1) * 4.8) +
          Math.min(18, engagementRate * 3) +
          Math.min(14, bucket.samples * 1.8) +
          (underTarget ? 9 * (bucket.broadness || 1) : 0) +
          connBoost +
          audienceBoost +
          banditBoost,
      );
      const status = bucket.samples >= minSamples && liftPct != null && liftPct > 14
        ? "exploit"
        : underTarget
          ? "expand"
          : bucket.samples < minSamples
            ? "probe"
            : liftPct != null && liftPct < -22
              ? "hold"
              : "watch";
      return {
        id: bucket.id,
        label: bucket.label,
        status,
        score: Number(score.toFixed(1)),
        samples: bucket.samples,
        avgScore: Number(avgScore.toFixed(1)),
        liftPct: liftPct == null ? null : Number(liftPct.toFixed(1)),
        sharePct: Number((share * 100).toFixed(1)),
        targetSharePct: Number((targetShare * 100).toFixed(1)),
        impressions: bucket.impressions,
        engagementRate: Number(engagementRate.toFixed(2)),
        directive: bucket.directive,
        lexicon: bucket.lexicon || [],
        examples: bucket.examples,
        nextAction: status === "exploit"
          ? `Exploit ${bucket.label}; it already reinforces the account memory.`
          : status === "expand"
            ? `Expand ${bucket.label}; it is below target share but broad enough for follower growth.`
            : status === "probe"
              ? `Probe ${bucket.label}; collect more samples before scaling.`
              : status === "hold"
                ? `Hold ${bucket.label} unless the story fit is exceptional.`
                : `Keep ${bucket.label} in controlled rotation.`,
      };
    })
    .sort((left, right) => {
      const priority = { exploit: 4, expand: 3, probe: 2, watch: 1, hold: 0 };
      return (priority[right.status] || 0) - (priority[left.status] || 0) ||
        right.score - left.score ||
        right.samples - left.samples;
    });

  const primaryPillar = pillars.find((pillar) => pillar.status === "exploit") ||
    pillars.find((pillar) => pillar.status === "expand") ||
    pillars.find((pillar) => pillar.status === "probe") ||
    pillars[0] ||
    null;
  const resonanceScore = boundedPercent(
    16 +
      Math.min(34, Number(primaryPillar?.score) || 0) * 0.48 +
      Math.min(18, sampleCount * 0.55) +
      Math.min(14, pillars.filter((pillar) => pillar.status === "exploit").length * 6) +
      Math.min(10, pillars.filter((pillar) => pillar.status === "expand").length * 4),
  );
  const severity = resonanceScore >= 66 ? "ok" : resonanceScore >= 42 ? "warn" : "danger";
  const mode = severity === "ok" ? "narrative_exploit" : severity === "warn" ? "narrative_tune" : "narrative_starved";
  const nextAction = primaryPillar
    ? `Bias next candidate toward ${primaryPillar.label}; make it sound like ${accountPromise}`
    : "Collect more measured posts before trusting narrative routing.";
  return {
    generatedAt: now,
    mode,
    severity,
    zeroExtraXReads: true,
    source: "cached tweet analytics + account promise",
    accountPromise,
    resonanceScore: Number(resonanceScore.toFixed(1)),
    sampleCount,
    primaryPillarId: primaryPillar?.id || null,
    primaryPillar,
    pillars,
    nextAction,
    promptDirectives: [
      primaryPillar ? primaryPillar.directive : null,
      `Account promise: ${accountPromise}`,
      "Every post must reinforce one durable memory: operator leverage, platform control, consumer behavior, risk boundary, or market timing.",
      "Prefer reusable rules and tradeoffs over standalone news takes.",
    ].filter(Boolean).slice(0, 5),
    guardrails: [
      "0 X read ops; cached analytics only.",
      "Do not chase unrelated ragebait, politics, giveaways, or pure recap.",
      "A post should be recognizable as Tech Signals even without seeing the profile.",
    ],
  };
}

function buildGrowthMissionControl({
  growthGoal = null,
  growthKinetics = null,
  operatorSlo = null,
  rateLimitGovernor = null,
  budgetBurnReactor = null,
  routeAmplifier = null,
  learningWriteback = null,
  viralFlywheel = null,
  cadence = null,
  now = new Date().toISOString(),
} = {}) {
  const kineticScore = Number(growthKinetics?.score) || 0;
  const velocityScore = Number(viralFlywheel?.velocityScore) || 0;
  const routeReadiness = Number(growthKinetics?.routeReadinessPct ?? operatorSlo?.readyMissions) || 0;
  const safeRemainingUsd = Number(
    budgetBurnReactor?.safeRemainingUsd ??
      rateLimitGovernor?.budget?.safeRemainingUsd ??
      operatorSlo?.safeRemainingUsd,
  );
  const safeCapUsd = Number(budgetBurnReactor?.safeCapUsd ?? rateLimitGovernor?.budget?.safeCapUsd);
  const safeRemainingPct = Number.isFinite(safeRemainingUsd) && Number.isFinite(safeCapUsd) && safeCapUsd > 0
    ? (safeRemainingUsd / safeCapUsd) * 100
    : 100;
  const readGate = rateLimitGovernor?.gates?.read || budgetBurnReactor?.readGate || cadence?.readGate || "cached_only";
  const publishGate = rateLimitGovernor?.gates?.publish || budgetBurnReactor?.publishGate || (cadence?.publishAllowed ? "open" : "review");
  const learningSamples = Number(learningWriteback?.sampleCount ?? operatorSlo?.learningSamples ?? 0) || 0;
  const learningReady = learningSamples >= Math.max(10, Number(learningWriteback?.minSamples) || 2);
  const remainingToMilestone = Number(growthKinetics?.remainingToMilestone ?? growthGoal?.remainingToTarget) || 0;
  const projectedDays = Number(growthKinetics?.projectedDaysToMilestone);
  const budgetPenalty = safeRemainingPct <= 0 ? 24 : safeRemainingPct < 14 ? 14 : safeRemainingPct < 32 ? 7 : 0;
  const gatePenalty = readGate === "closed" || readGate === "sealed" ? 16 : publishGate === "closed" ? 12 : publishGate === "guarded" ? 6 : 0;
  const missionScore = boundedPercent(
    kineticScore * 0.42 +
      velocityScore * 0.22 +
      Math.min(100, routeReadiness) * 0.2 +
      Math.min(100, safeRemainingPct) * 0.1 +
      (learningReady ? 6 : 0) -
      budgetPenalty -
      gatePenalty,
  );
  const severity =
    safeRemainingPct <= 0 || readGate === "closed" || readGate === "sealed"
      ? "danger"
      : missionScore >= 62 && safeRemainingPct >= 22
        ? "ok"
        : "warn";
  const mode = severity === "danger"
    ? "containment"
    : missionScore >= 78
      ? "scale_loop"
      : missionScore >= 52
        ? "ignition_loop"
        : "route_repair";
  const projectedLabel = Number.isFinite(projectedDays)
    ? `${formatNumber(projectedDays, projectedDays > 30 ? 0 : 1)}d`
    : "collect samples";
  const topRoute = routeAmplifier?.lanes?.[0] || routeAmplifier?.topRoute || operatorSlo?.lanes?.[0] || null;
  const nextAction = severity === "danger"
    ? "Seal paid X partitions, keep cached telemetry online, and execute only zero-read route ops."
    : routeReadiness < 50
      ? "Arm more manual route lanes before the next standalone post."
      : routeAmplifier?.nextAction || growthKinetics?.nextAction || cadence?.nextAction || "Keep the current route loop hot and let maintenance write outcomes back.";

  return {
    generatedAt: now,
    mode,
    severity,
    zeroExtraXReads: true,
    source: "cached traffic kinetics + SLO + cost governor",
    missionScore: Number(missionScore.toFixed(1)),
    northStar: {
      label: "active conn milestone",
      current: Number(growthKinetics?.currentFollowers ?? growthGoal?.currentFollowers ?? 0) || 0,
      target: Number(growthKinetics?.nextMilestone ?? growthGoal?.nextMilestone ?? growthGoal?.targetFollowers ?? 1000) || 1000,
      remaining: remainingToMilestone,
      projectedDays: Number.isFinite(projectedDays) ? Number(projectedDays.toFixed(1)) : null,
    },
    gates: {
      read: readGate,
      publish: publishGate,
      budget: safeRemainingPct <= 0 ? "sealed" : safeRemainingPct < 22 ? "guarded" : "open",
      learning: learningReady ? "online" : "sample-starved",
    },
    nextAction,
    topRoute: topRoute
      ? {
          label: topRoute.routeLabel || topRoute.label || topRoute.id || "route lane",
          score: Number(topRoute.score ?? topRoute.efficiencyScore ?? routeAmplifier?.score ?? 0) || 0,
          expectedLiftPct: Number(topRoute.expectedLiftPct ?? routeAmplifier?.expectedLiftPct ?? operatorSlo?.expectedLiftPct ?? 0) || 0,
          status: topRoute.status || "ok",
        }
      : null,
    cells: [
      { id: "mission_score", label: "mission score", value: `${formatNumber(missionScore, 1)}%`, status: severity },
      { id: "milestone", label: "milestone runway", value: projectedLabel, status: Number.isFinite(projectedDays) && projectedDays <= 45 ? "ok" : "warn" },
      { id: "route", label: "route coverage", value: `${formatNumber(routeReadiness, 0)}%`, status: routeReadiness >= 75 ? "ok" : routeReadiness >= 35 ? "warn" : "danger" },
      { id: "budget", label: "safe cost partition", value: Number.isFinite(safeRemainingUsd) ? `$${formatNumber(safeRemainingUsd, 3)}` : "unlimited", status: safeRemainingPct > 22 ? "ok" : safeRemainingPct > 0 ? "warn" : "danger" },
      { id: "learning", label: "learning samples", value: formatNumber(learningSamples), status: learningReady ? "ok" : "warn" },
    ],
    lanes: [
      { id: "ingress", label: "ingress load", value: `${formatNumber(kineticScore, 1)}%`, status: kineticScore >= 58 ? "ok" : kineticScore >= 34 ? "warn" : "danger" },
      { id: "flywheel", label: "flywheel velocity", value: `${formatNumber(velocityScore, 1)}%`, status: velocityScore >= 58 ? "ok" : velocityScore >= 34 ? "warn" : "danger" },
      { id: "route", label: "route amplifier", value: `${formatNumber(routeReadiness, 0)}%`, status: routeReadiness >= 75 ? "ok" : routeReadiness >= 35 ? "warn" : "danger" },
      { id: "cost", label: "cost boundary", value: Number.isFinite(safeRemainingPct) ? `${formatNumber(safeRemainingPct, 0)}%` : "∞", status: safeRemainingPct > 22 ? "ok" : safeRemainingPct > 0 ? "warn" : "danger" },
    ],
    runbook: [
      "Do not auto-search, auto-like, or auto-reply.",
      "Use cached telemetry, browser route links, and manual route outputs.",
      nextAction,
    ],
  };
}

function buildAutopilotDirectiveDeck({
  learningAutopilot = null,
  adaptiveAngleScheduler = null,
  temporalAngleMatrix = null,
  learningWriteback = null,
  growthMissionControl = null,
  budgetAllocationOptimizer = null,
  hourlyLoadBalancer = null,
  cadence = null,
  rateLimitGovernor = null,
  now = new Date().toISOString(),
} = {}) {
  const activeRule = learningWriteback?.activeRule ||
    (adaptiveAngleScheduler?.nextAngles || [])[0] ||
    learningAutopilot?.primaryFormat ||
    null;
  const temporalSlot = (temporalAngleMatrix?.slots || [])[0] || hourlyLoadBalancer?.nextWindow || null;
  const holdIds = [
    ...new Set([
      ...(learningWriteback?.holdFormatIds || []),
      ...(adaptiveAngleScheduler?.scoringBias?.holdFormatIds || []),
      ...(learningAutopilot?.holdFormats || []).map((row) => row.id).filter(Boolean),
    ]),
  ];
  const rankedBudgetLanes = budgetAllocationOptimizer?.rankedLaneIds || [];
  const preferredLane =
    budgetAllocationOptimizer?.lanes?.find((lane) => lane.id === budgetAllocationOptimizer?.recommendedLaneId) ||
    budgetAllocationOptimizer?.lanes?.find((lane) => lane.id === rankedBudgetLanes[0]) ||
    budgetAllocationOptimizer?.lanes?.[0] ||
    null;
  const route = growthMissionControl?.topRoute || null;
  const readGate = rateLimitGovernor?.gates?.read ||
    cadence?.readGate ||
    learningWriteback?.cells?.find((cell) => cell.id === "read_gate")?.value ||
    "cached_only";
  const publishGate = rateLimitGovernor?.gates?.publish ||
    (cadence?.publishAllowed ? "open" : "review");
  const safeRemainingUsd = Number(
    budgetAllocationOptimizer?.safeRemainingUsd ??
      rateLimitGovernor?.budget?.safeRemainingUsd ??
      growthMissionControl?.cells?.find((cell) => cell.id === "budget")?.value,
  );
  const safeSlots = Number(preferredLane?.safeSlots ?? learningWriteback?.cells?.find((cell) => cell.id === "safe_slots")?.value);
  const missionScore = Number(growthMissionControl?.missionScore) || 0;
  const ruleScore = Number(activeRule?.weight ?? activeRule?.score ?? activeRule?.avgScore ?? 0) || 0;
  const temporalScore = Number(temporalSlot?.score ?? temporalSlot?.loadScore ?? adaptiveAngleScheduler?.nextAngles?.[0]?.weight ?? 0) || 0;
  const budgetScore = readGate === "closed" || readGate === "sealed"
    ? 0
    : Number.isFinite(safeRemainingUsd)
      ? Math.min(100, Math.max(0, safeRemainingUsd / Math.max(0.01, monthlyBudgetUsd() * budgetSafetyRatio()) * 100))
      : 70;
  const deckScore = boundedPercent(
    missionScore * 0.34 +
      ruleScore * 0.24 +
      temporalScore * 0.18 +
      budgetScore * 0.16 +
      (holdIds.length ? 2 : 8),
  );
  const severity =
    readGate === "closed" || readGate === "sealed" || (Number.isFinite(safeRemainingUsd) && safeRemainingUsd <= 0)
      ? "danger"
      : deckScore >= 70
        ? "ok"
        : deckScore >= 46
          ? "warn"
          : "danger";
  const mode = severity === "danger"
    ? "cached_containment_deck"
    : deckScore >= 76
      ? "scale_directive_deck"
      : "ignition_directive_deck";
  const ruleLabel = activeRule?.label || compactBucketName(activeRule?.formatId || activeRule?.id || "decision_rule");
  const ruleId = activeRule?.formatId || activeRule?.id || "decision_rule";
  const temporalLabel = temporalSlot?.windowLabel || temporalSlot?.label || hourlyLoadBalancer?.nextWindow?.label || "next learned window";
  const temporalAngle = temporalSlot?.formatId || temporalSlot?.angle || activeRule?.id || "decision_rule";
  const routeLabel = route?.label || preferredLane?.label || "manual route lane";
  const safeLeftLabel = Number.isFinite(safeRemainingUsd)
    ? `$${formatNumber(safeRemainingUsd, 3)}`
    : "unmetered";
  const cards = [
    {
      id: "prompt_rule",
      label: "Prompt Rule",
      command: `lead:${ruleId} action:${activeRule?.action || "test"}`,
      detail: activeRule?.reason || learningWriteback?.nextWriteback || "Use the strongest cached learning rule before any exploration.",
      status: activeRule?.action === "hold" ? "danger" : activeRule?.action === "exploit" ? "ok" : "warn",
      source: "learning.writeback",
      priority: 1,
      score: Number(ruleScore.toFixed(1)),
      xReadOps: 0,
    },
    {
      id: "temporal_slot",
      label: "UTC Fire-Control",
      command: `window:${temporalLabel} utc angle:${compactBucketName(temporalAngle)}`,
      detail: temporalSlot?.reason || temporalAngleMatrix?.nextAction || hourlyLoadBalancer?.nextAction || "Route the next output through the learned hourly load window.",
      status: temporalSlot?.status === "hot" ? "ok" : temporalSlot ? "warn" : "neutral",
      source: "temporal.matrix",
      priority: 2,
      score: Number(temporalScore.toFixed(1)),
      xReadOps: 0,
    },
    {
      id: "route_bias",
      label: "Route Bias",
      command: `route:${routeLabel} manual_only`,
      detail: growthMissionControl?.nextAction || preferredLane?.nextAction || "Manual route selection only; do not auto-reply, like, follow, or search X.",
      status: route?.status || (preferredLane?.gate === "closed" ? "danger" : route || preferredLane ? "ok" : "warn"),
      source: "mission.control",
      priority: 3,
      score: Number(Number(route?.score ?? preferredLane?.efficiencyScore ?? 0).toFixed(1)),
      xReadOps: 0,
    },
    {
      id: "budget_gate",
      label: "Budget Gate",
      command: `read_gate:${readGate} publish_gate:${publishGate}`,
      detail: `Safe left ${safeLeftLabel}; recommended lane ${preferredLane?.label || preferredLane?.id || "cached route ops"}; normal backoff only.`,
      status: readGate === "closed" || readGate === "sealed" || (Number.isFinite(safeRemainingUsd) && safeRemainingUsd <= 0)
        ? "danger"
        : Number.isFinite(safeRemainingUsd) && safeRemainingUsd < 0.75
          ? "warn"
          : "ok",
      source: "cost.governor",
      priority: 4,
      score: Number(budgetScore.toFixed(1)),
      safeSlots: Number.isFinite(safeSlots) ? safeSlots : null,
      xReadOps: 0,
    },
    {
      id: "hold_gate",
      label: "Hold Gate",
      command: `suppress:${holdIds.length ? holdIds.join(",") : "none"}`,
      detail: holdIds.length
        ? `Keep ${holdIds.join(", ")} out of default generation unless story-fit is exceptional.`
        : "No under-baseline format is currently blocked; keep exploration small.",
      status: holdIds.length ? "warn" : "ok",
      source: "learning.guardrail",
      priority: 5,
      score: holdIds.length,
      xReadOps: 0,
    },
  ];
  const directives = cards.map((card) => `[P${card.priority}] ${card.command} :: ${card.detail}`);
  const activeDirective = directives[0] || "Keep cached control loop online.";
  const copyBlock = [
    "CODEX AUTOPILOT DIRECTIVE DECK",
    `mode: ${mode}`,
    `score: ${formatNumber(deckScore, 1)}`,
    "zero_extra_x_reads: true",
    "estimated_x_read_ops: 0",
    "",
    ...directives.map((directive) => `- ${directive}`),
    "",
    "GUARDRAILS:",
    "- Human-in-loop route ops only.",
    "- No automatic replies, likes, follows, scraping, or rate-limit circumvention.",
    "- Use cached telemetry, normal backoff, and cost gates.",
  ].join("\n");

  return {
    generatedAt: now,
    mode,
    source: "cached learning writeback + temporal matrix + mission control + cost governor",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    severity,
    confidence: learningWriteback?.confidence || adaptiveAngleScheduler?.confidence || temporalAngleMatrix?.confidence || "low",
    deckScore: Number(deckScore.toFixed(1)),
    activeDirective,
    primaryRule: {
      id: ruleId,
      label: ruleLabel,
      action: activeRule?.action || "test",
    },
    gates: {
      read: readGate,
      publish: publishGate,
      budget: cards[3].status,
      route: cards[2].status,
    },
    cards,
    directives,
    copyBlock,
    runbook: [
      "Open dashboard route links manually.",
      "Paste only high-fit drafts into relevant conversations.",
      "Let the next maintenance run write outcomes back into cached learning.",
    ],
  };
}

function buildDashboardSignalMap({ state, insights, drafts, actions, usage, experimentPlan, now }) {
  const rssFeeds = Object.values(state.rssHealth?.feeds || {}).map(normalizeRssHealthEntry);
  const healthyFeeds = rssFeeds.filter((feed) => feed.totalSuccesses > 0 && !feed.consecutiveFailures).length;
  const failingFeeds = rssFeeds.filter((feed) => feed.consecutiveFailures > 0).length;
  const learnedSources = Object.keys(insights.sources || {}).filter(Boolean).length;
  const records = insights.records || [];
  const measuredPosts = records.length;
  const baselineScore = Number(insights.baselineScore) || 0;
  // Keep Ranker bestScore aligned with last7d.topPosts (Blog data-consistency contract).
  const last7dScores = recordsSince(state, 24 * 7, now).map((record) => recordGrowthScore(record));
  const bestScore = Math.max(0, baselineScore, ...last7dScores);
  const endpointTotals = usageEndpointTotals(usage);
  const apiRemaining = Math.max(0, monthlyBudgetUsd() - (Number(usage?.totalEstimatedUsd) || 0));
  const rssValue = rssFeeds.length || learnedSources;
  const routeValue = actions.length;
  const draftValue = drafts.length;
  const learnValue = measuredPosts;

  const nodes = [
    {
      id: "rss",
      label: "RSS",
      value: rssValue,
      unit: rssFeeds.length ? "feeds" : "sources",
      detail: rssFeeds.length
        ? `${healthyFeeds} healthy / ${failingFeeds} failing`
        : `${learnedSources} learned sources`,
      health: failingFeeds ? "warn" : "ok",
      x: 0.17,
      y: 0.31,
    },
    {
      id: "score",
      label: "Ranker",
      value: Number(bestScore.toFixed(1)),
      unit: "best",
      detail: `baseline ${formatNumber(baselineScore, 1)} from ${measuredPosts} measured packets`,
      health: measuredPosts >= Math.max(1, Number(insights.minSamples) || 1) ? "ok" : "warn",
      x: 0.48,
      y: 0.2,
    },
    {
      id: "draft",
      label: "Swarm Output",
      value: draftValue,
      unit: "ready",
      detail: `${draftValue} manual inference outputs queued`,
      health: draftValue ? "ok" : "warn",
      x: 0.23,
      y: 0.74,
    },
    {
      id: "x",
      label: "X_ROUTE",
      value: routeValue,
      unit: "web routes",
      detail: `${routeValue} manual web routes; 0 extra X read ops`,
      health: routeValue ? "ok" : "warn",
      x: 0.72,
      y: 0.38,
    },
    {
      id: "learn",
      label: "Learn",
      value: learnValue,
      unit: "packets",
      detail: `${experimentPlan?.budgetSafeSlots ?? 0}/${experimentPlan?.slots ?? 0} budget-safe experiment slots`,
      health: apiRemaining > 0 ? "ok" : "warn",
      x: 0.78,
      y: 0.73,
    },
  ];

  return {
    version: 1,
    generatedAt: now,
    coordinateSystem: "percent",
    source: "packet_analytics + rss_health + x_api_usage",
    core: {
      label: "CORE",
      value: Number((baselineScore || bestScore || 0).toFixed(1)),
      unit: "baseline",
      detail: `${endpointTotals.calls} X API calls, ${endpointTotals.failures} failures tracked this month`,
      x: 0.46,
      y: 0.54,
    },
    nodes,
    routes: [
      { from: "rss", to: "score", value: Math.max(1, rssValue), unit: "signals", label: "feeds ranked into topics" },
      { from: "score", to: "draft", value: Math.max(1, draftValue), unit: "outputs", label: "winning hooks become outputs" },
      { from: "score", to: "x", value: Math.max(1, routeValue), unit: "web routes", label: "ranked ideas route to X web actions" },
      { from: "draft", to: "x", value: Math.max(1, draftValue), unit: "outputs", label: "manual paste queue" },
      { from: "x", to: "learn", value: Math.max(1, measuredPosts), unit: "measured packets", label: "outcomes feed learning" },
      { from: "learn", to: "score", value: Math.max(1, experimentPlan?.budgetSafeSlots || 0), unit: "slots", label: "experiments update scoring" },
    ],
    totals: {
      rssFeeds: rssFeeds.length,
      healthyFeeds,
      failingFeeds,
      learnedSources,
      draftsReady: draftValue,
      routesReady: routeValue,
      measuredPosts,
      bestScore: Number(bestScore.toFixed(1)),
      baselineScore: Number(baselineScore.toFixed(1)),
      xApiCalls: endpointTotals.calls,
      xApiFailures: endpointTotals.failures,
      apiRemainingUsd: roundUsd(apiRemaining),
    },
  };
}

function summarizeOpenAIUsage(usage = {}) {
  const purposes = Object.entries(usage?.purposes || {})
    .sort((left, right) => (right[1].calls || 0) - (left[1].calls || 0))
    .slice(0, 10)
    .map(([name, value]) => ({
      name,
      calls: Number(value.calls) || 0,
      failures: Number(value.failures) || 0,
      inputTokens: Number(value.inputTokens) || 0,
      outputTokens: Number(value.outputTokens) || 0,
      totalTokens: Number(value.totalTokens) || 0,
      usd: roundUsd(value.estimatedUsd),
      lastStatus: value.lastStatus || null,
    }));

  return {
    month: usage?.month || currentBudgetMonth(),
    spend: roundUsd(usage?.totalEstimatedUsd),
    updatedAt: usage?.updatedAt || null,
    purposes,
    models: Object.entries(usage?.models || {})
      .sort((left, right) => (right[1].calls || 0) - (left[1].calls || 0))
      .slice(0, 5)
      .map(([name, value]) => ({
        name,
        calls: Number(value.calls) || 0,
        totalTokens: Number(value.totalTokens) || 0,
        usd: roundUsd(value.estimatedUsd),
    })),
  };
}

function buildModelInferenceStream({ openAIUsage = {}, drafts = [], now = new Date().toISOString() } = {}) {
  const purposeEntries = Object.entries(openAIUsage?.purposes || {})
    .map(([name, value]) => ({
      name,
      calls: Number(value?.calls) || 0,
      failures: Number(value?.failures) || 0,
      inputTokens: Number(value?.inputTokens) || 0,
      outputTokens: Number(value?.outputTokens) || 0,
      totalTokens: Number(value?.totalTokens) || 0,
      usd: roundUsd(value?.estimatedUsd),
      lastStatus: value?.lastStatus || null,
    }))
    .sort((left, right) => right.calls - left.calls || right.totalTokens - left.totalTokens);
  const modelEntries = Object.entries(openAIUsage?.models || {})
    .map(([name, value]) => ({
      name,
      calls: Number(value?.calls) || 0,
      failures: Number(value?.failures) || 0,
      inputTokens: Number(value?.inputTokens) || 0,
      outputTokens: Number(value?.outputTokens) || 0,
      totalTokens: Number(value?.totalTokens) || 0,
      usd: roundUsd(value?.estimatedUsd),
      lastStatus: value?.lastStatus || null,
    }))
    .sort((left, right) => right.calls - left.calls || right.totalTokens - left.totalTokens);
  const calls = purposeEntries.reduce((sum, row) => sum + row.calls, 0);
  const failures = purposeEntries.reduce((sum, row) => sum + row.failures, 0);
  const inputTokens = purposeEntries.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = purposeEntries.reduce((sum, row) => sum + row.outputTokens, 0);
  const totalTokens = purposeEntries.reduce((sum, row) => sum + row.totalTokens, 0);
  const spend = roundUsd(openAIUsage?.totalEstimatedUsd);
  const outputsReady = Array.isArray(drafts) ? drafts.filter((draft) => draft?.text).length : 0;
  const estimatedCachedTokens = (drafts || []).reduce((sum, draft) => {
    const text = `${draft?.useWhen || draft?.title || ""} ${draft?.angle || ""} ${draft?.text || ""}`;
    return sum + Math.max(24, Math.ceil(text.length / 3.8));
  }, 0);
  const tracked = calls > 0 || totalTokens > 0 || spend > 0 || modelEntries.length > 0;
  const effectiveCalls = tracked ? calls : outputsReady;
  const effectiveTokens = tracked ? totalTokens : estimatedCachedTokens;
  const successRate = effectiveCalls > 0
    ? Number((((effectiveCalls - failures) / effectiveCalls) * 100).toFixed(1))
    : 100;
  const status = failures > 0
    ? "warn"
    : outputsReady || effectiveCalls
      ? "ok"
      : "warn";
  const primaryModel = modelEntries[0] || {
    name: "cached-output-router",
    calls: outputsReady,
    totalTokens: estimatedCachedTokens,
    usd: 0,
    lastStatus: 200,
  };
  const primaryPurpose = purposeEntries[0] || {
    name: "manual_route_outputs",
    calls: outputsReady,
    failures: 0,
    totalTokens: estimatedCachedTokens,
    usd: 0,
    lastStatus: 200,
  };
  const purposeTotal = Math.max(1, purposeEntries.reduce((sum, row) => sum + row.totalTokens, 0));
  const stages = [
    {
      id: "prompt_ingress",
      label: "PROMPT_INGRESS",
      value: tracked ? inputTokens : estimatedCachedTokens,
      unit: "tok",
      status: effectiveTokens ? "ok" : "warn",
      detail: tracked ? "tracked prompt/input token load" : "estimated from cached swarm outputs",
    },
    {
      id: "model_bus",
      label: "MODEL_BUS",
      value: effectiveCalls,
      unit: "calls",
      status: failures ? "warn" : "ok",
      detail: `${primaryModel.name || "model"} · HTTP ${primaryPurpose.lastStatus || primaryModel.lastStatus || 200}`,
    },
    {
      id: "swarm_output",
      label: "SWARM_OUT",
      value: outputsReady,
      unit: "outputs",
      status: outputsReady ? "ok" : "warn",
      detail: "paste-ready manual route outputs queued",
    },
    {
      id: "operator_gate",
      label: "OPERATOR_GATE",
      value: "manual",
      unit: "human",
      status: "ok",
      detail: "outputs require manual paste; no auto-publish path",
    },
  ];

  return {
    generatedAt: now,
    mode: tracked ? "tracked_model_inference_stream" : "cached_swarm_output_stream",
    status,
    source: "openai_usage_ledger + manual_route_output_cache",
    zeroExtraOpenAICalls: true,
    zeroExtraXReads: true,
    calls: effectiveCalls,
    failures,
    inputTokens: tracked ? inputTokens : estimatedCachedTokens,
    outputTokens: tracked ? outputTokens : 0,
    totalTokens: effectiveTokens,
    spend,
    successRate,
    updatedAt: openAIUsage?.updatedAt || now,
    primaryModel,
    primaryPurpose,
    stages,
    purposeLanes: (purposeEntries.length ? purposeEntries : [primaryPurpose])
      .slice(0, 6)
      .map((row) => ({
        ...row,
        sharePct: Number(((Number(row.totalTokens) || 0) / purposeTotal * 100).toFixed(1)),
      })),
    modelLanes: (modelEntries.length ? modelEntries : [primaryModel]).slice(0, 4),
    outputSamples: (drafts || []).slice(0, 4).map((draft, index) => ({
      index: index + 1,
      title: draft?.useWhen || draft?.title || draft?.angle || "manual route output",
      angle: draft?.angle || "",
      chars: String(draft?.text || "").length,
      text: draft?.text || "",
      createdAt: draft?.createdAt || null,
    })),
    runbook: failures
      ? "Hold optional model calls, reuse cached swarm outputs, and inspect the failed purpose before regenerating."
      : "Use cached swarm outputs first; refresh model inference only when the queue is thin or stale.",
  };
}

function maxIsoTimestamp(values) {
  let best = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const ms = Date.parse(value || "");
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

function latestTweetMetricsCheckedAt(state) {
  return maxIsoTimestamp(
    (state.tweets || []).flatMap((record) => {
      const snapshots = Array.isArray(record.metricsSnapshots) ? record.metricsSnapshots : [];
      return [
        record.latestMetrics?.checkedAt,
        ...snapshots.map((snapshot) => snapshot?.checkedAt),
      ];
    }),
  );
}

function buildDashboardTelemetry({ state, usage, now }) {
  const mode = maintenanceMode() || "post";
  const cachedReason = optionalEnv("DASHBOARD_CACHED_TELEMETRY_REASON");
  const latestSnapshot = (state.accountSnapshots || [])[state.accountSnapshots.length - 1] || null;
  const accountCheckedAt = latestSnapshot?.checkedAt || null;
  const tweetMetricsCheckedAt = latestTweetMetricsCheckedAt(state);
  const checkedAt = maxIsoTimestamp([accountCheckedAt, tweetMetricsCheckedAt]);
  const checkedMs = Date.parse(checkedAt || "");

  return {
    dashboardUpdatedAt: now,
    analyticsUpdatedAt: state.updatedAt || null,
    usageUpdatedAt: usage?.updatedAt || null,
    accountCheckedAt,
    tweetMetricsCheckedAt,
    checkedAt,
    ageMinutes: Number.isFinite(checkedMs)
      ? Math.max(0, Math.round((Date.now() - checkedMs) / 60000))
      : null,
    refreshMode: mode,
    cachedOnlyRefresh: Boolean(cachedReason) || dashboardOnlyMaintenanceMode(mode),
    cachedReason: cachedReason || (dashboardOnlyMaintenanceMode(mode) ? "dashboard_only" : null),
  };
}

function buildManualReplyActions(drafts) {
  const searchLinks = manualReplySearchLinks();
  return searchLinks.slice(0, 3).map((link, index) => ({
    step: index + 1,
    label: link.label,
    url: xSearchUrl(link.query),
    reason: link.when,
    draftIndex: Math.min(index, Math.max(0, drafts.length - 1)),
  }));
}

function learningReport(insights) {
  const learning = buildLearningInsights(insights);
  const bucketLine = (bucket) =>
    bucket
      ? `${compactBucketName(bucket.name)} · avg ${formatNumber(bucket.avgScore, 1)} · n=${bucket.samples}`
      : "not enough samples yet";
  return [
    "### Learning Summary",
    "",
    `- Best hook type: ${bucketLine(learning.bestHook)}`,
    `- Weakest format: ${bucketLine(learning.worstFormat)}`,
    `- Best source: ${bucketLine(learning.bestSource)}`,
    `- Confidence: ${learning.confidence}`,
    `- Next experiment: ${learning.nextExperiment}`,
  ].join("\n");
}

function experimentPlanReport(plan) {
  if (!plan?.recommendedFormats?.length) {
    return [
      "### Experiment Allocation",
      "",
      plan?.decision || "_No post experiments allocated; keep manual route ops only._",
    ].join("\n");
  }
  return [
    "### Experiment Allocation",
    "",
    `Decision: ${plan.decision}`,
    `Budget-safe slots: ${plan.budgetSafeSlots}/${plan.slots} · Text post cost: $${formatNumber(plan.textPostCostUsd, 3)} · Safe remaining: ${plan.safeRemainingUsd == null ? "unlimited" : `$${formatNumber(plan.safeRemainingUsd, 3)}`}`,
    "",
    "| Slot | Action | Format | Avg Score | Samples | Reason |",
    "|---:|---|---|---:|---:|---|",
    ...plan.recommendedFormats.map((item) =>
      [
        `| ${item.slot}`,
        markdownCell(item.action),
        markdownCell(item.label || item.id),
        formatNumber(item.avgScore, 1),
        item.samples,
        markdownCell(item.reason || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function opportunityReport(opportunities) {
  if (!opportunities?.length) return "### Opportunity Queue\n\n_No opportunity queue available yet._";
  return [
    "### Opportunity Queue",
    "",
    "_Zero-extra-X-API queue: open the route, paste the paired draft, and prioritize the highest score._",
    "",
    "| Priority | Score | Opportunity | Route | Evidence |",
    "|---:|---:|---|---|---|",
    ...opportunities.map((item) =>
      [
        `| ${item.priority}`,
        formatNumber(item.score, 1),
        markdownCell(item.label),
        item.routeUrl ? `[${markdownCell(item.routeLabel || "Open")}](${item.routeUrl})` : markdownCell(item.routeLabel || "-"),
        markdownCell(item.evidence || item.reason || "-").slice(0, 120),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function operatorProtocolQueueReport(distributionOps, { heading = "## Operator Protocol Queue", limit = 3 } = {}) {
  const missions = Array.isArray(distributionOps?.missions) ? distributionOps.missions.slice(0, limit) : [];
  if (!missions.length) return `${heading}\n\n_No operator protocol queue available yet._`;
  const missionHeading = heading.trim().startsWith("###") ? "####" : "###";
  return [
    heading,
    "",
    "_Open the route in X web, paste manually, and spend 0 extra X search/read API calls._",
    "",
    ...missions.flatMap((mission, index) => {
      const protocol = mission.operatorProtocol || {};
      const steps = Array.isArray(protocol.steps) ? protocol.steps : [];
      const stopConditions = Array.isArray(protocol.stopConditions) ? protocol.stopConditions : [];
      return [
        `${missionHeading} ${mission.priority || index + 1}. ${mission.label || mission.routeLabel || `Route ${index + 1}`}`,
        "",
        `Score: ${formatNumber(mission.score, 1)} · Expected lift: +${formatNumber(mission.expectedLiftPct || 0, 1)}% · SLA: ${formatNumber(mission.operatorSlaMinutes || 10)}m · Target: ${formatNumber(mission.targetReplies || 1)} route op${Number(mission.targetReplies) === 1 ? "" : "s"} · X API: ${mission.costEfficiency?.label || "0 incremental X API spend"}`,
        "",
        mission.routeUrl ? `Route: [${markdownCell(mission.routeLabel || "Open X route")}](<${mission.routeUrl}>)` : "Route: _not available_",
        "",
        protocol.objective || mission.routeReason || mission.evidence || "",
        "",
        steps.length ? "Protocol:" : null,
        ...steps.map((step, stepIndex) => `${stepIndex + 1}. **${markdownCell(step.label || step.id || `step.${stepIndex + 1}`)}** - ${step.detail || ""}`),
        stopConditions.length ? "" : null,
        stopConditions.length ? "Stop conditions:" : null,
        ...stopConditions.map((condition) => `- ${condition}`),
        protocol.writeback ? "" : null,
        protocol.writeback ? `Writeback: ${protocol.writeback}` : null,
        "",
        "```txt",
        mission.draftText || "",
        "```",
        "",
      ].filter((line) => line != null);
    }),
  ].join("\n");
}

function operatorDispatchPacketReport(packet, { heading = "## Operator Dispatch Packet" } = {}) {
  if (!packet?.packets?.length) return `${heading}\n\n_No operator dispatch packet available yet._`;
  return [
    heading,
    "",
    `_Zero-extra-X-API packet: open X routes manually, paste useful route outputs, and let the next maintenance run write the learning signal back._`,
    "",
    `Mode: ${packet.mode || "-"} · Ready: ${formatNumber(packet.readyPackets)}/${formatNumber(packet.totalPackets)} · Target: ${formatNumber(packet.targetReplies)} route ops · X reads: ${formatNumber(packet.estimatedXReadOps || 0)} · Incremental X API: $${formatNumber(packet.estimatedIncrementalXApiUsd || 0, 3)}`,
    `Next action: ${packet.nextAction || "-"}`,
    "",
    "| Priority | Route | SLA | Target | Lift | Ready | Evidence |",
    "|---:|---|---:|---:|---:|---|---|",
    ...packet.packets.map((item) =>
      [
        `| ${item.priority}`,
        item.routeUrl ? `[${markdownCell(item.routeLabel || item.label || "Open route")}](<${item.routeUrl}>)` : markdownCell(item.routeLabel || item.label || "-"),
        `${formatNumber(item.operatorSlaMinutes)}m`,
        formatNumber(item.targetReplies),
        `+${formatNumber(item.expectedLiftPct || 0, 1)}%`,
        item.ready ? "yes" : "no",
        markdownCell(item.evidence || item.reason || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
    "",
    "### Copy Block",
    "",
    "```txt",
    packet.copyBlock || "",
    "```",
  ].join("\n");
}

function dailyExecutionConsoleReport(consoleData, { heading = "## Daily Execution Console" } = {}) {
  if (!consoleData?.rows?.length) return `${heading}\n\n_No daily execution console available yet._`;
  return [
    heading,
    "",
    "_Fast path: open one route, paste one useful output, stop at the target. Zero live X search/read API calls._",
    "",
    `Mode: ${consoleData.mode || "-"} · Ready: ${formatNumber(consoleData.readyRows)}/${formatNumber(consoleData.totalRows)} · Target: ${formatNumber(consoleData.targetReplies)} route ops · X reads: ${formatNumber(consoleData.estimatedXReadOps || 0)}`,
    `Primary command: ${consoleData.nextAction || "-"}`,
    "",
    "| Priority | Status | Route | SLA | Target | Lift | Paste payload |",
    "|---:|---|---|---:|---:|---:|---|",
    ...consoleData.rows.slice(0, 5).map((row) =>
      [
        `| ${row.priority}`,
        row.ready ? "ready" : "missing",
        row.routeUrl ? `[${markdownCell(row.routeLabel || "Open route")}](<${row.routeUrl}>)` : markdownCell(row.routeLabel || "-"),
        `${formatNumber(row.operatorSlaMinutes)}m`,
        formatNumber(row.targetReplies),
        `+${formatNumber(row.expectedLiftPct || 0, 1)}%`,
        markdownCell(row.replyText || "-").slice(0, 150),
      ].join(" | ") + " |",
    ),
    "",
    "Guardrails:",
    "",
    ...(consoleData.guardrails || []).map((item) => `- ${item}`),
    "",
    "### Copy Block",
    "",
    "```txt",
    consoleData.copyBlock || "",
    "```",
  ].join("\n");
}

function operatorPasteQueueReport(queue, { heading = "## Operator Paste Queue" } = {}) {
  if (!queue?.tasks?.length) return `${heading}\n\n_No operator paste queue available yet._`;
  return [
    heading,
    "",
    "_Fast path: open the route, paste the paired payload once, mark done or skip. Zero live X search/read API calls._",
    "",
    `Mode: ${queue.mode || "-"} · Ready: ${formatNumber(queue.readyTasks)}/${formatNumber(queue.totalTasks)} · Target: ${formatNumber(queue.targetReplies)} route ops · X reads: ${formatNumber(queue.estimatedXReadOps || 0)} · Incremental X API: $${formatNumber(queue.estimatedIncrementalXApiUsd || 0, 3)}`,
    `Next action: ${queue.nextAction || "-"}`,
    "",
    "| Priority | Route | SLA | Target | Ready | Paste payload | Skip rule |",
    "|---:|---|---:|---:|---|---|---|",
    ...queue.tasks.slice(0, 5).map((task) =>
      [
        `| ${task.priority}`,
        task.openUrl ? `[${markdownCell(task.routeLabel || "Open route")}](<${task.openUrl}>)` : markdownCell(task.routeLabel || "-"),
        `${formatNumber(task.operatorSlaMinutes)}m`,
        formatNumber(task.targetReplies),
        task.ready ? "yes" : "no",
        markdownCell(task.pastePayload || "-").slice(0, 150),
        markdownCell(task.skipRule || "-").slice(0, 120),
      ].join(" | ") + " |",
    ),
    "",
    "### Copy Block",
    "",
    "```txt",
    queue.copyBlock || "",
    "```",
  ].join("\n");
}

function routeOpportunityMatrixReport(matrix, { heading = "## Route Opportunity Matrix" } = {}) {
  if (!matrix?.lanes?.length) return `${heading}\n\n_No route opportunity matrix available yet._`;
  return [
    heading,
    "",
    "_Priority matrix: cached signals rank browser-only route lanes. No X search/read API calls, no automated outbound actions._",
    "",
    `Mode: ${matrix.mode || "-"} · Ready: ${formatNumber(matrix.readyLanes)}/${formatNumber(matrix.totalLanes)} · Avg score: ${formatNumber(matrix.avgScore, 1)} · X reads: ${formatNumber(matrix.estimatedXReadOps || 0)} · Incremental X API: $${formatNumber(matrix.estimatedIncrementalXApiUsd || 0, 3)}`,
    `Next action: ${matrix.nextAction || "-"}`,
    "",
    "| Rank | Score | Status | Route | SLA | Target | Lift | Payload |",
    "|---:|---:|---|---|---:|---:|---:|---|",
    ...matrix.lanes.slice(0, 6).map((lane) =>
      [
        `| ${lane.rank}`,
        formatNumber(lane.score, 1),
        markdownCell(lane.status || "-"),
        lane.openUrl ? `[${markdownCell(lane.routeLabel || "Open route")}](<${lane.openUrl}>)` : markdownCell(lane.routeLabel || "-"),
        `${formatNumber(lane.operatorSlaMinutes)}m`,
        formatNumber(lane.targetReplies),
        `+${formatNumber(lane.expectedLiftPct || 0, 1)}%`,
        markdownCell(lane.pastePayload || "-").slice(0, 150),
      ].join(" | ") + " |",
    ),
    "",
    "Guardrails:",
    "",
    ...(matrix.guardrails || []).map((item) => `- ${item}`),
    "",
    "### Copy Block",
    "",
    "```txt",
    matrix.copyBlock || "",
    "```",
  ].join("\n");
}

function routeAmplifierReport(amplifier, { heading = "## Route Amplifier" } = {}) {
  if (!amplifier?.lanes?.length) return `${heading}\n\n_No route amplifier lanes available yet._`;
  return [
    heading,
    "",
    `_Cached scoring only: ranks manual X web routes without calling X search/read APIs._`,
    "",
    `Mode: ${amplifier.mode || "-"} · Ready lanes: ${formatNumber(amplifier.readyLanes)}/${formatNumber(amplifier.totalLanes)} · Avg amplifier score: ${formatNumber(amplifier.avgScore, 1)} · X reads: 0`,
    `Next action: ${amplifier.nextAction || "-"}`,
    `Formula: ${amplifier.formula || "-"}`,
    "",
    "| Rank | Score | Route | Status | Target | SLA | Lift | Action |",
    "|---:|---:|---|---|---:|---:|---:|---|",
    ...amplifier.lanes.map((lane) =>
      [
        `| ${lane.rank}`,
        formatNumber(lane.score, 1),
        lane.routeUrl ? `[${markdownCell(lane.label)}](<${lane.routeUrl}>)` : markdownCell(lane.label),
        markdownCell(lane.status),
        formatNumber(lane.targetReplies),
        `${formatNumber(lane.operatorSlaMinutes)}m`,
        `+${formatNumber(lane.expectedLiftPct || 0, 1)}%`,
        markdownCell(lane.action || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function manualReplyTargetAtlasReport(atlas, { heading = "## Manual Reply Target Atlas" } = {}) {
  if (!atlas?.targets?.length) return `${heading}\n\n_No manual reply target atlas available yet._`;
  return [
    heading,
    "",
    `_Zero-read X web targeting: the bot ranks where to paste manually, but does not auto-search, auto-like, auto-follow, or auto-reply._`,
    "",
    `Mode: ${atlas.mode || "-"} · Ready: ${formatNumber(atlas.readyTargets)}/${formatNumber(atlas.totalTargets)} · Reply target: ${formatNumber(atlas.totalTargetReplies)} · X reads: ${formatNumber(atlas.estimatedXReadOps || 0)} · Incremental X API: $${formatNumber(atlas.estimatedIncrementalXApiUsd || 0, 3)}`,
    `Next action: ${atlas.nextAction || "-"}`,
    `Policy: ${atlas.queryPolicy || "-"}`,
    "",
    "| Rank | Score | Query class | Route | Target | SLA | Freshness | Guarded output |",
    "|---:|---:|---|---|---:|---:|---:|---|",
    ...atlas.targets.map((target) =>
      [
        `| ${target.rank}`,
        formatNumber(target.score, 1),
        markdownCell(target.queryClass || "-"),
        target.routeUrl ? `[${markdownCell(target.label || "Open route")}](<${target.routeUrl}>)` : markdownCell(target.label || "-"),
        formatNumber(target.targetReplies),
        `${formatNumber(target.operatorSlaMinutes)}m`,
        `${formatNumber(target.freshnessWindowMinutes)}m`,
        markdownCell(target.draftText || "-").slice(0, 120),
      ].join(" | ") + " |",
    ),
    "",
    "Guardrails:",
    "",
    ...(atlas.guardrails || []).map((item) => `- ${item}`),
    "",
    "### Copy Block",
    "",
    "```txt",
    atlas.copyBlock || "",
    "```",
  ].join("\n");
}

function angleMutationReactorReport(reactor, { heading = "## Angle Mutation Reactor" } = {}) {
  if (!reactor?.mutations?.length) return `${heading}\n\n_No angle mutation reactor output available yet._`;
  return [
    heading,
    "",
    `_Cached learning only: mutates the next prompt bias without calling X search/read APIs._`,
    "",
    `Mode: ${reactor.mode || "-"} · Score: ${formatNumber(reactor.mutationScore, 1)} · Confidence: ${reactor.confidence || "-"} · X reads: 0`,
    reactor.consumers?.length ? `Consumers: ${reactor.consumers.join(", ")}` : null,
    `Next bias: ${reactor.nextPromptBias || "-"}`,
    "",
    "| Mutation | Score | Status | Before | After | Evidence |",
    "|---|---:|---|---|---|---|",
    ...reactor.mutations.map((mutation) =>
      [
        `| ${markdownCell(mutation.label || mutation.id || "-")}`,
        formatNumber(mutation.score, 1),
        markdownCell(mutation.status || "-"),
        markdownCell(mutation.before || "-"),
        markdownCell(mutation.after || "-"),
        markdownCell(mutation.reason || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
    "",
    "### Prompt Patch",
    "",
    "```txt",
    reactor.promptPatch || "",
    "```",
    "",
    "Guardrails: " + (reactor.guardrails || []).join(" · "),
  ].join("\n");
}

function hookPatternReactorReport(reactor, { heading = "## Hook Pattern Reactor" } = {}) {
  if (!reactor?.patterns?.length) return `${heading}\n\n_No hook pattern reactor output available yet._`;
  return [
    heading,
    "",
    `_Cached first-line learning only: ranks hook patterns without calling X search/read APIs._`,
    "",
    `Mode: ${reactor.mode || "-"} · Recommended: ${reactor.recommendedPattern?.label || "-"} · Confidence: ${reactor.confidence || "-"} · X reads: 0`,
    `Next action: ${reactor.nextAction || "-"}`,
    "",
    "| Pattern | Status | Score | Avg | Samples | Lift | Directive |",
    "|---|---|---:|---:|---:|---:|---|",
    ...reactor.patterns.slice(0, 8).map((pattern) =>
      [
        `| ${markdownCell(pattern.label || pattern.id || "-")}`,
        markdownCell(pattern.status || "-"),
        formatNumber(pattern.score, 1),
        formatNumber(pattern.avgScore, 1),
        formatNumber(pattern.samples),
        pattern.liftPct == null ? "-" : `${formatNumber(pattern.liftPct, 1)}%`,
        markdownCell(pattern.directive || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
    "",
    "### Prompt Patch",
    "",
    "```txt",
    reactor.promptPatch || "",
    "```",
    "",
    "Guardrails: " + (reactor.guardrails || []).join(" · "),
  ].join("\n");
}

function contentBanditAllocatorReport(allocator, { heading = "## Content Bandit Allocator" } = {}) {
  if (!allocator?.lanes?.length) return `${heading}\n\n_No content bandit allocator output available yet._`;
  return [
    heading,
    "",
    `_Cached UCB-style allocator: assigns exploit/explore weight to content formats without calling X search/read APIs._`,
    "",
    `Mode: ${allocator.mode || "-"} · Primary: ${allocator.recommendedLane?.label || "-"} · Explore: ${allocator.exploreLane?.label || "-"} · Confidence: ${allocator.confidence || "-"} · X reads: 0`,
    `Next action: ${allocator.nextAction || "-"}`,
    "",
    "| Rank | Format | Status | Allocation | Avg | Samples | UCB | Lift | Action |",
    "|---:|---|---|---:|---:|---:|---:|---:|---|",
    ...allocator.lanes.slice(0, 8).map((lane) =>
      [
        `| ${formatNumber(lane.rank)}`,
        markdownCell(lane.label || lane.id || "-"),
        markdownCell(lane.status || "-"),
        `${formatNumber(lane.allocationPct, 1)}%`,
        formatNumber(lane.avgScore, 1),
        formatNumber(lane.samples),
        formatNumber(lane.uncertainty, 2),
        lane.liftPct == null ? "-" : `${formatNumber(lane.liftPct, 1)}%`,
        markdownCell(lane.nextAction || lane.reason || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
    "",
    "### Prompt Patch",
    "",
    "```txt",
    allocator.promptPatch || "",
    "```",
    "",
    "Guardrails: " + (allocator.guardrails || []).join(" · "),
  ].join("\n");
}

function contentBanditSettlementReport(settlement, { heading = "## Bandit Reward Settlement" } = {}) {
  if (!settlement?.arms?.length) return `${heading}\n\n_No bandit reward settlement output available yet._`;
  return [
    heading,
    "",
    `_Cached reward settlement: compares allocator targets with measured template rewards without calling X search/read APIs._`,
    "",
    `Mode: ${settlement.mode || "-"} · Best arm: ${settlement.bestArm?.label || "-"} · Best reward: ${formatNumber(settlement.bestReward, 1)} · Avg recent regret: ${formatNumber(settlement.avgRecentRegret, 1)} · X reads: 0`,
    `Next action: ${settlement.nextAction || "-"}`,
    "",
    "| Arm | State | Reward | Recent | Regret | Alloc | Actual | Samples | Action |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ...settlement.arms.slice(0, 8).map((arm) =>
      [
        `| ${markdownCell(arm.label || arm.id || "-")}`,
        markdownCell(arm.status || "-"),
        formatNumber(arm.avgReward, 1),
        formatNumber(arm.recentAvgReward, 1),
        formatNumber(arm.regret, 1),
        `${formatNumber(arm.allocationPct, 1)}%`,
        `${formatNumber(arm.actualSharePct, 1)}%`,
        formatNumber(arm.samples),
        markdownCell(arm.nextAction || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
    "",
    "### Recent Settlements",
    "",
    "| Time | Format | Reward | Regret | Matched | Tweet |",
    "|---|---|---:|---:|---|---|",
    ...settlement.recentSettlements.slice(0, 8).map((item) =>
      [
        `| ${markdownCell(item.postedAt || "-")}`,
        markdownCell(item.formatId || "-"),
        formatNumber(item.reward, 1),
        formatNumber(item.regret, 1),
        item.matchedPrimary === null ? "-" : item.matchedPrimary ? "yes" : "no",
        item.url ? `[${markdownCell(item.text || item.id || "tweet").slice(0, 80)}](<${item.url}>)` : markdownCell(item.text || "-").slice(0, 80),
      ].join(" | ") + " |",
    ),
    "",
    "Guardrails: " + (settlement.guardrails || []).join(" · "),
  ].join("\n");
}

function activeConnConversionOptimizerReport(optimizer, { heading = "## Active Conn Conversion Optimizer" } = {}) {
  if (!optimizer?.lanes?.length) return `${heading}\n\n_No active-conn conversion optimizer output available yet._`;
  return [
    heading,
    "",
    `_Cached conversion control: estimates which formats, audiences, and sources are most likely to convert L7 traffic into active conns. It uses existing metrics only and performs 0 extra X reads._`,
    "",
    `Mode: ${optimizer.mode || "-"} · Severity: ${optimizer.severity || "-"} · Score: ${formatNumber(optimizer.conversionScore, 1)} · X reads: ${optimizer.zeroExtraXReads ? "0" : "unknown"}`,
    `Observed conn/1k: ${formatNumber(optimizer.observedConversionPer1k, 2)} · Fallback conn/1k: ${formatNumber(optimizer.fallbackConversionPer1k, 2)} · Profile-click proxy: ${formatNumber(optimizer.profileClickPer1k, 2)}/1k · Active conn delta: ${optimizer.activeConnDelta >= 0 ? "+" : ""}${formatNumber(optimizer.activeConnDelta)}`,
    `Next action: ${optimizer.nextAction || "-"}`,
    "",
    "| Rank | Lane | Kind | Status | Score | Conn/1k | Samples | L7 Traffic | ACK % | Profile Clicks | Action |",
    "|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|",
    ...optimizer.lanes.slice(0, 9).map((lane, index) =>
      [
        `| ${index + 1}`,
        markdownCell(lane.label || lane.id || "-"),
        markdownCell(lane.kind || "-"),
        markdownCell(lane.status || "-"),
        formatNumber(lane.conversionScore, 1),
        formatNumber(lane.expectedConnPer1k, 2),
        formatNumber(lane.samples),
        formatNumber(lane.impressions),
        formatNumber(lane.engagementRate, 2),
        formatNumber(lane.profileClicks),
        markdownCell(lane.nextAction || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
    "",
    "### Prompt Directives",
    "",
    ...(optimizer.promptDirectives || []).slice(0, 4).map((item) => `- ${item}`),
    "",
    "### Gates",
    "",
    ...(optimizer.gates || []).map((gate) => `- ${gate.label}: ${gate.value} (${gate.status})`),
  ].join("\n");
}

function narrativeResonanceReport(controller, { heading = "## Narrative Resonance Controller" } = {}) {
  if (!controller?.pillars?.length) return `${heading}\n\n_No narrative resonance controller output available yet._`;
  return [
    heading,
    "",
    `_Cached account-memory controller: keeps the bot recognizable as Tech Signals by routing candidates through durable narrative pillars. It performs 0 extra X reads._`,
    "",
    `Mode: ${controller.mode || "-"} · Severity: ${controller.severity || "-"} · Resonance: ${formatNumber(controller.resonanceScore, 1)} · X reads: ${controller.zeroExtraXReads ? "0" : "unknown"}`,
    `Primary pillar: ${controller.primaryPillar?.label || "-"} · Samples: ${formatNumber(controller.sampleCount)} · Account promise: ${controller.accountPromise || "-"}`,
    `Next action: ${controller.nextAction || "-"}`,
    "",
    "| Rank | Pillar | Status | Score | Avg | Samples | Share | Target | ACK % | Action |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|---|",
    ...controller.pillars.slice(0, 8).map((pillar, index) =>
      [
        `| ${index + 1}`,
        markdownCell(pillar.label || pillar.id || "-"),
        markdownCell(pillar.status || "-"),
        formatNumber(pillar.score, 1),
        formatNumber(pillar.avgScore, 1),
        formatNumber(pillar.samples),
        `${formatNumber(pillar.sharePct, 1)}%`,
        `${formatNumber(pillar.targetSharePct, 1)}%`,
        formatNumber(pillar.engagementRate, 2),
        markdownCell(pillar.nextAction || pillar.directive || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
    "",
    "### Prompt Directives",
    "",
    ...(controller.promptDirectives || []).slice(0, 5).map((item) => `- ${item}`),
    "",
    "Guardrails: " + (controller.guardrails || []).join(" · "),
  ].join("\n");
}

function generationDecisionTraceReport(trace, { heading = "### Generation Decision Trace" } = {}) {
  if (!trace?.candidates?.length) return `${heading}\n\n_No generation decision trace recorded yet._`;
  return [
    heading,
    "",
    `_Latest candidate ranker trace. This is cached post-generation evidence and does not call X search/read APIs._`,
    "",
    `Mode: ${trace.mode || "-"} · Selected: ${trace.selectedTemplateId || "-"} · Score: ${formatNumber(trace.selectedScore, 1)} · Rank: ${trace.selectedRank || "-"} / ${formatNumber(trace.candidateCount)}`,
    trace.localFallback
      ? `Local fallback: ${trace.localFallback.used ? "used" : trace.localFallback.selected ? "selected" : "standby"} · seed=${trace.localFallback.seedEnabled ? "on" : "off"} · local=${formatNumber(trace.localFallback.candidateCount)} · ai=${formatNumber(trace.localFallback.aiCandidateCount)} · X reads=0${trace.localFallback.error ? ` · error=${trace.localFallback.error}` : ""}`
      : null,
    trace.angleMutation
      ? `Angle mutation: ${trace.angleMutation.severity || "-"} · ${formatNumber(trace.angleMutation.mutationScore, 1)} · ${trace.angleMutation.nextPromptBias || "-"}`
      : null,
    trace.hookPattern
      ? `Hook pattern: ${trace.hookPattern.recommendedPattern?.label || "-"} · ${trace.hookPattern.confidence || "-"} · ${trace.hookPattern.promptPatch || "-"}`
      : null,
    trace.contentBandit
      ? `Content bandit: ${trace.contentBandit.recommendedLane?.label || "-"} · explore ${trace.contentBandit.exploreLane?.label || "-"} · ${trace.contentBandit.confidence || "-"}`
      : null,
    trace.narrativeResonance
      ? `Narrative resonance: ${trace.narrativeResonance.primaryPillar?.label || "-"} · ${formatNumber(trace.narrativeResonance.resonanceScore, 1)} · ${trace.narrativeResonance.mode || "-"}`
      : null,
    trace.topicTimingRouter?.activeLane
      ? `Topic timing: ${trace.topicTimingRouter.activeLane.windowLabel || "-"} UTC · ${trace.topicTimingRouter.activeLane.pillarLabel || "-"} · ${trace.topicTimingRouter.activeLane.formatLabel || trace.topicTimingRouter.activeLane.formatId || "-"} · ${formatNumber(trace.topicTimingRouter.routerScore, 1)}`
      : null,
    trace.growthOpportunityScorer?.activeOpportunity
      ? `Opportunity fusion: ${trace.growthOpportunityScorer.activeOpportunity.label || "-"} · ${formatNumber(trace.growthOpportunityScorer.opportunityScore, 1)} · ${trace.growthOpportunityScorer.confidence || "-"}`
      : null,
    trace.growthStrategy
      ? `Self-evolving strategy: ${trace.growthStrategy.status || "-"} · ${trace.growthStrategy.confidence || "-"} · ${trace.growthStrategy.nextAction || "-"}`
      : null,
    "",
    "| Rank | Selected | Source | Format | Score | Strategy | Policy | Mutation | Hook | Bandit | Narrative | Timing | Opportunity | Diagnostics |",
    "|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...trace.candidates.map((candidate) =>
      [
        `| ${formatNumber(candidate.rank)}`,
        candidate.selected ? "yes" : "",
        markdownCell(candidate.generationSource || "openai"),
        markdownCell(candidate.templateId || "-"),
        formatNumber(candidate.score, 1),
        formatNumber(candidate.selfEvolvingStrategyScore, 1),
        formatNumber(candidate.cachedGenerationPolicyScore, 1),
        formatNumber(candidate.angleMutationScore, 1),
        formatNumber(candidate.hookPatternScore, 1),
        formatNumber(candidate.contentBanditScore, 1),
        formatNumber(candidate.narrativeResonanceScore, 1),
        formatNumber(candidate.topicTimingScore, 1),
        formatNumber(candidate.growthOpportunityScore, 1),
        markdownCell([...(candidate.diagnostics || []), ...(candidate.selfEvolvingStrategyDiagnostics || []), ...(candidate.angleMutationDiagnostics || []), ...(candidate.hookPatternDiagnostics || []), ...(candidate.contentBanditDiagnostics || []), ...(candidate.narrativeResonanceDiagnostics || []), ...(candidate.topicTimingDiagnostics || []), ...(candidate.growthOpportunityDiagnostics || [])].slice(0, 10).join(", ") || "-").slice(0, 180),
      ].join(" | ") + " |",
    ),
  ].filter((line) => line != null).join("\n");
}

function formatAngleMutationReactorContext(reactor) {
  if (!reactor) return "Angle mutation reactor: unavailable.";
  const mutations = (reactor.mutations || [])
    .slice(0, 4)
    .map((mutation) =>
      `${mutation.id || mutation.label}: ${mutation.before || "-"} -> ${mutation.after || "-"}; status=${mutation.status || "-"}; score=${formatNumber(mutation.score, 1)}; ${mutation.promptBias || mutation.reason || ""}`,
    );
  const cells = (reactor.cells || [])
    .slice(0, 5)
    .map((cell) => `${cell.label || cell.id}=${cell.value}(${cell.status})`)
    .join("; ");
  return [
    "Angle mutation reactor:",
    `Mode: ${reactor.mode}; severity=${reactor.severity}; confidence=${reactor.confidence}; mutation_score=${formatNumber(reactor.mutationScore, 1)}; zero_extra_x_reads=true.`,
    reactor.consumers?.length ? `Consumed by: ${reactor.consumers.join(", ")}.` : null,
    `MUST apply next prompt bias: ${reactor.nextPromptBias || "-"}`,
    cells ? `Control cells: ${cells}.` : null,
    "Mutation ledger:",
    ...mutations.map((mutation) => `- ${mutation}`),
    "Guardrails:",
    ...(reactor.guardrails || []).slice(0, 4).map((guardrail) => `- ${guardrail}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function cadenceReport(controller) {
  if (!controller) return "### Cadence Controller\n\n_No cadence decision available yet._";
  const window = controller.cadenceWindow || controller.hourlyLoad || null;
  const topicWindow = controller.topicTimingWindow || null;
  const topicLane = topicWindow?.activeLane || null;
  const bestWindows = (window?.bestHours || [])
    .slice(0, 4)
    .map((hour) => `${hour.label} UTC (${formatNumber(hour.loadScore, 1)})`)
    .join(", ");
  return [
    "### Cadence Controller",
    "",
    `Decision: ${controller.mode} · Publish allowed: ${controller.publishAllowed ? "yes" : "no"} · Enforcement: ${controller.enforcement}`,
    `Reason: ${controller.reason}`,
    `Next action: ${controller.nextAction}`,
    window ? `Learned UTC window: ${window.mode} · current ${window.currentHour?.label || "-"} (${formatNumber(window.currentHour?.loadScore, 1)}) · next ${window.nextWindow?.label || "-"}${window.nextWindow ? ` in ${formatNumber(window.nextWindow.hoursFromNow, 1)}h` : ""}` : null,
    topicWindow
      ? `Topic timing gate: ${topicWindow.mode || "-"} · trusted=${topicWindow.trusted ? "yes" : "no"} · active ${topicLane ? `${topicLane.windowLabel || utcHourLabel(topicLane.hour)} UTC / ${topicLane.pillarLabel || topicLane.pillarId || "-"} / ${topicLane.formatLabel || topicLane.formatId || "-"}` : "-"}${topicWindow.hoursFromNow == null ? "" : ` in ${formatNumber(topicWindow.hoursFromNow, 1)}h`} · X reads ${topicWindow.zeroExtraXReads ? "0" : "unknown"}`
      : null,
    bestWindows ? `Best windows: ${bestWindows}` : null,
    "",
    "| Check | State | Detail |",
    "|---|---|---|",
    ...(controller.checks || []).map((check) =>
      [
        `| ${markdownCell(check.label)}`,
        check.ok ? "OK" : "Watch",
        markdownCell(`${check.value || "-"} - ${check.detail || "-"}`),
      ].join(" | ") + " |",
    ),
  ].filter((line) => line != null).join("\n");
}

function budgetAllocationOptimizerReport(optimizer, { heading = "### Budget Allocation Optimizer" } = {}) {
  if (!optimizer?.lanes?.length) return `${heading}\n\n_No budget allocation optimizer output available yet._`;
  return [
    heading,
    "",
    `_Cached cost allocator. It ranks growth actions by safe slots, expected lift, and X read pressure without calling X search/read APIs._`,
    "",
    `Mode: ${optimizer.mode || "-"} · Recommended: ${optimizer.recommendedLaneId || "-"} · Safe left: $${formatNumber(optimizer.safeRemainingUsd, 3)} · X reads: 0`,
    `Next action: ${optimizer.recommendedAction || optimizer.runbook || "-"}`,
    "",
    "| Rank | Lane | Gate | Cost | Safe Slots | Lift | Efficiency | X Reads | Next Action |",
    "|---:|---|---|---:|---:|---:|---:|---:|---|",
    ...(optimizer.rankedLaneIds || optimizer.lanes.map((lane) => lane.id)).map((id, index) => {
      const lane = optimizer.lanes.find((item) => item.id === id) || {};
      return [
        `| ${index + 1}`,
        markdownCell(lane.label || lane.id || "-"),
        markdownCell(lane.gate || "-"),
        `$${formatNumber(lane.costUsd, 3)}`,
        lane.safeSlots == null ? "∞" : formatNumber(lane.safeSlots),
        `${formatNumber(lane.expectedLiftPct, 1)}%`,
        formatNumber(lane.efficiencyScore, 1),
        formatNumber(lane.xReadOps || 0),
        markdownCell(lane.nextAction || lane.detail || "-").slice(0, 160),
      ].join(" | ") + " |";
    }),
    "",
    `Runbook: ${optimizer.runbook || "-"}`,
  ].join("\n");
}

function autopilotDirectiveDeckReport(deck, { heading = "### Autopilot Directive Deck" } = {}) {
  if (!deck?.cards?.length) return `${heading}\n\n_No autopilot directive deck available yet._`;
  const cards = Array.isArray(deck.cards) ? deck.cards : [];
  const directives = Array.isArray(deck.directives) ? deck.directives : [];
  const runbook = Array.isArray(deck.runbook) ? deck.runbook : [];
  return [
    heading,
    "",
    `_Zero-extra-X-read operating kernel: collapses cached learning, temporal routing, mission state, and cost gates into the next manual action set._`,
    "",
    `Mode: ${deck.mode || "-"} · Score: ${formatNumber(deck.deckScore, 1)} · Severity: ${deck.severity || "-"} · Confidence: ${deck.confidence || "-"} · X reads: ${formatNumber(deck.estimatedXReadOps || 0)}`,
    `Active directive: ${deck.activeDirective || "-"}`,
    deck.primaryRule
      ? `Primary rule: ${deck.primaryRule.label || deck.primaryRule.id || "-"} (${deck.primaryRule.action || "test"})`
      : null,
    "",
    "| P | Directive | Status | Score | Source | X Reads | Detail |",
    "|---:|---|---|---:|---|---:|---|",
    ...cards.map((card) =>
      [
        `| ${formatNumber(card.priority)}`,
        markdownCell(card.command || card.label || card.id || "-"),
        markdownCell(card.status || "-"),
        formatNumber(card.score, 1),
        markdownCell(card.source || "-"),
        formatNumber(card.xReadOps || 0),
        markdownCell(card.detail || "-").slice(0, 180),
      ].join(" | ") + " |",
    ),
    "",
    directives.length ? "### Directive Copy Block" : null,
    directives.length ? "" : null,
    directives.length ? "```txt" : null,
    directives.length ? (deck.copyBlock || directives.map((item) => `- ${item}`).join("\n")) : null,
    directives.length ? "```" : null,
    runbook.length ? "" : null,
    runbook.length ? "Runbook: " + runbook.join(" · ") : null,
  ].filter((line) => line != null).join("\n");
}

function temporalAngleMatrixReport(matrix) {
  if (!matrix?.slots?.length) return "### Temporal Angle Matrix\n\n_No temporal angle matrix available yet._";
  return [
    "### Temporal Angle Matrix",
    "",
    `Mode: ${matrix.mode} · Confidence: ${matrix.confidence} · Source: ${matrix.source}`,
    "",
    matrix.nextAction,
    "",
    "| UTC Window | Format | Action | Matrix Score | L7 Load | Samples | Evidence |",
    "|---|---|---|---:|---:|---:|---|",
    ...matrix.slots.map((slot) =>
      [
        `| ${markdownCell(slot.windowLabel)}`,
        markdownCell(slot.label || slot.formatId),
        markdownCell(slot.action),
        formatNumber(slot.score, 1),
        formatNumber(slot.loadScore, 1),
        formatNumber(slot.samples),
        markdownCell(slot.reason),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function topicTimingRouterReport(router, { heading = "### Topic Timing Router" } = {}) {
  if (!router?.lanes?.length) return `${heading}\n\n_No topic timing router output available yet._`;
  return [
    heading,
    "",
    `_Cached timing fire-control: combines UTC L7 load, narrative resonance, and content bandit reward into the next topic/format window. It performs 0 extra X reads._`,
    "",
    `Mode: ${router.mode || "-"} · Severity: ${router.severity || "-"} · Score: ${formatNumber(router.routerScore, 1)} · X reads: ${router.zeroExtraXReads ? "0" : "unknown"}`,
    `Active lane: ${router.activeLane ? `${router.activeLane.windowLabel} UTC · ${router.activeLane.pillarLabel} · ${router.activeLane.formatLabel}` : "-"}`,
    `Next action: ${router.nextAction || "-"}`,
    "",
    "| Rank | UTC | Pillar | Format | Status | Score | L7 Load | Samples | Avg | ACK % | Evidence |",
    "|---:|---|---|---|---|---:|---:|---:|---:|---:|---|",
    ...router.lanes.slice(0, 10).map((lane, index) =>
      [
        `| ${index + 1}`,
        markdownCell(lane.windowLabel || "-"),
        markdownCell(lane.pillarLabel || lane.pillarId || "-"),
        markdownCell(lane.formatLabel || lane.formatId || "-"),
        markdownCell(lane.status || "-"),
        formatNumber(lane.score, 1),
        formatNumber(lane.loadScore, 1),
        formatNumber(lane.samples),
        formatNumber(lane.avgScore, 1),
        formatNumber(lane.engagementRate, 2),
        markdownCell(lane.reason || lane.directive || "-").slice(0, 150),
      ].join(" | ") + " |",
    ),
    "",
    "### Prompt Directives",
    "",
    ...(router.promptDirectives || []).slice(0, 5).map((item) => `- ${item}`),
    "",
    "Guardrails: " + (router.guardrails || []).join(" · "),
  ].join("\n");
}

function growthOpportunityScorerReport(scorer, { heading = "### Opportunity Fusion Reactor" } = {}) {
  if (!scorer?.lanes?.length) return `${heading}\n\n_No opportunity fusion output available yet._`;
  const breakdown = Array.isArray(scorer.scoreBreakdown?.sources) ? scorer.scoreBreakdown.sources.slice(0, 8) : [];
  return [
    heading,
    "",
    `_Cached opportunity fusion: combines timing, format bandit, angle load, and narrative resonance into one next-best traffic lane. It performs 0 extra X reads._`,
    "",
    `Mode: ${scorer.mode || "-"} · Severity: ${scorer.severity || "-"} · Confidence: ${scorer.confidence || "-"} · Score: ${formatNumber(scorer.opportunityScore, 1)} · X reads: ${scorer.zeroExtraXReads ? "0" : "unknown"}`,
    `Active opportunity: ${scorer.activeOpportunity?.label || "-"}`,
    `Command: ${scorer.primaryCommand || "-"}`,
    `Formula: ${scorer.scoreBreakdown?.formula || "-"}`,
    "",
    "| Rank | Opportunity | Status | Score | Format | Pillar | Sources | Samples | Evidence |",
    "|---:|---|---|---:|---|---|---|---:|---|",
    ...scorer.lanes.slice(0, 10).map((lane, index) =>
      [
        `| ${index + 1}`,
        markdownCell(lane.label || "-"),
        markdownCell(lane.status || "-"),
        formatNumber(lane.score, 1),
        markdownCell(lane.formatLabel || lane.formatId || "-"),
        markdownCell(lane.pillarLabel || lane.pillarId || "-"),
        markdownCell((lane.sources || []).join(" + ") || "-"),
        formatNumber(lane.samples),
        markdownCell((lane.evidence || []).join(" / ") || "-").slice(0, 160),
      ].join(" | ") + " |",
    ),
    "",
    "### Score Breakdown",
    "",
    breakdown.length
      ? [
          "| Source | Avg Score | Lanes | Hot | Samples |",
          "|---|---:|---:|---:|---:|",
          ...breakdown.map((source) =>
            [
              `| ${markdownCell(source.source || "-")}`,
              formatNumber(source.avgScore, 1),
              formatNumber(source.lanes),
              formatNumber(source.hotLanes),
              formatNumber(source.samples),
            ].join(" | ") + " |",
          ),
        ].join("\n")
      : "_No source breakdown yet._",
    "",
    "### Prompt Directives",
    "",
    ...(scorer.promptDirectives || []).slice(0, 6).map((item) => `- ${item}`),
    "",
    "Guardrails: " + (scorer.guardrails || []).join(" · "),
  ].join("\n");
}

function nextWindowAngleCommanderReport(commander, { heading = "### Next Window Angle Commander" } = {}) {
  if (!commander) return `${heading}\n\n_No next-window commander output available yet._`;
  const activeWindow = commander.activeWindow || {};
  const activeAngle = commander.activeAngle || {};
  const gates = Array.isArray(commander.gates) ? commander.gates : [];
  const lanes = Array.isArray(commander.lanes) ? commander.lanes : [];
  return [
    heading,
    "",
    `_Zero-read fire-control packet: turns cached learning, cadence, timing, and opportunity signals into one operator command._`,
    "",
    `Mode: ${commander.mode || "-"} · Severity: ${commander.severity || "-"} · Score: ${formatNumber(commander.commanderScore, 1)} · Publish gate: ${commander.publishGate || "-"} · X reads: ${formatNumber(commander.estimatedXReadOps || 0)}`,
    `Window: ${activeWindow.windowLabel || "-"} UTC${activeWindow.hoursFromNow == null ? "" : ` · in ${formatNumber(activeWindow.hoursFromNow, 1)}h`} · L7 load ${formatNumber(activeWindow.loadScore, 1)}`,
    `Angle: ${activeAngle.formatLabel || activeAngle.formatId || "-"} · Pillar: ${activeAngle.pillarLabel || activeAngle.pillarId || "-"}`,
    `Command: ${commander.command || "-"}`,
    commander.routeUrl ? `Manual route: ${commander.routeUrl}` : null,
    "",
    "| Gate | Status | Value | Detail |",
    "|---|---|---|---|",
    ...gates.map((gate) =>
      [
        `| ${markdownCell(gate.label || gate.id || "-")}`,
        markdownCell(gate.status || "-"),
        markdownCell(gate.value || "-"),
        markdownCell(gate.detail || "-").slice(0, 180),
      ].join(" | ") + " |",
    ),
    "",
    "| Rank | Lane | Status | Score | Source | Detail |",
    "|---:|---|---|---:|---|---|",
    ...lanes.slice(0, 6).map((lane, index) =>
      [
        `| ${index + 1}`,
        markdownCell(lane.label || lane.id || "-"),
        markdownCell(lane.status || "-"),
        formatNumber(lane.score, 1),
        markdownCell(lane.source || "-"),
        markdownCell(lane.detail || "-").slice(0, 180),
      ].join(" | ") + " |",
    ),
    "",
    "### Commander Copy Block",
    "",
    "```txt",
    commander.copyBlock || (commander.checklist || []).map((item) => `- ${item}`).join("\n"),
    "```",
    "",
    "Guardrails: " + (commander.guardrails || []).join(" · "),
  ].filter((line) => line != null).join("\n");
}

function mediaRoiGateReport(gate) {
  if (!gate) return "### Media ROI Gate\n\n_No media ROI gate data available yet._";
  const checks = (gate.checks || [])
    .map((check) => `| ${markdownCell(check.label)} | ${check.ok ? "OK" : "HOLD"} | ${markdownCell(check.value)} |`)
    .join("\n");
  return [
    "### Media ROI Gate",
    "",
    `Decision: ${gate.decision} · Attach images allowed: ${gate.attachImageAllowed ? "yes" : "no"} · Extra X reads: ${gate.zeroExtraXReads ? "0" : "unknown"}`,
    `Reason: ${gate.reason}`,
    `Next action: ${gate.nextAction}`,
    `Media avg score: ${formatNumber(gate.mediaAvgScore, 2)} (${gate.mediaSamples} samples) · Text avg score: ${formatNumber(gate.textAvgScore, 2)} (${gate.textSamples} samples)`,
    `Media lift: ${gate.mediaLiftPct === null ? "unknown" : `${formatNumber(gate.mediaLiftPct, 1)}%`} / threshold ${formatNumber(gate.minLiftPct, 1)}%`,
    `Image cost: $${formatNumber(gate.imagePostCostUsd, 3)} · Text cost: $${formatNumber(gate.textPostCostUsd, 3)} · Incremental media cost: $${formatNumber(gate.incrementalImageCostUsd, 3)}`,
    "",
    "| Check | State | Value |",
    "|---|---|---|",
    checks,
  ].join("\n");
}

function audienceExpansionReport(router) {
  if (!router?.segments?.length) return "### Audience Expansion Router\n\n_No audience router data available yet._";
  return [
    "### Audience Expansion Router",
    "",
    `Mode: ${router.mode} · Confidence: ${router.confidence} · Extra X reads: ${router.zeroExtraXReads ? "0" : "unknown"}`,
    `Next action: ${router.nextAction}`,
    "",
    "| Segment | Action | Score | Avg | Samples | Share | Lift | Reason |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    ...router.segments.slice(0, 8).map((segment) =>
      [
        `| ${markdownCell(segment.label)}`,
        markdownCell(segment.action),
        formatNumber(segment.score, 1),
        formatNumber(segment.avgScore, 1),
        formatNumber(segment.samples),
        `${formatNumber(segment.sharePct, 1)}%`,
        `${formatNumber(segment.audienceLiftPct, 1)}%`,
        markdownCell(segment.reason || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function trendVelocityRadarReport(radar) {
  if (!radar?.items?.length) return "### Trend Velocity Radar\n\n_No RSS trend velocity radar available yet._";
  const summary = radar.summary || {};
  return [
    "### Trend Velocity Radar",
    "",
    `_Zero-extra-X-API detector: ranks RSS topics by freshness, cross-source echoes, source tier, and broad tech audience fit._`,
    "",
    `Mode: ${radar.mode || "rss_velocity"} · Extra X reads: ${radar.zeroExtraXReads ? "0" : "unknown"} · Updated: ${radar.updatedAt || "-"}`,
    `Average velocity: ${formatNumber(summary.avgVelocity, 1)} · Breakout/rising topics: ${formatNumber(summary.breakoutCount)} · Next action: ${summary.nextAction || "-"}`,
    "",
    "| Rank | Stage | Velocity | Age | Echoes | Source | Audience | Topic | Route |",
    "|---:|---|---:|---:|---:|---|---|---|---|",
    ...radar.items.slice(0, 10).map((item) =>
      [
        `| ${item.rank}`,
        markdownCell(item.stage),
        formatNumber(item.velocityScore, 1),
        item.ageHours === null || item.ageHours === undefined ? "-" : `${formatNumber(item.ageHours, 1)}h`,
        formatNumber(item.echoes),
        markdownCell(item.source || "-"),
        markdownCell(item.audienceLabel || "-"),
        item.link ? `[${markdownCell(item.title).slice(0, 90)}](${item.link})` : markdownCell(item.title).slice(0, 90),
        item.routeUrl ? `[Open X](${item.routeUrl})` : "-",
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function dashboardTrendVelocityRadar(state) {
  const radar = state?.trendVelocityRadar || { updatedAt: null, items: [], summary: null };
  return {
    updatedAt: radar.updatedAt || null,
    zeroExtraXReads: radar.zeroExtraXReads !== false,
    mode: radar.mode || "rss_velocity",
    summary: radar.summary || {
      items: Array.isArray(radar.items) ? radar.items.length : 0,
      breakoutCount: 0,
      avgVelocity: 0,
      primaryStage: "idle",
      primaryTitle: null,
      primarySource: null,
      nextAction: "Wait for the next RSS refresh.",
    },
    items: Array.isArray(radar.items) ? radar.items.slice(0, 12) : [],
  };
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return String(value || "")
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./, "")
      .split(/[/?#]/)[0]
      .trim();
  }
}

function rssSourceStatus(feed = {}, trend = {}, skipAfter = 3) {
  const failures = Number(feed.consecutiveFailures) || 0;
  const successes = Number(feed.totalSuccesses) || 0;
  const statusText = String(feed.lastStatus || "").toLowerCase();
  const velocity = Number(trend.avgVelocity) || 0;
  if (failures >= skipAfter || /403|410|429|forbidden|gone|rate/.test(statusText)) return "danger";
  if (failures > 0 || (!successes && !trend.count) || Number(feed.lastItemCount) === 0) return "warn";
  if (velocity >= 70 || Number(trend.breakoutCount) > 0) return "hot";
  return successes ? "ok" : "idle";
}

function rssSourcePriorityScore(feed = {}, trend = {}, status = "idle") {
  const successes = Number(feed.totalSuccesses) || 0;
  const failures = Number(feed.consecutiveFailures) || 0;
  const itemCount = Number(feed.lastItemCount) || 0;
  const velocity = Number(trend.avgVelocity) || 0;
  const breakoutBoost = (Number(trend.breakoutCount) || 0) * 8;
  const statusPenalty = status === "danger" ? 38 : status === "warn" ? 16 : 0;
  return Number(
    boundedPercent(
      Math.min(24, successes * 2.4) +
        Math.min(16, itemCount * 1.4) +
        velocity * 0.5 +
        breakoutBoost -
        failures * 9 -
        statusPenalty,
    ).toFixed(1),
  );
}

function buildRssSourceMesh({ state, trendVelocityRadar, now = new Date().toISOString() } = {}) {
  const skipAfter = integerEnv("NEWS_RSS_SKIP_AFTER_FAILURES", 3, 1, 20);
  const feeds = Object.values(state?.rssHealth?.feeds || {}).map(normalizeRssHealthEntry);
  const radarItems = Array.isArray(trendVelocityRadar?.items) ? trendVelocityRadar.items : [];
  const trendBySource = new Map();

  for (const item of radarItems) {
    const source = item?.source || hostFromUrl(item?.link);
    if (!source) continue;
    const bucket = trendBySource.get(source) || {
      source,
      count: 0,
      breakoutCount: 0,
      velocityTotal: 0,
      top: null,
    };
    const velocity = Number(item.velocityScore) || 0;
    bucket.count += 1;
    bucket.velocityTotal += velocity;
    if (["breakout", "rising", "hot"].includes(String(item.stage || "").toLowerCase())) bucket.breakoutCount += 1;
    if (!bucket.top || velocity > Number(bucket.top.velocityScore || 0)) bucket.top = item;
    trendBySource.set(source, bucket);
  }

  const feedBySource = new Map();
  for (const feed of feeds) {
    const source = feed.source || hostFromUrl(feed.url);
    if (!source) continue;
    const current = feedBySource.get(source);
    if (!current || Number(feed.totalSuccesses || 0) + Number(feed.totalFailures || 0) > Number(current.totalSuccesses || 0) + Number(current.totalFailures || 0)) {
      feedBySource.set(source, { ...feed, source });
    }
  }

  const sourceIds = [...new Set([...feedBySource.keys(), ...trendBySource.keys()])].filter(Boolean);
  const lanes = sourceIds.map((source, index) => {
    const feed = feedBySource.get(source) || {
      source,
      url: null,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastItemCount: 0,
      lastStatus: "trend_cache_only",
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      updatedAt: trendVelocityRadar?.updatedAt || null,
    };
    const trend = trendBySource.get(source) || { source, count: 0, breakoutCount: 0, velocityTotal: 0, top: null };
    const avgVelocity = trend.count ? trend.velocityTotal / trend.count : 0;
    const normalizedTrend = { ...trend, avgVelocity };
    const status = rssSourceStatus(feed, normalizedTrend, skipAfter);
    const priorityScore = rssSourcePriorityScore(feed, normalizedTrend, status);
    const host = source || hostFromUrl(feed.url);
    const top = trend.top || {};
    return {
      id: `rss:${host || index}`,
      source: host,
      host,
      url: feed.url || top.link || null,
      sourceTier: top.sourceTier || sourceTier(host),
      status,
      healthLabel:
        status === "danger"
          ? "source cooldown"
          : status === "warn"
            ? "cache watch"
            : status === "hot"
              ? "velocity hot"
              : status === "ok"
                ? "stream healthy"
                : "cache idle",
      priorityScore,
      totalSuccesses: Number(feed.totalSuccesses) || 0,
      totalFailures: Number(feed.totalFailures) || 0,
      consecutiveFailures: Number(feed.consecutiveFailures) || 0,
      lastItemCount: Number(feed.lastItemCount) || 0,
      lastStatus: feed.lastStatus || "trend_cache_only",
      lastError: feed.lastError || null,
      lastSuccessAt: feed.lastSuccessAt || null,
      lastFailureAt: feed.lastFailureAt || null,
      updatedAt: feed.updatedAt || trendVelocityRadar?.updatedAt || null,
      trendItems: trend.count,
      breakoutCount: trend.breakoutCount,
      avgVelocity: Number(avgVelocity.toFixed(1)),
      topTitle: top.title || null,
      topLink: top.link || null,
      routeUrl: top.routeUrl || null,
      routeQuery: top.routeQuery || null,
      routeReason: top.routeReason || "Use cached RSS signal as the angle anchor; execute routes manually in X web.",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
    };
  }).sort((left, right) => (right.priorityScore || 0) - (left.priorityScore || 0)).slice(0, 12);

  const healthySources = lanes.filter((lane) => ["ok", "hot"].includes(lane.status)).length;
  const watchSources = lanes.filter((lane) => lane.status === "warn").length;
  const failingSources = lanes.filter((lane) => lane.status === "danger").length;
  const cachedTrendItems = lanes.reduce((sum, lane) => sum + (Number(lane.trendItems) || 0), 0);
  const breakoutCount = lanes.reduce((sum, lane) => sum + (Number(lane.breakoutCount) || 0), 0);
  const avgVelocity = lanes.length
    ? lanes.reduce((sum, lane) => sum + (Number(lane.avgVelocity) || 0), 0) / lanes.length
    : 0;
  const primary = lanes[0] || null;

  return {
    generatedAt: now,
    updatedAt: state?.rssHealth?.updatedAt || trendVelocityRadar?.updatedAt || null,
    mode: "zero_read_rss_source_mesh",
    source: "rss_health_cache + trend_velocity_cache",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    estimatedIncrementalXApiUsd: 0,
    readGate: "cached_only",
    skipAfterConsecutiveFailures: skipAfter,
    activeSource: primary,
    summary: {
      totalSources: lanes.length,
      healthySources,
      watchSources,
      failingSources,
      cachedTrendItems,
      breakoutCount,
      avgVelocity: Number(avgVelocity.toFixed(1)),
      primarySource: primary?.source || null,
      nextAction: failingSources
        ? "Keep cooled sources out until the next normal RSS refresh."
        : breakoutCount
          ? "Route the hottest cached RSS source through manual X web lanes."
          : "Wait for the next normal RSS refresh and keep X reads sealed.",
    },
    cells: [
      { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
      { id: "sources", label: "RSS_SOURCES", value: String(lanes.length), status: lanes.length ? "ok" : "warn" },
      { id: "velocity", label: "AVG_VELOCITY", value: formatNumber(avgVelocity, 1), status: avgVelocity >= 70 ? "hot" : avgVelocity > 0 ? "ok" : "warn" },
      { id: "cooldown", label: "COOLDOWN", value: String(failingSources), status: failingSources ? "danger" : "ok" },
    ],
    lanes,
    guardrails: [
      "Cached RSS telemetry only.",
      "No live X search/read API calls.",
      "Normal RSS refresh cadence only; no retry storms.",
      "Manual route execution stays human-in-loop.",
    ],
  };
}

const DASHBOARD_VOCABULARY_SKIP_KEYS = new Set([
  "id",
  "formatId",
  "pillarId",
  "routeUrl",
  "routeQuery",
  "url",
  "link",
  "postedAt",
  "createdAt",
  "updatedAt",
  "generatedAt",
  "checkedAt",
  "workflowEvent",
]);

function sanitizeDashboardString(value) {
  return String(value)
    .replace(/\btweet analytics\b/gi, "packet analytics")
    .replace(/\btweet metrics\b/gi, "packet telemetry")
    .replace(/\btweet\/account telemetry\b/gi, "packet/account telemetry")
    .replace(/\bfollower snapshots\b/gi, "active conn snapshots")
    .replace(/\bfollowers\b/gi, "active conns")
    .replace(/\bfollower\b/gi, "active conn")
    .replace(/\bimpressions\b/gi, "L7 traffic events")
    .replace(/\bimpression\b/gi, "L7 traffic event")
    .replace(/\bviews\b/gi, "L7 events")
    .replace(/\bview\b/gi, "L7 event")
    .replace(/\berrors\b/gi, "HTTP status triage")
    .replace(/\berror\b/gi, "HTTP status triage")
    .replace(/\btweets\b/gi, "packets")
    .replace(/\btweet\b/gi, "packet")
    .replace(/\bposting\b/gi, "dispatching")
    .replace(/\bposts\b/gi, "packets")
    .replace(/\bpost\b/gi, "packet");
}

function sanitizeDashboardVocabulary(value, key = "") {
  if (typeof value === "string") {
    if (DASHBOARD_VOCABULARY_SKIP_KEYS.has(key) || /^https?:\/\//i.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return value;
    }
    return sanitizeDashboardString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDashboardVocabulary(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeDashboardVocabulary(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function buildDashboardData({ state, insights, usage, budgetState, openAIUsage, growthStrategy = null }) {
  const now = new Date().toISOString();
  state = ensureOperatorFollowerSnapshot(state, now);
  const last24h = recordsSince(state, 24, now);
  const last7d = recordsSince(state, 24 * 7, now);
  const delta = followerDelta(state);
  const latestSnapshot = (state.accountSnapshots || [])[state.accountSnapshots.length - 1] || null;
  const latestFollowers = latestFollowerCount(state);
  const drafts = dailyReplyDrafts(state);
  const searchLinks = manualReplySearchLinks();
  const actions = buildManualReplyActions(drafts);
  const opportunities = buildDashboardOpportunities({ insights, drafts, actions, state });
  const experimentPlan = buildExperimentPlan({ insights, usage, budgetState });
  const learningAutopilot = buildLearningAutopilot(insights, { experimentPlan, now });
  const hourlyLoadBalancer = buildHourlyLoadBalancer({ state, insights, now });
  const topicTimingRouterForCadence = buildCachedTopicTimingRouterForCadence({
    state,
    insights,
    usage,
    experimentPlan,
    hourlyLoadBalancer,
    now,
  });
  const cadence = buildGrowthCadenceController({
    state,
    insights,
    usage,
    budgetState,
    experimentPlan,
    hourlyLoadBalancer,
    topicTimingRouter: topicTimingRouterForCadence,
    now,
  });
  const statusTriage = buildDashboardStatusTriage(usage);
  const cooldown = evaluateXApiCooldown(usage, new Date(now));
  const accountSnapshotCache = buildAccountSnapshotCache(state, new Date(now));
  const projectedMaintenanceReadCost = estimateMaintenanceReadCostFromState(state);
  const xApiRunwayGuard = evaluateXApiRunwayGuard({
    usage,
    budgetState,
    projectedCost: projectedMaintenanceReadCost,
    now,
  });
  const controlPlane = buildGrowthControlPlane({
    state,
    insights,
    usage,
    cadence,
    statusTriage,
    cooldown,
    experimentPlan,
    opportunities,
    drafts,
    actions,
    now,
  });
  const rateLimitGovernor = buildRateLimitGovernor({
    usage,
    budgetState,
    cadence,
    controlPlane,
    statusTriage,
    cooldown,
    runwayGuard: xApiRunwayGuard,
    accountSnapshotCache,
    now,
  });
  const distributionOps = buildDistributionOps({
    opportunities,
    actions,
    drafts,
    insights,
    cadence,
    hourlyLoadBalancer,
    controlPlane,
    now,
  });
  const operatorSlo = buildOperatorSlo({
    distributionOps,
    insights,
    usage,
    budgetState,
    cadence,
    now,
  });
  const adaptiveAngleScheduler = buildAdaptiveAngleScheduler(insights, {
    state,
    experimentPlan,
    learningAutopilot,
    distributionOps,
    usage,
    now,
  });
  const temporalAngleMatrix = buildTemporalAngleMatrix({
    state,
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    now,
  });
  const angleLoadRouter = buildAngleLoadRouter({
    temporalAngleMatrix,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    learningAutopilot,
    rateLimitGovernor,
    cadence,
    now,
  });
  const mediaRoiGate = buildMediaRoiGate({ insights, usage, budgetState, now });
  const audienceExpansionRouter = buildAudienceExpansionRouter({ insights, now });
  const trendVelocityRadar = dashboardTrendVelocityRadar(state);
  const rssSourceMesh = buildRssSourceMesh({ state, trendVelocityRadar, now });
  const viralFlywheel = buildViralFlywheel({
    state,
    insights,
    opportunities,
    drafts,
    actions,
    controlPlane,
    distributionOps,
    learningAutopilot,
    experimentPlan,
    usage,
    now,
  });
  const learningWriteback = buildLearningWriteback({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    experimentPlan,
    rateLimitGovernor,
    now,
  });
  const growthGoal = buildGrowthGoal(state);
  const growthKinetics = buildGrowthKinetics({
    state,
    insights,
    distributionOps,
    operatorSlo,
    viralFlywheel,
    growthGoal,
    now,
  });
  const budgetBurnReactor = buildBudgetBurnReactor({
    usage,
    budgetState,
    cadence,
    operatorSlo,
    mediaRoiGate,
    now,
  });
  const operatorDispatchPacket = buildOperatorDispatchPacket({
    distributionOps,
    opportunities,
    drafts,
    actions,
    operatorSlo,
    viralFlywheel,
    controlPlane,
    budgetBurnReactor,
    now,
  });
  const routeAmplifier = buildRouteAmplifier({
    operatorDispatchPacket,
    distributionOps,
    insights,
    cadence,
    viralFlywheel,
    growthKinetics,
    budgetBurnReactor,
    now,
  });
  const manualReplyTargetAtlas = buildManualReplyTargetAtlas({
    operatorDispatchPacket,
    routeAmplifier,
    distributionOps,
    now,
  });
  const budgetAllocationOptimizer = buildBudgetAllocationOptimizer({
    usage,
    budgetState,
    budgetBurnReactor,
    cadence,
    operatorSlo,
    routeAmplifier,
    growthKinetics,
    viralFlywheel,
    mediaRoiGate,
    now,
  });
  const growthMissionControl = buildGrowthMissionControl({
    growthGoal,
    growthKinetics,
    operatorSlo,
    rateLimitGovernor,
    budgetBurnReactor,
    routeAmplifier,
    learningWriteback,
    viralFlywheel,
    cadence,
    now,
  });
  const growthRunwaySimulator = buildGrowthRunwaySimulator({
    growthGoal,
    growthKinetics,
    routeAmplifier,
    budgetAllocationOptimizer,
    operatorSlo,
    viralFlywheel,
    cadence,
    learningWriteback,
    growthMissionControl,
    now,
  });
  const operatorFlightDeck = buildOperatorFlightDeck({
    distributionOps,
    operatorDispatchPacket,
    routeAmplifier,
    growthRunwaySimulator,
    growthMissionControl,
    rateLimitGovernor,
    budgetAllocationOptimizer,
    learningWriteback,
    cadence,
    now,
  });
  const autopilotDirectiveDeck = buildAutopilotDirectiveDeck({
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    learningWriteback,
    growthMissionControl,
    budgetAllocationOptimizer,
    hourlyLoadBalancer,
    cadence,
    rateLimitGovernor,
    now,
  });
  const hookPatternReactor = buildHookPatternReactor({ insights, now });
  const contentBanditAllocator = buildContentBanditAllocator({ insights, hookPatternReactor, now });
  const contentBanditSettlement = buildContentBanditSettlement({ insights, contentBanditAllocator, now });
  const activeConnConversionOptimizer = buildActiveConnConversionOptimizer({
    state,
    insights,
    growthKinetics,
    contentBanditAllocator,
    audienceExpansionRouter,
    routeAmplifier,
    now,
  });
  const narrativeResonanceController = buildNarrativeResonanceController({
    insights,
    activeConnConversionOptimizer,
    audienceExpansionRouter,
    contentBanditAllocator,
    now,
  });
  const topicTimingRouter = buildTopicTimingRouter({
    insights,
    hourlyLoadBalancer,
    temporalAngleMatrix,
    contentBanditAllocator,
    narrativeResonanceController,
    now,
  });
  const growthOpportunityScorer = buildGrowthOpportunityScorer({
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    angleLoadRouter,
    contentBanditAllocator,
    narrativeResonanceController,
    topicTimingRouter,
    rateLimitGovernor,
    cadence,
    now,
  });
  const dailyExecutionConsole = buildDailyExecutionConsole({
    operatorDispatchPacket,
    routeAmplifier,
    manualReplyTargetAtlas,
    distributionOps,
    cadence,
    growthOpportunityScorer,
    now,
  });
  const operatorPasteQueue = buildOperatorPasteQueue({
    dailyExecutionConsole,
    operatorDispatchPacket,
    manualReplyTargetAtlas,
    routeAmplifier,
    distributionOps,
    now,
  });
  const nextWindowAngleCommander = buildNextWindowAngleCommander({
    cadence,
    topicTimingRouter,
    growthOpportunityScorer,
    hourlyLoadBalancer,
    angleLoadRouter,
    adaptiveAngleScheduler,
    budgetAllocationOptimizer,
    dailyExecutionConsole,
    now,
  });
  const l7FireWindowRouter = buildL7FireWindowRouter({
    nextWindowAngleCommander,
    topicTimingRouter,
    temporalAngleMatrix,
    angleLoadRouter,
    hourlyLoadBalancer,
    growthOpportunityScorer,
    cadence,
    rateLimitGovernor,
    budgetAllocationOptimizer,
    now,
  });
  const routeOpportunityMatrix = buildRouteOpportunityMatrix({
    operatorPasteQueue,
    dailyExecutionConsole,
    operatorDispatchPacket,
    routeAmplifier,
    manualReplyTargetAtlas,
    growthOpportunityScorer,
    nextWindowAngleCommander,
    budgetAllocationOptimizer,
    rssSourceMesh,
    now,
  });
  const l7SurgeSentinel = buildL7SurgeSentinel({
    state,
    growthKinetics,
    routeOpportunityMatrix,
    rateLimitGovernor,
    budgetBurnReactor,
    trendVelocityRadar,
    hourlyLoadBalancer,
    viralFlywheel,
    now,
  });
  const growthLeakProfiler = buildGrowthLeakProfiler({
    growthKinetics,
    l7SurgeSentinel,
    activeConnConversionOptimizer,
    routeOpportunityMatrix,
    budgetAllocationOptimizer,
    growthMissionControl,
    rateLimitGovernor,
    now,
  });
  const commandPacketDock = buildCommandPacketDock({
    operatorPasteQueue,
    routeOpportunityMatrix,
    growthLeakProfiler,
    nextWindowAngleCommander,
    l7SurgeSentinel,
    activeConnConversionOptimizer,
    now,
  });
  const identityConversionFirewall = buildIdentityConversionFirewall({
    narrativeResonanceController,
    activeConnConversionOptimizer,
    growthLeakProfiler,
    commandPacketDock,
    growthMissionControl,
    growthKinetics,
    now,
  });
  const angleMutationReactor = buildAngleMutationReactor({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    learningWriteback,
    routeAmplifier,
    operatorDispatchPacket,
    now,
  });
  const selfEvolvingStrategy = growthStrategy || buildSelfEvolvingGrowthStrategy({
    state,
    insights,
    generationStack: {
      learningAutopilot,
      adaptiveAngleScheduler,
      hourlyLoadBalancer,
      temporalAngleMatrix,
      angleLoadRouter,
      learningWriteback,
      angleMutationReactor,
      hookPatternReactor,
      contentBanditAllocator,
      contentBanditSettlement,
      audienceExpansionRouter,
      activeConnConversionOptimizer,
      narrativeResonanceController,
      topicTimingRouter,
      growthOpportunityScorer,
    },
    now,
  });
  const cachedGenerationFormats = selectContentFormats({
    performanceInsights: insights,
    count: tweetCandidateCount(),
    contentBanditAllocator,
    angleLoadRouter,
    growthOpportunityScorer,
    growthStrategy: selfEvolvingStrategy,
  });
  const cachedGenerationPolicy = buildCachedGenerationPolicy({
    generationStack: {
      learningAutopilot,
      adaptiveAngleScheduler,
      hourlyLoadBalancer,
      temporalAngleMatrix,
      angleLoadRouter,
      learningWriteback,
      angleMutationReactor,
      hookPatternReactor,
      contentBanditAllocator,
      contentBanditSettlement,
      audienceExpansionRouter,
      activeConnConversionOptimizer,
      narrativeResonanceController,
      topicTimingRouter,
      growthOpportunityScorer,
    },
    contentFormats: cachedGenerationFormats,
    story: trendVelocityRadar.items?.[0] || null,
    growthStrategy: selfEvolvingStrategy,
    now,
  });
  const latestGenerationDecisionTrace =
    (state.tweets || []).find((record) => record?.generationDecisionTrace)?.generationDecisionTrace || null;
  const learningLoopContract = buildLearningLoopContract({
    insights,
    learningAutopilot,
    contentBanditAllocator,
    contentBanditSettlement,
    growthOpportunityScorer,
    cachedGenerationPolicy,
    generationDecisionTrace: latestGenerationDecisionTrace,
    now,
  });
  const openAISummary = summarizeOpenAIUsage(openAIUsage);
  const modelInferenceStream = buildModelInferenceStream({ openAIUsage, drafts, now });
  const growthLoopTrace = buildGrowthLoopTrace({
    trendVelocityRadar,
    rssSourceMesh,
    cachedGenerationPolicy,
    growthOpportunityScorer,
    commandPacketDock,
    identityConversionFirewall,
    learningLoopContract,
    learningWriteback,
    modelInferenceStream,
    growthKinetics,
    rateLimitGovernor,
    now,
  });
  const routeFireDrill = buildRouteFireDrill({
    routeOpportunityMatrix,
    commandPacketDock,
    identityConversionFirewall,
    growthLoopTrace,
    l7SurgeSentinel,
    growthKinetics,
    budgetBurnReactor,
    operatorPasteQueue,
    now,
  });
  const languageTracks = buildLanguageTracks(state, insights, now);
  const growthDecision = buildGrowthDecision({
    state,
    insights,
    usage,
    budgetState,
    languageTracks,
    cadence,
    opportunities,
    experimentPlan,
    now,
  });
  const apiCap = monthlyBudgetUsd();
  const apiSpend = Math.max(
    Number(usage?.totalEstimatedUsd) || 0,
    Number(budgetState?.spentUsd) || 0,
  );
  const creditsCircuit = evaluateXCreditsCircuit(usage, new Date(now));
  const creditsDepleted =
    Boolean(creditsCircuit.active) ||
    (Boolean(cooldown?.active) && cooldown?.reasonCode === "credits_depleted");
  const estimatedRemaining = Math.max(0, apiCap - apiSpend);
  const estimatedSafeRemaining = Math.max(0, apiCap * budgetSafetyRatio() - apiSpend);
  const availableRemaining = creditsDepleted ? 0 : estimatedRemaining;
  const availableSafeRemaining = creditsDepleted ? 0 : estimatedSafeRemaining;

  const dashboardData = {
    version: 1,
    updatedAt: now,
    telemetry: buildDashboardTelemetry({ state, usage, now }),
    mode: {
      label: "Zero extra X API",
      description: "Web search links + manual route outputs.",
    },
    languageTracks,
    growthDecision,
    growthStrategy: selfEvolvingStrategy,
    profile: {
      followers: Number.isFinite(latestFollowers) ? latestFollowers : null,
      followerDelta: delta?.delta ?? null,
      followerCheckedAt: delta?.latestAt || latestSnapshot?.checkedAt || null,
      trackedPosts: (state.tweets || []).length,
      measuredPosts: insights.records.length,
      baselineScore: Number(insights.baselineScore.toFixed(1)),
    },
    growthGoal,
    growthKinetics,
    growthMissionControl,
    growthRunwaySimulator,
    autopilotDirectiveDeck,
    last24h: dashboardPeriodStats(last24h),
    last7d: dashboardPeriodStats(last7d),
    charts: buildDashboardCharts({ last24h, last7d, usage, now }),
    automation: buildDashboardAutomation({ drafts, actions, usage, budgetState, mediaRoiGate }),
    cadence,
    controlPlane,
    rateLimitGovernor,
    xApiRunwayGuard,
    accountSnapshotCache,
    budgetBurnReactor,
    budgetAllocationOptimizer,
    operatorDispatchPacket,
    dailyExecutionConsole,
    operatorPasteQueue,
    routeOpportunityMatrix,
    l7SurgeSentinel,
    growthLeakProfiler,
    commandPacketDock,
    identityConversionFirewall,
    growthLoopTrace,
    routeFireDrill,
    nextWindowAngleCommander,
    l7FireWindowRouter,
    operatorFlightDeck,
    routeAmplifier,
    manualReplyTargetAtlas,
    hookPatternReactor,
    contentBanditAllocator,
    contentBanditSettlement,
    activeConnConversionOptimizer,
    narrativeResonanceController,
    topicTimingRouter,
    growthOpportunityScorer,
    cachedGenerationPolicy,
    angleMutationReactor,
    generationDecisionTrace: latestGenerationDecisionTrace,
    distributionOps,
    operatorSlo,
    viralFlywheel,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    angleLoadRouter,
    learningWriteback,
    mediaRoiGate,
    audienceExpansionRouter,
    trendVelocityRadar,
    rssSourceMesh,
    hourlyLoadBalancer,
    signalMap: buildDashboardSignalMap({ state, insights, drafts, actions, usage, experimentPlan, now }),
    opportunities,
    actions,
    searchLinks: searchLinks.map((link) => ({
      label: link.label,
      url: xSearchUrl(link.query),
      reason: link.when,
    })),
    drafts: drafts.map((draft) => ({
      title: draft.useWhen || draft.angle || "Relevant tech post",
      text: draft.text,
      angle: draft.angle || "",
      createdAt: draft.createdAt || null,
    })),
    performance: {
      templates: topDashboardBuckets(insights.templates, insights),
      sources: topDashboardBuckets(insights.sources, insights),
      hashtags: topDashboardBuckets(insights.tags, insights, 8),
    },
    learning: buildLearningInsights(insights),
    learningAutopilot,
    learningLoopContract,
    modelInferenceStream,
    experimentPlan,
    diagnosis: [
      growthDecision.today?.summary || "Today: use cached growth telemetry to choose the next route.",
      "主贴质量不算差，但小账号阶段缺少初始互动，单独发帖很难被系统分发。",
      `最近 7 天记录到 ${last7d.length} 条、${sumTweetMetric(last7d, "impression_count")} 次触达；24 小时 ${last24h.length} 条、${sumTweetMetric(last24h, "impression_count")} 次触达。瓶颈是分发入口，不是发帖数量。`,
      "当前低成本路线是人工点网页搜索、复制输出，避免增加 X search/read API。",
      "路由操作优先贴在 2 小时内仍有讨论的大号帖子下面；主贴负责让主页可信。",
    ],
    api: {
      month: usage?.month || currentBudgetMonth(),
      spend: roundUsd(apiSpend),
      cap: apiCap,
      safeCap: roundUsd(apiCap * budgetSafetyRatio()),
      // `remaining` is what operators can still spend. When X returns credits
      // depleted, force $0 even if the local estimated ledger still has headroom.
      remaining: roundUsd(availableRemaining),
      safeRemaining: roundUsd(availableSafeRemaining),
      estimatedRemaining: roundUsd(estimatedRemaining),
      estimatedSafeRemaining: roundUsd(estimatedSafeRemaining),
      creditsDepleted,
      ledgerSource: "local_estimated_usage",
      ledgerNote: creditsDepleted
        ? "X credits depleted; available remaining forced to $0. Spend/cap below are the local estimated ledger, not the X console balance."
        : "Spend/cap/remaining come from the local estimated ledger, not the live X billing console.",
      creditsCircuit: {
        active: Boolean(creditsCircuit.active),
        endpoint: creditsCircuit.endpoint || null,
        status: creditsCircuit.status || null,
        since: creditsCircuit.since || null,
        until: creditsCircuit.until || null,
        remainingHours: creditsCircuit.remainingHours || 0,
        reason: creditsCircuit.reason || null,
      },
      statusTriage,
      cooldown,
      days: xApiDailySeries(usage, integerEnv("DASHBOARD_API_SERIES_DAYS", 14, 7, 31)),
      endpoints: Object.entries(usage?.endpoints || {})
        .sort((left, right) => right[1].calls - left[1].calls)
        .slice(0, 10)
        .map(([name, value]) => ({
          name,
          calls: value.calls || 0,
          failures: value.failures || 0,
          usd: Number((value.estimatedUsd || 0).toFixed(3)),
          lastStatus: value.lastStatus || null,
          statuses: endpointStatusCounts(value),
        })),
    },
    openai: openAISummary,
  };
  return sanitizeDashboardVocabulary(dashboardData);
}

function buildDailyReplyReport({ state, usage, budgetState }) {
  const now = new Date().toISOString();
  const insights = deriveAnalyticsInsights(state);
  const drafts = dailyReplyDrafts(state);
  const actions = buildManualReplyActions(drafts);
  const opportunities = buildDashboardOpportunities({ state, insights, drafts, actions });
  const experimentPlan = buildExperimentPlan({ state, insights, usage, budgetState });
  const hourlyLoadBalancer = buildHourlyLoadBalancer({ state, insights });
  const topicTimingRouterForCadence = buildCachedTopicTimingRouterForCadence({
    state,
    insights,
    usage,
    experimentPlan,
    hourlyLoadBalancer,
    now,
  });
  const cadence = buildGrowthCadenceController({
    state,
    insights,
    usage,
    budgetState,
    experimentPlan,
    hourlyLoadBalancer,
    topicTimingRouter: topicTimingRouterForCadence,
    now,
  });
  const distributionOps = buildDistributionOps({ opportunities, actions, drafts, insights, cadence, now });
  const learningAutopilot = buildLearningAutopilot(insights, { experimentPlan, now });
  const adaptiveAngleScheduler = buildAdaptiveAngleScheduler(insights, {
    state,
    experimentPlan,
    learningAutopilot,
    distributionOps,
    usage,
    now,
  });
  const temporalAngleMatrix = buildTemporalAngleMatrix({
    state,
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    now,
  });
  const learningWriteback = buildLearningWriteback({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    experimentPlan,
    now,
  });
  const operatorDispatchPacket = buildOperatorDispatchPacket({
    distributionOps,
    opportunities,
    drafts,
    actions,
    now,
  });
  const routeAmplifier = buildRouteAmplifier({
    operatorDispatchPacket,
    distributionOps,
    insights,
    cadence,
    now,
  });
  const manualReplyTargetAtlas = buildManualReplyTargetAtlas({
    operatorDispatchPacket,
    routeAmplifier,
    distributionOps,
    now,
  });
  const budgetBurnReactor = buildBudgetBurnReactor({
    usage,
    budgetState,
    cadence,
    operatorSlo: null,
    mediaRoiGate: null,
    now,
  });
  const budgetAllocationOptimizer = buildBudgetAllocationOptimizer({
    usage,
    budgetState,
    budgetBurnReactor,
    cadence,
    operatorSlo: null,
    routeAmplifier,
    growthKinetics: null,
    viralFlywheel: null,
    mediaRoiGate: null,
    now,
  });
  const autopilotDirectiveDeck = buildAutopilotDirectiveDeck({
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    learningWriteback,
    budgetAllocationOptimizer,
    hourlyLoadBalancer,
    cadence,
    now,
  });
  const angleMutationReactor = buildAngleMutationReactor({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    learningWriteback,
    routeAmplifier,
    operatorDispatchPacket,
    now,
  });
  const hookPatternReactor = buildHookPatternReactor({ insights, now });
  const contentBanditAllocator = buildContentBanditAllocator({ insights, hookPatternReactor, now });
  const contentBanditSettlement = buildContentBanditSettlement({ insights, contentBanditAllocator, now });
  const audienceExpansionRouter = buildAudienceExpansionRouter({ insights, now });
  const growthKinetics = buildGrowthKinetics({
    state,
    insights,
    distributionOps,
    growthGoal: buildGrowthGoal(state),
    now,
  });
  const activeConnConversionOptimizer = buildActiveConnConversionOptimizer({
    state,
    insights,
    growthKinetics,
    contentBanditAllocator,
    audienceExpansionRouter,
    routeAmplifier,
    now,
  });
  const narrativeResonanceController = buildNarrativeResonanceController({
    insights,
    activeConnConversionOptimizer,
    audienceExpansionRouter,
    contentBanditAllocator,
    now,
  });
  const topicTimingRouter = buildTopicTimingRouter({
    insights,
    hourlyLoadBalancer,
    temporalAngleMatrix,
    contentBanditAllocator,
    narrativeResonanceController,
    now,
  });
  const growthOpportunityScorer = buildGrowthOpportunityScorer({
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    contentBanditAllocator,
    narrativeResonanceController,
    topicTimingRouter,
    cadence,
    now,
  });
  const dailyExecutionConsole = buildDailyExecutionConsole({
    operatorDispatchPacket,
    routeAmplifier,
    manualReplyTargetAtlas,
    distributionOps,
    cadence,
    growthOpportunityScorer,
    now,
  });
  const operatorPasteQueue = buildOperatorPasteQueue({
    dailyExecutionConsole,
    operatorDispatchPacket,
    manualReplyTargetAtlas,
    routeAmplifier,
    distributionOps,
    now,
  });
  const nextWindowAngleCommander = buildNextWindowAngleCommander({
    cadence,
    topicTimingRouter,
    growthOpportunityScorer,
    hourlyLoadBalancer,
    adaptiveAngleScheduler,
    dailyExecutionConsole,
    now,
  });
  const routeOpportunityMatrix = buildRouteOpportunityMatrix({
    operatorPasteQueue,
    dailyExecutionConsole,
    operatorDispatchPacket,
    routeAmplifier,
    manualReplyTargetAtlas,
    growthOpportunityScorer,
    nextWindowAngleCommander,
    budgetAllocationOptimizer,
    now,
  });
  const handles = manualReplyTargetHandles().slice(0, 10).map((handle) => `@${handle}`).join(", ");
  const links = manualReplySearchLinks();
  const firstDraft = drafts[0] || fallbackManualReplyDrafts()[0];
  const secondDraft = drafts[1] || firstDraft;
  const thirdDraft = drafts[2] || secondDraft;
  return [
    "# Daily Growth Checklist",
    "",
    `Updated: ${now}`,
    "",
    "Goal: borrow distribution without adding X API spend.",
    "",
    "The program does not auto-search, auto-like, or auto-reply here. Open the X web links manually, paste a draft, and stop after 3-5 useful route ops.",
    "",
    operatorPasteQueueReport(operatorPasteQueue),
    "",
    routeOpportunityMatrixReport(routeOpportunityMatrix),
    "",
    dailyExecutionConsoleReport(dailyExecutionConsole),
    "",
    nextWindowAngleCommanderReport(nextWindowAngleCommander, { heading: "## Next Window Angle Commander" }),
    "",
    "## Today",
    "",
    `1. Open [${links[0].label}](<${xSearchUrl(links[0].query)}>) and reply once using Draft 1.`,
    `2. Open [${links[1].label}](<${xSearchUrl(links[1].query)}>) and reply once using Draft 2.`,
    `3. Open [${links[2].label}](<${xSearchUrl(links[2].query)}>) and reply once using Draft 3.`,
    "4. If one route op gets ACKs/thread replies, add 1-2 more useful replies in that same conversation.",
    "5. Stop. Do not chase every topic.",
    "",
    "Pick posts less than 2 hours old when possible. Skip ads, giveaways, politics, ragebait, and anything unrelated to tech. Do not add hashtags or links.",
    "",
    operatorDispatchPacketReport(operatorDispatchPacket, { heading: "## Operator Dispatch Packet" }),
    "",
    manualReplyTargetAtlasReport(manualReplyTargetAtlas),
    "",
    autopilotDirectiveDeckReport(autopilotDirectiveDeck, { heading: "## Autopilot Directive Deck" }),
    "",
    routeAmplifierReport(routeAmplifier),
    "",
    angleMutationReactorReport(angleMutationReactor),
    "",
    hookPatternReactorReport(hookPatternReactor),
    "",
    contentBanditAllocatorReport(contentBanditAllocator),
    "",
    contentBanditSettlementReport(contentBanditSettlement),
    "",
    activeConnConversionOptimizerReport(activeConnConversionOptimizer),
    "",
    narrativeResonanceReport(narrativeResonanceController),
    "",
    topicTimingRouterReport(topicTimingRouter, { heading: "## Topic Timing Router" }),
    "",
    growthOpportunityScorerReport(growthOpportunityScorer, { heading: "## Opportunity Fusion Reactor" }),
    "",
    operatorProtocolQueueReport(distributionOps),
    "",
    "## Cadence",
    "",
    `Mode: ${cadence.mode} · Publish allowed: ${cadence.publishAllowed ? "yes" : "no"} · Enforcement: ${cadence.enforcement}`,
    "",
    cadence.reason,
    "",
    cadence.nextAction,
    "",
    "## Opportunity Queue",
    "",
    ...opportunities.slice(0, 3).flatMap((item) => [
      `### ${item.priority}. ${item.label} (${formatNumber(item.score, 1)})`,
      "",
      `${item.reason} Evidence: ${item.evidence || "-"}`,
      "",
      item.routeUrl ? `[Open ${item.routeLabel}](<${item.routeUrl}>)` : null,
      "",
      "```txt",
      item.draftText || drafts[Math.min(item.draftIndex || 0, Math.max(0, drafts.length - 1))]?.text || "",
      "```",
      "",
    ].filter((line) => line != null)),
    "",
    "## Post Experiment Slots",
    "",
    experimentPlan.decision,
    "",
    ...experimentPlan.recommendedFormats.slice(0, 3).map((item) =>
      `- Slot ${item.slot}: ${item.label || item.id} (${item.action}, avg ${formatNumber(item.avgScore, 1)}, n=${item.samples})`,
    ),
    "",
    handles ? `Target accounts: ${handles}` : "Target accounts: any relevant English tech account.",
    "",
    "## One-Click Search Links",
    "",
    ...links.map((link) => `- [${link.label}](<${xSearchUrl(link.query)}>) - ${link.when}`),
    "",
    "## Fastest 3 Replies",
    "",
    "### Draft 1",
    "",
    "```txt",
    firstDraft.text,
    "```",
    "",
    "### Draft 2",
    "",
    "```txt",
    secondDraft.text,
    "```",
    "",
    "### Draft 3",
    "",
    "```txt",
    thirdDraft.text,
    "```",
    "",
    "## More Copy-Paste Replies",
    "",
    ...drafts.map((draft, index) =>
      [
        `### ${index + 1}. ${draft.useWhen || draft.angle || "Relevant tech post"}`,
        "",
        "```txt",
        draft.text,
        "```",
      ].join("\n"),
    ),
    "",
  ].join("\n");
}

function manualReplyPlaybookReport() {
  const handles = manualReplyTargetHandles().slice(0, 12);
  const targetText = handles.length
    ? handles.map((handle) => `@${handle}`).join(", ")
    : "Any relevant English tech account";
  const links = manualReplySearchLinks();

  return [
    "### Manual Reply Playbook",
    "",
    "_Low-cost distribution workflow: open the X web links manually, pick fresh high-signal posts, then paste relevant drafts below. This avoids extra X search/read API spend._",
    "",
    `Target accounts: ${targetText}`,
    "",
    "One-click search links:",
    "",
    ...links.map((link) => `- [${link.label}](<${xSearchUrl(link.query)}>) - ${link.when}`),
    "",
    "Search backup:",
    "",
    "```txt",
    manualReplySearchQuery(),
    "```",
    "",
    "Daily rule: reply to 3-5 posts less than 2 hours old. Prioritize active discussions, skip ads/giveaways/politics, and lightly edit one noun if a draft needs context.",
  ].join("\n");
}

function usageReport(usage) {
  const entries = Object.entries(usage.endpoints || {}).sort((left, right) => right[1].calls - left[1].calls);
  if (!entries.length) return "### X API Usage\n\n_No tracked X API calls yet._";
  return [
    "### X API Usage",
    "",
    `Month: ${usage.month || currentBudgetMonth()} · Estimated tracked spend: $${formatNumber(usage.totalEstimatedUsd, 3)}`,
    "",
    "| Endpoint | Calls | Failures | Est. USD | Last Status |",
    "|---|---:|---:|---:|---:|",
    ...entries.map(([endpoint, value]) =>
      `| ${endpoint} | ${value.calls} | ${value.failures} | $${formatNumber(value.estimatedUsd, 3)} | ${value.lastStatus || "-"} |`,
    ),
  ].join("\n");
}

function openAIUsageReport(usage) {
  const summary = summarizeOpenAIUsage(usage || {});
  const entries = summary.purposes || [];
  if (!entries.length) return "### Model Inference Stream\n\n_No tracked model inference calls yet._";
  return [
    "### Model Inference Stream",
    "",
    `Month: ${summary.month} · Estimated tracked spend: $${formatNumber(summary.spend, 3)} · Pricing defaults to $0 unless OPENAI_COST_* variables are configured.`,
    "",
    "| Purpose | Calls | Failures | Input Tokens | Output Tokens | Total Tokens | Est. USD | Last Status |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...entries.map((entry) =>
      [
        `| ${markdownCell(entry.name)}`,
        entry.calls,
        entry.failures,
        formatNumber(entry.inputTokens),
        formatNumber(entry.outputTokens),
        formatNumber(entry.totalTokens),
        `$${formatNumber(entry.usd, 3)}`,
        entry.lastStatus || "-",
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function languageTracksReport(languageTracks) {
  const tracks = Array.isArray(languageTracks?.tracks) ? languageTracks.tracks : [];
  if (!tracks.length) return "### Language Tracks\n\n_No language track telemetry yet._";
  return [
    "### Language Tracks",
    "",
    `Mode: ${languageTracks.mode || "unknown"} · Extra X reads: ${languageTracks.zeroExtraXReads ? 0 : "unknown"}`,
    "",
    "| Track | UTC Windows | Next Slot | 24h Progress | 7d Traffic | 7d ACKs | Avg Score | Status |",
    "|---|---|---|---:|---:|---:|---:|---|",
    ...tracks.map((track) =>
      [
        `| ${track.label || track.id}`,
        (track.utcHours || []).map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ") || "-",
        track.nextWindow?.label || "-",
        `${formatNumber(track.packetsLast24h)}/${formatNumber(track.dailyTarget)}`,
        formatNumber(track.traffic7d),
        formatNumber(track.ack7d),
        formatNumber(track.avgScore, 1),
        track.status || "-",
      ].join(" | ") + " |",
    ),
    "",
    ...tracks.flatMap((track) => [
      `- ${track.label}: ${track.nextAction || "-"}`,
    ]),
  ].join("\n");
}

function growthDecisionReport(decision) {
  if (!decision || typeof decision !== "object") return "### Growth Decision Layer\n\n_No growth decision data yet._";
  const reviewRows = [decision.review24h, decision.review72h].filter(Boolean).map((review) => {
    const counts = Object.entries(review.counts || {})
      .sort((left, right) => right[1] - left[1])
      .map(([action, count]) => `${action}: ${count}`)
      .join(" · ") || "no measured packets";
    const top = review.items?.[0]
      ? `${review.items[0].action} · score ${formatNumber(review.items[0].score, 1)} · ${markdownCell(review.items[0].reason)}`
      : "waiting for eligible cache entries";
    return `| ${review.hours}h | ${review.total || 0} | ${markdownCell(counts)} | ${markdownCell(top)} |`;
  });
  const failureRows = (decision.failureStats?.topReasons || []).slice(0, 5).map((reason) =>
    `| ${markdownCell(reason.category)} | ${formatNumber(reason.count)} | ${markdownCell(reason.lastMessage || "-")} |`,
  );
  const experimentRows = (decision.abPlan?.arms || []).map((arm) =>
    `| ${markdownCell(arm.label || arm.id)} | ${markdownCell(arm.armA)} | ${markdownCell(arm.armB)} | ${markdownCell(arm.metric)} |`,
  );
  return [
    "### Growth Decision Layer",
    "",
    `Mode: ${decision.mode || "unknown"} · Extra X reads: ${decision.zeroExtraXReads ? 0 : "unknown"} · Incremental X API: $${formatNumber(decision.estimatedIncrementalXApiUsd || 0, 3)}`,
    "",
    `Today: ${decision.today?.summary || "-"}`,
    `Language mix: ${String(decision.languageMix?.primary || "en").toUpperCase()} primary · ${decision.languageMix?.confidence || "unknown"} · ${decision.languageMix?.recommendation || "-"}`,
    "",
    "| Window | Packets | Actions | Top Call |",
    "|---|---:|---|---|",
    ...(reviewRows.length ? reviewRows : ["| - | 0 | - | - |"]),
    "",
    "#### Failure Reasons",
    "",
    failureRows.length
      ? ["| Category | Count | Latest |", "|---|---:|---|", ...failureRows].join("\n")
      : "_No recent run faults in cached state._",
    "",
    "#### Low-Cost A/B Plan",
    "",
    "| Test | A | B | Metric |",
    "|---|---|---|---|",
    ...(experimentRows.length ? experimentRows : ["| - | - | - | - |"]),
  ].join("\n");
}

function markdownCell(value) {
  return String(value ?? "-").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function rssHealthReport(state) {
  const feeds = Object.values(state.rssHealth?.feeds || {})
    .map(normalizeRssHealthEntry)
    .filter((entry) => entry.totalFailures || entry.consecutiveFailures)
    .sort((left, right) => {
      if (right.consecutiveFailures !== left.consecutiveFailures) {
        return right.consecutiveFailures - left.consecutiveFailures;
      }
      return Date.parse(right.lastFailureAt || "") - Date.parse(left.lastFailureAt || "");
    });

  if (!feeds.length) return "### RSS Ingest Health\n\n_No RSS ingest faults recorded._";

  const skipAfter = integerEnv("NEWS_RSS_SKIP_AFTER_FAILURES", 3, 1, 20);
  return [
    "### RSS Ingest Health",
    "",
    `Auto-skip threshold: ${skipAfter} consecutive failure(s).`,
    "",
    "| Feed | Consecutive Faults | Total Faults | Last HTTP Status | Last Fault |",
    "|---|---:|---:|---|---|",
    ...feeds.slice(0, 12).map((entry) =>
      [
        `| ${markdownCell(entry.source || entry.url)}`,
        entry.consecutiveFailures,
        entry.totalFailures,
        markdownCell(entry.lastStatus),
        markdownCell(entry.lastError || "-").slice(0, 120),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function runEventsReport(state) {
  const events = (state.runEvents || [])
    .filter((event) => event && typeof event === "object")
    .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""));
  if (!events.length) return "### Run Events\n\n_No run events recorded._";

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const counts = {};
  for (const event of events) {
    const createdAt = Date.parse(event.createdAt || "");
    if (!Number.isFinite(createdAt) || createdAt < sevenDaysAgo) continue;
    const category = event.category || "other";
    counts[category] = (counts[category] || 0) + 1;
  }
  const summary = Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([category, count]) => `${category}: ${count}`)
    .join(" · ");

  return [
    "### Run Events",
    "",
    summary ? `Last 7d: ${summary}` : "Last 7d: no classified events.",
    "",
    "| Time | Category | Type | Message |",
    "|---|---|---|---|",
    ...events.slice(0, 12).map((event) =>
      [
        `| ${markdownCell(event.createdAt || "-")}`,
        markdownCell(event.category || "other"),
        markdownCell(event.type || "info"),
        markdownCell(event.message || "-").slice(0, 140),
      ].join(" | ") + " |",
    ),
  ].join("\n");
}

function buildGrowthReport({ state, insights, usage, budgetState, openAIUsage, growthStrategy = null }) {
  const now = new Date().toISOString();
  const last24h = recordsSince(state, 24, now);
  const last7d = recordsSince(state, 24 * 7, now);
  const delta = followerDelta(state);
  const drafts = dailyReplyDrafts(state);
  const actions = buildManualReplyActions(drafts);
  const opportunities = buildDashboardOpportunities({ state, insights, drafts, actions });
  const experimentPlan = buildExperimentPlan({ state, insights, usage, budgetState });
  const learningAutopilot = buildLearningAutopilot(insights, { experimentPlan, now });
  const hourlyLoadBalancer = buildHourlyLoadBalancer({ state, insights, now });
  const adaptiveAngleScheduler = buildAdaptiveAngleScheduler(insights, {
    state,
    experimentPlan,
    learningAutopilot,
    usage,
    now,
  });
  const temporalAngleMatrix = buildTemporalAngleMatrix({
    state,
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    now,
  });
  const mediaRoiGate = buildMediaRoiGate({ insights, usage, budgetState, now });
  const audienceExpansionRouter = buildAudienceExpansionRouter({ insights, now });
  const trendVelocityRadar = dashboardTrendVelocityRadar(state);
  const topicTimingRouterForCadence = buildCachedTopicTimingRouterForCadence({
    state,
    insights,
    usage,
    experimentPlan,
    hourlyLoadBalancer,
    now,
  });
  const cadence = buildGrowthCadenceController({
    state,
    insights,
    usage,
    budgetState,
    experimentPlan,
    hourlyLoadBalancer,
    topicTimingRouter: topicTimingRouterForCadence,
    now,
  });
  const distributionOps = buildDistributionOps({ opportunities, actions, drafts, insights, cadence, now });
  const operatorDispatchPacket = buildOperatorDispatchPacket({
    distributionOps,
    opportunities,
    drafts,
    actions,
    now,
  });
  const routeAmplifier = buildRouteAmplifier({
    operatorDispatchPacket,
    distributionOps,
    insights,
    cadence,
    now,
  });
  const manualReplyTargetAtlas = buildManualReplyTargetAtlas({
    operatorDispatchPacket,
    routeAmplifier,
    distributionOps,
    now,
  });
  const budgetBurnReactor = buildBudgetBurnReactor({
    usage,
    budgetState,
    cadence,
    operatorSlo: null,
    mediaRoiGate,
    now,
  });
  const budgetAllocationOptimizer = buildBudgetAllocationOptimizer({
    usage,
    budgetState,
    budgetBurnReactor,
    cadence,
    operatorSlo: null,
    routeAmplifier,
    growthKinetics: null,
    viralFlywheel: null,
    mediaRoiGate,
    now,
  });
  const learningWriteback = buildLearningWriteback({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    experimentPlan,
    now,
  });
  const autopilotDirectiveDeck = buildAutopilotDirectiveDeck({
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    learningWriteback,
    budgetAllocationOptimizer,
    hourlyLoadBalancer,
    cadence,
    now,
  });
  const angleMutationReactor = buildAngleMutationReactor({
    insights,
    learningAutopilot,
    adaptiveAngleScheduler,
    temporalAngleMatrix,
    learningWriteback,
    routeAmplifier,
    operatorDispatchPacket,
    now,
  });
  const hookPatternReactor = buildHookPatternReactor({ insights, now });
  const contentBanditAllocator = buildContentBanditAllocator({ insights, hookPatternReactor, now });
  const contentBanditSettlement = buildContentBanditSettlement({ insights, contentBanditAllocator, now });
  const growthGoal = buildGrowthGoal(state);
  const growthKinetics = buildGrowthKinetics({
    state,
    insights,
    distributionOps,
    growthGoal,
    now,
  });
  const activeConnConversionOptimizer = buildActiveConnConversionOptimizer({
    state,
    insights,
    growthKinetics,
    contentBanditAllocator,
    audienceExpansionRouter,
    routeAmplifier,
    now,
  });
  const narrativeResonanceController = buildNarrativeResonanceController({
    insights,
    activeConnConversionOptimizer,
    audienceExpansionRouter,
    contentBanditAllocator,
    now,
  });
  const topicTimingRouter = buildTopicTimingRouter({
    insights,
    hourlyLoadBalancer,
    temporalAngleMatrix,
    contentBanditAllocator,
    narrativeResonanceController,
    now,
  });
  const growthOpportunityScorer = buildGrowthOpportunityScorer({
    insights,
    adaptiveAngleScheduler,
    hourlyLoadBalancer,
    contentBanditAllocator,
    narrativeResonanceController,
    topicTimingRouter,
    cadence,
    now,
  });
  const selfEvolvingStrategy = growthStrategy || buildSelfEvolvingGrowthStrategy({
    state,
    insights,
    generationStack: {
      learningAutopilot,
      adaptiveAngleScheduler,
      hourlyLoadBalancer,
      temporalAngleMatrix,
      learningWriteback,
      angleMutationReactor,
      hookPatternReactor,
      contentBanditAllocator,
      contentBanditSettlement,
      audienceExpansionRouter,
      activeConnConversionOptimizer,
      narrativeResonanceController,
      topicTimingRouter,
      growthOpportunityScorer,
    },
    now,
  });
  const dailyExecutionConsole = buildDailyExecutionConsole({
    operatorDispatchPacket,
    routeAmplifier,
    manualReplyTargetAtlas,
    distributionOps,
    cadence,
    growthOpportunityScorer,
    now,
  });
  const nextWindowAngleCommander = buildNextWindowAngleCommander({
    cadence,
    topicTimingRouter,
    growthOpportunityScorer,
    hourlyLoadBalancer,
    adaptiveAngleScheduler,
    budgetAllocationOptimizer,
    dailyExecutionConsole,
    now,
  });
  const latestGenerationDecisionTrace =
    (state.tweets || []).find((record) => record?.generationDecisionTrace)?.generationDecisionTrace || null;
  const languageTracks = buildLanguageTracks(state, insights, now);
  const growthDecision = buildGrowthDecision({
    state,
    insights,
    usage,
    budgetState,
    languageTracks,
    cadence,
    opportunities,
    experimentPlan,
    now,
  });
  const summary = [
    `Generated: ${now}`,
    `Tracked posts: ${(state.tweets || []).length}`,
    `Measured posts: ${insights.records.length}`,
    `Baseline growth score: ${formatNumber(insights.baselineScore, 1)}`,
    delta
      ? `Ingress Node Strength: ${formatNumber(delta.latestFollowers)} active conns (${delta.delta >= 0 ? "+" : ""}${formatNumber(delta.delta)} since last snapshot)`
      : "Ingress Node Strength: not enough snapshots yet",
  ];

  return [
    "# X Bot Growth Report",
    "",
    "For daily copy-paste work, open [Daily Route Plan](daily-replies.md).",
    "",
    ...summary.map((line) => `- ${line}`),
    "",
    learningReport(insights),
    "",
    experimentPlanReport(experimentPlan),
    "",
    cadenceReport(cadence),
    "",
    languageTracksReport(languageTracks),
    "",
    growthDecisionReport(growthDecision),
    "",
    growthStrategyReport(selfEvolvingStrategy),
    "",
    dailyExecutionConsoleReport(dailyExecutionConsole, { heading: "### Daily Execution Console" }),
    "",
    nextWindowAngleCommanderReport(nextWindowAngleCommander),
    "",
    budgetAllocationOptimizerReport(budgetAllocationOptimizer),
    "",
    autopilotDirectiveDeckReport(autopilotDirectiveDeck),
    "",
    operatorDispatchPacketReport(operatorDispatchPacket, { heading: "### Operator Dispatch Packet" }),
    "",
    manualReplyTargetAtlasReport(manualReplyTargetAtlas, { heading: "### Manual Reply Target Atlas" }),
    "",
    routeAmplifierReport(routeAmplifier, { heading: "### Route Amplifier" }),
    "",
    angleMutationReactorReport(angleMutationReactor, { heading: "### Angle Mutation Reactor" }),
    "",
    hookPatternReactorReport(hookPatternReactor, { heading: "### Hook Pattern Reactor" }),
    "",
    contentBanditAllocatorReport(contentBanditAllocator, { heading: "### Content Bandit Allocator" }),
    "",
    contentBanditSettlementReport(contentBanditSettlement, { heading: "### Bandit Reward Settlement" }),
    "",
    activeConnConversionOptimizerReport(activeConnConversionOptimizer, { heading: "### Active Conn Conversion Optimizer" }),
    "",
    narrativeResonanceReport(narrativeResonanceController, { heading: "### Narrative Resonance Controller" }),
    "",
    topicTimingRouterReport(topicTimingRouter, { heading: "### Topic Timing Router" }),
    "",
    growthOpportunityScorerReport(growthOpportunityScorer, { heading: "### Opportunity Fusion Reactor" }),
    "",
    generationDecisionTraceReport(latestGenerationDecisionTrace),
    "",
    operatorProtocolQueueReport(distributionOps, { heading: "### Operator Protocol Queue" }),
    "",
    temporalAngleMatrixReport(temporalAngleMatrix),
    "",
    trendVelocityRadarReport(trendVelocityRadar),
    "",
    audienceExpansionReport(audienceExpansionRouter),
    "",
    mediaRoiGateReport(mediaRoiGate),
    "",
    opportunityReport(opportunities),
    "",
    "## Highest-Throughput Packets: Last 24h",
    "",
    reportTable(last24h),
    "",
    "## Highest-Throughput Packets: Last 7d",
    "",
    reportTable(last7d),
    "",
    bucketReport("Best Templates", insights.templates, insights),
    "",
    bucketReport("Best Sources", insights.sources, insights),
    "",
    bucketReport("Best Source Tiers", insights.sourceTiers, insights),
    "",
    bucketReport("Best Hashtags", insights.tags, insights, 8),
    "",
    hotspotReport(state),
    "",
    followUpDraftReport(state),
    "",
    manualReplyPlaybookReport(),
    "",
    manualReplyDraftReport(state),
    "",
    autoReplyReport(state),
    "",
    rssHealthReport(state),
    "",
    runEventsReport(state),
    "",
    usageReport(usage || { endpoints: {} }),
    "",
    openAIUsageReport(openAIUsage || {}),
    "",
  ].join("\n");
}

async function writeGrowthReport() {
  const state = await readTweetAnalytics();
  const insights = deriveAnalyticsInsights(state);
  const usage = await readXApiUsageState();
  const openAIUsage = await readOpenAIUsageState();
  const budgetState = await readApiBudgetState();
  const previousStrategy = await readGrowthStrategy();
  const growthStrategy = buildSelfEvolvingGrowthStrategy({
    state,
    insights,
    previous: previousStrategy,
  });
  await persistGrowthStrategy(growthStrategy);
  if (growthStrategy?.evolution?.frozen) {
    console.log(
      `Daily growth strategy frozen for UTC ${growthStrategy.evolution.utcDay}; digest refreshed, weights unchanged.`,
    );
  } else {
    await appendGrowthEvolutionLog(growthStrategy);
    const mutationSummary = (growthStrategy?.evolution?.mutations || [])
      .map((item) => item.formatId ? `${item.type}:${item.formatId}` : item.type)
      .join(", ") || "none";
    console.log(`Evolved growth strategy from daily traffic digest; mutations=${mutationSummary}.`);
  }
  const report = buildGrowthReport({ state, insights, usage, budgetState, openAIUsage, growthStrategy });
  const file = optionalEnv("GROWTH_REPORT_FILE", ".github/runtime/growth-report.md");
  await writeTextFile(file, report);
  console.log(`Wrote growth report to ${file}.`);

  const dailyReplyReport = buildDailyReplyReport({ state, usage, budgetState });
  const dailyReplyFile = optionalEnv("DAILY_REPLY_FILE", ".github/runtime/daily-replies.md");
  await writeTextFile(dailyReplyFile, dailyReplyReport);
  console.log(`Wrote daily route plan to ${dailyReplyFile}.`);

  const dashboardData = buildDashboardData({ state, insights, usage, budgetState, openAIUsage, growthStrategy });
  const dashboardDataFile = optionalEnv("DASHBOARD_DATA_FILE", ".github/runtime/dashboard-data.json");
  await writeTextFile(dashboardDataFile, `${JSON.stringify(dashboardData, null, 2)}\n`);
  console.log(`Wrote dashboard data to ${dashboardDataFile}.`);

  const summaryFile = optionalEnv("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    const existing = await readTextFileIfExists(summaryFile);
    await writeTextFile(summaryFile, `${existing}${report}\n`);
  }
  return report;
}

async function recordPostedTweetAnalytics({
  tweet,
  tweetId,
  mediaId,
  selectedStory,
  language,
  imagePlan,
  selectedCandidate,
  generationDecisionTrace,
}) {
  if (!tweetAnalyticsEnabled() || !tweetId) return;
  const state = await readTweetAnalytics();
  const record = {
    id: String(tweetId),
    text: tweet,
    language: language?.code || null,
    postedAt: new Date().toISOString(),
    url: `https://x.com/i/web/status/${tweetId}`,
    characterCount: countCharacters(tweet),
    hasMedia: Boolean(mediaId),
    mediaId: mediaId || null,
    imagePlan: imagePlan?.reason || null,
    newsTitle: selectedStory?.title || null,
    newsLink: selectedStory?.link || null,
    newsSource: selectedStory?.source || null,
    newsSourceTier: selectedStory?.sourceTier || sourceTier(selectedStory?.source),
    newsHotScore: selectedStory?.hotScore ?? null,
    newsLearnedScore: selectedStory?.learnedScore ?? null,
    trendVelocityScore: selectedStory?.trendVelocityScore ?? null,
    trendVelocityStage: selectedStory?.trendVelocityStage || null,
    trendVelocityLift: selectedStory?.trendVelocityLift ?? null,
    trendVelocityAgeHours: selectedStory?.trendVelocityAgeHours ?? null,
    crossSourceEchoes: selectedStory?.crossSourceEchoes ?? null,
    audienceSegment: selectedStory?.audienceSegment || primaryAudienceSegment(selectedStory || tweet).id,
    audienceLabel: selectedStory?.audienceLabel || primaryAudienceSegment(selectedStory || tweet).label,
    templateId: selectedCandidate?.templateId || null,
    candidateScore: selectedCandidate?.score ?? null,
    candidateReason: selectedCandidate?.reason || null,
    angleMutationScore: selectedCandidate?.angleMutationScore ?? null,
    angleMutationDiagnostics: selectedCandidate?.angleMutationDiagnostics || [],
    hookPatternScore: selectedCandidate?.hookPatternScore ?? null,
    hookPatternDiagnostics: selectedCandidate?.hookPatternDiagnostics || [],
    hookPattern: selectedCandidate?.hookPatternClassification || null,
    contentBanditScore: selectedCandidate?.contentBanditScore ?? null,
    contentBanditDiagnostics: selectedCandidate?.contentBanditDiagnostics || [],
    narrativeResonanceScore: selectedCandidate?.narrativeResonanceScore ?? null,
    narrativeResonanceDiagnostics: selectedCandidate?.narrativeResonanceDiagnostics || [],
    narrativePillar: selectedCandidate?.narrativePillar || null,
    topicTimingScore: selectedCandidate?.topicTimingScore ?? null,
    topicTimingDiagnostics: selectedCandidate?.topicTimingDiagnostics || [],
    topicTimingLane: selectedCandidate?.topicTimingLane || null,
    generationDecisionTrace: generationDecisionTrace || null,
    hashtags: extractHashtags(tweet),
    metricsSnapshots: [],
    latestMetrics: null,
    workflowRunUrl: workflowRunUrl(),
    createdAt: new Date().toISOString(),
  };

  state.tweets = [record, ...state.tweets.filter((item) => String(item.id) !== String(tweetId))];
  await persistTweetAnalytics(state);
  console.log(`Recorded tweet analytics seed for ${tweetId}.`);
}

function workflowRunUrl() {
  const serverUrl = optionalEnv("GITHUB_SERVER_URL");
  const repository = optionalEnv("GITHUB_REPOSITORY");
  const runId = optionalEnv("GITHUB_RUN_ID");
  if (!serverUrl || !repository || !runId) return null;
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function archiveGenerationDecisionSummary(trace, selectedCandidate) {
  if (!trace && !selectedCandidate) return null;
  return {
    mode: trace?.mode || null,
    zeroExtraXReads: trace?.zeroExtraXReads ?? true,
    estimatedXReadOps: trace?.estimatedXReadOps ?? 0,
    selectedRank: trace?.selectedRank ?? null,
    selectedTemplateId: trace?.selectedTemplateId || selectedCandidate?.templateId || null,
    selectedScore: trace?.selectedScore ?? selectedCandidate?.score ?? null,
    selectedReason: trace?.selectedReason || selectedCandidate?.reason || null,
    language: trace?.language || null,
    storyTitle: trace?.story?.title || null,
    storySource: trace?.story?.source || null,
    angleMutationMode: trace?.angleMutation?.mode || null,
    hookPatternMode: trace?.hookPattern?.mode || null,
    contentBanditMode: trace?.contentBandit?.mode || null,
    selectedAngle: trace?.selectedCandidate?.angle || selectedCandidate?.angle || null,
  };
}

async function appendTweetArchive({
  tweet,
  tweetId,
  mediaId,
  selectedStory,
  language,
  selectedCandidate,
  generationDecisionTrace,
}) {
  if (!isTruthy(optionalEnv("TWEET_ARCHIVE_ENABLED", "true"))) return;

  const archiveFile = optionalEnv("TWEET_ARCHIVE_FILE", "archive/tweets.jsonl");
  const entry = {
    id: tweetId || null,
    text: tweet,
    language: language?.code || null,
    postedAt: new Date().toISOString(),
    url: tweetId ? `https://x.com/i/web/status/${tweetId}` : null,
    characterCount: countCharacters(tweet),
    hasMedia: Boolean(mediaId),
    mediaId: mediaId || null,
    newsTitle: selectedStory?.title || null,
    newsLink: selectedStory?.link || null,
    newsSource: selectedStory?.source || null,
    newsSourceTier: selectedStory?.sourceTier || sourceTier(selectedStory?.source),
    newsHotScore: selectedStory?.hotScore ?? null,
    newsLearnedScore: selectedStory?.learnedScore ?? null,
    trendVelocityScore: selectedStory?.trendVelocityScore ?? null,
    trendVelocityStage: selectedStory?.trendVelocityStage || null,
    trendVelocityLift: selectedStory?.trendVelocityLift ?? null,
    trendVelocityAgeHours: selectedStory?.trendVelocityAgeHours ?? null,
    audienceSegment: selectedStory?.audienceSegment || primaryAudienceSegment(selectedStory || tweet).id,
    audienceLabel: selectedStory?.audienceLabel || primaryAudienceSegment(selectedStory || tweet).label,
    templateId: selectedCandidate?.templateId || null,
    candidateScore: selectedCandidate?.score ?? null,
    candidateReason: selectedCandidate?.reason || null,
    angleMutationScore: selectedCandidate?.angleMutationScore ?? null,
    angleMutationDiagnostics: selectedCandidate?.angleMutationDiagnostics || [],
    hookPatternScore: selectedCandidate?.hookPatternScore ?? null,
    hookPatternDiagnostics: selectedCandidate?.hookPatternDiagnostics || [],
    hookPattern: selectedCandidate?.hookPatternClassification || null,
    contentBanditScore: selectedCandidate?.contentBanditScore ?? null,
    contentBanditDiagnostics: selectedCandidate?.contentBanditDiagnostics || [],
    narrativeResonanceScore: selectedCandidate?.narrativeResonanceScore ?? null,
    narrativeResonanceDiagnostics: selectedCandidate?.narrativeResonanceDiagnostics || [],
    narrativePillar: selectedCandidate?.narrativePillar || null,
    topicTimingScore: selectedCandidate?.topicTimingScore ?? null,
    topicTimingDiagnostics: selectedCandidate?.topicTimingDiagnostics || [],
    topicTimingLane: selectedCandidate?.topicTimingLane || null,
    generationDecisionSummary: archiveGenerationDecisionSummary(generationDecisionTrace, selectedCandidate),
    workflowRunUrl: workflowRunUrl(),
  };

  await ensureParentDirectory(archiveFile);
  const existing = await readTextFileIfExists(archiveFile);
  await Bun.write(archiveFile, `${existing}${JSON.stringify(entry)}\n`);
}

function currentBudgetMonth() {
  return new Date().toISOString().slice(0, 7);
}

function monthlyBudgetUsd() {
  return numberEnv("X_API_MONTHLY_BUDGET_USD", 5, 0, 1000);
}

function budgetSafetyRatio() {
  return numberEnv("X_API_BUDGET_SAFETY_RATIO", 0.9, 0.5, 1);
}

function estimatedPostCost(hasMedia) {
  const tweetCost = numberEnv("X_API_COST_TWEET_CREATE", 0.015, 0, 1);
  const mediaCost = numberEnv("X_API_COST_MEDIA_UPLOAD", 0.015, 0, 1);
  if (!hasMedia) return tweetCost;
  return tweetCost + mediaCost;
}

function mediaRoiGateEnabled() {
  return isTruthy(optionalEnv("TWEET_MEDIA_ROI_GATE_ENABLED", "true"));
}

function mediaRoiBucketSummary(bucket) {
  return {
    samples: Number(bucket?.count) || 0,
    avgScore: Number(bucket?.avgScore) || 0,
  };
}

function buildMediaRoiGate({ insights, usage, budgetState, now = null } = {}) {
  const enabled = mediaRoiGateEnabled();
  const minSamples = integerEnv("TWEET_MEDIA_ROI_MIN_SAMPLES", 3, 1, 100);
  const minLift = numberEnv("TWEET_MEDIA_ROI_MIN_LIFT", 0.18, -1, 10);
  const textPostCost = estimatedPostCost(false);
  const imagePostCost = estimatedPostCost(true);
  const incrementalImageCost = Math.max(0, imagePostCost - textPostCost);
  const minSafeRemaining = numberEnv(
    "TWEET_MEDIA_ROI_MIN_SAFE_REMAINING_USD",
    Math.max(imagePostCost * 2, incrementalImageCost),
    0,
    1000,
  );
  const media = mediaRoiBucketSummary(insights?.media?.with_media);
  const text = mediaRoiBucketSummary(insights?.media?.text_only);
  const baseline = Number(insights?.baselineScore) || 0;
  const referenceScore = text.samples > 0 ? text.avgScore : baseline;
  const liftPct =
    media.samples > 0 && referenceScore > 0
      ? (media.avgScore - referenceScore) / referenceScore
      : null;
  const enoughSamples = media.samples >= minSamples && text.samples >= minSamples;
  const cap = monthlyBudgetUsd();
  const safeCap = cap * budgetSafetyRatio();
  const trackedSpend = Number(usage?.totalEstimatedUsd) || 0;
  const publishSpend = Number(budgetState?.spentUsd) || 0;
  const spendBasis = Math.max(trackedSpend, publishSpend);
  const safeRemaining = cap > 0 ? Math.max(0, safeCap - spendBasis) : null;
  const budgetOk = cap <= 0 || safeRemaining >= minSafeRemaining;
  const liftOk = liftPct !== null && liftPct >= minLift;

  let decision = "allow";
  let attachImageAllowed = true;
  let reason = "Media ROI gate disabled.";
  let nextAction = "Use normal image story signal.";

  if (enabled) {
    decision = "hold";
    attachImageAllowed = false;
    if (!enoughSamples) {
      reason = `Need ${minSamples}+ measured text and media posts before spending on images (${text.samples} text, ${media.samples} media).`;
      nextAction = "Keep image posts off until enough cached outcomes prove lift.";
    } else if (!budgetOk) {
      reason = `Safe X API budget left $${formatNumber(safeRemaining || 0, 3)} is below media reserve $${formatNumber(minSafeRemaining, 3)}.`;
      nextAction = "Preserve budget for text posts and manual route workflow.";
    } else if (!liftOk) {
      reason = `Media lift ${formatNumber((liftPct || 0) * 100, 1)}% is below ${formatNumber(minLift * 100, 1)}% threshold.`;
      nextAction = "Default to text-only unless future analytics show media lift.";
    } else {
      decision = "allow";
      attachImageAllowed = true;
      reason = `Media lift ${formatNumber(liftPct * 100, 1)}% clears ${formatNumber(minLift * 100, 1)}% threshold.`;
      nextAction = "Allow image only when story and quota gates also pass.";
    }
  }

  return {
    enabled,
    decision,
    attachImageAllowed,
    generatedAt: now || new Date().toISOString(),
    zeroExtraXReads: true,
    confidence: enoughSamples ? "measured" : "low_samples",
    reason,
    nextAction,
    mediaAvgScore: Number(media.avgScore.toFixed(2)),
    textAvgScore: Number(text.avgScore.toFixed(2)),
    baselineScore: Number(baseline.toFixed(2)),
    mediaSamples: media.samples,
    textSamples: text.samples,
    minSamples,
    mediaLiftPct: liftPct === null ? null : Number((liftPct * 100).toFixed(1)),
    minLiftPct: Number((minLift * 100).toFixed(1)),
    textPostCostUsd: roundUsd(textPostCost),
    imagePostCostUsd: roundUsd(imagePostCost),
    incrementalImageCostUsd: roundUsd(incrementalImageCost),
    minSafeRemainingUsd: roundUsd(minSafeRemaining),
    safeRemainingUsd: safeRemaining === null ? null : roundUsd(safeRemaining),
    checks: [
      {
        id: "samples",
        ok: enoughSamples,
        label: "cached sample floor",
        value: `${media.samples}/${minSamples} media · ${text.samples}/${minSamples} text`,
      },
      {
        id: "lift",
        ok: liftOk,
        label: "media lift",
        value: liftPct === null ? "unknown" : `${formatNumber(liftPct * 100, 1)}%`,
      },
      {
        id: "budget",
        ok: budgetOk,
        label: "safe budget reserve",
        value: safeRemaining === null ? "unlimited" : `$${formatNumber(safeRemaining, 3)} left`,
      },
      {
        id: "x_reads",
        ok: true,
        label: "extra X reads",
        value: "0",
      },
    ],
  };
}

async function readApiBudgetState() {
  const file = optionalEnv("X_API_BUDGET_FILE", ".github/runtime/x-api-budget.json");
  const state = await readJsonFileIfExists(file, {});
  const month = currentBudgetMonth();
  if (state.month !== month) {
    return {
      month,
      spentUsd: 0,
      posts: 0,
      imagePostsByDate: {},
      lastPostedAt: null,
      lastImagePostedAt: null,
    };
  }
  return {
    month,
    spentUsd: Number(state.spentUsd) || 0,
    posts: Number(state.posts) || 0,
    imagePostsByDate:
      state.imagePostsByDate && typeof state.imagePostsByDate === "object"
        ? state.imagePostsByDate
        : {},
    lastPostedAt: state.lastPostedAt || null,
    lastImagePostedAt: state.lastImagePostedAt || null,
  };
}

async function persistApiBudgetState(state) {
  const file = optionalEnv("X_API_BUDGET_FILE", ".github/runtime/x-api-budget.json");
  await ensureParentDirectory(file);
  await Bun.write(file, `${JSON.stringify(state, null, 2)}\n`);
}

function logApiBudgetStatus(state) {
  const budget = monthlyBudgetUsd();
  if (budget <= 0) {
    console.log("X API budget tracking is disabled.");
    return;
  }

  const textCost = estimatedPostCost(false);
  const imageCost = estimatedPostCost(true);
  const remaining = Math.max(0, budget * budgetSafetyRatio() - state.spentUsd);
  console.log(
    `X API budget ${state.month}: $${state.spentUsd.toFixed(3)} spent / $${budget} cap (text ~$${textCost.toFixed(3)}, image ~$${imageCost.toFixed(3)}, ~$${remaining.toFixed(2)} left).`,
  );
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function storyVerdictCacheFile() {
  return optionalEnv(
    "TWEET_STORY_VERDICT_CACHE_FILE",
    optionalEnv("TWEET_DAILY_IMAGE_STATE_FILE", ".github/runtime/story-verdict-cache.json"),
  );
}

async function readStoryVerdictCache() {
  const parsed = await readJsonFileIfExists(storyVerdictCacheFile(), {});
  const today = currentUtcDate();
  if (parsed.date !== today) {
    return { date: today, verdicts: {} };
  }
  return {
    date: today,
    verdicts: parsed.verdicts && typeof parsed.verdicts === "object" ? parsed.verdicts : {},
  };
}

async function persistStoryVerdictCache(cache) {
  const file = storyVerdictCacheFile();
  await ensureParentDirectory(file);
  await Bun.write(file, `${JSON.stringify(cache, null, 2)}\n`);
}

function parseStoryValueVerdict(content) {
  try {
    const parsed = JSON.parse(String(content || "").trim());
    const imageWorthy = Boolean(
      parsed.imageWorthy ?? parsed.image_worthy ?? parsed.worthy,
    );
    const postWorthy = Boolean(
      parsed.postWorthy ?? parsed.post_worthy ?? parsed.worthy ?? imageWorthy,
    );
    return {
      postWorthy,
      imageWorthy,
      reason: String(parsed.reason || parsed.explanation || "").trim() || "No reason given.",
    };
  } catch {
    return {
      postWorthy: true,
      imageWorthy: false,
      reason: "Could not parse AI story value verdict.",
    };
  }
}

function formatStoryForImageVerdict(story) {
  if (!story) return "No story provided.";
  return [
    `Title: ${story.title || "unknown"}`,
    story.source ? `Source: ${story.source}` : null,
    story.published ? `Published: ${story.published}` : null,
    story.hotScore != null ? `Hot score: ${Number(story.hotScore).toFixed(2)}` : null,
    story.crossSourceEchoes ? `Cross-source echoes: ${story.crossSourceEchoes}` : null,
    story.summary ? `Summary: ${String(story.summary).slice(0, 320)}` : null,
    story.link ? `Link: ${story.link}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const DEFAULT_IMAGE_WORTH_SYSTEM_PROMPT = [
  "You judge tech stories for X audience growth: whether to post and whether a professional stock photo will lift engagement.",
  'Return JSON only: {"postWorthy":boolean,"imageWorthy":boolean,"reason":"short explanation"}.',
  "postWorthy=true for broadly interesting stories with a sharp angle, discussion potential, or repost value.",
  "Reject routine funding, minor releases, legal filings, and low-signal updates.",
  "Prefer credible developer-tool and AI workflow shifts from products such as Cursor, GitHub, OpenAI, Anthropic, Google, Apple, Microsoft, and Cloudflare, even when the RSS title is terse.",
  "imageWorthy=true when a high-quality editorial stock photo (Pexels) can support the post via a clear visual metaphor—",
  "developer workstation, data center, chip/hardware, robotics, cybersecurity, startup office, abstract AI/neural glow, etc.",
  "Say yes even if a product screenshot would also work; we are NOT limited to exact brand imagery.",
  "imageWorthy=false only when the story is purely textual (numbers, legal text) or no credible visual metaphor exists at all.",
  "Lean imageWorthy=true for: AI/ML model news, dev tools, security incidents, hardware, platform shifts, visible industry moments.",
].join(" ");

const DEFAULT_IMAGE_WORTH_USER_PROMPT = [
  "Audience language for today's post: {{language}}.",
  "Story:",
  "{{news}}",
  "Should we post this story? Can a professional editorial stock photo (not a screenshot) represent it well on X?",
  "If a visual metaphor is reasonable, prefer imageWorthy=true.",
].join("\n");

const DEFAULT_IMAGE_SEARCH_SYSTEM_PROMPT = [
  "You write Pexels stock photo search queries for professional tech accounts on X.",
  "Return 3-5 English keywords only on one line. No quotes, labels, or explanation.",
  "Style: editorial, clean, modern, professional, minimal clutter, credible tech journalism aesthetic.",
  "Use concrete visual nouns: server room, coding laptop, circuit board, glass office, chip wafer, cybersecurity lock.",
  "Avoid: logos, branded products, UI screenshots, memes, cartoons, handshakes, generic business stock clichés.",
].join(" ");

const DEFAULT_IMAGE_SEARCH_USER_PROMPT = [
  "Write a Pexels search query for a polished editorial tech photo matching this post.",
  "Think Wired / Ars Technica social cards: one strong subject, professional lighting, no text overlays.",
  "If the tweet is abstract, map it to a visual metaphor (e.g. AI policy → server governance, coding agent → developer desk).",
  "Topic context: {{topic}}",
  "News context:",
  "{{news}}",
].join("\n");

async function evaluateStoryValue(story, language) {
  if (!story) {
    return { postWorthy: false, imageWorthy: false, reason: "No story to evaluate." };
  }

  const systemPrompt = optionalEnv(
    "TWEET_IMAGE_WORTH_SYSTEM_PROMPT",
    DEFAULT_IMAGE_WORTH_SYSTEM_PROMPT,
  );
  const customPrompt = optionalEnv("TWEET_IMAGE_WORTH_PROMPT");
  const userPrompt = customPrompt
    ? interpolatePrompt(customPrompt, {
        news: formatStoryForImageVerdict(story),
        language: language?.label || language?.code || "unknown",
        topic: optionalEnv("TWEET_TOPIC", "technology, AI, Big Tech, consumer tech, startups, apps, cybersecurity, cloud, software"),
      })
    : interpolatePrompt(DEFAULT_IMAGE_WORTH_USER_PROMPT, {
        news: formatStoryForImageVerdict(story),
        language: language?.label || language?.code || "unknown",
        topic: optionalEnv("TWEET_TOPIC", "technology, AI, Big Tech, consumer tech, startups, apps, cybersecurity, cloud, software"),
      });

  const temperatureRaw = optionalEnv("OPENAI_IMAGE_VERDICT_TEMPERATURE");
  const temperature = temperatureRaw ? numberEnv("OPENAI_IMAGE_VERDICT_TEMPERATURE", 0.2, 0, 1) : null;

  const { response, data } = await callOpenAIChat({
    purpose: "story_value_verdict",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    responseFormat: { type: "json_object" },
    temperature,
  });

  if (!response.ok) {
    const message = data?.error?.message || `OpenAI story value verdict failed (${response.status})`;
    console.warn(message);
    return { postWorthy: true, imageWorthy: false, reason: message };
  }

  return parseStoryValueVerdict(data?.choices?.[0]?.message?.content);
}

async function getStoryVerdict(story, language) {
  if (!story) {
    return { postWorthy: false, imageWorthy: false, reason: "No story to evaluate." };
  }

  const link = story.link || "";
  if (link) {
    const cache = await readStoryVerdictCache();
    const cached = cache.verdicts[link];
    if (cached && typeof cached.postWorthy === "boolean") {
      return cached;
    }

    const verdict = await evaluateStoryValue(story, language);
    if (dryRunEnabled()) return verdict;
    cache.verdicts[link] = verdict;
    await persistStoryVerdictCache(cache);
    return verdict;
  }

  return evaluateStoryValue(story, language);
}

function evaluateStoryQuality(story) {
  if (!story) return { allow: false, reason: "No story selected." };
  if (!isTruthy(optionalEnv("TWEET_SKIP_WEAK_STORIES", "true"))) {
    return { allow: true };
  }

  const minScore = numberEnv("TWEET_MIN_HOT_SCORE", 1.25, 0, 10);
  const minScoreWithEchoes = numberEnv("TWEET_MIN_HOT_SCORE_WITH_ECHOES", 1.0, 0, 10);
  const score = Number(story.hotScore) || 0;
  const echoes = Number(story.crossSourceEchoes) || 0;

  if (echoes >= 1 && score >= Math.min(minScore, minScoreWithEchoes)) return { allow: true };
  if (score >= minScore) return { allow: true };

  return {
    allow: false,
    reason: `Weak story for posting (score=${score.toFixed(2)}, cross-source echoes=${echoes}).`,
  };
}

function storyImageSignal(story) {
  const score = Number(story?.hotScore) || 0;
  const echoes = Number(story?.crossSourceEchoes) || 0;
  const minScore = numberEnv("TWEET_IMAGE_MIN_HOT_SCORE", 2.5, 0, 20);
  const minEchoes = integerEnv("TWEET_IMAGE_MIN_CROSS_SOURCE_ECHOES", 0, 0, 10);
  if (!story) {
    return { allow: false, reason: "No story selected for image." };
  }
  if (score < minScore) {
    return {
      allow: false,
      reason: `story hot score ${score.toFixed(2)} < image threshold ${minScore.toFixed(2)}`,
    };
  }
  if (echoes < minEchoes) {
    return {
      allow: false,
      reason: `cross-source echoes ${echoes} < image threshold ${minEchoes}`,
    };
  }
  return { allow: true };
}

async function imageQuotaStatus() {
  const maxPerDay = integerEnv("TWEET_IMAGE_MAX_PER_DAY", 1, 0, 24);
  if (maxPerDay <= 0) {
    return { allow: false, reason: "TWEET_IMAGE_MAX_PER_DAY is 0" };
  }

  const state = await readApiBudgetState();
  const day = currentUtcDate();
  const usedToday = Number(state.imagePostsByDate?.[day]) || 0;
  if (usedToday >= maxPerDay) {
    return {
      allow: false,
      reason: `daily image quota reached (${usedToday}/${maxPerDay})`,
    };
  }

  return { allow: true, usedToday, maxPerDay };
}

async function resolveImageAttachmentPlan({ story, language, verdict, mediaRoiGate = null } = {}) {
  if (!isTruthy(optionalEnv("TWEET_IMAGE_ENABLED", "false"))) {
    return { attachImage: false, reason: "TWEET_IMAGE_ENABLED is false" };
  }

  const mode = optionalEnv("TWEET_DAILY_IMAGE_MODE", "ai_per_post").toLowerCase();
  if (mode === "text_only" || mode === "none") {
    return { attachImage: false, reason: `TWEET_DAILY_IMAGE_MODE=${mode}` };
  }

  const quota = await imageQuotaStatus();
  if (!quota.allow) {
    return { attachImage: false, reason: quota.reason };
  }

  if (mediaRoiGate?.enabled && !mediaRoiGate.attachImageAllowed) {
    return {
      attachImage: false,
      reason: `media ROI gate: ${mediaRoiGate.reason}`,
      mediaRoiGate,
    };
  }

  if (mode === "fixed_hour") {
    const targetHour = integerEnv("TWEET_DAILY_IMAGE_UTC_HOUR", 17, 0, 23);
    const hour = new Date().getUTCHours();
    if (hour !== targetHour) {
      return {
        attachImage: false,
        reason: `Text-only run. fixed_hour mode reserves images for ${String(targetHour).padStart(2, "0")}:00 UTC.`,
      };
    }
    return {
      attachImage: true,
      reason: `fixed_hour mode image slot at ${String(targetHour).padStart(2, "0")}:00 UTC.`,
      mediaRoiGate,
    };
  }

  const signal = storyImageSignal(story);
  if (!signal.allow) {
    return { attachImage: false, reason: signal.reason };
  }

  const resolved = verdict || (await getStoryVerdict(story, language));
  if (resolved.imageWorthy) {
    return {
      attachImage: true,
      reason: `AI image-worthy within image quota (${quota.usedToday}/${quota.maxPerDay} used): ${resolved.reason}`,
      mediaRoiGate,
    };
  }

  return {
    attachImage: false,
    reason: `AI declined image: ${resolved.reason}`,
    mediaRoiGate,
  };
}

async function evaluatePostBudget(attachImage = false) {
  const budget = monthlyBudgetUsd();
  const state = await readApiBudgetState();
  logApiBudgetStatus(state);

  if (budget <= 0) {
    return { allowed: true, state, projectedCost: 0 };
  }

  const projectedCost = estimatedPostCost(attachImage);
  const spendCap = budget * budgetSafetyRatio();

  if (state.spentUsd + projectedCost > spendCap) {
    return {
      allowed: false,
      state,
      projectedCost,
      reason: `Monthly X API budget would be exceeded ($${state.spentUsd.toFixed(3)} spent + ~$${projectedCost.toFixed(3)} next post > $${spendCap.toFixed(2)} safe cap).`,
    };
  }

  if (xApiUsageTrackingEnabled()) {
    const usage = await readXApiUsageState();
    const trackedSpend = Number(usage.totalEstimatedUsd) || 0;
    if (trackedSpend + projectedCost > spendCap) {
      return {
        allowed: false,
        state,
        usage,
        projectedCost,
        reason: `Monthly X API total spend would exceed safe cap ($${trackedSpend.toFixed(3)} tracked + ~$${projectedCost.toFixed(3)} next post > $${spendCap.toFixed(2)} safe cap).`,
      };
    }
  }

  const minHours = numberEnv("X_API_MIN_HOURS_BETWEEN_POSTS", 0, 0, 168);
  if (state.lastPostedAt && minHours > 0) {
    const elapsedMs = Date.now() - Date.parse(state.lastPostedAt);
    const minMs = minHours * 60 * 60 * 1000;
    if (Number.isFinite(elapsedMs) && elapsedMs < minMs) {
      const waitHours = ((minMs - elapsedMs) / (60 * 60 * 1000)).toFixed(1);
      return {
        allowed: false,
        state,
        projectedCost,
        reason: `Minimum post interval not reached (${minHours}h). Wait about ${waitHours}h.`,
      };
    }
  }

  return { allowed: true, state, projectedCost };
}

async function recordApiSpend(projectedCost, hasMedia) {
  const budget = monthlyBudgetUsd();
  if (budget <= 0) return;

  const state = await readApiBudgetState();
  const actualCost = estimatedPostCost(hasMedia);
  state.spentUsd = (Number(state.spentUsd) || 0) + actualCost;
  state.posts = (Number(state.posts) || 0) + 1;
  state.lastPostedAt = new Date().toISOString();
  if (hasMedia) {
    const day = currentUtcDate();
    state.imagePostsByDate = state.imagePostsByDate || {};
    state.imagePostsByDate[day] = (Number(state.imagePostsByDate[day]) || 0) + 1;
    state.lastImagePostedAt = state.lastPostedAt;
  }
  await persistApiBudgetState(state);
  logApiBudgetStatus(state);
  console.log(
    `Recorded X API spend ~$${actualCost.toFixed(3)} for this ${hasMedia ? "image" : "text"} post (projected was ~$${projectedCost.toFixed(3)}).`,
  );
}

async function readCachedAccessToken() {
  const cacheFile = optionalEnv(
    "X_ACCESS_TOKEN_CACHE_FILE",
    ".github/runtime/x-access-token.json",
  );
  const cached = await readJsonFileIfExists(cacheFile, null);
  if (!cached?.accessToken || !cached?.expiresAt) return null;

  const bufferMs =
    integerEnv("X_ACCESS_TOKEN_REFRESH_BUFFER_SEC", 300, 60, 3600) * 1000;
  if (Date.now() >= Date.parse(cached.expiresAt) - bufferMs) return null;

  const scopes = Array.isArray(cached.scopes)
    ? cached.scopes
    : parseOAuthScopes(cached.scopes);
  const missingScopes = missingOAuthScopes(scopes, requiredOAuthScopes());
  if (scopes.length && missingScopes.length) return null;

  return {
    accessToken: cached.accessToken,
    scopes,
    label: "cached access token",
  };
}

async function persistAccessTokenCache({
  accessToken,
  expiresIn,
  scopes,
  label,
}) {
  const cacheFile = optionalEnv(
    "X_ACCESS_TOKEN_CACHE_FILE",
    ".github/runtime/x-access-token.json",
  );
  const ttlSec = Number(expiresIn);
  const expiresAt = new Date(
    Date.now() + (Number.isFinite(ttlSec) ? ttlSec : 7200) * 1000,
  ).toISOString();

  await ensureParentDirectory(cacheFile);
  await Bun.write(
    cacheFile,
    `${JSON.stringify(
      {
        accessToken,
        expiresAt,
        scopes,
        source: label,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Cached X access token until ${expiresAt}.`);
}

function countCharacters(text) {
  return Array.from(text).length;
}

function normalizeTweetPunctuation(text) {
  const lastPeriodIndex = text.lastIndexOf("。");
  if (lastPeriodIndex < 0) return text;
  return text.slice(0, lastPeriodIndex).replaceAll("。", "，") + text.slice(lastPeriodIndex);
}

function breakTweetHashtags(text) {
  const match = /(^|[\s，。！？、；：,.!?;:])(#\S+)/.exec(text);
  if (!match) return text;

  const hashIndex = match.index + match[1].length;
  if (hashIndex === 0) return text;
  return `${text.slice(0, hashIndex).trimEnd()}\n${text.slice(hashIndex).trimStart()}`;
}

function trimTweet(text) {
  const normalized = normalizeTweetPunctuation(
    breakTweetHashtags(
      text
        .replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );

  if (countCharacters(normalized) <= MAX_TWEET_LENGTH) {
    return normalized;
  }

  return Array.from(normalized).slice(0, MAX_TWEET_LENGTH - 1).join("").trimEnd() + "…";
}

function decodeXmlEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function cleanXmlText(text) {
  return decodeXmlEntities(text).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function firstTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanXmlText(match[1]) : "";
}

function firstAtomLink(block) {
  const hrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (hrefMatch) return decodeXmlEntities(hrefMatch[1]).trim();
  return firstTag(block, "link");
}

function collectBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((match) => match[1]);
}

function parseFeedItems(xml, sourceUrl) {
  const blocks = collectBlocks(xml, "item").length ? collectBlocks(xml, "item") : collectBlocks(xml, "entry");

  return blocks
    .map((block, index) => {
      const published = firstTag(block, "pubDate") || firstTag(block, "published") || firstTag(block, "updated");
      return {
        title: firstTag(block, "title"),
        link: firstAtomLink(block),
        summary: firstTag(block, "description") || firstTag(block, "summary") || firstTag(block, "content"),
        published,
        publishedMs: Date.parse(published) || 0,
        source: new URL(sourceUrl).hostname.replace(/^www\./, ""),
        sourceUrl,
        sourceIndex: 0,
        itemIndex: index,
      };
    })
    .filter((item) => item.title);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "x-bot-github-actions/1.0",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  return results;
}

function tokenizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fa5]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !TITLE_STOP_WORDS.has(token));
}

function titleTokenOverlap(leftTitle, rightTitle) {
  const left = new Set(tokenizeTitle(leftTitle));
  const right = new Set(tokenizeTitle(rightTitle));
  if (!left.size || !right.size) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.min(left.size, right.size);
}

function countCrossSourceEchoes(item, allItems) {
  const threshold = numberEnv("NEWS_HOT_TITLE_OVERLAP", 0.42, 0.2, 0.9);
  const sources = new Set();
  for (const other of allItems) {
    if (other === item || other.source === item.source) continue;
    if (titleTokenOverlap(item.title, other.title) >= threshold) {
      sources.add(other.source);
    }
  }
  return sources.size;
}

function recencyScore(publishedMs, nowMs) {
  if (!publishedMs) return 0.15;
  const ageHours = (nowMs - publishedMs) / (60 * 60 * 1000);
  if (ageHours < 0) return 1;
  if (ageHours <= 6) return 1;
  if (ageHours <= 24) return 0.9;
  if (ageHours <= 48) return 0.7;
  if (ageHours <= 72) return 0.5;
  return Math.max(0.1, 1 - ageHours / 168);
}

const SOURCE_TIER_HOSTS = {
  official: new Set([
    "openai.com",
    "anthropic.com",
    "github.blog",
    "blog.google",
    "deepmind.google",
    "aws.amazon.com",
    "blogs.microsoft.com",
    "blog.cloudflare.com",
    "stripe.com",
    "apple.com",
    "huggingface.co",
    "blog.rust-lang.org",
  ]),
  discussion: new Set([
    "hnrss.org",
    "news.ycombinator.com",
    "producthunt.com",
    "reddit.com",
    "dev.to",
    "v2ex.com",
  ]),
  cn: new Set([
    "sspai.com",
    "ifanr.com",
    "36kr.com",
    "ithome.com",
    "qbitai.com",
    "solidot.org",
    "cnbeta.com.tw",
    "feed.appinn.com",
  ]),
  mainstream: new Set([
    "theverge.com",
    "techcrunch.com",
    "wired.com",
    "feeds.arstechnica.com",
    "technologyreview.com",
    "engadget.com",
    "venturebeat.com",
    "cnet.com",
    "zdnet.com",
    "feeds.bbci.co.uk",
    "rss.nytimes.com",
    "theguardian.com",
  ]),
  radar: new Set(["x.com"]),
};

function sourceTier(source) {
  const host = String(source || "").replace(/^www\./, "");
  for (const [tier, hosts] of Object.entries(SOURCE_TIER_HOSTS)) {
    if (hosts.has(host)) return tier;
  }
  return "other";
}

function sourceTierBoost(tier) {
  const configured = optionalEnv(`NEWS_SOURCE_TIER_${String(tier || "").toUpperCase()}_BOOST`);
  if (configured) return numberEnv(`NEWS_SOURCE_TIER_${String(tier || "").toUpperCase()}_BOOST`, 1, 0.1, 3);
  const defaults = {
    official: 1.18,
    discussion: 1.1,
    radar: 1.12,
    mainstream: 1.04,
    cn: 0.98,
    other: 1,
  };
  return defaults[tier] || 1;
}

function learnedTopicLift(item, performanceInsights) {
  if (!isTruthy(optionalEnv("TWEET_GROWTH_LEARNING_ENABLED", "true"))) return 0;
  if (!performanceInsights?.records?.length) return 0;

  const sourceLift = performanceLift(
    performanceInsights.sources?.[item.source],
    performanceInsights,
    0.35,
  );
  const tokens = tokenizeTitle(`${item.title || ""} ${item.summary || ""}`).slice(0, 12);
  const tagLifts = tokens
    .map((token) => performanceLift(performanceInsights.tags?.[token], performanceInsights, 0.25))
    .filter((lift) => lift !== 0);
  const tagLift = tagLifts.length
    ? tagLifts.reduce((sum, lift) => sum + lift, 0) / tagLifts.length
    : 0;

  return Math.max(-0.35, Math.min(0.55, sourceLift + tagLift));
}

function trendVelocityRadarEnabled() {
  return isTruthy(optionalEnv("TWEET_TREND_VELOCITY_RADAR_ENABLED", "true"));
}

function newsItemAgeHours(item, nowMs) {
  if (!item?.publishedMs) return null;
  return Math.max(0, (nowMs - item.publishedMs) / (60 * 60 * 1000));
}

function trendFreshnessCurve(ageHours) {
  if (ageHours === null || ageHours === undefined) return 0.32;
  if (ageHours <= 1) return 1.18;
  if (ageHours <= 3) return 1.08;
  if (ageHours <= 6) return 1;
  if (ageHours <= 12) return 0.84;
  if (ageHours <= 24) return 0.66;
  if (ageHours <= 48) return 0.42;
  return Math.max(0.16, 1 - ageHours / 96);
}

function relatedNewsItems(item, allItems) {
  const itemTokens = tokenizeTitle(`${item?.title || ""} ${item?.summary || ""}`);
  if (!itemTokens.length) return [];
  return (allItems || []).filter((candidate) => {
    if (!candidate || candidate === item) return false;
    if (candidate.link && item.link && candidate.link === item.link) return false;
    const candidateTokens = tokenizeTitle(`${candidate.title || ""} ${candidate.summary || ""}`);
    return titleTokenOverlap(itemTokens, candidateTokens) >= 0.28;
  });
}

function trendVelocityProfile(item, allItems, nowMs) {
  const ageHours = newsItemAgeHours(item, nowMs);
  const freshness = trendFreshnessCurve(ageHours);
  const related = relatedNewsItems(item, allItems);
  const echoes = countCrossSourceEchoes(item, allItems);
  const sourceDiversity = new Set(
    [item, ...related]
      .map((candidate) => candidate?.source)
      .filter(Boolean),
  ).size;
  const tier = item.sourceTier || sourceTier(item.source);
  const tierFactor = sourceTierBoost(tier);
  const segment = primaryAudienceSegment(item);
  const audienceBroadness = Number(segment.broadness) || 1;
  const burst = Math.min(2.4, 1 + echoes * 0.34 + Math.max(0, sourceDiversity - 1) * 0.16);
  const rawScore =
    38 * freshness +
    18 * Math.min(1.6, burst) +
    15 * Math.min(1.35, tierFactor) +
    12 * Math.min(1.5, audienceBroadness) +
    5 * Math.min(1.5, related.length / 3);
  const score = Math.max(0, Math.min(100, rawScore));
  let stage = "probe";
  if ((ageHours ?? 999) > 48) stage = "cooling";
  else if (score >= 76 && echoes >= 1) stage = "breakout";
  else if (score >= 62) stage = "rising";
  else if ((ageHours ?? 999) <= 6) stage = "early";
  else stage = "watch";
  const reasonParts = [];
  reasonParts.push(ageHours === null ? "unknown age" : `${formatNumber(ageHours, 1)}h old`);
  reasonParts.push(`${echoes} echoes`);
  reasonParts.push(`${sourceDiversity} sources`);
  reasonParts.push(`${tier} source`);
  reasonParts.push(segment.label);
  return {
    score: Number(score.toFixed(1)),
    lift: trendVelocityRadarEnabled()
      ? Number(Math.max(-0.08, Math.min(numberEnv("TWEET_TREND_VELOCITY_MAX_LIFT", 0.28, 0, 0.75), (score - 46) / 190)).toFixed(3))
      : 0,
    stage,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    echoes,
    sourceDiversity,
    tier,
    audienceSegment: segment.id,
    audienceLabel: segment.label,
    reason: reasonParts.join(" · "),
  };
}

function scoreNewsHotness(item, allItems, nowMs, recentStoryLinks, performanceInsights = null) {
  const recency = recencyScore(item.publishedMs, nowMs);
  const echoes = countCrossSourceEchoes(item, allItems);
  const crossSourceBoost = 1 + echoes * numberEnv("NEWS_HOT_CROSS_SOURCE_WEIGHT", 0.35, 0, 2);
  const tier = item.sourceTier || sourceTier(item.source);
  const tierBoost = sourceTierBoost(tier);
  const learnedLift = learnedTopicLift(item, performanceInsights);
  const audienceLift = audienceExpansionLift(item, performanceInsights);
  const trendLift = trendVelocityProfile(item, allItems, nowMs).lift;
  let score = recency * crossSourceBoost * tierBoost;

  if (item.link && recentStoryLinks.includes(item.link)) {
    score *= numberEnv("NEWS_REPEAT_PENALTY", 0.15, 0.01, 1);
  }

  return score * (1 + learnedLift + audienceLift + trendLift);
}

function isPromotionalStory(item) {
  const title = String(item?.title || "");
  const promoPattern = /(\[?\s*(推广|广告|赞助|sponsored|affiliate)\s*\]?|#\s*ad\b)/i;
  return promoPattern.test(title);
}

function rankHotNewsItems(items, recentStoryLinks, performanceInsights = null) {
  const nowMs = Date.now();
  return items
    .filter((item) => !isPromotionalStory(item))
    .map((item) => {
      const learnedLift = learnedTopicLift(item, performanceInsights);
      const audienceSegment = primaryAudienceSegment(item);
      const audienceLift = audienceExpansionLift(item, performanceInsights);
      const trendVelocity = trendVelocityProfile(item, items, nowMs);
      const hotScore = scoreNewsHotness(
        item,
        items,
        nowMs,
        recentStoryLinks,
        performanceInsights,
      );
      return {
        ...item,
        sourceTier: item.sourceTier || sourceTier(item.source),
        hotScore,
        learnedLift,
        audienceSegment: audienceSegment.id,
        audienceLabel: audienceSegment.label,
        audienceLift,
        trendVelocityScore: trendVelocity.score,
        trendVelocityLift: trendVelocity.lift,
        trendVelocityStage: trendVelocity.stage,
        trendVelocityAgeHours: trendVelocity.ageHours,
        trendVelocityReason: trendVelocity.reason,
        learnedScore: hotScore,
        crossSourceEchoes: countCrossSourceEchoes(item, items),
      };
    })
    .sort((left, right) => {
      if (right.hotScore !== left.hotScore) return right.hotScore - left.hotScore;
      if (right.publishedMs !== left.publishedMs) {
        return right.publishedMs - left.publishedMs;
      }
      return left.itemIndex - right.itemIndex;
    });
}

function buildTrendVelocityRadar({ ranked = [], now = null } = {}) {
  const updatedAt = now || new Date().toISOString();
  const items = (ranked || [])
    .filter((item) => item && !isPromotionalStory(item))
    .slice()
    .sort((left, right) => {
      const leftScore = Number(left.trendVelocityScore) || 0;
      const rightScore = Number(right.trendVelocityScore) || 0;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return (right.hotScore || 0) - (left.hotScore || 0);
    })
    .slice(0, integerEnv("TWEET_TREND_VELOCITY_MAX_ITEMS", 12, 3, 30))
    .map((item, index) => {
      const routeQuery = trendRouteQuery(item);
      return {
        rank: index + 1,
        title: item.title || "Untitled story",
        link: item.link || null,
        source: item.source || null,
        sourceTier: item.sourceTier || sourceTier(item.source),
        audienceSegment: item.audienceSegment || primaryAudienceSegment(item).id,
        audienceLabel: item.audienceLabel || primaryAudienceSegment(item).label,
        hotScore: Number((Number(item.hotScore) || 0).toFixed(2)),
        velocityScore: Number((Number(item.trendVelocityScore) || 0).toFixed(1)),
        velocityLift: Number((Number(item.trendVelocityLift) || 0).toFixed(3)),
        stage: item.trendVelocityStage || "watch",
        ageHours: item.trendVelocityAgeHours ?? null,
        echoes: item.crossSourceEchoes ?? 0,
        reason: item.trendVelocityReason || "",
        routeLabel: "Live X route",
        routeQuery,
        routeUrl: xSearchUrl(routeQuery),
        routeReason: "Open live X web search and reply manually under active high-throughput conversations.",
        replyAngle: trendReplyAngle(item),
        zeroExtraXReads: true,
      };
    });
  const breakoutCount = items.filter((item) => item.stage === "breakout" || item.stage === "rising").length;
  const avgVelocity = items.length
    ? items.reduce((sum, item) => sum + item.velocityScore, 0) / items.length
    : 0;
  const primary = items[0] || null;
  return {
    updatedAt,
    zeroExtraXReads: true,
    mode: trendVelocityRadarEnabled() ? "rss_velocity" : "disabled",
    summary: {
      items: items.length,
      breakoutCount,
      avgVelocity: Number(avgVelocity.toFixed(1)),
      primaryStage: primary?.stage || "idle",
      primaryTitle: primary?.title || null,
      primarySource: primary?.source || null,
      nextAction: primary
        ? `Route ${primary.stage} story from ${primary.source || "RSS"} into the next post angle.`
        : "Wait for the next RSS refresh.",
    },
    items,
  };
}

async function persistTrendVelocityRadar(ranked) {
  if (!tweetAnalyticsEnabled() || dryRunEnabled() || !trendVelocityRadarEnabled()) return null;
  const radar = buildTrendVelocityRadar({ ranked });
  const state = await readTweetAnalytics();
  state.trendVelocityRadar = radar;
  await persistTweetAnalytics(state);
  console.log(`Trend velocity radar stored ${radar.items.length} RSS topic(s).`);
  return radar;
}

async function refreshTrendVelocityRadar(performanceInsights = null, hotspotItems = []) {
  if (!trendVelocityRadarEnabled()) return null;
  try {
    const { ranked } = await fetchNewsItems(performanceInsights, hotspotItems);
    if (!ranked.length) {
      console.warn("Trend velocity radar skipped: no RSS stories available.");
      return null;
    }
    return buildTrendVelocityRadar({ ranked });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Trend velocity radar refresh skipped: ${message}`);
    await recordRunEvent("maintenance_degraded", `trend velocity radar refresh skipped: ${message}`, {
      category: "content",
    });
    return null;
  }
}

const BLOCKED_RSS_HOSTS = new Set([
  "marco.org",
  "swift.org",
  "stackoverflow.blog",
  "llvm.org",
  "v8.dev",
  "llamaindex.ai",
  "netflixtechblog.com",
  "tldr.tech",
  "linear.app",
  "indiehackers.com",
  "geekpark.net",
  "leiphone.com",
  "huxiu.com",
]);

function isBlockedRssUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (BLOCKED_RSS_HOSTS.has(host)) return true;
    if (host === "blog.rust-lang.org" && url.includes("/compiler-team/")) return true;
    if (host === "apnews.com" || host === "rss.dw.com" || host === "ai.meta.com") return true;
    return false;
  } catch {
    return false;
  }
}

function filterRssUrls(urls) {
  const kept = [];
  for (const url of urls) {
    if (isBlockedRssUrl(url)) {
      console.log(`Skipping blocked RSS feed: ${url}`);
      continue;
    }
    kept.push(url);
  }
  return kept;
}

function parseUrlList(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(/[\n,;]+/)
        .map((value) => value.trim())
        .filter((value) => value && !value.startsWith("#") && /^https?:\/\//i.test(value)),
    ),
  ];
}

async function filterRssUrlsByHealth(urls) {
  if (!isTruthy(optionalEnv("NEWS_RSS_HEALTH_ENABLED", "true"))) return urls;

  const skipAfter = integerEnv("NEWS_RSS_SKIP_AFTER_FAILURES", 3, 1, 20);
  const probeEveryHours = numberEnv("NEWS_RSS_HEALTH_PROBE_EVERY_HOURS", 12, 1, 168);
  const state = await readTweetAnalytics();
  const feeds = state.rssHealth?.feeds || {};
  const now = Date.now();
  const kept = [];
  const skipped = [];

  for (const url of urls) {
    const entry = feeds[url];
    const failures = Number(entry?.consecutiveFailures) || 0;
    const lastChecked = Date.parse(entry?.updatedAt || entry?.lastFailureAt || "");
    const stillCoolingDown =
      Number.isFinite(lastChecked) &&
      now - lastChecked < probeEveryHours * 60 * 60 * 1000;

    if (failures >= skipAfter && stillCoolingDown) {
      skipped.push({ url, failures });
      continue;
    }
    kept.push(url);
  }

  if (skipped.length) {
    console.log(
      `Skipping ${skipped.length} unhealthy RSS feed(s) until next health probe: ${skipped
        .slice(0, 5)
        .map((item) => `${new URL(item.url).hostname.replace(/^www\./, "")}(${item.failures})`)
        .join(", ")}${skipped.length > 5 ? ", ..." : ""}`,
    );
  }

  return kept;
}

async function loadNewsRssUrls() {
  const file = optionalEnv("NEWS_RSS_URLS_FILE", ".github/config/news-rss-urls.txt");
  const fromFile = filterRssUrls(parseUrlList(await readTextFileIfExists(file)));
  if (fromFile.length) {
    const healthy = await filterRssUrlsByHealth(fromFile);
    console.log(`Loaded ${healthy.length} RSS feeds from ${file}.`);
    return healthy;
  }

  const fromEnv = filterRssUrls(listEnv("NEWS_RSS_URLS"));
  if (fromEnv.length) {
    const healthy = await filterRssUrlsByHealth(fromEnv);
    console.log(`Loaded ${healthy.length} RSS feeds from NEWS_RSS_URLS env.`);
    return healthy;
  }

  return [];
}

async function fetchNewsItems(performanceInsights = null, hotspotItems = []) {
  const urls = await loadNewsRssUrls();
  if (!urls.length && !hotspotItems.length) return { items: [], selected: null, ranked: [] };

  const perFeedMax = integerEnv("NEWS_PER_FEED_MAX", 8, 1, 30);
  const contextMax = integerEnv("NEWS_MAX_ITEMS", 6, 1, 20);
  const timeoutMs = integerEnv("NEWS_FETCH_TIMEOUT_MS", 10000, 1000, 30000);
  const concurrency = integerEnv("NEWS_FETCH_CONCURRENCY", 6, 1, 20);
  const pickerState = await readNewsPickerState();

  if (urls.length) {
    console.log(`Fetching ${urls.length} RSS feeds in parallel (up to ${perFeedMax} items each).`);
  }

  const rssHealthUpdates = [];
  const feedResults = urls.length
    ? await mapPool(urls, concurrency, async (url) => {
        const source = new URL(url).hostname.replace(/^www\./, "");
        try {
          const xml = await fetchText(url, timeoutMs);
          const items = parseFeedItems(xml, url)
            .sort((left, right) => right.publishedMs - left.publishedMs)
            .slice(0, perFeedMax);
          console.log(`Fetched ${items.length} items from ${source}.`);
          rssHealthUpdates.push({
            url,
            source,
            ok: true,
            status: "ok",
            itemCount: items.length,
          });
          return items;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          rssHealthUpdates.push({
            url,
            source,
            ok: false,
            status: message.split(/\s+/)[0] || "error",
            error: message,
          });
          console.warn(
            `Failed to fetch RSS feed ${url}: ${message}`,
          );
          return [];
        }
      })
    : [];
  await recordRssHealth(rssHealthUpdates);

  const merged = [...feedResults.flat(), ...hotspotItems];
  if (!merged.length) {
    console.warn("No RSS items fetched from configured feeds.");
    return { items: [], selected: null, ranked: [] };
  }
  if (hotspotItems.length) {
    console.log(`Merged ${hotspotItems.length} cached X hotspot radar items into story ranking.`);
  }

  const ranked = rankHotNewsItems(merged, pickerState.recentStoryLinks, performanceInsights);
  await persistTrendVelocityRadar(ranked);
  const archiveLinks = await readRecentArchiveStoryLinks();
  const topStory = ranked[0] || null;
  const selected = selectStoryFromRanked(ranked, archiveLinks);
  const contextItems = ranked.slice(0, contextMax);

  if (selected && topStory?.link && selected.link !== topStory.link) {
    console.log("Top story was recently posted; using next best candidate.");
  }

  return { items: contextItems, selected, ranked };
}

async function pickPostableStory(ranked, language) {
  const maxAttempts = integerEnv("TWEET_STORY_PICK_MAX", 5, 1, 15);
  const skipOnAiReject = isTruthy(optionalEnv("TWEET_AI_SKIP_LOW_VALUE", "true"));
  const archiveLinks = await readRecentArchiveStoryLinks();

  const candidates = [];
  for (const item of ranked) {
    if (item.link && archiveLinks.has(item.link)) continue;
    candidates.push(item);
  }
  if (!candidates.length && ranked.length) {
    candidates.push(ranked[0]);
  }

  for (let index = 0; index < Math.min(maxAttempts, candidates.length); index += 1) {
    const story = candidates[index];
    if (index === 0) {
      console.log(
        `Selected hottest topic: "${story.title}" (${story.source}, score=${story.hotScore.toFixed(2)}, velocity=${formatNumber(story.trendVelocityScore, 1)} ${story.trendVelocityStage || "watch"}, learned lift=${((story.learnedLift || 0) * 100).toFixed(0)}%, cross-source echoes=${story.crossSourceEchoes}).`,
      );
    } else {
      console.log(
        `Trying story candidate ${index + 1}: "${story.title}" (${story.source}, score=${story.hotScore.toFixed(2)}, velocity=${formatNumber(story.trendVelocityScore, 1)} ${story.trendVelocityStage || "watch"}, learned lift=${((story.learnedLift || 0) * 100).toFixed(0)}%).`,
      );
    }

    const quality = evaluateStoryQuality(story);
    if (!quality.allow) {
      console.log(`Skipping candidate ${index + 1} for low signal: ${quality.reason}`);
      continue;
    }

    const verdict = await getStoryVerdict(story, language);
    console.log(
      `AI story value: post=${verdict.postWorthy ? "yes" : "no"}, image=${verdict.imageWorthy ? "yes" : "no"} — ${verdict.reason}`,
    );

    if (verdict.postWorthy || !skipOnAiReject) {
      if (index > 0) {
        console.log(`Using story candidate ${index + 1} after earlier rejections.`);
      }
      return { story, verdict };
    }

    console.log(`AI rejected candidate ${index + 1}; trying next story.`);
  }

  return null;
}

async function readRecentArchiveStoryLinks() {
  const hours = numberEnv("TWEET_STORY_COOLDOWN_HOURS", 36, 0, 168);
  if (hours <= 0) return new Set();

  const archiveFile = optionalEnv("TWEET_ARCHIVE_FILE", "archive/tweets.jsonl");
  let content = "";
  try {
    content = await Bun.file(archiveFile).text();
  } catch {
    return new Set();
  }

  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const links = new Set();
  for (const line of content.trim().split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const postedAt = Date.parse(entry.postedAt);
      if (!Number.isFinite(postedAt) || postedAt < cutoff) break;
      if (entry.newsLink) links.add(String(entry.newsLink));
    } catch {
      continue;
    }
  }
  return links;
}

function selectStoryFromRanked(ranked, archiveLinks) {
  if (!ranked.length) return null;
  for (const item of ranked) {
    if (item.link && archiveLinks.has(item.link)) continue;
    return item;
  }
  return ranked[0];
}

function formatNewsItemLine(item, index, { selected = false } = {}) {
  const parts = [`${index + 1}. ${item.title}`];
  if (selected) parts.unshift("[SELECTED]");
  if (item.source) parts.push(`source: ${item.source}`);
  if (item.sourceTier) parts.push(`tier: ${item.sourceTier}`);
  if (item.published) parts.push(`published: ${item.published}`);
  if (item.link) parts.push(`url: ${item.link}`);
  if (item.hotScore != null) parts.push(`hot score: ${item.hotScore.toFixed(2)}`);
  if (item.crossSourceEchoes) {
    parts.push(`covered by ${item.crossSourceEchoes + 1} feeds`);
  }
  if (item.summary) parts.push(`summary: ${item.summary.slice(0, 220)}`);
  return parts.join(" | ");
}

function formatNewsContext(items, selected, buildNotes = []) {
  if (!items.length) return "No external news feed was configured or fetched.";

  if (!selected) {
    return items
      .map((item, index) => formatNewsItemLine(item, index))
      .join("\n");
  }

  return formatHybridContentContext({
    selected,
    newsItems: items,
    buildNotes,
    formatNewsItem: formatNewsItemLine,
  });
}

function interpolatePrompt(template, values) {
  return template.replace(/\{\{\s*(news|topic|language|now|style|history|tweet|performance)\s*\}\}/gi, (_, key) => values[key.toLowerCase()] || "");
}

function formatHistoryContext(history) {
  if (!history.length) return "No recent post history.";
  return history.map((tweet, index) => `${index + 1}. ${tweet}`).join("\n");
}

function hashtagPromptRules() {
  if (!isTruthy(optionalEnv("TWEET_HASHTAGS_ENABLED", "true"))) {
    return ["- Do not include hashtags."];
  }

  const custom = optionalEnv("TWEET_HASHTAG_PROMPT");
  if (custom) return [custom];

  const count = integerEnv("TWEET_HASHTAG_COUNT", 2, 1, 5);
  return [
    `- End the post with exactly ${count} relevant hashtags on a new line.`,
    "- Hashtags must match the selected story (e.g. #AI, #BigTech, #ConsumerTech, #Cybersecurity, #Startups, #Cloud, #DevTools).",
    "- Prefer high-signal tech tags over generic trend tags; use #TechNews only as a fallback.",
    "- Prefer widely used English tech tags even for Chinese posts, because they route into larger global conversations.",
    `- Use exactly ${count} hashtags, no more; never add a third tag, emoji, or URL.`,
    "- Hashtags are mandatory unless hashtags are disabled by configuration.",
  ];
}

function growthSourceRequirements(contentType = "news_take") {
  const isBuildInPublic = String(contentType) === "build_in_public";
  return [
    "Growth requirements:",
    isBuildInPublic
      ? "- Source is Build-in-Public: frame the progress as a \"cheat code\" or a costly lesson. Put a dollar or time value on it when the source data supports one; never invent numbers."
      : "- Source is News: find the angle that makes 90% of people wrong about this, then tell the 10% truth backed by the source detail.",
    "- Format for readability: use tight line breaks, not one dense paragraph.",
  ];
}

function buildPrompt({
  customPrompt,
  language,
  topic,
  now,
  style,
  newsContext,
  historyContext,
  performanceContext,
  contentFormat,
  contentType = "news_take",
}) {
  const values = {
    news: newsContext,
    topic,
    language,
    now,
    style,
    history: historyContext,
    performance: performanceContext,
  };
  const hashtagRules = hashtagPromptRules();

  if (customPrompt) {
    return [
      interpolatePrompt(customPrompt, values),
      "Recent post history to avoid repeating:",
      historyContext,
      "Performance memory to exploit:",
      performanceContext,
      "Hard constraints:",
      "- Base the post on the PRIMARY CONTENT INPUT only. RSS is context, not a script.",
      "- Do not repeat recent post wording, topic angle, structure, or conclusion.",
      "- Do not include URLs or links in the post.",
      ...growthSourceRequirements(contentType),
      growthFewShotExamples(language, contentType),
      ...growthPromptRules(language, contentFormat),
      ...hashtagRules,
    ].join("\n");
  }

  return [
    `Write one fresh X post in ${language}.`,
    `Topic lane: ${topic}.`,
    "Hybrid content context:",
    newsContext,
    "Recent post history to avoid repeating:",
    historyContext,
    "Performance memory to exploit:",
    performanceContext,
    "Style:",
    style,
    "Rules:",
    "- Return only the final post text.",
    "- Stay under 280 characters including hashtags.",
    "- Sound like a sharp human operator, not a brand account and not an AI assistant.",
    "- Base the post on the PRIMARY CONTENT INPUT only. Do not summarize multiple stories.",
    "- Give one clear opinion or takeaway for the target tech audience.",
    "- No generic hype words, no emoji unless essential.",
    ...growthSourceRequirements(contentType),
    growthFewShotExamples(language, contentType),
    ...growthPromptRules(language, contentFormat),
    ...hashtagRules,
    "- Do not include URLs or links in the post.",
  ].join("\n");
}

function sanitizeImageQuery(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/["'`]/g, "")
    .split("\n")[0]
    .replace(/^[\s\-:]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function imageFileName(contentType) {
  if (contentType.includes("png")) return "tweet-image.png";
  return "tweet-image.jpg";
}

function xMediaAppendUrl(mediaId) {
  return `https://api.x.com/2/media/upload/${mediaId}/append`;
}

function xMediaFinalizeUrl(mediaId) {
  return `https://api.x.com/2/media/upload/${mediaId}/finalize`;
}

function normalizeImageMediaType(contentType) {
  const mediaType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!mediaType.startsWith("image/")) {
    throw new Error(`Unsupported image media type: ${contentType || "unknown"}`);
  }
  return mediaType;
}

function parseOAuthScopes(scopeValue) {
  return String(scopeValue || "").split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

function logOAuthScopes(scopeValue, label) {
  const scopes = parseOAuthScopes(scopeValue);
  console.log(`${label}: ${scopes.join(" ")}`);
  return scopes;
}

function localImageSearchQuery({ tweet, newsContext, topic }) {
  const haystack = `${tweet || ""} ${newsContext || ""} ${topic || ""}`.toLowerCase();
  const rules = [
    {
      pattern: /(security|cyber|privacy|breach|cve|漏洞|安全|隐私)/i,
      query: "cybersecurity lock server room",
    },
    {
      pattern: /(chip|gpu|nvidia|semiconductor|hardware|wafer|芯片|半导体|硬件)/i,
      query: "semiconductor chip wafer data center",
    },
    {
      pattern: /(robot|robotics|automation|机器人|自动化)/i,
      query: "robotics lab automation",
    },
    {
      pattern: /(ios|iphone|ipad|apple|mobile|app store|手机|移动端)/i,
      query: "smartphone app developer desk",
    },
    {
      pattern: /(cloud|server|api|platform|infrastructure|aws|azure|cloudflare|vercel|云|平台|基础设施)/i,
      query: "data center server racks",
    },
    {
      pattern: /(coding|developer|devtools|github|cursor|ide|code|programming|开发|编程|工程师)/i,
      query: "developer laptop coding workspace",
    },
    {
      pattern: /(ai|llm|model|agent|openai|anthropic|gemini|deepmind|claude|人工智能|模型|代理)/i,
      query: "artificial intelligence data center",
    },
    {
      pattern: /(startup|funding|founder|producthunt|创业|融资)/i,
      query: "startup office laptop",
    },
  ];

  const matched = rules.find((rule) => rule.pattern.test(haystack));
  return matched?.query || "modern technology workspace";
}

async function generateImageQuery({ tweet, newsContext, topic }) {
  const queryMode = optionalEnv("TWEET_IMAGE_SEARCH_QUERY_MODE", "local").toLowerCase();
  if (queryMode !== "ai") {
    const configured = optionalEnv("TWEET_IMAGE_SEARCH_QUERY");
    const query = sanitizeImageQuery(
      configured || localImageSearchQuery({ tweet, newsContext, topic }),
    );
    if (!query) throw new Error("Local image search query was empty");
    console.log(`Pexels search query (${queryMode}): ${query}`);
    return query;
  }

  const customPrompt = optionalEnv("TWEET_IMAGE_SEARCH_PROMPT", DEFAULT_IMAGE_SEARCH_USER_PROMPT);
  const prompt = [
    interpolatePrompt(customPrompt, { tweet, news: newsContext, topic }),
    "Tweet:",
    tweet,
    "Return only 3 to 5 English search keywords on one line. No explanation.",
  ].join("\n");

  const { response, data } = await callOpenAIChat({
    purpose: "image_search_query",
    messages: [
      {
        role: "system",
        content: optionalEnv("TWEET_IMAGE_SEARCH_SYSTEM_PROMPT", DEFAULT_IMAGE_SEARCH_SYSTEM_PROMPT),
      },
      { role: "user", content: prompt },
    ],
  });

  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI image search query failed (${response.status})`);
  }

  const query = sanitizeImageQuery(data?.choices?.[0]?.message?.content);
  if (!query) throw new Error("OpenAI returned an empty image search query");
  console.log(`Pexels search query: ${query}`);
  return query;
}

async function searchPexelsImage(query) {
  const apiKey = requireEnv("PEXELS_API_KEY");
  const results = integerEnv("TWEET_IMAGE_SEARCH_RESULTS", 8, 1, 20);
  const orientation = optionalEnv("TWEET_IMAGE_ORIENTATION", "landscape");
  const url = new URL(PEXELS_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(results));
  url.searchParams.set("orientation", orientation);

  const response = await fetch(url, {
    headers: { Authorization: apiKey, Accept: "application/json", "User-Agent": "x-bot-github-actions/1.0" },
  });

  const data = await response.json().catch(() => ({}));
  const photos = Array.isArray(data.photos) ? data.photos : [];
  const candidates = photos.filter((photo) => photo?.src?.large || photo?.src?.large2x);

  if (!candidates.length) throw new Error(`No photos for query: ${query}`);
  const photo = candidates[0];
  console.log(`Selected Pexels photo by ${photo.photographer || "unknown"} (top relevance match).`);
  return { url: photo.src.large2x || photo.src.large || photo.src.original, photographer: photo.photographer || "unknown" };
}

async function downloadImage(url) {
  const timeoutMs = integerEnv("TWEET_IMAGE_FETCH_TIMEOUT_MS", 10000, 1000, 30000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: "image/jpeg,image/png,image/*,*/*", "User-Agent": "x-bot-github-actions/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status}`);

    const contentType = response.headers.get("content-type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

// 优化 1：彻底去掉了 STATUS 轮询调用。对静态图片而言，FINALIZE 执行完即可用，免除多余扣费。
async function uploadTweetImage(accessToken, image) {
  const mediaType = normalizeImageMediaType(image.contentType);

  // 1. INITIALIZE
  const initResponse = await xFetch("MEDIA_INITIALIZE", X_MEDIA_INIT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ media_type: mediaType, total_bytes: image.bytes.byteLength, media_category: "tweet_image" }),
  });
  const initData = await initResponse.json().catch(() => ({}));
  const mediaId = initData?.data?.id || initData?.media_id_string;
  if (!mediaId) throw new Error("X media initialize did not return a media id");

  // 2. APPEND
  const appendForm = new FormData();
  appendForm.set("segment_index", "0");
  appendForm.set("media", new Blob([image.bytes], { type: mediaType }), imageFileName(mediaType));

  const appendResponse = await xFetch("MEDIA_APPEND", xMediaAppendUrl(mediaId), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: appendForm,
  });
  if (!appendResponse.ok) throw new Error("X media append failed");

  // 3. FINALIZE
  const finalizeResponse = await xFetch("MEDIA_FINALIZE", xMediaFinalizeUrl(mediaId), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!finalizeResponse.ok) throw new Error("X media finalize failed");

  return mediaId;
}

async function prepareTweetImage(
  { tweet, newsContext, topic },
  accessToken,
  { attachImage = false } = {},
) {
  if (!attachImage) return null;

  try {
    const query = await generateImageQuery({ tweet, newsContext, topic });
    const photo = await searchPexelsImage(query);
    const image = await downloadImage(photo.url);
    return await uploadTweetImage(accessToken, image);
  } catch (error) {
    console.warn(`Image attachment skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function tweetCandidateCount() {
  return integerEnv("TWEET_CANDIDATE_COUNT", 4, 1, 5);
}

function candidateJsonPrompt({
  customPrompt,
  language,
  topic,
  now,
  style,
  newsContext,
  historyContext,
  performanceContext,
  contentFormats,
  contentType = "news_take",
}) {
  const formatList = contentFormats
    .map((format, index) => `${index + 1}. ${format.id}: ${format.instruction}`)
    .join("\n");
  const growthRequirements = growthSourceRequirements(contentType);
  const hashtagRules = hashtagPromptRules();
  const values = {
    news: newsContext,
    topic,
    language,
    now,
    style,
    history: historyContext,
    performance: performanceContext,
  };
  const baseRules = [
    `Write competing X post candidates in ${language}.`,
    `Topic lane: ${topic}.`,
    `Current time: ${now}.`,
    "Hybrid content context:",
    newsContext,
    "Recent post history to avoid repeating:",
    historyContext,
    "Performance memory to exploit:",
    performanceContext,
    "Style:",
    style,
    customPrompt ? `Custom prompt:\n${interpolatePrompt(customPrompt, values)}` : null,
    "Hard rules:",
    "- Base every candidate on the PRIMARY CONTENT INPUT only.",
    "- Do not summarize multiple stories.",
    "- Do not include URLs or links.",
    "- Stay under 280 characters including hashtags.",
    "- Sound like a sharp human operator, not a brand account and not an AI assistant.",
    "- Give one clear opinion or takeaway for the target tech audience.",
    "- At least one candidate must be a practical playbook or decision rule for tech readers, not only developers.",
    "- Every candidate needs a follow-worthy reason: sharper judgment, saved time, user impact, business impact, or a useful operating rule.",
    "- No generic hype words, no emoji unless essential.",
    ...growthRequirements,
    growthFewShotExamples(language, contentType),
    ...growthPromptRules(language, contentFormats[0]),
    ...hashtagRules,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    baseRules,
    "",
    "Generate multiple competing candidates before choosing.",
    "Available content formats:",
    formatList,
    "Return JSON only with this shape:",
    '{"candidates":[{"text":"final tweet text","formatId":"one format id above","angle":"short angle","reason":"why this can earn reposts/replies"}]}',
    `Return exactly ${contentFormats.length} candidates. Each candidate must use a different formatId when possible.`,
    "Each text must be publishable as-is, under 280 characters including hashtags, with no URL.",
  ].join("\n");
}

function parseTweetCandidateJson(content, fallbackFormats) {
  try {
    const parsed = JSON.parse(String(content || "").trim());
    const rawCandidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.candidates)
        ? parsed.candidates
        : Array.isArray(parsed.posts)
          ? parsed.posts
          : [];
    return rawCandidates
      .map((candidate, index) => {
        const fallbackFormat = fallbackFormats[index % fallbackFormats.length];
        const text = typeof candidate === "string"
          ? candidate
          : candidate.text || candidate.tweet || candidate.post || "";
        return {
          text: trimTweet(text),
          templateId: String(
            (typeof candidate === "object" && candidate
              ? candidate.formatId || candidate.templateId
              : "") || fallbackFormat.id,
          ),
          angle: String((typeof candidate === "object" && candidate?.angle) || "").trim(),
          reason: String((typeof candidate === "object" && (candidate.reason || candidate.rationale)) || "").trim(),
        };
      })
      .filter((candidate) => candidate.text);
  } catch {
    return [];
  }
}

function localPolicyFallbackEnabled() {
  return isTruthy(optionalEnv("TWEET_LOCAL_POLICY_FALLBACK_ENABLED", "true"));
}

function localPolicySeedEnabled() {
  return isTruthy(optionalEnv("TWEET_LOCAL_POLICY_SEED_ENABLED", "true"));
}

function compactLocalStorySubject(title, source) {
  const text = String(title || "");
  const haystack = `${text} ${source || ""}`;
  const entityMatch = haystack.match(
    /\b(OpenAI|Anthropic|Claude|Gemini|DeepMind|Nvidia|Cursor|GitHub|Vercel|Cloudflare|Apple|Google|Microsoft|Meta|Amazon|Tesla|iPhone|Android|YouTube|TikTok|Paramount|Reddit|Stripe|AWS)\b/i,
  );
  const entity = entityMatch
    ? entityMatch[1].replace(/^aws$/i, "AWS").replace(/^iphone$/i, "iPhone")
    : "";
  const categoryRules = [
    { pattern: /(agent|tooling|workflow|automation|developer|coding|代码|开发|工具)/i, label: "agent tooling" },
    { pattern: /(model|llm|ai|人工智能|模型)/i, label: "AI model cycle" },
    { pattern: /(cloud|server|api|platform|infrastructure|云|平台|基础设施)/i, label: "cloud platform shift" },
    { pattern: /(security|privacy|breach|auth|cve|安全|隐私|漏洞)/i, label: "security boundary" },
    { pattern: /(chip|gpu|semiconductor|hardware|芯片|硬件|半导体)/i, label: "hardware cycle" },
    { pattern: /(app|iphone|android|mobile|consumer|用户|应用|手机)/i, label: "consumer app shift" },
    { pattern: /(startup|funding|founder|launch|product hunt|创业|融资|发布)/i, label: "startup launch" },
    { pattern: /(judge|law|policy|regulator|court|antitrust|privacy|政策|监管|法院)/i, label: "platform policy" },
  ];
  const category = categoryRules.find((rule) => rule.pattern.test(haystack))?.label || "tech shift";
  if (entity) return `${entity} ${category}`;
  if (/sspai\.com/i.test(source)) return "少数派 App 工具推荐";
  if (/producthunt/i.test(source)) return "Product Hunt launch";
  if (/hacker|hnrss|news\.ycombinator/i.test(source)) return "Hacker News thread";
  if (/bbc|feeds\.bbci/i.test(source)) return "BBC tech segment";
  return "";
}

function localStorySubject(story) {
  const source = String(story?.source || "").replace(/^www\./i, "");
  const title = String(story?.title || "this tech shift")
    .replace(/\s*[-–—|:]\s*(TechCrunch|The Verge|WIRED|Ars Technica|BBC|NYTimes|Guardian|Engadget|CNET)\s*$/i, "")
    .replace(/^(派评\s*[|｜]\s*|Tech Now\s*[:：-]?\s*)/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const genericTitle = !title ||
    /^(tech now|近期值得关注的 app|worth watching|latest apps?|weekly roundup|headlines?)$/i.test(title) ||
    /^(近期值得关注的\s*App|科技新闻|每日新闻|头条)$/i.test(title);
  if (genericTitle) {
    if (/sspai\.com/i.test(source)) return "少数派 App 工具推荐";
    if (/bbc|feeds\.bbci/i.test(source)) return "BBC tech segment";
    if (/producthunt/i.test(source)) return "this Product Hunt launch";
    if (/hacker|hnrss|news\.ycombinator/i.test(source)) return "this Hacker News thread";
    if (source) return `${source} story`;
    return "this tech shift";
  }
  const compactSubject = compactLocalStorySubject(title, source);
  if (compactSubject) return compactSubject;
  const words = title.split(/\s+/);
  if (words.length <= 4 && countCharacters(title) <= 38) return title;
  return source ? `${source} story` : words.slice(0, 5).join(" ");
}

function localFallbackSubjectLabel({ subject, story, language }) {
  const source = String(story?.source || "").replace(/^www\./i, "");
  const isZh = language?.code === "zh";
  const clean = String(subject || "").replace(/\s+/g, " ").trim();
  if (!clean) return isZh ? "这次技术变化" : "this tech shift";
  if (isZh && /[A-Za-z][A-Za-z0-9+.-]+\s+[A-Za-z]/.test(clean) && countCharacters(clean) > 44) {
    return source ? `${source} 这次变化` : "这次技术变化";
  }
  if (!isZh && /[\u4e00-\u9fff]/.test(clean) && countCharacters(clean) > 60) {
    return source ? `${source} story` : "this tech shift";
  }
  return clean;
}

function localFallbackTweetBody({ subject, story = null, language, formatId }) {
  const isZh = language?.code === "zh";
  const label = localFallbackSubjectLabel({ subject, story, language });
  const id = formatId || "decision_rule";
  if (isZh) {
    const templates = {
      not_x_but_y: `${label} 不是功能清单，而是默认入口争夺。谁掌握权限、预算和回滚，谁更接近真正的平台层。`,
      decision_rule: `先别急着迁移到 ${label}。拿一个真实流程测三件事：是否更快、是否可回滚、是否会改变默认入口。只改善演示就先等。`,
      operator_pain: `${label} 带来的不是少点工作，而是新一轮运维账：默认设置、权限、预算、回滚、支持压力都要重新过一遍。`,
      contrarian_cost: `${label} 的隐藏成本不在订阅费，而在迁移摩擦。工具越像默认入口，团队越要先算权限、回滚和支持成本。`,
      sharp_question: `${label} 真正值得问的是：它让操作者少做一步，还是把成本藏进提示词、权限和回滚里？`,
      playbook: `看 ${label}，别先看发布文案。选一个真实流程，测速度、失败率、回滚成本；三项都过，再考虑变成默认。`,
      second_order: `${label} 的二阶影响不在功能本身，而在谁会变成新的默认入口。默认一迁移，分发和预算都会跟着动。`,
      prediction: `${label} 如果真的重要，第一周就会改变默认流程；如果只让演示更好看，很快会被团队丢回待办清单。`,
      brutal_truth: `${label} 真正值钱的不是发布，而是谁先改默认流程。功能清单只是噪音。`,
      massive_value_drop: `${label} 先别迁移。拿一个真实流程测速度、失败率和回滚；三项不过，就别交智商税。`,
      myth_busting: `别信 ${label} 会让你少干活。多数人看错了：它把成本藏进权限、提示词和回滚里。`,
      the_hard_way: `${label} 我交过学费：演示好看、线上卡回滚。下次先测真实流程，再决定要不要变成默认。`,
    };
    return templates[id] || templates.decision_rule;
  }

  const templates = {
    not_x_but_y: `${label} is not a feature race. It is a default-workflow test: whoever owns permissions, rollback, and budget becomes the real platform.`,
    decision_rule: `Do not migrate to ${label} because the demo looks better. Test one real workflow first: speed, rollback, and default behavior. If only the demo improves, wait.`,
    operator_pain: `${label} creates a new operator job: retune defaults, permissions, budgets, rollback, and support before anyone gets faster.`,
    contrarian_cost: `The hidden cost of ${label} is migration churn. The more it wants to become a default, the more teams need rollback, permission, and support budgets.`,
    sharp_question: `${label} has one useful question: does it remove operator work, or just hide that work inside prompts, permissions, budgets, and rollback plans?`,
    playbook: `Before adopting ${label}, ignore the launch copy. Test one real workflow, measure rollback cost, then decide whether it deserves to become a default.`,
    second_order: `The second-order effect of ${label}: the winner is not the flashiest feature, but the product that quietly becomes the default distribution path.`,
    prediction: `${label} will matter if teams stop configuring something manually after week one. If it only makes demos cleaner, it will stay optional.`,
    brutal_truth: `${label} is not the product. The product is whoever owns the default workflow after week one.`,
    massive_value_drop: `Before adopting ${label}, test one real workflow: speed, failure rate, rollback. If any fail, do not pay the tax.`,
    myth_busting: `The myth around ${label}: it saves work. The 10% truth: it hides work in prompts, permissions, and rollback.`,
    the_hard_way: `Hard lesson on ${label}: the demo was free, the rollback was not. Next time, measure one real workflow before it becomes default.`,
  };
  return templates[id] || templates.decision_rule;
}

function buildLocalPolicyTweetCandidates({
  story = null,
  language = null,
  contentFormats = [],
  cachedGenerationPolicy = null,
} = {}) {
  if (!localPolicyFallbackEnabled() && !localPolicySeedEnabled()) return [];
  const formatsById = new Map((contentFormats || []).map((format) => [format.id, format]));
  const formatIds = uniqueStrings(
    [
      cachedGenerationPolicy?.primaryFormatId,
      ...(cachedGenerationPolicy?.rankedFormatIds || []),
      ...(contentFormats || []).map((format) => format.id),
    ],
    2,
  ).filter((id) => formatsById.has(id) || id);
  const subject = localStorySubject(story);
  return formatIds.map((formatId, index) => ({
    text: trimTweet(localFallbackTweetBody({ subject, story, language, formatId })),
    templateId: formatId || contentFormats[index % Math.max(1, contentFormats.length)]?.id || "decision_rule",
    angle: cachedGenerationPolicy?.hookPattern?.label || "cached policy local seed",
    reason: index === 0
      ? "local cached policy candidate for OpenAI fallback and ranker calibration"
      : "local cached policy exploration candidate",
    generationSource: "local_cached_policy",
  })).filter((candidate) => candidate.text);
}

function textSimilarity(left, right) {
  const leftTokens = new Set(tokenizeTitle(left));
  const rightTokens = new Set(tokenizeTitle(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function formulaicGrowthTemplateOpening(text) {
  const firstLine = String(text || "").trim().split(/\n/)[0] || "";
  return /^(decision rule for|playbook for)\b/i.test(firstLine) ||
    /^the hidden cost of .{42,}:/i.test(firstLine) ||
    /( 的判断标准很简单|真正的问题是：它减少了操作成本|raises the real question: does this reduce operator work)/i.test(firstLine);
}

function headlineFrameSimilarity(text, story) {
  const firstLine = String(text || "").trim().split(/\n/)[0] || "";
  return Math.max(
    textSimilarity(firstLine, story?.title || ""),
    textSimilarity(String(text || ""), story?.title || ""),
  );
}

function storySpecificityScore(text, story) {
  const titleTokens = tokenizeTitle(story?.title || "").slice(0, 8);
  if (!titleTokens.length) return 0;
  const lower = String(text || "").toLowerCase();
  const hits = titleTokens.filter((token) => lower.includes(token.toLowerCase())).length;
  return Math.min(8, hits * 2);
}

function mutationFormatIds(value) {
  const text = String(value || "").toLowerCase();
  const ids = new Set();
  for (const id of Object.keys(ANGLE_LIBRARY)) {
    if (text.includes(id.toLowerCase()) || text.includes(compactBucketName(id).toLowerCase())) {
      ids.add(id);
    }
  }
  return ids;
}

function scoreAngleMutationCompliance(candidate, { story = null, angleMutationReactor = null } = {}) {
  if (!angleMutationReactor?.mutations?.length) return { delta: 0, reasons: [] };
  const reasons = [];
  let delta = 0;
  const candidateFormat = String(candidate.templateId || "").toLowerCase();
  const text = `${candidate.angle || ""} ${candidate.reason || ""} ${candidate.text || ""}`.toLowerCase();
  const primary = angleMutationReactor.primaryMutation || angleMutationReactor.mutations.find((mutation) => mutation?.id === "prompt_rule") || null;
  const preferredIds = mutationFormatIds(primary?.after);
  const temporal = angleMutationReactor.mutations.find((mutation) => mutation?.id === "temporal_bias");
  for (const id of mutationFormatIds(temporal?.after)) preferredIds.add(id);

  if (preferredIds.has(candidateFormat)) {
    delta += angleMutationReactor.severity === "ok" ? 10 : 7;
    reasons.push("mutation primary format");
  } else if (preferredIds.size && angleMutationReactor.severity === "ok") {
    delta -= 3;
    reasons.push("missed mutation format");
  }

  const keywordHits = [...preferredIds]
    .flatMap((id) => ANGLE_LIBRARY[id]?.keywords || [])
    .filter((keyword) => keyword && text.includes(String(keyword).toLowerCase()))
    .slice(0, 4);
  if (keywordHits.length) {
    delta += Math.min(8, keywordHits.length * 2);
    reasons.push("mutation keyword");
  }

  const holdGate = angleMutationReactor.mutations.find((mutation) => mutation?.id === "hold_gate");
  const heldIds = mutationFormatIds(holdGate?.after);
  if (heldIds.has(candidateFormat)) {
    delta -= 10;
    reasons.push("mutation hold gate");
  }

  const sourceTopic = angleMutationReactor.mutations.find((mutation) => mutation?.id === "source_topic_bias");
  const sourceTopicText = String(sourceTopic?.after || "").toLowerCase();
  const storySource = String(story?.source || "").toLowerCase();
  const storyTitle = String(story?.title || "").toLowerCase();
  if (sourceTopicText && storySource && sourceTopicText.includes(storySource)) {
    delta += 3;
    reasons.push("mutation source match");
  }
  if (sourceTopicText && tokenizeTitle(sourceTopicText).some((token) => token.length > 2 && storyTitle.includes(token.toLowerCase()))) {
    delta += 3;
    reasons.push("mutation topic match");
  }

  if (/headline recap|generic optimism|unsupported claims|outrage bait/i.test(text)) {
    delta -= 6;
    reasons.push("mutation guardrail risk");
  }

  return {
    delta: Number(delta.toFixed(1)),
    reasons,
  };
}

function scoreHookPatternCompliance(candidate, { hookPatternReactor = null } = {}) {
  const classification = classifyHookPattern(candidate?.text || "");
  if (!hookPatternReactor?.patterns?.length) {
    return { delta: 0, reasons: [], classification };
  }

  const ids = new Set(classification.patternIds || []);
  const recommended = hookPatternReactor.recommendedPattern || null;
  const avoidIds = new Set((hookPatternReactor.avoidPatterns || []).map((pattern) => pattern.id));
  let delta = 0;
  const reasons = [];

  if (recommended?.id) {
    if (ids.has(recommended.id)) {
      delta += recommended.status === "exploit" ? 10 : 7;
      reasons.push("hook reactor primary");
    } else {
      delta -= hookPatternReactor.confidence === "high" ? 5 : 3;
      reasons.push("missed hook reactor");
    }
  }

  const avoided = [...ids].filter((id) => avoidIds.has(id) || id === "weak_recap");
  if (avoided.length) {
    delta -= avoided.includes("weak_recap") ? 12 : 8;
    reasons.push(`avoid hook ${avoided.join(",")}`);
  }

  if (classification.firstLine && countCharacters(classification.firstLine) <= 105) {
    delta += 2;
    reasons.push("compact first line");
  }

  return {
    delta: Number(delta.toFixed(1)),
    reasons,
    classification,
  };
}

function scoreContentBanditCompliance(candidate, { contentBanditAllocator = null } = {}) {
  if (!contentBanditAllocator?.lanes?.length) return { delta: 0, reasons: [] };
  const lane = contentBanditAllocator.lanes.find((item) => item.id === candidate?.templateId) || null;
  if (!lane) return { delta: 0, reasons: [] };
  let delta = 0;
  const reasons = [];
  if (lane.status === "exploit") {
    delta += 9;
    reasons.push("bandit exploit lane");
  } else if (lane.status === "explore") {
    delta += 5;
    reasons.push("bandit exploration lane");
  } else if (lane.status === "hold") {
    delta -= 10;
    reasons.push("bandit hold lane");
  } else {
    delta += 2;
    reasons.push("bandit rotation lane");
  }
  delta += Math.min(6, Math.max(0, Number(lane.allocationPct) || 0) / 12);
  return {
    delta: Number(delta.toFixed(1)),
    reasons,
  };
}

function scoreAngleLoadRouterCompliance(candidate, { angleLoadRouter = null } = {}) {
  if (!angleLoadRouter) return { delta: 0, reasons: [] };
  const templateId = candidate?.templateId;
  if (!templateId) return { delta: 0, reasons: [] };
  let delta = 0;
  const reasons = [];
  const active = angleLoadRouter.activeSlot || null;
  if (active?.formatId === templateId) {
    delta += active.status === "hot" ? 11 : active.status === "watch" ? 8 : 5;
    reasons.push("angle load active slot");
  }
  const lane = (angleLoadRouter.lanes || []).find((item) => (item.formatId || item.id) === templateId) || null;
  if (lane) {
    if (lane.status === "hot") {
      delta += 8;
      reasons.push("angle load hot lane");
    } else if (lane.status === "watch") {
      delta += 5;
      reasons.push("angle load watch lane");
    } else if (lane.status === "hold") {
      delta -= 7;
      reasons.push("angle load hold lane");
    } else {
      delta += 2;
      reasons.push("angle load probe lane");
    }
    delta += Math.min(4, Math.max(0, Number(lane.loadScore) || 0) / 25);
  }
  return {
    delta: Number(delta.toFixed(1)),
    reasons,
  };
}

function scoreNarrativeResonanceCompliance(candidate, { story = null, narrativeResonanceController = null } = {}) {
  const classification = primaryNarrativePillar({
    text: candidate?.text || "",
    angle: candidate?.angle || "",
    candidateReason: candidate?.reason || "",
    title: story?.title || "",
    summary: story?.summary || "",
    source: story?.source || "",
  });
  if (!narrativeResonanceController?.pillars?.length) {
    return { delta: 0, reasons: [], classification };
  }
  const pillar = narrativeResonanceController.pillars.find((item) => item.id === classification.id) || null;
  const primary = narrativeResonanceController.primaryPillar || null;
  const text = `${candidate?.text || ""} ${candidate?.angle || ""} ${candidate?.reason || ""}`.toLowerCase();
  let delta = 0;
  const reasons = [];

  if (primary?.id && classification.id === primary.id) {
    delta += primary.status === "exploit" ? 11 : primary.status === "expand" ? 9 : 6;
    reasons.push("narrative primary");
  } else if (primary?.id && narrativeResonanceController.severity === "ok") {
    delta -= 3;
    reasons.push("missed narrative primary");
  }

  if (pillar) {
    if (pillar.status === "exploit") {
      delta += 5;
      reasons.push("narrative exploit lane");
    } else if (pillar.status === "expand") {
      delta += 4;
      reasons.push("narrative expansion lane");
    } else if (pillar.status === "hold") {
      delta -= 8;
      reasons.push("narrative hold lane");
    } else {
      delta += 2;
      reasons.push("narrative rotation lane");
    }
    delta += Math.min(5, (Number(pillar.score) || 0) / 22);
  }

  const lexiconHits = (classification.lexicon || []).filter((word) => text.includes(String(word).toLowerCase())).length;
  if (lexiconHits) {
    delta += Math.min(6, lexiconHits * 1.6);
    reasons.push("account lexicon");
  }

  if (/(operator|workflow|default|distribution|risk|margin|lock-in|tradeoff|decision rule|operating rule|成本|默认|分发|风险|权衡|规则)/i.test(text)) {
    delta += 4;
    reasons.push("durable account memory");
  }

  if (/^(today|breaking|according to|近日|据报道|新闻|消息)\b/i.test(String(candidate?.text || "").trim())) {
    delta -= 6;
    reasons.push("weak narrative recap");
  }

  return {
    delta: Number(delta.toFixed(1)),
    reasons,
    classification,
  };
}

function scoreTopicTimingCompliance(candidate, { story = null, topicTimingRouter = null } = {}) {
  const classification = primaryNarrativePillar({
    text: candidate?.text || "",
    angle: candidate?.angle || "",
    candidateReason: candidate?.reason || "",
    title: story?.title || "",
    summary: story?.summary || "",
    source: story?.source || "",
  });
  if (!topicTimingRouter?.lanes?.length) {
    return { delta: 0, reasons: [], classification, lane: null };
  }

  const templateId = candidate?.templateId;
  const active = topicTimingRouter.activeLane || null;
  const lane =
    (topicTimingRouter.lanes || []).find((item) => item.formatId === templateId && item.pillarId === classification.id) ||
    (topicTimingRouter.lanes || []).find((item) => item.formatId === templateId) ||
    (topicTimingRouter.lanes || []).find((item) => item.pillarId === classification.id) ||
    null;
  let delta = 0;
  const reasons = [];

  if (active) {
    if (active.formatId === templateId && active.pillarId === classification.id) {
      delta += active.status === "hot" ? 13 : 10;
      reasons.push("topic timing active lane");
    } else if (active.pillarId === classification.id) {
      delta += 6;
      reasons.push("topic timing pillar");
    } else if (active.formatId === templateId) {
      delta += 4;
      reasons.push("topic timing format");
    } else if (topicTimingRouter.severity === "ok") {
      delta -= 3;
      reasons.push("missed timing lane");
    }
  }

  if (lane) {
    if (lane.status === "hot") {
      delta += 7;
      reasons.push("topic timing hot lane");
    } else if (lane.status === "watch") {
      delta += 5;
      reasons.push("topic timing watch lane");
    } else if (lane.status === "seed") {
      delta += 2;
      reasons.push("topic timing seed lane");
    } else if (lane.status === "probe") {
      delta += 1;
      reasons.push("topic timing probe lane");
    }
    delta += Math.min(5, Math.max(0, Number(lane.score) || 0) / 24);
    if (lane.observed) {
      delta += 2;
      reasons.push("observed timing sample");
    }
  }

  return {
    delta: Number(delta.toFixed(1)),
    reasons,
    classification,
    lane,
  };
}

function scoreGrowthOpportunityCompliance(candidate, { story = null, growthOpportunityScorer = null } = {}) {
  const classification = primaryNarrativePillar({
    text: candidate?.text || "",
    angle: candidate?.angle || "",
    candidateReason: candidate?.reason || "",
    title: story?.title || "",
    summary: story?.summary || "",
    source: story?.source || "",
  });
  if (!growthOpportunityScorer?.lanes?.length) {
    return { delta: 0, reasons: [], classification, lane: null };
  }

  const templateId = candidate?.templateId;
  const active = growthOpportunityScorer.activeOpportunity || null;
  const lane =
    (growthOpportunityScorer.lanes || []).find((item) => item.formatId === templateId && item.pillarId === classification.id) ||
    (growthOpportunityScorer.lanes || []).find((item) => item.formatId === templateId) ||
    (growthOpportunityScorer.lanes || []).find((item) => item.pillarId === classification.id) ||
    null;
  let delta = 0;
  const reasons = [];

  if (active) {
    if (active.formatId === templateId && active.pillarId === classification.id) {
      delta += active.status === "hot" ? 12 : 9;
      reasons.push("opportunity active lane");
    } else if (active.formatId === templateId) {
      delta += 6;
      reasons.push("opportunity format");
    } else if (active.pillarId === classification.id) {
      delta += 5;
      reasons.push("opportunity narrative");
    } else if (growthOpportunityScorer.confidence === "high" && active.score >= 76) {
      delta -= 3;
      reasons.push("missed active opportunity");
    }
  }

  if (lane) {
    delta += Math.min(7, Math.max(0, Number(lane.score) || 0) / 15);
    if ((lane.sources || []).length >= 3) {
      delta += 4;
      reasons.push("multi-signal opportunity");
    } else if ((lane.sources || []).length >= 2) {
      delta += 2;
      reasons.push("two-signal opportunity");
    }
    if (lane.status === "hot") {
      delta += 4;
      reasons.push("hot opportunity lane");
    }
  }

  return {
    delta: Number(delta.toFixed(1)),
    reasons,
    classification,
    lane,
  };
}

function policyKeywordSet(...values) {
  const stop = new Set([
    "with",
    "this",
    "that",
    "from",
    "into",
    "only",
    "format",
    "story",
    "selected",
    "primary",
    "unless",
    "strongly",
    "listed",
    "reader",
    "today",
    "score",
    "sources",
  ]);
  const keywords = new Set();
  for (const value of values) {
    for (const token of String(value || "").toLowerCase().split(/[^a-z0-9]+/i)) {
      if (token.length < 4 || stop.has(token)) continue;
      keywords.add(token);
      if (keywords.size >= 14) return keywords;
    }
  }
  return keywords;
}

function scoreCachedGenerationPolicyCompliance(candidate, { cachedGenerationPolicy = null } = {}) {
  if (!cachedGenerationPolicy) return { delta: 0, reasons: [] };
  const text = String(candidate?.text || "");
  const haystack = `${candidate?.angle || ""} ${candidate?.reason || ""} ${text}`.toLowerCase();
  const firstLine = text.split(/\n/)[0] || text;
  const templateId = candidate?.templateId || candidate?.formatId || "";
  const primaryFormatId = cachedGenerationPolicy.primaryFormatId || "";
  const ranked = new Set(cachedGenerationPolicy.rankedFormatIds || []);
  const avoid = new Set(cachedGenerationPolicy.avoidFormatIds || []);
  const reasons = [];
  let delta = 0;

  if (primaryFormatId && templateId === primaryFormatId) {
    delta += 10;
    reasons.push("policy primary format");
  } else if (templateId && ranked.has(templateId)) {
    delta += 4;
    reasons.push("policy ranked format");
  } else if (primaryFormatId && templateId) {
    delta -= 3;
    reasons.push("missed policy primary");
  }

  if (templateId && avoid.has(templateId)) {
    delta -= 16;
    reasons.push("policy avoided format");
  }

  const hookId = cachedGenerationPolicy.hookPattern?.id || "";
  if (hookId) {
    const hook = classifyHookPattern(text);
    if (hook.primaryId === hookId || hook.patternIds.includes(hookId)) {
      delta += 7;
      reasons.push("policy hook pattern");
    } else if (hookId !== "weak_recap") {
      delta -= 4;
      reasons.push("missed policy hook");
    }
  }

  const narrativeKeywords = policyKeywordSet(
    cachedGenerationPolicy.narrativePillar?.label,
    cachedGenerationPolicy.narrativePillar?.directive,
  );
  const narrativeHits = [...narrativeKeywords].filter((keyword) => haystack.includes(keyword)).slice(0, 3);
  if (narrativeHits.length) {
    delta += Math.min(4, narrativeHits.length * 1.5);
    reasons.push("policy narrative keywords");
  }

  const opportunityKeywords = policyKeywordSet(
    cachedGenerationPolicy.opportunity?.label,
    ...(cachedGenerationPolicy.opportunity?.promptDirectives || []),
  );
  const opportunityHits = [...opportunityKeywords].filter((keyword) => haystack.includes(keyword)).slice(0, 3);
  if (opportunityHits.length) {
    delta += Math.min(4, opportunityHits.length * 1.5);
    reasons.push("policy opportunity lane");
  }

  const directiveKeywords = policyKeywordSet(...(cachedGenerationPolicy.directives || []).slice(0, 5));
  const directiveHits = [...directiveKeywords].filter((keyword) => haystack.includes(keyword)).slice(0, 4);
  if (directiveHits.length >= 2) {
    delta += Math.min(5, directiveHits.length * 1.2);
    reasons.push("policy directive match");
  }

  if (/^(\s*(近日|据报道|新闻|消息|today|according to|breaking)\b)/i.test(firstLine)) {
    delta -= 6;
    reasons.push("policy blocks recap");
  }
  if (/https?:\/\//i.test(text)) {
    delta -= 10;
    reasons.push("policy blocks URL");
  }

  return {
    delta: Number(delta.toFixed(1)),
    reasons,
    directiveHits,
    narrativeHits,
    opportunityHits,
  };
}

function entityTokenHits(text, story = null) {
  const haystack = String(text || "").toLowerCase();
  const storyText = `${story?.title || ""} ${story?.summary || ""} ${story?.source || ""}`;
  const storyEntities = [
    ...String(storyText)
      .matchAll(/\b[A-Z][A-Za-z0-9+.-]{2,}(?:\s+[A-Z][A-Za-z0-9+.-]{2,}){0,3}\b/g),
  ].map((match) => match[0]);
  const knownEntities = [
    "openai",
    "anthropic",
    "claude",
    "gemini",
    "deepmind",
    "nvidia",
    "apple",
    "google",
    "microsoft",
    "meta",
    "amazon",
    "github",
    "cursor",
    "vercel",
    "cloudflare",
    "stripe",
    "tesla",
    "android",
    "iphone",
    "youtube",
    "tiktok",
    "aws",
    "llama",
    "mistral",
    "huggingface",
    "hugging face",
    "open-weight",
    "open weights",
    "open-weights",
  ];
  const entityHits = knownEntities.filter((entity) => haystack.includes(entity));
  for (const entity of storyEntities) {
    const normalized = entity.toLowerCase();
    if (normalized.length >= 3 && haystack.includes(normalized)) entityHits.push(normalized);
  }
  return uniqueStrings(entityHits, 8);
}

function viralHookGateEnabled() {
  return isTruthy(optionalEnv("TWEET_VIRAL_HOOK_GATE_ENABLED", "true"));
}

function viralHookGate(candidate, { story = null, language = null } = {}) {
  const text = String(candidate?.text || "");
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\n/)[0]?.trim() || trimmed;
  const firstLineChars = countCharacters(firstLine);
  const isZh = language?.code === "zh" || isChineseText(trimmed);
  const reasons = [];
  const warnings = [];
  let score = 0;

  if (!viralHookGateEnabled()) {
    return {
      allow: true,
      score: 0,
      reasons: ["viral hook gate disabled"],
      warnings: [],
      entityHits: [],
      firstLine,
      mode: "local_zero_api_viral_hook_gate",
    };
  }

  if (!trimmed) {
    return {
      allow: false,
      score: -50,
      reasons: ["empty"],
      warnings: [],
      entityHits: [],
      firstLine,
      mode: "local_zero_api_viral_hook_gate",
    };
  }

  if (firstLineChars >= (isZh ? 18 : 38) && firstLineChars <= (isZh ? 72 : 118)) {
    score += 14;
    reasons.push("compact standalone hook");
  } else if (firstLineChars > (isZh ? 92 : 145)) {
    score -= 14;
    warnings.push("long_first_line");
  } else {
    score -= 5;
    warnings.push("thin_first_line");
  }

  if (/(not .+ but |instead of|hidden cost|decision rule|the real question|if .+ then |when .+ do |default|tradeoff|workflow|distribution|lock-in|margin|risk|platform|operator|不是.+而是|隐藏成本|判断标准|真正的问题|默认|分发|风险|权衡|工作流|平台)/i.test(firstLine)) {
    score += 18;
    reasons.push("repostable hook frame");
  }

  if (/(why it matters|what happened|here's what|according to|today|breaking|launches?|announces?|reportedly|近日|据报道|消息称|发布了|推出了|值得关注)/i.test(firstLine)) {
    score -= 22;
    warnings.push("headline_or_media_frame");
  }

  const entities = entityTokenHits(trimmed, story);
  if (entities.length) {
    score += Math.min(12, 4 + entities.length * 2);
    reasons.push("concrete entity");
  } else {
    score -= isZh ? 4 : 9;
    warnings.push("missing_concrete_entity");
  }

  if (/(next|stop|start|switch|wait|measure|test|default|budget|pricing|privacy|security|workflow|distribution|rollback|permission|playbook|rule|checklist|先|别|停止|切换|测试|衡量|预算|权限|回滚|清单|规则|默认)/i.test(trimmed)) {
    score += 10;
    reasons.push("operator action");
  } else {
    warnings.push("missing_operator_action");
  }

  const titleSimilarity = textSimilarity(trimmed, story?.title || "");
  if (titleSimilarity >= 0.72) {
    score -= 24;
    warnings.push("headline_overlap");
  } else if (titleSimilarity <= 0.45) {
    score += 5;
    reasons.push("not headline recap");
  }

  if (/(AI is changing|future of AI|game.?changer|revolutionary|exciting|interesting|值得一看|可以关注|不可忽视|颠覆|震撼|重磅)/i.test(trimmed)) {
    score -= 18;
    warnings.push("generic_ai_slop");
  }

  const allow = score >= numberEnv("TWEET_VIRAL_HOOK_GATE_MIN_SCORE", 8, -50, 60) &&
    !warnings.includes("headline_overlap") &&
    !warnings.includes("headline_or_media_frame") &&
    !warnings.includes("generic_ai_slop");

  return {
    allow,
    score: Number(score.toFixed(1)),
    reasons,
    warnings,
    entityHits: entities,
    firstLine,
    mode: "local_zero_api_viral_hook_gate",
  };
}

function scoreTweetCandidate(candidate, {
  history,
  story,
  language,
  performanceInsights,
  angleMutationReactor = null,
  hookPatternReactor = null,
  contentBanditAllocator = null,
  angleLoadRouter = null,
  narrativeResonanceController = null,
  topicTimingRouter = null,
  growthOpportunityScorer = null,
  cachedGenerationPolicy = null,
  growthStrategy = null,
}) {
  const text = ensureTweetHashtags(candidate.text, story, language, performanceInsights);
  candidate = { ...candidate, text };
  const charCount = countCharacters(text);
  const isZh = language?.code === "zh";
  const firstLine = text.split(/\n/)[0] || text;
  let score = 50;
  const reasons = [];

  if (charCount <= MAX_TWEET_LENGTH) {
    score += 8;
  } else {
    score -= 50;
    reasons.push("too long");
  }

  const idealMin = isZh ? 55 : 120;
  const idealMax = isZh ? 150 : 240;
  if (charCount >= idealMin && charCount <= idealMax) {
    score += 8;
    reasons.push("tight length");
  } else if (charCount < idealMin) {
    score -= 4;
    reasons.push("short");
  }

  if (/不是.+(而是|是)|not .+ but |instead of/i.test(firstLine)) {
    score += 9;
    reasons.push("reframe hook");
  }
  if (/(接下来|下一步|未来|半年|一年|months?|默认|标配|default|standard|2026|2027)/i.test(text)) {
    score += 6;
    reasons.push("time-bound prediction");
  }
  if (formulaicGrowthTemplateOpening(text)) {
    score -= 28;
    reasons.push("formulaic growth template");
  }
  const headlineSimilarity = headlineFrameSimilarity(text, story);
  if (headlineSimilarity >= 0.62) {
    score -= 26;
    reasons.push("headline frame");
  }
  if (/(6[-–]12|6\s*(到|至|-)\s*12|six to twelve)/i.test(text)) {
    score -= 4;
    reasons.push("formulaic timeframe");
  }
  if (
    isZh
      ? /(建议|优先|先别|别急|该做|下一步|清单|框架|判断标准|检查|迁移|预算|复盘|团队|开发者|工程师|创业者|产品经理|负责人)/.test(text)
      : /\b(playbook|checklist|rule|framework|operators?|builders?|developers?|founders?|teams?|users?|creators?|investors?|consumers?|budget|pricing|privacy|platform|distribution|default|device|app|cloud|security|market)\b/i.test(text)
  ) {
    score += 8;
    reasons.push("practical takeaway");
  }
  if (/(：|:|一是|二是|三是|两件事|三件事|\bif\b.+\bthen\b|\bwhen\b.+\bdo\b)/i.test(text)) {
    score += 5;
    reasons.push("usable structure");
  }
  if (/[?？]$/.test(text.trim()) || /(真正的问题|the real question|what changes)/i.test(text)) {
    score += 4;
    reasons.push("reply path");
  }
  if (/^(\s*(近日|据报道|新闻|消息|today|according to|breaking)\b)/i.test(text)) {
    score -= 10;
    reasons.push("news recap opening");
  }
  if (/(值得关注|不容错过|重磅|震撼|颠覆|游戏规则|引爆|挑战和机遇|全新变革|主宰市场|超高效率|不可忽视|revolutionary|game.?changer|exciting news)/i.test(text)) {
    score -= 18;
    reasons.push("generic hype");
  }
  if (/(可能|也许|或许|值得一看|可以关注一下|\bmay\b|\bmight\b|\bperhaps\b|\binteresting\b)/i.test(text)) {
    score -= 5;
    reasons.push("weak hedge");
  }
  if (/https?:\/\//i.test(text)) {
    score -= 20;
    reasons.push("contains URL");
  }

  score += storySpecificityScore(text, story);

  const hashtags = extractHashtags(text);
  if (hashtags.length >= 1 && hashtags.length <= 3) {
    score += 4;
  } else if (isTruthy(optionalEnv("TWEET_HASHTAGS_ENABLED", "true"))) {
    score -= 4;
    reasons.push("hashtag count");
  }

  const maxHistorySimilarity = Math.max(
    0,
    ...(history || []).map((previous) => textSimilarity(text, previous)),
  );
  if (maxHistorySimilarity > 0.55) {
    score -= 16;
    reasons.push("too similar to history");
  } else if (maxHistorySimilarity < 0.25) {
    score += 4;
  }

  const templateLift = performanceLift(
    performanceInsights?.templates?.[candidate.templateId],
    performanceInsights || { minSamples: 999, baselineScore: 0 },
    0.5,
  );
  if (templateLift) {
    score += templateLift * 18;
    reasons.push(`template lift ${(templateLift * 100).toFixed(0)}%`);
  }

  const sourceLift = performanceLift(
    performanceInsights?.sources?.[story?.source],
    performanceInsights || { minSamples: 999, baselineScore: 0 },
    0.35,
  );
  if (sourceLift) score += sourceLift * 10;

  const autopilot = buildLearningAutopilot(performanceInsights || {});
  const exploitIds = new Set((autopilot.exploitFormats || []).map((row) => row.id));
  const testIds = new Set((autopilot.testFormats || []).map((row) => row.id));
  const exploreIds = new Set((autopilot.exploreFormats || []).map((row) => row.id));
  const holdIds = new Set((autopilot.holdFormats || []).map((row) => row.id));
  if (exploitIds.has(candidate.templateId)) {
    score += 7;
    reasons.push("autopilot exploit");
  } else if (testIds.has(candidate.templateId)) {
    score += 4;
    reasons.push("autopilot test");
  } else if (exploreIds.has(candidate.templateId)) {
    score += 2;
    reasons.push("autopilot explore");
  } else if (holdIds.has(candidate.templateId)) {
    score -= 9;
    reasons.push("autopilot hold");
  }

  const angleScheduler = buildAdaptiveAngleScheduler(performanceInsights || {}, { learningAutopilot: autopilot });
  const preferredFormatIds = new Set(angleScheduler.scoringBias?.preferredFormatIds || []);
  const schedulerHoldIds = new Set(angleScheduler.scoringBias?.holdFormatIds || []);
  const candidateAngleText = `${candidate.angle || ""} ${candidate.reason || ""} ${text}`.toLowerCase();
  const keywordHits = (angleScheduler.scoringBias?.preferredAngleKeywords || [])
    .filter((keyword) => keyword && candidateAngleText.includes(String(keyword).toLowerCase()))
    .slice(0, 3);
  if (preferredFormatIds.has(candidate.templateId)) {
    score += angleScheduler.mode === "surge_exploit" ? 7 : 5;
    reasons.push("angle scheduler format");
  }
  if (keywordHits.length) {
    score += Math.min(5, keywordHits.length * 2);
    reasons.push("angle scheduler keyword");
  }
  if (schedulerHoldIds.has(candidate.templateId)) {
    score -= 6;
    reasons.push("angle scheduler hold");
  }

  const mutationCompliance = scoreAngleMutationCompliance(candidate, { story, angleMutationReactor });
  if (mutationCompliance.delta) {
    score += mutationCompliance.delta;
    reasons.push(...mutationCompliance.reasons);
  }

  const hookCompliance = scoreHookPatternCompliance(candidate, { hookPatternReactor });
  if (hookCompliance.delta) {
    score += hookCompliance.delta;
    reasons.push(...hookCompliance.reasons);
  }

  const banditCompliance = scoreContentBanditCompliance(candidate, { contentBanditAllocator });
  if (banditCompliance.delta) {
    score += banditCompliance.delta;
    reasons.push(...banditCompliance.reasons);
  }

  const angleLoadCompliance = scoreAngleLoadRouterCompliance(candidate, { angleLoadRouter });
  if (angleLoadCompliance.delta) {
    score += angleLoadCompliance.delta;
    reasons.push(...angleLoadCompliance.reasons);
  }

  const narrativeCompliance = scoreNarrativeResonanceCompliance(candidate, { story, narrativeResonanceController });
  if (narrativeCompliance.delta) {
    score += narrativeCompliance.delta;
    reasons.push(...narrativeCompliance.reasons);
  }

  const topicTimingCompliance = scoreTopicTimingCompliance(candidate, { story, topicTimingRouter });
  if (topicTimingCompliance.delta) {
    score += topicTimingCompliance.delta;
    reasons.push(...topicTimingCompliance.reasons);
  }

  const opportunityCompliance = scoreGrowthOpportunityCompliance(candidate, { story, growthOpportunityScorer });
  if (opportunityCompliance.delta) {
    score += opportunityCompliance.delta;
    reasons.push(...opportunityCompliance.reasons);
  }

  const policyCompliance = scoreCachedGenerationPolicyCompliance(candidate, { cachedGenerationPolicy });
  if (policyCompliance.delta) {
    score += policyCompliance.delta;
    reasons.push(...policyCompliance.reasons);
  }

  const selfEvolvingCompliance = scoreSelfEvolvingStrategyCompliance(candidate, { growthStrategy, story });
  if (selfEvolvingCompliance.delta) {
    score += selfEvolvingCompliance.delta;
    reasons.push(...selfEvolvingCompliance.reasons);
  }

  const hookGate = viralHookGate(candidate, { story, language });
  score += hookGate.allow ? Math.min(18, hookGate.score * 0.35) : Math.max(-24, hookGate.score * 0.5);
  if (hookGate.reasons.length) reasons.push(...hookGate.reasons.slice(0, 4));
  if (!hookGate.allow) reasons.push(`viral hook gate: ${hookGate.warnings.join(",") || "weak hook"}`);

  return {
    ...candidate,
    score: Math.round(score * 10) / 10,
    reason: candidate.reason || reasons.join(", ") || "highest local growth score",
    diagnostics: reasons,
    angleMutationScore: mutationCompliance.delta,
    angleMutationDiagnostics: mutationCompliance.reasons,
    hookPatternScore: hookCompliance.delta,
    hookPatternDiagnostics: hookCompliance.reasons,
    hookPatternClassification: hookCompliance.classification,
    contentBanditScore: banditCompliance.delta,
    contentBanditDiagnostics: banditCompliance.reasons,
    angleLoadRouterScore: angleLoadCompliance.delta,
    angleLoadRouterDiagnostics: angleLoadCompliance.reasons,
    narrativeResonanceScore: narrativeCompliance.delta,
    narrativeResonanceDiagnostics: narrativeCompliance.reasons,
    narrativePillar: narrativeCompliance.classification
      ? {
          id: narrativeCompliance.classification.id,
          label: narrativeCompliance.classification.label,
          matchScore: narrativeCompliance.classification.matchScore ?? null,
        }
      : null,
    topicTimingScore: topicTimingCompliance.delta,
    topicTimingDiagnostics: topicTimingCompliance.reasons,
    topicTimingLane: topicTimingCompliance.lane
      ? {
          id: topicTimingCompliance.lane.id || null,
          windowLabel: topicTimingCompliance.lane.windowLabel || null,
          hour: topicTimingCompliance.lane.hour ?? null,
          pillarId: topicTimingCompliance.lane.pillarId || null,
          pillarLabel: topicTimingCompliance.lane.pillarLabel || null,
          formatId: topicTimingCompliance.lane.formatId || null,
          formatLabel: topicTimingCompliance.lane.formatLabel || null,
          score: topicTimingCompliance.lane.score ?? null,
          status: topicTimingCompliance.lane.status || null,
        }
      : null,
    growthOpportunityScore: opportunityCompliance.delta,
    growthOpportunityDiagnostics: opportunityCompliance.reasons,
    growthOpportunityLane: opportunityCompliance.lane
      ? {
          id: opportunityCompliance.lane.id || null,
          label: opportunityCompliance.lane.label || null,
          formatId: opportunityCompliance.lane.formatId || null,
          pillarId: opportunityCompliance.lane.pillarId || null,
          score: opportunityCompliance.lane.score ?? null,
          status: opportunityCompliance.lane.status || null,
          sources: opportunityCompliance.lane.sources || [],
        }
      : null,
    cachedGenerationPolicyScore: policyCompliance.delta,
    cachedGenerationPolicyDiagnostics: policyCompliance.reasons,
    cachedGenerationPolicyHits: {
      directive: policyCompliance.directiveHits || [],
      narrative: policyCompliance.narrativeHits || [],
      opportunity: policyCompliance.opportunityHits || [],
    },
    selfEvolvingStrategyScore: selfEvolvingCompliance.delta,
    selfEvolvingStrategyDiagnostics: selfEvolvingCompliance.reasons,
    viralHookGate: hookGate,
  };
}

function qualityGateEnabled() {
  return isTruthy(optionalEnv("TWEET_QUALITY_GATE_ENABLED", "true"));
}

function qualityIssuesForTweet(text, story, growthStrategy = null, language = null) {
  const issues = [];
  const trimmed = String(text || "").trim();
  if (countCharacters(trimmed) > MAX_TWEET_LENGTH) issues.push({ severity: "block", reason: "too_long" });
  if (/https?:\/\//i.test(trimmed)) issues.push({ severity: "block", reason: "contains_url" });
  if (formulaicGrowthTemplateOpening(trimmed)) {
    issues.push({ severity: "block", reason: "formulaic_growth_template" });
  }
  if (/^(近日|据报道|新闻|消息|today|according to|breaking)\b/i.test(trimmed)) {
    issues.push({ severity: "block", reason: "news_recap_opening" });
  }
  if (/(值得关注|不容错过|重磅|震撼|颠覆|游戏规则|引爆|挑战和机遇|全新变革|主宰市场|超高效率|不可忽视|revolutionary|game.?changer|exciting news)/i.test(trimmed)) {
    issues.push({ severity: "block", reason: "generic_hype" });
  }
  if (/(可能|也许|或许|值得一看|可以关注一下|\bmay\b|\bmight\b|\bperhaps\b|\binteresting\b)/i.test(trimmed)) {
    issues.push({ severity: "warn", reason: "weak_hedge" });
  }
  if (/(6[-–]12|6\s*(到|至|-)\s*12|six to twelve)/i.test(trimmed)) {
    issues.push({ severity: "warn", reason: "formulaic_timeframe" });
  }
  const headlineSimilarity = headlineFrameSimilarity(trimmed, story);
  if (story?.contentKind !== "build_in_public") {
    if (headlineSimilarity > 0.62) {
      issues.push({ severity: "block", reason: "too_close_to_headline" });
    } else if (headlineSimilarity > 0.45) {
      issues.push({ severity: "warn", reason: "headline_frame_risk" });
    }
  }
  if (!storySpecificityScore(trimmed, story) && !/(openai|github|cursor|anthropic|vercel|cloudflare|apple|google|microsoft|ai|开发|代码|模型|agent)/i.test(trimmed)) {
    issues.push({ severity: "warn", reason: "low_specificity" });
  }
  if (isTruthy(optionalEnv("TWEET_HASHTAGS_ENABLED", "true")) && extractHashtags(trimmed).length === 0) {
    issues.push({ severity: "warn", reason: "missing_hashtags" });
  }
  return [
    ...issues,
    ...hybridQualityIssues(trimmed, {
      languageCode: language?.code || "",
      contentKind: story?.contentKind || "news_take",
    }),
    ...qualityIssuesFromGrowthStrategy(trimmed, story, growthStrategy),
  ];
}

async function aiQualityVerdict(candidate, { story, language }) {
  if (!isTruthy(optionalEnv("TWEET_AI_QUALITY_GATE_ENABLED", "false"))) {
    return { allow: true, reason: "AI quality gate disabled" };
  }

  const { response, data } = await callOpenAIChat({
    purpose: "quality_gate",
    messages: [
      {
        role: "system",
        content:
          'You are a strict editor for a tech X account. Return JSON only: {"allow":boolean,"reason":"short","risk":"low|medium|high"}. Reject marketing hype, factual overreach, generic summaries, and claims not supported by the source context.',
      },
      {
        role: "user",
        content: [
          `Language: ${language?.label || language?.code || "unknown"}`,
          "Story context:",
          formatStoryForImageVerdict(story),
          "Candidate tweet:",
          candidate.text,
        ].join("\n"),
      },
    ],
    responseFormat: { type: "json_object" },
  });

  if (!response.ok) {
    console.warn(data?.error?.message || `AI quality gate failed (${response.status}); allowing local-approved candidate.`);
    return { allow: true, reason: "AI gate unavailable" };
  }

  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    return {
      allow: Boolean(parsed.allow),
      reason: String(parsed.reason || "").trim() || "No reason",
      risk: String(parsed.risk || "").trim() || "unknown",
    };
  } catch {
    return { allow: true, reason: "AI gate returned unparsable JSON" };
  }
}

async function selectQualityApprovedCandidate(candidates, context) {
  if (!qualityGateEnabled()) return candidates[0];

  for (const candidate of candidates) {
    const issues = qualityIssuesForTweet(
      candidate.text,
      context.story,
      context.growthStrategy || null,
      context.language,
    );
    const hookGate = candidate.viralHookGate || viralHookGate(candidate, context);
    candidate.viralHookGate = hookGate;
    if (!hookGate.allow) {
      issues.push({
        severity: "block",
        reason: `viral_hook_gate:${hookGate.warnings.join("|") || "weak_hook"}`,
      });
    }
    const blocking = issues.filter((issue) => issue.severity === "block");
    candidate.qualityIssues = issues;
    if (blocking.length) {
      console.log(`Quality gate rejected ${candidate.templateId}: ${blocking.map((issue) => issue.reason).join(", ")}`);
      continue;
    }

    const aiVerdict = await aiQualityVerdict(candidate, context);
    candidate.aiQualityVerdict = aiVerdict;
    if (aiVerdict.allow) {
      if (issues.length) {
        console.log(`Quality gate warnings for ${candidate.templateId}: ${issues.map((issue) => issue.reason).join(", ")}`);
      }
      return candidate;
    }
    console.log(`AI quality gate rejected ${candidate.templateId}: ${aiVerdict.reason}`);
  }

  // STRICT=true fails the run. Otherwise (default) degrade to the top-ranked candidate
  // so schedule posts still ship; README documents this as the non-strict path.
  // ALLOW_BLOCKED_FALLBACK remains an explicit alias for the same non-strict fallback.
  if (isTruthy(optionalEnv("TWEET_QUALITY_GATE_STRICT", "false"))) {
    throw new Error("No tweet candidate passed the quality gate");
  }
  console.warn(
    "No tweet candidate passed the quality gate; falling back to top-ranked candidate (TWEET_QUALITY_GATE_STRICT=false).",
  );
  return candidates[0];
}

function logTweetCandidates(candidates, selected) {
  console.log("Tweet candidates ranked:");
  for (const [index, candidate] of candidates.entries()) {
    const marker = candidate === selected ? "SELECTED" : `#${index + 1}`;
    console.log(
      `${marker} score=${candidate.score.toFixed(1)} format=${candidate.templateId} hook=${candidate.viralHookGate?.allow ? "pass" : "block"}:${formatNumber(candidate.viralHookGate?.score, 1)} policy=${formatNumber(candidate.cachedGenerationPolicyScore, 1)} timing=${formatNumber(candidate.topicTimingScore, 1)} chars=${countCharacters(candidate.text)} reason=${candidate.reason}`,
    );
    console.log(candidate.text);
  }
}

function compactCandidateTrace(candidate, selectedCandidate, index) {
  if (!candidate) return null;
  return {
    rank: index + 1,
    selected: candidate === selectedCandidate || candidate.text === selectedCandidate?.text,
    templateId: candidate.templateId || null,
    score: candidate.score ?? null,
    angleMutationScore: candidate.angleMutationScore ?? 0,
    hookPatternScore: candidate.hookPatternScore ?? 0,
    contentBanditScore: candidate.contentBanditScore ?? 0,
    narrativeResonanceScore: candidate.narrativeResonanceScore ?? 0,
    narrativePillar: candidate.narrativePillar || null,
    topicTimingScore: candidate.topicTimingScore ?? 0,
    topicTimingLane: candidate.topicTimingLane || null,
    growthOpportunityScore: candidate.growthOpportunityScore ?? 0,
    growthOpportunityLane: candidate.growthOpportunityLane || null,
    cachedGenerationPolicyScore: candidate.cachedGenerationPolicyScore ?? 0,
    cachedGenerationPolicyHits: candidate.cachedGenerationPolicyHits || null,
    hookPattern: candidate.hookPatternClassification
      ? {
          primaryId: candidate.hookPatternClassification.primaryId || null,
          primaryLabel: candidate.hookPatternClassification.primaryLabel || null,
          patternIds: candidate.hookPatternClassification.patternIds || [],
          firstLine: candidate.hookPatternClassification.firstLine || null,
        }
      : null,
    reason: candidate.reason || null,
    diagnostics: Array.isArray(candidate.diagnostics) ? candidate.diagnostics.slice(0, 12) : [],
    angleMutationDiagnostics: Array.isArray(candidate.angleMutationDiagnostics)
      ? candidate.angleMutationDiagnostics.slice(0, 8)
      : [],
    hookPatternDiagnostics: Array.isArray(candidate.hookPatternDiagnostics)
      ? candidate.hookPatternDiagnostics.slice(0, 8)
      : [],
    contentBanditDiagnostics: Array.isArray(candidate.contentBanditDiagnostics)
      ? candidate.contentBanditDiagnostics.slice(0, 8)
      : [],
    angleLoadRouterScore: candidate.angleLoadRouterScore ?? 0,
    angleLoadRouterDiagnostics: Array.isArray(candidate.angleLoadRouterDiagnostics)
      ? candidate.angleLoadRouterDiagnostics.slice(0, 8)
      : [],
    narrativeResonanceDiagnostics: Array.isArray(candidate.narrativeResonanceDiagnostics)
      ? candidate.narrativeResonanceDiagnostics.slice(0, 8)
      : [],
    topicTimingDiagnostics: Array.isArray(candidate.topicTimingDiagnostics)
      ? candidate.topicTimingDiagnostics.slice(0, 8)
      : [],
    growthOpportunityDiagnostics: Array.isArray(candidate.growthOpportunityDiagnostics)
      ? candidate.growthOpportunityDiagnostics.slice(0, 8)
      : [],
    cachedGenerationPolicyDiagnostics: Array.isArray(candidate.cachedGenerationPolicyDiagnostics)
      ? candidate.cachedGenerationPolicyDiagnostics.slice(0, 8)
      : [],
    selfEvolvingStrategyScore: candidate.selfEvolvingStrategyScore ?? 0,
    selfEvolvingStrategyDiagnostics: Array.isArray(candidate.selfEvolvingStrategyDiagnostics)
      ? candidate.selfEvolvingStrategyDiagnostics.slice(0, 8)
      : [],
    qualityIssues: Array.isArray(candidate.qualityIssues)
      ? candidate.qualityIssues.map((issue) => issue.reason || issue).slice(0, 8)
      : [],
    viralHookGate: candidate.viralHookGate
      ? {
          allow: Boolean(candidate.viralHookGate.allow),
          score: candidate.viralHookGate.score ?? null,
          reasons: candidate.viralHookGate.reasons || [],
          warnings: candidate.viralHookGate.warnings || [],
          entityHits: candidate.viralHookGate.entityHits || [],
          firstLine: candidate.viralHookGate.firstLine || null,
          mode: candidate.viralHookGate.mode || null,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    aiQualityVerdict: candidate.aiQualityVerdict
      ? {
          allow: Boolean(candidate.aiQualityVerdict.allow),
          reason: candidate.aiQualityVerdict.reason || null,
          risk: candidate.aiQualityVerdict.risk || null,
        }
      : null,
    generationSource: candidate.generationSource || "openai",
    angle: candidate.angle || null,
    characterCount: countCharacters(candidate.text || ""),
    text: candidate.text || "",
  };
}

function buildGenerationDecisionTrace({
  candidates = [],
  selectedCandidate = null,
  angleMutationReactor = null,
  hookPatternReactor = null,
  contentBanditAllocator = null,
  angleLoadRouter = null,
  narrativeResonanceController = null,
  topicTimingRouter = null,
  growthOpportunityScorer = null,
  cachedGenerationPolicy = null,
  growthStrategy = null,
  localFallback = null,
  story = null,
  language = null,
} = {}) {
  const selectedIndex = candidates.findIndex((candidate) => candidate === selectedCandidate || candidate.text === selectedCandidate?.text);
  const selectedTrace = compactCandidateTrace(
    selectedCandidate,
    selectedCandidate,
    selectedIndex >= 0 ? selectedIndex : 0,
  );
  return {
    generatedAt: new Date().toISOString(),
    mode: "candidate_ranker_with_hook_angle_load_narrative_and_topic_timing",
    zeroExtraXReads: true,
    estimatedXReadOps: 0,
    selectedRank: selectedIndex >= 0 ? selectedIndex + 1 : null,
    selectedTemplateId: selectedCandidate?.templateId || null,
    selectedScore: selectedCandidate?.score ?? null,
    selectedReason: selectedCandidate?.reason || null,
    candidateCount: candidates.length,
    localFallback: localFallback
      ? {
          enabled: Boolean(localFallback.enabled),
          seedEnabled: Boolean(localFallback.seedEnabled),
          used: Boolean(localFallback.used),
          selected: Boolean(localFallback.selected),
          candidateCount: Number(localFallback.candidateCount) || 0,
          aiCandidateCount: Number(localFallback.aiCandidateCount) || 0,
          error: localFallback.error || null,
          mode: "cached_policy_local_fallback",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    language: language?.code || null,
    story: story
      ? {
          title: story.title || null,
          source: story.source || null,
          hotScore: story.hotScore ?? null,
          learnedScore: story.learnedScore ?? null,
        }
      : null,
    angleMutation: angleMutationReactor
      ? {
          mode: angleMutationReactor.mode,
          severity: angleMutationReactor.severity,
          confidence: angleMutationReactor.confidence,
          mutationScore: angleMutationReactor.mutationScore,
          nextPromptBias: angleMutationReactor.nextPromptBias,
          primaryMutation: angleMutationReactor.primaryMutation,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    hookPattern: hookPatternReactor
      ? {
          mode: hookPatternReactor.mode,
          confidence: hookPatternReactor.confidence,
          recommendedPattern: hookPatternReactor.recommendedPattern,
          avoidPatterns: hookPatternReactor.avoidPatterns,
          promptPatch: hookPatternReactor.promptPatch,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    contentBandit: contentBanditAllocator
      ? {
          mode: contentBanditAllocator.mode,
          confidence: contentBanditAllocator.confidence,
          recommendedLane: contentBanditAllocator.recommendedLane,
          exploreLane: contentBanditAllocator.exploreLane,
          rankedFormatIds: contentBanditAllocator.rankedFormatIds,
          promptPatch: contentBanditAllocator.promptPatch,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    angleLoadRouter: angleLoadRouter
      ? {
          mode: angleLoadRouter.mode,
          severity: angleLoadRouter.severity,
          activeSlot: angleLoadRouter.activeSlot,
          rankedFormatIds: angleLoadRouterFormatIds(angleLoadRouter),
          lanes: (angleLoadRouter.lanes || []).slice(0, 5),
          activeCommand: angleLoadRouter.activeCommand || null,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    narrativeResonance: narrativeResonanceController
      ? {
          mode: narrativeResonanceController.mode,
          severity: narrativeResonanceController.severity,
          accountPromise: narrativeResonanceController.accountPromise,
          resonanceScore: narrativeResonanceController.resonanceScore,
          primaryPillar: narrativeResonanceController.primaryPillar,
          promptDirectives: (narrativeResonanceController.promptDirectives || []).slice(0, 5),
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    topicTimingRouter: topicTimingRouter
      ? {
          mode: topicTimingRouter.mode,
          severity: topicTimingRouter.severity,
          routerScore: topicTimingRouter.routerScore,
          activeLane: topicTimingRouter.activeLane,
          lanes: (topicTimingRouter.lanes || []).slice(0, 5),
          promptDirectives: (topicTimingRouter.promptDirectives || []).slice(0, 5),
          zeroExtraXReads: Boolean(topicTimingRouter.zeroExtraXReads),
          estimatedXReadOps: 0,
        }
      : null,
    growthOpportunityScorer: growthOpportunityScorer
      ? {
          mode: growthOpportunityScorer.mode,
          severity: growthOpportunityScorer.severity,
          confidence: growthOpportunityScorer.confidence,
          opportunityScore: growthOpportunityScorer.opportunityScore,
          activeOpportunity: growthOpportunityScorer.activeOpportunity,
          lanes: (growthOpportunityScorer.lanes || []).slice(0, 5),
          promptDirectives: (growthOpportunityScorer.promptDirectives || []).slice(0, 5),
          zeroExtraXReads: Boolean(growthOpportunityScorer.zeroExtraXReads),
          estimatedXReadOps: 0,
        }
      : null,
    cachedGenerationPolicy: cachedGenerationPolicy
      ? {
          mode: cachedGenerationPolicy.mode,
          confidence: cachedGenerationPolicy.confidence,
          zeroExtraXReads: Boolean(cachedGenerationPolicy.zeroExtraXReads),
          estimatedXReadOps: cachedGenerationPolicy.estimatedXReadOps ?? 0,
          estimatedIncrementalXApiUsd: cachedGenerationPolicy.estimatedIncrementalXApiUsd ?? 0,
          primaryFormatId: cachedGenerationPolicy.primaryFormatId,
          primaryFormatLabel: cachedGenerationPolicy.primaryFormatLabel,
          exploreFormatId: cachedGenerationPolicy.exploreFormatId,
          rankedFormatIds: cachedGenerationPolicy.rankedFormatIds || [],
          avoidFormatIds: cachedGenerationPolicy.avoidFormatIds || [],
          hookPattern: cachedGenerationPolicy.hookPattern || null,
          narrativePillar: cachedGenerationPolicy.narrativePillar || null,
          opportunity: cachedGenerationPolicy.opportunity || null,
          directives: (cachedGenerationPolicy.directives || []).slice(0, 10),
          promptBlock: cachedGenerationPolicy.promptBlock || null,
        }
      : null,
    growthStrategy: growthStrategy
      ? {
          mode: growthStrategy.mode || null,
          status: growthStrategy.status || null,
          confidence: growthStrategy.confidence || null,
          promotedFormats: (growthStrategy.promotedFormats || []).slice(0, 5),
          holdFormats: (growthStrategy.holdFormats || []).slice(0, 5),
          exploreFormatId: growthStrategy.exploreFormatId || null,
          formatWeights: growthStrategy.formatWeights || {},
          utcDay: growthStrategy.evolution?.utcDay || growthStrategy.dailyDigest?.utcDay || null,
          preferredHashtags: (growthStrategy.preferredHashtags || []).slice(0, 6),
          nextAction: growthStrategy.nextAction || null,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        }
      : null,
    selectedCandidate: selectedTrace,
    candidates: candidates
      .slice(0, 5)
      .map((candidate, index) => compactCandidateTrace(candidate, selectedCandidate, index))
      .filter(Boolean),
    gates: {
      qualityGateEnabled: qualityGateEnabled(),
      viralHookGateEnabled: viralHookGateEnabled(),
      aiQualityGateEnabled: isTruthy(optionalEnv("TWEET_AI_QUALITY_GATE_ENABLED", "false")),
      strictQualityGate: isTruthy(optionalEnv("TWEET_QUALITY_GATE_STRICT", "false")),
    },
  };
}

async function composeTweet({
  story,
  language,
  newsItems,
  buildNotes = [],
  history,
  featuredImagePost = false,
  performanceInsights = null,
}) {
  const topic = optionalEnv("TWEET_TOPIC", "technology, AI, Big Tech, consumer tech, startups, apps, cybersecurity, cloud, software");
  const customPrompt = optionalEnv("TWEET_PROMPT");
  const systemPrompt = optionalEnv(
    "TWEET_SYSTEM_PROMPT",
    systemPromptForLanguage(language?.code),
  );
  const now = new Date().toISOString();
  const newsContext = formatNewsContext(newsItems, story, buildNotes);
  const historyContext = formatHistoryContext(history);
  const generationStack = performanceInsights?.records?.length
    ? buildGenerationLearningStack(performanceInsights)
    : null;
  const angleMutationReactor = generationStack?.angleMutationReactor || null;
  const hookPatternReactor = generationStack?.hookPatternReactor || null;
  const contentBanditAllocator = generationStack?.contentBanditAllocator || null;
  const angleLoadRouter = generationStack?.angleLoadRouter || null;
  const narrativeResonanceController = generationStack?.narrativeResonanceController || null;
  const topicTimingRouter = generationStack?.topicTimingRouter || null;
  const growthOpportunityScorer = generationStack?.growthOpportunityScorer || null;
  const growthStrategy =
    (await readGrowthStrategy()) ||
    (performanceInsights?.records?.length
      ? buildSelfEvolvingGrowthStrategy({ state: { tweets: performanceInsights.records }, insights: performanceInsights, generationStack, now })
      : null);
  const performanceContext = [
    formatPerformanceContext(performanceInsights, generationStack),
    formatSelfEvolvingGrowthStrategyContext(growthStrategy),
  ].filter(Boolean).join("\n\n");
  const candidateCount = tweetCandidateCount();
  const contentFormats = selectContentFormats({
    performanceInsights,
    count: candidateCount,
    contentBanditAllocator,
    angleLoadRouter,
    growthOpportunityScorer,
    growthStrategy,
  });
  const cachedGenerationPolicy = buildCachedGenerationPolicy({
    generationStack,
    contentFormats,
    story,
    language,
    growthStrategy,
    now,
  });

  console.log(`Generating tweet in ${language.label}.`);
  console.log(`Candidate formats: ${contentFormats.map((format) => format.id).join(", ")}.`);
  console.log(
    `Cached generation policy: primary=${cachedGenerationPolicy.primaryFormatId || "-"}, confidence=${cachedGenerationPolicy.confidence}, X reads=0.`,
  );
  if (growthStrategy) {
    console.log(
      `Self-evolving growth strategy: status=${growthStrategy.status || "-"}, confidence=${growthStrategy.confidence || "-"}, next=${growthStrategy.nextAction || "-"}.`,
    );
  }
  if (angleMutationReactor) {
    console.log(
      `Angle mutation reactor: score=${formatNumber(angleMutationReactor.mutationScore, 1)}, severity=${angleMutationReactor.severity}, bias=${angleMutationReactor.nextPromptBias}`,
    );
  }
  if (hookPatternReactor?.recommendedPattern) {
    console.log(
      `Hook pattern reactor: pattern=${hookPatternReactor.recommendedPattern.label}, confidence=${hookPatternReactor.confidence}, patch=${hookPatternReactor.promptPatch}`,
    );
  }
  if (contentBanditAllocator?.recommendedLane) {
    console.log(
      `Content bandit allocator: primary=${contentBanditAllocator.recommendedLane.id}, explore=${contentBanditAllocator.exploreLane?.id || "-"}, confidence=${contentBanditAllocator.confidence}`,
    );
  }
  if (angleLoadRouter?.activeSlot) {
    console.log(
      `Angle load router: active=${angleLoadRouter.activeSlot.formatId || "-"}, window=${angleLoadRouter.activeSlot.windowLabel || "-"}, severity=${angleLoadRouter.severity}, ranked=${angleLoadRouterFormatIds(angleLoadRouter).join(",") || "-"}`,
    );
  }
  if (narrativeResonanceController?.primaryPillar) {
    console.log(
      `Narrative resonance: primary=${narrativeResonanceController.primaryPillar.label}, score=${formatNumber(narrativeResonanceController.resonanceScore, 1)}, mode=${narrativeResonanceController.mode}`,
    );
  }
  if (topicTimingRouter?.activeLane) {
    console.log(
      `Topic timing router: active=${topicTimingRouter.activeLane.windowLabel || "-"} UTC/${topicTimingRouter.activeLane.pillarLabel || "-"}/${topicTimingRouter.activeLane.formatId || "-"}, score=${formatNumber(topicTimingRouter.routerScore, 1)}, mode=${topicTimingRouter.mode}`,
    );
  }
  if (growthOpportunityScorer?.activeOpportunity) {
    console.log(
      `Opportunity fusion reactor: active=${growthOpportunityScorer.activeOpportunity.label || "-"}, score=${formatNumber(growthOpportunityScorer.opportunityScore, 1)}, confidence=${growthOpportunityScorer.confidence}, X reads=0`,
    );
  }

  const promptParts = [];
  if (candidateCount > 1) {
    promptParts.push(
      candidateJsonPrompt({
        customPrompt,
        language: language.label,
        topic,
        now,
        style: language.style,
        newsContext,
        historyContext,
        performanceContext,
        contentFormats,
        contentType: story?.contentKind || "news_take",
      }),
    );
  } else {
    promptParts.push(
      buildPrompt({
        customPrompt,
        language: language.label,
        topic,
        now,
        style: language.style,
        newsContext,
        historyContext,
        performanceContext,
        contentFormat: contentFormats[0],
        contentType: story?.contentKind || "news_take",
      }),
    );
  }

  if (featuredImagePost) {
    promptParts.push(
      "This is today's featured image post for the highest-value story. Take a sharper or fresher angle if needed, but stay on the selected story only.",
    );
  }
  promptParts.push(formatCachedGenerationPolicyContext(cachedGenerationPolicy));

  const localPolicyCandidates = buildLocalPolicyTweetCandidates({
    story,
    language,
    contentFormats,
    cachedGenerationPolicy,
  });
  let rawCandidates = [];
  let aiGenerationError = null;

  let response;
  let data;
  try {
    ({ response, data } = await callOpenAIChat({
      purpose: "tweet_generation",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: promptParts.join("\n") },
      ],
      responseFormat: candidateCount > 1 ? { type: "json_object" } : null,
    }));
  } catch (error) {
    aiGenerationError = error instanceof Error ? error.message : String(error);
  }

  if (aiGenerationError) {
    // handled by local fallback below
  } else if (!response.ok) {
    aiGenerationError = data?.error?.message || `OpenAI tweet generation failed (${response.status})`;
  } else {
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      aiGenerationError = "OpenAI returned an empty tweet";
    } else {
      rawCandidates =
        candidateCount > 1
          ? parseTweetCandidateJson(text, contentFormats)
          : [
              {
                text: trimTweet(text),
                templateId: contentFormats[0].id,
                angle: "",
                reason: "",
                generationSource: "openai",
              },
            ];
      rawCandidates = rawCandidates.map((candidate) => ({
        ...candidate,
        generationSource: candidate.generationSource || "openai",
      }));
      if (!rawCandidates.length) {
        aiGenerationError = "OpenAI returned no parseable tweet candidates";
      }
    }
  }

  const aiCandidateCount = rawCandidates.length;
  const shouldUseLocalFallback = !rawCandidates.length && localPolicyFallbackEnabled();
  const shouldSeedLocalPolicy = rawCandidates.length > 0 && localPolicySeedEnabled();
  if (shouldUseLocalFallback) {
    if (!localPolicyCandidates.length) throw new Error(aiGenerationError || "OpenAI returned no usable tweet candidates");
    console.warn(`Using ${localPolicyCandidates.length} local cached-policy fallback candidate(s): ${aiGenerationError}`);
    rawCandidates = localPolicyCandidates;
  } else if (shouldSeedLocalPolicy && localPolicyCandidates.length) {
    rawCandidates = [...rawCandidates, localPolicyCandidates[0]];
  } else if (!rawCandidates.length) {
    throw new Error(aiGenerationError || "OpenAI returned no usable tweet candidates");
  }

  const candidates = rawCandidates
    .map((candidate) =>
      scoreTweetCandidate(candidate, {
        history,
        story,
        language,
        performanceInsights,
        angleMutationReactor,
        hookPatternReactor,
        contentBanditAllocator,
        angleLoadRouter,
        narrativeResonanceController,
        topicTimingRouter,
        growthOpportunityScorer,
        cachedGenerationPolicy,
        growthStrategy,
      }),
    )
    .sort((left, right) => right.score - left.score);

  if (!candidates.length) {
    throw new Error("OpenAI returned no usable tweet candidates");
  }
  const selectedCandidate = await selectQualityApprovedCandidate(candidates, {
    story,
    language,
    growthStrategy,
  });
  logTweetCandidates(candidates, selectedCandidate);

  const promotedText = maybeAppendOpenSourcePromo(selectedCandidate.text, {
    score: selectedCandidate.score,
    language,
    seed: `${selectedCandidate.templateId || "tweet"}:${story?.id || story?.title || story?.url || ""}:${new Date().toISOString().slice(0, 10)}`,
  });
  if (promotedText !== selectedCandidate.text) {
    selectedCandidate.text = promotedText;
    selectedCandidate.openSourcePromoAttached = true;
    console.log(`Attached open-source promo footer: ${openSourcePromoUrl()}`);
  }

  return {
    tweet: selectedCandidate.text,
    selectedStory: story,
    language,
    selectedCandidate,
    candidates,
    generationDecisionTrace: buildGenerationDecisionTrace({
      candidates,
      selectedCandidate,
      angleMutationReactor,
      hookPatternReactor,
      contentBanditAllocator,
      angleLoadRouter,
      narrativeResonanceController,
      topicTimingRouter,
      growthOpportunityScorer,
      cachedGenerationPolicy,
      growthStrategy,
      localFallback: {
        enabled: localPolicyFallbackEnabled(),
        seedEnabled: localPolicySeedEnabled(),
        used: shouldUseLocalFallback,
        selected: selectedCandidate.generationSource === "local_cached_policy",
        candidateCount: localPolicyCandidates.length,
        aiCandidateCount,
        error: aiGenerationError,
      },
      story,
      language,
    }),
    imageContext: { newsContext, topic, selectedTitle: story?.title || "" },
  };
}

async function generateTweet() {
  const fixedText = optionalEnv("TWEET_TEXT");
  if (fixedText) {
    return {
      tweet: trimTweet(fixedText),
      selectedStory: null,
      language: null,
      selectedCandidate: {
        text: trimTweet(fixedText),
        templateId: "fixed_text",
        score: null,
        reason: "TWEET_TEXT override",
      },
      candidates: [],
      imageContext: { newsContext: "", topic: "" },
    };
  }

  const history = await readTweetHistory();
  const language = await resolveNextTweetLanguage(history);
  const analytics = await readTweetAnalytics();
  const performanceInsights = deriveAnalyticsInsights(analytics);
  const { items: newsItems, selected } = await fetchNewsItems(
    performanceInsights,
    cachedHotspotItems(analytics),
  );
  const buildNotes = await loadBuildInPublicNotes({
    filePath: optionalEnv("TWEET_BUILD_IN_PUBLIC_FILE", ".github/content/build-in-public.jsonl"),
    inline: optionalEnv("TWEET_BUILD_IN_PUBLIC_NOTES"),
    maxAgeDays: numberEnv("TWEET_BUILD_IN_PUBLIC_MAX_AGE_DAYS", 45, 1, 365),
    limit: integerEnv("TWEET_BUILD_IN_PUBLIC_LIMIT", 20, 1, 50),
  });
  const hybridStory = chooseHybridContent({
    selectedNews: selected,
    buildNotes,
    buildRatio: numberEnv("TWEET_BUILD_IN_PUBLIC_RATIO", 0.35, 0, 0.9),
    seed: `${new Date().toISOString().slice(0, 13)}:${language.code}`,
  });
  if (hybridStory?.contentKind === "build_in_public") {
    console.log(`Hybrid content: build-in-public note ${hybridStory.buildNote?.id || "-"}.`);
  }
  return composeTweet({
    story: hybridStory,
    language,
    newsItems,
    buildNotes,
    history,
    performanceInsights,
  });
}

function getXRefreshTokenCandidates() {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (label, envName) => {
    const rawValue = optionalEnv(envName);
    const refreshToken = compactSecret(rawValue);
    if (!refreshToken || seen.has(refreshToken)) return;
    seen.add(refreshToken);
    candidates.push({ label, envName, rawValue, refreshToken });
  };

  addCandidate("cached refresh token", "X_OAUTH2_REFRESH_TOKEN_CACHE");
  addCandidate("GitHub secret refresh token", "X_OAUTH2_REFRESH_TOKEN");

  if (!candidates.length) throw new Error("Missing X OAuth2 refresh token.");
  return candidates;
}

function isConfidentialXClient(clientId) {
  if (/:ci$/i.test(clientId)) return true;
  try {
    const decoded = Buffer.from(clientId, "base64").toString("utf8");
    return /:ci$/i.test(decoded) || decoded.includes(":ci");
  } catch {
    return false;
  }
}

function resolveXOAuthClientCredentials() {
  const clientId = compactSecret(requireEnv("X_CLIENT_ID"));
  const clientSecret = compactSecret(optionalEnv("X_CLIENT_SECRET"));
  const confidential = isConfidentialXClient(clientId);

  console.log(`X OAuth app type: ${confidential ? "confidential (:ci)" : "public/native"}`);
  console.log(`X_CLIENT_ID length: ${clientId.length}`);
  if (clientSecret) {
    console.log(`X_CLIENT_SECRET length: ${clientSecret.length}`);
  } else if (confidential) {
    throw new Error(
      "Missing X_CLIENT_SECRET for confidential X OAuth app (:ci). Copy Client Secret from X Developer Portal → your app → Keys and tokens → OAuth 2.0 Client Secret, then add GitHub secret X_CLIENT_SECRET.",
    );
  }

  return { clientId, clientSecret, confidential };
}

function buildXOAuthTokenRequest({ clientId, clientSecret, confidential, params }) {
  const body = new URLSearchParams(params);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  if (confidential || clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
    return { headers, body };
  }

  body.set("client_id", clientId);
  return { headers, body };
}

async function refreshXAccessToken(candidate) {
  const { label, envName, rawValue, refreshToken } = candidate;
  maskGitHubSecret(refreshToken);
  logSecretShape(envName, rawValue, refreshToken);

  const { clientId, clientSecret, confidential } = resolveXOAuthClientCredentials();
  const { headers, body } = buildXOAuthTokenRequest({
    clientId,
    clientSecret,
    confidential,
    params: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  });

  const response = await xFetch("OAUTH_REFRESH", X_OAUTH2_TOKEN_URL, {
    method: "POST",
    headers,
    body,
  }, { costUsd: 0 });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      data?.error_description ||
      data?.error ||
      data?.errors?.[0]?.message ||
      data?.title ||
      `HTTP ${response.status}`;
    const detailText = String(detail);
    const invalidRefreshToken = /invalid.*token|token.*invalid/i.test(detailText);

    if (envName === "X_OAUTH2_REFRESH_TOKEN_CACHE") {
      await discardCachedXRefreshToken(detailText);
    } else if (invalidRefreshToken) {
      console.warn(
        `GitHub secret X_OAUTH2_REFRESH_TOKEN is invalid: ${detailText}. Update the secret after re-authorizing X OAuth.`,
      );
    }

    const hint =
      /missing valid authorization header/i.test(detailText) &&
      clientSecret
        ? " Check that GitHub secrets X_CLIENT_ID and X_CLIENT_SECRET are the OAuth 2.0 pair from Developer Portal (not API Key / Consumer Secret), then regenerate Client Secret and re-authorize."
        : invalidRefreshToken
          ? " Update GitHub secret X_OAUTH2_REFRESH_TOKEN after re-authorizing."
          : "";
    throw new Error(`X OAuth2 refresh failed (${label}): ${detail}${hint}`);
  }

  const scopes = logOAuthScopes(data.scope, "X OAuth2 token scopes");
  await persistXRefreshToken(data.refresh_token || refreshToken);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scopes,
    envName,
    label,
  };
}

function requiredOAuthScopes() {
  const scopes = ["tweet.write"];
  if (tweetAnalyticsEnabled()) {
    scopes.push("tweet.read", "users.read");
  }
  if (isTruthy(optionalEnv("TWEET_IMAGE_ENABLED"))) {
    scopes.push("media.write");
  }
  return scopes;
}

function missingOAuthScopes(scopes, requiredScopes) {
  if (!scopes.length) return [];
  return requiredScopes.filter((scope) => !scopes.includes(scope));
}

async function getXAccessToken(candidate) {
  const cached = await readCachedAccessToken();
  if (cached?.accessToken) {
    console.log("Using cached X access token (skipping OAuth refresh).");
    return cached.accessToken;
  }

  const { accessToken, expiresIn, scopes, envName, label } =
    await refreshXAccessToken(candidate);
  if (!accessToken) {
    throw new Error("Missing X OAuth2 access token after refresh.");
  }

  const missingScopes = missingOAuthScopes(scopes, requiredOAuthScopes());
  if (missingScopes.length) {
    if (envName === "X_OAUTH2_REFRESH_TOKEN_CACHE") {
      await discardCachedXRefreshToken(
        `missing OAuth scopes: ${missingScopes.join(", ")}`,
      );
      console.warn(
        `Discarded cached X refresh token because scopes are missing: ${missingScopes.join(", ")}.`,
      );
    }

    throw new Error(
      `X OAuth2 token from ${label} is missing required scopes: ${missingScopes.join(", ")}.`,
    );
  }

  await persistAccessTokenCache({
    accessToken,
    expiresIn,
    scopes,
    label,
  });
  return accessToken;
}

async function postTweet(text, accessToken, mediaIds = []) {
  const body = { text };
  if (mediaIds.length) body.media = { media_ids: mediaIds };

  const response = await xFetch("CREATE_TWEET", X_CREATE_TWEET_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (isXCreditsDepletedPayload(response.status, data)) {
      throw new XCreditsDepletedError(`X create tweet failed: ${JSON.stringify(data)}`, {
        endpoint: "CREATE_TWEET",
        status: response.status,
        data,
      });
    }
    throw new Error(`X create tweet failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function publishTweetWithCandidate(tweet, imageContext, candidate, imagePlan) {
  const accessToken = await getXAccessToken(candidate);
  const mediaId = await prepareTweetImage(
    {
      tweet,
      newsContext: imageContext?.newsContext || "",
      topic: imageContext?.topic || "",
    },
    accessToken,
    { attachImage: imagePlan.attachImage },
  );

  const result = await postTweet(tweet, accessToken, mediaId ? [mediaId] : []);
  return { result, mediaId, accessToken };
}

async function publishTweetWithFallback(tweet, imageContext, imagePlan) {
  const candidates = getXRefreshTokenCandidates();
  let lastError = null;

  for (const [index, candidate] of candidates.entries()) {
    try {
      if (index > 0) {
        console.log(`Retrying X publish with ${candidate.label}.`);
      }
      return await publishTweetWithCandidate(tweet, imageContext, candidate, imagePlan);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`X publish with ${candidate.label} failed: ${message}`);
      if (error instanceof XCreditsDepletedError || /credits depleted|credits-depleted/i.test(message)) {
        throw error instanceof XCreditsDepletedError
          ? error
          : new XCreditsDepletedError(message, { endpoint: "CREATE_TWEET", status: 402 });
      }
      if (index === candidates.length - 1) {
        throw error;
      }
    }
  }

  throw lastError || new Error("X publish failed without an error detail.");
}

function tweetSelfTestMode() {
  return optionalEnv("TWEET_SELF_TEST").toLowerCase().replace(/_/g, "-");
}

function assertSelfTest(condition, message, details = null) {
  if (condition) return;
  const suffix = details ? `: ${JSON.stringify(details)}` : "";
  throw new Error(`Self-test failed: ${message}${suffix}`);
}

async function withSelfTestEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeJsonFileForSelfTest(filePath, value) {
  await ensureParentDirectory(filePath);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (typeof Bun !== "undefined") {
    await Bun.write(filePath, content);
    return;
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(filePath, content);
}

async function runLocalFallbackSelfTest() {
  const now = new Date().toISOString();
  const story = {
    title: "OpenAI ships new agent tooling for production developer teams",
    source: "openai.com",
    sourceTier: "ai_lab",
    summary:
      "A production agent tooling update changes how teams manage defaults, permissions, budgets, and rollback policies.",
    publishedAt: now,
    url: "https://example.invalid/openai-agent-tooling",
    hotScore: 9.4,
  };
  const languageCode = normalizeLanguageCode(optionalEnv("TWEET_SELF_TEST_LANGUAGE", "en")) || "en";
  const language = languageProfile(languageCode);
  const history = [];
  const performanceInsights = deriveAnalyticsInsights({ tweets: [] });
  const generationStack = buildGenerationLearningStack(performanceInsights);
  const contentFormats = selectContentFormats({
    performanceInsights,
    count: Math.max(2, Math.min(3, tweetCandidateCount())),
    contentBanditAllocator: generationStack.contentBanditAllocator,
    angleLoadRouter: generationStack.angleLoadRouter,
    growthOpportunityScorer: generationStack.growthOpportunityScorer,
  });
  const cachedGenerationPolicy = buildCachedGenerationPolicy({
    generationStack,
    contentFormats,
    story,
    language,
    now,
  });
  const localPolicyCandidates = buildLocalPolicyTweetCandidates({
    story,
    language,
    contentFormats,
    cachedGenerationPolicy,
  });

  assertSelfTest(localPolicyCandidates.length > 0, "local fallback produced no candidates", {
    formats: contentFormats.map((format) => format.id),
  });

  const candidates = localPolicyCandidates
    .map((candidate) =>
      scoreTweetCandidate(candidate, {
        history,
        story,
        language,
        performanceInsights,
        angleMutationReactor: generationStack.angleMutationReactor,
        hookPatternReactor: generationStack.hookPatternReactor,
        contentBanditAllocator: generationStack.contentBanditAllocator,
        angleLoadRouter: generationStack.angleLoadRouter,
        narrativeResonanceController: generationStack.narrativeResonanceController,
        topicTimingRouter: generationStack.topicTimingRouter,
        growthOpportunityScorer: generationStack.growthOpportunityScorer,
        cachedGenerationPolicy,
      }),
    )
    .sort((left, right) => right.score - left.score);
  const selectedCandidate = await selectQualityApprovedCandidate(candidates, { story, language });
  const trace = buildGenerationDecisionTrace({
    candidates,
    selectedCandidate,
    angleMutationReactor: generationStack.angleMutationReactor,
    hookPatternReactor: generationStack.hookPatternReactor,
    contentBanditAllocator: generationStack.contentBanditAllocator,
    angleLoadRouter: generationStack.angleLoadRouter,
    narrativeResonanceController: generationStack.narrativeResonanceController,
    topicTimingRouter: generationStack.topicTimingRouter,
    growthOpportunityScorer: generationStack.growthOpportunityScorer,
    cachedGenerationPolicy,
    localFallback: {
      enabled: localPolicyFallbackEnabled(),
      seedEnabled: localPolicySeedEnabled(),
      used: true,
      selected: selectedCandidate.generationSource === "local_cached_policy",
      candidateCount: localPolicyCandidates.length,
      aiCandidateCount: 0,
      error: "self-test forced OpenAI unavailable",
    },
    story,
    language,
  });
  const issues = qualityIssuesForTweet(selectedCandidate.text, story);

  assertSelfTest(trace.zeroExtraXReads === true && trace.estimatedXReadOps === 0, "trace is not zero-read", trace);
  assertSelfTest(trace.localFallback?.used === true, "trace did not record local fallback usage", trace.localFallback);
  assertSelfTest(selectedCandidate.generationSource === "local_cached_policy", "selected candidate is not local fallback", {
    generationSource: selectedCandidate.generationSource,
  });
  assertSelfTest(countCharacters(selectedCandidate.text) <= MAX_TWEET_LENGTH, "selected candidate exceeds X length", {
    chars: countCharacters(selectedCandidate.text),
  });
  assertSelfTest(!/https?:\/\//i.test(selectedCandidate.text), "selected candidate contains URL", selectedCandidate.text);
  assertSelfTest(!issues.some((issue) => issue.severity === "block"), "selected candidate has blocking quality issue", issues);

  console.log("Self-test local_fallback passed.");
  console.log(
    `Selected local candidate: format=${selectedCandidate.templateId}, score=${formatNumber(selectedCandidate.score, 1)}, chars=${countCharacters(selectedCandidate.text)}, X reads=0.`,
  );
  console.log(selectedCandidate.text);
  console.log(generationDecisionTraceReport(trace, { heading: "### Self-test Generation Decision Trace" }));
}

async function runCostGovernorSelfTest() {
  await withSelfTestEnv({
    X_API_MONTHLY_BUDGET_USD: "5",
    X_API_BUDGET_SAFETY_RATIO: "0.9",
    X_API_RUNWAY_GUARD_ENABLED: "true",
    X_API_RUNWAY_LOOKBACK_DAYS: "7",
    X_API_RUNWAY_MAINTENANCE_RUNS_PER_DAY: "1",
    X_API_RUNWAY_MIN_DAYS: "3",
    X_API_COST_READ: "0.05",
    X_API_COST_TWEET_CREATE: "0.015",
    X_API_COST_MEDIA_UPLOAD: "0.015",
    X_API_RATE_LIMIT_COOLDOWN_MINUTES: "360",
    X_API_BACKEND_COOLDOWN_MINUTES: "30",
    TWEET_CADENCE_DAILY_POST_TARGET: "1",
    TWEET_ANALYTICS_FILE: ".github/runtime/self-test-cost-governor-tweet-analytics.json",
    X_API_USAGE_FILE: ".github/runtime/self-test-cost-governor-x-api-usage.json",
    X_API_BUDGET_FILE: ".github/runtime/self-test-cost-governor-x-api-budget.json",
  }, async () => {
    const now = new Date();
    const month = currentBudgetMonth();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const eightHoursAgo = new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString();

    const cooldown = evaluateXApiCooldown({
      month,
      endpoints: {
        RECENT_SEARCH: {
          calls: 1,
          failures: 1,
          lastStatus: 429,
          lastFailureAt: tenMinutesAgo,
        },
      },
    }, now);
    assertSelfTest(cooldown.active === true, "429 cooldown did not activate", cooldown);
    assertSelfTest(cooldown.reasonCode === "rate_limit", "429 cooldown reason mismatch", cooldown);
    assertSelfTest(cooldown.readGate === "closed", "429 cooldown did not close live read gate", cooldown);

    const expiredCooldown = evaluateXApiCooldown({
      month,
      endpoints: {
        RECENT_SEARCH: {
          calls: 1,
          failures: 1,
          lastStatus: 429,
          lastFailureAt: eightHoursAgo,
        },
      },
    }, now);
    assertSelfTest(expiredCooldown.active === false, "expired 429 cooldown remained active", expiredCooldown);

    const overBudgetRunway = evaluateXApiRunwayGuard({
      usage: {
        month,
        days: {},
        endpoints: {},
        totalEstimatedUsd: 4.4,
      },
      budgetState: {
        month,
        spentUsd: 4.4,
      },
      projectedCost: 0.2,
      now,
    });
    assertSelfTest(overBudgetRunway.active === true, "runway guard did not activate near safe cap", overBudgetRunway);
    assertSelfTest(overBudgetRunway.readGate === "cached_only", "runway guard did not force cached-only reads", overBudgetRunway);
    assertSelfTest(
      overBudgetRunway.trackedSpendUsd + overBudgetRunway.projectedCostUsd > overBudgetRunway.safeCapUsd ||
        overBudgetRunway.monthEndSafe === false,
      "runway guard did not detect unsafe projected spend",
      overBudgetRunway,
    );

    const safeRunway = evaluateXApiRunwayGuard({
      usage: {
        month,
        days: {},
        endpoints: {},
        totalEstimatedUsd: 0.15,
      },
      budgetState: {
        month,
        spentUsd: 0.15,
      },
      projectedCost: 0.05,
      now,
    });
    assertSelfTest(safeRunway.active === false, "runway guard over-blocked safe spend", safeRunway);
    assertSelfTest(safeRunway.readGate === "open", "safe runway did not keep live reads open", safeRunway);

    const freshAccountState = {
      ...emptyTweetAnalyticsState(),
      accountSnapshots: [
        {
          checkedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
          publicMetrics: { followers_count: 65 },
        },
      ],
    };
    const staleAccountState = {
      ...emptyTweetAnalyticsState(),
      accountSnapshots: [
        {
          checkedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000).toISOString(),
          publicMetrics: { followers_count: 65 },
        },
      ],
    };
    const freshAccountSnapshotCost = await withSelfTestEnv({
      TWEET_ACCOUNT_SNAPSHOT_ENABLED: "true",
      TWEET_ACCOUNT_SNAPSHOT_MAX_AGE_HOURS: "12",
      TWEET_HOTSPOT_RADAR_ENABLED: "false",
      TWEET_AUTO_REPLY_ENABLED: "false",
    }, () => estimateMaintenanceReadCostFromState(freshAccountState));
    const staleAccountSnapshotCost = await withSelfTestEnv({
      TWEET_ACCOUNT_SNAPSHOT_ENABLED: "true",
      TWEET_ACCOUNT_SNAPSHOT_MAX_AGE_HOURS: "12",
      TWEET_HOTSPOT_RADAR_ENABLED: "false",
      TWEET_AUTO_REPLY_ENABLED: "false",
    }, () => estimateMaintenanceReadCostFromState(staleAccountState));
    assertSelfTest(freshAccountSnapshotCost === 0, "fresh account snapshot was not cached for maintenance cost", {
      freshAccountSnapshotCost,
    });
    assertSelfTest(staleAccountSnapshotCost >= estimatedEndpointCost("USER_ME_LOOKUP"), "stale account snapshot did not project a refresh read", {
      staleAccountSnapshotCost,
    });
    const freshAccountCache = await withSelfTestEnv({
      TWEET_ACCOUNT_SNAPSHOT_ENABLED: "true",
      TWEET_ACCOUNT_SNAPSHOT_MAX_AGE_HOURS: "12",
    }, () => buildAccountSnapshotCache(freshAccountState, now));
    const staleAccountCache = await withSelfTestEnv({
      TWEET_ACCOUNT_SNAPSHOT_ENABLED: "true",
      TWEET_ACCOUNT_SNAPSHOT_MAX_AGE_HOURS: "12",
    }, () => buildAccountSnapshotCache(staleAccountState, now));
    assertSelfTest(freshAccountCache.mode === "cache_hit" && freshAccountCache.savedReadCostUsd > 0, "fresh account snapshot cache telemetry is not a cache hit", freshAccountCache);
    assertSelfTest(staleAccountCache.mode === "refresh_due" && staleAccountCache.estimatedRefreshCostUsd > 0, "stale account snapshot cache telemetry is not refresh_due", staleAccountCache);
    const partitionMatrix = buildCircuitPartitionMatrix({
      usage: { month, days: {}, endpoints: {} },
      readGate: "cached_only",
      publishGate: "review",
      activeRunwayGuard: false,
      safeTextSlots: 10,
      accountSnapshotCache: freshAccountCache,
    });
    const accountSnapshotPartition = partitionMatrix.find((partition) => partition.id === "account_snapshot");
    assertSelfTest(accountSnapshotPartition?.gate === "cached_only", "account snapshot partition did not use cached_only gate", accountSnapshotPartition);

    await writeJsonFileForSelfTest(tweetAnalyticsFile(), emptyTweetAnalyticsState());
    await writeJsonFileForSelfTest(xApiUsageFile(), {
      month,
      days: {},
      endpoints: {},
      totalEstimatedUsd: 4.35,
    });
    await writeJsonFileForSelfTest(optionalEnv("X_API_BUDGET_FILE", ".github/runtime/x-api-budget.json"), {
      month,
      spentUsd: 4.35,
      lastPostedAt: null,
      posts: [],
    });

    const autoReplyMaintenanceBudget = await withSelfTestEnv({
      TWEET_ACCOUNT_SNAPSHOT_ENABLED: "false",
      TWEET_HOTSPOT_RADAR_ENABLED: "false",
      TWEET_AUTO_REPLY_ENABLED: "true",
      TWEET_AUTO_REPLY_MAX_QUERIES: "3",
      TWEET_METRICS_MAX_POSTS: "1",
    }, () => evaluateMaintenanceReadBudget());
    assertSelfTest(autoReplyMaintenanceBudget.allowed === false, "auto-reply maintenance reads were not budget-gated", autoReplyMaintenanceBudget);
    assertSelfTest(autoReplyMaintenanceBudget.category === "budget", "auto-reply maintenance budget skip category mismatch", autoReplyMaintenanceBudget);
    assertSelfTest(autoReplyMaintenanceBudget.projectedCost >= 0.15, "auto-reply projected read cost did not include query fan-out", autoReplyMaintenanceBudget);
    assertSelfTest(
      autoReplyMaintenanceBudget.spent + autoReplyMaintenanceBudget.projectedCost > autoReplyMaintenanceBudget.safeCap,
      "auto-reply maintenance budget did not exceed safe cap in self-test",
      autoReplyMaintenanceBudget,
    );

    console.log("Self-test cost_governor passed.");
    console.log(
      `Cooldown readGate=${cooldown.readGate}; runway readGate=${overBudgetRunway.readGate}; safe readGate=${safeRunway.readGate}.`,
    );
    console.log(
      `Auto-reply maintenance gate=${autoReplyMaintenanceBudget.category}; projected reads=$${formatNumber(autoReplyMaintenanceBudget.projectedCost, 3)}.`,
    );
  });
}

async function runHourlyLoadSelfTest() {
  await withSelfTestEnv({
    TWEET_GROWTH_MIN_SAMPLES: "2",
    TWEET_HOURLY_LOAD_MIN_SAMPLES: "2",
    TWEET_HOURLY_LOAD_WARM_SCORE: "45",
    TWEET_HOURLY_LOAD_PUBLISH_NOW_SCORE: "60",
    TWEET_CADENCE_MAX_WAIT_FOR_HOT_HOUR: "4",
    TWEET_CADENCE_ENFORCEMENT: "learned_window",
    TWEET_CADENCE_DAILY_POST_TARGET: "8",
    TWEET_CADENCE_DAILY_POST_TARGET_EN: "8",
    TWEET_CADENCE_DAILY_POST_TARGET_ZH: "8",
    X_API_MIN_HOURS_BETWEEN_POSTS: "0",
    TWEET_CADENCE_MIN_HOURS_BETWEEN_POSTS: "0",
    // CI pinches the live format pool to growth templates; this fixture needs the
    // classic learning formats so topic timing can rediscover the UTC 12 peak.
    TWEET_CONTENT_FORMAT_ID: "",
    TWEET_CONTENT_FORMAT_IDS:
      "not_x_but_y,second_order,prediction,operator_pain,contrarian_cost,sharp_question,playbook,decision_rule,brutal_truth,massive_value_drop,myth_busting,the_hard_way",
    TWEET_PEAK_ZH_UTC_HOURS: "12,13",
    TWEET_PEAK_EN_UTC_HOURS: "14,17,22",
  }, async () => {
    const now = "2026-07-09T10:00:00.000Z";
    const dayMs = 24 * 60 * 60 * 1000;
    const baseMs = Date.parse(now);
    const hotAt = (daysAgo, minute = 12) => new Date(baseMs - daysAgo * dayMs + 2 * 60 * 60 * 1000 + minute * 60 * 1000).toISOString();
    const coldAt = (daysAgo, hour, minute = 8) => {
      const date = new Date(baseMs - daysAgo * dayMs);
      date.setUTCHours(hour, minute, 0, 0);
      return date.toISOString();
    };
    const tweets = [
      ...Array.from({ length: 7 }, (_, index) => syntheticLearningRecord({
        index,
        templateId: "operator_pain",
        postedAt: hotAt(index + 1),
        impressions: 1800 + index * 120,
        likes: 18 + index,
        reposts: 6,
        quotes: 2,
        replies: 8,
        bookmarks: 6,
        profileClicks: 5,
        detailExpands: 20,
        text: "AI platform teams inherit the hidden operations work: permissions, evals, rollback, and budget ceilings.",
      })),
      ...Array.from({ length: 5 }, (_, index) => syntheticLearningRecord({
        index,
        templateId: "second_order",
        postedAt: coldAt(index + 1, 10),
        impressions: 70 + index * 5,
        likes: 0,
        replies: 0,
        text: "AI tools are getting better and will change software work.",
      })),
      ...Array.from({ length: 3 }, (_, index) => syntheticLearningRecord({
        index,
        templateId: "prediction",
        postedAt: coldAt(index + 1, 18),
        impressions: 140 + index * 10,
        likes: 1,
        replies: 0,
        text: "A platform default shift will change the next developer workflow.",
      })),
    ];
    const state = {
      tweets,
      accountSnapshots: [
        {
          checkedAt: now,
          publicMetrics: { followers_count: 128 },
        },
      ],
    };
    const insights = deriveAnalyticsInsights(state);
    const usage = {
      month: currentBudgetMonth(),
      totalEstimatedUsd: 0.1,
      endpoints: {},
      days: {},
    };
    const budgetState = {
      month: currentBudgetMonth(),
      spentUsd: 0.1,
      posts: 0,
      lastPostedAt: null,
    };
    const experimentPlan = buildExperimentPlan({ state, insights, usage, budgetState });
    const hourlyLoadBalancer = buildHourlyLoadBalancer({ state, insights, now });
    const topicTimingRouter = buildCachedTopicTimingRouterForCadence({
      state,
      insights,
      usage,
      experimentPlan,
      hourlyLoadBalancer,
      now,
    });
    const cadence = buildGrowthCadenceController({
      state,
      insights,
      usage,
      budgetState,
      experimentPlan,
      hourlyLoadBalancer,
      topicTimingRouter,
      now,
    });
    const learningAutopilot = buildLearningAutopilot(insights, { experimentPlan, now });
    const adaptiveAngleScheduler = buildAdaptiveAngleScheduler(insights, {
      state,
      experimentPlan,
      learningAutopilot,
      usage,
      now,
    });
    const temporalAngleMatrix = buildTemporalAngleMatrix({
      state,
      insights,
      adaptiveAngleScheduler,
      hourlyLoadBalancer,
      now,
    });
    const hookPatternReactor = buildHookPatternReactor({ insights, now });
    const contentBanditAllocator = buildContentBanditAllocator({ insights, hookPatternReactor, now });
    const narrativeResonanceController = buildNarrativeResonanceController({
      insights,
      contentBanditAllocator,
      now,
    });
    const fullTopicTimingRouter = buildTopicTimingRouter({
      insights,
      hourlyLoadBalancer,
      temporalAngleMatrix,
      contentBanditAllocator,
      narrativeResonanceController,
      now,
    });
    const angleLoadRouter = buildAngleLoadRouter({
      temporalAngleMatrix,
      adaptiveAngleScheduler,
      hourlyLoadBalancer,
      learningAutopilot,
      cadence,
      now,
    });
    const commander = buildNextWindowAngleCommander({
      cadence,
      topicTimingRouter: fullTopicTimingRouter,
      hourlyLoadBalancer,
      angleLoadRouter,
      adaptiveAngleScheduler,
      now,
    });

    assertSelfTest(hourlyLoadBalancer.zeroExtraXReads === true, "hourly load balancer is not zero-read", hourlyLoadBalancer);
    assertSelfTest(hourlyLoadBalancer.nextWindow?.hour === 12, "hourly load balancer did not choose the learned 12:00 UTC peak", hourlyLoadBalancer);
    assertSelfTest(hourlyLoadBalancer.nextWindow?.hoursFromNow === 2, "hourly load balancer next window offset mismatch", hourlyLoadBalancer.nextWindow);
    assertSelfTest(hourlyLoadBalancer.mode === "wait_for_peak", "hourly load balancer did not enter wait_for_peak mode", hourlyLoadBalancer);
    assertSelfTest(cadence.reasonCode === "learned_peak_wait", "cadence controller did not honor learned peak wait", cadence);
    assertSelfTest(cadence.willBlockPublish === true, "cadence enforcement did not block off-window publish", cadence);
    assertSelfTest(topicTimingRouter.zeroExtraXReads === true && fullTopicTimingRouter.zeroExtraXReads === true, "topic timing router is not zero-read", {
      cadenceRouter: topicTimingRouter,
      fullRouter: fullTopicTimingRouter,
    });
    assertSelfTest(
      [topicTimingRouter.activeLane?.hour, fullTopicTimingRouter.activeLane?.hour].includes(12),
      "topic timing router did not route into the learned UTC peak",
      { cadenceLane: topicTimingRouter.activeLane, fullLane: fullTopicTimingRouter.activeLane },
    );
    assertSelfTest(
      temporalAngleMatrix.slots?.[0]?.hour === 12,
      "temporal angle matrix did not put the learned peak first",
      temporalAngleMatrix.slots,
    );
    assertSelfTest(
      commander.window?.hour === 12 || /12:00/.test(String(commander.window?.label || commander.copyBlock || "")),
      "next window commander did not inherit the learned UTC peak",
      commander,
    );
    assertSelfTest(
      commander.zeroExtraXReads === true && commander.readGate === "cached_only",
      "next window commander is not cached-only",
      commander,
    );

    const midnight = "2026-08-22T00:05:00.000Z";
    const utcDayCadenceState = {
      tweets: [
        syntheticLearningRecord({
          index: 1,
          templateId: "operator_pain",
          postedAt: "2026-08-21T00:10:00.000Z",
          impressions: 900,
          likes: 8,
          language: "en",
        }),
        syntheticLearningRecord({
          index: 2,
          templateId: "operator_pain",
          postedAt: "2026-08-21T16:05:00.000Z",
          impressions: 900,
          likes: 8,
          language: "en",
        }),
        syntheticLearningRecord({
          index: 3,
          templateId: "operator_pain",
          postedAt: "2026-08-21T19:05:00.000Z",
          impressions: 900,
          likes: 8,
          language: "en",
        }),
      ],
      accountSnapshots: [],
    };
    const utcDayCadence = await withSelfTestEnv({
      TWEET_CADENCE_CONTROLLER_ENABLED: "true",
      TWEET_CADENCE_ENFORCEMENT: "budget_guard",
      TWEET_CADENCE_DAILY_POST_TARGET_EN: "3",
      TWEET_CADENCE_DAILY_POST_TARGET_ZH: "1",
      TWEET_CADENCE_MIN_HOURS_BETWEEN_POSTS: "0",
    }, async () =>
      buildGrowthCadenceController({
        state: utcDayCadenceState,
        insights: deriveAnalyticsInsights(utcDayCadenceState),
        usage: { month: currentBudgetMonth(), totalEstimatedUsd: 0.1, endpoints: {}, days: {} },
        budgetState: { month: currentBudgetMonth(), spentUsd: 0.1, posts: 0, lastPostedAt: null },
        experimentPlan: { budgetSafeSlots: 3 },
        languageCode: "en",
        now: midnight,
      }),
    );
    assertSelfTest(
      utcDayCadence.reasonCode !== "daily_target_reached",
      "UTC-day cadence incorrectly blocked the US East evening slot using yesterday's rolling 24h posts",
      utcDayCadence,
    );
    assertSelfTest(
      utcDayCadence.postsUtcDay === 0,
      "UTC-day cadence did not report zero English posts for the new UTC day",
      utcDayCadence,
    );

    console.log("Self-test hourly_load passed.");
    console.log(
      `Learned peak=${hourlyLoadBalancer.nextWindow.label} UTC in ${formatNumber(hourlyLoadBalancer.nextWindow.hoursFromNow, 1)}h; cadence=${cadence.reasonCode}; X reads=0.`,
    );
    console.log(
      `Topic timing=${fullTopicTimingRouter.activeLane?.windowLabel || "-"} UTC / ${fullTopicTimingRouter.activeLane?.pillarLabel || "-"} / ${fullTopicTimingRouter.activeLane?.formatLabel || fullTopicTimingRouter.activeLane?.formatId || "-"}.`,
    );
  });
}

function syntheticLearningRecord({
  index,
  templateId,
  postedAt,
  impressions,
  likes = 0,
  reposts = 0,
  quotes = 0,
  replies = 0,
  bookmarks = 0,
  profileClicks = 0,
  detailExpands = 0,
  text = "",
}) {
  return {
    id: `selftest-${templateId}-${index}`,
    text,
    language: "en",
    postedAt,
    templateId,
    newsSource: "openai.com",
    newsSourceTier: "ai_lab",
    audienceSegment: "builders",
    latestMetrics: {
      capturedAt: postedAt,
      publicMetrics: {
        impression_count: impressions,
        like_count: likes,
        retweet_count: reposts,
        quote_count: quotes,
        reply_count: replies,
        bookmark_count: bookmarks,
      },
      nonPublicMetrics: {
        user_profile_clicks: profileClicks,
        detail_expands: detailExpands,
      },
      organicMetrics: {},
    },
    metricsSnapshots: [],
  };
}

async function runLearningLoopSelfTest() {
  await withSelfTestEnv({
    TWEET_CONTENT_FORMAT_ID: "",
    TWEET_CONTENT_FORMAT_IDS: "not_x_but_y,second_order,prediction,operator_pain,contrarian_cost,sharp_question,playbook,decision_rule",
    TWEET_GROWTH_MIN_SAMPLES: "2",
    TWEET_CANDIDATE_COUNT: "4",
    TWEET_LOCAL_POLICY_FALLBACK_ENABLED: "true",
    TWEET_LOCAL_POLICY_SEED_ENABLED: "true",
    TWEET_HASHTAGS_ENABLED: "false",
  }, async () => {
    const nowMs = Date.now();
    const postedAt = (hoursAgo) => new Date(nowMs - hoursAgo * 60 * 60 * 1000).toISOString();
    const winningText =
      "Every AI coding upgrade creates a new operator job: permissions, rollback, evals, and budget guardrails.";
    const losingText =
      "A model update is interesting because it is faster and smarter for developers.";
    const tweets = [
      ...Array.from({ length: 6 }, (_, index) => syntheticLearningRecord({
        index,
        templateId: "operator_pain",
        postedAt: postedAt(index + 1),
        impressions: 1600 + index * 90,
        likes: 14 + index,
        reposts: 5,
        quotes: 2,
        replies: 7,
        bookmarks: 6,
        profileClicks: 4,
        detailExpands: 18,
        text: winningText,
      })),
      ...Array.from({ length: 4 }, (_, index) => syntheticLearningRecord({
        index,
        templateId: "second_order",
        postedAt: postedAt(index + 12),
        impressions: 80 + index * 8,
        likes: 0,
        reposts: 0,
        quotes: 0,
        replies: 0,
        bookmarks: 0,
        profileClicks: 0,
        detailExpands: 1,
        text: losingText,
      })),
    ];
    const performanceInsights = deriveAnalyticsInsights({ tweets });
    const generationStack = buildGenerationLearningStack(performanceInsights);
    const yesterday = new Date(nowMs - 30 * 60 * 60 * 1000).toISOString();
    const previousStrategy = {
      ...emptyGrowthStrategy(yesterday),
      formatWeights: Object.fromEntries(configuredContentFormats().map((format) => [format.id, 1])),
      evolution: { utcDay: utcDayStampFromValue(yesterday), mutations: [] },
    };
    const evolvedStrategy = buildSelfEvolvingGrowthStrategy({
      state: { tweets },
      insights: performanceInsights,
      generationStack,
      previous: previousStrategy,
      now: new Date(nowMs).toISOString(),
    });
    assertSelfTest(
      evolvedStrategy?.dailyDigest?.bestFormat?.id === "operator_pain",
      "daily traffic digest did not pick operator_pain as the 24h winner",
      evolvedStrategy?.dailyDigest,
    );
    assertSelfTest(
      (evolvedStrategy?.promotedFormats || []).some((row) => row.id === "operator_pain"),
      "evolved strategy did not promote operator_pain",
      evolvedStrategy?.promotedFormats,
    );
    assertSelfTest(
      (evolvedStrategy?.holdFormats || []).some((row) => row.id === "second_order"),
      "evolved strategy did not hold second_order",
      evolvedStrategy?.holdFormats,
    );
    assertSelfTest(
      Number(evolvedStrategy?.formatWeights?.operator_pain) > Number(evolvedStrategy?.formatWeights?.second_order || 0),
      "evolved weights did not raise the 24h winner over the loser",
      evolvedStrategy?.formatWeights,
    );
    const frozenStrategy = await withSelfTestEnv({ TWEET_MAINTENANCE_MODE: "dashboard_only" }, async () =>
      buildSelfEvolvingGrowthStrategy({
        state: { tweets },
        insights: performanceInsights,
        generationStack,
        previous: evolvedStrategy,
        now: `${utcDayStampFromValue(evolvedStrategy.generatedAt)}T18:00:00.000Z`,
      }),
    );
    assertSelfTest(
      frozenStrategy?.evolution?.frozen === true,
      "same-day dashboard_only did not freeze strategy weights",
      frozenStrategy?.evolution,
    );
    assertSelfTest(
      frozenStrategy?.formatWeights?.operator_pain === evolvedStrategy.formatWeights.operator_pain,
      "frozen strategy mutated format weights",
      frozenStrategy?.formatWeights,
    );
    const contentFormats = selectContentFormats({
      performanceInsights,
      count: 4,
      contentBanditAllocator: generationStack.contentBanditAllocator,
      angleLoadRouter: generationStack.angleLoadRouter,
      growthOpportunityScorer: generationStack.growthOpportunityScorer,
      growthStrategy: evolvedStrategy,
    });
    assertSelfTest(
      contentFormats[0]?.id === "operator_pain",
      "format picker did not lead with the evolved winner",
      contentFormats.map((format) => format.id),
    );
    assertSelfTest(
      !contentFormats.slice(0, 3).some((format) => format.id === "second_order"),
      "format picker ranked a held format too high",
      contentFormats.map((format) => format.id),
    );
    const story = {
      title: "OpenAI updates agent tooling for coding teams",
      source: "openai.com",
      sourceTier: "ai_lab",
      summary:
        "New agent tooling makes coding assistants more useful but pushes teams to manage permissions, evals, rollback, and budgets.",
      publishedAt: new Date(nowMs).toISOString(),
      url: "https://example.invalid/agent-tooling",
      hotScore: 8.8,
    };
    const language = languageProfile("en");
    const cachedGenerationPolicy = buildCachedGenerationPolicy({
      generationStack,
      contentFormats,
      story,
      language,
      growthStrategy: evolvedStrategy,
      now: new Date(nowMs).toISOString(),
    });
    const localPolicyCandidates = buildLocalPolicyTweetCandidates({
      story,
      language,
      contentFormats,
      cachedGenerationPolicy,
    });
    const candidates = localPolicyCandidates
      .map((candidate) =>
        scoreTweetCandidate(candidate, {
          history: [],
          story,
          language,
          performanceInsights,
          angleMutationReactor: generationStack.angleMutationReactor,
          hookPatternReactor: generationStack.hookPatternReactor,
          contentBanditAllocator: generationStack.contentBanditAllocator,
          angleLoadRouter: generationStack.angleLoadRouter,
          narrativeResonanceController: generationStack.narrativeResonanceController,
          topicTimingRouter: generationStack.topicTimingRouter,
          growthOpportunityScorer: generationStack.growthOpportunityScorer,
          cachedGenerationPolicy,
        }),
      )
      .sort((left, right) => right.score - left.score);
    const selectedCandidate = await selectQualityApprovedCandidate(candidates, { story, language });
    const trace = buildGenerationDecisionTrace({
      candidates,
      selectedCandidate,
      angleMutationReactor: generationStack.angleMutationReactor,
      hookPatternReactor: generationStack.hookPatternReactor,
      contentBanditAllocator: generationStack.contentBanditAllocator,
      angleLoadRouter: generationStack.angleLoadRouter,
      narrativeResonanceController: generationStack.narrativeResonanceController,
      topicTimingRouter: generationStack.topicTimingRouter,
      growthOpportunityScorer: generationStack.growthOpportunityScorer,
      cachedGenerationPolicy,
      localFallback: {
        enabled: localPolicyFallbackEnabled(),
        seedEnabled: localPolicySeedEnabled(),
        used: true,
        selected: selectedCandidate.generationSource === "local_cached_policy",
        candidateCount: localPolicyCandidates.length,
        aiCandidateCount: 0,
        error: "self-test uses cached analytics only",
      },
      story,
      language,
    });
    tweets[0].generationDecisionTrace = trace;
    const learningLoopContract = buildLearningLoopContract({
      insights: performanceInsights,
      learningAutopilot: generationStack.learningAutopilot,
      contentBanditAllocator: generationStack.contentBanditAllocator,
      contentBanditSettlement: generationStack.contentBanditSettlement,
      growthOpportunityScorer: generationStack.growthOpportunityScorer,
      cachedGenerationPolicy,
      generationDecisionTrace: trace,
      now: new Date(nowMs).toISOString(),
    });
    const dashboardData = buildDashboardData({
      state: {
        tweets,
        accountSnapshots: [
          {
            checkedAt: new Date(nowMs).toISOString(),
            publicMetrics: { followers_count: 128 },
          },
        ],
        rssHealth: {
          updatedAt: new Date(nowMs).toISOString(),
          feeds: {
            "https://github.blog/feed/": {
              url: "https://github.blog/feed/",
              source: "github.blog",
              consecutiveFailures: 0,
              totalFailures: 0,
              totalSuccesses: 6,
              lastItemCount: 8,
              lastStatus: "ok",
              lastError: null,
              lastSuccessAt: new Date(nowMs).toISOString(),
              lastFailureAt: null,
              updatedAt: new Date(nowMs).toISOString(),
            },
            "https://www.theverge.com/rss/index.xml": {
              url: "https://www.theverge.com/rss/index.xml",
              source: "theverge.com",
              consecutiveFailures: 1,
              totalFailures: 1,
              totalSuccesses: 4,
              lastItemCount: 8,
              lastStatus: "transient_http_status",
              lastError: "temporary RSS status",
              lastSuccessAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
              lastFailureAt: new Date(nowMs).toISOString(),
              updatedAt: new Date(nowMs).toISOString(),
            },
          },
        },
        trendVelocityRadar: {
          updatedAt: new Date(nowMs).toISOString(),
          mode: "rss_velocity",
          zeroExtraXReads: true,
          summary: {
            items: 2,
            breakoutCount: 1,
            avgVelocity: 82.1,
            primaryStage: "breakout",
            primaryTitle: "AI coding agents move from demo to workflow control",
            primarySource: "github.blog",
            nextAction: "Route cached RSS source through manual X web lanes.",
          },
          items: [
            {
              rank: 1,
              title: "AI coding agents move from demo to workflow control",
              link: "https://github.blog/",
              source: "github.blog",
              sourceTier: "official",
              audienceLabel: "AI / Agent Stack",
              velocityScore: 86.4,
              velocityLift: 0.213,
              stage: "breakout",
              ageHours: 2.3,
              echoes: 4,
              reason: "cached breakout source",
              routeUrl: "https://x.com/search?q=AI%20coding%20agents&src=typed_query&f=live",
              routeQuery: "AI coding agents -is:retweet lang:en",
              routeReason: "Open live X web route manually and use the cached RSS angle.",
              zeroExtraXReads: true,
            },
            {
              rank: 2,
              title: "Big Tech bundles AI defaults into the operating system layer",
              link: "https://www.theverge.com/",
              source: "theverge.com",
              sourceTier: "mainstream",
              audienceLabel: "Big Tech Platform",
              velocityScore: 77.8,
              velocityLift: 0.16,
              stage: "rising",
              ageHours: 4.8,
              echoes: 3,
              reason: "cached rising source",
              routeUrl: "https://x.com/search?q=AI%20platform%20defaults&src=typed_query&f=live",
              routeQuery: "AI platform defaults -is:retweet lang:en",
              routeReason: "Open live X web route manually and use the cached RSS angle.",
              zeroExtraXReads: true,
            },
          ],
        },
      },
      insights: performanceInsights,
      usage: {
        month: currentBudgetMonth(),
        totalEstimatedUsd: 0.39,
        endpoints: {
          CREATE_TWEET: { calls: 9, failures: 0, estimatedUsd: 0.135, lastStatus: 201 },
          USER_ME_LOOKUP: { calls: 5, failures: 0, estimatedUsd: 0.15, lastStatus: 200 },
          TWEET_METRICS_LOOKUP: { calls: 7, failures: 0, estimatedUsd: 0.105, lastStatus: 200 },
        },
        days: {},
      },
      budgetState: {},
      openAIUsage: {},
    });

    const winner = performanceInsights.templates.operator_pain;
    const loser = performanceInsights.templates.second_order;
    const bandit = generationStack.contentBanditAllocator;
    const winnerLane = (bandit.lanes || []).find((lane) => lane.id === "operator_pain");
    const loserLane = (bandit.lanes || []).find((lane) => lane.id === "second_order");

    assertSelfTest(winner?.count >= 6, "synthetic winner samples missing", winner);
    assertSelfTest(winner.avgScore > performanceInsights.baselineScore * 1.08, "winner did not beat baseline", {
      winner,
      baselineScore: performanceInsights.baselineScore,
    });
    assertSelfTest(loser?.count >= 4 && loser.avgScore < performanceInsights.baselineScore * 0.82, "loser did not fall below baseline", {
      loser,
      baselineScore: performanceInsights.baselineScore,
    });
    assertSelfTest(bandit.zeroExtraXReads === true, "content bandit is not zero-read", bandit);
    assertSelfTest(bandit.recommendedLane?.id === "operator_pain", "bandit did not exploit winning format", bandit.recommendedLane);
    assertSelfTest(winnerLane?.status === "exploit", "winner lane is not exploit", winnerLane);
    assertSelfTest(loserLane?.status === "hold", "loser lane is not hold", loserLane);
    assertSelfTest(contentFormats[0]?.id === "operator_pain", "format selection did not lead with learned winner", {
      formats: contentFormats.map((format) => format.id),
    });
    assertSelfTest(cachedGenerationPolicy.zeroExtraXReads === true, "cached generation policy is not zero-read", cachedGenerationPolicy);
    assertSelfTest(cachedGenerationPolicy.primaryFormatId === "operator_pain", "cached policy missed learned primary format", {
      primaryFormatId: cachedGenerationPolicy.primaryFormatId,
      rankedFormatIds: cachedGenerationPolicy.rankedFormatIds,
    });
    assertSelfTest(localPolicyCandidates[0]?.templateId === "operator_pain", "local fallback did not seed learned winner first", {
      candidates: localPolicyCandidates.map((candidate) => candidate.templateId),
    });
    assertSelfTest(selectedCandidate.templateId === "operator_pain", "ranker did not select learned winner", {
      selected: compactCandidateTrace(selectedCandidate, selectedCandidate, 0),
      candidates: candidates.map((candidate, index) => compactCandidateTrace(candidate, selectedCandidate, index)),
    });
    assertSelfTest(trace.zeroExtraXReads === true && trace.estimatedXReadOps === 0, "learning loop trace is not zero-read", trace);
    assertSelfTest(learningLoopContract.zeroExtraXReads === true, "learning loop contract is not zero-read", learningLoopContract);
    assertSelfTest(learningLoopContract.estimatedXReadOps === 0, "learning loop contract estimates X reads", learningLoopContract);
    assertSelfTest(learningLoopContract.primaryArm?.id === "operator_pain", "learning loop contract missed learned primary arm", {
      primaryArm: learningLoopContract.primaryArm,
      cells: learningLoopContract.cells,
    });
    assertSelfTest(learningLoopContract.policy?.primaryFormatId === "operator_pain", "learning loop contract policy missed learned primary", learningLoopContract.policy);
    assertSelfTest(learningLoopContract.selectedTrace?.templateId === "operator_pain", "learning loop contract missed selected trace", learningLoopContract.selectedTrace);
    assertSelfTest(
      (learningLoopContract.cells || []).some((cell) => cell.id === "read_gate" && /0 X reads/i.test(String(cell.value || ""))),
      "learning loop contract read gate cell missing",
      learningLoopContract.cells,
    );
    assertSelfTest(dashboardData.learningLoopContract?.zeroExtraXReads === true, "dashboard data learning contract is not zero-read", dashboardData.learningLoopContract);
    assertSelfTest(dashboardData.learningLoopContract?.estimatedXReadOps === 0, "dashboard data learning contract estimates X reads", dashboardData.learningLoopContract);
    assertSelfTest(
      dashboardData.learningLoopContract?.primaryArm?.id === "operator_pain",
      "dashboard data learning contract missed learned primary arm",
      dashboardData.learningLoopContract,
    );
    assertSelfTest(
      dashboardData.learningLoopContract?.policy?.primaryFormatId === "operator_pain",
      "dashboard data learning contract policy missed learned primary",
      dashboardData.learningLoopContract?.policy,
    );
    assertSelfTest(
      dashboardData.learningLoopContract?.selectedTrace?.templateId === "operator_pain",
      "dashboard data learning contract missed selected trace",
      dashboardData.learningLoopContract?.selectedTrace,
    );
    assertSelfTest(dashboardData.cachedGenerationPolicy?.zeroExtraXReads === true, "dashboard cached generation policy is not zero-read", dashboardData.cachedGenerationPolicy);
    assertSelfTest(
      dashboardData.cachedGenerationPolicy?.primaryFormatId === "operator_pain",
      "dashboard cached generation policy missed learned primary",
      dashboardData.cachedGenerationPolicy,
    );
    assertSelfTest(
      dashboardData.generationDecisionTrace?.zeroExtraXReads === true &&
        dashboardData.generationDecisionTrace?.estimatedXReadOps === 0,
      "dashboard data generation trace is not zero-read",
      dashboardData.generationDecisionTrace,
    );
    assertSelfTest(
      dashboardData.l7FireWindowRouter?.mode === "zero_read_l7_fire_window_router" &&
        dashboardData.l7FireWindowRouter?.zeroExtraXReads === true &&
        dashboardData.l7FireWindowRouter?.estimatedXReadOps === 0,
      "dashboard L7 fire-window router is not zero-read",
      dashboardData.l7FireWindowRouter,
    );
    assertSelfTest(
      (dashboardData.l7FireWindowRouter?.lanes || []).length > 0 &&
        dashboardData.l7FireWindowRouter?.activeLane,
      "dashboard L7 fire-window router did not produce active lanes",
      dashboardData.l7FireWindowRouter,
    );
    assertSelfTest(
      dashboardData.l7SurgeSentinel?.mode === "zero_read_l7_surge_sentinel" &&
        dashboardData.l7SurgeSentinel?.zeroExtraXReads === true &&
        dashboardData.l7SurgeSentinel?.estimatedXReadOps === 0,
      "dashboard L7 surge sentinel is not zero-read",
      dashboardData.l7SurgeSentinel,
    );
    assertSelfTest(
      (dashboardData.l7SurgeSentinel?.lanes || []).length > 0 &&
        (dashboardData.l7SurgeSentinel?.trace || []).length > 0,
      "dashboard L7 surge sentinel did not produce lanes and trace",
      dashboardData.l7SurgeSentinel,
    );
    assertSelfTest(
      dashboardData.growthLeakProfiler?.mode === "zero_read_growth_leak_profiler" &&
        dashboardData.growthLeakProfiler?.zeroExtraXReads === true &&
        dashboardData.growthLeakProfiler?.estimatedXReadOps === 0 &&
        dashboardData.growthLeakProfiler?.estimatedIncrementalXApiUsd === 0,
      "dashboard growth leak profiler is not zero-read",
      dashboardData.growthLeakProfiler,
    );
    assertSelfTest(
      (dashboardData.growthLeakProfiler?.stages || []).length >= 5 &&
        dashboardData.growthLeakProfiler?.primaryLeakId &&
        dashboardData.growthLeakProfiler?.primaryLeak,
      "dashboard growth leak profiler did not produce a leak diagnosis",
      dashboardData.growthLeakProfiler,
    );
    assertSelfTest(
      dashboardData.commandPacketDock?.mode === "zero_read_command_packet_dock" &&
        dashboardData.commandPacketDock?.zeroExtraXReads === true &&
        dashboardData.commandPacketDock?.estimatedXReadOps === 0 &&
        dashboardData.commandPacketDock?.estimatedIncrementalXApiUsd === 0,
      "dashboard command packet dock is not zero-read",
      dashboardData.commandPacketDock,
    );
    assertSelfTest(
      dashboardData.commandPacketDock?.primaryPacket &&
        (dashboardData.commandPacketDock?.steps || []).length >= 4,
      "dashboard command packet dock did not produce an operator packet",
      dashboardData.commandPacketDock,
    );
    assertSelfTest(
      dashboardData.identityConversionFirewall?.mode === "zero_read_identity_conversion_firewall" &&
        dashboardData.identityConversionFirewall?.zeroExtraXReads === true &&
        dashboardData.identityConversionFirewall?.estimatedXReadOps === 0 &&
        dashboardData.identityConversionFirewall?.estimatedIncrementalXApiUsd === 0,
      "dashboard identity conversion firewall is not zero-read",
      dashboardData.identityConversionFirewall,
    );
    assertSelfTest(
      (dashboardData.identityConversionFirewall?.checks || []).length >= 5 &&
        dashboardData.identityConversionFirewall?.nextAction &&
        (dashboardData.identityConversionFirewall?.profileRunbook || []).length >= 3,
      "dashboard identity conversion firewall did not produce conversion gates",
      dashboardData.identityConversionFirewall,
    );
    assertSelfTest(
      dashboardData.growthLoopTrace?.mode === "zero_read_growth_loop_trace" &&
        dashboardData.growthLoopTrace?.zeroExtraXReads === true &&
        dashboardData.growthLoopTrace?.estimatedXReadOps === 0 &&
        dashboardData.growthLoopTrace?.estimatedIncrementalXApiUsd === 0,
      "dashboard growth loop trace is not zero-read",
      dashboardData.growthLoopTrace,
    );
    assertSelfTest(
      (dashboardData.growthLoopTrace?.stages || []).length >= 5 &&
        (dashboardData.growthLoopTrace?.edges || []).length >= 4 &&
        dashboardData.growthLoopTrace?.bottleneckStageId &&
        dashboardData.growthLoopTrace?.nextAction,
      "dashboard growth loop trace did not produce a complete route trace",
      dashboardData.growthLoopTrace,
    );
    assertSelfTest(
      dashboardData.routeFireDrill?.mode === "zero_read_route_fire_drill" &&
        dashboardData.routeFireDrill?.zeroExtraXReads === true &&
        dashboardData.routeFireDrill?.estimatedXReadOps === 0 &&
        dashboardData.routeFireDrill?.estimatedIncrementalXApiUsd === 0,
      "dashboard route fire drill is not zero-read",
      dashboardData.routeFireDrill,
    );
    assertSelfTest(
      dashboardData.routeFireDrill?.operatorMode === "human_in_loop" &&
        dashboardData.routeFireDrill?.readGate === "browser_only" &&
        dashboardData.routeFireDrill?.manualOnly === true,
      "dashboard route fire drill is not browser-only and human-in-loop",
      dashboardData.routeFireDrill,
    );
    assertSelfTest(
      (dashboardData.routeFireDrill?.scenarios || []).length >= 3 &&
        dashboardData.routeFireDrill?.primaryScenarioId &&
        dashboardData.routeFireDrill?.nextAction,
      "dashboard route fire drill did not produce operator scenarios",
      dashboardData.routeFireDrill,
    );
    assertSelfTest(
      dashboardData.rssSourceMesh?.mode === "zero_read_rss_source_mesh" &&
        dashboardData.rssSourceMesh?.zeroExtraXReads === true &&
        dashboardData.rssSourceMesh?.estimatedXReadOps === 0,
      "dashboard RSS source mesh is not zero-read",
      dashboardData.rssSourceMesh,
    );
    assertSelfTest(
      (dashboardData.rssSourceMesh?.lanes || []).length >= 2 &&
        dashboardData.rssSourceMesh?.activeSource?.source === "github.blog",
      "dashboard RSS source mesh did not rank cached sources",
      dashboardData.rssSourceMesh,
    );
    const dashboardAccountSnapshotCache = dashboardData.accountSnapshotCache || {};
    const dashboardAccountSnapshotCacheIsZeroRead =
      (dashboardAccountSnapshotCache.mode === "cache_hit" && dashboardAccountSnapshotCache.savedReadCostUsd > 0) ||
      (
        dashboardAccountSnapshotCache.mode === "disabled" &&
        dashboardAccountSnapshotCache.enabled === false &&
        dashboardAccountSnapshotCache.zeroExtraXReads === true &&
        dashboardAccountSnapshotCache.readGate === "cached_only" &&
        dashboardAccountSnapshotCache.due === false &&
        dashboardAccountSnapshotCache.estimatedRefreshCostUsd === 0
      );
    assertSelfTest(
      dashboardAccountSnapshotCacheIsZeroRead,
      "dashboard account snapshot cache telemetry did not record a zero-read cache state",
      dashboardData.accountSnapshotCache,
    );
    assertSelfTest(
      (dashboardData.rateLimitGovernor?.partitionMatrix || []).some((partition) =>
        partition.id === "account_snapshot" &&
          partition.gate === "cached_only" &&
          (partition.cache?.mode === "cache_hit" || partition.cache?.mode === "disabled")
      ),
      "dashboard rate governor missed account_snapshot cache partition",
      dashboardData.rateLimitGovernor?.partitionMatrix,
    );
    const signalMap = dashboardData.signalMap || {};
    const signalNodeById = new Map((signalMap.nodes || []).map((node) => [node.id, node]));
    const requiredSignalNodeIds = ["rss", "score", "draft", "x", "learn"];
    assertSelfTest(signalMap.source === "packet_analytics + rss_health + x_api_usage", "dashboard signal map source drifted", signalMap);
    assertSelfTest(
      requiredSignalNodeIds.every((nodeId) => signalNodeById.has(nodeId)),
      "dashboard signal map missing required topology nodes",
      signalMap.nodes,
    );
    assertSelfTest(
      (signalMap.routes || []).some((route) => route.from === "x" && route.to === "learn"),
      "dashboard signal map does not feed X_ROUTE outcomes into learning",
      signalMap.routes,
    );
    assertSelfTest(
      (signalMap.routes || []).every((route) => signalNodeById.has(route.from) && signalNodeById.has(route.to)),
      "dashboard signal map route references an unknown node",
      signalMap.routes,
    );
    const xSignalNode = signalNodeById.get("x") || {};
    assertSelfTest(xSignalNode.label === "X_ROUTE", "dashboard signal map x node is not labeled X_ROUTE", xSignalNode);
    assertSelfTest(xSignalNode.unit === "web routes", "dashboard signal map x node is not a manual web route unit", xSignalNode);
    assertSelfTest(/0 extra X read ops/i.test(String(xSignalNode.detail || "")), "dashboard signal map x node does not declare zero X reads", xSignalNode);
    assertSelfTest(Number(xSignalNode.value) === dashboardData.actions.length, "dashboard signal map X_ROUTE count does not match manual actions", {
      xSignalNode,
      actions: dashboardData.actions.length,
    });
    assertSelfTest(Number(signalNodeById.get("draft")?.value) === dashboardData.drafts.length, "dashboard signal map draft count does not match output queue", {
      draftNode: signalNodeById.get("draft"),
      drafts: dashboardData.drafts.length,
    });
    assertSelfTest(Number(signalNodeById.get("learn")?.value) === dashboardData.profile.measuredPosts, "dashboard signal map learn count does not match measured packets", {
      learnNode: signalNodeById.get("learn"),
      measuredPosts: dashboardData.profile.measuredPosts,
    });
    assertSelfTest(
      Number(signalMap.totals?.xApiCalls) === 21 && Number(signalMap.totals?.xApiFailures) === 0,
      "dashboard signal map API totals do not match self-test usage partition",
      signalMap.totals,
    );
    assertSelfTest(
      (signalMap.nodes || []).every((node) =>
        Number(node.x) > 0 &&
          Number(node.x) < 1 &&
          Number(node.y) > 0 &&
          Number(node.y) < 1
      ),
      "dashboard signal map coordinates are not normalized percentages",
      signalMap.nodes,
    );
    const chartTotal = (chart) => (chart?.points || []).reduce((sum, point) => sum + (Number(point.value) || 0), 0);
    assertSelfTest(
      dashboardData.charts?.impressions24h?.total === dashboardData.last24h.impressions,
      "dashboard 24h chart total does not match L7 traffic metric",
      dashboardData.charts?.impressions24h,
    );
    assertSelfTest(
      chartTotal(dashboardData.charts?.impressions24h) === dashboardData.charts?.impressions24h?.total,
      "dashboard 24h chart points do not sum to chart total",
      dashboardData.charts?.impressions24h,
    );
    assertSelfTest(
      dashboardData.charts?.impressions7d?.total === dashboardData.last7d.impressions,
      "dashboard 7d chart total does not match L7 traffic metric",
      dashboardData.charts?.impressions7d,
    );
    assertSelfTest(
      chartTotal(dashboardData.charts?.impressions7d) === dashboardData.charts?.impressions7d?.total,
      "dashboard 7d chart points do not sum to chart total",
      dashboardData.charts?.impressions7d,
    );
    assertSelfTest(
      dashboardData.last7d.topPosts.length === dashboardData.last7d.posts,
      "dashboard last7d topPosts count does not match last7d posts",
      dashboardData.last7d,
    );
    assertSelfTest(
      (dashboardData.languageTracks?.tracks || []).reduce((sum, track) => sum + (Number(track.packetsLast7d) || 0), 0) === dashboardData.last7d.posts,
      "dashboard language track 7d packets do not match last7d posts",
      dashboardData.languageTracks,
    );
    assertSelfTest(
      dashboardData.charts?.xApiCallsDaily?.source === "x_api_usage.endpoints",
      "dashboard X API call chart did not fall back to endpoint totals when daily buckets were empty",
      dashboardData.charts?.xApiCallsDaily,
    );
    assertSelfTest(
      chartTotal(dashboardData.charts?.xApiCallsDaily) === 21,
      "dashboard X API call chart fallback total mismatch",
      dashboardData.charts?.xApiCallsDaily,
    );
    assertSelfTest(
      Number(chartTotal(dashboardData.charts?.xApiSpendDaily).toFixed(3)) === 0.39,
      "dashboard X API spend chart fallback total mismatch",
      dashboardData.charts?.xApiSpendDaily,
    );
    assertSelfTest(
      (trace.candidates || []).some((candidate) =>
        candidate.selected &&
          candidate.templateId === "operator_pain" &&
          [
            ...(candidate.diagnostics || []),
            ...(candidate.contentBanditDiagnostics || []),
            ...(candidate.cachedGenerationPolicyDiagnostics || []),
          ].some((item) => /policy primary format|content bandit|bandit exploit lane/i.test(item)),
      ),
      "selected trace did not record learning policy influence",
      trace.candidates,
    );

    console.log("Self-test learning_loop passed.");
    console.log(
      `Winner=operator_pain avg=${formatNumber(winner.avgScore, 1)} baseline=${formatNumber(performanceInsights.baselineScore, 1)}; loser=second_order avg=${formatNumber(loser.avgScore, 1)}.`,
    );
    console.log(
      `Primary format=${cachedGenerationPolicy.primaryFormatId}; selected=${selectedCandidate.templateId}; X reads=${trace.estimatedXReadOps}.`,
    );
    console.log(
      `Dashboard contract=${dashboardData.learningLoopContract.mode}; primary=${dashboardData.learningLoopContract.primaryArm?.id}; dashboard X reads=${dashboardData.learningLoopContract.estimatedXReadOps}.`,
    );
  });
}

async function runSelfTestIfRequested() {
  const mode = tweetSelfTestMode();
  if (!mode) return false;
  if (["local-fallback", "fallback", "tweet-fallback"].includes(mode)) {
    await runLocalFallbackSelfTest();
    return true;
  }
  if (["cost-governor", "x-api-cost-guard", "budget-guard"].includes(mode)) {
    await runCostGovernorSelfTest();
    return true;
  }
  if (["learning-loop", "growth-learning", "cached-learning"].includes(mode)) {
    await runLearningLoopSelfTest();
    return true;
  }
  if (["hourly-load", "hourly-learning", "topic-timing", "timing-router"].includes(mode)) {
    await runHourlyLoadSelfTest();
    return true;
  }
  throw new Error(`Unknown TWEET_SELF_TEST mode: ${mode}`);
}

async function getXAccessTokenWithFallback() {
  const candidates = getXRefreshTokenCandidates();
  let lastError = null;
  for (const [index, candidate] of candidates.entries()) {
    try {
      if (index > 0) console.log(`Retrying X access token with ${candidate.label}.`);
      return await getXAccessToken(candidate);
    } catch (error) {
      lastError = error;
      console.warn(`X access token with ${candidate.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (index === candidates.length - 1) throw error;
    }
  }
  throw lastError || new Error("X access token failed without an error detail.");
}

function dryRunEnabled() {
  return (
    isTruthy(optionalEnv("TWEET_DRY_RUN", "false")) ||
    isTruthy(optionalEnv("TWEET_DRY_RUN_TOP_CANDIDATES", "false"))
  );
}

function maintenanceMode() {
  return optionalEnv("TWEET_MAINTENANCE_MODE").toLowerCase();
}

function dashboardOnlyMaintenanceMode(mode = maintenanceMode()) {
  return ["dashboard_only", "report_only", "cached_report"].includes(mode);
}

function liveSnapshotMaintenanceMode(mode = maintenanceMode()) {
  return ["live_snapshot", "account_snapshot", "live_dashboard"].includes(mode);
}

function markDashboardTelemetryCached(reason) {
  process.env.DASHBOARD_CACHED_TELEMETRY_REASON = reason;
}

function clearDashboardTelemetryCached() {
  delete process.env.DASHBOARD_CACHED_TELEMETRY_REASON;
}

async function evaluateLiveSnapshotReadBudget() {
  const usage = await readXApiUsageState();
  const cooldown = evaluateXApiCooldown(usage);
  if (cooldown.active) {
    return {
      allowed: false,
      category: "cooldown",
      projectedCost: 0,
      spent: Number(usage.totalEstimatedUsd) || 0,
      safeCap: monthlyBudgetUsd() * budgetSafetyRatio(),
      cooldown,
      reason: cooldown.reason,
    };
  }

  const state = await readTweetAnalytics();
  const snapshotDue =
    isTruthy(optionalEnv("TWEET_ACCOUNT_SNAPSHOT_ENABLED", "true")) &&
    shouldRefreshAccountSnapshot(state);
  const metricsEnabled = isTruthy(optionalEnv("TWEET_LIVE_SNAPSHOT_METRICS_ENABLED", "false"));
  let projectedCost = 0;
  if (snapshotDue) projectedCost += estimatedEndpointCost("USER_ME_LOOKUP");
  if (metricsEnabled) {
    const maxPosts = integerEnv("TWEET_LIVE_SNAPSHOT_METRICS_MAX_POSTS", 2, 0, 20);
    const due = state.tweets.filter((record) => record.id && shouldRefreshTweetMetrics(record)).slice(0, maxPosts);
    if (due.length) projectedCost += estimatedEndpointCost("TWEET_METRICS_LOOKUP");
  }

  return {
    allowed: true,
    category: snapshotDue || (metricsEnabled && projectedCost > 0) ? "live_snapshot" : "cache_fresh",
    projectedCost: Number(projectedCost.toFixed(3)),
    spent: Number(usage.totalEstimatedUsd) || 0,
    safeCap: monthlyBudgetUsd() * budgetSafetyRatio(),
    cooldown,
    reason: snapshotDue
      ? `Live snapshot will refresh USER_ME_LOOKUP (~$${estimatedEndpointCost("USER_ME_LOOKUP").toFixed(3)}).`
      : "Account snapshot cache is still fresh; rebuild dashboard from cache only.",
  };
}

async function refreshLiveSnapshotTelemetry(accessToken) {
  if (!tweetAnalyticsEnabled()) return { accountRefreshed: false, metricsRefreshed: 0 };

  const state = await readTweetAnalytics();
  let accountRefreshed = false;
  let metricsRefreshed = 0;

  const accountSnapshotEnabled = isTruthy(optionalEnv("TWEET_ACCOUNT_SNAPSHOT_ENABLED", "true"));
  const accountSnapshotDue = accountSnapshotEnabled && shouldRefreshAccountSnapshot(state);
  if (accountSnapshotDue) {
    const accountSnapshot = await fetchAccountSnapshot(accessToken);
    state.accountSnapshots = [...(state.accountSnapshots || []), accountSnapshot].slice(-100);
    accountRefreshed = true;
    const followers = accountSnapshot.publicMetrics?.followers_count;
    if (followers != null) console.log(`Live snapshot followers: ${followers}.`);
  } else if (accountSnapshotEnabled) {
    const latest = latestAccountSnapshot(state);
    const ageHours = accountSnapshotAgeHours(state);
    const maxAgeHours = accountSnapshotMaxAgeHours();
    const followers = latest?.publicMetrics?.followers_count;
    console.log(
      `Live snapshot cache hit: ${followers == null ? "followers unknown" : `${followers} followers`}, age=${formatNumber(ageHours, 1)}h / ${formatNumber(maxAgeHours, 1)}h TTL.`,
    );
  }

  if (isTruthy(optionalEnv("TWEET_LIVE_SNAPSHOT_METRICS_ENABLED", "false"))) {
    const maxPosts = integerEnv("TWEET_LIVE_SNAPSHOT_METRICS_MAX_POSTS", 2, 0, 20);
    const dueRecords = state.tweets
      .filter((record) => record.id && shouldRefreshTweetMetrics(record))
      .slice(0, maxPosts);
    if (dueRecords.length) {
      const ids = dueRecords.map((record) => record.id);
      const metrics = await fetchTweetMetrics(accessToken, ids);
      const byId = new Map(metrics.map((tweet) => [String(tweet.id), tweet]));
      for (const record of dueRecords) {
        const tweet = byId.get(String(record.id));
        if (!tweet) continue;
        const snapshot = metricsSnapshotFromTweet(tweet);
        record.latestMetrics = snapshot;
        record.metricsSnapshots = [...(record.metricsSnapshots || []), snapshot].slice(-24);
        record.updatedAt = new Date().toISOString();
        metricsRefreshed += 1;
      }
    }
  }

  await persistTweetAnalytics(state);
  return { accountRefreshed, metricsRefreshed };
}

async function runLiveSnapshotMaintenance() {
  console.log(
    "Running live_snapshot maintenance: refresh account followers when due, rebuild dashboard, sync-ready output. Skips hotspot/auto-reply and ignores runway guard for this cheap read.",
  );

  if (dryRunEnabled()) {
    markDashboardTelemetryCached("dry_run");
    await writeGrowthReport();
    console.log("Live snapshot dry run complete; skipped X reads.");
    return;
  }

  const readBudget = await evaluateLiveSnapshotReadBudget();
  if (!readBudget.allowed) {
    console.warn(`Skipping live snapshot reads: ${readBudget.reason}`);
    markDashboardTelemetryCached(readBudget.category === "cooldown" ? "x_api_cooldown" : "x_api_budget_guard");
    await recordRunEvent("skip", `live snapshot skip: ${readBudget.reason}`, {
      category: readBudget.category || "budget",
      projectedCost: readBudget.projectedCost,
      spent: readBudget.spent,
      safeCap: readBudget.safeCap,
      cooldown: readBudget.cooldown || null,
    });
    await writeGrowthReport();
    console.log("Live snapshot maintenance complete with cached telemetry.");
    return;
  }

  if (readBudget.projectedCost > 0) {
    console.log(`Live snapshot budget check passed: ~$${readBudget.projectedCost.toFixed(3)} projected.`);
  } else {
    clearDashboardTelemetryCached();
    markDashboardTelemetryCached("live_snapshot_cache_fresh");
  }

  let accessToken = null;
  if (readBudget.projectedCost > 0) {
    try {
      accessToken = await getXAccessTokenWithFallback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendGitHubOutput("x_auth_unavailable", "true");
      console.warn(`X access token unavailable for live snapshot: ${message}`);
      markDashboardTelemetryCached("x_auth_unavailable");
      await recordRunEvent("maintenance_degraded", message, { category: "x_auth" });
    }
  }

  if (accessToken && readBudget.projectedCost > 0) {
    try {
      const result = await refreshLiveSnapshotTelemetry(accessToken);
      clearDashboardTelemetryCached();
      console.log(
        `Live snapshot refreshed: account=${result.accountRefreshed ? "yes" : "no"}, metrics=${result.metricsRefreshed}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Live snapshot X refresh failed; rebuilding from cache: ${message}`);
      markDashboardTelemetryCached("live_snapshot_failed");
      await recordRunEvent("maintenance_degraded", message, { category: "x_api" });
    }
  } else if (readBudget.projectedCost > 0) {
    console.warn("Continuing live snapshot with cached analytics only.");
  }

  await writeGrowthReport();
  console.log("Live snapshot maintenance complete.");
}

async function runGrowthMaintenance() {
  const mode = maintenanceMode();
  if (dashboardOnlyMaintenanceMode(mode)) {
    markDashboardTelemetryCached(mode);
    console.log(
      `Running ${mode} maintenance mode: cached analytics, reports, daily route plan, dashboard data. No X API or OpenAI calls.`,
    );
    await writeGrowthReport();
    console.log("Dashboard-only maintenance complete.");
    return;
  }

  if (liveSnapshotMaintenanceMode(mode)) {
    await runLiveSnapshotMaintenance();
    return;
  }

  console.log("Running growth maintenance mode: metrics, hotspot radar, auto-replies, reply drafts, follow-up drafts, report.");
  if (dryRunEnabled()) {
    markDashboardTelemetryCached("dry_run");
    await writeGrowthReport();
    console.log("Maintenance dry run complete; skipped X refresh, hotspot radar, auto-replies, reply drafts, and follow-up draft generation.");
    return;
  }

  const readBudget = await evaluateMaintenanceReadBudget();
  if (!readBudget.allowed) {
    const skipReason =
      readBudget.category === "cooldown"
        ? "x_api_cooldown"
        : readBudget.category === "runway"
          ? "x_api_runway_guard"
          : "x_api_budget_guard";
    console.warn(`Skipping live maintenance reads to protect X API ${readBudget.category || "budget"}: ${readBudget.reason}`);
    markDashboardTelemetryCached(skipReason);
    await recordRunEvent("skip", `maintenance read budget skip: ${readBudget.reason}`, {
      category: readBudget.category || "budget",
      projectedCost: readBudget.projectedCost,
      spent: readBudget.spent,
      safeCap: readBudget.safeCap,
      cooldown: readBudget.cooldown || null,
      runway: readBudget.runway || null,
    });
    // Cheap follower refresh still keeps the public dashboard alive even when
    // the full metrics_report path is runway-blocked.
    if (isTruthy(optionalEnv("TWEET_METRICS_FALLBACK_LIVE_SNAPSHOT", "false"))) {
      console.log("Falling back to live_snapshot after full metrics read budget skip.");
      await runLiveSnapshotMaintenance();
      return;
    }
    await writeGrowthReport();
    console.log(`Growth maintenance complete with cached telemetry due to ${skipReason}.`);
    return;
  }
  if (readBudget.projectedCost > 0) {
    console.log(
      `Maintenance X read budget check passed: ~$${readBudget.projectedCost.toFixed(3)} projected reads, $${Number(readBudget.spent || 0).toFixed(3)} spent / $${Number(readBudget.safeCap || 0).toFixed(2)} safe cap.`,
    );
  }

  let accessToken = null;
  try {
    accessToken = await getXAccessTokenWithFallback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendGitHubOutput("x_auth_unavailable", "true");
    console.warn(
      `X access token unavailable; skipping live metrics and hotspot radar for this maintenance run: ${message}`,
    );
    markDashboardTelemetryCached("x_auth_unavailable");
    await recordRunEvent("maintenance_degraded", message, { category: "x_auth" });
  }

  if (accessToken) {
    await refreshTweetAnalytics(accessToken);
    await refreshHotspotRadar(accessToken);
    await runAutoReplies(accessToken);
  } else {
    console.warn("Continuing growth maintenance with cached analytics only.");
  }

  let state = await readTweetAnalytics();
  let insights = deriveAnalyticsInsights(state);
  await refreshTrendVelocityRadar(insights, cachedHotspotItems(state));
  state = await readTweetAnalytics();
  insights = deriveAnalyticsInsights(state);
  await generateFollowUpDrafts(state, insights);
  await generateManualReplyDrafts(state, insights);
  await writeGrowthReport();
  console.log("Growth maintenance complete.");
}

async function main() {
  const eventName = optionalEnv("GITHUB_EVENT_NAME", "local");
  const cron = optionalEnv("GITHUB_EVENT_SCHEDULE");
  console.log(
    `Workflow event: ${eventName}${cron ? `, cron=${cron}` : ""}, now=${new Date().toISOString()}`,
  );

  if (await runSelfTestIfRequested()) {
    return;
  }

  if (maintenanceMode()) {
    await runGrowthMaintenance();
    return;
  }

  const peakWindow = evaluatePeakPostingWindow();
  if (!peakWindow.allowed) {
    console.log(`Skipping run outside peak posting window: ${peakWindow.reason}`);
    await recordRunEvent("skip", `outside peak posting window: ${peakWindow.reason}`, {
      category: "schedule",
    });
    return;
  }
  if (peakWindow.reason) {
    console.log(`Peak posting window: ${peakWindow.reason}`);
  }

  const fixedText = optionalEnv("TWEET_TEXT");
  const languageUtcHour = peakWindow.scheduledHour ?? new Date().getUTCHours();
  const history = fixedText ? [] : await readTweetHistory();
  const plannedLanguage = fixedText
    ? languageProfile(normalizeLanguageCode(optionalEnv("TWEET_LANGUAGE", "en")) || "en")
    : await resolveNextTweetLanguage(history, languageUtcHour, peakWindow.languageCode);
  console.log(
    `Language plan: ${plannedLanguage.code} for UTC ${String(languageUtcHour).padStart(2, "0")}:00` +
      `${peakWindow.languageCode ? ` (slot locked ${peakWindow.languageCode})` : ""}.`,
  );
  const analyticsState = await readTweetAnalytics();
  let performanceInsights = deriveAnalyticsInsights(analyticsState);
  const usageState = await readXApiUsageState();
  const creditsCircuit = evaluateXCreditsCircuit(usageState);
  if (creditsCircuit.active && !dryRunEnabled()) {
    console.log(`Skipping run by X credits circuit breaker: ${creditsCircuit.reason}`);
    await recordRunEvent("skip", `credits depleted: ${creditsCircuit.reason}`, {
      category: "credits_depleted",
      endpoint: creditsCircuit.endpoint,
      status: creditsCircuit.status,
      until: creditsCircuit.until,
    });
    return;
  }
  const budgetState = await readApiBudgetState();
  const mediaRoiGate = buildMediaRoiGate({
    insights: performanceInsights,
    usage: usageState,
    budgetState,
  });
  console.log(
    `Media ROI gate: ${mediaRoiGate.decision} (${mediaRoiGate.reason}; extra X reads=${mediaRoiGate.zeroExtraXReads ? 0 : "unknown"}).`,
  );
  const hourlyLoadBalancer = buildHourlyLoadBalancer({ state: analyticsState, insights: performanceInsights });
  const cadencePlan = buildExperimentPlan({
    state: analyticsState,
    insights: performanceInsights,
    usage: usageState,
    budgetState,
  });
  const topicTimingRouterForCadence = buildCachedTopicTimingRouterForCadence({
    state: analyticsState,
    insights: performanceInsights,
    usage: usageState,
    experimentPlan: cadencePlan,
    hourlyLoadBalancer,
  });
  const cadence = buildGrowthCadenceController({
    state: analyticsState,
    insights: performanceInsights,
    usage: usageState,
    budgetState,
    experimentPlan: cadencePlan,
    hourlyLoadBalancer,
    topicTimingRouter: topicTimingRouterForCadence,
    fixedText: Boolean(fixedText),
    languageCode: plannedLanguage?.code || peakWindow.languageCode || null,
  });
  if (shouldEnforceCadence(cadence)) {
    console.log(`Skipping run by cadence controller: ${cadence.reason}`);
    await recordRunEvent("skip", `cadence skip: ${cadence.reason}`, {
      category: "schedule",
      reasonCode: cadence.reasonCode,
      mode: cadence.mode,
      enforcement: cadence.enforcement,
      nextAction: cadence.nextAction,
    });
    return;
  }
  if (cadence.enabled && !cadence.publishAllowed) {
    console.log(`Cadence advisory (${cadence.reasonCode}): ${cadence.reason}`);
  } else if (cadence.enabled) {
    console.log(`Cadence controller: ${cadence.mode} (${cadence.reason})`);
  }
  if (hourlyLoadBalancer?.nextWindow) {
    console.log(
      `Learned UTC window: current ${hourlyLoadBalancer.currentHour.label} score=${formatNumber(hourlyLoadBalancer.currentHour.loadScore, 1)}, next ${hourlyLoadBalancer.nextWindow.label} in ${formatNumber(hourlyLoadBalancer.nextWindow.hoursFromNow, 1)}h.`,
    );
  }
  if (topicTimingRouterForCadence?.activeLane) {
    const lane = topicTimingRouterForCadence.activeLane;
    console.log(
      `Topic timing gate: ${lane.windowLabel || utcHourLabel(lane.hour)} UTC / ${lane.pillarLabel || lane.pillarId || "-"} / ${lane.formatLabel || lane.formatId || "-"} in ${formatNumber(lane.hoursFromNow, 1)}h; score=${formatNumber(topicTimingRouterForCadence.routerScore, 1)}; X reads=0.`,
    );
  }

  if (!dryRunEnabled()) {
    console.log("Checking X OAuth before generating tweet.");
    await getXAccessTokenWithFallback();
  }

  let tweet;
  let selectedStory;
  let language;
  let imageContext;
  let imagePlan;
  let selectedCandidate;
  let generationDecisionTrace;
  let composeInput = null;

  if (fixedText) {
    imagePlan = await resolveImageAttachmentPlan({ mediaRoiGate });
  } else {
    const languageForRun = plannedLanguage;
    const { items: newsItems, ranked } = await fetchNewsItems(
      performanceInsights,
      cachedHotspotItems(analyticsState),
    );
    const buildNotes = await loadBuildInPublicNotes({
      filePath: optionalEnv("TWEET_BUILD_IN_PUBLIC_FILE", ".github/content/build-in-public.jsonl"),
      inline: optionalEnv("TWEET_BUILD_IN_PUBLIC_NOTES"),
      maxAgeDays: numberEnv("TWEET_BUILD_IN_PUBLIC_MAX_AGE_DAYS", 45, 1, 365),
      limit: integerEnv("TWEET_BUILD_IN_PUBLIC_LIMIT", 20, 1, 50),
    });

    if (!ranked.length && !buildNotes.length) {
      console.log("Skipping run: no RSS stories or build-in-public notes available.");
      await recordRunEvent("skip", "no hybrid content available", { category: "content" });
      return;
    }

    let selected = ranked[0] || null;
    let verdict = null;
    if (ranked.length) {
      const pick = await pickPostableStory(ranked, languageForRun);
      if (pick) {
        selected = pick.story;
        verdict = pick.verdict;
      }
    }

    const hybridStory = chooseHybridContent({
      selectedNews: selected,
      buildNotes,
      buildRatio: numberEnv("TWEET_BUILD_IN_PUBLIC_RATIO", 0.35, 0, 0.9),
      seed: `${new Date().toISOString().slice(0, 13)}:${languageForRun?.code || "en"}`,
    });
    if (!hybridStory) {
      console.log("Skipping run; no post-worthy hybrid content found.");
      await recordRunEvent("skip", "no post-worthy hybrid content found", {
        category: "content",
      });
      return;
    }
    if (hybridStory.contentKind === "build_in_public") {
      console.log(`Hybrid content: build-in-public note ${hybridStory.buildNote?.id || "-"}.`);
    } else {
      console.log(`Hybrid content: news take ${hybridStory.title || "-"}.`);
    }

    imagePlan = await resolveImageAttachmentPlan({
      story: hybridStory,
      language: languageForRun,
      verdict,
      mediaRoiGate,
    });

    composeInput = {
      story: hybridStory,
      language: languageForRun,
      newsItems,
      buildNotes,
      history,
      performanceInsights,
    };
  }

  console.log(
    imagePlan.attachImage
      ? `Image plan: attach image (${imagePlan.reason})`
      : `Image plan: text only (${imagePlan.reason})`,
  );

  const budget = await evaluatePostBudget(imagePlan.attachImage);
  if (!budget.allowed) {
    if (imagePlan.attachImage) {
      const textBudget = await evaluatePostBudget(false);
      if (textBudget.allowed) {
        console.log(`Downgrading image post to text-only to protect X API budget: ${budget.reason}`);
        await recordRunEvent("budget_downgrade", `image downgraded to text-only: ${budget.reason}`, {
          category: "budget",
        });
        imagePlan = {
          attachImage: false,
          reason: `budget downgrade from image: ${budget.reason}`,
        };
        budget.allowed = true;
        budget.state = textBudget.state;
        budget.projectedCost = textBudget.projectedCost;
      } else {
        console.log(`Skipping run to protect X API budget: ${textBudget.reason}`);
        await recordRunEvent("skip", `budget skip: ${textBudget.reason}`, {
          category: "budget",
        });
        return;
      }
    } else {
      console.log(`Skipping run to protect X API budget: ${budget.reason}`);
      await recordRunEvent("skip", `budget skip: ${budget.reason}`, {
        category: "budget",
      });
      return;
    }
  }

  if (fixedText) {
    ({ tweet, selectedStory, language, imageContext, selectedCandidate, generationDecisionTrace } = await generateTweet());
  } else {
    ({ tweet, selectedStory, language, imageContext, selectedCandidate, generationDecisionTrace } = await composeTweet(composeInput));
  }

  console.log(`Generated tweet (${countCharacters(tweet)} chars): ${tweet}`);

  if (dryRunEnabled()) {
    console.log("Dry run enabled; skipping X publish, budget spend, archive, and runtime state mutation.");
    return;
  }

  let result;
  let mediaId;
  let accessToken;
  try {
    ({ result, mediaId, accessToken } = await publishTweetWithFallback(
      tweet,
      imageContext,
      imagePlan,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof XCreditsDepletedError || /credits depleted|credits-depleted/i.test(message)) {
      console.log(`Skipping publish because X credits are depleted: ${message}`);
      await recordRunEvent("skip", `credits depleted during publish: ${message}`, {
        category: "credits_depleted",
      });
      return;
    }
    throw error;
  }
  const tweetId = result?.data?.id || null;

  await recordApiSpend(budget.projectedCost, Boolean(mediaId));
  await persistTweetHistory(tweet);
  if (language?.code) {
    await persistTweetLanguage(language.code);
  }
  if (selectedStory) {
    await persistNewsPickerState(selectedStory);
  }
  await recordPostedTweetAnalytics({
    tweet,
    tweetId,
    mediaId,
    selectedStory,
    language,
    imagePlan,
    selectedCandidate,
    generationDecisionTrace,
  });
  await appendTweetArchive({
    tweet,
    tweetId,
    mediaId,
    selectedStory,
    language,
    selectedCandidate,
    generationDecisionTrace,
  });
  if (accessToken && isTruthy(optionalEnv("TWEET_REFRESH_METRICS_AFTER_POST", "false"))) {
    await refreshTweetAnalytics(accessToken);
  }
  await recordRunEvent("posted", `tweet posted: ${tweetId || "unknown id"}`, {
    category: "x_api",
    tweetId,
    hasMedia: Boolean(mediaId),
    source: selectedStory?.source || null,
    templateId: selectedCandidate?.templateId || null,
  });
  console.log(`Tweet posted: ${tweetId || "unknown id"}`);
}

main().catch(async (error) => {
  console.error(error);
  await recordRunEvent("error", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
