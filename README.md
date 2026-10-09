# qq-cli

English | [简体中文](https://github.com/Chihiro521/qq-cli-local/blob/main/README.zh-CN.md)

`qq-cli` is a Windows command-line tool for reading local Classic PCQQ message history. Browse conversations, search messages, view statistics, and export chat records from a local QQ message database.

[Installation guide (Chinese)](https://chihiro521.github.io/qq-cli-local/) · [npm package](https://www.npmjs.com/package/qq-cli-local) · [GitHub Releases](https://github.com/Chihiro521/qq-cli-local/releases)

## Features

- List group, private, and system conversations and browse their message history.
- Search by keyword, conversation, time, and message type, and view conversation statistics.
- Export messages as Markdown, plain text, JSONL, or ChatLab files.
- Read local favorites and find new messages using checkpoints saved by this tool.
- Prepare message chunks and references for later AI summarization. `summarize` generates local material without calling a model or accessing the network.

## Requirements

- Windows x64.
- Node.js `>=22.5`.
- For encrypted databases: Classic PCQQ `9.7.25.29417` x86 must be running and signed in to the target account. Python `>=3.10`, `frida`, and `psutil` are also required:

  ```powershell
  python -m pip install frida psutil
  ```

- Standard, unencrypted SQLite databases can be read directly without a running QQ client or the Python dependencies above.

## Installation

### Install from npm (recommended)

```powershell
npm install --global qq-cli-local
qq-cli --help
```

The npm package is named **`qq-cli-local`**; the installed command is **`qq-cli`**.

### Install from Git

```powershell
git clone https://github.com/Chihiro521/qq-cli-local.git
Set-Location qq-cli-local
npm install --global .
```

You can also install a local checkout with `npm install --global .`, or download a `.tgz` archive from GitHub Releases and install it with `npm install --global .\qq-cli-local-VERSION.tgz`. Replace `VERSION` with the version in the downloaded filename.

Run `qq-cli --help` to see the available commands.

## Initial setup

Replace the example path and UIN with your local `Msg3.0.db` path and QQ account UIN, then import the database and check its status:

```powershell
qq-cli init --db "D:\QQ-data\123456789\Msg3.0.db" --account-uin 123456789
qq-cli refresh
qq-cli status --format text
```

`refresh` updates the local query cache from the configured data source. Configuration, caches, and checkpoints are stored in `%LOCALAPPDATA%\qq-cli` by default. The source database is read-only. To use a different configuration file, add `--config "D:\path\config.json"` to the command.

## Common commands

Results are JSON by default. Add `--format text` for readable text output.

```powershell
# List recent conversations
qq-cli sessions --limit 10 --format text

# Read the last 7 days of a group's messages
qq-cli history group:1234567890 --days 7 --limit 20 --format text

# Search a specific conversation
qq-cli search "keyword" --chat group:1234567890 --days 30 --format text

# Export the last 7 days of a group's history
qq-cli export group:1234567890 --days 7 --format markdown --output ".\chat.md"

# View statistics, observed contacts, and favorites
qq-cli stats group:1234567890 --days 30
qq-cli contacts --limit 20
qq-cli favorites --limit 20
```

`CHAT` accepts `group:<group-number>`, `buddy:<QQ-number>`, a group number, a full conversation name, or a unique name fragment. Bare numbers match group conversations first. Time filters accept `YYYY-MM-DD`, `YYYY-MM-DD HH:MM`, and `YYYY-MM-DD HH:MM:SS`. An end date given without a time includes the entire day.

Full command list:

```text
qq-cli init --db PATH [--account-uin UIN]
qq-cli refresh [--db PATH] [--account-uin UIN]
qq-cli status
qq-cli sessions [--kind all|group|buddy] [--query TEXT] [--limit 20]
qq-cli history CHAT [--limit 50] [--offset N] [--before TIME:RAND]
                   [--start-time TIME] [--end-time TIME] [--days N]
                   [--type TYPE] [--sender UIN] [--media] [--order asc|desc]
qq-cli search KEYWORD [--chat CHAT ...] [--limit 20] [--offset N]
                  [--start-time TIME] [--end-time TIME] [--days N] [--type TYPE]
qq-cli stats CHAT [--start-time TIME] [--end-time TIME] [--days N] [--top N]
qq-cli summarize CHAT [--days N] [--limit 500] [--chunk-size 80] [--prompt TEXT]
qq-cli contacts [--query TEXT] [--detail CHAT] [--limit 50]
qq-cli members GROUP [--limit 50]
qq-cli favorites [--query TEXT] [--type TYPE] [--limit 20] [--db PATH]
qq-cli unread [--limit 20]
qq-cli new-messages
qq-cli export CHAT [--output FILE] [--format markdown|txt|jsonl|chatlab]
                 [--start-time TIME] [--end-time TIME] [--days N] [--limit N] [--force]
qq-cli clean [--all]
```

`unread` and `new-messages` compare messages against qq-cli's own checkpoints. These counts are independent of the QQ client's unread counts. The first `new-messages` run establishes a baseline.

## Publishing

CI runs tests on pushes to `main`. After updating the version in `package.json` and pushing a matching `v` tag, GitHub Actions runs tests, publishes to npm using OIDC, and creates a GitHub Release with a `.tgz` archive. Changes to `docs/` automatically deploy the installation guide to GitHub Pages.

```powershell
npm version patch
git push origin main --follow-tags
```

### Bootstrap publishing for a new package

The npm account needs two-factor authentication enabled. Publish once locally to create the package:

```powershell
npm login --auth-type=web
npm publish --access public
```

Once the package exists, use npm `>=11.15.0` to add a GitHub Actions Trusted Publisher. This command temporarily uses a newer npm version while keeping the global npm installation unchanged. Complete the browser authentication when prompted:

```powershell
npm exec --yes --package 'npm@^11.15.0' -- npm trust github qq-cli-local --repo Chihiro521/qq-cli-local --file publish.yml --allow-publish --yes
```

Alternatively, configure a Trusted Publisher in the npm package settings with GitHub owner `Chihiro521`, repository `qq-cli-local`, and workflow file `publish.yml`, and enable **Allow npm publish**. Subsequent releases use OIDC authentication and are triggered by a `v` tag that matches the package version.

## Development

```powershell
npm test
npm pack
```

See [DESIGN.md (Chinese)](DESIGN.md) for implementation details and database processing behavior.

## Data coverage

- `contacts` lists private-chat participants observed in the message database.
- `members` lists senders observed in the selected group's messages.
- `favorites` extracts verifiable text/XML fields from `MyCollection\mc3.db` and includes hints for content that could not be fully parsed.
- `summarize` generates local message material and references for later summarization.
- Capability flags in `status` describe which data is covered.

## Compatibility

Encrypted database support is pinned to the verified Classic PCQQ `9.7.25.29417` x86 build. QQNT is not supported. The tool reads the source database and processes encrypted databases through a temporary copy. It does not automatically start, close, or restart QQ. Caches, favorites output, and exports can contain plain-text chat content.
