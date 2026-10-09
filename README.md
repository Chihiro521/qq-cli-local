# qq-cli

`qq-cli` 是一个面向 Windows 的 Classic PCQQ 本地消息命令行工具。它可以读取本地 QQ 消息数据库，查询会话和消息、搜索内容、查看统计，并导出聊天记录。

## 功能

- 列出群聊、私聊和系统会话，按会话查看历史消息。
- 按关键词、会话、时间和消息类型搜索，并统计会话消息。
- 将消息导出为 Markdown、纯文本、JSONL 或 ChatLab 格式。
- 查询本地收藏，并根据本工具保存的检查点查看新增消息。
- 为后续 AI 总结整理分块消息和引用；`summarize` 只生成本地素材，不调用模型或联网。

## 环境要求

- Windows x64。
- Node.js `>=22.5`。
- 使用加密数据库时，需要 Classic PCQQ `9.7.25.29417` x86 正在运行并登录目标账号；同时需要 Python `>=3.10` 及 `frida`、`psutil`：

  ```powershell
  python -m pip install frida psutil
  ```

- 使用标准明文 SQLite 数据库时，不需要启动 QQ，也不需要上述 Python 依赖。

## 安装

### 从 Git 仓库安装

```powershell
git clone https://github.com/Chihiro521/qq-cli-local.git
Set-Location qq-cli-local
npm install --global .
```

### 从 npm 安装

```powershell
npm install --global qq-cli-local
```

也可以在项目目录运行 `npm install --global .` 从本地源码安装，或先运行 `npm pack` 生成 `.tgz` 包。

安装后运行 `qq-cli --help` 查看命令。

## 首次配置

将示例路径和 UIN 替换为自己的本地 `Msg3.0.db` 路径及 QQ 账号 UIN，然后导入数据库并检查状态：

```powershell
qq-cli init --db "D:\QQ-data\123456789\Msg3.0.db" --account-uin 123456789
qq-cli refresh
qq-cli status --format text
```

`refresh` 会从已配置的数据源更新本地查询缓存。配置、缓存和检查点默认保存在 `%LOCALAPPDATA%\qq-cli`，不会写回源数据库。需要使用另一份配置时，可在命令中添加 `--config "D:\path\config.json"`。

## 常用命令

默认结果为 JSON，添加 `--format text` 可切换为便于阅读的文本输出。

```powershell
# 列出最近的会话
qq-cli sessions --limit 10 --format text

# 查看某个群最近 7 天的消息
qq-cli history group:1234567890 --days 7 --limit 20 --format text

# 搜索指定会话中的关键词
qq-cli search "关键词" --chat group:1234567890 --days 30 --format text

# 导出某个群最近 7 天的记录
qq-cli export group:1234567890 --days 7 --format markdown --output ".\chat.md"

# 查看会话统计、联系人和收藏
qq-cli stats group:1234567890 --days 30
qq-cli contacts --limit 20
qq-cli favorites --limit 20
```

`CHAT` 可以写成 `group:<群号>`、`buddy:<QQ号>`、群号、完整名称或唯一名称片段。裸数字优先匹配群聊。时间参数支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:MM` 和 `YYYY-MM-DD HH:MM:SS`；日期形式的结束日期会包含当天。

完整命令列表：

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

`unread` 和 `new-messages` 根据 qq-cli 自己的检查点判断变化，不代表 QQ 客户端的官方未读数。首次运行 `new-messages` 会建立基线。

## 发布

CI 会在推送到 `main` 时运行测试。将 `package.json` 版本号更新并推送对应的 `v` 标签后，GitHub Actions 会运行测试并发布到 npm：

```powershell
npm version patch
git push origin main --follow-tags
```

首次启用需要 npm 账号已开启双重认证，并完成一次本地发布以创建包：

```powershell
npm login --auth-type=web
npm publish --access public
```

包创建后，使用 npm `>=11.15.0` 添加 GitHub Actions Trusted Publisher。下面的命令临时使用新版 npm，不更改本机全局 npm 版本；按提示在浏览器完成身份验证：

```powershell
npm exec --yes --package 'npm@^11.15.0' -- npm trust github qq-cli-local --repo Chihiro521/qq-cli-local --file publish.yml --allow-publish --yes
```

也可以在 npm 包设置的 Trusted Publisher 中填写 GitHub 用户 `Chihiro521`、仓库 `qq-cli-local`、工作流文件 `publish.yml`，并启用 **Allow npm publish**。完成后，推送与包版本一致的 `v` 标签即可自动发布，后续发版使用 OIDC 身份验证。

## 开发

```powershell
npm test
npm pack
```

实现细节和数据库处理边界见 [DESIGN.md](DESIGN.md)。

## 数据范围

- `contacts` 只列出消息库中观察到的私聊对象，不是完整好友列表。
- `members` 只列出所选群消息中观察到的发言者，不是完整群成员列表。
- `favorites` 对 `MyCollection\mc3.db` 中可验证的文本/XML 字段做保守提取，未能完整解析的内容会附带提示。
- `summarize` 只在本地生成消息素材和引用，不发送消息或调用在线服务。
- `status` 中的能力标记用于说明各项数据覆盖范围。

## 适配范围

加密数据库支持锁定到经校验的 Classic PCQQ `9.7.25.29417` x86，不支持 QQNT。工具只读取源数据库；处理加密库时在临时副本上工作，不会自动启动、关闭或重启 QQ。缓存、收藏结果和导出文件可能包含明文聊天内容，请妥善保管。
