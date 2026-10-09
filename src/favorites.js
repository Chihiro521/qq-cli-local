"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { CliError } = require("./errors");

const TABLE = "Cid2DataTable";
const REQUIRED_COLUMNS = [
  "lid",
  "cid",
  "type",
  "localTime",
  "serverTime",
  "createTime",
  "collectTime",
  "data"
];
const TYPE_BY_NUMBER = new Map([
  [1, "text"],
  [2, "image"],
  [3, "article"],
  [4, "card"],
  [5, "video"]
]);
const KNOWN_TYPES = new Set(TYPE_BY_NUMBER.values());
const XML_FIELDS = new Set([
  "author",
  "content",
  "desc",
  "description",
  "name",
  "source",
  "summary",
  "text",
  "title",
  "url"
]);

function detectFavoritesSource(sourcePath) {
  if (typeof sourcePath !== "string" || !sourcePath.trim()) {
    throw new CliError("INVALID_ARGUMENT", "收藏数据库路径不能为空");
  }

  const supplied = path.resolve(sourcePath);
  const candidates = [supplied];
  try {
    if (fs.statSync(supplied).isDirectory()) {
      candidates.unshift(path.join(supplied, "mc3.db"));
      candidates.unshift(path.join(supplied, "MyCollection", "mc3.db"));
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new CliError(
        "FAVORITES_DATABASE_OPEN_FAILED",
        `无法检查收藏数据库路径: ${error.message}`
      );
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new CliError(
          "FAVORITES_DATABASE_OPEN_FAILED",
          `无法检查收藏数据库路径: ${error.message}`
        );
      }
    }
  }
  throw new CliError("FAVORITES_DATABASE_NOT_FOUND", `收藏数据库不存在: ${supplied}`);
}

function openFavoritesDatabase(sourcePath) {
  const resolved = detectFavoritesSource(sourcePath);
  let database;
  try {
    database = new DatabaseSync(resolved, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    validateSchema(database);
    return database;
  } catch (error) {
    if (database) database.close();
    if (error instanceof CliError) throw error;
    throw new CliError(
      "FAVORITES_DATABASE_INVALID",
      `无法读取收藏数据库: ${error.message}`
    );
  }
}

function validateSchema(database) {
  let rows;
  try {
    rows = database.prepare(`PRAGMA table_info("${TABLE}")`).all();
  } catch (error) {
    throw new CliError("FAVORITES_DATABASE_INVALID", `无法检查收藏表: ${error.message}`);
  }
  if (rows.length === 0) {
    throw new CliError("FAVORITES_DATABASE_INVALID", `数据库中没有 ${TABLE}`);
  }
  const columns = new Map(rows.map((row) => [row.name.toLocaleLowerCase(), row.name]));
  for (const required of REQUIRED_COLUMNS) {
    if (!columns.has(required.toLocaleLowerCase())) {
      throw new CliError("FAVORITES_DATABASE_INVALID", `收藏表缺少字段: ${required}`);
    }
  }
  return columns;
}

function cleanText(value) {
  return value
    .replace(/\0/g, "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulText(value) {
  if (value.length < 3 || value.length > 8192) return false;
  let useful = 0;
  for (const character of value) {
    if (/[^\p{C}\p{Z}]/u.test(character) || character === " ") useful += 1;
  }
  return useful / value.length >= 0.8;
}

function extractUtf8(buffer) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const results = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    const byte = buffer[index];
    if (index < buffer.length && (byte >= 0x20 || byte >= 0x80)) continue;
    if (index - start >= 3) {
      try {
        const text = cleanText(decoder.decode(buffer.subarray(start, index)));
        if (isUsefulText(text)) results.push(text);
      } catch {}
    }
    start = index + 1;
  }
  return results;
}

function extractUtf16(buffer) {
  const results = [];
  for (const offset of [0]) {
    let current = [];
    for (let index = offset; index + 1 < buffer.length; index += 2) {
      const code = buffer.readUInt16LE(index);
      const printable = code >= 0x20 && code !== 0x7f && !(code >= 0xd800 && code <= 0xdfff);
      if (printable) {
        current.push(String.fromCharCode(code));
      } else {
        const text = cleanText(current.join(""));
        if (isUsefulText(text)) results.push(text);
        current = [];
      }
    }
    const text = cleanText(current.join(""));
    if (isUsefulText(text)) results.push(text);
  }
  return results;
}

function decodeXmlEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLocaleLowerCase()] ?? match;
    const hex = entity[1].toLocaleLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function extractXmlFields(texts) {
  const fields = {};
  let sawXml = false;
  for (const text of texts) {
    if (!/<[a-z_:][^>]*>/i.test(text)) continue;
    sawXml = true;
    const pattern = /<([a-z_:][\w:.-]*)\b[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1\s*>/gi;
    for (const match of text.matchAll(pattern)) {
      const name = match[1].split(":").at(-1).toLocaleLowerCase();
      if (!XML_FIELDS.has(name)) continue;
      const value = cleanText(decodeXmlEntities(match[2] ?? match[3] ?? ""));
      if (value && fields[name] === undefined) fields[name] = value;
    }
  }
  return { fields, sawXml };
}

function uniqueTexts(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = value.toLocaleLowerCase();
    if (!value || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function parseBlob(value) {
  if (value === null || value === undefined) {
    return {
      summary: "",
      sourceText: "",
      xmlFields: {},
      coverage: { level: "none", dataBytes: 0, encodings: [] },
      parseWarnings: ["data 为空"]
    };
  }
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf8 = extractUtf8(buffer);
  const utf16 = extractUtf16(buffer);
  const texts = uniqueTexts([...utf8, ...utf16]);
  const { fields, sawXml } = extractXmlFields(texts);
  const fieldTexts = uniqueTexts(Object.values(fields));
  const sourceTexts = uniqueTexts([...fieldTexts, ...texts]);
  const summaryCandidates = [
    fields.title,
    fields.summary,
    fields.description,
    fields.desc,
    fields.content,
    fields.text,
    fields.name,
    ...texts.filter((text) => !text.startsWith("<"))
  ].filter(Boolean);
  const summary = cleanText(summaryCandidates.join(" | ")).slice(0, 500);
  const encodings = [];
  if (utf8.length) encodings.push("utf-8");
  if (utf16.length) encodings.push("utf-16le");
  const parseWarnings = [];
  if (!texts.length && buffer.length) parseWarnings.push("data 中未发现可安全提取的文本");
  if (sawXml && Object.keys(fields).length === 0) {
    parseWarnings.push("发现 XML，但没有识别到支持的文本字段");
  }
  return {
    summary,
    sourceText: sourceTexts.join("\n").slice(0, 32768),
    xmlFields: fields,
    coverage: {
      level: Object.keys(fields).length ? "structured" : texts.length ? "text" : "none",
      dataBytes: buffer.length,
      encodings
    },
    parseWarnings
  };
}

function scalar(value) {
  return typeof value === "bigint" ? value.toString() : value ?? null;
}

function timestampIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number < 100000000000 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function mapType(rawType, parsed) {
  const numeric = Number(rawType);
  if (Number.isInteger(numeric) && TYPE_BY_NUMBER.has(numeric)) return TYPE_BY_NUMBER.get(numeric);
  const normalized = String(rawType ?? "").trim().toLocaleLowerCase();
  if (KNOWN_TYPES.has(normalized)) return normalized;

  const text = `${parsed.sourceText} ${Object.values(parsed.xmlFields).join(" ")}`;
  if (/\.(?:jpe?g|png|gif|webp|bmp)(?:[?#\s]|$)/i.test(text)) return "image";
  if (/\.(?:mp4|mov|m4v|avi|wmv)(?:[?#\s]|$)/i.test(text)) return "video";
  if (parsed.xmlFields.url && (parsed.xmlFields.title || parsed.xmlFields.summary)) return "article";
  if (parsed.coverage.level === "structured") return "card";
  if (parsed.sourceText) return "text";
  return "unknown";
}

function normalizeArguments(sourceOrOptions, maybeOptions) {
  if (typeof sourceOrOptions === "string") {
    return { sourcePath: sourceOrOptions, options: maybeOptions ?? {} };
  }
  if (sourceOrOptions && typeof sourceOrOptions === "object") {
    const {
      source,
      sourcePath,
      databasePath,
      path: suppliedPath,
      ...options
    } = sourceOrOptions;
    return { sourcePath: sourcePath ?? databasePath ?? suppliedPath ?? source, options };
  }
  return { sourcePath: null, options: maybeOptions ?? {} };
}

function validateOptions({ limit = 50, type = null, query = null }) {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new CliError("INVALID_ARGUMENT", "limit 必须是非负整数");
  }
  const normalizedType = type === null ? null : String(type).trim().toLocaleLowerCase();
  if (normalizedType && !KNOWN_TYPES.has(normalizedType) && !/^\d+$/.test(normalizedType)) {
    throw new CliError("INVALID_ARGUMENT", `不支持的收藏类型: ${type}`);
  }
  return {
    limit,
    type: normalizedType || null,
    query: query === null ? null : String(query).toLocaleLowerCase()
  };
}

function listFavorites(sourceOrOptions, maybeOptions) {
  const { sourcePath, options } = normalizeArguments(sourceOrOptions, maybeOptions);
  const filters = validateOptions(options);
  const database = openFavoritesDatabase(sourcePath);
  try {
    if (filters.limit === 0) return [];
    const columns = validateSchema(database);
    const quoted = (name) => `"${columns.get(name.toLocaleLowerCase()).replace(/"/g, '""')}"`;
    const selected = REQUIRED_COLUMNS.map((name) => `${quoted(name)} AS "${name}"`).join(", ");
    const sql =
      `SELECT ${selected} FROM "${TABLE}" ` +
      `ORDER BY ${quoted("collectTime")} DESC, ${quoted("lid")} DESC`;
    const favorites = [];
    for (const row of database.prepare(sql).iterate()) {
      const parsed = parseBlob(row.data);
      const mappedType = mapType(row.type, parsed);
      if (filters.type && filters.type !== mappedType && filters.type !== String(row.type)) continue;
      if (filters.query && !parsed.sourceText.toLocaleLowerCase().includes(filters.query)) continue;
      favorites.push({
        lid: scalar(row.lid),
        cid: scalar(row.cid),
        type: mappedType,
        rawType: scalar(row.type),
        timestamps: {
          localTime: scalar(row.localTime),
          localTimeAt: timestampIso(row.localTime),
          serverTime: scalar(row.serverTime),
          serverTimeAt: timestampIso(row.serverTime),
          createTime: scalar(row.createTime),
          createTimeAt: timestampIso(row.createTime),
          collectTime: scalar(row.collectTime),
          collectTimeAt: timestampIso(row.collectTime)
        },
        summary: parsed.summary,
        sourceText: parsed.sourceText,
        xmlFields: parsed.xmlFields,
        coverage: parsed.coverage,
        parseWarnings: parsed.parseWarnings
      });
      if (favorites.length >= filters.limit) break;
    }
    return favorites;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("FAVORITES_DATABASE_INVALID", `无法查询收藏数据库: ${error.message}`);
  } finally {
    database.close();
  }
}

function createFavoritesReader(sourcePath) {
  const resolved = detectFavoritesSource(sourcePath);
  return {
    sourcePath: resolved,
    listFavorites(options = {}) {
      return listFavorites(resolved, options);
    }
  };
}

module.exports = {
  createFavoritesReader,
  detectFavoritesSource,
  listFavorites,
  openFavoritesDatabase,
  parseFavoriteData: parseBlob
};
