"use strict";

const crypto = require("node:crypto");

const RECEIVER_FIELD = "strRecieverShowName";

class DecodeFailure extends Error {}

class Reader {
  constructor(value) {
    this.buffer = Buffer.from(value ?? []);
    this.offset = 0;
  }

  get remaining() {
    return this.buffer.length - this.offset;
  }

  read(length) {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) {
      throw new DecodeFailure(
        `需要 ${length} 字节，offset=${this.offset}，剩余=${this.remaining}`
      );
    }
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(length) {
    this.read(length);
  }

  u8() {
    return this.read(1)[0];
  }

  u16() {
    const value = this.buffer.readUInt16LE(this.offset);
    this.skip(2);
    return value;
  }

  u32() {
    const value = this.buffer.readUInt32LE(this.offset);
    this.skip(4);
    return value;
  }
}

function parseTlvs(value, warnings, context) {
  const reader = new Reader(value);
  const items = [];
  while (reader.remaining > 0) {
    const offset = reader.offset;
    if (reader.remaining < 3) {
      warnings.push(`${context}: TLV 头被截断，offset=${offset}`);
      break;
    }
    const tag = reader.u8();
    const length = reader.u16();
    if (length > reader.remaining) {
      warnings.push(
        `${context}: tag=${tag} 长度=${length} 超出剩余=${reader.remaining}`
      );
      break;
    }
    items.push({ tag, value: reader.read(length), offset });
  }
  return items;
}

function decodeUtf16(value, warnings, context) {
  if (value.length % 2 !== 0) {
    warnings.push(`${context}: UTF-16LE 字节数为奇数`);
    return Buffer.from(value.subarray(0, value.length - 1)).toString("utf16le");
  }
  return Buffer.from(value).toString("utf16le").replace(/^\uFEFF/, "");
}

function firstInner(items, wantedTag) {
  return items.find((item) => item.tag === wantedTag)?.value ?? null;
}

function bytesToInteger(value) {
  let result = 0n;
  for (const byte of value) result = (result << 8n) | BigInt(byte);
  return result.toString();
}

function decodeMessage(raw) {
  const warnings = [];
  const elements = [];
  const unknownTags = [];
  const displayNames = [];
  const rendered = [];
  let headerTime = null;
  let headerRand = null;

  try {
    const reader = new Reader(raw);
    reader.skip(8);
    headerTime = reader.u32();
    headerRand = reader.u32();
    reader.u32();
    reader.skip(4);
    const fontNameLength = reader.u16();
    decodeUtf16(reader.read(fontNameLength), warnings, "fontName");
    reader.skip(2);

    const topLevel = parseTlvs(
      reader.read(reader.remaining),
      warnings,
      "message"
    );

    for (const item of topLevel) {
      let nestedValue = null;
      const nested = () => {
        if (nestedValue !== null) return nestedValue;
        const nestedWarnings = [];
        nestedValue = parseTlvs(item.value, nestedWarnings, `tag=${item.tag}`);
        warnings.push(...nestedWarnings);
        return nestedValue;
      };

      if (item.tag === 1) {
        const values = nested()
          .filter((part) => part.tag === 1)
          .map((part) => decodeUtf16(part.value, warnings, "text"));
        for (const text of values) {
          elements.push({ type: "text", text });
          rendered.push(text);
        }
      } else if (item.tag === 2) {
        const faceBytes = firstInner(nested(), 1);
        if (faceBytes) {
          const id = bytesToInteger(faceBytes);
          elements.push({ type: "face", id });
          rendered.push(`[表情:${id}]`);
        }
      } else if (item.tag === 3 || item.tag === 6) {
        const hash = firstInner(nested(), 1);
        const pathValue = firstInner(nested(), 2);
        const image = {
          type: "image",
          scope: item.tag === 3 ? "group" : "private",
          hash: hash ? Buffer.from(hash).toString("hex") : null,
          path: pathValue
            ? decodeUtf16(pathValue, warnings, "image.path")
            : null
        };
        elements.push(image);
        rendered.push("[图片]");
      } else if (item.tag === 7) {
        const hash = firstInner(nested(), 1);
        elements.push({
          type: "voice",
          hash: hash ? Buffer.from(hash).toString("hex") : null
        });
        rendered.push("[语音]");
      } else if (item.tag === 18) {
        for (const part of nested()) {
          if (part.tag !== 1 && part.tag !== 2) continue;
          const name = decodeUtf16(part.value, warnings, "displayName").trim();
          if (name) displayNames.push(name);
        }
      } else if (item.tag === 26) {
        const payload = firstInner(nested(), 1);
        let hash = null;
        if (payload && payload.length >= 260) {
          const decodedHash = Buffer.from(payload.subarray(244, 260));
          for (let index = 0; index < decodedHash.length; index += 1) {
            decodedHash[index] ^= 0xef;
          }
          hash = decodedHash.toString("hex");
        }
        elements.push({ type: "video", hash });
        rendered.push("[视频]");
      } else {
        if (!unknownTags.includes(item.tag)) unknownTags.push(item.tag);
      }
    }
  } catch (error) {
    warnings.push(
      error instanceof DecodeFailure ? error.message : `消息解析失败: ${error.message}`
    );
  }

  if (rendered.length === 0 && unknownTags.length > 0) {
    rendered.push(`[QQ消息:${unknownTags.join(",")}]`);
  }

  const knownTypes = [...new Set(elements.map((element) => element.type))];
  return {
    headerTime,
    headerRand,
    senderName: displayNames.at(-1) ?? null,
    text: rendered.join(""),
    type:
      knownTypes.length === 0
        ? "unknown"
        : knownTypes.length === 1
          ? knownTypes[0]
          : "mixed",
    elements,
    unknownTags,
    decodeWarnings: warnings
  };
}

function xorString(value) {
  const buffer = Buffer.from(value);
  if (buffer.length > 0xff) throw new DecodeFailure("QQ 字符串超过 255 字节");
  const key = 0xff - buffer.length;
  const output = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index < buffer.length; index += 1) {
    output[index] = buffer[index] ^ key;
  }
  return output;
}

const receiverFieldBytes = Buffer.from(RECEIVER_FIELD, "utf16le");
const receiverLength = Buffer.alloc(2);
receiverLength.writeUInt16LE(receiverFieldBytes.length);
const receiverMarker = Buffer.concat([
  Buffer.from([0x08]),
  receiverLength,
  xorString(receiverFieldBytes)
]);

function extractReceiverNames(info) {
  if (!info) return [];
  const value = Buffer.from(info);
  const names = [];
  let start = 0;

  while (start < value.length) {
    const markerOffset = value.indexOf(receiverMarker, start);
    if (markerOffset < 0) break;
    const lengthOffset = markerOffset + receiverMarker.length;
    if (lengthOffset + 4 > value.length) break;
    const byteLength = value.readUInt32LE(lengthOffset);
    const valueOffset = lengthOffset + 4;
    const valueEnd = valueOffset + byteLength;
    if (
      byteLength > 0 &&
      byteLength <= 0xff &&
      byteLength % 2 === 0 &&
      valueEnd <= value.length
    ) {
      const decoded = xorString(value.subarray(valueOffset, valueEnd)).toString(
        "utf16le"
      );
      if (decoded && ![...decoded].some((character) => character < " ")) {
        names.push(decoded);
      }
    }
    start = valueEnd > markerOffset ? valueEnd : markerOffset + 1;
  }

  return names;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
  DecodeFailure,
  Reader,
  decodeMessage,
  digest,
  extractReceiverNames,
  parseTlvs,
  xorString
};
