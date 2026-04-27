// Writes Alex's personal activities to ops_activities (Flow Ops dashboard).
// Driven by Telegram /log <subcommand> <contact name>.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);

const ALEX_EMAIL = "alex@getflowmortgage.ca";

export type ActivityKind =
  | "call"
  | "dm"
  | "text"
  | "email"
  | "meeting"
  | "partnernew"
  | "partnerdeepen"
  | "pastclient"
  | "app"
  | "newsletter"
  | "content";

const KIND_TO_TYPE: Record<ActivityKind, string> = {
  call: "outreach_call",
  dm: "outreach_dm",
  text: "outreach_text",
  email: "outreach_email",
  meeting: "partner_meeting",
  partnernew: "partner_new",
  partnerdeepen: "partner_deepen",
  pastclient: "past_client_touch",
  app: "application_started",
  newsletter: "newsletter_sent",
  content: "content_shipped",
};

export const KIND_LABELS: Record<ActivityKind, string> = {
  call: "Outbound call",
  dm: "DM",
  text: "Text",
  email: "Email",
  meeting: "Meeting (partner or prospect)",
  partnernew: "New partner activation",
  partnerdeepen: "Partner deepen",
  pastclient: "Past-client nurture",
  app: "Application started",
  newsletter: "Newsletter sent",
  content: "Content shipped",
};

export const HELP_TEXT =
  `Activity log shortcuts. /log <kind> <who or what>

Kinds:
- call -- outbound call
- dm -- DM (IG, LinkedIn, etc)
- text -- SMS / iMessage
- email -- email outreach
- meeting -- partner or prospect meeting
- partnernew -- new partner activation
- partnerdeepen -- top partner deepen
- pastclient -- past-client nurture
- app -- application started
- newsletter -- newsletter sent
- content -- content shipped (reel / blog / YT)

Examples:
/log call Sarah at E&V
/log dm @higherupwellness re collab
/log meeting Lewis Ratcliff
/log pastclient Beth Minto

Logs land instantly on the Sales scoreboard at ops.getflowmortgage.ca.`;

export interface LogResult {
  ok: boolean;
  type?: string;
  label?: string;
  error?: string;
}

export async function logActivity(input: string): Promise<LogResult> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "empty" };
  }

  const [rawKind, ...rest] = trimmed.split(/\s+/);
  const kind = rawKind.toLowerCase().replace(/^\//, "") as ActivityKind;
  const activity_type = KIND_TO_TYPE[kind];
  if (!activity_type) {
    return { ok: false, error: `unknown kind '${rawKind}'` };
  }

  const note = rest.join(" ").trim() || null;

  const { error } = await supabase.from("ops_activities").insert({
    occurred_at: new Date().toISOString(),
    user_email: ALEX_EMAIL,
    activity_type,
    contact_name: note,
    notes: trimmed,
    source: "telegram_log",
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, type: activity_type, label: KIND_LABELS[kind] };
}
