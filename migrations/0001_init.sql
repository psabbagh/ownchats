-- OwnChats schema, v0. Times are Unix milliseconds.

-- Key-value settings: Meta app values, connection state, health markers.
-- Values marked secret in src/settings.ts are stored encrypted.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',      -- JSON array; the first one is the main keyword
  any_comment INTEGER NOT NULL DEFAULT 0,   -- 1: answer every comment, ignore keywords
  media_id TEXT,                            -- NULL: all posts
  media_label TEXT,                         -- caption snippet shown in the dashboard
  public_replies TEXT NOT NULL DEFAULT '[]', -- JSON array of variants, used in turn
  reply_cursor INTEGER NOT NULL DEFAULT 0,
  opening_text TEXT NOT NULL DEFAULT '',
  opening_button TEXT NOT NULL DEFAULT '',  -- empty: no opening button
  ask_email INTEGER NOT NULL DEFAULT 0,
  email_prompt TEXT NOT NULL DEFAULT '',
  email_reask TEXT NOT NULL DEFAULT '',
  link_text TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL,
  link_button TEXT NOT NULL DEFAULT '',     -- empty: the link goes in the text
  dm_keyword INTEGER NOT NULL DEFAULT 1,    -- 1: the keyword also works by DM
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every comment seen once, by webhook or poll. The primary key is the dedupe.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  parent_id TEXT,
  from_id TEXT,
  from_username TEXT,
  text TEXT NOT NULL DEFAULT '',
  commented_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source TEXT NOT NULL,                     -- webhook | poll
  status TEXT NOT NULL,                     -- new | processing | queued | done | skipped | failed
  reason TEXT,
  campaign_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at INTEGER
);
CREATE INDEX comments_status ON comments (status, received_at);

-- One row per person and campaign: the DM state machine, and the
-- "one DM per person per campaign" rule.
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  ig_user_id TEXT NOT NULL,                 -- the person's messaging id (IGSID): taps and DMs come from it
  commenter_id TEXT,                        -- the id on their comment, when the trigger was a comment
  username TEXT,
  trigger TEXT NOT NULL,                    -- comment | dm
  comment_id TEXT,
  state TEXT NOT NULL,                      -- opened | awaiting_email | reasked | done
  first_sent_at INTEGER,                    -- NULL until the first DM went out
  last_inbound_at INTEGER,                  -- last tap or message from the person
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (campaign_id, ig_user_id),
  UNIQUE (campaign_id, commenter_id)
);
CREATE INDEX conversations_person ON conversations (ig_user_id, updated_at);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  ig_user_id TEXT NOT NULL,
  username TEXT,
  email TEXT NOT NULL,
  consent_text TEXT NOT NULL,               -- the wording the person saw
  consented_at INTEGER NOT NULL,
  UNIQUE (campaign_id, ig_user_id)
);
CREATE INDEX leads_time ON leads (consented_at);

-- Incoming DM and tap ids already handled, so a redelivered webhook does nothing.
CREATE TABLE inbound (
  mid TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- What happened and why: one row per decision.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- comment | private_reply | public_reply | tap | message | email | link | token | webhook
  outcome TEXT NOT NULL,                    -- sent | saved | received | skipped | failed | queued
  reason TEXT,
  campaign_id INTEGER,
  comment_id TEXT,
  ig_user_id TEXT,
  username TEXT,
  detail TEXT
);
CREATE INDEX activity_time ON activity (at);
CREATE INDEX activity_kind ON activity (kind, outcome, at);
CREATE INDEX activity_campaign ON activity (campaign_id, at);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX login_attempts_ip ON login_attempts (ip, at);
