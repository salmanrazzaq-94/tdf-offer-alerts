import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const refreshWorkflow = readFileSync(".github/workflows/refresh-cookie.yml", "utf8");
const preCheckWorkflow = readFileSync(".github/workflows/pre-check.yml", "utf8");
const deployWorkflow = readFileSync(".github/workflows/deploy-worker.yml", "utf8");
const workerSmokeWorkflow = readFileSync(".github/workflows/worker-smoke.yml", "utf8");
const e2eWranglerConfig = readFileSync("wrangler.e2e.toml", "utf8");
const workerE2eScript = readFileSync("scripts/worker-e2e.mjs", "utf8");
const smokeWorkerScript = readFileSync("scripts/smoke-worker.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const deployGuard = readFileSync("scripts/ensure-production-deploy-from-main.mjs", "utf8");
const workflows = [refreshWorkflow, preCheckWorkflow, deployWorkflow, workerSmokeWorkflow];

test("workflows use Node 24-compatible GitHub actions", () => {
  for (const workflow of workflows) {
    assert.doesNotMatch(workflow, /actions\/checkout@v4/);
    assert.doesNotMatch(workflow, /actions\/setup-node@v4/);
    assert.doesNotMatch(workflow, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/);
  }

  assert.match(preCheckWorkflow, /actions\/checkout@v6/);
  assert.match(preCheckWorkflow, /actions\/setup-node@v6/);
});

test("refresh-cookie workflow remains manually dispatchable", () => {
  assert.match(refreshWorkflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(refreshWorkflow, /\/refresh-failed\?token=\$\{COOKIE_FORM_TOKEN\}/);
});

test("refresh-cookie workflow does not use unquoted env values with colon separators", () => {
  const unsafeEnvLine = refreshWorkflow
    .split("\n")
    .find((line) => /^\s+[A-Z][A-Z0-9_]*:\s+[^"'\s][^#\n]*:\s+/.test(line));

  assert.equal(unsafeEnvLine, undefined);
});

test("pre-check workflow validates pull requests without deploying production", () => {
  assert.match(preCheckWorkflow, /^\s*pull_request:\s*$/m);
  assert.match(preCheckWorkflow, /^\s*push:\s*$/m);
  assert.match(preCheckWorkflow, /^\s+- main\s*$/m);
  assert.match(preCheckWorkflow, /npm run quality/);
  assert.match(preCheckWorkflow, /^\s*e2e:\s*$/m);
  assert.match(preCheckWorkflow, /npm run worker:e2e-deploy/);
  assert.match(preCheckWorkflow, /npm run login:browserbase/);
  assert.match(preCheckWorkflow, /npm run worker:e2e/);
  assert.match(preCheckWorkflow, /E2E_TELEGRAM_CHAT_ID/);
  assert.match(preCheckWorkflow, /E2E_WORKER_BASE_URL/);
  assert.match(preCheckWorkflow, /E2E_COOKIE_FORM_TOKEN/);
  assert.doesNotMatch(preCheckWorkflow, /wrangler deploy\s*$/m);
});

test("worker deploy workflow only deploys production from main", () => {
  assert.match(deployWorkflow, /^\s*push:\s*$/m);
  assert.match(deployWorkflow, /^\s+- main\s*$/m);
  assert.match(deployWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(deployWorkflow, /npm run quality/);
  assert.match(deployWorkflow, /npm run worker:deploy/);
  assert.match(deployWorkflow, /npm run smoke:worker/);
  assert.match(deployWorkflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.doesNotMatch(deployWorkflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(deployWorkflow, /^\s*workflow_dispatch:\s*$/m);
});

test("production smoke stays quiet and limited", () => {
  assert.match(workerSmokeWorkflow, /npm run smoke:worker/);
  assert.match(smokeWorkerScript, /\/health/);
  assert.match(smokeWorkerScript, /\/debug/);
  assert.match(smokeWorkerScript, /\/verify-cookie/);
  assert.doesNotMatch(smokeWorkerScript, /\/run-delta/);
  assert.doesNotMatch(smokeWorkerScript, /\/run-daily/);
  assert.doesNotMatch(smokeWorkerScript, /\/telegram/);
  assert.doesNotMatch(smokeWorkerScript, /\/refresh-failed/);
});

test("production deploy script is guarded to GitHub Actions push on origin main", () => {
  assert.equal(packageJson.scripts["worker:dry-run"], "wrangler deploy --dry-run");
  assert.equal(packageJson.scripts["worker:e2e-deploy"], "wrangler deploy --config wrangler.e2e.toml");
  assert.equal(packageJson.scripts["worker:e2e"], "node scripts/worker-e2e.mjs");

  const workerDeploy = packageJson.scripts["worker:deploy"];
  assert.ok(workerDeploy);
  assert.match(workerDeploy, /ensure-production-deploy-from-main\.mjs/);
  assert.match(workerDeploy, /wrangler deploy/);
  assert.match(deployGuard, /GITHUB_ACTIONS/);
  assert.match(deployGuard, /GITHUB_EVENT_NAME/);
  assert.match(deployGuard, /GITHUB_REF/);
  assert.match(deployGuard, /const productionBranch = "main"/);
  assert.match(deployGuard, /const productionRemote = "origin"/);
  assert.match(deployGuard, /runGit\(\["fetch", "--quiet", productionRemote, `\$\{productionBranch\}:refs\/remotes\/\$\{productionRef\}`\]\)/);
  assert.match(deployGuard, /status", "--porcelain"/);
  assert.match(deployGuard, /rev-parse", "HEAD"/);
  assert.match(deployGuard, /rev-parse", productionRef/);
});

test("e2e worker uses isolated Cloudflare resources", () => {
  assert.match(e2eWranglerConfig, /^name = "tdf-alerts-bot-e2e"$/m);
  assert.match(e2eWranglerConfig, /binding = "TDF_ALERTS"/);
  assert.match(e2eWranglerConfig, /id = "663fc62f616f4b22a232d75be8607ad5"/);
  assert.doesNotMatch(e2eWranglerConfig, /\[triggers\]/);
  assert.doesNotMatch(e2eWranglerConfig, /565f5f3899a547439f1ce155e9947971/);
});

test("e2e script verifies worker endpoints and telegram delivery paths", () => {
  assert.match(workerE2eScript, /E2E_WORKER_BASE_URL/);
  assert.match(workerE2eScript, /E2E_COOKIE_FORM_TOKEN/);
  assert.match(workerE2eScript, /E2E_TELEGRAM_CHAT_ID/);
  assert.match(workerE2eScript, /\/health/);
  assert.match(workerE2eScript, /\/cookie/);
  assert.match(workerE2eScript, /\/verify-cookie/);
  assert.match(workerE2eScript, /\/run-delta/);
  assert.match(workerE2eScript, /\/run-daily/);
  assert.match(workerE2eScript, /\/debug/);
  assert.match(workerE2eScript, /\/logs/);
  assert.match(workerE2eScript, /\/telegram/);
  assert.match(workerE2eScript, /\/refresh-failed/);
  assert.match(workerE2eScript, /notify: "false"/);
  assert.match(workerE2eScript, /telegram:\/status/);
  assert.match(workerE2eScript, /telegram:\/debug/);
  assert.match(workerE2eScript, /telegram:\/logs/);
  assert.match(workerE2eScript, /telegram:\/offers/);
});
