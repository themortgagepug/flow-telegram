// Conversation memory -- stores recent messages per user in Supabase
// Keeps last 10 messages for context continuity

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// In-memory cache (per Vercel function instance)
// Falls back to this if Supabase chat_history table doesn't exist
const memoryCache: Record<number, ChatMessage[]> = {};
const MAX_MESSAGES = 10;

export async function getHistory(userId: number): Promise<ChatMessage[]> {
  try {
    const { data, error } = await supabase
      .from("chat_history")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(MAX_MESSAGES);

    if (error || !data) {
      // Table might not exist yet, use in-memory cache
      return memoryCache[userId] || [];
    }
    return data as ChatMessage[];
  } catch {
    return memoryCache[userId] || [];
  }
}

export async function addToHistory(userId: number, role: "user" | "assistant", content: string) {
  // Keep content short for memory (first 500 chars)
  const trimmed = content.substring(0, 500);

  // In-memory fallback
  if (!memoryCache[userId]) memoryCache[userId] = [];
  memoryCache[userId].push({ role, content: trimmed });
  if (memoryCache[userId].length > MAX_MESSAGES) {
    memoryCache[userId] = memoryCache[userId].slice(-MAX_MESSAGES);
  }

  // Try Supabase
  try {
    await supabase.from("chat_history").insert({
      user_id: userId,
      role,
      content: trimmed,
    });

    // Prune old messages (keep last MAX_MESSAGES)
    const { data: all } = await supabase
      .from("chat_history")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (all && all.length > MAX_MESSAGES) {
      const toDelete = all.slice(0, all.length - MAX_MESSAGES).map(r => r.id);
      await supabase.from("chat_history").delete().in("id", toDelete);
    }
  } catch {
    // Supabase table might not exist yet, that's ok
  }
}

export async function clearHistory(userId: number) {
  memoryCache[userId] = [];
  try {
    await supabase.from("chat_history").delete().eq("user_id", userId);
  } catch {
    // ignore
  }
}
