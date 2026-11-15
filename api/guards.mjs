/**
 * Who may launch, and how fast. Ported from TAG's guards.ts.
 *
 * Every launch is paid by the platform's launch wallet (~0.025 SOL), so these bound what PUMP FUND spends and how the
 * @PumpFund account behaves. Personal rules (followers, age, per-account cooldown) REFUSE. Capacity rules (launching
 * closed, hourly ceiling, spacing, the first-week ramp) DEFER: the request waits in the queue, it is not thrown away.
 *
 * ⭐ The first-week ramp exists because TAG's first account was suspended after 35 launches in 4 hours with every
 * configured limit respected: it died of PATTERN (a new account posting a burst of link replies), not of rule-breaking.
 * It can only ever make the bot quieter.
 */
import { now, launchingOpen } from './db.mjs'

const HOUR = 3600, DAY = 86400
const list = (v) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/^[@$]/, '')).filter(Boolean)

export function guardConfig(env = process.env) {
  return {
    minFollowers: Number(env.MIN_FOLLOWERS ?? 25),
    minAccountAgeDays: Number(env.MIN_ACCOUNT_AGE_DAYS ?? 14),
    perAuthorCooldownSeconds: Number(env.PER_AUTHOR_COOLDOWN_SECONDS ?? 0), // operator 15 Nov: launch as many times as they want (was 30 min)
    perAuthorDailyLimit: Number(env.PER_AUTHOR_DAILY_LIMIT ?? 0), // operator 11 Nov: no daily cap (0 = unlimited)
    // operator 11 Nov: NO global cap, no spacing, no first-week ramp: only one launch per account per 30 minutes.
    // (still available by env: GLOBAL_HOURLY_LIMIT > 0, MIN_SPACING_SECONDS, LAUNCH_RAMP=1)
    globalHourlyLimit: Number(env.GLOBAL_HOURLY_LIMIT ?? 0) > 0 ? Number(env.GLOBAL_HOURLY_LIMIT) : Infinity,
    minSpacingSeconds: Number(env.MIN_SPACING_SECONDS ?? 0),
    rampEnabled: env.LAUNCH_RAMP === '1',
    blocklist: list(env.BLOCKLIST),
    exempt: list(env.GUARD_EXEMPT),
    blockedSymbols: list(env.BLOCKED_SYMBOLS).map((s) => s.toUpperCase()),
    // operator 11 Nov: a cashtag can be launched once per 24 hours (0 = off)
    tickerHoldSeconds: Number(env.TICKER_HOLD_SECONDS ?? 86400),
  }
}

const RAMP = [
  { fromHours: 0, hourly: 4, spacing: 300 },
  { fromHours: 24, hourly: 8, spacing: 180 },
  { fromHours: 72, hourly: 15, spacing: 90 },
  { fromHours: 168, hourly: Infinity, spacing: 0 },
]

/** Launches made by the bot (the platform token is not one). */
const launchedSince = (db, t) => db.prepare("SELECT count(*) n FROM mentions WHERE state = 'launched' AND launched_at > ?").get(t).n

export function rampFor(db, g, at = now()) {
  const configured = { hourly: g.globalHourlyLimit, spacing: g.minSpacingSeconds }
  if (!g.rampEnabled) return configured
  const first = db.prepare("SELECT MIN(launched_at) t FROM mentions WHERE state = 'launched'").get().t
  const ageHours = first == null ? 0 : (at - first) / HOUR
  let step = RAMP[0]
  for (const r of RAMP) if (ageHours >= r.fromHours) step = r
  return { hourly: Math.min(configured.hourly, step.hourly), spacing: Math.max(configured.spacing, step.spacing) }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * @param subject { authorId, authorHandle, authorFollowers, authorCreatedAt (unix seconds or null), symbol }
 * @returns { allowed: true } | { allowed: false, code, reason, defer?: true, retryAfter?: seconds }
 */
export function checkGuards(db, g, s, at = now()) {
  const handle = s.authorHandle.toLowerCase()
  if (g.blocklist.includes(handle)) return { allowed: false, code: 'blocklisted', reason: 'This account cannot launch tokens here.' }
  if (g.blockedSymbols.includes(s.symbol.toUpperCase())) return { allowed: false, code: 'blocked-symbol', reason: `$${s.symbol} is not available to launch.` }
  // ⭐ cashtag protection (operator 11 Nov): a cashtag launched by anyone cannot be launched again for 24 hours.
  // Binds everyone, exempt accounts too: it protects the token that holds the cashtag, not a rate.
  // ⭐ the operator can let ONE post past this rule (api/requeue.mjs <tweet id> --allow-taken-ticker, 12 Nov)
  if (g.tickerHoldSeconds > 0 && !s.tickerOverride) {
    const prev = db.prepare('SELECT MAX(created_at) t FROM tokens WHERE upper(symbol) = ? AND created_at > ?').get(s.symbol.toUpperCase(), at - g.tickerHoldSeconds).t
    if (prev != null) {
      const hours = Math.max(1, Math.ceil((g.tickerHoldSeconds - (at - prev)) / 3600))
      return { allowed: false, code: 'ticker-taken', reason: `$${s.symbol.toUpperCase()} was launched in the last 24 hours. Pick another ticker, or try again in ${plural(hours, 'hour')}.` }
    }
  }
  const exempt = g.exempt.includes(handle)
  if (!exempt) {
    const last = db.prepare("SELECT MAX(launched_at) t FROM mentions WHERE author_id = ? AND state = 'launched'").get(String(s.authorId)).t
    if (last != null && at - last < g.perAuthorCooldownSeconds) {
      return { allowed: false, code: 'cooldown', reason: `You can launch one token every ${Math.round(g.perAuthorCooldownSeconds / 60)} minutes. Try again in ${plural(Math.ceil((g.perAuthorCooldownSeconds - (at - last)) / 60), 'minute')}.` }
    }
    const today = db.prepare("SELECT count(*) n FROM mentions WHERE author_id = ? AND state = 'launched' AND launched_at > ?").get(String(s.authorId), at - DAY).n
    if (g.perAuthorDailyLimit > 0 && today >= g.perAuthorDailyLimit) return { allowed: false, code: 'author-daily-limit', reason: `You can launch ${plural(g.perAuthorDailyLimit, 'token')} a day. Try again tomorrow.` }
    // ⭐ a wallet launcher (operator 14 Nov) pays for its launch: there is no X profile to measure, and the cost is the gate
    const walletAuthor = !/^\d+$/.test(String(s.authorId))
    if (!walletAuthor && (s.authorFollowers ?? 0) < g.minFollowers) return { allowed: false, code: 'too-few-followers', reason: `An account needs at least ${plural(g.minFollowers, 'follower')} to launch a token.` }
    // A missing creation date passes: the follower minimum already catches new, empty accounts.
    if (!walletAuthor && s.authorCreatedAt && (at - s.authorCreatedAt) / DAY < g.minAccountAgeDays) {
      return { allowed: false, code: 'account-too-new', reason: `An account needs to be at least ${plural(g.minAccountAgeDays, 'day')} old to launch a token.` }
    }
  }
  // Capacity: defer, never refuse. Binds exempt accounts too (it is about what the bot spends, not who asks).
  if (!launchingOpen(db)) return { allowed: false, code: 'launching-closed', defer: true, reason: 'launching opens shortly, and this is queued until it does' }
  const ramp = rampFor(db, g, at)
  if (launchedSince(db, at - HOUR) >= ramp.hourly) return { allowed: false, code: 'hourly-limit', defer: true, retryAfter: 60, reason: 'queued: the hourly ceiling is reached' }
  const lastAny = db.prepare("SELECT MAX(launched_at) t FROM mentions WHERE state = 'launched'").get().t
  if (lastAny != null && at - lastAny < ramp.spacing) return { allowed: false, code: 'spacing', defer: true, retryAfter: ramp.spacing - (at - lastAny), reason: 'queued behind the launch just before it' }
  return { allowed: true }
}
