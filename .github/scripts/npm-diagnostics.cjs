"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const PACKAGE = "scientific-figure-library";
const REGISTRY = "https://registry.npmjs.org";
const ERROR_CODES = new Set(["E401", "E403", "E404", "ENEEDAUTH", "EOTP", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]);

function json(text) {
  try { return JSON.parse(String(text)); } catch { return undefined; }
}

function username(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value) ? value : undefined;
}

function failure(result) {
  const parsed = json(result.stdout);
  const rawCode = parsed?.error?.code ?? String(result.stderr).match(/npm (?:error|ERR!) code (\w+)/u)?.[1];
  const code = ERROR_CODES.has(rawCode) ? rawCode : "UNKNOWN";
  // Never persist raw npm output, configuration, tokens or debug logs.
  return {
    status: ["E401", "E403", "ENEEDAUTH", "EOTP"].includes(code) ? "authentication_rejected" : "request_failed",
    errorCode: code,
    mentionsTokenExpiryOrRevocation: /expired|revoked/iu.test(String(result.stderr) + String(parsed?.error?.summary ?? "")),
    mentionsInvalidToken: /invalid.{0,30}token|token.{0,30}invalid/iu.test(String(result.stderr) + String(parsed?.error?.summary ?? "")),
  };
}

function redact(value, secret) {
  if (typeof value === "string") return secret ? value.split(secret).join("[REDACTED]") : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  return value;
}

async function diagnose({ run, tokenPresent, secret = "" }) {
  const versionResult = await run(["--version"], false);
  const npmVersion = /^\d+\.\d+\.\d+$/u.test(versionResult.stdout?.trim()) ? versionResult.stdout.trim() : "unknown";
  const report = {
    schema: "figure-library.npm-auth-diagnostic.v1", registry: REGISTRY, package: PACKAGE,
    nodeVersion: process.version, npmVersion, tokenPresent,
    readOnly: true, publishAttempted: false,
  };
  const metadata = await run(["view", PACKAGE, "name", "maintainers", "dist-tags", "--json"], false);
  const publicData = json(metadata.stdout);
  const maintainers = metadata.exitCode === 0 && publicData?.name === PACKAGE
    ? (Array.isArray(publicData.maintainers) ? publicData.maintainers : []).flatMap(value => {
      const name = username(typeof value === "string" ? value.split(" ")[0] : value?.name);
      return name ? [name] : [];
    }) : [];
  report.publicPackage = metadata.exitCode === 0 && publicData?.name === PACKAGE
    ? { status: "found", latest: publicData["dist-tags"]?.latest ?? null, maintainers }
    : failure(metadata);
  if (!tokenPresent) {
    report.authentication = { status: "token_missing" };
    return redact(report, secret);
  }
  const identity = await run(["whoami", "--json"], true);
  const name = username(json(identity.stdout));
  if (identity.exitCode !== 0 || !name) {
    report.authentication = failure(identity);
    return redact(report, secret);
  }
  report.authentication = { status: "authenticated", username: name, listedMaintainer: maintainers.includes(name) };
  const access = await run(["access", "list", "packages", name, "--json"], true);
  const permission = json(access.stdout)?.[PACKAGE];
  report.packageAccess = access.exitCode === 0
    ? { status: "queried", permission: ["read-write", "read-only"].includes(permission) ? permission : "not_listed" }
    : failure(access);
  report.publicationAuthorization = "not_proven_by_read_only_checks; token scope, expiry, IP and package 2FA policies may further restrict publishing";
  return redact(report, secret);
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux") throw new Error("Run only through the authorized GitHub-hosted diagnostic workflow");
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, "sfl-npm-readonly-"));
  const publicConfig = path.join(root, "public.npmrc");
  await fs.writeFile(publicConfig, `registry=${REGISTRY}\n`);
  const secret = process.env.NODE_AUTH_TOKEN ?? "";
  const execute = promisify(execFile);
  const run = async (args, authenticated) => {
    const env = { ...process.env, npm_config_cache: path.join(root, "cache") };
    if (!authenticated) {
      env.NODE_AUTH_TOKEN = "";
      env.NPM_CONFIG_USERCONFIG = publicConfig;
      env.npm_config_userconfig = publicConfig;
      delete env.NPM_TOKEN;
    }
    try {
      const result = await execute("npm", [...args, `--registry=${REGISTRY}`, "--ignore-scripts", "--loglevel=error", "--fetch-retries=0", "--fetch-timeout=15000"], {
        cwd: root, env, encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { exitCode: 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const report = await diagnose({ run, tokenPresent: Boolean(secret), secret });
  report.sourceCommit = process.env.GITHUB_SHA;
  const file = process.env.NPM_DIAGNOSTICS_REPORT;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const safe = JSON.stringify(report, null, 2);
  await fs.writeFile(file, `${safe}\n`);
  console.log(safe);
  if (report.authentication.status !== "authenticated") process.exitCode = 1;
}

module.exports = { diagnose, failure, redact };
if (require.main === module) main().catch(() => {
  console.error("npm diagnostic could not complete; no raw command output or credentials were logged");
  process.exitCode = 1;
});
