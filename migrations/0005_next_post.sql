-- A campaign can wait for the next post instead of naming one. While it waits this
-- holds the time it started waiting (Unix ms) and media_id is empty; the Cron then
-- attaches it to the first post published after that time and clears this.
ALTER TABLE campaigns ADD COLUMN next_post_after INTEGER;
