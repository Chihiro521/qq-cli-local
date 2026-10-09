"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { CliError } = require("./errors");

function parseHelperOutput(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Ignore non-JSON output from native dependencies.
    }
  }
  return null;
}

function decryptDatabase(source, output) {
  const helper = path.join(__dirname, "pcqq_decrypt.py");
  const python = process.env.QQ_CLI_PYTHON || "python";
  const result = spawnSync(
    python,
    [helper, "decrypt", "--source", source, "--output", output],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      windowsHide: true
    }
  );

  if (result.error) {
    const code = result.error.code === "ENOENT" ? "PYTHON_NOT_FOUND" : "DECRYPT_HELPER_FAILED";
    throw new CliError(code, `无法运行 PCQQ 解密 helper: ${result.error.message}`);
  }

  const payload = parseHelperOutput(result.status === 0 ? result.stdout : result.stderr || result.stdout);
  if (result.status !== 0 || !payload?.ok) {
    const code = payload?.error?.code || "DECRYPT_HELPER_FAILED";
    const message = payload?.error?.message || `PCQQ 解密 helper 退出码 ${result.status}`;
    throw new CliError(code, message);
  }
  return payload.data;
}

module.exports = { decryptDatabase, parseHelperOutput };
