#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cliPath = path.resolve(__dirname, "..", "src", "cli.js");
const result = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", cliPath, ...process.argv.slice(2)],
  { stdio: "inherit", windowsHide: true }
);

if (result.error) {
  console.error(`qq-cli: ${result.error.message}`);
  process.exit(1);
}

if (result.signal === "SIGINT") {
  process.exit(130);
}

process.exit(result.status ?? 1);
