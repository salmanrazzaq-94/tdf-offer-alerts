import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const refreshWorkflow = readFileSync(".github/workflows/refresh-cookie.yml", "utf8");
const preCheckWorkflow = readFileSync(".github/workflows/pre-check.yml", "utf8");
const deployWorkflow = readFileSync(".github/workflows/deploy-worker.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const deployGuard = readFileSync("scripts/ensure-production-deploy-from-main.mjs", "utf8");

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
  assert.match(preCheckWorkflow, /npm run check/);
  assert.match(preCheckWorkflow, /npm test/);
  assert.match(preCheckWorkflow, /npm run worker:dry-run/);
  assert.doesNotMatch(preCheckWorkflow, /wrangler deploy\s*$/m);
});

test("worker deploy workflow only deploys production from main", () => {
  assert.match(deployWorkflow, /^\s*push:\s*$/m);
  assert.match(deployWorkflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(deployWorkflow, /^\s+- main\s*$/m);
  assert.match(deployWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(deployWorkflow, /npm run check/);
  assert.match(deployWorkflow, /npm test/);
  assert.match(deployWorkflow, /npm run worker:dry-run/);
  assert.match(deployWorkflow, /npm run worker:deploy/);
  assert.match(deployWorkflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.doesNotMatch(deployWorkflow, /^\s*pull_request:\s*$/m);
});

test("production deploy script is guarded to origin main", () => {
  assert.equal(packageJson.scripts["worker:dry-run"], "wrangler deploy --dry-run");
  assert.match(packageJson.scripts["worker:deploy"], /ensure-production-deploy-from-main\.mjs/);
  assert.match(packageJson.scripts["worker:deploy"], /wrangler deploy/);
  assert.match(deployGuard, /const productionBranch = "main"/);
  assert.match(deployGuard, /const productionRemote = "origin"/);
  assert.match(deployGuard, /runGit\(\["fetch", "--quiet", productionRemote, `\$\{productionBranch\}:refs\/remotes\/\$\{productionRef\}`\]\)/);
  assert.match(deployGuard, /status", "--porcelain"/);
  assert.match(deployGuard, /rev-parse", "HEAD"/);
  assert.match(deployGuard, /rev-parse", productionRef/);
});
