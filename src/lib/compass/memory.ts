// Compass conversation history (separate from the ops bot's chat_history).
// Stores in Supabase compass_threads via service-role.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);

const MAX_MESSAGES = 12;

export type CompassMessage = { role: "user" | "assistant"; content: string };

export async function loadCompassHistory(userId: number): Promise<CompassMessage[]> {
  const { data } = await supabase
    .from("compass_threads")
    .select("role, content")
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES);
  if (!data) return [];
  return (data as CompassMessage[]).reverse();
}

export async function appendCompassMessage(
  userId: number,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  await supabase.from("compass_threads").insert({
    user_id: userId,
    role,
    content,
  });
}
