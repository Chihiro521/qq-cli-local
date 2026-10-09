"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { allMessages } = require("./database");
const { CliError } = require("./errors");
const { hashFile } = require("./storage");

function nativeLines(group, messages) {
  return [
    JSON.stringify({
      _type: "header",
      format: "qq-cli-jsonl",
      version: 1,
      group
    }),
    ...messages.map((message) =>
      JSON.stringify({ _type: "message", ...message })
    )
  ];
}

function textLines(conversation, messages) {
  return messages.map(
    (message) =>
      `[${message.sentAt}] ${message.senderName}(${message.senderUin}): ${message.text}`
  );
}

function markdownLines(conversation, messages) {
  return [
    `# ${conversation.name}`,
    "",
    `- QQ: ${conversation.peerUin ?? conversation.groupUin}`,
    `- Type: ${conversation.kind ?? "group"}`,
    `- Messages: ${messages.length}`,
    "",
    ...messages.flatMap((message) => [
      `## ${message.sentAt} - ${message.senderName} (${message.senderUin})`,
      "",
      message.text || `*[${message.type}]*`,
      ""
    ])
  ];
}

function exportLines(conversation, messages, options) {
  if (options.format === "chatlab") {
    return chatLabLines(conversation, messages, options.accountUin);
  }
  if (options.format === "markdown") return markdownLines(conversation, messages);
  if (options.format === "text" || options.format === "txt") {
    return textLines(conversation, messages);
  }
  return nativeLines(conversation, messages);
}

function renderExport(database, conversation, options) {
  const messages = allMessages(database, conversation, {
    ...options.filters,
    limit: options.limit ?? null,
    order: "asc"
  });
  return {
    content: `${exportLines(conversation, messages, options).join("\n")}\n`,
    messages
  };
}

function chatLabLines(group, messages, accountUin) {
  const kind = group.kind ?? "group";
  const peerUin = group.peerUin ?? group.groupUin;
  const sourceSessionId = `qq-${accountUin || "unknown"}-${kind}-${peerUin}`;
  const lines = [
    JSON.stringify({
      _type: "header",
      chatlab: {
        version: "0.0.2",
        exportedAt: Math.floor(Date.now() / 1000),
        generator: "qq-cli-local"
      },
      meta: {
        name: group.name,
        platform: "qq",
        type: kind === "group" ? "group" : "private",
        groupId: kind === "group" ? peerUin : null,
        peerId: kind === "buddy" ? peerUin : null,
        sourceSessionId
      }
    })
  ];

  const members = new Map();
  for (const message of messages) {
    members.set(message.senderUin, message.senderName || message.senderUin);
  }
  for (const [sender, name] of members) {
    lines.push(
      JSON.stringify({
        _type: "member",
        platformId: sender,
        accountName: name,
        groupNickname: name
      })
    );
  }
  for (const message of messages) {
    lines.push(
      JSON.stringify({
        _type: "message",
        sender: message.senderUin,
        accountName: message.senderName,
        groupNickname: message.senderName,
        timestamp: message.time,
        type: 0,
        content: message.text,
        platformMessageId: message.id
      })
    );
  }
  return lines;
}

function exportGroup(database, group, options) {
  const output = path.resolve(options.output);
  if (fs.existsSync(output) && !options.force) {
    throw new CliError("OUTPUT_EXISTS", `文件已存在，请加 --force: ${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const { content, messages } = renderExport(database, group, options);
  const temporary = `${output}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temporary, content, "utf8");
    if (fs.existsSync(output)) fs.rmSync(output, { force: true });
    fs.renameSync(temporary, output);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (error instanceof CliError) throw error;
    throw new CliError("EXPORT_FAILED", `导出失败: ${error.message}`);
  }

  return {
    output,
    format: options.format,
    conversationId: group.id ?? `group:${group.groupUin}`,
    conversationKind: group.kind ?? "group",
    peerUin: group.peerUin ?? group.groupUin,
    groupUin: group.groupUin,
    groupName: group.name,
    messageCount: messages.length,
    sha256: hashFile(output)
  };
}

module.exports = {
  chatLabLines,
  exportGroup,
  markdownLines,
  nativeLines,
  renderExport,
  textLines
};
