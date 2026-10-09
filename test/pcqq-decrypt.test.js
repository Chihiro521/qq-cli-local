"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const HELPER = path.join(__dirname, "..", "src", "pcqq_decrypt.py");

function runPython(script, args = []) {
  return spawnSync(process.env.QQ_CLI_PYTHON || "python", ["-c", script, HELPER, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
}

test("relaxes changing persistent rollback journals but keeps active journals strict", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-cli-snapshot-test-"));
  try {
    const result = runPython(String.raw`
import importlib.util
import shutil
import sys
from pathlib import Path

helper = Path(sys.argv[1])
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pcqq_decrypt_test", helper)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

source = root / "Msg3.0.db"
work = root / "work.db"
source.write_bytes(b"stable database")
Path(f"{source}-journal").write_bytes(b"placeholder")

original_copy_locked = m.copy_locked
original_copy_optional_sidecar = m.copy_optional_sidecar

def plain_copy(source_path, target_path):
    shutil.copyfile(source_path, target_path)

m.copy_locked = plain_copy

try:
    persistent_states = [b"\\x00" * 520 + b"a", b"\\x00" * 520 + b"b"]
    persistent_index = {"value": 0}
    def copy_persistent(_source, target):
        data = persistent_states[persistent_index["value"]]
        persistent_index["value"] += 1
        target.write_bytes(data)
        return m.hash_file(target)
    m.copy_optional_sidecar = copy_persistent
    result = m.snapshot_live_database(source, work, attempts=1)
    assert result == m.hash_file(work)

    hot_states = [
        m.ROLLBACK_JOURNAL_MAGIC + b"\\x00" * 504 + b"a",
        m.ROLLBACK_JOURNAL_MAGIC + b"\\x00" * 504 + b"b",
    ]
    hot_index = {"value": 0}
    def copy_hot(_source, target):
        data = hot_states[hot_index["value"]]
        hot_index["value"] += 1
        target.write_bytes(data)
        return m.hash_file(target)
    m.copy_optional_sidecar = copy_hot
    try:
        m.snapshot_live_database(source, work, attempts=1)
    except m.HelperError as error:
        assert error.code == "SNAPSHOT_UNSTABLE"
    else:
        raise AssertionError("changing active rollback journal should remain unstable")
finally:
    m.copy_locked = original_copy_locked
    m.copy_optional_sidecar = original_copy_optional_sidecar
`, [directory]);

    assert.equal(result.status, 0, `python helper test failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
