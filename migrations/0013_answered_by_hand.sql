-- The owner answered someone by hand after Instagram refused OwnChats' send (decision of 2026-11-21).
-- Set on the conversation: one is created for a first DM that never went out, so the
-- person counts as answered and a later comment gets no second DM.
ALTER TABLE conversations ADD COLUMN answered_by_hand_at INTEGER;
-- Set on the comment whose first DM never went out, so it leaves To check.
ALTER TABLE comments ADD COLUMN answered_by_hand_at INTEGER;
