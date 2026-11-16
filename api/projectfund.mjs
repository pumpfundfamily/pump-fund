/**
 * ⭐ $FUND gives half of its creator rewards to SEAL (Security Alliance, securityalliance.org). Operator, 16 Nov 2026:
 * "SEAL works, automate it and make it all show on the website too, 50%", then: "when we launch my wallet stays the 100%
 * recipient of fees and we just handle it from my wallet".
 *
 * The operator creates $FUND on Pumpfun from their own wallet, the TEAM wallet (api/official.mjs lists it). It stays
 * $FUND's only Pumpfun creator: nothing is set up or locked on Pumpfun. Every keeper pass:
 *
 *   collect  $FUND's creator rewards (curve or PumpSwap, swept first) → the team wallet. Permissionless: the keeper sends
 *            and pays the fee, so what the team wallet gained in that transaction is exactly the rewards.
 *   move     bps (default 50%) of everything collected, minus what was already moved → SEAL's HOLDING wallet, signed by the
 *            team wallet's key (PROJECT_WALLET_KEY, kept on the box for this). The keeper pays the fee.
 *   donate   the holding wallet → SEAL: its own Solana address if SEAL ever gives one (SEAL_SOLANA_ADDRESS), else through
 *            Endaoment on Base (api/sealbridge.mjs).
 *
 * ⛔ Every transfer is written down BEFORE it is sent (kv fund_pending) and settled from the chain after: a crash between
 *    a transfer landing and its record can never send SEAL's share twice, nor lose a collect.
 * ⛔ The creator vault is per WALLET: the team wallet launches only $FUND. A claim made by hand on Pumpfun would bypass
 *    this (the operator is told not to; the keeper collects every 5 minutes anyway).
 * The holding wallet is derived from FEE_SEED. Every step is a public transaction, recorded in fund_events and shown on
 * the $FUND page and /payouts.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js'
import { buildTx, fateOf, sendUntilFate } from '../lib/tx.mjs'
import { feeWallet } from './feewallet.mjs'
import { kvGet, kvSet, now } from './db.mjs'
import { RENT_FLOOR } from './launch.mjs'
import { collectIxs, readCoin } from './keeper.mjs'
import { ENDAOMENT } from './sealbridge.mjs'

export const SEAL = {
  name: 'SEAL (Security Alliance)', short: 'SEAL', url: 'https://securityalliance.org', x: '_SEAL_Org',
  avatar: 'https://unavatar.io/x/_SEAL_Org',
  about: 'A nonprofit of security researchers that responds to live crypto hacks (SEAL 911) and tracks attacks, AI-driven ones included.',
}
export const DEFAULT_BPS = 5000
/** Below this a forward to SEAL's own address is not worth a transaction. */
export const DONATE_MIN_LAMPORTS = 10_000_000
/** Below this SEAL's share waits for the next collect (a transfer this small is mostly fee). */
export const MOVE_MIN_LAMPORTS = 100_000

export function fundConfig(env = process.env) {
  const bps = Number(env.PROJECT_DONATION_BPS ?? DEFAULT_BPS)
  if (!Number.isInteger(bps) || bps <= 0 || bps >= 10000) throw new Error('PROJECT_DONATION_BPS must be 1..9999')
  let sealAddress = null
  if (env.SEAL_SOLANA_ADDRESS) {
    const pk = new PublicKey(String(env.SEAL_SOLANA_ADDRESS).trim())
    // ⛔ an off-curve address is a program account, never a person's wallet (memory address-typo-lost-funds)
    if (!PublicKey.isOnCurve(pk.toBytes())) throw new Error('SEAL_SOLANA_ADDRESS is not a wallet address (off curve)')
    sealAddress = pk
  }
  return { bps, sealAddress, donateMin: Number(env.SEAL_DONATE_MIN_LAMPORTS ?? DONATE_MIN_LAMPORTS), collectMin: Number(env.MIN_COLLECT_LAMPORTS ?? 5_000_000), moveMin: Number(env.SEAL_MOVE_MIN_LAMPORTS ?? MOVE_MIN_LAMPORTS) }
}

/** SEAL's holding wallet for a mint: derived from FEE_SEED, so nothing is stored. */
export const sealHold = (seed, mint) => feeWallet(seed, `seal-hold:v1:${typeof mint === 'string' ? mint : mint.toBase58()}`)

/** What `address` gained in transaction `signature` (post − pre), read from the chain; null while not readable yet. */
export async function gainedIn(conn, signature, address) {
  for (let i = 0; i < 10; i++) {
    const tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)
    if (tx?.meta) {
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
      for (let k = 0; k < keys.length; k++) if (keys.get(k).equals(new PublicKey(address))) return tx.meta.postBalances[k] - tx.meta.preBalances[k]
      return 0
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

const build = (conn, payer, signers, ixs) => buildTx(conn, { payer: payer.publicKey, signers: [payer, ...signers], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...ixs] })
const record = (db, kind, signature, lamports, { total = null, destination = null } = {}) =>
  db.prepare('INSERT OR IGNORE INTO fund_events (kind, signature, lamports, total, destination, time) VALUES (?, ?, ?, ?, ?, ?)').run(kind, signature, lamports, total, destination, now())
const sum = (db, kind) => db.prepare('SELECT COALESCE(SUM(lamports), 0) l FROM fund_events WHERE kind = ?').get(kind).l
/** SEAL's share of everything collected that has not been moved to its holding wallet yet. */
export const sealOwed = (db, bps) => Math.floor((sum(db, 'collect') * bps) / 10000) - sum(db, 'moved')

/**
 * The one transfer in flight (kv fund_pending = { kind, signature, lvh, lamports, destination }): settled from the chain.
 * Returns true when nothing is pending any more (it landed and was recorded, or it can never land).
 */
async function settlePending(db, conn, project, log) {
  const p = JSON.parse(kvGet(db, 'fund_pending') ?? 'null')
  if (!p) return true
  const f = await fateOf(conn, p.signature, p.lvh)
  if (f.fate === 'unknown') return false
  if (f.fate === 'landed') {
    if (p.kind === 'collect') {
      const g = await gainedIn(conn, p.signature, project)
      if (g == null) return false
      if (g > 0) record(db, 'collect', p.signature, g)
    } else record(db, p.kind, p.signature, p.lamports, { destination: p.destination })
  } else log.info?.(`$FUND ${p.kind} ${p.signature.slice(0, 8)} ${f.fate}: nothing moved`)
  db.prepare("DELETE FROM kv WHERE k = 'fund_pending'").run()
  return true
}
async function sendTracked(db, conn, kind, built, extra = {}) {
  kvSet(db, 'fund_pending', JSON.stringify({ kind, signature: built.signature, lvh: built.lastValidBlockHeight, ...extra })) // before the send
  await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
}

/** One keeper pass for $FUND: collect, move SEAL's share, donate to SEAL's own address if it has one. Never throws. */
export async function fundPass({ db, conn, pump, keeper, seed, project = null, env = process.env, log = console }) {
  const mint = kvGet(db, 'platform_mint')
  if (!mint) return { idle: 'no project token yet' }
  let cfg
  try { cfg = fundConfig(env) } catch (e) { log.error?.(`$FUND: ${e.message}`); return { error: e.message } }
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint)
  if (!t) return { idle: 'not listed' }
  if (!project) { log.error?.('$FUND: the team wallet key is not loaded (PROJECT_WALLET_KEY): SEAL\'s share cannot be moved'); return { wait: 'the team wallet key is not loaded (PROJECT_WALLET_KEY)' } }
  if (project.publicKey.toBase58() !== t.fee_wallet) { log.error?.(`$FUND: the key is ${project.publicKey.toBase58()}, but $FUND was created by ${t.fee_wallet}`); return { error: 'wrong project key' } }
  const hold = sealHold(seed, mint)
  const out = {}
  try {
    if (!(await settlePending(db, conn, project.publicKey, log))) return { wait: 'a transfer is confirming' }
    // collect: the rewards waiting for the team wallet (curve or PumpSwap) → the team wallet
    const coin = { ...t, share_config: null }
    const r = await readCoin(conn, coin)
    if (r.pool && coin.pool !== r.pool.toBase58()) db.prepare('UPDATE tokens SET pool = ?, graduated = 1 WHERE mint = ?').run(r.pool.toBase58(), mint)
    const waiting = r.vault + r.ammVault + r.curveFee + r.poolFee
    if (waiting >= cfg.collectMin) {
      await sendTracked(db, conn, 'collect', await build(conn, keeper, [], await collectIxs(conn, pump, coin, r, keeper.publicKey)))
      if (!(await settlePending(db, conn, project.publicKey, log))) return { wait: 'the collect is confirming' }
      out.collected = true
    }
    // move: SEAL's share of everything collected, from the team wallet to SEAL's holding wallet
    const owed = sealOwed(db, cfg.bps)
    if (owed >= cfg.moveMin) {
      // the holding wallet must exist before a small transfer can land in it (memory solana-rent-floor-deadlocks-pda-escrow)
      if ((await conn.getBalance(hold.publicKey, 'confirmed')) < RENT_FLOOR) {
        const b = await build(conn, keeper, [], [SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: hold.publicKey, lamports: RENT_FLOOR })])
        const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
        if (f.fate !== 'landed') return { ...out, wait: `opening SEAL's holding wallet: ${f.fate}` }
      }
      const bal = await conn.getBalance(project.publicKey, 'confirmed')
      if (bal < owed + RENT_FLOOR) { log.error?.(`$FUND: the team wallet holds ${bal / 1e9} SOL, less than SEAL's share ${owed / 1e9} SOL. Needs the operator.`); return { ...out, wait: 'the team wallet holds less than SEAL\'s share' } }
      await sendTracked(db, conn, 'moved', await build(conn, keeper, [project], [SystemProgram.transfer({ fromPubkey: project.publicKey, toPubkey: hold.publicKey, lamports: owed })]), { lamports: owed, destination: hold.publicKey.toBase58() })
      if (!(await settlePending(db, conn, project.publicKey, log))) return { ...out, wait: 'the move is confirming' }
      out.moved = owed
    }
    // donate to SEAL's own Solana address, when SEAL has given one (else the Endaoment route takes it: api/sealbridge.mjs)
    if (cfg.sealAddress) {
      const amount = (await conn.getBalance(hold.publicKey, 'confirmed')) - RENT_FLOOR
      if (amount >= cfg.donateMin) {
        await sendTracked(db, conn, 'donated', await build(conn, keeper, [hold], [SystemProgram.transfer({ fromPubkey: hold.publicKey, toPubkey: cfg.sealAddress, lamports: amount })]), { lamports: amount, destination: cfg.sealAddress.toBase58() })
        if (await settlePending(db, conn, project.publicKey, log)) { out.donated = amount; log.info?.(`$FUND: ${amount / 1e9} SOL donated to SEAL`) }
      }
    }
  } catch (e) { log.error?.(`$FUND pass: ${e.message}`); out.error = e.message }
  return out
}

/** The figures the site shows for $FUND's SEAL half. */
export function fundView(db, seed, env = process.env) {
  const mint = kvGet(db, 'platform_mint')
  if (!mint || !seed) return null
  let cfg
  try { cfg = fundConfig(env) } catch { return null }
  const t = db.prepare('SELECT fee_wallet FROM tokens WHERE mint = ?').get(mint)
  if (!t) return null
  const br = db.prepare("SELECT COALESCE(SUM(CASE WHEN state = 'done' THEN lamports END), 0) done, COALESCE(SUM(CASE WHEN state = 'done' THEN usdc END), 0) usdc, COALESCE(SUM(CASE WHEN state IN ('bridging', 'donating') THEN lamports END), 0) moving FROM seal_bridges").get()
  const earned = Math.floor((sum(db, 'collect') * cfg.bps) / 10000), donated = sum(db, 'donated') + br.done
  return {
    bps: cfg.bps, projectWallet: t.fee_wallet, holdWallet: sealHold(seed, mint).publicKey.toBase58(), sealAddress: cfg.sealAddress?.toBase58() ?? null,
    // ⭐ how it reaches SEAL: its own Solana address when it has given one, else Endaoment on Base (api/sealbridge.mjs)
    route: cfg.sealAddress ? 'solana' : 'endaoment', endaoment: cfg.sealAddress ? null : { org: ENDAOMENT.org, url: ENDAOMENT.url, chain: 'Base' },
    earned: earned / 1e9, donated: donated / 1e9, donatedUsd: br.usdc / 1e6, moving: br.moving / 1e9, waiting: Math.max(0, earned - donated - br.moving) / 1e9, seal: SEAL,
  }
}
