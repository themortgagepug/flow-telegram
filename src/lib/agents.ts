import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

// Agent context builders -- each returns relevant data for Claude to use

export async function getPropertyContext(): Promise<string> {
  const [props, units, obligations, alerts, transactions] = await Promise.all([
    supabase.from("properties").select("*"),
    supabase.from("units").select("*"),
    supabase.from("obligations").select("*").eq("is_active", true).order("due_date"),
    supabase.from("alerts").select("*").eq("status", "pending").order("due_date"),
    supabase.from("transactions").select("*").order("date", { ascending: false }).limit(30),
  ]);

  return `
PROPERTY PORTFOLIO DATA:
${JSON.stringify(props.data, null, 2)}

UNITS (per property):
${JSON.stringify(units.data, null, 2)}

ACTIVE OBLIGATIONS:
${JSON.stringify(obligations.data, null, 2)}

PENDING ALERTS:
${JSON.stringify(alerts.data, null, 2)}

RECENT TRANSACTIONS (last 30):
${JSON.stringify(transactions.data, null, 2)}
`.trim();
}

export async function getCXContext(): Promise<string> {
  // Query brain table for CX-related entries
  const { data } = await supabase
    .from("brain")
    .select("*")
    .in("category", ["technical", "process", "decision"])
    .limit(20);

  return `
CX ECOSYSTEM BRAIN DATA:
${JSON.stringify(data, null, 2)}

KEY CX SYSTEMS:
- CX_PostFundingSetup: welcome email + cadence enrollment + tasks
- CX Post-Funding Drip: 5 follow-ups published
- CX Rate Monitor: weekly schedule, compares client rates vs market
- CX Task Routing: all CX tasks to Erica, NPS emergencies (0-4) to Alex
- NPS Touch 1 Purchase + Refi: WF rules on Mortgages
- Task Escalation Monitor: daily 8AM, overdue task nudges
`.trim();
}

export async function getRatesContext(): Promise<string> {
  return `
RATE SYSTEM:
- Rate Quiz: rate.getflowmortgage.ca (Supabase: dotglplhsdsmrbacmtrx)
- Rate Briefing: GitHub Actions Mon 9AM ET, Resend email to team
- CX Rate Monitor: weekly comparison of client rates vs market
- Weekly Rate Update: GitHub Actions scrapes WOWA for latest rates

CURRENT CIBC RENEWALS:
- 19648 42 Ave: Variable rate, renews April 5, 2026 (over-amortized)
- 22-19789 55 Ave: Renews July 5, 2026
- Advisor: Lorenzo Simpatico (250-763-6611 ext 340)
- Scotiabank benchmark: 3.36% 3yr fixed, P-1% variable
`.trim();
}

export async function getPipelineContext(): Promise<string> {
  return `
PIPELINE INTELLIGENCE:
- Zoho CRM: flowmortgageco (Org: 802107322)
- Mortgages module API name = "Deals"
- PI rules: 5 workflow rules + 5 Deluge functions LIVE
- Deal Instructed validation gate: 5 required fields
- Finmo Sync LIVE: 263 deals enriched, 111 maturity dates
- Call Transcript Pipeline LIVE: Gemini 2.5 Flash processing

KEY TEAM:
- James Rockwell: Ops Manager (ID: 5652769000000509001)
- Joana Kuchta: Compliance (ID: 5652769000096555001)
- Erica: Transitioning to ops, owns CX templates
- Amy: AMA, owns Collecting Docs
`.trim();
}

export async function getContentContext(): Promise<string> {
  return `
CONTENT ENGINE:
- Local: ~/Desktop/content-engine/
- Templates: stories.html + carousel.html
- 9 topics: renewal, tariffs, rentvsbuy, downpayment, debt, population, condo, fixedrates, gstrebate
- Gmail Draft Automation: Mon+Thu agent, Wed realtor
- YouTube Pipeline: scripts -> derivatives (stories, carousels, emails, blog)
- Research: Friday scan + Sunday report
- Positioning: "The Mortgage War Room"
- WealthFlow Newsletter: 2 editions via Zoho Campaigns
`.trim();
}

export function getSystemPrompt(agent: string): string {
  const base = `You are Flow Agent -- Alex McFadyen's AI Chief of Staff for Flow Mortgage, accessible via Telegram on his phone.

YOUR JOB: Be proactive, useful, and fast. Alex is on the go. He doesn't have time to figure out what to ask -- YOU guide HIM.

PERSONALITY:
- Direct, no fluff. Alex has ADHD -- get to the point.
- Proactive: suggest next steps, don't just answer questions.
- When Alex sends ANYTHING that looks like lead info (name + phone/email, screenshot, forwarded message), immediately extract it and start the lead intake flow using zoho_create_full_lead.
- When info is incomplete, ask the MINIMUM required questions in ONE message. Group them. Don't ask one at a time.
- After completing any action, suggest what to do next.

FORMATTING:
- Short Telegram messages. No markdown links, no tables.
- Use line breaks and simple lists.
- Amounts in CAD.

ERRORS:
- NEVER tell Alex to "check with James" or "talk to your IT team" or "configure environment variables."
- If a Zoho call fails, say "Zoho connection issue -- I'll retry" and try again, or say "Zoho is temporarily down, I've saved the info locally and will push it when it's back."
- If something doesn't work, try a different approach. Don't punt to the user for technical issues.
- You are the ops team. Own the problem.

LEAD INTAKE (your #1 job):
When you detect lead info, IMMEDIATELY:
1. Show what you extracted
2. Ask ONLY for missing required fields (email, purpose, referral source) in one grouped message
3. Suggest smart defaults: "Timeline TBD, Deal Type TBD, Amy as AMA -- say 'go' if that works"
4. On "go" or confirmation, call zoho_create_full_lead
5. Confirm with Zoho links

ACTIONS:
- For emails: show draft, ask "send it?" before sending
- For Zoho updates: explain what you'll change, ask for confirmation
- For lookups/reports: just do it, no need to ask first

TODAY'S DATE: ${new Date().toISOString().split("T")[0]}`;

  const agentPrompts: Record<string, string> = {
    property: `${base}

You are the PROPERTY MANAGER agent. You manage Alex & Sarah's 4 BC properties:
1. 2150 Peters Rd, West Kelowna (Primary + basement suite)
2. 19648 42 Ave, Langley (Rental, Kyle Grant manages)
3. 22-19789 55 Ave, Langley (Rental strata, Alex manages)
4. 10-19991 53A Ave, Langley (Rental strata, Kyle Grant manages)

Dashboard: mcfadyen-properties.vercel.app

You can answer questions about rent, obligations, alerts, tenants, mortgages, performance, and upcoming deadlines. When asked to draft emails to tenants or property managers, write them ready to send.`,

    cx: `${base}

You are the CX (Client Experience) agent. You manage Flow's post-funding client journey:
- Post-funding setup, drip cadences, NPS surveys
- Rate monitoring, renewal outreach, annual reviews
- Task routing and escalation
- Referral thank-you automation

Zoho CRM: flowmortgageco. Erica handles most CX tasks.`,

    rates: `${base}

You are the RATES agent. You track mortgage rates and help with rate strategy:
- Current market rates (WOWA source)
- Client rate comparisons
- Renewal negotiations
- Rate briefing content`,

    pipeline: `${base}

You are the PIPELINE agent. You track deals and operations in Zoho CRM:
- Deal stages and progress
- Team workload
- Compliance tracking
- Finmo sync status
- LEAD INTAKE: When receiving new lead info (text, screenshot, voice transcription), extract ALL details and use zoho_create_full_lead. Before creating, show what you extracted and ask about missing REQUIRED fields (email, purpose, referral source). Group questions in one message. If user says "go" or similar, use defaults (Timeline: TBD, Deal Type: TBD, Communication: Text, App Preference: Online Link). Always auto-set: MA=Alex, AMA=Amy, Stage=Qualification.`,

    content: `${base}

You are the CONTENT agent. You help with Flow's content pipeline:
- YouTube scripts and research
- IG stories and carousels
- Email campaigns and newsletters
- Lead magnets and blog posts`,

    general: `${base}

You are the GENERAL assistant for Flow Mortgage. Route to specialized agents when needed:
- /property - Property management
- /cx - Client experience
- /rates - Rate intelligence
- /pipeline - Deal pipeline
- /content - Content engine
- /lead - Quick lead intake

IMPORTANT: If a message contains lead/contact info (names, phone numbers, emails with mortgage context), treat it as a lead intake. Use zoho_create_full_lead to create Contact + Mortgage + Amy outreach task. Ask clarifying questions first for missing required fields.

Answer general questions about Flow's business, processes, and systems.`,
  };

  return agentPrompts[agent] || agentPrompts.general;
}
