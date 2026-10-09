"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { CliError } = require("../src/errors");
const {
  createFavoritesReader,
  detectFavoritesSource,
  listFavorites,
  openFavoritesDatabase
} = require("../src/favorites");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-favorites-test-"));
  const collectionDirectory = path.join(directory, "MyCollection");
  fs.mkdirSync(collectionDirectory);
  const databasePath = path.join(collectionDirectory, "mc3.db");
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE Cid2DataTable (" +
      "lid INTEGER, cid TEXT, type INTEGER, localTime INTEGER, serverTime INTEGER, " +
      "createTime INTEGER, collectTime INTEGER, extra TEXT, data BLOB)"
  );
  const insert = database.prepare(
    "INSERT INTO Cid2DataTable VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insert.run(
    1,
    "synthetic-1",
    1,
    1700000000,
    1700000001,
    1700000002,
    1700000003,
    "ignored",
    Buffer.concat([Buffer.from([0, 1]), Buffer.from("Synthetic UTF-8 note", "utf8")])
  );
  insert.run(
    2,
    "synthetic-2",
    3,
    1700000010,
    1700000011,
    1700000012,
    1700000013,
    "ignored",
    Buffer.from(
      "<item><title>Fixture article</title><summary>Searchable sample</summary>" +
        "<url>https://example.invalid/item</url></item>",
      "utf16le"
    )
  );
  insert.run(3, "synthetic-3", 99, 0, 0, 0, 1700000023, "ignored", Buffer.from([0, 1, 2]));
  database.close();
  return { directory, databasePath };
}

test("detects a caller-supplied favorites database path and opens query-only", () => {
  const data = fixture();
  try {
    assert.equal(detectFavoritesSource(data.directory), data.databasePath);
    assert.equal(detectFavoritesSource(path.dirname(data.databasePath)), data.databasePath);
    assert.equal(detectFavoritesSource(data.databasePath), data.databasePath);

    const database = openFavoritesDatabase(data.databasePath);
    try {
      const queryOnly = Object.values(database.prepare("PRAGMA query_only").get())[0];
      assert.equal(queryOnly, 1);
      assert.throws(() => database.exec("DELETE FROM Cid2DataTable"));
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(data.directory, { recursive: true, force: true });
  }
});

test("lists, parses, filters and limits synthetic favorites", () => {
  const data = fixture();
  try {
    const favorites = listFavorites(data.directory, { limit: 10 });
    assert.equal(favorites.length, 3);
    assert.equal(favorites[0].rawType, 99);
    assert.equal(favorites[0].type, "unknown");
    assert.equal(favorites[0].coverage.level, "none");
    assert.ok(favorites[0].parseWarnings.length > 0);

    const article = favorites[1];
    assert.equal(article.type, "article");
    assert.equal(article.xmlFields.title, "Fixture article");
    assert.match(article.summary, /Searchable sample/);
    assert.equal(article.timestamps.collectTime, 1700000013);
    assert.equal(article.timestamps.collectTimeAt, "2023-11-14T22:13:33.000Z");
    assert.deepEqual(article.parseWarnings, []);

    const reader = createFavoritesReader(data.directory);
    assert.equal(reader.sourcePath, data.databasePath);
    const queried = reader.listFavorites({ type: "article", query: "searchable", limit: 1 });
    assert.equal(queried.length, 1);
    assert.equal(queried[0].cid, "synthetic-2");

    const text = listFavorites({ sourcePath: data.databasePath, type: "text", query: "utf-8" });
    assert.equal(text.length, 1);
    assert.match(text[0].sourceText, /Synthetic UTF-8 note/);
    assert.deepEqual(listFavorites({ source: data.databasePath, limit: 0 }), []);
  } finally {
    fs.rmSync(data.directory, { recursive: true, force: true });
  }
});

test("reports absent and invalid favorites databases as CliError capabilities", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-favorites-errors-"));
  const invalidPath = path.join(directory, "mc3.db");
  try {
    assert.throws(
      () => listFavorites(path.join(directory, "absent")),
      (error) => error instanceof CliError && error.code === "FAVORITES_DATABASE_NOT_FOUND"
    );
    fs.writeFileSync(invalidPath, "not sqlite");
    assert.throws(
      () => listFavorites(invalidPath),
      (error) => error instanceof CliError && error.code === "FAVORITES_DATABASE_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
