import { createClient } from "@supabase/supabase-js";

// Reads the latest pipeline accountability report from the ops Supabase and
// formats it for Telegram. Shared by the weekly cron and the /accountability command.
const OPS_URL = process.env.OPS_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co";
const OPS_KEY = process.env.OPS_SUPABASE_ANON_KEY || "sb_publishable_ZnDF_CW7Xyx_t_qnFEWxyQ_0f189bwZ";

export async function getAccountabilityMessage(): Promise<string> {
  const supabase = createClient(OPS_URL, OPS_KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("pipeline_accountability_reports")
    .select("report")
    .order("id", { ascending: false })
    .limit(1);
  if (error) return `Accountability report unavailable: ${error.message}`;
  const r: any = data?.[0]?.report;
  if (!r) return "No accountability report available yet.";

  const urgent: any[] = Array.isArray(r.urgent) ? r.urgent : [];
  const owners: any[] = Array.isArray(r.by_owner) ? r.by_owner : [];
  const lines: string[] = [];
  lines.push(`PIPELINE ACCOUNTABILITY — ${r.as_of}`);
  lines.push("");
  lines.push(`Urgent ${r.urgent_count ?? 0} · Watch ${r.watch_count ?? 0} · Stale ${r.stale_cleanup_count ?? 0}`);
  lines.push("");
  lines.push("URGENT — closing soon & gone quiet:");
  if (urgent.length) {
    urgent.slice(0, 12).forEach((d, i) => {
      lines.push(`${i + 1}. ${d.deal_name} — ${d.owner_name} · ${d.stage} · ${d.days_quiet}d quiet · closes ${d.closing_date}`);
    });
  } else {
    lines.push("None — every closing-soon deal is current.");
  }
  lines.push("");
  lines.push("OWNER SCORECARD (urgent / quiet of active):");
  owners.forEach((o) => {
    lines.push(`• ${o.owner_name}: ${o.urgent ?? 0} urgent / ${o.quiet ?? 0} quiet of ${o.active_deals ?? 0} (${o.pct_quiet ?? 0}%)`);
  });
  lines.push("");
  lines.push(`Full list: ops.getflowmortgage.ca/accountability · team view: "Needs Follow-Up" in Zoho.`);
  return lines.join("\n");
}
