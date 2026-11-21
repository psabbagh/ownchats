-- Owner alerts (src/alerts.ts) count recent comments by how they arrived every minute.
-- Without this index that count would read the whole 30 days of comments each time.
CREATE INDEX comments_received ON comments (received_at);
