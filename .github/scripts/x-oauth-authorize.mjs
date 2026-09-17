import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

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

function parseCallbackUrl(requestUrl) {
  const url = new URL(requestUrl, DEFAULT_REDIRECT_URI);
  return {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
    errorDescription: url.searchParams.get("error_description"),
  };
}

function htmlResponse(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p><p>可以关闭这个页面，回到终端查看 refresh_token。</p></body></html>`;
}

function compactSecret(value) {
  return String(value || "").replace(/\s+/g, "");
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

async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  codeVerifier,
}) {
  const normalizedClientId = compactSecret(clientId);
  const normalizedClientSecret = compactSecret(clientSecret);
  const confidential = isConfidentialXClient(normalizedClientId);
  if (confidential && !normalizedClientSecret) {
    throw new Error(
      "Missing X_CLIENT_SECRET for confidential X OAuth app (:ci).",
    );
  }

  const { headers, body } = buildXOAuthTokenRequest({
    clientId: normalizedClientId,
    clientSecret: normalizedClientSecret,
    confidential,
    params: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
  });

  const response = await fetch(X_OAUTH2_TOKEN_URL, {
    method: "POST",
    headers,
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Token exchange failed: ${response.status} ${JSON.stringify(data)}`,
    );
  }
  return data;
}

async function main() {
  const clientId = compactSecret(requireEnv("X_CLIENT_ID"));
  const clientSecret = compactSecret(requireEnv("X_CLIENT_SECRET"));
  const redirectUri = optionalEnv("X_REDIRECT_URI", DEFAULT_REDIRECT_URI);
  const scope = optionalEnv("X_OAUTH2_SCOPE", DEFAULT_SCOPE);
  const port = Number(optionalEnv("X_OAUTH_REDIRECT_PORT", "3000"));

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

  const authorizeLink = authorizeUrl.toString();
  console.log("在浏览器打开下面这个链接并完成授权:\n");
  console.log(authorizeLink);
  console.log(`\n等待回调: ${redirectUri}`);

  if (process.platform === "darwin") {
    spawn("open", [authorizeLink], { stdio: "ignore", detached: true }).unref();
    console.log("\n已在默认浏览器打开授权页（macOS）。");
  }

  const tokenData = await new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer(async (request, response) => {
      const callback = parseCallbackUrl(request.url || "/");

      if (callback.error) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(htmlResponse("授权失败", callback.error));
        if (!settled) {
          settled = true;
          server.close();
          reject(
            new Error(
              `Authorization denied: ${callback.error}${callback.errorDescription ? ` (${callback.errorDescription})` : ""}`,
            ),
          );
        }
        return;
      }

      if (!callback.code) {
        response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        response.end(htmlResponse("未收到 code", "请从终端里的授权链接进入。"));
        return;
      }

      if (callback.state !== state) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(htmlResponse("state 不匹配", "请重新运行脚本。"));
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error("OAuth state mismatch."));
        }
        return;
      }

      try {
        const data = await exchangeAuthorizationCode({
          clientId,
          clientSecret,
          redirectUri,
          code: callback.code,
          codeVerifier,
        });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          htmlResponse("授权成功", "refresh_token 已输出到终端。"),
        );
        if (!settled) {
          settled = true;
          server.close();
          resolve(data);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        response.end(htmlResponse("换 token 失败", message));
        if (!settled) {
          settled = true;
          server.close();
          reject(error);
        }
      }
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`本地回调服务已启动: http://127.0.0.1:${port}`);
    });

    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("等待授权超时（10 分钟）。"));
      }
    }, 10 * 60 * 1000);
  });

  console.log("\n授权成功。\n");
  console.log("Scopes:", tokenData.scope || "(not returned)");
  console.log(
    "Access token expires in:",
    tokenData.expires_in ?? "unknown",
    "seconds",
  );

  if (!tokenData.refresh_token) {
    throw new Error(
      `No refresh_token returned. Response: ${JSON.stringify(tokenData)}`,
    );
  }

  console.log("\n把下面这串填到 GitHub secret: X_OAUTH2_REFRESH_TOKEN\n");
  console.log(tokenData.refresh_token);
  console.log(
    "\n更新 secret 后，只删除 Actions caches: x-bot-tokens-* 和 x-oauth2-refresh-token-*（不要删 x-bot-learning-*）",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
