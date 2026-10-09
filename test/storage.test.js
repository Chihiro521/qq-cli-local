"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseHelperOutput } = require("../src/decrypt");
const { detectDatabaseType, installDatabase } = require("../src/storage");
const { createFixture } = require("./helpers");

test("detects plaintext and Classic PCQQ encrypted database headers", () => {
  const fixture = createFixture();
  const encrypted = path.join(fixture.directory, "Msg3.0.db");
  try {
    assert.equal(detectDatabaseType(fixture.databasePath), "plaintext");
    fs.writeFileSync(encrypted, Buffer.from("SQLite header 3\0", "ascii"));
    assert.equal(detectDatabaseType(encrypted), "pcqq-encrypted");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a plaintext source with an active SQLite sidecar", () => {
  const fixture = createFixture();
  const target = path.join(fixture.directory, "cache", "Msg3.0.db");
  try {
    fs.writeFileSync(`${fixture.databasePath}-wal`, "active");
    assert.throws(
      () => installDatabase(fixture.databasePath, target),
      (error) => error.code === "DATABASE_BUSY"
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("parses helper JSON after native diagnostic output", () => {
  assert.deepEqual(parseHelperOutput('diagnostic\n{"ok":true,"data":{"value":1}}\n'), {
    ok: true,
    data: { value: 1 }
  });
});
