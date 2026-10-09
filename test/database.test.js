"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  history,
  listSessions,
  observedContacts,
  observedMembers,
  openDatabase,
  resolveConversation,
  resolveGroup,
  search,
  statistics,
  validateDatabase
} = require("../src/database");
const { createFixture } = require("./helpers");

test("lists, resolves, reads and searches group messages", () => {
  const fixture = createFixture();
  try {
    const validation = validateDatabase(fixture.databasePath);
    assert.equal(validation.groupCount, 2);

    const database = openDatabase(fixture.databasePath);
    try {
      const sessions = listSessions(database);
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].name, "其他群");

      const group = resolveGroup(database, "测试群", sessions);
      const result = history(database, group, { limit: 10 });
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0].rand, 2);
      assert.equal(result.messages[1].rand, 1);

      const found = search(database, "HELLO", { limit: 10 });
      assert.equal(found.totalMatches, 1);
      assert.equal(found.messages[0].groupUin, "123456");
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("queries buddy conversations, ranges, types, offsets and observed metadata", () => {
  const fixture = createFixture({ includeBuddy: true });
  try {
    const validation = validateDatabase(fixture.databasePath);
    assert.equal(validation.buddyCount, 1);
    const database = openDatabase(fixture.databasePath);
    try {
      const sessions = listSessions(database);
      assert.equal(sessions.length, 3);
      assert.equal(sessions[0].id, "buddy:55555");
      const buddy = resolveConversation(database, "buddy:55555", sessions);
      const direct = history(database, buddy, { limit: 10 });
      assert.equal(direct.messages[0].conversationKind, "buddy");
      assert.equal(direct.messages[0].buddyUin, "55555");

      const group = resolveGroup(database, "123456", sessions);
      const ranged = history(database, group, {
        limit: 10,
        offset: 1,
        type: "text",
        range: { startEpochSeconds: 1700000000, endEpochSeconds: 1700000000 }
      });
      assert.deepEqual(ranged.messages.map((message) => message.rand), [1]);
      assert.equal(statistics(database, group).total, 2);
      assert.equal(observedMembers(database, group).memberCount, 2);
      assert.equal(observedContacts(database).length, 1);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
