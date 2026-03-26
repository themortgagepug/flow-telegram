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
const SETUP_MODE = true;

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
