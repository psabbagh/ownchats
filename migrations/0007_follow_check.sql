-- The follow check: after the tap, ask Meta whether the person follows the account,
-- and ask them to follow first if they don't. Off unless a campaign switches it on.
-- Numbered 0007 so it never clashes with 0006 on the lead webhook branch.

ALTER TABLE campaigns ADD COLUMN follow_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN follow_prompt TEXT NOT NULL DEFAULT 'Almost there, {name}! Follow me first, then tap the button and I''ll send it over.';
ALTER TABLE campaigns ADD COLUMN follow_reask TEXT NOT NULL DEFAULT 'I can''t see your follow yet. It can take a moment to show up. Follow me, then tap the button again.';
ALTER TABLE campaigns ADD COLUMN follow_button TEXT NOT NULL DEFAULT 'I''m following';

-- Per conversation: how many times the person was asked to follow (0, 1 or 2), and
-- whether they followed at the last check (1 or 0; NULL while never checked, or when
-- Meta's answer was missing).
ALTER TABLE conversations ADD COLUMN follow_asked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN follows INTEGER;
