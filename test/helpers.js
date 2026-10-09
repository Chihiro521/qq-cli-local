"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function tlv(tag, value) {
  const buffer = Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), u16(buffer.length), buffer]);
}

function messageBlob(time, rand, text, senderName = "测试用户") {
  const font = Buffer.from("宋体", "utf16le");
  const body = Buffer.concat([
    tlv(0, Buffer.from([1, 2, 3, 4])),
    tlv(1, tlv(1, Buffer.from(text, "utf16le"))),
    tlv(18, tlv(1, Buffer.from(senderName, "utf16le")))
  ]);
  return Buffer.concat([
    Buffer.alloc(8),
    u32(time),
    u32(rand),
    u32(0),
    Buffer.from([12, 0, 0, 0]),
    u16(font.length),
    font,
    Buffer.alloc(2),
    body
  ]);
}

function xor(value) {
  const buffer = Buffer.from(value);
  const key = 0xff - buffer.length;
  const output = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index < buffer.length; index += 1) {
    output[index] = buffer[index] ^ key;
  }
  return output;
}

function infoBlob(groupName) {
  const field = Buffer.from("strRecieverShowName", "utf16le");
  const value = Buffer.from(groupName, "utf16le");
  return Buffer.concat([
    Buffer.from([0x08]),
    u16(field.length),
    xor(field),
    u32(value.length),
    xor(value)
  ]);
}

function createFixture({ includeBuddy = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-cli-test-"));
  const databasePath = path.join(directory, "Msg3.0.db");
  const database = new DatabaseSync(databasePath);
  for (const groupUin of ["123456", "987654"]) {
    database.exec(
      `CREATE TABLE group_${groupUin} (` +
        "Time INTEGER, Rand INTEGER, SenderUin INTEGER, MsgContent BLOB, Info BLOB, " +
        "PRIMARY KEY(Time, Rand))"
    );
  }
  const insertFirst = database.prepare(
    "INSERT INTO group_123456 VALUES (?, ?, ?, ?, ?)"
  );
  insertFirst.run(
    1700000000,
    1,
    10001,
    messageBlob(1700000000, 1, "第一条 hello"),
    infoBlob("测试群")
  );
  insertFirst.run(
    1700000000,
    2,
    10002,
    messageBlob(1700000000, 2, "第二条 world", "另一个用户"),
    infoBlob("测试群")
  );
  database
    .prepare("INSERT INTO group_987654 VALUES (?, ?, ?, ?, ?)")
    .run(
      1700000010,
      3,
      10003,
      messageBlob(1700000010, 3, "其他群消息"),
      infoBlob("其他群")
    );
  if (includeBuddy) {
    database.exec(
      "CREATE TABLE buddy_55555 (" +
        "Time INTEGER, Rand INTEGER, SenderUin INTEGER, MsgContent BLOB, Info BLOB, " +
        "PRIMARY KEY(Time, Rand))"
    );
    database
      .prepare("INSERT INTO buddy_55555 VALUES (?, ?, ?, ?, ?)")
      .run(
        1700000020,
        4,
        55555,
        messageBlob(1700000020, 4, "private hello", "Alice"),
        infoBlob("Alice")
      );
  }
  database.close();
  return { directory, databasePath };
}

module.exports = { createFixture, infoBlob, messageBlob, tlv };
