# AAI Loadmasters — Charge Rules

Extracted from the legacy Anvil module (`aai-anvil-rules.py`). Loadmasters
reuse the **pilot / default** summary pipeline (`_build_default_summary` /
`_build_default_daily_counts`), with one crucial pre-step:

## Blank-activity injection (`_inject_loadmaster_blank_activities`)

Because loadmasters often have fewer scheduled activities than pilots (they
can have quiet days on the roster that are still payable waiting days), the
Anvil module **injects synthetic "BLANK Shift" activities** before running
the summary. Specifically, for each loadmaster (`Type starts with "L"`):

1. For **every day in the payroll period that has no activity row**, insert a
   blank row:
   - `ActivityCode = BLANK`, `ActivityType = BLANK`, `ActivitySubType = Shift`
   - start = `day 00:00:01Z`, end = `day 23:59:59Z`
   - Same crew metadata as the real activities.

2. For **the day immediately after the last day of each payable-streak**,
   insert a blank row too (if not already present and still inside the
   period). Rationale: loadmasters are paid the "reset" day that closes a
   rotation.

After injection the rows flow through the same default (pilot-style)
summary. Net effect: loadmasters effectively get **one Daily Allowance per
day** covered by their contract in the period, unless the day is explicitly
OFF / GRNAW / SIMAW / CBT-at-home / CNV-only / illness-at-home.

## Charge types

Same as pilots — the default pipeline does not branch on role once blanks
are injected. So:

| Charge type | Source |
|---|---|
| DailyAllowance, Availability Premium, Years with Client, PerDiem, GroundFee, SimFee, SoldOffDay, BODDays | Same rules as `aai-pilots.md`. |
| totalFlightHoursOvertimeDecimal (BLH) | Pilots-only in practice — loadmasters rarely accumulate BLH; the report can still run but typically emits nothing. |

## Key differences vs pilots

- **BLANK day injection** (above) — loadmasters get credited for quiet days.
- **Premium allowlist exception** (`ADOE / MIOD / RDVT`) — same logic,
  applies to any crew with empty ActiveRoles. Probably triggers for
  loadmasters more often.
- No duty end codes apply meaningfully (BLH rotation closes don't fire for
  loadmasters).

## Open questions

1. **Is BLANK injection the right model to carry forward?** It's a legacy
   workaround for RAIDO not returning rows for quiet days. The cleaner model
   is: "if the placement is active on day D and D is not OFF, it's payable".
   Should we keep injecting blanks, or have the engine iterate per-day over
   the period directly?
2. **"Type starts with L"** — confirm that RAIDO `Crew.Type` returns e.g.
   `L-...` for loadmasters. This is the pure marker the module uses.
3. **Availability Premium** — currently mirrors DailyAllowance with the same
   empty-role / WW-only zeroing as pilots. For loadmasters, is there a
   different rule or is it the same?
