"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { createFixture, infoBlob, messageBlob } = require("./helpers");

const launcher = path.resolve(__dirname, "..", "bin", "qq-cli.js");

function run(home, args) {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    encoding: "utf8",
    env: { ...process.env, QQ_CLI_HOME: home }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("runs init to export as an npm-style CLI", () => {
  const fixture = createFixture();
  const home = path.join(fixture.directory, "home");
  const output = path.join(fixture.directory, "group.jsonl");
  try {
    const initialized = run(home, [
      "init",
      "--db",
      fixture.databasePath,
      "--account-uin",
      "10000"
    ]);
    assert.equal(initialized.data.database.groupCount, 2);

    const sessions = run(home, ["sessions", "--limit", "10"]);
    assert.equal(sessions.data.sessions.length, 2);

    const messages = run(home, ["history", "123456", "--limit", "10"]);
    assert.equal(messages.data.messages.length, 2);

    const searched = run(home, ["search", "hello"]);
    assert.equal(searched.data.totalMatches, 1);

    const exported = run(home, [
      "export",
      "123456",
      "--output",
      output
    ]);
    assert.equal(exported.data.messageCount, 2);
    assert.equal(fs.readFileSync(output, "utf8").split("\n")[0].includes("header"), true);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("supports parity commands for mixed conversations and local checkpoints", () => {
  const fixture = createFixture({ includeBuddy: true });
  const home = path.join(fixture.directory, "home");
  try {
    run(home, ["init", "--db", fixture.databasePath, "--account-uin", "10000"]);

    const buddySessions = run(home, ["sessions", "--kind", "buddy"]);
    assert.equal(buddySessions.data.sessions.length, 1);
    assert.equal(buddySessions.data.sessions[0].id, "buddy:55555");

    const direct = run(home, [
      "history",
      "buddy:55555",
      "--start-time",
      "2023-11-01",
      "--end-time",
      "2023-12-01"
    ]);
    assert.equal(direct.data.messages[0].text, "private hello");

    const searched = run(home, [
      "search",
      "hello",
      "--chat",
      "123456",
      "--chat",
      "buddy:55555"
    ]);
    assert.equal(searched.data.totalMatches, 2);

    const stats = run(home, ["stats", "123456"]);
    assert.equal(stats.data.total, 2);
    assert.equal(stats.data.topSenders.length, 2);

    const summary = run(home, ["summarize", "123456", "--chunk-size", "1"]);
    assert.equal(summary.data.mode, "prompt-only");
    assert.equal(summary.data.networkUsed, false);
    assert.equal(summary.data.chunks.length, 2);

    const contacts = run(home, ["contacts"]);
    assert.equal(contacts.data.authoritative, false);
    assert.equal(contacts.data.contacts[0].uin, "55555");

    const members = run(home, ["members", "123456"]);
    assert.equal(members.data.coverage, "observed-senders");
    assert.equal(members.data.memberCount, 2);

    const rendered = run(home, ["export", "123456", "--format", "markdown"]);
    assert.match(rendered.data.content, /^# 测试群/m);

    const baseline = run(home, ["new-messages"]);
    assert.equal(baseline.data.baselineEstablished, true);
    assert.equal(baseline.data.messageCount, 0);

    const cache = path.join(home, "cache", "Msg3.0.db");
    const database = new DatabaseSync(cache);
    database
      .prepare("INSERT INTO group_123456 VALUES (?, ?, ?, ?, ?)")
      .run(
        1700000030,
        5,
        10001,
        messageBlob(1700000030, 5, "checkpoint message"),
        infoBlob("测试群")
      );
    database.close();

    const unread = run(home, ["unread"]);
    assert.equal(unread.data.messageCount, 1);
    assert.equal(unread.data.authoritative, false);
    const fresh = run(home, ["new-messages"]);
    assert.equal(fresh.data.messages[0].text, "checkpoint message");
    assert.equal(run(home, ["unread"]).data.messageCount, 0);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
