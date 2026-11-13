-- Reposts, for every post type: asked with the post's other numbers. NULL until read.
ALTER TABLE media_stats ADD COLUMN reposts INTEGER;

-- The account's numbers for each of Meta's days, which run midnight to midnight
-- Pacific time. Meta fills a day in over 48 hours, so recent days are read again.
-- A number Meta has not given yet stays NULL.
CREATE TABLE account_days (
  day TEXT PRIMARY KEY,                     -- YYYY-MM-DD, Meta's day (Pacific time)
  reach INTEGER,                            -- accounts reached that day
  reach_followers INTEGER,                  -- reach by follow_type: FOLLOWER
  reach_non_followers INTEGER,              -- NON_FOLLOWER
  reach_unknown INTEGER,                    -- UNKNOWN
  follows INTEGER,                          -- follows_and_unfollows by follow_type: FOLLOWER
  unfollows INTEGER,                        -- NON_FOLLOWER: unfollowed or left Instagram
  fetched_at INTEGER NOT NULL,              -- last attempt
  updated_at INTEGER,                       -- last successful read
  problem TEXT                              -- why the last attempt failed, NULL when it worked
);
