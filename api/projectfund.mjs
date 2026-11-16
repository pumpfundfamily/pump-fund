/**
 * ⭐ $FUND gives half of its creator rewards to SEAL (Security Alliance, securityalliance.org). Operator, 16 Nov 2026:
 * "SEAL works, automate it and make it all show on the website too, 50%".
 *
 * The operator creates $FUND on Pumpfun from their own wallet (the PROJECT wallet; api/official.mjs lists it). Then:
 *
 *   lock     once: Pumpfun fee sharing on $FUND with two shareholders, the project wallet (100% − bps) and SEAL's
 *            HOLDING wallet (bps, default 50%), locked for ever (update_fee_shares; Pumpfun allows it once). Signed by the
 *            project wallet's key (PROJECT_WALLET_KEY), the only thing that key is ever used for, plus forwarding
 *            SEAL's half of what was earned before the lock (Pumpfun pays that to the creator at the lock).
 *   split    every keeper pass: sweep + distribute (permissionless, the keeper pays the fee). Pumpfun pays both halves.
 *   donate   the holding wallet's balance above its rent goes to SEAL's own Solana address (SEAL_SOLANA_ADDRESS) once the
 *            operator has it from SEAL; until then it waits there and the site says so.
 *
 * The holding wallet is derived from FEE_SEED (like every coin's reward wallet): nothing extra to store or lose.
 * Every step is a public transaction, recorded in fund_events and shown on the $FUND page and /payouts.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'
import { createSharingConfigIx, readSharingConfig, sharingConfigAddress, updateSharesIx } from '../lib/feeshare.mjs'
import { feeWallet } from './feewallet.mjs'
import { kvGet, kvSet, now } from './db.mjs'
import { RENT_FLOOR } from './launch.mjs'
import { collectIxs, readCoin } from './keeper.mjs'
import { ENDAOMENT } from './sealbridge.mjs'
import { collectCreatorFeeIx, creatorVaultAddress } from '../lib/pump.mjs'

export const SEAL = {
  name: 'SEAL (Security Alliance)', short: 'SEAL', url: 'https://securityalliance.org', x: '_SEAL_Org',
  avatar: 'https://unavatar.io/x/_SEAL_Org',
  about: 'A nonprofit of security researchers that responds to live crypto hacks (SEAL 911) and tracks attacks, AI-driven ones included.',
}
export const DEFAULT_BPS = 5000
/** Below this a forward to SEAL is not worth a transaction. */
export const DONATE_MIN_LAMPORTS = 10_000_000

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
  return { bps, sealAddress, donateMin: Number(env.SEAL_DONATE_MIN_LAMPORTS ?? DONATE_MIN_LAMPORTS) }
}

/** SEAL's holding wallet for a mint: derived from FEE_SEED, so nothing is stored. */
export const sealHold = (seed, mint) => feeWallet(seed, `seal-hold:v1:${typeof mint === 'string' ? mint : mint.toBase58()}`)

/** The shareholders $FUND is locked with, in this order: project wallet, then SEAL's holding wallet. */
export const fundShareholders = (project, hold, bps) => [{ address: new PublicKey(project), bps: 10000 - bps }, { address: new PublicKey(hold), bps }]

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

const send = async (conn, payer, signers, ixs, priority = 100_000) => {
  const built = await buildTx(conn, { payer: payer.publicKey, signers: [payer, ...signers], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }), ...ixs] })
  const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
  return { ...f, signature: built.signature }
}
const record = (db, kind, signature, lamports, { total = null, destination = null } = {}) =>
  db.prepare('INSERT OR IGNORE INTO fund_events (kind, signature, lamports, total, destination, time) VALUES (?, ?, ?, ?, ?, ?)').run(kind, signature, lamports, total, destination, now())

/**
 * Locks $FUND's split. Idempotent, every step read back from the chain; kv `fund_lock` keeps { lockSig, interim, forwardSig }.
 * Returns { done } | { wait } | { failed } (failed = locked some other way: needs the operator, never retried).
 */
export async function lockFund({ db, conn, pump, mint, project, keeper, seed, bps, log = console }) {
  const m = new PublicKey(mint), hold = sealHold(seed, m).publicKey
  const want = fundShareholders(project.publicKey, hold, bps)
  let st = {}
  try { st = JSON.parse(kvGet(db, 'fund_lock') ?? '{}') } catch {}
  const save = () => kvSet(db, 'fund_lock', JSON.stringify(st))
  let cfg = await readSharingConfig(conn, m)
  const same = (c) => c && c.shareholders.length === want.length && c.shareholders.every((s, i) => s.address === want[i].address.toBase58() && s.bps === want[i].bps)
  if (cfg?.locked && !same(cfg)) return { failed: `$FUND's Pumpfun rewards are already locked to other shareholders: ${cfg.shareholders.map((s) => `${s.address} ${s.bps / 100}%`).join(', ')}` }
  if (!(cfg?.locked && same(cfg))) {
    // the holding wallet must exist before Pumpfun can pay it a small share (memory solana-rent-floor-deadlocks-pda-escrow)
    if ((await conn.getBalance(hold, 'confirmed')) < RENT_FLOOR) {
      const f = await send(conn, keeper, [], [SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: hold, lamports: RENT_FLOOR })])
      if (f.fate !== 'landed') return { wait: `funding SEAL's holding wallet: ${f.fate}` }
    }
    if (!cfg) {
      // ⭐ the project wallet pays the config's rent (Pumpfun's rule: the payer is the creator); the keeper pays the fee
      const f = await send(conn, keeper, [project], [await createSharingConfigIx(conn, { mint: m, creator: project.publicKey })])
      if (f.fate !== 'landed') return { wait: `turning on fee sharing: ${f.fate} ${f.error ?? ''}`.trim() }
      cfg = await readSharingConfig(conn, m)
      if (!cfg) return { wait: 'fee sharing not readable yet' }
    }
    if (cfg.locked && !same(cfg)) return { failed: 'locked to other shareholders' }
    if (!cfg.locked) {
      const current = cfg.shareholders.map((s) => new PublicKey(s.address))
      const f = await send(conn, keeper, [project], [await updateSharesIx(conn, { mint: m, authority: project.publicKey, shareholders: want, current })])
      if (f.fate !== 'landed') return { wait: `locking the split: ${f.fate} ${f.error ?? ''}`.trim() }
      st.lockSig = f.signature; save()
      log.info?.(`$FUND split locked: ${(10000 - bps) / 100}% project wallet, ${bps / 100}% SEAL (holding ${hold.toBase58()}) in ${f.signature}`)
    }
  }
  db.prepare('UPDATE tokens SET share_config = ? WHERE mint = ?').run(sharingConfigAddress(m).toBase58(), m.toBase58())
  // what $FUND earned before the lock: Pumpfun paid it to the CREATOR (the project wallet's own creator vault, which the
  // lock does not move; plus anything the lock itself paid out). It is collected to the project wallet (permissionless)
  // and SEAL's share goes to the holding wallet. ⛔ That vault holds every coin the wallet created: the operator launches
  // ONLY $FUND from it (keys/mainnet/project-wallet.key says so).
  if (st.lockSig && st.lockGain == null) {
    const g = await gainedIn(conn, st.lockSig, project.publicKey)
    if (g == null) return { wait: 'reading the lock transaction' }
    st.lockGain = Math.max(0, g); save()
  }
  if (st.lockSig && st.collectGain == null) {
    if (!st.collectSig) {
      const vault = await conn.getBalance(creatorVaultAddress(project.publicKey), 'confirmed')
      if (vault - RENT_FLOOR <= 0) { st.collectGain = 0; save() }
      else {
        const f = await send(conn, keeper, [], [await collectCreatorFeeIx(pump, project.publicKey)])
        if (f.fate !== 'landed') return { wait: `collecting the first rewards: ${f.fate} ${f.error ?? ''}`.trim() }
        st.collectSig = f.signature; save()
      }
    }
    if (st.collectSig) {
      const g = await gainedIn(conn, st.collectSig, project.publicKey)
      if (g == null) return { wait: 'reading the collect' }
      st.collectGain = Math.max(0, g); save()
    }
  }
  if (st.interim == null && st.lockGain != null && st.collectGain != null) { st.interim = st.lockGain + st.collectGain; save() }
  const part = Math.floor(((st.interim ?? 0) * bps) / 10000)
  if (part >= 10_000 && !st.forwarded) {
    if (!st.forwardSig) {
      const f = await send(conn, keeper, [project], [SystemProgram.transfer({ fromPubkey: project.publicKey, toPubkey: hold, lamports: part })])
      if (f.fate !== 'landed') return { wait: `forwarding SEAL's share of the first rewards: ${f.fate}` }
      st.forwardSig = f.signature; save()
    }
    record(db, 'interim', st.forwardSig, part, { total: st.interim, destination: hold.toBase58() })
    st.forwarded = true; save()
  }
  return { done: true, hold: hold.toBase58() }
}

/** One keeper pass for $FUND: lock if needed, split what waits, send SEAL's part on. Never throws. */
export async function fundPass({ db, conn, pump, keeper, seed, project = null, env = process.env, log = console }) {
  const mint = kvGet(db, 'platform_mint')
  if (!mint) return { idle: 'no project token yet' }
  let cfg
  try { cfg = fundConfig(env) } catch (e) { log.error?.(`$FUND split: ${e.message}`); return { error: e.message } }
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint)
  if (!t) return { idle: 'not listed' }
  const hold = sealHold(seed, mint)
  if (!t.share_config || kvGet(db, 'fund_lock_done') !== '1') {
    if (!project) return { wait: 'the project wallet key is not loaded (PROJECT_WALLET_KEY)' }
    if (project.publicKey.toBase58() !== t.fee_wallet) { log.error?.(`$FUND split: the key is ${project.publicKey.toBase58()}, but $FUND was created by ${t.fee_wallet}`); return { error: 'wrong project key' } }
    try {
      const r = await lockFund({ db, conn, pump, mint, project, keeper, seed, bps: cfg.bps, log })
      if (r.failed) { log.error?.(`$FUND split: ${r.failed}. Needs the operator.`); kvSet(db, 'fund_lock_error', r.failed); return r }
      if (!r.done) return r
      kvSet(db, 'fund_lock_done', '1')
    } catch (e) { log.error?.(`$FUND lock: ${e.message}`); return { wait: e.message } }
  }
  const out = {}
  // split: Pumpfun pays both halves (sweep + distribute, permissionless; the keeper pays the fee)
  try {
    const shareholders = fundShareholders(t.fee_wallet, hold.publicKey, cfg.bps).map((s) => ({ kind: 'wallet', address: s.address }))
    const coin = { ...db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint), shareholders }
    const r = await readCoin(conn, coin)
    if (r.pool && coin.pool !== r.pool.toBase58()) db.prepare('UPDATE tokens SET pool = ?, graduated = 1 WHERE mint = ?').run(r.pool.toBase58(), mint)
    const waiting = r.vault + r.ammVault + r.curveFee + r.poolFee
    if (waiting >= Number(env.MIN_COLLECT_LAMPORTS ?? 5_000_000)) {
      const f = await send(conn, keeper, [], await collectIxs(conn, pump, coin, r, keeper.publicKey))
      if (f.fate === 'landed') {
        const g = await gainedIn(conn, f.signature, hold.publicKey)
        const got = Math.max(0, g ?? Math.floor((waiting * cfg.bps) / 10000))
        if (got > 0) record(db, 'split', f.signature, got, { total: waiting })
        out.split = f.signature
      } else log.error?.(`$FUND split ${f.fate} ${f.error ?? ''}`)
    }
  } catch (e) { log.error?.(`$FUND split: ${e.message}`) }
  // donate: the holding wallet above its rent → SEAL's own address
  try {
    if (cfg.sealAddress) {
      const bal = await conn.getBalance(hold.publicKey, 'confirmed')
      const amount = bal - RENT_FLOOR
      if (amount >= cfg.donateMin) {
        const f = await send(conn, keeper, [hold], [SystemProgram.transfer({ fromPubkey: hold.publicKey, toPubkey: cfg.sealAddress, lamports: amount })])
        if (f.fate === 'landed') { record(db, 'donated', f.signature, amount, { destination: cfg.sealAddress.toBase58() }); out.donated = amount; log.info?.(`$FUND: ${amount / 1e9} SOL donated to SEAL in ${f.signature}`) }
        else log.error?.(`$FUND donation ${f.fate} ${f.error ?? ''}`)
      }
    }
  } catch (e) { log.error?.(`$FUND donation: ${e.message}`) }
  return out
}

/** The figures the site shows for $FUND's SEAL half. */
export function fundView(db, seed, env = process.env) {
  const mint = kvGet(db, 'platform_mint')
  if (!mint || !seed) return null
  let cfg
  try { cfg = fundConfig(env) } catch { return null }
  const t = db.prepare('SELECT fee_wallet, share_config FROM tokens WHERE mint = ?').get(mint)
  if (!t) return null
  const sum = (kind) => db.prepare('SELECT COALESCE(SUM(lamports), 0) l FROM fund_events WHERE kind = ?').get(kind).l
  const br = db.prepare("SELECT COALESCE(SUM(CASE WHEN state = 'done' THEN lamports END), 0) done, COALESCE(SUM(CASE WHEN state = 'done' THEN usdc END), 0) usdc, COALESCE(SUM(CASE WHEN state IN ('bridging', 'donating') THEN lamports END), 0) moving FROM seal_bridges").get()
  const earned = sum('interim') + sum('split'), donated = sum('donated') + br.done
  return {
    bps: cfg.bps, locked: kvGet(db, 'fund_lock_done') === '1', projectWallet: t.fee_wallet, holdWallet: sealHold(seed, mint).publicKey.toBase58(),
    sealAddress: cfg.sealAddress?.toBase58() ?? null, shareConfig: t.share_config ?? null,
    // ⭐ how it reaches SEAL: its own Solana address when it has given one, else Endaoment on Base (api/sealbridge.mjs)
    route: cfg.sealAddress ? 'solana' : 'endaoment', endaoment: cfg.sealAddress ? null : { org: ENDAOMENT.org, url: ENDAOMENT.url, chain: 'Base' },
    earned: earned / 1e9, donated: donated / 1e9, donatedUsd: br.usdc / 1e6, moving: br.moving / 1e9, waiting: Math.max(0, earned - donated - br.moving) / 1e9, seal: SEAL,
  }
}
