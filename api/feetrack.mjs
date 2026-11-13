/**
 * ⭐ Fees that never pass through our fee wallets, tracked from the chain (operator 11 Nov: "0 SOL for all tokens"):
 *
 *   native holder-reward coins   pump.fun makes the coin's `holder-rewards` PDA its creator. Its creator fees are
 *                                collected INTO that PDA (pump `collect_creator_fee`) and paid OUT of it to the
 *                                holders (`distribute_fee_to_holders`, by pump.fun's crank HckQ93…). Verified 11 Nov on
 *                                mainnet: the PDA's own history is just those two kinds of transaction.
 *                                in = every positive balance change, out = every negative one.
 *   the platform coin            its creator is the operator's wallet; in = what that wallet collected from pump.fun
 *                                (transactions whose logs show a creator-fee collect), out = the same (it is the payout).
 *
 * waiting = what is earned but not collected yet: the creator vault (curve) + the PumpSwap creator vault + fees still on
 * the curve / pool (pump.fun keeps new fees there until swept), and for a holder coin what sits in the PDA undistributed.
 *
 * Cheap by design (memory dont-waste-paid-api-credits): one getSignaturesForAddress per coin per pass with `until` the last
 * seen signature, then one getTransaction per NEW transaction (a handful per active coin); a batch of account reads for
 * the waiting amounts. SOL-paired coins only (a paired coin's fees are in its pair token).
 */
import { PublicKey } from '@solana/web3.js'
import { holderRewardsAddress } from '../lib/pump.mjs'
import { readCoin } from './keeper.mjs'
import { now } from './db.mjs'

const PACE_MS = Number(process.env.FEETRACK_PACE_MS ?? 0) // extra gap per read; the keeper's connection itself is paced (lib/paced.mjs)
const COLLECT_LOG = /Instruction: (CollectCreatorFee|CollectCoinCreatorFee)\b/

/** The account whose history is the coin's fee history, and the coin's on-chain creator. */
export function externalFeeAccount(coin) {
  if (coin.quote_mint) return null
  if (coin.native_holders) { const pda = holderRewardsAddress(new PublicKey(coin.mint)); return { history: pda, creator: pda, kind: 'holders' } }
  if (coin.own_creator) { const w = new PublicKey(coin.fee_wallet); return { history: w, creator: w, kind: 'own' } }
  return null
}

async function rpc(conn, method, params) {
  const r = await conn._rpcRequest(method, params)
  if (r.error) throw new Error(`${method}: ${r.error.message}`)
  return r.result
}

/**
 * Updates one coin's ext_in / ext_out / ext_waiting from the chain. Returns what changed.
 *
 * ⛔ Counted OLDEST first and never skipped (11 Nov: a busy holder coin had 565 transactions in its first hour; taking
 * the newest N would have lost the older ones for good). Every new signature is listed (cheap, 1000 a call), then at
 * most `maxTx` of the oldest are read, in batches; the cursor stops at the last one counted, so a lag only delays.
 * ⛔ No rent is assumed: the holder-rewards PDA is a plain system account that pump.fun drains below the "rent floor"
 * (seen: 681,828 lamports left). Every lamport in is a collected fee, every lamport out a payout to holders.
 */
export async function trackExternalFees(db, conn, coin, { maxTx = 200 } = {}) {
  const acct = externalFeeAccount(coin)
  if (!acct) return null
  const H = acct.history.toBase58()
  const fresh = []
  let before
  for (let page = 0; page < 20; page++) {
    const sigs = await rpc(conn, 'getSignaturesForAddress', [H, { limit: 1000, ...(coin.ext_sig ? { until: coin.ext_sig } : {}), ...(before ? { before } : {}), commitment: 'confirmed' }])
    fresh.push(...sigs)
    if (sigs.length < 1000) break
    before = sigs.at(-1).signature
  }
  const todo = fresh.reverse().slice(0, maxTx) // oldest first
  let addIn = 0, addOut = 0, newest = coin.ext_sig, read = 0
  const wanted = todo.filter((s) => !s.err && !(s.blockTime && s.blockTime < coin.created_at - 60))
  // ⛔ one at a time, paced (11 Nov: a 50-request batch tripped the shared Helius key's BURST limit, 429s for every
  // reader on the box; memory rpc-rate-limit-is-a-burst-limit)
  const txs = new Map()
  for (const s of wanted) {
    txs.set(s.signature, await rpc(conn, 'getTransaction', [s.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]).catch(() => null))
    read++
    await new Promise((r) => setTimeout(r, PACE_MS))
  }
  for (const s of todo) {
    // before the launch (the operator's wallet has older history) or failed: nothing to count, but move past it
    if (s.err || (s.blockTime && s.blockTime < coin.created_at - 60)) { newest = s.signature; continue }
    const tx = txs.get(s.signature)
    if (!tx?.meta) break // not readable yet: the cursor stays on the last one counted, so this one is counted next pass
    newest = s.signature
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])]
    const i = keys.indexOf(H)
    if (i < 0) continue
    let delta = tx.meta.postBalances[i] - tx.meta.preBalances[i]
    if (acct.kind === 'holders') { if (delta > 0) addIn += delta; else addOut += -delta }
    else if ((tx.meta.logMessages ?? []).some((l) => COLLECT_LOG.test(l))) {
      if (i === 0) delta += tx.meta.fee // the wallet paid the transaction fee out of what it collected
      if (delta > 0) { addIn += delta; addOut += delta }
    }
  }
  // waiting = earned but NOT collected yet (creator vaults, curve, pool). What sits in the holder-rewards PDA was already
  // counted in ext_in; it is ext_in − ext_out, never added here a second time.
  const r = await readCoin(conn, { ...coin, fee_wallet: acct.creator.toBase58() })
  const waiting = r.vault + r.ammVault + r.curveFee + r.poolFee
  db.prepare('UPDATE tokens SET ext_in = ext_in + ?, ext_out = ext_out + ?, ext_waiting = ?, ext_sig = ?, ext_at = ? WHERE mint = ?')
    .run(addIn, addOut, waiting, newest ?? null, now(), coin.mint)
  return { mint: coin.mint, in: addIn, out: addOut, waiting, txs: read, behind: Math.max(0, fresh.length - todo.length) }
}

/**
 * One pass over every coin whose fees pump.fun handles itself. At most `budget` transactions are read per pass in all
 * (memory dont-waste-paid-api-credits): busy coins catch up over a few passes, never skipping. Errors stay per coin.
 */
export async function trackAllExternal(db, conn, { log = console, everySeconds = 240, budget = Number(process.env.FEETRACK_TX_BUDGET ?? 400) } = {}) {
  const coins = db.prepare('SELECT * FROM tokens WHERE quote_mint IS NULL AND (native_holders = 1 OR own_creator = 1) AND ext_at < ? ORDER BY ext_at LIMIT 300').all(now() - everySeconds)
  const out = []
  let left = budget
  for (const c of coins) {
    if (left <= 0) break
    try {
      const r = await trackExternalFees(db, conn, c, { maxTx: Math.min(600, left) })
      if (r) left -= r.txs
      if (r && (r.in || r.out || r.behind)) out.push(r)
    } catch (e) { log.error?.(`feetrack ${c.mint.slice(0, 8)}: ${e.message}`) }
  }
  return out
}
