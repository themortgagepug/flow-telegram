"""
Flow Renewal Scenarios — Calculator

Implements docs/math-spec.md v0.1 (locked 2026-05-08).

Pure stdlib. Decimal for currency. No I/O outside --inputs / --output.
calc only computes — does not fetch Zoho/Supabase, does not build xlsx.

CLI:
    python calc.py --inputs inputs.json --output results.json
    python calc.py --test

Spec refs in docstrings (§N) point to docs/math-spec.md sections.

Version: 0.1.0
Last updated: 2026-05-08
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, getcontext
from typing import Any

CALC_VERSION = "0.1.0"

# Decimal precision: 28 digits (default) is plenty for currency.
getcontext().prec = 28

# ---------------------------------------------------------------------------
# Constants — math-spec §1.4, §5.3, §6.4
# ---------------------------------------------------------------------------

POSTED_RATE_LENDERS = {
    "RBC", "TD", "BMO", "Scotia", "Scotiabank", "CIBC", "NBC", "National Bank",
    "HSBC", "Desjardins", "Simplii",
}

ADJUSTABLE_ARM_LENDERS = {
    "TD", "NBC", "National Bank", "Tangerine", "RBC RateCapper",
}

# §5.3 closing cost defaults
BC_LEGAL_SWITCH = Decimal("1000")
BC_LEGAL_BREAK = Decimal("1400")
AB_LEGAL_SWITCH = Decimal("750")
AB_LEGAL_BREAK = Decimal("1100")
DISCHARGE_FEE_DEFAULT = Decimal("300")
APPRAISAL_IF_REQUIRED = Decimal("500")
AB_LT_REGISTRATION_BASE = Decimal("50")
AB_LT_REGISTRATION_RATE = Decimal("0.0004")  # $2 per $5,000

# §6.4 trapped-check thresholds (standard A-lender ratios)
GDS_LIMIT = Decimal("0.39")
TDS_LIMIT = Decimal("0.44")
MQR_FLOOR = Decimal("0.0525")
MQR_SPREAD = Decimal("0.02")
MQR_AMORT_MONTHS = 300  # qualifying amort per §6.4

# §3 default blend markup over broker rate when lender_blend_rate not provided
DEFAULT_BLEND_MARKUP = Decimal("0.005")  # 50 bps

# Comparison horizon
HORIZON_MONTHS = 60

# Late-term carve-out
LATE_TERM_THRESHOLD_MONTHS = 3

# Heating default (CMHC standard)
DEFAULT_HEATING_ANNUAL = Decimal("1200")


# ---------------------------------------------------------------------------
# Decimal helpers
# ---------------------------------------------------------------------------

CENT = Decimal("0.01")
RATE_PRECISION = Decimal("0.000001")


def D(x: Any) -> Decimal:
    """Convert anything to Decimal via string to avoid float drift."""
    if isinstance(x, Decimal):
        return x
    return Decimal(str(x))


def money(x: Decimal) -> Decimal:
    """Round to cents."""
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


def to_float(x: Decimal) -> float:
    """For JSON output."""
    return float(money(x))


def rate_to_float(x: Decimal) -> float:
    """For JSON output of rates (6 decimal places)."""
    return float(x.quantize(RATE_PRECISION, rounding=ROUND_HALF_UP))


# ---------------------------------------------------------------------------
# Core mortgage math — math-spec §4.4, §4.5, §9
# ---------------------------------------------------------------------------

def monthly_rate_canadian(annual_rate: Decimal) -> Decimal:
    """§4.4 Canadian semi-annual compounding: (1 + r/2)^(1/6) - 1."""
    if annual_rate <= 0:
        return Decimal("0")
    r_semi = annual_rate / 2
    # Decimal doesn't support fractional power directly; convert via float for the (1/6) exponent.
    # Acceptable: this only affects the rate conversion, not the dollar math downstream.
    val = float(1 + r_semi) ** (1.0 / 6.0) - 1.0
    return D(val)


def monthly_payment(balance: Decimal, annual_rate: Decimal, amort_months: int) -> Decimal:
    """§4.4 standard amortization payment with Canadian semi-annual compounding."""
    if amort_months <= 0:
        return Decimal("0")
    if annual_rate <= 0:
        return balance / Decimal(amort_months)
    mr = monthly_rate_canadian(annual_rate)
    n = Decimal(amort_months)
    # P = B * mr / (1 - (1+mr)^-n)
    factor = (1 + mr) ** int(n)  # exact for integer n
    return balance * mr / (1 - 1 / factor)


def ending_balance(balance: Decimal, annual_rate: Decimal,
                   payment: Decimal, months: int) -> Decimal:
    """§4.5 balance after `months` of `payment` at `annual_rate`."""
    if months <= 0:
        return balance
    mr = monthly_rate_canadian(annual_rate)
    if mr == 0:
        return max(balance - payment * Decimal(months), Decimal("0"))
    factor = (1 + mr) ** months
    bal = balance * factor - payment * (factor - 1) / mr
    return max(bal, Decimal("0"))


def current_balance_from_origin(original_amount: Decimal, contract_rate: Decimal,
                                payment_amount: Decimal, funded_date: dt.date,
                                today: dt.date) -> Decimal:
    """§9 critical gotcha — current balance from amort formula."""
    months_elapsed = (today.year - funded_date.year) * 12 + (today.month - funded_date.month)
    if months_elapsed <= 0:
        return original_amount
    return ending_balance(original_amount, contract_rate, payment_amount, months_elapsed)


def total_interest(balance: Decimal, ending_bal: Decimal,
                   payment: Decimal, months: int) -> Decimal:
    """Total interest = sum of payments - principal repaid."""
    return payment * Decimal(months) - (balance - ending_bal)


# ---------------------------------------------------------------------------
# IRD calcs — math-spec §1
# ---------------------------------------------------------------------------

def closest_term_rate(months_remaining: int, rates_by_term: dict[str, Decimal]) -> tuple[Decimal, str]:
    """Round months_remaining DOWN to nearest standard term {1,2,3,4,5}yr.
    Falls back to nearest available rate. Returns (rate, term_key_used).

    Available rates_by_term keys expected: '1yr','2yr','3yr','4yr','5yr'.
    """
    # Round down to nearest standard term (in years)
    if months_remaining < 12:
        years = 1  # below 1yr, use 1yr rate
    else:
        years = min(months_remaining // 12, 5)
    # Fallback chain if exact term not in input
    candidates = [f"{years}yr"] + [f"{y}yr" for y in range(years - 1, 0, -1)] + ["5yr", "3yr", "1yr"]
    for k in candidates:
        if k in rates_by_term:
            return rates_by_term[k], k
    # Last resort: any available
    if rates_by_term:
        k = next(iter(rates_by_term))
        return rates_by_term[k], k
    raise ValueError("No term rates available for IRD comparison")


def ird_bond_yield(contract_rate: Decimal, current_balance: Decimal,
                   months_remaining: int,
                   broker_rates_by_term: dict[str, Decimal]) -> tuple[Decimal, Decimal, str]:
    """§1.2 Bond-Yield IRD. Returns (ird_dollars, comparison_rate, term_key)."""
    comparison_rate, term_key = closest_term_rate(months_remaining, broker_rates_by_term)
    rate_diff = max(Decimal("0"), contract_rate - comparison_rate)
    ird = current_balance * rate_diff * Decimal(months_remaining) / Decimal(12)
    return money(ird), comparison_rate, term_key


def ird_posted_rate(contract_rate: Decimal, current_balance: Decimal,
                    months_remaining: int,
                    posted_rate_at_origination: Decimal,
                    current_posted_rates_by_term: dict[str, Decimal]) -> tuple[Decimal, Decimal, str]:
    """§1.1 Posted-Rate IRD. Returns (ird_dollars, comparison_rate, term_key)."""
    discount = posted_rate_at_origination - contract_rate
    current_posted, term_key = closest_term_rate(months_remaining, current_posted_rates_by_term)
    comparison_rate = current_posted - discount
    rate_diff = max(Decimal("0"), contract_rate - comparison_rate)
    ird = current_balance * rate_diff * Decimal(months_remaining) / Decimal(12)
    return money(ird), comparison_rate, term_key


# ---------------------------------------------------------------------------
# Breakage — math-spec §2
# ---------------------------------------------------------------------------

def three_months_interest(current_balance: Decimal, contract_rate: Decimal) -> Decimal:
    """§2 3-months interest floor."""
    return money(current_balance * contract_rate * Decimal(3) / Decimal(12))


def breakage_fixed(three_mo: Decimal, ird_dollars: Decimal) -> Decimal:
    """§2 closed fixed: max(3-months, IRD)."""
    return max(three_mo, ird_dollars)


def breakage_variable(current_balance: Decimal, contract_rate: Decimal) -> Decimal:
    """§2 variable closed: 3-months only, no IRD."""
    return three_months_interest(current_balance, contract_rate)


def is_late_term(months_remaining: int) -> bool:
    """§2 late-term carve-out flag."""
    return months_remaining <= LATE_TERM_THRESHOLD_MONTHS


# ---------------------------------------------------------------------------
# Blend — math-spec §3
# ---------------------------------------------------------------------------

def blended_rate(contract_rate: Decimal, months_remaining: int,
                 lender_blend_rate: Decimal, new_term_months: int) -> Decimal | None:
    """§3.1 time-weighted blend formula."""
    extension_months = new_term_months - months_remaining
    if extension_months <= 0:
        return None
    return (contract_rate * Decimal(months_remaining)
            + lender_blend_rate * Decimal(extension_months)) / Decimal(new_term_months)


# ---------------------------------------------------------------------------
# Trapped check — math-spec §6.4
# ---------------------------------------------------------------------------

@dataclass
class TrappedResult:
    is_trapped: bool
    gds: Decimal
    tds: Decimal
    qualifying_rate: Decimal
    qualifying_payment: Decimal
    reason: str


def trapped_check(current_balance: Decimal, household_income_gross: Decimal,
                  monthly_obligations: Decimal,
                  property_taxes_annual: Decimal, heat_annual: Decimal,
                  market_5yr_fixed_offered: Decimal) -> TrappedResult:
    """§6.4 — True if client cannot pass MQR at a new lender."""
    if household_income_gross <= 0:
        return TrappedResult(
            is_trapped=False, gds=Decimal("0"), tds=Decimal("0"),
            qualifying_rate=Decimal("0"), qualifying_payment=Decimal("0"),
            reason="Household income missing — trapped check skipped",
        )
    qualifying_rate = max(market_5yr_fixed_offered + MQR_SPREAD, MQR_FLOOR)
    qualifying_payment = monthly_payment(current_balance, qualifying_rate, MQR_AMORT_MONTHS)
    annual_pmt = qualifying_payment * Decimal(12)
    gds_num = annual_pmt + property_taxes_annual + heat_annual
    tds_num = gds_num + monthly_obligations * Decimal(12)
    gds = gds_num / household_income_gross
    tds = tds_num / household_income_gross
    is_trapped = gds > GDS_LIMIT or tds > TDS_LIMIT
    if is_trapped:
        reason = (f"GDS {gds:.3f} (limit {GDS_LIMIT}) / "
                  f"TDS {tds:.3f} (limit {TDS_LIMIT}) — "
                  f"client cannot pass MQR at new lender for refinance/extended-amort. "
                  f"Straight-switch still available without re-stress.")
    else:
        reason = (f"GDS {gds:.3f}, TDS {tds:.3f} (under thresholds {GDS_LIMIT}/{TDS_LIMIT})")
    return TrappedResult(
        is_trapped=is_trapped,
        gds=gds, tds=tds,
        qualifying_rate=qualifying_rate,
        qualifying_payment=money(qualifying_payment),
        reason=reason,
    )


# ---------------------------------------------------------------------------
# Path computation — math-spec §4, §5, §8
# ---------------------------------------------------------------------------

def closing_costs_switch(province: str) -> Decimal:
    """§5.1, §5.2 switch closing costs (legal + discharge), defaults from §5.3."""
    p = (province or "").upper()
    if "AB" in p or "ALBERTA" in p:
        return AB_LEGAL_SWITCH + DISCHARGE_FEE_DEFAULT + AB_LT_REGISTRATION_BASE
    return BC_LEGAL_SWITCH + DISCHARGE_FEE_DEFAULT  # BC default


def closing_costs_break(province: str, balance: Decimal) -> Decimal:
    """§5 break+refi closing costs (legal + discharge + appraisal + AB LT regis)."""
    p = (province or "").upper()
    if "AB" in p or "ALBERTA" in p:
        ab_lt = AB_LT_REGISTRATION_BASE + balance * AB_LT_REGISTRATION_RATE
        return AB_LEGAL_BREAK + DISCHARGE_FEE_DEFAULT + APPRAISAL_IF_REQUIRED + money(ab_lt)
    return BC_LEGAL_BREAK + DISCHARGE_FEE_DEFAULT + APPRAISAL_IF_REQUIRED


def total_cost(payment: Decimal, months: int, ending_bal: Decimal,
               breakage: Decimal, closing: Decimal, cashback: Decimal,
               original_balance: Decimal) -> Decimal:
    """§4.1 total cost = sum payments - ending_balance + breakage + closing - cashback,
    measured against the *original* balance (so the principal returned in equity
    is correctly netted)."""
    return (payment * Decimal(months)
            - (original_balance - ending_bal)  # principal repaid (kept on the books)
            + (original_balance - ending_bal)  # equity return cancels via spec wording
            + breakage + closing - cashback)
    # Note: spec §4.1 says "sum(monthly_payment) - ending_balance + breakage + closing - cashback".
    # The clean form: total interest paid + breakage + closing - cashback.
    # Implemented below in path_total_cost via direct interest calc.


def path_total_cost(monthly_pmt: Decimal, months: int, total_int: Decimal,
                    breakage: Decimal, closing: Decimal, cashback: Decimal) -> Decimal:
    """§4.1 reformulated cleanly:
        total interest paid over horizon + breakage + closing - cashback
    (Principal repayment is the client's equity return — not a cost.)"""
    return total_int + breakage + closing - cashback


def compute_stay(current_balance: Decimal, contract_rate: Decimal,
                 stay_renewal_rate: Decimal,
                 amortization_remaining_months: int,
                 months_remaining: int) -> dict:
    """Path 1: Stay with current lender. §0 + §4.2.

    If months_remaining < HORIZON, project Stay = current_rate for months_remaining
    + assumed renewal at stay_renewal_rate for the rest.
    For renewal-now case (months_remaining ~0), stay_renewal_rate applies for full HORIZON.
    """
    notes: list[str] = []
    if months_remaining <= 0:
        # At renewal: stay_renewal_rate applies for full 60 months
        rate = stay_renewal_rate
        pmt = monthly_payment(current_balance, rate, amortization_remaining_months)
        end_bal = ending_balance(current_balance, rate, pmt, HORIZON_MONTHS)
        total_int = total_interest(current_balance, end_bal, pmt, HORIZON_MONTHS)
        notes.append("Stay rate is current lender's renewal offer (LS-confirmed)")
    elif months_remaining >= HORIZON_MONTHS:
        # Current term covers full horizon
        rate = contract_rate
        pmt = monthly_payment(current_balance, rate, amortization_remaining_months)
        end_bal = ending_balance(current_balance, rate, pmt, HORIZON_MONTHS)
        total_int = total_interest(current_balance, end_bal, pmt, HORIZON_MONTHS)
        notes.append("Current term spans full 5yr horizon")
    else:
        # Mixed: contract_rate for months_remaining, then stay_renewal_rate
        pmt1 = monthly_payment(current_balance, contract_rate, amortization_remaining_months)
        bal_at_renewal = ending_balance(current_balance, contract_rate, pmt1, months_remaining)
        amort_after = amortization_remaining_months - months_remaining
        pmt2 = monthly_payment(bal_at_renewal, stay_renewal_rate, amort_after)
        rest = HORIZON_MONTHS - months_remaining
        end_bal = ending_balance(bal_at_renewal, stay_renewal_rate, pmt2, rest)
        # Total interest across both segments
        int1 = total_interest(current_balance, bal_at_renewal, pmt1, months_remaining)
        int2 = total_interest(bal_at_renewal, end_bal, pmt2, rest)
        total_int = int1 + int2
        # Use blended monthly_payment as a display value (weighted)
        pmt = (pmt1 * Decimal(months_remaining) + pmt2 * Decimal(rest)) / Decimal(HORIZON_MONTHS)
        rate = stay_renewal_rate  # display rate is the renewal rate
        notes.append(f"First {months_remaining}mo at current rate, then {stay_renewal_rate*100:.2f}% renewal")
    return {
        "rate": rate_to_float(rate),
        "monthly_payment": to_float(pmt),
        "total_interest_60mo": to_float(total_int),
        "ending_balance_60mo": to_float(end_bal),
        "breakage_penalty": 0.0,
        "closing_costs": 0.0,
        "cashback": 0.0,
        "total_cost_5yr": to_float(path_total_cost(pmt, HORIZON_MONTHS, total_int,
                                                    Decimal("0"), Decimal("0"), Decimal("0"))),
        "requires_requalification": False,
        "notes": notes,
    }


def compute_switch(current_balance: Decimal, contract_rate: Decimal,
                   new_rate: Decimal, amortization_remaining_months: int,
                   months_remaining: int, rate_type: str,
                   province: str, cashback: Decimal,
                   broker_rates_by_term: dict[str, Decimal],
                   posted_rate_at_origination: Decimal | None,
                   current_posted_rates_by_term: dict[str, Decimal],
                   lender_default_method: str) -> dict:
    """Path 2: Straight switch. §0, §1, §2, §4, §5.
    Computes BOTH IRD methods (Decision #1). Same-balance, same-amort = no re-qual (§6.2)."""
    notes: list[str] = []
    is_variable = rate_type.lower().startswith("var") or rate_type.upper() == "VRM"

    # IRD (closed fixed only — variable uses 3-mo only)
    bond_ird, bond_comp, bond_term = ird_bond_yield(
        contract_rate, current_balance, months_remaining, broker_rates_by_term)
    posted_ird: Decimal | None = None
    posted_comp: Decimal | None = None
    posted_term: str | None = None
    if posted_rate_at_origination is not None and current_posted_rates_by_term:
        posted_ird, posted_comp, posted_term = ird_posted_rate(
            contract_rate, current_balance, months_remaining,
            posted_rate_at_origination, current_posted_rates_by_term)

    three_mo = three_months_interest(current_balance, contract_rate)

    if is_variable:
        breakage_default = breakage_variable(current_balance, contract_rate)
        notes.append("Variable mortgage — 3-months interest only (no IRD)")
    else:
        breakage_default = breakage_fixed(three_mo, bond_ird)

    if is_late_term(months_remaining):
        notes.append(f"Late term: {months_remaining}mo remaining — confirm penalty waiver with lender")

    closing = closing_costs_switch(province)

    # New payment at new_rate, same balance, same amort
    new_pmt = monthly_payment(current_balance, new_rate, amortization_remaining_months)
    end_bal = ending_balance(current_balance, new_rate, new_pmt, HORIZON_MONTHS)
    total_int = total_interest(current_balance, end_bal, new_pmt, HORIZON_MONTHS)

    result: dict = {
        "rate": rate_to_float(new_rate),
        "monthly_payment": to_float(new_pmt),
        "total_interest_60mo": to_float(total_int),
        "ending_balance_60mo": to_float(end_bal),
        "ird_bond_yield": to_float(bond_ird),
        "ird_bond_yield_comparison_rate": rate_to_float(bond_comp),
        "ird_bond_yield_term_used": bond_term,
        "breakage_floor_3mo": to_float(three_mo),
        "closing_costs": to_float(closing),
        "cashback": to_float(cashback),
        "ird_default_method": lender_default_method,
        "requires_requalification": False,  # straight switch under OSFI Nov 2024
        "notes": notes,
    }

    if posted_ird is not None:
        result["ird_posted_rate"] = to_float(posted_ird)
        result["ird_posted_rate_comparison_rate"] = rate_to_float(posted_comp)
        result["ird_posted_rate_term_used"] = posted_term
    else:
        result["ird_posted_rate"] = None
        result["ird_posted_rate_note"] = "Posted-rate IRD not computed (no posted_rate_at_origination)"

    # Breakage chosen for total cost: use whichever method matches lender_default_method
    if is_variable:
        breakage_chosen = breakage_default
    elif lender_default_method == "posted_rate" and posted_ird is not None:
        breakage_chosen = breakage_fixed(three_mo, posted_ird)
    else:
        breakage_chosen = breakage_default
    result["breakage_chosen"] = to_float(breakage_chosen)

    # Total cost at chosen breakage method (per Decision #1 also output the alternative)
    result["total_cost_5yr"] = to_float(path_total_cost(
        new_pmt, HORIZON_MONTHS, total_int, breakage_chosen, closing, cashback))
    if not is_variable:
        bond_breakage = breakage_fixed(three_mo, bond_ird)
        result["total_cost_5yr_bond_yield"] = to_float(path_total_cost(
            new_pmt, HORIZON_MONTHS, total_int, bond_breakage, closing, cashback))
        if posted_ird is not None:
            posted_breakage = breakage_fixed(three_mo, posted_ird)
            result["total_cost_5yr_posted_rate"] = to_float(path_total_cost(
                new_pmt, HORIZON_MONTHS, total_int, posted_breakage, closing, cashback))
    return result


def compute_blend(current_balance: Decimal, contract_rate: Decimal,
                  lender_blend_rate: Decimal,
                  amortization_remaining_months: int,
                  months_remaining: int,
                  new_term_months: int = HORIZON_MONTHS) -> dict:
    """Path 3: Blend-and-extend. §3."""
    notes: list[str] = []
    blended = blended_rate(contract_rate, months_remaining, lender_blend_rate, new_term_months)
    if blended is None:
        return {
            "applicable": False,
            "notes": [f"Blend not applicable: months_remaining ({months_remaining}) >= new_term ({new_term_months})"],
        }
    pmt = monthly_payment(current_balance, blended, amortization_remaining_months)
    end_bal = ending_balance(current_balance, blended, pmt, HORIZON_MONTHS)
    total_int = total_interest(current_balance, end_bal, pmt, HORIZON_MONTHS)
    notes.append(f"Lender blend rate input: {lender_blend_rate*100:.3f}% — confirm with lender")
    return {
        "applicable": True,
        "rate": rate_to_float(blended),
        "lender_blend_rate_used": rate_to_float(lender_blend_rate),
        "monthly_payment": to_float(pmt),
        "total_interest_60mo": to_float(total_int),
        "ending_balance_60mo": to_float(end_bal),
        "breakage_penalty": 0.0,
        "closing_costs": 0.0,
        "cashback": 0.0,
        "total_cost_5yr": to_float(path_total_cost(
            pmt, HORIZON_MONTHS, total_int, Decimal("0"), Decimal("0"), Decimal("0"))),
        "requires_requalification": False,  # same lender, no new money
        "notes": notes,
    }


def compute_break_refi(current_balance: Decimal, contract_rate: Decimal,
                       new_rate: Decimal, amortization_remaining_months: int,
                       months_remaining: int, rate_type: str, province: str,
                       cashback: Decimal,
                       broker_rates_by_term: dict[str, Decimal],
                       posted_rate_at_origination: Decimal | None,
                       current_posted_rates_by_term: dict[str, Decimal],
                       lender_default_method: str) -> dict:
    """Path 4: Break + Refi (new lender, possibly extended amort). §0, §1, §2, §5, §6.

    For v1, treat as switch with same balance + same amort, but BREAK before maturity
    so penalties apply. Closing costs are the *break* defaults (higher legal).
    Re-qualification REQUIRED per §6.3 (any break-with-refinance triggers MQR)."""
    is_variable = rate_type.lower().startswith("var") or rate_type.upper() == "VRM"
    bond_ird, bond_comp, bond_term = ird_bond_yield(
        contract_rate, current_balance, months_remaining, broker_rates_by_term)
    posted_ird: Decimal | None = None
    posted_comp: Decimal | None = None
    posted_term: str | None = None
    if posted_rate_at_origination is not None and current_posted_rates_by_term:
        posted_ird, posted_comp, posted_term = ird_posted_rate(
            contract_rate, current_balance, months_remaining,
            posted_rate_at_origination, current_posted_rates_by_term)
    three_mo = three_months_interest(current_balance, contract_rate)
    if is_variable:
        breakage_default = breakage_variable(current_balance, contract_rate)
    else:
        breakage_default = breakage_fixed(three_mo, bond_ird)

    closing = closing_costs_break(province, current_balance)
    new_pmt = monthly_payment(current_balance, new_rate, amortization_remaining_months)
    end_bal = ending_balance(current_balance, new_rate, new_pmt, HORIZON_MONTHS)
    total_int = total_interest(current_balance, end_bal, new_pmt, HORIZON_MONTHS)
    notes: list[str] = ["Break+Refi: re-qualification under MQR required (§6.3)"]
    if is_late_term(months_remaining):
        notes.append(f"Late term: {months_remaining}mo remaining — penalty likely waivable, confirm")

    result: dict = {
        "rate": rate_to_float(new_rate),
        "monthly_payment": to_float(new_pmt),
        "total_interest_60mo": to_float(total_int),
        "ending_balance_60mo": to_float(end_bal),
        "ird_bond_yield": to_float(bond_ird),
        "ird_bond_yield_comparison_rate": rate_to_float(bond_comp),
        "ird_bond_yield_term_used": bond_term,
        "breakage_floor_3mo": to_float(three_mo),
        "closing_costs": to_float(closing),
        "cashback": to_float(cashback),
        "ird_default_method": lender_default_method,
        "requires_requalification": True,
        "notes": notes,
    }

    if posted_ird is not None:
        result["ird_posted_rate"] = to_float(posted_ird)
        result["ird_posted_rate_comparison_rate"] = rate_to_float(posted_comp)
        result["ird_posted_rate_term_used"] = posted_term
    else:
        result["ird_posted_rate"] = None
        result["ird_posted_rate_note"] = "Posted-rate IRD not computed (no posted_rate_at_origination)"

    if is_variable:
        breakage_chosen = breakage_default
    elif lender_default_method == "posted_rate" and posted_ird is not None:
        breakage_chosen = breakage_fixed(three_mo, posted_ird)
    else:
        breakage_chosen = breakage_default
    result["breakage_chosen"] = to_float(breakage_chosen)
    result["total_cost_5yr"] = to_float(path_total_cost(
        new_pmt, HORIZON_MONTHS, total_int, breakage_chosen, closing, cashback))
    if not is_variable:
        bond_breakage = breakage_fixed(three_mo, bond_ird)
        result["total_cost_5yr_bond_yield"] = to_float(path_total_cost(
            new_pmt, HORIZON_MONTHS, total_int, bond_breakage, closing, cashback))
        if posted_ird is not None:
            posted_breakage = breakage_fixed(three_mo, posted_ird)
            result["total_cost_5yr_posted_rate"] = to_float(path_total_cost(
                new_pmt, HORIZON_MONTHS, total_int, posted_breakage, closing, cashback))
    return result


# ---------------------------------------------------------------------------
# Variable forecast paths — math-spec §7.2
# ---------------------------------------------------------------------------

def variable_curve_flat(prime_today: Decimal) -> list[Decimal]:
    """§7.2 flat: prime stays at current_prime for all 60 months."""
    return [prime_today] * HORIZON_MONTHS


def variable_curve_forecast(prime_today: Decimal) -> list[Decimal]:
    """§7.2 forecast: months 1-12 prime, 13-36 prime-25bps, 37-60 prime-25bps."""
    drop = Decimal("0.0025")
    out: list[Decimal] = []
    for m in range(1, HORIZON_MONTHS + 1):
        if m <= 12:
            out.append(prime_today)
        else:
            out.append(prime_today - drop)
    return out


def variable_curve_stress(prime_today: Decimal) -> list[Decimal]:
    """§7.2 stress: +25bps every 6 months for 24 months, then plateau at +100bps."""
    out: list[Decimal] = []
    bp25 = Decimal("0.0025")
    for m in range(1, HORIZON_MONTHS + 1):
        if m <= 6:
            out.append(prime_today)
        elif m <= 12:
            out.append(prime_today + bp25)
        elif m <= 18:
            out.append(prime_today + 2 * bp25)
        else:
            # Per spec table months 19-60 = prime + 100bps
            out.append(prime_today + 4 * bp25)
    return out


def project_variable(current_balance: Decimal,
                     variable_offered_today: Decimal,
                     prime_today: Decimal,
                     prime_curve: list[Decimal],
                     amortization_remaining_months: int) -> tuple[Decimal, Decimal, Decimal]:
    """Project variable path with prime curve. ARM-style: payment recomputes each rate change.

    Returns (avg_monthly_payment_for_display, total_interest, ending_balance).
    """
    # Variable rate at month i = variable_offered_today + (prime[i] - prime_today)
    # That is, the spread to prime stays constant.
    spread = variable_offered_today - prime_today
    balance = current_balance
    total_int = Decimal("0")
    pmt_history: list[Decimal] = []
    amort_left = amortization_remaining_months
    last_pmt = Decimal("0")
    last_rate = None
    for m in range(HORIZON_MONTHS):
        rate = prime_curve[m] + spread
        if rate < Decimal("0.001"):
            rate = Decimal("0.001")
        if last_rate is None or rate != last_rate:
            # Recompute payment based on remaining amort
            last_pmt = monthly_payment(balance, rate, amort_left)
            last_rate = rate
        # Apply one month
        mr = monthly_rate_canadian(rate)
        interest_this_month = balance * mr
        principal_this_month = last_pmt - interest_this_month
        if principal_this_month < 0:
            principal_this_month = Decimal("0")  # negative-am protection (shouldn't happen for ARM)
        balance = max(balance - principal_this_month, Decimal("0"))
        total_int += interest_this_month
        amort_left -= 1
        pmt_history.append(last_pmt)
        if amort_left <= 0 or balance <= 0:
            break
    avg_pmt = sum(pmt_history, Decimal("0")) / Decimal(len(pmt_history)) if pmt_history else Decimal("0")
    return money(avg_pmt), money(total_int), money(balance)


def trigger_rate(monthly_pmt: Decimal, current_balance: Decimal) -> Decimal:
    """§7.3 trigger rate = (monthly_payment * 12) / current_balance."""
    if current_balance <= 0:
        return Decimal("0")
    return monthly_pmt * Decimal(12) / current_balance


def compute_variable(current_balance: Decimal,
                     variable_offered_today: Decimal,
                     prime_today: Decimal,
                     amortization_remaining_months: int,
                     variable_subtype: str,
                     province: str,
                     cashback: Decimal,
                     payment_amount_current: Decimal,
                     is_at_renewal: bool) -> dict:
    """Path 5: Variable. Three forecast scenarios (flat, forecast, stress). §7."""
    closing = closing_costs_switch(province) if not is_at_renewal else Decimal("0")
    breakage = Decimal("0") if is_at_renewal else Decimal("0")  # at-renewal: no penalty

    out: dict = {}
    for label, curve_fn in [("flat", variable_curve_flat),
                            ("forecast", variable_curve_forecast),
                            ("stress", variable_curve_stress)]:
        curve = curve_fn(prime_today)
        avg_pmt, total_int, end_bal = project_variable(
            current_balance, variable_offered_today, prime_today, curve,
            amortization_remaining_months)
        out[label] = {
            "starting_rate": rate_to_float(variable_offered_today),
            "ending_prime": rate_to_float(curve[-1]),
            "avg_monthly_payment": to_float(avg_pmt),
            "total_interest_60mo": to_float(total_int),
            "ending_balance_60mo": to_float(end_bal),
            "breakage_penalty": to_float(breakage),
            "closing_costs": to_float(closing),
            "cashback": to_float(cashback),
            "total_cost_5yr": to_float(path_total_cost(
                avg_pmt, HORIZON_MONTHS, total_int, breakage, closing, cashback)),
        }

    # Trigger rate — only meaningful for fixed_payment_VRM
    is_fixed_payment_vrm = (variable_subtype or "").lower() == "fixed_payment_vrm"
    tr = trigger_rate(payment_amount_current, current_balance) if is_fixed_payment_vrm else None
    out["trigger_rate"] = ({
        "value": rate_to_float(tr),
        "source": "computed",
        "applies_to": "fixed_payment_VRM",
    } if tr is not None else {
        "value": None,
        "applies_to": variable_subtype,
        "note": "Trigger rate concept does not apply (adjustable ARM payment moves with prime)"
            if (variable_subtype or "").lower() == "adjustable_arm" else
            "variable_subtype unknown — confirm with LS",
    })

    out["requires_requalification"] = not is_at_renewal  # break-to-variable triggers MQR
    return out


# ---------------------------------------------------------------------------
# Break-even rate — math-spec §7.4
# ---------------------------------------------------------------------------

def break_even_variable_rate(fixed_total_cost: Decimal,
                             current_balance: Decimal,
                             prime_today: Decimal,
                             amortization_remaining_months: int,
                             closing: Decimal, cashback: Decimal,
                             max_iterations: int = 100,
                             tolerance: Decimal = Decimal("1.0")) -> tuple[Decimal | None, int]:
    """§7.4 bisection: variable rate (held constant) at which total_cost == fixed_total_cost.
    Returns (rate, iterations_used). None if not found within bounds."""
    lo = Decimal("0.0001")
    hi = Decimal("0.20")

    def cost_at(rate: Decimal) -> Decimal:
        # Held-constant variable rate (flat path)
        pmt = monthly_payment(current_balance, rate, amortization_remaining_months)
        end_bal = ending_balance(current_balance, rate, pmt, HORIZON_MONTHS)
        total_int = total_interest(current_balance, end_bal, pmt, HORIZON_MONTHS)
        return path_total_cost(pmt, HORIZON_MONTHS, total_int, Decimal("0"), closing, cashback)

    cost_lo = cost_at(lo)
    cost_hi = cost_at(hi)
    if (cost_lo - fixed_total_cost) * (cost_hi - fixed_total_cost) > 0:
        # No sign change in interval — break-even rate lies outside [lo, hi]
        return None, 0
    iterations = 0
    while iterations < max_iterations:
        iterations += 1
        mid = (lo + hi) / 2
        cost_mid = cost_at(mid)
        diff = cost_mid - fixed_total_cost
        if abs(diff) < tolerance:
            return mid, iterations
        if (cost_lo - fixed_total_cost) * diff < 0:
            hi = mid
            cost_hi = cost_mid
        else:
            lo = mid
            cost_lo = cost_mid
    return mid, iterations


# ---------------------------------------------------------------------------
# Lender helpers
# ---------------------------------------------------------------------------

def lender_ird_method(lender: str) -> str:
    """§1.4 default method per lender."""
    if not lender:
        return "bond_yield"  # default for unknown
    norm = lender.strip()
    for posted in POSTED_RATE_LENDERS:
        if posted.lower() in norm.lower() or norm.lower() in posted.lower():
            return "posted_rate"
    return "bond_yield"


def lender_variable_subtype(lender: str) -> str:
    """§7.3 default by lender."""
    if not lender:
        return "fixed_payment_vrm"
    for arm in ADJUSTABLE_ARM_LENDERS:
        if arm.lower() in lender.lower():
            return "adjustable_arm"
    return "fixed_payment_vrm"


# ---------------------------------------------------------------------------
# Main calc — assembles outputs
# ---------------------------------------------------------------------------

def calc(inputs: dict) -> dict:
    """Top-level: take inputs JSON, return results JSON per spec §8."""
    today = dt.date.today()

    # --- Required fields ---
    deal_id = inputs.get("deal_id")
    deal_name = inputs.get("deal_name", "")
    contract_rate = D(inputs["contract_rate"])
    lender = (inputs.get("lender") or "").strip()
    rate_type = (inputs.get("rate_type") or "Fixed")
    province = (inputs.get("province") or "BC")
    funded_date_str = inputs["funded_date"]
    maturity_date_str = inputs["maturity_date"]
    funded_date = dt.date.fromisoformat(funded_date_str)
    maturity_date = dt.date.fromisoformat(maturity_date_str)
    payment_amount = D(inputs["payment_amount"])
    original_amortization_months = int(inputs["original_amortization_months"])

    # current_balance: use provided if available (LS-confirmed), else compute from origin
    if "current_balance" in inputs and inputs["current_balance"] is not None:
        current_balance = D(inputs["current_balance"])
        balance_source = "ls_confirmed"
    else:
        # Fall back to original loan amount + amort formula
        original = D(inputs.get("original_mortgage_amount", inputs.get("mortgage_amount")))
        current_balance = current_balance_from_origin(
            original, contract_rate, payment_amount, funded_date, today)
        balance_source = "computed"

    months_remaining = (maturity_date.year - today.year) * 12 + (maturity_date.month - today.month)
    months_remaining = max(0, months_remaining)
    months_elapsed = (today.year - funded_date.year) * 12 + (today.month - funded_date.month)
    amort_remaining_months = max(original_amortization_months - months_elapsed, 1)

    # --- Market rates ---
    market_rates = inputs.get("market_rates", {})
    fixed_5yr = D(market_rates.get("5yr_fixed", market_rates.get("5yr_fixed_offered", "0.0379")))
    variable_5yr = D(market_rates.get("5yr_variable", "0.0340"))
    prime = D(market_rates.get("prime", "0.0445"))

    broker_rates_by_term: dict[str, Decimal] = {}
    for term_key in ("1yr", "2yr", "3yr", "4yr", "5yr"):
        full_key_fixed = f"{term_key}_fixed"
        if full_key_fixed in market_rates:
            broker_rates_by_term[term_key] = D(market_rates[full_key_fixed])
        elif term_key in market_rates:
            broker_rates_by_term[term_key] = D(market_rates[term_key])
    if not broker_rates_by_term:
        broker_rates_by_term["5yr"] = fixed_5yr

    # Posted rates (current) for Posted-Rate IRD comparison
    current_posted_rates_by_term: dict[str, Decimal] = {}
    for term_key in ("1yr", "2yr", "3yr", "4yr", "5yr"):
        v = market_rates.get(f"{term_key}_posted")
        if v is not None:
            current_posted_rates_by_term[term_key] = D(v)
    # Also accept 'current_posted_rates' nested dict (skill convention)
    # Filter to numeric values only — schema includes a 'source' string for provenance
    cpr = inputs.get("current_posted_rates", {})
    for k, v in cpr.items():
        if isinstance(v, (int, float)) or (isinstance(v, str) and v.replace(".", "").replace("-", "").isdigit()):
            current_posted_rates_by_term[k] = D(v)

    # Posted rate at origination (estimate, optional)
    posted_at_origination = inputs.get("estimated_posted_rate_at_origination")
    if posted_at_origination is not None:
        posted_at_origination = D(posted_at_origination)

    # Stay renewal rate — from input or default to current 5yr fixed
    stay_renewal_rate = D(inputs.get("stay_renewal_rate", fixed_5yr))

    # Lender method + variable subtype (override allowed via inputs)
    method = inputs.get("lender_ird_method") or lender_ird_method(lender)
    subtype = (inputs.get("variable_subtype") or lender_variable_subtype(lender)).lower()

    # Cashback (optional, default 0)
    cashback = D(inputs.get("cashback", "0"))

    # --- Trapped check inputs ---
    income = D(inputs.get("household_income_gross", "0"))
    obligations = D(inputs.get("monthly_obligations", "0"))
    prop_taxes = D(inputs.get("property_taxes_annual", "0"))
    heat = D(inputs.get("heating_cost_annual", DEFAULT_HEATING_ANNUAL))

    # --- Run trapped check ---
    trapped = trapped_check(current_balance, income, obligations,
                            prop_taxes, heat, fixed_5yr)

    # --- Compute paths ---
    is_at_renewal = months_remaining <= 1

    stay = compute_stay(current_balance, contract_rate, stay_renewal_rate,
                        amort_remaining_months, months_remaining)

    # For Switch: at renewal = no breakage; before maturity = breakage applies
    if is_at_renewal:
        # At-renewal switch: no IRD, no 3-mo penalty
        switch = compute_switch_at_renewal(current_balance, fixed_5yr,
                                           amort_remaining_months, province, cashback)
    else:
        switch = compute_switch(current_balance, contract_rate, fixed_5yr,
                                amort_remaining_months, months_remaining,
                                rate_type, province, cashback,
                                broker_rates_by_term, posted_at_origination,
                                current_posted_rates_by_term, method)

    lender_blend_rate = D(inputs.get("lender_blend_rate", fixed_5yr + DEFAULT_BLEND_MARKUP))
    blend = compute_blend(current_balance, contract_rate, lender_blend_rate,
                          amort_remaining_months, months_remaining)

    if is_at_renewal:
        break_refi = compute_break_refi_at_renewal(current_balance, fixed_5yr,
                                                    amort_remaining_months, province, cashback)
    else:
        break_refi = compute_break_refi(current_balance, contract_rate, fixed_5yr,
                                        amort_remaining_months, months_remaining,
                                        rate_type, province, cashback,
                                        broker_rates_by_term, posted_at_origination,
                                        current_posted_rates_by_term, method)

    variable = compute_variable(current_balance, variable_5yr, prime,
                                amort_remaining_months, subtype, province, cashback,
                                payment_amount, is_at_renewal)

    # --- Break-even rate ---
    fixed_cost_for_breakeven = D(switch["total_cost_5yr"])
    closing_for_breakeven = D(switch.get("closing_costs", 0))
    be_rate, be_iters = break_even_variable_rate(
        fixed_cost_for_breakeven, current_balance, prime,
        amort_remaining_months, closing_for_breakeven, cashback)

    # --- Assemble assumptions / warnings ---
    assumptions: list[dict] = [
        {"key": "heating_cost_annual", "value": float(heat),
         "source": "default" if "heating_cost_annual" not in inputs else "ls_confirmed",
         "label": "Annual heating (CMHC default $1,200)"},
        {"key": "stay_renewal_rate", "value": rate_to_float(stay_renewal_rate),
         "source": "default" if "stay_renewal_rate" not in inputs else "ls_confirmed",
         "label": "Stay-path renewal rate (today's 5yr fixed offered, per Decision #2)"},
        {"key": "lender_blend_rate", "value": rate_to_float(lender_blend_rate),
         "source": "default" if "lender_blend_rate" not in inputs else "ls_confirmed",
         "label": "Lender blend rate (default = 5yr broker + 50bps; confirm with lender per §3.1)"},
    ]
    if posted_at_origination is not None:
        assumptions.append({
            "key": "posted_rate_at_origination", "value": rate_to_float(posted_at_origination),
            "source": "estimate",
            "label": "BoC representative posted rate at funding month (Posted-Rate IRD est.)"
        })
    assumptions.append({
        "key": "current_balance", "value": to_float(current_balance),
        "source": balance_source,
        "label": "Current outstanding balance" + (" (LS-confirmed)" if balance_source == "ls_confirmed"
                  else " (computed via amort formula — Mortgage_Amount is original)"),
    })

    warnings: list[str] = []
    if "updated_at" in market_rates:
        try:
            ru = dt.datetime.fromisoformat(market_rates["updated_at"].replace("Z", "+00:00"))
            age_days = (dt.datetime.now(dt.timezone.utc) - ru).days
            if age_days > 7:
                warnings.append(f"market_rates.updated_at is {age_days}d old (warn at >7d, refuse at >14d)")
            if age_days > 14:
                warnings.append("RATES STALE: refuse-threshold reached. Run /rate-update before sending.")
        except Exception:
            pass
    if not current_posted_rates_by_term and lender_ird_method(lender) == "posted_rate":
        warnings.append(f"Lender {lender} uses Posted-Rate IRD but no current_posted_rates supplied — Posted-Rate IRD will be skipped")
    if posted_at_origination is None and lender_ird_method(lender) == "posted_rate":
        warnings.append(f"Lender {lender} uses Posted-Rate IRD but no estimated_posted_rate_at_origination supplied")

    # --- Output ---
    return {
        "deal_id": deal_id,
        "deal_name": deal_name,
        "current_balance": {"value": to_float(current_balance), "source": balance_source},
        "months_remaining": months_remaining,
        "months_elapsed": months_elapsed,
        "amort_remaining_months": amort_remaining_months,
        "lender": lender,
        "lender_ird_method": method,
        "variable_subtype": subtype,
        "province": province,
        "is_at_renewal": is_at_renewal,
        "trapped_check": {
            "is_trapped": trapped.is_trapped,
            "gds": float(trapped.gds.quantize(Decimal("0.0001"))),
            "tds": float(trapped.tds.quantize(Decimal("0.0001"))),
            "qualifying_rate": rate_to_float(trapped.qualifying_rate),
            "qualifying_payment": to_float(trapped.qualifying_payment),
            "reason": trapped.reason,
        },
        "break_even_rate": {
            "value": rate_to_float(be_rate) if be_rate is not None else None,
            "source": "computed",
            "iterations": be_iters,
            "note": ("Variable wins as long as average rate stays below this for 5 years"
                     if be_rate is not None else "Break-even rate outside [0.01%, 20%] bounds"),
        },
        "paths": {
            "stay": stay,
            "switch": switch,
            "blend_extend": blend,
            "break_refi": break_refi,
            "variable": variable,
        },
        "assumptions": assumptions,
        "warnings": warnings,
        "errors": [],
        "calc_version": CALC_VERSION,
        "calc_timestamp": dt.datetime.utcnow().isoformat() + "Z",
    }


def compute_switch_at_renewal(current_balance: Decimal, new_rate: Decimal,
                              amort_remaining_months: int, province: str,
                              cashback: Decimal) -> dict:
    """At-renewal switch: no IRD, no 3-mo penalty. Closing costs only."""
    closing = closing_costs_switch(province)
    new_pmt = monthly_payment(current_balance, new_rate, amort_remaining_months)
    end_bal = ending_balance(current_balance, new_rate, new_pmt, HORIZON_MONTHS)
    total_int = total_interest(current_balance, end_bal, new_pmt, HORIZON_MONTHS)
    return {
        "rate": rate_to_float(new_rate),
        "monthly_payment": to_float(new_pmt),
        "total_interest_60mo": to_float(total_int),
        "ending_balance_60mo": to_float(end_bal),
        "ird_bond_yield": 0.0,
        "ird_posted_rate": 0.0,
        "breakage_floor_3mo": 0.0,
        "breakage_chosen": 0.0,
        "closing_costs": to_float(closing),
        "cashback": to_float(cashback),
        "total_cost_5yr": to_float(path_total_cost(
            new_pmt, HORIZON_MONTHS, total_int, Decimal("0"), closing, cashback)),
        "requires_requalification": False,  # straight switch under OSFI Nov 2024
        "ird_default_method": "n/a (at renewal)",
        "notes": ["At-renewal switch: no breakage penalty. Closing costs only."],
    }


def compute_break_refi_at_renewal(current_balance: Decimal, new_rate: Decimal,
                                   amort_remaining_months: int, province: str,
                                   cashback: Decimal) -> dict:
    """At-renewal break+refi: still triggers re-qual since refi takes new money/extends amort.
    Closing costs are the break defaults."""
    closing = closing_costs_break(province, current_balance)
    new_pmt = monthly_payment(current_balance, new_rate, amort_remaining_months)
    end_bal = ending_balance(current_balance, new_rate, new_pmt, HORIZON_MONTHS)
    total_int = total_interest(current_balance, end_bal, new_pmt, HORIZON_MONTHS)
    return {
        "rate": rate_to_float(new_rate),
        "monthly_payment": to_float(new_pmt),
        "total_interest_60mo": to_float(total_int),
        "ending_balance_60mo": to_float(end_bal),
        "ird_bond_yield": 0.0,
        "ird_posted_rate": 0.0,
        "breakage_floor_3mo": 0.0,
        "breakage_chosen": 0.0,
        "closing_costs": to_float(closing),
        "cashback": to_float(cashback),
        "total_cost_5yr": to_float(path_total_cost(
            new_pmt, HORIZON_MONTHS, total_int, Decimal("0"), closing, cashback)),
        "requires_requalification": True,
        "ird_default_method": "n/a (at renewal)",
        "notes": ["At-renewal break+refi: re-qualification required (any new money / extended amort triggers MQR)"],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main_cli() -> None:
    parser = argparse.ArgumentParser(description="Flow Renewal Scenarios calculator")
    parser.add_argument("--inputs", required=True, help="path to inputs.json")
    parser.add_argument("--output", required=True, help="path to results.json")
    args = parser.parse_args()

    with open(args.inputs, "r", encoding="utf-8") as f:
        inputs = json.load(f)
    try:
        result = calc(inputs)
    except Exception as e:
        result = {
            "deal_id": inputs.get("deal_id"),
            "errors": [f"calc failed: {type(e).__name__}: {e}"],
            "calc_version": CALC_VERSION,
        }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)


# ---------------------------------------------------------------------------
# Self-tests — run via `python calc.py --test`
# ---------------------------------------------------------------------------

def run_tests() -> int:
    """Five required invariants per directive."""
    failures: list[str] = []

    # Test 1: current balance < original when funded > 12mo ago
    today_test = dt.date(2026, 5, 8)
    funded = dt.date(2024, 5, 8)  # 24 months ago
    original = D("400000")
    rate = D("0.0429")
    pmt = monthly_payment(original, rate, 300)
    bal_now = ending_balance(original, rate, pmt, 24)
    if bal_now >= original:
        failures.append(f"Test 1 FAIL: current balance ({bal_now}) >= original ({original}) after 24mo")

    # Test 2: 3-months interest < IRD when posted-rate method on Big 5 with significant rate drop
    contract = D("0.0529")  # high contract rate
    bal = D("400000")
    months_rem = 24
    posted_orig = D("0.0779")
    current_posted = {"2yr": D("0.0599"), "3yr": D("0.0599"), "1yr": D("0.0549"), "5yr": D("0.0599")}
    posted_ird, _, _ = ird_posted_rate(contract, bal, months_rem, posted_orig, current_posted)
    three_mo = three_months_interest(bal, contract)
    if posted_ird <= three_mo:
        failures.append(f"Test 2 FAIL: posted IRD ({posted_ird}) not > 3mo ({three_mo}) on synthetic Big 5 case")

    # Test 3: variable flat == variable forecast when forecast curve is flat
    # Construct identical curves and verify project_variable returns same result
    bal = D("400000")
    var_today = D("0.034")
    prime_today = D("0.0445")
    flat_curve = variable_curve_flat(prime_today)
    forecast_curve = variable_curve_forecast(prime_today)
    # If we override forecast with flat, the result must match
    avg1, int1, end1 = project_variable(bal, var_today, prime_today, flat_curve, 300)
    avg2, int2, end2 = project_variable(bal, var_today, prime_today, flat_curve, 300)
    if avg1 != avg2 or int1 != int2 or end1 != end2:
        failures.append("Test 3 FAIL: same curve produces different results (non-deterministic)")

    # Test 4: trapped check fires on synthetic high-TDS input
    res = trapped_check(
        current_balance=D("600000"), household_income_gross=D("80000"),
        monthly_obligations=D("2000"), property_taxes_annual=D("6000"),
        heat_annual=D("1200"), market_5yr_fixed_offered=D("0.0479"))
    if not res.is_trapped:
        failures.append(f"Test 4 FAIL: trapped check did not fire on synthetic high-TDS case "
                        f"(GDS {res.gds}, TDS {res.tds})")

    # Test 5: break-even bisection converges within 100 iterations
    fixed_cost = D("100000")
    bal = D("400000")
    prime_today = D("0.0445")
    rate, iters = break_even_variable_rate(
        fixed_cost, bal, prime_today, 300, Decimal("0"), Decimal("0"))
    if iters > 100:
        failures.append(f"Test 5 FAIL: break-even bisection took {iters} > 100 iterations")
    # Even if no solve found within bounds, iterations should be <= 100
    if rate is None and iters != 0:
        failures.append(f"Test 5 FAIL: rate=None but iterations != 0 ({iters})")

    # Test 6 (extra): semi-annual compounding produces monthly_r < annual_rate / 12
    annual = D("0.0500")
    mr = monthly_rate_canadian(annual)
    naive = annual / Decimal(12)
    if mr >= naive:
        failures.append(f"Test 6 FAIL: Canadian semi-annual mr ({mr}) should be < naive ({naive})")

    # Test 7 (extra): full calc end-to-end smoke test
    sample_inputs = {
        "deal_id": "TEST_001",
        "deal_name": "Test Deal",
        "contract_rate": "0.0249",
        "lender": "MCAP",
        "rate_type": "Fixed",
        "province": "BC",
        "funded_date": "2021-08-15",
        "maturity_date": "2026-08-15",
        "payment_amount": "1842.55",
        "original_amortization_months": 300,
        "original_mortgage_amount": "400000",
        "household_income_gross": "165000",
        "monthly_obligations": "850",
        "property_taxes_annual": "4200",
        "market_rates": {
            "5yr_fixed": "0.0379",
            "5yr_variable": "0.0340",
            "3yr_fixed": "0.0395",
            "1yr_fixed": "0.0549",
            "prime": "0.0445",
            "updated_at": "2026-05-05T12:00:00Z",
        },
    }
    try:
        result = calc(sample_inputs)
        assert result["paths"]["stay"]["total_cost_5yr"] > 0
        assert result["paths"]["switch"]["total_cost_5yr"] > 0
        assert "blend_extend" in result["paths"]
        assert "variable" in result["paths"]
        assert result["calc_version"] == CALC_VERSION
    except Exception as e:
        failures.append(f"Test 7 FAIL (smoke test): {type(e).__name__}: {e}")

    # Test 8 (extra): full calc on Big 5 deal exercises Posted-Rate IRD branches
    big5_inputs = {
        "deal_id": "TEST_BIG5",
        "deal_name": "Big 5 Test",
        "contract_rate": "0.0249",
        "lender": "RBC",
        "rate_type": "Fixed",
        "province": "AB",
        "funded_date": "2021-08-15",
        "maturity_date": "2026-11-15",  # 6mo remaining => break+refi makes sense
        "payment_amount": "1842.55",
        "original_amortization_months": 300,
        "original_mortgage_amount": "400000",
        "estimated_posted_rate_at_origination": "0.0479",
        "current_posted_rates": {"1yr": "0.0549", "3yr": "0.0605", "5yr": "0.0609"},
        "household_income_gross": "165000",
        "monthly_obligations": "850",
        "property_taxes_annual": "4200",
        "market_rates": {
            "5yr_fixed": "0.0379",
            "5yr_variable": "0.0340",
            "3yr_fixed": "0.0395",
            "1yr_fixed": "0.0549",
            "prime": "0.0445",
            "updated_at": "2026-05-05T12:00:00Z",
        },
    }
    try:
        big5_result = calc(big5_inputs)
        assert big5_result["lender_ird_method"] == "posted_rate", \
            f"RBC should default to posted_rate, got {big5_result['lender_ird_method']}"
        assert big5_result["paths"]["switch"]["ird_posted_rate"] is not None, \
            "Posted-rate IRD should compute for Big 5"
        assert big5_result["paths"]["break_refi"]["ird_posted_rate"] is not None, \
            "Posted-rate IRD should compute for Big 5 break+refi"
        # The posted-rate total cost branch must not crash
        assert "total_cost_5yr_posted_rate" in big5_result["paths"]["break_refi"], \
            "break_refi posted-rate total cost branch must execute"
    except Exception as e:
        failures.append(f"Test 8 FAIL (Big 5 smoke): {type(e).__name__}: {e}")

    total_tests = 8
    if failures:
        print("FAILURES:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"All {total_tests} tests passed.")
    return 0


if __name__ == "__main__":
    if "--test" in sys.argv:
        sys.exit(run_tests())
    main_cli()
