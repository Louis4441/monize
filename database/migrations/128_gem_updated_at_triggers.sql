-- The GEM tables declare updated_at but nothing was keeping it.
--
-- Every other table with the column has an `update_..._updated_at` trigger, and
-- TypeORM's @UpdateDateColumn is not a substitute: it only stamps rows the ORM
-- itself writes. A direct UPDATE -- a migration, a support fix, a restore --
-- leaves the timestamp at whatever it was, and the GUC-aware trigger is also
-- what `withPreserveTimestamps` steers during a backup restore, so without the
-- trigger there is nothing there to steer.
--
-- gem_strategy_accounts and gem_strategy_signals have no updated_at: the first
-- is a join row that is inserted and deleted rather than edited, the second is
-- an immutable record of one evaluation (its `executed_at` is the event time,
-- not a row-touched time). Neither takes a trigger.

DROP TRIGGER IF EXISTS update_gem_strategies_updated_at ON gem_strategies;
CREATE TRIGGER update_gem_strategies_updated_at
  BEFORE UPDATE ON gem_strategies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_gem_strategy_assets_updated_at ON gem_strategy_assets;
CREATE TRIGGER update_gem_strategy_assets_updated_at
  BEFORE UPDATE ON gem_strategy_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
