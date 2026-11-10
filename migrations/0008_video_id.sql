-- The id of the video a campaign is for, in the owner's own numbering (for example
-- SF-14), so their other tools can link the two without reading it out of the name.
-- Empty: none.

ALTER TABLE campaigns ADD COLUMN video_id TEXT NOT NULL DEFAULT '';
