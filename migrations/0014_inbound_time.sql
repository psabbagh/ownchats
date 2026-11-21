-- The "no taps" alert (src/alerts.ts) counts recent taps and replies every minute.
-- Without this index that count would read all 30 days of them each time.
CREATE INDEX inbound_time ON inbound (received_at);
