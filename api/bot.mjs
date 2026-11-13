/**
 * The @PumpFund loop: read mentions → queue launch requests → launch one at a time → reply.
 *
 *   poll      reads mentions since the newest seen (minus a 2-minute overlap); a KNOWN tweet id is skipped before
 *             anything billable is done for it (memory twitterapi-poller-drains-balance)
 *   queue     the oldest queued request whose wait is over passes the guards (api/guards.mjs), is CLAIMED with a
 *             conditional UPDATE, then launched (api/launch.mjs)
 *   recover   a request left 'launching' (crash, or the chain had not answered) is settled from the chain's answer
 *   reply     one reply per pass, at least REPLY_SPACING seconds apart: a burst of link replies is what gets an account
 *             flagged (TAG's first account)
 *
 * The platform launch: the operator posts from the platform account (PLATFORM_X_ID) naming PROJECT_TICKER while
 * launching is closed. That one request skips the guards, and its landing opens launching for everyone (recordLaunch).
 */
import { PublicKey } from '@solana/web3.js'
import { now, kvGet, kvSet, launchingOpen, upsertUser, DEFAULT_MODE } from './db.mjs'
import { parseTweet, isLaunchRequest } from './parse.mjs'
import { checkGuards } from './guards.mjs'
import { launchMention, settleAttempt, fateOf, MAX_ATTEMPTS } from './launch.mjs'
import { feeWallet } from './feewallet.mjs'
import { launchedReply, rejectedReply, failedReply, cleanReply } from './replies.mjs'
import { botReason } from './botfilter.mjs'
import { resolvePair } from './pairs.mjs'
import { resolveFloatPair } from './floatpairs.mjs'
import { floatTickerTaken } from '../lib/float.mjs'

/** Refusals worth answering: a real person made a fixable mistake, or hit the daily limit. Everything else is silent. */
export const REPLY_TO_REFUSALS = new Set(['for-unknown', 'for-lookup-failed', 'bad-ticker', 'name-too-long', 'cooldown', 'author-daily-limit', 'blocked-symbol', 'ticker-taken', 'float-ticker-taken', 'bad-pair'])

const OVERLAP = 120

export function createBot({ db, conn, pump, x, launcher, platformLauncher = null, seed, guards, env = process.env, publicUrl, logoDir = './data/logos', lookupTables = [], pin, log = console }) {
  const handle = env.X_HANDLE ?? 'PumpFund'
  const platformXId = env.PLATFORM_X_ID ?? ''
  const projectTicker = String(env.PROJECT_TICKER ?? '').replace(/^\$/, '').toUpperCase()
  const replySpacing = Number(env.REPLY_SPACING_SECONDS ?? 20)
  const repliesOn = env.REPLIES !== '0'

  // ⛔ ONE platform launch, ever: none recorded AND none already queued/in flight (a second $CASHTAG post before the
  // first lands would otherwise also launch from the operator's wallet)
  const isPlatformRequest = (m, symbol) =>
    !!platformXId && m.authorId === platformXId && !!projectTicker && symbol === projectTicker && !kvGet(db, 'platform_mint') &&
    !db.prepare("SELECT 1 FROM mentions WHERE platform = 1 AND state IN ('queued', 'launching', 'launched')").get()

  async function poll() {
    const last = Number(kvGet(db, 'last_mention_at') ?? 0)
    const since = last ? last - OVERLAP : now() - 600
    const list = await x.fetchMentions(since)
    const newest = list.reduce((n, m) => Math.max(n, m.createdAt), last)
    const added = ingest(list)
    if (newest > last) kvSet(db, 'last_mention_at', newest)
    const out = { read: list.length, added }
    try { const w = await watchPlatformReply(); if (w) out.platformWatch = w } catch (e) { log.error?.(`platform watch: ${e.message}`) }
    return out
  }

  const platformPending = () => !!platformXId && !!projectTicker && !kvGet(db, 'platform_mint') &&
    !db.prepare("SELECT 1 FROM mentions WHERE platform = 1 AND state IN ('queued', 'launching', 'launched')").get()

  /**
   * ⭐ Until the platform token exists: the operator's own $CASHTAG reply under PLATFORM_WATCH_TWEET is read straight
   * from that post's replies every 30 s (11 Nov: X's mention search can leave out an account tagging itself, and the
   * account was too new for search or its own timeline to list anything). Only the operator's account counts.
   */
  async function watchPlatformReply() {
    const tid = env.PLATFORM_WATCH_TWEET
    if (!tid || !x.fetchReplies || !platformPending()) return null
    const lastAt = Number(kvGet(db, 'platform_watch_at') ?? 0)
    if (now() - lastAt < Number(env.PLATFORM_WATCH_SECONDS ?? 30)) return null
    kvSet(db, 'platform_watch_at', now())
    const since = Number(kvGet(db, 'platform_watch_since') ?? 0) || now() - 6 * 3600
    const replies = await x.fetchReplies(tid, since - OVERLAP)
    const mine = replies.filter((m) => m.authorId === platformXId)
    const newest = replies.reduce((n, m) => Math.max(n, m.createdAt), since)
    kvSet(db, 'platform_watch_since', newest)
    return mine.length ? { replies: replies.length, mine: mine.length, added: ingest(mine) } : null
  }

  /** The fallback by hand: one post id, read and taken in exactly as a mention would be. */
  async function ingestTweetId(id) {
    const t = await x.fetchTweet(String(id))
    if (!t?.mention) return { error: 'post not found' }
    const added = ingest([t.mention])
    const row = db.prepare('SELECT state, platform, code FROM mentions WHERE tweet_id = ?').get(String(id))
    return { added, row: row ?? null }
  }

  /** Takes in a list of posts (mentions, or the operator's own reply). Returns how many became new rows. */
  function ingest(list) {
    let added = 0
    for (const m of list) {
      if (db.prepare('SELECT 1 FROM mentions WHERE tweet_id = ?').get(m.id)) continue // before anything that can cost
      const parsedForSelf = m.authorId === platformXId ? parseTweet(m.text) : null
      const self = parsedForSelf?.ok && isPlatformRequest(m, parsedForSelf.request.symbol)
      if (!isLaunchRequest(m, handle, { allowSelf: self })) continue
      const bot = self ? null : botReason(m)
      if (bot) {
        // recorded (so it is never re-read or re-billed) but never launched or answered
        db.prepare(`INSERT OR IGNORE INTO mentions (tweet_id, author_id, author_handle, text, url, tweeted_at, seen_at, updated_at, state, code, reason, reply_state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected', 'bot', ?, 'skipped')`).run(m.id, m.authorId, m.authorHandle, m.text, m.url, m.createdAt, now(), now(), bot)
        log.info?.(`ignored @${m.authorHandle} (${m.id}): ${bot}`)
        continue
      }
      upsertUser(db, { id: m.authorId, handle: m.authorHandle, name: m.authorName, avatar: m.authorAvatar, followers: m.authorFollowers, createdAt: m.authorCreatedAt })
      const p = parseTweet(m.text)
      const base = [m.id, m.authorId, m.authorHandle, m.text, m.url, m.createdAt, now(), m.mediaUrl, m.inReplyToId, m.authorFollowers, m.authorCreatedAt, now()]
      if (!p.ok) {
        db.prepare(`INSERT OR IGNORE INTO mentions (tweet_id, author_id, author_handle, text, url, tweeted_at, seen_at, image_url, in_reply_to_id,
          author_followers, author_created_at, updated_at, state, code, reason, reply_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)`)
          .run(...base, p.code, p.message, rejectionReplyState(m.authorId, p.code))
      } else {
        db.prepare(`INSERT OR IGNORE INTO mentions (tweet_id, author_id, author_handle, text, url, tweeted_at, seen_at, image_url, in_reply_to_id,
          author_followers, author_created_at, updated_at, state, symbol, name, mode, platform, quoted_image_url, pair_input, venue, for_handle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(...base, p.request.symbol, self && env.PROJECT_NAME ? String(env.PROJECT_NAME).slice(0, 32) : p.request.name, forTarget(p, m) ? 'creator' : null, self ? 1 : 0, m.quotedMediaUrl ?? null,
            self ? null : p.request.pair ?? null,
            // ⭐ Float (11 Nov): "on Float" / "on Pumpfun" in the post wins, else the account's setting
            self || env.FLOAT_ENABLED === '0' ? 'pump' : p.request.venue ?? db.prepare('SELECT launch_venue FROM users WHERE x_id = ?').get(m.authorId)?.launch_venue ?? 'pump', // mode: the author's site setting decides (operator 10 Nov); the platform token is always SOL-paired
            forTarget(p, m))
      }
      added++
    }
    return added
  }

  /** "for @alice": the handle the coin is for, or null (no target, the author themself, or our own account). */
  function forTarget(p, m) {
    if (!p.ok || p.request.symbol == null || !p.request.forHandle || (m.authorId === platformXId)) return null
    const h = p.request.forHandle
    if (h.toLowerCase() === handle.toLowerCase() || h.toLowerCase() === String(m.authorHandle).toLowerCase()) return null
    return h
  }

  /**
   * Resolves a request's target (for_handle) to X's numeric id, once, before the launch claim. The coin's rewards are
   * keyed on that id for ever, so a guess is never used: an unknown account is refused, a failed lookup waits and retries
   * (an hour of failures refuses it). A new account gets X Money set up for it (payout_auto); one that chose its own
   * payout keeps its choice.
   */
  async function resolveTarget(m) {
    let info
    try { info = await x.userInfo(m.for_handle) } catch (e) {
      if (now() - m.seen_at > 3600) return { reject: 'for-lookup-failed', reason: `@${m.for_handle} could not be looked up on X for an hour. Post again to retry.` }
      return { defer: `looking up @${m.for_handle} failed: ${e.message}` }
    }
    if (!info?.id || !/^[0-9]{1,25}$/.test(info.id)) return { reject: 'for-unknown', reason: `@${m.for_handle} was not found on X. Check the handle and post again.` }
    if (info.id === String(m.author_id)) { db.prepare('UPDATE mentions SET for_handle = NULL, mode = NULL WHERE tweet_id = ?').run(m.tweet_id); return { self: true } }
    if (platformXId && info.id === String(platformXId)) return { reject: 'for-unknown', reason: 'Coins cannot be launched for this account. Pick someone else.' }
    upsertUser(db, { id: info.id, handle: info.handle, name: info.name, avatar: info.avatar, followers: info.followers, createdAt: info.createdAt })
    // ⭐ X Money for an account that never chose: its rewards go to its X Money automatically (operator 12 Nov)
    db.prepare("UPDATE users SET payout_kind = 'xmoney', payout_auto = 1 WHERE x_id = ? AND settings_at IS NULL AND payout_kind = 'claim'").run(info.id)
    db.prepare('UPDATE mentions SET for_id = ?, for_handle = ? WHERE tweet_id = ?').run(info.id, info.handle, m.tweet_id)
    return { id: info.id, handle: info.handle }
  }

  /** Only fixable mistakes and the per-account limits are answered, at most once per account per day; the rest are silent. */
  function rejectionReplyState(authorId, code) {
    if (!REPLY_TO_REFUSALS.has(code)) return 'skipped'
    const recent = db.prepare("SELECT 1 FROM mentions WHERE author_id = ? AND state = 'rejected' AND reply_state IN ('pending', 'sent') AND seen_at > ?").get(String(authorId), now() - 86400)
    return recent ? 'skipped' : 'pending'
  }

  async function recover() {
    const rows = db.prepare("SELECT * FROM mentions WHERE state = 'launching'").all()
    for (const r of rows) {
      if (!r.signature || !r.mint) {
        // Claimed but nothing was sent (a crash before the signature was written): back to the queue.
        db.prepare("UPDATE mentions SET state = 'queued', next_try_at = ?, updated_at = ? WHERE tweet_id = ? AND state = 'launching' AND signature IS NULL").run(now() + 30, now(), r.tweet_id)
        continue
      }
      const f = await fateOf(conn, r.signature, r.last_valid_height)
      const res = await settleAttempt(db, conn, { mention: r, mint: r.mint, feeWalletPk: feeWallet(seed, r.mint).publicKey, signature: r.signature, fate: f,
        payload: r.payload ? JSON.parse(r.payload) : null, mode: r.mode ?? db.prepare('SELECT default_mode FROM users WHERE x_id = ?').get(r.author_id)?.default_mode ?? DEFAULT_MODE, platform: !!r.platform, launcher, log })
      if (res.outcome !== 'unknown') log.info?.(`recovered ${r.tweet_id}: ${res.outcome} ${r.mint}`)
    }
  }

  /** Launches at most one request. Returns what happened, for logs and tests. */
  async function processQueue() {
    if (db.prepare("SELECT 1 FROM mentions WHERE state = 'launching'").get()) return { idle: 'a launch is unresolved' }
    const m = db.prepare("SELECT * FROM mentions WHERE state = 'queued' AND next_try_at <= ? ORDER BY platform DESC, seen_at LIMIT 1").get(now())
    if (!m) return { idle: 'queue empty' }
    // second line of defence: a platform request after the platform token exists never reaches the operator's wallet
    if (m.platform && (kvGet(db, 'platform_mint') || db.prepare("SELECT 1 FROM mentions WHERE platform = 1 AND state IN ('launching', 'launched') AND tweet_id != ?").get(m.tweet_id))) {
      db.prepare("UPDATE mentions SET state = 'rejected', code = 'platform-done', reason = 'the platform token already launched', reply_state = 'skipped', updated_at = ? WHERE tweet_id = ? AND state = 'queued'").run(now(), m.tweet_id)
      return { rejected: 'platform-done', tweet: m.tweet_id }
    }
    if (m.for_handle && !m.for_id && !m.platform) {
      const r = await resolveTarget(m)
      if (r.defer) { db.prepare('UPDATE mentions SET next_try_at = ?, code = ?, reason = ? WHERE tweet_id = ?').run(now() + 60, 'for-wait', r.defer, m.tweet_id); return { deferred: 'for-wait', tweet: m.tweet_id } }
      if (r.reject) {
        db.prepare("UPDATE mentions SET state = 'rejected', code = ?, reason = ?, reply_state = ?, updated_at = ? WHERE tweet_id = ? AND state = 'queued'")
          .run(r.reject, r.reason, rejectionReplyState(m.author_id, r.reject), now(), m.tweet_id)
        return { rejected: r.reject, tweet: m.tweet_id }
      }
      Object.assign(m, db.prepare('SELECT for_id, for_handle, mode FROM mentions WHERE tweet_id = ?').get(m.tweet_id))
    }
    if (!m.platform) {
      const v = checkGuards(db, guards, { authorId: m.author_id, authorHandle: m.author_handle, authorFollowers: m.author_followers, authorCreatedAt: m.author_created_at, symbol: m.symbol, tickerOverride: !!m.ticker_override })
      if (!v.allowed && v.defer) {
        db.prepare('UPDATE mentions SET next_try_at = ?, code = ?, reason = ? WHERE tweet_id = ?').run(now() + (v.code === 'launching-closed' ? 60 : (v.retryAfter ?? 30)), v.code, v.reason, m.tweet_id)
        return { deferred: v.code, tweet: m.tweet_id }
      }
      if (!v.allowed) {
        db.prepare("UPDATE mentions SET state = 'rejected', code = ?, reason = ?, reply_state = ?, updated_at = ? WHERE tweet_id = ? AND state = 'queued'")
          .run(v.code, v.reason, rejectionReplyState(m.author_id, v.code), now(), m.tweet_id)
        return { rejected: v.code, tweet: m.tweet_id }
      }
    }
    // A custom pair is checked against the chain before the claim: a pair pump.fun would refuse is answered, not launched.
    // ⭐ a Float launch: a ticker already on Float would need a takeover fee (2..5 SOL); we never pay it, we say so
    if (m.venue === 'float' && !m.platform) {
      let taken = false
      try { taken = await floatTickerTaken(conn, m.symbol) } catch { taken = false }
      if (taken) {
        db.prepare("UPDATE mentions SET state = 'rejected', code = 'float-ticker-taken', reason = ?, reply_state = ?, updated_at = ? WHERE tweet_id = ? AND state = 'queued'")
          .run(`$${m.symbol.toUpperCase()} is already taken on Float. Pick another ticker, or launch it on Pumpfun.`, rejectionReplyState(m.author_id, 'float-ticker-taken'), now(), m.tweet_id)
        return { rejected: 'float-ticker-taken', tweet: m.tweet_id }
      }
    }
    if (m.pair_input && !m.platform) {
      let r
      try { r = m.venue === 'float' ? await resolveFloatPair(db, conn, m.pair_input) : await resolvePair(db, conn, m.pair_input) } catch (e) { r = { ok: false, code: 'pair-wait', reason: `pair lookup failed: ${e.message}` } }
      // a pair that stays unreadable (or mid-migration) for an hour is refused rather than retried for ever
      if (!r.ok && r.code === 'pair-wait' && now() - m.seen_at > 3600) r = { ok: false, code: 'bad-pair', reason: 'That pair could not be checked for an hour. Post again to retry.' }
      if (!r.ok && r.code === 'pair-wait') {
        db.prepare('UPDATE mentions SET next_try_at = ?, code = ?, reason = ? WHERE tweet_id = ?').run(now() + 60, 'pair-wait', r.reason, m.tweet_id)
        return { deferred: 'pair-wait', tweet: m.tweet_id }
      }
      if (!r.ok) {
        db.prepare("UPDATE mentions SET state = 'rejected', code = ?, reason = ?, reply_state = ?, updated_at = ? WHERE tweet_id = ? AND state = 'queued'")
          .run(r.code, r.reason, rejectionReplyState(m.author_id, r.code), now(), m.tweet_id)
        return { rejected: r.code, tweet: m.tweet_id }
      }
      db.prepare('UPDATE mentions SET pair = ? WHERE tweet_id = ?').run(r.quote.kind === 'sol' ? null : JSON.stringify(r.quote), m.tweet_id)
      m.pair = r.quote.kind === 'sol' ? null : JSON.stringify(r.quote)
    }
    // ⛔ The claim: a conditional UPDATE, so two loops (or a restart racing a slow pass) never launch one request twice.
    if (db.prepare("UPDATE mentions SET state = 'launching', updated_at = ? WHERE tweet_id = ? AND state = 'queued'").run(now(), m.tweet_id).changes !== 1) return { idle: 'lost the claim' }
    let res
    try {
      res = await launchMention({ db, conn, pump, launcher, platformLauncher, seed, mention: m, x, publicUrl, logoDir, lookupTables, ...(pin ? { pin } : {}), log })
    } catch (e) {
      res = { outcome: 'error', error: e.message }
      const row = db.prepare('SELECT * FROM mentions WHERE tweet_id = ?').get(m.tweet_id)
      // Only a row with nothing sent can go back to the queue; a signature on it means recover() decides.
      if (row.state === 'launching' && !row.signature) {
        const final = row.attempts >= MAX_ATTEMPTS
        db.prepare(`UPDATE mentions SET state = ?, code = ?, reason = ?, next_try_at = ?, reply_state = CASE WHEN ? THEN 'pending' ELSE reply_state END, updated_at = ? WHERE tweet_id = ?`)
          .run(final ? 'failed' : 'queued', final ? 'launch-failed' : 'retrying', e.message.slice(0, 300), now() + 60, final ? 1 : 0, now(), m.tweet_id)
      }
    }
    if (res.hold) db.prepare("UPDATE mentions SET state = 'queued', attempts = MAX(0, attempts - 1), next_try_at = ?, reason = ?, updated_at = ? WHERE tweet_id = ? AND state = 'launching' AND signature IS NULL").run(now() + 120, res.error, now(), m.tweet_id)
    else if (res.outcome === 'retry') db.prepare('UPDATE mentions SET next_try_at = ? WHERE tweet_id = ?').run(now() + 30, m.tweet_id)
    if (res.outcome === 'launched') log.info?.(`launched $${m.symbol} ${res.mint} for @${m.author_handle} (${m.tweet_id})`)
    else log.info?.(`launch ${m.tweet_id} ${res.outcome}${res.error ? `: ${res.error}` : ''}`)
    return { ...res, tweet: m.tweet_id }
  }

  function replyText(r) {
    if (r.state === 'launched') {
      const t = db.prepare('SELECT mode, own_creator, quote_symbol, venue, launched_by_id, creator_handle FROM tokens WHERE mint = ?').get(r.mint)
      if (t?.own_creator) return launchedReply({ symbol: r.symbol, name: r.name, mint: r.mint, mode: 'platform' })
      return launchedReply({ symbol: r.symbol, name: r.name, mint: r.mint, mode: t?.mode ?? 'creator', pair: t?.quote_symbol ?? null, venue: t?.venue ?? 'pump', forHandle: t?.launched_by_id ? t.creator_handle : null })
    }
    if (r.state === 'rejected') return rejectedReply(r.reason ?? 'that one cannot launch')
    if (r.state === 'failed') return failedReply()
    return null
  }

  async function replyOne() {
    if (!repliesOn || !x.canReply) return { idle: 'replies off' }
    const lastAt = Number(kvGet(db, 'last_reply_at') ?? 0)
    if (now() - lastAt < replySpacing) return { idle: 'spacing' }
    const r = db.prepare("SELECT * FROM mentions WHERE reply_state = 'pending' AND source = 'x' AND reply_after <= ? AND state IN ('launched', 'rejected', 'failed') ORDER BY state = 'launched' DESC, updated_at LIMIT 1").get(now())
    if (!r) return { idle: 'nothing to say' }
    const raw = replyText(r)
    // ⛔ never an emoji, hashtag or "--" in anything we post (operator rule), whatever produced the text
    const text = raw == null ? null : cleanReply(raw)
    if (!text) { db.prepare("UPDATE mentions SET reply_state = 'skipped' WHERE tweet_id = ?").run(r.tweet_id); return { skipped: r.tweet_id } }
    // Marked before the send: a crash mid-send retries in 10 minutes rather than at once.
    db.prepare('UPDATE mentions SET reply_attempts = reply_attempts + 1, reply_after = ? WHERE tweet_id = ?').run(now() + 600, r.tweet_id)
    kvSet(db, 'last_reply_at', now())
    try {
      const id = await x.reply(r.tweet_id, text)
      db.prepare("UPDATE mentions SET reply_state = 'sent', reply_id = ?, updated_at = ? WHERE tweet_id = ?").run(id, now(), r.tweet_id)
      return { replied: r.tweet_id, id }
    } catch (e) {
      const final = r.reply_attempts + 1 >= 5
      db.prepare('UPDATE mentions SET reply_state = ?, reply_after = ? WHERE tweet_id = ?').run(final ? 'failed' : 'pending', now() + 60 * 2 ** (r.reply_attempts + 1), r.tweet_id)
      log.error?.(`reply to ${r.tweet_id} failed: ${e.message}`)
      return { replyFailed: r.tweet_id, error: e.message }
    }
  }

  async function tick({ doPoll = true } = {}) {
    const out = {}
    if (doPoll) { try { out.poll = await poll() } catch (e) { out.poll = { error: e.message }; log.error?.(`poll: ${e.message}`) } }
    try { await recover() } catch (e) { log.error?.(`recover: ${e.message}`) }
    try { out.queue = await processQueue() } catch (e) { out.queue = { error: e.message }; log.error?.(`queue: ${e.message}`) }
    try { out.reply = await replyOne() } catch (e) { log.error?.(`reply: ${e.message}`) }
    return out
  }

  // X is read every POLL_SECONDS; the queue and replies are worked every 2 s in between (operator 11 Nov: no launch cap,
  // so the queue must not wait 20 s per launch: one launch per 20 s pass was ~180 an hour at most)
  function start(intervalMs = Number(env.POLL_SECONDS ?? 20) * 1000, workMs = Number(env.WORK_MS ?? 2000)) {
    let stopped = false, timer, lastPoll = 0
    const loop = async () => {
      if (stopped) return
      // ⛔ Pump Fund has no X bot: mentions are read only when BOT_POLL=1 is set on purpose (each read is paid)
      const doPoll = env.BOT_POLL === '1' && Date.now() - lastPoll >= intervalMs
      if (doPoll) lastPoll = Date.now()
      await tick({ doPoll })
      timer = setTimeout(loop, workMs)
    }
    loop()
    return () => { stopped = true; clearTimeout(timer) }
  }

  return { poll, recover, processQueue, replyOne, tick, start, ingestTweetId, watchPlatformReply, launchingOpen: () => launchingOpen(db) }
}
