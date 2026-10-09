"use strict";

const { CliError } = require("./errors");

const LOCAL_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/;

function invalid(message) {
  throw new CliError("INVALID_ARGUMENT", message);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatLocal(date) {
  return [
    `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join(" ");
}

function metadata(date, precision) {
  return {
    epochSeconds: Math.floor(date.getTime() / 1000),
    iso: date.toISOString(),
    local: formatLocal(date),
    precision
  };
}

function parseLocalTime(value, options = {}) {
  if (typeof value !== "string") {
    invalid("时间必须是字符串");
  }

  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) {
    invalid(`无效时间格式: ${value}`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const dateOnly = hourText === undefined;
  const endOfDay = dateOnly && options.endOfDay === true;
  const parts = {
    year: Number(yearText),
    month: Number(monthText) - 1,
    day: Number(dayText),
    hour: endOfDay ? 23 : Number(hourText || 0),
    minute: endOfDay ? 59 : Number(minuteText || 0),
    second: endOfDay ? 59 : Number(secondText || 0)
  };

  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(parts.year, parts.month, parts.day);
  date.setHours(parts.hour, parts.minute, parts.second, 0);

  if (
    date.getFullYear() !== parts.year ||
    date.getMonth() !== parts.month ||
    date.getDate() !== parts.day ||
    date.getHours() !== parts.hour ||
    date.getMinutes() !== parts.minute ||
    date.getSeconds() !== parts.second
  ) {
    invalid(`无效本地时间: ${value}`);
  }

  return metadata(date, dateOnly ? "date" : secondText === undefined ? "minute" : "second");
}

function parseDays(value) {
  const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    invalid("--days 必须是大于等于 1 的整数");
  }
  return normalized;
}

function buildTimeRange({ startTime, endTime, days } = {}, now = new Date()) {
  const hasExplicitTime = startTime != null || endTime != null;
  const hasDays = days != null;

  if (hasDays && hasExplicitTime) {
    invalid("--days 不能与显式开始或结束时间同时使用");
  }

  let start = null;
  let end = null;

  if (hasDays) {
    const count = parseDays(days);
    const current = new Date(now);
    if (Number.isNaN(current.getTime())) invalid("当前时间无效");
    current.setMilliseconds(0);

    const midnight = new Date(current);
    midnight.setHours(0, 0, 0, 0);
    midnight.setDate(midnight.getDate() - (count - 1));
    start = metadata(midnight, "second");
    end = metadata(current, "second");
  } else {
    if (startTime != null) start = parseLocalTime(startTime);
    if (endTime != null) end = parseLocalTime(endTime, { endOfDay: true });
  }

  if (start && end && start.epochSeconds > end.epochSeconds) {
    invalid("开始时间不能晚于结束时间");
  }

  return {
    startEpochSeconds: start?.epochSeconds ?? null,
    endEpochSeconds: end?.epochSeconds ?? null,
    startIso: start?.iso ?? null,
    endIso: end?.iso ?? null,
    startLocal: start?.local ?? null,
    endLocal: end?.local ?? null
  };
}

module.exports = { buildTimeRange, parseLocalTime };
