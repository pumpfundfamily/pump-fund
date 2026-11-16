/**
 * ⭐ SEAL's half of $FUND reaches SEAL through ENDAOMENT (operator 16 Nov: "I don't have SEAL's Solana address, figure out
 * how to do it"). SEAL publishes no Solana address; it is a US 501(c)(3), "Open Security Alliance Inc", EIN 92-3456081,
 * and Endaoment (a donor-advised fund) holds an on-chain account for it that grants donations on to the nonprofit.
 *
 * Verified on chain 16 Nov 2026 (not taken on an API's word):
 *   Endaoment's OrgFundFactory 0x10fd…a589 (same address on every chain, per Endaoment's docs) computes
 *   computeOrgAddress(bytes32("923456081")) = 0x6041A570f7B7C8a0a2eBC849C1ff9697EB9279Cd, on Ethereum AND Base.
 *   On Ethereum that contract exists: orgId "923456081", entityType 1, registry = Endaoment's official Registry, which
 *   says isActiveEntity = true; baseToken USDC. On Base it was not deployed yet; deployOrg is permissionless (simulated
 *   from our Base wallet: returns that same address, ~0.0000014 ETH of gas).
 *
 * The route, one row per batch in `seal_bridges` (every step is a public transaction, shown on the site):
 *   bridging   SEAL's holding wallet (Solana) → Relay → USDC on Base, to SEAL's OWN Base account (derived from FEE_SEED,
 *              never the pooled X Money wallet). refundTo = the holding wallet.
 *   donating   on Base: deployOrg once if needed (the address is re-checked against the factory first), USDC approve, then
 *              Org.donate(amount). Endaoment keeps 1.5% and grants the rest to SEAL.
 *   done       donate_tx set.
 * Gas for SEAL's Base account comes from the X Money Base wallet, a little at a time.
 *
 * ⛔ Relay's `failure` is NOT final and a refund arrives minus gas (memory, xmoney.mjs): a failed bridge waits; a refund
 *    leaves the SOL in the holding wallet for the next batch. Nothing is ever counted as donated before donate() landed.
 */
import { createHmac } from 'node:crypto'

import { fateOf, sendUntilFate } from '../lib/tx.mjs'
import { now } from './db.mjs'
import { RENT_FLOOR } from './launch.mjs'
import { BASE_CHAIN, BASE_USDC, SOLANA_RELAY_CHAIN, SOL_NATIVE, relayDepositTx } from './xmoney.mjs'

export const ENDAOMENT = {
  factory: '0x10fd9348136dcea154f752fe0b6db45fc298a589',
  orgId: '923456081', // SEAL: Open Security Alliance Inc, EIN 92-3456081, as Endaoment encodes it (no hyphen)
  org: '0x6041A570f7B7C8a0a2eBC849C1ff9697EB9279Cd',
  url: 'https://app.endaoment.org/orgs/923456081',
  feeBps: 150,
}
/** SEAL's own Base account (receives the bridged USDC, calls donate). Derived, never stored. */
export const sealBaseKey = (seed) => `0x${createHmac('sha256', seed).update('pumpfund-base-seal:v1').digest('hex')}`

export function sealBridgeConfig(env = process.env) {
  return {
    enabled: env.SEAL_ROUTE !== 'off' && !env.SEAL_SOLANA_ADDRESS, // a Solana address from SEAL itself replaces this route
    minLamports: Number(env.SEAL_BRIDGE_MIN_LAMPORTS ?? 100_000_000), // 0.1 SOL: Relay's fees stay small next to it
    feeBuffer: 5_000_000, // the holding wallet pays its own deposit transaction
    minGasWei: BigInt(env.SEAL_MIN_GAS_WEI ?? 30_000_000_000_000), // 0.00003 ETH on SEAL's Base account
    topUpWei: BigInt(env.SEAL_TOPUP_WEI ?? 150_000_000_000_000), // 0.00015 ETH from the X Money Base wallet
  }
}

const row = (db) => db.prepare("SELECT * FROM seal_bridges WHERE state IN ('bridging', 'donating') ORDER BY id LIMIT 1").get()
const set = (db, id, f) => { const k = Object.keys(f); db.prepare(`UPDATE seal_bridges SET ${k.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...k.map((c) => f[c]), now(), id) }

/**
 * One pass. `hold` = SEAL's holding wallet (Keypair). `rails` = { relay: { quote, status }, seal: { address, ethBalance,
 * usdcBalance, usdcIn(hash), orgAddress(), orgDeployed(), deployOrg(), approve(amount), donate(amount) }, topUp(to, wei) }.
 * Returns what it did. Never throws past a step it could not finish (the next pass carries on).
 */
export async function sealBridgePass({ db, conn, hold, rails, cfg = sealBridgeConfig(), log = console }) {
  let r = row(db)
  if (!r) {
    const bal = await conn.getBalance(hold.publicKey, 'confirmed')
    const lamports = bal - RENT_FLOOR - cfg.feeBuffer
    if (lamports < cfg.minLamports) return { idle: lamports }
    db.prepare("INSERT INTO seal_bridges (state, lamports, created_at, updated_at) VALUES ('bridging', ?, ?, ?)").run(lamports, now(), now())
    r = row(db)
  }
  if (r.state === 'bridging') {
    if (!r.relay_sig) {
      const quote = await rails.relay.quote({ user: hold.publicKey.toBase58(), recipient: rails.seal.address, originChainId: SOLANA_RELAY_CHAIN, destinationChainId: BASE_CHAIN,
        originCurrency: SOL_NATIVE, destinationCurrency: BASE_USDC, amount: String(r.lamports), tradeType: 'EXACT_INPUT', refundTo: hold.publicKey.toBase58() })
      const { requestId, built } = await relayDepositTx(conn, hold, quote)
      set(db, r.id, { relay_request: requestId, relay_sig: built.signature, relay_lvh: built.lastValidBlockHeight }) // before the send: a crash finds it again
      const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
      if (['rejected', 'expired', 'failed'].includes(f.fate)) { set(db, r.id, { relay_sig: null, relay_request: null, error: `bridge deposit ${f.fate}: ${f.error ?? ''}`.trim() }); return { retry: f.fate } }
      return { bridging: built.signature }
    }
    const f = await fateOf(conn, r.relay_sig, r.relay_lvh)
    if (f.fate === 'unknown') return { wait: 'deposit confirming' }
    if (f.fate !== 'landed') { set(db, r.id, { relay_sig: null, relay_request: null, error: `bridge deposit ${f.fate}` }); return { retry: f.fate } }
    const st = await rails.relay.status(r.relay_request)
    if (st.status === 'success') {
      const dest = (st.txHashes ?? [])[0]
      if (!dest) return { wait: 'no fill hash yet' }
      const usdc = await rails.seal.usdcIn(dest)
      if (usdc <= 0n) { set(db, r.id, { state: 'failed', error: `relay says success but ${dest} paid SEAL's Base account no USDC` }); log.error?.(`SEAL bridge #${r.id}: no USDC arrived (${dest}). Needs the operator.`); return { failed: true } }
      set(db, r.id, { state: 'donating', dest_tx: dest, usdc: Number(usdc), error: null })
      r = row(db)
    } else if (st.status === 'refund') {
      // the SOL is back in the holding wallet (minus Relay's gas): the next batch takes it again
      set(db, r.id, { state: 'refunded', error: 'the bridge refunded; the SOL went back to the holding wallet' })
      return { refunded: true }
    } else {
      if (st.status === 'failure' && st.refundFailReason) { set(db, r.id, { state: 'failed', error: `Relay will not refund by itself: ${String(st.refundFailReason).slice(0, 80)}` }); log.error?.(`SEAL bridge #${r.id} failed for good. Needs the operator.`); return { failed: true } }
      if (now() - r.updated_at > 6 * 3600) log.error?.(`SEAL bridge #${r.id}: Relay ${r.relay_request} still ${st.status} after 6 h`)
      return { wait: st.status }
    }
  }
  // donating, on Base
  if (BigInt(await rails.seal.ethBalance()) < cfg.minGasWei) { await rails.topUp(rails.seal.address, cfg.topUpWei); log.info?.(`SEAL's Base account topped up with ${Number(cfg.topUpWei) / 1e18} ETH for gas`) }
  if (!r.deploy_tx && !(await rails.seal.orgDeployed())) {
    // ⛔ the address is re-derived from Endaoment's factory every time before money moves towards it
    if ((await rails.seal.orgAddress()).toLowerCase() !== ENDAOMENT.org.toLowerCase()) { set(db, r.id, { state: 'failed', error: 'Endaoment factory no longer computes SEAL\'s known address' }); log.error?.('SEAL: Endaoment address mismatch. Needs the operator.'); return { failed: true } }
    set(db, r.id, { deploy_tx: await rails.seal.deployOrg() })
  }
  const amount = BigInt(await rails.seal.usdcBalance())
  if (amount <= 0n) { if (r.donate_tx) { set(db, r.id, { state: 'done' }); return { done: r.id } } return { wait: 'no USDC on SEAL\'s Base account' } }
  if (!r.approve_tx) set(db, r.id, { approve_tx: await rails.seal.approve(amount) })
  const donate = await rails.seal.donate(amount)
  set(db, r.id, { state: 'done', donate_tx: donate, usdc: Number(amount), done_at: now() })
  log.info?.(`SEAL: ${Number(amount) / 1e6} USDC donated through Endaoment in ${donate}`)
  return { donated: Number(amount), tx: donate }
}

/** The real Base side for SEAL (viem). `main` = the X Money rails (its Base wallet pays SEAL's gas; its Relay client). */
export async function realSealRails(seed, main, baseRpcs) {
  const { createPublicClient, createWalletClient, http, fallback, erc20Abi, parseEventLogs, stringToHex } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { base } = await import('viem/chains')
  const account = privateKeyToAccount(sealBaseKey(seed))
  const transport = fallback(baseRpcs.map((u) => http(u)))
  const pub = createPublicClient({ chain: base, transport })
  const wallet = createWalletClient({ account, chain: base, transport })
  const fn = (name, inputs, outputs = [], stateMutability = 'nonpayable') => ({ name, type: 'function', stateMutability, inputs: inputs.map((t) => ({ type: t })), outputs: outputs.map((t) => ({ type: t })) })
  const abi = [fn('computeOrgAddress', ['bytes32'], ['address'], 'view'), fn('deployOrg', ['bytes32'], ['address']), fn('donate', ['uint256'])]
  const orgId = stringToHex(ENDAOMENT.orgId, { size: 32 })
  const write = async (req) => {
    const { request } = await pub.simulateContract({ ...req, account })
    const hash = await wallet.writeContract(request)
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (rc.status !== 'success') throw new Error(`base tx ${hash} reverted`)
    return hash
  }
  return {
    relay: main.relay,
    topUp: (to, wei) => main.base.send({ to, data: '0x', value: String(wei) }),
    seal: {
      address: account.address,
      ethBalance: () => pub.getBalance({ address: account.address }),
      usdcBalance: () => pub.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      async usdcIn(hash) {
        const rc = await pub.getTransactionReceipt({ hash })
        const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: rc.logs.filter((l) => l.address.toLowerCase() === BASE_USDC) })
        return logs.filter((l) => l.args.to.toLowerCase() === account.address.toLowerCase()).reduce((s, l) => s + l.args.value, 0n)
      },
      orgAddress: () => pub.readContract({ address: ENDAOMENT.factory, abi, functionName: 'computeOrgAddress', args: [orgId] }),
      orgDeployed: async () => { const c = await pub.getCode({ address: ENDAOMENT.org }); return !!c && c !== '0x' },
      deployOrg: () => write({ address: ENDAOMENT.factory, abi, functionName: 'deployOrg', args: [orgId] }),
      approve: (amount) => write({ address: BASE_USDC, abi: erc20Abi, functionName: 'approve', args: [ENDAOMENT.org, amount] }),
      donate: (amount) => write({ address: ENDAOMENT.org, abi, functionName: 'donate', args: [amount] }),
    },
  }
}

/** For the site: the batches (newest first) and what reached SEAL. */
export function sealBridges(db) { return db.prepare('SELECT * FROM seal_bridges ORDER BY id DESC').all() }

