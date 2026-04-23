# AAI Mechanics (Maintenance) — Charge Rules

Extracted from the legacy Anvil module (`aai-anvil-rules.py`,
`_build_maintenance_summary` + `_build_maintenance_daily_counts`).

## Inputs

- RAIDO roster for the crew in the payroll period.
- Per-crew **Maintenance Flags** (editable manually in Anvil — need to be
  modelled in confair-platform as editable config per placement/crew):
  - `b2_allowance` — does this mechanic earn the B2 Allowance
  - `crs_fee` — CRS Fee eligible
  - `crs_premium` — CRS Premium eligible
  - `base_rep` — base representative stipend
  - ~~`shift_foreman`~~, ~~`lead_technician`~~ — now **derived from ActiveRoles**
    (SFO / LEAD) rather than flag fields.
- `ActiveRoles` from RAIDO Crew SpecialRoles (whitelist: WW, 21-14, 24-12,
  20-10, 21-21, 24-6, 28-12, 14-14, LEAD, SFO).

## Charge types

| Charge type | Unit | Rule |
|---|---|---|
| **Daily Allowance** | per day | Payable-day rule (below). |
| **Extra Days** | per day | Any activity with `ActivityCode = ECD` or `Designator = ECD`. |
| **Overtime** | per day | Column present but always 0 in current module (placeholder). *[Q: how should OT be computed for mechanics?]* |
| **Flight Pay - 1-10** | per day | Flight on day with `Designator` containing `u` **and** BLH ≤ 10h (600 min). |
| **Flight Pay 10-24** | per day | Flight on day with `Designator` containing `u` **and** BLH > 10h. |
| **MXLD** | per day | Any activity with `Designator` containing `mxld`. |
| **MXSF** | per day | Any activity with `Designator` containing `mxsf`. |
| **B2 Allowance** | per day | Per qualifying Daily Allowance day **if** `b2_allowance` flag set. |
| **Boroscope Allowance** | 1 or 2 per day | `Designator = MXBO1` → 1; `Designator = MXBO2` → 2. |
| **CRS Fee** | per day | Per qualifying Daily Allowance day **if** `crs_fee` flag set. |
| **CRS Premium** | per day | Per qualifying Daily Allowance day **if** `crs_premium` flag set. |
| **Location Allowance (KSA)** | 0 or 1 **per month** | 1 if the crew had any shift at `JED` during the month, else 0. |
| **Travel Allowance** | per travel block | Transport block that touches the crew's home base (or is adjacent to a home DayOff) earns 1 per block. See travel rules below. |
| **Shift Foreman** | 0 or 1 per month | 1 if `SFO` in ActiveRoles at any point in the window. |
| **Lead Technician** | 0 or 1 per month | 1 if `LEAD` in ActiveRoles **and** forces Daily Allowance to min 21 for the month. |
| **Base Rep** | 0 or 1 per month | 1 if `base_rep` flag is set **and** total Daily Allowance > 0. |

## Daily Allowance — payable-day gate (mechanics)

A day counts for Daily Allowance iff:

- Day is **not** an OFF subtype (DayOff / Vacation / Vac), **and**
- Day has at least one of: `shift`, `work flight` (non-passenger flight), or
  `hotel` (but hotel alone on a transport day does NOT qualify).

Special cases that adjust the default:

1. **Transport-only day not touching crew_nia** → still counts as Daily
   Allowance = 1 (the crew is stuck somewhere not home).
2. **Travel day that does touch home and lacks shift/flight/hotel** → NOT
   Daily Allowance (it's a travel day, only Travel Allowance applies).
3. **LEAD role**: if mechanic has `LEAD` in ActiveRoles, final Daily
   Allowance is raised to at least 21 per month.

## Travel Allowance — block rule

Travel is awarded **per contiguous transport block**, not per transport day.

- A transport day = any activity with `ActivitySubType = transport`, plus
  passenger-positioning flights (`Designator = P`) — those are also counted
  as transport for this rule.
- A block = a run of consecutive transport days (no gap > 1 day).
- One Travel Allowance per block, awarded the first time in the block that
  a transport touches `crew_nia` (start or end base).
- If the block never touches home, but it's **adjacent to a home DayOff**
  (the day before or after the block), it still earns 1 Travel Allowance.

## Flight Pay

- Only applies to flights whose `Designator` contains a `u` (e.g. `u`, `pu`,
  etc. — any substring match). *[Q: what does "u" denote in the designator?
  Maintenance taxi flight? Please confirm.]*
- BLH threshold for 1-10 vs 10-24 = 10h (600 min).
- BLH is derived from `ActualStart` / `ActualEnd` UTC difference; segments
  crossing midnight are split so per-day BLH totals are UTC-day-scoped.

## Special roles → automatic charges

| RAIDO ActiveRole | Effect |
|---|---|
| `SFO` (Shift Foreman) | Shift Foreman = 1 per month |
| `LEAD` (Lead Technician) | Lead Technician = 1 per month + Daily Allowance floored at 21 |

## Open questions

1. **Overtime** for mechanics is stubbed to 0. What's the real rule?
2. **B2 Allowance** — what is B2? Just want a short description for the spec.
3. **Base Rep** — is this a flat monthly stipend, or does it multiply by days
   on base? Current code emits 0/1 only.
4. **Designator semantics** — `u`, `mxld`, `mxsf`, `mxbo1/2`, `ecd` — please
   confirm these are the correct RAIDO designators for mechanics.
5. **LEAD minimum of 21 days** — hardcoded. Is this a fixed AAI rule or does
   it differ per contract?
