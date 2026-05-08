// Renewal scenarios handler. Triggered by /renewal <deal_id>.
// Fetches Zoho deal + Supabase market rates, POSTs to /api/renewal-compute (Python),
// returns the xlsx bytes for sendDocument.

import { ZOHO_API, zohoFetch } from "../tool-handlers";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://jkeujqzlclrxhwamplby.supabase.co";
const SUPABASE_RATES_FUNCTION = process.env.SUPABASE_RATES_FUNCTION_URL || `${SUPABASE_URL}/functions/v1/rates`;
const RENEWAL_COMPUTE_SECRET = process.env.RENEWAL_COMPUTE_SECRET || "";

const DEAL_FIELDS = [
  "Deal_Name", "Maturity_Date", "Funded_Date", "Mortgage_Amount",
  "Mortgage_Rate", "Rate_Type", "Term_Length", "Amortization",
  "Payment_Amount", "High_Ratio_Insurable_Uninsurable", "Lender_Name",
  "Pipeline", "Stage", "Renewal_Status", "Contact_Name", "Owner",
  "Combined_Address",
].join(",");

type ZohoLookup = { id: string; name: string } | null;

interface RawZohoDeal {
  id: string;
  Deal_Name?: string;
  Maturity_Date?: string;
  Funded_Date?: string;
  Mortgage_Amount?: number;
  Mortgage_Rate?: number;
  Rate_Type?: string;
  Term_Length?: number;
  Amortization?: number;
  Payment_Amount?: number;
  High_Ratio_Insurable_Uninsurable?: string;
  Lender_Name?: ZohoLookup | string;
  Pipeline?: string;
  Stage?: string;
  Renewal_Status?: string;
  Contact_Name?: ZohoLookup;
  Owner?: ZohoLookup;
  Combined_Address?: string;
}

export interface RenewalResult {
  ok: true;
  filename: string;
  xlsxBytes: Uint8Array;
  summaryText: string;
  dealId: string;
}

export interface RenewalError {
  ok: false;
  error: string;
  hint?: string;
}

export async function runRenewalForDealId(dealIdRaw: string): Promise<RenewalResult | RenewalError> {
  const dealId = dealIdRaw.trim();
  if (!/^\d{15,20}$/.test(dealId)) {
    return { ok: false, error: "Invalid Deal ID", hint: "Use the 18-digit Zoho Deal ID. /renewal 5652769000xxxxxxx" };
  }

  const deal = await fetchDeal(dealId);
  if (!deal) {
    return { ok: false, error: `Deal ${dealId} not found in Zoho.` };
  }

  if ((deal.High_Ratio_Insurable_Uninsurable || "").toLowerCase() === "insured") {
    return {
      ok: false,
      error: "Insured renewal — manual review required.",
      hint: "v1 scope is uninsured-only. Book Alex for insured deals.",
    };
  }

  if (!deal.Maturity_Date) return { ok: false, error: "Maturity_Date missing on this deal. Update Zoho first." };
  if (!deal.Funded_Date) return { ok: false, error: "Funded_Date missing on this deal. Update Zoho first." };
  if (!deal.Mortgage_Amount || !deal.Mortgage_Rate || !deal.Payment_Amount) {
    return { ok: false, error: "Mortgage_Amount / Mortgage_Rate / Payment_Amount missing on this deal." };
  }

  const marketRates = await fetchMarketRates();
  if (!marketRates) {
    return { ok: false, error: "Could not fetch live market_rates from Supabase." };
  }

  const lender = typeof deal.Lender_Name === "object" && deal.Lender_Name
    ? deal.Lender_Name.name
    : (deal.Lender_Name as string | undefined) || "";

  const rawInputs = {
    deal_id: dealId,
    deal_name: deal.Deal_Name,
    mortgage_amount: deal.Mortgage_Amount,
    contract_rate: deal.Mortgage_Rate / 100, // Zoho stores as percent (e.g. 4.25)
    lender,
    rate_type: deal.Rate_Type || "Fixed",
    funded_date: deal.Funded_Date,
    maturity_date: deal.Maturity_Date,
    term_length_months: deal.Term_Length,
    original_amortization_months: deal.Amortization,
    payment_amount: deal.Payment_Amount,
    insured_status: deal.High_Ratio_Insurable_Uninsurable || "Uninsurable",
    combined_address: deal.Combined_Address,
    market_rates: marketRates,
  };

  const computeUrl = computeUrl_();
  const res = await fetch(computeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flow-renewal-secret": RENEWAL_COMPUTE_SECRET,
    },
    body: JSON.stringify(rawInputs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    return { ok: false, error: `compute service ${res.status}`, hint: errBody.slice(0, 300) };
  }

  const data = (await res.json()) as {
    summary: ComputeSummary;
    xlsx_b64: string;
    filename: string;
  };

  const xlsxBytes = Uint8Array.from(Buffer.from(data.xlsx_b64, "base64"));
  return {
    ok: true,
    filename: data.filename,
    xlsxBytes,
    summaryText: formatSummary(data.summary),
    dealId,
  };
}

// ---------------------------------------------------------------------------

interface ComputeSummary {
  deal_name?: string;
  current_balance?: { value: number };
  trapped_check?: { is_trapped: boolean; reason?: string };
  break_even_rate?: { value: number };
  paths?: Record<string, Record<string, unknown>>;
  warnings?: string[];
}

function formatSummary(s: ComputeSummary): string {
  const path = (k: string, f: string) => {
    const v = s.paths?.[k]?.[f];
    return typeof v === "object" && v !== null && "value" in v
      ? (v as { value: number }).value
      : (typeof v === "number" ? v : null);
  };
  const stay = path("stay", "total_cost_5yr");
  const switchBY = path("switch", "total_cost_5yr_bond_yield");
  const switchPR = path("switch", "total_cost_5yr_posted_rate");
  const variable = (s.paths?.variable as Record<string, Record<string, number> | undefined>)?.flat?.total_cost_5yr ?? null;
  const trapped = s.trapped_check?.is_trapped;
  const be = s.break_even_rate?.value;

  const lines: string[] = [];
  lines.push(`<b>${s.deal_name || "Renewal"}</b>`);
  if (trapped) lines.push("⚠️ <b>LIMITED FLEXIBILITY</b> — see banner in xlsx");
  lines.push(`Current balance: $${(s.current_balance?.value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  lines.push("");
  lines.push("<b>5yr total cost (lower is better):</b>");
  if (stay != null) lines.push(`• Stay: $${stay.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  if (switchBY != null) lines.push(`• Switch (Bond-Yield IRD): $${switchBY.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  if (switchPR != null && switchPR !== switchBY) lines.push(`• Switch (Posted-Rate IRD): $${switchPR.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  if (variable != null) lines.push(`• Variable (flat): $${variable.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  if (be != null) lines.push(`Break-even variable rate: ${(be * 100).toFixed(2)}%`);
  if (s.warnings?.length) lines.push(`\n⚠ ${s.warnings.join("; ")}`);
  return lines.join("\n");
}

async function fetchDeal(dealId: string): Promise<RawZohoDeal | null> {
  const url = `${ZOHO_API}/Deals/${dealId}?fields=${encodeURIComponent(DEAL_FIELDS)}`;
  const res = await zohoFetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: RawZohoDeal[] };
  if (!data.data || data.data.length === 0) return null;
  return data.data[0];
}

interface MarketRatesPayload {
  "5yr_fixed": number;
  "5yr_variable": number;
  "3yr_fixed": number;
  "1yr_fixed": number;
  prime: number;
  updated_at: string;
}

async function fetchMarketRates(): Promise<MarketRatesPayload | null> {
  try {
    const res = await fetch(`${SUPABASE_RATES_FUNCTION}?format=slim`, {
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SUPABASE_FUNCTION_SECRET
          ? { "X-Function-Secret": process.env.SUPABASE_FUNCTION_SECRET }
          : {}),
      },
    });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    return mapRatesShape(json);
  } catch {
    return null;
  }
}

function mapRatesShape(raw: Record<string, unknown>): MarketRatesPayload | null {
  const adv = (raw.advertised || raw.displayed || raw) as Record<string, number>;
  if (typeof adv["5yr_fixed"] === "number" && typeof adv.prime === "number") {
    return {
      "5yr_fixed": numFrac(adv["5yr_fixed"]),
      "5yr_variable": numFrac(adv["5yr_variable"]),
      "3yr_fixed": numFrac(adv["3yr_fixed"]),
      "1yr_fixed": numFrac(adv["1yr_fixed"]),
      prime: numFrac(adv.prime),
      updated_at: (raw.updated_at as string) || new Date().toISOString(),
    };
  }
  // Long-format fallback: { rates: [{rate_type, term_key, rate}] }
  const rates = raw.rates as Array<{ rate_type: string; term_key: string; rate: number }> | undefined;
  if (rates) {
    const lookup: Record<string, number> = {};
    for (const r of rates) {
      lookup[`${r.term_key}_${r.rate_type}`] = numFrac(r.rate);
    }
    return {
      "5yr_fixed": lookup["5yr_fixed"] ?? 0,
      "5yr_variable": lookup["5yr_variable"] ?? lookup["variable_variable"] ?? 0,
      "3yr_fixed": lookup["3yr_fixed"] ?? 0,
      "1yr_fixed": lookup["1yr_fixed"] ?? 0,
      prime: lookup["prime_prime"] ?? lookup["prime_variable"] ?? 0,
      updated_at: (raw.updated_at as string) || new Date().toISOString(),
    };
  }
  return null;
}

function numFrac(n: number): number {
  // Normalize: if value > 1, treat as percent (4.25 → 0.0425). Else assume decimal already.
  return n > 1 ? n / 100 : n;
}

function computeUrl_(): string {
  // Vercel deploys this Python function alongside the Next.js app at /api/renewal-compute
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.RENEWAL_COMPUTE_URL || "http://localhost:3000";
  return `${base}/api/renewal-compute`;
}
