/**
 * ⭐ Float (floatlaunch.xyz, operator 11 Nov): coins on Raydium LaunchLab through Float's program, which takes the
 * coin's LaunchLab creator + platform fees and splits them (holders 15% / dev 5% / $FLOAT buyback 35% / traders 35% /
 * treasury 10%, Float docs). Read 11 Nov from Float's own site bundle (it embeds the program's IDL, saved here as
 * lib/float.idl.json) and from chain:
 *   launch(args)       permissionless; the coin mint is the Float PDA ["mint", creator, nonce u64 LE] (no vanity,
 *                      no Float server). args.fee_receiver = the wallet paid the dev share, in the PAIR token.
 *   max_takeover       a ticker already on Float costs 2..5 SOL to take over; we pass 0, so a taken ticker fails.
 *   quote              any of Float's QuoteAsset accounts (SOL, USDC, ~400 tokenized stocks and coins). The
 *                      LaunchLab global config of a pair is stored on its QuoteAsset.
 * Accounts as the site derives them (its helpers W / S / g / G).
 */
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js'
import { AnchorProvider, BorshCoder, Program } from '@coral-xyz/anchor'
import BN from 'bn.js'
import { createRequire } from 'node:module'

export const FLOAT = new PublicKey('3KguFi7YYzLgttG46fRism16CfcuNCkDh6U7td9JTqxX')
export const LAUNCHLAB = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj')
export const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
export const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112')
export const floatIdl = createRequire(import.meta.url)('./float.idl.json')
export const floatCoder = new BorshCoder(floatIdl)

const pda = (seeds, program = FLOAT) => PublicKey.findProgramAddressSync(seeds, program)[0]
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
export const F = {
  config: pda([Buffer.from('config')]),
  quoteAsset: (quoteMint) => pda([Buffer.from('quote'), quoteMint.toBuffer()]),
  ticker: (t) => pda([Buffer.from('ticker'), Buffer.from(String(t).toUpperCase())]),
  launch: (mint) => pda([Buffer.from('launch'), mint.toBuffer()]),
  platform: (tier) => pda([Buffer.from('platform'), Buffer.from([tier])]),
  coinVault: (mint) => pda([Buffer.from('coin'), mint.toBuffer()]),
  coinMint: (creator, nonce) => pda([Buffer.from('mint'), creator.toBuffer(), u64le(nonce)]),
}
export const LL = {
  authority: pda([Buffer.from('vault_auth_seed')], LAUNCHLAB),
  eventAuthority: pda([Buffer.from('__event_authority')], LAUNCHLAB),
  platformConfig: (platform) => pda([Buffer.from('platform_config'), platform.toBuffer()], LAUNCHLAB),
  pool: (base, quote) => pda([Buffer.from('pool'), base.toBuffer(), quote.toBuffer()], LAUNCHLAB),
  vault: (pool, mint) => pda([Buffer.from('pool_vault'), pool.toBuffer(), mint.toBuffer()], LAUNCHLAB),
}
export const metadataAddress = (mint) => pda([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)

const programs = new WeakMap()
export function floatProgram(conn) {
  if (!programs.has(conn)) programs.set(conn, new Program(floatIdl, new AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, {})))
  return programs.get(conn)
}

/** Float's config (treasury, fee tiers, paused flag) and one pair's QuoteAsset, read from chain. */
export async function readFloat(conn, quoteMint) {
  const [c, q, qm] = await conn.getMultipleAccountsInfo([F.config, F.quoteAsset(quoteMint), quoteMint], 'confirmed')
  if (!c) throw new Error('Float config not found')
  const config = floatCoder.accounts.decode('Config', c.data)
  const quote = q ? floatCoder.accounts.decode('QuoteAsset', q.data) : null
  return { config, quote, quoteTokenProgram: qm?.owner ?? null }
}

/**
 * The launch instruction. `creator` signs and pays; the coin mint is derived from it and a random nonce.
 * Returns { ix, mint, pool, nonce }.
 */
export async function floatLaunchIx(conn, { creator, name, ticker, uri, feeReceiver, quoteMint = WSOL, tier = 0, nonce = null, maxTakeoverLamports = 0n }) {
  const { config, quote, quoteTokenProgram } = await readFloat(conn, quoteMint)
  if (config.launches_paused) throw new Error('Float launches are paused')
  if (!quote || !quote.enabled) throw new Error('Float does not list that pair')
  const n = nonce ?? (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n | BigInt(Math.floor(Math.random() * 2 ** 32)))
  const mint = F.coinMint(creator, n)
  const pool = LL.pool(mint, quoteMint)
  const ix = await floatProgram(conn).methods.launch({
    // camelCase: the Anchor client converts the IDL's snake_case (as Float's own site sends them)
    name, ticker, uri, feeReceiver, feeTier: tier, mintNonce: new BN(n.toString()), maxTakeover: { lamports: new BN(String(maxTakeoverLamports)) },
  }).accountsPartial({
    creator, config: F.config, treasury: config.treasury, quoteAsset: F.quoteAsset(quoteMint), quoteMint, tickerRecord: F.ticker(ticker),
    coinMint: mint, launch: F.launch(mint), coinVault: F.coinVault(mint), globalConfig: quote.global_config,
    platformConfig: LL.platformConfig(F.platform(tier)), launchlabAuthority: LL.authority, poolState: pool,
    baseVault: LL.vault(pool, mint), quoteVault: LL.vault(pool, quoteMint), metadata: metadataAddress(mint), eventAuthority: LL.eventAuthority,
    launchlabProgram: LAUNCHLAB, tokenProgram: TOKEN, quoteTokenProgram: quoteTokenProgram ?? TOKEN, metadataProgram: METAPLEX,
    systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  }).instruction()
  return { ix, mint, pool, nonce: n }
}

/** A Float coin's on-chain record (fee receiver, pool, lifetime fee totals), or null. */
export async function launchState(conn, mint) {
  const info = await conn.getAccountInfo(F.launch(new PublicKey(mint)), 'confirmed')
  return info ? floatCoder.accounts.decode('LaunchState', info.data) : null
}

/** True when `ticker` already has a Float ticker record (a launch would need a takeover fee: we never pay one). */
export async function floatTickerTaken(conn, ticker) {
  return !!(await conn.getAccountInfo(F.ticker(ticker), 'confirmed'))
}

/** Associated token account (classic or Token-2022). */
export const ataOf = (owner, mint, program = TOKEN) => PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0]

/**
 * claim_dev_fees: sends the coin's owed dev share (LaunchState.dev_owed) to the fee receiver's account of the pair token.
 * Permissionless (any payer). The receiver's token account must exist.
 */
export async function claimDevFeesIx(conn, { payer, mint, feeReceiver, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const m = new PublicKey(mint), coinVault = F.coinVault(m)
  return floatProgram(conn).methods.claimDevFees().accountsPartial({
    payer, launch: F.launch(m), coinVault, coinVaultQuote: ataOf(coinVault, quoteMint, quoteTokenProgram), devQuote: ataOf(feeReceiver, quoteMint, quoteTokenProgram),
    quoteMint, quoteTokenProgram,
  }).instruction()
}

export const LL_FEES = {
  creatorAuth: pda([Buffer.from('creator_fee_vault_auth_seed')], LAUNCHLAB),
  creatorVault: (creator, quoteMint) => pda([creator.toBuffer(), quoteMint.toBuffer()], LAUNCHLAB),
  platformVault: (platformConfig, quoteMint) => pda([platformConfig.toBuffer(), quoteMint.toBuffer()], LAUNCHLAB),
}

/**
 * claim_coin_fees (curve stage): LaunchLab's creator fee for this coin (its creator is the Float coin vault) → Float,
 * which splits it and books the dev share as LaunchState.dev_owed. Permissionless.
 */
export async function claimCoinFeesIx(conn, { payer, mint, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const m = new PublicKey(mint), coinVault = F.coinVault(m)
  return floatProgram(conn).methods.claimCoinFees().accountsPartial({
    payer, config: F.config, launch: F.launch(m), coinVault, coinVaultQuote: ataOf(coinVault, quoteMint, quoteTokenProgram), quoteMint,
    quoteAsset: F.quoteAsset(quoteMint), feeVaultAuthority: LL_FEES.creatorAuth, creatorFeeVault: LL_FEES.creatorVault(coinVault, quoteMint),
    launchlabProgram: LAUNCHLAB, quoteTokenProgram,
  }).instruction()
}

/**
 * LaunchLab buy_exact_in on a Float coin's curve (as Float's own site builds it): spend `amountIn` of the quote
 * (WSOL units for a SOL pair, from the buyer's quote account) for at least `minOut` coins. Used by tests.
 */
export function floatBuyIx({ buyer, mint, quoteMint = WSOL, quoteTokenProgram = TOKEN, globalConfig, tier = 0, amountIn, minOut = 1n }) {
  const m = new PublicKey(mint), pool = LL.pool(m, quoteMint), platformConfig = LL.platformConfig(F.platform(tier))
  const data = Buffer.alloc(32)
  Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]).copy(data)
  data.writeBigUInt64LE(BigInt(amountIn), 8); data.writeBigUInt64LE(BigInt(minOut), 16) // share_fee_rate (24..32) = 0
  const k = (pubkey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s })
  return new TransactionInstruction({
    programId: LAUNCHLAB, data,
    keys: [k(buyer, true, true), k(LL.authority), k(globalConfig), k(platformConfig), k(pool, true), k(ataOf(buyer, m), true), k(ataOf(buyer, quoteMint, quoteTokenProgram), true),
      k(LL.vault(pool, m), true), k(LL.vault(pool, quoteMint), true), k(m), k(quoteMint), k(TOKEN), k(quoteTokenProgram), k(LL.eventAuthority), k(LAUNCHLAB),
      k(SystemProgram.programId), k(LL_FEES.platformVault(platformConfig, quoteMint), true), k(LL_FEES.creatorVault(F.coinVault(m), quoteMint), true)],
  })
}
