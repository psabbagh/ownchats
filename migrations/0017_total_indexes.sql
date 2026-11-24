-- Covering indexes for the campaign totals (the dashboard, the Results page, GET /api/campaigns
-- and GET /api/stats). Each total still reads one index entry per row it counts, but no longer
-- reads the table row behind it, nor rows it doesn't count.

-- People, first DMs, links sent and answered by hand per campaign. Before, SQLite walked the
-- (campaign_id, commenter_id) index and fetched every conversation from the table: two rows read
-- per conversation.
CREATE INDEX conversations_totals ON conversations (campaign_id, first_sent_at, answered_by_hand_at, state);

-- Taps and the people who tapped, per campaign. Before, the search went through every received
-- activity row (taps and DMs), by activity_outcome.
CREATE INDEX activity_taps ON activity (kind, outcome, campaign_id, ig_user_id);

-- People who clicked a link, per campaign: only the clicked links, already in the order the
-- distinct count needs.
CREATE INDEX tracked_links_clicked ON tracked_links (campaign_id, conversation_id)
  WHERE first_clicked_at IS NOT NULL AND conversation_id IS NOT NULL;
