/**
 * X access through twitterapi.io (ported from TAG's x/twitterapiio.ts).
 *
 *   mentions   GET /twitter/user/mentions?userName=&sinceTime=     (billed per tweet returned; one page is the norm)
 *   tweet      GET /twitter/tweets?tweet_ids=                      (the parent post's image, when a launch replies to one)
 *   reply      POST /twitter/create_tweet_v2 { login_cookies, tweet_text, reply_to_tweet_id, proxy }
 *
 * ⛔ The key is shared with other projects (memory twitterapi-poller-drains-balance): the poll reads only since the last
 * tweet it has seen (minus a small overlap), and a known tweet id is skipped BEFORE anything billable happens for it.
 * `FixtureX` stands in for tests and dry runs.
 */
const BASE = 'https://api.twitterapi.io'

function pickMedia(t) {
  for (const pool of [t.extendedEntities?.media, t.entities?.media]) {
    if (!Array.isArray(pool)) continue
    for (const m of pool) if (m?.media_url_https && (!m.type || m.type === 'photo')) return m.media_url_https
  }
  return null
}
const unix = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000) }

export function toMention(t) {
  if (!t?.id || typeof t.text !== 'string') return null
  const a = t.author ?? {}
  if (!a.userName || !a.id) return null
  return {
    id: String(t.id), text: t.text, createdAt: unix(t.createdAt) ?? Math.floor(Date.now() / 1000),
    authorHandle: a.userName, authorId: String(a.id), authorName: a.name ?? a.userName,
    authorFollowers: Number.isFinite(a.followers) ? Number(a.followers) : 0,
    authorCreatedAt: a.createdAt ? unix(a.createdAt) : null,
    authorAvatar: a.profilePicture ?? null,
    // bot signals (api/botfilter.mjs)
    authorFollowing: Number.isFinite(a.following) ? Number(a.following) : null,
    authorTweets: Number.isFinite(a.statusesCount) ? Number(a.statusesCount) : null,
    authorAutomated: a.isAutomated === true || !!a.automatedBy,
    authorVerified: a.isBlueVerified === true || a.isVerified === true,
    mediaUrl: pickMedia(t), inReplyToId: t.inReplyToId ? String(t.inReplyToId) : null,
    // a quote post carries the quoted post inline: its picture costs no extra call
    quotedMediaUrl: t.quoted_tweet ? pickMedia(t.quoted_tweet) : null,
    isRetweet: Boolean(t.retweeted_tweet), url: t.url ?? `https://x.com/${a.userName}/status/${t.id}`,
  }
}

export class TwitterApiIo {
  constructor({ apiKey, handle, loginCookie = '', proxy = '', fetchImpl = fetch, maxPages = 5 }) {
    Object.assign(this, { apiKey, handle, loginCookie, proxy, fetchImpl, maxPages })
    this.kind = 'twitterapi.io'
  }
  async get(path, params) {
    const url = new URL(path, BASE)
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v))
    const res = await this.fetchImpl(url, { headers: { 'X-API-Key': this.apiKey }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`twitterapi.io ${path} ${res.status}`)
    const body = await res.json()
    if (body.status === 'error') throw new Error(`twitterapi.io ${path}: ${body.message ?? 'error'}`)
    return body
  }
  async fetchMentions(sinceUnix) {
    const out = []
    let cursor = ''
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this.get('/twitter/user/mentions', { userName: this.handle, sinceTime: sinceUnix, cursor })
      for (const raw of body.tweets ?? []) { const m = toMention(raw); if (m) out.push(m) }
      // has_next_page can read true with nothing behind it; the empty cursor is what ends the loop.
      if (!body.has_next_page || !body.next_cursor) break
      cursor = body.next_cursor
    }
    return out
  }
  /** Replies under one post (newest pages first), since a unix time. Used to catch the operator's own platform reply,
   *  which X's mention search can leave out (an account tagging itself), and the account is too new for search. */
  async fetchReplies(tweetId, sinceUnix) {
    const out = []
    let cursor = ''
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this.get('/twitter/tweet/replies', { tweetId, sinceTime: sinceUnix, cursor })
      for (const raw of body.tweets ?? []) { const m = toMention(raw); if (m) out.push(m) }
      if (!body.has_next_page || !body.next_cursor) break
      cursor = body.next_cursor
    }
    return out
  }
  async fetchTweet(id) {
    const body = await this.get('/twitter/tweets', { tweet_ids: id })
    const t = (body.tweets ?? body.data ?? [])[0]
    return t ? { mediaUrl: pickMedia(t), authorHandle: t.author?.userName ?? null, mention: toMention(t) } : null
  }
  async userInfo(handle) {
    const body = await this.get('/twitter/user/info', { userName: handle })
    const u = body.data
    return u?.id ? { id: String(u.id), handle: u.userName, name: u.name, avatar: u.profilePicture ?? null, followers: u.followers ?? 0, createdAt: u.createdAt ? unix(u.createdAt) : null } : null
  }
  get canReply() { return Boolean(this.loginCookie) }
  async reply(inReplyToId, text) {
    if (!this.loginCookie) throw new Error('replies are not configured (X_LOGIN_COOKIE)')
    const res = await this.fetchImpl(`${BASE}/twitter/create_tweet_v2`, {
      method: 'POST', headers: { 'X-API-Key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ login_cookies: this.loginCookie, tweet_text: text, reply_to_tweet_id: inReplyToId, proxy: this.proxy }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`twitterapi.io reply ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const body = await res.json()
    if (body.status === 'error') throw new Error(`twitterapi.io reply: ${body.message ?? 'error'}`)
    return body.data?.create_tweet?.tweet_id ?? body.tweet_id ?? null
  }
}

/** In-memory X for tests and DRY_RUN: mentions are pushed in, replies are kept. */
export class FixtureX {
  constructor(handle = 'PumpFund') { this.kind = 'fixture'; this.handle = handle; this.mentions = []; this.replies = []; this.tweets = new Map(); this.calls = { mentions: 0, tweet: 0 } }
  get canReply() { return true }
  async fetchMentions(since) { this.calls.mentions++; return this.mentions.filter((m) => !since || m.createdAt >= since) }
  async fetchTweet(id) { this.calls.tweet++; return this.tweets.get(id) ?? null }
  async fetchReplies(tweetId, since) { this.calls.replies = (this.calls.replies ?? 0) + 1; return (this.replyThreads?.get(tweetId) ?? []).filter((m) => !since || m.createdAt >= since) }
  // tests set x.users (lower-case handle → { id, handle, ... }) and x.userInfoFails = true to simulate an outage
  async userInfo(handle) { this.calls.user = (this.calls.user ?? 0) + 1; if (this.userInfoFails) throw new Error('twitterapi.io /twitter/user/info 503'); return this.users?.get(String(handle).toLowerCase()) ?? null }
  async reply(to, text) { const id = `r${this.replies.length + 1}`; this.replies.push({ to, text, id }); return id }
}
