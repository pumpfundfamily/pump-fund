// Minimal pump.fun client for EARN, driven by the IDL pump.fun publishes on chain (vendored in
// lib/pump.idl.json; scripts/check-idl.mjs compares it to the live one). Anchor's TS client
// resolves every PDA the IDL describes; the accounts it cannot describe are added here by hand.
import { AnchorProvider, BorshCoder, Program } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { readFileSync } from 'node:fs'

export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112')

export const pumpIdl = JSON.parse(readFileSync(new URL('./pump.idl.json', import.meta.url)))
export const pumpAmmIdl = JSON.parse(readFileSync(new URL('./pump_amm.idl.json', import.meta.url)))
export const pumpCoder = new BorshCoder(pumpIdl)

const pda = (seeds, program = PUMP) => PublicKey.findProgramAddressSync(seeds, program)[0]
export const globalAddress = () => pda([Buffer.from('global')])
export const bondingCurveAddress = (mint) => pda([Buffer.from('bonding-curve'), mint.toBuffer()])
export const bondingCurveV2Address = (mint) => pda([Buffer.from('bonding-curve-v2'), mint.toBuffer()])
export const creatorVaultAddress = (creator) => pda([Buffer.from('creator-vault'), creator.toBuffer()])
export const holderRewardsAddress = (mint) => pda([Buffer.from('holder-rewards'), mint.toBuffer()])
export const MAYHEM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e')
/** ⛔ A PDA of the MAYHEM program, not of pump.fun (13 Nov: derived under pump.fun it gave a wrong vault, which only a
 *  mayhem mode create touches: "Instruction references an unknown account"). Checked against a mainnet create_v2. */
export const mayhemStateAddress = (mint) => pda([Buffer.from('mayhem-state'), mint.toBuffer()], MAYHEM)
/** The Mayhem program's SOL vault; a mayhem mode coin's token vault is ITS Token-2022 account for the mint (checked against a mainnet create_v2). */
export const mayhemSolVault = () => pda([Buffer.from('sol-vault')], MAYHEM)
export const mayhemTokenVaultAddress = (mint) => ata(mayhemSolVault(), mint, TOKEN_2022)
/** The account pump.fun migrates a coin as; also the pool PDA's `creator` seed. */
export const poolAuthority = (mint) => pda([Buffer.from('pool-authority'), mint.toBuffer()])
/** The PumpSwap pool of a migrated coin. `index` is a seed; every migration seen uses 0, callers try a few. */
export const poolAddress = (mint, quoteMint = WSOL, index = 0) => {
  const idx = Buffer.alloc(2); idx.writeUInt16LE(index)
  return pda([Buffer.from('pool'), idx, poolAuthority(mint).toBuffer(), mint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM)
}
export const POOL_INDEXES = [0, 1, 2, 3]
/** PumpSwap Pool account (Anchor-decoded, fields as in lib/pump_amm.idl.json). */
export function decodePool(data) { return new BorshCoder(pumpAmmIdl).accounts.decode('Pool', data) }
/** The `amount` of an SPL token account (classic or Token-2022 share the first 72 bytes). */
export const tokenAccountAmount = (data) => data.readBigUInt64LE(64)
export const COIN_DECIMALS = 6
/** PumpSwap: the authority whose WSOL account holds a graduated coin's creator fees. */
export const ammCreatorVaultAuthority = (creator) => pda([Buffer.from('creator_vault'), creator.toBuffer()], PUMP_AMM)

export function ata(owner, mint, tokenProgram) {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))
}

export function decodeGlobal(data) { return pumpCoder.accounts.decode('Global', data) }
export function decodeBondingCurve(data) { return pumpCoder.accounts.decode('BondingCurve', data) }

/** A read-only Program: instruction building needs a connection for lookups, never a wallet. */
export function pumpProgram(connection) {
  const provider = new AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, {})
  return new Program(pumpIdl, provider)
}

export async function loadGlobal(connection) {
  const acc = await connection.getAccountInfo(globalAddress())
  if (!acc) throw new Error('pump.fun Global not found — wrong cluster?')
  return decodeGlobal(acc.data)
}

/** SOL-paired, Token-2022 coin. `creator` is who the creator fees belong to — for EARN, a fee address. */
/** `holderReward`: pump.fun's native "creator rewards go to holders" launch option (BondingCurve.is_holder_reward), locked
 *  for the coin's life: fees accrue in pump.fun's holder-rewards PDA ["holder-rewards", mint] and pump.fun pays holders. */
export async function createV2Ix(program, { mint, user, name, symbol, uri, creator, creatorFeeBps = null, holderReward = false, quote = null, mayhem = false, cashback = false }) {
  const m = program.methods
    .createV2(name, symbol, uri, creator, !!mayhem, { 0: !!cashback }, { 0: new BN(creatorFeeBps ?? 0) }, { 0: !!holderReward })
    .accountsPartial({ mint, user, mayhemTokenVault: mayhemTokenVaultAddress(mint) })
  // `quote`: a resolveQuote() result (kind listed | curve | pool); null or kind 'sol' = SOL-paired
  if (quote && quote.kind !== 'sol') m.remainingAccounts(quoteRemainingAccounts(quote, mint))
  return m.instruction()
}

/** The protocol fee recipient a buy must name: a mayhem mode coin pays pump.fun's reserved recipients, any other the normal ones. */
export function buyFeeRecipient(global, mayhem = false) {
  const list = mayhem ? [global.reserved_fee_recipient, ...global.reserved_fee_recipients] : [global.fee_recipient, ...global.fee_recipients]
  return list.find((k) => !k.equals(PublicKey.default))
}

/** `buy_exact_sol_in` on a create_v2 curve. Remaining accounts: bonding_curve_v2, ONE buyback recipient. */
export async function buyExactSolInIx(program, global, { mint, user, creator, lamports, minTokensOut = 1n, mayhem = false }) {
  const buyback = global.buyback_fee_recipients.find((k) => !k.equals(PublicKey.default))
  const feeRecipient = buyFeeRecipient(global, mayhem)
  return program.methods
    .buyExactSolIn(new BN(String(lamports)), new BN(String(minTokensOut)), { 0: true })
    .accountsPartial({ mint, user, feeRecipient, tokenProgram: TOKEN_2022, associatedUser: ata(user, mint, TOKEN_2022), creatorVault: creatorVaultAddress(creator) })
    .remainingAccounts([
      { pubkey: bondingCurveV2Address(mint), isSigner: false, isWritable: true },
      { pubkey: buyback, isSigner: false, isWritable: true },
    ])
    .instruction()
}

/** Moves a creator's accrued curve fees into the creator account. The creator does NOT sign. */
export async function collectCreatorFeeIx(program, creator) {
  return program.methods.collectCreatorFee().accountsPartial({ creator }).instruction()
}


/* ── creator-fee sweeps ──────────────────────────────────────────────────────────────────────────────────────────────
 * pump.fun's NEW trades (pump.fun web/app: buy_v3/sell_v3, PumpSwap buy_v2/sell_v2) keep the creator fee ON the curve
 * (BondingCurve.creator_fee, u64 @125) or the pool (Pool.creator_fees, u64 @279) until a permissionless sweep pays it into
 * the creator vault; the vault reads EMPTY until then (memory: pumpfun-fees-kept-until-swept). The vendored IDLs predate
 * the sweeps, so these two use newer IDLs (from ~/shill, proven there 9 Oct). SOL-paired: quote = WSOL, the quote token
 * accounts are derived but unused. A sweep with nothing waiting is a no-op.
 */
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const AMM_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
const pumpSweepIdl = JSON.parse(readFileSync(new URL('./pump-sweep.idl.json', import.meta.url)))
const ammSweepIdl = JSON.parse(readFileSync(new URL('./pump_amm-sweep.idl.json', import.meta.url)))
const sweepPrograms = new WeakMap()
function sweepProgramsFor(connection) {
  let p = sweepPrograms.get(connection)
  if (!p) {
    const provider = new AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, {})
    p = { pump: new Program(pumpSweepIdl, provider), amm: new Program(ammSweepIdl, provider) }
    sweepPrograms.set(connection, p)
  }
  return p
}
export const curveCreatorFeeWaiting = (data) => (data && data.length >= 133 ? data.readBigUInt64LE(125) : 0n)
export const poolCreatorFeesWaiting = (data) => (data && data.length >= 287 ? data.readBigUInt64LE(279) : 0n)
/** The curve's creator (who its fees belong to), or null. */
export const curveCreator = (data) => (data && data.length >= 81 ? new PublicKey(data.subarray(49, 81)) : null)

export async function sweepCurveCreatorFeeIx(connection, { mint, payer, creator }) {
  const curve = bondingCurveAddress(mint), vault = creatorVaultAddress(creator)
  return sweepProgramsFor(connection).pump.methods.sweepCreatorFee()
    .accountsPartial({ payer, global: globalAddress(), baseMint: mint, quoteMint: WSOL, quoteTokenProgram: TOKEN_PROGRAM, bondingCurve: curve,
      associatedQuoteBondingCurve: ata(curve, WSOL, TOKEN_PROGRAM), recipient: vault, associatedQuoteRecipient: ata(vault, WSOL, TOKEN_PROGRAM) })
    .instruction()
}
/** PumpSwap: Pool.creator_fees → the coin creator vault authority's WSOL account (then transfer_creator_fees_to_pump). */
export async function sweepPoolCreatorFeeIx(connection, { pool, poolData, payer, creator }) {
  const authority = ammCreatorVaultAuthority(creator)
  return sweepProgramsFor(connection).amm.methods.sweepCreatorFee()
    .accountsPartial({ payer, globalConfig: AMM_GLOBAL_CONFIG, pool, quoteMint: WSOL, quoteTokenProgram: TOKEN_PROGRAM,
      poolQuoteTokenAccount: decodePool(poolData).pool_quote_token_account, recipient: authority, recipientTokenAccount: ata(authority, WSOL, TOKEN_PROGRAM) })
    .instruction()
}


/* ── custom pairs ────────────────────────────────────────────────────────────────────────────────────────────────────
 * Ported from ~/agency/lib/pump.mjs (proven there on mainnet clones, Oct 2026). A coin paired with token Q:
 * create_v2 + remaining [Q, curve's Q ATA, Q's token program, quote_control] for a mint on pump.fun's quote-control list
 * (or USDC), + [Q's bonding curve] for a pump coin still on its curve, + [Q's pool, base and quote vaults] once migrated.
 * ⛔ Creator fees on such a coin accrue IN Q: the *_v2 collects move Q tokens, never SOL.
 * ⛔ create_v2 creates the curve's Q ATA NON-idempotently (memory pumpfun-create-v2-griefable-curve-ata): the mint must
 * stay unknown until the launch lands. Our …fund keys are secret until sent, and a retry uses a fresh key.
 */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
export const QUOTE_CONTROL = pda([Buffer.from('quote-control')])
export const decodeQuoteControl = (data) => pumpCoder.accounts.decode('QuoteControl', data)

/** pump.fun's quote-control list (base58 mints). */
export async function readQuoteControl(connection) {
  const info = await connection.getAccountInfo(QUOTE_CONTROL)
  return info ? decodeQuoteControl(info.data).mints.map((x) => x.mint.toBase58()) : []
}

const isSolOrUsdc = (k) => !k || k.equals(PublicKey.default) || k.equals(WSOL) || k.equals(USDC)

/**
 * Whether token Q can be a coin's pair, and every account a launch against it needs. Never throws for a bad Q: returns
 * { ok: false, code, reason }. `code` 'pair-wait' = try again shortly (a curve between completion and its pool).
 * Kinds: 'listed' (quote-control list, or USDC), 'curve' (a pump coin on its curve), 'pool' (a pump coin on PumpSwap).
 */
export async function resolveQuote(connection, q, { listed = null } = {}) {
  let mint
  try { mint = q instanceof PublicKey ? q : new PublicKey(String(q).trim()) } catch { return { ok: false, code: 'bad-pair', reason: 'That pair is not a token address.' } }
  if (mint.equals(WSOL)) return { ok: true, kind: 'sol' }
  const curveAddr = bondingCurveAddress(mint)
  const [mintInfo, curveInfo] = await connection.getMultipleAccountsInfo([mint, curveAddr])
  if (!mintInfo || !(mintInfo.owner.equals(TOKEN_PROGRAM_ID) || mintInfo.owner.equals(TOKEN_2022)) || mintInfo.data.length < 82) {
    return { ok: false, code: 'bad-pair', reason: 'That pair is not a token on Solana.' }
  }
  const base = { mint: mint.toBase58(), tokenProgram: mintInfo.owner.toBase58(), decimals: mintInfo.data[44] }
  const list = listed ?? (await readQuoteControl(connection))
  if (mint.equals(USDC) || list.includes(base.mint)) return { ok: true, kind: 'listed', ...base, curve: null, pool: null }
  if (!curveInfo) return { ok: false, code: 'bad-pair', reason: 'Pumpfun cannot pair with that token. Pair with SOL, a Pumpfun token, or a token on Pumpfun\'s pair list.' }
  const c = decodeBondingCurve(curveInfo.data)
  if (c.is_mayhem_mode) return { ok: false, code: 'bad-pair', reason: 'Pumpfun cannot pair with a mayhem mode token.' }
  if (!c.complete) {
    if (Number(c.depth ?? 0) > 0 || !isSolOrUsdc(c.quote_mint)) return { ok: false, code: 'bad-pair', reason: 'That token is itself paired with another token, and Pumpfun allows one level of pairing.' }
    return { ok: true, kind: 'curve', ...base, curve: curveAddr.toBase58(), pool: null }
  }
  // Graduated: its PumpSwap pool must exist. ⛔ A migrated curve reads ALL ZEROES (quote included): try both quotes.
  const candidates = [WSOL, USDC].map((k) => ({ k, addr: poolAddress(mint, k, 0) }))
  const infos = await connection.getMultipleAccountsInfo(candidates.map((x) => x.addr))
  const hit = candidates.findIndex((_, i) => infos[i] && infos[i].data.length >= 200)
  if (hit < 0) {
    const held = await connection.getAccountInfo(ata(curveAddr, mint, mintInfo.owner)).catch(() => null)
    const mid = Boolean(held && held.data.length >= 72 && tokenAccountAmount(held.data) > 0n)
    return mid
      ? { ok: false, code: 'pair-wait', reason: 'That token just finished its curve and is moving to its pool.' }
      : { ok: false, code: 'bad-pair', reason: 'That token graduated outside Pumpfun, so Pumpfun cannot pair with it.' }
  }
  const pool = decodePool(infos[hit].data)
  return { ok: true, kind: 'pool', ...base, curve: curveAddr.toBase58(), pool: { address: candidates[hit].addr.toBase58(), base: pool.pool_base_token_account.toBase58(), quote: pool.pool_quote_token_account.toBase58() } }
}

/** create_v2's remaining accounts for coin `mint` paired with the resolved quote `q`. */
export function quoteRemainingAccounts(q, mint) {
  const Q = new PublicKey(q.mint), prog = new PublicKey(q.tokenProgram)
  const acc = (k, w = false) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: w })
  const out = [acc(Q), acc(ata(bondingCurveAddress(mint), Q, prog), true), acc(prog), acc(QUOTE_CONTROL)]
  if (q.kind === 'listed') return out
  out.push(acc(q.curve))
  if (q.kind === 'pool') out.push(acc(q.pool.address), acc(q.pool.base), acc(q.pool.quote))
  return out
}

/** Moves a creator's accrued curve fees in Q into the creator's own Q account (must exist). Permissionless. */
export async function collectCreatorFeeV2Ix(program, { creator, quoteMint, quoteProgram }) {
  const c = new PublicKey(creator), Q = new PublicKey(quoteMint), prog = new PublicKey(quoteProgram), vault = creatorVaultAddress(c)
  return program.methods.collectCreatorFeeV2()
    .accountsPartial({ creator: c, creatorTokenAccount: ata(c, Q, prog), creatorVault: vault, creatorVaultTokenAccount: ata(vault, Q, prog), quoteMint: Q, quoteTokenProgram: prog })
    .instruction()
}

/** PumpSwap: the coin creator vault's Q → the creator's own Q account (must exist). Permissionless. */
export async function collectCoinCreatorFeeIx(connection, { creator, quoteMint, quoteProgram }) {
  const c = new PublicKey(creator), Q = new PublicKey(quoteMint), prog = new PublicKey(quoteProgram), auth = ammCreatorVaultAuthority(c)
  return sweepProgramsFor(connection).amm.methods.collectCoinCreatorFee()
    .accountsPartial({ quoteMint: Q, quoteTokenProgram: prog, coinCreator: c, coinCreatorVaultAuthority: auth, coinCreatorVaultAta: ata(auth, Q, prog), coinCreatorTokenAccount: ata(c, Q, prog) })
    .instruction()
}

/** Curve sweep in Q: BondingCurve.creator_fee → the creator vault's Q account. */
export async function sweepCurveCreatorFeeQIx(connection, { mint, payer, creator, quoteMint, quoteProgram }) {
  const m = new PublicKey(mint), Q = new PublicKey(quoteMint), prog = new PublicKey(quoteProgram)
  const curve = bondingCurveAddress(m), vault = creatorVaultAddress(new PublicKey(creator))
  return sweepProgramsFor(connection).pump.methods.sweepCreatorFee()
    .accountsPartial({ payer, global: globalAddress(), baseMint: m, quoteMint: Q, quoteTokenProgram: prog, bondingCurve: curve,
      associatedQuoteBondingCurve: ata(curve, Q, prog), recipient: vault, associatedQuoteRecipient: ata(vault, Q, prog) })
    .instruction()
}

/** Pool sweep in Q: Pool.creator_fees → the coin creator vault authority's Q account. */
export async function sweepPoolCreatorFeeQIx(connection, { pool, poolData, payer, creator, quoteMint, quoteProgram }) {
  const Q = new PublicKey(quoteMint), prog = new PublicKey(quoteProgram), authority = ammCreatorVaultAuthority(new PublicKey(creator))
  return sweepProgramsFor(connection).amm.methods.sweepCreatorFee()
    .accountsPartial({ payer, globalConfig: AMM_GLOBAL_CONFIG, pool, quoteMint: Q, quoteTokenProgram: prog,
      poolQuoteTokenAccount: decodePool(poolData).pool_quote_token_account, recipient: authority, recipientTokenAccount: ata(authority, Q, prog) })
    .instruction()
}

/** `buy_exact_quote_in_v2`: spend `amountIn` of Q on a Q-paired curve (tests, and anyone's first buy). */
export async function buyExactQuoteInV2Ix(program, global, { mint, user, creator, quoteMint, quoteProgram, amountIn, minTokensOut = 1n }) {
  const Q = new PublicKey(quoteMint), prog = new PublicKey(quoteProgram)
  const buyback = global.buyback_fee_recipients.find((k) => !k.equals(PublicKey.default))
  const feeRecipient = [global.fee_recipient, ...global.fee_recipients].find((k) => !k.equals(PublicKey.default))
  const curve = bondingCurveAddress(mint), vault = creatorVaultAddress(creator)
  return program.methods.buyExactQuoteInV2(new BN(String(amountIn)), new BN(String(minTokensOut)))
    .accountsPartial({ baseMint: mint, quoteMint: Q, baseTokenProgram: TOKEN_2022, quoteTokenProgram: prog, feeRecipient, associatedQuoteFeeRecipient: ata(feeRecipient, Q, prog),
      buybackFeeRecipient: buyback, associatedQuoteBuybackFeeRecipient: ata(buyback, Q, prog), bondingCurve: curve, associatedBaseBondingCurve: ata(curve, mint, TOKEN_2022),
      associatedQuoteBondingCurve: ata(curve, Q, prog), user, associatedBaseUser: ata(user, mint, TOKEN_2022), associatedQuoteUser: ata(user, Q, prog),
      creatorVault: vault, associatedCreatorVault: ata(vault, Q, prog) })
    .instruction()
}
