-- 2026-04-30: Backfill duplicate column pairs in charge_items.
--
-- Background: charge_items has two duplicate "rate" columns
-- (rate_per_unit/rate_amount) and two "total" columns
-- (total_amount/total_value). Different code paths historically wrote to
-- different columns, leaving rows with one populated and the other null.
--
-- This migration mirrors values across both pairs so any read path returns
-- the same number. Going forward, both PRs in this stack write to both
-- pairs. Long-term, a follow-up should pick a canonical pair and drop the
-- other.

update public.charge_items
   set rate_amount  = rate_per_unit
 where rate_amount  is null
   and rate_per_unit is not null;

update public.charge_items
   set rate_per_unit = rate_amount
 where rate_per_unit is null
   and rate_amount   is not null;

update public.charge_items
   set total_value = total_amount
 where total_value is null
   and total_amount is not null;

update public.charge_items
   set total_amount = total_value
 where total_amount is null
   and total_value  is not null;

-- Verify (should return 0)
select count(*) as still_mismatched
from public.charge_items
where (rate_amount is distinct from rate_per_unit)
   or (total_value is distinct from total_amount);
