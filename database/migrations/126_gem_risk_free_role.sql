-- GEM strategy: separate the absolute-momentum benchmark from the safe asset.
--
-- Dual momentum measures equities against a risk-free rate -- T-bills in
-- Antonacci's rules -- but a RISK-OFF period is spent in an aggregate bond
-- fund, not in T-bills. Until now a single `SAFE` role played both parts, so a
-- strategy could either use the right yardstick or hold the right instrument,
-- never both.
--
-- The new `RISK_FREE` role is the yardstick; `SAFE` keeps its meaning as what
-- the portfolio holds while RISK-OFF. `RISK_FREE` is optional: when no
-- instrument is assigned to it the absolute test falls back to `SAFE`, so every
-- existing configuration evaluates exactly as it did before this migration.
--
-- `benchmark_role` records which of the two a stored evaluation actually used,
-- so history stays honest after a user assigns a dedicated risk-free
-- instrument. Rows evaluated before the split are left NULL and read as `SAFE`.
--
-- Roles are plain VARCHAR with no CHECK constraint, so the new value needs no
-- constraint change -- only the recorded benchmark is new.

ALTER TABLE gem_strategy_signals
    ADD COLUMN IF NOT EXISTS benchmark_role VARCHAR(20);

COMMENT ON COLUMN gem_strategy_signals.benchmark_role IS
    'Role the absolute-momentum test compared US equities against; NULL means SAFE (pre-split rows)';
