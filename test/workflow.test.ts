import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const refreshWorkflow = readFileSync(".github/workflows/refresh-cookie.yml", "utf8");

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
