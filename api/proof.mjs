/**
 * ⭐ PROOF of every payment (13 Nov, operator: "a payouts page where everything is tracked and verifiable on chain, and
 * on every token page only the payments that token made").
 *
 * One record per payment, newest first, each with the steps that moved the money and the public transaction or account
 * that proves each one (Solscan for Solana, Basescan for Base). Three kinds:
 *   peer     an X Money / payment-app payout: collected from the coins' reward wallets → bridged to Base USDC →
 *            listed on Peer → each buyer's verified payment → (unfilled: withdrawn → bridged back → credited back)
 *   wallet   a payout straight to a Solana wallet the account chose (one transfer from the coin's reward wallet)
 *   pumpfun  what Pumpfun paid itself on a natively split coin (its split of the swept rewards; a charity forward)
 * With `mint`, only records that moved THAT coin's money, and a peer payout counts only that coin's part (its collect
 * transfers; the shared steps say how many coins they carried).
 *
 * ⛔ Nothing here names a Zelle payee in full (appShown masks it), and labels never carry one (outflow labels are
 *    'peer:<app>').
 */
import { appShown, isApp, isOurs } from './rails.mjs'
import { charityById } from './charities.mjs'
import { buckets, sharesOf } from './db.mjs'
import { donationFeeAddress, sharingConfigAddress } from '../lib/feeshare.mjs'
import { SEAL, fundConfig, sealHold } from './projectfund.mjs'

/** The token a payout came from, for its icon on the lists (operator 16 Nov: "the icon of each payout = the token image"). */
const tokenOf = (db, mint) => (mint ? db.prepare('SELECT mint, symbol, image FROM tokens WHERE mint = ?').get(mint) : null)
const icon = (t) => ({ image: t?.image ?? null, symbol: t?.symbol ?? null, mint: t?.mint ?? null })

const SOLSCAN = (sig) => `https://solscan.io/tx/${sig}`
const SOL_ACCOUNT = (a) => `https://solscan.io/account/${a}`
const BASESCAN = (h) => `https://basescan.org/tx/${h}`
const BASE_ACCOUNT = (a) => `https://basescan.org/address/${a}`
const usdc = (n) => Number(n ?? 0) / 1e6
const sol = (n) => Number(n ?? 0) / 1e9

const shownPayee = (r) => (isApp(r.platform) ? appShown(r.platform, r.handle) : `@${r.handle}`)
const railLabel = (r) => (isApp(r.platform) ? appShown(r.platform, r.handle).split(' ')[0] : 'X Money')

/** Status of a Peer payout in one short sentence. */
function peerStatus(r, paidUsd) {
  if (r.state === 'done') return paidUsd > 0 ? (r.return_usdc > 0 ? 'Partly paid; the rest went back to the balance' : 'Paid') : r.returned_lamports > 0 ? 'Nobody paid in time; back in the balance' : 'Ended'
  if (r.state === 'failed') return 'Delayed'
  if (r.state === 'listed') return paidUsd > 0 ? 'Partly paid, waiting for the rest' : 'Listed on Peer, waiting for a payer'
  if (r.state === 'returning' || r.state === 'crediting') return 'Returning to the balance'
  if (r.state === 'bridging') return 'Bridging to Base'
  return 'Preparing'
}

/** One Peer payout's record. `mint` = only that coin's part (null when the payout took nothing from it). */
export function peerRecord(db, r, { mint = null, baseWallet = null } = {}) {
  const collects = db.prepare("SELECT o.signature, o.lamports, o.mint, o.time, t.symbol FROM outflows o LEFT JOIN tokens t ON t.mint = o.mint WHERE o.x_id = ? AND o.kind = 'payout' AND (o.destination LIKE 'xmoney:%' OR o.destination LIKE 'peer:%') AND o.state = 'landed' AND o.time >= ? AND o.time <= ? ORDER BY o.time")
    .all(r.x_id, r.created_at, r.done_at ?? r.updated_at ?? 4e9)
  const mine = mint ? collects.filter((c) => c.mint === mint) : collects
  if (mint && !mine.length) return null
  const coins = new Set(collects.map((c) => c.mint)).size
  const fills = db.prepare('SELECT * FROM xmoney_fills WHERE payout_id = ? ORDER BY paid_at').all(r.id)
  const paidUsd = r.paid_usd + (r.cur_paid_usd ?? 0)
  // this coin's share of the payout (token pages); the whole payout everywhere else
  const part = mint && r.lamports > 0 ? mine.reduce((s, c) => s + c.lamports, 0) / r.lamports : 1
  const shared = mint && coins > 1 ? ` (carried ${coins} tokens' rewards together)` : ''
  const steps = []
  for (const c of mine) steps.push({ step: 'collect', label: `Collected from $${c.symbol ?? '?'}`, amount: `${sol(c.lamports)} SOL`, chain: 'solana', tx: c.signature, url: SOLSCAN(c.signature) })
  if (r.relay_sig) steps.push({ step: 'bridge', label: `Sent to Relay to bridge to Base${shared}`, amount: `${sol(r.lamports)} SOL`, chain: 'solana', tx: r.relay_sig, url: SOLSCAN(r.relay_sig) })
  if (r.bridge_dest_tx) steps.push({ step: 'bridged', label: 'Arrived on Base as USDC', amount: `${usdc(r.usdc)} USDC`, chain: 'base', tx: r.bridge_dest_tx, url: BASESCAN(r.bridge_dest_tx) })
  if (r.deposit_id) {
    const [escrow, id] = String(r.deposit_id).split('_')
    steps.push({ step: 'listed', label: `Listed on Peer as order #${id ?? r.deposit_id}: a buyer pays ${shownPayee(r)} on ${railLabel(r)}`, amount: `${usdc(r.usdc)} USDC`, chain: 'base',
      tx: r.deposit_tx ?? null, url: r.deposit_tx ? BASESCAN(r.deposit_tx) : /^0x[0-9a-fA-F]{40}$/.test(escrow ?? '') ? BASE_ACCOUNT(escrow) : null })
  }
  for (const f of fills) steps.push({ step: 'paid', label: `Buyer paid ${f.fiat_paid != null ? `${f.currency && f.currency !== 'USD' ? f.currency + ' ' : '$'}${Number(f.fiat_paid).toFixed(2)}` : 'the account'}, verified by Peer; USDC released to the buyer`,
    amount: `${usdc(f.usdc)} USDC`, chain: 'base', tx: f.intent_hash, url: f.buyer ? BASE_ACCOUNT(f.buyer) : null, note: 'Peer order (intent) hash; the link opens the buyer\'s address' })
  if (r.withdraw_tx) steps.push({ step: 'withdrawn', label: 'Unfilled USDC withdrawn from Peer', amount: r.return_usdc ? `${usdc(r.return_usdc)} USDC` : null, chain: 'base', tx: r.withdraw_tx, url: BASESCAN(r.withdraw_tx) })
  for (const h of JSON.parse(r.return_txs || '[]')) steps.push({ step: 'bridge-back', label: 'Sent back through Relay to Solana', amount: null, chain: 'base', tx: h, url: BASESCAN(h) })
  if (r.return_dest_tx) steps.push({ step: 'returned', label: 'Arrived back on Solana', amount: `${sol(r.returned_lamports)} SOL`, chain: 'solana', tx: r.return_dest_tx, url: SOLSCAN(r.return_dest_tx) })
  if (r.credit_sig) steps.push({ step: 'credited', label: 'Credited back to the account\'s balance', amount: `${sol(r.returned_lamports)} SOL`, chain: 'solana', tx: r.credit_sig, url: SOLSCAN(r.credit_sig) })
  return {
    ...icon(tokenOf(db, (mine[0] ?? collects[0])?.mint)), people: paidUsd > 0 ? [`x:${r.x_id}`] : [],
    id: `peer-${r.id}`, kind: 'peer', platform: r.platform ?? 'xmoney', time: r.created_at, who: shownPayee(r), whoLink: isApp(r.platform) ? null : `/x/${r.handle}`,
    rail: railLabel(r), status: peerStatus(r, paidUsd), done: r.state === 'done',
    sol: sol(mine.reduce((s, c) => s + c.lamports, 0) || (mint ? 0 : r.lamports)), usd: usdc(r.usdc) * part, paidUsd: paidUsd * part,
    steps, baseWallet,
  }
}

/** A payout straight to a Solana wallet (the account's own choice): the transfer itself is the proof. */
export function walletRecord(db, o) {
  const t = db.prepare('SELECT symbol FROM tokens WHERE mint = ?').get(o.mint)
  const u = o.x_id && /^\d+$/.test(o.x_id) ? db.prepare('SELECT handle FROM users WHERE x_id = ?').get(o.x_id) : null
  return { ...icon(tokenOf(db, o.mint)), people: [o.x_id ? `x:${o.x_id}` : `w:${o.destination}`], id: `wallet-${o.id}`, kind: 'wallet', platform: 'wallet', time: o.time, who: u?.handle ? `@${u.handle}` : 'A recipient', whoLink: u?.handle ? `/x/${u.handle}` : null,
    rail: 'Solana wallet', status: 'Paid', done: true, sol: sol(o.lamports), usd: o.sol_usd ? sol(o.lamports) * o.sol_usd : null, paidUsd: null,
    steps: [{ step: 'paid', label: `Sent from $${t?.symbol ?? '?'}'s reward wallet to ${o.destination.slice(0, 4)}…${o.destination.slice(-4)}`, amount: `${sol(o.lamports)} SOL`, chain: 'solana', tx: o.signature, url: SOLSCAN(o.signature), account: SOL_ACCOUNT(o.destination) }] }
}

/** What Pumpfun paid itself on a natively split coin. */
export function pumpfunRecord(db, e) {
  const t = db.prepare('SELECT symbol FROM tokens WHERE mint = ?').get(e.mint)
  if (e.kind === 'donation') {
    const c = charityById(e.recipient)
    return { ...icon(tokenOf(db, e.mint)), people: [`charity:${e.recipient}`], id: `pf-${e.id}`, kind: 'pumpfun', platform: 'charity', time: e.time, who: c?.name ?? 'A charity', whoLink: null, rail: 'Donate.gg', status: 'Forwarded to the charity', done: true,
      sol: sol(e.lamports), usd: null, paidUsd: null,
      steps: [{ step: 'donated', label: `$${t?.symbol ?? '?'}'s charity share forwarded through Donate.gg's relay`, amount: `${sol(e.lamports)} SOL`, chain: 'solana', tx: e.signature, url: SOLSCAN(e.signature) }] }
  }
  const shares = db.prepare("SELECT kind, handle, recipient_id, bps FROM token_shares WHERE mint = ? AND kind IN ('github', 'charity') ORDER BY slot").all(e.mint)
  // ⭐ the row is the GitHub accounts' part only (operator 16 Nov: list and "Paid out" must agree): the reward wallet's part is
  // paid again as X Money / wallet rows and a charity's as its own donation row. A split with no GitHub share is no row.
  const gh = shares.filter((s) => s.kind === 'github')
  if (!gh.length) return null
  const ghLamports = gh.reduce((n, s) => n + Math.floor(e.lamports * s.bps / 10000), 0)
  if (ghLamports <= 0) return null // dust: nothing reached them
  return { ...icon(tokenOf(db, e.mint)), people: gh.map((s) => `github:${s.recipient_id}`), id: `pf-${e.id}`, kind: 'pumpfun', platform: 'pumpfun', time: e.time, who: gh.map((s) => `${s.handle} on GitHub`).join(', '),
    whoLink: null, rail: 'Pumpfun fee sharing', status: 'Split by Pumpfun', done: true, sol: sol(ghLamports), usd: null, paidUsd: null,
    steps: [{ step: 'split', label: `Pumpfun split $${t?.symbol ?? '?'}'s swept rewards between its shareholders (${shares.map((s) => `${s.kind === 'github' ? s.handle : 'charity'} ${s.bps / 100}%`).join(', ')}, the rest to the reward wallet)`, amount: `${sol(e.lamports)} SOL`, chain: 'solana', tx: e.signature, url: SOLSCAN(e.signature) }] }
}

const MIN_GAP = 10_000 // lamports: rounding and a trade landing between a read and a sweep are not a missed payout

/**
 * What Pumpfun paid on a natively split coin that no recorded transaction of ours covers (operator 16 Nov: "track them in
 * full"). Pumpfun's split is permissionless, and so is a charity's forward, so others may run them; the money still reaches
 * the recipients. Measured against the chain's own numbers:
 *   GitHub   its share of everything the coin's split paid out, known from the X accounts' part (credited to the reward
 *            wallet by our ledger) or, with no X account, from the charities' part (Pumpfun's own count, see below)
 *   charity  Pumpfun's DonationFeePda.total_donated (the keeper keeps it in kv donated:<mint>:<charity>)
 * The rest over what our rows show is one row per recipient, proven by the account on chain instead of a transaction.
 */
export function unseenRecords(db, natives, mint = null) {
  const out = []
  const coins = db.prepare(`SELECT mint, symbol, image, created_at FROM tokens WHERE share_config IS NOT NULL AND quote_mint IS NULL${mint ? ' AND mint = ?' : ''}`).all(...(mint ? [mint] : []))
  for (const t of coins) {
    const shares = sharesOf(db, t.mint), gh = shares.filter((s) => s.kind === 'github'), ch = shares.filter((s) => s.kind === 'charity')
    const xBps = shares.filter((s) => isOurs(s.kind)).reduce((n, s) => n + s.bps, 0), chBps = ch.reduce((n, s) => n + s.bps, 0)
    const last = db.prepare('SELECT MAX(time) t FROM native_events WHERE mint = ?').get(t.mint).t ?? t.created_at
    const donated = new Map(ch.map((c) => { try { return [c.id, JSON.parse(db.prepare('SELECT v FROM kv WHERE k = ?').get(`donated:${t.mint}:${c.id}`)?.v ?? 'null')] } catch { return [c.id, null] } }))
    const mine = natives.filter((r) => r.mint === t.mint)
    for (const c of ch) {
      const d = donated.get(c.id)
      if (!d) continue
      const recorded = Math.round(mine.filter((r) => r.platform === 'charity' && r.people[0] === `charity:${c.id}`).reduce((n, r) => n + r.sol * 1e9, 0))
      const gap = d.total - recorded
      if (gap > MIN_GAP) {
        const name = charityById(c.id)?.name ?? c.handle ?? 'A charity', acc = donationFeeAddress(t.mint, c.id).toBase58()
        out.push({ ...icon(t), people: [`charity:${c.id}`], id: `pfc-${t.mint}-${c.id}`, kind: 'pumpfun', platform: 'charity', time: d.at ?? last, who: name, whoLink: null,
          rail: 'Donate.gg', status: 'Forwarded to the charity', done: true, sol: sol(gap), usd: null, paidUsd: null,
          steps: [{ step: 'donated', label: `Forwarded to the charity in transactions Pump Fund did not send; Pumpfun's own total for it on this account`, amount: `${sol(gap)} SOL`, chain: 'solana', tx: null, url: SOL_ACCOUNT(acc), account: SOL_ACCOUNT(acc) }] })
      }
    }
    if (!gh.length) continue
    let total = null
    if (xBps > 0) total = (buckets(db, t.mint).creatorIn * 10000) / xBps
    else if (chBps > 0 && ch.every((c) => donated.get(c.id))) total = (ch.reduce((n, c) => n + donated.get(c.id).total + donated.get(c.id).waiting, 0) * 10000) / chBps
    if (total == null) continue
    const ghBps = gh.reduce((n, s) => n + s.bps, 0)
    const recorded = Math.round(mine.filter((r) => r.platform === 'pumpfun').reduce((n, r) => n + r.sol * 1e9, 0))
    const gap = Math.floor((total * ghBps) / 10000) - recorded
    if (gap > MIN_GAP && gap > recorded * 0.01) {
      const acc = sharingConfigAddress(t.mint).toBase58()
      out.push({ ...icon(t), people: gh.map((s) => `github:${s.id}`), id: `pfg-${t.mint}`, kind: 'pumpfun', platform: 'pumpfun', time: last,
        who: gh.map((s) => `${s.handle} on GitHub`).join(', '), whoLink: null, rail: 'Pumpfun fee sharing', status: 'Split by Pumpfun', done: true, sol: sol(gap), usd: null, paidUsd: null,
        steps: [{ step: 'split', label: `Split by Pumpfun in transactions Pump Fund did not send (Pumpfun's split can be run by anyone); they are on this account's history`, amount: `${sol(gap)} SOL`, chain: 'solana', tx: null, url: SOL_ACCOUNT(acc), account: SOL_ACCOUNT(acc) }] })
    }
  }
  return out
}

/**
 * $FUND's half for SEAL (api/projectfund.mjs): one record per donation to SEAL's address, its steps every Pumpfun split
 * (and the first-rewards forward) that filled the holding wallet since the donation before; what is still in the
 * holding wallet is one more record, not done ("Held for SEAL"), so nothing is hidden and nothing is counted twice.
 */
export function sealRecords(db, { mint = null, seed = null, env = process.env } = {}) {
  const fund = db.prepare("SELECT v FROM kv WHERE k = 'platform_mint'").get()?.v
  if (!fund || !seed || (mint && mint !== fund)) return []
  const t = tokenOf(db, fund)
  let cfg = null
  try { cfg = fundConfig(env) } catch { return [] }
  const hold = sealHold(seed, fund).publicKey.toBase58()
  const ev = db.prepare('SELECT * FROM fund_events ORDER BY time, id').all()
  const step = (e) => e.kind === 'donated'
    ? { step: 'donated', label: `Sent from SEAL's holding wallet to SEAL's own address ${e.destination.slice(0, 4)}…${e.destination.slice(-4)}`, amount: `${sol(e.lamports)} SOL`, chain: 'solana', tx: e.signature, url: SOLSCAN(e.signature), account: SOL_ACCOUNT(e.destination) }
    : e.kind === 'interim'
      ? { step: 'set-aside', label: `SEAL's ${cfg.bps / 100}% of $${t?.symbol ?? 'FUND'}'s first rewards (earned before the split was locked), moved to SEAL's holding wallet`, amount: `${sol(e.lamports)} SOL`, chain: 'solana', tx: e.signature, url: SOLSCAN(e.signature), account: SOL_ACCOUNT(hold) }
      : { step: 'split', label: `Pumpfun split $${t?.symbol ?? 'FUND'}'s rewards: ${cfg.bps / 100}% to SEAL's holding wallet`, amount: `${sol(e.lamports)} SOL`, chain: 'solana', tx: e.signature, url: SOLSCAN(e.signature), account: SOL_ACCOUNT(hold) }
  const out = []
  let pending = []
  const base = { ...icon(t), kind: 'seal', platform: 'seal', who: SEAL.name, whoLink: null, people: ['seal'], usd: null, paidUsd: null }
  for (const e of ev) {
    if (e.kind !== 'donated') { pending.push(e); continue }
    out.push({ ...base, id: `seal-${e.id}`, time: e.time, rail: 'Solana', status: 'Donated to SEAL', done: true, sol: sol(e.lamports), steps: [...pending.map(step), step(e)] })
    pending = []
  }
  const held = pending.reduce((n, e) => n + e.lamports, 0)
  if (held > 0) out.push({ ...base, people: [], id: 'seal-held', time: pending.at(-1).time, rail: 'Solana', status: cfg.sealAddress ? 'Held for SEAL' : 'Held for SEAL until its Solana address is confirmed', done: false, sol: sol(held), steps: pending.map(step) })
  return out
}

/** Every payment record, newest first; `mint` = only that coin's. { records, total }. */
export function proofRecords(db, { mint = null, limit = 50, offset = 0, baseWallet = null, seal = null } = {}) {
  const peers = db.prepare('SELECT * FROM xmoney_payouts ORDER BY id DESC').all().map((r) => peerRecord(db, r, { mint, baseWallet })).filter(Boolean)
  const wallets = db.prepare(`SELECT * FROM outflows WHERE kind = 'payout' AND state = 'landed' AND destination NOT LIKE 'xmoney:%' AND destination NOT LIKE 'peer:%'${mint ? ' AND mint = ?' : ''}`).all(...(mint ? [mint] : [])).map((o) => walletRecord(db, o))
  const natives = db.prepare(`SELECT * FROM native_events${mint ? ' WHERE mint = ?' : ''}`).all(...(mint ? [mint] : [])).map((e) => pumpfunRecord(db, e)).filter(Boolean)
  const unseen = unseenRecords(db, natives, mint)
  const seals = seal ? sealRecords(db, { mint, seed: seal.seed, env: seal.env }) : []
  const all = [...peers, ...wallets, ...natives, ...unseen, ...seals].sort((a, b) => b.time - a.time)
  return { records: all.slice(offset, offset + limit), total: all.length }
}
