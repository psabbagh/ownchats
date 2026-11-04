import { log, type Ctx } from "./context";
import { explainError } from "./meta/client";
import { saveSettings } from "./settings";
import { DAY } from "./time";

/** Warn this long before the token or its data access expires. */
export const WARN_BEFORE = 7 * DAY;

/**
 * Daily token check. Unified Login gives a system-user token that does not expire
 * when the configuration says "Never", and Meta offers no simple refresh for it.
 * So this reads what Meta reports and records any problem for /setup and the
 * dashboard to show: revoked, expiring within a week, or data access ending.
 */
export async function checkToken(ctx: Ctx): Promise<void> {
  if (!ctx.meta) return;
  const now = ctx.now();
  let problem = "";
  try {
    const info = await ctx.meta.tokenInfo();
    if (!info.valid) problem = "Meta says the token is no longer valid. Reconnect Instagram.";
    else if (info.expiresAt && info.expiresAt - now < WARN_BEFORE) problem = `The token expires on ${new Date(info.expiresAt).toDateString()}. Reconnect Instagram before then.`;
    else if (info.dataAccessExpiresAt && info.dataAccessExpiresAt - now < WARN_BEFORE) problem = `Meta's data access for this token ends on ${new Date(info.dataAccessExpiresAt).toDateString()}. Reconnect Instagram before then.`;
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, {
      token_expires_at: String(info.expiresAt ?? 0),
      token_data_expires_at: String(info.dataAccessExpiresAt ?? 0),
    });
  } catch (err) {
    problem = `Could not check the token: ${explainError(err).reason}.`;
  }
  if (problem && problem !== ctx.settings.token_problem) {
    await log(ctx, { kind: "token", outcome: "failed", reason: problem });
  }
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { token_problem: problem, token_checked_at: String(now) });
  ctx.settings.token_problem = problem;
}
