/**
 * ⭐ X Money payouts (operator 11 Nov: "see how BagsPay does it").
 *
 * X has no API for an app to send money to an X Money account. What BagsPay (and we) use instead is Peer
 * (peer.xyz, ex-ZKP2P): a market where people BUY USDC on Base by paying fiat. We put the creator's fees up for sale as
 * Base USDC, and the order says "pay for this by sending dollars to @handle on X Money". A buyer pays the creator from
 * their own X Money; Peer verifies that payment (a TLS proof of the X Money receipt) and only then releases our USDC to
 * the buyer. Probed 11 Nov: the xmoney:USD corridor had 296 fills in 30 days, median ~22 h from listing to payment.
 *
 * ✅ VERIFIED against BagsPay itself (11 Nov, read from chain): its Peer deposits carry the attribution `bags-payout-bot`
 * from depositor 0x5832bE95…0177, 188 X Money deposits via Peer Cash `cashout` (intent range 1 USDC .. the whole
 * deposit, the SDK default), each funded seconds before by Relay's solver (0xf70da978…) from a Relay SOL→Base-USDC
 * request (Solana payer PAY9yjtc…). Buyers often abandon (733 pruned vs 263 filled) and the deposit simply stays
 * live; only a sub-$1 remainder (below Peer's 1 USDC minimum fill) is withdrawn. Median listing→closed 24 h, p90 52 h.
 *
 * One payout (a row of xmoney_payouts) runs, one step per keeper pass (every 5 min):
 *
 *   collecting  the creator's SOL buckets → the keeper wallet: ordinary payout outflows (label 'xmoney:@handle'), so the
 *               ledger's rule holds: SOL leaves a bucket only as an outflow the chain answered
 *   bridging    keeper SOL → Relay (relay.link) → USDC in our Base wallet. The Solana deposit is signed by the keeper; the
 *               USDC that arrived is read from the Base fill transaction's Transfer log, never assumed from the quote
 *   listing     Peer Cash `cashout()`: deposit that USDC, payee = the creator's X handle, X Money, USD, market rate
 *   listed      read the order each pass. Fully paid → done. A remainder under 1 USDC (no buyer can take it) →
 *               withdrawn and carried into the account's next payout. Unfilled after XMONEY_MAX_DAYS, or the creator
 *               left X Money → the unfilled USDC is withdrawn and sent home. An abandoned buyer changes nothing:
 *               Peer prunes the intent and the order takes the next buyer (as BagsPay's do)
 *   returning   unfilled USDC → Relay → keeper SOL (the SOL that arrived is read from the Solana fill transaction)
 *   crediting   keeper → the coin's fee wallet, booked to that coin's CREATOR bucket: the creator's balance again
 *
 * ⭐ PAYMENT APPS (13 Nov, api/rails.mjs): a Venmo / Cash App / Zelle / Chime recipient is paid by exactly the same steps,
 * with `platform` = that app and the payee from its token_shares row. Its row's x_id is its ledger key ('venmo:jane').
 * Nobody can sign in as it, so it never "leaves": its payout only ends paid, or unfilled after XMONEY_MAX_DAYS. A payee
 * nobody can pay (a typo, a closed account) would otherwise loop for ever (bridge out, wait, bridge back): after an
 * unfilled payout the next waits APP_RETRY_DAYS × the unfilled run, and after APP_MAX_UNFILLED in a row it stops (the
 * balance stays owed; the operator decides).
 *
 * ⛔ Rules this file keeps:
 *   - one live payout per account: a UNIQUE partial index on xmoney_payouts refuses a second (memory
 *     in-process-guard-is-not-a-db-lock)
 *   - money is only booked from a positive answer (the chain's fate, Relay's 'success', Peer's order state); 'unknown'
 *     waits (memory tx-expiry-needs-positive-answer)
 *   - every step is resumable from the row alone: a crash between "sent" and "written" is found again (Solana by the
 *     stored signature, Peer by the wallet's order list, Relay by the stored request id)
 *   - the Base wallet's key is DERIVED from FEE_SEED (like every fee wallet), so the FEE_SEED backup also covers it
 */
import { handleForXId } from './providers/twitterapiio.mjs'
import { createHmac } from 'node:crypto'
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { buildTx, fateOf, sendUntilFate } from '../lib/tx.mjs'
import { feeWallet } from './feewallet.mjs'
import { lockCoin, now, owedTo, unlockCoin } from './db.mjs'
import { keeperConfig, payCreator } from './keeper.mjs'
import { APP_KINDS, APP_RAILS, isApp } from './rails.mjs'

export const SOLANA_RELAY_CHAIN = 792703809
export const BASE_CHAIN = 8453
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const SOL_NATIVE = '11111111111111111111111111111111'
const RELAY_API = 'https://api.relay.link'
const LIVE = ['collecting', 'bridging', 'listing', 'listed', 'returning', 'crediting']

export function xmoneyConfig(env = process.env) {
  return {
    enabled: env.XMONEY_ENABLED === '1',
    // a payout starts once the creator's SOL reaches max(this, their own threshold): Relay's fee is ~$0.11 + 0.15%
    minLamports: Number(env.XMONEY_MIN_LAMPORTS ?? 100_000_000),
    maxDays: Number(env.XMONEY_MAX_DAYS ?? 14),
    maxAttempts: Number(env.XMONEY_MAX_ATTEMPTS ?? 5),
    dustUsdc: Number(env.XMONEY_DUST_USDC ?? 500_000), // $0.50: below this, unfilled USDC is not worth a bridge back
    minEthWei: BigInt(env.XMONEY_MIN_ETH_WEI ?? '20000000000000'), // 0.00002 ETH: Base gas for a deposit/withdraw
    adoptSeconds: Number(env.XMONEY_ADOPT_SECONDS ?? 600), // Peer's indexer lag before a lost cashout is re-sent
    // ⛔ mainnet.base.org alone 429s ('request limit reached', seen 11 Nov): a fallback list, BASE_RPC_URL first
    baseRpcs: [...new Set([...(env.BASE_RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...(env.BASE_RPC_URL_ONLY === '1' ? [] : ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'])])],
    minFillUsdc: 1_000_000n, // Peer Cash's minimum intent (capabilities().amount.recommendedMin; BagsPay's intentAmountMin)
    twitterApiKey: env.TWITTERAPI_IO_KEY ?? '', // the payee's current handle by X id, for accounts that never signed in
    appRetryDays: Number(env.APP_RETRY_DAYS ?? 7),
    appMaxUnfilled: Number(env.APP_MAX_UNFILLED ?? 3),
  }
}

/** The Base wallet's private key: HMAC(FEE_SEED, label). Never stored, never logged. */
export const baseKey = (seed) => `0x${createHmac('sha256', seed).update('pumpfund-base-xmoney:v1').digest('hex')}`

const big = (v) => BigInt(v ?? 0)

/**
 * The real rails: Relay (REST), Base (viem) and Peer Cash (@zkp2p/cash). Loaded only by the keeper, only when enabled.
 * Tests pass their own object with the same shape.
 */
export async function realRails(seed, cfg = xmoneyConfig()) {
  const { createPublicClient, createWalletClient, http, fallback, erc20Abi, parseEventLogs } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { base } = await import('viem/chains')
  const { createCashClient } = await import('@zkp2p/cash')
  const account = privateKeyToAccount(baseKey(seed))
  const transport = cfg.baseRpcs.length === 1 ? http(cfg.baseRpcs[0]) : fallback(cfg.baseRpcs.map((u) => http(u)))
  const pub = createPublicClient({ chain: base, transport })
  const wallet = createWalletClient({ account, chain: base, transport })
  // `referrer`: analytics-only attribution on our deposits, as BagsPay tags theirs 'bags-payout-bot'
  const cash = createCashClient({ environment: 'production', transport, referrer: 'pumpfund-payout-bot' })
  const relayFetch = async (path, body) => {
    const r = await fetch(`${RELAY_API}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`relay ${path.split('?')[0]} ${r.status}: ${j.message ?? 'no answer'}`)
    return j
  }
  // current @handle of an X id (null = no such account; throws = the lookup failed)
  const handleOf = cfg.twitterApiKey ? async (xId) => (await handleForXId(cfg.twitterApiKey, xId))?.handle ?? null : null
  return {
    handleOf,
    baseAddress: account.address,
    relay: {
      quote: (body) => relayFetch('/quote', body),
      status: (requestId) => relayFetch(`/intents/status/v2?requestId=${encodeURIComponent(requestId)}`),
    },
    base: {
      ethBalance: () => pub.getBalance({ address: account.address }),
      usdcBalance: () => pub.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      /** One Relay EVM step item: sent, then its receipt must say success. */
      async send(d) {
        const hash = await wallet.sendTransaction({ to: d.to, data: d.data, value: big(d.value),
          ...(d.gas ? { gas: big(d.gas) } : {}), ...(d.maxFeePerGas ? { maxFeePerGas: big(d.maxFeePerGas), maxPriorityFeePerGas: big(d.maxPriorityFeePerGas) } : {}) })
        const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
        if (rc.status !== 'success') throw new Error(`base tx ${hash} reverted`)
        return hash
      },
      /** USDC that a Base transaction moved INTO our wallet (from its Transfer logs). */
      async usdcIn(hash) {
        const rc = await pub.getTransactionReceipt({ hash })
        const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: rc.logs.filter((l) => l.address.toLowerCase() === BASE_USDC) })
        return logs.filter((l) => l.args.to.toLowerCase() === account.address.toLowerCase()).reduce((s, l) => s + l.args.value, 0n)
      },
    },
    peer: {
      async cashout({ amount, payee, platform = 'xmoney' }) {
        const currency = platform === 'xmoney' ? 'USD' : APP_RAILS[platform]?.currency
        if (!currency) throw new Error(`no Peer corridor for ${platform}`)
        const r = await cash.cashout({ amount: big(amount), receive: { platform, currency, payee } }, { signer: wallet })
        return { depositId: r.depositId, txHash: r.txHash ?? null }
      },
      order: (depositId) => cash.order(depositId),
      orders: () => cash.orders(account.address, { limit: 100 }),
      // ⭐ PayPal: has the owner connected this account with Peer (read-only; api/paypal.mjs)
      connected: (platform, payee) => cash.isSarConnected({ platform, payeeHandle: payee }),
      withdraw: async (depositId) => { const r = await cash.withdraw(depositId, { signer: wallet }); return { withdrawTxHash: r?.withdrawTxHash ?? null } },
    },
  }
}

/** SOL that a Solana transaction moved into `owner` (post − pre). Reads version-1 transactions too. */
export async function solIn(conn, signature, owner) {
  const tx = await conn._rpcRequest('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }])
  const t = tx?.result
  if (!t?.meta) return null
  const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])]
  const i = keys.indexOf(owner)
  return i < 0 ? 0 : t.meta.postBalances[i] - t.meta.preBalances[i]
}

const setRow = (db, id, f) => {
  const cols = Object.keys(f)
  db.prepare(`UPDATE xmoney_payouts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => f[c]), now(), id)
}
/** The outflow label of a payout: 'xmoney:@handle', or 'peer:venmo' for an app (⛔ never the payee: labels are public). */
export const payoutLabel = (platform, handle) => (isApp(platform) ? `peer:${platform}` : `xmoney:@${handle}`)
/** The payout outflows that belong to one row: its account's 'xmoney:' / 'peer:' payouts since the row was made. */
const outflowsOf = (db, row) => db.prepare("SELECT * FROM outflows WHERE x_id = ? AND kind = 'payout' AND (destination LIKE 'xmoney:%' OR destination LIKE 'peer:%') AND time >= ?").all(row.x_id, row.created_at)

/**
 * May an app account start a payout now? { ok } or { ok: false, why }. Counts its payouts that ended with nobody paying
 * (in a row, newest first): each one pushes the next try out by appRetryDays, and appMaxUnfilled of them stop it.
 */
export function appMayStart(db, key, cfg, t = now()) {
  const rows = db.prepare("SELECT paid_usd, returned_lamports, return_usdc, done_at FROM xmoney_payouts WHERE x_id = ? AND state = 'done' ORDER BY id DESC LIMIT ?").all(key, cfg.appMaxUnfilled)
  let run = 0
  for (const r of rows) { if (r.paid_usd > 0 || !(r.returned_lamports > 0 || r.return_usdc > 0)) break; run++ }
  if (run >= cfg.appMaxUnfilled) return { ok: false, why: `${run} payouts in a row found nobody to pay this account: stopped` }
  if (run > 0 && t - rows[0].done_at < run * cfg.appRetryDays * 86400) return { ok: false, why: 'waiting after an unfilled payout' }
  return { ok: true }
}

/** Starts a payout for every X Money account whose SOL passed its threshold. */
async function start(db, conn, { keeper, seed, cfg, solUsd, log, rails }) {
  const started = []
  for (const c of db.prepare(`SELECT p.x_id, SUM(p.carry_usdc) n, MAX(p.refund_mint) mint, MAX(p.handle) handle FROM xmoney_payouts p JOIN users u ON u.x_id = p.x_id
      WHERE p.carry_usdc > 0 AND p.carry_used = 0 AND NOT (u.payout_kind = 'xmoney' AND (u.payout_confirmed = 1 OR u.payout_auto = 1)) GROUP BY p.x_id`).all()) {
    if (c.n < cfg.dustUsdc) continue // under $0.50: stays on Base until the account picks X Money again
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare("INSERT INTO xmoney_payouts (x_id, handle, state, refund_mint, return_usdc, usdc, created_at, updated_at) VALUES (?, ?, 'returning', ?, ?, ?, ?, ?)").run(c.x_id, c.handle, c.mint, c.n, c.n, now(), now())
      db.prepare('UPDATE xmoney_payouts SET carry_used = 1 WHERE x_id = ? AND carry_usdc > 0 AND carry_used = 0').run(c.x_id)
      db.exec('COMMIT')
      started.push({ xmoney: c.handle, carryHome: c.n })
    } catch { db.exec('ROLLBACK') } // the unique index: a live payout of that account exists; next pass
  }
  // confirmed by the account itself, or set up for it by a launch made for it (payout_auto, 12 Nov)
  const users = db.prepare("SELECT * FROM users WHERE payout_kind = 'xmoney' AND (payout_confirmed = 1 OR payout_auto = 1) AND handle IS NOT NULL").all()
  for (const u of users) {
    if (db.prepare(`SELECT 1 FROM xmoney_payouts WHERE x_id = ? AND state IN (${LIVE.map(() => '?').join(',')})`).get(u.x_id, ...LIVE)) continue
    const owed = owedTo(db, u.x_id).total
    if (owed < Math.max(cfg.minLamports, u.auto_min_lamports)) continue
    let id
    try {
      id = Number(db.prepare("INSERT INTO xmoney_payouts (x_id, handle, state, sol_usd, created_at, updated_at) VALUES (?, ?, 'collecting', ?, ?, ?)")
        .run(u.x_id, u.handle, solUsd, now(), now()).lastInsertRowid)
    } catch { continue } // the unique index: another payout of this account is live
    try {
      const r = await payCreator(db, conn, { keeper, seed, xId: u.x_id, destination: keeper.publicKey.toBase58(), minLamports: 1, cfg: keeperConfig(), solUsd, label: payoutLabel('xmoney', u.handle) })
      setRow(db, id, { collect_sigs: JSON.stringify(r.signatures) })
      if (!r.signatures.length) db.prepare('DELETE FROM xmoney_payouts WHERE id = ?').run(id) // nothing was sent: no payout
      else started.push({ xmoney: u.handle, collecting: r.total })
    } catch (e) {
      // nothing signed (a short bucket, a busy coin): the row is dropped; anything that WAS sent is found by outflowsOf
      if (!outflowsOf(db, { x_id: u.x_id, created_at: db.prepare('SELECT created_at FROM xmoney_payouts WHERE id = ?').get(id).created_at }).length) db.prepare('DELETE FROM xmoney_payouts WHERE id = ?').run(id)
      log.error?.(`xmoney start @${u.handle}: ${e.message}`)
    }
  }
  // ⭐ payment-app recipients: every one is paid automatically (nobody chooses for them)
  const apps = db.prepare(`SELECT recipient_id key, kind, MIN(handle) payee FROM token_shares WHERE kind IN (${APP_KINDS.map(() => '?').join(',')}) GROUP BY recipient_id, kind`).all(...APP_KINDS)
  for (const a of apps) {
    if (!a.payee) continue
    if (db.prepare(`SELECT 1 FROM xmoney_payouts WHERE x_id = ? AND state IN (${LIVE.map(() => '?').join(',')})`).get(a.key, ...LIVE)) continue
    if (owedTo(db, a.key).total < cfg.minLamports) continue
    if (!appMayStart(db, a.key, cfg).ok) continue
    // ⛔ PayPal: Peer refuses a cash-out until the owner connected the account. Asked BEFORE anything is collected or
    // bridged; no answer = not now. The share waits in its balance meanwhile.
    if (APP_RAILS[a.kind]?.needsConnect) {
      let ok = false
      try { ok = !!(await rails.peer.connected?.(a.kind, a.payee)) } catch { ok = false }
      if (!ok) continue
    }
    let id
    try {
      id = Number(db.prepare("INSERT INTO xmoney_payouts (x_id, handle, platform, state, sol_usd, created_at, updated_at) VALUES (?, ?, ?, 'collecting', ?, ?, ?)")
        .run(a.key, a.payee, a.kind, solUsd, now(), now()).lastInsertRowid)
    } catch { continue }
    try {
      const r = await payCreator(db, conn, { keeper, seed, xId: a.key, destination: keeper.publicKey.toBase58(), minLamports: 1, cfg: keeperConfig(), solUsd, label: payoutLabel(a.kind, a.payee) })
      setRow(db, id, { collect_sigs: JSON.stringify(r.signatures) })
      if (!r.signatures.length) db.prepare('DELETE FROM xmoney_payouts WHERE id = ?').run(id)
      else started.push({ payout: a.kind, collecting: r.total })
    } catch (e) {
      if (!outflowsOf(db, { x_id: a.key, created_at: db.prepare('SELECT created_at FROM xmoney_payouts WHERE id = ?').get(id).created_at }).length) db.prepare('DELETE FROM xmoney_payouts WHERE id = ?').run(id)
      log.error?.(`payout start ${a.kind} #${id}: ${e.message}`)
    }
  }
  return started
}

async function stepCollecting(db, row) {
  const outs = outflowsOf(db, row)
  if (outs.some((o) => o.state === 'sending')) return 'wait'
  const landed = outs.filter((o) => o.state === 'landed')
  const lamports = landed.reduce((s, o) => s + o.lamports, 0)
  if (!lamports) {
    if (now() - row.created_at < 600) return 'wait'
    setRow(db, row.id, { state: 'done', done_at: now(), error: 'nothing was collected; the fees stayed in the balance' })
    return 'empty'
  }
  // the coin that gave the most: any unfilled remainder is credited back to its creator bucket
  const top = landed.sort((a, b) => b.lamports - a.lamports)[0]
  setRow(db, row.id, { state: 'bridging', lamports, refund_mint: top.mint })
  return 'collected'
}

/** Relay's Solana deposit, built and signed by the keeper (the only signer it may ask for). */
async function relayDepositTx(conn, keeper, quote) {
  const step = quote.steps?.find((s) => s.kind === 'transaction')
  const data = step?.items?.[0]?.data
  if (!step?.requestId || !data?.instructions?.length) throw new Error('relay quote has no Solana deposit')
  const ixs = data.instructions.map((i) => new TransactionInstruction({
    programId: new PublicKey(i.programId), data: Buffer.from(i.data, 'hex'),
    keys: i.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
  }))
  for (const ix of ixs) for (const k of ix.keys) if (k.isSigner && !k.pubkey.equals(keeper.publicKey)) throw new Error(`relay asks for a signer that is not the keeper: ${k.pubkey.toBase58()}`)
  if (!ixs.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) ixs.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
  const luts = []
  for (const a of data.addressLookupTableAddresses ?? []) {
    const l = (await conn.getAddressLookupTable(new PublicKey(a))).value
    if (!l) throw new Error(`relay lookup table ${a} not found`)
    luts.push(l)
  }
  return { requestId: step.requestId, built: await buildTx(conn, { payer: keeper.publicKey, ixs, signers: [keeper], lookupTables: luts }) }
}

async function stepBridging(db, conn, { keeper, rails, cfg, log }, row) {
  if (!row.relay_sig) {
    if (row.relay_attempts >= cfg.maxAttempts) { setRow(db, row.id, { state: 'crediting', returned_lamports: row.lamports, error: 'the bridge to Base failed repeatedly; the SOL goes back to the balance' }); return 'giving-back' }
    const bal = await conn.getBalance(keeper.publicKey)
    if (bal < row.lamports + 10_000_000) { log.error?.(`xmoney #${row.id}: keeper holds ${bal / 1e9} SOL, needs ${row.lamports / 1e9} + fees`); return 'wait' }
    const quote = await rails.relay.quote({ user: keeper.publicKey.toBase58(), recipient: rails.baseAddress, originChainId: SOLANA_RELAY_CHAIN, destinationChainId: BASE_CHAIN,
      originCurrency: SOL_NATIVE, destinationCurrency: BASE_USDC, amount: String(row.lamports), tradeType: 'EXACT_INPUT' })
    const { requestId, built } = await relayDepositTx(conn, keeper, quote)
    // written BEFORE the send: a crash after it is found again by this signature
    setRow(db, row.id, { relay_request: requestId, relay_sig: built.signature, relay_lvh: built.lastValidBlockHeight, relay_attempts: row.relay_attempts + 1 })
    const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
    if (f.fate === 'rejected' || f.fate === 'expired' || f.fate === 'failed') { setRow(db, row.id, { relay_sig: null, relay_request: null, error: `bridge deposit ${f.fate}: ${f.error ?? ''}`.trim() }); return 'retry' }
    return 'sent'
  }
  const f = await fateOf(conn, row.relay_sig, row.relay_lvh)
  if (f.fate === 'unknown') return 'wait'
  if (f.fate !== 'landed') { setRow(db, row.id, { relay_sig: null, relay_request: null, error: `bridge deposit ${f.fate}` }); return 'retry' }
  const st = await rails.relay.status(row.relay_request)
  if (st.status === 'success') {
    const dest = (st.txHashes ?? [])[0]
    if (!dest) return 'wait'
    const usdc = await rails.base.usdcIn(dest)
    if (usdc <= 0n) { setRow(db, row.id, { state: 'failed', error: `relay says success but ${dest} paid our Base wallet no USDC` }); return 'failed' }
    setRow(db, row.id, { state: 'listing', usdc: Number(usdc), bridge_dest_tx: dest, error: null })
    return 'bridged'
  }
  if (st.status === 'refund' || st.status === 'failure') {
    // Relay refunds the SOL to its sender (the keeper): give it back to the creator
    setRow(db, row.id, { state: 'crediting', returned_lamports: row.lamports, error: `the bridge ${st.status === 'refund' ? 'refunded' : 'failed'}; the SOL goes back to the balance` })
    return 'giving-back'
  }
  if (now() - row.updated_at > 6 * 3600) log.error?.(`xmoney #${row.id}: Relay request ${row.relay_request} still ${st.status} after 6 h`)
  return 'wait'
}

// an app account cannot leave (nobody signs in as it); an X account leaves by picking another payout
const stillXMoney = (db, row) => isApp(row.platform) || !!db.prepare("SELECT 1 FROM users WHERE x_id = ? AND payout_kind = 'xmoney' AND (payout_confirmed = 1 OR payout_auto = 1)").get(row.x_id)

async function stepListing(db, { rails, cfg, log }, row) {
  if (!stillXMoney(db, row)) { setRow(db, row.id, { state: 'returning', return_usdc: row.usdc }); return 'left' }
  if (big(await rails.base.ethBalance()) < cfg.minEthWei) { log.error?.(`xmoney #${row.id}: Base wallet ${rails.baseAddress} needs ETH for gas`); return 'wait' }
  if (row.list_started_at) {
    // a cashout may have gone out before a crash: adopt an order of that size no row owns yet
    const known = new Set(db.prepare('SELECT deposit_id FROM xmoney_payouts WHERE deposit_id IS NOT NULL').all().map((r) => r.deposit_id))
    const lost = (await rails.peer.orders()).find((o) => !known.has(o.depositId) && big(o.totalAmount) === big(row.usdc) && !o.withdrawn)
    if (lost) { setRow(db, row.id, { state: 'listed', deposit_id: lost.depositId, listed_at: now() }); return 'adopted' }
    if (now() - row.list_started_at < cfg.adoptSeconds) return 'wait'
  }
  if (!row.list_started_at) {
    // sub-$1 remainders this account left on earlier payouts ride along with this one
    db.exec('BEGIN IMMEDIATE')
    try {
      const c = db.prepare("SELECT COALESCE(SUM(carry_usdc), 0) n FROM xmoney_payouts WHERE x_id = ? AND id != ? AND carry_usdc > 0 AND carry_used = 0").get(row.x_id, row.id).n
      if (c > 0) {
        db.prepare("UPDATE xmoney_payouts SET carry_used = 1 WHERE x_id = ? AND id != ? AND carry_usdc > 0 AND carry_used = 0").run(row.x_id, row.id)
        row = { ...row, usdc: row.usdc + c }
      }
      setRow(db, row.id, { usdc: row.usdc, list_started_at: now() })
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  } else setRow(db, row.id, { list_started_at: now() })
  if (isApp(row.platform)) {
    // the payee exactly as it was fixed at launch (api/rails.mjs canonical form)
    let r
    try { r = await rails.peer.cashout({ amount: big(row.usdc), payee: row.handle, platform: row.platform }) } catch (e) {
      // the connection went away between the check and the listing: the USDC comes home, the share waits again
      if (e?.code === 'PAYEE_VERIFICATION_REQUIRED') { setRow(db, row.id, { state: 'returning', return_usdc: row.usdc, error: `${APP_RAILS[row.platform]?.label ?? row.platform} account is not connected with Peer` }); return 'not-connected' }
      throw e
    }
    setRow(db, row.id, { state: 'listed', deposit_id: r.depositId, deposit_tx: r.txHash ?? null, listed_at: now(), error: null })
    return 'listed'
  }
  let handle = (db.prepare('SELECT handle FROM users WHERE x_id = ?').get(row.x_id)?.handle ?? row.handle).replace(/^@/, '')
  // ⛔ Peer pays a HANDLE. An account that never signed in (X Money set up for it by a launch made for it) is looked up by
  //    its permanent X id right before listing, so a rename (and a stranger taking the old name) can never be paid.
  //    No answer = no listing this pass; an account that no longer exists keeps its balance (never listed).
  if (db.prepare('SELECT payout_auto FROM users WHERE x_id = ?').get(row.x_id)?.payout_auto && rails.handleOf) {
    let now_ = null
    try { now_ = await rails.handleOf(row.x_id) } catch (e) { setRow(db, row.id, { error: `handle lookup failed: ${String(e.message).slice(0, 120)}` }); return 'wait' }
    if (!now_) { setRow(db, row.id, { error: 'the X account no longer exists: not listed' }); return 'wait' }
    if (now_ !== handle) { db.prepare('UPDATE users SET handle = ? WHERE x_id = ?').run(now_, row.x_id); handle = now_ }
  }
  const r = await rails.peer.cashout({ amount: big(row.usdc), payee: handle })
  setRow(db, row.id, { state: 'listed', deposit_id: r.depositId, deposit_tx: r.txHash ?? null, listed_at: now(), handle, error: null })
  return 'listed'
}

/** Every buyer who paid this payout, once Peer has verified their payment (FULFILLED / MANUALLY_RELEASED). Idempotent. */
export function recordFills(db, payoutId, fills = []) {
  const ins = db.prepare('INSERT OR IGNORE INTO xmoney_fills (intent_hash, payout_id, buyer, usdc, fiat_paid, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const f of fills ?? []) {
    if (!f?.intentHash || !(f.status === 'FULFILLED' || f.status === 'MANUALLY_RELEASED')) continue
    ins.run(String(f.intentHash), payoutId, f.buyer ?? null, Number(f.releasedAmount ?? f.amount ?? 0), f.fiatPaid ?? null, f.paidCurrency ?? f.currency ?? null, f.paidAt ?? f.fulfilledAt ?? null)
  }
}

async function stepListed(db, { rails, cfg }, row) {
  const o = await rails.peer.order(row.deposit_id)
  const total = big(o.totalAmount), filled = big(o.filledAmount), pending = big(o.pendingAmount), returned = big(o.returnedAmount)
  const paidUsd = (o.fills ?? []).reduce((s, f) => s + (f.fiatPaid ?? 0), 0)
  const open = total - filled - pending - returned
  setRow(db, row.id, { cur_filled_usdc: Number(filled), cur_paid_usd: paidUsd })
  recordFills(db, row.id, o.fills)
  if (pending > 0n) return 'wait' // a buyer is paying: never pull the USDC from under them
  const totals = { filled_usdc: row.filled_usdc + Number(filled), paid_usd: row.paid_usd + paidUsd, cur_filled_usdc: 0, cur_paid_usd: 0 }
  if (open <= 0n && returned === 0n) { setRow(db, row.id, { ...totals, state: 'done', done_at: now() }); return 'paid' }
  const left = !stillXMoney(db, row)
  const stale = now() - row.listed_at > cfg.maxDays * 86400
  // a remainder under Peer's minimum fill can never be bought: BagsPay withdraws it; we carry it to the next payout
  const stub = open > 0n && open < cfg.minFillUsdc && filled > 0n
  if (open > 0n && !(left || stale || stub)) return 'wait' // an abandoned buyer is pruned by Peer; the order stays live
  if (open > 0n) { const w = await rails.peer.withdraw(row.deposit_id); if (w?.withdrawTxHash) setRow(db, row.id, { withdraw_tx: w.withdrawTxHash }) }
  // what came back is what the order says came back (a crash after the withdraw lands here too)
  const back = big((open > 0n ? await rails.peer.order(row.deposit_id) : o).returnedAmount)
  if (back <= 0n) return 'wait'
  if (stub && !left) { setRow(db, row.id, { ...totals, state: 'done', done_at: now(), carry_usdc: Number(back) }); return 'carried' }
  setRow(db, row.id, { ...totals, state: 'returning', return_usdc: Number(back) })
  return 'returning'
}

async function stepReturning(db, conn, { keeper, rails, cfg, log }, row) {
  if (row.return_usdc < cfg.dustUsdc) {
    setRow(db, row.id, { state: 'done', done_at: now(), error: row.return_usdc ? `$${(row.return_usdc / 1e6).toFixed(2)} unfilled was too small to bring back` : null })
    return 'dust'
  }
  if (row.return_request) {
    const st = await rails.relay.status(row.return_request).catch(() => ({ status: 'unknown' }))
    if (st.status === 'success') {
      const dest = (st.txHashes ?? [])[0]
      const got = dest ? await solIn(conn, dest, keeper.publicKey.toBase58()) : null
      if (!got) return 'wait'
      setRow(db, row.id, { state: 'crediting', returned_lamports: got, return_dest_tx: dest })
      return 'back'
    }
    if (st.status === 'refund' || st.status === 'failure') { setRow(db, row.id, { return_request: null, relay_attempts: row.relay_attempts + 1, error: `the bridge back ${st.status}` }); return 'retry' }
    // never deposited (a crash between quote and send): redo once the wallet still holds the USDC and enough time passed
    if ((st.status === 'waiting' || st.status === 'unknown') && now() - row.return_started_at > 1800 && big(await rails.base.usdcBalance()) >= big(row.return_usdc)) {
      setRow(db, row.id, { return_request: null })
      return 'retry'
    }
    return 'wait'
  }
  if (row.relay_attempts >= cfg.maxAttempts * 2) { setRow(db, row.id, { state: 'failed', error: 'the bridge back to Solana failed repeatedly; the USDC is in the Base wallet' }); return 'failed' }
  if (big(await rails.base.ethBalance()) < cfg.minEthWei) { log.error?.(`xmoney #${row.id}: Base wallet ${rails.baseAddress} needs ETH for gas`); return 'wait' }
  const quote = await rails.relay.quote({ user: rails.baseAddress, recipient: keeper.publicKey.toBase58(), originChainId: BASE_CHAIN, destinationChainId: SOLANA_RELAY_CHAIN,
    originCurrency: BASE_USDC, destinationCurrency: SOL_NATIVE, amount: String(row.return_usdc), tradeType: 'EXACT_INPUT' })
  const steps = (quote.steps ?? []).filter((s) => s.kind === 'transaction')
  const requestId = steps.find((s) => s.requestId)?.requestId
  if (!requestId) throw new Error('relay quote back has no request id')
  setRow(db, row.id, { return_request: requestId, return_started_at: now() })
  const sent = []
  for (const s of steps) for (const it of s.items ?? []) {
    if (Number(it.data?.chainId) !== BASE_CHAIN) throw new Error('relay step is not on Base')
    sent.push(await rails.base.send(it.data))
    setRow(db, row.id, { return_txs: JSON.stringify(sent) })
  }
  return 'sent'
}

async function stepCrediting(db, conn, { keeper, seed, cfg }, row) {
  const coin = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(row.refund_mint)
  if (!coin) { setRow(db, row.id, { state: 'failed', error: `refund coin ${row.refund_mint} is unknown` }); return 'failed' }
  const fw = feeWallet(seed, coin.mint).publicKey
  if (fw.toBase58() !== coin.fee_wallet) throw new Error(`FEE_SEED does not derive ${coin.fee_wallet}`)
  if (row.credit_sig) {
    const f = await fateOf(conn, row.credit_sig, row.credit_lvh)
    if (f.fate === 'unknown') return 'wait'
    if (f.fate === 'landed') { setRow(db, row.id, { state: 'done', done_at: now() }); return 'credited' }
    // never landed: take the booking back and try again
    db.prepare('DELETE FROM credits WHERE signature = ? AND mint = ?').run(row.credit_sig, coin.mint)
    setRow(db, row.id, { credit_sig: null, credit_lvh: null, relay_attempts: row.relay_attempts + 1 })
    return 'retry'
  }
  if (row.relay_attempts >= cfg.maxAttempts * 3) { setRow(db, row.id, { state: 'failed', error: 'crediting the balance failed repeatedly' }); return 'failed' }
  if (!lockCoin(db, coin.mint, 300)) return 'wait'
  try {
    const built = await buildTx(conn, { payer: keeper.publicKey, signers: [keeper], ixs: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: fw, lamports: row.returned_lamports }),
    ] })
    // ⛔ booked BEFORE the send, with this signature: the SOL then never looks like new fees to the keeper's credit step
    // (a booking above the wallet's balance reads as no surplus); an expired send deletes the booking again
    db.exec('BEGIN IMMEDIATE')
    try {
      // booked to the account the payout was for (on a split coin the others' shares are untouched)
      db.prepare("INSERT INTO credits (mint, bucket, lamports, signature, time, sol_usd, x_id) VALUES (?, 'creator', ?, ?, ?, ?, ?)").run(coin.mint, row.returned_lamports, built.signature, now(), row.sol_usd, String(row.x_id))
      setRow(db, row.id, { credit_sig: built.signature, credit_lvh: built.lastValidBlockHeight })
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
    return 'sent'
  } finally { unlockCoin(db, coin.mint) }
}

/**
 * One X Money pass: start new payouts, then move every live one a step. Never throws; errors are stored on the row.
 */
export async function xmoneyPass({ db, conn, keeper, seed, rails, cfg = xmoneyConfig(), solUsd = null, log = console }) {
  const results = await start(db, conn, { keeper, seed, cfg, solUsd, log, rails })
  const rows = db.prepare(`SELECT * FROM xmoney_payouts WHERE state IN (${LIVE.map(() => '?').join(',')}) ORDER BY id`).all(...LIVE)
  const ctx = { keeper, seed, rails, cfg, log }
  for (const row of rows) {
    try {
      const step = row.state === 'collecting' ? await stepCollecting(db, row)
        : row.state === 'bridging' ? await stepBridging(db, conn, ctx, row)
        : row.state === 'listing' ? await stepListing(db, ctx, row)
        : row.state === 'listed' ? await stepListed(db, ctx, row)
        : row.state === 'returning' ? await stepReturning(db, conn, ctx, row)
        : await stepCrediting(db, conn, ctx, row)
      if (step !== 'wait') results.push({ xmoney: row.id, handle: row.handle, from: row.state, step })
    } catch (e) {
      setRow(db, row.id, { error: String(e.message ?? e).slice(0, 300) })
      log.error?.(`xmoney #${row.id} ${row.state}: ${e.message}`)
    }
  }
  return results
}

/** What the account page shows for one payout. */
export function xmoneyView(r) {
  const filled = r.filled_usdc + (r.cur_filled_usdc ?? 0), paid = r.paid_usd + (r.cur_paid_usd ?? 0)
  const status = r.state === 'done' ? (paid > 0 ? (r.return_usdc > 0 ? 'Partly paid, the rest is back in your balance' : 'Paid') : (r.returned_lamports > 0 ? 'Back in your balance' : 'Ended'))
    : r.state === 'failed' ? 'Delayed, we are looking into it'
    : r.state === 'listed' ? (filled > 0 ? 'Partly paid, waiting for the rest' : 'Waiting for a payer')
    : r.state === 'returning' || r.state === 'crediting' ? 'Returning to your balance'
    : 'Preparing'
  const carried = r.carry_usdc > 0 && !r.carry_used ? ` · $${(r.carry_usdc / 1e6).toFixed(2)} carried to your next payout` : ''
  return { id: r.id, time: r.created_at, handle: r.handle, sol: r.lamports / 1e9, usd: r.usdc / 1e6, paidUsd: paid, status: status + carried, done: r.state === 'done' }
}
