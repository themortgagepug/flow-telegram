import type { ExtractedMetadata, Platform } from "./types";

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

const PLATFORM_PATTERNS: Array<{ platform: Platform; regex: RegExp }> = [
  { platform: "instagram", regex: /(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+/i },
  { platform: "tiktok", regex: /(?:www\.|vm\.|vt\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|[A-Za-z0-9]+)/i },
  { platform: "youtube", regex: /(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|shorts\/|live\/)[A-Za-z0-9_-]+|youtu\.be\/[A-Za-z0-9_-]+)/i },
  { platform: "twitter", regex: /(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+/i },
];

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  return Array.from(new Set(matches.map((u) => u.replace(/[.,;:!?)]+$/, ""))));
}

export function classifyPlatform(url: string): Platform {
  for (const { platform, regex } of PLATFORM_PATTERNS) {
    if (regex.test(url)) return platform;
  }
  return "other";
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

async function fetchOembed(url: string, platform: Platform): Promise<Partial<ExtractedMetadata> | null> {
  let oembedUrl: string | null = null;

  if (platform === "tiktok") {
    oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  } else if (platform === "youtube") {
    oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  } else if (platform === "twitter") {
    oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1`;
  }

  if (!oembedUrl) return null;

  try {
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;

    return {
      title: typeof data.title === "string" ? data.title : undefined,
      creator_handle: typeof data.author_name === "string" ? data.author_name : undefined,
      thumbnail_url: typeof data.thumbnail_url === "string" ? data.thumbnail_url : undefined,
      description: typeof data.html === "string" ? stripHtml(data.html).slice(0, 500) : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchOgTags(url: string): Promise<Partial<ExtractedMetadata> | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();

    const og = (prop: string) => {
      const re = new RegExp(
        `<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`,
        "i",
      );
      const m = html.match(re);
      return m?.[1];
    };

    const title = og("title");
    const description = og("description");
    const image = og("image");
    const videoDuration = og("video:duration");

    const creatorMatch =
      html.match(/<meta[^>]+name=["']twitter:creator["'][^>]+content=["']@?([^"']+)["']/i) ||
      html.match(/"username":"([^"]+)"/);

    return {
      title,
      description,
      thumbnail_url: image,
      creator_handle: creatorMatch?.[1],
      duration_seconds: videoDuration ? parseInt(videoDuration, 10) || undefined : undefined,
    };
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function extractMetadata(url: string): Promise<ExtractedMetadata> {
  const platform = classifyPlatform(url);

  const oembed = await fetchOembed(url, platform);
  if (oembed && (oembed.title || oembed.creator_handle)) {
    return {
      url,
      platform,
      title: oembed.title,
      description: oembed.description,
      creator_handle: oembed.creator_handle,
      thumbnail_url: oembed.thumbnail_url,
      duration_seconds: oembed.duration_seconds,
      fetched_via: "oembed",
    };
  }

  const og = await fetchOgTags(url);
  if (og && (og.title || og.description)) {
    return {
      url,
      platform,
      title: og.title,
      description: og.description,
      creator_handle: og.creator_handle,
      thumbnail_url: og.thumbnail_url,
      duration_seconds: og.duration_seconds,
      fetched_via: "og_scrape",
    };
  }

  return { url, platform, fetched_via: "url_only" };
}
