-- On 2026-11-27 Meta blocked every call from the app for a while (code 200, subcode 5258005).
-- Until OwnChats recognised that block, each refused read was stored as "missing permission",
-- and a post keeps its note until its next good read, up to a day for a post past 30 days.
-- OwnChats can't tell those notes from a real missing permission, so every post and day still
-- carrying one is read again from the next Cron run: a block's note clears, a real missing
-- permission is simply stored again. Since then a block's end makes the same catch-up itself.
UPDATE media_stats SET fetched_at = 0 WHERE problem = 'missing permission';
UPDATE account_days SET fetched_at = 0 WHERE problem = 'missing permission';
