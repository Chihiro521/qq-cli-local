"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const VERSION = 1;

function identityValue(value) {
  return value === undefined || value === null ? null : String(value);
}

function freshState(identity = {}, warning = null) {
  return {
    version: VERSION,
    accountUin: identityValue(identity.accountUin),
    sourceDb: identityValue(identity.sourceDb),
    cacheSha256: identityValue(identity.cacheSha256),
    checkedAt: null,
    conversations: {},
    warning
  };
}

function sameIdentity(state, identity) {
  return (
    state.accountUin === identityValue(identity.accountUin) &&
    state.sourceDb === identityValue(identity.sourceDb)
  );
}

function uint32(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  return number >>> 0;
}

function sessionSummary(session) {
  if (!session || typeof session !== "object") return null;
  const id = session.id ?? session.groupUin;
  if (id === undefined || id === null) return null;

  const source = session.latest && typeof session.latest === "object"
    ? session.latest
    : session;
  const time = uint32(source.time ?? session.lastMessageTime);
  if (time === null) return null;
  const rand = uint32(source.rand ?? session.lastMessageRand ?? 0);
  if (rand === null) return null;
  const messageId = source.messageId ??
    (source === session ? null : source.id) ??
    session.lastMessageId ??
    null;

  return {
    id: String(id),
    name: session.name ?? null,
    groupUin: session.groupUin === undefined ? null : String(session.groupUin),
    latest: {
      time,
      rand,
      messageId: messageId === null || messageId === undefined ? null : String(messageId)
    }
  };
}

function validCursor(cursor) {
  return (
    cursor &&
    typeof cursor === "object" &&
    uint32(cursor.time) !== null &&
    uint32(cursor.rand) !== null &&
    (cursor.messageId === null ||
      cursor.messageId === undefined ||
      typeof cursor.messageId === "string")
  );
}

function validState(state) {
  if (
    !state ||
    typeof state !== "object" ||
    state.version !== VERSION ||
    !state.conversations ||
    typeof state.conversations !== "object" ||
    Array.isArray(state.conversations)
  ) {
    return false;
  }
  return Object.values(state.conversations).every(validCursor);
}

function cleanState(state) {
  const conversations = {};
  for (const [id, cursor] of Object.entries(state.conversations)) {
    conversations[id] = {
      time: uint32(cursor.time),
      rand: uint32(cursor.rand),
      messageId: cursor.messageId ?? null
    };
  }
  return {
    version: VERSION,
    accountUin: identityValue(state.accountUin),
    sourceDb: identityValue(state.sourceDb),
    cacheSha256: identityValue(state.cacheSha256),
    checkedAt: typeof state.checkedAt === "string" ? state.checkedAt : null,
    conversations,
    warning: null
  };
}

function loadState(statePath, identity = {}) {
  if (typeof statePath !== "string" || statePath.length === 0) {
    throw new TypeError("statePath must be a non-empty string");
  }

  let contents;
  try {
    contents = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return freshState(identity);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return freshState(identity, "STATE_CORRUPT");
  }

  if (!validState(parsed)) return freshState(identity, "STATE_CORRUPT");
  if (!sameIdentity(parsed, identity)) {
    return freshState(identity, "IDENTITY_CHANGED");
  }
  const state = cleanState(parsed);
  state.cacheSha256 = identityValue(identity.cacheSha256 ?? state.cacheSha256);
  return state;
}

function saveState(statePath, state) {
  if (typeof statePath !== "string" || statePath.length === 0) {
    throw new TypeError("statePath must be a non-empty string");
  }
  if (!validState(state)) throw new TypeError("state is invalid");
  if (
    state.sourceDb &&
    path.resolve(statePath).toLocaleLowerCase() ===
      path.resolve(state.sourceDb).toLocaleLowerCase()
  ) {
    throw new Error("statePath must not be the QQ source database");
  }

  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const serialized = cleanState(state);
  delete serialized.warning;

  try {
    fs.writeFileSync(temporary, `${JSON.stringify(serialized, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    fs.renameSync(temporary, statePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function compareSessions(sessions, state) {
  const previous = state && state.conversations ? state.conversations : {};
  const changed = [];
  for (const session of sessions) {
    const summary = sessionSummary(session);
    if (!summary) continue;
    const cursor = previous[summary.id];
    const previousTime = cursor ? uint32(cursor.time) : null;
    const previousRand = cursor ? uint32(cursor.rand) : null;
    if (
      previousTime === null ||
      summary.latest.time > previousTime ||
      (summary.latest.time === previousTime && summary.latest.rand > previousRand)
    ) {
      changed.push(summary);
    }
  }
  return changed;
}

function advanceState(identity, sessions, existing = null) {
  const base = validState(existing) && sameIdentity(existing, identity)
    ? cleanState(existing)
    : freshState(identity);

  base.accountUin = identityValue(identity.accountUin);
  base.sourceDb = identityValue(identity.sourceDb);
  base.cacheSha256 = identityValue(identity.cacheSha256);
  base.checkedAt = new Date().toISOString();
  base.warning = null;
  for (const session of sessions) {
    const summary = sessionSummary(session);
    if (!summary) continue;
    const previous = base.conversations[summary.id];
    if (
      !previous ||
      summary.latest.time > previous.time ||
      (summary.latest.time === previous.time && summary.latest.rand >= previous.rand)
    ) {
      base.conversations[summary.id] = summary.latest;
    }
  }
  return base;
}

module.exports = { advanceState, compareSessions, loadState, saveState };
