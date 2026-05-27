#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const productionBranch = "main";
const productionRemote = "origin";
const productionRef = `${productionRemote}/${productionBranch}`;

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fail(message) {
  console.error(`Production deploy blocked: ${message}`);
  console.error(`Deploy production only from a clean checkout at ${productionRef}.`);
  process.exit(1);
}

const branch = process.env.GITHUB_REF_NAME || runGit(["branch", "--show-current"]);
if (branch !== productionBranch) {
  fail(`current branch is ${branch || "detached HEAD"}, not ${productionBranch}`);
}

try {
  runGit(["fetch", "--quiet", productionRemote, `${productionBranch}:refs/remotes/${productionRef}`]);
} catch {
  fail(`could not fetch ${productionRef}`);
}

const status = runGit(["status", "--porcelain"]);
if (status.length > 0) {
  fail("working tree has uncommitted changes");
}

const head = runGit(["rev-parse", "HEAD"]);
const remoteHead = runGit(["rev-parse", productionRef]);
if (head !== remoteHead) {
  fail(`local HEAD ${head.slice(0, 12)} does not match ${productionRef} ${remoteHead.slice(0, 12)}`);
}

console.log(`Production deploy allowed from ${productionRef} at ${head.slice(0, 12)}.`);
