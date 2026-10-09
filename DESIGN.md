# qq-cli Implementation Notes

## Pipeline

```text
Classic PCQQ encrypted Msg3.0.db (or plaintext SQLite)
  -> recover the running codec key read-only when required
  -> take stable source/journal snapshots
  -> decrypt only a temporary copy in an isolated 32-bit helper
  -> quick_check + integrity_check
  -> %LOCALAPPDATA%\qq-cli\cache\Msg3.0.db
  -> sessions/history/search/stats/export/checkpoints
```

The Node query process opens SQLite with `readOnly: true` and `PRAGMA query_only = ON`. Python handles only the version-locked PCQQ key recovery and copy decryption path.

## Storage

```text
%LOCALAPPDATA%\qq-cli\
  config.json
  state.json
  cache\Msg3.0.db
```

`state.json` contains CLI checkpoints only. It is identity-bound to the account and source path, written atomically, and never stored beside or over the QQ source database.

Plaintext imports are validated, copied to a temporary destination, hash-checked, validated again, and atomically installed. A plaintext source with active SQLite sidecars is rejected.

For encrypted sources, the implementation:

1. Verifies exact `QQ.exe` and `KernelUtil.dll` SHA-256 hashes for PCQQ `9.7.25.29417` x86.
2. Uses `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` to recover the 16-byte key from an already-open codec without writing QQ memory or persisting the key.
3. Uses `esentutl /y` twice and compares snapshots so a changing database/journal pair is rejected.
4. Loads the verified 32-bit `KernelUtil.dll` in a temporary `rundll32` process and runs `open -> key -> rekey(NULL, 0) -> close` only on the copy.
5. Removes the PCQQ extension header, validates SQLite integrity, and atomically replaces the cache.

## Conversation Model

The query layer recognizes exact table names:

```text
group_<uin>   -> group:<uin>
buddy_<uin>   -> buddy:<uin>
system_<id>   -> system:<id>
```

Each supported table must expose `Time`, `Rand`, `SenderUin`, `MsgContent`, and `Info`. Existing group message IDs remain `<groupUin>:<Time_u32>:<Rand_u32>` for compatibility. Other IDs include their kind prefix.

Conversation names are taken conservatively from the latest usable `strRecieverShowName` value in `Info`; absent values use an explicit fallback. A bare numeric selector prefers a group. Kind-prefixed selectors are unambiguous.

## Query Semantics

- All timestamps and cursors compare `Time` and `Rand` as unsigned 32-bit values.
- `history` supports offset pagination or descending keyset pagination; nonzero `--offset` and `--before` are mutually exclusive.
- Date-only end bounds include local `23:59:59`; `--days` uses local calendar midnights through the current second.
- Search applies conversation, time, type, and text filters before global offset/limit slicing.
- Message filtering is decoder-backed. Unsupported content remains `unknown` instead of being guessed.
- Media enrichment only reports resolvable stored paths and local existence; it does not download anything.

Current decoded `MsgContent` tags include text, face, group/private image, voice, display name, and video. Unknown or truncated TLVs remain visible through `unknownTags` and `decodeWarnings`.

## Approximate Capabilities

Classic PCQQ does not expose a verified authoritative schema here for all contacts, all group members, or current QQ unread counts. The CLI therefore makes these boundaries explicit:

- Contacts are correspondents observed in `buddy_<uin>` tables.
- Members are senders observed in a selected group table.
- Unread/new messages are messages newer than this CLI's own checkpoint.
- Favorites use conservative text and XML extraction from `MyCollection\mc3.db` blobs.
- Summarization emits local model-ready evidence and references but performs no AI or network call.

No unavailable field is fabricated from unverified databases or protocol guesses.

## Exports

- JSONL: one header followed by normalized messages.
- ChatLab: stable source and platform message IDs for group or private conversations.
- Markdown and text: human-readable chronological messages.
- File writes use a temporary file and atomic rename. Existing files require `--force`.

## Limits

- Encrypted database support is version/hash locked to the tested Classic PCQQ build.
- QQNT is unsupported.
- The CLI never starts, stops, restarts, or injects into QQ.
- Source databases are never modified.
