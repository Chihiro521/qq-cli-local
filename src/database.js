"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { decodeMessage, extractReceiverNames } = require("./decode");
const { CliError } = require("./errors");

const TABLE_PATTERNS = [
  { kind: "group", pattern: /^group_(\d+)$/ },
  { kind: "buddy", pattern: /^buddy_(\d+)$/ },
  { kind: "system", pattern: /^system_(\d+)$/ }
];
const REQUIRED_COLUMNS = ["Time", "Rand", "SenderUin", "MsgContent", "Info"];
const U32_MAX = 4294967295;
const U32_MASK = 4294967295;
const MESSAGE_TYPES = new Set([
  "text",
  "image",
  "voice",
  "video",
  "face",
  "sticker",
  "location",
  "link",
  "file",
  "call",
  "system",
  "mixed",
  "unknown"
]);

function toU32(value) {
  if (value === null || value === undefined) return null;
  return Number(BigInt.asUintN(32, BigInt(value)));
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function openDatabase(databasePath) {
  const resolved = path.resolve(databasePath);
  if (!fs.existsSync(resolved)) {
    throw new CliError("DATABASE_NOT_FOUND", `数据库不存在: ${resolved}`);
  }
  try {
    const database = new DatabaseSync(resolved, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    return database;
  } catch (error) {
    throw new CliError("DATABASE_OPEN_FAILED", `无法打开数据库: ${error.message}`);
  }
}

function pragmaValue(database, name) {
  const row = database.prepare(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : null;
}

function descriptorFromTable(table) {
  for (const definition of TABLE_PATTERNS) {
    const match = definition.pattern.exec(table);
    if (match) {
      return {
        id: `${definition.kind}:${match[1]}`,
        kind: definition.kind,
        peerUin: match[1],
        table
      };
    }
  }
  return null;
}

function listConversationTables(database, { kind = "all" } = {}) {
  if (!new Set(["all", "group", "buddy", "system"]).has(kind)) {
    throw new CliError("INVALID_ARGUMENT", `不支持的会话类型: ${kind}`);
  }
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => descriptorFromTable(row.name))
    .filter((item) => item && (kind === "all" || item.kind === kind));
}

function listGroupTables(database) {
  return listConversationTables(database, { kind: "group" }).map((item) => ({
    table: item.table,
    groupUin: item.peerUin
  }));
}

function tableColumns(database, table) {
  return database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => row.name);
}

function validateDatabase(databasePath, { full = true } = {}) {
  const database = openDatabase(databasePath);
  try {
    const quickCheck = pragmaValue(database, "quick_check");
    if (quickCheck !== "ok") {
      throw new CliError("DATABASE_INVALID", `quick_check: ${quickCheck}`);
    }
    const integrityCheck = full ? pragmaValue(database, "integrity_check") : null;
    if (full && integrityCheck !== "ok") {
      throw new CliError("DATABASE_INVALID", `integrity_check: ${integrityCheck}`);
    }
    const conversations = listConversationTables(database);
    if (!conversations.some((item) => item.kind === "group")) {
      throw new CliError("DATABASE_INVALID", "数据库中没有 group_<群号> 消息表");
    }
    for (const conversation of conversations) {
      const columns = tableColumns(database, conversation.table);
      for (const required of REQUIRED_COLUMNS) {
        if (!columns.includes(required)) {
          throw new CliError(
            "DATABASE_INVALID",
            `${conversation.table} 缺少字段: ${required}`
          );
        }
      }
    }
    return {
      quickCheck,
      integrityCheck,
      groupCount: conversations.filter((item) => item.kind === "group").length,
      buddyCount: conversations.filter((item) => item.kind === "buddy").length,
      systemCount: conversations.filter((item) => item.kind === "system").length
    };
  } finally {
    database.close();
  }
}

function fallbackName(conversation) {
  if (conversation.kind === "group") return `QQ群 ${conversation.peerUin}`;
  if (conversation.kind === "buddy") return `QQ好友 ${conversation.peerUin}`;
  return `QQ系统消息 ${conversation.peerUin}`;
}

function findConversationName(database, conversation) {
  if (conversation.kind === "system") return fallbackName(conversation);
  const statement = database.prepare(
    `SELECT Info FROM ${quoteIdentifier(conversation.table)} ` +
      "WHERE Info IS NOT NULL " +
      `ORDER BY (Time & ${U32_MASK}) DESC, (Rand & ${U32_MASK}) DESC`
  );
  for (const row of statement.iterate()) {
    const names = extractReceiverNames(row.Info);
    for (let index = names.length - 1; index >= 0; index -= 1) {
      const name = names[index].trim();
      if (name && name !== conversation.peerUin && !/^\d+$/.test(name)) return name;
    }
  }
  return fallbackName(conversation);
}

function conversationFields(conversation) {
  return {
    id: conversation.id,
    kind: conversation.kind,
    isGroup: conversation.kind === "group",
    peerUin: conversation.peerUin,
    groupUin: conversation.kind === "group" ? conversation.peerUin : null,
    buddyUin: conversation.kind === "buddy" ? conversation.peerUin : null,
    name: conversation.name
  };
}

function messageId(conversation, time, rand) {
  return conversation.kind === "group"
    ? `${conversation.peerUin}:${time}:${rand}`
    : `${conversation.kind}:${conversation.peerUin}:${time}:${rand}`;
}

function messageFromRow(conversation, row, { media = false } = {}) {
  const time = toU32(row.Time);
  const rand = toU32(row.Rand);
  const senderUin = toU32(row.SenderUin);
  const decoded = decodeMessage(row.MsgContent);
  const warnings = [...decoded.decodeWarnings];
  if (decoded.headerTime !== null && decoded.headerTime !== time) {
    warnings.push(`消息头 Time=${decoded.headerTime} 与数据库 Time=${time} 不一致`);
  }
  if (decoded.headerRand !== null && decoded.headerRand !== rand) {
    warnings.push(`消息头 Rand=${decoded.headerRand} 与数据库 Rand=${rand} 不一致`);
  }

  const elements = decoded.elements.map((element) => {
    if (!media || !element.path) return element;
    const resolved = path.resolve(element.path);
    return { ...element, resolvedPath: resolved, exists: fs.existsSync(resolved) };
  });
  const type = conversation.kind === "system" && decoded.type === "unknown"
    ? "system"
    : decoded.type;
  return {
    id: messageId(conversation, time, rand),
    conversationId: conversation.id,
    conversationKind: conversation.kind,
    peerUin: conversation.peerUin,
    conversationName: conversation.name,
    groupUin: conversation.kind === "group" ? conversation.peerUin : null,
    groupName: conversation.kind === "group" ? conversation.name : null,
    buddyUin: conversation.kind === "buddy" ? conversation.peerUin : null,
    time,
    rand,
    sentAt: new Date(time * 1000).toISOString(),
    senderUin: String(senderUin),
    senderName: decoded.senderName ?? String(senderUin),
    type,
    text: decoded.text,
    elements,
    unknownTags: decoded.unknownTags,
    decodeWarnings: warnings
  };
}

function latestRow(database, conversation) {
  return database
    .prepare(
      `SELECT Time, Rand, SenderUin, MsgContent FROM ${quoteIdentifier(conversation.table)} ` +
        `ORDER BY (Time & ${U32_MASK}) DESC, (Rand & ${U32_MASK}) DESC LIMIT 1`
    )
    .get();
}

function listSessions(database, { query = null, limit = null, kind = "all" } = {}) {
  const sessions = [];
  for (const descriptor of listConversationTables(database, { kind })) {
    const conversation = { ...descriptor, name: findConversationName(database, descriptor) };
    const count = Number(
      database
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(conversation.table)}`)
        .get().n
    );
    const row = latestRow(database, conversation);
    const latest = row ? messageFromRow(conversation, row) : null;
    sessions.push({
      ...conversationFields(conversation),
      table: conversation.table,
      messageCount: count,
      lastMessageTime: latest?.time ?? null,
      lastMessageRand: latest?.rand ?? null,
      lastMessageId: latest?.id ?? null,
      lastMessageAt: latest?.sentAt ?? null,
      lastMessage: latest?.text ?? null,
      messageType: latest?.type ?? null,
      senderUin: latest?.senderUin ?? null,
      senderName: latest?.senderName ?? null,
      latest: latest
        ? { time: latest.time, rand: latest.rand, messageId: latest.id }
        : null
    });
  }

  sessions.sort(
    (left, right) =>
      (right.lastMessageTime ?? -1) - (left.lastMessageTime ?? -1) ||
      (right.lastMessageRand ?? -1) - (left.lastMessageRand ?? -1) ||
      left.id.localeCompare(right.id)
  );
  const filtered = query
    ? sessions.filter((session) => {
        const needle = query.toLocaleLowerCase();
        return (
          session.peerUin.includes(query) ||
          session.name.toLocaleLowerCase().includes(needle)
        );
      })
    : sessions;
  return limit === null ? filtered : filtered.slice(0, limit);
}

function resolveConversation(database, selector, sessions = null) {
  const available = sessions ?? listSessions(database);
  const prefixed = /^(group|buddy|system):(.+)$/.exec(selector);
  if (prefixed) {
    const match = available.find(
      (item) => item.kind === prefixed[1] && item.peerUin === prefixed[2]
    );
    if (match) return match;
  }
  if (/^\d+$/.test(selector)) {
    const group = available.find(
      (item) => item.kind === "group" && item.peerUin === selector
    );
    if (group) return group;
    const matches = available.filter((item) => item.peerUin === selector);
    if (matches.length === 1) return matches[0];
  }

  const needle = selector.toLocaleLowerCase();
  const exact = available.filter((item) => item.name.toLocaleLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new CliError("AMBIGUOUS_CHAT", `多个会话使用名称: ${selector}`);
  }
  const partial = available.filter((item) =>
    item.name.toLocaleLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new CliError(
      "AMBIGUOUS_CHAT",
      `名称匹配到多个会话: ${partial.map((item) => item.name).join("、")}`
    );
  }
  throw new CliError("CHAT_NOT_FOUND", `找不到会话: ${selector}`);
}

function resolveGroup(database, selector, sessions = null) {
  const groups = (sessions ?? listSessions(database)).filter((item) => item.kind === "group");
  const resolved = resolveConversation(database, selector, groups);
  if (resolved.kind !== "group") {
    throw new CliError("INVALID_GROUP", `不是群聊: ${selector}`);
  }
  return resolved;
}

function parseCursor(cursor) {
  if (!cursor) return null;
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (!match) {
    throw new CliError("INVALID_CURSOR", "--before 格式应为 TIME:RAND");
  }
  const time = Number(match[1]);
  const rand = Number(match[2]);
  if (
    !Number.isSafeInteger(time) ||
    !Number.isSafeInteger(rand) ||
    time < 0 ||
    rand < 0 ||
    time > U32_MAX ||
    rand > U32_MAX
  ) {
    throw new CliError("INVALID_CURSOR", "--before 的 TIME 和 RAND 必须是 uint32");
  }
  return { time, rand };
}

function normalizeTypes(types) {
  if (types === null || types === undefined) return [];
  const values = Array.isArray(types) ? types : [types];
  return values.map((type) => {
    const normalized = String(type).toLocaleLowerCase();
    if (!MESSAGE_TYPES.has(normalized)) {
      throw new CliError("INVALID_ARGUMENT", `不支持的消息类型: ${type}`);
    }
    return normalized;
  });
}

function messageMatchesTypes(message, types) {
  if (types.length === 0) return true;
  const elementTypes = new Set(message.elements.map((element) => element.type));
  return types.some((type) => {
    if (type === "sticker") return message.type === "face" || elementTypes.has("face");
    if (type === "face") return message.type === "face" || elementTypes.has("face");
    return message.type === type || elementTypes.has(type);
  });
}

function buildMessageQuery(
  conversation,
  { before = null, range = null, sender = null, order = "desc" } = {}
) {
  const direction = order === "asc" ? "ASC" : "DESC";
  const clauses = [];
  const params = [];
  if (before) {
    clauses.push(
      `((Time & ${U32_MASK}) < ? OR ((Time & ${U32_MASK}) = ? AND (Rand & ${U32_MASK}) < ?))`
    );
    params.push(before.time, before.time, before.rand);
  }
  if (range?.startEpochSeconds !== null && range?.startEpochSeconds !== undefined) {
    clauses.push(`(Time & ${U32_MASK}) >= ?`);
    params.push(range.startEpochSeconds);
  }
  if (range?.endEpochSeconds !== null && range?.endEpochSeconds !== undefined) {
    clauses.push(`(Time & ${U32_MASK}) <= ?`);
    params.push(range.endEpochSeconds);
  }
  if (sender !== null && sender !== undefined) {
    clauses.push(`(SenderUin & ${U32_MASK}) = ?`);
    params.push(Number(sender));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return {
    sql:
      `SELECT Time, Rand, SenderUin, MsgContent FROM ${quoteIdentifier(conversation.table)} ${where} ` +
      `ORDER BY (Time & ${U32_MASK}) ${direction}, (Rand & ${U32_MASK}) ${direction}`,
    params
  };
}

function collectMessages(database, conversation, options = {}) {
  const before = parseCursor(options.before);
  const types = normalizeTypes(options.types ?? options.type);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? null;
  const order = options.order === "asc" ? "asc" : "desc";
  const keyword = options.keyword ?? null;
  const caseSensitive = options.caseSensitive === true;
  const needle = keyword === null
    ? null
    : caseSensitive
      ? String(keyword)
      : String(keyword).toLocaleLowerCase();
  const query = buildMessageQuery(conversation, {
    before,
    range: options.range,
    sender: options.sender,
    order
  });
  const messages = [];
  let scanned = 0;
  let matched = 0;
  let skipped = 0;
  let hasMore = false;
  for (const row of database.prepare(query.sql).iterate(...query.params)) {
    scanned += 1;
    const message = messageFromRow(conversation, row, { media: options.media });
    if (!messageMatchesTypes(message, types)) continue;
    if (needle !== null) {
      const haystack = caseSensitive ? message.text : message.text.toLocaleLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    matched += 1;
    if (skipped < offset) {
      skipped += 1;
      continue;
    }
    if (limit !== null && messages.length >= limit) {
      hasMore = true;
      if (!options.countAll) break;
      continue;
    }
    messages.push(message);
  }
  return { messages, scanned, matched, skipped, hasMore };
}

function history(database, conversation, options = {}) {
  if (options.before && (options.offset ?? 0) > 0) {
    throw new CliError("INVALID_ARGUMENT", "--before 不能与非零 --offset 同时使用");
  }
  if (options.before && options.order === "asc") {
    throw new CliError("INVALID_ARGUMENT", "--before 仅支持倒序查询");
  }
  const limit = options.limit ?? 50;
  const result = collectMessages(database, conversation, { ...options, limit });
  const last = result.messages.at(-1);
  return {
    conversation: conversationFields(conversation),
    group: conversation.kind === "group" ? conversation : null,
    messages: result.messages,
    range: options.range ?? null,
    pagination: {
      limit,
      offset: options.offset ?? 0,
      hasMore: result.hasMore,
      nextOffset: result.hasMore ? (options.offset ?? 0) + result.messages.length : null,
      nextBefore:
        result.hasMore && last && (options.order ?? "desc") === "desc"
          ? `${last.time}:${last.rand}`
          : null
    },
    nextBefore:
      result.hasMore && last && (options.order ?? "desc") === "desc"
        ? `${last.time}:${last.rand}`
        : null,
    scanned: result.scanned
  };
}

function allMessages(database, conversation, options = {}) {
  return collectMessages(database, conversation, { ...options, limit: options.limit ?? null }).messages;
}

function search(database, keyword, options = {}) {
  const sessions = listSessions(database, { kind: options.kind ?? "all" });
  const selectors = options.chats ?? (options.chat ? [options.chat] : []);
  const selected = selectors.length
    ? selectors.map((selector) => resolveConversation(database, selector, sessions))
    : sessions;
  const unique = [...new Map(selected.map((item) => [item.id, item])).values()];
  const matches = [];
  let scanned = 0;
  for (const conversation of unique) {
    const result = collectMessages(database, conversation, {
      ...options,
      keyword,
      offset: 0,
      limit: null,
      countAll: true,
      order: "desc"
    });
    scanned += result.scanned;
    matches.push(...result.messages);
  }
  matches.sort(
    (left, right) =>
      right.time - left.time ||
      right.rand - left.rand ||
      left.conversationId.localeCompare(right.conversationId)
  );
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const messages = matches.slice(offset, offset + limit);
  return {
    messages,
    results: messages,
    scanned,
    totalMatches: matches.length,
    range: options.range ?? null,
    pagination: {
      limit,
      offset,
      hasMore: offset + messages.length < matches.length,
      nextOffset: offset + messages.length < matches.length ? offset + messages.length : null
    }
  };
}

function statistics(database, conversation, options = {}) {
  const messages = allMessages(database, conversation, { ...options, order: "asc" });
  const typeBreakdown = {};
  const senders = new Map();
  const hourly = Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [String(hour), 0]));
  let decodeFailures = 0;
  for (const message of messages) {
    typeBreakdown[message.type] = (typeBreakdown[message.type] ?? 0) + 1;
    const sender = senders.get(message.senderUin) ?? {
      senderUin: message.senderUin,
      name: message.senderName,
      count: 0
    };
    sender.name = message.senderName || sender.name;
    sender.count += 1;
    senders.set(message.senderUin, sender);
    hourly[String(new Date(message.time * 1000).getHours())] += 1;
    if (message.decodeWarnings.length) decodeFailures += 1;
  }
  const top = options.top ?? 10;
  return {
    conversation: conversationFields(conversation),
    range: options.range ?? null,
    total: messages.length,
    typeBreakdown: Object.fromEntries(
      Object.entries(typeBreakdown).sort((left, right) => right[1] - left[1])
    ),
    topSenders: [...senders.values()]
      .sort((left, right) => right.count - left.count || left.senderUin.localeCompare(right.senderUin))
      .slice(0, top),
    hourly,
    decodeFailures
  };
}

function observedMembers(database, group, { limit = 50 } = {}) {
  if (group.kind !== "group") throw new CliError("INVALID_GROUP", "members 仅支持群聊");
  const messages = allMessages(database, group, { order: "asc" });
  const members = new Map();
  for (const message of messages) {
    const member = members.get(message.senderUin) ?? {
      uin: message.senderUin,
      name: message.senderName,
      messageCount: 0,
      firstMessageAt: message.sentAt,
      lastMessageAt: message.sentAt
    };
    member.name = message.senderName || member.name;
    member.messageCount += 1;
    member.lastMessageAt = message.sentAt;
    members.set(message.senderUin, member);
  }
  return {
    group: conversationFields(group),
    memberCount: members.size,
    coverage: "observed-senders",
    authoritative: false,
    members: [...members.values()]
      .sort((left, right) => right.messageCount - left.messageCount || left.uin.localeCompare(right.uin))
      .slice(0, limit)
  };
}

function observedContacts(database, { query = null, detail = null, limit = 50 } = {}) {
  const contacts = listSessions(database, { kind: "buddy" }).map((session) => ({
    uin: session.peerUin,
    name: session.name,
    messageCount: session.messageCount,
    lastMessageAt: session.lastMessageAt,
    coverage: "observed-correspondent",
    authoritative: false
  }));
  if (detail) {
    const session = resolveConversation(database, detail, listSessions(database, { kind: "buddy" }));
    return contacts.find((contact) => contact.uin === session.peerUin) ?? null;
  }
  const filtered = query
    ? contacts.filter(
        (contact) =>
          contact.uin.includes(query) ||
          contact.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      )
    : contacts;
  return filtered.slice(0, limit);
}

function inspectDatabase(databasePath) {
  const database = openDatabase(databasePath);
  try {
    const conversations = listConversationTables(database);
    const counts = { group: 0, buddy: 0, system: 0 };
    const messages = { group: 0, buddy: 0, system: 0 };
    for (const conversation of conversations) {
      counts[conversation.kind] += 1;
      messages[conversation.kind] += Number(
        database
          .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(conversation.table)}`)
          .get().n
      );
    }
    return {
      quickCheck: pragmaValue(database, "quick_check"),
      groupCount: counts.group,
      buddyCount: counts.buddy,
      systemCount: counts.system,
      messageCount: messages.group,
      buddyMessageCount: messages.buddy,
      systemMessageCount: messages.system,
      totalMessageCount: messages.group + messages.buddy + messages.system,
      capabilities: {
        groupHistory: counts.group > 0 ? "full" : "unavailable",
        buddyHistory: counts.buddy > 0 ? "full" : "unavailable",
        contacts: counts.buddy > 0 ? "observed" : "unavailable",
        members: counts.group > 0 ? "observed" : "unavailable",
        unread: "checkpoint"
      }
    };
  } finally {
    database.close();
  }
}

module.exports = {
  MESSAGE_TYPES,
  allMessages,
  collectMessages,
  history,
  inspectDatabase,
  listConversationTables,
  listGroupTables,
  listSessions,
  messageFromRow,
  observedContacts,
  observedMembers,
  openDatabase,
  parseCursor,
  resolveConversation,
  resolveGroup,
  search,
  statistics,
  toU32,
  validateDatabase
};
