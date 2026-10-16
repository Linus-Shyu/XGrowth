#!/usr/bin/env node

// Paste-based X OAuth 2.0 authorization: no local HTTP server needed.
// The browser lands on an ERR_CONNECTION_REFUSED page (nothing listens on
// localhost:3000); copy that page's full URL from the address bar and paste it
// back into this script. The PKCE verifier lives in this process, so the
// exchange is just as secure as the server-based flow.

import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const X_OAUTH2_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_OAUTH2_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const DEFAULT_SCOPE =
  "tweet.read tweet.write users.read offline.access media.write";
const DEFAULT_REDIRECT_URI = "http://localhost:3000";

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

function compactSecret(value) {
  return String(value || "").replace(/\s+/g, "");
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeVerifier() {
  return base64UrlEncode(randomBytes(32));
}

function createCodeChallenge(codeVerifier) {
  return base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
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

function parseCallbackUrl(input) {
  const url = new URL(String(input || "").trim(), DEFAULT_REDIRECT_URI);
  return {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
    errorDescription: url.searchParams.get("error_description"),
  };
}

async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  codeVerifier,
}) {
  const confidential = isConfidentialXClient(clientId);
  if (confidential && !clientSecret) {
    throw new Error("Missing X_CLIENT_SECRET for confidential X OAuth app (:ci).");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (confidential || clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
  } else {
    body.set("client_id", clientId);
  }

  const response = await fetch(X_OAUTH2_TOKEN_URL, { method: "POST", headers, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const clientId = compactSecret(requireEnv("X_CLIENT_ID"));
  const clientSecret = compactSecret(optionalEnv("X_CLIENT_SECRET"));
  const redirectUri = optionalEnv("X_REDIRECT_URI", DEFAULT_REDIRECT_URI);
  const scope = optionalEnv("X_OAUTH2_SCOPE", DEFAULT_SCOPE);

  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const state = base64UrlEncode(randomBytes(16));

  const authorizeUrl = new URL(X_OAUTH2_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  console.log("\n1. 在浏览器打开下面这个链接并完成授权:\n");
  console.log(authorizeUrl.toString());
  console.log("\n2. 授权完成后浏览器会跳转到 http://localhost:3000 并显示“无法连接”(这是正常的)。");
  console.log("   复制浏览器地址栏里的【完整 URL】(以 http://localhost:3000/?code=... 开头)。\n");

  const pasted = (await readLine("3. 把完整 URL(或 URL 里 code= 后面的那串码)粘贴到这里后回车: ")).trim();

  let callback;
  if (/^https?:\/\//i.test(pasted)) {
    callback = parseCallbackUrl(pasted);
    if (callback.error) {
      throw new Error(
        `Authorization denied: ${callback.error}${callback.errorDescription ? ` (${callback.errorDescription})` : ""}`,
      );
    }
    if (callback.state && callback.state !== state) {
      throw new Error("state 不匹配, 请重新运行本脚本再试一次。");
    }
  } else {
    // 直接粘贴 code 本身(跳转页里 code= 后面的部分)
    callback = { code: pasted.split(/[&=]/).pop() || "", state: null, error: null };
  }
  if (!callback.code) {
    throw new Error("没有拿到 code。请复制跳转页地址栏里 code= 后面的那串字符(不含 &state 部分)。");
  }

  const data = await exchangeAuthorizationCode({
    clientId,
    clientSecret,
    redirectUri,
    code: callback.code,
    codeVerifier,
  });

  console.log("\n========================================");
  console.log("授权成功。你的 refresh_token:");
  console.log("========================================\n");
  console.log(data.refresh_token);
  console.log("\n接下来:");
  console.log("1. 把上面的 refresh_token 更新到 x_bot 的 GitHub secret X_OAUTH2_REFRESH_TOKEN");
  console.log("2. 删除 Actions caches 里所有 x-bot-tokens-* 条目 (不要删 x-bot-learning-*)");
  console.log("3. 手动跑一次 growth maintenance (dashboard_only) 验证日志无 invalid token");
  console.log("注意: access_token 只是临时的, refresh_token 才是要存的值。");
}

main().catch((error) => {
  console.error(`\n错误: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
