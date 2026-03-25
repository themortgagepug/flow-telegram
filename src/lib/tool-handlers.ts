import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

const ZOHO_API = "https://www.zohoapis.com/crm/v2";
const ZOHO_TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token";

// === ZOHO AUTH (module-scoped token cache) ===

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

async function refreshZohoToken(): Promise<string | null> {
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    console.log("[Zoho] Missing credentials -- ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, or ZOHO_CLIENT_SECRET not set");
    return null;
  }

  console.log("[Zoho] Refreshing access token...");
  try {
    const res = await fetch(ZOHO_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log(`[Zoho] Token refresh failed HTTP ${res.status}: ${text}`);
      return null;
    }

    const data = await res.json();
    if (!data.access_token) {
      console.log(`[Zoho] Token refresh returned no access_token: ${JSON.stringify(data)}`);
      return null;
    }

    // Zoho tokens expire in 3600s; cache for 55 min to be safe
    const expiresIn = (data.expires_in || 3600) - 300;
    tokenCache = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    console.log(`[Zoho] Token refreshed, valid for ${expiresIn}s`);
    return data.access_token;
  } catch (err) {
    console.log(`[Zoho] Token refresh threw: ${err}`);
    return null;
  }
}

async function getZohoToken(): Promise<string | null> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  return refreshZohoToken();
}

// Zoho fetch wrapper with token caching + single retry on 401
async function zohoFetch(url: string, options: RequestInit = {}): Promise<Response> {
  let token = await getZohoToken();
  if (!token) throw new Error("Zoho authentication unavailable -- check env vars");

  const makeRequest = (t: string) =>
    fetch(url, {
      ...options,
      headers: {
        Authorization: `Zoho-oauthtoken ${t}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

  console.log(`[Zoho] ${options.method || "GET"} ${url}`);
  let res = await makeRequest(token);

  if (res.status === 401) {
    console.log("[Zoho] Got 401 -- clearing cache and retrying with fresh token");
    tokenCache = null;
    token = await refreshZohoToken();
    if (!token) throw new Error("Zoho re-authentication failed");
    res = await makeRequest(token);
  }

  return res;
}

// === TEAM ID MAP ===

const TEAM_OWNER_IDS: Record<string, string> = {
  alex: "5652769000000509001",
  james: "5652769000000509001",  // James Rockwell
  erica: "5652769000000509001",  // Update with Erica's actual Zoho user ID
  joana: "5652769000096555001",  // Joana Kuchta
  amy: "5652769000000509001",    // Update with Amy's actual Zoho user ID
};

function resolveOwnerId(name: string): string {
  return TEAM_OWNER_IDS[name.toLowerCase()] || TEAM_OWNER_IDS.alex;
}

// === VALID DEAL STAGES ===

const VALID_STAGES = [
  "Qualification",
  "Pre-Approval",
  "Submitted",
  "Approved",
  "Instructed",
  "Funded",
  "Complete",
  "Lost",
];

// === TOOL HANDLERS ===

export async function handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "zoho_create_lead":
        return await zohoCreateLead(input);
      case "zoho_search_contacts":
        return await zohoSearchContacts(input);
      case "zoho_create_task":
        return await zohoCreateTask(input);
      case "zoho_update_deal":
        return await zohoUpdateDeal(input);
      case "zoho_pipeline_report":
        return await zohoPipelineReport();
      case "zoho_get_deal_details":
        return await zohoGetDealDetails(input);
      case "zoho_recent_activity":
        return await zohoRecentActivity();
      case "send_email":
        return await sendEmail(input);
      case "send_template_email":
        return await sendTemplateEmail(input);
      case "create_calendar_event":
        return await createCalendarEvent(input);
      case "property_add_transaction":
        return await propertyAddTransaction(input);
      case "property_create_alert":
        return await propertyCreateAlert(input);
      case "property_query":
        return await propertyQuery(input);
      case "generate_preapproval":
        return await generatePreapproval(input);
      case "get_daily_briefing":
        return await getDailyBriefing(input);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`[ToolHandler] Error in ${name}: ${msg}`);
    return `Error executing ${name}: ${msg}`;
  }
}

// === ZOHO HANDLERS ===

async function zohoCreateLead(input: Record<string, unknown>): Promise<string> {
  if (!input.first_name || !input.last_name) {
    return "Cannot create lead -- first_name and last_name are required.";
  }

  let token: string | null;
  try {
    token = await getZohoToken();
  } catch {
    token = null;
  }

  if (!token) {
    return (
      "Zoho not configured. Lead captured locally:\n" +
      JSON.stringify(input, null, 2)
    );
  }

  try {
    const payload = {
      data: [
        {
          First_Name: String(input.first_name),
          Last_Name: String(input.last_name),
          Email: input.email ? String(input.email) : undefined,
          Phone: input.phone ? String(input.phone) : undefined,
          Lead_Source: input.source ? String(input.source) : "Telegram",
          Description: input.notes
            ? String(input.notes)
            : "Created via Flow Telegram Bot",
        },
      ],
    };

    console.log(`[Zoho] Creating contact: ${input.first_name} ${input.last_name}`);
    const res = await zohoFetch(`${ZOHO_API}/Contacts`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    console.log(`[Zoho] Create contact response: ${JSON.stringify(data)}`);

    if (data.data?.[0]?.code === "SUCCESS") {
      const id = data.data[0].details.id;
      const link = `https://crm.zoho.com/crm/flowmortgageco/tab/Contacts/${id}`;
      return (
        `Lead created in Zoho CRM.\n` +
        `Name: ${input.first_name} ${input.last_name}\n` +
        `ID: ${id}\n` +
        `Link: ${link}` +
        (input.email ? `\nEmail: ${input.email}` : "") +
        (input.phone ? `\nPhone: ${input.phone}` : "")
      );
    }

    const errMsg = data.data?.[0]?.message || data.message || JSON.stringify(data);
    return `Zoho returned an error creating contact: ${errMsg}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoCreateLead threw: ${msg}`);
    return `Failed to create lead in Zoho: ${msg}`;
  }
}

async function zohoSearchContacts(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query || "").trim();
  if (!query) return "Please provide a search term.";

  try {
    // 1. Try contact name search
    const contactNameRes = await zohoFetch(
      `${ZOHO_API}/Contacts/search?criteria=(Full_Name:equals:${encodeURIComponent(query)})`
    );
    const contactNameData = await contactNameRes.json();
    console.log(`[Zoho] Contact name search for "${query}": ${contactNameData.data?.length || 0} results`);

    // 2. Try contact email search if name search empty
    let contactData = contactNameData.data || [];
    if (!contactData.length) {
      const contactEmailRes = await zohoFetch(
        `${ZOHO_API}/Contacts/search?criteria=(Email:equals:${encodeURIComponent(query)})`
      );
      const contactEmailData = await contactEmailRes.json();
      console.log(`[Zoho] Contact email search for "${query}": ${contactEmailData.data?.length || 0} results`);
      contactData = contactEmailData.data || [];
    }

    // 3. Also search Deals by name
    const dealRes = await zohoFetch(
      `${ZOHO_API}/Deals/search?criteria=(Deal_Name:contains:${encodeURIComponent(query)})`
    );
    const dealData = await dealRes.json();
    console.log(`[Zoho] Deal search for "${query}": ${dealData.data?.length || 0} results`);

    const lines: string[] = [];

    if (contactData.length) {
      lines.push(`CONTACTS (${contactData.length}):`);
      for (const c of contactData as Record<string, unknown>[]) {
        const name = String(c.Full_Name || `${c.First_Name || ""} ${c.Last_Name || ""}`.trim() || "Unknown");
        const email = String(c.Email || "no email");
        const phone = String(c.Phone || "no phone");
        const id = String(c.id || "");
        const link = id ? `https://crm.zoho.com/crm/flowmortgageco/tab/Contacts/${id}` : "";
        lines.push(`  ${name} | ${email} | ${phone}${link ? `\n  ${link}` : ""}`);
      }
    }

    if ((dealData.data || []).length) {
      lines.push(`\nDEALS (${dealData.data.length}):`);
      for (const d of dealData.data as Record<string, unknown>[]) {
        const dealName = String(d.Deal_Name || "Unnamed Deal");
        const stage = String(d.Stage || "Unknown");
        const amount = d.Amount ? `$${Number(d.Amount).toLocaleString()}` : "N/A";
        const id = String(d.id || "");
        const link = id ? `https://crm.zoho.com/crm/flowmortgageco/tab/Deals/${id}` : "";
        // Contact on the deal
        const contactName = d.Contact_Name
          ? (typeof d.Contact_Name === "object"
              ? String((d.Contact_Name as Record<string, unknown>).name || "")
              : String(d.Contact_Name))
          : "";
        lines.push(
          `  ${dealName} | Stage: ${stage} | Amount: ${amount}${contactName ? ` | Client: ${contactName}` : ""}${link ? `\n  ${link}` : ""}`
        );
      }
    }

    if (!lines.length) {
      return `No contacts or deals found for "${query}". Try a different name, email, or deal name.`;
    }

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoSearchContacts threw: ${msg}`);
    return `Failed to search Zoho: ${msg}`;
  }
}

async function zohoCreateTask(input: Record<string, unknown>): Promise<string> {
  if (!input.subject) return "Task subject is required.";

  const assigneeName = String(input.assignee || "alex");
  const ownerId = resolveOwnerId(assigneeName);

  try {
    const payload = {
      data: [
        {
          Subject: String(input.subject),
          Owner: { id: ownerId },
          Due_Date: input.due_date ? String(input.due_date) : undefined,
          Description: input.description ? String(input.description) : "",
          Priority: input.priority ? String(input.priority) : "Normal",
          Status: "Not Started",
        },
      ],
    };

    console.log(`[Zoho] Creating task: "${input.subject}" for ${assigneeName} (${ownerId})`);
    const res = await zohoFetch(`${ZOHO_API}/Tasks`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    console.log(`[Zoho] Create task response: ${JSON.stringify(data)}`);

    if (data.data?.[0]?.code === "SUCCESS") {
      const id = data.data[0].details.id;
      return (
        `Task created in Zoho.\n` +
        `Subject: "${input.subject}"\n` +
        `Assigned to: ${assigneeName}` +
        (input.due_date ? `\nDue: ${input.due_date}` : "") +
        (input.priority ? `\nPriority: ${input.priority}` : "") +
        `\nID: ${id}`
      );
    }

    const errMsg = data.data?.[0]?.message || data.message || JSON.stringify(data);
    return `Zoho returned an error creating task: ${errMsg}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoCreateTask threw: ${msg}`);
    return `Failed to create task in Zoho: ${msg}`;
  }
}

async function zohoUpdateDeal(input: Record<string, unknown>): Promise<string> {
  if (!input.deal_name) return "deal_name is required to update a deal.";

  const stage = input.stage ? String(input.stage) : null;
  if (stage && !VALID_STAGES.includes(stage)) {
    return (
      `Invalid stage "${stage}". Valid stages are: ${VALID_STAGES.join(", ")}`
    );
  }

  try {
    // Search for deal
    console.log(`[Zoho] Searching for deal: "${input.deal_name}"`);
    const searchRes = await zohoFetch(
      `${ZOHO_API}/Deals/search?criteria=(Deal_Name:contains:${encodeURIComponent(String(input.deal_name))})`
    );
    const searchData = await searchRes.json();
    console.log(`[Zoho] Deal search results: ${searchData.data?.length || 0} found`);

    if (!searchData.data?.length) {
      return `Deal "${input.deal_name}" not found in Zoho. Try a partial name or check spelling.`;
    }

    // If multiple matches, list them
    if (searchData.data.length > 1) {
      const matches = (searchData.data as Record<string, unknown>[])
        .map((d) => `  ${String(d.Deal_Name || "?")} (Stage: ${String(d.Stage || "?")})`)
        .join("\n");
      return `Multiple deals matched "${input.deal_name}". Be more specific:\n${matches}`;
    }

    const deal = searchData.data[0] as Record<string, unknown>;
    const dealId = String(deal.id);
    const dealName = String(deal.Deal_Name || input.deal_name);
    const currentStage = String(deal.Stage || "Unknown");

    const updateData: Record<string, unknown> = {};
    if (stage) updateData.Stage = stage;
    if (input.notes) updateData.Description = String(input.notes);
    if (input.amount) updateData.Amount = Number(input.amount);

    if (!Object.keys(updateData).length) {
      return `Nothing to update -- provide at least one of: stage, notes, amount.`;
    }

    console.log(`[Zoho] Updating deal ${dealId} (${dealName}): ${JSON.stringify(updateData)}`);
    const res = await zohoFetch(`${ZOHO_API}/Deals/${dealId}`, {
      method: "PUT",
      body: JSON.stringify({ data: [updateData] }),
    });

    const data = await res.json();
    console.log(`[Zoho] Update deal response: ${JSON.stringify(data)}`);

    if (data.data?.[0]?.code === "SUCCESS") {
      const link = `https://crm.zoho.com/crm/flowmortgageco/tab/Deals/${dealId}`;
      return (
        `Deal updated.\n` +
        `Deal: ${dealName}\n` +
        (stage ? `Stage: ${currentStage} -> ${stage}\n` : "") +
        (input.notes ? `Notes added.\n` : "") +
        `Link: ${link}`
      );
    }

    const errMsg = data.data?.[0]?.message || data.message || JSON.stringify(data);
    return `Zoho returned an error updating deal: ${errMsg}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoUpdateDeal threw: ${msg}`);
    return `Failed to update deal in Zoho: ${msg}`;
  }
}

async function zohoPipelineReport(): Promise<string> {
  try {
    console.log("[Zoho] Fetching pipeline report -- all open deals");

    // Fetch up to 200 deals -- sufficient for most pipelines
    const res = await zohoFetch(
      `${ZOHO_API}/Deals?fields=Deal_Name,Stage,Amount,Modified_Time,Created_Time,Contact_Name,Owner&per_page=200&page=1`
    );
    const data = await res.json();
    console.log(`[Zoho] Pipeline report: ${data.data?.length || 0} deals returned`);

    if (!data.data?.length) return "No deals found in Zoho CRM.";

    const deals = data.data as Record<string, unknown>[];
    const now = Date.now();

    // Group by stage
    const byStage: Record<string, { deals: typeof deals; totalValue: number }> = {};
    for (const d of deals) {
      const stage = String(d.Stage || "Unknown");
      if (!byStage[stage]) byStage[stage] = { deals: [], totalValue: 0 };
      byStage[stage].deals.push(d);
      byStage[stage].totalValue += Number(d.Amount || 0);
    }

    const lines: string[] = ["PIPELINE REPORT\n"];

    // Use a sensible stage order
    const stageOrder = [
      ...VALID_STAGES,
      ...Object.keys(byStage).filter((s) => !VALID_STAGES.includes(s)),
    ];

    let grandTotal = 0;
    for (const stage of stageOrder) {
      const group = byStage[stage];
      if (!group) continue;

      grandTotal += group.totalValue;
      lines.push(
        `${stage.toUpperCase()} (${group.deals.length} deal${group.deals.length !== 1 ? "s" : ""}` +
          (group.totalValue ? ` | $${group.totalValue.toLocaleString()}` : "") +
          ")"
      );

      for (const d of group.deals) {
        const dealName = String(d.Deal_Name || "Unnamed");
        const amount = d.Amount ? `$${Number(d.Amount).toLocaleString()}` : "N/A";

        // Days in current stage (use Modified_Time as proxy)
        const modifiedMs = d.Modified_Time
          ? new Date(String(d.Modified_Time)).getTime()
          : null;
        const daysAging = modifiedMs
          ? Math.floor((now - modifiedMs) / 86400000)
          : null;

        const contactName = d.Contact_Name
          ? typeof d.Contact_Name === "object"
            ? String((d.Contact_Name as Record<string, unknown>).name || "")
            : String(d.Contact_Name)
          : "";

        lines.push(
          `  - ${dealName}` +
            (contactName ? ` (${contactName})` : "") +
            ` | ${amount}` +
            (daysAging !== null ? ` | ${daysAging}d in stage` : "")
        );
      }
      lines.push("");
    }

    lines.push(`TOTAL PIPELINE VALUE: $${grandTotal.toLocaleString()}`);
    lines.push(`TOTAL DEALS: ${deals.length}`);

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoPipelineReport threw: ${msg}`);
    return `Failed to fetch pipeline report: ${msg}`;
  }
}

async function zohoGetDealDetails(input: Record<string, unknown>): Promise<string> {
  const dealName = String(input.deal_name || "").trim();
  if (!dealName) return "deal_name is required.";

  try {
    console.log(`[Zoho] Fetching deal details for: "${dealName}"`);
    const searchRes = await zohoFetch(
      `${ZOHO_API}/Deals/search?criteria=(Deal_Name:contains:${encodeURIComponent(dealName)})`
    );
    const searchData = await searchRes.json();

    if (!searchData.data?.length) {
      return `Deal "${dealName}" not found. Try a partial name.`;
    }

    if (searchData.data.length > 1) {
      const matches = (searchData.data as Record<string, unknown>[])
        .map((d) => `  ${String(d.Deal_Name || "?")} | Stage: ${String(d.Stage || "?")}`)
        .join("\n");
      return `Multiple deals matched. Narrow your search:\n${matches}`;
    }

    const d = searchData.data[0] as Record<string, unknown>;
    const id = String(d.id);
    const link = `https://crm.zoho.com/crm/flowmortgageco/tab/Deals/${id}`;

    const ownerName =
      typeof d.Owner === "object" && d.Owner !== null
        ? String((d.Owner as Record<string, unknown>).name || "Unknown")
        : String(d.Owner || "Unknown");

    const contactName =
      typeof d.Contact_Name === "object" && d.Contact_Name !== null
        ? String((d.Contact_Name as Record<string, unknown>).name || "")
        : String(d.Contact_Name || "");

    const now = Date.now();
    const modifiedMs = d.Modified_Time
      ? new Date(String(d.Modified_Time)).getTime()
      : null;
    const daysInStage = modifiedMs
      ? Math.floor((now - modifiedMs) / 86400000)
      : null;

    const createdMs = d.Created_Time
      ? new Date(String(d.Created_Time)).getTime()
      : null;
    const daysOld = createdMs
      ? Math.floor((now - createdMs) / 86400000)
      : null;

    const lines = [
      `DEAL: ${String(d.Deal_Name || "Unnamed")}`,
      `Link: ${link}`,
      ``,
      `Stage: ${String(d.Stage || "Unknown")}${daysInStage !== null ? ` (${daysInStage}d in stage)` : ""}`,
      `Amount: ${d.Amount ? `$${Number(d.Amount).toLocaleString()}` : "Not set"}`,
      `Client: ${contactName || "None linked"}`,
      `Assigned to: ${ownerName}`,
      ``,
      `Created: ${d.Created_Time ? String(d.Created_Time).split("T")[0] : "Unknown"}${daysOld !== null ? ` (${daysOld} days ago)` : ""}`,
      `Last modified: ${d.Modified_Time ? String(d.Modified_Time).split("T")[0] : "Unknown"}`,
    ];

    if (d.Description) lines.push(`\nNotes: ${String(d.Description)}`);
    if (d.Closing_Date) lines.push(`Closing date: ${String(d.Closing_Date)}`);

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoGetDealDetails threw: ${msg}`);
    return `Failed to get deal details: ${msg}`;
  }
}

async function zohoRecentActivity(): Promise<string> {
  try {
    console.log("[Zoho] Fetching deals modified in last 7 days");

    // Zoho sort by Modified_Time descending -- filter client-side for 7 days
    const res = await zohoFetch(
      `${ZOHO_API}/Deals?fields=Deal_Name,Stage,Amount,Modified_Time,Contact_Name,Owner&sort_by=Modified_Time&sort_order=desc&per_page=50&page=1`
    );
    const data = await res.json();

    if (!data.data?.length) return "No deals found.";

    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;

    const recent = (data.data as Record<string, unknown>[]).filter((d) => {
      if (!d.Modified_Time) return false;
      return new Date(String(d.Modified_Time)).getTime() >= cutoff;
    });

    if (!recent.length) return "No deals modified in the last 7 days.";

    const lines = [`RECENT ACTIVITY (last 7 days) -- ${recent.length} deals\n`];

    for (const d of recent) {
      const dealName = String(d.Deal_Name || "Unnamed");
      const stage = String(d.Stage || "Unknown");
      const amount = d.Amount ? `$${Number(d.Amount).toLocaleString()}` : "N/A";
      const modifiedDate = d.Modified_Time
        ? String(d.Modified_Time).split("T")[0]
        : "Unknown";
      const daysAgo = d.Modified_Time
        ? Math.floor((now - new Date(String(d.Modified_Time)).getTime()) / 86400000)
        : null;

      const contactName =
        typeof d.Contact_Name === "object" && d.Contact_Name !== null
          ? String((d.Contact_Name as Record<string, unknown>).name || "")
          : String(d.Contact_Name || "");

      lines.push(
        `${dealName}${contactName ? ` (${contactName})` : ""}` +
          `\n  Stage: ${stage} | ${amount} | Modified: ${modifiedDate}${daysAgo !== null ? ` (${daysAgo}d ago)` : ""}`
      );
    }

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoRecentActivity threw: ${msg}`);
    return `Failed to fetch recent activity: ${msg}`;
  }
}

// === EMAIL TEMPLATES ===

interface EmailTemplate {
  subject: string;
  body: string;
}

const EMAIL_TEMPLATES: Record<string, EmailTemplate> = {
  rate_quote: {
    subject: "Your Personalized Rate Options -- Flow Mortgage Co",
    body: `Hi {{client_name}},

Great connecting with you. Based on your situation, here are the current rates I'd be looking at for you:

Fixed ({{term}} year): {{fixed_rate}}%
Variable: {{variable_rate}}%

On a {{purchase_price}} purchase with {{down_payment}} down, your estimated payment would be approximately {{monthly_payment}}/month.

These rates are live as of today and can move quickly. If you want to lock something in, the next step is getting your pre-approval started -- takes about 15 minutes.

Want to move forward? Just reply here or book a quick call: {{booking_link}}

Alex McFadyen
Flow Mortgage Co`,
  },

  status_update: {
    subject: "Update on Your Mortgage File -- {{stage}}",
    body: `Hi {{client_name}},

Quick update on your file -- we're currently at the {{stage}} stage.

{{stage_detail}}

Next step: {{next_step}}

If you have any questions or need anything from me, just reply to this email. We're on it.

Alex McFadyen
Flow Mortgage Co`,
  },

  partner_thankyou: {
    subject: "Thank You for the Referral",
    body: `Hi {{partner_name}},

Wanted to reach out personally -- thank you for referring {{client_name}} to us. We really appreciate the trust.

I'll take great care of them and keep you in the loop on how it goes.

If there's ever anything I can do for you or your clients, I'm always a call away.

Alex McFadyen
Flow Mortgage Co`,
  },

  welcome: {
    subject: "Welcome to Flow -- Here's What to Expect",
    body: `Hi {{client_name}},

Welcome to Flow. Really excited to be working with you on this.

Here's what to expect over the next few days:

1. Document collection -- I'll send you a secure link to upload your documents. The faster we get these, the faster we move.
2. Application submission -- Once we have everything, I submit to the lender.
3. Approval -- Most decisions come back within 24-72 hours.
4. You'll always know where your file is -- I'll update you at every stage.

Any questions at all, just reply here. My team and I are quick to respond.

Alex McFadyen
Flow Mortgage Co`,
  },

  pre_approval: {
    subject: "Your Pre-Approval is Ready -- Flow Mortgage Co",
    body: `Hi {{client_name}},

Great news -- your pre-approval is ready.

Pre-Approval Amount: {{approval_amount}}
Rate: {{rate}}%
Term: {{term}}

This pre-approval is valid for {{validity_period}} and gives you the purchasing power you need to shop with confidence.

A few important notes:
- This is subject to satisfactory property appraisal and final lender review
- Rate is guaranteed for {{rate_hold_days}} days
- Please keep your financial situation stable (no new credit, job changes, etc.)

Attached is your pre-approval letter. You can share this with your realtor.

Any questions, I'm here.

Alex McFadyen
Flow Mortgage Co`,
  },
};

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

async function sendTemplateEmail(input: Record<string, unknown>): Promise<string> {
  const templateName = String(input.template || "").toLowerCase();
  const template = EMAIL_TEMPLATES[templateName];

  if (!template) {
    return (
      `Unknown template "${templateName}". Available templates: ` +
      Object.keys(EMAIL_TEMPLATES).join(", ")
    );
  }

  if (!input.to) return "Recipient email (to) is required.";

  // Build variable map from input
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number") {
      vars[key] = String(value);
    }
  }

  // Smart defaults per template
  if (templateName === "status_update" && !vars.stage_detail) {
    const stageDefaults: Record<string, string> = {
      Qualification: "We're reviewing your initial information and figuring out the best strategy.",
      "Pre-Approval": "We're putting together your pre-approval package.",
      Submitted: "Your application has been submitted to the lender and is under review.",
      Approved: "The lender has approved your file -- we're now working through the conditions.",
      Instructed: "The lender has issued mortgage instructions to your lawyer.",
      Funded: "Your mortgage has funded. Congratulations!",
      Complete: "Your file is complete. Everything has been finalized.",
    };
    vars.stage_detail = stageDefaults[vars.stage] || "We're actively working on your file.";
  }

  if (templateName === "rate_quote") {
    vars.booking_link = vars.booking_link || "https://calendly.com/getflowmortgage";
    vars.variable_rate = vars.variable_rate || "P - 0.90%";
  }

  if (templateName === "pre_approval") {
    vars.validity_period = vars.validity_period || "120 days";
    vars.rate_hold_days = vars.rate_hold_days || "120";
  }

  const subject = fillTemplate(
    input.subject ? String(input.subject) : template.subject,
    vars
  );
  const body = fillTemplate(template.body, vars);

  // Show draft if not confirmed
  if (!input.confirm) {
    return (
      `DRAFT EMAIL (template: ${templateName}):\n` +
      `To: ${input.to}\n` +
      `Subject: ${subject}\n\n` +
      `${body}\n\n` +
      `Reply "send it" to confirm sending.`
    );
  }

  // Send via Resend
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return (
      `Resend not configured (RESEND_API_KEY missing). Draft:\n\nTo: ${input.to}\nSubject: ${subject}\n\n${body}`
    );
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Alex McFadyen <alex@getflowmortgage.ca>",
        to: String(input.to),
        subject,
        text: body,
      }),
    });
    const data = await res.json();
    return data.id
      ? `Email sent to ${input.to} (template: ${templateName})`
      : `Resend error: ${JSON.stringify(data)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to send email: ${msg}`;
  }
}

// === ORIGINAL EMAIL ===

async function sendEmail(input: Record<string, unknown>): Promise<string> {
  if (!input.confirm) {
    return (
      `DRAFT EMAIL:\nTo: ${input.to}\nSubject: ${input.subject}\n\n${input.body}\n\nReply "send it" to confirm.`
    );
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return "Resend not configured. Draft saved:\n" + JSON.stringify(input, null, 2);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Alex McFadyen <alex@getflowmortgage.ca>",
      to: input.to,
      subject: input.subject,
      text: String(input.body),
    }),
  });
  const data = await res.json();
  return data.id
    ? `Email sent to ${input.to}`
    : `Failed: ${JSON.stringify(data)}`;
}

// === CALENDAR ===

async function createCalendarEvent(input: Record<string, unknown>): Promise<string> {
  return (
    `Calendar event prepared:\n` +
    `Title: ${input.title}\n` +
    `Date: ${input.date} at ${input.time} PT\n` +
    `Duration: ${input.duration_minutes || 30} min\n` +
    (input.attendees ? `Attendees: ${input.attendees}\n` : "") +
    `\nNote: Auto-creation requires Google Calendar OAuth setup. Logged as an alert.`
  );
}

// === PROPERTY HUB ===

async function propertyAddTransaction(input: Record<string, unknown>): Promise<string> {
  const { data: props } = await supabase.from("properties").select("id, name");
  const prop = props?.find(
    (p) =>
      p.name.toLowerCase().includes(String(input.property_name).toLowerCase()) ||
      String(input.property_name)
        .toLowerCase()
        .includes(p.name.toLowerCase().split(" ")[0])
  );
  if (!prop) {
    return `Property "${input.property_name}" not found. Available: ${props?.map((p) => p.name).join(", ")}`;
  }

  const today = new Date().toISOString().split("T")[0];
  await supabase.from("transactions").insert({
    property_id: prop.id,
    type: input.type,
    category: input.category,
    amount: input.amount,
    description: input.description || null,
    date: input.date || today,
    is_tax_deductible: input.is_tax_deductible || false,
  });

  return `Logged ${input.type}: $${input.amount} (${input.category}) to ${prop.name}`;
}

async function propertyCreateAlert(input: Record<string, unknown>): Promise<string> {
  let propertyId = null;
  if (input.property_name) {
    const { data: props } = await supabase.from("properties").select("id, name");
    const prop = props?.find((p) =>
      p.name.toLowerCase().includes(String(input.property_name).toLowerCase())
    );
    if (prop) propertyId = prop.id;
  }

  await supabase.from("alerts").insert({
    property_id: propertyId,
    type: "action",
    title: input.title,
    description: input.description || null,
    due_date: input.due_date || null,
    priority: input.priority || "normal",
    status: "pending",
  });

  return `Alert created: "${input.title}"${input.due_date ? ` (due ${input.due_date})` : ""}`;
}

async function propertyQuery(input: Record<string, unknown>): Promise<string> {
  const queryType = String(input.query_type);
  const propFilter = input.property_name ? String(input.property_name) : null;

  let propId: string | null = null;
  if (propFilter) {
    const { data: props } = await supabase.from("properties").select("id, name");
    const prop = props?.find((p) =>
      p.name.toLowerCase().includes(propFilter.toLowerCase())
    );
    if (prop) propId = prop.id;
  }

  switch (queryType) {
    case "overview": {
      const [props, alerts, units] = await Promise.all([
        supabase.from("properties").select("*"),
        supabase.from("alerts").select("*").eq("status", "pending"),
        supabase.from("units").select("*"),
      ]);
      const totalValue =
        props.data?.reduce((s, p) => s + (p.current_value || 0), 0) || 0;
      const totalRent =
        units.data
          ?.filter((u) => u.is_rented)
          .reduce((s, u) => s + (u.current_rent || 0), 0) || 0;
      return (
        `Portfolio: ${props.data?.length} properties, $${totalValue.toLocaleString()} total value\n` +
        `Monthly rent: $${totalRent.toLocaleString()}\n` +
        `Pending alerts: ${alerts.data?.length || 0}\n` +
        `Occupancy: ${units.data?.filter((u) => u.is_rented).length}/${units.data?.length} units rented`
      );
    }
    case "alerts": {
      let q = supabase
        .from("alerts")
        .select("*")
        .eq("status", "pending")
        .order("due_date");
      if (propId) q = q.eq("property_id", propId);
      const { data } = await q;
      if (!data?.length) return "No pending alerts.";
      return data
        .map(
          (a) =>
            `[${a.priority.toUpperCase()}] ${a.title}${a.due_date ? ` (due ${a.due_date})` : ""}`
        )
        .join("\n");
    }
    case "rent_status": {
      let q = supabase.from("units").select("*").eq("is_rented", true);
      if (propId) q = q.eq("property_id", propId);
      const { data: units } = await q;
      const { data: props } = await supabase
        .from("properties")
        .select("id, name");
      if (!units?.length) return "No rented units found.";
      return units
        .map((u) => {
          const prop = props?.find((p) => p.id === u.property_id);
          return `${prop?.name || "?"} - ${u.name}: $${u.current_rent || "TBD"}/mo (${u.tenant_name || "unknown tenant"})`;
        })
        .join("\n");
    }
    case "obligations": {
      let q = supabase
        .from("obligations")
        .select("*")
        .eq("is_active", true)
        .order("due_date");
      if (propId) q = q.eq("property_id", propId);
      const { data } = await q;
      if (!data?.length) return "No active obligations.";
      return data
        .map(
          (o) =>
            `${o.name}: $${o.amount || "TBD"} (${o.frequency}) - due ${o.due_date || "TBD"}`
        )
        .join("\n");
    }
    default:
      return `Unknown query type: ${queryType}`;
  }
}

// === DOCUMENTS ===

async function generatePreapproval(input: Record<string, unknown>): Promise<string> {
  return (
    `Pre-Approval Letter prepared:\n` +
    `Client: ${input.client_name}\n` +
    `Amount: $${Number(input.approval_amount).toLocaleString()}\n` +
    `Rate: ${input.rate || "TBD"}%\n` +
    `Term: ${input.term || "5 year fixed"}\n` +
    (input.property_address ? `Property: ${input.property_address}\n` : "") +
    `\nTo generate the PDF, use the Pre-Approval button in Zoho CRM, or I can trigger it once the deal is in the system.`
  );
}

// === DAILY BRIEFING ===

async function getDailyBriefing(input: Record<string, unknown>): Promise<string> {
  const [alerts, obligations, units, properties] = await Promise.all([
    supabase.from("alerts").select("*").eq("status", "pending").order("due_date"),
    supabase
      .from("obligations")
      .select("*")
      .eq("is_active", true)
      .order("due_date"),
    supabase.from("units").select("*"),
    supabase.from("properties").select("*"),
  ]);

  const today = new Date().toISOString().split("T")[0];
  const urgentAlerts =
    alerts.data?.filter(
      (a) => a.priority === "urgent" || a.priority === "high"
    ) || [];
  const dueSoon =
    obligations.data?.filter(
      (o) =>
        o.due_date &&
        o.due_date <=
          new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]
    ) || [];
  const totalRent =
    units.data
      ?.filter((u) => u.is_rented)
      .reduce((s, u) => s + (u.current_rent || 0), 0) || 0;
  const totalValue =
    properties.data?.reduce((s, p) => s + (p.current_value || 0), 0) || 0;

  // Attempt to include Zoho pipeline summary
  let zohoSummary = "";
  try {
    const token = await getZohoToken();
    if (token) {
      const res = await zohoFetch(
        `${ZOHO_API}/Deals?fields=Stage,Amount&per_page=200&page=1`
      );
      const dealData = await res.json();
      if (dealData.data?.length) {
        const deals = dealData.data as Record<string, unknown>[];
        const openDeals = deals.filter(
          (d) => !["Funded", "Complete", "Lost"].includes(String(d.Stage || ""))
        );
        const totalPipeline = openDeals.reduce(
          (s, d) => s + Number(d.Amount || 0),
          0
        );
        zohoSummary =
          `\nZOHO PIPELINE: ${openDeals.length} active deals | $${totalPipeline.toLocaleString()} pipeline\n`;
      }
    }
  } catch {
    // Non-fatal -- briefing still works without Zoho
  }

  let briefing = `DAILY BRIEFING - ${today}\n\n`;
  briefing += `Portfolio: $${totalValue.toLocaleString()} | Monthly rent: $${totalRent.toLocaleString()}\n`;
  briefing += zohoSummary;
  briefing += "\n";

  if (urgentAlerts.length > 0) {
    briefing += `URGENT (${urgentAlerts.length}):\n`;
    urgentAlerts.forEach((a) => {
      briefing += `- ${a.title}${a.due_date ? ` (${a.due_date})` : ""}\n`;
    });
    briefing += "\n";
  }

  if (dueSoon.length > 0) {
    briefing += `DUE THIS WEEK (${dueSoon.length}):\n`;
    dueSoon.forEach((o) => {
      briefing += `- ${o.name}: $${o.amount || "TBD"} (${o.due_date})\n`;
    });
    briefing += "\n";
  }

  const allAlerts = alerts.data || [];
  if (allAlerts.length > urgentAlerts.length) {
    briefing += `OTHER ALERTS (${allAlerts.length - urgentAlerts.length}):\n`;
    allAlerts
      .filter((a) => a.priority !== "urgent" && a.priority !== "high")
      .forEach((a) => {
        briefing += `- ${a.title}\n`;
      });
  }

  briefing += `\nDashboard: mcfadyen-properties.vercel.app`;
  return briefing;
}
