-- Every recent post of the account, not only campaign posts, so the API can serve
-- them to other tools. Filled by the Cron's hourly listing; numbers as before.
ALTER TABLE media_stats ADD COLUMN posted_at INTEGER;
ALTER TABLE media_stats ADD COLUMN caption TEXT;
ALTER TABLE media_stats ADD COLUMN permalink TEXT;
ALTER TABLE media_stats ADD COLUMN media_type TEXT;
ALTER TABLE media_stats ADD COLUMN thumbnail_url TEXT;
ALTER TABLE media_stats ADD COLUMN listed_at INTEGER;   -- last seen in the account's post list
CREATE INDEX media_stats_posted ON media_stats (posted_at);
