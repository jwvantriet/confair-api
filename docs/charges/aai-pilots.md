# AAI Pilots — Charge Rules

Extracted from the legacy Anvil module (`aai-anvil-rules.py`). Source of truth
for porting to the confair-api charge engine. Anything ambiguous here is
flagged — confirm before implementing.

## Inputs

- RAIDO roster for the crew in the payroll period (with a 35-day lookback for
  BLH rotation context).
- `Crew` object from RAIDO: `Base` / `Bases[]` → `crew_nia`, `DateOfEmployment`
  → `years_since_start`, `SpecialRoles` → `ActiveRoles`.
- Carerix: placement rate per charge type (amount × qty = charge).

## Per-day bucketing

A detail row for each activity (flight / shift / transport / hotel / off / etc.)
gets grouped by `(crew_id, calendar_day)` in UTC. Each day produces one row in
the summary with the counts below.

## Charge types

| Charge type | Unit | Computation per day |
|---|---|---|
| **DailyAllowance** | 1 per qualifying day | See `daily_allowance` rules below. |
| **Availability Premium** | 1 per qualifying day | Mirrors DailyAllowance, with zeroing rules below. |
| **Years with Client** | 1 per qualifying day | Count day only if `years_since_start > 5` (from Carerix `DateOfEmployment`). |
| **PerDiem** | 1 per qualifying day | Equal to DailyAllowance, minus 1 on any day that has a `PXP` activity code (floored at 0). |
| **GroundFee** | 1 per day | Any activity with `Designator = GRNAW` on that day. |
| **SimFee** | 1 per day | Any activity with `Designator = SIMAW` on that day. |
| **SoldOffDay** | 1 per day | Any activity with `ActivityCode = HRD` on that day. |
| **BODDays** | 1 per day | Any activity with `ActivityCode = BOD` on that day. |
| **totalFlightHoursOvertimeDecimal** | hours (2dp) | BLH above 65h per rotation. See BLH section. |

## DailyAllowance — payable-day gate

A day counts for DailyAllowance iff **none of the following** are true:

1. Day has a `GRNAW` or `SIMAW` designator (→ only GroundFee / SimFee, no allowance).
2. Day's activities are **all `CBT`** and all start at the crew's home base (`crew_nia`). "CBT at home" is training at base — no allowance.
3. Day's activities are **all `CNV`**. Not payable.
4. Every activity on the day is an OFF subtype (DayOff / Vacation / Vac) **and** none of them is a `PXP` code.
5. Every activity is `CBO`.
6. Only "illness" at the crew's home base (illness away from home does count).

Otherwise, DailyAllowance = 1 for that day. Notable inclusions:

- Illness **away from home base** counts as a payable day.
- `PXP` on an otherwise-OFF day counts (PXP overrides the OFF gate).

## Availability Premium — mirrors DailyAllowance, then zeroed if…

Starts equal to DailyAllowance, then forced to 0 when **any** of:

- Any activity on the day carries `Designator = WW`.
- At crew summary level: `ActiveRoles` is empty **or** exactly `WW`, **except**
  for a hardcoded allowlist of crew IDs — `ADOE`, `MIOD`, `RDVT` — who get the
  premium even with empty roles. *[Q: is the allowlist still current? needs
  verification.]*

## PerDiem

- Equal to DailyAllowance for the day.
- Subtract 1 if the day has a `PXP` code (floored at 0). Rationale: PXP means
  the client is already feeding the crew that day.

## Ground / Sim days exclude everything else

On a day with `GRNAW` or `SIMAW`, the crew earns only GroundFee (or SimFee).
All other charges are **forced to 0** at crew-summary level. Specifically, if
either GroundFee or SimFee > 0 anywhere in the period, the crew's
DailyAllowance / AvailabilityPremium / YearsWithClient / PerDiem / SoldOffDay
/ BODDays totals are wiped to 0 for that crew. *[Q: is this period-wide wipe
intentional or was it a simplification — should it be per-day only?]*

## BLH / Overtime / Rotation boundaries

A "rotation" is the time window between two boundary events for a pilot. BLH
minutes accumulate inside the window. If the total exceeds **65h (3 900 min)**
at close, the excess = overtime.

### Window opens when…

- A duty boundary `Start` is hit on a **flight / transport / shift** activity.
- Or an implicit start: a FLIGHT activity appears with no window open.

### Window closes when…

1. A pilot duty end code is hit. End code set:
   ```
   20-10, 21-14, 21-21, 24-12, 24-6, 28-21,
   EML, RLO, RLOF, RLOW, MVTD, PXP, ULV, VAU, WFL, CNV
   ```
   Close-time = end of the **previous** activity (end code row itself is not
   included in the window hours).
2. A **home-base DayOff** — labelled `(Unpaid Day)` in the output. Close-time
   = start of the DayOff.
3. **30-day cap** — the window is hard-closed at midnight UTC of `start + 30d`.
   Output row labelled `(30 DayCap)`. If the next day is not a home DayOff, a
   new window auto-reopens at that midnight.

### Output row

Only emitted when overtime_minutes > 0 and the close falls inside the payroll
period.

| Field | Meaning |
|---|---|
| totalFlightHours | HH:MM (total BLH accumulated in the window) |
| totalFlightHoursDecimal | same, as decimal hours, 2dp |
| totalFlightHoursOvertime | HH:MM above 65h |
| totalFlightHoursOvertimeDecimal | same, decimal 2dp |
| start_period / end_period | compact UTC timestamps |

## Flight BLH source

BLH per flight segment = derived from `ActualStart` / `ActualEnd` in the
roster Activity's `Times` array (TimeOut objects). Fallback: `Start` / `End`
fields on the activity.

Segments crossing UTC midnight are split so BLH is billed against the day
the flight actually closes; split points are 23:59:59 → 00:00:01.

Suppressions:

- If the day also contains an `EMVT` (emergency repositioning) on the same
  flight day, the BLH is cleared to empty (not billed as revenue BLH).
- `Designator = P` (passenger) → BLH cleared.

## Open questions / ambiguities

1. **Premium allowlist**: `ADOE / MIOD / RDVT` hardcoded exceptions for empty
   ActiveRoles. Is this still correct or should it move to a config field?
2. **Ground/Sim period-wipe**: any day's GroundFee / SimFee wipes the whole
   period's allowance / years / per-diem for that crew. Intentional?
3. **"years_since > 5"** → strictly `>`, i.e. the 6th anniversary. Agreed with
   the earlier YWC discussion ("5 years or more with the client") — note the
   strict-greater convention.
4. **`SoldOffDay`** counts `HRD` but the label says "Sold Off Day". Confirm
   `HRD` is the correct activity code.
5. **End code boundary semantics**: rotation closes at the *previous*
   activity's end time, excluding the end code itself. Confirmed by code;
   confirm matches your process.
