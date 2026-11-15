/**
 * PUMP FUND API: plain node:http + node:sqlite. Also runs the launch queue (api/bot.mjs, X polling off) and the vanity grinder.
 * The keeper runs as its own timer (api/keeper-run.mjs); both sign for fee wallets, and the per-coin DB lock
 * (db.lockCoin) is what keeps them from signing for the same wallet at once.
 */
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { APP_RAILS, appShown, isApp, isOurs, cleanPayee } from './rails.mjs'
import { ConnectError, createPaypalConnector, realSarClient } from './paypal.mjs'
import { proofRecords } from './proof.mjs'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { openDb, now, kvGet, kvSet, buckets, owedTo, owedAssets, upsertUser, launchingOpen, mintsOf, shareOf, sharesOf, LAUNCHING_CLOSED } from './db.mjs'
import { lamportsToUsd, refreshMarket, solUsd } from './market.mjs'
import { payCreator, keeperConfig } from './keeper.mjs'
import { parseSeed, seedFingerprint } from './feewallet.mjs'
import { freshCount, startGrinder } from './vanity.mjs'
import { pumpProgram } from '../lib/pump.mjs'
import { xProvider } from './providers/x.mjs'
import { stubProvider } from './providers/stub.mjs'
import { fomoProvider, isFomoWallet } from './providers/fomo.mjs'
import { xmoneyConfig, xmoneyView, baseKey } from './xmoney.mjs'
import { squareLogo } from './images.mjs'
import { TwitterApiIo, FixtureX } from './x.mjs'
import { createBot } from './bot.mjs'
import { guardConfig } from './guards.mjs'
import { createSiteLauncher, SiteError } from './sitelaunch.mjs'
import { charityById } from './charities.mjs'

export class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status } }

export function createApp({ env = process.env, db: dbIn = null, conn: connIn = null, x: xIn = null, keeper: keeperIn = null, launcher: launcherIn = null, platformLauncher: platformLauncherIn = null, pin = null, github = null, sar = null } = {}) {
  const PUBLIC_URL = (env.PUBLIC_URL ?? 'http://localhost:5590').replace(/\/+$/, '')
  const SITE_ORIGIN = new URL(PUBLIC_URL).origin
  const DATA_DIR = env.DATA_DIR ?? './data'
  const LOGO_DIR = env.LOGO_DIR ?? join(DATA_DIR, 'logos')
  mkdirSync(LOGO_DIR, { recursive: true })
  const db = dbIn ?? openDb(env.DB_PATH ?? join(DATA_DIR, 'pumpfund.db'))
  // A fresh store starts with launching CLOSED: it opens when the platform token lands (api/launch.mjs recordLaunch).
  if (!kvGet(db, 'initialised')) { kvSet(db, 'initialised', now()); if (env.START_OPEN !== '1') kvSet(db, LAUNCHING_CLOSED, 'until the project token launches') }

  const rpcCounts = new Map()
  const conn = connIn ?? new Connection(env.RPC_URL ?? 'http://127.0.0.1:8899', {
    commitment: 'confirmed',
    fetchMiddleware: (url, options, f) => { try { for (const r of [].concat(JSON.parse(options.body))) rpcCounts.set(r.method, (rpcCounts.get(r.method) ?? 0) + 1) } catch {} return f(url, options) },
  })
  const readKey = (p) => p && existsSync(p) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')))) : null
  const keeper = keeperIn ?? readKey(env.KEEPER_KEY)
  const launcher = launcherIn ?? readKey(env.LAUNCH_KEY)
  // the platform token's own launch + creator wallet (operator 10 Nov); absent = the launch wallet, fee-wallet creator
  const platformLauncher = platformLauncherIn ?? readKey(env.PLATFORM_LAUNCH_KEY)
  const seed = env.FEE_SEED ? parseSeed(env.FEE_SEED) : null
  const pump = pumpProgram(conn)
  const kcfg = keeperConfig(env)

  // ── X ──
  // our own X account, shown on the site only when set (no X bot here: nothing is read from or posted to X)
  const X_HANDLE = env.X_HANDLE ?? ''
  const x = xIn ?? (env.TWITTERAPI_IO_KEY ? new TwitterApiIo({ apiKey: env.TWITTERAPI_IO_KEY, handle: X_HANDLE || 'pumpfund', loginCookie: env.X_LOGIN_COOKIE ?? '', proxy: env.X_PROXY ?? '' }) : new FixtureX(X_HANDLE || 'pumpfund'))
  const DEV = env.DEV_STUBS === '1'
  if (DEV && PUBLIC_URL.startsWith('https:')) throw new Error('DEV_STUBS=1 is refused on an https site')
  const signIn = env.X_CLIENT_ID ? xProvider(env.X_CLIENT_ID, env.X_CLIENT_SECRET, env.X_BEARER, env.TWITTERAPI_IO_KEY) : DEV ? stubProvider('x', 'X') : null
  const OAUTH_CALLBACK_BASE = env.OAUTH_CALLBACK_BASE || PUBLIC_URL
  const fomo = fomoProvider(env.FOMO_LOOKUP)
  const xcfg = xmoneyConfig(env), xmoneyOn = xcfg.enabled
  // ⭐ Float launches (11 Nov): on unless FLOAT_ENABLED=0 (then every request launches on pump.fun)
  const floatOn = false // Pump Fund launches on Pumpfun only

  const guards = guardConfig(env)
  const bot = launcher && seed ? createBot({ db, conn, pump, x, launcher, platformLauncher, seed, guards, env, publicUrl: PUBLIC_URL, logoDir: LOGO_DIR, ...(pin ? { pin } : {}) }) : null
  // ⭐ launching on the site (13 Nov): the same launch, from a form (api/sitelaunch.mjs)
  const site = createSiteLauncher({ db, conn, pump, launcher, seed, guards, env, publicUrl: PUBLIC_URL, logoDir: LOGO_DIR, x, ...(pin ? { pin } : {}), ...(github ? { github } : {}) })
  // ⭐ wallet launches: payments the chain had not answered yet, and refunds of paid launches that failed (every 30 s)
  if (launcher && seed && env.SITE_SWEEPS !== '0') {
    let sweeping = false
    setInterval(async () => {
      if (sweeping) return
      sweeping = true
      try { await site.recoverPays(); await site.refundFailed() } catch (e) { console.error(`site sweeps: ${e.message}`) } finally { sweeping = false }
    }, 30_000).unref()
  }

  // ── helpers ──
  const memoStore = new Map()
  async function memo(key, ttlMs, fn) {
    const hit = memoStore.get(key)
    if (hit && hit.until > Date.now()) return hit.value
    const value = await fn()
    memoStore.set(key, { value, until: Date.now() + ttlMs })
    if (memoStore.size > 5000) for (const [k, v] of memoStore) if (v.until < Date.now()) memoStore.delete(k)
    return value
  }
  // ⭐ Public reads are built at most once per few seconds and shared by every visitor (launch traffic, 11 Nov load test:
  // /api/stats and /api/tokens did ~150 req/s each, and this process also runs the bot). res.cacheKey marks a cacheable read.
  const respCache = new Map()
  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    if (status === 200 && res.cacheKey) {
      if (respCache.size > 5000) respCache.clear()
      respCache.set(res.cacheKey, { at: Date.now(), text })
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(text)
  }
  const readJson = (req, limit = 16 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError('Too large', 413)); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { reject(new HttpError('Bad JSON')) } })
    req.on('error', reject)
  })
  const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1] ?? null
  const secure = PUBLIC_URL.startsWith('https:')
  const cookies = []
  const setCookie = (res, name, value, maxAge) => {
    const all = [].concat(res.getHeader('set-cookie') ?? [])
    all.push(`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`)
    res.setHeader('set-cookie', all)
  }
  void cookies
  const hits = new Map()
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((h) => t - h < 3600_000)) hits.delete(k) }, 600_000).unref()
  function limited(req, bucket, perHour) {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',').pop().trim()
    const k = `${bucket}:${ip}`, t = Date.now()
    const list = (hits.get(k) ?? []).filter((h) => t - h < 3600_000)
    list.push(t); hits.set(k, list)
    return list.length > perHour
  }
  // ⭐ PayPal recipients connect their account with Peer before they can be paid (api/paypal.mjs)
  const paypal = createPaypalConnector({ client: sar ?? realSarClient,
    isRecipient: (h) => !!db.prepare("SELECT 1 FROM token_shares WHERE kind = 'paypal' AND recipient_id = ?").get(`paypal:${h}`) })
  const int = (q, name, dflt, max) => { const n = Number(q.get(name) ?? dflt); return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : dflt }

  const SESSION_DAYS = 14
  const SID = 'pf_sid'
  function sessionUser(req) {
    const id = cookie(req, SID)
    if (!id) return null
    const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now())
    return s ? db.prepare('SELECT * FROM users WHERE x_id = ?').get(s.x_id) : null
  }
  const pendingAuth = new Map()
  const safeReturnPath = (ret) => (/^\/(?![\/\\])[\x21-\x7e]*$/.test(ret ?? '') && !String(ret).includes('\\') ? ret : '/account')

  const userView = (u) => u ? { id: u.x_id, handle: u.handle ?? '', name: u.name ?? u.handle ?? '', avatar: u.avatar ?? '' } : null
  const unitScale = (t) => 10 ** (t.quote_mint ? (t.quote_decimals ?? 0) : 9)
  /** Lifetime creator fees of a coin pump.fun pays out itself: collected (ext_in) + still waiting (ext_waiting). */
  const extEarned = (t) => (t.native_holders || t.own_creator) && !t.quote_mint ? (t.ext_in ?? 0) + (t.ext_waiting ?? 0) : 0
  function tokenView(t, price) {
    const b = buckets(db, t.mint)
    const sol = (units) => (t.quote_mint ? 0 : units / 1e9)
    const airdropped = db.prepare("SELECT COALESCE(SUM(lamports), 0) l, count(DISTINCT batch) n FROM outflows WHERE mint = ? AND kind = 'airdrop' AND state = 'landed'").get(t.mint)
    const paid = db.prepare("SELECT COALESCE(SUM(lamports), 0) l FROM outflows WHERE mint = ? AND kind = 'payout' AND state = 'landed'").get(t.mint).l
    const creator = db.prepare('SELECT * FROM users WHERE x_id = ?').get(t.creator_id)
    return {
      mint: t.mint, name: t.name, symbol: t.symbol, image: t.image ?? '', description: t.description ?? '',
      creator: userView(creator) ?? { id: t.creator_id, handle: t.creator_handle, name: t.creator_handle, avatar: '' },
      tweetUrl: t.tweet_url ?? '', launchTx: t.launch_sig ?? '', createdAt: t.created_at, platform: !!t.platform,
      // launched FOR its creator by someone else (12 Nov): who asked
      launchedBy: t.launched_by_id ? { id: t.launched_by_id, handle: t.launched_by_handle } : null,
      // ⭐ who the creator rewards belong to and in what shares (fixed at launch), with each account's own figures
      shares: t.own_creator ? [] : shareViews(t, b),
      // ⭐ GitHub accounts / charities among the recipients: Pumpfun's own fee sharing pays those, locked on chain
      shareConfig: t.share_config ?? null,
      mode: t.mode, nativeHolders: !!t.native_holders, ownCreator: !!t.own_creator, feeWallet: t.fee_wallet, venue: t.venue ?? 'pump',
      // ⭐ a paired coin (11 Nov): fees are in its quote token. `unit` names the asset every amount below is in;
      // the *Sol fields are SOL coins only (0 for a paired coin).
      quote: t.quote_mint ? { mint: t.quote_mint, symbol: t.quote_symbol ?? '', decimals: t.quote_decimals ?? 0 } : null,
      unit: t.quote_mint ? (t.quote_symbol || 'tokens') : 'SOL',
      // ⭐ own-wallet (platform) coin: its creator rewards are read from the chain (api/feetrack.mjs), shown like any other coin's
      creatorEarned: (t.own_creator ? t.ext_in + t.ext_waiting : totalEarned(t, b)) / unitScale(t),
      creatorPaid: (t.own_creator ? t.ext_out : paid) / unitScale(t), creatorOwed: (t.own_creator ? t.ext_waiting : b.creator) / unitScale(t),
      marketCapUsd: t.market_cap_usd ?? 0, graduated: !!t.graduated, curveProgress: t.curve_progress ?? 0,
      volume24hUsd: t.volume_24h_usd ?? 0, change24h: t.change_24h ?? null,
      feesUsd: t.quote_mint ? (t.fees_usd ?? 0) : lamportsToUsd(totalEarned(t, b) + b.holdersIn + extEarned(t), price), feesSol: sol(totalEarned(t, b) + b.holdersIn + extEarned(t)),
      creatorEarnedSol: sol(b.creatorIn), creatorPaidSol: sol(paid), creatorOwedSol: sol(b.creator),
      holdersEarnedSol: sol(b.holdersIn), holdersPaidSol: sol(airdropped.l + (t.native_holders ? t.ext_out : 0)),
      holdersPendingSol: sol(b.holders + (t.native_holders ? t.ext_in - t.ext_out + t.ext_waiting : 0)), airdrops: airdropped.n,
      links: {
        pump: `https://pump.fun/coin/${t.mint}`, float: `https://www.floatlaunch.xyz/tokens/${t.mint}`, fomo: `https://fomo.family/tokens/solana/${t.mint}`,
        dexscreener: `https://dexscreener.com/solana/${t.mint}`, x: `https://x.com/search?q=${encodeURIComponent('$' + t.symbol)}&f=live`,
        solscan: `https://solscan.io/token/${t.mint}`,
      },
    }
  }
  // our Base wallet (Peer deposits live there), derived from FEE_SEED like every fee wallet; computed once
  let baseAddr = null
  const baseWalletAddress = async () => {
    if (baseAddr || !seed) return baseAddr
    const { privateKeyToAccount } = await import('viem/accounts')
    baseAddr = privateKeyToAccount(baseKey(seed)).address
    return baseAddr
  }
  const outflowView = (o, price) => {
    const t = db.prepare('SELECT quote_mint, quote_symbol, quote_decimals FROM tokens WHERE mint = ?').get(o.mint) ?? {}
    const amount = o.lamports / unitScale(t)
    return { signature: o.signature, time: o.time, unit: t.quote_mint ? (t.quote_symbol || 'tokens') : 'SOL', amount,
      sol: t.quote_mint ? 0 : amount, usd: t.quote_mint ? null : lamportsToUsd(o.lamports, o.sol_usd ?? price), kind: o.kind, destination: o.destination, mint: o.mint, state: o.state,
    recipients: o.kind === 'airdrop' ? db.prepare('SELECT count(*) n FROM airdrop_items WHERE outflow_id = ?').get(o.id).n : undefined }
  }

  /**
   * A coin's recipients for the pages. X accounts carry our ledger's figures. GitHub accounts and charities are paid by
   * Pumpfun directly, pro rata with the X accounts' combined share, so what they earned is that share's total scaled to
   * their own (exact up to a lamport of rounding); with no X account on the coin there is nothing of ours to scale: null.
   */
  function shareViews(t, b) {
    const rows = sharesOf(db, t.mint), xBps = rows.filter((s) => isOurs(s.kind)).reduce((n, s) => n + s.bps, 0)
    return rows.map((s) => {
      // ⭐ a payment app: our ledger's figures, like an X account. ⛔ `id` is its ledger key, which holds the payee in
      // full: never sent to a page (a Zelle payee is an email or phone number). `handle` is the masked display.
      if (isApp(s.kind)) {
        const part = shareOf(db, t.mint, s.id)
        return { kind: s.kind, id: `${s.kind}-${s.slot}`, app: APP_RAILS[s.kind].label, handle: appShown(s.kind, s.handle), name: appShown(s.kind, s.handle), avatar: '', url: '', pct: s.bps / 100,
          earned: part.earned / unitScale(t), paid: part.paid / unitScale(t), owed: part.owed / unitScale(t),
          // PayPal: has the owner connected it with Peer (null = not known yet), and where they do it
          ...(APP_RAILS[s.kind].needsConnect ? { connected: paypal.connectedCached(s.handle), connectPath: `/paypal/${encodeURIComponent(s.handle)}` } : {}) }
      }
      if (s.kind === 'x') {
        const u = db.prepare('SELECT * FROM users WHERE x_id = ?').get(s.id), part = shareOf(db, t.mint, s.id)
        return { kind: 'x', id: s.id, handle: u?.handle ?? s.handle ?? '', name: u?.name ?? u?.handle ?? s.handle ?? '', avatar: u?.avatar ?? '', url: '', pct: s.bps / 100,
          earned: part.earned / unitScale(t), paid: part.paid / unitScale(t), owed: part.owed / unitScale(t) }
      }
      const earned = xBps > 0 ? (b.creatorIn * s.bps) / xBps / unitScale(t) : null
      if (s.kind === 'github') return { kind: 'github', id: s.id, handle: s.handle ?? '', name: s.handle ?? '', avatar: `https://avatars.githubusercontent.com/u/${s.id}?s=96`, url: `https://github.com/${s.handle ?? ''}`, pct: s.bps / 100, earned, paid: null, owed: null }
      const c = charityById(s.id)
      return { kind: 'charity', id: s.id, handle: c?.name ?? s.handle ?? '', name: c?.name ?? s.handle ?? '', avatar: c?.logo ?? '', url: c?.url ?? '', pct: s.bps / 100, earned, paid: null, owed: null }
    })
  }
  /** What a coin earned in all, in its units: the X accounts' credited total scaled up to 100% on a natively split coin. */
  const totalEarned = (t, b) => { if (!t.share_config) return b.creatorIn; const xBps = sharesOf(db, t.mint).filter((s) => isOurs(s.kind)).reduce((n, s) => n + s.bps, 0); return xBps > 0 ? Math.round((b.creatorIn * 10000) / xBps) : 0 }
  /** The tokens an X account has a share of, newest first. */
  const tokensOf = (xId) => mintsOf(db, xId).map((mint) => db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint)).filter((t) => t && !t.own_creator).sort((a, b) => b.created_at - a.created_at)
  /** Who a payout row paid, as a page may show it (a Zelle payee masked). */
  const payeeShown = (r) => (isApp(r.platform) ? appShown(r.platform, r.handle) : `@${r.handle}`)
  const xmoneyStatus = (r, v) => r.state === 'done' ? (v.paidUsd > 0 ? (r.return_usdc > 0 ? 'Partly paid; the rest went back to their balance' : isApp(r.platform) ? `Paid to ${payeeShown(r)}` : `Paid to @${r.handle}'s X Money`) : (r.returned_lamports > 0 ? 'Nobody paid in time: back in their balance' : 'Ended'))
    : r.state === 'failed' ? 'Delayed' : r.state === 'listed' ? (v.paidUsd > 0 ? 'Partly paid, waiting for the rest' : 'Listed on Peer, waiting for a payer')
    : r.state === 'returning' || r.state === 'crediting' ? 'Returning to their balance' : r.state === 'bridging' ? 'Bridging to Base' : 'Preparing'
  function xmoneyTotals() {
    const rows = db.prepare('SELECT * FROM xmoney_payouts').all()
    let paidUsd = 0, listedUsd = 0
    const people = new Set()
    for (const r of rows) {
      const v = xmoneyView(r)
      paidUsd += v.paidUsd ?? 0
      if (v.paidUsd > 0) people.add(r.x_id)
      if (r.state === 'listed') listedUsd += Math.max(0, r.usdc / 1e6 - (v.paidUsd ?? 0))
    }
    return { enabled: xmoneyOn, paidUsd, listedUsd, people: people.size, payouts: rows.length }
  }

  // ── routes ──
  async function route(req, res, url) {
    const path = url.pathname, q = url.searchParams
    let m
    if (path === '/api/health') return json(res, 200, { ok: true })
    if (req.method === 'GET') {
      // signed-in visitors always read their token / creator pages fresh (a setting they just saved must show at once)
      const ttl = path === '/api/stats' || path === '/api/tokens' || path === '/api/payouts' || path === '/api/proof' ? 5000 : path === '/api/feed' ? 3000
        : /^\/api\/(token|creator)\/[^/]+$/.test(path) && !cookie(req, SID) ? 5000 : 0
      if (ttl) {
        const key = `${path}?${q.toString()}`, hit = respCache.get(key)
        if (hit && Date.now() - hit.at < ttl) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(hit.text) }
        res.cacheKey = key
      }
    }
    const price = await solUsd().catch(() => 0)

    if (path === '/api/stats') {
      const s = { n: db.prepare('SELECT count(*) n FROM tokens').get().n, c: db.prepare('SELECT count(DISTINCT recipient_id) c FROM token_shares').get().c }
      // ⛔ SOL sums over SOL coins only; a paired coin's rows are in its own token (its USD is in tokens.fees_usd)
      // + fees pump.fun pays out itself (holder-reward coins, the platform coin), read from the chain (api/feetrack.mjs)
      const ext = db.prepare('SELECT COALESCE(SUM(ext_in + ext_waiting), 0) earned, COALESCE(SUM(CASE WHEN own_creator = 1 THEN ext_out ELSE 0 END), 0) toCreator, COALESCE(SUM(CASE WHEN native_holders = 1 THEN ext_out ELSE 0 END), 0) toHolders FROM tokens WHERE quote_mint IS NULL AND (native_holders = 1 OR own_creator = 1)').get()
      const fees = db.prepare('SELECT COALESCE(SUM(c.lamports), 0) l FROM credits c JOIN tokens t ON t.mint = c.mint WHERE t.quote_mint IS NULL').get().l + ext.earned
      const pairedUsd = db.prepare('SELECT COALESCE(SUM(fees_usd), 0) u FROM tokens WHERE quote_mint IS NOT NULL').get().u
      const paid = db.prepare("SELECT o.kind, COALESCE(SUM(o.lamports), 0) l FROM outflows o JOIN tokens t ON t.mint = o.mint WHERE o.state = 'landed' AND t.quote_mint IS NULL GROUP BY o.kind").all()
      const pm = kvGet(db, 'platform_mint')
      return json(res, 200, {
        launches: s.n, creators: s.c, feesSol: fees / 1e9, feesUsd: lamportsToUsd(fees, price) + pairedUsd, solUsd: price,
        paidToCreatorsSol: ((paid.find((r) => r.kind === 'payout')?.l ?? 0) + ext.toCreator) / 1e9, airdroppedSol: ((paid.find((r) => r.kind === 'airdrop')?.l ?? 0) + ext.toHolders) / 1e9,
        queued: db.prepare("SELECT count(*) n FROM mentions WHERE state IN ('queued', 'launching')").get().n,
        launchingOpen: launchingOpen(db), handle: X_HANDLE, platformMint: pm, ticker: String(env.PROJECT_TICKER ?? 'FUND').replace(/^\$/, '').toUpperCase(),
        // ⭐ dollars that reached people's X Money (buyers' proven payments on Peer), and what is listed and waiting for a payer
        xmoney: xmoneyTotals(),
      })
    }
    if (path === '/api/tokens') {
      const sort = { new: 'created_at DESC', top: 'market_cap_usd DESC', fees: 'fees_usd DESC' }[q.get('sort') ?? 'new'] ?? 'created_at DESC'
      const search = String(q.get('q') ?? '').trim().replace(/^\$/, '')
      const limit = int(q, 'limit', 48, 100), offset = int(q, 'offset', 0, 100_000)
      // ⭐ stage (13 Nov, like ponscharity.family/explore): 'graduated' = on PumpSwap, 'curve' = still on the bonding curve
      const stage = q.get('stage') === 'graduated' ? 'graduated = 1' : q.get('stage') === 'curve' ? 'graduated = 0' : null
      const conds = [...(search ? ['(upper(symbol) LIKE ? OR upper(name) LIKE ? OR mint = ? OR lower(creator_handle) = lower(?))'] : []), ...(stage ? [stage] : [])]
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const args = search ? [`${search.toUpperCase()}%`, `%${search.toUpperCase()}%`, search, search.replace(/^@/, '')] : []
      const rows = db.prepare(`SELECT * FROM tokens ${where} ORDER BY platform DESC, ${sort} LIMIT ? OFFSET ?`).all(...args, limit, offset)
      const total = db.prepare(`SELECT count(*) n FROM tokens ${where}`).get(...args).n
      return json(res, 200, { tokens: rows.map((t) => tokenView(t, price)), total })
    }
    if ((m = path.match(/^\/api\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
      const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m[1])
      if (!t) return json(res, 404, { error: 'Not a Pump Fund token' })
      // Market figures refresh in the background: the page never waits on pump.fun or DexScreener.
      if (now() - (t.market_at ?? 0) > 60) memo(`mkt:${t.mint}`, 60_000, () => refreshMarket(db, conn, t.mint, price)).catch(() => {})
      const fresh = t
      const outflows = db.prepare("SELECT * FROM outflows WHERE mint = ? AND state = 'landed' ORDER BY time DESC LIMIT 30").all(t.mint)
      // X Money payouts that took this coin's creator rewards (12 Nov): every step with its transaction
      const ids = t.own_creator ? [t.creator_id] : sharesOf(db, t.mint).filter((s) => isOurs(s.kind)).map((s) => s.id)
      const xmoney = (ids.length ? db.prepare(`SELECT * FROM xmoney_payouts WHERE x_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 60`).all(...ids) : []).map((r) => {
        const outs = db.prepare("SELECT signature, lamports, time FROM outflows WHERE x_id = ? AND mint = ? AND kind = 'payout' AND (destination LIKE 'xmoney:%' OR destination LIKE 'peer:%') AND state = 'landed' AND time >= ? AND time <= ?")
          .all(r.x_id, t.mint, r.created_at, r.done_at ?? r.updated_at ?? now())
        if (!outs.length) return null
        const v = xmoneyView(r)
        const status = xmoneyStatus(r, v)
        return { id: r.id, time: r.created_at, handle: isApp(r.platform) ? payeeShown(r) : r.handle, platform: r.platform ?? 'xmoney', sol: outs.reduce((s, o) => s + o.lamports, 0) / 1e9, totalSol: r.lamports / 1e9, usd: r.usdc / 1e6, paidUsd: v.paidUsd,
          status, done: r.state === 'done', collectTxs: outs.map((o) => o.signature), bridgeTx: r.relay_sig ?? null, peerOrder: r.deposit_id ?? null, creditTx: r.credit_sig ?? null }
      }).filter(Boolean)
      // ⭐ every payment THIS coin's rewards made, with the on-chain proof of each step (api/proof.mjs)
      const baseWallet = await baseWalletAddress()
      const proof = proofRecords(db, { mint: t.mint, limit: 100, baseWallet })
      return json(res, 200, { token: tokenView(fresh, price), activity: outflows.map((o) => outflowView(o, price)), xmoney, xmoneyWallet: xmoney.length ? baseWallet : null, proof: proof.records, proofTotal: proof.total })
    }
    if ((m = path.match(/^\/api\/creator\/([A-Za-z0-9_]{1,15})$/))) {
      const u = db.prepare('SELECT * FROM users WHERE lower(handle) = lower(?)').get(m[1])
      // every token this account has a share of; the totals are ITS shares, not the tokens' whole rewards
      const tokens = u ? tokensOf(u.x_id) : []
      if (!u || (!tokens.length && !db.prepare('SELECT 1 FROM tokens WHERE launched_by_id = ?').get(u.x_id))) return json(res, 404, { error: 'No tokens fund this account yet' })
      const views = tokens.map((t) => tokenView(t, price))
      const mine = views.map((v) => v.shares.find((s) => s.id === u.x_id)).filter(Boolean)
      return json(res, 200, { creator: userView(u), tokens: views,
        earnedSol: mine.reduce((s, v) => s + v.earned, 0), paidSol: mine.reduce((s, v) => s + v.paid, 0) })
    }
    // ⭐ every X Money payout, newest first: who, how much, where it stands, with the transactions that prove it
    // ⭐ the public proof ledger: every payment, every step, every transaction (api/proof.mjs)
    if (path === '/api/proof') {
      const baseWallet = await baseWalletAddress()
      const r = proofRecords(db, { limit: int(q, 'limit', 30, 100), offset: int(q, 'offset', 0, 1e6), baseWallet })
      return json(res, 200, { ...r, baseWallet, totals: xmoneyTotals() })
    }
    if (path === '/api/payouts') {
      const rows = db.prepare('SELECT * FROM xmoney_payouts ORDER BY id DESC LIMIT ?').all(int(q, 'limit', 20, 100))
      return json(res, 200, { payouts: rows.map((r) => {
        const v = xmoneyView(r)
        return { id: r.id, time: r.created_at, handle: isApp(r.platform) ? payeeShown(r) : r.handle, platform: r.platform ?? 'xmoney', sol: r.lamports / 1e9, usd: r.usdc / 1e6, paidUsd: v.paidUsd ?? 0, status: xmoneyStatus(r, v), done: r.state === 'done',
          bridgeTx: r.relay_sig ?? null, peerOrder: r.deposit_id ?? null }
      }), wallet: rows.length ? await baseWalletAddress() : null, totals: xmoneyTotals() })
    }
    if (path === '/api/feed') {
      const rows = db.prepare("SELECT tweet_id, author_handle, symbol, name, state, mint, url, seen_at, launched_at FROM mentions WHERE state IN ('queued', 'launching', 'launched') ORDER BY seen_at DESC LIMIT 30").all()
      return json(res, 200, { feed: rows.map((r) => ({ tweetId: r.tweet_id, handle: r.author_handle, symbol: r.symbol, name: r.name, state: r.state === 'launching' ? 'queued' : r.state, mint: r.mint, url: r.url ?? `${PUBLIC_URL}/x/${r.author_handle}`, at: r.launched_at ?? r.seen_at })) })
    }
    if ((m = path.match(/^\/api\/logos\/([a-f0-9]{32}\.(png|jpg|gif|webp))$/))) {
      const file = join(LOGO_DIR, basename(m[1]))
      if (!existsSync(file)) return json(res, 404, { error: 'not found' })
      const sq = q.get('sq') === '0' ? null : squareLogo(LOGO_DIR, m[1])
      const type = sq ? 'image/webp' : { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[m[2]]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' })
      return createReadStream(sq ?? file).pipe(res)
    }

    // ── sign in with X ──
    if (path === '/api/auth/x/start') {
      if (!signIn) return json(res, 503, { error: 'X sign-in is not set up yet' })
      if (limited(req, 'auth', 60)) return json(res, 429, { error: 'Too many sign-in attempts' })
      const redirect = `${OAUTH_CALLBACK_BASE}/api/auth/x/callback`
      const { url: to, state, verifier } = signIn.begin(redirect, DEV ? q.get('as') : undefined)
      pendingAuth.set(state, { verifier, returnTo: safeReturnPath(q.get('return')), at: Date.now() })
      for (const [k, v] of pendingAuth) if (Date.now() - v.at > 600_000) pendingAuth.delete(k)
      setCookie(res, 'pf_auth', state, 600)
      res.writeHead(302, { location: to }); return res.end()
    }
    if (path === '/api/auth/x/callback') {
      const state = q.get('state'), code = q.get('code')
      const p = pendingAuth.get(state)
      if (!p || !code || cookie(req, 'pf_auth') !== state) { res.writeHead(302, { location: '/account?error=signin' }); return res.end() }
      pendingAuth.delete(state)
      try {
        const identity = await signIn.complete(code, p.verifier, `${OAUTH_CALLBACK_BASE}/api/auth/x/callback`)
        upsertUser(db, { id: identity.id, handle: identity.handle, name: identity.name, avatar: identity.avatar })
        const sid = randomBytes(24).toString('base64url')
        db.prepare('INSERT INTO sessions (id, x_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sid, String(identity.id), now(), now() + SESSION_DAYS * 86400)
        setCookie(res, SID, sid, SESSION_DAYS * 86400)
        setCookie(res, 'pf_auth', '', 0)
        res.writeHead(302, { location: p.returnTo }); return res.end()
      } catch (e) {
        res.writeHead(302, { location: `/account?error=${encodeURIComponent(e.message.slice(0, 120))}` }); return res.end()
      }
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      const id = cookie(req, SID)
      if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      setCookie(res, SID, '', 0)
      return json(res, 200, { ok: true })
    }

    // ── launching on the site ──
    // the slow parts are shared for 15 s; whether launching is open is read fresh, so the form opens the moment $FUND lands
    if (path === '/api/launch/options') return json(res, 200, { ...(await memo('launch-options', 15_000, () => site.options())), open: !!launcher && !!seed && launchingOpen(db) })
    if (path === '/api/launch/check') {
      if (limited(req, 'launch-check', 600)) return json(res, 429, { error: 'Too many checks, slow down a little' })
      // ⭐ no sign-in since wallet launches (14 Nov): the X lookup is a paid read, so it is limited per IP instead
      const forHandle = q.get('for') ?? ''
      if (forHandle && limited(req, 'launch-for', 60)) return json(res, 429, { error: 'Too many lookups, slow down a little' })
      const githubLogin = q.get('github') ?? ''
      if (githubLogin && limited(req, 'launch-github', 40)) return json(res, 429, { error: 'Too many lookups, slow down a little' })
      return json(res, 200, await site.check({ symbol: q.get('symbol') ?? '', forHandle, githubLogin, user: null }))
    }
    // the charity picker: Donate.gg's directory, searched by name
    if (path === '/api/charities') {
      if (limited(req, 'charities', 1200)) return json(res, 429, { error: 'Too many searches, slow down a little' })
      return json(res, 200, { charities: site.searchCharities(q.get('q') ?? '', 12) })
    }
    // ⭐ PayPal connect: the account's page, starting a connection, and its status (api/paypal.mjs)
    if ((m = path.match(/^\/api\/paypal\/([a-z0-9._-]{1,40})$/)) && req.method === 'GET') {
      const h = cleanPayee('paypal', m[1])
      const key = h ? `paypal:${h}` : null
      const mints = key ? mintsOf(db, key) : []
      if (!mints.length) return json(res, 404, { error: 'No Pump Fund token pays this PayPal account' })
      let connected = null
      if (!limited(req, 'paypal-read', 600)) connected = await paypal.connected(h).catch(() => null)
      const tokens = mints.map((mint) => db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint)).filter(Boolean).sort((a, b) => b.created_at - a.created_at)
      return json(res, 200, { handle: h, connected, owedSol: owedTo(db, key).total / 1e9,
        tokens: tokens.map((t) => ({ mint: t.mint, symbol: t.symbol, name: t.name, image: t.image, pct: (sharesOf(db, t.mint).find((x) => x.id === key)?.bps ?? 0) / 100 })) })
    }
    if (path === '/api/paypal/connect' && req.method === 'POST') {
      if (limited(req, 'paypal-connect', 20)) return json(res, 429, { error: 'Too many tries. Wait a while and try again.' })
      const b = await readJson(req, 4096)
      const h = cleanPayee('paypal', b.handle)
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',').pop().trim()
      try { return json(res, 200, await paypal.start({ handle: h, email: b.email, ip })) }
      catch (e) { if (e instanceof ConnectError) return json(res, e.status, { error: e.message }); throw e }
    }
    if ((m = path.match(/^\/api\/paypal\/connect\/([A-Za-z0-9_-]{16})$/)) && req.method === 'GET') {
      if (limited(req, 'paypal-status', 1200)) return json(res, 429, { error: 'Slow down a little' })
      return json(res, 200, await paypal.status(m[1]))
    }
    // ⭐ launching is by wallet (operator 14 Nov): the connected wallet pays and signs, no X session is needed
    if (path === '/api/launch' && req.method === 'POST') {
      if (limited(req, 'launch', 30)) return json(res, 429, { error: 'Too many launch attempts, try again later' })
      return json(res, 200, await site.submit(null, await readJson(req, 6 * 1024 * 1024)))
    }
    if (path === '/api/launch/sign' && req.method === 'POST') {
      if (limited(req, 'launch-sign', 60)) return json(res, 429, { error: 'Too many launch attempts, try again later' })
      return json(res, 200, await site.sign(null, await readJson(req, 8 * 1024)))
    }
    if ((m = path.match(/^\/api\/launch\/(site-[a-f0-9]{18})$/))) {
      if (limited(req, 'launch-status', 2000)) return json(res, 429, { error: 'Slow down a little' })
      return json(res, 200, site.status(null, m[1]))
    }

    if (path === '/api/me') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      const tokens = tokensOf(u.x_id).map((t) => tokenView(t, price))
      const owed = owedTo(db, u.x_id)
      const payouts = db.prepare("SELECT * FROM outflows WHERE x_id = ? AND kind = 'payout' AND state != 'expired' ORDER BY time DESC LIMIT 50").all(u.x_id)
      return json(res, 200, {
        user: userView(u),
        settings: {
          defaultMode: u.default_mode, payoutKind: u.payout_kind, payoutWallet: u.payout_wallet ?? '', fomoHandle: u.fomo_handle ?? '',
          payoutConfirmed: !!u.payout_confirmed, autoMinSol: u.auto_min_lamports / 1e9, launchVenue: floatOn ? (u.launch_venue ?? 'pump') : 'pump',
        },
        options: { fomo: fomo.configured, float: floatOn, xmoney: xmoneyOn, xmoneyNote: xmoneyOn ? '' : 'X Money payouts open shortly. Until then your rewards wait safely and can be withdrawn to a wallet.', xmoneyMinSol: xcfg.minLamports / 1e9 },
        owedSol: owed.total / 1e9, owedUsd: lamportsToUsd(owed.total, price), minWithdrawSol: Number(env.MIN_WITHDRAW_LAMPORTS ?? 10_000_000) / 1e9,
        // every asset owed, SOL first: paired coins pay their creator in the pair token
        owed: owedAssets(db, u.x_id).map((a) => ({ asset: a.asset, symbol: a.symbol, decimals: a.decimals, amount: a.units / 10 ** a.decimals, coins: a.coins.length })),
        tokens, payouts: payouts.map((o) => outflowView(o, price)),
        xmoney: db.prepare('SELECT * FROM xmoney_payouts WHERE x_id = ? ORDER BY id DESC LIMIT 20').all(u.x_id).map(xmoneyView),
      })
    }
    if (path === '/api/settings' && req.method === 'POST') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      if (limited(req, 'settings', 120)) return json(res, 429, { error: 'Too many changes, try again later' })
      const body = await readJson(req)
      const set = {}
      if (body.defaultMode !== undefined) {
        if (!['creator', 'holders'].includes(body.defaultMode)) throw new HttpError('Fee mode is creator or holders')
        set.default_mode = body.defaultMode
      }
      if (body.launchVenue !== undefined) {
        if (!['pump', 'float'].includes(body.launchVenue)) throw new HttpError('Launch venue is pump or float')
        if (body.launchVenue === 'float' && !floatOn) throw new HttpError('Float launches are not switched on')
        set.launch_venue = body.launchVenue
      }
      if (body.autoMinSol !== undefined) {
        const v = Math.round(Number(body.autoMinSol) * 1e9)
        if (!Number.isFinite(v) || v < 10_000_000 || v > 1000e9) throw new HttpError('Auto-pay threshold is 0.01 to 1000 SOL')
        set.auto_min_lamports = v
      }
      if (body.payoutKind !== undefined) {
        const kind = body.payoutKind
        if (kind === 'xmoney' && !xmoneyOn) throw new HttpError('X Money payouts open shortly. Pick a wallet or hold your rewards for now.')
        if (!['claim', 'wallet', 'fomo', 'xmoney'].includes(kind)) throw new HttpError('Unknown payout option')
        set.payout_kind = kind
        if (kind === 'claim') { set.payout_confirmed = 0 }
        if (kind === 'xmoney') {
          // Peer cannot check that X Money is on for the handle: the account says so, or nothing is sent
          if (body.xmoneyOn !== true) throw new HttpError(`Confirm that X Money is turned on for @${u.handle}`)
          set.payout_confirmed = 1; set.payout_wallet = null; set.fomo_handle = null
        }
        if (kind === 'wallet') {
          let pk
          try { pk = new PublicKey(String(body.payoutWallet ?? '').trim()) } catch { throw new HttpError('That is not a Solana address') }
          if (!PublicKey.isOnCurve(pk.toBytes())) throw new HttpError('That address is a program account, not a wallet')
          const info = await conn.getAccountInfo(pk).catch(() => null)
          if (info && !info.owner.equals(SystemProgram.programId)) throw new HttpError('That address is a token or program account, not a wallet')
          set.payout_wallet = pk.toBase58(); set.payout_confirmed = 1; set.fomo_handle = null
        }
        if (kind === 'fomo') {
          if (!fomo.configured) throw new HttpError('FOMO payouts are not set up yet')
          if (limited(req, 'fomo', 20)) return json(res, 429, { error: 'Too many lookups, try again later' })
          const h = String(body.fomoHandle ?? '').trim().replace(/^@/, '')
          if (!/^[A-Za-z0-9_.]{1,30}$/.test(h)) throw new HttpError('Enter your FOMO handle')
          const [found] = await fomo.lookup(h)
          if (!found?.wallet) throw new HttpError('No FOMO account with a Solana wallet under that handle')
          // ⭐ Confirmed on chain: a FOMO wallet's own transactions are co-signed by FOMO (api/providers/fomo.mjs).
          const ok = await isFomoWallet(conn, found.wallet).catch(() => false)
          set.fomo_handle = found.handle ?? h; set.payout_wallet = found.wallet; set.payout_confirmed = ok ? 1 : 0
        }
      }
      if (!Object.keys(set).length) throw new HttpError('Nothing to change')
      set.settings_at = now()
      set.payout_auto = 0 // the account chose for itself
      const cols = Object.keys(set)
      db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE x_id = ?`).run(...cols.map((c) => set[c]), u.x_id)
      const after = db.prepare('SELECT * FROM users WHERE x_id = ?').get(u.x_id)
      return json(res, 200, { ok: true, payoutConfirmed: !!after.payout_confirmed, payoutWallet: after.payout_wallet ?? '' })
    }
    if (path === '/api/withdraw' && req.method === 'POST') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      if (!keeper || !seed) return json(res, 503, { error: 'Payouts are not set up yet' })
      if (limited(req, 'withdraw', 10)) return json(res, 429, { error: 'Too many withdrawals, try again later' })
      const body = await readJson(req)
      let dest = String(body.destination ?? '').trim() || u.payout_wallet
      let pk
      try { pk = new PublicKey(dest) } catch { throw new HttpError('Enter a Solana wallet address') }
      if (!PublicKey.isOnCurve(pk.toBytes())) throw new HttpError('That address is a program account, not a wallet')
      const info = await conn.getAccountInfo(pk).catch(() => null)
      if (info && !info.owner.equals(SystemProgram.programId)) throw new HttpError('That address is a token or program account, not a wallet')
      // `asset`: 'SOL' (default) or the mint of a pair token owed from paired coins
      const asset = String(body.asset ?? 'SOL').trim() || 'SOL'
      if (asset !== 'SOL' && !db.prepare('SELECT 1 FROM tokens WHERE creator_id = ? AND quote_mint = ?').get(u.x_id, asset)) throw new HttpError('Nothing is owed to you in that token')
      const min = asset === 'SOL' ? Number(env.MIN_WITHDRAW_LAMPORTS ?? 10_000_000) : 1
      const r = await payCreator(db, conn, { keeper, seed, xId: u.x_id, destination: pk.toBase58(), minLamports: min, cfg: kcfg, solUsd: price, asset })
      if (!r.signatures.length) throw new HttpError(r.total <= 0 ? 'Nothing to withdraw yet' : r.total < min ? `The minimum withdrawal is ${min / 1e9} SOL` : 'A payout for your coins is already in progress. Try again in a minute.', 409)
      const dec = asset === 'SOL' ? 9 : (db.prepare('SELECT quote_decimals d FROM tokens WHERE quote_mint = ? LIMIT 1').get(asset)?.d ?? 0)
      return json(res, 200, { ok: true, asset, paid: r.paid / 10 ** dec, paidSol: asset === 'SOL' ? r.paid / 1e9 : 0, pending: r.pending, signatures: r.signatures })
    }
    return json(res, 404, { error: 'Not found' })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, PUBLIC_URL)
    if (req.method === 'POST') {
      // Every write is same-site only.
      const origin = req.headers.origin
      if ((origin && origin !== SITE_ORIGIN) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request refused' })
    } else if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' })
    try { await route(req, res, url) }
    catch (e) {
      const status = e instanceof HttpError || e instanceof SiteError ? e.status : 500
      // a SiteError is always a sentence written for the person at the form, whatever its status
      const shown = e instanceof SiteError || status < 500
      if (!shown) console.error(`${req.method} ${url.pathname}:`, e)
      if (!res.headersSent) json(res, status, { error: shown ? e.message : 'Something went wrong' })
    }
  })

  return { server, db, conn, bot, site, x, seed, keeper, launcher, platformLauncher, rpcCounts, publicUrl: PUBLIC_URL, logoDir: LOGO_DIR }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env
  const app = createApp({ env })
  const port = Number(env.PORT ?? 5590)
  app.server.listen(port, '127.0.0.1', () => console.log(`pumpfund api on :${port}, bot ${!app.bot ? 'OFF (LAUNCH_KEY/FEE_SEED missing)' : env.BOT === '0' ? 'off (BOT=0)' : 'on'}, x ${app.x.kind}, seed ${app.seed ? seedFingerprint(app.seed) : 'none'}, launching ${launchingOpen(app.db) ? 'OPEN' : 'closed'}, platform launcher ${app.platformLauncher ? app.platformLauncher.publicKey.toBase58() : 'the launch wallet'}`))
  setInterval(() => { if (app.rpcCounts.size) { console.log('rpc calls last hour:', JSON.stringify(Object.fromEntries(app.rpcCounts))); app.rpcCounts.clear() } }, 3600_000).unref()
  if (env.VANITY_DIR) startGrinder(app.db, { workDir: env.VANITY_DIR, bin: env.GRIND_BIN ?? 'pumpfund-grind', target: Number(env.VANITY_TARGET ?? 40), threads: Number(env.VANITY_THREADS ?? 1) })
  // the launch queue (site launches and the $FUND launch); X is never polled unless BOT_POLL=1
  if (app.bot && env.BOT !== '0') app.bot.start()
  // ⭐ the project token is launched by the operator on Pumpfun itself: its wallet is watched, and the create it signs
  // lists the token and opens launching (api/official.mjs). Stops for good once found.
  if (env.PLATFORM_WALLET && env.OFFICIAL_WATCH !== '0') {
    const { startOfficialWatch } = await import('./official.mjs')
    startOfficialWatch({ db: app.db, conn: app.conn, wallet: env.PLATFORM_WALLET, env, publicUrl: app.publicUrl, logoDir: app.logoDir, log: { info: (m) => console.log(m), error: (m) => console.error(m) } })
  }
  // Market data for the list pages, gently: the 20 newest coins every 2 minutes.
  setInterval(async () => {
    const price = await solUsd().catch(() => 0)
    if (!price) return
    for (const t of app.db.prepare('SELECT mint FROM tokens ORDER BY created_at DESC LIMIT 20').all()) await refreshMarket(app.db, app.conn, t.mint, price).catch(() => {})
  }, 120_000).unref()
  void freshCount
}
