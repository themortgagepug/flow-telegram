import { createClient } from "@supabase/supabase-js";

// The decision channel. Alex, 2026-08-21: "I want clarity and only useful items
// that will be 2 way." flow-decision-push sends one message per decision; this
// is the other half, so a reply of "yes" actually settles it instead of just
// telling him to go and click something.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  { auth: { persistSession: false } },
);

export type OpenDecision = {
  id: string;
  subject: string;
  source_agent: string;
  kind: string;
  created_at: string;
};

/** The decision most recently pushed to him and still unanswered. */
export async function openDecision(): Promise<OpenDecision | null> {
  const { data, error } = await supabase
    .from("approval_queue")
    .select("id,subject,source_agent,kind,created_at")
    .eq("status", "pending")
    .not("notified_at", "is", null)
    .order("notified_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0] as OpenDecision;
}

export async function approveDecision(id: string, who: string) {
  return supabase.from("approval_queue").update({
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: who,
    resolved_via: "telegram",
  }).eq("id", id);
}

export async function declineDecision(id: string, who: string, reason: string) {
  return supabase.from("approval_queue").update({
    status: "rejected",
    rejection_reason: reason || "declined via Telegram",
    approved_by: who,
    resolved_via: "telegram",
  }).eq("id", id);
}

/** Keeps it open, but records what he said so the note is not lost. */
export async function noteOnDecision(id: string, note: string) {
  return supabase.from("approval_queue").update({
    alex_note: note,
    resolved_via: "telegram_note",
  }).eq("id", id);
}

const YES = /^\s*(y|yes|yep|yeah|approve[d]?|ok|okay|do it|send it|go|go ahead|confirm)\s*[.!]?\s*$/i;
const NO = /^\s*(n|no|nope|decline[d]?|reject|cancel|skip|not now)\s*[.!]?\s*$/i;

/**
 * If a pushed decision is open and this message answers it, settle it and
 * return the confirmation to send back. Returns null when the message is not an
 * answer, so normal conversation is untouched.
 */
export async function handleDecisionReply(
  text: string,
  who: string,
): Promise<string | null> {
  const t = (text || "").trim();
  if (!t || t.startsWith("/")) return null;
  const isYes = YES.test(t);
  const isNo = NO.test(t);
  if (!isYes && !isNo) return null;

  const d = await openDecision();
  if (!d) return null;

  if (isYes) {
    const { error } = await approveDecision(d.id, who);
    return error
      ? `Could not record that: ${error.message}`
      : `Approved: ${d.subject}\n${d.source_agent} will pick it up on its next run.`;
  }
  const { error } = await declineDecision(d.id, who, `declined by ${who} via Telegram`);
  return error
    ? `Could not record that: ${error.message}`
    : `Declined: ${d.subject}\nIt is closed and will not come back.`;
}
