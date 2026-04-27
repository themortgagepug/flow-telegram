// Compass coach inbound message handler. Routes Telegram messages from the
// dedicated coach bot to Claude with the operator-stack persona, persists
// conversation in compass_threads.

import { sendMessage, sendTypingAction } from "../telegram";
import { chatWithClaude } from "../claude";
import { COMPASS_SYSTEM_PROMPT } from "./persona";
import { loadCompassHistory, appendCompassMessage } from "./memory";
import { buildCompassContext } from "./context";

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type?: string };
  from: { id: number; first_name?: string };
  text?: string;
  voice?: { file_id: string };
  photo?: Array<{ file_id: string }>;
  date: number;
}

export async function handleCompassMessage(
  message: TelegramMessage,
  token: string,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text ?? "").trim();

  if (!text) {
    await sendMessage(
      token,
      chatId,
      "Coach takes text for now. Voice + photo coming. Type the question.",
    );
    return;
  }

  // Light command surface
  if (text === "/start") {
    await sendMessage(
      token,
      chatId,
      `Coach is awake.

Briefs land at 06:30 / 12:30 / 20:30 PT.
Talk to me anytime. Drill sergeant mode.

Ask the question. I'll answer with a frame named.`,
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      token,
      chatId,
      `Coach commands:

/brief -- on-demand wakeup-style brief
/state -- raw live business state (debug)
/frame <hormozi|martell|ballantyne|buffett|priestley|pg|dunford|naval> <question> -- force a specific frame
/help -- this

Or just talk to me. State the situation, I commit to one move.`,
    );
    return;
  }

  if (text === "/state") {
    await sendTypingAction(token, chatId);
    const ctx = await buildCompassContext();
    const safe = ctx.length > 4000 ? ctx.slice(0, 3990) + "\n…" : ctx;
    await sendMessage(token, chatId, safe);
    return;
  }

  await sendTypingAction(token, chatId);

  // Pull live business context in parallel with history load.
  const [history, liveContext] = await Promise.all([
    loadCompassHistory(userId),
    buildCompassContext(),
  ]);

  await appendCompassMessage(userId, "user", text);

  const composedSystem = `${COMPASS_SYSTEM_PROMPT}\n\n${liveContext}`;

  const reply = await chatWithClaude({
    systemPrompt: composedSystem,
    userMessage: text,
    history,
  });

  const finalText = reply.text || "No reply generated. Try rephrasing.";

  // Telegram has a 4096-char hard cap.
  const safe = finalText.length > 4000 ? finalText.slice(0, 3990) + "\n…" : finalText;

  await sendMessage(token, chatId, safe);
  await appendCompassMessage(userId, "assistant", safe);
}
