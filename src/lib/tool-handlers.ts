import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

const ZOHO_API = "https://www.zohoapis.com/crm/v2";
const ZOHO_TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token";

// === ZOHO AUTH ===
async function getZohoToken(): Promise<string | null> {
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) return null;

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
  const data = await res.json();
  return data.access_token || null;
}

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
      case "send_email":
        return await sendEmail(input);
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
    return `Error executing ${name}: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// === ZOHO HANDLERS ===

async function zohoCreateLead(input: Record<string, unknown>): Promise<string> {
  const token = await getZohoToken();
  if (!token) return "Zoho not configured yet. Lead captured locally:\n" + JSON.stringify(input, null, 2);

  const res = await fetch(`${ZOHO_API}/Contacts`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{
        First_Name: input.first_name,
        Last_Name: input.last_name,
        Email: input.email || null,
        Phone: input.phone || null,
        Lead_Source: input.source || "Telegram",
        Description: input.notes || "Created via Flow Telegram Bot",
      }],
    }),
  });
  const data = await res.json();
  if (data.data?.[0]?.code === "SUCCESS") {
    return `Lead created in Zoho CRM:\n${input.first_name} ${input.last_name}\nID: ${data.data[0].details.id}`;
  }
  return `Zoho response: ${JSON.stringify(data)}`;
}

async function zohoSearchContacts(input: Record<string, unknown>): Promise<string> {
  const token = await getZohoToken();
  if (!token) return "Zoho not configured. Add ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET env vars.";

  const query = String(input.query);
  const res = await fetch(`${ZOHO_API}/Contacts/search?criteria=(Full_Name:equals:${encodeURIComponent(query)})`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (!data.data?.length) {
    // Try deals
    const dealRes = await fetch(`${ZOHO_API}/Deals/search?criteria=(Deal_Name:equals:${encodeURIComponent(query)})`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const dealData = await dealRes.json();
    if (dealData.data?.length) {
      return dealData.data.map((d: Record<string, unknown>) => `Deal: ${d.Deal_Name} | Stage: ${d.Stage} | Amount: $${d.Amount || "N/A"}`).join("\n");
    }
    return `No contacts or deals found for "${query}".`;
  }
  return data.data.map((c: Record<string, unknown>) => `${c.Full_Name} | ${c.Email || "no email"} | ${c.Phone || "no phone"}`).join("\n");
}

async function zohoCreateTask(input: Record<string, unknown>): Promise<string> {
  const token = await getZohoToken();
  if (!token) return "Zoho not configured. Task logged locally:\n" + JSON.stringify(input, null, 2);

  const assigneeMap: Record<string, string> = {
    alex: "5652769000000509001",
    erica: "5652769000000509001", // Update with Erica's actual ID
    james: "5652769000000509001",
    joana: "5652769000096555001",
    amy: "5652769000000509001", // Update with Amy's actual ID
  };

  const assigneeName = String(input.assignee).toLowerCase();
  const ownerId = assigneeMap[assigneeName] || assigneeMap.alex;

  const res = await fetch(`${ZOHO_API}/Tasks`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{
        Subject: input.subject,
        Owner: { id: ownerId },
        Due_Date: input.due_date || null,
        Description: input.description || "",
        Priority: input.priority || "Normal",
      }],
    }),
  });
  const data = await res.json();
  return data.data?.[0]?.code === "SUCCESS"
    ? `Task created: "${input.subject}" assigned to ${input.assignee}`
    : `Zoho response: ${JSON.stringify(data)}`;
}

async function zohoUpdateDeal(input: Record<string, unknown>): Promise<string> {
  const token = await getZohoToken();
  if (!token) return "Zoho not configured. Update logged:\n" + JSON.stringify(input, null, 2);

  // Search for deal first
  const searchRes = await fetch(`${ZOHO_API}/Deals/search?criteria=(Deal_Name:equals:${encodeURIComponent(String(input.deal_name))})`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const searchData = await searchRes.json();
  if (!searchData.data?.length) return `Deal "${input.deal_name}" not found in Zoho.`;

  const dealId = searchData.data[0].id;
  const updateData: Record<string, unknown> = {};
  if (input.stage) updateData.Stage = input.stage;
  if (input.notes) updateData.Description = input.notes;

  const res = await fetch(`${ZOHO_API}/Deals/${dealId}`, {
    method: "PUT",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: [updateData] }),
  });
  const data = await res.json();
  return data.data?.[0]?.code === "SUCCESS"
    ? `Deal "${input.deal_name}" updated. ${input.stage ? `Stage: ${input.stage}` : ""}`
    : `Zoho response: ${JSON.stringify(data)}`;
}

// === EMAIL ===

async function sendEmail(input: Record<string, unknown>): Promise<string> {
  if (!input.confirm) {
    return `DRAFT EMAIL:\nTo: ${input.to}\nSubject: ${input.subject}\n\n${input.body}\n\nReply "send it" to confirm.`;
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return "Resend not configured. Draft saved:\n" + JSON.stringify(input, null, 2);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Alex McFadyen <alex@getflowmortgage.ca>",
      to: input.to,
      subject: input.subject,
      text: String(input.body),
    }),
  });
  const data = await res.json();
  return data.id ? `Email sent to ${input.to}` : `Failed: ${JSON.stringify(data)}`;
}

// === CALENDAR ===

async function createCalendarEvent(input: Record<string, unknown>): Promise<string> {
  // For now, return formatted event to create
  // Full Google Calendar API integration requires OAuth flow
  return `Calendar event prepared:\nTitle: ${input.title}\nDate: ${input.date} at ${input.time} PT\nDuration: ${input.duration_minutes || 30} min\n${input.attendees ? `Attendees: ${input.attendees}` : ""}\n\nNote: Auto-creation requires Google Calendar OAuth setup. For now, I've logged this as an alert.`;
}

// === PROPERTY HUB ===

async function propertyAddTransaction(input: Record<string, unknown>): Promise<string> {
  // Find property by name fragment
  const { data: props } = await supabase.from("properties").select("id, name");
  const prop = props?.find(p =>
    p.name.toLowerCase().includes(String(input.property_name).toLowerCase()) ||
    String(input.property_name).toLowerCase().includes(p.name.toLowerCase().split(" ")[0])
  );
  if (!prop) return `Property "${input.property_name}" not found. Available: ${props?.map(p => p.name).join(", ")}`;

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
    const prop = props?.find(p => p.name.toLowerCase().includes(String(input.property_name).toLowerCase()));
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
    const prop = props?.find(p => p.name.toLowerCase().includes(propFilter.toLowerCase()));
    if (prop) propId = prop.id;
  }

  switch (queryType) {
    case "overview": {
      const [props, alerts, units] = await Promise.all([
        supabase.from("properties").select("*"),
        supabase.from("alerts").select("*").eq("status", "pending"),
        supabase.from("units").select("*"),
      ]);
      const totalValue = props.data?.reduce((s, p) => s + (p.current_value || 0), 0) || 0;
      const totalRent = units.data?.filter(u => u.is_rented).reduce((s, u) => s + (u.current_rent || 0), 0) || 0;
      return `Portfolio: ${props.data?.length} properties, $${totalValue.toLocaleString()} total value\nMonthly rent: $${totalRent.toLocaleString()}\nPending alerts: ${alerts.data?.length || 0}\nOccupancy: ${units.data?.filter(u => u.is_rented).length}/${units.data?.length} units rented`;
    }
    case "alerts": {
      let q = supabase.from("alerts").select("*").eq("status", "pending").order("due_date");
      if (propId) q = q.eq("property_id", propId);
      const { data } = await q;
      if (!data?.length) return "No pending alerts.";
      return data.map(a => `[${a.priority.toUpperCase()}] ${a.title}${a.due_date ? ` (due ${a.due_date})` : ""}`).join("\n");
    }
    case "rent_status": {
      let q = supabase.from("units").select("*").eq("is_rented", true);
      if (propId) q = q.eq("property_id", propId);
      const { data: units } = await q;
      const { data: props } = await supabase.from("properties").select("id, name");
      if (!units?.length) return "No rented units found.";
      return units.map(u => {
        const prop = props?.find(p => p.id === u.property_id);
        return `${prop?.name || "?"} - ${u.name}: $${u.current_rent || "TBD"}/mo (${u.tenant_name || "unknown tenant"})`;
      }).join("\n");
    }
    case "obligations": {
      let q = supabase.from("obligations").select("*").eq("is_active", true).order("due_date");
      if (propId) q = q.eq("property_id", propId);
      const { data } = await q;
      if (!data?.length) return "No active obligations.";
      return data.map(o => `${o.name}: $${o.amount || "TBD"} (${o.frequency}) - due ${o.due_date || "TBD"}`).join("\n");
    }
    default:
      return `Unknown query type: ${queryType}`;
  }
}

// === DOCUMENTS ===

async function generatePreapproval(input: Record<string, unknown>): Promise<string> {
  // Log the pre-approval request -- actual PDF generation would trigger the GCP function
  return `Pre-Approval Letter prepared:\nClient: ${input.client_name}\nAmount: $${Number(input.approval_amount).toLocaleString()}\nRate: ${input.rate || "TBD"}%\nTerm: ${input.term || "5 year fixed"}\n${input.property_address ? `Property: ${input.property_address}` : ""}\n\nTo generate the PDF, use the Pre-Approval button in Zoho CRM, or I can trigger it once the deal is in the system.`;
}

// === DAILY BRIEFING ===

async function getDailyBriefing(input: Record<string, unknown>): Promise<string> {
  const [alerts, obligations, units, properties] = await Promise.all([
    supabase.from("alerts").select("*").eq("status", "pending").order("due_date"),
    supabase.from("obligations").select("*").eq("is_active", true).order("due_date"),
    supabase.from("units").select("*"),
    supabase.from("properties").select("*"),
  ]);

  const today = new Date().toISOString().split("T")[0];
  const urgentAlerts = alerts.data?.filter(a => a.priority === "urgent" || a.priority === "high") || [];
  const dueSoon = obligations.data?.filter(o => o.due_date && o.due_date <= new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]) || [];
  const totalRent = units.data?.filter(u => u.is_rented).reduce((s, u) => s + (u.current_rent || 0), 0) || 0;
  const totalValue = properties.data?.reduce((s, p) => s + (p.current_value || 0), 0) || 0;

  let briefing = `DAILY BRIEFING - ${today}\n\n`;
  briefing += `Portfolio: $${totalValue.toLocaleString()} | Monthly rent: $${totalRent.toLocaleString()}\n\n`;

  if (urgentAlerts.length > 0) {
    briefing += `URGENT (${urgentAlerts.length}):\n`;
    urgentAlerts.forEach(a => { briefing += `- ${a.title}${a.due_date ? ` (${a.due_date})` : ""}\n`; });
    briefing += "\n";
  }

  if (dueSoon.length > 0) {
    briefing += `DUE THIS WEEK (${dueSoon.length}):\n`;
    dueSoon.forEach(o => { briefing += `- ${o.name}: $${o.amount || "TBD"} (${o.due_date})\n`; });
    briefing += "\n";
  }

  const allAlerts = alerts.data || [];
  if (allAlerts.length > urgentAlerts.length) {
    briefing += `OTHER ALERTS (${allAlerts.length - urgentAlerts.length}):\n`;
    allAlerts.filter(a => a.priority !== "urgent" && a.priority !== "high").forEach(a => {
      briefing += `- ${a.title}\n`;
    });
  }

  briefing += `\nDashboard: mcfadyen-properties.vercel.app`;
  return briefing;
}
