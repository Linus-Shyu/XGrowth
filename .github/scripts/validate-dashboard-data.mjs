#!/usr/bin/env node

import fs from "node:fs";

const file = process.argv[2] || process.env.DASHBOARD_DATA_FILE || ".github/runtime/dashboard-data.json";

class DashboardValidationError extends Error {
  constructor(message, details = "") {
    super(message);
    this.name = "DashboardValidationError";
    this.details = details;
  }
}

function fail(message, details = "") {
  throw new DashboardValidationError(message, details);
}

function printValidationError(error) {
  console.error(`Dashboard data validation failed: ${error.message}`);
  if (error.details) console.error(error.details);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertNear(label, actual, expected, tolerance = 0.005) {
  if (Math.abs(number(actual) - number(expected)) > tolerance) {
    fail(`${label} mismatch.`, `actual=${actual}, expected=${expected}`);
  }
}

function readDashboardData(path) {
  if (!fs.existsSync(path)) fail(`file does not exist: ${path}`);
  if (!fs.statSync(path).size) fail(`file is empty: ${path}`);
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    fail(`file is not valid JSON: ${path}`, error instanceof Error ? error.message : String(error));
  }
}

function assertNoMarketingVocabulary(data) {
  const serialized = JSON.stringify(data);
  const banned = [
    [/\bfollowers\b/i, "use active conns / ingress node strength"],
    [/\bimpressions\b/i, "use L7 events / traffic load in dashboard-facing text"],
    [/\btweet analytics\b/i, "use packet analytics"],
  ];
  for (const [pattern, replacement] of banned) {
    if (pattern.test(serialized)) {
      fail(`dashboard JSON contains forbidden dashboard vocabulary; ${replacement}.`, String(pattern));
    }
  }
}

const DASHBOARD_VISIBLE_STRING_SKIP_KEYS = new Set([
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

function collectDashboardVisibleStrings(value, key = "", pointer = "$") {
  if (typeof value === "string") {
    if (
      DASHBOARD_VISIBLE_STRING_SKIP_KEYS.has(key) ||
      /^https?:\/\//i.test(value) ||
      /^\d{4}-\d{2}-\d{2}T/.test(value)
    ) {
      return [];
    }
    return [{ pointer, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectDashboardVisibleStrings(item, key, `${pointer}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([entryKey, entryValue]) =>
      collectDashboardVisibleStrings(entryValue, entryKey, `${pointer}.${entryKey}`),
    );
  }
  return [];
}

function assertDashboardVisibleTextClean(label, value) {
  const bannedVocabulary = [
    [/\bfollowers?\b/i, "Ingress Node Strength / Active Conns"],
    [/\bimpressions?\b/i, "Total Ingestion Throughput / L7 Traffic Load"],
    [/\bviews\b/i, "L7 events / throughput"],
    [/\berrors?\b/i, "HTTP Status Triage"],
    [/\btweets?\b/i, "packets / dispatches"],
    [/\bpost(?:s|ing)?\b/i, "packets / dispatches"],
  ];
  const unsafeAutomation = [
    /(enable|allow|publish|send|post|dispatch).{0,80}auto[-_ ]?repl(?:y|ies)/i,
    /(bypass|circumvent).{0,40}rate[-_ ]?limit/i,
  ];

  for (const item of collectDashboardVisibleStrings(value)) {
    for (const [pattern, replacement] of bannedVocabulary) {
      if (pattern.test(item.value)) {
        fail(`${label} contains forbidden dashboard vocabulary at ${item.pointer}; use ${replacement}.`, item.value);
      }
    }
    for (const pattern of unsafeAutomation) {
      if (pattern.test(item.value)) {
        fail(`${label} contains unsafe automation wording at ${item.pointer}.`, item.value);
      }
    }
  }
}

const HTTP_STATUS_BUCKET_IDS = ["success2xx", "client4xx", "auth4xx", "rateLimit429", "backend5xx"];

function normalizedHttpStatus(status) {
  const code = Number.parseInt(String(status ?? ""), 10);
  return Number.isFinite(code) ? code : null;
}

function httpStatusBucketId(code) {
  if (code === 429) return "rateLimit429";
  if (code >= 500) return "backend5xx";
  if (code === 401 || code === 403) return "auth4xx";
  if (code >= 400) return "client4xx";
  if (code >= 200 && code < 300) return "success2xx";
  return null;
}

function endpointStatusCounts(endpoint = {}) {
  const counts = {};
  for (const [status, count] of Object.entries(endpoint.statuses || {})) {
    const code = normalizedHttpStatus(status);
    const value = number(count);
    if (!code || value <= 0) continue;
    counts[String(code)] = (counts[String(code)] || 0) + value;
  }
  if (!Object.keys(counts).length && endpoint.lastStatus != null) {
    const code = normalizedHttpStatus(endpoint.lastStatus);
    if (code) {
      counts[String(code)] = code >= 400
        ? Math.max(1, number(endpoint.failures))
        : Math.max(1, number(endpoint.calls));
    }
  }
  return counts;
}

function buildExpectedApiStatusTriage(api = {}) {
  const buckets = Object.fromEntries(HTTP_STATUS_BUCKET_IDS.map((id) => [id, { count: 0, endpoints: new Map() }]));
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
  const incidents = [];

  for (const endpoint of api.endpoints || []) {
    const endpointName = endpoint.name || "-";
    const calls = number(endpoint.calls);
    const failures = number(endpoint.failures);
    const statuses = endpointStatusCounts(endpoint);
    const local = {
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

    const latestCode = normalizedHttpStatus(endpoint.lastStatus);
    if (latestCode === 429) {
      totals.activeRateLimit429 += 1;
      local.activeRateLimit429 += 1;
    } else if (latestCode >= 500) {
      totals.activeBackendFault5xx += 1;
      local.activeBackendFault5xx += 1;
    } else if (latestCode === 401 || latestCode === 403) {
      totals.activeAuthFault4xx += 1;
      local.activeAuthFault4xx += 1;
    } else if (latestCode >= 400) {
      totals.activeClientFault4xx += 1;
      local.activeClientFault4xx += 1;
    }

    for (const [status, countValue] of Object.entries(statuses)) {
      const code = normalizedHttpStatus(status);
      const count = number(countValue);
      const bucketId = code ? httpStatusBucketId(code) : null;
      if (!bucketId || count <= 0) continue;
      buckets[bucketId].count += count;
      buckets[bucketId].endpoints.set(endpointName, (buckets[bucketId].endpoints.get(endpointName) || 0) + count);
      if (bucketId === "success2xx") totals.success2xx += count;
      if (bucketId === "rateLimit429") {
        totals.rateLimit429 += count;
        local.rateLimit429 += count;
      } else if (bucketId === "backend5xx") {
        totals.backendFault5xx += count;
        local.backendFault5xx += count;
      } else if (bucketId === "auth4xx") {
        totals.authFault4xx += count;
        local.authFault4xx += count;
      } else if (bucketId === "client4xx") {
        totals.clientFault4xx += count;
        local.clientFault4xx += count;
      }
    }

    if (failures || local.rateLimit429 || local.backendFault5xx || local.authFault4xx || local.clientFault4xx) {
      const active = Boolean(
        local.activeRateLimit429 ||
        local.activeBackendFault5xx ||
        local.activeAuthFault4xx ||
        local.activeClientFault4xx,
      );
      incidents.push({
        endpoint: endpointName,
        active,
        failures,
        ...local,
      });
    }
  }

  const severity = totals.activeRateLimit429 || totals.activeBackendFault5xx
    ? "danger"
    : totals.activeAuthFault4xx || totals.activeClientFault4xx
      ? "warn"
      : totals.totalFailures
        ? "cached"
        : "ok";
  return {
    ...totals,
    severity,
    failureRate: totals.totalCalls ? Number(((totals.totalFailures / totals.totalCalls) * 100).toFixed(2)) : 0,
    statusMatrix: HTTP_STATUS_BUCKET_IDS.map((id) => ({
      id,
      count: buckets[id].count,
      sharePct: totals.totalCalls ? Number(((buckets[id].count / totals.totalCalls) * 100).toFixed(1)) : 0,
      endpoints: [...buckets[id].endpoints.entries()]
        .sort((left, right) => number(right[1]) - number(left[1]))
        .map(([endpoint, count]) => ({ endpoint, count })),
    })),
    incidents,
  };
}

function assertApiStatusTriage(data) {
  const api = data.api;
  const triage = api?.statusTriage;
  if (!triage || typeof triage !== "object") {
    fail("missing api.statusTriage telemetry.");
  }
  const expected = buildExpectedApiStatusTriage(api || {});
  for (const key of [
    "totalCalls",
    "totalFailures",
    "success2xx",
    "rateLimit429",
    "backendFault5xx",
    "authFault4xx",
    "clientFault4xx",
    "activeRateLimit429",
    "activeBackendFault5xx",
    "activeAuthFault4xx",
    "activeClientFault4xx",
  ]) {
    assertNear(`api.statusTriage ${key}`, triage[key], expected[key]);
  }
  assertNear("api.statusTriage failureRate", triage.failureRate, expected.failureRate, 0.01);
  if (triage.severity !== expected.severity) {
    fail("api.statusTriage severity drifted.", `actual=${triage.severity}, expected=${expected.severity}`);
  }

  const rows = new Map((Array.isArray(triage.statusMatrix) ? triage.statusMatrix : []).map((row) => [row.id, row]));
  for (const expectedRow of expected.statusMatrix) {
    const row = rows.get(expectedRow.id);
    if (!row) fail("api.statusTriage status matrix is missing a bucket.", expectedRow.id);
    assertNear(`api.statusTriage statusMatrix.${expectedRow.id}.count`, row.count, expectedRow.count);
    assertNear(`api.statusTriage statusMatrix.${expectedRow.id}.sharePct`, row.sharePct, expectedRow.sharePct, 0.1);
    if (expectedRow.count > 0 && !Array.isArray(row.endpoints)) {
      fail("api.statusTriage status matrix bucket must expose endpoint detail.", JSON.stringify(row));
    }
  }

  const incidents = Array.isArray(triage.incidents) ? triage.incidents : [];
  const expectedIncidentEndpoints = new Set(expected.incidents.map((incident) => incident.endpoint));
  for (const endpoint of expectedIncidentEndpoints) {
    if (!incidents.some((incident) => incident.endpoint === endpoint)) {
      fail("api.statusTriage incidents are missing an endpoint fault partition.", endpoint);
    }
  }
  if ((expected.activeRateLimit429 || expected.activeBackendFault5xx) && data.rateLimitGovernor?.gates?.read !== "closed") {
    fail("active 429/5xx partitions must close the rateLimitGovernor read gate.", JSON.stringify({
      activeRateLimit429: expected.activeRateLimit429,
      activeBackendFault5xx: expected.activeBackendFault5xx,
      readGate: data.rateLimitGovernor?.gates?.read,
    }));
  }
}

function assertSignalMap(data) {
  const signalMap = data.signalMap;
  if (!signalMap || typeof signalMap !== "object") {
    fail("missing explicit signalMap telemetry.");
  }
  if (String(signalMap.source || "").toLowerCase().includes("tweet")) {
    fail("signalMap source must use packet vocabulary.", signalMap.source || "<missing>");
  }
  if (signalMap.coordinateSystem !== "percent") {
    fail("signalMap coordinateSystem must be percent.", signalMap.coordinateSystem || "<missing>");
  }

  const expectedNodeIds = ["rss", "score", "draft", "x", "learn"];
  const nodes = Array.isArray(signalMap.nodes) ? signalMap.nodes : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const nodeId of expectedNodeIds) {
    if (!nodeById.has(nodeId)) {
      fail(`signalMap missing required node: ${nodeId}.`, JSON.stringify(nodes.map((node) => node.id)));
    }
  }

  for (const node of nodes) {
    if (!(number(node.x) > 0 && number(node.x) < 1 && number(node.y) > 0 && number(node.y) < 1)) {
      fail("signalMap node coordinates must be normalized percentages.", JSON.stringify(node));
    }
  }

  const xNode = nodeById.get("x") || {};
  if (xNode.label !== "X_ROUTE") fail("x node must be labeled X_ROUTE.", JSON.stringify(xNode));
  if (xNode.unit !== "web routes") fail("x node must use web routes unit.", JSON.stringify(xNode));
  if (!/0 (?:extra )?X read ops/i.test(String(xNode.detail || ""))) {
    fail("x node must declare zero X read ops.", JSON.stringify(xNode));
  }

  const actions = Array.isArray(data.actions) ? data.actions : [];
  const drafts = Array.isArray(data.drafts) ? data.drafts : [];
  assertNear("signalMap X_ROUTE count", xNode.value, actions.length);
  assertNear("signalMap draft count", nodeById.get("draft")?.value, drafts.length);
  assertNear("signalMap learn packet count", nodeById.get("learn")?.value, data.profile?.measuredPosts);

  const topPostScores = (data.last7d?.topPosts || []).map((post) => number(post.score));
  const expectedBestScore = Math.max(number(data.profile?.baselineScore), ...topPostScores, 0);
  assertNear("signalMap best score", nodeById.get("score")?.value, expectedBestScore);
  if (Number.isFinite(number(signalMap.totals?.bestScore, NaN))) {
    assertNear("signalMap totals.bestScore", signalMap.totals.bestScore, expectedBestScore);
  }

  const endpointTotals = (data.api?.endpoints || []).reduce(
    (totals, endpoint) => ({
      calls: totals.calls + number(endpoint.calls),
      failures: totals.failures + number(endpoint.failures),
    }),
    { calls: 0, failures: 0 },
  );
  assertNear("signalMap API calls", signalMap.totals?.xApiCalls, endpointTotals.calls);
  assertNear("signalMap API failures", signalMap.totals?.xApiFailures, endpointTotals.failures);
  assertNear("signalMap API remaining", signalMap.totals?.apiRemainingUsd, number(data.api?.cap) - number(data.api?.spend));

  const routes = Array.isArray(signalMap.routes) ? signalMap.routes : [];
  if (!routes.length) fail("signalMap routes are empty.");
  for (const route of routes) {
    if (!nodeById.has(route.from) && route.from !== "core") {
      fail("signalMap route references unknown source node.", JSON.stringify(route));
    }
    if (!nodeById.has(route.to) && route.to !== "core") {
      fail("signalMap route references unknown target node.", JSON.stringify(route));
    }
  }
  if (!routes.some((route) => route.from === "x" && route.to === "learn")) {
    fail("signalMap must route X_ROUTE outcomes into Learn.");
  }
}

function assertNextWindowCommander(data) {
  const commander = data.nextWindowAngleCommander;
  if (!commander || typeof commander !== "object") {
    fail("missing nextWindowAngleCommander telemetry.");
  }
  if (commander.mode !== "zero_read_next_window_commander") {
    fail("nextWindowAngleCommander mode drifted.", commander.mode || "<missing>");
  }
  if (commander.zeroExtraXReads !== true || number(commander.estimatedXReadOps) !== 0) {
    fail("nextWindowAngleCommander must be zero-read.", JSON.stringify({
      zeroExtraXReads: commander.zeroExtraXReads,
      estimatedXReadOps: commander.estimatedXReadOps,
    }));
  }
  if (commander.readGate !== "cached_only") {
    fail("nextWindowAngleCommander read gate must be cached_only.", commander.readGate || "<missing>");
  }
  if (String(commander.source || "").toLowerCase().includes("tweet")) {
    fail("nextWindowAngleCommander source must use packet vocabulary.", commander.source || "<missing>");
  }
  const score = number(commander.commanderScore, NaN);
  if (!(score >= 0 && score <= 100)) {
    fail("nextWindowAngleCommander score must be 0..100.", String(commander.commanderScore));
  }

  const activeWindow = commander.activeWindow || {};
  const window = commander.window || {};
  const activeLabel = activeWindow.windowLabel || activeWindow.label;
  const windowLabel = window.windowLabel || window.label;
  if (!activeLabel || !windowLabel || activeLabel !== windowLabel) {
    fail("nextWindowAngleCommander window labels must match.", JSON.stringify({ activeWindow, window }));
  }
  if (number(activeWindow.hour, -1) !== number(window.hour, -2)) {
    fail("nextWindowAngleCommander activeWindow/window hours must match.", JSON.stringify({ activeWindow, window }));
  }
  if (!(number(window.hour, -1) >= 0 && number(window.hour, -1) <= 23)) {
    fail("nextWindowAngleCommander window hour must be 0..23.", JSON.stringify(window));
  }
  if (!Number.isFinite(number(window.hoursFromNow, NaN)) || number(window.hoursFromNow) < 0) {
    fail("nextWindowAngleCommander hoursFromNow must be non-negative.", JSON.stringify(window));
  }

  const activeAngle = commander.activeAngle || {};
  if (!activeAngle.formatId || !activeAngle.formatLabel) {
    fail("nextWindowAngleCommander active angle is incomplete.", JSON.stringify(activeAngle));
  }
  if (!String(commander.command || "").trim()) {
    fail("nextWindowAngleCommander command is empty.");
  }
  if (/(enable|allow|publish|send|post).{0,80}auto[-_ ]?repl(?:y|ies)/i.test(JSON.stringify(commander)) ||
      /(bypass|circumvent).{0,40}rate[-_ ]?limit/i.test(JSON.stringify(commander))) {
    fail("nextWindowAngleCommander contains unsafe automation wording.");
  }

  const actionUrls = new Set((data.actions || []).map((action) => action.url).filter(Boolean));
  if (commander.routeUrl && actionUrls.size && !actionUrls.has(commander.routeUrl)) {
    fail("nextWindowAngleCommander routeUrl must come from manual actions.", commander.routeUrl);
  }
  const gates = Array.isArray(commander.gates) ? commander.gates : [];
  if (!gates.some((gate) => gate.id === "x_read_partition" && String(gate.value || "").includes("0"))) {
    fail("nextWindowAngleCommander must expose a zero-read partition gate.", JSON.stringify(gates));
  }
}

function assertL7FireWindowRouter(data) {
  const router = data.l7FireWindowRouter;
  if (!router) return;
  if (router.mode !== "zero_read_l7_fire_window_router" && router.mode !== "derived_zero_read_l7_fire_window_router") {
    fail("l7FireWindowRouter mode drifted.", router.mode || "<missing>");
  }
  if (router.zeroExtraXReads !== true || number(router.estimatedXReadOps) !== 0) {
    fail("l7FireWindowRouter must be zero-read.", JSON.stringify({
      zeroExtraXReads: router.zeroExtraXReads,
      estimatedXReadOps: router.estimatedXReadOps,
    }));
  }
  if (!["cached_only", "closed"].includes(router.readGate)) {
    fail("l7FireWindowRouter readGate must stay cached_only or closed.", router.readGate || "<missing>");
  }
  if (!["open", "review", "closed", "guarded", "manual_route_only", "blocked"].includes(router.publishGate)) {
    fail("l7FireWindowRouter publishGate has unknown state.", router.publishGate || "<missing>");
  }
  const lanes = Array.isArray(router.lanes) ? router.lanes : [];
  if (!lanes.length || !router.activeLane) {
    fail("l7FireWindowRouter must expose active lanes.", JSON.stringify(router));
  }
  for (const lane of lanes) {
    if (!String(lane.windowLabel || "").trim() || !String(lane.formatLabel || lane.formatId || "").trim()) {
      fail("l7FireWindowRouter lane is incomplete.", JSON.stringify(lane));
    }
  }
  assertDashboardVisibleTextClean("l7FireWindowRouter", router);
}

function assertL7SurgeSentinel(data) {
  const sentinel = data.l7SurgeSentinel;
  if (!sentinel || typeof sentinel !== "object") {
    fail("missing l7SurgeSentinel telemetry.");
  }
  if (sentinel.mode !== "zero_read_l7_surge_sentinel" && sentinel.mode !== "derived_zero_read_l7_surge_sentinel") {
    fail("l7SurgeSentinel mode drifted.", sentinel.mode || "<missing>");
  }
  if (
    sentinel.zeroExtraXReads !== true ||
    number(sentinel.estimatedXReadOps) !== 0 ||
    number(sentinel.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("l7SurgeSentinel must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: sentinel.zeroExtraXReads,
      estimatedXReadOps: sentinel.estimatedXReadOps,
      estimatedIncrementalXApiUsd: sentinel.estimatedIncrementalXApiUsd,
    }));
  }
  if (!["cached_only", "closed"].includes(sentinel.readGate)) {
    fail("l7SurgeSentinel readGate must stay cached_only or closed.", sentinel.readGate || "<missing>");
  }
  if (sentinel.operatorMode !== "human_in_loop" || sentinel.manualOnly !== true) {
    fail("l7SurgeSentinel must remain human-in-loop and manual-only.", JSON.stringify({
      operatorMode: sentinel.operatorMode,
      manualOnly: sentinel.manualOnly,
    }));
  }
  const score = number(sentinel.sentinelScore, NaN);
  if (!(score >= 0 && score <= 100)) {
    fail("l7SurgeSentinel score must be 0..100.", String(sentinel.sentinelScore));
  }
  const lanes = Array.isArray(sentinel.lanes) ? sentinel.lanes : [];
  if (!lanes.length) fail("l7SurgeSentinel lanes are empty.");
  const allowedStatuses = new Set(["hot", "ok", "watch", "warn", "danger"]);
  for (const lane of lanes) {
    if (!allowedStatuses.has(String(lane.status || ""))) {
      fail("l7SurgeSentinel lane has unknown status.", JSON.stringify(lane));
    }
    const laneScore = number(lane.score, NaN);
    if (!(laneScore >= 0 && laneScore <= 100)) {
      fail("l7SurgeSentinel lane score must be 0..100.", JSON.stringify(lane));
    }
    if (lane.zeroExtraXReads !== true || number(lane.estimatedXReadOps) !== 0) {
      fail("l7SurgeSentinel lane must be zero-read.", JSON.stringify(lane));
    }
  }
  const xReadCell = (sentinel.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("l7SurgeSentinel must expose a zero X read cell.", JSON.stringify(sentinel.cells || []));
  }
  const trace = Array.isArray(sentinel.trace) ? sentinel.trace : [];
  if (!trace.length || !trace.every((value) => Number.isFinite(number(value, NaN)) && number(value) >= 0)) {
    fail("l7SurgeSentinel trace must contain non-negative numeric values.", JSON.stringify(trace));
  }
  if (number(sentinel.traceMax) < Math.max(1, ...trace.map((value) => number(value)))) {
    fail("l7SurgeSentinel traceMax must cover trace values.", JSON.stringify({ traceMax: sentinel.traceMax, trace }));
  }
  const routeCoverage = number(sentinel.routeCoveragePct, NaN);
  if (!(routeCoverage >= 0 && routeCoverage <= 100)) {
    fail("l7SurgeSentinel routeCoveragePct must be 0..100.", String(sentinel.routeCoveragePct));
  }
  assertDashboardVisibleTextClean("l7SurgeSentinel", sentinel);
}

function assertGrowthLeakProfiler(data) {
  const profiler = data.growthLeakProfiler;
  if (!profiler || typeof profiler !== "object") {
    fail("missing growthLeakProfiler telemetry.");
  }
  if (
    profiler.mode !== "zero_read_growth_leak_profiler" &&
    profiler.mode !== "derived_zero_read_growth_leak_profiler"
  ) {
    fail("growthLeakProfiler mode drifted.", profiler.mode || "<missing>");
  }
  if (
    profiler.zeroExtraXReads !== true ||
    number(profiler.estimatedXReadOps) !== 0 ||
    number(profiler.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("growthLeakProfiler must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: profiler.zeroExtraXReads,
      estimatedXReadOps: profiler.estimatedXReadOps,
      estimatedIncrementalXApiUsd: profiler.estimatedIncrementalXApiUsd,
    }));
  }
  if (!["cached_only", "closed"].includes(profiler.readGate)) {
    fail("growthLeakProfiler readGate must stay cached_only or closed.", profiler.readGate || "<missing>");
  }
  if (profiler.operatorMode !== "human_in_loop" || profiler.manualOnly !== true) {
    fail("growthLeakProfiler must remain human-in-loop and manual-only.", JSON.stringify({
      operatorMode: profiler.operatorMode,
      manualOnly: profiler.manualOnly,
    }));
  }
  const leakScore = number(profiler.leakScore, NaN);
  if (!(leakScore >= 0 && leakScore <= 100)) {
    fail("growthLeakProfiler leakScore must be 0..100.", String(profiler.leakScore));
  }
  const stages = Array.isArray(profiler.stages) ? profiler.stages : [];
  if (stages.length < 5) fail("growthLeakProfiler stages are incomplete.");
  const allowedStatuses = new Set(["ok", "warn", "danger"]);
  for (const stage of stages) {
    if (!allowedStatuses.has(String(stage.status || ""))) {
      fail("growthLeakProfiler stage has unknown status.", JSON.stringify(stage));
    }
    const score = number(stage.score, NaN);
    const leakPct = number(stage.leakPct, NaN);
    if (!(score >= 0 && score <= 100) || !(leakPct >= 0 && leakPct <= 100)) {
      fail("growthLeakProfiler stage score/leakPct must be 0..100.", JSON.stringify(stage));
    }
    if (
      stage.zeroExtraXReads !== true ||
      number(stage.estimatedXReadOps) !== 0 ||
      number(stage.estimatedIncrementalXApiUsd) !== 0
    ) {
      fail("growthLeakProfiler stage must be zero-read and zero incremental cost.", JSON.stringify(stage));
    }
    if (!String(stage.nextAction || "").trim()) {
      fail("growthLeakProfiler stage must include an operator action.", JSON.stringify(stage));
    }
  }
  const primaryLeakId = String(profiler.primaryLeakId || "");
  if (!primaryLeakId || !stages.some((stage) => stage.id === primaryLeakId)) {
    fail("growthLeakProfiler primaryLeakId must reference a stage.", JSON.stringify({
      primaryLeakId: profiler.primaryLeakId,
      stages: stages.map((stage) => stage.id),
    }));
  }
  if (!profiler.primaryLeak || profiler.primaryLeak.id !== primaryLeakId) {
    fail("growthLeakProfiler primaryLeak must match primaryLeakId.", JSON.stringify(profiler.primaryLeak || null));
  }
  const xReadCell = (profiler.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("growthLeakProfiler must expose a zero X read cell.", JSON.stringify(profiler.cells || []));
  }
  assertDashboardVisibleTextClean("growthLeakProfiler", profiler);
}

function assertCommandPacketDock(data) {
  const dock = data.commandPacketDock;
  if (!dock || typeof dock !== "object") {
    fail("missing commandPacketDock telemetry.");
  }
  if (
    dock.mode !== "zero_read_command_packet_dock" &&
    dock.mode !== "derived_zero_read_command_packet_dock"
  ) {
    fail("commandPacketDock mode drifted.", dock.mode || "<missing>");
  }
  if (
    dock.zeroExtraXReads !== true ||
    number(dock.estimatedXReadOps) !== 0 ||
    number(dock.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("commandPacketDock must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: dock.zeroExtraXReads,
      estimatedXReadOps: dock.estimatedXReadOps,
      estimatedIncrementalXApiUsd: dock.estimatedIncrementalXApiUsd,
    }));
  }
  if (dock.readGate !== "browser_only" || dock.operatorMode !== "human_in_loop" || dock.manualOnly !== true) {
    fail("commandPacketDock must remain browser-only, manual-only, and human-in-loop.", JSON.stringify({
      readGate: dock.readGate,
      operatorMode: dock.operatorMode,
      manualOnly: dock.manualOnly,
    }));
  }
  const commandScore = number(dock.commandScore, NaN);
  if (!(commandScore >= 0 && commandScore <= 100)) {
    fail("commandPacketDock commandScore must be 0..100.", String(dock.commandScore));
  }
  const packet = dock.primaryPacket;
  if (!packet || typeof packet !== "object") {
    fail("commandPacketDock must include a primaryPacket.");
  }
  if (
    packet.zeroExtraXReads !== true ||
    number(packet.estimatedXReadOps) !== 0 ||
    number(packet.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("commandPacketDock primaryPacket must be zero-read and zero incremental cost.", JSON.stringify(packet));
  }
  if (packet.status === "ready" && (!/^https:\/\/x\.com\//i.test(String(packet.openUrl || "")) || !String(packet.pastePayload || "").trim())) {
    fail("commandPacketDock ready packet must include an X web route and paste payload.", JSON.stringify(packet));
  }
  if (!String(packet.editRule || "").trim() || !String(packet.skipRule || "").trim() || !String(packet.doneSignal || "").trim()) {
    fail("commandPacketDock primaryPacket must include edit/skip/done rules.", JSON.stringify(packet));
  }
  const steps = Array.isArray(dock.steps) ? dock.steps : [];
  if (steps.length < 4) fail("commandPacketDock steps are incomplete.");
  const allowedStepStatuses = new Set(["ok", "warn", "danger"]);
  for (const step of steps) {
    if (!String(step.id || "").trim() || !String(step.label || "").trim() || !String(step.detail || "").trim()) {
      fail("commandPacketDock step is incomplete.", JSON.stringify(step));
    }
    if (!allowedStepStatuses.has(String(step.status || ""))) {
      fail("commandPacketDock step has unknown status.", JSON.stringify(step));
    }
  }
  const xReadCell = (dock.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("commandPacketDock must expose a zero X read cell.", JSON.stringify(dock.cells || []));
  }
  assertDashboardVisibleTextClean("commandPacketDock", dock);
}

function assertIdentityConversionFirewall(data) {
  const firewall = data.identityConversionFirewall;
  if (!firewall || typeof firewall !== "object") {
    fail("missing identityConversionFirewall telemetry.");
  }
  if (
    firewall.mode !== "zero_read_identity_conversion_firewall" &&
    firewall.mode !== "derived_zero_read_identity_conversion_firewall"
  ) {
    fail("identityConversionFirewall mode drifted.", firewall.mode || "<missing>");
  }
  if (
    firewall.zeroExtraXReads !== true ||
    number(firewall.estimatedXReadOps) !== 0 ||
    number(firewall.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("identityConversionFirewall must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: firewall.zeroExtraXReads,
      estimatedXReadOps: firewall.estimatedXReadOps,
      estimatedIncrementalXApiUsd: firewall.estimatedIncrementalXApiUsd,
    }));
  }
  if (firewall.readGate !== "cached_only" || firewall.operatorMode !== "human_in_loop" || firewall.manualOnly !== true) {
    fail("identityConversionFirewall must remain cached-only, manual-only, and human-in-loop.", JSON.stringify({
      readGate: firewall.readGate,
      operatorMode: firewall.operatorMode,
      manualOnly: firewall.manualOnly,
    }));
  }
  const identityScore = number(firewall.identityScore, NaN);
  if (!(identityScore >= 0 && identityScore <= 100)) {
    fail("identityConversionFirewall identityScore must be 0..100.", String(firewall.identityScore));
  }
  const checks = Array.isArray(firewall.checks) ? firewall.checks : [];
  if (checks.length < 5) fail("identityConversionFirewall checks are incomplete.");
  const allowedStatuses = new Set(["ok", "warn", "danger"]);
  for (const check of checks) {
    if (!String(check.id || "").trim() || !String(check.label || "").trim() || !String(check.detail || "").trim()) {
      fail("identityConversionFirewall check is incomplete.", JSON.stringify(check));
    }
    if (!allowedStatuses.has(String(check.status || ""))) {
      fail("identityConversionFirewall check has unknown status.", JSON.stringify(check));
    }
    const score = number(check.score, NaN);
    if (!(score >= 0 && score <= 100)) {
      fail("identityConversionFirewall check score must be 0..100.", JSON.stringify(check));
    }
    if (
      check.zeroExtraXReads !== true ||
      number(check.estimatedXReadOps) !== 0 ||
      number(check.estimatedIncrementalXApiUsd) !== 0
    ) {
      fail("identityConversionFirewall check must be zero-read and zero incremental cost.", JSON.stringify(check));
    }
    if (!String(check.nextAction || "").trim()) {
      fail("identityConversionFirewall check must include an operator action.", JSON.stringify(check));
    }
  }
  const weakestCheckId = String(firewall.weakestCheckId || "");
  if (weakestCheckId && !checks.some((check) => check.id === weakestCheckId)) {
    fail("identityConversionFirewall weakestCheckId must reference a check.", JSON.stringify({
      weakestCheckId: firewall.weakestCheckId,
      checks: checks.map((check) => check.id),
    }));
  }
  const xReadCell = (firewall.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("identityConversionFirewall must expose a zero X read cell.", JSON.stringify(firewall.cells || []));
  }
  const runbook = Array.isArray(firewall.profileRunbook) ? firewall.profileRunbook : [];
  if (runbook.length < 3 || runbook.some((item) => !String(item || "").trim())) {
    fail("identityConversionFirewall must expose a usable profileRunbook.", JSON.stringify(runbook));
  }
  if (!String(firewall.accountPromise || "").trim() || !String(firewall.nextAction || "").trim()) {
    fail("identityConversionFirewall must expose accountPromise and nextAction.", JSON.stringify({
      accountPromise: firewall.accountPromise,
      nextAction: firewall.nextAction,
    }));
  }
  assertDashboardVisibleTextClean("identityConversionFirewall", firewall);
}

function assertGrowthLoopTrace(data) {
  const trace = data.growthLoopTrace;
  if (!trace || typeof trace !== "object") {
    fail("missing growthLoopTrace telemetry.");
  }
  if (
    trace.mode !== "zero_read_growth_loop_trace" &&
    trace.mode !== "derived_zero_read_growth_loop_trace"
  ) {
    fail("growthLoopTrace mode drifted.", trace.mode || "<missing>");
  }
  if (
    trace.zeroExtraXReads !== true ||
    number(trace.estimatedXReadOps) !== 0 ||
    number(trace.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("growthLoopTrace must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: trace.zeroExtraXReads,
      estimatedXReadOps: trace.estimatedXReadOps,
      estimatedIncrementalXApiUsd: trace.estimatedIncrementalXApiUsd,
    }));
  }
  if (trace.readGate !== "cached_only" || trace.operatorMode !== "human_in_loop" || trace.manualOnly !== true) {
    fail("growthLoopTrace must remain cached-only, manual-only, and human-in-loop.", JSON.stringify({
      readGate: trace.readGate,
      operatorMode: trace.operatorMode,
      manualOnly: trace.manualOnly,
    }));
  }
  const traceScore = number(trace.traceScore, NaN);
  if (!(traceScore >= 0 && traceScore <= 100)) {
    fail("growthLoopTrace traceScore must be 0..100.", String(trace.traceScore));
  }
  const stages = Array.isArray(trace.stages) ? trace.stages : [];
  if (stages.length < 5) fail("growthLoopTrace stages are incomplete.");
  const allowedStatuses = new Set(["ok", "warn", "danger"]);
  const stageIds = new Set();
  let previousStart = -1;
  for (const stage of stages) {
    if (!String(stage.id || "").trim() || !String(stage.label || "").trim() || !String(stage.detail || "").trim()) {
      fail("growthLoopTrace stage is incomplete.", JSON.stringify(stage));
    }
    stageIds.add(stage.id);
    if (!allowedStatuses.has(String(stage.status || ""))) {
      fail("growthLoopTrace stage has unknown status.", JSON.stringify(stage));
    }
    const score = number(stage.score, NaN);
    if (!(score >= 0 && score <= 100)) {
      fail("growthLoopTrace stage score must be 0..100.", JSON.stringify(stage));
    }
    if (
      stage.zeroExtraXReads !== true ||
      number(stage.estimatedXReadOps) !== 0 ||
      number(stage.estimatedIncrementalXApiUsd) !== 0
    ) {
      fail("growthLoopTrace stage must be zero-read and zero incremental cost.", JSON.stringify(stage));
    }
    if (!["cached_only", "browser_only"].includes(String(stage.readGate || ""))) {
      fail("growthLoopTrace stage readGate is invalid.", JSON.stringify(stage));
    }
    if (number(stage.durationMs) <= 0 || number(stage.startPct) < previousStart || number(stage.widthPct) <= 0) {
      fail("growthLoopTrace stage timing is invalid.", JSON.stringify(stage));
    }
    previousStart = number(stage.startPct);
  }
  const edges = Array.isArray(trace.edges) ? trace.edges : [];
  if (edges.length < stages.length - 1) fail("growthLoopTrace edges are incomplete.");
  for (const edge of edges) {
    if (!stageIds.has(edge.from) || !stageIds.has(edge.to)) {
      fail("growthLoopTrace edge references unknown stage.", JSON.stringify(edge));
    }
    if (edge.zeroExtraXReads !== true || number(edge.estimatedXReadOps) !== 0 || number(edge.estimatedIncrementalXApiUsd) !== 0) {
      fail("growthLoopTrace edge must be zero-read.", JSON.stringify(edge));
    }
  }
  if (trace.bottleneckStageId && !stageIds.has(trace.bottleneckStageId)) {
    fail("growthLoopTrace bottleneckStageId must reference a stage.", JSON.stringify({
      bottleneckStageId: trace.bottleneckStageId,
      stages: [...stageIds],
    }));
  }
  const xReadCell = (trace.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("growthLoopTrace must expose a zero X read cell.", JSON.stringify(trace.cells || []));
  }
  if (!String(trace.nextAction || "").trim() || !String(trace.copyBlock || "").trim()) {
    fail("growthLoopTrace must expose nextAction and copyBlock.", JSON.stringify({
      nextAction: trace.nextAction,
      copyBlock: trace.copyBlock,
    }));
  }
  assertDashboardVisibleTextClean("growthLoopTrace", trace);
}

function assertRouteFireDrill(data) {
  const drill = data.routeFireDrill;
  if (!drill || typeof drill !== "object") {
    fail("missing routeFireDrill telemetry.");
  }
  if (
    drill.mode !== "zero_read_route_fire_drill" &&
    drill.mode !== "derived_zero_read_route_fire_drill"
  ) {
    fail("routeFireDrill mode drifted.", drill.mode || "<missing>");
  }
  if (
    drill.zeroExtraXReads !== true ||
    number(drill.estimatedXReadOps) !== 0 ||
    number(drill.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("routeFireDrill must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: drill.zeroExtraXReads,
      estimatedXReadOps: drill.estimatedXReadOps,
      estimatedIncrementalXApiUsd: drill.estimatedIncrementalXApiUsd,
    }));
  }
  if (drill.readGate !== "browser_only" || drill.operatorMode !== "human_in_loop" || drill.manualOnly !== true) {
    fail("routeFireDrill must remain browser-only, manual-only, and human-in-loop.", JSON.stringify({
      readGate: drill.readGate,
      operatorMode: drill.operatorMode,
      manualOnly: drill.manualOnly,
    }));
  }
  const drillScore = number(drill.drillScore, NaN);
  if (!(drillScore >= 0 && drillScore <= 100)) {
    fail("routeFireDrill drillScore must be 0..100.", String(drill.drillScore));
  }
  const scenarios = Array.isArray(drill.scenarios) ? drill.scenarios : [];
  if (scenarios.length < 3) fail("routeFireDrill scenarios are incomplete.");
  const scenarioIds = new Set();
  const allowedStatuses = new Set(["ok", "warn", "danger"]);
  for (const scenario of scenarios) {
    scenarioIds.add(scenario.id);
    if (
      !String(scenario.id || "").trim() ||
      !String(scenario.label || "").trim() ||
      !String(scenario.routeLabel || "").trim() ||
      !String(scenario.detail || "").trim() ||
      !String(scenario.editRule || "").trim() ||
      !String(scenario.skipRule || "").trim() ||
      !String(scenario.stopRule || "").trim()
    ) {
      fail("routeFireDrill scenario is incomplete.", JSON.stringify(scenario));
    }
    if (!allowedStatuses.has(String(scenario.status || ""))) {
      fail("routeFireDrill scenario has unknown status.", JSON.stringify(scenario));
    }
    const scenarioScore = number(scenario.drillScore, NaN);
    if (!(scenarioScore >= 0 && scenarioScore <= 100)) {
      fail("routeFireDrill scenario drillScore must be 0..100.", JSON.stringify(scenario));
    }
    if (
      scenario.manualOnly !== true ||
      scenario.zeroExtraXReads !== true ||
      number(scenario.estimatedXReadOps) !== 0 ||
      number(scenario.estimatedIncrementalXApiUsd) !== 0
    ) {
      fail("routeFireDrill scenario must be manual-only and zero-read.", JSON.stringify(scenario));
    }
    if (scenario.operatorMode !== "human_in_loop" || scenario.readGate !== "browser_only") {
      fail("routeFireDrill scenario must remain browser-only and human-in-loop.", JSON.stringify(scenario));
    }
    if (number(scenario.targetOps) < 1 || number(scenario.operatorSlaMinutes) < 5) {
      fail("routeFireDrill scenario route target or SLA is invalid.", JSON.stringify(scenario));
    }
    if (scenario.ready && (!/^https:\/\/x\.com\//i.test(String(scenario.openUrl || "")) || !String(scenario.pastePayload || "").trim())) {
      fail("routeFireDrill ready scenario must include an X web route and paste payload.", JSON.stringify(scenario));
    }
  }
  if (!scenarioIds.has(drill.primaryScenarioId)) {
    fail("routeFireDrill primaryScenarioId must reference a scenario.", JSON.stringify({
      primaryScenarioId: drill.primaryScenarioId,
      scenarios: [...scenarioIds],
    }));
  }
  const xReadCell = (drill.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("routeFireDrill must expose a zero X read cell.", JSON.stringify(drill.cells || []));
  }
  if (!String(drill.nextAction || "").trim() || !String(drill.copyBlock || "").trim()) {
    fail("routeFireDrill must expose nextAction and copyBlock.", JSON.stringify({
      nextAction: drill.nextAction,
      copyBlock: drill.copyBlock,
    }));
  }
  assertDashboardVisibleTextClean("routeFireDrill", drill);
}

function assertRssSourceMesh(data) {
  const mesh = data.rssSourceMesh;
  if (!mesh) return;
  if (mesh.mode !== "zero_read_rss_source_mesh" && mesh.mode !== "derived_zero_read_rss_source_mesh") {
    fail("rssSourceMesh mode drifted.", mesh.mode || "<missing>");
  }
  if (mesh.zeroExtraXReads !== true || number(mesh.estimatedXReadOps) !== 0 || number(mesh.estimatedIncrementalXApiUsd) !== 0) {
    fail("rssSourceMesh must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: mesh.zeroExtraXReads,
      estimatedXReadOps: mesh.estimatedXReadOps,
      estimatedIncrementalXApiUsd: mesh.estimatedIncrementalXApiUsd,
    }));
  }
  if (mesh.readGate !== "cached_only") {
    fail("rssSourceMesh readGate must stay cached_only.", mesh.readGate || "<missing>");
  }
  const lanes = Array.isArray(mesh.lanes) ? mesh.lanes : [];
  const totalSources = number(mesh.summary?.totalSources, lanes.length);
  if (totalSources > 0 && !lanes.length) {
    fail("rssSourceMesh summary declares sources but lanes are empty.", JSON.stringify(mesh.summary || {}));
  }
  const allowedStatuses = new Set(["hot", "ok", "warn", "danger", "idle"]);
  for (const lane of lanes) {
    if (!String(lane.source || lane.host || "").trim()) {
      fail("rssSourceMesh lane is missing source.", JSON.stringify(lane));
    }
    if (!allowedStatuses.has(String(lane.status || ""))) {
      fail("rssSourceMesh lane has unknown status.", JSON.stringify(lane));
    }
    const score = number(lane.priorityScore, NaN);
    if (!(score >= 0 && score <= 100)) {
      fail("rssSourceMesh lane priorityScore must be 0..100.", JSON.stringify(lane));
    }
    if (lane.zeroExtraXReads !== true || number(lane.estimatedXReadOps) !== 0) {
      fail("rssSourceMesh lane must be zero-read.", JSON.stringify(lane));
    }
  }
  if (mesh.activeSource && lanes.length && !lanes.some((lane) => lane.id === mesh.activeSource.id)) {
    fail("rssSourceMesh activeSource must come from lanes.", JSON.stringify({ activeSource: mesh.activeSource, lanes }));
  }
  const xReadCell = (mesh.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("rssSourceMesh must expose a zero X read cell.", JSON.stringify(mesh.cells || []));
  }
  assertDashboardVisibleTextClean("rssSourceMesh", mesh);
}

function assertOperatorPasteQueue(data) {
  const queue = data.operatorPasteQueue;
  if (!queue || typeof queue !== "object") {
    fail("missing operatorPasteQueue telemetry.");
  }
  if (queue.mode !== "manual_paste_queue") {
    fail("operatorPasteQueue mode drifted.", queue.mode || "<missing>");
  }
  if (queue.zeroExtraXReads !== true || number(queue.estimatedXReadOps) !== 0 || number(queue.estimatedIncrementalXApiUsd) !== 0) {
    fail("operatorPasteQueue must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: queue.zeroExtraXReads,
      estimatedXReadOps: queue.estimatedXReadOps,
      estimatedIncrementalXApiUsd: queue.estimatedIncrementalXApiUsd,
    }));
  }
  if (queue.readGate !== "browser_only" || queue.operatorMode !== "human_in_loop") {
    fail("operatorPasteQueue must remain browser-only and human-in-loop.", JSON.stringify({
      readGate: queue.readGate,
      operatorMode: queue.operatorMode,
    }));
  }
  const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  if (!tasks.length) fail("operatorPasteQueue tasks are empty.");
  const readyTasks = tasks.filter((task) => task.ready);
  if (number(queue.readyTasks) !== readyTasks.length) {
    fail("operatorPasteQueue readyTasks count drifted.", JSON.stringify({ declared: queue.readyTasks, actual: readyTasks.length }));
  }
  if (number(queue.totalTasks) !== tasks.length) {
    fail("operatorPasteQueue totalTasks count drifted.", JSON.stringify({ declared: queue.totalTasks, actual: tasks.length }));
  }
  if (readyTasks.length && (!queue.primaryOpenUrl || !queue.primaryPastePayload)) {
    fail("operatorPasteQueue primary ready task is incomplete.", JSON.stringify({
      primaryOpenUrl: queue.primaryOpenUrl,
      primaryPastePayload: queue.primaryPastePayload,
    }));
  }
  for (const task of tasks) {
    if (task.zeroExtraXReads !== true || number(task.estimatedXReadOps) !== 0 || number(task.estimatedIncrementalXApiUsd) !== 0) {
      fail("operatorPasteQueue task must be zero-read and zero incremental X API cost.", JSON.stringify(task));
    }
    if (task.ready && (!/^https:\/\/x\.com\//i.test(String(task.openUrl || "")) || !String(task.pastePayload || "").trim())) {
      fail("operatorPasteQueue ready task must include an X web route and paste payload.", JSON.stringify(task));
    }
    if (!String(task.skipRule || "").trim() || !String(task.doneSignal || "").trim() || !String(task.editRule || "").trim()) {
      fail("operatorPasteQueue task must include edit/skip/done operator rules.", JSON.stringify(task));
    }
  }
  assertDashboardVisibleTextClean("operatorPasteQueue", queue);
}

function assertRouteOpportunityMatrix(data) {
  const matrix = data.routeOpportunityMatrix;
  if (!matrix || typeof matrix !== "object") {
    fail("missing routeOpportunityMatrix telemetry.");
  }
  if (matrix.mode !== "zero_read_route_opportunity_matrix") {
    fail("routeOpportunityMatrix mode drifted.", matrix.mode || "<missing>");
  }
  if (
    matrix.zeroExtraXReads !== true ||
    number(matrix.estimatedXReadOps) !== 0 ||
    number(matrix.estimatedIncrementalXApiUsd) !== 0
  ) {
    fail("routeOpportunityMatrix must be zero-read and zero incremental X API cost.", JSON.stringify({
      zeroExtraXReads: matrix.zeroExtraXReads,
      estimatedXReadOps: matrix.estimatedXReadOps,
      estimatedIncrementalXApiUsd: matrix.estimatedIncrementalXApiUsd,
    }));
  }
  if (matrix.readGate !== "browser_only" || matrix.operatorMode !== "human_in_loop" || matrix.manualOnly !== true) {
    fail("routeOpportunityMatrix must remain browser-only, manual-only, and human-in-loop.", JSON.stringify({
      readGate: matrix.readGate,
      operatorMode: matrix.operatorMode,
      manualOnly: matrix.manualOnly,
    }));
  }
  const lanes = Array.isArray(matrix.lanes) ? matrix.lanes : [];
  if (!lanes.length) fail("routeOpportunityMatrix lanes are empty.");
  const readyLanes = lanes.filter((lane) => lane.ready);
  if (number(matrix.readyLanes) !== readyLanes.length) {
    fail("routeOpportunityMatrix readyLanes count drifted.", JSON.stringify({ declared: matrix.readyLanes, actual: readyLanes.length }));
  }
  if (number(matrix.totalLanes) !== lanes.length) {
    fail("routeOpportunityMatrix totalLanes count drifted.", JSON.stringify({ declared: matrix.totalLanes, actual: lanes.length }));
  }
  const allowedStatuses = new Set(["hot", "ok", "watch", "hold", "warn", "danger"]);
  for (const lane of lanes) {
    if (!allowedStatuses.has(String(lane.status || ""))) {
      fail("routeOpportunityMatrix lane has unknown status.", JSON.stringify(lane));
    }
    const score = number(lane.score, NaN);
    if (!(score >= 0 && score <= 100)) {
      fail("routeOpportunityMatrix lane score must be 0..100.", JSON.stringify(lane));
    }
    if (lane.manualOnly !== true || lane.zeroExtraXReads !== true || number(lane.estimatedXReadOps) !== 0 || number(lane.estimatedIncrementalXApiUsd) !== 0) {
      fail("routeOpportunityMatrix lane must be manual-only and zero-read.", JSON.stringify(lane));
    }
    if (lane.ready && (!/^https:\/\/x\.com\//i.test(String(lane.openUrl || "")) || !String(lane.pastePayload || "").trim())) {
      fail("routeOpportunityMatrix ready lane must include an X web route and paste payload.", JSON.stringify(lane));
    }
    if (!String(lane.skipRule || "").trim() || !String(lane.doneSignal || "").trim() || !String(lane.editRule || "").trim()) {
      fail("routeOpportunityMatrix lane must include edit/skip/done operator rules.", JSON.stringify(lane));
    }
  }
  const xReadCell = (matrix.cells || []).find((cell) => cell.id === "x_reads");
  if (!xReadCell || !/0/.test(String(xReadCell.value || ""))) {
    fail("routeOpportunityMatrix must expose a zero X read cell.", JSON.stringify(matrix.cells || []));
  }
  if (readyLanes.length && (!matrix.primaryOpenUrl || !matrix.primaryPastePayload)) {
    fail("routeOpportunityMatrix primary ready lane is incomplete.", JSON.stringify({
      primaryOpenUrl: matrix.primaryOpenUrl,
      primaryPastePayload: matrix.primaryPastePayload,
    }));
  }
  assertDashboardVisibleTextClean("routeOpportunityMatrix", matrix);
}

function assertCostTelemetry(data) {
  const governor = data.rateLimitGovernor;
  if (!governor || typeof governor !== "object") {
    fail("missing rateLimitGovernor telemetry.");
  }
  if (governor.zeroExtraXReads !== true || governor.circuit?.zeroExtraXReads !== true) {
    fail("rateLimitGovernor must be zero-read.", JSON.stringify({
      zeroExtraXReads: governor.zeroExtraXReads,
      circuitZeroExtraXReads: governor.circuit?.zeroExtraXReads,
    }));
  }
  if (!["cached_only", "closed"].includes(governor.gates?.read)) {
    fail("rateLimitGovernor read gate must stay cached_only or closed.", governor.gates?.read || "<missing>");
  }
  if (!["open", "review", "closed", "guarded"].includes(governor.gates?.publish)) {
    fail("rateLimitGovernor publish gate has unknown state.", governor.gates?.publish || "<missing>");
  }
  if (!Array.isArray(governor.partitionMatrix) || !governor.partitionMatrix.length) {
    fail("rateLimitGovernor is missing partitionMatrix telemetry.");
  }
  if (!governor.partitionMatrix.some((partition) => partition.id === "read_search")) {
    fail("rateLimitGovernor partitionMatrix must include read_search.");
  }
  if (!Number.isFinite(number(governor.budget?.safeCapUsd, NaN))) {
    fail("rateLimitGovernor budget.safeCapUsd must be numeric.", JSON.stringify(governor.budget || {}));
  }

  const runway = data.xApiRunwayGuard;
  if (!runway || typeof runway !== "object") {
    fail("missing xApiRunwayGuard telemetry.");
  }
  if (typeof runway.active !== "boolean" || typeof runway.monthEndSafe !== "boolean") {
    fail("xApiRunwayGuard must expose active/monthEndSafe booleans.", JSON.stringify(runway));
  }
  if (!Number.isFinite(number(runway.projectedCostUsd, NaN)) || !Number.isFinite(number(runway.monthEndProjectedSpendUsd, NaN))) {
    fail("xApiRunwayGuard must expose numeric projected cost telemetry.", JSON.stringify(runway));
  }

  const burn = data.budgetBurnReactor;
  if (!burn || typeof burn !== "object") {
    fail("missing budgetBurnReactor telemetry.");
  }
  if (burn.zeroExtraXReads !== true) {
    fail("budgetBurnReactor must be zero-read.", JSON.stringify({ zeroExtraXReads: burn.zeroExtraXReads }));
  }
  if (!["cached_only", "sealed"].includes(burn.readGate)) {
    fail("budgetBurnReactor read gate must be cached_only or sealed.", burn.readGate || "<missing>");
  }
  if (!Number.isFinite(number(burn.safeCapUsd, NaN)) || !Number.isFinite(number(burn.projectedDailyBurnUsd, NaN))) {
    fail("budgetBurnReactor must expose numeric safeCap/projectedDailyBurn telemetry.", JSON.stringify(burn));
  }
  if (!Array.isArray(burn.series) || !burn.series.length) {
    fail("budgetBurnReactor must expose a burn series.");
  }
  const liveReads = (burn.partitions || []).find((partition) => partition.id === "live_reads");
  if (!liveReads || !/0/.test(String(liveReads.value || ""))) {
    fail("budgetBurnReactor must show the live X read partition at 0 ops.", JSON.stringify(liveReads || {}));
  }

  const optimizer = data.budgetAllocationOptimizer;
  if (!optimizer || typeof optimizer !== "object") {
    fail("missing budgetAllocationOptimizer telemetry.");
  }
  if (optimizer.mode !== "zero_read_budget_allocator" || optimizer.zeroExtraXReads !== true) {
    fail("budgetAllocationOptimizer mode drifted.", JSON.stringify({
      mode: optimizer.mode,
      zeroExtraXReads: optimizer.zeroExtraXReads,
    }));
  }
  const lanes = Array.isArray(optimizer.lanes) ? optimizer.lanes : [];
  if (!lanes.length) fail("budgetAllocationOptimizer lanes are empty.");
  const recommended = lanes.find((lane) => lane.id === optimizer.recommendedLaneId);
  if (!recommended) fail("budgetAllocationOptimizer recommended lane is missing.", optimizer.recommendedLaneId || "<missing>");
  if (number(recommended.xReadOps) !== 0 || recommended.id === "live_x_search") {
    fail("budgetAllocationOptimizer recommended lane must not require X reads.", JSON.stringify(recommended));
  }
  const manualLane = lanes.find((lane) => lane.id === "manual_route_burst");
  if (!manualLane || number(manualLane.costUsd) !== 0 || number(manualLane.xReadOps) !== 0) {
    fail("budgetAllocationOptimizer must preserve a zero-cost manual route lane.", JSON.stringify(manualLane || {}));
  }
  const liveLane = lanes.find((lane) => lane.id === "live_x_search");
  if (!liveLane || number(liveLane.xReadOps) <= 0 || !["closed", "sealed"].includes(liveLane.gate) || liveLane.status !== "danger") {
    fail("budgetAllocationOptimizer must keep live_x_search sealed as a danger lane.", JSON.stringify(liveLane || {}));
  }

  const media = data.mediaRoiGate || data.automation?.mediaRoiGate;
  if (!media || typeof media !== "object") {
    fail("missing mediaRoiGate telemetry.");
  }
  if (media.zeroExtraXReads !== true || typeof media.attachImageAllowed !== "boolean" || !String(media.decision || "").trim()) {
    fail("mediaRoiGate must expose zero-read boolean image gating.", JSON.stringify(media));
  }
  if (media.attachImageAllowed && media.decision !== "allow") {
    fail("mediaRoiGate cannot attach images unless decision is allow.", JSON.stringify(media));
  }
  const xReadCheck = (media.checks || []).find((check) => check.id === "x_reads");
  if (!xReadCheck || String(xReadCheck.value || "") !== "0") {
    fail("mediaRoiGate must expose a zero extra X reads check.", JSON.stringify(xReadCheck || {}));
  }

  assertDashboardVisibleTextClean("rateLimitGovernor", governor);
  assertDashboardVisibleTextClean("xApiRunwayGuard", runway);
  assertDashboardVisibleTextClean("budgetBurnReactor", burn);
  assertDashboardVisibleTextClean("budgetAllocationOptimizer", optimizer);
  assertDashboardVisibleTextClean("mediaRoiGate", media);
}

function assertLanguageTracks(data) {
  const languageTracks = data.languageTracks;
  if (!languageTracks || typeof languageTracks !== "object") {
    fail("missing languageTracks telemetry.");
  }
  if (languageTracks.zeroExtraXReads !== true || number(languageTracks.estimatedXReadOps) !== 0) {
    fail("languageTracks must be zero-read.", JSON.stringify(languageTracks));
  }
  const tracks = Array.isArray(languageTracks.tracks) ? languageTracks.tracks : [];
  const byId = new Map(tracks.map((track) => [track.id, track]));
  for (const id of ["zh", "en"]) {
    const track = byId.get(id);
    if (!track) fail(`languageTracks missing ${id} track.`, JSON.stringify(tracks.map((item) => item.id)));
    if (!Array.isArray(track.utcHours) || !track.utcHours.length) {
      fail(`languageTracks ${id} track must expose UTC windows.`, JSON.stringify(track));
    }
    for (const hour of track.utcHours) {
      if (!(number(hour, NaN) >= 0 && number(hour, NaN) <= 23)) {
        fail(`languageTracks ${id} UTC hour is invalid.`, JSON.stringify(track.utcHours));
      }
    }
    if (!(number(track.dailyTarget, NaN) >= 1)) {
      fail(`languageTracks ${id} dailyTarget must be positive.`, JSON.stringify(track));
    }
    for (const key of ["packetsLast24h", "packetsLast7d", "measuredPackets", "traffic7d", "ack7d"]) {
      if (!(number(track[key], NaN) >= 0)) {
        fail(`languageTracks ${id}.${key} must be a non-negative number.`, JSON.stringify(track));
      }
    }
    if (track.nextWindow) {
      if (!(number(track.nextWindow.hour, NaN) >= 0 && number(track.nextWindow.hour, NaN) <= 23)) {
        fail(`languageTracks ${id} nextWindow hour is invalid.`, JSON.stringify(track.nextWindow));
      }
      if (!(number(track.nextWindow.hoursFromNow, NaN) >= 0)) {
        fail(`languageTracks ${id} nextWindow hoursFromNow must be non-negative.`, JSON.stringify(track.nextWindow));
      }
    }
  }
  assertDashboardVisibleTextClean("languageTracks", languageTracks);
}

function periodMetricSum(posts, key) {
  return (Array.isArray(posts) ? posts : []).reduce((sum, post) => sum + number(post?.[key]), 0);
}

function assertAlignedWindows(data) {
  for (const key of ["last24h", "last7d"]) {
    const period = data[key];
    if (!period || typeof period !== "object") continue;
    if (!Number.isFinite(number(period.posts, NaN))) continue;
    const posts = Array.isArray(period.topPosts) ? period.topPosts : [];
    assertNear(`${key} topPosts count`, posts.length, period.posts);
    assertNear(`${key} topPosts impressions`, periodMetricSum(posts, "impressions"), period.impressions);
    assertNear(`${key} topPosts likes`, periodMetricSum(posts, "likes"), period.likes);
    assertNear(`${key} topPosts reposts`, periodMetricSum(posts, "reposts"), period.reposts);
    assertNear(`${key} topPosts replies`, periodMetricSum(posts, "replies"), period.replies);
  }

  const last7d = data.last7d || {};
  if (Number.isFinite(number(last7d.posts, NaN))) {
    const tracks = Array.isArray(data.languageTracks?.tracks) ? data.languageTracks.tracks : [];
    const packetSum = tracks.reduce((sum, track) => sum + number(track.packetsLast7d), 0);
    const trafficSum = tracks.reduce((sum, track) => sum + number(track.traffic7d), 0);
    const ackSum = tracks.reduce((sum, track) => sum + number(track.ack7d), 0);
    const engagement = number(last7d.likes) + number(last7d.reposts) + number(last7d.replies);
    assertNear("languageTracks 7d packets", packetSum, last7d.posts);
    assertNear("languageTracks 7d traffic", trafficSum, last7d.impressions);
    assertNear("languageTracks 7d ACKs", ackSum, engagement);
    const mix = data.growthDecision?.languageMix?.scores || {};
    for (const id of ["en", "zh"]) {
      const track = tracks.find((item) => item.id === id);
      if (!track) continue;
      if (Number.isFinite(number(mix[id], NaN))) {
        assertNear(`languageMix ${id} score`, mix[id], track.avgScore);
      }
      const sampleKey = `${id}Samples`;
      if (Number.isFinite(number(mix[sampleKey], NaN))) {
        assertNear(`languageMix ${id} samples`, mix[sampleKey], track.measuredPackets);
      }
    }
  }

  const chart7d = data.charts?.impressions7d;
  if (chart7d && Array.isArray(chart7d.points) && Number.isFinite(number(last7d.impressions, NaN))) {
    const pointTotal = chart7d.points.reduce((sum, point) => sum + number(point.value), 0);
    assertNear("charts.impressions7d point sum", pointTotal, last7d.impressions);
    assertNear("charts.impressions7d total", chart7d.total, last7d.impressions);
  }

  const chart24h = data.charts?.impressions24h;
  const last24h = data.last24h || {};
  if (chart24h && Array.isArray(chart24h.points) && Number.isFinite(number(last24h.impressions, NaN))) {
    const pointTotal = chart24h.points.reduce((sum, point) => sum + number(point.value), 0);
    assertNear("charts.impressions24h point sum", pointTotal, last24h.impressions);
    assertNear("charts.impressions24h total", chart24h.total, last24h.impressions);
  }
}

function assertGrowthDecision(data) {
  const decision = data.growthDecision;
  if (!decision || typeof decision !== "object") {
    fail("missing growthDecision telemetry.");
  }
  if (decision.mode !== "zero_read_growth_decision_layer") {
    fail("growthDecision mode must be zero_read_growth_decision_layer.", JSON.stringify(decision));
  }
  if (decision.zeroExtraXReads !== true || number(decision.estimatedXReadOps) !== 0) {
    fail("growthDecision must be zero-read.", JSON.stringify(decision));
  }
  if (number(decision.estimatedIncrementalXApiUsd, NaN) !== 0) {
    fail("growthDecision must not add X API spend.", JSON.stringify(decision));
  }
  const today = decision.today || {};
  if (!today.summary || typeof today.summary !== "string") {
    fail("growthDecision.today.summary is required.", JSON.stringify(today));
  }
  if (!["en", "zh"].includes(today.primaryLanguage || decision.languageMix?.primary)) {
    fail("growthDecision primary language must be en or zh.", JSON.stringify(today));
  }
  for (const [key, hours] of [["review24h", 24], ["review72h", 72]]) {
    const review = decision[key];
    if (!review || typeof review !== "object") fail(`growthDecision missing ${key}.`);
    if (number(review.hours, NaN) !== hours) fail(`growthDecision.${key}.hours must be ${hours}.`, JSON.stringify(review));
    if (review.zeroExtraXReads !== true || number(review.estimatedXReadOps) !== 0) {
      fail(`growthDecision.${key} must be zero-read.`, JSON.stringify(review));
    }
    if (!Array.isArray(review.items)) fail(`growthDecision.${key}.items must be an array.`);
  }
  if (!decision.languageMix || !["en", "zh"].includes(decision.languageMix.primary)) {
    fail("growthDecision.languageMix.primary must be en or zh.", JSON.stringify(decision.languageMix));
  }
  if (decision.languageMix.zeroExtraXReads !== true || number(decision.languageMix.estimatedXReadOps) !== 0) {
    fail("growthDecision.languageMix must be zero-read.", JSON.stringify(decision.languageMix));
  }
  if (!decision.failureStats || !Array.isArray(decision.failureStats.topReasons)) {
    fail("growthDecision.failureStats.topReasons must be an array.", JSON.stringify(decision.failureStats));
  }
  if (decision.failureStats.zeroExtraXReads !== true || number(decision.failureStats.estimatedXReadOps) !== 0) {
    fail("growthDecision.failureStats must be zero-read.", JSON.stringify(decision.failureStats));
  }
  if (!decision.abPlan || decision.abPlan.mode !== "zero_read_low_cost_ab") {
    fail("growthDecision.abPlan mode must be zero_read_low_cost_ab.", JSON.stringify(decision.abPlan));
  }
  if (decision.abPlan.zeroExtraXReads !== true || number(decision.abPlan.estimatedXReadOps) !== 0) {
    fail("growthDecision.abPlan must be zero-read.", JSON.stringify(decision.abPlan));
  }
  if (!Array.isArray(decision.abPlan.arms) || decision.abPlan.arms.length < 3) {
    fail("growthDecision.abPlan must expose at least three experiment arms.", JSON.stringify(decision.abPlan));
  }
  assertDashboardVisibleTextClean("growthDecision", decision);
}

function assertDashboardData(data) {
  if (!data || typeof data !== "object") fail("dashboard data root must be an object.");
  if (data.version == null) fail("missing version.");
  if (!Number.isFinite(Date.parse(data.updatedAt || ""))) fail("updatedAt is missing or invalid.", data.updatedAt || "<missing>");
  if (!data.profile || typeof data.profile !== "object") fail("missing profile block.");
  if (!data.api || typeof data.api !== "object") fail("missing api block.");
  assertLanguageTracks(data);
  assertGrowthDecision(data);
  assertAlignedWindows(data);
  assertApiStatusTriage(data);
  assertSignalMap(data);
  assertNextWindowCommander(data);
  assertL7FireWindowRouter(data);
  assertL7SurgeSentinel(data);
  assertGrowthLeakProfiler(data);
  assertCommandPacketDock(data);
  assertIdentityConversionFirewall(data);
  assertGrowthLoopTrace(data);
  assertRouteFireDrill(data);
  assertRssSourceMesh(data);
  assertOperatorPasteQueue(data);
  assertRouteOpportunityMatrix(data);
  assertCostTelemetry(data);
  assertNoMarketingVocabulary(data.signalMap);
  assertNoMarketingVocabulary(data.nextWindowAngleCommander);
  assertNoMarketingVocabulary(data.operatorPasteQueue);
  assertNoMarketingVocabulary(data.routeOpportunityMatrix);
  assertNoMarketingVocabulary(data.rssSourceMesh);
  assertNoMarketingVocabulary(data.l7SurgeSentinel);
  assertNoMarketingVocabulary(data.growthLeakProfiler);
  assertNoMarketingVocabulary(data.commandPacketDock);
  assertNoMarketingVocabulary(data.identityConversionFirewall);
  assertNoMarketingVocabulary(data.growthLoopTrace);
  assertNoMarketingVocabulary(data.routeFireDrill);
}

function validFixture() {
  return {
    version: 1,
    updatedAt: "2026-07-09T00:00:00.000Z",
    languageTracks: {
      mode: "timezone",
      generatedAt: "2026-07-09T00:00:00.000Z",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      tracks: [
        {
          id: "zh",
          label: "ZH",
          locale: "zh-CN",
          windowLabel: "China evening prime",
          utcHours: [12, 13],
          nextWindow: { hour: 12, label: "12:00 UTC", hoursFromNow: 12 },
          dailyTarget: 1,
          packetsLast24h: 0,
          packetsLast7d: 1,
          measuredPackets: 1,
          traffic7d: 12,
          ack7d: 1,
          avgScore: 2.4,
          topPackets: [],
          latestPacketAt: null,
          status: "scheduled",
          nextAction: "Next ZH slot is 12:00 UTC; cadence is scoped to this language track.",
        },
        {
          id: "en",
          label: "EN",
          locale: "en",
          windowLabel: "EU afternoon + US lunch/evening",
          utcHours: [14, 17, 22],
          nextWindow: { hour: 14, label: "14:00 UTC", hoursFromNow: 14 },
          dailyTarget: 1,
          packetsLast24h: 0,
          packetsLast7d: 2,
          measuredPackets: 2,
          traffic7d: 24,
          ack7d: 3,
          avgScore: 3.8,
          topPackets: [],
          latestPacketAt: null,
          status: "scheduled",
          nextAction: "Next EN slot is 14:00 UTC; cadence is scoped to this language track.",
        },
      ],
    },
    growthDecision: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_growth_decision_layer",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      today: {
        generatedAt: "2026-07-09T00:00:00.000Z",
        zeroExtraXReads: true,
        estimatedXReadOps: 0,
        mode: "publish_or_route",
        summary: "Today: prioritize EN at 14:00 UTC; use #AI #DevTools when story-fit allows.",
        primaryLanguage: "en",
        nextSlot: { hour: 14, label: "14:00 UTC", hoursFromNow: 14 },
        selectedTags: ["#AI", "#DevTools"],
        canPost: true,
        budgetSafeRemainingUsd: 3.2,
        cadenceReason: "cached cadence is inside guardrail",
        nextRoute: null,
        experiment: { primaryFormat: "operator_pain", secondaryFormat: "decision_rule" },
      },
      review24h: {
        generatedAt: "2026-07-09T00:00:00.000Z",
        hours: 24,
        zeroExtraXReads: true,
        estimatedXReadOps: 0,
        total: 0,
        counts: {},
        items: [],
      },
      review72h: {
        generatedAt: "2026-07-09T00:00:00.000Z",
        hours: 72,
        zeroExtraXReads: true,
        estimatedXReadOps: 0,
        total: 0,
        counts: {},
        items: [],
      },
      languageMix: {
        generatedAt: "2026-07-09T00:00:00.000Z",
        zeroExtraXReads: true,
        estimatedXReadOps: 0,
        primary: "en",
        confidence: "early",
        recommendation: "Keep English as the main growth rail; use Chinese as a focused support rail unless ZH starts outperforming.",
        targets: { en: 1, zh: 1 },
        scores: { en: 3.8, zh: 2.4, enSamples: 2, zhSamples: 1 },
      },
      failureStats: {
        generatedAt: "2026-07-09T00:00:00.000Z",
        lookbackDays: 7,
        zeroExtraXReads: true,
        estimatedXReadOps: 0,
        totalEvents: 0,
        topReasons: [],
        primaryReason: null,
      },
      abPlan: {
        generatedAt: "2026-07-09T00:00:00.000Z",
        mode: "zero_read_low_cost_ab",
        zeroExtraXReads: true,
        estimatedXReadOps: 0,
        estimatedIncrementalXApiUsd: 0,
        cadence: "use existing scheduled slots only",
        arms: [
          {
            id: "hook_format",
            label: "Hook format A/B",
            armA: "operator_pain",
            armB: "decision_rule",
            metric: "24h score + replies",
            nextAction: "Alternate hook patterns inside existing rails.",
          },
          {
            id: "hashtag_pair",
            label: "Hashtag pair A/B",
            armA: "#AI #DevTools",
            armB: "#BigTech #Cloud",
            metric: "24h traffic and ACK rate",
            nextAction: "Keep exactly two tags.",
          },
          {
            id: "language_mix",
            label: "Language mix guard",
            armA: "EN primary",
            armB: "1 EN + 1 ZH control",
            metric: "72h active-conversion proxy",
            nextAction: "Compare rails with the same daily cap.",
          },
        ],
      },
    },
    profile: {
      measuredPosts: 3,
      baselineScore: 4.1,
    },
    last7d: {
      posts: 3,
      impressions: 36,
      likes: 3,
      reposts: 0,
      replies: 1,
      topPosts: [
        { score: 6.4, impressions: 24, likes: 2, reposts: 0, replies: 1 },
        { score: 5.1, impressions: 12, likes: 1, reposts: 0, replies: 0 },
        { score: 2.4, impressions: 0, likes: 0, reposts: 0, replies: 0 },
      ],
    },
    actions: [
      { label: "Target Accounts", url: "https://x.com/search?q=ai&src=typed_query&f=live" },
      { label: "AI / DevTools", url: "https://x.com/search?q=devtools&src=typed_query&f=live" },
    ],
    drafts: [
      { text: "Packet route output one." },
      { text: "Packet route output two." },
    ],
    api: {
      cap: 5,
      spend: 1.25,
      endpoints: [
        { name: "CREATE_TWEET", calls: 2, failures: 0, lastStatus: 201, statuses: { 201: 2 } },
        { name: "TWEET_METRICS_LOOKUP", calls: 3, failures: 1, lastStatus: 200, statuses: { 200: 2, 503: 1 } },
      ],
      statusTriage: {
        totalCalls: 5,
        totalFailures: 1,
        success2xx: 4,
        rateLimit429: 0,
        backendFault5xx: 1,
        authFault4xx: 0,
        clientFault4xx: 0,
        activeRateLimit429: 0,
        activeBackendFault5xx: 0,
        activeAuthFault4xx: 0,
        activeClientFault4xx: 0,
        severity: "cached",
        failureRate: 20,
        statusMatrix: [
          {
            id: "success2xx",
            label: "2xx success",
            count: 4,
            sharePct: 80,
            endpoints: [
              { endpoint: "CREATE_TWEET", count: 2 },
              { endpoint: "TWEET_METRICS_LOOKUP", count: 2 },
            ],
          },
          { id: "client4xx", label: "4xx client", count: 0, sharePct: 0, endpoints: [] },
          { id: "auth4xx", label: "401/403 auth", count: 0, sharePct: 0, endpoints: [] },
          { id: "rateLimit429", label: "429 rate-limit", count: 0, sharePct: 0, endpoints: [] },
          {
            id: "backend5xx",
            label: "5xx backend",
            count: 1,
            sharePct: 20,
            endpoints: [{ endpoint: "TWEET_METRICS_LOOKUP", count: 1 }],
          },
        ],
        topFaultEndpoints: [
          {
            endpoint: "TWEET_METRICS_LOOKUP",
            severity: "cached",
            active: false,
            failures: 1,
            lastStatus: 200,
            totalFaults: 1,
          },
        ],
        incidents: [
          {
            endpoint: "TWEET_METRICS_LOOKUP",
            severity: "cached",
            active: false,
            calls: 3,
            failures: 1,
            lastStatus: 200,
            statuses: { 200: 2, 503: 1 },
            rateLimit429: 0,
            backendFault5xx: 1,
            authFault4xx: 0,
            clientFault4xx: 0,
            activeRateLimit429: 0,
            activeBackendFault5xx: 0,
            activeAuthFault4xx: 0,
            activeClientFault4xx: 0,
          },
        ],
      },
    },
    signalMap: {
      version: 1,
      generatedAt: "2026-07-09T00:00:00.000Z",
      coordinateSystem: "percent",
      source: "packet_analytics + rss_health + x_api_usage",
      core: {
        label: "CORE",
        value: 4.1,
        unit: "baseline",
        detail: "5 X API calls, 1 failures tracked this month",
        x: 0.46,
        y: 0.54,
      },
      nodes: [
        { id: "rss", label: "RSS", value: 8, unit: "sources", detail: "8 learned sources", health: "ok", x: 0.2, y: 0.34 },
        { id: "score", label: "Ranker", value: 6.4, unit: "best", detail: "best packet score", health: "ok", x: 0.48, y: 0.22 },
        { id: "draft", label: "Swarm Output", value: 2, unit: "ready", detail: "2 outputs queued", health: "ok", x: 0.22, y: 0.7 },
        { id: "x", label: "X_ROUTE", value: 2, unit: "web routes", detail: "2 manual web routes; 0 extra X read ops", health: "ok", x: 0.72, y: 0.42 },
        { id: "learn", label: "Learn", value: 3, unit: "packets", detail: "3 measured outcomes", health: "ok", x: 0.76, y: 0.69 },
      ],
      routes: [
        { from: "rss", to: "score", value: 8, unit: "signals", label: "sources ranked into topics" },
        { from: "score", to: "draft", value: 2, unit: "outputs", label: "winning hooks become outputs" },
        { from: "score", to: "x", value: 2, unit: "web routes", label: "ranked ideas route to X web actions" },
        { from: "draft", to: "x", value: 2, unit: "outputs", label: "manual paste queue" },
        { from: "x", to: "learn", value: 3, unit: "measured packets", label: "outcomes feed learning" },
      ],
      totals: {
        xApiCalls: 5,
        xApiFailures: 1,
        apiRemainingUsd: 3.75,
      },
    },
    rssSourceMesh: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_rss_source_mesh",
      source: "rss_health_cache + trend_velocity_cache",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      readGate: "cached_only",
      activeSource: { id: "rss:github.blog", source: "github.blog", status: "hot", priorityScore: 86.4 },
      summary: {
        totalSources: 2,
        healthySources: 1,
        watchSources: 1,
        failingSources: 0,
        cachedTrendItems: 2,
        breakoutCount: 1,
        avgVelocity: 78.2,
        primarySource: "github.blog",
        nextAction: "Route the hottest cached RSS source through manual X web lanes.",
      },
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "sources", label: "RSS_SOURCES", value: "2", status: "ok" },
      ],
      lanes: [
        {
          id: "rss:github.blog",
          source: "github.blog",
          host: "github.blog",
          url: "https://github.blog/feed/",
          sourceTier: "official",
          status: "hot",
          healthLabel: "velocity hot",
          priorityScore: 86.4,
          totalSuccesses: 6,
          totalFailures: 0,
          consecutiveFailures: 0,
          lastItemCount: 8,
          lastStatus: "ok",
          trendItems: 1,
          breakoutCount: 1,
          avgVelocity: 86.4,
          topTitle: "AI coding agents move from demo to workflow control",
          topLink: "https://github.blog/",
          routeUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
          routeReason: "Use cached RSS signal as the angle anchor; execute routes manually in X web.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        },
      ],
      guardrails: [
        "Cached RSS telemetry only.",
        "No live X search/read API calls.",
        "Normal RSS refresh cadence only; no retry storms.",
      ],
    },
    nextWindowAngleCommander: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_next_window_commander",
      severity: "ok",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      source: "cached cadence + topic timing + opportunity scorer + angle load",
      commanderScore: 84.2,
      publishGate: "manual_route_only",
      readGate: "cached_only",
      activeWindow: { hour: 13, windowLabel: "13:00", hoursFromNow: 4, loadScore: 88.4 },
      window: { hour: 13, label: "13:00", windowLabel: "13:00", hoursFromNow: 4, loadScore: 88.4 },
      activeAngle: {
        formatId: "decision_rule",
        formatLabel: "Decision Rule",
        pillarId: "ai_platform",
        pillarLabel: "AI / Agent Stack",
        opportunityScore: 91.2,
        timingScore: 81.6,
      },
      command: "Hold the standalone packet; run one manual route op and keep the Decision Rule angle warm for 13:00 UTC.",
      promptBias: ["Format=decision_rule", "Pillar=AI / Agent Stack", "Window=13:00 UTC"],
      routeUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
      gates: [
        { id: "x_read_partition", label: "X read partition", status: "ok", value: "0 ops", detail: "Cached telemetry and manual web route links only." },
        { id: "cadence", label: "Cadence", status: "warn", value: "manual_route_only", detail: "Manual route is preferred until the next learned window." },
      ],
      lanes: [
        { id: "timing", label: "13:00 UTC / AI / Agent Stack / Decision Rule", score: 81.6, status: "watch", source: "topic_timing", detail: "Learned high-load window." },
      ],
      checklist: [
        "Do not force a standalone packet while cadence gates are in review.",
        "Open one prepared X web route and paste one useful reply.",
      ],
    },
    operatorPasteQueue: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "manual_paste_queue",
      severity: "ok",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      targetReplies: 2,
      readyTasks: 2,
      totalTasks: 2,
      primaryRouteLabel: "Target Accounts",
      primaryOpenUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
      primaryPastePayload: "Packet route output one.",
      nextAction: "Open Target Accounts, paste one useful payload, then continue down the queue.",
      operatorMode: "human_in_loop",
      readGate: "browser_only",
      guardrails: [
        "Manual browser execution only; no automated outbound actions.",
        "Use route links; X search/read API stays at 0.",
        "Stop at target count and let maintenance write learning back.",
      ],
      tasks: [
        {
          id: "paste:1",
          priority: 1,
          routeLabel: "Target Accounts",
          openUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
          pastePayload: "Packet route output one.",
          status: "ok",
          ready: true,
          targetReplies: 1,
          operatorSlaMinutes: 10,
          expectedLiftPct: 12.5,
          reason: "Use the highest-signal fresh technical exchange in this route.",
          editRule: "Only edit nouns, timing, and one concrete reference needed by the target exchange.",
          skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
          doneSignal: "One useful manual response pasted, or this route skipped for quality.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "paste:2",
          priority: 2,
          routeLabel: "AI / DevTools",
          openUrl: "https://x.com/search?q=devtools&src=typed_query&f=live",
          pastePayload: "Packet route output two.",
          status: "ok",
          ready: true,
          targetReplies: 1,
          operatorSlaMinutes: 20,
          expectedLiftPct: 8.1,
          reason: "Use the highest-signal fresh technical exchange in this route.",
          editRule: "Only edit nouns, timing, and one concrete reference needed by the target exchange.",
          skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
          doneSignal: "One useful manual response pasted, or this route skipped for quality.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
      ],
      steps: [
        { id: "open_route", label: "open.route", detail: "Open the queued route link in X web." },
        { id: "paste_payload", label: "paste.payload", detail: "Paste once, edit only context, then move to the next route." },
      ],
      copyBlock: "CODEX OPERATOR PASTE QUEUE\nCost guard: 0 live X search/read ops",
    },
    routeOpportunityMatrix: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_route_opportunity_matrix",
      severity: "ok",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "browser_only",
      manualOnly: true,
      readyLanes: 2,
      totalLanes: 2,
      avgScore: 82.4,
      expectedLiftPct: 10.3,
      topRouteLabel: "Target Accounts",
      primaryOpenUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
      primaryPastePayload: "Packet route output one.",
      nextAction: "Open Target Accounts, paste one useful payload, then mark the lane done or skipped.",
      summary: {
        topRouteLabel: "Target Accounts",
        topScore: 88.2,
        topStatus: "hot",
        routeBudget: "$0 incremental X API",
        readOps: 0,
        manualTarget: 2,
        activeWindow: "13:00",
        activeAngle: "Decision Rule",
      },
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "ready", label: "READY_LANES", value: "2/2", status: "ok" },
        { id: "score", label: "ROUTE_SCORE", value: "82.4", status: "ok" },
      ],
      lanes: [
        {
          id: "matrix:1",
          source: "paste_queue",
          rank: 1,
          label: "Target Accounts",
          routeLabel: "Target Accounts",
          openUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
          pastePayload: "Packet route output one.",
          status: "hot",
          ready: true,
          score: 88.2,
          routeScore: 82.1,
          opportunityScore: 91.2,
          expectedLiftPct: 12.5,
          targetReplies: 1,
          operatorSlaMinutes: 10,
          confidence: "medium",
          windowLabel: "13:00",
          formatId: "decision_rule",
          formatLabel: "Decision Rule",
          pillarId: "ai_platform",
          pillarLabel: "AI / Agent Stack",
          routeReason: "Use the strongest cached route; choose only a live technical exchange in the browser.",
          editRule: "Edit nouns, timing, and one concrete reference only.",
          skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
          doneSignal: "One useful route op completed or the lane skipped for quality.",
          readGate: "browser_only",
          operatorMode: "human_in_loop",
          manualOnly: true,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "matrix:2",
          source: "paste_queue",
          rank: 2,
          label: "AI / DevTools",
          routeLabel: "AI / DevTools",
          openUrl: "https://x.com/search?q=devtools&src=typed_query&f=live",
          pastePayload: "Packet route output two.",
          status: "ok",
          ready: true,
          score: 76.6,
          routeScore: 75.4,
          opportunityScore: 91.2,
          expectedLiftPct: 8.1,
          targetReplies: 1,
          operatorSlaMinutes: 20,
          confidence: "low",
          windowLabel: "13:00",
          formatId: "decision_rule",
          formatLabel: "Decision Rule",
          pillarId: "ai_platform",
          pillarLabel: "AI / Agent Stack",
          routeReason: "Use the strongest cached route; choose only a live technical exchange in the browser.",
          editRule: "Edit nouns, timing, and one concrete reference only.",
          skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
          doneSignal: "One useful route op completed or the lane skipped for quality.",
          readGate: "browser_only",
          operatorMode: "human_in_loop",
          manualOnly: true,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
      ],
      guardrails: [
        "Manual browser execution only; no automated outbound actions.",
        "No X search/read API calls for route selection.",
        "No rate-limit circumvention; use normal backoff and cached telemetry.",
        "Stop at target count and let maintenance write learning back.",
      ],
      copyBlock: "CODEX ROUTE OPPORTUNITY MATRIX\nCost guard: 0 extra X search/read ops",
    },
    l7SurgeSentinel: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_l7_surge_sentinel",
      severity: "ok",
      source: "cached packet metrics + route matrix + cost governor",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "cached_only",
      manualOnly: true,
      sentinelScore: 78.4,
      l7Events24h: 420,
      l7Events7d: 1960,
      dailyBaseline: 280,
      surgeRatio: 1.5,
      ackRate24h: 4.8,
      ackRate7d: 3.2,
      routeCoveragePct: 100,
      routeScore: 82.4,
      breakoutCount: 2,
      avgVelocity: 78.2,
      activeWindow: { hour: 13, label: "13:00", loadScore: 88.4 },
      primaryRouteLabel: "Target Accounts",
      primaryOpenUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
      primaryPastePayload: "Packet route output one.",
      nextAction: "Exploit the active load window with one manual route packet; keep live X reads sealed.",
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "l7_24h", label: "L7_24H", value: "420", status: "ok" },
        { id: "surge_ratio", label: "SURGE_RATIO", value: "1.50x", status: "ok" },
        { id: "route_ready", label: "ROUTE_READY", value: "2/2", status: "ok" },
      ],
      lanes: [
        {
          id: "l7_load",
          label: "L7_LOAD",
          value: "420",
          score: 78,
          status: "hot",
          detail: "280.0 baseline/day · 1.50x",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        },
        {
          id: "route_mesh",
          label: "ROUTE_MESH",
          value: "2/2",
          score: 95,
          status: "hot",
          detail: "82.4 avg matrix score",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
        },
      ],
      trace: [40, 64, 110, 206],
      traceMax: 206,
      guardrails: [
        "Cached telemetry only; 0 X search/read API operations.",
        "Manual browser execution only; no automated outbound actions.",
        "Normal backoff only; no rate-limit circumvention.",
      ],
    },
    growthLeakProfiler: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_growth_leak_profiler",
      severity: "warn",
      source: "cached packet metrics + active conn proxy + route matrix",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "cached_only",
      manualOnly: true,
      leakScore: 62.7,
      primaryLeakId: "profile_proxy",
      primaryLeak: {
        id: "profile_proxy",
        label: "PROFILE_PROXY",
        status: "warn",
        score: 42,
        leakPct: 58,
        nextAction: "Make the payload promise repeatable tech utility and place it under a credible account exchange.",
      },
      nextAction: "Make the payload promise repeatable tech utility and place it under a credible account exchange.",
      stages: [
        {
          id: "l7_input",
          label: "L7_INPUT",
          value: "420",
          score: 78,
          status: "ok",
          leakPct: 22,
          detail: "1.50x cached load ratio",
          nextAction: "Route one cached high-signal packet inside an active technical exchange before generating more standalone output.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "ack_layer",
          label: "ACK_LAYER",
          value: "4.8%",
          score: 76.8,
          status: "ok",
          leakPct: 23.2,
          detail: "reaction layer from cached packet metrics",
          nextAction: "Tighten the first line into one decision rule; make the payload useful enough for a senior operator to save.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "profile_proxy",
          label: "PROFILE_PROXY",
          value: "0.40/1k",
          score: 42,
          status: "warn",
          leakPct: 58,
          detail: "12 measured packets in cache",
          nextAction: "Make the payload promise repeatable tech utility and place it under a credible account exchange.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "active_conn",
          label: "ACTIVE_CONN",
          value: "+0",
          score: 44,
          status: "warn",
          leakPct: 56,
          detail: "0.00/1k observed · 0.80/1k prior",
          nextAction: "Run the strongest route lane and make the account promise explicit in the first sentence.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "route_mesh",
          label: "ROUTE_MESH",
          value: "2/2",
          score: 94.7,
          status: "ok",
          leakPct: 5.3,
          detail: "82.4 avg route score",
          nextAction: "Open the ready route lane, paste one useful payload, then mark done or skipped.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "cost_gate",
          label: "COST_GATE",
          value: "cached_only",
          score: 100,
          status: "ok",
          leakPct: 0,
          detail: "cached-only X read partition",
          nextAction: "Keep live reads sealed; operate from cached telemetry and manual browser routes.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
      ],
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "primary_leak", label: "PRIMARY_LEAK", value: "PROFILE_PROXY", status: "warn" },
        { id: "active_conn", label: "ACTIVE_CONN_DELTA", value: "+0", status: "warn" },
        { id: "profile_proxy", label: "PROFILE_PROXY", value: "0.40/1k", status: "ok" },
        { id: "route_ready", label: "ROUTE_READY", value: "2/2", status: "ok" },
      ],
      guardrails: [
        "Cached telemetry only; 0 X search/read API operations.",
        "Manual browser execution only; no automated outbound actions.",
        "Normal backoff only; no rate-limit circumvention.",
      ],
    },
    commandPacketDock: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_command_packet_dock",
      severity: "ok",
      source: "cached route matrix + leak profiler + paste queue",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "browser_only",
      manualOnly: true,
      commandScore: 78.3,
      routeLabel: "Target Accounts",
      openUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
      pastePayload: "Packet route output one.",
      targetOps: 1,
      operatorSlaMinutes: 10,
      primaryLeakId: "profile_proxy",
      primaryLeakLabel: "PROFILE_PROXY",
      primaryLeakStatus: "warn",
      nextAction: "Open Target Accounts, select one fresh technical exchange, paste the payload, then stop after 1 route op.",
      primaryPacket: {
        id: "matrix:1",
        label: "Target Accounts",
        status: "ready",
        openUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
        pastePayload: "Packet route output one.",
        score: 88.2,
        operatorSlaMinutes: 10,
        targetOps: 1,
        editRule: "Edit nouns, timing, and one concrete reference only.",
        skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
        doneSignal: "One useful route op completed or skipped for quality.",
        zeroExtraXReads: true,
        estimatedXReadOps: 0,
        estimatedIncrementalXApiUsd: 0,
      },
      steps: [
        { id: "open_route", label: "OPEN_ROUTE", status: "ok", detail: "Open the X web route from this dock." },
        { id: "select_exchange", label: "SELECT_EXCHANGE", status: "ok", detail: "Choose one fresh technical exchange with visible discussion." },
        { id: "paste_payload", label: "PASTE_PAYLOAD", status: "ok", detail: "Paste once, edit only context, then leave the lane." },
        { id: "stop_gate", label: "STOP_GATE", status: "ok", detail: "Stop after 1 route op or when quality drops." },
      ],
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "route", label: "ROUTE", value: "Target Accounts", status: "ok" },
        { id: "sla", label: "OPERATOR_SLA", value: "10m", status: "ok" },
        { id: "leak", label: "PRIMARY_LEAK", value: "PROFILE_PROXY", status: "warn" },
        { id: "payload", label: "PAYLOAD", value: "armed", status: "ok" },
      ],
      guardrails: [
        "Manual browser execution only; no automated outbound actions.",
        "Use X web route links; search/read API operations stay at 0.",
        "No rate-limit circumvention; use normal cooldown and cached telemetry.",
      ],
      copyBlock: "CODEX COMMAND PACKET DOCK\nCost guard: 0 X search/read API operations\nOPEN: https://x.com/search?q=ai&src=typed_query&f=live\nPASTE: Packet route output one.",
    },
    identityConversionFirewall: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_identity_conversion_firewall",
      severity: "warn",
      source: "cached account promise + active conn proxy + route dock",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "cached_only",
      manualOnly: true,
      identityScore: 68.4,
      accountPromise: "Tech Signals explains how AI, platforms, apps, cloud, security, and startups change operator leverage, defaults, distribution, and risk.",
      primaryPillarId: "operator_leverage",
      primaryPillarLabel: "Operator Leverage",
      routeLabel: "Target Accounts",
      activeConnDelta: 0,
      profileClickPer1k: 0.4,
      weakestCheckId: "profile_proxy",
      weakestCheckLabel: "PROFILE_PROXY",
      nextAction: "Turn the first sentence into a reason to inspect the operator behind the packet.",
      checks: [
        {
          id: "promise_match",
          label: "PROMISE_MATCH",
          value: "Operator Leverage",
          score: 74,
          status: "ok",
          detail: "account memory vs cached narrative lane",
          nextAction: "Make the next packet prove Operator Leverage inside the first line.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "active_conn",
          label: "ACTIVE_CONN",
          value: "+0",
          score: 49,
          status: "warn",
          detail: "active conn delta from cached account snapshots",
          nextAction: "Route one proof packet that makes the account promise obvious before asking for attention.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "profile_proxy",
          label: "PROFILE_PROXY",
          value: "0.40/1k",
          score: 41,
          status: "danger",
          detail: "12 cached packets in the conversion buffer",
          nextAction: "Turn the first sentence into a reason to inspect the operator behind the packet.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "route_proof",
          label: "ROUTE_PROOF",
          value: "armed",
          score: 82,
          status: "ok",
          detail: "Target Accounts command dock lane",
          nextAction: "Open Target Accounts, paste one useful payload, then stop at the manual gate.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "leak_repair",
          label: "LEAK_REPAIR",
          value: "PROFILE_PROXY",
          score: 58,
          status: "warn",
          detail: "lowest-scoring cached loop partition",
          nextAction: "Make the payload promise repeatable tech utility and place it under a credible account exchange.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
        {
          id: "cost_boundary",
          label: "COST_BOUNDARY",
          value: "0 ops",
          score: 100,
          status: "ok",
          detail: "read partition sealed to cached telemetry",
          nextAction: "Keep identity tuning inside cached data and manual browser execution.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
        },
      ],
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "identity_score", label: "IDENTITY_SCORE", value: "68.4", status: "warn" },
        { id: "promise", label: "PROMISE", value: "Operator Leverage", status: "ok" },
        { id: "active_conn", label: "ACTIVE_CONN_DELTA", value: "+0", status: "warn" },
        { id: "route", label: "ROUTE_PROOF", value: "armed", status: "ok" },
        { id: "weakest", label: "WEAKEST_GATE", value: "PROFILE_PROXY", status: "danger" },
      ],
      profileRunbook: [
        "Lead every packet with one operator-grade rule before any recap.",
        "Keep the visible account memory aligned to Operator Leverage.",
        "Route through Target Accounts; stop after the manual ACK gate.",
      ],
      guardrails: [
        "Cached telemetry only; 0 X search/read API operations.",
        "Manual browser execution only; no automated outbound actions.",
        "Normal cooldown only; no rate-limit shortcuts.",
      ],
      copyBlock: "CODEX IDENTITY CONVERSION FIREWALL\nCost guard: 0 X search/read API operations\nIdentity score: 68.4\nRoute: Target Accounts.",
    },
    growthLoopTrace: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_growth_loop_trace",
      severity: "warn",
      source: "cached RSS + generation policy + command dock + learning contract",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "cached_only",
      manualOnly: true,
      traceScore: 69.2,
      totalLatencyMs: 10800,
      savedReadOps: 5,
      activeSource: "github.blog",
      bottleneckStageId: "learn_writeback",
      bottleneckStageLabel: "LEARN_WRITEBACK",
      nextAction: "Let maintenance refresh metrics before widening the topic surface.",
      stages: [
        {
          id: "rss_ingest",
          label: "RSS_INGEST",
          subsystem: "RSS",
          score: 82,
          status: "ok",
          durationMs: 1700,
          startMs: 0,
          endMs: 1700,
          startPct: 0,
          widthPct: 15.74,
          input: "46 cached sources",
          output: "8 cached signals",
          detail: "github.blog feeds the route loop without X read ops.",
          nextAction: "Keep github.blog hot until its cached velocity cools.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "cached_only",
          readGate: "cached_only",
        },
        {
          id: "swarm_rank",
          label: "SWARM_RANK",
          subsystem: "AI",
          score: 74,
          status: "ok",
          durationMs: 2400,
          startMs: 1700,
          endMs: 4100,
          startPct: 15.74,
          widthPct: 22.22,
          input: "8 signal candidates",
          output: "3 angle lanes",
          detail: "Cached rank policy selected the next angle lane.",
          nextAction: "Keep the winning angle lane pinned until maintenance writes new evidence.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "cached_only",
          readGate: "cached_only",
        },
        {
          id: "packet_draft",
          label: "PACKET_DRAFT",
          subsystem: "TXT",
          score: 78,
          status: "ok",
          durationMs: 1800,
          startMs: 4100,
          endMs: 5900,
          startPct: 37.96,
          widthPct: 16.67,
          input: "Target Accounts",
          output: "payload armed",
          detail: "Operator packet is ready for manual paste.",
          nextAction: "Copy one payload and preserve the operator-grade first line.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "cached_only",
          readGate: "cached_only",
        },
        {
          id: "manual_route",
          label: "MANUAL_ROUTE",
          subsystem: "X",
          score: 68,
          status: "warn",
          durationMs: 2900,
          startMs: 5900,
          endMs: 8800,
          startPct: 54.63,
          widthPct: 26.85,
          input: "Target Accounts",
          output: "browser route armed",
          detail: "Manual X web route is armed; API read partition stays sealed.",
          nextAction: "Open Target Accounts, paste one useful payload, then stop at the manual gate.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "human_in_loop",
          readGate: "browser_only",
        },
        {
          id: "learn_writeback",
          label: "LEARN_WRITEBACK",
          subsystem: "ML",
          score: 44,
          status: "warn",
          durationMs: 2000,
          startMs: 8800,
          endMs: 10800,
          startPct: 81.48,
          widthPct: 18.52,
          input: "120 packet samples",
          output: "angle weights updated",
          detail: "Maintenance writes cached packet outcomes into the next angle decision.",
          nextAction: "Let maintenance refresh metrics before widening the topic surface.",
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "cached_only",
          readGate: "cached_only",
        },
      ],
      edges: [
        { id: "rss_ingest->swarm_rank", from: "rss_ingest", to: "swarm_rank", label: "RSS->AI", status: "ok", score: 78, zeroExtraXReads: true, estimatedXReadOps: 0, estimatedIncrementalXApiUsd: 0 },
        { id: "swarm_rank->packet_draft", from: "swarm_rank", to: "packet_draft", label: "AI->TXT", status: "ok", score: 76, zeroExtraXReads: true, estimatedXReadOps: 0, estimatedIncrementalXApiUsd: 0 },
        { id: "packet_draft->manual_route", from: "packet_draft", to: "manual_route", label: "TXT->X", status: "ok", score: 73, zeroExtraXReads: true, estimatedXReadOps: 0, estimatedIncrementalXApiUsd: 0 },
        { id: "manual_route->learn_writeback", from: "manual_route", to: "learn_writeback", label: "X->ML", status: "warn", score: 56, zeroExtraXReads: true, estimatedXReadOps: 0, estimatedIncrementalXApiUsd: 0 },
      ],
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "trace_score", label: "TRACE_SCORE", value: "69.2", status: "warn" },
        { id: "bottleneck", label: "BOTTLENECK", value: "LEARN_WRITEBACK", status: "warn" },
        { id: "latency", label: "TRACE_LATENCY", value: "10.8s", status: "ok" },
        { id: "saved_reads", label: "SAVED_READ_OPS", value: "5 ops", status: "ok" },
        { id: "manual_gate", label: "MANUAL_GATE", value: "armed", status: "ok" },
      ],
      guardrails: [
        "Cached telemetry only; 0 X search/read API operations.",
        "Manual browser route only; no automated outbound actions.",
        "Normal cooldown only; no rate-limit shortcuts.",
      ],
      copyBlock: "CODEX GROWTH LOOP TRACE\nCost guard: 0 X search/read API operations\nTrace score: 69.2\nBottleneck: LEARN_WRITEBACK.",
    },
    routeFireDrill: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_route_fire_drill",
      severity: "ok",
      source: "cached route matrix + command dock + growth loop trace",
      zeroExtraXReads: true,
      estimatedXReadOps: 0,
      estimatedIncrementalXApiUsd: 0,
      operatorMode: "human_in_loop",
      readGate: "browser_only",
      manualOnly: true,
      drillScore: 73.2,
      primaryScenarioId: "alpha",
      primaryRouteLabel: "Target Accounts",
      primaryOpenUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
      primaryPastePayload: "Cloud platforms are becoming operating systems for teams. The lock-in is incident memory, secrets, previews, and rollback paths.",
      nextAction: "Run ALPHA_FIRE on Target Accounts, then stop at the ACK gate.",
      scenarios: [
        {
          id: "alpha",
          label: "ALPHA_FIRE",
          mode: "highest_score",
          status: "ok",
          drillScore: 78.4,
          routeLabel: "Target Accounts",
          openUrl: "https://x.com/search?q=ai&src=typed_query&f=live",
          pastePayload: "Cloud platforms are becoming operating systems for teams. The lock-in is incident memory, secrets, previews, and rollback paths.",
          targetOps: 3,
          operatorSlaMinutes: 10,
          expectedLiftPct: 12.4,
          projectedL7Events: 260,
          projectedActiveConns: 0.34,
          confidence: "medium",
          detail: "Execute the strongest ready route first.",
          routeReason: "cached route readiness, expected lift, SLA, and budget guard",
          editRule: "Edit nouns, timing, and one concrete reference only.",
          skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
          stopRule: "Stop after 3 route ops or when quality drops.",
          ready: true,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "human_in_loop",
          readGate: "browser_only",
          manualOnly: true,
        },
        {
          id: "bravo",
          label: "BRAVO_FAST",
          mode: "fast_ack",
          status: "warn",
          drillScore: 64.8,
          routeLabel: "Builder Feed",
          openUrl: "https://x.com/search?q=developer%20tools&src=typed_query&f=live",
          pastePayload: "The hard part is not model IQ anymore. It is who owns evals, tool permissions, rollback, and the first bad agent incident.",
          targetOps: 2,
          operatorSlaMinutes: 8,
          expectedLiftPct: 7.1,
          projectedL7Events: 188,
          projectedActiveConns: 0.25,
          confidence: "low",
          detail: "Use the shortest SLA lane when the top route is stale.",
          routeReason: "cached fast-lane SLA and manual browser route",
          editRule: "Edit nouns, timing, and one concrete reference only.",
          skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
          stopRule: "Stop after 2 route ops or when quality drops.",
          ready: true,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "human_in_loop",
          readGate: "browser_only",
          manualOnly: true,
        },
        {
          id: "charlie",
          label: "CHARLIE_REPAIR",
          mode: "repair_gate",
          status: "warn",
          drillScore: 52.3,
          routeLabel: "Repair Lane",
          openUrl: "https://x.com/search?q=cloud%20security&src=typed_query&f=live",
          pastePayload: "Security defaults decide adoption faster than launch demos. Teams copy the tool that makes rollback and permission review boring.",
          targetOps: 1,
          operatorSlaMinutes: 15,
          expectedLiftPct: 3.2,
          projectedL7Events: 142,
          projectedActiveConns: 0.19,
          confidence: "low",
          detail: "Hold or repair if route quality drops below the manual gate.",
          routeReason: "cached repair gate keeps distribution quality above the floor",
          editRule: "Edit nouns, timing, and one concrete reference only.",
          skipRule: "Skip stale, political, giveaway, ragebait, low-signal, or off-topic exchanges.",
          stopRule: "Stop after 1 route op or when quality drops.",
          ready: true,
          zeroExtraXReads: true,
          estimatedXReadOps: 0,
          estimatedIncrementalXApiUsd: 0,
          operatorMode: "human_in_loop",
          readGate: "browser_only",
          manualOnly: true,
        },
      ],
      cells: [
        { id: "x_reads", label: "X_READ_PARTITION", value: "0 ops", status: "ok" },
        { id: "drill_score", label: "DRILL_SCORE", value: "73.2", status: "ok" },
        { id: "primary", label: "PRIMARY_FIRE", value: "ALPHA_FIRE", status: "ok" },
        { id: "projected_l7", label: "PROJECTED_L7", value: "260", status: "ok" },
        { id: "active_conn", label: "ACTIVE_CONN_PROXY", value: "0.34", status: "ok" },
        { id: "manual_gate", label: "MANUAL_GATE", value: "armed", status: "ok" },
      ],
      guardrails: [
        "Cached telemetry only; 0 X search/read API operations.",
        "Manual browser execution only; no automated outbound actions.",
        "Stop at the ACK gate; no automated outbound actions.",
      ],
      copyBlock: "CODEX ROUTE FIRE DRILL\nCost guard: 0 X search/read API operations\nPrimary: ALPHA_FIRE · Target Accounts\nOPEN: https://x.com/search?q=ai&src=typed_query&f=live\nPASTE: Cloud platforms are becoming operating systems for teams. The lock-in is incident memory, secrets, previews, and rollback paths.",
    },
    rateLimitGovernor: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      status: "reactor nominal",
      severity: "ok",
      circuit: {
        mode: "nominal_cached_first",
        pressurePct: 12.5,
        zeroExtraXReads: true,
      },
      zeroExtraXReads: true,
      gates: {
        read: "cached_only",
        publish: "review",
        cadence: "manual_route_only",
      },
      budget: {
        capUsd: 5,
        safeCapUsd: 4.5,
        trackedSpendUsd: 1.25,
        safeRemainingUsd: 3.25,
        safeTextSlots: 216,
        textPostCostUsd: 0.015,
      },
      partitionMatrix: [
        {
          id: "read_search",
          label: "READ_SEARCH",
          gate: "cached_only",
          status: "ok",
          calls: 0,
          failures: 0,
          pressurePct: 10,
          directive: "No paid search reads; route from cached opportunities.",
        },
        {
          id: "write",
          label: "WRITE_PATH",
          gate: "review",
          status: "ok",
          calls: 2,
          failures: 0,
          pressurePct: 4,
          directive: "Human review required before writes.",
        },
      ],
      cells: [
        { id: "read", label: "read gate", value: "cached_only", status: "ok" },
        { id: "publish", label: "packet gate", value: "review", status: "warn" },
      ],
      runbook: "Cached routing is clear. Keep live X reads at zero unless the cadence gate explicitly opens.",
    },
    xApiRunwayGuard: {
      enabled: true,
      active: false,
      monthEndSafe: true,
      projectedCostUsd: 0.1,
      projectedDailyBurnUsd: 0.015,
      monthEndProjectedSpendUsd: 1.6,
      safeCapUsd: 4.5,
      safeRemainingUsd: 3.25,
    },
    budgetBurnReactor: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      zeroExtraXReads: true,
      source: "x_api_usage ledger + dispatch budget ledger",
      severity: "ok",
      mode: "inside_safe_envelope",
      capUsd: 5,
      safeCapUsd: 4.5,
      spendUsd: 1.25,
      safeRemainingUsd: 3.25,
      burnPct: 27.8,
      projectedDailyBurnUsd: 0.015,
      readGate: "cached_only",
      publishGate: "review",
      mediaGate: "hold",
      runbook: "Budget burn is inside the safe envelope. Preserve images behind ROI gate and keep live reads at zero.",
      partitions: [
        { id: "manual_routes", label: "manual route lanes", value: "$0.000", status: "ok", detail: "operator paste loop" },
        { id: "text_publish", label: "text dispatch", value: "$0.015", status: "ok", detail: "216 safe slots" },
        { id: "media_publish", label: "media dispatch", value: "$0.030", status: "warn", detail: "held behind ROI gate" },
        { id: "live_reads", label: "live X reads", value: "0 ops", status: "ok", detail: "cached_only" },
      ],
      series: [
        { day: "2026-07-08", usd: 0.015 },
        { day: "2026-07-09", usd: 0.015 },
      ],
    },
    budgetAllocationOptimizer: {
      generatedAt: "2026-07-09T00:00:00.000Z",
      mode: "zero_read_budget_allocator",
      zeroExtraXReads: true,
      source: "cached cost ledger + route amplifier + cadence controller",
      severity: "ok",
      recommendedLaneId: "manual_route_burst",
      recommendedAction: "Execute the top manual route packet before buying more X API operations.",
      safeRemainingUsd: 3.25,
      capUsd: 5,
      safeCapUsd: 4.5,
      lanes: [
        {
          id: "manual_route_burst",
          label: "manual route burst",
          costUsd: 0,
          safeSlots: 2,
          expectedLiftPct: 18,
          gate: "open",
          status: "ok",
          efficiencyScore: 92,
          detail: "Operator paste loop uses prepared X web routes and spends no X search/read API.",
          nextAction: "Execute the top manual route packet before buying more X API operations.",
          xReadOps: 0,
          zeroExtraXReads: true,
        },
        {
          id: "text_post_experiment",
          label: "text dispatch experiment",
          costUsd: 0.015,
          safeSlots: 216,
          expectedLiftPct: 6,
          gate: "review",
          status: "warn",
          efficiencyScore: 58,
          detail: "Cadence controller decides whether the next standalone packet should publish.",
          nextAction: "Publish only inside the cadence and budget boundary.",
          xReadOps: 0,
          zeroExtraXReads: true,
        },
        {
          id: "live_x_search",
          label: "live X search",
          costUsd: 0.015,
          safeSlots: 0,
          expectedLiftPct: 0,
          gate: "closed",
          status: "danger",
          efficiencyScore: 0,
          detail: "Use browser/web search links instead; the bot should not burn X search/read quota for manual targeting.",
          nextAction: "Keep this partition sealed unless you explicitly switch out of low-cost mode.",
          xReadOps: 1,
          zeroExtraXReads: false,
        },
      ],
      rankedLaneIds: ["manual_route_burst", "text_post_experiment", "live_x_search"],
    },
    mediaRoiGate: {
      enabled: true,
      decision: "hold",
      attachImageAllowed: false,
      generatedAt: "2026-07-09T00:00:00.000Z",
      zeroExtraXReads: true,
      confidence: "low_samples",
      reason: "Need 3+ measured text and media packets before spending on images.",
      nextAction: "Keep image packets off until enough cached outcomes prove lift.",
      checks: [
        { id: "samples", ok: false, label: "cached sample floor", value: "0/3 media · 0/3 text" },
        { id: "x_reads", ok: true, label: "extra X reads", value: "0" },
      ],
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectValidationFailure(label, data, expectedPattern) {
  try {
    assertDashboardData(data);
  } catch (error) {
    if (!(error instanceof DashboardValidationError)) throw error;
    const text = `${error.message}\n${error.details || ""}`;
    if (!expectedPattern.test(text)) {
      throw new Error(`Self-test ${label} failed with unexpected error: ${text}`);
    }
    console.log(`Dashboard validator self-test rejected ${label}.`);
    return;
  }
  throw new Error(`Self-test ${label} unexpectedly passed.`);
}

function runSelfTest() {
  const good = validFixture();
  assertDashboardData(good);

  const missingSignalMap = clone(good);
  delete missingSignalMap.signalMap;
  expectValidationFailure("missing signalMap", missingSignalMap, /missing explicit signalMap/i);

  const routeMismatch = clone(good);
  routeMismatch.signalMap.nodes.find((node) => node.id === "x").value = 99;
  expectValidationFailure("X_ROUTE count mismatch", routeMismatch, /X_ROUTE count/i);

  const unsafeSource = clone(good);
  unsafeSource.signalMap.source = "tweet analytics";
  expectValidationFailure("tweet vocabulary", unsafeSource, /packet vocabulary|forbidden dashboard vocabulary/i);

  const missingCommander = clone(good);
  delete missingCommander.nextWindowAngleCommander;
  expectValidationFailure("missing commander", missingCommander, /missing nextWindowAngleCommander/i);

  const commanderReadDrift = clone(good);
  commanderReadDrift.nextWindowAngleCommander.estimatedXReadOps = 1;
  expectValidationFailure("commander X read drift", commanderReadDrift, /zero-read/i);

  const commanderWindowDrift = clone(good);
  commanderWindowDrift.nextWindowAngleCommander.window.hour = 14;
  expectValidationFailure("commander window mismatch", commanderWindowDrift, /hours must match/i);

  const surgeReadDrift = clone(good);
  surgeReadDrift.l7SurgeSentinel.estimatedXReadOps = 1;
  expectValidationFailure("L7 surge X read drift", surgeReadDrift, /l7SurgeSentinel must be zero-read/i);

  const surgeTraceDrift = clone(good);
  surgeTraceDrift.l7SurgeSentinel.traceMax = 20;
  expectValidationFailure("L7 surge trace drift", surgeTraceDrift, /traceMax/i);

  const leakReadDrift = clone(good);
  leakReadDrift.growthLeakProfiler.estimatedXReadOps = 1;
  expectValidationFailure("growth leak X read drift", leakReadDrift, /growthLeakProfiler must be zero-read/i);

  const leakPrimaryDrift = clone(good);
  leakPrimaryDrift.growthLeakProfiler.primaryLeakId = "ghost_partition";
  expectValidationFailure("growth leak primary drift", leakPrimaryDrift, /primaryLeakId must reference a stage/i);

  const commandDockReadDrift = clone(good);
  commandDockReadDrift.commandPacketDock.estimatedXReadOps = 1;
  expectValidationFailure("command dock X read drift", commandDockReadDrift, /commandPacketDock must be zero-read/i);

  const commandDockModeDrift = clone(good);
  commandDockModeDrift.commandPacketDock.operatorMode = "autonomous";
  expectValidationFailure("command dock operator mode drift", commandDockModeDrift, /human-in-loop/i);

  const identityReadDrift = clone(good);
  identityReadDrift.identityConversionFirewall.estimatedXReadOps = 1;
  expectValidationFailure("identity firewall X read drift", identityReadDrift, /identityConversionFirewall must be zero-read/i);

  const identityModeDrift = clone(good);
  identityModeDrift.identityConversionFirewall.operatorMode = "autonomous";
  expectValidationFailure("identity firewall operator mode drift", identityModeDrift, /human-in-loop/i);

  const identityWeakestDrift = clone(good);
  identityWeakestDrift.identityConversionFirewall.weakestCheckId = "ghost_gate";
  expectValidationFailure("identity firewall weakest gate drift", identityWeakestDrift, /weakestCheckId must reference/i);

  const traceReadDrift = clone(good);
  traceReadDrift.growthLoopTrace.stages[0].estimatedXReadOps = 1;
  expectValidationFailure("growth loop trace X read drift", traceReadDrift, /growthLoopTrace stage must be zero-read/i);

  const traceModeDrift = clone(good);
  traceModeDrift.growthLoopTrace.operatorMode = "autonomous";
  expectValidationFailure("growth loop trace operator mode drift", traceModeDrift, /human-in-loop/i);

  const traceBottleneckDrift = clone(good);
  traceBottleneckDrift.growthLoopTrace.bottleneckStageId = "ghost_stage";
  expectValidationFailure("growth loop trace bottleneck drift", traceBottleneckDrift, /bottleneckStageId must reference/i);

  const routeFireReadDrift = clone(good);
  routeFireReadDrift.routeFireDrill.scenarios[0].estimatedXReadOps = 1;
  expectValidationFailure("route fire drill X read drift", routeFireReadDrift, /routeFireDrill scenario must be manual-only and zero-read/i);

  const routeFireModeDrift = clone(good);
  routeFireModeDrift.routeFireDrill.operatorMode = "autonomous";
  expectValidationFailure("route fire drill operator mode drift", routeFireModeDrift, /human-in-loop/i);

  const routeFirePrimaryDrift = clone(good);
  routeFirePrimaryDrift.routeFireDrill.primaryScenarioId = "ghost_scenario";
  expectValidationFailure("route fire drill primary drift", routeFirePrimaryDrift, /primaryScenarioId must reference/i);

  const brokenRoute = clone(good);
  brokenRoute.signalMap.routes[0].from = "ghost";
  expectValidationFailure("unknown route node", brokenRoute, /unknown source node/i);

  const missingBudgetBurn = clone(good);
  delete missingBudgetBurn.budgetBurnReactor;
  expectValidationFailure("missing budget burn reactor", missingBudgetBurn, /missing budgetBurnReactor/i);

  const liveSearchRecommended = clone(good);
  liveSearchRecommended.budgetAllocationOptimizer.recommendedLaneId = "live_x_search";
  expectValidationFailure("live search recommended", liveSearchRecommended, /recommended lane must not require X reads/i);

  const mediaReadDrift = clone(good);
  mediaReadDrift.mediaRoiGate.checks.find((check) => check.id === "x_reads").value = "1";
  expectValidationFailure("media X read drift", mediaReadDrift, /zero extra X reads check/i);

  const triageCounterDrift = clone(good);
  triageCounterDrift.api.statusTriage.backendFault5xx = 0;
  expectValidationFailure("HTTP triage backend drift", triageCounterDrift, /backendFault5xx/i);

  const triageMatrixDrift = clone(good);
  triageMatrixDrift.api.statusTriage.statusMatrix.find((row) => row.id === "backend5xx").count = 0;
  expectValidationFailure("HTTP triage matrix drift", triageMatrixDrift, /statusMatrix\.backend5xx\.count/i);

  const activeFaultGateDrift = clone(good);
  activeFaultGateDrift.api.endpoints[1].lastStatus = 503;
  activeFaultGateDrift.api.statusTriage.activeBackendFault5xx = 1;
  activeFaultGateDrift.api.statusTriage.severity = "danger";
  activeFaultGateDrift.api.statusTriage.incidents[0].active = true;
  activeFaultGateDrift.api.statusTriage.incidents[0].severity = "danger";
  expectValidationFailure("active HTTP fault read gate", activeFaultGateDrift, /read gate/i);

  console.log("Dashboard data validator self-test passed.");
}

try {
  if (process.argv.includes("--self-test") || process.env.DASHBOARD_VALIDATOR_SELF_TEST === "true") {
    runSelfTest();
  } else {
    const data = readDashboardData(file);
    assertDashboardData(data);
    console.log(`Dashboard data validation passed: ${file}`);
  }
} catch (error) {
  if (error instanceof DashboardValidationError) {
    printValidationError(error);
  } else {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
  }
  process.exit(1);
}
