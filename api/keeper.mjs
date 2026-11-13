/**
 * The keeper. Per coin, each pass:
 *
 *   settle    every 'sending' outflow gets the chain's answer (landed → spent, expired/failed → released)
 *   collect   [pool sweep → transfer_creator_fees_to_pump] → [curve sweep] → collect_creator_fee: pump.fun's creator fees
 *             move into the coin's fee wallet. All permissionless; the keeper pays the transaction fee.
 *   credit    whatever the fee wallet holds above   rent floor + creator bucket + holders bucket   is new money, booked to
 *             the coin's mode NOW. Skipped while any outflow of that coin is unanswered (its SOL may or may not have left).
 *   auto-pay  creator buckets → the creator's saved wallet / FOMO wallet, once their total passes their threshold
 *   airdrop   a holders bucket past HOLDERS_MIN_LAMPORTS (or a day old and past HOLDERS_DUST_LAMPORTS) → pro rata to holders
 *
 * Fee wallets only ever move credited SOL out; the keeper's own wallet pays every transaction fee, so the buckets add up
 * to the lamport.
 *
 * ⛔ pump.fun's new trades keep creator fees ON the curve / pool until swept (memory pumpfun-fees-kept-until-swept): the
 * creator vault reads empty until then, so the sweeps come first.
 *
 * ⭐ PAIRED COINS (11 Nov): a coin paired with token Q earns its creator fees in Q. The same steps run on Q: the fee
 * wallet's Q token account (opened by the keeper) is the balance, credits/outflows hold Q units, payouts are Q transfers
 * to the creator's wallet. Holders airdrops stay SOL-only: a paired coin's holders are paid by pump.fun (holder rewards).
 */
import { AnchorProvider, Program } from '@coral-xyz/anchor'
import { isOurs } from './rails.mjs'
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token'
import {
  WSOL, ammCreatorVaultAuthority, ata, bondingCurveAddress, collectCreatorFeeIx, creatorVaultAddress, curveCreator,
  curveCreatorFeeWaiting, decodePool, poolCreatorFeesWaiting, pumpAmmIdl, sweepCurveCreatorFeeIx, sweepPoolCreatorFeeIx,
  POOL_INDEXES, poolAddress, TOKEN_2022, tokenAccountAmount, collectCreatorFeeV2Ix, collectCoinCreatorFeeIx, sweepCurveCreatorFeeQIx,
  sweepPoolCreatorFeeQIx,
} from '../lib/pump.mjs'
import { buildTx, sendUntilFate, fateOf } from '../lib/tx.mjs'
import { feeWallet } from './feewallet.mjs'
import { buckets, lockCoin, unlockCoin, now, owedAssets, mintsOf, shareOf, sharesOf, ledgerShares, splitAmount } from './db.mjs'
import { crankDonationIx, createSocialIx, distributeIx, shareholderAddress } from '../lib/feeshare.mjs'
import { tokenUsd } from './market.mjs'
import { RENT_FLOOR } from './launch.mjs'
import { collectFloat } from './floatkeeper.mjs'

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

export function keeperConfig(env = process.env) {
  return {
    minCollect: Number(env.MIN_COLLECT_LAMPORTS ?? 3_000_000),
    holdersMin: Number(env.HOLDERS_MIN_LAMPORTS ?? 50_000_000),
    holdersDust: Number(env.HOLDERS_DUST_LAMPORTS ?? 10_000_000),
    holderMinTokens: BigInt(env.HOLDER_MIN_TOKENS ?? 100_000) * 1_000_000n, // 0.01% of 1B
    maxHolders: Number(env.MAX_HOLDERS ?? 100),
    minShare: Number(env.MIN_SHARE_LAMPORTS ?? 10_000),
    batch: Number(env.AIRDROP_BATCH ?? 14),
    payoutCoinsPerTx: 6,
    priority: Number(env.PRIORITY_MICROLAMPORTS ?? 50_000),
    // paired coins: no SOL value to compare against, so a collect runs at most this often per coin (each costs a tx fee)
    collectQSeconds: Number(env.COLLECT_Q_SECONDS ?? 3600),
    // paired coins: auto-pay sends each token at most this often per creator (a new token account costs ~0.002 SOL)
    autoPayQSeconds: Number(env.AUTOPAY_Q_SECONDS ?? 86_400),
    // a coin's charity account is forwarded to the charity once it holds this much above its rent (each forward costs a fee)
    donationMin: Number(env.DONATION_MIN_LAMPORTS ?? 10_000_000),
  }
}

const ammProgram = new WeakMap()
function amm(conn) {
  let p = ammProgram.get(conn)
  if (!p) { p = new Program(pumpAmmIdl, new AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, {})); ammProgram.set(conn, p) }
  return p
}

/** What waits for one coin, in lamports, from one batched read. */
export async function readCoin(conn, coin) {
  const fw = new PublicKey(coin.fee_wallet), mint = new PublicKey(coin.mint)
  const pools = coin.pool ? [new PublicKey(coin.pool)] : (coin.graduated ? POOL_INDEXES.map((i) => poolAddress(mint, undefined, i)) : [])
  // ⭐ a natively split coin's Pumpfun creator is its sharing config: its vaults are the config's, the wallet is still ours
  const creator = coin.share_config ? new PublicKey(coin.share_config) : fw
  const keys = [fw, creatorVaultAddress(creator), ata(ammCreatorVaultAuthority(creator), WSOL, TOKEN), bondingCurveAddress(mint), ...pools]
  const infos = await conn.getMultipleAccountsInfo(keys, 'confirmed')
  const [w, vault, ammVault, curve] = infos
  let pool = null, poolData = null, poolFee = 0
  for (let i = 0; i < pools.length; i++) {
    const info = infos[4 + i]
    if (!info || info.data.length < 200) continue
    try { if (decodePool(info.data).coin_creator.equals(creator)) { pool = pools[i]; poolData = info.data; poolFee = Number(poolCreatorFeesWaiting(info.data)); break } } catch {}
  }
  return {
    wallet: w?.lamports ?? 0,
    vault: Math.max(0, (vault?.lamports ?? 0) - RENT_FLOOR),
    ammVault: ammVault ? Number(ammVault.data.readBigUInt64LE(64)) : 0,
    curveFee: curve && curveCreator(curve.data)?.equals(creator) ? Number(curveCreatorFeeWaiting(curve.data)) : 0,
    poolFee, pool, poolData,
  }
}

/** The collect transaction's instructions for one coin (nothing if nothing waits). */
export async function collectIxs(conn, pump, coin, r, payer) {
  const fw = new PublicKey(coin.fee_wallet), mint = new PublicKey(coin.mint)
  const creator = coin.share_config ? new PublicKey(coin.share_config) : fw
  const ixs = []
  if (r.poolFee > 0) ixs.push(await sweepPoolCreatorFeeIx(conn, { pool: r.pool, poolData: r.poolData, payer, creator }))
  if (r.ammVault > 0 || r.poolFee > 0) ixs.push(await amm(conn).methods.transferCreatorFeesToPump().accountsPartial({ wsolMint: WSOL, tokenProgram: TOKEN, coinCreator: creator, pumpCreatorVault: creatorVaultAddress(creator) }).instruction())
  if (r.curveFee > 0) ixs.push(await sweepCurveCreatorFeeIx(conn, { mint, payer, creator }))
  if (!(ixs.length || r.vault > 0)) return ixs
  if (!coin.share_config) { ixs.push(await collectCreatorFeeIx(pump, fw)); return ixs }
  // ⭐ a natively split coin: Pumpfun pays every shareholder its share (ours is the coin's reward wallet). A GitHub
  // account that was never opened is opened first: a small share cannot land on an address that does not exist yet.
  const holders = coin.shareholders ?? []
  const infos = await conn.getMultipleAccountsInfo(holders.map((h) => h.address), 'confirmed')
  const open = []
  for (let i = 0; i < holders.length; i++) if (holders[i].kind === 'github' && (!infos[i] || infos[i].owner.equals(SystemProgram.programId))) open.push(await createSocialIx(conn, { payer, githubId: holders[i].id }))
  return [...open, ...ixs, await distributeIx(pump, { mint, shareholders: holders.map((h) => h.address) })]
}

/** Books new SOL in the coin's fee wallet to its mode. Returns the lamports credited (0 if none or blocked). */
export function creditSurplus(db, coin, walletLamports, { signature = null, solUsd = null } = {}) {
  if (db.prepare("SELECT 1 FROM outflows WHERE mint = ? AND state = 'sending'").get(coin.mint)) return 0
  const b = buckets(db, coin.mint)
  const surplus = walletLamports - RENT_FLOOR - b.creator - b.holders
  if (surplus <= 0) return 0
  const mode = db.prepare('SELECT mode FROM tokens WHERE mint = ?').get(coin.mint).mode
  bookCredit(db, coin.mint, mode, surplus, signature, solUsd)
  if (solUsd > 0) db.prepare('UPDATE tokens SET fees_usd = fees_usd + ? WHERE mint = ?').run((surplus / 1e9) * solUsd, coin.mint)
  return surplus
}

/**
 * Writes a credit. ⭐ A creator credit is booked per recipient (db.splitAmount over the coin's fixed shares): one row each,
 * in ONE database transaction, adding up to exactly `amount`. A holders credit is one row (nobody's yet).
 */
function bookCredit(db, mint, bucket, amount, signature, usd) {
  const ins = db.prepare('INSERT INTO credits (mint, bucket, lamports, signature, time, sol_usd, x_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
  if (bucket !== 'creator') return void ins.run(mint, bucket, amount, signature, now(), usd, null)
  const parts = splitAmount(amount, ledgerShares(db, mint)).filter((p) => p.amount > 0)
  // nobody of ours to book it to (a coin funding only GitHub accounts / charities): it stays unbooked in the wallet
  if (!parts.length) return
  db.exec('BEGIN IMMEDIATE')
  try { for (const p of parts) ins.run(mint, 'creator', p.amount, signature, now(), usd, p.id); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
}

/* ── paired coins: the same, in the quote token Q ── */
const quoteOf = (coin) => ({ mint: new PublicKey(coin.quote_mint), program: new PublicKey(coin.quote_program), decimals: coin.quote_decimals })

/** What waits for one paired coin, in Q units, from one batched read. `wallet` = the fee wallet's Q account. */
export async function readCoinQ(conn, coin) {
  const fw = new PublicKey(coin.fee_wallet), mint = new PublicKey(coin.mint), Q = quoteOf(coin)
  const pool = coin.pool ? new PublicKey(coin.pool) : poolAddress(mint, Q.mint, 0)
  const keys = [ata(fw, Q.mint, Q.program), ata(creatorVaultAddress(fw), Q.mint, Q.program), ata(ammCreatorVaultAuthority(fw), Q.mint, Q.program), bondingCurveAddress(mint), pool]
  const [w, vault, ammVault, curve, p] = await conn.getMultipleAccountsInfo(keys, 'confirmed')
  let poolFee = 0, poolHit = null, poolData = null
  if (p && p.data.length >= 200) {
    try { if (decodePool(p.data).coin_creator.equals(fw)) { poolHit = pool; poolData = p.data; poolFee = Number(poolCreatorFeesWaiting(p.data)) } } catch {}
  }
  const amt = (i) => (i && i.data.length >= 72 ? Number(tokenAccountAmount(i.data)) : 0)
  return {
    wallet: amt(w), walletOpen: !!w, vault: amt(vault), ammVault: amt(ammVault),
    curveFee: curve && curveCreator(curve.data)?.equals(fw) ? Number(curveCreatorFeeWaiting(curve.data)) : 0,
    poolFee, pool: poolHit, poolData,
  }
}

/** Collect instructions for a paired coin: open the fee wallet's Q account, sweep, collect (all permissionless). */
export async function collectIxsQ(conn, pump, coin, r, payer) {
  const fw = new PublicKey(coin.fee_wallet), Q = quoteOf(coin), q = { quoteMint: Q.mint, quoteProgram: Q.program }
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer, ata(fw, Q.mint, Q.program), fw, Q.mint, Q.program)]
  if (r.poolFee > 0) ixs.push(await sweepPoolCreatorFeeQIx(conn, { pool: r.pool, poolData: r.poolData, payer, creator: fw, ...q }))
  if (r.ammVault > 0 || r.poolFee > 0) ixs.push(await collectCoinCreatorFeeIx(conn, { creator: fw, ...q }))
  if (r.curveFee > 0) ixs.push(await sweepCurveCreatorFeeQIx(conn, { mint: coin.mint, payer, creator: fw, ...q }))
  if (r.curveFee > 0 || r.vault > 0) ixs.push(await collectCreatorFeeV2Ix(pump, { creator: fw, ...q }))
  return ixs
}

/** Collects a paired coin's Q into its fee wallet (throttled: cfg.collectQSeconds, or `force`). Caller holds the lock. */
export async function collectCoinQ(db, conn, pump, keeper, coin, cfg = keeperConfig(), log = console, { force = false } = {}) {
  let r = await readCoinQ(conn, coin)
  if (r.pool && coin.pool !== r.pool.toBase58()) db.prepare('UPDATE tokens SET pool = ?, graduated = 1 WHERE mint = ?').run(r.pool.toBase58(), coin.mint)
  const waiting = r.vault + r.ammVault + r.curveFee + r.poolFee
  const due = force || now() - (coin.last_collect_at ?? 0) >= cfg.collectQSeconds
  let sig = null
  if (waiting > 0 && due) {
    const ixs = await collectIxsQ(conn, pump, coin, r, keeper.publicKey)
    const built = await buildTx(conn, { payer: keeper.publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: coin.share_config ? 600_000 : 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priority }), ...ixs], signers: [keeper] })
    const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
    db.prepare('UPDATE tokens SET last_collect_at = ? WHERE mint = ?').run(now(), coin.mint)
    if (f.fate === 'landed') { sig = built.signature; r = await readCoinQ(conn, coin) }
    else log.error?.(`collect ${coin.mint.slice(0, 8)} (paired) ${f.fate} ${f.error ?? ''}`)
  }
  return { r, sig }
}

/** Books new Q in a paired coin's fee wallet to its mode (no rent floor: a token account's rent is not Q). */
export function creditSurplusQ(db, coin, walletUnits, { signature = null, priceUsd = null } = {}) {
  if (db.prepare("SELECT 1 FROM outflows WHERE mint = ? AND state = 'sending'").get(coin.mint)) return 0
  const b = buckets(db, coin.mint)
  const surplus = walletUnits - b.creator - b.holders
  if (surplus <= 0) return 0
  const mode = db.prepare('SELECT mode FROM tokens WHERE mint = ?').get(coin.mint).mode
  // credits.sol_usd holds the USD price of one whole Q for a paired coin's rows
  bookCredit(db, coin.mint, mode, surplus, signature, priceUsd)
  if (priceUsd > 0) db.prepare('UPDATE tokens SET fees_usd = fees_usd + ? WHERE mint = ?').run((surplus / 10 ** (coin.quote_decimals ?? 0)) * priceUsd, coin.mint)
  return surplus
}

/** Settles every unanswered outflow from the chain's answer. */
export async function settleOutflows(db, conn, log = console) {
  const rows = db.prepare("SELECT DISTINCT signature, last_valid_height FROM outflows WHERE state = 'sending' AND signature IS NOT NULL").all()
  for (const r of rows) {
    const f = await fateOf(conn, r.signature, r.last_valid_height)
    if (f.fate === 'unknown') continue
    const state = f.fate === 'landed' ? 'landed' : 'expired'
    db.prepare("UPDATE outflows SET state = ?, settled_at = ? WHERE signature = ? AND state = 'sending'").run(state, now(), r.signature)
    log.info?.(`outflow ${r.signature.slice(0, 12)}… ${state}`)
  }
  // A row with no signature was never sent (a crash between the reservation and the build): release it.
  db.prepare("UPDATE outflows SET state = 'expired', settled_at = ? WHERE state = 'sending' AND signature IS NULL AND time < ?").run(now(), now() - 300)
}

/**
 * Sends one transaction that moves SOL out of fee wallets. `moves` = [{ coin, bucket, lamports, to (PublicKey) }] all
 * from coins whose lock the caller holds. Rows are written 'sending' BEFORE the send; the chain's answer settles them.
 * Returns { fate, signature }.
 */
async function sendOutflow(db, conn, { keeper, seed, moves, kind, xId = null, items = null, priority, solUsd = null, label = null }) {
  const ids = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const m of moves) {
      // Re-checked inside the transaction: never reserve more than the bucket holds.
      if (buckets(db, m.coin.mint)[m.bucket] < m.lamports) throw new Error(`${m.coin.mint} ${m.bucket} bucket is short`)
      // ⛔ a payout moves only what was credited to THAT account on that coin (a split coin's bucket holds others' money too)
      if (kind === 'payout' && m.bucket === 'creator' && shareOf(db, m.coin.mint, xId).owed < m.lamports) throw new Error(`${m.coin.mint}: more than this account's share`)
      const id = db.prepare(`INSERT INTO outflows (mint, bucket, lamports, kind, destination, x_id, state, time, sol_usd) VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`)
        .run(m.coin.mint, m.bucket, m.lamports, kind, kind === 'payout' ? (label ?? m.to.toBase58()) : null, xId, now(), solUsd).lastInsertRowid
      ids.push(Number(id))
    }
    if (items) for (const it of items) db.prepare('INSERT INTO airdrop_items (outflow_id, owner, lamports, tokens) VALUES (?, ?, ?, ?)').run(ids[0], it.owner, it.lamports, String(it.tokens))
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  try {
    const signers = new Map([[keeper.publicKey.toBase58(), keeper]])
    const tokenMoves = moves.filter((m) => m.coin.quote_mint).length
    if (tokenMoves && (items || tokenMoves !== moves.length || new Set(moves.map((m) => m.coin.quote_mint)).size !== 1)) throw new Error('one payout moves one asset')
    const units = tokenMoves ? 40_000 + 30_000 * moves.length : 5_000 + 600 * (items?.length ?? moves.length)
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority })]
    if (tokenMoves) {
      // the creator's Q account, opened if missing (the keeper pays its rent once)
      const Q = quoteOf(moves[0].coin)
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata(moves[0].to, Q.mint, Q.program), moves[0].to, Q.mint, Q.program))
    }
    for (const m of moves) {
      const kp = feeWallet(seed, m.coin.mint)
      if (kp.publicKey.toBase58() !== m.coin.fee_wallet) throw new Error(`FEE_SEED does not derive ${m.coin.fee_wallet}`)
      signers.set(kp.publicKey.toBase58(), kp)
      if (m.coin.quote_mint) {
        const Q = quoteOf(m.coin)
        ixs.push(createTransferCheckedInstruction(ata(kp.publicKey, Q.mint, Q.program), Q.mint, ata(m.to, Q.mint, Q.program), kp.publicKey, BigInt(m.lamports), Q.decimals, [], Q.program))
      } else if (items) for (const it of items) ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(it.owner), lamports: it.lamports }))
      else ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: m.to, lamports: m.lamports }))
    }
    const built = await buildTx(conn, { payer: keeper.publicKey, ixs, signers: [...signers.values()] })
    db.prepare(`UPDATE outflows SET signature = ?, last_valid_height = ? WHERE id IN (${ids.join(',')})`).run(built.signature, built.lastValidBlockHeight)
    const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
    if (f.fate !== 'unknown') db.prepare(`UPDATE outflows SET state = ?, settled_at = ? WHERE id IN (${ids.join(',')}) AND state = 'sending'`).run(f.fate === 'landed' ? 'landed' : 'expired', now())
    return { ...f, signature: built.signature }
  } catch (e) {
    // Nothing was signed+written yet if the signature is still null: release the reservation.
    db.prepare(`UPDATE outflows SET state = 'expired', settled_at = ? WHERE id IN (${ids.join(',')}) AND signature IS NULL`).run(now())
    throw e
  }
}

/**
 * Pays an X account's creator buckets to `destination`. Used by the site's withdraw and the keeper's auto-pay.
 * Returns { paid: lamports, signatures: [...], pending: bool }.
 */
export async function payCreator(db, conn, { keeper, seed, xId, destination, minLamports = 10_000_000, cfg = keeperConfig(), solUsd = null, asset = 'SOL', label = null }) {
  const to = new PublicKey(destination)
  // ⛔ one asset per call: SOL coins, or the coins paired with one token (their buckets hold that token's units)
  // every coin this account has a share of; the amount is ITS part of the coin's creator bucket, never the whole bucket
  const coins = mintsOf(db, xId).map((mint) => db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint))
    .filter((c) => c && !c.own_creator && (asset === 'SOL' ? c.quote_mint == null : c.quote_mint === asset))
    .map((c) => ({ coin: c, lamports: shareOf(db, c.mint, xId).owed })).filter((c) => c.lamports > 0).sort((a, b) => b.lamports - a.lamports)
  const total = coins.reduce((s, c) => s + c.lamports, 0)
  if (total < minLamports || total <= 0) return { paid: 0, signatures: [], total }
  let paid = 0, pending = false
  const signatures = []
  const perTx = asset === 'SOL' ? cfg.payoutCoinsPerTx : 4
  for (let i = 0; i < coins.length; i += perTx) {
    const group = coins.slice(i, i + perTx).filter((c) => lockCoin(db, c.coin.mint))
    if (!group.length) continue
    try {
      // amounts re-read under the lock (a credit or a holders switch may have happened since)
      const moves = group.map((c) => ({ coin: c.coin, bucket: 'creator', lamports: shareOf(db, c.coin.mint, xId).owed, to })).filter((m) => m.lamports > 0)
      if (!moves.length) continue
      const r = await sendOutflow(db, conn, { keeper, seed, moves, kind: 'payout', xId: String(xId), priority: cfg.priority, solUsd, label })
      signatures.push(r.signature)
      if (r.fate === 'landed') paid += moves.reduce((s, m) => s + m.lamports, 0)
      else if (r.fate === 'unknown') pending = true
    } finally { for (const c of group) unlockCoin(db, c.coin.mint) }
  }
  return { paid, signatures, pending, total }
}

/** Token-2022 accounts of `mint`: [{ owner, amount }], from one getProgramAccounts (owner + amount only). */
export async function holdersOf(conn, mint, program = TOKEN_2022) {
  const accs = await conn.getProgramAccounts(program, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: mint } }],
    dataSlice: { offset: 32, length: 40 },
  })
  const byOwner = new Map()
  for (const a of accs) {
    const d = a.account.data
    if (d.length < 40) continue
    const owner = new PublicKey(d.subarray(0, 32)).toBase58()
    const amount = d.readBigUInt64LE(32)
    if (amount > 0n) byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount)
  }
  return [...byOwner].map(([owner, amount]) => ({ owner, amount }))
}

/**
 * The airdrop plan for `pot` lamports: pro rata by balance among wallets (on-curve owners: curves, pools and other
 * program accounts are never paid) holding at least `holderMinTokens`, the largest `maxHolders`. A share below
 * `minShare`, or one that would leave an empty wallet under the rent floor, is dropped and the pot re-divided.
 */
export function planAirdrop(holders, pot, { exclude = [], holderMinTokens, maxHolders, minShare, lamportsOf = null }) {
  const ex = new Set(exclude)
  let list = holders.filter((h) => !ex.has(h.owner) && h.amount >= holderMinTokens && PublicKey.isOnCurve(new PublicKey(h.owner).toBytes()))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)).slice(0, maxHolders)
  for (let round = 0; round < 10 && list.length; round++) {
    const sum = list.reduce((s, h) => s + h.amount, 0n)
    const shares = list.map((h) => ({ ...h, lamports: Number((BigInt(pot) * h.amount) / sum) }))
    const keep = shares.filter((s) => s.lamports >= minShare && !(lamportsOf && (lamportsOf.get(s.owner) ?? 0) === 0 && s.lamports < RENT_FLOOR)
      && !(lamportsOf && (lamportsOf.get(s.owner) ?? 0) > 0 && (lamportsOf.get(s.owner) ?? 0) < RENT_FLOOR))
    if (keep.length === shares.length) return shares
    list = keep.map(({ lamports, ...h }) => h)
  }
  return []
}

/** One coin's holders airdrop, in batches. Caller holds the coin's lock. */
export async function airdrop(db, conn, { keeper, seed, coin, cfg = keeperConfig(), solUsd = null, log = console }) {
  if (coin.quote_mint) return { sent: 0, reason: 'a paired coin\'s holders are paid by pump.fun, never airdropped' }
  const pot = buckets(db, coin.mint).holders
  if (pot <= 0) return { sent: 0 }
  // a Float coin is a classic SPL token (LaunchLab); a pump.fun coin is Token-2022
  const holders = await holdersOf(conn, coin.mint, coin.venue === 'float' ? TOKEN : TOKEN_2022)
  const owners = holders.map((h) => new PublicKey(h.owner))
  const lamportsOf = new Map()
  for (let i = 0; i < owners.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(owners.slice(i, i + 100), 'confirmed')
    infos.forEach((inf, j) => lamportsOf.set(owners[i + j].toBase58(), inf?.lamports ?? 0))
  }
  const plan = planAirdrop(holders, pot, { exclude: [coin.fee_wallet, keeper.publicKey.toBase58()], ...cfg, lamportsOf })
  if (!plan.length) return { sent: 0, reason: 'no eligible holders' }
  const batchId = `${coin.mint.slice(0, 8)}-${now()}`
  let sent = 0
  for (let i = 0; i < plan.length; i += cfg.batch) {
    const items = plan.slice(i, i + cfg.batch).map((p) => ({ owner: p.owner, lamports: p.lamports, tokens: p.amount }))
    const lamports = items.reduce((s, it) => s + it.lamports, 0)
    const r = await sendOutflow(db, conn, { keeper, seed, moves: [{ coin, bucket: 'holders', lamports }], kind: 'airdrop', items, priority: cfg.priority, solUsd })
    db.prepare('UPDATE outflows SET batch = ? WHERE signature = ?').run(batchId, r.signature)
    if (r.fate === 'landed') sent += lamports
    else { log.info?.(`airdrop ${coin.mint.slice(0, 8)} batch ${i / cfg.batch} ${r.fate}; the rest waits for the next pass`); break }
  }
  db.prepare('UPDATE tokens SET last_distribution_at = ? WHERE mint = ?').run(now(), coin.mint)
  return { sent, recipients: plan.length }
}

/**
 * Collects what waits for one coin into its fee wallet (if worth a transaction) and returns the fresh read.
 * The caller holds the coin's lock and credits afterwards.
 */
export async function collectCoin(db, conn, pump, keeper, coin, cfg = keeperConfig(), log = console) {
  if (coin.share_config) coin = { ...coin, shareholders: shareholdersOf(db, coin) }
  let r = await readCoin(conn, coin)
  if (r.pool && coin.pool !== r.pool.toBase58()) db.prepare('UPDATE tokens SET pool = ?, graduated = 1 WHERE mint = ?').run(r.pool.toBase58(), coin.mint)
  const waiting = r.vault + r.ammVault + r.curveFee + r.poolFee
  let sig = null
  if (waiting >= cfg.minCollect) {
    const ixs = await collectIxs(conn, pump, coin, r, keeper.publicKey)
    const built = await buildTx(conn, { payer: keeper.publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priority }), ...ixs], signers: [keeper] })
    const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
    if (f.fate === 'landed') {
      sig = built.signature; r = await readCoin(conn, coin)
      // ⭐ proof pages: Pumpfun split everything swept in this transaction between the coin's shareholders
      if (coin.share_config) db.prepare("INSERT OR IGNORE INTO native_events (mint, kind, signature, lamports, recipient, time) VALUES (?, 'distribute', ?, ?, NULL, ?)").run(coin.mint, sig, waiting, now())
    }
    else log.error?.(`collect ${coin.mint.slice(0, 8)} ${f.fate} ${f.error ?? ''}`)
  }
  if (coin.share_config) {
    for (const d of await forwardDonations(conn, keeper, coin, cfg, log))
      db.prepare("INSERT OR IGNORE INTO native_events (mint, kind, signature, lamports, recipient, time) VALUES (?, 'donation', ?, ?, ?, ?)").run(coin.mint, d.signature, d.lamports, d.charity, now())
  }
  return { r, sig }
}

/**
 * ⭐ Sends what a coin's charity accounts hold on to the charities (Pumpfun's donation relay; permissionless, anyone may
 * do it and Pumpfun's own site does too). One transaction per charity, only above cfg.donationMin; a refusal is logged
 * and tried again next pass: the money stays in the charity's own account on chain either way, it cannot go anywhere else.
 */
export async function forwardDonations(conn, keeper, coin, cfg = keeperConfig(), log = console) {
  const charities = (coin.shareholders ?? []).filter((h) => h.kind === 'charity')
  if (!charities.length) return []
  const infos = await conn.getMultipleAccountsInfo(charities.map((h) => h.address), 'confirmed')
  const out = []
  for (let i = 0; i < charities.length; i++) {
    const info = infos[i]
    if (!info || info.owner.equals(SystemProgram.programId)) continue
    const waiting = info.lamports - await conn.getMinimumBalanceForRentExemption(info.data.length)
    if (waiting < cfg.donationMin) continue
    try {
      const built = await buildTx(conn, { payer: keeper.publicKey, signers: [keeper], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priority }), await crankDonationIx(conn, { payer: keeper.publicKey, mint: new PublicKey(coin.mint), configId: charities[i].id })] })
      const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
      if (f.fate === 'landed') { out.push({ charity: charities[i].id, lamports: waiting, signature: built.signature }); log.info?.(`donation ${coin.mint.slice(0, 8)} → ${charities[i].id.slice(0, 10)}: ${waiting / 1e9} SOL forwarded`) }
      else log.error?.(`donation ${coin.mint.slice(0, 8)} ${f.fate} ${f.error ?? ''}`)
    } catch (e) { log.error?.(`donation ${coin.mint.slice(0, 8)}: ${e.message}`) }
  }
  return out
}

/**
 * A natively split coin's shareholders as they are on chain, in the config's order: the coin's reward wallet first when
 * it funds X accounts (their combined share), then each GitHub account and charity. [{ kind, id, bps, address }]
 */
export function shareholdersOf(db, coin) {
  const rows = sharesOf(db, coin.mint), x = rows.filter((s) => isOurs(s.kind))
  const out = x.length ? [{ kind: 'wallet', id: coin.fee_wallet, bps: x.reduce((t, s) => t + s.bps, 0) }] : []
  for (const s of rows) if (!isOurs(s.kind)) out.push({ kind: s.kind, id: s.id, bps: s.bps })
  return out.map((h) => ({ ...h, address: shareholderAddress(coin.mint, h) }))
}

/** One keeper pass over every coin. A failure on one coin never stops the others. */
export async function keeperPass({ db, conn, pump, keeper, seed, cfg = keeperConfig(), solUsd = null, log = console }) {
  await settleOutflows(db, conn, log)
  const results = []
  // Native holder-reward coins are paid out by pump.fun itself: nothing of theirs ever reaches a fee wallet.
  const coins = db.prepare('SELECT * FROM tokens WHERE native_holders = 0 AND own_creator = 0 ORDER BY created_at').all()
  for (const coin of coins) {
    try {
      if (!lockCoin(db, coin.mint, 180)) continue
      try {
        // ⭐ Float coins (api/floatkeeper.mjs): Float's claim → our fee wallet; SOL unwrapped, then booked like any coin
        if (coin.venue === 'float') {
          const { r, sig } = await collectFloat(db, conn, keeper, seed, coin, cfg, log)
          if (coin.quote_mint) {
            const b = buckets(db, coin.mint)
            const priceUsd = r.wallet > b.creator + b.holders ? await tokenUsd(coin.quote_mint).catch(() => null) : null
            const credited = creditSurplusQ(db, coin, r.wallet, { signature: sig, priceUsd })
            if (credited) results.push({ mint: coin.mint, credited, asset: coin.quote_mint })
            continue
          }
          const credited = creditSurplus(db, coin, r.wallet, { signature: sig, solUsd })
          if (credited) results.push({ mint: coin.mint, credited, bucket: db.prepare('SELECT mode FROM tokens WHERE mint = ?').get(coin.mint).mode })
          const b = buckets(db, coin.mint)
          const fresh = db.prepare('SELECT last_distribution_at FROM tokens WHERE mint = ?').get(coin.mint).last_distribution_at
          if (b.holders >= cfg.holdersMin || (b.holders >= cfg.holdersDust && now() - fresh > 86400)) results.push({ mint: coin.mint, airdrop: await airdrop(db, conn, { keeper, seed, coin, cfg, solUsd, log }) })
          continue
        }
        if (coin.quote_mint) {
          const { r, sig } = await collectCoinQ(db, conn, pump, keeper, coin, cfg, log)
          // the token's USD price (DexScreener) is read only when there is something new to book
          const b = buckets(db, coin.mint)
          const priceUsd = r.wallet > b.creator + b.holders ? await tokenUsd(coin.quote_mint).catch(() => null) : null
          const credited = creditSurplusQ(db, coin, r.wallet, { signature: sig, priceUsd })
          if (credited) results.push({ mint: coin.mint, credited, asset: coin.quote_mint })
          continue // holders of a paired coin are paid by pump.fun; there is no Q airdrop
        }
        const { r, sig } = await collectCoin(db, conn, pump, keeper, coin, cfg, log)
        const credited = creditSurplus(db, coin, r.wallet, { signature: sig, solUsd })
        if (credited) results.push({ mint: coin.mint, credited, bucket: db.prepare('SELECT mode FROM tokens WHERE mint = ?').get(coin.mint).mode })
        const b = buckets(db, coin.mint)
        const fresh = db.prepare('SELECT last_distribution_at FROM tokens WHERE mint = ?').get(coin.mint).last_distribution_at
        if (b.holders >= cfg.holdersMin || (b.holders >= cfg.holdersDust && now() - fresh > 86400)) {
          const a = await airdrop(db, conn, { keeper, seed, coin, cfg, solUsd, log })
          results.push({ mint: coin.mint, airdrop: a })
        }
      } finally { unlockCoin(db, coin.mint) }
    } catch (e) {
      results.push({ mint: coin.mint, error: e.message })
      log.error?.(`keeper ${coin.mint.slice(0, 8)}: ${e.message}`)
    }
  }
  // Auto-pay: creators with a confirmed wallet (Solana or FOMO) whose total passed their threshold.
  const users = db.prepare("SELECT * FROM users WHERE payout_kind IN ('wallet', 'fomo') AND payout_confirmed = 1 AND payout_wallet IS NOT NULL").all()
  for (const u of users) {
    try {
      const r = await payCreator(db, conn, { keeper, seed, xId: u.x_id, destination: u.payout_wallet, minLamports: Math.max(10_000_000, u.auto_min_lamports), cfg, solUsd })
      if (r.paid || r.pending) results.push({ autopay: u.handle, ...r })
    } catch (e) { log.error?.(`autopay @${u.handle}: ${e.message}`) }
    // paired coins: each token at most once per AUTOPAY_Q_SECONDS (no SOL threshold applies to a token)
    for (const a of owedAssets(db, u.x_id).filter((x) => x.asset !== 'SOL')) {
      try {
        const recent = db.prepare(`SELECT 1 FROM outflows o JOIN tokens t ON t.mint = o.mint WHERE o.x_id = ? AND o.kind = 'payout' AND t.quote_mint = ?
          AND o.state != 'expired' AND o.time > ?`).get(u.x_id, a.asset, now() - cfg.autoPayQSeconds)
        if (recent) continue
        const r = await payCreator(db, conn, { keeper, seed, xId: u.x_id, destination: u.payout_wallet, minLamports: 1, cfg, asset: a.asset })
        if (r.paid || r.pending) results.push({ autopay: u.handle, asset: a.symbol, ...r })
      } catch (e) { log.error?.(`autopay @${u.handle} ${a.symbol}: ${e.message}`) }
    }
  }
  return results
}
