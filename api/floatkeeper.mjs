/**
 * ⭐ The keeper's step for a Float coin (operator 11 Nov). Float pays the dev share (5% of the trading fee) to the coin's
 * fee wallet, in the pair token, once someone runs its permissionless claims (Float's own bot does, every few minutes;
 * we run them too, so nothing depends on it):
 *
 *   claim     on the curve: open the accounts the claims need, claim_coin_fees (LaunchLab creator fee → Float's
 *             split, dev share → LaunchState.dev_owed), claim_dev_fees (dev_owed → the fee wallet's pair-token account)
 *   unwrap    SOL pair: close the fee wallet's WSOL account into the fee wallet and reopen it, paid by the fee wallet
 *             itself, in ONE transaction: its SOL then grows by exactly the wrapped fees (the account's rent goes out and
 *             back), and from there it is an ordinary SOL coin (credit → creator/holders → payouts, airdrops, X Money)
 *
 * Returns { r: { wallet }, sig } like collectCoin / collectCoinQ: `wallet` is the fee wallet's SOL (SOL pair) or its
 * pair-token units (token pair).
 */
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } from '@solana/spl-token'
import { F, LL_FEES, TOKEN, WSOL, ataOf, claimCoinFeesIx, claimDevFeesIx, launchState } from '../lib/float.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'
import { feeWallet } from './feewallet.mjs'
import { tokenAccountAmount } from '../lib/pump.mjs'

const amountOf = (info) => (info && info.data.length >= 72 ? Number(tokenAccountAmount(info.data)) : 0)

async function send(conn, payer, signers, ixs, priority) {
  const built = await buildTx(conn, { payer: payer.publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }), ...ixs], signers })
  const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
  return { ...f, signature: built.signature }
}

export async function collectFloat(db, conn, keeper, seed, coin, cfg, log = console) {
  const mint = new PublicKey(coin.mint), fw = new PublicKey(coin.fee_wallet)
  const Q = coin.quote_mint ? new PublicKey(coin.quote_mint) : WSOL
  const QP = coin.quote_program ? new PublicKey(coin.quote_program) : TOKEN
  const fwq = ataOf(fw, Q, QP), coinVault = F.coinVault(mint)
  const [creatorVaultInfo, fwqInfo, st] = await Promise.all([
    conn.getAccountInfo(LL_FEES.creatorVault(coinVault, Q), 'confirmed'), conn.getAccountInfo(fwq, 'confirmed'), launchState(conn, mint).catch(() => null),
  ])
  const onCurve = amountOf(creatorVaultInfo)
  const owed = st ? Number(st.dev_owed) : 0
  let sig = null
  // claim: only when it is worth a transaction (the keeper pays the fee)
  const minQ = coin.quote_mint ? 1 : cfg.minCollect
  if (st && (onCurve >= minQ * 4 || owed >= minQ)) {
    const ixs = [createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, fwq, fw, Q, QP)]
    if (onCurve > 0) ixs.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ataOf(coinVault, Q, QP), coinVault, Q, QP), await claimCoinFeesIx(conn, { payer: keeper.publicKey, mint, quoteMint: Q, quoteTokenProgram: QP }))
    ixs.push(await claimDevFeesIx(conn, { payer: keeper.publicKey, mint, feeReceiver: fw, quoteMint: Q, quoteTokenProgram: QP }))
    const f = await send(conn, keeper, [keeper], ixs, cfg.priority)
    if (f.fate === 'landed') sig = f.signature
    else log.error?.(`float claim ${coin.mint.slice(0, 8)} ${f.fate} ${f.error ?? ''}`)
  }
  if (coin.quote_mint) {
    const w = await conn.getAccountInfo(fwq, 'confirmed')
    return { r: { wallet: amountOf(w) }, sig }
  }
  // unwrap the SOL pair's WSOL into the fee wallet itself
  const wrapped = amountOf(sig ? await conn.getAccountInfo(fwq, 'confirmed') : fwqInfo)
  if (wrapped >= cfg.minCollect) {
    const kp = feeWallet(seed, coin.mint)
    if (!kp.publicKey.equals(fw)) throw new Error(`FEE_SEED does not derive ${coin.fee_wallet}`)
    const f = await send(conn, keeper, [keeper, kp], [
      createCloseAccountInstruction(fwq, fw, fw),
      createAssociatedTokenAccountIdempotentInstruction(fw, fwq, fw, WSOL),
    ], cfg.priority)
    if (f.fate === 'landed') sig = f.signature
    else log.error?.(`float unwrap ${coin.mint.slice(0, 8)} ${f.fate} ${f.error ?? ''}`)
  }
  return { r: { wallet: await conn.getBalance(fw, 'confirmed') }, sig }
}
