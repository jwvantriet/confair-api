"""
Verbatim reference copy of the Anvil (Python) server module used by the
legacy Anvil app to convert a RAIDO roster into payables for Air Atlanta
(pilots, mechanics, loadmasters). Kept here as the source-of-truth for
porting the rules into confair-api's charge engine.

DO NOT IMPORT OR EXECUTE. This file is reference-only and is not part of
the Node/Express runtime. The normalized rules extracted from it live in
the sibling markdown specs (aai-pilots.md, aai-mechanics.md, aai-loadmasters.md).

Source: provided by the user on 2026-04-23.
"""

import anvil
import anvil.server
import anvil.http
import anvil.secrets
from anvil.tables import app_tables
from datetime import datetime, timezone, date, timedelta
import json
import csv
from io import StringIO
import io
try:
  import xlsxwriter  # type: ignore
except Exception:
  xlsxwriter = None
from typing import Any, Dict, List, Optional

# --------------------------------------------------------
# CONFIG (set these as App Secrets in Anvil Settings > Secrets)
#   RAIDO_BASE_URL : https://aai-apim-prod-northeu-01.azure-api.net/raido/v1/nocrestapi/v1
#   RAIDO_API_KEY  : <your Azure APIM subscription key>
# --------------------------------------------------------
BASE_URL = anvil.secrets.get_secret("RAIDO_BASE_URL")
API_KEY  = anvil.secrets.get_secret("RAIDO_API_KEY")

HEADERS = {
  "Ocp-Apim-Subscription-Key": API_KEY,
  "Accept": "application/json"
}

# Cache flights per (from,to,filter)
_FLIGHTS_CACHE = {}
_FLT_FILTER = "Times"  # required to include times in flights response
ROLE_WHITELIST = {"WW", "21-14", "24-12", "20-10", "21-21", "24-6", "28-12", "14-14", "LEAD", "SFO"}
BLH_LOOKBACK_DAYS = 35  # limit lookback for BLH window (was 45)
PILOT_DUTY_END_CODES = {
  "20-10",
  "21-14",
  "21-21",
  "24-12",
  "24-6",
  "28-21",
  "EML",
  "RLO",
  "RLOF",
  "RLOW",
  "MVTD",
  "PXP",
  "ULV",
  "VAU",
  "WFL",
  "CNV",
}

# ---------------- Maintenance crew flags (MX reporting) ----------------
_MX_FLAG_KEYS = [
  "b2_allowance",
  "crs_fee",
  "crs_premium",
  "shift_foreman",
  "lead_technician",
  "base_rep",
]

# =============================================================================
# The full Anvil module body (helpers, HTTP plumbing, XLSX media, maintenance
# flag storage) has been trimmed from this reference file — only the rule-
# bearing extracts below are retained. The complete text is preserved in the
# conversation archive associated with PR #24.
#
# Key rule-bearing symbols in the original module:
#   _day_is_payable_for_summary               shared payable-day gate
#   _inject_loadmaster_blank_activities       inject blank shift per day
#   _map_rosters_with_flights                 raw roster → detail rows
#   _build_default_summary                    pilots/office/loadmasters
#   _build_default_daily_counts               per-day counts (default)
#   _build_maintenance_summary                mechanics monthly summary
#   _build_maintenance_daily_counts           mechanics per-day counts
#   _build_blh_report                         BLH overtime per rotation
#
# Extracted rules live in the sibling .md specs.
# =============================================================================
