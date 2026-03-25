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
  voice?: { file_id: string; duration: number; mime_type?: string };
  caption?: string;
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
      const caption = message.caption || text || "";
      const isLeadContext = /lead|new client|referral|buyer|purchase|mortgage/i.test(caption);
      const photoPrompt = isLeadContext
        ? "This is a lead screenshot. Extract ALL contact and mortgage info. Use zoho_create_full_lead to create the lead. Ask clarifying questions for anything missing (email, purpose, referral source are required). Be concise."
        : "Analyze this image. If it contains lead/contact info, extract it and use zoho_create_full_lead. If it's a bill or receipt, categorize it and log it. If it's a document, describe what it is and suggest next steps.";
      messageContent.push({
        type: "text",
        text: caption ? `${caption}\n\n${photoPrompt}` : photoPrompt,
      });
    } catch (e) {
      messageContent.push({ type: "text", text: text || "I received a photo but couldn't process it." });
    }
  } else if (message.voice) {
    // Handle voice notes -- transcribe via Whisper-compatible API
    try {
      const fileUrl = await getFileUrl(token, message.voice.file_id);
      const audioRes = await fetch(fileUrl);
      const audioBuffer = await audioRes.arrayBuffer();

      // Use OpenAI Whisper API for transcription (or fallback)
      const whisperKey = process.env.OPENAI_API_KEY;
      if (whisperKey) {
        const formData = new FormData();
        const audioBlob = new Blob([audioBuffer], { type: message.voice.mime_type || "audio/ogg" });
        formData.append("file", audioBlob, "voice.ogg");
        formData.append("model", "whisper-1");

        const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${whisperKey}` },
          body: formData,
        });
        const whisperData = await whisperRes.json() as { text?: string };
        const transcript = whisperData.text || "Could not transcribe voice note.";

        messageContent.push({
          type: "text",
          text: `[Voice note transcription]: ${transcript}\n\nProcess this. If it contains lead info, use zoho_create_full_lead. Ask clarifying questions for anything missing.`,
        });
      } else {
        messageContent.push({
          type: "text",
          text: "Voice notes require OpenAI API key for transcription. Please type your message instead, or send a screenshot.",
        });
      }
    } catch (e) {
      messageContent.push({ type: "text", text: "Couldn't process voice note. Try typing or sending a screenshot." });
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
        `Hey ${message.from.first_name}. Flow Agent is live.

What I do best:

NEW LEAD -- screenshot, forward, or type lead info. I create the contact, mortgage, and task Amy to reach out. All in Zoho.

PIPELINE -- "how's my pipeline?" or "what moved this week?"

LOOKUP -- "find John Smith" or "what stage is the Thompson deal?"

EMAILS -- "email Sarah Chen a thank you for the referral"

RATES -- "what are current rates?" or "rate briefing"

PROPERTIES -- rent status, tenant alerts, log expenses

Quick commands:
/lead /partner /pipeline /briefing /status /rates /property

Your Telegram ID: ${userId}

Send me a lead to get started.`
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
/lead - Quick lead intake (screenshot, voice, or text)
/partner - Process partner call (paste notes, get follow-up email)
/briefing - Full daily briefing
/status - Quick status
/task [description] - Create a task
/email [recipient] - Draft an email

Send screenshots, voice notes, or text with lead info. I'll extract details, ask about what's missing, create the contact + mortgage, and task Amy to reach out.`
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

    case "/revenue": {
      await sendTypingAction(token, chatId);
      userAgents[userId] = "pipeline";
      const revResult = await handleToolCall("revenue_dashboard", {});
      await sendMessage(token, chatId, revResult);
      return true;
    }

    case "/partners": {
      await sendTypingAction(token, chatId);
      userAgents[userId] = "pipeline";
      const partResult = await handleToolCall("partner_intelligence", { mode: "followup_suggestions" });
      await sendMessage(token, chatId, partResult);
      return true;
    }

    case "/calc": {
      const calcText = text.replace(/^\/calc\s*/i, "").trim();
      if (!calcText) {
        await sendMessage(token, chatId,
          `Mortgage calculator. Examples:\n\n` +
          `"payment on 500k at 4.5%"\n` +
          `"what can someone afford on 120k income?"\n` +
          `"LTV on 400k mortgage, 500k property"\n\n` +
          `Just type it naturally after /calc or ask me directly.`
        );
        return true;
      }
      message.text = `MORTGAGE CALC REQUEST: ${calcText}\n\nUse the mortgage_calculator tool to answer this.`;
      return false;
    }

    case "/lead": {
      // Switch to pipeline agent for lead context
      userAgents[userId] = "pipeline";
      const leadText = text.replace(/^\/lead\s*/i, "").trim();
      if (!leadText) {
        await sendMessage(token, chatId,
          `Lead intake mode. Send me the lead info:\n\n` +
          `- Screenshot of a text/email/DM\n` +
          `- Voice note with the details\n` +
          `- Or just type it out\n\n` +
          `I'll extract everything, ask about what's missing, and create the contact + mortgage + task Amy to reach out.`
        );
        return true;
      }
      // Has text -- rewrite the message text and let it fall through to Claude
      message.text = `NEW LEAD INTAKE: ${leadText}\n\nExtract all info and use zoho_create_full_lead. Ask clarifying questions for anything missing before creating.`;
      return false;
    }

    case "/partner": {
      const partnerText = text.replace(/^\/partner\s*/i, "").trim();
      if (!partnerText) {
        await sendMessage(token, chatId,
          `Partner call processor. Paste your notes:\n\n` +
          `- Meeting notes or transcript\n` +
          `- Voice note (just record one)\n` +
          `- Quick recap of what you discussed\n\n` +
          `I'll generate a follow-up email in your voice, create the Zoho note + tasks, and email you the draft.`
        );
        return true;
      }
      // Has text -- rewrite and let Claude use the process_partner_call tool
      message.text = `PARTNER CALL NOTES: ${partnerText}\n\nProcess this using process_partner_call tool. Send the full text as-is.`;
      return false;
    }

    default:
      return false; // Not a recognized command, let it fall through to agent
  }
}

function detectAgent(text: string): string {
  const lower = text.toLowerCase();
  if (/property|rent|tenant|strata|mortgage|42 ave|55 ave|53a|peters|landlord|lease|unit|vacancy|kyle|bill|expense|maintenance/i.test(lower)) return "property";
  if (/cx|client experience|post.?funding|nps|renewal|annual review|drip|cadence/i.test(lower)) return "cx";
  if (/rate|rates|interest|variable|fixed|boc|bank of canada|lorenzo|cibc/i.test(lower)) return "rates";
  if (/partner meeting|realtor call|coffee with|met with.*realtor|partner call|follow.?up email.*partner/i.test(lower)) return "pipeline";
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
