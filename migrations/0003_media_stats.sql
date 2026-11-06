-- Instagram's lifetime numbers for each campaign's post, read by the Cron.
-- A metric Meta has no number for stays NULL. On a failed read the old numbers stay.
CREATE TABLE media_stats (
  media_id TEXT PRIMARY KEY,
  views INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saved INTEGER,
  fetched_at INTEGER NOT NULL,              -- last attempt
  updated_at INTEGER,                       -- last successful read
  problem TEXT                              -- why the last attempt failed, NULL when it worked
);
