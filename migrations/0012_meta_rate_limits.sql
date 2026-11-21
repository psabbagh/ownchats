-- Sends first when Meta's app-level rate limit is near (decision of 2026-11-21).

-- A private reply Meta refused for a passing reason is tried again at this time,
-- spaced out over days inside Meta's 7-day window. NULL: as soon as possible.
ALTER TABLE comments ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE comments ADD COLUMN first_refused_at INTEGER;   -- the retry schedule counts from here
CREATE INDEX comments_retry ON comments (status, next_attempt_at);

-- A message after a tap or a reply that Meta refused for a passing reason: what was
-- due, kept so the Cron can send it inside Meta's 24-hour window, or the owner
-- can send it from To check. NULL when nothing is waiting.
ALTER TABLE conversations ADD COLUMN pending_message TEXT;   -- JSON of the message, before /go/ links
ALTER TABLE conversations ADD COLUMN pending_state TEXT;     -- the state once it is sent
ALTER TABLE conversations ADD COLUMN pending_reason TEXT;    -- the reason logged once it is sent
ALTER TABLE conversations ADD COLUMN pending_kind TEXT;      -- link | message
ALTER TABLE conversations ADD COLUMN pending_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN pending_at INTEGER;     -- next automatic try; NULL once the Cron gave up
ALTER TABLE conversations ADD COLUMN pending_since INTEGER;  -- first refusal: the retry schedule counts from here
CREATE INDEX conversations_pending ON conversations (pending_at);

-- A Reel's watch time and skip rate are read less often than its other numbers.
ALTER TABLE media_stats ADD COLUMN reel_fetched_at INTEGER;
