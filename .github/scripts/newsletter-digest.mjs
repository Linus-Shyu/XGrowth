// Weekly newsletter digest: builds a markdown digest from the growth report
// (+ platform variants when present) and optionally emails it via Resend.
// Without RESEND_* secrets it just writes reports/newsletter-digest.md.
// Runs under node or bun; no Bun-only APIs.

import { mkdir, readFile, writeFile } from "node:fs/promises";

const env = (name, fallback = "") => String(process.env[name] || "").trim() || fallback;

const REPORT_FILE = env("GROWTH_REPORT_FILE", ".github/runtime/growth-report.md");
const PUBLIC_REPORT = env("GROWTH_REPORT_PUBLIC_FILE", "reports/growth-report.md");
const VARIANTS_FILE = env("TWEET_PLATFORM_VARIANTS_FILE", ".github/runtime/platform-variants.md");
const DIGEST_FILE = env("NEWSLETTER_DIGEST_FILE", ".github/runtime/newsletter-digest.md");
const PUBLIC_DIGEST = env("NEWSLETTER_DIGEST_PUBLIC_FILE", "reports/newsletter-digest.md");
const RESEND_API_KEY = env("RESEND_API_KEY");
const NEWSLETTER_FROM = env("NEWSLETTER_FROM");
const NEWSLETTER_TO = env("NEWSLETTER_TO");
const NEWSLETTER_SUBJECT = env("NEWSLETTER_SUBJECT", "x_bot weekly growth digest");

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const report =
    (await readTextIfExists(REPORT_FILE)) || (await readTextIfExists(PUBLIC_REPORT));
  const variants = await readTextIfExists(VARIANTS_FILE);
  if (!report.trim()) {
    console.warn("No growth report available; skipping newsletter digest.");
    return;
  }

  const week = new Date().toISOString().slice(0, 10);
  const digest = [
    `# x_bot weekly digest — ${week}`,
    "",
    report.trim(),
    variants.trim() ? `\n\n---\n\n${variants.trim()}` : "",
    "",
  ].join("\n");

  await mkdir(DIGEST_FILE.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(DIGEST_FILE, `${digest}\n`);
  await mkdir(PUBLIC_DIGEST.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(PUBLIC_DIGEST, `${digest}\n`);
  console.log(`Wrote newsletter digest to ${PUBLIC_DIGEST}.`);

  if (!RESEND_API_KEY || !NEWSLETTER_FROM || !NEWSLETTER_TO) {
    console.log("RESEND_API_KEY / NEWSLETTER_FROM / NEWSLETTER_TO not all set; skipping email send.");
    return;
  }

  const recipients = NEWSLETTER_TO.split(/[,\s]+/).map((email) => email.trim()).filter(Boolean);
  if (!recipients.length) {
    console.warn("NEWSLETTER_TO contained no valid recipients; skipping email send.");
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: NEWSLETTER_FROM,
      to: recipients,
      subject: `${NEWSLETTER_SUBJECT} ${week}`,
      text: digest,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn(`Resend rejected the email (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
    return;
  }
  console.log(`Newsletter email sent to ${recipients.length} recipient(s): ${data.id || "ok"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
