import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

const ZOHO_API = "https://www.zohoapis.com/crm/v7";
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

// REAL Zoho stages (verified from live data)
const VALID_STAGES = [
  "Lead Received",
  "HOT (Contacted & App Sent)",
  "Call Booked",
  "Collecting Documentation",
  "File Processed - Pending PS",
  "Review Summary Commenced",
  "File Review Complete - Clients Waiting",
  "Rate Hold (Pre-App)",
  "No Rate Hold (Pre-App)",
  "Deal Submitted",
  "Lender Approved / Pending Conditions",
  "Deal Instructed",
  "Broker Complete",
  "Compliance Review Completed",
  "Mortgage Closed",
  "Fees Collected",
  "Lost Deal",
  "LOST LEAD",
  "Long Term (On Hold)",
  "Long Term - Approval - More than 4 Months to Close",
  "Post RS Hold/Cold/Expired P/A Files",
  "Hold/Cold Pre-RS",
  "LT Renewals",
  "Additional Properties",
];

// Stage groups for reporting
const ACTIVE_STAGES = [
  "Lead Received", "HOT (Contacted & App Sent)", "Call Booked",
  "Collecting Documentation", "File Processed - Pending PS",
  "Review Summary Commenced", "File Review Complete - Clients Waiting",
  "Rate Hold (Pre-App)", "No Rate Hold (Pre-App)",
  "Deal Submitted", "Lender Approved / Pending Conditions",
  "Deal Instructed", "Broker Complete", "Compliance Review Completed",
];
const FUNDED_STAGES = ["Mortgage Closed", "Fees Collected"];
const LOST_STAGES = ["Lost Deal", "LOST LEAD"];
const HOLD_STAGES = ["Long Term (On Hold)", "Long Term - Approval - More than 4 Months to Close", "Post RS Hold/Cold/Expired P/A Files", "Hold/Cold Pre-RS"];

// === TOOL HANDLERS ===

export async function handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "zoho_create_lead":
        return await zohoCreateLead(input);
      case "zoho_create_full_lead":
        return await zohoCreateFullLead(input);
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
      case "query_brain":
        return await queryBrain(input);
      case "flowiq_search":
        return await flowiqSearch(input);
      case "call_intelligence":
        return await callIntelligence(input);
      case "objection_trends":
        return await objectionTrends();
      case "ceo_dashboard":
        return await ceoDashboard();
      case "revenue_dashboard":
        return await revenueDashboard(input);
      case "partner_intelligence":
        return await partnerIntelligence(input);
      case "mortgage_calculator":
        return await mortgageCalculator(input);
      case "process_partner_call":
        return await processPartnerCall(input);
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

async function zohoCreateFullLead(input: Record<string, unknown>): Promise<string> {
  if (!input.first_name || !input.last_name || !input.email || !input.purpose) {
    return "Full lead requires: first_name, last_name, email, and purpose.";
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

  const firstName = String(input.first_name);
  const lastName = String(input.last_name);
  const email = String(input.email);
  const purpose = String(input.purpose);
  const results: string[] = [];

  try {
    // Step 1: Check for duplicate contact
    let contactId: string | null = null;
    try {
      const searchRes = await zohoFetch(
        `${ZOHO_API}/Contacts/search?criteria=(Email:equals:${encodeURIComponent(email)})`
      );
      const searchData = await searchRes.json();
      if (searchData.data?.length) {
        contactId = String(searchData.data[0].id);
        results.push(`Found existing contact: ${firstName} ${lastName} (${contactId})`);
      }
    } catch {
      // No duplicate found, proceed with creation
    }

    // Step 2: Create Contact if not exists
    if (!contactId) {
      const contactPayload: Record<string, unknown> = {
        First_Name: firstName,
        Last_Name: lastName,
        Email: email,
        Contact_Status: "Lead",
      };

      if (input.phone) contactPayload.Phone = String(input.phone);
      if (input.preferred_name) contactPayload.Other_Name = String(input.preferred_name);
      if (input.income_type) contactPayload.Description = `Income: ${input.income_type}`;
      if (input.preferred_communication) {
        contactPayload.Description = (contactPayload.Description || "") +
          `\nPreferred contact: ${input.preferred_communication}`;
      }

      // Add referral source info
      if (input.referral_source) {
        contactPayload.Lead_Source = String(input.referral_source);
      }

      console.log(`[Zoho] Creating contact: ${firstName} ${lastName}`);
      const contactRes = await zohoFetch(`${ZOHO_API}/Contacts`, {
        method: "POST",
        body: JSON.stringify({ data: [contactPayload] }),
      });
      const contactData = await contactRes.json();

      if (contactData.data?.[0]?.code === "SUCCESS") {
        contactId = String(contactData.data[0].details.id);
        const contactLink = `https://crm.zoho.com/crm/flowmortgageco/tab/Contacts/${contactId}`;
        results.push(`Contact created: ${firstName} ${lastName}\n  ${contactLink}`);
      } else {
        const errMsg = contactData.data?.[0]?.message || JSON.stringify(contactData);
        results.push(`Contact creation issue: ${errMsg}`);
      }
    }

    // Step 3: Create Mortgage (Deal)
    const dealName = `${lastName}, ${firstName} - ${purpose}`;
    const dealPayload: Record<string, unknown> = {
      Deal_Name: dealName,
      Stage: "Qualification",
      Pipeline: "Standard (Mortgages)",
      // AMA field - assign Amy
      AMA: { id: resolveOwnerId("amy") },
      // Owner is Alex
      Owner: { id: resolveOwnerId("alex") },
    };

    if (input.mortgage_amount) dealPayload.Amount = Number(input.mortgage_amount);
    if (contactId) dealPayload.Contact_Name = { id: contactId };

    // Build description with all details
    const descParts: string[] = [];
    descParts.push(`Purpose: ${purpose}`);
    if (input.fthb) descParts.push(`FTHB: Yes`);
    if (input.deal_type) descParts.push(`Deal Type: ${input.deal_type}`);
    if (input.timeline) descParts.push(`Timeline: ${input.timeline}`);
    if (input.expected_ltv) descParts.push(`Expected LTV: ${input.expected_ltv}`);
    if (input.income_type) descParts.push(`Income: ${input.income_type}`);
    if (input.preferred_communication) descParts.push(`Preferred Contact: ${input.preferred_communication}`);
    if (input.referral_source) descParts.push(`Referral Source: ${input.referral_source}`);
    if (input.referrer_name) descParts.push(`Referrer: ${input.referrer_name}`);
    if (input.realtor_name) descParts.push(`Realtor: ${input.realtor_name}`);
    if (input.secondary_first_name) {
      descParts.push(`Co-borrower: ${input.secondary_first_name} ${input.secondary_last_name || ""}`);
      if (input.secondary_email) descParts.push(`Co-borrower Email: ${input.secondary_email}`);
      if (input.secondary_income_type) descParts.push(`Co-borrower Income: ${input.secondary_income_type}`);
    }
    if (input.key_notes) descParts.push(`\nNotes: ${input.key_notes}`);
    if (input.overview) descParts.push(`Overview: ${input.overview}`);
    descParts.push(`\nCreated via Flow Telegram Bot`);
    dealPayload.Description = descParts.join("\n");

    console.log(`[Zoho] Creating deal: ${dealName}`);
    const dealRes = await zohoFetch(`${ZOHO_API}/Deals`, {
      method: "POST",
      body: JSON.stringify({ data: [dealPayload] }),
    });
    const dealData = await dealRes.json();

    let dealId: string | null = null;
    if (dealData.data?.[0]?.code === "SUCCESS") {
      dealId = String(dealData.data[0].details.id);
      const dealLink = `https://crm.zoho.com/crm/flowmortgageco/tab/Deals/${dealId}`;
      results.push(`Mortgage created: ${dealName}\n  Stage: Qualification\n  ${dealLink}`);
    } else {
      const errMsg = dealData.data?.[0]?.message || JSON.stringify(dealData);
      results.push(`Deal creation issue: ${errMsg}`);
    }

    // Step 4: Create Task for Amy to reach out
    const today = new Date();
    const dueDate = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const dueDateStr = dueDate.toISOString().split("T")[0];

    const taskDesc = [
      `New lead: ${firstName} ${lastName}`,
      `Email: ${email}`,
      input.phone ? `Phone: ${input.phone}` : null,
      `Purpose: ${purpose}`,
      input.preferred_communication ? `Preferred contact method: ${input.preferred_communication}` : null,
      input.referral_source ? `Referral: ${input.referral_source}` : null,
      input.referrer_name ? `Referred by: ${input.referrer_name}` : null,
      input.key_notes ? `Notes: ${input.key_notes}` : null,
    ].filter(Boolean).join("\n");

    const taskPayload = {
      data: [
        {
          Subject: `Reach out to new lead: ${firstName} ${lastName}`,
          Owner: { id: resolveOwnerId("amy") },
          Due_Date: dueDateStr,
          Description: taskDesc,
          Priority: "High",
          Status: "Not Started",
          ...(dealId ? { $se_module: "Deals", What_Id: { id: dealId } } : {}),
        },
      ],
    };

    console.log(`[Zoho] Creating outreach task for Amy`);
    const taskRes = await zohoFetch(`${ZOHO_API}/Tasks`, {
      method: "POST",
      body: JSON.stringify(taskPayload),
    });
    const taskData = await taskRes.json();

    if (taskData.data?.[0]?.code === "SUCCESS") {
      results.push(`Task created for Amy: Reach out to ${firstName} ${lastName} (due ${dueDateStr})`);
    } else {
      results.push(`Task creation issue: ${JSON.stringify(taskData)}`);
    }

    // Step 5: Summary
    return (
      `LEAD INTAKE COMPLETE\n` +
      `${"=".repeat(25)}\n` +
      results.join("\n\n") +
      `\n\nAmy has been tasked to reach out.` +
      `\nWelcome email: NOT sent yet` +
      `\nLead stage: Qualification`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Zoho] zohoCreateFullLead threw: ${msg}`);
    return `Failed to create full lead: ${msg}\n\nPartial results:\n${results.join("\n")}`;
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

    // Fetch deals with CEO-level fields
    const DEAL_FIELDS = [
      "Deal_Name", "Stage", "Amount", "Pipeline",
      "Modified_Time", "Created_Time", "Closing_Date",
      "Contact_Name", "Owner", "AMA", "Loan_Specialist",
      "Lender_Name", "Mortgage_Rate", "Amortization_Years",
      "ON_HOLD_Reason", "On_Hold_Reason_Notes", "Hold_Re_engage_Date",
      "Reason_For_Loss", "Lost_To",
      "Condo_Freehold", "City",
      "Mortgage_Type", "Deal_Type", "High_Ratio_Insurable_Uninsurable",
      "Buyer_s_Realtor", "Funded_Date",
      "Date_of_Last_Email", "Additional_Conditions",
    ].join(",");

    const res = await zohoFetch(
      `${ZOHO_API}/Deals?fields=${DEAL_FIELDS}&per_page=200&page=1`
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

        const lender = d.Lender_Name ? ` | ${d.Lender_Name}` : "";
        const closing = d.Closing_Date ? ` | Close: ${d.Closing_Date}` : "";
        const holdReason = d.ON_HOLD_Reason ? ` | HOLD: ${d.ON_HOLD_Reason}` : "";
        const lastEmail = d.Date_of_Last_Email ? ` | Last update: ${d.Date_of_Last_Email}` : "";
        const owner = d.Owner && typeof d.Owner === "object"
          ? String((d.Owner as Record<string, unknown>).name || "")
          : "";
        const ama = d.AMA && typeof d.AMA === "object"
          ? String((d.AMA as Record<string, unknown>).name || "")
          : "";
        const team = (owner || ama) ? ` | ${owner}${ama ? "/" + ama : ""}` : "";
        const staleFlag = daysAging !== null && daysAging >= 5 ? " ⚠️" : "";

        lines.push(
          `  - ${dealName}` +
            (contactName ? ` (${contactName})` : "") +
            ` | ${amount}` +
            (daysAging !== null ? ` | ${daysAging}d` : "") +
            staleFlag +
            lender + closing + holdReason + lastEmail + team
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

    const amaName = typeof d.AMA === "object" && d.AMA !== null
      ? String((d.AMA as Record<string, unknown>).name || "")
      : "";
    const lsName = typeof d.Loan_Specialist === "object" && d.Loan_Specialist !== null
      ? String((d.Loan_Specialist as Record<string, unknown>).name || "")
      : "";

    const lines = [
      `DEAL: ${String(d.Deal_Name || "Unnamed")}`,
      `${link}`,
      ``,
      `Stage: ${String(d.Stage || "Unknown")}${daysInStage !== null ? ` (${daysInStage}d in stage)` : ""}`,
      `Amount: ${d.Amount ? `$${Number(d.Amount).toLocaleString()}` : "Not set"}`,
      `Client: ${contactName || "None linked"}`,
      `MA: ${ownerName}${amaName ? ` | AMA: ${amaName}` : ""}${lsName ? ` | LS: ${lsName}` : ""}`,
    ];

    if (d.Pipeline) lines.push(`Pipeline: ${d.Pipeline}`);
    if (d.Lender_Name) lines.push(`Lender: ${d.Lender_Name}`);
    if (d.Mortgage_Rate) lines.push(`Rate: ${d.Mortgage_Rate}%`);
    if (d.Amortization_Years) lines.push(`Amortization: ${d.Amortization_Years} years`);
    if (d.Mortgage_Type) lines.push(`Type: ${d.Mortgage_Type}`);
    if (d.Deal_Type) lines.push(`Deal Type: ${d.Deal_Type}`);
    if (d.High_Ratio_Insurable_Uninsurable) lines.push(`Insurance: ${d.High_Ratio_Insurable_Uninsurable}`);
    if (d.Condo_Freehold) lines.push(`Property: ${d.Condo_Freehold}`);
    if (d.City) lines.push(`City: ${d.City}`);
    if (d.Closing_Date) lines.push(`Closing: ${d.Closing_Date}`);
    if (d.Funded_Date) lines.push(`Funded: ${d.Funded_Date}`);

    if (d.ON_HOLD_Reason) {
      lines.push(`\nON HOLD: ${d.ON_HOLD_Reason}`);
      if (d.On_Hold_Reason_Notes) lines.push(`Hold notes: ${d.On_Hold_Reason_Notes}`);
      if (d.Hold_Re_engage_Date) lines.push(`Re-engage: ${d.Hold_Re_engage_Date}`);
    }
    if (d.Reason_For_Loss) lines.push(`Lost reason: ${d.Reason_For_Loss}`);

    if (d.Date_of_Last_Email) lines.push(`\nLast client update: ${d.Date_of_Last_Email}`);
    if (d.Additional_Conditions) lines.push(`Conditions: ${String(d.Additional_Conditions).slice(0, 300)}`);

    lines.push(`\nCreated: ${d.Created_Time ? String(d.Created_Time).split("T")[0] : "?"}${daysOld !== null ? ` (${daysOld}d ago)` : ""}`);
    lines.push(`Modified: ${d.Modified_Time ? String(d.Modified_Time).split("T")[0] : "?"}`);

    if (d.Description) lines.push(`\nNotes: ${String(d.Description).slice(0, 500)}`);

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

// === FLOWIQ - LENDER GUIDELINE SEARCH ===

async function flowiqSearch(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query || "").trim();
  if (!query) return "Need a query. E.g. 'self-employed 90% LTV purchase' or 'which lenders do stated income?'";

  try {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const lines: string[] = [];

    // 1. Search lender_guidelines (3,843 rows - columns: lender, policy, status, guideline, category)
    let guidelineQuery = supabase
      .from("lender_guidelines")
      .select("lender, policy, status, guideline, category")
      .limit(25);

    if (input.lender) {
      guidelineQuery = guidelineQuery.ilike("lender", `%${String(input.lender)}%`);
    }

    // Build OR filter across policy and guideline columns
    const orParts = terms.flatMap(t => [`policy.ilike.%${t}%`, `guideline.ilike.%${t}%`]);
    if (orParts.length) {
      guidelineQuery = guidelineQuery.or(orParts.join(","));
    }

    const { data: guidelines, error: gError } = await guidelineQuery;

    if (gError) {
      lines.push(`Guideline search error: ${gError.message}`);
    } else if (guidelines?.length) {
      // Group by lender
      const byLender: Record<string, Array<Record<string, unknown>>> = {};
      for (const r of guidelines) {
        const lender = String(r.lender || "Unknown");
        if (!byLender[lender]) byLender[lender] = [];
        byLender[lender].push(r);
      }

      lines.push(`LENDER GUIDELINES (${guidelines.length} matches across ${Object.keys(byLender).length} lenders):\n`);
      for (const [lender, policies] of Object.entries(byLender)) {
        lines.push(`${lender}:`);
        for (const p of policies.slice(0, 4)) {
          const status = p.status === "Accepted" ? "YES" : p.status === "Not Accepted" ? "NO" : String(p.status || "?");
          lines.push(`  [${status}] ${p.policy}`);
          if (p.guideline) lines.push(`    ${String(p.guideline).slice(0, 200)}`);
        }
        if (policies.length > 4) lines.push(`  ...${policies.length - 4} more policies`);
        lines.push("");
      }
    } else {
      lines.push(`No lender guidelines matched "${query}".`);
    }

    // 2. Also check insurer_rules (CMHC, Sagen, Canada Guaranty)
    const insurerFilter = terms.map(t => `rule_text.ilike.%${t}%,rule_name.ilike.%${t}%`).join(",");
    const { data: insurerRules } = await supabase
      .from("insurer_rules")
      .select("insurer, rule_name, rule_text, rule_category")
      .or(insurerFilter)
      .limit(10);

    if (insurerRules?.length) {
      lines.push(`\nINSURER RULES:`);
      for (const r of insurerRules) {
        lines.push(`${r.insurer} | ${r.rule_name}`);
        lines.push(`  ${String(r.rule_text).slice(0, 200)}`);
      }
    }

    // 3. Also check underwriting_rules (B-20, stress test, etc.)
    const uwFilter = terms.map(t => `rule_description.ilike.%${t}%,rule_name.ilike.%${t}%`).join(",");
    const { data: uwRules } = await supabase
      .from("underwriting_rules")
      .select("rule_type, rule_name, rule_description, applies_to, source")
      .or(uwFilter)
      .limit(5);

    if (uwRules?.length) {
      lines.push(`\nUNDERWRITING RULES:`);
      for (const r of uwRules) {
        lines.push(`${r.rule_name} (${r.source || r.rule_type})`);
        lines.push(`  ${String(r.rule_description).slice(0, 200)}`);
        if (r.applies_to) lines.push(`  Applies to: ${Array.isArray(r.applies_to) ? r.applies_to.join(", ") : r.applies_to}`);
      }
    }

    if (!lines.length) return `No results for "${query}". Try: self-employed, rental, stated income, CMHC, high ratio, etc.`;

    lines.push(`\nSource: FlowIQ (3,843 lender guidelines + insurer rules + B-20)`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `FlowIQ search error: ${msg}`;
  }
}

// === CALL INTELLIGENCE ===

async function callIntelligence(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query || "").trim();
  if (!query) return "Need a search term (client name, topic, keyword).";
  const searchType = String(input.type || "both");

  const lines: string[] = [];

  try {
    // Search transcripts
    if (searchType === "transcripts" || searchType === "both") {
      const { data: transcripts } = await supabase
        .from("call_transcripts")
        .select("id, date, source, client_name, call_type, summary, key_topics, action_items, sentiment")
        .or(`client_name.ilike.%${query}%,summary.ilike.%${query}%,key_topics.ilike.%${query}%`)
        .order("date", { ascending: false })
        .limit(5);

      if (transcripts?.length) {
        lines.push(`CALL TRANSCRIPTS (${transcripts.length}):\n`);
        for (const t of transcripts) {
          lines.push(`${t.date || "?"} | ${t.client_name || "Unknown"} | ${t.call_type || "?"} | ${t.source || "?"}`);
          if (t.summary) lines.push(`  Summary: ${String(t.summary).slice(0, 200)}`);
          if (t.key_topics) lines.push(`  Topics: ${t.key_topics}`);
          if (t.action_items) lines.push(`  Actions: ${String(t.action_items).slice(0, 150)}`);
          if (t.sentiment) lines.push(`  Sentiment: ${t.sentiment}`);
          lines.push("");
        }
      }
    }

    // Search opportunities
    if (searchType === "opportunities" || searchType === "both") {
      const { data: opps } = await supabase
        .from("opportunities")
        .select("id, type, description, client_name, confidence, status, created_at")
        .or(`client_name.ilike.%${query}%,description.ilike.%${query}%,type.ilike.%${query}%`)
        .order("created_at", { ascending: false })
        .limit(10);

      if (opps?.length) {
        lines.push(`OPPORTUNITIES (${opps.length}):\n`);
        for (const o of opps) {
          const conf = o.confidence ? ` | ${Math.round(Number(o.confidence) * 100)}% confidence` : "";
          lines.push(`${o.type || "?"} | ${o.client_name || "?"} | ${o.status || "open"}${conf}`);
          if (o.description) lines.push(`  ${String(o.description).slice(0, 200)}`);
          lines.push("");
        }
      }
    }

    if (!lines.length) return `No call transcripts or opportunities found for "${query}".`;
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Call intelligence error: ${msg}`;
  }
}

// === OBJECTION TRENDS ===

async function objectionTrends(): Promise<string> {
  try {
    // Pull objection data from brain table
    const { data } = await supabase
      .from("brain")
      .select("topic, content")
      .eq("category", "content")
      .ilike("topic", "%Objection%");

    if (!data?.length) return "No objection trend data found in brain.";

    const lines = [`CLIENT OBJECTION TRENDS (from call transcripts):\n`];
    for (const row of data) {
      const topic = String(row.topic || "").replace("Objection Trend: ", "").toUpperCase();
      const content = String(row.content || "");
      // Extract mentions count and key quotes
      const mentionsMatch = content.match(/Mentions: (\d+)/);
      const mentions = mentionsMatch ? mentionsMatch[1] : "?";
      // Get first few client quotes
      const quotes = content.match(/"([^"]{10,80})"/g)?.slice(0, 3) || [];

      lines.push(`${topic} (${mentions} mentions)`);
      for (const q of quotes) {
        lines.push(`  ${q}`);
      }
      lines.push("");
    }

    lines.push("Use these for content ideas, sales coaching, or to prep for common client concerns.");
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Objection trends error: ${msg}`;
  }
}

// === CEO DASHBOARD ===

async function ceoDashboard(): Promise<string> {
  try {
    const DEAL_FIELDS = [
      "Deal_Name", "Stage", "Amount", "Pipeline",
      "Modified_Time", "Created_Time", "Closing_Date",
      "Contact_Name", "Owner", "AMA",
      "Lender_Name", "ON_HOLD_Reason", "On_Hold_Reason_Notes",
      "Date_of_Last_Email", "Funded_Date", "Expected_Mortgage_Amount",
    ].join(",");

    const [dealsRes, tasksRes] = await Promise.all([
      zohoFetch(`${ZOHO_API}/Deals?fields=${DEAL_FIELDS}&per_page=200&page=1`),
      zohoFetch(`${ZOHO_API}/Tasks?fields=Subject,Status,Due_Date,Owner,Priority,What_Id&per_page=50&sort_by=Due_Date&sort_order=asc`),
    ]);

    const dealsData = await dealsRes.json();
    const tasksData = await tasksRes.json();
    const deals = (dealsData.data || []) as Record<string, unknown>[];
    const tasks = (tasksData.data || []) as Record<string, unknown>[];
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];
    const currentMonth = today.slice(0, 7);

    const lines: string[] = [];

    // 1. REVENUE PULSE
    const funded = deals.filter((d) => {
      const stage = String(d.Stage || "");
      if (!FUNDED_STAGES.includes(stage)) return false;
      const fd = String(d.Funded_Date || "");
      return fd.startsWith(currentMonth);
    });
    const mortgageVolume = funded.reduce((sum, d) => sum + Number(d.Expected_Mortgage_Amount || d.Amount || 0), 0);
    const commissionTotal = funded.reduce((sum, d) => sum + Number(d.Amount || 0), 0);
    const dayOfMonth = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const pace = dayOfMonth > 0 ? Math.round((funded.length / dayOfMonth) * daysInMonth) : 0;
    const daysLeft = daysInMonth - dayOfMonth;

    lines.push(`REVENUE: ${funded.length}/35 funded | $${mortgageVolume.toLocaleString()} volume | $${commissionTotal.toLocaleString()} commission | Pace: ${pace}/mo | ${daysLeft}d left`);

    // 2. PIPELINE SNAPSHOT
    const stageCounts: Record<string, { count: number; value: number }> = {};
    for (const d of deals) {
      const stage = String(d.Stage || "");
      if (!ACTIVE_STAGES.includes(stage)) continue;
      if (!stageCounts[stage]) stageCounts[stage] = { count: 0, value: 0 };
      stageCounts[stage].count++;
      stageCounts[stage].value += Number(d.Expected_Mortgage_Amount || d.Amount || 0);
    }
    const totalActive = Object.values(stageCounts).reduce((s, v) => s + v.count, 0);
    const totalValue = Object.values(stageCounts).reduce((s, v) => s + v.value, 0);
    lines.push(`\nPIPELINE: ${totalActive} active deals | $${totalValue.toLocaleString()}`);
    for (const stage of ACTIVE_STAGES) {
      const s = stageCounts[stage];
      if (s) lines.push(`  ${stage}: ${s.count} | $${s.value.toLocaleString()}`);
    }

    // 3. NEEDS ATTENTION -- stuck deals
    const stuck: string[] = [];
    for (const d of deals) {
      const stage = String(d.Stage || "");
      if ([...FUNDED_STAGES, ...LOST_STAGES, ...HOLD_STAGES, "LT Renewals", "Additional Properties"].includes(stage)) continue;
      const modMs = d.Modified_Time ? new Date(String(d.Modified_Time)).getTime() : 0;
      const days = modMs > 0 ? Math.floor((now - modMs) / 86400000) : 0;
      if (days >= 5) {
        const name = String(d.Deal_Name || "?");
        const reason = d.ON_HOLD_Reason ? ` (${d.ON_HOLD_Reason})` : "";
        stuck.push(`  ${name} | ${stage} | ${days}d stale${reason}`);
      }
    }
    if (stuck.length) {
      lines.push(`\nSTUCK (5+ days, need action):`);
      lines.push(...stuck.slice(0, 8));
      if (stuck.length > 8) lines.push(`  ...and ${stuck.length - 8} more`);
    }

    // 4. UPCOMING CLOSINGS
    const sevenDaysOut = new Date(now + 7 * 86400000).toISOString().split("T")[0];
    const closingSoon = deals.filter((d) => {
      const cd = String(d.Closing_Date || "");
      return cd >= today && cd <= sevenDaysOut && !["Funded", "Complete", "Lost"].includes(String(d.Stage));
    });
    if (closingSoon.length) {
      lines.push(`\nCLOSING THIS WEEK:`);
      for (const d of closingSoon) {
        lines.push(`  ${d.Deal_Name} | ${d.Stage} | $${Number(d.Amount || 0).toLocaleString()} | ${d.Closing_Date}`);
      }
    }

    // 5. ON HOLD
    const onHold = deals.filter((d) => HOLD_STAGES.includes(String(d.Stage || "")));
    if (onHold.length) {
      lines.push(`\nON HOLD (${onHold.length}):`);
      for (const d of onHold.slice(0, 5)) {
        const reason = d.ON_HOLD_Reason ? String(d.ON_HOLD_Reason) : "No reason";
        lines.push(`  ${d.Deal_Name} | ${reason}`);
      }
    }

    // 6. OVERDUE TASKS
    const overdue = tasks.filter((t) => {
      const due = String(t.Due_Date || "");
      return due && due < today && String(t.Status) !== "Completed";
    });
    if (overdue.length) {
      lines.push(`\nOVERDUE TASKS (${overdue.length}):`);
      for (const t of overdue.slice(0, 5)) {
        const owner = t.Owner && typeof t.Owner === "object" ? String((t.Owner as Record<string, unknown>).name || "") : "";
        lines.push(`  ${t.Subject} | ${owner} | Due: ${t.Due_Date}`);
      }
    }

    // 7. BIGGEST DEALS IN PLAY
    const bigDeals = deals
      .filter((d) => ACTIVE_STAGES.includes(String(d.Stage || "")) && Number(d.Expected_Mortgage_Amount || d.Amount || 0) > 0)
      .sort((a, b) => Number(b.Expected_Mortgage_Amount || b.Amount || 0) - Number(a.Expected_Mortgage_Amount || a.Amount || 0))
      .slice(0, 5);
    if (bigDeals.length) {
      lines.push(`\nBIGGEST DEALS IN PLAY:`);
      for (const d of bigDeals) {
        const mort = Number(d.Expected_Mortgage_Amount || d.Amount || 0);
        lines.push(`  ${d.Deal_Name} | ${d.Stage} | $${mort.toLocaleString()}${d.Lender_Name ? ` | ${d.Lender_Name}` : ""}`);
      }
    }

    lines.push(`\nData source: Zoho CRM live query (${deals.length} deals scanned)`);
    lines.push(`What do you want to dig into?`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `CEO dashboard error: ${msg}`;
  }
}

// === REVENUE DASHBOARD ===

async function revenueDashboard(input: Record<string, unknown>): Promise<string> {
  try {
    const now = new Date();
    const targetMonth = input.month ? String(input.month) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const [year, month] = targetMonth.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dayOfMonth = now.getMonth() + 1 === month && now.getFullYear() === year ? now.getDate() : daysInMonth;

    // Fetch deals with correct revenue fields
    const res = await zohoFetch(
      `${ZOHO_API}/Deals?fields=Deal_Name,Stage,Amount,Expected_Mortgage_Amount,Funded_Date,Closing_Date,Contact_Name,Lender_Name,Deal_Type,Modified_Time&per_page=200&page=1`
    );
    const data = await res.json();
    if (!data.data?.length) return "No deals found in Zoho CRM.";

    const deals = data.data as Record<string, unknown>[];
    const MONTHLY_TARGET = 35;

    // FUNDED this month = Stage "Mortgage Closed" or "Fees Collected" with Funded_Date in target month
    const funded = deals.filter((d) => {
      const stage = String(d.Stage || "");
      if (!FUNDED_STAGES.includes(stage)) return false;
      const fd = String(d.Funded_Date || "");
      return fd.startsWith(targetMonth);
    });

    // Amount = commission, Expected_Mortgage_Amount = mortgage volume
    const commissionTotal = funded.reduce((sum, d) => sum + Number(d.Amount || 0), 0);
    const mortgageVolume = funded.reduce((sum, d) => sum + Number(d.Expected_Mortgage_Amount || 0), 0);
    const avgMortgage = funded.length > 0 ? mortgageVolume / funded.length : 0;
    const avgCommission = funded.length > 0 ? commissionTotal / funded.length : 0;

    // Projected closings = Deal Instructed + Broker Complete + Compliance Review
    const closeStages = ["Deal Instructed", "Broker Complete", "Compliance Review Completed"];
    const projected = deals.filter((d) => closeStages.includes(String(d.Stage || "")));
    const projectedMortgage = projected.reduce((sum, d) => sum + Number(d.Expected_Mortgage_Amount || 0), 0);
    const projectedCommission = projected.reduce((sum, d) => sum + Number(d.Amount || 0), 0);

    // In pipeline = Lender Approved + Deal Submitted
    const pipeStages = ["Lender Approved / Pending Conditions", "Deal Submitted"];
    const inPipe = deals.filter((d) => pipeStages.includes(String(d.Stage || "")));

    // Pace calculation
    const pace = dayOfMonth > 0 ? Math.round((funded.length / dayOfMonth) * daysInMonth) : 0;
    const remaining = Math.max(0, MONTHLY_TARGET - funded.length);
    const daysLeft = daysInMonth - dayOfMonth;

    const lines: string[] = [];
    lines.push(`REVENUE - ${targetMonth} (VERIFIED FROM ZOHO)\n`);
    lines.push(`FUNDED: ${funded.length} deals`);
    lines.push(`  Mortgage volume: $${mortgageVolume.toLocaleString()}`);
    lines.push(`  Commission: $${commissionTotal.toLocaleString()}`);
    lines.push(`  Avg mortgage: $${Math.round(avgMortgage).toLocaleString()}`);
    lines.push(`  Avg commission: $${Math.round(avgCommission).toLocaleString()}`);
    lines.push(``);
    lines.push(`TARGET: ${MONTHLY_TARGET} deals | ${remaining} to go | ${daysLeft} days left`);
    lines.push(`PACE: ${pace} projected at current rate`);

    if (projected.length) {
      lines.push(`\nABOUT TO FUND (Instructed/Broker Complete/Compliance):`);
      lines.push(`  ${projected.length} deals | $${projectedMortgage.toLocaleString()} mortgage | $${projectedCommission.toLocaleString()} commission`);
      for (const d of projected) {
        const name = String(d.Deal_Name || "?").replace("FLOW - ", "");
        const mort = Number(d.Expected_Mortgage_Amount || 0);
        const comm = Number(d.Amount || 0);
        lines.push(`  - ${name} | $${mort.toLocaleString()} | comm $${comm.toLocaleString()}${d.Lender_Name ? ` | ${d.Lender_Name}` : ""}`);
      }
    }

    if (inPipe.length) {
      lines.push(`\nIN UNDERWRITING (Submitted/Lender Approved):`);
      lines.push(`  ${inPipe.length} deals`);
      for (const d of inPipe.slice(0, 8)) {
        const name = String(d.Deal_Name || "?").replace("FLOW - ", "");
        const mort = Number(d.Expected_Mortgage_Amount || 0);
        lines.push(`  - ${name} | $${mort.toLocaleString()} | ${d.Stage}${d.Lender_Name ? ` | ${d.Lender_Name}` : ""}`);
      }
    }

    if (funded.length > 0) {
      lines.push(`\nFUNDED THIS MONTH:`);
      for (const d of funded) {
        const name = String(d.Deal_Name || "?").replace("FLOW - ", "");
        const mort = Number(d.Expected_Mortgage_Amount || 0);
        const comm = Number(d.Amount || 0);
        lines.push(`  - ${name} | $${mort.toLocaleString()} | comm $${comm.toLocaleString()} | ${d.Funded_Date}${d.Lender_Name ? ` | ${d.Lender_Name}` : ""}`);
      }
    }

    lines.push(`\nData source: Zoho CRM live query (${deals.length} deals scanned)`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Revenue dashboard error: ${msg}`;
  }
}

// === PARTNER INTELLIGENCE ===

async function partnerIntelligence(input: Record<string, unknown>): Promise<string> {
  try {
    const mode = String(input.mode || "followup_suggestions");

    if (mode === "lookup" && input.partner_name) {
      const name = String(input.partner_name);
      const res = await zohoFetch(
        `${ZOHO_API}/Contacts/search?criteria=(Full_Name:contains:${encodeURIComponent(name)})&fields=Full_Name,Email,Phone,Partner_Temperature,Last_Meeting_Date,Next_Touch_Date,Meeting_Count,Touch_Count,Contact_Type,Partner_Status,Referrals_Given,Modified_Time`
      );
      const data = await res.json();
      if (!data.data?.length) return `No partner found matching "${name}".`;

      const lines: string[] = [];
      for (const c of data.data as Record<string, unknown>[]) {
        lines.push(`${c.Full_Name}`);
        if (c.Email) lines.push(`  Email: ${c.Email}`);
        if (c.Phone) lines.push(`  Phone: ${c.Phone}`);
        if (c.Partner_Temperature) lines.push(`  Temperature: ${c.Partner_Temperature}`);
        if (c.Partner_Status) lines.push(`  Rank: ${c.Partner_Status}`);
        if (c.Last_Meeting_Date) lines.push(`  Last Meeting: ${c.Last_Meeting_Date}`);
        if (c.Next_Touch_Date) lines.push(`  Next Touch: ${c.Next_Touch_Date}`);
        if (c.Meeting_Count) lines.push(`  Meetings: ${c.Meeting_Count}`);
        if (c.Referrals_Given) lines.push(`  Referrals: ${c.Referrals_Given}`);
        lines.push("");
      }
      return lines.join("\n");
    }

    // Cold check / followup suggestions - fetch partners with Last_Meeting_Date
    const res = await zohoFetch(
      `${ZOHO_API}/Contacts/search?criteria=(Partner_Temperature:in:Hot,Warm,Cool,Cold,New)&fields=Full_Name,Email,Phone,Partner_Temperature,Last_Meeting_Date,Next_Touch_Date,Referrals_Given,Partner_Status,Modified_Time&per_page=100`
    );
    const data = await res.json();
    if (!data.data?.length) return "No partners found with temperature set in Zoho.";

    const partners = data.data as Record<string, unknown>[];
    const now = Date.now();
    const THREE_WEEKS = 21 * 86400000;

    // Calculate days since last touch
    const withAge = partners.map((p: Record<string, unknown>) => {
      const lastMeeting = p.Last_Meeting_Date ? new Date(String(p.Last_Meeting_Date)).getTime() : 0;
      const lastModified = p.Modified_Time ? new Date(String(p.Modified_Time)).getTime() : 0;
      const lastTouch = Math.max(lastMeeting, lastModified);
      const daysSince = lastTouch > 0 ? Math.floor((now - lastTouch) / 86400000) : 999;
      return { ...p, daysSince, lastTouch } as Record<string, unknown> & { daysSince: number; lastTouch: number };
    });

    if (mode === "cold_check") {
      const cold = withAge.filter((p) => p.daysSince >= 21).sort((a, b) => b.daysSince - a.daysSince);
      if (!cold.length) return "No partners going cold. Everyone's been touched in the last 3 weeks.";

      const lines = [`PARTNERS GOING COLD (21+ days no touch):\n`];
      for (const p of cold.slice(0, 15)) {
        lines.push(`${p.Full_Name} | ${p.Partner_Temperature || "?"} | ${p.daysSince}d ago | Referrals: ${p.Referrals_Given || 0}`);
      }
      return lines.join("\n");
    }

    // followup_suggestions - prioritize by: high temp going cold, most referrals, longest gap
    const suggestions = withAge
      .filter((p) => p.daysSince >= 14)
      .sort((a, b) => {
        // Prioritize hot/warm partners going cold
        const tempScore: Record<string, number> = { Hot: 5, Warm: 4, New: 3, Cool: 2, Cold: 1 };
        const aScore = (tempScore[String(a.Partner_Temperature)] || 0) * 10 + Number(a.Referrals_Given || 0);
        const bScore = (tempScore[String(b.Partner_Temperature)] || 0) * 10 + Number(b.Referrals_Given || 0);
        return bScore - aScore;
      });

    if (!suggestions.length) return "All partners are fresh. No follow-ups needed right now.";

    const lines = [`FOLLOW-UP SUGGESTIONS (14+ days, prioritized):\n`];
    for (const p of suggestions.slice(0, 10)) {
      lines.push(
        `${p.Full_Name} | ${p.Partner_Temperature || "?"} | ${p.daysSince}d since last touch | Rank: ${p.Partner_Status || "?"} | Referrals: ${p.Referrals_Given || 0}`
      );
    }
    lines.push(`\nTip: Start with the top 3. A quick text or coffee invite keeps the relationship warm.`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Partner intelligence error: ${msg}`;
  }
}

// === MORTGAGE CALCULATOR ===

function calcMonthlyPayment(principal: number, annualRate: number, amortYears: number): number {
  const r = annualRate / 100 / 12;
  const n = amortYears * 12;
  if (r === 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

function cmhcPremiumRate(ltv: number): number {
  if (ltv <= 80) return 0;
  if (ltv <= 85) return 0.028;
  if (ltv <= 90) return 0.031;
  if (ltv <= 95) return 0.04;
  return 0; // Over 95% not insurable
}

async function mortgageCalculator(input: Record<string, unknown>): Promise<string> {
  const mode = String(input.mode || "payment");
  const amort = Number(input.amortization || 25);

  if (mode === "payment") {
    const principal = Number(input.mortgage_amount || 0);
    const rate = Number(input.rate || 5.0);
    if (!principal) return "Need mortgage_amount for payment calc.";

    const monthly = calcMonthlyPayment(principal, rate, amort);
    const biweekly = (monthly * 12) / 26;
    const totalPaid = monthly * amort * 12;
    const totalInterest = totalPaid - principal;

    return [
      `PAYMENT CALCULATOR`,
      ``,
      `Mortgage: $${principal.toLocaleString()}`,
      `Rate: ${rate}%`,
      `Amortization: ${amort} years`,
      ``,
      `Monthly: $${Math.round(monthly).toLocaleString()}`,
      `Bi-weekly accelerated: $${Math.round(biweekly).toLocaleString()}`,
      `Total interest: $${Math.round(totalInterest).toLocaleString()}`,
    ].join("\n");
  }

  if (mode === "ltv") {
    const mortgage = Number(input.mortgage_amount || 0);
    const value = Number(input.property_value || 0);
    if (!mortgage || !value) return "Need mortgage_amount and property_value for LTV calc.";

    const ltv = (mortgage / value) * 100;
    const premRate = cmhcPremiumRate(ltv);
    const premium = premRate > 0 ? mortgage * premRate : 0;

    const lines = [
      `LTV CALCULATOR`,
      ``,
      `Mortgage: $${mortgage.toLocaleString()}`,
      `Property Value: $${value.toLocaleString()}`,
      `LTV: ${ltv.toFixed(1)}%`,
    ];
    if (premRate > 0) {
      lines.push(`CMHC Insurance: ${(premRate * 100).toFixed(1)}% = $${Math.round(premium).toLocaleString()}`);
      lines.push(`Total Mortgage w/ CMHC: $${Math.round(mortgage + premium).toLocaleString()}`);
    } else {
      lines.push(`No CMHC insurance required (LTV <= 80%)`);
    }
    return lines.join("\n");
  }

  if (mode === "affordability") {
    const income = Number(input.annual_income || 0);
    if (!income) return "Need annual_income for affordability calc.";

    const monthlyIncome = income / 12;
    const monthlyDebts = Number(input.monthly_debts || 0);
    const contractRate = Number(input.rate || 5.0);
    const stressRate = Math.max(contractRate + 2, 5.25);
    const downPayment = Number(input.down_payment || 0);

    // Property tax estimate: ~1% of value / 12
    // Heat: $150/month (CMHC standard)
    const heat = 150;

    // GDS: 39% of gross monthly = PITH (principal + interest + tax + heat)
    const maxGDS = monthlyIncome * 0.39;
    // TDS: 44% of gross monthly = PITH + debts
    const maxTDS = monthlyIncome * 0.44;

    // Max PITH from TDS (more restrictive when debts exist)
    const maxPITH_gds = maxGDS;
    const maxPITH_tds = maxTDS - monthlyDebts;
    const maxPITH = Math.min(maxPITH_gds, maxPITH_tds);

    // Property tax = ~1%/year of value = approx $propertyValue * 0.01 / 12
    // This is circular (depends on property value), so iterate
    let maxMortgage = 0;
    let maxPurchase = 0;

    // Iterative solver: start with estimate, converge
    let estimate = maxPITH * 200; // rough starting point
    for (let i = 0; i < 20; i++) {
      const propTax = estimate * 0.01 / 12;
      const availableForPI = maxPITH - propTax - heat;
      if (availableForPI <= 0) { estimate *= 0.5; continue; }

      // Back out max mortgage from available PI using stress test rate
      const r = stressRate / 100 / 12;
      const n = amort * 12;
      const maxMort = availableForPI * (Math.pow(1 + r, n) - 1) / (r * Math.pow(1 + r, n));

      // Check if CMHC applies
      const ltv = downPayment > 0 ? (maxMort / (maxMort + downPayment)) * 100 : 95;
      const premRate = cmhcPremiumRate(ltv);
      // CMHC premium is added to mortgage, so actual borrowing = maxMort / (1 + premRate)
      const effectiveMortgage = premRate > 0 ? maxMort / (1 + premRate) : maxMort;

      maxMortgage = effectiveMortgage;
      maxPurchase = effectiveMortgage + downPayment;
      estimate = maxPurchase; // converge
    }

    const actualPayment = calcMonthlyPayment(maxMortgage, contractRate, amort);

    return [
      `AFFORDABILITY CALCULATOR (Canadian Rules)`,
      ``,
      `Income: $${income.toLocaleString()}/year ($${Math.round(monthlyIncome).toLocaleString()}/mo)`,
      monthlyDebts > 0 ? `Monthly debts: $${monthlyDebts.toLocaleString()}` : `No monthly debts`,
      downPayment > 0 ? `Down payment: $${downPayment.toLocaleString()}` : `No down payment specified`,
      ``,
      `Stress test rate: ${stressRate}%`,
      `GDS limit: 39% | TDS limit: 44%`,
      ``,
      `MAX PURCHASE: $${Math.round(maxPurchase).toLocaleString()}`,
      `MAX MORTGAGE: $${Math.round(maxMortgage).toLocaleString()}`,
      ``,
      `At ${contractRate}% actual rate:`,
      `Monthly payment: $${Math.round(actualPayment).toLocaleString()}`,
      `Bi-weekly: $${Math.round((actualPayment * 12) / 26).toLocaleString()}`,
      maxMortgage / maxPurchase > 0.8 ? `\nNote: CMHC insurance applies (LTV > 80%)` : ``,
    ].join("\n");
  }

  return "Unknown mode. Use: affordability, payment, or ltv";
}

// === KNOWLEDGE BASE ===

async function queryBrain(input: Record<string, unknown>): Promise<string> {
  try {
    let query = supabase.from("brain").select("category, topic, content, tags");

    if (input.category) {
      query = query.eq("category", String(input.category));
    }

    const { data, error } = await query.order("category");

    if (error) return `Brain query error: ${error.message}`;
    if (!data?.length) return "No results found in knowledge base.";

    // Filter by search term if provided
    let results = data;
    if (input.search) {
      const term = String(input.search).toLowerCase();
      results = data.filter(
        (row: Record<string, unknown>) =>
          String(row.topic || "").toLowerCase().includes(term) ||
          String(row.content || "").toLowerCase().includes(term) ||
          String(row.tags || "").toLowerCase().includes(term)
      );
    }

    if (!results.length) return `No results matching "${input.search}" in knowledge base.`;

    const lines = results.map((row: Record<string, unknown>) => {
      const cat = String(row.category || "");
      const topic = String(row.topic || "");
      const content = String(row.content || "");
      return `[${cat.toUpperCase()}] ${topic}\n${content}`;
    });

    return `FLOW KNOWLEDGE BASE (${results.length} results):\n\n${lines.join("\n\n---\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Brain query failed: ${msg}`;
  }
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

// === PARTNER CALL PROCESSING ===

async function processPartnerCall(input: Record<string, unknown>): Promise<string> {
  const text = (input.text as string) || "";
  const partnerName = (input.partner_name as string) || "";

  if (!text || text.length < 20) {
    return "Need more detail. Paste the full call notes, transcript, or voice note content.";
  }

  try {
    const resp = await fetch(
      "https://transcript-processor-vxwqplu37q-uc.a.run.app/partner",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, partner_name: partnerName }),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      return `Processing failed (${resp.status}): ${err.slice(0, 200)}`;
    }

    const data = await resp.json();

    let result = `PARTNER CALL PROCESSED\n\n`;
    result += `Partner: ${data.partner_name || partnerName || "Unknown"}\n`;
    result += `Summary: ${data.summary || "N/A"}\n\n`;

    if (data.action_items?.length) {
      result += `ACTION ITEMS:\n`;
      for (const item of data.action_items) {
        result += `- ${item.task || item}\n`;
      }
      result += `\n`;
    }

    if (data.commitments?.length) {
      result += `COMMITMENTS:\n`;
      for (const c of data.commitments) {
        result += `- ${c}\n`;
      }
      result += `\n`;
    }

    if (data.follow_up_email) {
      result += `FOLLOW-UP EMAIL DRAFT:\n---\n${data.follow_up_email}\n---\n\n`;
    }

    result += `Zoho: ${data.zoho?.status === "success" ? "Note + tasks created" : "Check CRM"}\n`;
    result += `A formatted version was also emailed to you.`;

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error processing partner call: ${msg}`;
  }
}
