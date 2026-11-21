-- When a campaign was last turned on or off (Unix ms), so the campaigns page can say
-- "Off since". NULL for campaigns switched before this column: updated_at can't stand
-- in for it, since any edit changes it.
ALTER TABLE campaigns ADD COLUMN active_changed_at INTEGER;
