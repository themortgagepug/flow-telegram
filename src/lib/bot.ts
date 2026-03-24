import Anthropic from "@anthropic-ai/sdk";
import { sendMessage, sendTypingAction } from "./telegram";
import { getTeamMember } from "./team";
import {
  getPropertyContext,
  getCXContext,
  getRatesContext,
  getPipelineContext,
  getContentContext,
  getSystemPrompt,
} from "./agents";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type TelegramMessage = {
  message_id: number;
  from: { id: number; username?: string; first_name: string };
  chat: { id: number; type: string };
  text: string;
  date: number;
};

// Track which agent each user is currently talking to
const userAgents: Record<number, string> = {};

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

  // Handle commands
  if (text.startsWith("/")) {
    const command = text.split(" ")[0].toLowerCase().replace("@", "");

    switch (command) {
      case "/start":
        await sendMessage(
          token,
          chatId,
          `Welcome to Flow Agent, ${message.from.first_name}!

Available agents:
/property - Property management (4 properties)
/cx - Client experience & post-funding
/rates - Rate intelligence & renewals
/pipeline - Deal pipeline & CRM
/content - Content engine & marketing
/help - Show this menu

Just type a message and I'll route it to the right agent. Or switch agents with the commands above.

Your Telegram ID: ${userId}`
        );
        return;

      case "/help":
        await sendMessage(
          token,
          chatId,
          `Flow Agent Commands:

/property - Switch to property manager
/cx - Switch to CX agent
/rates - Switch to rates agent
/pipeline - Switch to pipeline agent
/content - Switch to content agent
/status - Quick status across all systems
/help - Show this menu

Or just ask me anything -- I'll figure out the right agent.`
        );
        return;

      case "/property":
        userAgents[userId] = "property";
        await sendMessage(token, chatId, "Switched to Property Manager agent. Ask me anything about your 4 properties.");
        return;

      case "/cx":
        userAgents[userId] = "cx";
        await sendMessage(token, chatId, "Switched to CX agent. Ask about client experience, post-funding, NPS, renewals.");
        return;

      case "/rates":
        userAgents[userId] = "rates";
        await sendMessage(token, chatId, "Switched to Rates agent. Ask about current rates, renewals, comparisons.");
        return;

      case "/pipeline":
        userAgents[userId] = "pipeline";
        await sendMessage(token, chatId, "Switched to Pipeline agent. Ask about deals, team workload, CRM.");
        return;

      case "/content":
        userAgents[userId] = "content";
        await sendMessage(token, chatId, "Switched to Content agent. Ask about YouTube, IG, emails, newsletters.");
        return;

      case "/status":
        await handleStatusCommand(token, chatId);
        return;
    }
  }

  // Determine which agent to use
  let agent = userAgents[userId] || detectAgent(text);
  userAgents[userId] = agent;

  // Get context for the agent
  let context = "";
  try {
    switch (agent) {
      case "property":
        context = await getPropertyContext();
        break;
      case "cx":
        context = await getCXContext();
        break;
      case "rates":
        context = await getRatesContext();
        break;
      case "pipeline":
        context = await getPipelineContext();
        break;
      case "content":
        context = await getContentContext();
        break;
      default:
        context = "No specific context loaded. Route to a specialized agent if needed.";
    }
  } catch (e) {
    console.error("Context fetch error:", e);
    context = "Error fetching context data.";
  }

  // Call Claude
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: getSystemPrompt(agent) + "\n\nCONTEXT DATA:\n" + context,
      messages: [{ role: "user", content: text }],
    });

    const reply =
      response.content[0].type === "text"
        ? response.content[0].text
        : "I couldn't generate a response.";

    await sendMessage(token, chatId, reply);
  } catch (error) {
    console.error("Claude error:", error);
    await sendMessage(token, chatId, "Error processing your request. Try again in a moment.");
  }
}

function detectAgent(text: string): string {
  const lower = text.toLowerCase();

  // Property keywords
  if (
    /property|rent|tenant|strata|mortgage|42 ave|55 ave|53a|peters|landlord|lease|unit|vacancy|kyle/i.test(lower)
  ) {
    return "property";
  }

  // CX keywords
  if (/cx|client experience|post.?funding|nps|renewal|annual review|drip|cadence|erica/i.test(lower)) {
    return "cx";
  }

  // Rates keywords
  if (/rate|rates|interest|variable|fixed|boc|bank of canada|lorenzo|cibc/i.test(lower)) {
    return "rates";
  }

  // Pipeline keywords
  if (/deal|pipeline|zoho|crm|funded|instructed|compliance|james|joana|finmo/i.test(lower)) {
    return "pipeline";
  }

  // Content keywords
  if (/content|youtube|video|script|story|carousel|instagram|ig|newsletter|blog|email campaign/i.test(lower)) {
    return "content";
  }

  return "general";
}

async function handleStatusCommand(token: string, chatId: number) {
  try {
    const context = await getPropertyContext();
    const alertCount = (context.match(/"status":"pending"/g) || []).length;

    await sendMessage(
      token,
      chatId,
      `Flow Status Overview

Property Hub:
- 4 properties tracked
- ${alertCount} pending alerts
- Dashboard: mcfadyen-properties.vercel.app

CX Ecosystem: ACTIVE
- Post-funding drip: running
- Rate monitor: weekly
- Task escalation: daily 8AM

Content Engine: ACTIVE
- Gmail drafts: Mon+Thu+Wed
- Rate briefing: Mon 9AM ET

Type /property, /cx, /rates, /pipeline, or /content to dive deeper.`
    );
  } catch {
    await sendMessage(token, chatId, "Error fetching status. Try again.");
  }
}
