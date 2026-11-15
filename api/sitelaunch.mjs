/**
 * Launching on Pump Fund (13 Nov 2026): a free launch made from a form by an account signed in with X.
 *
 * ⭐ Every coin is launched FOR one to five X accounts (the form's `recipients`: a handle and a percentage each, 5% at
 * least, 100% together; operator 13 Nov). The coin's creator rewards are theirs in those shares, fixed at launch, and go
 * to each account's X Money (api/xmoney.mjs) unless it signs in and chooses a wallet. ⛔ The launcher never gets a cut: the
 * signed-in account cannot be a recipient. Every handle is resolved to X's numeric id BEFORE anything is queued or built,
 * because the rewards are keyed on that id for ever: an unknown handle is refused on the form, never guessed.
 * Coins are always SOL-paired and always in 'creator' mode (no holder rewards, no custom pairs here).
 *
 *   without a dev buy   the request joins the launch queue (a `mentions` row, source 'site'): guards, launch code and crash
 *                       recovery are the queue's (api/bot.mjs, api/launch.mjs).
 *   with a dev buy      the buyer's own wallet must sign, so the launch is built at once and waits in `site_drafts`:
 *                         prepare  the launch wallet stays fee payer and pays the creation; the buyer's wallet is a signer
 *                                  only for its own buy (its SOL, its token account). Simulated before it is offered.
 *                         sign     the wallet signs and hands the transaction BACK (it never sends it). The message must be
 *                                  the one we built (a wallet may only add its own Lighthouse guard instructions), the
 *                                  buyer's signature must verify, and only then do the launch wallet and the mint key sign.
 *                                  ⛔ Our signatures are added LAST, at submit (memory custodial-unstake-sign-last): a
 *                                  transaction signed by the launch wallet never leaves this server unsent.
 *                       The row is written 'launching' with its signature BEFORE the send, so bot.recover() settles it from
 *                       the chain after a crash like any other launch. A dev-buy launch is ONE attempt: the wallet signed
 *                       that exact message, so a failure is final and the form is simply submitted again.
 *
 * ⛔ A dev buy needs the launch lookup table (create + buy with three signers is ~1,390 bytes without it, ~1,100 with):
 * scripts/make-launch-lut.mjs creates it once and stores its address (kv `launch_lut`, or env LAUNCH_LUT). Without it the
 * form offers launches without a dev buy only.
 */
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { APP_KINDS, APP_RAILS, appKey, cleanPayee, isApp, isOurs } from './rails.mjs'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { bondingCurveAddress, loadGlobal } from '../lib/pump.mjs'
import { fateOf, sendUntilFate, signatureOf } from '../lib/tx.mjs'
import { now, kvGet, launchingOpen, upsertUser } from './db.mjs'
import { checkGuards } from './guards.mjs'
import { imageType, storeImage } from './images.mjs'
import { feeWallet } from './feewallet.mjs'
import { issueKey } from './vanity.mjs'
import { MAX_ATTEMPTS, MIN_LAUNCH_BALANCE, buildLaunchIxs, launchShares, pinMetadata, pinOnce, settleAttempt, siteFields } from './launch.mjs'
import { NAME_MAX, SYMBOL_MAX } from './parse.mjs'
import { charityById, searchCharities } from './charities.mjs'
import { cleanLogin, githubLookup } from './github.mjs'

export class SiteError extends Error { constructor(msg, status = 400) { super(msg); this.status = status } }

export const DESC_MAX = 500
export const LINK_MAX = 120
export const IMAGE_MAX = 4 * 1024 * 1024
/** How long a prepared dev-buy launch waits for the wallet (a blockhash lives ~60-90 s). */
export const DRAFT_SECONDS = 75
/** pump.fun's total fee on a buy at launch size, measured on a mainnet clone 13 Nov (1 SOL → 34,199,203 tokens): 1.25%. */
export const LAUNCH_BUY_FEE_BPS = 125
/** What a first buy costs the buyer on top of the buy: its token account and pump.fun's volume account (measured: 0.0048 SOL). */
export const BUYER_EXTRA_LAMPORTS = 5_000_000
/**
 * ⭐ WALLET LAUNCHES (operator 14 Nov: "it should be with wallet", "this isn't Cashtags, build it this way"). The launcher
 * connects a wallet and PAYS the launch: no X sign-in. Without a dev buy their wallet signs one payment of LAUNCH_FEE to
 * our launch wallet (memo = the launch id); once the chain says it landed the launch is queued and launched as before.
 * With a dev buy the payment rides in the launch transaction itself. A paid launch that ends failed or rejected is
 * refunded to the paying wallet (refundFailed). The launcher's identity is its wallet address (mentions.author_id).
 */
export const LAUNCH_FEE_LAMPORTS = 10_000_000 // ~0.009 SOL measured per plain launch (rents + fees)
export const NATIVE_FEE_LAMPORTS = 25_000_000 // GitHub / charity recipients: config + their accounts (0.0217 measured)
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
/** A launcher that is a wallet, in the shape the rest of this file uses for an account. */
export const walletUser = (wallet) => ({ x_id: wallet, handle: '', name: '', avatar: '', followers: null, x_created_at: null, wallet: true })

/** Phantom's guard program: the only instructions a wallet may add to the launch it signs. */
export const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'

/** Removes characters that render as nothing (memory nfkc-misses-zero-width-chars) and every control character but a newline. */
const clean = (s) => String(s ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim()
const bytes = (s) => new TextEncoder().encode(s).length

function link(raw, label, hosts = null, handleBase = null) {
  let v = clean(raw).replace(/\s+/g, '')
  if (!v) return ''
  if (handleBase && /^@?[A-Za-z0-9_]{1,32}$/.test(v)) v = `${handleBase}${v.replace(/^@/, '')}`
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`
  let u
  try { u = new URL(v) } catch { throw new SiteError(`The ${label} is not a web address.`) }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) throw new SiteError(`The ${label} must be an https web address.`)
  if (hosts && !hosts.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) throw new SiteError(`The ${label} must be on ${hosts[0]}.`)
  if (u.toString().length > LINK_MAX) throw new SiteError(`The ${label} is too long (up to ${LINK_MAX} characters).`)
  return u.toString()
}

/**
 * The form's fields → a clean request, or a SiteError with a sentence the form can show. Pure: no network, no chain.
 * Everything here is permanent on chain (pump.fun metadata has no update authority), so it is checked before anything is pinned.
 */
export function validateSiteLaunch(body, { devBuyMinLamports = 1_000_000, devBuyMaxLamports = 50e9 } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const symbol = clean(b.symbol).replace(/^\$/, '').toUpperCase()
  if (!symbol) throw new SiteError('Add a ticker.')
  if (symbol.length > SYMBOL_MAX) throw new SiteError(`A ticker can be up to ${SYMBOL_MAX} letters or numbers.`)
  // the same shape X reads as a cashtag: letters and numbers, starting with a letter
  if (!/^[A-Z][A-Z0-9]*$/.test(symbol)) throw new SiteError('A ticker is letters and numbers, starting with a letter.')
  const name = clean(b.name).replace(/\s+/g, ' ') || symbol
  if (bytes(name) > NAME_MAX) throw new SiteError(`A token name can be up to ${NAME_MAX} characters.`)
  const description = clean(b.description).replace(/\n{3,}/g, '\n\n')
  if (description.length > DESC_MAX) throw new SiteError(`The description can be up to ${DESC_MAX} characters.`)
  // who the coin funds: handles and whole percentages. Resolved to X ids in submit(), never here.
  const recipients = cleanRecipients(b)

  let image = null
  if (b.image) {
    const raw = String(b.image).replace(/^data:[^,]*,/, '')
    if (raw.length > Math.ceil(IMAGE_MAX / 3) * 4 + 16) throw new SiteError('That image is over 4 MB.')
    image = Buffer.from(raw, 'base64')
    if (image.length > IMAGE_MAX) throw new SiteError('That image is over 4 MB.')
    if (!imageType(image)) throw new SiteError('The image must be a PNG, JPG, GIF or WebP.')
  }

  let devBuy = null
  if (b.devBuy && (b.devBuy.sol !== undefined || b.devBuy.wallet)) {
    const sol = Number(String(b.devBuy.sol ?? '').trim())
    if (!Number.isFinite(sol) || sol < 0) throw new SiteError('The dev buy must be an amount of SOL.')
    const lamports = Math.round(sol * 1e9)
    if (lamports > 0) {
      if (lamports < devBuyMinLamports) throw new SiteError(`The smallest dev buy is ${devBuyMinLamports / 1e9} SOL.`)
      if (lamports > devBuyMaxLamports) throw new SiteError(`The largest dev buy is ${devBuyMaxLamports / 1e9} SOL.`)
      let pk
      try { pk = new PublicKey(String(b.devBuy.wallet ?? '').trim()) } catch { throw new SiteError('Connect the wallet that pays for the dev buy.') }
      if (!PublicKey.isOnCurve(pk.toBytes())) throw new SiteError('That address is a program account, not a wallet.')
      devBuy = { wallet: pk.toBase58(), lamports }
    }
  }
  return {
    symbol, name, description, mode: 'creator', recipients, image, devBuy,
    website: link(b.website, 'website'),
    twitter: link(b.twitter, 'X link', ['x.com', 'twitter.com'], 'https://x.com/'),
    telegram: link(b.telegram, 'Telegram link', ['t.me', 'telegram.me'], 'https://t.me/'),
  }
}

/** An X handle as typed ("@bob", "x.com/bob", " bob ") → "bob", '' when empty; anything else is refused. */
export function cleanFor(raw) {
  const v = clean(raw).replace(/\s+/g, '').replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '')
  if (!v) return ''
  if (!/^[A-Za-z0-9_]{1,15}$/.test(v)) throw new SiteError('Enter the X handle that receives the creator rewards, like @handle.')
  return v
}

export const MAX_RECIPIENTS = 5
export const MIN_SHARE_PCT = 5

/**
 * The form's recipients → [{ kind, handle, bps }], slot 0 first. `recipients: [{ kind?, handle, pct }]`, or the older
 * single `for` (100%). Whole percentages, each at least MIN_SHARE_PCT, 100 together, one to MAX_RECIPIENTS, nobody twice.
 *   kind 'x' (default)  handle = an X handle           → that account's X Money (our ledger)
 *   kind 'github'       handle = a GitHub login        → paid by Pumpfun, claimed on Pumpfun with GitHub
 *   kind 'charity'      handle = a Donate.gg charity id (0x…64, from the picker) → donated by Pumpfun's relay
 *   kind 'venmo' | 'cashapp' | 'zelle' | 'chime' | 'paypal'  handle = that app's payee → paid in dollars via Peer (api/rails.mjs)
 */
export const RECIPIENT_KINDS = ['x', 'github', 'charity', ...APP_KINDS]
export function cleanRecipients(b) {
  const raw = Array.isArray(b.recipients) ? b.recipients : b.for != null && String(b.for).trim() ? [{ handle: b.for, pct: 100 }] : []
  const list = raw.filter((r) => r && (String(r.handle ?? '').trim() || r.pct)).map((r) => {
    const kind = r.kind == null || r.kind === '' ? 'x' : String(r.kind)
    if (!RECIPIENT_KINDS.includes(kind)) throw new SiteError('A recipient is an X account, a GitHub account, a charity, or a Venmo, Cash App, Zelle, Chime or PayPal account.')
    const pct = Number(String(r.pct ?? '').trim())
    if (kind === 'github') { const login = cleanLogin(r.handle); if (login === null) throw new SiteError('Enter a GitHub username, like octocat.'); return { kind, handle: login, pct } }
    if (isApp(kind)) {
      const raw = clean(r.handle)
      if (!raw) return { kind, handle: '', pct }
      const payee = cleanPayee(kind, raw)
      if (!payee) throw new SiteError(`Enter a valid ${APP_RAILS[kind].hint}.`)
      return { kind, handle: payee, pct }
    }
    if (kind === 'charity') { const id = clean(r.handle).toLowerCase(); if (id && !/^0x[0-9a-f]{64}$/.test(id)) throw new SiteError('Pick the charity from the list.'); return { kind, handle: id, pct } }
    return { kind, handle: cleanFor(r.handle), pct }
  })
  if (!list.length || list.some((r) => !r.handle)) throw new SiteError('Name the X account that receives the creator rewards.')
  if (list.length > MAX_RECIPIENTS) throw new SiteError(`A token can fund up to ${MAX_RECIPIENTS} accounts.`)
  if (list.some((r) => !Number.isInteger(r.pct))) throw new SiteError('Each share is a whole percentage.')
  if (list.some((r) => r.pct < MIN_SHARE_PCT)) throw new SiteError(`Each account gets at least ${MIN_SHARE_PCT}%.`)
  if (list.reduce((s, r) => s + r.pct, 0) !== 100) throw new SiteError('The shares must add up to 100%.')
  if (new Set(list.map((r) => `${r.kind}:${r.handle.toLowerCase()}`)).size !== list.length) throw new SiteError('Each account can be listed once.')
  return list.map((r) => ({ kind: r.kind, handle: r.handle, bps: r.pct * 100 }))
}

const decompile = (m, keys) => m.compiledInstructions.map((ix) => ({
  program: keys.get(ix.programIdIndex)?.toBase58() ?? '?', accounts: ix.accountKeyIndexes.map((i) => keys.get(i)?.toBase58() ?? '?'), data: Buffer.from(ix.data).toString('hex'),
}))
const sameIx = (a, b) => a.program === b.program && a.data === b.data && a.accounts.length === b.accounts.length && a.accounts.every((k, i) => k === b.accounts[i])

/**
 * Is `returned` (the message the wallet signed) the launch we built (`original`)? Byte-identical is the normal case.
 * Otherwise the wallet may only have ADDED instructions of its own guard program (Phantom's Lighthouse), none of which
 * may name the launch wallet or the mint: every instruction of ours must still be there, in order and unchanged, with the
 * same fee payer, signers and blockhash, and no lookup table but ours. Pure. Returns { ok, changed } or { ok: false, reason }.
 */
export function sameLaunch(original, returned, { lut = null, launcher, mint, buyer, signers: signersOpt = null, protect = null }) {
  try {
    if (Buffer.from(original.serialize()).equals(Buffer.from(returned.serialize()))) return { ok: true, changed: false }
    if (returned.version !== 0) return { ok: false, reason: 'another transaction version' }
    if (returned.recentBlockhash !== original.recentBlockhash) return { ok: false, reason: 'another blockhash' }
    const n = returned.header.numRequiredSignatures
    const wantSigners = signersOpt
    const signers = returned.staticAccountKeys.slice(0, n).map((k) => k.toBase58())
    // `signers` (fee payer first) and `protect` (keys an added instruction may not name): default = a dev-buy launch
    const want = (wantSigners ?? [launcher, mint, buyer]).map((k) => k.toBase58())
    const guarded = (protect ?? [launcher, mint]).map((k) => k.toBase58())
    if (n !== want.length || signers[0] !== want[0] || want.some((k) => !signers.includes(k))) return { ok: false, reason: 'other signers' }
    if (returned.addressTableLookups.some((l) => !lut || !l.accountKey.equals(lut.key))) return { ok: false, reason: 'another lookup table' }
    const tables = lut ? [lut] : []
    const ours = decompile(original, original.getAccountKeys({ addressLookupTableAccounts: tables }))
    const theirs = decompile(returned, returned.getAccountKeys({ addressLookupTableAccounts: tables }))
    let i = 0, extras = 0
    for (const ix of theirs) {
      if (i < ours.length && sameIx(ix, ours[i])) { i++; continue }
      if (ix.program !== LIGHTHOUSE) return { ok: false, reason: 'an instruction that is not part of the launch' }
      if (guarded.some((k) => ix.accounts.includes(k))) return { ok: false, reason: 'an added instruction that names the launch wallet' }
      if (++extras > 4) return { ok: false, reason: 'too many added instructions' }
    }
    if (i !== ours.length) return { ok: false, reason: 'a launch instruction is missing or altered' }
    return { ok: true, changed: true }
  } catch (e) {
    return { ok: false, reason: `unreadable (${String(e?.message ?? e).slice(0, 60)})` }
  }
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
/** True when `signature` is `pubkey`'s ed25519 signature over `message`. */
export function signedBy(pubkey, message, signature) {
  try {
    if (!signature || signature.length !== 64) return false
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pubkey.toBytes())]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(message), key, Buffer.from(signature))
  } catch { return false }
}

export function createSiteLauncher({ db, conn, pump, launcher, seed, guards, env = process.env, publicUrl, logoDir, pin = pinMetadata, x = null, github = githubLookup({ token: env.GITHUB_TOKEN ?? '' }), log = console }) {
  const devBuyMinLamports = Number(env.DEV_BUY_MIN_LAMPORTS ?? 1_000_000)
  const feePlain = Number(env.LAUNCH_FEE_LAMPORTS ?? LAUNCH_FEE_LAMPORTS), feeNative = Number(env.NATIVE_FEE_LAMPORTS ?? NATIVE_FEE_LAMPORTS)
  const devBuyMaxLamports = Math.round(Number(env.DEV_BUY_MAX_SOL ?? 50) * 1e9)
  const ready = () => !!launcher && !!seed

  let lutHit = { at: 0, value: null }
  /** The launch lookup table, or null when none is set up (then no dev buys). A found table is kept for 5 minutes. */
  async function launchLut() {
    if (lutHit.value && Date.now() - lutHit.at < 300_000) return lutHit.value
    const addr = env.LAUNCH_LUT || kvGet(db, 'launch_lut')
    if (!addr) return null
    let key
    try { key = new PublicKey(addr) } catch { return null }
    const value = (await conn.getAddressLookupTable(key)).value
    if (value) lutHit = { at: Date.now(), value }
    return value
  }

  let curveHit = { at: 0, value: { virtualSol: 30, virtualTokens: 1_073_000_000, supply: 1_000_000_000 } }
  async function curve() {
    if (Date.now() - curveHit.at < 600_000) return curveHit.value
    try {
      const g = await loadGlobal(conn)
      curveHit = { at: Date.now(), value: { virtualSol: Number(g.initial_virtual_sol_reserves) / 1e9, virtualTokens: Number(g.initial_virtual_token_reserves) / 1e6, supply: Number(g.token_total_supply) / 1e6 } }
    } catch { curveHit.at = Date.now() - 540_000 /* the last known figures, read again in a minute */ }
    return curveHit.value
  }

  /** What the form needs to draw itself. Public. */
  async function options() {
    const lut = ready() ? await launchLut().catch(() => null) : null
    return {
      open: ready() && launchingOpen(db),
      nameMax: NAME_MAX, symbolMax: SYMBOL_MAX, descMax: DESC_MAX, imageMax: IMAGE_MAX,
      devBuy: { enabled: !!lut, minSol: devBuyMinLamports / 1e9, maxSol: devBuyMaxLamports / 1e9, feeBps: LAUNCH_BUY_FEE_BPS, extraSol: BUYER_EXTRA_LAMPORTS / 1e9 },
      curve: await curve(),
      maxRecipients: MAX_RECIPIENTS, minSharePct: MIN_SHARE_PCT,
      fee: { sol: feePlain / 1e9, nativeSol: feeNative / 1e9 },
      limits: { cooldownMinutes: Math.round(guards.perAuthorCooldownSeconds / 60), minFollowers: guards.minFollowers, minAccountAgeDays: guards.minAccountAgeDays, tickerHoldHours: Math.round(guards.tickerHoldSeconds / 3600) },
    }
  }

  // ⛔ Every X lookup is a paid read (memory dont-waste-paid-api-credits): one per handle per 10 minutes, shared by all
  // visitors, and a failed lookup is remembered for 20 s so a typing form cannot hammer an outage.
  const lookups = new Map()
  async function lookupHandle(handle) {
    const k = handle.toLowerCase(), hit = lookups.get(k)
    if (hit && hit.until > Date.now()) { if (hit.error) throw hit.error; return hit.info }
    if (lookups.size > 2000) lookups.clear()
    if (!x?.userInfo) throw new Error('X lookups are not set up')
    try {
      const info = await x.userInfo(handle)
      const ok = info?.id && /^[0-9]{1,25}$/.test(String(info.id)) ? { ...info, id: String(info.id) } : null
      lookups.set(k, { info: ok, until: Date.now() + 600_000 })
      return ok
    } catch (error) { lookups.set(k, { error, until: Date.now() + 20_000 }); throw error }
  }

  /**
   * One recipient → { id, handle, name, avatar, self }. The signed-in account's own handle = itself (no lookup; callers refuse it).
   * Anyone else is looked up on X: unknown → refused; lookup down → refused with "try again" (a guess is never used).
   * `write`: also store the account, and set its rewards to go to its X Money if it never chose a payout itself.
   */
  async function resolveFor(user, forHandle, { write = false } = {}) {
    const platformXId = String(env.PLATFORM_X_ID ?? '')
    let target
    if (!forHandle) throw new SiteError('Name the X account that receives the creator rewards.')
    if (user?.handle && forHandle.toLowerCase() === String(user.handle).toLowerCase()) {
      target = { id: String(user.x_id), handle: user.handle ?? '', name: user.name ?? user.handle ?? '', avatar: user.avatar ?? '', self: true }
    } else {
      let info
      try { info = await lookupHandle(forHandle) } catch { throw new SiteError(`@${forHandle} could not be looked up on X just now. Try again in a minute.`, 503) }
      if (!info) throw new SiteError(`@${forHandle} was not found on X. Check the handle.`)
      if (platformXId && info.id === platformXId) throw new SiteError('Coins cannot be launched for this account. Pick someone else.')
      target = { id: info.id, handle: info.handle, name: info.name ?? info.handle, avatar: info.avatar ?? '', self: !!user && info.id === String(user.x_id) }
      if (write && !target.self) upsertUser(db, { id: info.id, handle: info.handle, name: info.name, avatar: info.avatar, followers: info.followers, createdAt: info.createdAt })
    }
    // ⭐ X Money for an account that never chose: its rewards go to its X Money automatically. Its own saved choice wins.
    if (write && !target.self) db.prepare("UPDATE users SET payout_kind = 'xmoney', payout_auto = 1 WHERE x_id = ? AND settings_at IS NULL AND payout_kind = 'claim'").run(target.id)
    return target
  }

  const NO_SELF = 'You cannot be a recipient of a token you launch. Name the accounts it funds.'
  /** A GitHub login → { id (numeric, permanent), login, name, avatar }. Unknown → refused; GitHub down → "try again". */
  async function resolveGithub(login) {
    let u
    try { u = await github(login) } catch { throw new SiteError(`${login} could not be looked up on GitHub just now. Try again in a minute.`, 503) }
    if (!u) throw new SiteError(`${login} was not found on GitHub. Check the username.`)
    return u
  }
  /**
   * Every recipient of a launch → [{ kind: 'x', id, handle, bps }], slot 0 first. ⛔ The launcher is refused (by X id, so a
   * second handle of the same account does not get past it), and so is the same account listed under two handles.
   */
  async function resolveRecipients(user, recipients, { write = false } = {}) {
    const out = []
    // looked up first and written only once ALL are known: a refused form leaves no half-set-up accounts behind
    for (const r of recipients) {
      let got
      if (r.kind === 'github') { const u = await resolveGithub(r.handle); got = { kind: 'github', id: u.id, handle: u.login, bps: r.bps } }
      // ⛔ a charity is the directory's entry for that id, or nothing: the id is never trusted as typed
      else if (r.kind === 'charity') { const c = charityById(r.handle); if (!c) throw new SiteError('Pick the charity from the list.'); got = { kind: 'charity', id: c.id, handle: c.name, bps: r.bps } }
      // a payment app: nothing to look up (no API answers whether a Venmo / Cash App / Zelle / Chime account exists); the
      // id is its ledger key. ⛔ It cannot be checked against the launcher (operator accepted that, 13 Nov)
      else if (isApp(r.kind)) { const p = cleanPayee(r.kind, r.handle); if (!p) throw new SiteError(`Enter a valid ${APP_RAILS[r.kind].hint}.`); got = { kind: r.kind, id: appKey(r.kind, p), handle: p, bps: r.bps } }
      else { const t = await resolveFor(user, r.handle); if (t.self) throw new SiteError(NO_SELF); got = { kind: 'x', id: t.id, handle: t.handle, bps: r.bps } }
      // ids are unique per kind only (x:42 is not github:42)
      if (out.some((o) => o.kind === got.kind && o.id === got.id)) throw new SiteError('Each account can be listed once.')
      out.push(got)
    }
    if (write) for (const r of recipients) if (r.kind === 'x') await resolveFor(user, r.handle, { write: true })
    return out
  }

  /** As-you-type answers: is the ticker free, does the X account exist (`user` = the signed-in account, or no lookup). Never throws for a bad input. */
  async function check({ symbol = '', forHandle = '', githubLogin = '', user = null } = {}) {
    const out = { ticker: null, for: null, github: null }
    if (githubLogin) {
      const login = cleanLogin(githubLogin)
      if (!login) out.github = { ok: false, reason: 'Enter a GitHub username, like octocat.' }
      else try { const u = await resolveGithub(login); out.github = { ok: true, id: u.id, handle: u.login, name: u.name, avatar: u.avatar } } catch (e) { out.github = { ok: false, reason: e instanceof SiteError ? e.message : 'That username could not be checked.', ...(e instanceof SiteError && e.status !== 503 ? {} : { retry: true }) } }
    }
    const sym = clean(symbol).replace(/^\$/, '').toUpperCase()
    if (/^[A-Z][A-Z0-9]{0,9}$/.test(sym)) {
      let taken = null
      if (guards.blockedSymbols.includes(sym)) taken = `$${sym} is not available to launch.`
      else if (guards.tickerHoldSeconds > 0) {
        const prev = db.prepare('SELECT MAX(created_at) t FROM tokens WHERE upper(symbol) = ? AND created_at > ?').get(sym, now() - guards.tickerHoldSeconds).t
        if (prev != null) {
          const hours = Math.max(1, Math.ceil((guards.tickerHoldSeconds - (now() - prev)) / 3600))
          taken = `$${sym} was launched in the last 24 hours. Pick another ticker, or try again in ${hours} ${hours === 1 ? 'hour' : 'hours'}.`
        }
      }
      out.ticker = { symbol: sym, free: !taken, reason: taken }
    }
    if (forHandle) {
      try {
        const t = await resolveFor(user, cleanFor(forHandle))
        out.for = t.self ? { ok: false, reason: NO_SELF } : { ok: true, id: t.id, handle: t.handle, name: t.name, avatar: t.avatar ?? '', self: false }
      } catch (e) { out.for = { ok: false, reason: e instanceof SiteError ? e.message : 'That handle could not be checked.', ...(e instanceof SiteError && e.status !== 503 ? {} : { retry: true }) } }
    }
    return out
  }

  /** Followers and account age for the guards: read once from X when the sign-in did not bring them. */
  async function withProfile(user) {
    if (user.wallet) return user
    if (user.followers != null || !x?.userInfo || !user.handle) return user
    let info
    try { info = await x.userInfo(user.handle) } catch { throw new SiteError('Your X account could not be checked just now. Try again in a minute.', 503) }
    if (info?.id && String(info.id) === String(user.x_id)) upsertUser(db, { id: info.id, handle: info.handle, name: info.name, avatar: info.avatar, followers: info.followers, createdAt: info.createdAt })
    return db.prepare('SELECT * FROM users WHERE x_id = ?').get(user.x_id)
  }

  /** The same rules a post goes through. `wait` = capacity rules may queue the request (no dev buy); otherwise they refuse. */
  function guard(user, symbol, { wait }) {
    if (!launchingOpen(db)) throw new SiteError('Launching is closed right now.', 409)
    const v = checkGuards(db, guards, { authorId: user.x_id, authorHandle: user.handle ?? '', authorFollowers: user.followers, authorCreatedAt: user.x_created_at, symbol })
    if (v.allowed || (v.defer && wait)) return
    if (v.defer) throw new SiteError('Launches are queued right now. Try again in a minute, or launch without a dev buy to join the queue.', 429)
    throw new SiteError(v.reason, ['cooldown', 'author-daily-limit'].includes(v.code) ? 429 : 409)
  }

  const newId = () => `site-${randomBytes(9).toString('hex')}`
  const inFlight = (xId) => db.prepare("SELECT tweet_id FROM mentions WHERE author_id = ? AND source = 'site' AND state IN ('queued', 'launching') LIMIT 1").get(String(xId))

  function insertMention({ id, user, req, opts, state, extra = {} }) {
    db.prepare(`INSERT INTO mentions (tweet_id, author_id, author_handle, text, url, tweeted_at, seen_at, updated_at, state, symbol, name, mode, platform, venue, source, opts,
      reply_state, author_followers, author_created_at, mint, signature, last_valid_height, attempts, payload, for_id, for_handle)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'creator', 0, 'pump', 'site', ?, 'skipped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(user.x_id), user.handle ?? '', `site launch $${req.symbol} ${req.name}`, now(), now(), now(), state, req.symbol, req.name, JSON.stringify(opts),
        user.followers ?? null, user.x_created_at ?? null, extra.mint ?? null, extra.signature ?? null, extra.lastValidHeight ?? null, extra.attempts ?? 0, extra.payload ?? null,
        // launched for someone else: the coin is theirs (recordLaunch); for yourself these stay empty
        req.forId ?? null, req.forId ? req.forHandle : null)
  }

  /**
   * The form's submit. Without a dev buy: queued, { id, state: 'queued' }. With one: built and returned for the wallet,
   * { id, state: 'signing', transaction (base64, unsigned), mint, expiresAt }.
   */
  async function submit(_user, body) {
    if (!ready()) throw new SiteError('Launching is not set up yet.', 503)
    // ⭐ the launcher is the connected wallet (operator 14 Nov): it pays and signs
    let walletPk
    try { walletPk = new PublicKey(String(body?.wallet ?? '').trim()) } catch { throw new SiteError('Connect a wallet to launch.') }
    if (!PublicKey.isOnCurve(walletPk.toBytes())) throw new SiteError('That address is a program account, not a wallet.')
    const wallet = walletPk.toBase58()
    let user = walletUser(wallet)
    if (body?.devBuy && (body.devBuy.sol !== undefined && String(body.devBuy.sol).trim() !== '')) body = { ...body, devBuy: { ...body.devBuy, wallet } }
    else body = { ...body, devBuy: null }
    const req = validateSiteLaunch(body, { devBuyMinLamports, devBuyMaxLamports })
    // closed is answered before any paid X read is made for the request
    if (!launchingOpen(db)) throw new SiteError('Launching is closed right now.', 409)
    if (inFlight(user.x_id)) throw new SiteError('Your previous launch is still going through. Give it a moment.', 409)
    user = await withProfile(user)
    guard(user, req.symbol, { wait: !req.devBuy })
    // who it funds, as X's numeric ids, before anything is queued or built. Slot 0 is the coin's first-named account.
    const shares = await resolveRecipients(user, req.recipients, { write: true })
    // GitHub accounts and charities are paid by Pumpfun's own fee sharing, set up in the launch: no room for a dev buy there
    if (req.devBuy && shares.some((s) => !isOurs(s.kind))) throw new SiteError('A dev buy is not available on a token that funds a GitHub account or a charity. Remove the dev buy, or buy on Pumpfun once the token is live.')
    // the coin's first X account (our ledger's anchor); a GitHub or charity id is never stored as one
    const firstX = shares.find((s) => s.kind === 'x')
    req.forId = firstX?.id ?? null
    req.forHandle = firstX?.handle ?? null

    const opts = { shares, description: req.description, website: req.website, twitter: req.twitter, telegram: req.telegram, imageFile: req.image ? storeImage({ logoDir, publicUrl }, req.image).split('/').pop() : null }
    const fee = shares.some((s) => !isOurs(s.kind)) ? feeNative : feePlain
    if (!req.devBuy) return preparePay(user, req, opts, fee)
    return prepare(user, req, opts, fee)
  }

  /**
   * A launch without a dev buy: the wallet pays `fee` to the launch wallet in a transaction of its own (memo = the
   * launch id). Built here, signed by the wallet, sent by us in sign(); queued only once the chain says it landed.
   */
  async function preparePay(user, req, opts, fee) {
    const payer = new PublicKey(user.x_id)
    const bal = await conn.getBalance(payer, 'confirmed')
    if (bal < fee + 2_000_000) throw new SiteError(`That wallet holds ${(bal / 1e9).toFixed(4)} SOL. Launching costs ${fee / 1e9} SOL plus a network fee.`)
    db.prepare("UPDATE site_drafts SET state = 'expired' WHERE x_id = ? AND state = 'open'").run(user.x_id)
    const id = newId()
    const ixs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: launcher.publicKey, lamports: fee }),
      new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: payer, isSigner: true, isWritable: false }], data: Buffer.from(`pumpfund launch ${id}`) }),
    ]
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
    const raw = new VersionedTransaction(message).serialize()
    const expiresAt = now() + DRAFT_SECONDS
    db.prepare(`INSERT INTO site_drafts (id, x_id, state, mint, wallet, lamports, message, last_valid_height, request, payload, created_at, expires_at) VALUES (?, ?, 'open', '', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, user.x_id, user.x_id, fee, Buffer.from(message.serialize()).toString('base64'), lastValidBlockHeight,
        JSON.stringify({ symbol: req.symbol, name: req.name, mode: 'creator', forId: req.forId, forHandle: req.forHandle, opts }), JSON.stringify({ pay: true, fee }), now(), expiresAt)
    return { id, state: 'signing', kind: 'pay', transaction: Buffer.from(raw).toString('base64'), wallet: user.x_id, feeSol: fee / 1e9, expiresAt }
  }

  async function prepare(user, req, opts, fee = feePlain) {
    const lut = await launchLut().catch(() => null)
    if (!lut) throw new SiteError('Dev buys are switched off right now. Launch without one, and buy on Pumpfun or FOMO once it is live.', 503)
    const buyer = new PublicKey(req.devBuy.wallet)
    const [launchBalance, buyerInfo] = await Promise.all([conn.getBalance(launcher.publicKey, 'confirmed'), conn.getAccountInfo(buyer, 'confirmed')])
    if (launchBalance < MIN_LAUNCH_BALANCE) throw new SiteError('Launching is paused for a moment. Try again shortly.', 503)
    if (buyerInfo && !buyerInfo.owner.equals(SystemProgram.programId)) throw new SiteError('That address is a token or program account, not a wallet.')
    const need = req.devBuy.lamports + BUYER_EXTRA_LAMPORTS + fee + 1_000_000
    if ((buyerInfo?.lamports ?? 0) < need) throw new SiteError(`That wallet holds ${((buyerInfo?.lamports ?? 0) / 1e9).toFixed(4)} SOL. A ${req.devBuy.lamports / 1e9} SOL dev buy needs about ${(need / 1e9).toFixed(4)} SOL.`)

    const row = { symbol: req.symbol, author_handle: user.handle, for_id: req.forId, for_handle: req.forHandle, opts: JSON.stringify(opts) }
    launchShares(row) // well-formed before anything is built (the same check recordLaunch relies on)
    const site = siteFields({ mention: row, publicUrl, logoDir })
    const image = storeImage({ logoDir, publicUrl }, site.img.bytes)
    const pinned = await pinOnce(db, pin, { image: site.img.bytes, imageType: site.img.type, name: req.name, symbol: req.symbol, description: site.description, website: site.website, twitter: site.twitter, telegram: site.telegram })
    const holderReward = false

    // one live draft per account: an earlier one can no longer be signed
    db.prepare("UPDATE site_drafts SET state = 'expired' WHERE x_id = ? AND state = 'open'").run(String(user.x_id))
    const mintKp = issueKey(db, `site:${user.x_id}`)
    if (!mintKp) throw new SiteError('No token addresses are ready right now. Try again in a minute.', 503)
    const mint = mintKp.publicKey.toBase58()
    if (await conn.getAccountInfo(bondingCurveAddress(mintKp.publicKey), 'confirmed')) {
      db.prepare("UPDATE vanity SET state = 'burned' WHERE pubkey = ? AND state != 'launched'").run(mint)
      throw new SiteError('That did not go through. Press Launch again.', 503)
    }
    const fw = feeWallet(seed, mint).publicKey
    const ixs = await buildLaunchIxs({ conn, pump, launcher: launcher.publicKey, mint: mintKp.publicKey, feeWalletPk: fw, name: req.name, symbol: req.symbol, uri: pinned.uri, holderReward, devBuy: { user: buyer, lamports: req.devBuy.lamports } })
    // ⭐ the launcher pays the launch in the same transaction (all or nothing with the create and the buy)
    ixs.push(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: launcher.publicKey, lamports: fee }))
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([lut])
    const tx = new VersionedTransaction(message)
    let raw
    try { raw = tx.serialize() } catch { raw = null }
    if (!raw || raw.length > 1232) {
      log.error?.(`site launch: dev-buy transaction is ${raw?.length ?? 'over'} bytes (lookup table out of date? run scripts/make-launch-lut.mjs)`)
      throw new SiteError('Dev buys are switched off right now. Launch without one, and buy once it is live.', 503)
    }
    // Simulated before the wallet is asked: a launch that cannot land is never offered for signing.
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' })
    if (sim.value.err) {
      log.error?.(`site launch: simulation refused ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-4).join(' | ')}`)
      throw new SiteError('The launch could not be built just now. Nothing was sent. Try again in a moment.', 502)
    }
    const id = newId()
    const payload = { uri: pinned.uri, image, description: site.description, imageSource: site.img.source, holderReward, ownCreator: null, quote: null, devBuy: req.devBuy }
    const expiresAt = now() + DRAFT_SECONDS
    db.prepare(`INSERT INTO site_drafts (id, x_id, state, mint, wallet, lamports, message, last_valid_height, request, payload, created_at, expires_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(user.x_id), mint, req.devBuy.wallet, req.devBuy.lamports, Buffer.from(message.serialize()).toString('base64'), lastValidBlockHeight,
        JSON.stringify({ symbol: req.symbol, name: req.name, mode: 'creator', forId: req.forId, forHandle: req.forHandle, opts }), JSON.stringify(payload), now(), expiresAt)
    return { id, state: 'signing', kind: 'launch', mint, transaction: Buffer.from(raw).toString('base64'), wallet: req.devBuy.wallet, devBuySol: req.devBuy.lamports / 1e9, feeSol: fee / 1e9, expiresAt }
  }

  /**
   * The wallet's signed transaction comes back. Checked, co-signed by the launch wallet and the mint key, recorded, sent.
   * Returns at once with { id, state: 'launching', mint, signature }; `done` (not for the client) resolves when settled.
   */
  async function sign(_user, body) {
    if (!ready()) throw new SiteError('Launching is not set up yet.', 503)
    const d = db.prepare('SELECT * FROM site_drafts WHERE id = ?').get(String(body?.id ?? ''))
    if (!d) throw new SiteError('That launch was not found. Press Launch again.', 404)
    let user = walletUser(d.x_id)
    if (JSON.parse(d.payload).pay) return signPay(d, body)
    if (d.state !== 'open' || now() > d.expires_at) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)
    let tx
    try {
      const bytes = Buffer.from(String(body.transaction ?? ''), 'base64')
      if (!bytes.length || bytes.length > 1232) throw new Error('size')
      tx = VersionedTransaction.deserialize(bytes)
    } catch { throw new SiteError('The wallet returned something that is not a transaction. Nothing was sent.') }
    const original = VersionedMessage.deserialize(Buffer.from(d.message, 'base64'))
    const mintPk = new PublicKey(d.mint), buyer = new PublicKey(d.wallet)
    const lut = await launchLut().catch(() => null)
    const same = sameLaunch(original, tx.message, { lut, launcher: launcher.publicKey, mint: mintPk, buyer })
    if (!same.ok) {
      log.error?.(`site launch ${d.id}: wallet returned a different message (${same.reason})`)
      throw new SiteError('Your wallet changed the transaction, so it was not sent. Try again, or use another wallet.')
    }
    const message = tx.message.serialize()
    const at = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).findIndex((k) => k.equals(buyer))
    const buyerSig = at >= 0 ? tx.signatures[at] : null
    if (!signedBy(buyer, message, buyerSig)) throw new SiteError('The transaction was not signed by the connected wallet. Nothing was sent.')

    const request = JSON.parse(d.request)
    // the rules again, at the moment of sending: someone may have launched the ticker while the wallet prompt was open
    guard(user, request.symbol, { wait: false })
    if (inFlight(user.x_id)) throw new SiteError('Your previous launch is still going through. Give it a moment.', 409)
    if (await conn.getBlockHeight('confirmed') > d.last_valid_height) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)
    const key = db.prepare("SELECT secret FROM vanity WHERE pubkey = ? AND state = 'issued'").get(d.mint)
    if (!key) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)

    // ⛔ Our signatures LAST: only now do the launch wallet and the mint key sign, and the next thing that happens is the send.
    const out = new VersionedTransaction(tx.message)
    out.sign([launcher, Keypair.fromSecretKey(Buffer.from(key.secret, 'base64'))])
    out.addSignature(buyer, buyerSig)
    const raw = out.serialize(), signature = signatureOf(out)

    // ⛔ The claim and the launch row in one transaction, BEFORE the send: a draft is signed once, and from here on
    // bot.recover() can always ask the chain what happened.
    db.exec('BEGIN IMMEDIATE')
    try {
      if (db.prepare("UPDATE site_drafts SET state = 'used' WHERE id = ? AND state = 'open'").run(d.id).changes !== 1) throw new SiteError('That launch was already sent.', 409)
      insertMention({ id: d.id, user, req: request, opts: request.opts, state: 'launching',
        extra: { mint: d.mint, signature, lastValidHeight: d.last_valid_height, attempts: MAX_ATTEMPTS, payload: d.payload } })
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }

    const done = (async () => {
      const fate = await sendUntilFate(conn, { raw, signature, lastValidBlockHeight: d.last_valid_height })
      const row = db.prepare('SELECT * FROM mentions WHERE tweet_id = ?').get(d.id)
      if (row.state !== 'launching') return { outcome: row.state, mint: row.mint } // recover() got there first
      const res = await settleAttempt(db, conn, { mention: row, mint: d.mint, feeWalletPk: feeWallet(seed, d.mint).publicKey, signature, fate, payload: JSON.parse(d.payload), mode: 'creator', platform: false, log })
      log.info?.(`site launch ${d.id} $${request.symbol} with a ${d.lamports / 1e9} SOL dev buy: ${res.outcome}${res.error ? ` (${res.error})` : ''}`)
      return res
    })().catch((e) => { log.error?.(`site launch ${d.id}: ${e.message}`); return { outcome: 'unknown', error: e.message } })
    const result = { id: d.id, state: 'launching', mint: d.mint, signature }
    Object.defineProperty(result, 'done', { value: done, enumerable: false })
    return result
  }

  /** Where one of the account's own site launches stands. */
  function status(_user, id) {
    const m = db.prepare("SELECT * FROM mentions WHERE tweet_id = ? AND source = 'site'").get(String(id))
    if (m) {
      const reason = m.state === 'rejected' ? (m.reason ?? 'That one cannot launch.')
        // ⛔ split-failed: the coin IS live on Pumpfun (api/launch.mjs settleAttempt); never tell the launcher to try again
        : m.state === 'failed' ? (m.code === 'split-failed' && m.reason ? m.reason : 'The launch did not go through. Nothing was bought. Try again.') : null
      return { id: m.tweet_id, state: m.state, symbol: m.symbol, mint: m.state === 'launched' || m.state === 'launching' ? m.mint : null, signature: m.signature ?? null, reason }
    }
    const d = db.prepare('SELECT id, state, mint, expires_at, payload FROM site_drafts WHERE id = ?').get(String(id))
    if (!d) throw new SiteError('Not found', 404)
    const pay = JSON.parse(d.payload)
    if (d.state === 'used' && pay.pay) return { id: d.id, state: 'paying', mint: null, signature: pay.sig ?? null, reason: null }
    return { id: d.id, state: d.state === 'open' && now() <= d.expires_at ? 'signing' : 'expired', mint: null, signature: null, reason: null }
  }

  /**
   * The wallet signed its payment. Checked (our message, its signature), the rules again, then sent. ⛔ Written BEFORE the
   * send (draft 'used' + the signature), so a crash is found again by recoverPays; the launch is queued ONLY on 'landed'.
   */
  async function signPay(d, body) {
    if (d.state !== 'open' || now() > d.expires_at) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)
    let tx
    try {
      const b = Buffer.from(String(body.transaction ?? ''), 'base64')
      if (!b.length || b.length > 1232) throw new Error('size')
      tx = VersionedTransaction.deserialize(b)
    } catch { throw new SiteError('The wallet returned something that is not a transaction. Nothing was sent.') }
    const payer = new PublicKey(d.wallet)
    const same = sameLaunch(VersionedMessage.deserialize(Buffer.from(d.message, 'base64')), tx.message, { signers: [payer], protect: [] })
    if (!same.ok) throw new SiteError('Your wallet changed the transaction, so it was not sent. Try again, or use another wallet.')
    const sig = tx.signatures[0]
    if (!signedBy(payer, tx.message.serialize(), sig)) throw new SiteError('The transaction was not signed by the connected wallet. Nothing was sent.')
    const request = JSON.parse(d.request)
    const user = walletUser(d.wallet)
    guard(user, request.symbol, { wait: true })
    if (inFlight(user.x_id)) throw new SiteError('Your previous launch is still going through. Give it a moment.', 409)
    if (await conn.getBlockHeight('confirmed') > d.last_valid_height) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)
    const raw = tx.serialize(), signature = signatureOf(tx)
    if (db.prepare("UPDATE site_drafts SET state = 'used', payload = ? WHERE id = ? AND state = 'open'").run(JSON.stringify({ pay: true, fee: d.lamports, sig: signature }), d.id).changes !== 1) throw new SiteError('That launch was already sent.', 409)
    const f = await sendUntilFate(conn, { raw, signature, lastValidBlockHeight: d.last_valid_height })
    const out = settlePay(d.id, f.fate)
    return { id: d.id, state: out, signature }
  }

  /** A payment's fate → queue the launch (landed), give up (expired / failed: nothing was charged), or wait (unknown). */
  function settlePay(id, fate) {
    const d = db.prepare('SELECT * FROM site_drafts WHERE id = ?').get(id)
    const pay = JSON.parse(d.payload)
    if (fate === 'landed') {
      const request = JSON.parse(d.request)
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!db.prepare('SELECT 1 FROM mentions WHERE tweet_id = ?').get(id)) {
          insertMention({ id, user: walletUser(d.wallet), req: request, opts: { ...request.opts, fee: { payer: d.wallet, lamports: d.lamports, sig: pay.sig } }, state: 'queued' })
        }
        db.prepare('UPDATE site_drafts SET payload = ? WHERE id = ?').run(JSON.stringify({ ...pay, landed: true }), id)
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
      log.info?.(`site launch ${id}: paid ${d.lamports / 1e9} SOL from ${d.wallet}, queued`)
      return 'queued'
    }
    if (fate === 'expired' || fate === 'failed' || fate === 'rejected') {
      db.prepare("UPDATE site_drafts SET state = 'expired', payload = ? WHERE id = ?").run(JSON.stringify({ ...pay, failed: fate }), id)
      throw new SiteError('The payment did not go through, so nothing was charged. Press Launch again.', 409)
    }
    return 'paying'
  }

  /** Payments sent but not yet answered (a crash, a slow chain): asked again until the chain answers. */
  async function recoverPays() {
    for (const d of db.prepare("SELECT * FROM site_drafts WHERE state = 'used' AND mint = '' AND payload LIKE '%\"sig\"%' AND payload NOT LIKE '%\"landed\"%'").all()) {
      const pay = JSON.parse(d.payload)
      const f = await fateOf(conn, pay.sig, d.last_valid_height).catch(() => ({ fate: 'unknown' }))
      try { settlePay(d.id, f.fate) } catch { /* expired: nothing was charged */ }
    }
  }

  /**
   * ⛔ A launch that was paid for but ended failed or rejected is refunded to the wallet that paid (memory
   * refund-leftover-to-sender). The refund signature is written BEFORE the send; only a positive answer settles it.
   */
  async function refundFailed() {
    const rows = db.prepare("SELECT tweet_id, opts FROM mentions WHERE source = 'site' AND state IN ('failed', 'rejected') AND opts LIKE '%\"fee\"%'").all()
    for (const m of rows) {
      const opts = JSON.parse(m.opts)
      const fee = opts.fee
      if (!fee || fee.refunded) continue
      if (fee.refundSig) {
        const f = await fateOf(conn, fee.refundSig, fee.refundLvh).catch(() => ({ fate: 'unknown' }))
        if (f.fate === 'landed') fee.refunded = true
        else if (f.fate === 'expired' || f.fate === 'failed') { delete fee.refundSig; delete fee.refundLvh }
        db.prepare('UPDATE mentions SET opts = ? WHERE tweet_id = ?').run(JSON.stringify(opts), m.tweet_id)
        continue
      }
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: blockhash, instructions: [
        SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: new PublicKey(fee.payer), lamports: fee.lamports }),
      ] }).compileToV0Message())
      tx.sign([launcher])
      const signature = signatureOf(tx)
      fee.refundSig = signature; fee.refundLvh = lastValidBlockHeight
      db.prepare('UPDATE mentions SET opts = ? WHERE tweet_id = ?').run(JSON.stringify(opts), m.tweet_id)
      const f = await sendUntilFate(conn, { raw: tx.serialize(), signature, lastValidBlockHeight })
      if (f.fate === 'landed') { fee.refunded = true; log.info?.(`site launch ${m.tweet_id}: refunded ${fee.lamports / 1e9} SOL to ${fee.payer}`) }
      else if (f.fate === 'expired' || f.fate === 'failed') { delete fee.refundSig; delete fee.refundLvh }
      db.prepare('UPDATE mentions SET opts = ? WHERE tweet_id = ?').run(JSON.stringify(opts), m.tweet_id)
    }
  }

  return { options, check, submit, sign, status, launchLut, resolveFor, resolveRecipients, searchCharities, recoverPays, refundFailed }
}
