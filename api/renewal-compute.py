"""
Vercel Python serverless function: renewal-compute.

POST /api/renewal-compute
Body: enriched-or-raw renewal inputs JSON. The wrapper enriches raw Zoho fields
into the calc.py inputs schema before invoking calc + render.

Returns: { "summary": {...calc results...}, "xlsx_b64": "...base64...", "filename": "..." }

Source files synced from:
  Flow Projects/Plugins/flow-renewal-scenarios/scripts/calc.py
  Flow Projects/Plugins/flow-renewal-scenarios/scripts/render.py
  Flow Projects/Plugins/flow-renewal-scenarios/data/historical_big5_posted_rates.csv

Auth: x-flow-renewal-secret header must match RENEWAL_COMPUTE_SECRET env.
"""
from __future__ import annotations

import base64
import csv
import json
import os
import re
import sys
import tempfile
import traceback
from datetime import date, datetime
from decimal import Decimal, getcontext
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / "_lib"))

import calc  # noqa: E402
import render  # noqa: E402

getcontext().prec = 28

SECRET_HEADER = "x-flow-renewal-secret"
EXPECTED_SECRET = os.environ.get("RENEWAL_COMPUTE_SECRET", "")

BIG5_LENDERS = {
    "RBC", "ROYAL BANK", "TD", "BMO", "BANK OF MONTREAL",
    "SCOTIA", "SCOTIABANK", "CIBC", "NBC", "NATIONAL BANK",
    "HSBC", "DESJARDINS", "SIMPLII",
}

CSV_PATH = HERE / "_lib" / "historical_big5_posted_rates.csv"


# ---------------------------------------------------------------------------
# Enrichment: turn raw Zoho fields into calc.py inputs schema
# ---------------------------------------------------------------------------

def _is_big5(lender: str) -> bool:
    return lender.upper().strip() in BIG5_LENDERS


def _parse_province(address: str | None) -> str | None:
    if not address:
        return None
    a = address.upper()
    if re.search(r"\b(BC|B\.C\.|BRITISH\s+COLUMBIA)\b", a):
        return "BC"
    if re.search(r"\b(AB|ALBERTA)\b", a):
        return "AB"
    return None


def _term_key_for_term_length(term_months: int | None) -> str:
    if not term_months:
        return "5yr"
    yrs = round(term_months / 12)
    if yrs <= 1:
        return "1yr"
    if yrs <= 3:
        return "3yr"
    return "5yr"


def _load_posted_rate_history() -> tuple[dict[str, dict[str, float]], dict[str, float]]:
    """
    Returns (history_by_month, latest_by_term).
    history_by_month: { "2021-08": { "1yr": 2.79, "3yr": 3.04, "5yr": 4.79 } }
    latest_by_term:   { "1yr": 5.49, "3yr": 6.05, "5yr": 6.09 }
    """
    history: dict[str, dict[str, float]] = {}
    latest_row: dict[str, float] = {}
    with CSV_PATH.open() as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    for row in rows:
        month = row["month_year"]
        history[month] = {
            "1yr": float(row.get("Big5_avg_1yr_posted", 0) or 0),
            "3yr": float(row.get("Big5_avg_3yr_posted", 0) or 0),
            "5yr": float(row.get("Big5_avg_5yr_posted", 0) or 0),
        }
    if rows:
        last = rows[-1]
        latest_row = {
            "1yr": float(last.get("Big5_avg_1yr_posted", 0) or 0),
            "3yr": float(last.get("Big5_avg_3yr_posted", 0) or 0),
            "5yr": float(last.get("Big5_avg_5yr_posted", 0) or 0),
        }
    return history, latest_row


def _compute_current_balance(
    original: float, contract_rate: float, payment: float,
    funded_date: str, today: date | None = None,
) -> float:
    """Canadian semi-annual compounding. Returns current outstanding principal."""
    fd = datetime.fromisoformat(funded_date).date()
    t = today or date.today()
    months_elapsed = (t.year - fd.year) * 12 + (t.month - fd.month)
    if months_elapsed <= 0:
        return original

    r = Decimal(str(contract_rate)) / Decimal("2")
    monthly_r = (Decimal("1") + r) ** (Decimal("1") / Decimal("6")) - Decimal("1")

    n = months_elapsed
    bal = Decimal(str(original))
    pay = Decimal(str(payment))
    one_plus = Decimal("1") + monthly_r
    grown = bal * (one_plus ** n)
    paid = pay * ((one_plus ** n) - Decimal("1")) / monthly_r
    current = grown - paid
    return float(max(current, Decimal("0")))


def _enrich_inputs(raw: dict[str, Any]) -> dict[str, Any]:
    """
    Turn raw Zoho-derived fields into calc.py inputs schema.
    Idempotent: if a field is already filled, don't recompute.
    """
    out = dict(raw)
    history, latest = _load_posted_rate_history()

    # Province from address
    if not out.get("province"):
        out["province"] = _parse_province(raw.get("combined_address") or raw.get("province_or_address"))

    # Current balance from amortization
    if "current_balance" not in out and all(
        out.get(k) for k in ("mortgage_amount", "contract_rate", "payment_amount", "funded_date")
    ):
        out["current_balance"] = _compute_current_balance(
            float(out["mortgage_amount"]),
            float(out["contract_rate"]),
            float(out["payment_amount"]),
            out["funded_date"],
        )

    # Lender method default + variable subtype
    lender = (out.get("lender") or "").upper().strip()
    if not out.get("lender_ird_method"):
        out["lender_ird_method"] = "posted_rate" if _is_big5(lender) else "bond_yield"

    # Posted rate at origination — Big 5 only, look up by funded_date
    if (
        out.get("estimated_posted_rate_at_origination") is None
        and _is_big5(lender)
        and out.get("funded_date")
    ):
        try:
            fd_month = out["funded_date"][:7]  # YYYY-MM
            term_key = _term_key_for_term_length(out.get("term_length_months"))
            posted = history.get(fd_month, {}).get(term_key)
            if posted:
                out["estimated_posted_rate_at_origination"] = posted / 100.0
                out["estimated_posted_rate_source"] = (
                    f"BoC representative {term_key} posted, {fd_month} (estimate)"
                )
        except Exception as e:
            out.setdefault("warnings", []).append(f"posted-rate lookup failed: {e}")

    # Current posted rates (always include latest row for IRD comparison side)
    if not out.get("current_posted_rates"):
        out["current_posted_rates"] = {
            "1yr": latest.get("1yr", 0) / 100.0,
            "3yr": latest.get("3yr", 0) / 100.0,
            "5yr": latest.get("5yr", 0) / 100.0,
            "source": "BoC representative rate, latest row of historical_big5_posted_rates.csv",
        }

    # Defaults LS may not have provided
    out.setdefault("heating_cost_annual", 1200)
    if "property_taxes_annual" not in out and out.get("property_value"):
        out["property_taxes_annual"] = round(float(out["property_value"]) * 0.01)

    return out


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self._send(200, {
            "service": "flow-renewal-compute",
            "version": "0.1.0",
            "calc_version": getattr(calc, "CALC_VERSION", "unknown"),
        })

    def do_POST(self) -> None:
        import time as _time
        t0 = _time.time()
        deal_id = None
        lender = None
        outcome = "error"
        try:
            secret = self.headers.get(SECRET_HEADER, "")
            if not EXPECTED_SECRET or secret != EXPECTED_SECRET:
                self._send(401, {"error": "unauthorized"})
                outcome = "unauthorized"
                return

            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                self._send(400, {"error": "empty body"})
                return

            raw = self.rfile.read(content_length)
            try:
                inputs_raw = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as e:
                self._send(400, {"error": f"invalid JSON: {e}"})
                return

            if not isinstance(inputs_raw, dict):
                self._send(400, {"error": "inputs must be a JSON object"})
                return

            deal_id = inputs_raw.get("deal_id")
            lender = inputs_raw.get("lender")

            # v1 hard guard: insured deals error out
            if str(inputs_raw.get("insured_status", "")).lower() == "insured":
                self._send(422, {
                    "error": "insured_renewal_v1_excluded",
                    "message": "Insured renewals require manual review — book Alex.",
                })
                outcome = "insured_excluded"
                return

            inputs = _enrich_inputs(inputs_raw)

            with tempfile.TemporaryDirectory() as tmp:
                xlsx_path = Path(tmp) / "renewal.xlsx"

                results = calc.calc(inputs)

                if results.get("errors"):
                    self._send(422, {
                        "error": "calc_failed",
                        "calc_errors": results["errors"],
                        "enriched_inputs_keys": sorted(inputs.keys()),
                    })
                    outcome = "calc_failed"
                    return

                render.render_xlsx(results, str(xlsx_path))
                xlsx_bytes = xlsx_path.read_bytes()

            self._send(200, {
                "summary": results,
                "xlsx_b64": base64.b64encode(xlsx_bytes).decode("ascii"),
                "filename": _filename_for(inputs, results),
            })
            outcome = "ok"

            # Telemetry — Vercel captures stdout, queryable in dashboard logs
            print(json.dumps({
                "event": "renewal_compute",
                "outcome": outcome,
                "deal_id": deal_id,
                "lender": lender,
                "ird_method": inputs.get("lender_ird_method"),
                "trapped": (results.get("trapped_check") or {}).get("is_trapped"),
                "rate_type": inputs.get("rate_type"),
                "province": inputs.get("province"),
                "duration_ms": int((_time.time() - t0) * 1000),
                "calc_version": getattr(calc, "CALC_VERSION", "unknown"),
            }))
        except Exception as e:
            tb = traceback.format_exc()
            self._send(500, {"error": str(e), "traceback": tb[-2000:]})
            outcome = "exception"
            print(json.dumps({
                "event": "renewal_compute",
                "outcome": outcome,
                "deal_id": deal_id,
                "lender": lender,
                "exception_type": type(e).__name__,
                "exception_msg": str(e)[:200],
                "duration_ms": int((_time.time() - t0) * 1000),
            }))


def _filename_for(inputs: dict, results: dict) -> str:
    deal = (
        results.get("deal_name")
        or inputs.get("deal_name")
        or inputs.get("deal_id")
        or "renewal"
    )
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(deal))[:50]
    ts = (results.get("calc_timestamp") or "")[:10] or date.today().isoformat()
    return f"Renewal-{safe}-{ts}.xlsx"
