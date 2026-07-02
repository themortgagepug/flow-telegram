// Team access control -- LOCKED DOWN
// Only registered users can interact with the bot

export type TeamMember = {
  name: string;
  role: "admin" | "team" | "viewer";
  agents: string[]; // which agents they can access
};

// Allowed Telegram usernames (lowercase) -- add team members here
// After someone messages the bot, they'll see their user ID
// Add their username OR numeric ID below
const ALLOWED_USERS: Record<string, TeamMember> = {
  themortgagepug: { name: "Alex", role: "admin", agents: ["property", "cx", "rates", "pipeline", "content", "general"] },
};

// Numeric Telegram IDs (more reliable than usernames)
const ALLOWED_IDS: Record<number, TeamMember> = {
  7544938550: { name: "Alex", role: "admin", agents: ["property", "cx", "rates", "pipeline", "content", "general"] },
};

// ADMIN OVERRIDE: First message from any user gets through during setup phase
// Set this to false once team is registered
// LOCKED 2026-07-02: bot is reachable again via long-polling; Alex is
// registered by ID + username above, so open admin access must stay off.
const SETUP_MODE = false;

export function getTeamMember(userId: number, username?: string): TeamMember | null {
  // Check by numeric ID first (most reliable)
  if (ALLOWED_IDS[userId]) return ALLOWED_IDS[userId];

  // Check by username
  if (username && ALLOWED_USERS[username.toLowerCase()]) {
    return ALLOWED_USERS[username.toLowerCase()];
  }

  // Setup mode: allow anyone but flag it
  if (SETUP_MODE) {
    console.log(`[SETUP] Unregistered user: ${username || "no_username"} (ID: ${userId})`);
    return {
      name: username || `user_${userId}`,
      role: "admin", // Everyone is admin during setup
      agents: ["property", "cx", "rates", "pipeline", "content", "general"],
    };
  }

  // Locked down: deny access
  console.log(`[DENIED] Unauthorized user: ${username || "no_username"} (ID: ${userId})`);
  return null;
}

export function isAdmin(userId: number): boolean {
  const member = ALLOWED_IDS[userId];
  return member?.role === "admin";
}

// =====================================================================
// TEAM BOT (@flowmortgagecoteambot) -- separate roster from the main/admin bot.
// The main bot above stays Alex-only; the team bot is the staff-facing one.
// Registration phase: TEAM_BOT_SETUP_MODE lets staff message it once so we can
// capture their numeric IDs, then we fill TEAM_BOT_IDS and flip setup off to lock it.
// =====================================================================
const TEAM_AGENTS = ["pipeline", "cx", "general"];

const TEAM_BOT_IDS: Record<number, TeamMember> = {
  7544938550: { name: "Alex", role: "admin", agents: TEAM_AGENTS },
  // Added after registration (collect IDs via the bot in setup mode):
  // James, Lidia, Sckala, Erica, Amy, Leah  (Joana pending channel decision)
};

// Flip to false once the roster above is filled, to lock the team bot to staff only.
const TEAM_BOT_SETUP_MODE = true;

export function getTeamBotMember(userId: number, username?: string): TeamMember | null {
  if (TEAM_BOT_IDS[userId]) return TEAM_BOT_IDS[userId];

  if (TEAM_BOT_SETUP_MODE) {
    console.log(`[TEAM SETUP] Unregistered team-bot user: ${username || "no_username"} (ID: ${userId})`);
    return { name: username || `user_${userId}`, role: "team", agents: TEAM_AGENTS };
  }

  console.log(`[TEAM DENIED] Unauthorized team-bot user: ${username || "no_username"} (ID: ${userId})`);
  return null;
}
