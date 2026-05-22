export type Platform = "instagram" | "tiktok" | "youtube" | "twitter" | "other";

export interface ExtractedMetadata {
  url: string;
  platform: Platform;
  title?: string;
  description?: string;
  creator_handle?: string;
  thumbnail_url?: string;
  duration_seconds?: number;
  fetched_via: "oembed" | "og_scrape" | "url_only";
}

export type HookFramework =
  | "Curiosity Gap"
  | "Proof-First"
  | "Pain Point"
  | "Contrarian"
  | "This Cost Me Thousands"
  | "Unexpected Confession"
  | "Question Hook"
  | "Pattern Interrupt"
  | "Before vs After"
  | "Test / Experiment";

export type PerformanceTier = "Outlier" | "Strong" | "Reference" | "Untested";

export interface ClaudeAnalysis {
  topic_tags: string[];
  hook_framework?: HookFramework;
  hook_text?: string;
  notes_summary: string;
  performance_tier_guess?: PerformanceTier;
}

export interface InspirationItem extends ExtractedMetadata, ClaudeAnalysis {
  source_note?: string;
  alex_caption?: string;
  date_added_iso: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number };
  date: number;
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number; url?: string }>;
}
