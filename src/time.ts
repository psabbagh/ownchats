export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Meta allows one private reply per comment, within 7 days of the comment. */
export const PRIVATE_REPLY_WINDOW = 7 * DAY;
/** Meta allows further messages only within 24 hours of the person's last message or tap. */
export const MESSAGING_WINDOW = DAY;
/** Meta's limit is 750 private replies an hour; stay under it. */
export const PRIVATE_REPLIES_PER_HOUR = 700;

/** For the API, the CSV and the database: always UTC, so other tools never guess a zone. */
export function iso(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString() : "";
}

/** Whether Intl knows this IANA time zone name ("America/Toronto"). */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone the pages show times in: the owner's choice in Settings, UTC until they make one. */
export function timeZoneOf(settings: { time_zone?: string }): string {
  const tz = settings.time_zone;
  return tz && isTimeZone(tz) ? tz : "UTC";
}
