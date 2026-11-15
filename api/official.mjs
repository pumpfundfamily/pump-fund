/**
 * ⭐ The project token, launched by the OPERATOR on Pumpfun itself (operator 15 Nov: "I will be launching with wallet
 * cashc…; make sure it is picked up automatically; when I launch, launches should become enabled").
 *
 * PLATFORM_WALLET is watched. The first Pumpfun create that wallet SIGNS with the project ticker (PROJECT_TICKER, $FUND)
 * is the project token: it is listed here (operator's own coin: its creator rewards are the operator's on Pumpfun, the
 * keeper never touches it) and launching OPENS in the same database transaction (api/launch.mjs recordLaunch).
 *
 * ⛔ Rules this keeps (each learned the hard way elsewhere):
 *   - the wallet must have SIGNED the create: an address index also lists transactions that merely mention it (someone
 *     else creating a coin "for" that wallet, a transfer to it). Memory watcher-must-check-signer.
 *   - Pumpfun's own site sends version-1 transactions, which @solana/web3.js cannot read: raw `getTransaction` with
 *     maxSupportedTransactionVersion 1. Memory pumpfun-create-arrives-as-v1-tx.
 *   - never by ticker alone (anyone can launch a $FUND): signer AND ticker. Another coin from the wallet is ignored.
 *   - only what happens AFTER the watch starts counts: the newest signature at the first pass is the starting line (no
 *     clocks compared), so nothing in the wallet's history can open launching.
 *   - one cheap indexed read per pass, and it stops for good once the token is found (memory dont-waste-paid-api-credits).
 */
import bs58 from 'bs58'
import { BorshCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { PUMP, bondingCurveAddress, curveCreator } from '../lib/pump.mjs'
import { kvGet, kvSet, now, launchingOpen } from './db.mjs'
import { recordLaunch } from './launch.mjs'
import { storeImage } from './images.mjs'
import { PLATFORM_ROW_ID } from './platform-launch.mjs'

// the newer interface: it names every create instruction Pumpfun has (create, create_v2)
const idl = JSON.parse(readFileSync(new URL('../lib/pump-sweep.idl.json', import.meta.url)))
const coder = new BorshCoder(idl)
const CREATES = new Map(idl.instructions.filter((i) => /^create(_v\d+)?$/.test(i.name)).map((i) => [Buffer.from(i.discriminator).toString('hex'), i.name]))
export const normTicker = (s) => String(s ?? '').trim().replace(/^\$/, '').toUpperCase()

/**
 * { mint, name, symbol, uri, via, signature } when the jsonParsed transaction `tx` succeeded, was SIGNED by `wallet` and
 * holds a Pumpfun create (top level or inner); else null.
 */
export function pumpCreateBy(tx, wallet) {
  const keys = tx?.transaction?.message?.accountKeys ?? []
  if (!tx || tx.meta?.err || !keys.some((k) => (k.pubkey ?? k) === wallet && k.signer === true)) return null
  const all = [...(tx.transaction.message.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions ?? [])]
  for (const ix of all) {
    if (ix.programId !== PUMP.toBase58() || typeof ix.data !== 'string' || !ix.accounts?.length) continue
    let d
    try { d = Buffer.from(bs58.decode(ix.data)) } catch { continue }
    const via = CREATES.get(d.subarray(0, 8).toString('hex'))
    if (!via) continue
    let args = {}
    try { args = coder.instruction.decode(d)?.data ?? {} } catch { /* a newer argument layout: the mint is still the first account */ }
    return { mint: ix.accounts[0], name: args.name ?? null, symbol: args.symbol ?? null, uri: args.uri ?? null, via, signature: tx.transaction.signatures[0] }
  }
  return null
}

const rawTx = async (conn, signature) => (await conn._rpcRequest('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]))?.result ?? null

/** Lists `hit` (a pumpCreateBy result) as the project token and opens launching. Idempotent. */
export async function goLive(db, conn, hit, { wallet, env = process.env, publicUrl, logoDir, log = console }) {
  const mint = new PublicKey(hit.mint)
  const curve = await conn.getAccountInfo(bondingCurveAddress(mint), 'confirmed')
  if (!curve || !curve.owner.equals(PUMP)) throw new Error(`${hit.mint} has no Pumpfun curve yet`)
  // whoever Pumpfun pays its creator rewards to (the operator's wallet, unless the operator set something else up)
  const creator = curveCreator(curve.data) ?? new PublicKey(wallet)
  const ticker = normTicker(hit.symbol || env.PROJECT_TICKER), name = String(hit.name || env.PROJECT_NAME || ticker)
  const handle = String(env.X_HANDLE ?? '').replace(/^@/, '')
  const image = storeImage({ logoDir, publicUrl }, readFileSync(new URL('./assets/project-token.png', import.meta.url)))
  const description = `Launch Pumpfun tokens whose creator rewards fund people and good causes. ${publicUrl.replace(/^https?:\/\//, '')}`
  // ⛔ written as 'launched' at once: a 'queued' platform row would be LAUNCHED by the queue (a second $FUND)
  db.prepare(`INSERT OR IGNORE INTO mentions (tweet_id, author_id, author_handle, text, url, tweeted_at, seen_at, updated_at, state, symbol, name, mode, platform, venue, source, reply_state, mint, signature, launched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'launched', ?, ?, 'creator', 1, 'pump', 'site', 'skipped', ?, ?, ?)`)
    .run(PLATFORM_ROW_ID, String(env.PLATFORM_X_ID || 'platform'), handle || 'pumpfund', `project token $${ticker} ${name}, launched on Pumpfun by ${wallet}`, handle ? `https://x.com/${handle}` : '', now(), now(), now(), ticker, name, hit.mint, hit.signature, now())
  const mention = db.prepare('SELECT * FROM mentions WHERE tweet_id = ?').get(PLATFORM_ROW_ID)
  if (mention.mint !== hit.mint) throw new Error(`the project token is already ${mention.mint}`)
  recordLaunch(db, { mention, mint: hit.mint, feeWalletPk: creator, signature: hit.signature, uri: hit.uri, image, description, mode: 'creator', platform: true, ownCreator: true })
  log.info?.(`PROJECT TOKEN $${ticker} "${name}" found: ${hit.mint} (created by ${wallet} in ${hit.signature}). Launching is ${launchingOpen(db) ? 'OPEN' : 'STILL CLOSED'}.`)
  return { mint: hit.mint, ticker, name }
}

/**
 * One pass: reads the wallet's new transactions (oldest first) and goes live on the first create it signed with the
 * project ticker. Returns { done, mint? } | { waiting, checked }. Safe to repeat; a failure leaves the cursor where it was.
 */
export async function watchOfficial({ db, conn, wallet, env = process.env, publicUrl, logoDir, log = console }) {
  const have = kvGet(db, 'platform_mint')
  if (have) return { done: true, mint: have }
  const ticker = normTicker(env.PROJECT_TICKER)
  if (!ticker) return { waiting: 'PROJECT_TICKER is not set', checked: 0 }
  const address = new PublicKey(wallet)
  if (!kvGet(db, 'official_watch_from')) {
    // the starting line: whatever is already in the wallet's history is never looked at
    const newest = (await conn.getSignaturesForAddress(address, { limit: 1 }))[0]?.signature ?? ''
    kvSet(db, 'official_cursor', newest); kvSet(db, 'official_watch_from', newest || 'start')
    log.info?.(`watching ${wallet} for the Pumpfun create of $${ticker} (after ${newest ? newest.slice(0, 12) + '…' : 'its first transaction'})`)
    return { waiting: 'started', checked: 0 }
  }
  const cursor = kvGet(db, 'official_cursor') || null
  const sigs = (await conn.getSignaturesForAddress(address, { limit: 100, ...(cursor ? { until: cursor } : {}) })).reverse()
  let checked = 0
  for (const s of sigs) {
    if (!s.err) {
      const tx = await rawTx(conn, s.signature)
      if (!tx) return { waiting: 'a transaction is not readable yet', checked } // asked again next pass, cursor unchanged
      const hit = pumpCreateBy(tx, wallet)
      if (hit && normTicker(hit.symbol) === ticker) return { done: true, ...(await goLive(db, conn, hit, { wallet, env, publicUrl, logoDir, log })) }
      if (hit) log.info?.(`${wallet} created $${hit.symbol ?? '?'} (${hit.mint}): not $${ticker}, ignored`)
    }
    kvSet(db, 'official_cursor', s.signature)
    checked++
  }
  return { waiting: `no $${ticker} yet`, checked }
}

/** Runs watchOfficial until the token is found: every `fastSeconds` for the first three days, then every minute. */
export function startOfficialWatch(opts, { fastSeconds = 20 } = {}) {
  const started = Date.now()
  let timer = null, stopped = false
  const loop = async () => {
    if (stopped) return
    let r = null
    try { r = await watchOfficial(opts) } catch (e) { opts.log?.error?.(`project token watch: ${e.message}`) }
    if (r?.done) return
    timer = setTimeout(loop, (Date.now() - started < 3 * 86400_000 ? fastSeconds : 60) * 1000)
    timer.unref?.()
  }
  loop()
  return () => { stopped = true; clearTimeout(timer) }
}
