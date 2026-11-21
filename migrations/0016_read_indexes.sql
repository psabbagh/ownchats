-- Indexes for the queries that read the most rows. D1 on the Workers Free plan allows
-- 5 million rows read a day per account, and each of these queries scanned a whole
-- table, or a campaign's whole activity log, every time it ran.

-- A person's sends and refusals on a campaign: who Meta refused and whether a later
-- send reached them (refused.ts), and the failure counts per campaign (stats.ts).
CREATE INDEX activity_outcome ON activity (outcome, campaign_id, ig_user_id, kind, at);

-- Conversations with a message waiting to be sent again: few at any time, read every
-- minute by the alerts (refusedSends).
CREATE INDEX conversations_waiting ON conversations (id) WHERE pending_message IS NOT NULL;

-- Skipped comments by why and when, for To check (missed.ts).
CREATE INDEX comments_reason ON comments (status, reason, commented_at);

-- Whether someone who commented already has a conversation, by the id on their comment.
CREATE INDEX conversations_commenter ON conversations (commenter_id);
