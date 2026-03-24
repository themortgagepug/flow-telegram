// Tool definitions for Claude tool_use
// Each tool maps to a real action the bot can take

export const TOOLS = [
  // === ZOHO CRM ===
  {
    name: "zoho_create_lead",
    description: "Create a new lead/contact in Zoho CRM. Use when someone shares lead info (screenshot, text, business card photo). Extract: first name, last name, email, phone, source, notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        first_name: { type: "string", description: "Lead first name" },
        last_name: { type: "string", description: "Lead last name" },
        email: { type: "string", description: "Email address" },
        phone: { type: "string", description: "Phone number" },
        source: { type: "string", description: "Lead source (Referral, Website, Social Media, etc)" },
        notes: { type: "string", description: "Any additional context about the lead" },
      },
      required: ["first_name", "last_name"],
    },
  },
  {
    name: "zoho_search_contacts",
    description: "Search Zoho CRM for a contact or deal by name, email, or phone.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search term (name, email, or phone)" },
      },
      required: ["query"],
    },
  },
  {
    name: "zoho_create_task",
    description: "Create a task in Zoho CRM assigned to a team member.",
    input_schema: {
      type: "object" as const,
      properties: {
        subject: { type: "string", description: "Task subject/title" },
        assignee: { type: "string", description: "Team member name (Alex, Erica, James, Joana, Amy)" },
        due_date: { type: "string", description: "Due date YYYY-MM-DD" },
        description: { type: "string", description: "Task details" },
        priority: { type: "string", enum: ["High", "Normal", "Low"], description: "Priority level" },
      },
      required: ["subject", "assignee"],
    },
  },
  {
    name: "zoho_update_deal",
    description: "Update a mortgage deal stage or field in Zoho CRM.",
    input_schema: {
      type: "object" as const,
      properties: {
        deal_name: { type: "string", description: "Deal/mortgage name to search for" },
        stage: { type: "string", description: "New stage (Qualification, Pre-Approval, Submitted, Approved, Instructed, Funded)" },
        notes: { type: "string", description: "Notes to add" },
      },
      required: ["deal_name"],
    },
  },

  // === EMAIL ===
  {
    name: "send_email",
    description: "Draft and send an email. ALWAYS show the draft to the user first and ask for confirmation before sending.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        confirm: { type: "boolean", description: "Set to false to show draft only, true to actually send" },
      },
      required: ["to", "subject", "body"],
    },
  },

  // === CALENDAR ===
  {
    name: "create_calendar_event",
    description: "Create a Google Calendar event.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date YYYY-MM-DD" },
        time: { type: "string", description: "Start time HH:MM (24hr, Pacific)" },
        duration_minutes: { type: "number", description: "Duration in minutes (default 30)" },
        description: { type: "string", description: "Event description" },
        attendees: { type: "string", description: "Comma-separated email addresses" },
      },
      required: ["title", "date", "time"],
    },
  },

  // === PROPERTY HUB ===
  {
    name: "property_add_transaction",
    description: "Log a financial transaction (income or expense) to a property.",
    input_schema: {
      type: "object" as const,
      properties: {
        property_name: { type: "string", description: "Property name or address fragment (Peters, 42 Ave, 55 Ave, 53A)" },
        type: { type: "string", enum: ["income", "expense"], description: "Transaction type" },
        category: { type: "string", description: "Category (rent, insurance, maintenance, strata_fee, property_tax, mortgage, utilities, other)" },
        amount: { type: "number", description: "Amount in CAD" },
        description: { type: "string", description: "Description" },
        date: { type: "string", description: "Date YYYY-MM-DD (default today)" },
        is_tax_deductible: { type: "boolean", description: "Tax deductible expense?" },
      },
      required: ["property_name", "type", "category", "amount"],
    },
  },
  {
    name: "property_create_alert",
    description: "Create an alert/action item in Property Hub.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Alert title" },
        description: { type: "string", description: "Alert details" },
        due_date: { type: "string", description: "Due date YYYY-MM-DD" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Priority" },
        property_name: { type: "string", description: "Related property (optional)" },
      },
      required: ["title"],
    },
  },
  {
    name: "property_query",
    description: "Query property data -- rent status, obligations, alerts, tenant info, performance metrics.",
    input_schema: {
      type: "object" as const,
      properties: {
        query_type: { type: "string", enum: ["overview", "alerts", "rent_status", "obligations", "performance", "tenants"], description: "What to query" },
        property_name: { type: "string", description: "Specific property (optional, omit for all)" },
      },
      required: ["query_type"],
    },
  },

  // === DOCUMENTS ===
  {
    name: "generate_preapproval",
    description: "Generate a pre-approval letter for a client. Collects client details and triggers the PDF generation.",
    input_schema: {
      type: "object" as const,
      properties: {
        client_name: { type: "string", description: "Client full name" },
        approval_amount: { type: "number", description: "Pre-approval amount" },
        rate: { type: "number", description: "Interest rate" },
        term: { type: "string", description: "Mortgage term (e.g. 5 year fixed)" },
        property_address: { type: "string", description: "Property address (if known)" },
        notes: { type: "string", description: "Additional notes" },
      },
      required: ["client_name", "approval_amount"],
    },
  },

  // === DAILY BRIEFING ===
  {
    name: "get_daily_briefing",
    description: "Generate a comprehensive daily briefing covering all systems: deals, tasks, calendar, properties, content.",
    input_schema: {
      type: "object" as const,
      properties: {
        detail_level: { type: "string", enum: ["quick", "full"], description: "Quick summary or full detail" },
      },
      required: [],
    },
  },
];
