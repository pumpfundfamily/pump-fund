/**
 * Sending a transaction and learning its fate.
 *
 * ⛔ "Expired" is concluded ONLY from a positive chain answer: the block height is past the blockhash's last valid
 * height AND a fresh status read still finds no signature (memory tx-expiry-needs-positive-answer). An RPC error, a
 * timeout or "still processing" is UNKNOWN, never expired: reading it as expired would book a landed payout as unspent
 * and pay it twice.
 */
import { TransactionMessage, VersionedTransaction } from '@solana/web3.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function buildTx(conn, { payer, ixs, signers, lookupTables = [] }) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookupTables))
  tx.sign(signers)
  const raw = tx.serialize()
  if (raw.length > 1232) throw new Error(`transaction is ${raw.length} bytes, over Solana's 1,232`)
  return { tx, raw, signature: bs58sig(tx), lastValidBlockHeight }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function bs58sig(tx) {
  const bytes = tx.signatures[0]
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')), s = ''
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break }
  return s
}

/** A signed transaction's signature (its first: the fee payer's), in base58. */
export const signatureOf = (tx) => bs58sig(tx)

/**
 * The chain's answer for a signature: 'landed' | 'failed' (landed with an error) | 'expired' | 'unknown'.
 * Never throws.
 */
export async function fateOf(conn, signature, lastValidBlockHeight) {
  try {
    const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st.err ? { fate: 'failed', err: st.err } : { fate: 'landed' }
    if (st) return { fate: 'unknown' } // processed: not yet an answer
    const height = await conn.getBlockHeight('confirmed')
    if (height <= lastValidBlockHeight) return { fate: 'unknown' }
    // Past the window: read once more, so a landing between the two reads is not missed.
    const again = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
    if (again) return again.err ? { fate: 'failed', err: again.err } : (again.confirmationStatus === 'processed' ? { fate: 'unknown' } : { fate: 'landed' })
    return { fate: 'expired' }
  } catch (e) {
    return { fate: 'unknown', error: e.message }
  }
}

/**
 * Sends `raw` (resending every few seconds) until the chain gives an answer or `timeoutMs` passes.
 * Returns the fate; 'unknown' means the caller must keep the signature and ask again later.
 */
export async function sendUntilFate(conn, { raw, signature, lastValidBlockHeight, timeoutMs = 90_000, skipPreflight = false }) {
  const start = Date.now()
  let lastSend = 0
  let preflightError = null
  for (;;) {
    if (Date.now() - lastSend > 4000) {
      lastSend = Date.now()
      try { await conn.sendRawTransaction(raw, { skipPreflight, maxRetries: 0, preflightCommitment: 'confirmed' }) }
      catch (e) {
        // A simulation failure on the FIRST send means the transaction cannot land as built: no money moved.
        const msg = String(e?.message ?? e)
        if (/already been processed/i.test(msg)) { /* landed already: fall through to the status read */ }
        else if (!skipPreflight && lastSend - start < 1000 && /simulation failed|custom program error|insufficient/i.test(msg)) { preflightError = msg; return { fate: 'rejected', error: msg, logs: e?.logs ?? e?.transactionLogs ?? null } }
      }
    }
    const f = await fateOf(conn, signature, lastValidBlockHeight)
    if (f.fate !== 'unknown') return f
    if (Date.now() - start > timeoutMs) return { fate: 'unknown', error: preflightError }
    await sleep(1500)
  }
}
