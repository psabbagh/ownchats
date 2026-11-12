-- Link plus optional email: the label of a button under the thank-you that opens
-- the privacy page. Empty: no button, as before for campaigns that already exist.

ALTER TABLE campaigns ADD COLUMN optional_thanks_button TEXT NOT NULL DEFAULT '';
