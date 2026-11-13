/**
 * Locking a coin's GitHub / charity shares on Pumpfun (lib/feeshare.mjs), after its launch transaction has landed.
 *
 * The launch transaction creates the coin with the LAUNCH WALLET as its Pumpfun creator and turns fee sharing on (the
 * config then names the launch wallet alone, unlocked). This module does the rest, each step read back from the chain so
 * it can be repeated after a crash without doing anything twice:
 *
 *   open      each charity's donation account (only the coin's creator can, and only BEFORE the lock)
 *   lock      update_fee_shares with the final shareholders: Pumpfun allows this once, then nobody can change them
 *   accounts  each GitHub account's fee account, if it was never opened (anyone can; a small payout cannot land without it)
 *   forward   ⛔ rewards earned between the launch and the lock were paid by Pumpfun to the launch wallet (it was the only
 *             shareholder for those seconds). Exactly that amount, read from the lock transaction itself, is sent on to
 *             the shareholders in their shares: Pump Fund keeps none of a coin's rewards.
 *
 * Why two steps: all of it in one transaction only fits for the smallest mixes (measured 13 Nov: 1,196 bytes with ONE
 * charity next to the X share, 1,316 with two), and a charity account cannot be opened after the lock.
 * State kept between calls (in the request's payload): updateSig/updateLvh, interim, forwardSig/forwardLvh, forwarded.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js'
import { isOurs } from './rails.mjs'
import { creatorVaultAddress } from '../lib/pump.mjs'
import { createDonationIx, createSocialIx, readSharingConfig, sameShareholders, shareholderAddress, sharingConfigAddress, updateSharesIx } from '../lib/feeshare.mjs'
import { buildTx, fateOf, sendUntilFate } from '../lib/tx.mjs'
import { splitAmount } from './db.mjs'

/** Interim rewards under this are not worth a transaction (and a share of it could not land on an empty address). */
export const FORWARD_MIN_LAMPORTS = 50_000

/**
 * The shareholders a coin gets on chain, in order: the coin's reward wallet first when it funds X accounts (their
 * combined share, divided by our ledger), then each GitHub account and charity. `shares` = [{ kind, id, bps }].
 */
export function nativeShareholders(mint, feeWalletPk, shares) {
  const x = shares.filter((s) => isOurs(s.kind))
  const out = x.length ? [{ kind: 'wallet', id: new PublicKey(feeWalletPk).toBase58(), bps: x.reduce((t, s) => t + s.bps, 0) }] : []
  for (const s of shares) if (!isOurs(s.kind)) out.push({ kind: s.kind, id: String(s.id), bps: s.bps })
  return out.map((h) => ({ ...h, address: shareholderAddress(mint, h) }))
}
export const isNative = (shares) => shares.some((s) => !isOurs(s.kind))

async function send(conn, launcher, ixs, { units = 400_000 } = {}) {
  const built = await buildTx(conn, { payer: launcher.publicKey, signers: [launcher], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }), ...ixs] })
  const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
  return { ...f, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight }
}
const fits = async (conn, launcher, ixs) => { try { await buildTx(conn, { payer: launcher.publicKey, signers: [launcher], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...ixs] }); return true } catch { return false } }

/** What the creator vault paid out inside one landed transaction (the lock pays the pending rewards to the old shareholder). */
async function vaultPaid(conn, signature, vault) {
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  if (!tx) return null
  const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])]
  const i = keys.findIndex((k) => k.equals(vault))
  return i < 0 ? 0 : Math.max(0, tx.meta.preBalances[i] - tx.meta.postBalances[i])
}

/**
 * Brings a launched coin to "shares locked, accounts open, interim rewards forwarded". Idempotent; call it until it says
 * done. `state` is this function's own memory (see the header), `save(state)` persists it BEFORE anything is sent.
 * Returns { done: true } | { wait: reason } | { failed: reason }.
 */
export async function settleNativeSplit({ conn, launcher, mint, feeWalletPk, shares, state = {}, save = () => {}, log = console }) {
  mint = new PublicKey(mint)
  const want = nativeShareholders(mint, feeWalletPk, shares)
  const total = want.reduce((t, s) => t + s.bps, 0)
  if (total !== 10000 || want.length < 1 || want.length > 10) return { failed: 'the shareholders do not add up' }
  let cfg = await readSharingConfig(conn, mint)
  if (!cfg) return { failed: 'the coin has no sharing config' }

  if (!cfg.locked) {
    const only = cfg.shareholders.length === 1 && cfg.shareholders[0].address === launcher.publicKey.toBase58()
    if (!only) return { failed: 'the sharing config names someone else before the lock' }
    if (state.updateSig) {
      const f = await fateOf(conn, state.updateSig, state.updateLvh)
      if (f.fate === 'unknown' || f.fate === 'landed') return { wait: 'the lock is confirming' }
      state = { ...state, updateSig: null, updateLvh: null }; save(state) // positively expired or refused: build it again
    }
    // the charity accounts that are not open yet (only now, before the lock, can they be opened)
    const charities = want.filter((h) => h.kind === 'charity')
    const infos = charities.length ? await conn.getMultipleAccountsInfo(charities.map((h) => h.address), 'confirmed') : []
    let opens = []
    for (let i = 0; i < charities.length; i++) if (!infos[i] || infos[i].owner.equals(SystemProgram.programId)) opens.push(await createDonationIx(conn, { payer: launcher.publicKey, mint, configId: charities[i].id }))
    const update = await updateSharesIx(conn, { mint, authority: launcher.publicKey, shareholders: want.map((h) => ({ address: h.address, bps: h.bps })), current: [launcher.publicKey] })
    // as many opens as fit ride in the lock's own transaction; the rest go first, two at a time
    while (opens.length && !(await fits(conn, launcher, [...opens, update]))) {
      const batch = opens.slice(0, 2)
      const f = await send(conn, launcher, batch)
      if (f.fate !== 'landed') return { wait: `opening charity accounts: ${f.fate} ${f.error ?? ''}`.trim() }
      opens = opens.slice(2)
    }
    // ⛔ written before the send: from here the chain may hold the lock
    const built = await buildTx(conn, { payer: launcher.publicKey, signers: [launcher], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }), ...opens, update] })
    state = { ...state, updateSig: built.signature, updateLvh: built.lastValidBlockHeight }; save(state)
    const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
    if (f.fate !== 'landed') {
      log.error?.(`native split ${mint.toBase58().slice(0, 8)}: lock ${f.fate} ${f.error ?? JSON.stringify(f.err ?? '')}`)
      // a lock the chain keeps refusing will not start working: stop after four refusals and say so
      if (f.fate === 'failed' || f.fate === 'rejected') { state = { ...state, updateSig: null, updateLvh: null, lockRefused: (state.lockRefused ?? 0) + 1 }; save(state); if (state.lockRefused >= 4) return { failed: `Pumpfun refused the lock: ${f.error ?? JSON.stringify(f.err ?? '')}`.slice(0, 200) } }
      return { wait: `the lock: ${f.fate}` }
    }
    cfg = await readSharingConfig(conn, mint)
    if (!cfg?.locked) return { wait: 'the lock landed, reading it back' }
  }

  // ⛔ locked for ever: it must be exactly what the launch promised
  if (!sameShareholders(cfg, want)) return { failed: 'the coin is locked with other shareholders than requested' }

  // GitHub accounts that were never opened (anyone may open them; we pay their rent)
  const gh = want.filter((h) => h.kind === 'github')
  if (gh.length) {
    const infos = await conn.getMultipleAccountsInfo(gh.map((h) => h.address), 'confirmed')
    const opens = []
    for (let i = 0; i < gh.length; i++) if (!infos[i] || infos[i].owner.equals(SystemProgram.programId)) opens.push(await createSocialIx(conn, { payer: launcher.publicKey, githubId: gh[i].id }))
    for (let i = 0; i < opens.length; i += 4) { const f = await send(conn, launcher, opens.slice(i, i + 4)); if (f.fate !== 'landed') return { wait: `opening GitHub accounts: ${f.fate} ${f.error ?? ''}`.trim() } }
  }

  // what Pumpfun paid the launch wallet at the lock goes on to the shareholders, in their shares
  if (state.interim == null) {
    const paid = state.updateSig ? await vaultPaid(conn, state.updateSig, creatorVaultAddress(sharingConfigAddress(mint))) : 0
    if (paid == null) return { wait: 'reading the lock transaction' }
    state = { ...state, interim: paid }; save(state)
  }
  if (state.interim >= FORWARD_MIN_LAMPORTS && !state.forwarded) {
    if (state.forwardSig) {
      const f = await fateOf(conn, state.forwardSig, state.forwardLvh)
      if (f.fate === 'unknown') return { wait: 'the forward is confirming' }
      if (f.fate === 'landed') { state = { ...state, forwarded: true }; save(state) } else { state = { ...state, forwardSig: null, forwardLvh: null }; save(state) }
    }
    if (!state.forwarded) {
      const parts = splitAmount(state.interim, want).filter((p) => p.amount > 0)
      const built = await buildTx(conn, { payer: launcher.publicKey, signers: [launcher], ixs: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }), ...parts.map((p) => SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: p.address, lamports: p.amount }))] })
      state = { ...state, forwardSig: built.signature, forwardLvh: built.lastValidBlockHeight }; save(state)
      const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
      if (f.fate !== 'landed') return { wait: `forwarding the first rewards: ${f.fate} ${f.error ?? ''}`.trim() }
      state = { ...state, forwarded: true }; save(state)
      log.info?.(`native split ${mint.toBase58().slice(0, 8)}: forwarded ${state.interim} lamports earned before the lock`)
    }
  }
  return { done: true, config: cfg.address.toBase58(), interim: state.interim ?? 0 }
}
