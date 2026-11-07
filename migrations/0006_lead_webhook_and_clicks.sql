-- The lead webhook, a per-campaign email tag, and link click counting.

-- Optional free text per campaign, sent to the lead webhook as campaign.email_tag so the
-- owner's email tool can start the right sequence. Empty: sent as null.
ALTER TABLE campaigns ADD COLUMN email_tag TEXT NOT NULL DEFAULT '';

-- One row per event sent to the lead webhook, kept while it is retried.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,                      -- the delivery id, the same on every retry
  event TEXT NOT NULL,                      -- lead.created | lead.deleted
  payload TEXT NOT NULL,                    -- the event's fields as JSON; emptied once delivered or given up
  test INTEGER NOT NULL DEFAULT 0,          -- 1: sent with "Send a test lead"
  campaign_id INTEGER,
  ig_user_id TEXT,                          -- whose lead it carries, so deleting the person cancels it
  username TEXT,
  status TEXT NOT NULL,                     -- pending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,                  -- while pending: when the next attempt is due
  last_result TEXT,                         -- the last attempt in words: "HTTP 200", "timed out after 10 seconds"
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX deliveries_due ON deliveries (status, next_attempt_at);
CREATE INDEX deliveries_time ON deliveries (created_at);

-- Link click counting: campaign links go out as /go/<id>, one random id per
-- conversation and link. The URL carries nothing else.
CREATE TABLE tracked_links (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER,                  -- NULL once its campaign is deleted: the link still works and counts nowhere
  campaign_id INTEGER NOT NULL,
  link_index INTEGER NOT NULL,              -- which of the campaign's links, from 0
  url TEXT NOT NULL,                        -- where it leads
  first_clicked_at INTEGER,                 -- the person's first click; previews and HEAD requests don't count
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, link_index)
);
CREATE INDEX tracked_links_campaign ON tracked_links (campaign_id, first_clicked_at);
