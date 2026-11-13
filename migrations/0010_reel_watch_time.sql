-- Two numbers Meta gives only for Reels, each read in a request of its own so a
-- refusal never costs the post's other numbers. NULL until read, and for every
-- other post type. A failed or refused read keeps the last number.
ALTER TABLE media_stats ADD COLUMN avg_watch_time_ms INTEGER;  -- ig_reels_avg_watch_time, milliseconds
ALTER TABLE media_stats ADD COLUMN skip_rate_percent REAL;     -- reels_skip_rate: share of initial views skipped in the first 3 seconds, 0 to 100
