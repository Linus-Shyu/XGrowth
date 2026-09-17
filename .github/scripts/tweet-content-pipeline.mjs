import { readFile } from "node:fs/promises";

const AI_SLOP_PATTERNS = [
  {
    reason: "generic_ai_filler",
    pattern:
      /\b(in today'?s (?:fast[- ]paced|rapidly evolving) (?:world|landscape)|the future is here|only time will tell|it remains to be seen|this is just the beginning|exciting times ahead|a testament to|marks? a significant milestone)\b|在(?:当今|这个)(?:快速发展|日新月异)的时代|未来已来|让我们拭目以待|这仅仅是开始|令人兴奋的时代|标志着一个重要里程碑/i,
  },
  {
    reason: "empty_importance_claim",
    pattern:
      /\b(?:underscores?|highlights?|showcases?|demonstrates?) (?:the )?(?:growing |critical |transformative )?(?:importance|potential|power) of\b|凸显了.{0,12}(?:重要性|巨大潜力)|展示了.{0,12}(?:力量|潜力)/i,
  },
  {
    reason: "engagement_bait",
    pattern:
      /\bwhat do you think\b|\bthoughts\??$|\bagree or disagree\b|\blet that sink in\b|\bprove me wrong\b|\bhot take:?\b|你怎么看[？?]?$|大家怎么看|同意吗[？?]?|打脸我|来反驳我/i,
  },
  {
    reason: "consultant_filler",
    pattern:
      /\b(?:businesses|companies|developers|teams) (?:must|need to|should) (?:adapt|innovate|embrace|stay ahead)\b|(?:企业|团队|开发者)(?:必须|需要|应该)(?:拥抱变化|积极创新|顺势而为|跟上时代)/i,
  },
];

const ENGLISH_SYSTEM_PROMPT = [
  "You are Linus Shyu: elite indie developer, CTO-minded operator, and growth hacker writing for Tech Twitter.",
  "You drop concentrated truth bombs average developers are afraid to say. Optimize for BOOKMARKS and QUOTE TWEETS via dense value or polarizing-but-evidenced engineering opinions.",
  "CRITICAL GROWTH RULES:",
  "1) SCROLL-STOPPER HOOK: first sentence triggers FOMO, challenges a popular belief, or states a shocking result (time/money/latency/cost saved or burned).",
  "2) THE VILLAIN: position the take against a concrete villain (bloated stacks, slow process, lazy AI wrappers, cargo-cult best practices)—never a vague enemy.",
  "3) BOOKMARK BAIT: pack exact numbers, named tools/APIs, constraints, or architectural decisions so the post feels worth saving.",
  "4) ARROGANT BUT HELPFUL: sound highly competent; give away the playbook, not vibes.",
  "5) NO CHEAP BAIT: never ask What do you think / Thoughts / Prove me wrong. Drop the mic; leave tension for informed replies.",
  "Ground every claim in the PRIMARY CONTENT INPUT (news take or build-in-public note). Never recap a headline. Never invent undocumented APIs or fake metrics. One post, one idea. Short concrete sentences. No newsroom voice, brand voice, consultant filler, or AI slop.",
].join(" ");

const CHINESE_SYSTEM_PROMPT = [
  "你是 Linus Shyu：带反叛精神的独立开发者、CTO 与流量黑客，中文 X 账号追求降维打击式增长。",
  "你手里有普通开发者不知道的作弊代码，用极其精炼锋利的语言撕开行业假象，输出让人忍不住收藏的硬核干货。",
  "涨粉军规：",
  "1）制造情绪波动：首句是暴论、打破常识的判断，或有冲击力的真实数据（削掉多少成本、干掉哪个方案）。",
  "2）高价值信息差：抛一个别人踩不到的坑、一个冷门配置、一条容易被忽略的限制，让人觉得不收藏就亏。",
  "3）踩一捧一（技术向）：明确拉踩低效臃肿的旧方案，制造值得辩论的技术分歧。",
  "4）绝对自信：断言语气，去掉“可能”“或许”“我个人认为”。",
  "5）诱导动作：用隐性指令替代无脑提问，例如“把这段加进你的 CI”“别再为这个交智商税”。",
  "硬约束：所有暴论、数字、坑都必须来自 PRIMARY CONTENT INPUT（新闻或 Build in Public 素材），不得编造接口、特性或指标；拉踩针对方案而非具体个人；不用“你怎么看”式诱饵；一条只讲一个洞察；正文短句、结论先行。",
].join("");

const ENGLISH_GROWTH_EXAMPLES = {
  build_in_public: {
    source: "Moved from Python to Bun for GitHub Actions, saved time",
    bad: "Switched the x_bot backend from Python to Bun in GitHub Actions. We saw a 70% decrease in run times! Good day for optimizations.",
    good: "Stop using Python for your automation scripts.\nRewrote the x_bot pipeline in Bun for GitHub Actions.\nCold starts vanished. Execution time dropped 70%.\nCompute costs approaching zero.\nStop paying for bloated execution times.",
  },
  news_take: {
    source: "Vercel launches new pricing",
    bad: "Vercel's new pricing is out. It looks like it will save developers a lot of money on bandwidth.",
    good: "Everyone is cheering Vercel's new pricing, but they missed the trap.\nThe bandwidth is cheaper, but the compute multiplier just quietly killed your edge-heavy architecture.\nMove your heavy lifting back to a cheap VPS.\nHere is the math.",
  },
};

const CHINESE_GROWTH_EXAMPLES = {
  build_in_public: {
    source: "用 DeepSeek 替换 OpenAI 且关掉 thinking 省钱",
    bad: "测试了一下 DeepSeek v4-flash，把 thinking 关掉后，生成质量尚可，但 API 成本大大降低了，适合跑自动化任务。",
    good: "还在给 OpenAI 交高昂的 API 智商税？跑自动化推文，直接切 DeepSeek v4-flash 并强制关闭 thinking 模式。文本质量肉眼无感下降，但单次调用的成本直接被按在地上摩擦。这才是现阶段 AI 自动化的最优解，别再盲信昂贵的推理模型了。",
  },
  news_take: {
    source: "某个大厂开源了新的前端框架",
    bad: "XXX 厂开源了新框架，带来了全新的状态管理思路，值得前端开发者学习。",
    good: "XXX 厂的新开源框架纯属过度设计（Over-engineering）的狂欢。99% 的独立产品根本不需要这么重的状态流转逻辑。老老实实写原生或者最基础的 React，把省下来的 10 个小时拿去优化核心业务逻辑，你的 MRR 会感谢你。",
  },
};

function formatGrowthExampleBlock(example) {
  if (!example) return "";
  return [
    `Source: ${example.source}`,
    `BAD (do not write like this): ${example.bad}`,
    `GOOD (match this energy): ${example.good}`,
  ].join("\n");
}

export function growthFewShotExamples(languageCode, contentType = "news_take") {
  const isZh = String(languageCode || "").toLowerCase().startsWith("zh")
    || String(languageCode || "").toLowerCase().includes("chinese");
  const library = isZh ? CHINESE_GROWTH_EXAMPLES : ENGLISH_GROWTH_EXAMPLES;
  const kind = String(contentType) === "build_in_public" ? "build_in_public" : "news_take";
  const primary = library[kind];
  const secondary = library[kind === "build_in_public" ? "news_take" : "build_in_public"];
  return [
    "Good vs bad tweet examples (Growth version). Match GOOD; never copy BAD:",
    "",
    `[${kind === "build_in_public" ? "Build-in-Public" : "News"}]`,
    formatGrowthExampleBlock(primary),
    "",
    `[${kind === "build_in_public" ? "News" : "Build-in-Public"}]`,
    formatGrowthExampleBlock(secondary),
  ].join("\n");
}

function cleanText(value, max = 1_000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : String(value || "").split(/[,，]/);
  return [...new Set(tags.map((tag) => cleanText(tag, 40).toLowerCase()).filter(Boolean))].slice(0, 8);
}

function normalizeBuildNote(raw, index, now = new Date()) {
  if (!raw || typeof raw !== "object") return null;
  const summary = cleanText(raw.summary || raw.text || raw.progress || raw.problem, 600);
  if (!summary) return null;

  const date = cleanText(raw.date || raw.createdAt || raw.updatedAt, 64);
  const timestamp = date ? Date.parse(date) : Number.NaN;
  const ageHours = Number.isFinite(timestamp)
    ? Math.max(0, (now.getTime() - timestamp) / 3_600_000)
    : null;

  return {
    id: cleanText(raw.id, 100) || `build-note-${index + 1}`,
    kind: cleanText(raw.kind || raw.type, 40) || "progress",
    product: cleanText(raw.product || raw.project, 100),
    summary,
    detail: cleanText(raw.detail || raw.context || raw.lesson, 700),
    evidence: cleanText(raw.evidence || raw.metric || raw.result, 300),
    status: cleanText(raw.status, 40) || "active",
    date: date || null,
    ageHours,
    tags: normalizeTags(raw.tags),
    public: raw.public !== false,
  };
}

function parseInlineNotes(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((summary, index) => ({ id: `inline-${index + 1}`, summary }));
  }
}

async function readJsonLines(filePath) {
  if (!filePath) return [];
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          console.warn(`Ignoring invalid build-in-public JSONL line ${index + 1}: ${error.message}`);
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Cannot read build-in-public notes from ${filePath}: ${error.message}`);
    }
    return [];
  }
}

export async function loadBuildInPublicNotes({
  filePath = ".github/content/build-in-public.jsonl",
  inline = "",
  now = new Date(),
  maxAgeDays = 45,
  limit = 20,
} = {}) {
  const raw = [...parseInlineNotes(inline), ...(await readJsonLines(filePath))];
  const notes = raw
    .map((item, index) => normalizeBuildNote(item, index, now))
    .filter((note) => note?.public && note.status !== "private")
    .filter((note) => note.ageHours == null || note.ageHours <= maxAgeDays * 24)
    .sort((left, right) => {
      const evidenceDelta = Number(Boolean(right.evidence)) - Number(Boolean(left.evidence));
      if (evidenceDelta) return evidenceDelta;
      return (left.ageHours ?? Number.MAX_SAFE_INTEGER) - (right.ageHours ?? Number.MAX_SAFE_INTEGER);
    });
  return notes.slice(0, limit);
}

function stableFraction(seed) {
  let hash = 2_166_136_261;
  for (const char of String(seed || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

export function chooseHybridContent({
  selectedNews = null,
  buildNotes = [],
  buildRatio = 0.35,
  seed = new Date().toISOString().slice(0, 13),
} = {}) {
  const note = buildNotes[0] || null;
  if (!selectedNews && !note) return null;
  if (!selectedNews) return buildNoteToStory(note);
  if (!note) return { ...selectedNews, contentKind: "news_take" };

  const ratio = Math.min(0.9, Math.max(0, Number(buildRatio) || 0));
  return stableFraction(seed) < ratio
    ? buildNoteToStory(note)
    : { ...selectedNews, contentKind: "news_take" };
}

export function buildNoteToStory(note) {
  if (!note) return null;
  const subject = note.product || note.kind || "Build in Public";
  return {
    title: `${subject}: ${note.summary.slice(0, 140)}`,
    summary: [note.summary, note.detail, note.evidence ? `Evidence: ${note.evidence}` : ""]
      .filter(Boolean)
      .join(" "),
    source: "build-in-public",
    sourceTier: "first_party",
    published: note.date,
    link: "",
    hotScore: 5,
    crossSourceEchoes: 0,
    contentKind: "build_in_public",
    buildNote: note,
  };
}

function formatBuildNote(note, selected = false) {
  const parts = [
    selected ? "PRIMARY BUILD LOG" : "Build log",
    note.product ? `product: ${note.product}` : null,
    `kind: ${note.kind}`,
    `event: ${note.summary}`,
    note.detail ? `constraint/lesson: ${note.detail}` : null,
    note.evidence ? `evidence: ${note.evidence}` : null,
    note.tags.length ? `tags: ${note.tags.join(", ")}` : null,
    note.date ? `date: ${note.date}` : null,
  ];
  return parts.filter(Boolean).join(" | ");
}

export function formatHybridContentContext({
  selected,
  newsItems = [],
  buildNotes = [],
  formatNewsItem,
} = {}) {
  if (selected?.contentKind === "build_in_public") {
    return [
      "PRIMARY CONTENT INPUT — BUILD IN PUBLIC (write from this first-party event, not from RSS):",
      formatBuildNote(selected.buildNote, true),
      "",
      "CURRENT TECH PULSE (optional framing only; do not turn this into a news summary):",
      ...newsItems.slice(0, 3).map((item, index) => formatNewsItem(item, index)),
    ].join("\n");
  }

  return [
    "PRIMARY CONTENT INPUT — CURATED TECH NEWS (write a sharp take, not a summary):",
    formatNewsItem(selected, 0, { selected: true }),
    buildNotes.length ? "" : null,
    buildNotes.length ? "FIRST-PARTY BUILDER CONTEXT (use only if it creates a real operator insight):" : null,
    ...buildNotes.slice(0, 2).map((note) => formatBuildNote(note)),
    "",
    "Other recent stories (context only; do not summarize multiple stories):",
    ...newsItems
      .filter((item) => item.link !== selected?.link)
      .slice(0, 4)
      .map((item, index) => formatNewsItem(item, index + 1)),
  ]
    .filter((line) => line != null)
    .join("\n");
}

export function systemPromptForLanguage(languageCode) {
  return String(languageCode || "").toLowerCase().startsWith("zh")
    ? CHINESE_SYSTEM_PROMPT
    : ENGLISH_SYSTEM_PROMPT;
}

function substantiveTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/#[\p{L}\p{N}_-]+/gu, "")
    .match(/[\p{Script=Han}]|[a-z0-9][a-z0-9+._-]*/gu) || [];
}

export function hybridQualityIssues(text, { languageCode = "", contentKind = "news_take" } = {}) {
  const trimmed = String(text || "").trim();
  const issues = [];
  const isZh = languageCode === "zh" || /[\u4e00-\u9fff]/.test(trimmed);
  const tokens = substantiveTokens(trimmed);

  for (const { reason, pattern } of AI_SLOP_PATTERNS) {
    if (pattern.test(trimmed)) issues.push({ severity: "block", reason });
  }

  if (tokens.length < (isZh ? 20 : 18)) {
    issues.push({ severity: "warn", reason: "low_information_density" });
  }

  const concreteSignals = [
    /\d/,
    /\b(?:api|sdk|cli|latency|token|cache|oauth|deploy|build|bug|users?|revenue|mrr|conversion|retention|cost|pricing|model|database|queue|release|shipped)\b/i,
    /(?:接口|延迟|缓存|鉴权|部署|构建|错误|用户|收入|转化|留存|成本|定价|模型|数据库|队列|发布|上线)/,
    /\b[A-Z][A-Za-z0-9+._-]{2,}\b/,
  ].filter((pattern) => pattern.test(trimmed)).length;
  if (concreteSignals === 0) {
    issues.push({ severity: "block", reason: "no_concrete_signal" });
  }

  if (
    contentKind === "build_in_public" &&
    !/\b(?:I|we|my|our|shipped|built|cut|fixed|removed|tested|learned|lost|spent|failed)\b|(?:我|我们|刚|上线|发布|修了|删了|踩坑|测试|花了|失败|学到)/i.test(trimmed)
  ) {
    issues.push({ severity: "block", reason: "build_log_without_lived_experience" });
  }

  if ((trimmed.match(/[!！]/g) || []).length > 1) {
    issues.push({ severity: "warn", reason: "excessive_exclamation" });
  }

  return issues;
}
