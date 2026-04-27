import { sendMessage, sendTypingAction, getFileUrl } from "./telegram";
import { getTeamMember } from "./team";
import {
  getPropertyContext,
  getCXContext,
  getRatesContext,
  getPipelineContext,
  getContentContext,
  getSystemPrompt,
  getBrainContext,
} from "./agents";
import { handleToolCall } from "./tool-handlers";
import { getHistory, addToHistory } from "./memory";
import { chatWithClaude } from "./claude";
import { logActivity, HELP_TEXT as LOG_HELP } from "./activity-log";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  // Build the user message + save any attached photo to disk so Claude can read it
  let userMessage = text;
  let imagePath: string | undefined;

  if (message.photo?.length) {
    const largestPhoto = message.photo[message.photo.length - 1];
    try {
      const fileUrl = await getFileUrl(token, largestPhoto.file_id);
      const imageRes = await fetch(fileUrl);
      const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
      const ext = fileUrl.endsWith(".png") ? "png" : "jpg";
      imagePath = join(tmpdir(), `tg-${message.message_id}.${ext}`);
      await writeFile(imagePath, imageBuffer);

      const caption = message.caption || text || "";
      const isLeadContext = /lead|new client|referral|buyer|purchase|mortgage/i.test(caption);
      const photoPrompt = isLeadContext
        ? "This is a lead screenshot. Extract ALL contact and mortgage info. Use zoho_create_full_lead to create the lead. Ask clarifying questions for anything missing (email, purpose, referral source are required). Be concise."
        : "Analyze this image. If it contains lead/contact info, extract it and use zoho_create_full_lead. If it's a bill or receipt, categorize it and log it. If it's a document, describe what it is and suggest next steps.";
      userMessage = caption ? `${caption}\n\n${photoPrompt}` : photoPrompt;
    } catch (e) {
      console.error("[Bot] Photo fetch error:", e);
      userMessage = text || "I received a photo but couldn't download it.";
    }
  } else if (message.voice) {
    try {
      const fileUrl = await getFileUrl(token, message.voice.file_id);
      const audioRes = await fetch(fileUrl);
      const audioBuffer = await audioRes.arrayBuffer();

      const groqKey = process.env.GROQ_API_KEY;
      if (groqKey) {
        const formData = new FormData();
        const audioBlob = new Blob([audioBuffer], { type: message.voice.mime_type || "audio/ogg" });
        formData.append("file", audioBlob, "voice.ogg");
        formData.append("model", "whisper-large-v3");

        const whisperRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${groqKey}` },
          body: formData,
        });
        const whisperData = await whisperRes.json() as { text?: string };
        const transcript = whisperData.text || "Could not transcribe voice note.";
        userMessage = `[Voice note]: ${transcript}\n\nProcess this. If it contains lead info, use zoho_create_full_lead.`;
      } else {
        userMessage = "Voice notes require Groq API key. Please type your message instead.";
      }
    } catch (e) {
      console.error("[Bot] Voice processing error:", e);
      userMessage = "Couldn't process voice note. Try typing instead.";
    }
  }

  // Determine agent + gather context
  const agent = userAgents[userId] || detectAgent(text);
  userAgents[userId] = agent;

  let context = "";
  try {
    const [agentContext, brainContext] = await Promise.all([
      (async () => {
        switch (agent) {
          case "property": return await getPropertyContext();
          case "cx": return await getCXContext();
          case "rates": return await getRatesContext();
          case "pipeline": return await getPipelineContext();
          case "content": return await getContentContext();
          default: return "";
        }
      })(),
      getBrainContext(),
    ]);
    context = (agentContext ? `AGENT CONTEXT:\n${agentContext}\n\n` : "") +
      `FLOW KNOWLEDGE BASE:\n${brainContext}`;
  } catch (e) {
    console.error("Context fetch error:", e);
  }

  // Typing indicator during Claude call
  const typingInterval = setInterval(() => sendTypingAction(token, chatId), 4000);

  try {
    // Save user message to history
    await addToHistory(userId, "user", userMessage);

    // Call Claude via Agent SDK (uses Max subscription, no API credits)
    const history = await getHistory(userId);
    const result = await chatWithClaude({
      systemPrompt: getSystemPrompt(agent) + "\n\n" + context,
      userMessage,
      imagePath,
      history: history.map((h) => ({ role: h.role, content: h.content })),
    });

    clearInterval(typingInterval);

    const reply = result.text;
    await addToHistory(userId, "assistant", reply);
    await sendMessage(token, chatId, reply);

    if (result.error) {
      console.error("[Bot] Claude returned error:", result.error);
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error("[Bot] handler error:", error);
    await sendMessage(token, chatId, "Something went wrong. Try again or rephrase your request.");
  }
}

async function handleCommand(text: string, message: TelegramMessage, token: string, chatId: number, userId: number): Promise<boolean> {
  const command = text.split(" ")[0].toLowerCase().replace(/@\w+/, "");

  switch (command) {
    case "/start":
      await sendMessage(token, chatId,
        `Hey ${message.from.first_name}. Flow Agent is live.

/pulse -- The big picture. Revenue, pipeline, stuck deals, closings, overdue tasks, biggest deals in play. One command.

/lead -- Screenshot, forward, or type lead info. Contact + mortgage + Amy tasked. Done.

/revenue -- Funded vs 35-deal target, pace, projections.

/partners -- Who's going cold? Who to follow up with?

/calc -- "What can someone afford on 120k?" Instant Canadian mortgage math.

/pipeline -- Full pipeline by stage.

/briefing -- Everything across all systems.

Or just talk to me. I know the whole team, every process, every SOP.

Your Telegram ID: ${userId}`
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
/log <kind> <who> - Log activity to Sales scoreboard (call/dm/meeting/etc)
/partner - Process partner call (paste notes, get follow-up email)
/shortform <topic> - 5 video scripts for Reels/TikTok
/shortform hook <topic> - 10 hooks for testing
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

    case "/pulse": {
      await sendTypingAction(token, chatId);
      userAgents[userId] = "pipeline";
      const pulseResult = await handleToolCall("ceo_dashboard", {});
      await sendMessage(token, chatId, pulseResult);
      return true;
    }

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

    case "/shortform": {
      userAgents[userId] = "content";
      const sfText = text.replace(/^\/shortform\s*/i, "").trim();
      if (!sfText) {
        await sendMessage(token, chatId,
          `Short-form video scripts. Options:\n\n` +
          `/shortform <topic> - 5 scripts on a topic\n` +
          `/shortform hook <topic> - 10 hooks for testing\n\n` +
          `Examples:\n` +
          `"shortform rate drops"\n` +
          `"shortform hook renewal letters"\n` +
          `"give me reels about self-employed"\n\n` +
          `Or just describe what you want.`
        );
        return true;
      }
      // Check if it's a hook request
      const hookMatch = sfText.match(/^hooks?\s+(.+)/i);
      if (hookMatch) {
        message.text = `Generate 10 hooks for rapid testing on: ${hookMatch[1]}. Use the generate_hooks tool.`;
      } else {
        message.text = `Generate 5 short-form video scripts for @TheMortgagePug on: ${sfText}. Use the generate_short_form_scripts tool.`;
      }
      return false;
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

    case "/log": {
      const body = text.replace(/^\/log\s*/i, "").trim();
      if (!body) {
        await sendMessage(token, chatId, LOG_HELP);
        return true;
      }
      const result = await logActivity(body);
      if (result.ok) {
        await sendMessage(
          token,
          chatId,
          `Logged: ${result.label}.\n\nSee ops.getflowmortgage.ca`,
        );
      } else {
        await sendMessage(
          token,
          chatId,
          `Could not log: ${result.error}.\n\n${LOG_HELP}`,
        );
      }
      return true;
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
