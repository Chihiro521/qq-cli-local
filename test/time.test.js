"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { CliError } = require("../src/errors");
const { buildTimeRange, parseLocalTime } = require("../src/time");

function epoch(year, month, day, hour = 0, minute = 0, second = 0) {
  return Math.floor(new Date(year, month - 1, day, hour, minute, second).getTime() / 1000);
}

function assertInvalid(callback) {
  assert.throws(callback, (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT");
}

test("parses each supported local time precision", () => {
  const date = parseLocalTime("2024-02-29");
  assert.deepEqual(date, {
    epochSeconds: epoch(2024, 2, 29),
    iso: new Date(2024, 1, 29).toISOString(),
    local: "2024-02-29 00:00:00",
    precision: "date"
  });

  const minute = parseLocalTime("2024-02-29 13:07");
  assert.equal(minute.epochSeconds, epoch(2024, 2, 29, 13, 7));
  assert.equal(minute.local, "2024-02-29 13:07:00");
  assert.equal(minute.precision, "minute");

  const second = parseLocalTime("2024-02-29 13:07:09");
  assert.equal(second.epochSeconds, epoch(2024, 2, 29, 13, 7, 9));
  assert.equal(second.iso, new Date(2024, 1, 29, 13, 7, 9).toISOString());
  assert.equal(second.local, "2024-02-29 13:07:09");
  assert.equal(second.precision, "second");
});

test("uses the final second of a date-only end bound", () => {
  const range = buildTimeRange({
    startTime: "2024-03-01",
    endTime: "2024-03-02"
  });

  assert.equal(range.startEpochSeconds, epoch(2024, 3, 1));
  assert.equal(range.endEpochSeconds, epoch(2024, 3, 2, 23, 59, 59));
  assert.equal(range.startLocal, "2024-03-01 00:00:00");
  assert.equal(range.endLocal, "2024-03-02 23:59:59");
  assert.equal(range.startIso, new Date(2024, 2, 1).toISOString());
  assert.equal(range.endIso, new Date(2024, 2, 2, 23, 59, 59).toISOString());
});

test("does not extend a minute- or second-precision end bound", () => {
  assert.equal(
    buildTimeRange({ endTime: "2024-03-02 08:09" }).endEpochSeconds,
    epoch(2024, 3, 2, 8, 9)
  );
  assert.equal(
    buildTimeRange({ endTime: "2024-03-02 08:09:10" }).endEpochSeconds,
    epoch(2024, 3, 2, 8, 9, 10)
  );
});

test("rejects malformed, out-of-range, and rolled-over local dates", () => {
  for (const value of [
    "2024-2-01",
    "2024-02-01T12:00:00",
    "2024-02-01 12",
    "2023-02-29",
    "2024-04-31",
    "2024-00-10",
    "2024-13-10",
    "2024-01-00",
    "2024-01-01 24:00",
    "2024-01-01 12:60",
    "2024-01-01 12:00:60",
    ""
  ]) {
    assertInvalid(() => parseLocalTime(value));
  }
  assertInvalid(() => parseLocalTime(null));
});

test("rejects a start bound after the inclusive end bound", () => {
  assertInvalid(() =>
    buildTimeRange({ startTime: "2024-05-02", endTime: "2024-05-01" })
  );
  assert.doesNotThrow(() =>
    buildTimeRange({ startTime: "2024-05-01 23:59:59", endTime: "2024-05-01" })
  );
});

test("builds --days from local calendar midnights through now", () => {
  const now = new Date(2024, 2, 1, 16, 17, 18, 987);
  const range = buildTimeRange({ days: 3 }, now);

  assert.equal(range.startEpochSeconds, epoch(2024, 2, 28));
  assert.equal(range.endEpochSeconds, epoch(2024, 3, 1, 16, 17, 18));
  assert.equal(range.startLocal, "2024-02-28 00:00:00");
  assert.equal(range.endLocal, "2024-03-01 16:17:18");
  assert.equal(range.startIso, new Date(2024, 1, 28).toISOString());
  assert.equal(range.endIso, new Date(2024, 2, 1, 16, 17, 18).toISOString());
});

test("accepts a numeric CLI string for --days and treats one as today", () => {
  const now = new Date(2024, 8, 5, 9, 8, 7);
  const range = buildTimeRange({ days: "1" }, now);
  assert.equal(range.startEpochSeconds, epoch(2024, 9, 5));
  assert.equal(range.endEpochSeconds, epoch(2024, 9, 5, 9, 8, 7));
});

test("rejects invalid --days values and combinations with explicit bounds", () => {
  for (const days of [0, -1, 1.5, "0", "1.5", " 2", "", Number.MAX_SAFE_INTEGER + 1]) {
    assertInvalid(() => buildTimeRange({ days }));
  }
  assertInvalid(() => buildTimeRange({ days: 2, startTime: "2024-01-01" }));
  assertInvalid(() => buildTimeRange({ days: 2, endTime: "2024-01-02" }));
});

test("supports open and empty ranges with null metadata", () => {
  assert.deepEqual(buildTimeRange(), {
    startEpochSeconds: null,
    endEpochSeconds: null,
    startIso: null,
    endIso: null,
    startLocal: null,
    endLocal: null
  });

  const range = buildTimeRange({ startTime: "2024-01-02 03:04:05" });
  assert.equal(range.startEpochSeconds, epoch(2024, 1, 2, 3, 4, 5));
  assert.equal(range.endEpochSeconds, null);
  assert.equal(range.endIso, null);
  assert.equal(range.endLocal, null);
});

test("rejects an invalid injected current time", () => {
  assertInvalid(() => buildTimeRange({ days: 1 }, new Date("invalid")));
});
