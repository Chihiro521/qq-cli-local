"""Decrypt a Classic PCQQ Msg3.0.db copy for qq-cli.

This helper supports one hash-pinned 32-bit PCQQ build. It reads the key from
the already-open codec context with PROCESS_VM_READ, then performs rekeying in
a disposable 32-bit rundll32 process. The QQ process and source database are
never written to.
"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
from typing import Iterable


QQ_EXE_SHA256 = "e20e6670f31472e4545af1b6115f1a5cc553bbd0da2894b8def41cc3280e2347"
KERNEL_SHA256 = "b39f79c6cf43a5665dabb587f31784c713fbfda55ef0ebdd4a51ac1d0a0ec4e9"
KERNEL_SIZE = 0x1CC000

# Offsets for KernelUtil.dll from PCQQ 9.7.25.29417.
MULTI_DB_VTABLE = 0x15882C
MULTI_DB_MEMBER_VTABLE = 0x181DD8
CODEC_CALLBACK = 0x64107
CODEC_SIZE_CALLBACK = 0x249D
CODEC_FREE_CALLBACK = 0x642CC

OPEN_RVA = 0x579D4
CLOSE_RVA = 0x35980
EXEC_RVA = 0x359A2
INIT_EXT_HEADER_RVA = 0x86A2C
KEY_RVA = 0x86EC3
REKEY_INTERNAL_RVA = 0x870DD

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01
READABLE_PRIVATE_PROTECTIONS = {0x04, 0x08, 0x40, 0x80}


class HelperError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class MemoryBasicInformation(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


class ProcessReader:
    def __init__(self, pid: int):
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel32.OpenProcess.restype = wintypes.HANDLE
        self.kernel32.ReadProcessMemory.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        self.kernel32.ReadProcessMemory.restype = wintypes.BOOL
        self.kernel32.VirtualQueryEx.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            ctypes.POINTER(MemoryBasicInformation),
            ctypes.c_size_t,
        ]
        self.kernel32.VirtualQueryEx.restype = ctypes.c_size_t
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.CloseHandle.restype = wintypes.BOOL

        self.handle = self.kernel32.OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid
        )
        if not self.handle:
            error = ctypes.get_last_error()
            raise HelperError("PROCESS_OPEN_FAILED", f"Cannot read QQ process {pid}: WinError {error}")

    def close(self) -> None:
        if self.handle:
            self.kernel32.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self) -> "ProcessReader":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()

    def read(self, address: int, size: int) -> bytes:
        if address <= 0 or size <= 0:
            raise OSError("Invalid remote memory range")
        buffer = ctypes.create_string_buffer(size)
        read_count = ctypes.c_size_t()
        success = self.kernel32.ReadProcessMemory(
            self.handle,
            ctypes.c_void_p(address),
            buffer,
            size,
            ctypes.byref(read_count),
        )
        if not success or read_count.value != size:
            raise OSError(f"Cannot read remote memory at 0x{address:x}")
        return buffer.raw

    def uint32(self, address: int) -> int:
        return struct.unpack("<I", self.read(address, 4))[0]

    def c_string(self, address: int, maximum: int = 1024) -> str:
        value = self.read(address, maximum).split(b"\0", 1)[0]
        for encoding in ("utf-8", "mbcs"):
            try:
                return value.decode(encoding)
            except UnicodeDecodeError:
                pass
        return value.decode("latin-1", errors="replace")

    def private_writable_regions(self) -> Iterable[tuple[int, int]]:
        address = 0
        maximum = 0x100000000
        information = MemoryBasicInformation()
        information_size = ctypes.sizeof(information)
        while address < maximum:
            result = self.kernel32.VirtualQueryEx(
                self.handle,
                ctypes.c_void_p(address),
                ctypes.byref(information),
                information_size,
            )
            if result == 0:
                break
            base = int(information.BaseAddress or 0)
            size = int(information.RegionSize)
            if size <= 0:
                break
            protection = int(information.Protect)
            if (
                information.State == MEM_COMMIT
                and information.Type == MEM_PRIVATE
                and protection in READABLE_PRIVATE_PROTECTIONS
                and not protection & (PAGE_GUARD | PAGE_NOACCESS)
            ):
                yield base, size
            next_address = base + size
            if next_address <= address:
                break
            address = next_address


def hash_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_path(value: str | Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(value))).replace("/", "\\")


def find_supported_qq():
    try:
        import psutil
    except ImportError as error:
        raise HelperError("DEPENDENCY_MISSING", "Python package psutil is required") from error

    found_qq = False
    unsupported = []
    supported = []
    for process in psutil.process_iter(["name", "exe", "cmdline"]):
        try:
            if process.info["name"] != "QQ.exe" or not process.info["exe"]:
                continue
            found_qq = True
            executable = Path(process.info["exe"])
            kernel = executable.parent / "KernelUtil.dll"
            if not executable.is_file() or not kernel.is_file():
                continue
            exe_hash = hash_file(executable)
            kernel_hash = hash_file(kernel)
            if exe_hash != QQ_EXE_SHA256 or kernel_hash != KERNEL_SHA256:
                unsupported.append({"pid": process.pid, "qqSha256": exe_hash, "kernelSha256": kernel_hash})
                continue

            mappings = process.memory_maps(grouped=False)
            kernel_mappings = [
                mapping
                for mapping in mappings
                if normalized_path(mapping.path) == normalized_path(kernel)
            ]
            if not kernel_mappings:
                continue
            base = min(int(mapping.addr, 16) for mapping in kernel_mappings)
            supported.append((process, executable, kernel, base))
        except (OSError, RuntimeError, psutil.Error):
            continue

    if supported:
        return supported
    if unsupported:
        raise HelperError(
            "UNSUPPORTED_QQ_BUILD",
            "Running QQ.exe does not match supported Classic PCQQ 9.7.25.29417",
        )
    if found_qq:
        raise HelperError("QQ_DATABASE_PROCESS_NOT_FOUND", "No supported QQ process has KernelUtil.dll loaded")
    raise HelperError("QQ_NOT_RUNNING", "Classic PCQQ is not running")


def iter_pattern_addresses(reader: ProcessReader, pattern: bytes) -> Iterable[int]:
    chunk_size = 4 * 1024 * 1024
    overlap_size = len(pattern) - 1
    for region_base, region_size in reader.private_writable_regions():
        offset = 0
        overlap = b""
        while offset < region_size:
            read_size = min(chunk_size, region_size - offset)
            try:
                chunk = reader.read(region_base + offset, read_size)
            except OSError:
                break
            data = overlap + chunk
            search_at = 0
            while True:
                match = data.find(pattern, search_at)
                if match < 0:
                    break
                yield region_base + offset - len(overlap) + match
                search_at = match + 1
            overlap = data[-overlap_size:] if overlap_size else b""
            offset += read_size


def inspect_database_object(
    reader: ProcessReader, object_address: int, kernel_base: int
) -> tuple[str, bytes] | None:
    try:
        header = reader.read(object_address, 0x44)
        value = lambda offset: struct.unpack_from("<I", header, offset)[0]
        if value(0x00) != kernel_base + MULTI_DB_VTABLE:
            return None
        if value(0x08) != kernel_base + MULTI_DB_MEMBER_VTABLE:
            return None
        if value(0x10) != 0x2BF20 or value(0x14) != 16:
            return None
        if value(0x40) != object_address:
            return None

        database = value(0x0C)
        database_array = reader.uint32(database + 0x14)
        btree = reader.uint32(database_array + 0x04)
        shared_btree = reader.uint32(btree + 0x04)
        pager = reader.uint32(shared_btree)
        if reader.uint32(pager + 0xC8) != kernel_base + CODEC_CALLBACK:
            return None
        if reader.uint32(pager + 0xCC) != kernel_base + CODEC_SIZE_CALLBACK:
            return None
        if reader.uint32(pager + 0xD0) != kernel_base + CODEC_FREE_CALLBACK:
            return None

        filename_pointer = reader.uint32(pager + 0xA8)
        filename = reader.c_string(filename_pointer)
        codec = reader.uint32(pager + 0xD4)
        key_blob_pointer = reader.uint32(codec)
        key_blob_length = reader.uint32(codec + 0x04)
        if key_blob_length != 272 or reader.uint32(codec + 0x10) != 8192:
            return None
        blob = reader.read(key_blob_pointer, key_blob_length)
        key = bytes(blob[17 * index + (blob[17 * index + 16] & 0x0F)] for index in range(16))
        return filename, key
    except (OSError, struct.error, ValueError):
        return None


def recover_key(source: Path) -> tuple[dict, bytearray]:
    candidates = []
    process_errors = []
    for process, executable, kernel, kernel_base in find_supported_qq():
        pattern = struct.pack("<I", kernel_base + MULTI_DB_VTABLE)
        try:
            with ProcessReader(process.pid) as reader:
                for address in iter_pattern_addresses(reader, pattern):
                    candidate = inspect_database_object(reader, address, kernel_base)
                    if candidate is None:
                        continue
                    filename, key = candidate
                    if Path(filename).name.casefold() != "msg3.0.db":
                        continue
                    candidates.append((process.pid, executable, kernel, filename, key))
        except HelperError as error:
            process_errors.append(error)

    if not candidates:
        if process_errors:
            raise process_errors[0]
        raise HelperError("KEY_NOT_FOUND", "The running QQ process has no open Msg3.0.db codec context")

    unique_candidates = []
    seen = set()
    for candidate in candidates:
        identity = (candidate[0], normalized_path(candidate[3]), candidate[4])
        if identity not in seen:
            seen.add(identity)
            unique_candidates.append(candidate)
    candidates = unique_candidates

    source_normalized = normalized_path(source)
    exact = [candidate for candidate in candidates if normalized_path(candidate[3]) == source_normalized]
    if len(exact) == 1:
        selected = exact[0]
    elif len(candidates) == 1:
        selected = candidates[0]
    else:
        raise HelperError(
            "DATABASE_AMBIGUOUS",
            "Multiple Msg3.0.db instances are open; pass the path used by the target account",
        )

    pid, executable, kernel, filename, key_bytes = selected
    key = bytearray(key_bytes)
    metadata = {
        "pid": pid,
        "qqExe": os.fspath(executable),
        "kernelUtil": os.fspath(kernel),
        "openDatabase": filename,
        "keyFingerprint": hashlib.sha256(key).hexdigest()[:16],
    }
    return metadata, key


DECRYPT_SCRIPT = r"""
function bytesFromHex(value) {
  const output = [];
  for (let index = 0; index < value.length; index += 2) {
    output.push(parseInt(value.substring(index, index + 2), 16));
  }
  return output;
}

function assertCode(module, offset, expected) {
  const actual = new Uint8Array(module.base.add(offset).readByteArray(expected.length));
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error('KernelUtil code mismatch at RVA 0x' + offset.toString(16));
    }
  }
}

rpc.exports = {
  decrypt(kernelPath, databasePath, keyHex) {
    if (Process.pointerSize !== 4) throw new Error('A 32-bit helper process is required');

    const kernel32 = Process.getModuleByName('kernel32.dll');
    const setDllDirectory = new NativeFunction(
      kernel32.getExportByName('SetDllDirectoryW'), 'bool', ['pointer'], 'stdcall'
    );
    const directory = kernelPath.substring(0, Math.max(kernelPath.lastIndexOf('\\'), kernelPath.lastIndexOf('/')));
    if (!setDllDirectory(Memory.allocUtf16String(directory))) {
      throw new Error('SetDllDirectoryW failed');
    }

    const kernel = Module.load(kernelPath);
    if (kernel.size !== 0x1cc000) throw new Error('Unexpected KernelUtil image size');
    assertCode(kernel, 0x579d4, [0x55, 0x8b, 0xec, 0x51, 0x51]);
    assertCode(kernel, 0x35980, [0x55, 0x8b, 0xec, 0x6a, 0x00]);
    assertCode(kernel, 0x359a2, [0x55, 0x8b, 0xec, 0x83, 0xec, 0x20]);
    assertCode(kernel, 0x86a2c, [0x55, 0x8b, 0xec, 0x83, 0xec, 0x10]);
    assertCode(kernel, 0x86ec3, [0x55, 0x8b, 0xec, 0x56, 0x6b]);
    assertCode(kernel, 0x870dd, [0x55, 0x8b, 0xec, 0x83, 0xec, 0x18]);

    const openDatabase = new NativeFunction(
      kernel.base.add(0x579d4), 'int', ['pointer', 'pointer', 'int', 'pointer'], 'mscdecl'
    );
    const closeDatabase = new NativeFunction(kernel.base.add(0x35980), 'int', ['pointer'], 'mscdecl');
    const execute = new NativeFunction(
      kernel.base.add(0x359a2), 'int', ['pointer', 'pointer', 'pointer', 'pointer', 'pointer'], 'mscdecl'
    );
    const initializeExtendedHeader = new NativeFunction(
      kernel.base.add(0x86a2c), 'int', ['pointer', 'int', 'pointer'], 'mscdecl'
    );
    const applyKey = new NativeFunction(
      kernel.base.add(0x86ec3), 'int', ['pointer', 'pointer', 'int'], 'mscdecl'
    );
    const removeKey = new NativeFunction(
      kernel.base.add(0x870dd), 'int', ['pointer', 'pointer', 'int'], 'mscdecl'
    );

    const pathPointer = Memory.allocUtf8String(databasePath);
    const databasePointer = Memory.alloc(Process.pointerSize);
    databasePointer.writePointer(NULL);
    const keyPointer = Memory.alloc(16);
    keyPointer.writeByteArray(bytesFromHex(keyHex));
    const pageSizeSql = Memory.allocUtf8String('PRAGMA page_size=8192;');
    const testSql = Memory.allocUtf8String('SELECT count(*) FROM sqlite_master;');

    const result = {
      open: openDatabase(pathPointer, databasePointer, 2, NULL),
      pageSize: null,
      extendedHeader: null,
      key: null,
      readBefore: null,
      rekey: null,
      readAfter: null,
      close: null
    };
    const database = databasePointer.readPointer();
    if (database.isNull()) return result;

    try {
      result.pageSize = execute(database, pageSizeSql, NULL, NULL, NULL);
      result.extendedHeader = initializeExtendedHeader(database, 1024, NULL);
      result.key = applyKey(database, keyPointer, 16);
      result.readBefore = execute(database, testSql, NULL, NULL, NULL);
      if (result.key !== 0 || result.readBefore !== 0) return result;
      result.rekey = removeKey(database, NULL, 0);
      result.readAfter = execute(database, testSql, NULL, NULL, NULL);
    } finally {
      result.close = closeDatabase(database);
    }
    return result;
  }
};
"""


def decrypt_work_copy(kernel_path: Path, work_path: Path, key: bytes) -> dict:
    try:
        import frida
    except ImportError as error:
        raise HelperError("DEPENDENCY_MISSING", "Python package frida is required") from error

    helper_executable = Path(os.environ.get("WINDIR", r"C:\Windows")) / "SysWOW64" / "rundll32.exe"
    if not helper_executable.is_file():
        raise HelperError("HELPER_NOT_FOUND", f"32-bit rundll32 not found: {helper_executable}")

    pid = None
    session = None
    try:
        device = frida.get_local_device()
        pid = device.spawn([os.fspath(helper_executable)])
        session = device.attach(pid)
        script = session.create_script(DECRYPT_SCRIPT)
        script.load()
        result = script.exports_sync.decrypt(
            os.fspath(kernel_path), os.fspath(work_path), key.hex()
        )
    except Exception as error:
        raise HelperError("DECRYPT_PROCESS_FAILED", f"PCQQ decrypt helper failed: {error}") from error
    finally:
        if session is not None:
            try:
                session.detach()
            except Exception:
                pass
        if pid is not None:
            try:
                device.kill(pid)
            except Exception:
                pass

    required_zero = ("open", "pageSize", "extendedHeader", "key", "readBefore", "rekey", "readAfter", "close")
    failures = {name: result.get(name) for name in required_zero if result.get(name) != 0}
    if failures:
        raise HelperError("DECRYPT_FAILED", f"KernelUtil decrypt returned errors: {failures}")
    return result


def copy_locked(source: Path, target: Path) -> None:
    if target.exists():
        target.unlink()
    command = ["esentutl", "/y", os.fspath(source), "/d", os.fspath(target), "/o"]
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except OSError as error:
        raise HelperError("COPY_FAILED", f"Cannot start esentutl: {error}") from error
    if completed.returncode != 0 or not target.is_file():
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        raise HelperError("COPY_FAILED", f"Cannot copy live database{suffix}")


def remove_files(*paths: Path) -> None:
    for file_path in paths:
        try:
            file_path.unlink(missing_ok=True)
        except OSError:
            pass


def copy_optional_sidecar(source: Path, target: Path) -> str | None:
    if not source.is_file():
        return None
    copy_locked(source, target)
    return hash_file(target)


ROLLBACK_JOURNAL_MAGIC = b"\xd9\xd5\x05\xf9\x20\xa1\x63\xd7"


def has_active_rollback_journal_header(snapshot: Path) -> bool:
    if not snapshot.is_file() or snapshot.stat().st_size <= 512:
        return False
    with snapshot.open("rb") as stream:
        return stream.read(len(ROLLBACK_JOURNAL_MAGIC)) == ROLLBACK_JOURNAL_MAGIC


def snapshot_live_database(source: Path, work_path: Path, attempts: int = 5) -> str:
    source_journal = Path(f"{source}-journal")
    source_wal = Path(f"{source}-wal")
    if source_wal.is_file() and source_wal.stat().st_size:
        raise HelperError("DATABASE_MODE_UNSUPPORTED", "Live PCQQ WAL snapshots are not supported")

    first = work_path.with_name(f"{work_path.name}.snapshot-a")
    second = work_path.with_name(f"{work_path.name}.snapshot-b")
    journal_before = work_path.with_name(f"{work_path.name}.journal-before")
    journal_after = Path(f"{work_path}-journal")
    last_error = None
    for _attempt in range(attempts):
        remove_files(work_path, first, second, journal_before, journal_after)
        try:
            before_hash = copy_optional_sidecar(source_journal, journal_before)
            before_active = has_active_rollback_journal_header(journal_before)
            copy_locked(source, first)
            first_hash = hash_file(first)
            copy_locked(source, second)
            second_hash = hash_file(second)
            after_hash = copy_optional_sidecar(source_journal, journal_after)
            after_active = has_active_rollback_journal_header(journal_after)
            journal_stable = before_hash == after_hash
            journal_requires_stability = before_active or after_active
            if first_hash == second_hash and (not journal_requires_stability or journal_stable):
                os.replace(second, work_path)
                remove_files(first, journal_before)
                return second_hash
        except (HelperError, OSError) as error:
            last_error = error
        time.sleep(0.1)

    remove_files(work_path, first, second, journal_before, journal_after)
    detail = f": {last_error}" if last_error else ""
    raise HelperError(
        "SNAPSHOT_UNSTABLE",
        f"The live database changed during every snapshot attempt{detail}",
    )


def validate_plain_database(database_path: Path) -> str:
    try:
        database = sqlite3.connect(f"file:{database_path.as_posix()}?mode=ro", uri=True)
        try:
            result = database.execute("PRAGMA quick_check").fetchone()
        finally:
            database.close()
    except sqlite3.Error as error:
        raise HelperError("DATABASE_INVALID", f"Decrypted database is invalid: {error}") from error
    if not result or result[0] != "ok":
        raise HelperError("DATABASE_INVALID", f"Decrypted database quick_check failed: {result}")
    return result[0]


def install_plain_output(work_path: Path, output_path: Path) -> None:
    with work_path.open("rb") as source:
        header = source.read(1040)
    if header.startswith(b"SQLite format 3\0"):
        offset = 0
    elif header[1024:].startswith(b"SQLite format 3\0"):
        offset = 1024
    else:
        raise HelperError("DECRYPT_FAILED", "Rekeyed copy has no plaintext SQLite header")

    temporary = output_path.with_name(f"{output_path.name}.{os.getpid()}.tmp")
    try:
        with work_path.open("rb") as source, temporary.open("wb") as destination:
            source.seek(offset)
            shutil.copyfileobj(source, destination, 1024 * 1024)
        validate_plain_database(temporary)
        os.replace(temporary, output_path)
    finally:
        if temporary.exists():
            temporary.unlink()


def decrypt_database(source: Path, output: Path) -> dict:
    if sys.platform != "win32":
        raise HelperError("UNSUPPORTED_PLATFORM", "Classic PCQQ decryption requires Windows")
    if not source.is_file():
        raise HelperError("DATABASE_NOT_FOUND", f"Database does not exist: {source}")
    if source.name.casefold() != "msg3.0.db":
        raise HelperError("INVALID_DATABASE_NAME", "Classic PCQQ database must be named Msg3.0.db")
    if normalized_path(source) == normalized_path(output):
        raise HelperError("UNSAFE_OUTPUT", "Output must not overwrite the source database")

    metadata, key = recover_key(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    work_path = output.with_name(f"{output.name}.{os.getpid()}.encrypted")
    work_journal = Path(f"{work_path}-journal")
    try:
        source_snapshot_sha256 = snapshot_live_database(source, work_path)
        results = decrypt_work_copy(Path(metadata["kernelUtil"]), work_path, key)
        install_plain_output(work_path, output)
    finally:
        for index in range(len(key)):
            key[index] = 0
        remove_files(work_journal, work_path)

    return {
        **metadata,
        "source": os.fspath(source),
        "sourceSnapshotSha256": source_snapshot_sha256,
        "output": os.fspath(output),
        "quickCheck": "ok",
        "sha256": hash_file(output),
        "engine": "Classic PCQQ 9.7.25.29417 KernelUtil.dll",
        "returnCodes": results,
    }


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Decrypt a Classic PCQQ Msg3.0.db copy")
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe = subparsers.add_parser("probe", help="Find the open database key without exposing it")
    probe.add_argument("--source", required=True, type=Path)

    decrypt = subparsers.add_parser("decrypt", help="Decrypt the source into a plaintext output")
    decrypt.add_argument("--source", required=True, type=Path)
    decrypt.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    try:
        arguments = parse_arguments()
        source = arguments.source.resolve()
        if arguments.command == "probe":
            metadata, _key = recover_key(source)
            result = {**metadata, "source": os.fspath(source)}
            for index in range(len(_key)):
                _key[index] = 0
        else:
            result = decrypt_database(source, arguments.output.resolve())
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=True))
        return 0
    except HelperError as error:
        print(
            json.dumps(
                {"ok": False, "error": {"code": error.code, "message": str(error)}},
                ensure_ascii=True,
            ),
            file=sys.stderr,
        )
        return 2
    except Exception as error:
        print(
            json.dumps(
                {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": str(error)}},
                ensure_ascii=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
