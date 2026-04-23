# Charge rules — specs

Source-of-truth charge rules for each (company, role) we bill, extracted
from the systems currently in production so we can port them into the
confair-api charge engine.

| File | Scope |
|---|---|
| [`aai-pilots.md`](./aai-pilots.md) | Air Atlanta Icelandic / Europe — pilots (+ general "default" pipeline) |
| [`aai-mechanics.md`](./aai-mechanics.md) | Air Atlanta — maintenance crew |
| [`aai-loadmasters.md`](./aai-loadmasters.md) | Air Atlanta — loadmasters |
| [`aai-anvil-rules.py`](./aai-anvil-rules.py) | Reference header from the legacy Anvil module (full body in conversation archive / original paste) |

## Workflow

1. User pastes the authoritative rules (code or spreadsheet) into the
   conversation or a file in this folder.
2. Rules are normalized into a markdown spec here with open-questions flagged.
3. Spec is reviewed with the user, questions resolved, spec marked "locked".
4. Implementation PR references the spec it implements.

## Next

- Confirm / correct open questions in the three AAI specs.
- Design the `company_charge_config` table + admin UI (Phase 2) informed by
  these specs so the eventual shape actually fits.
- Port rules into `src/services/charges/` in confair-api, branching on
  `(company_id, role_group)` from the config table.
