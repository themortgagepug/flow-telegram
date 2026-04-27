// Live business context fetcher for Compass coach. Pulls Top 40, MTD funded,
// open deals, stalled tasks, today's activities, and the hardcoded goal stack.
// Composed into a single text block injected ahead of every Compass message
// so the coach answers from real numbers, not memory of memory.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);

const ZOHO_BASE = "https://www.zohoapis.com/crm/v3";

// Module-level cache. Vercel keeps warm instances 5-15 min so this avoids
// re-fetching the world on every back-and-forth message.
const CACHE = new Map<string, { data: string; expiresAt: number }>();
const CACHE_TTL_MS = 90_000;

// --- Zoho ----------------------------------------------------------------

async function getZohoToken(): Promise<string | null> {
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) return null;
  try {
    const r = await fetch(
      `https://accounts.zoho.com/oauth/v2/token?grant_type=refresh_token&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&refresh_token=${ZOHO_REFRESH_TOKEN}`,
      { method: "POST" },
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchTop40(token: string): Promise<Array<{ name: string; type?: string; lastTouchDays?: number | null }>> {
  try {
    const r = await fetch(
      `${ZOHO_BASE.replace("/v3", "/v6")}/Contacts/search?criteria=${encodeURIComponent("(Tag.name:equals:Top_40_Maintenance)")}&fields=id,Full_Name,Contact_Type,Partner_Status,Last_Activity_Time&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (!r.ok) return [];
    const data = (await r.json()).data ?? [];
    const now = Date.now();
    return data.map((c: Record<string, unknown>) => {
      const last = c.Last_Activity_Time as string | undefined;
      const days = last ? Math.floor((now - new Date(last).getTime()) / 86400000) : null;
      return {
        name: (c.Full_Name as string) ?? "",
        type: (c.Contact_Type as string) ?? (c.Partner_Status as string) ?? "",
        lastTouchDays: days,
      };
    });
  } catch {
    return [];
  }
}

async function fetchOwnedOpenDeals(token: string): Promise<Array<{ name: string; stage: string; amount: number; modifiedDays: number }>> {
  try {
    const r = await fetch(
      `${ZOHO_BASE}/Deals?fields=id,Deal_Name,Stage,Mortgage_Amount,Amount,Owner,Modified_Time&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (!r.ok) return [];
    const data = (await r.json()).data ?? [];
    const terminal = new Set(["Funded", "Closed Lost", "Closed Won", "Cancelled"]);
    const now = Date.now();
    return data
      .filter((d: Record<string, unknown>) => {
        const owner = d.Owner as Record<string, unknown> | undefined;
        const ownerEmail = (owner?.email as string) ?? "";
        return ownerEmail.toLowerCase() === "alex@getflowmortgage.ca" && !terminal.has(d.Stage as string);
      })
      .map((d: Record<string, unknown>) => ({
        name: (d.Deal_Name as string) ?? "",
        stage: (d.Stage as string) ?? "Unknown",
        amount: Number((d.Mortgage_Amount ?? d.Amount) || 0),
        modifiedDays: Math.floor(
          (now - new Date((d.Modified_Time as string) ?? new Date().toISOString()).getTime()) / 86400000,
        ),
      }))
      .sort((a: { amount: number }, b: { amount: number }) => b.amount - a.amount)
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function fetchStalledTasks(token: string): Promise<Array<{ subject: string; due?: string; daysOverdue?: number }>> {
  try {
    const r = await fetch(
      `${ZOHO_BASE}/Tasks?fields=id,Subject,Status,Due_Date,Owner&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (!r.ok) return [];
    const data = (await r.json()).data ?? [];
    const today = new Date().toISOString().slice(0, 10);
    return data
      .filter((t: Record<string, unknown>) => {
        const owner = t.Owner as Record<string, unknown> | undefined;
        const ownerEmail = (owner?.email as string) ?? "";
        const isAlex = ownerEmail.toLowerCase() === "alex@getflowmortgage.ca";
        const due = (t.Due_Date as string) ?? "";
        return isAlex && t.Status !== "Completed" && due && due < today;
      })
      .map((t: Record<string, unknown>) => {
        const due = t.Due_Date as string;
        const days = Math.floor((Date.now() - new Date(due).getTime()) / 86400000);
        return {
          subject: (t.Subject as string) ?? "",
          due,
          daysOverdue: days,
        };
      })
      .slice(0, 8);
  } catch {
    return [];
  }
}

// --- Supabase ------------------------------------------------------------

async function fetchActivityPace(): Promise<{
  todayCount: number;
  weekCount: number;
  byType: Record<string, number>;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 7);

  const { data } = await supabase
    .from("ops_activities")
    .select("activity_type, occurred_at")
    .gte("occurred_at", weekStart.toISOString());

  const todayIso = today.toISOString();
  const todayCount = (data ?? []).filter((a) => a.occurred_at >= todayIso).length;
  const weekCount = (data ?? []).length;
  const byType: Record<string, number> = {};
  for (const a of data ?? []) byType[a.activity_type] = (byType[a.activity_type] ?? 0) + 1;
  return { todayCount, weekCount, byType };
}

async function fetchMtdFunded(): Promise<{ amount: number; count: number }> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { data } = await supabase
    .from("ops_funnel_daily")
    .select("funded_today_amount, funded_today_count")
    .gte("snapshot_date", monthStart.toISOString().slice(0, 10));
  const amount = (data ?? []).reduce((s, d) => s + Number(d.funded_today_amount ?? 0), 0);
  const count = (data ?? []).reduce((s, d) => s + Number(d.funded_today_count ?? 0), 0);
  return { amount, count };
}

async function fetchActiveProjects(): Promise<Array<{ name: string; status: string; nextAction: string; staleDays: number; category?: string }>> {
  const { data } = await supabase
    .from("projects")
    .select("name, status, next_action, last_touched, category")
    .in("status", ["active", "blocked", "in_progress"])
    .order("last_touched", { ascending: false })
    .limit(15);
  const now = Date.now();
  return (data ?? []).map((p) => ({
    name: (p.name as string) ?? "",
    status: (p.status as string) ?? "",
    nextAction: ((p.next_action as string) ?? "").slice(0, 140),
    staleDays: p.last_touched
      ? Math.floor((now - new Date(p.last_touched as string).getTime()) / 86400000)
      : 999,
    category: (p.category as string) ?? undefined,
  }));
}

async function fetchPendingApprovals(): Promise<Array<{ kind: string; preview: string; priority: string; sourceAgent: string; ageHours: number }>> {
  const { data } = await supabase
    .from("approval_queue")
    .select("kind, preview, priority, source_agent, created_at, approved_at, rejection_reason")
    .is("approved_at", null)
    .is("rejection_reason", null)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(8);
  const now = Date.now();
  return (data ?? []).map((a) => ({
    kind: (a.kind as string) ?? "",
    preview: ((a.preview as string) ?? "").slice(0, 180),
    priority: (a.priority as string) ?? "normal",
    sourceAgent: (a.source_agent as string) ?? "",
    ageHours: a.created_at
      ? Math.floor((now - new Date(a.created_at as string).getTime()) / 3600000)
      : 0,
  }));
}

async function fetchRecentObservations(): Promise<Array<{ agent: string; trigger: string; outcome: string; summary: string; ageHours: number }>> {
  const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data } = await supabase
    .from("agent_observations")
    .select("agent_name, trigger, outcome_status, payload, anomaly, action_taken, created_at")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(20);
  const now = Date.now();
  return (data ?? []).map((o) => {
    const payload = o.payload as Record<string, unknown> | null;
    const summary =
      (o.action_taken as string) ||
      (o.anomaly as string) ||
      (typeof payload?.summary === "string" ? (payload.summary as string) : "") ||
      JSON.stringify(payload ?? {}).slice(0, 120);
    return {
      agent: (o.agent_name as string) ?? "",
      trigger: (o.trigger as string) ?? "",
      outcome: (o.outcome_status as string) ?? "",
      summary: summary.slice(0, 180),
      ageHours: o.created_at
        ? Math.floor((now - new Date(o.created_at as string).getTime()) / 3600000)
        : 0,
    };
  });
}

async function fetchRecentCoachingCalls(): Promise<Array<{ when: string; type: string; decisions: string; actions: string }>> {
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from("call_transcripts")
    .select("call_date, call_type, key_decisions, action_items, intelligence")
    .gte("call_date", cutoff)
    .in("call_type", ["coaching", "planning", "partner"])
    .order("call_date", { ascending: false })
    .limit(5);
  return (data ?? []).map((c) => {
    const decisions = Array.isArray(c.key_decisions)
      ? (c.key_decisions as string[]).slice(0, 3).join("; ")
      : (c.key_decisions as string) ?? "";
    const actions = Array.isArray(c.action_items)
      ? (c.action_items as string[]).slice(0, 3).join("; ")
      : (c.action_items as string) ?? "";
    return {
      when: (c.call_date as string) ?? "",
      type: (c.call_type as string) ?? "",
      decisions: decisions.slice(0, 200),
      actions: actions.slice(0, 200),
    };
  });
}

async function fetchKeyMemoryEntries(): Promise<Array<{ topic: string; category: string; content: string }>> {
  // Pull operating principles + active priorities from the brain table.
  const topicsOfInterest = [
    "10x batch tracker",
    "half-done inventory",
    "systemic gaps",
    "advisory team",
    "coach mandate",
    "operating system",
  ];
  const { data } = await supabase
    .from("brain")
    .select("topic, category, content, updated_at")
    .or(topicsOfInterest.map((t) => `topic.ilike.%${t}%`).join(","))
    .order("updated_at", { ascending: false })
    .limit(6);
  return (data ?? []).map((m) => ({
    topic: (m.topic as string) ?? "",
    category: (m.category as string) ?? "",
    content: ((m.content as string) ?? "").slice(0, 600),
  }));
}

async function fetchTargets(): Promise<Record<string, number>> {
  const { data } = await supabase
    .from("ops_targets")
    .select("target_type, value, effective_from")
    .eq("scope", "alex_personal")
    .order("effective_from", { ascending: false });
  const latest: Record<string, number> = {};
  for (const t of data ?? []) {
    if (!(t.target_type in latest)) latest[t.target_type] = Number(t.value);
  }
  return latest;
}

// --- Goals (hardcoded from memory) ---------------------------------------

const GOALS_BLOCK = `
**December 2026 picture (priority order):**
1. Personal take-home over $1M in 2026 — currently behind. Bar.
2. Flow Underwriter at $1M ARR — sellable AI for brokers, Addy.so parity.
3. YouTube channel "The Mortgage War Room" at 20K subs — currently 4,020.
4. Ops lead in seat at Flow Mortgage — extracts Alex from Layer 2.
5. EVOLV 3 + Summit v2 with Mo sold out — Oct 2026.
6. Alex spending 60% of time on Layers 3-6 (software, brand, community, AI).

Layer 1 (brand) and Layer 2 (brokerage) must work without owning Alex's hours.
`.trim();

// --- Compose -------------------------------------------------------------

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(n);
}

function pacePct(target: number, dayOfMonth: number, daysInMonth: number, current: number): string {
  if (target <= 0) return "(no target)";
  const expected = target * (dayOfMonth / daysInMonth);
  const diffDays = (current - expected) / (target / daysInMonth);
  const sign = diffDays >= 0 ? "+" : "";
  return `${sign}${diffDays.toFixed(1)} days vs target pace`;
}

export async function buildCompassContext(): Promise<string> {
  const cacheKey = "context";
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const token = await getZohoToken();

  const [activity, mtd, targets, top40, openDeals, stalledTasks, projects, approvals, observations, coachingCalls, brainMem] = await Promise.all([
    fetchActivityPace(),
    fetchMtdFunded(),
    fetchTargets(),
    token ? fetchTop40(token) : Promise.resolve([]),
    token ? fetchOwnedOpenDeals(token) : Promise.resolve([]),
    token ? fetchStalledTasks(token) : Promise.resolve([]),
    fetchActiveProjects(),
    fetchPendingApprovals(),
    fetchRecentObservations(),
    fetchRecentCoachingCalls(),
    fetchKeyMemoryEntries(),
  ]);

  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  const monthlyTarget = targets["monthly_funded_volume"] ?? 0;
  const annualTakeHomeTarget = targets["annual_take_home"] ?? 1_000_000;

  // Top 40 dormant breakdown
  const top40Total = top40.length;
  const top40Cold = top40.filter((c) => c.lastTouchDays != null && c.lastTouchDays > 30).length;
  const top40Dormant = top40.filter((c) => c.lastTouchDays != null && c.lastTouchDays > 90).length;
  const top40Hot = top40.filter((c) => c.lastTouchDays != null && c.lastTouchDays <= 7);
  const top40NeedingTouch = top40
    .filter((c) => c.lastTouchDays != null && c.lastTouchDays > 14)
    .sort((a, b) => (b.lastTouchDays ?? 0) - (a.lastTouchDays ?? 0))
    .slice(0, 8);

  // Open deals breakdown
  const openDealsValue = openDeals.reduce((s, d) => s + d.amount, 0);
  const dealsAtRisk = openDeals.filter((d) => d.modifiedDays > 7).length;

  const sections: string[] = [
    "## Live business state — fetched seconds ago",
    "",
    "### Goals (Dec 2026)",
    GOALS_BLOCK,
    "",
    "### Money pace this month",
    `- MTD funded: ${fmtMoney(mtd.amount)} (${mtd.count} deals)`,
    `- Monthly target: ${fmtMoney(monthlyTarget)}`,
    `- Pace: ${pacePct(monthlyTarget, dayOfMonth, daysInMonth, mtd.amount)}`,
    `- Annual take-home target: ${fmtMoney(annualTakeHomeTarget)} (currently behind per memory)`,
    "",
    "### Today's activity",
    `- Logged today: ${activity.todayCount} activities`,
    `- Last 7 days: ${activity.weekCount} activities`,
    `- By type: ${
      Object.entries(activity.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
    "",
    "### Top 40 relationship state (Zoho Top_40_Maintenance tag)",
    `- Total tracked: ${top40Total} | Hot (≤7d): ${top40Hot.length} | Cooling (>30d): ${top40Cold} | Dormant (>90d): ${top40Dormant}`,
    top40NeedingTouch.length
      ? "- Needs a touch (oldest first):\n" +
        top40NeedingTouch
          .map((c) => `  - ${c.name}${c.type ? ` (${c.type})` : ""} — ${c.lastTouchDays}d`)
          .join("\n")
      : "- All top 40 touched within 14 days.",
    "",
    "### Alex-owned open deals",
    `- Count: ${openDeals.length} | Total value: ${fmtMoney(openDealsValue)} | At risk (>7d untouched): ${dealsAtRisk}`,
    openDeals
      .slice(0, 5)
      .map((d) => `  - ${d.name} — ${d.stage} — ${fmtMoney(d.amount)} (${d.modifiedDays}d)`)
      .join("\n"),
    "",
    "### Alex's overdue tasks",
    stalledTasks.length === 0
      ? "- None overdue."
      : stalledTasks
          .map((t) => `  - ${t.subject} — ${t.daysOverdue}d overdue`)
          .join("\n"),
    "",
    "### Active projects (Flow Brain Supabase)",
    projects.length === 0
      ? "- No active projects tracked."
      : projects
          .map(
            (p) =>
              `- ${p.name}${p.category ? ` [${p.category}]` : ""} — ${p.status} — ${p.staleDays}d since touch — next: ${p.nextAction || "(no next action set)"}`,
          )
          .join("\n"),
    "",
    "### Pending approvals (waiting on Alex)",
    approvals.length === 0
      ? "- Nothing waiting."
      : approvals
          .map(
            (a) =>
              `- [${a.priority}] ${a.kind} from ${a.sourceAgent} — ${a.ageHours}h old — ${a.preview}`,
          )
          .join("\n"),
    "",
    "### Last 24h agent OS observations",
    observations.length === 0
      ? "- Quiet. No agent activity."
      : observations
          .slice(0, 8)
          .map(
            (o) =>
              `- ${o.agent}/${o.trigger} (${o.outcome}, ${o.ageHours}h ago) — ${o.summary}`,
          )
          .join("\n"),
    "",
    "### Recent coaching/planning/partner call decisions (last 14d)",
    coachingCalls.length === 0
      ? "- No recent calls in the brain."
      : coachingCalls
          .map(
            (c) =>
              `- ${c.when} (${c.type}): decisions: ${c.decisions || "—"} | actions: ${c.actions || "—"}`,
          )
          .join("\n"),
    "",
    "### Operating principles (Flow Brain memory)",
    brainMem.length === 0
      ? "- (no relevant brain entries fetched)"
      : brainMem
          .map((m) => `- ${m.topic} [${m.category}]: ${m.content.slice(0, 200)}…`)
          .join("\n"),
    "",
    "## End live state. Use these numbers, do not invent.",
  ];

  const text = sections.join("\n");
  CACHE.set(cacheKey, { data: text, expiresAt: Date.now() + CACHE_TTL_MS });
  return text;
}
