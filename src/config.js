"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CliError } = require("./errors");

function homeDir() {
  if (process.env.QQ_CLI_CONFIG) {
    return path.dirname(path.resolve(process.env.QQ_CLI_CONFIG));
  }
  if (process.env.QQ_CLI_HOME) {
    return path.resolve(process.env.QQ_CLI_HOME);
  }
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData
    ? path.join(localAppData, "qq-cli")
    : path.join(os.homedir(), ".qq-cli");
}

function paths() {
  const home = homeDir();
  return {
    home,
    config: process.env.QQ_CLI_CONFIG
      ? path.resolve(process.env.QQ_CLI_CONFIG)
      : path.join(home, "config.json"),
    state: path.join(home, "state.json"),
    cacheDir: path.join(home, "cache"),
    database: path.join(home, "cache", "Msg3.0.db")
  };
}

function loadConfig({ required = true } = {}) {
  const configPath = paths().config;
  if (!fs.existsSync(configPath)) {
    if (!required) return null;
    throw new CliError("NOT_INITIALIZED", "请先运行 qq-cli init --db PATH");
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config.cacheDb || typeof config.cacheDb !== "string") {
      throw new Error("cacheDb is missing");
    }
    return config;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("CONFIG_INVALID", `配置文件无效: ${error.message}`);
  }
}

function saveConfig(config) {
  const appPaths = paths();
  fs.mkdirSync(appPaths.home, { recursive: true });
  const temporary = `${appPaths.config}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, appPaths.config);
}

module.exports = { homeDir, loadConfig, paths, saveConfig };
