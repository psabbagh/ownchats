-- Three email modes per campaign, up to three links, and every outgoing text editable.

-- none: link only | optional: link plus an optional email ask | first: email before the link
ALTER TABLE campaigns ADD COLUMN email_mode TEXT NOT NULL DEFAULT 'none';
UPDATE campaigns SET email_mode = 'first' WHERE ask_email = 1;
ALTER TABLE campaigns DROP COLUMN ask_email;

-- [{"label": "...", "url": "..."}], one to three. Labels make buttons; without labels the links go in the text.
ALTER TABLE campaigns ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
UPDATE campaigns SET links = json_array(json_object('label', link_button, 'url', link_url));
ALTER TABLE campaigns DROP COLUMN link_button;
ALTER TABLE campaigns DROP COLUMN link_url;

ALTER TABLE campaigns ADD COLUMN email_thanks TEXT NOT NULL DEFAULT '';    -- email first: text with the link once the email is saved
ALTER TABLE campaigns ADD COLUMN optional_prompt TEXT NOT NULL DEFAULT ''; -- optional: the line added under the link
ALTER TABLE campaigns ADD COLUMN optional_thanks TEXT NOT NULL DEFAULT ''; -- optional: the reply once the email is saved
ALTER TABLE campaigns ADD COLUMN consent_text TEXT NOT NULL DEFAULT '';    -- saved with each lead; empty: the question they answered

-- The person's Instagram name, when Meta shares it, for {name}.
ALTER TABLE conversations ADD COLUMN name TEXT;
