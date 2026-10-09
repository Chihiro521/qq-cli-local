"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { decodeMessage, extractReceiverNames } = require("../src/decode");
const { infoBlob, messageBlob } = require("./helpers");

test("decodes text, sender and unknown tags without false warnings", () => {
  const decoded = decodeMessage(messageBlob(1700000000, 9, "你好 hello", "昵称"));
  assert.equal(decoded.headerTime, 1700000000);
  assert.equal(decoded.headerRand, 9);
  assert.equal(decoded.senderName, "昵称");
  assert.equal(decoded.text, "你好 hello");
  assert.deepEqual(decoded.unknownTags, [0]);
  assert.deepEqual(decoded.decodeWarnings, []);
});

test("keeps decoded prefix when a trailing TLV is truncated", () => {
  const valid = messageBlob(1700000000, 9, "保留我");
  const broken = Buffer.concat([valid, Buffer.from([1, 20, 0, 1])]);
  const decoded = decodeMessage(broken);
  assert.equal(decoded.text, "保留我");
  assert.equal(decoded.decodeWarnings.length, 1);
});

test("extracts receiver show name", () => {
  assert.deepEqual(extractReceiverNames(infoBlob("测试群 >ᴗoಣ")), [
    "测试群 >ᴗoಣ"
  ]);
});
