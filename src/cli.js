"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadConfig, paths, saveConfig } = require("./config");
const {
  allMessages,
  history,
  inspectDatabase,
  listSessions,
  observedContacts,
  observedMembers,
  openDatabase,
  resolveConversation,
  resolveGroup,
  search,
  statistics
} = require("./database");
const { CliError } = require("./errors");
const { exportGroup, renderExport } = require("./exporter");
const { listFavorites } = require("./favorites");
const { advanceState, compareSessions, loadState, saveState } = require("./state");
const { installDatabase } = require("./storage");
const { buildTimeRange } = require("./time");

const VERSION = require("../package.json").version;

const HELP = `qq-cli ${VERSION}

个人使用的 Classic PCQQ 本地消息查询工具

Usage:
  qq-cli [--format json|text] [--config FILE] <command> [options]

Commands:
  init          导入明文或 Classic PCQQ 加密的 Msg3.0.db
  refresh       解密（如需要）并刷新本地缓存
  status        查看配置、数据库和能力状态
  sessions      列出群聊、私聊和系统会话
  history       查看会话历史
  search        搜索消息
  stats         统计会话消息
  summarize     生成供 AI 总结使用的本地素材
  contacts      列出从私聊记录观察到的联系人
  members       列出从群消息观察到的成员
  favorites     查询本地 QQ 收藏
  unread        查看检查点以来有变化的会话
  new-messages  读取检查点以来的新消息并推进检查点
  export        导出 JSONL、ChatLab、Markdown 或文本
  clean         删除本地缓存和检查点

Examples:
  qq-cli sessions --limit 10
  qq-cli history 1234567890 --days 7 --limit 20
  qq-cli search "关键词" --chat 1234567890 --start-time "2026-09-01"
  qq-cli stats 1234567890 --days 30
  qq-cli export 1234567890 --format markdown --output chat.md
`;

function extractGlobalOptions(argv) {
  const remaining = [];
  let format = "json";
  let version = false;
  let commandSeen = false;
  let command = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!commandSeen && !token.startsWith("-")) {
      commandSeen = true;
      command = token;
      remaining.push(token);
      continue;
    }
    if (token === "--config" || token.startsWith("--config=")) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[++index];
      if (!value) throw new CliError("INVALID_ARGUMENT", "--config 需要值");
      process.env.QQ_CLI_CONFIG = path.resolve(value);
      continue;
    }
    if (token === "--format" || token.startsWith("--format=")) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[index + 1];
      if (!value) throw new CliError("INVALID_ARGUMENT", "--format 需要值");
      if (command === "export" && !new Set(["json", "text"]).has(value)) {
        remaining.push(token);
        if (!token.includes("=")) {
          remaining.push(value);
          index += 1;
        }
      } else {
        format = value;
        if (!token.includes("=")) index += 1;
      }
      continue;
    }
    if (token === "--version" || token === "-V") {
      version = true;
      continue;
    }
    remaining.push(token);
  }
  if (!new Set(["json", "text"]).has(format)) {
    throw new CliError("INVALID_ARGUMENT", `不支持的输出格式: ${format}`);
  }
  return { format, version, argv: remaining };
}

function parseOptions(tokens, specification) {
  const values = {};
  const positionals = [];
  for (const [name, definition] of Object.entries(specification)) {
    if (definition.multiple) values[name] = [];
    else if (Object.hasOwn(definition, "default")) values[name] = definition.default;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token === "--help" || token === "-h") {
      values.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const option = separator >= 0 ? token.slice(0, separator) : token;
    const name = option.slice(2);
    const definition = specification[name];
    if (!definition) throw new CliError("INVALID_ARGUMENT", `未知参数: ${option}`);
    if (definition.type === "boolean") {
      if (separator >= 0) throw new CliError("INVALID_ARGUMENT", `${option} 不接受值`);
      values[name] = true;
      continue;
    }
    const value = separator >= 0 ? token.slice(separator + 1) : tokens[++index];
    if (value === undefined || value === "") {
      throw new CliError("INVALID_ARGUMENT", `${option} 需要值`);
    }
    if (definition.multiple) values[name].push(value);
    else values[name] = value;
  }
  return { values, positionals };
}

function integerOption(value, name, minimum = 1, maximum = 1000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliError("INVALID_ARGUMENT", `${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return parsed;
}

function requireOnePositional(positionals, label) {
  if (positionals.length !== 1) {
    throw new CliError("INVALID_ARGUMENT", `需要一个 ${label}`);
  }
  return positionals[0];
}

function noPositionals(positionals, command) {
  if (positionals.length) throw new CliError("INVALID_ARGUMENT", `${command} 不接受位置参数`);
}

function inferAccountUin(databasePath) {
  for (const part of path.resolve(databasePath).split(path.sep).reverse()) {
    if (/^\d{5,12}$/.test(part)) return part;
  }
  return null;
}

function inferFavorites(databasePath) {
  const candidate = path.join(path.dirname(path.resolve(databasePath)), "MyCollection", "mc3.db");
  return fs.existsSync(candidate) ? candidate : null;
}

function installedConfig(options, previous = null) {
  if (options["account-uin"] && !/^\d+$/.test(options["account-uin"])) {
    throw new CliError("INVALID_ARGUMENT", "--account-uin 必须是数字");
  }
  const source = options.db ? path.resolve(options.db) : previous?.sourceDb;
  if (!source) throw new CliError("INVALID_ARGUMENT", "init 需要 --db PATH");
  const sourceChanged = previous
    ? path.resolve(source).toLocaleLowerCase() !== path.resolve(previous.sourceDb).toLocaleLowerCase()
    : true;
  const installed = installDatabase(source, paths().database);
  const now = new Date().toISOString();
  return {
    ...(previous ?? {}),
    version: 1,
    accountUin:
      options["account-uin"] ??
      (sourceChanged ? inferAccountUin(source) : previous?.accountUin),
    sourceDb: installed.source,
    cacheDb: installed.target,
    favoritesDb: inferFavorites(source),
    sourceType: installed.sourceType,
    sourceSha256: installed.sourceSha256,
    cacheSha256: installed.cacheSha256,
    decryption: installed.decryption
      ? {
          engine: installed.decryption.engine,
          qqExe: installed.decryption.qqExe,
          kernelUtil: installed.decryption.kernelUtil,
          openDatabase: installed.decryption.openDatabase,
          keyFingerprint: installed.decryption.keyFingerprint,
          decryptedAt: now
        }
      : null,
    initializedAt: previous?.initializedAt ?? now,
    lastRefreshAt: now
  };
}

function initialize(options) {
  const config = installedConfig(options);
  saveConfig(config);
  return { config, database: inspectDatabase(config.cacheDb) };
}

function refresh(options) {
  const config = installedConfig(options, loadConfig());
  saveConfig(config);
  return { config, database: inspectDatabase(config.cacheDb) };
}

function status() {
  const config = loadConfig({ required: false });
  if (!config) return { configured: false, home: paths().home };
  const cacheExists = fs.existsSync(config.cacheDb);
  const database = cacheExists ? inspectDatabase(config.cacheDb) : null;
  return {
    configured: true,
    accountUin: config.accountUin,
    sourceDb: config.sourceDb,
    sourceType: config.sourceType ?? "plaintext",
    cacheDb: config.cacheDb,
    cacheExists,
    favoritesDb: config.favoritesDb ?? inferFavorites(config.sourceDb),
    sourceSha256: config.sourceSha256,
    cacheSha256: config.cacheSha256 ?? null,
    decryption: config.decryption ?? null,
    initializedAt: config.initializedAt,
    lastRefreshAt: config.lastRefreshAt,
    database,
    capabilities: {
      ...(database?.capabilities ?? {}),
      favorites: fs.existsSync(config.favoritesDb ?? inferFavorites(config.sourceDb) ?? "")
        ? "observed"
        : "unavailable",
      summarization: "full",
      aiExecution: "unavailable"
    }
  };
}

function withDatabase(action) {
  const config = loadConfig();
  if (!fs.existsSync(config.cacheDb)) {
    throw new CliError("CACHE_NOT_FOUND", "本地缓存不存在，请运行 qq-cli refresh");
  }
  const database = openDatabase(config.cacheDb);
  try {
    return action(database, config);
  } finally {
    database.close();
  }
}

function clean(options) {
  const appPaths = paths();
  const removed = [];
  for (const target of [appPaths.cacheDir, appPaths.state]) {
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  if (options.all && fs.existsSync(appPaths.config)) {
    fs.rmSync(appPaths.config, { force: true });
    removed.push(appPaths.config);
  }
  return { removed };
}

const RANGE_OPTIONS = {
  "start-time": { type: "string", default: null },
  "end-time": { type: "string", default: null },
  days: { type: "string", default: null }
};

function rangeFrom(values) {
  return buildTimeRange({
    startTime: values["start-time"],
    endTime: values["end-time"],
    days: values.days
  });
}

function messageFilters(values, extras = {}) {
  const offset = integerOption(values.offset ?? "0", "--offset", 0, 10000000);
  if (values.sender && !/^\d+$/.test(values.sender)) {
    throw new CliError("INVALID_ARGUMENT", "--sender 必须是数字 UIN");
  }
  return {
    range: rangeFrom(values),
    offset,
    type: values.type ?? null,
    sender: values.sender ?? null,
    media: values.media === true,
    ...extras
  };
}

function stateIdentity(config) {
  return {
    accountUin: config.accountUin,
    sourceDb: config.sourceDb,
    cacheSha256: config.cacheSha256
  };
}

function checkpointChanges(database, config, { advance }) {
  const sessions = listSessions(database);
  const identity = stateIdentity(config);
  const state = loadState(paths().state, identity);
  const firstCheck = state.checkedAt === null;
  const changed = firstCheck ? [] : compareSessions(sessions, state);
  const changedIds = new Set(changed.map((item) => item.id));
  const changedSessions = sessions.filter((session) => changedIds.has(session.id));
  const messages = [];
  if (!firstCheck) {
    for (const session of changedSessions) {
      const cursor = state.conversations[session.id];
      messages.push(
        ...allMessages(database, session, { order: "asc" }).filter(
          (message) =>
            message.time > cursor.time ||
            (message.time === cursor.time && message.rand > cursor.rand)
        )
      );
    }
  }
  messages.sort(
    (left, right) =>
      left.time - right.time || left.rand - right.rand || left.id.localeCompare(right.id)
  );
  if (advance) saveState(paths().state, advanceState(identity, sessions, state));
  return {
    authoritative: false,
    coverage: "cli-checkpoint",
    baselineEstablished: firstCheck && advance,
    checkedAt: state.checkedAt,
    warning: state.warning ?? (firstCheck ? "NO_PREVIOUS_CHECKPOINT" : null),
    sessionCount: changedSessions.length,
    messageCount: messages.length,
    sessions: changedSessions,
    messages
  };
}

function summarize(database, conversation, values) {
  const limit = integerOption(values.limit, "--limit", 1, 10000);
  const chunkSize = integerOption(values["chunk-size"], "--chunk-size", 1, 500);
  const filters = messageFilters(values, { limit, order: "asc" });
  const messages = allMessages(database, conversation, filters);
  const chunks = [];
  for (let index = 0; index < messages.length; index += chunkSize) {
    const slice = messages.slice(index, index + chunkSize);
    chunks.push({
      index: chunks.length + 1,
      messageIds: slice.map((message) => message.id),
      text: slice
        .map(
          (message) =>
            `[${message.sentAt}] ${message.senderName}(${message.senderUin}) [${message.id}]: ${message.text}`
        )
        .join("\n")
    });
  }
  return {
    conversation: {
      id: conversation.id,
      kind: conversation.kind,
      peerUin: conversation.peerUin,
      name: conversation.name
    },
    mode: "prompt-only",
    networkUsed: false,
    prompt:
      values.prompt ??
      "请基于以下 QQ 消息素材进行忠实总结。区分事实、观点与不确定信息，并用方括号中的消息 ID 引用依据。",
    range: filters.range,
    messageCount: messages.length,
    chunkSize,
    chunks,
    stats: statistics(database, conversation, filters)
  };
}

function textMessages(data) {
  return (data.messages ?? data.results ?? [])
    .map(
      (message) =>
        `[${message.sentAt}] ${message.conversationName ?? message.groupName ?? ""} ` +
        `${message.senderName}(${message.senderUin}): ${message.text}`
    )
    .join("\n");
}

function renderText(command, data) {
  if (command === "sessions") {
    return data.sessions
      .map(
        (session) =>
          `${session.lastMessageAt ?? "-"}\t${session.id}\t${session.name}\t${session.messageCount}`
      )
      .join("\n");
  }
  if (["history", "search", "new-messages"].includes(command)) return textMessages(data);
  if (command === "unread") {
    return data.sessions.map((session) => `${session.id}\t${session.name}\t${session.lastMessageAt}`).join("\n");
  }
  if (command === "contacts") {
    const contacts = Array.isArray(data.contacts) ? data.contacts : [data.contact].filter(Boolean);
    return contacts.map((contact) => `${contact.uin}\t${contact.name}\t${contact.messageCount}`).join("\n");
  }
  if (command === "members") {
    return data.members.map((member) => `${member.uin}\t${member.name}\t${member.messageCount}`).join("\n");
  }
  if (command === "favorites") {
    return data.favorites.map((item) => `${item.type}\t${item.summary}`).join("\n");
  }
  if (command === "status") {
    if (!data.configured) return `未初始化\n${data.home}`;
    return [
      `账号: ${data.accountUin ?? "未知"}`,
      `缓存: ${data.cacheDb}`,
      `群聊: ${data.database?.groupCount ?? 0}`,
      `私聊: ${data.database?.buddyCount ?? 0}`,
      `消息: ${data.database?.totalMessageCount ?? 0}`,
      `检查: ${data.database?.quickCheck ?? "缓存不存在"}`,
      `刷新: ${data.lastRefreshAt}`
    ].join("\n");
  }
  if (command === "export" && data.content) return data.content.trimEnd();
  if (command === "export") return `${data.output}\n${data.name ?? data.groupName}，${data.messageCount} 条消息`;
  if (command === "clean") return data.removed.join("\n") || "没有可删除的文件";
  if (command === "init" || command === "refresh") {
    return [
      `缓存: ${data.config.cacheDb}`,
      `群聊: ${data.database.groupCount}`,
      `私聊: ${data.database.buddyCount}`,
      `消息: ${data.database.totalMessageCount}`,
      `检查: ${data.database.quickCheck}`
    ].join("\n");
  }
  return JSON.stringify(data, null, 2);
}

function emitSuccess(command, data, format) {
  const output = format === "text" ? renderText(command, data) : JSON.stringify({ ok: true, data }, null, 2);
  process.stdout.write(`${output}\n`);
}

function emitError(error, format) {
  const code = error instanceof CliError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const output = format === "text" ? `${code}: ${message}` : JSON.stringify({ ok: false, error: { code, message } }, null, 2);
  process.stderr.write(`${output}\n`);
  return error instanceof CliError ? error.exitCode : 1;
}

function commandHelp(command) {
  const help = {
    init: "qq-cli init --db PATH [--account-uin UIN]",
    refresh: "qq-cli refresh [--db PATH] [--account-uin UIN]",
    status: "qq-cli status",
    sessions: "qq-cli sessions [--query TEXT] [--kind all|group|buddy] [--limit 20]",
    history: "qq-cli history CHAT [--limit 50] [--offset N] [--start-time TIME] [--end-time TIME] [--days N] [--type TYPE] [--media]",
    search: "qq-cli search KEYWORD [--chat CHAT ...] [--limit 20] [--offset N] [--start-time TIME] [--end-time TIME] [--days N] [--type TYPE]",
    stats: "qq-cli stats CHAT [--start-time TIME] [--end-time TIME] [--days N]",
    summarize: "qq-cli summarize CHAT [--days N] [--limit 500] [--chunk-size 80] [--prompt TEXT]",
    contacts: "qq-cli contacts [--query TEXT] [--detail CHAT] [--limit 50]",
    members: "qq-cli members GROUP [--limit 50]",
    favorites: "qq-cli favorites [--query TEXT] [--type TYPE] [--limit 20] [--db PATH]",
    unread: "qq-cli unread [--limit 20]",
    "new-messages": "qq-cli new-messages",
    export: "qq-cli export CHAT [--output FILE] [--format markdown|txt|jsonl|chatlab] [--start-time TIME] [--end-time TIME] [--days N] [--limit N] [--force]",
    clean: "qq-cli clean [--all]"
  };
  return help[command] ?? HELP;
}

function execute(command, tokens) {
  if (command === "init" || command === "refresh") {
    const parsed = parseOptions(tokens, { db: { type: "string" }, "account-uin": { type: "string" } });
    if (parsed.values.help) return { help: commandHelp(command) };
    noPositionals(parsed.positionals, command);
    return { data: command === "init" ? initialize(parsed.values) : refresh(parsed.values) };
  }
  if (command === "status") {
    const parsed = parseOptions(tokens, {});
    if (parsed.values.help) return { help: commandHelp(command) };
    noPositionals(parsed.positionals, command);
    return { data: status() };
  }
  if (command === "sessions") {
    const parsed = parseOptions(tokens, {
      query: { type: "string", default: null },
      kind: { type: "string", default: "all" },
      limit: { type: "string", default: "20" }
    });
    if (parsed.values.help) return { help: commandHelp(command) };
    noPositionals(parsed.positionals, command);
    return {
      data: withDatabase((database) => ({
        sessions: listSessions(database, {
          query: parsed.values.query,
          kind: parsed.values.kind,
          limit: integerOption(parsed.values.limit, "--limit")
        })
      }))
    };
  }
  if (command === "history") {
    const parsed = parseOptions(tokens, {
      limit: { type: "string", default: "50" },
      offset: { type: "string", default: "0" },
      before: { type: "string", default: null },
      type: { type: "string", default: null },
      sender: { type: "string", default: null },
      media: { type: "boolean", default: false },
      order: { type: "string", default: "desc" },
      ...RANGE_OPTIONS
    });
    if (parsed.values.help) return { help: commandHelp(command) };
    const selector = requireOnePositional(parsed.positionals, "CHAT");
    const limit = integerOption(parsed.values.limit, "--limit", 1, 10000);
    if (!new Set(["asc", "desc"]).has(parsed.values.order)) {
      throw new CliError("INVALID_ARGUMENT", "--order 仅支持 asc 或 desc");
    }
    return {
      data: withDatabase((database) =>
        history(database, resolveConversation(database, selector), {
          ...messageFilters(parsed.values, { limit, before: parsed.values.before }),
          order: parsed.values.order
        })
      )
    };
  }
  if (command === "search") {
    const parsed = parseOptions(tokens, {
      chat: { type: "string", multiple: true },
      limit: { type: "string", default: "20" },
      offset: { type: "string", default: "0" },
      type: { type: "string", default: null },
      kind: { type: "string", default: "all" },
      "case-sensitive": { type: "boolean", default: false },
      ...RANGE_OPTIONS
    });
    if (parsed.values.help) return { help: commandHelp(command) };
    const keyword = requireOnePositional(parsed.positionals, "KEYWORD");
    return {
      data: withDatabase((database) =>
        search(database, keyword, {
          ...messageFilters(parsed.values, {
            limit: integerOption(parsed.values.limit, "--limit", 1, 500)
          }),
          chats: parsed.values.chat,
          kind: parsed.values.kind,
          caseSensitive: parsed.values["case-sensitive"]
        })
      )
    };
  }
  if (command === "stats") {
    const parsed = parseOptions(tokens, { top: { type: "string", default: "10" }, type: { type: "string", default: null }, sender: { type: "string", default: null }, ...RANGE_OPTIONS });
    if (parsed.values.help) return { help: commandHelp(command) };
    const selector = requireOnePositional(parsed.positionals, "CHAT");
    return {
      data: withDatabase((database) =>
        statistics(database, resolveConversation(database, selector), {
          ...messageFilters(parsed.values),
          top: integerOption(parsed.values.top, "--top", 1, 1000)
        })
      )
    };
  }
  if (command === "summarize") {
    const parsed = parseOptions(tokens, {
      limit: { type: "string", default: "500" },
      offset: { type: "string", default: "0" },
      "chunk-size": { type: "string", default: "80" },
      prompt: { type: "string", default: null },
      type: { type: "string", default: null },
      sender: { type: "string", default: null },
      ...RANGE_OPTIONS
    });
    if (parsed.values.help) return { help: commandHelp(command) };
    const selector = requireOnePositional(parsed.positionals, "CHAT");
    return { data: withDatabase((database) => summarize(database, resolveConversation(database, selector), parsed.values)) };
  }
  if (command === "contacts") {
    const parsed = parseOptions(tokens, {
      query: { type: "string", default: null },
      detail: { type: "string", default: null },
      limit: { type: "string", default: "50" }
    });
    if (parsed.values.help) return { help: commandHelp(command) };
    noPositionals(parsed.positionals, command);
    return {
      data: withDatabase((database) => {
        const result = observedContacts(database, {
          query: parsed.values.query,
          detail: parsed.values.detail,
          limit: integerOption(parsed.values.limit, "--limit")
        });
        return parsed.values.detail
          ? { coverage: "observed-correspondents", authoritative: false, contact: result }
          : { coverage: "observed-correspondents", authoritative: false, contacts: result };
      })
    };
  }
  if (command === "members") {
    const parsed = parseOptions(tokens, { limit: { type: "string", default: "50" } });
    if (parsed.values.help) return { help: commandHelp(command) };
    const selector = requireOnePositional(parsed.positionals, "GROUP");
    return {
      data: withDatabase((database) =>
        observedMembers(database, resolveGroup(database, selector), {
          limit: integerOption(parsed.values.limit, "--limit")
        })
      )
    };
  }
  if (command === "favorites") {
    const parsed = parseOptions(tokens, {
      db: { type: "string", default: null },
      query: { type: "string", default: null },
      type: { type: "string", default: null },
      limit: { type: "string", default: "20" }
    });
    if (parsed.values.help) return { help: commandHelp(command) };
    noPositionals(parsed.positionals, command);
    const config = loadConfig();
    const source = parsed.values.db ?? config.favoritesDb ?? inferFavorites(config.sourceDb);
    if (!source) throw new CliError("FAVORITES_UNAVAILABLE", "未发现 MyCollection/mc3.db，可用 --db PATH 指定");
    const favorites = listFavorites(source, {
      query: parsed.values.query,
      type: parsed.values.type,
      limit: integerOption(parsed.values.limit, "--limit")
    });
    return { data: { source: path.resolve(source), coverage: "partial-safe-text-extraction", favorites } };
  }
  if (command === "unread" || command === "new-messages") {
    const parsed = parseOptions(tokens, command === "unread" ? { limit: { type: "string", default: "20" } } : {});
    if (parsed.values.help) return { help: commandHelp(command) };
    noPositionals(parsed.positionals, command);
    const data = withDatabase((database, config) => checkpointChanges(database, config, { advance: command === "new-messages" }));
    if (command === "unread") {
      const limit = integerOption(parsed.values.limit, "--limit");
      data.sessions = data.sessions.slice(0, limit);
      data.sessionCount = data.sessions.length;
    }
    return { data };
  }
  if (command === "export") {
    const parsed = parseOptions(tokens, {
      output: { type: "string", default: null },
      format: { type: "string", default: null },
      "export-format": { type: "string", default: null },
      limit: { type: "string", default: null },
      force: { type: "boolean", default: false },
      type: { type: "string", default: null },
      sender: { type: "string", default: null },
      ...RANGE_OPTIONS
    });
    if (parsed.values.help) return { help: commandHelp(command) };
    const selector = requireOnePositional(parsed.positionals, "CHAT");
    const format =
      parsed.values.format ??
      parsed.values["export-format"] ??
      (parsed.values.output ? "jsonl" : "markdown");
    const normalizedFormat = format === "txt" ? "text" : format;
    if (!new Set(["jsonl", "chatlab", "markdown", "text"]).has(normalizedFormat)) {
      throw new CliError("INVALID_ARGUMENT", "导出格式仅支持 jsonl、chatlab、markdown 或 txt");
    }
    const limit = parsed.values.limit === null
      ? null
      : integerOption(parsed.values.limit, "--limit", 1, 1000000);
    return {
      data: withDatabase((database, config) => {
        const conversation = resolveConversation(database, selector);
        const options = {
          output: parsed.values.output,
          format: normalizedFormat,
          force: parsed.values.force,
          accountUin: config.accountUin,
          limit,
          filters: messageFilters({ ...parsed.values, offset: "0" })
        };
        if (options.output) {
          const result = exportGroup(database, conversation, options);
          return { ...result, name: conversation.name };
        }
        const result = renderExport(database, conversation, options);
        return {
          conversationId: conversation.id,
          name: conversation.name,
          format: normalizedFormat,
          messageCount: result.messages.length,
          content: result.content
        };
      })
    };
  }
  if (command === "clean") {
    const parsed = parseOptions(tokens, { all: { type: "boolean", default: false } });
    if (parsed.values.help) return { help: commandHelp(command) };
    noPositionals(parsed.positionals, command);
    return { data: clean(parsed.values) };
  }
  throw new CliError("UNKNOWN_COMMAND", `未知命令: ${command}`);
}

function main() {
  let format = "json";
  try {
    const global = extractGlobalOptions(process.argv.slice(2));
    format = global.format;
    if (global.version) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (global.argv.length === 0 || global.argv[0] === "--help" || global.argv[0] === "-h") {
      process.stdout.write(HELP);
      return 0;
    }
    const [command, ...tokens] = global.argv;
    const result = execute(command, tokens);
    if (result.help) process.stdout.write(`${result.help}\n`);
    else emitSuccess(command, result.data, format);
    return 0;
  } catch (error) {
    if (error?.code === "EPIPE") return 0;
    return emitError(error, format);
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  execute,
  extractGlobalOptions,
  integerOption,
  main,
  parseOptions,
  renderText
};
