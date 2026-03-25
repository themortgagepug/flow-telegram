// Tool definitions for Claude tool_use
// Each tool maps to a real action the bot can take

export const TOOLS = [
  // === ZOHO CRM ===
  {
    name: "zoho_create_lead",
    description:
      "Create a new lead/contact in Zoho CRM. Use when someone shares lead info (screenshot, text, business card photo). Extract: first name, last name, email, phone, source, notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        first_name: { type: "string", description: "Lead first name" },
        last_name: { type: "string", description: "Lead last name" },
        email: { type: "string", description: "Email address" },
        phone: { type: "string", description: "Phone number" },
        source: {
          type: "string",
          description:
            "Lead source (Referral, Website, Social Media, Partner, Event, etc)",
        },
        notes: {
          type: "string",
          description: "Any additional context about the lead",
        },
      },
      required: ["first_name", "last_name"],
    },
  },
  {
    name: "zoho_create_full_lead",
    description:
      "FULL lead intake: creates Contact + Mortgage Deal + assigns Amy as AMA + creates outreach task. Use this instead of zoho_create_lead when you have enough info for a proper mortgage lead. Mirrors the internal New Lead Form.",
    input_schema: {
      type: "object" as const,
      properties: {
        first_name: { type: "string", description: "Client first name (REQUIRED)" },
        last_name: { type: "string", description: "Client last name (REQUIRED)" },
        preferred_name: { type: "string", description: "Name they go by" },
        email: { type: "string", description: "Client email (REQUIRED)" },
        phone: { type: "string", description: "Client phone number" },
        income_type: {
          type: "string",
          enum: ["Employed", "Self-Employed", "Unemployed", "Retired"],
          description: "Employment type",
        },
        purpose: {
          type: "string",
          enum: ["Purchase", "Refinance", "Renewal/Switch", "Construction", "2nd Mortgage", "Commercial"],
          description: "Purpose of mortgage (REQUIRED)",
        },
        fthb: { type: "boolean", description: "First time home buyer?" },
        mortgage_amount: { type: "number", description: "Estimated mortgage amount" },
        expected_ltv: { type: "string", description: "Expected LTV percentage" },
        deal_type: {
          type: "string",
          enum: ["A", "B", "Private", "TBD"],
          description: "Deal type (default TBD)",
        },
        timeline: {
          type: "string",
          enum: ["Urgent", "1-3 Months", "3-6 Months", "6-12 Months", "TBD"],
          description: "Timeline for the mortgage",
        },
        preferred_communication: {
          type: "string",
          enum: ["Phone", "Text", "Email"],
          description: "How client prefers to be contacted",
        },
        referral_source: {
          type: "string",
          enum: [
            "Accountant", "Builder", "Cash Flow Success Program", "Client Database",
            "Facebook", "Financial Advisor/Planner", "Flow Team",
            "Google or Flow Website", "Hammer Real Estate Group Leads",
            "Instagram", "Lawyer", "Martine Perron", "Mortgage Broker",
            "Podcast", "Realtor", "Repeat Client", "Other",
          ],
          description: "Where the lead came from",
        },
        referrer_name: { type: "string", description: "Name of person who referred (First Last)" },
        referrer_phone: { type: "string", description: "Referrer phone number" },
        referrer_email: { type: "string", description: "Referrer email" },
        realtor_name: { type: "string", description: "Realtor name if purchase (First Last)" },
        realtor_email: { type: "string", description: "Realtor email" },
        secondary_first_name: { type: "string", description: "Co-borrower first name" },
        secondary_last_name: { type: "string", description: "Co-borrower last name" },
        secondary_email: { type: "string", description: "Co-borrower email" },
        secondary_phone: { type: "string", description: "Co-borrower phone" },
        secondary_income_type: {
          type: "string",
          enum: ["Employed", "Self-Employed", "Unemployed", "Retired"],
          description: "Co-borrower employment type",
        },
        key_notes: { type: "string", description: "Important notes about the lead" },
        overview: { type: "string", description: "One-line deal summary" },
      },
      required: ["first_name", "last_name", "email", "purpose"],
    },
  },
  {
    name: "zoho_search_contacts",
    description:
      "Search Zoho CRM for a contact or deal by name, email, or phone. Searches both Contacts and Deals modules. Try email if name search fails.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search term (name, email, or phone number)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "zoho_create_task",
    description:
      "Create a task in Zoho CRM assigned to a team member. Always set a due date when possible.",
    input_schema: {
      type: "object" as const,
      properties: {
        subject: { type: "string", description: "Task subject/title" },
        assignee: {
          type: "string",
          description:
            "Team member name: Alex, Erica, James, Joana, or Amy",
        },
        due_date: { type: "string", description: "Due date YYYY-MM-DD" },
        description: { type: "string", description: "Task details" },
        priority: {
          type: "string",
          enum: ["High", "Normal", "Low"],
          description: "Priority level",
        },
      },
      required: ["subject", "assignee"],
    },
  },
  {
    name: "zoho_update_deal",
    description:
      "Update a mortgage deal stage or notes in Zoho CRM. Validates stage against known values before updating.",
    input_schema: {
      type: "object" as const,
      properties: {
        deal_name: {
          type: "string",
          description: "Deal/mortgage name to search for (partial name ok)",
        },
        stage: {
          type: "string",
          description:
            "New stage: Qualification, Pre-Approval, Submitted, Approved, Instructed, Funded, Complete, or Lost",
        },
        notes: { type: "string", description: "Notes to add to the deal" },
        amount: { type: "number", description: "Update the deal amount ($)" },
      },
      required: ["deal_name"],
    },
  },
  {
    name: "zoho_pipeline_report",
    description:
      "Get a full pipeline report: all deals grouped by stage with counts, total value, and days aging in current stage. Great for daily/weekly briefings.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "zoho_get_deal_details",
    description:
      "Get full details on a specific deal: stage, amount, client, assigned to, notes, dates, and how long it has been in the current stage.",
    input_schema: {
      type: "object" as const,
      properties: {
        deal_name: {
          type: "string",
          description: "Deal name to look up (partial name ok)",
        },
      },
      required: ["deal_name"],
    },
  },
  {
    name: "zoho_recent_activity",
    description:
      "Get all deals modified in the last 7 days sorted by most recently updated. Use to see what's moving in the pipeline.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  // === EMAIL ===
  {
    name: "send_email",
    description:
      "Draft and send a custom email. ALWAYS show the draft to the user first and ask for confirmation before sending.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        confirm: {
          type: "boolean",
          description:
            "Set to false to show draft only, true to actually send",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_template_email",
    description:
      "Send from a pre-built email template with smart defaults. Templates: rate_quote, status_update, partner_thankyou, welcome, pre_approval. Always show the draft first unless confirm is explicitly true.",
    input_schema: {
      type: "object" as const,
      properties: {
        template: {
          type: "string",
          enum: [
            "rate_quote",
            "status_update",
            "partner_thankyou",
            "welcome",
            "pre_approval",
          ],
          description: "Template name to use",
        },
        to: { type: "string", description: "Recipient email address" },
        confirm: {
          type: "boolean",
          description: "false = show draft only, true = send immediately",
        },
        // Common variables
        client_name: { type: "string", description: "Client full name" },
        partner_name: {
          type: "string",
          description: "Partner name (for partner_thankyou template)",
        },
        stage: {
          type: "string",
          description:
            "Deal stage (for status_update): Qualification, Pre-Approval, Submitted, Approved, Instructed, Funded",
        },
        next_step: {
          type: "string",
          description:
            "Next step description (for status_update template)",
        },
        // Rate quote variables
        fixed_rate: {
          type: "string",
          description: "Fixed rate % (e.g. 4.19)",
        },
        variable_rate: {
          type: "string",
          description: "Variable rate (e.g. P - 0.90%)",
        },
        term: { type: "string", description: "Mortgage term (e.g. 5)" },
        purchase_price: {
          type: "string",
          description: "Purchase price (e.g. $750,000)",
        },
        down_payment: {
          type: "string",
          description: "Down payment (e.g. $150,000)",
        },
        monthly_payment: {
          type: "string",
          description: "Estimated monthly payment (e.g. $2,847)",
        },
        // Pre-approval variables
        approval_amount: {
          type: "string",
          description: "Pre-approval amount (e.g. $850,000)",
        },
        rate: { type: "string", description: "Rate % for pre-approval" },
        // Override subject
        subject: {
          type: "string",
          description: "Override the template subject line",
        },
      },
      required: ["template", "to"],
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
        time: {
          type: "string",
          description: "Start time HH:MM (24hr, Pacific)",
        },
        duration_minutes: {
          type: "number",
          description: "Duration in minutes (default 30)",
        },
        description: { type: "string", description: "Event description" },
        attendees: {
          type: "string",
          description: "Comma-separated email addresses",
        },
      },
      required: ["title", "date", "time"],
    },
  },

  // === PROPERTY HUB ===
  {
    name: "property_add_transaction",
    description:
      "Log a financial transaction (income or expense) to a property.",
    input_schema: {
      type: "object" as const,
      properties: {
        property_name: {
          type: "string",
          description:
            "Property name or address fragment (Peters, 42 Ave, 55 Ave, 53A)",
        },
        type: {
          type: "string",
          enum: ["income", "expense"],
          description: "Transaction type",
        },
        category: {
          type: "string",
          description:
            "Category (rent, insurance, maintenance, strata_fee, property_tax, mortgage, utilities, other)",
        },
        amount: { type: "number", description: "Amount in CAD" },
        description: { type: "string", description: "Description" },
        date: {
          type: "string",
          description: "Date YYYY-MM-DD (default today)",
        },
        is_tax_deductible: {
          type: "boolean",
          description: "Tax deductible expense?",
        },
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
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "Priority",
        },
        property_name: {
          type: "string",
          description: "Related property (optional)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "property_query",
    description:
      "Query property data -- rent status, obligations, alerts, tenant info, performance metrics.",
    input_schema: {
      type: "object" as const,
      properties: {
        query_type: {
          type: "string",
          enum: [
            "overview",
            "alerts",
            "rent_status",
            "obligations",
            "performance",
            "tenants",
          ],
          description: "What to query",
        },
        property_name: {
          type: "string",
          description: "Specific property (optional, omit for all)",
        },
      },
      required: ["query_type"],
    },
  },

  // === DOCUMENTS ===
  {
    name: "generate_preapproval",
    description:
      "Generate a pre-approval letter for a client. Collects client details and triggers the PDF generation.",
    input_schema: {
      type: "object" as const,
      properties: {
        client_name: { type: "string", description: "Client full name" },
        approval_amount: {
          type: "number",
          description: "Pre-approval amount",
        },
        rate: { type: "number", description: "Interest rate" },
        term: {
          type: "string",
          description: "Mortgage term (e.g. 5 year fixed)",
        },
        property_address: {
          type: "string",
          description: "Property address (if known)",
        },
        notes: { type: "string", description: "Additional notes" },
      },
      required: ["client_name", "approval_amount"],
    },
  },

  // === PARTNER CALL PROCESSING ===
  {
    name: "process_partner_call",
    description:
      "Process a partner meeting transcript or notes. Sends to the call intelligence pipeline which generates: meeting summary, follow-up email draft in Alex's voice, Zoho CRM note + task, and emails Alex the ready-to-forward draft. Use when Alex pastes call notes, meeting recap, or voice note transcript about a partner/realtor/lender meeting.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The call transcript, meeting notes, or voice note transcript to process",
        },
        partner_name: {
          type: "string",
          description: "Partner's name if known (optional - will be extracted from text if not provided)",
        },
      },
      required: ["text"],
    },
  },

  // === KNOWLEDGE BASE ===
  {
    name: "query_brain",
    description:
      "Search Flow's knowledge base (Supabase brain table) for SOPs, processes, team info, decisions, technical docs, project status, preferences, and content intelligence. Use this whenever you need to look up how something works, who does what, or what the current status of a system/project is.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: ["team", "technical", "decision", "process", "preference", "project", "content"],
          description: "Filter by category. Omit to search all.",
        },
        search: {
          type: "string",
          description: "Search term to filter results by topic or content (case-insensitive)",
        },
      },
      required: [],
    },
  },

  // === DAILY BRIEFING ===
  {
    name: "get_daily_briefing",
    description:
      "Generate a comprehensive daily briefing covering all systems: Zoho pipeline, deals, tasks, calendar, properties, content.",
    input_schema: {
      type: "object" as const,
      properties: {
        detail_level: {
          type: "string",
          enum: ["quick", "full"],
          description: "Quick summary or full detail",
        },
      },
      required: [],
    },
  },
];
