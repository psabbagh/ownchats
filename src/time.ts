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

export function iso(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString() : "";
}
