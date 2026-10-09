"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { validateDatabase } = require("./database");
const { decryptDatabase } = require("./decrypt");
const { CliError } = require("./errors");

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii");
const PCQQ_MAGIC = Buffer.from("SQLite header 3", "ascii");

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function detectDatabaseType(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const header = Buffer.alloc(16);
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.equals(SQLITE_MAGIC)) return "plaintext";
  if (header.subarray(0, PCQQ_MAGIC.length).equals(PCQQ_MAGIC)) return "pcqq-encrypted";
  return "unknown";
}

function replaceDatabase(temporary, target, backup) {
  if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try {
    fs.renameSync(temporary, target);
    if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(backup)) {
      fs.renameSync(backup, target);
    }
    throw error;
  }
}

function removeTemporaryArtifacts(temporary) {
  try {
    fs.rmSync(temporary, { force: true });
  } catch {}
  const directory = path.dirname(temporary);
  const prefix = `${path.basename(temporary)}.`;
  try {
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.startsWith(prefix)) continue;
      try {
        fs.rmSync(path.join(directory, entry), { force: true });
      } catch {}
    }
  } catch {}
}

function hasActiveSidecar(databasePath) {
  return ["-wal", "-journal"].some((suffix) => {
    const sidecar = `${databasePath}${suffix}`;
    try {
      return fs.statSync(sidecar).size > 0;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
}

function installDatabase(sourcePath, targetPath) {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (!fs.existsSync(source)) {
    throw new CliError("DATABASE_NOT_FOUND", `数据库不存在: ${source}`);
  }
  let sourceType;
  try {
    sourceType = detectDatabaseType(source);
  } catch (error) {
    throw new CliError("DATABASE_OPEN_FAILED", `无法读取数据库头: ${error.message}`);
  }
  if (source.toLocaleLowerCase() === target.toLocaleLowerCase()) {
    if (sourceType !== "plaintext") {
      throw new CliError("UNSAFE_OUTPUT", "加密源数据库不能与明文缓存使用同一路径");
    }
    validateDatabase(source);
    const sha256 = hashFile(source);
    return {
      source,
      target,
      sourceType,
      sourceSha256: sha256,
      cacheSha256: sha256,
      sha256,
      copied: false,
      decryption: null
    };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  const backup = `${target}.${process.pid}.bak`;

  try {
    let sourceSha256;
    let decryption = null;
    if (sourceType === "plaintext") {
      if (hasActiveSidecar(source)) {
        throw new CliError(
          "DATABASE_BUSY",
          "明文数据库存在活动的 WAL 或 journal；请先生成稳定副本后再导入"
        );
      }
      validateDatabase(source);
      fs.copyFileSync(source, temporary);
      sourceSha256 = hashFile(source);
      if (sourceSha256 !== hashFile(temporary)) {
        throw new CliError("COPY_FAILED", "数据库复制前后 SHA-256 不一致");
      }
    } else if (sourceType === "pcqq-encrypted") {
      decryption = decryptDatabase(source, temporary);
      sourceSha256 = decryption.sourceSnapshotSha256;
    } else {
      throw new CliError(
        "DATABASE_FORMAT_UNSUPPORTED",
        "输入既不是明文 SQLite，也不是支持的 Classic PCQQ 加密 Msg3.0.db"
      );
    }

    validateDatabase(temporary);
    const cacheSha256 = hashFile(temporary);
    if (decryption && cacheSha256 !== decryption.sha256) {
      throw new CliError("DECRYPT_FAILED", "解密产物 SHA-256 校验不一致");
    }

    replaceDatabase(temporary, target, backup);

    return {
      source,
      target,
      sourceType,
      sourceSha256,
      cacheSha256,
      sha256: cacheSha256,
      copied: true,
      decryption
    };
  } catch (error) {
    removeTemporaryArtifacts(temporary);
    if (error instanceof CliError) throw error;
    throw new CliError("COPY_FAILED", `复制数据库失败: ${error.message}`);
  }
}

module.exports = { detectDatabaseType, hashFile, installDatabase };
