const TELEGRAM_API = "https://api.telegram.org/bot";

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML"
) {
  // Telegram has a 4096 char limit per message
  const chunks = splitMessage(text, 4000);

  for (const chunk of chunks) {
    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
  }
}

export async function sendTypingAction(token: string, chatId: number) {
  await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Split at last newline before limit
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }
  return chunks;
}

export async function getFileUrl(token: string, fileId: string): Promise<string> {
  const res = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = await res.json();
  return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
}

export async function sendDocument(
  token: string,
  chatId: number,
  filename: string,
  bytes: Uint8Array,
  caption?: string
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  // Cast to BlobPart to satisfy DOM lib types in this Next.js env
  form.append("document", new Blob([bytes as BlobPart]), filename);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }

  const res = await fetch(`${TELEGRAM_API}${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "<no body>");
    throw new Error(`Telegram sendDocument failed (${res.status}): ${errText.slice(0, 200)}`);
  }
}
