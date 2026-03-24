// Team access control
// Map Telegram user IDs to team members and their permissions
// Alex will need to message the bot first, then we capture his Telegram ID

export type TeamMember = {
  name: string;
  role: string;
  agents: string[]; // which agents they can access
};

// Populated after team members message the bot
// Format: telegram_user_id -> member info
const TEAM: Record<number, TeamMember> = {
  // These get populated when team members first /register with the bot
};

// Allowed Telegram usernames (case insensitive) as fallback
const ALLOWED_USERNAMES: Record<string, TeamMember> = {};

// Admin emails who can access everything
const ADMINS = ["alex@getflowmortgage.ca", "sarahkmcfadyen@gmail.com"];

// For now, allow all users but log who they are
// Alex can lock this down later with /register command
export function getTeamMember(userId: number, username?: string): TeamMember | null {
  // Check registered team members
  if (TEAM[userId]) return TEAM[userId];

  // Check username allowlist
  if (username && ALLOWED_USERNAMES[username.toLowerCase()]) {
    return ALLOWED_USERNAMES[username.toLowerCase()];
  }

  // For now, return a default member (open access during setup)
  // Alex should lock this down after team is registered
  return {
    name: username || `user_${userId}`,
    role: "team",
    agents: ["property", "cx", "rates", "pipeline", "content", "general"],
  };
}

export function isAdmin(userId: number): boolean {
  const member = TEAM[userId];
  return member?.role === "admin";
}
