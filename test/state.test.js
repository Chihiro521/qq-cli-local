"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  advanceState,
  compareSessions,
  loadState,
  saveState
} = require("../src/state");

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qq-cli-state-"));
  return { home, statePath: path.join(home, "state", "checkpoint.json") };
}

const identity = {
  accountUin: "10001",
  sourceDb: "D:\\QQ\\Msg3.0.db",
  cacheSha256: "abc123"
};

test("uses only the caller-supplied state path and round-trips checkpoints", () => {
  const { home, statePath } = fixture();
  try {
    const initial = loadState(statePath, identity);
    assert.deepEqual(initial.conversations, {});
    assert.equal(initial.warning, null);

    const advanced = advanceState(identity, [
      {
        id: "group:42",
        groupUin: "42",
        name: "group",
        latest: { time: 10, rand: 20, messageId: "42:10:20" }
      }
    ], initial);
    saveState(statePath, advanced);

    const loaded = loadState(statePath, identity);
    assert.deepEqual(loaded.conversations["group:42"], {
      time: 10,
      rand: 20,
      messageId: "42:10:20"
    });
    assert.match(loaded.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      fs.readdirSync(path.dirname(statePath)),
      [path.basename(statePath)]
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("compares unsigned time and rand lexicographically", () => {
  const state = advanceState(identity, [
    { id: "same", latest: { time: -1, rand: -2, messageId: "old" } },
    { id: "rand", latest: { time: 7, rand: -2, messageId: "old" } },
    { id: "older", latest: { time: 8, rand: 9, messageId: "old" } }
  ]);

  const changed = compareSessions([
    { id: "same", name: "same", latest: { time: 0xffffffff, rand: 0xfffffffe, messageId: "same" } },
    { id: "rand", name: "rand", latest: { time: 7, rand: -1, messageId: "new" } },
    { id: "older", name: "older", latest: { time: 7, rand: 0xffffffff, messageId: "older" } },
    { id: "new", name: "new", latest: { time: 1, rand: 0, messageId: "first" } }
  ], state);

  assert.deepEqual(changed.map((session) => session.id), ["rand", "new"]);
  assert.deepEqual(changed[0].latest, {
    time: 7,
    rand: 0xffffffff,
    messageId: "new"
  });
});

test("supports existing listSessions summaries", () => {
  const changed = compareSessions(
    [{ id: "group:1", groupUin: "1", name: "one", lastMessageTime: 12 }],
    loadState("Z:\\path-that-does-not-exist\\state.json", identity)
  );
  assert.deepEqual(changed[0].latest, { time: 12, rand: 0, messageId: null });
});

test("resets on account or source changes but not cache hash changes", () => {
  const existing = advanceState(identity, [
    { id: "group:1", latest: { time: 1, rand: 2, messageId: "m" } }
  ]);

  const cacheRefresh = advanceState({ ...identity, cacheSha256: "new-hash" }, [], existing);
  assert.ok(cacheRefresh.conversations["group:1"]);
  assert.equal(cacheRefresh.cacheSha256, "new-hash");

  const accountChange = advanceState({ ...identity, accountUin: "20002" }, [], existing);
  assert.deepEqual(accountChange.conversations, {});
  const sourceChange = advanceState({ ...identity, sourceDb: "other.db" }, [], existing);
  assert.deepEqual(sourceChange.conversations, {});
});

test("advance does not regress an existing conversation checkpoint", () => {
  const existing = advanceState(identity, [
    { id: "group:1", latest: { time: 10, rand: 20, messageId: "new" } }
  ]);
  const advanced = advanceState(identity, [
    { id: "group:1", latest: { time: 10, rand: 19, messageId: "old" } }
  ], existing);
  assert.deepEqual(advanced.conversations["group:1"], {
    time: 10,
    rand: 20,
    messageId: "new"
  });
});

test("returns a fresh warning state for corrupt JSON and identity mismatch", () => {
  const { home, statePath } = fixture();
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{broken", "utf8");
    const corrupt = loadState(statePath, identity);
    assert.equal(corrupt.warning, "STATE_CORRUPT");
    assert.deepEqual(corrupt.conversations, {});

    saveState(statePath, advanceState(identity, []));
    const changed = loadState(statePath, { ...identity, accountUin: "other" });
    assert.equal(changed.warning, "IDENTITY_CHANGED");
    assert.deepEqual(changed.conversations, {});
    assert.equal(changed.accountUin, "other");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refuses to write state over the QQ source database", () => {
  const { home } = fixture();
  const sourceDb = path.join(home, "Msg3.0.db");
  try {
    fs.writeFileSync(sourceDb, "QQ database", "utf8");
    const state = advanceState({ ...identity, sourceDb }, []);
    assert.throws(
      () => saveState(sourceDb, state),
      /must not be the QQ source database/
    );
    assert.equal(fs.readFileSync(sourceDb, "utf8"), "QQ database");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
