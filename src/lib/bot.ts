import { sendMessage, sendTypingAction, getFileUrl } from "./telegram";
import { getTeamMember } from "./team";
import {
  getPropertyContext,
  getCXContext,
  getRatesContext,
  getPipelineContext,
  getContentContext,
  getSystemPrompt,
} from "./agents";
import { TOOLS } from "./tools";
import { handleToolCall } from "./tool-handlers";
import { getHistory, addToHistory } from "./memory";

function getAnthropicClient() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Anthropic = require("@anthropic-ai/sdk").default;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

type TelegramMessage = {
  message_id: number;
  from: { id: number; username?: string; first_name: string };
  chat: { id: number; type: string };
  text: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  date: number;
};

// Track which agent each user is currently talking to
const userAgents: Record<number, string> = {};
// Track pending confirmations (e.g., "send it" to confirm an email)
const pendingActions: Record<number, { tool: string; input: Record<string, unknown> }> = {};

export async function handleMessage(message: TelegramMessage, token: string) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.trim() || "";
  const username = message.from.username;

  // Check team access
  const member = getTeamMember(userId, username);
  if (!member) {
    await sendMessage(token, chatId, "Access denied. Contact Alex to get added.");
    return;
  }

  // Show typing indicator
  await sendTypingAction(token, chatId);

  // Handle confirmation replies
  if (pendingActions[userId] && /^(send it|confirm|yes|do it|approved|go ahead)/i.test(text)) {
    const action = pendingActions[userId];
    delete pendingActions[userId];
    action.input.confirm = true;
    const result = await handleToolCall(action.tool, action.input);
    await sendMessage(token, chatId, result);
    return;
  }
  if (pendingActions[userId] && /^(cancel|no|nevermind|nah)/i.test(text)) {
    delete pendingActions[userId];
    await sendMessage(token, chatId, "Cancelled.");
    return;
  }

  // Handle commands
  if (text.startsWith("/")) {
    const handled = await handleCommand(text, message, token, chatId, userId);
    if (handled) return;
  }

  // Build message content (text or text + image)
  const messageContent: Array<Record<string, unknown>> = [];

  // Handle photo messages (screenshots, bills, documents)
  if (message.photo?.length) {
    const largestPhoto = message.photo[message.photo.length - 1];
    try {
      const fileUrl = await getFileUrl(token, largestPhoto.file_id);
      const imageRes = await fetch(fileUrl);
      const imageBuffer = await imageRes.arrayBuffer();
      const base64 = Buffer.from(imageBuffer).toString("base64");
      const mediaType = fileUrl.endsWith(".png") ? "image/png" : "image/jpeg";

      messageContent.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64 },
      });
      messageContent.push({
        type: "text",
        text: text || "Analyze this image. If it contains lead/contact info, extract it and create a lead. If it's a bill or receipt, categorize it and log it. If it's a document, describe what it is and suggest next steps.",
      });
    } catch (e) {
      messageContent.push({ type: "text", text: text || "I received a photo but couldn't process it." });
    }
  } else {
    messageContent.push({ type: "text", text });
  }

  // Determine agent
  const agent = userAgents[userId] || detectAgent(text);
  userAgents[userId] = agent;

  // Get context
  let context = "";
  try {
    switch (agent) {
      case "property": context = await getPropertyContext(); break;
      case "cx": context = await getCXContext(); break;
      case "rates": context = await getRatesContext(); break;
      case "pipeline": context = await getPipelineContext(); break;
      case "content": context = await getContentContext(); break;
      default: context = "No specific context loaded.";
    }
  } catch (e) {
    console.error("Context fetch error:", e);
  }

  // Call Claude with tools + conversation memory
  try {
    const anthropic = getAnthropicClient();

    // Build messages with conversation history
    const history = await getHistory(userId);
    const historyMessages = history.map(h => ({ role: h.role, content: h.content }));

    // Add current message
    const messages: Array<Record<string, unknown>> = [
      ...historyMessages,
      { role: "user", content: messageContent },
    ];

    // Save user message to history
    const userText = typeof messageContent === "string" ? messageContent : text;
    await addToHistory(userId, "user", userText);

    // Send typing indicator periodically
    const typingInterval = setInterval(() => sendTypingAction(token, chatId), 4000);

    let response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: getSystemPrompt(agent) + "\n\nCONTEXT DATA:\n" + context,
      tools: TOOLS,
      messages,
    });

    // Handle tool use loop (up to 5 iterations)
    let iterations = 0;

    while (iterations < 5) {
      // Check if Claude wants to use a tool
      const toolUse = response.content.find((c: Record<string, unknown>) => c.type === "tool_use");
      if (!toolUse) break;

      const toolName = (toolUse as Record<string, unknown>).name as string;
      const toolInput = (toolUse as Record<string, unknown>).input as Record<string, unknown>;
      const toolId = (toolUse as Record<string, unknown>).id as string;

      // For send_email without confirm, store as pending and show draft
      if (toolName === "send_email" && !toolInput.confirm) {
        const result = await handleToolCall(toolName, toolInput);
        pendingActions[userId] = { tool: toolName, input: toolInput };
        await sendMessage(token, chatId, result + "\n\nReply 'send it' to confirm or 'cancel' to discard.");
        return;
      }

      // Execute the tool
      const result = await handleToolCall(toolName, toolInput);

      // Add assistant response and tool result to messages
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: result }],
      });

      // Get next response
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: getSystemPrompt(agent) + "\n\nCONTEXT DATA:\n" + context,
        tools: TOOLS,
        messages,
      });

      iterations++;
    }

    clearInterval(typingInterval);

    // Extract final text response
    const textBlocks = response.content.filter((c: Record<string, unknown>) => c.type === "text");
    const reply = textBlocks.length > 0
      ? textBlocks.map((c: Record<string, unknown>) => c.text).join("\n")
      : "Done.";

    // Save assistant response to history
    await addToHistory(userId, "assistant", reply);

    await sendMessage(token, chatId, reply);
  } catch (error) {
    console.error("Claude error:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg.includes("rate_limit")) {
      await sendMessage(token, chatId, "Rate limited. Wait a moment and try again.");
    } else if (errMsg.includes("overloaded")) {
      await sendMessage(token, chatId, "AI is busy. Try again in 30 seconds.");
    } else {
      await sendMessage(token, chatId, "Something went wrong. Try again or rephrase your request.");
    }
  }
}

async function handleCommand(text: string, message: TelegramMessage, token: string, chatId: number, userId: number): Promise<boolean> {
  const command = text.split(" ")[0].toLowerCase().replace(/@\w+/, "");

  switch (command) {
    case "/start":
      await sendMessage(token, chatId,
        `Welcome to Flow Agent, ${message.from.first_name}!

I'm your AI Chief of Staff. I can:

- Create leads from screenshots
- Send emails & draft letters
- Manage your 4 properties
- Query deals & CRM
- Generate pre-approval letters
- Track rates & renewals
- Log expenses & transactions

Commands:
/property /cx /rates /pipeline /content
/briefing - Daily briefing
/status - Quick overview
/help - All commands

Or just tell me what you need. Send photos of leads, bills, or documents and I'll handle them.

Your ID: ${userId}`
      );
      return true;

    case "/help":
      await sendMessage(token, chatId,
        `Flow Agent Commands:

Agents:
/property - Property management
/cx - Client experience
/rates - Rate intelligence
/pipeline - Deal pipeline
/content - Content engine

Actions:
/briefing - Full daily briefing
/status - Quick status
/lead [name] - Create a lead
/task [description] - Create a task
/email [recipient] - Draft an email

Or just talk to me naturally. Send screenshots to create leads, photos of bills to log expenses.`
      );
      return true;

    case "/briefing":
      await sendTypingAction(token, chatId);
      const result = await handleToolCall("get_daily_briefing", { detail_level: "full" });
      await sendMessage(token, chatId, result);
      return true;

    case "/property":
      userAgents[userId] = "property";
      await sendMessage(token, chatId, "Property Manager active. Ask about your 4 properties, rent, tenants, obligations, or performance.");
      return true;

    case "/cx":
      userAgents[userId] = "cx";
      await sendMessage(token, chatId, "CX Agent active. Ask about post-funding, NPS, renewals, or client tasks.");
      return true;

    case "/rates":
      userAgents[userId] = "rates";
      await sendMessage(token, chatId, "Rates Agent active. Ask about current rates, CIBC renewals, or market trends.");
      return true;

    case "/pipeline":
      userAgents[userId] = "pipeline";
      await sendMessage(token, chatId, "Pipeline Agent active. Ask about deals, team workload, or CRM status.");
      return true;

    case "/content":
      userAgents[userId] = "content";
      await sendMessage(token, chatId, "Content Agent active. Ask about YouTube, IG, emails, or newsletters.");
      return true;

    case "/status":
      await handleStatusCommand(token, chatId);
      return true;

    default:
      return false; // Not a recognized command, let it fall through to agent
  }
}

function detectAgent(text: string): string {
  const lower = text.toLowerCase();
  if (/property|rent|tenant|strata|mortgage|42 ave|55 ave|53a|peters|landlord|lease|unit|vacancy|kyle|bill|expense|maintenance/i.test(lower)) return "property";
  if (/cx|client experience|post.?funding|nps|renewal|annual review|drip|cadence/i.test(lower)) return "cx";
  if (/rate|rates|interest|variable|fixed|boc|bank of canada|lorenzo|cibc/i.test(lower)) return "rates";
  if (/deal|pipeline|zoho|crm|funded|instructed|compliance|james|joana|finmo|lead|pre.?approval/i.test(lower)) return "pipeline";
  if (/content|youtube|video|script|story|carousel|instagram|ig|newsletter|blog|email campaign/i.test(lower)) return "content";
  return "general";
}

async function handleStatusCommand(token: string, chatId: number) {
  try {
    const result = await handleToolCall("get_daily_briefing", { detail_level: "quick" });
    await sendMessage(token, chatId, result);
  } catch {
    await sendMessage(token, chatId, "Error fetching status. Try again.");
  }
}
