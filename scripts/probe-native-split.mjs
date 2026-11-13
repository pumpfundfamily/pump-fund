// PROBE (local validator only): can ONE Pumpfun coin split its creator rewards between a wallet of ours, a GitHub account
// and a charity, through Pumpfun's own fee sharing? Launches a coin, sets the split, trades, distributes, prints balances.
// Run: ./validator.sh (port 8931), then `node scripts/probe-native-split.mjs`. Refuses any RPC that is not localhost.
import anchor from '@coral-xyz/anchor'
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { PUMP, PUMP_AMM, TOKEN_2022, TOKEN_PROGRAM_ID, WSOL, ammCreatorVaultAuthority, ata, bondingCurveAddress, buyExactSolInIx, createV2Ix, creatorVaultAddress, curveCreator, loadGlobal, poolAddress, pumpProgram } from '../lib/pump.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8931'
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(RPC)) throw new Error('local validator only')
const conn = new Connection(RPC, 'confirmed')
const pump = pumpProgram(conn)
const PFEE = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
const fees = new anchor.Program(JSON.parse(readFileSync(new URL('../lib/pump_fees.idl.json', import.meta.url))), new anchor.AnchorProvider(conn, { publicKey: Keypair.generate().publicKey }, {}))
const pda = (seeds, prog = PFEE) => PublicKey.findProgramAddressSync(seeds, prog)[0]
const fund = async (pk, sol) => { const s = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
const send = async (label, payer, ixs, signers) => {
  const b = await buildTx(conn, { payer: payer.publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs], signers })
  const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  console.log(`${f.fate === 'landed' ? '✅' : '❌'} ${label}: ${b.raw.length} bytes${f.fate === 'landed' ? '' : ' ' + JSON.stringify(f.error ?? f.err ?? f).slice(0, 500)}`)
  if (f.fate !== 'landed') { console.log((f.logs ?? []).slice(-8).join('\n')); process.exit(1) }
}

const launcher = Keypair.generate(), mintKp = Keypair.generate(), trader = Keypair.generate(), rewardWallet = Keypair.generate().publicKey
await fund(launcher.publicKey, 5); await fund(trader.publicKey, 20)
const mint = mintKp.publicKey
const githubId = '583231' // a GitHub numeric user id (octocat); platform 2 = GitHub on Pumpfun
const charity = new PublicKey(Buffer.from('dc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46', 'hex')) // St. Jude's Donate.gg id
const sharingConfig = pda([Buffer.from('sharing-config'), mint.toBuffer()])
const socialPda = pda([Buffer.from('social-fee-pda'), Buffer.from(githubId), Buffer.from([2])])
const donationPda = pda([Buffer.from('donation-fee-pda'), mint.toBuffer(), charity.toBuffer()])

// 1. launch: the launch wallet is the coin's creator (it must sign the sharing set-up)
await send('create_v2', launcher, [await createV2Ix(pump, { mint, user: launcher.publicKey, name: 'Native Split', symbol: 'NSPLIT', uri: 'https://gateway.pinata.cloud/ipfs/bafkreiprobe', creator: launcher.publicKey })], [launcher, mintKp])

// 2. the split, in ONE transaction: sharing config + the GitHub account + the charity account + the shares (locked for ever)
const ammAuth = ammCreatorVaultAuthority(sharingConfig)
const shares = [{ address: rewardWallet, shareBps: 5000 }, { address: socialPda, shareBps: 3000 }, { address: donationPda, shareBps: 2000 }]
const ixs = [
  await fees.methods.createFeeSharingConfig().accountsPartial({ payer: launcher.publicKey, mint, sharingConfig, bondingCurve: bondingCurveAddress(mint), pool: null, pumpAmmProgram: null, pumpAmmEventAuthority: null }).instruction(),
  ...(await conn.getAccountInfo(socialPda) ? [] : [await fees.methods.createSocialFeePda(githubId, 2).accountsPartial({ payer: launcher.publicKey, socialFeePda: socialPda }).instruction()]),
  await fees.methods.createDonationFeePda().accountsPartial({ payer: launcher.publicKey, donationFeePda: donationPda, configId: charity, baseMint: mint, bondingCurve: bondingCurveAddress(mint), pool: poolAddress(mint), sharingConfig }).instruction(),
  await fees.methods.updateFeeShares(shares).accountsPartial({ authority: launcher.publicKey, mint, sharingConfig, pumpCreatorVault: creatorVaultAddress(sharingConfig), coinCreatorVaultAuthority: ammAuth, coinCreatorVaultAta: ata(ammAuth, WSOL, TOKEN_PROGRAM_ID) })
    .remainingAccounts([{ pubkey: launcher.publicKey, isSigner: false, isWritable: true }]).instruction(),
]
await send('sharing config + GitHub account + charity account + shares', launcher, ixs, [launcher])
const cfg = fees.coder.accounts.decode('sharingConfig', (await conn.getAccountInfo(sharingConfig)).data)
console.log('   shareholders:', cfg.shareholders.map((s) => `${s.address.toBase58().slice(0, 6)} ${s.shareBps / 100}%`).join(', '), '| admin_revoked', cfg.adminRevoked)
const creator = curveCreator((await conn.getAccountInfo(bondingCurveAddress(mint))).data)
console.log('   curve creator is the sharing config:', creator.equals(sharingConfig))

// 3. trades pay creator rewards into the config's vault
const global = await loadGlobal(conn)
await send('buy 10 SOL', trader, [createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, mint, TOKEN_2022), trader.publicKey, mint, TOKEN_2022),
  await buyExactSolInIx(pump, global, { mint, user: trader.publicKey, creator, lamports: 10_000_000_000n })], [trader])

// 4. anyone distributes: Pumpfun pays each shareholder its share
const bal = async () => Promise.all([rewardWallet, socialPda, donationPda, creatorVaultAddress(sharingConfig)].map((k) => conn.getBalance(k)))
const before = await bal()
const dist = await pump.methods.distributeCreatorFees().accountsPartial({ mint, bondingCurve: bondingCurveAddress(mint), sharingConfig, creatorVault: creatorVaultAddress(sharingConfig) })
  .remainingAccounts(shares.map((s) => ({ pubkey: s.address, isSigner: false, isWritable: true }))).instruction()
await send('distribute_creator_fees (signed by a stranger)', trader, [dist], [trader])
const after = await bal(), got = after.map((v, i) => v - before[i])
const paid = got[0] + got[1] + got[2]
console.log(`   paid out ${paid / 1e9} SOL: our reward wallet ${got[0]} (${(got[0] / paid * 100).toFixed(2)}%), GitHub account ${got[1]} (${(got[1] / paid * 100).toFixed(2)}%), charity account ${got[2]} (${(got[2] / paid * 100).toFixed(2)}%)`)

// 5. a second attempt to change the shares must be refused
try {
  const again = await fees.methods.updateFeeShares([{ address: rewardWallet, shareBps: 10000 }]).accountsPartial({ authority: launcher.publicKey, mint, sharingConfig, pumpCreatorVault: creatorVaultAddress(sharingConfig), coinCreatorVaultAuthority: ammAuth, coinCreatorVaultAta: ata(ammAuth, WSOL, TOKEN_PROGRAM_ID) })
    .remainingAccounts(shares.map((s) => ({ pubkey: s.address, isSigner: false, isWritable: true }))).instruction()
  const b = await buildTx(conn, { payer: launcher.publicKey, ixs: [again], signers: [launcher] })
  const sim = await conn.simulateTransaction(b.tx ?? (await import('@solana/web3.js')).VersionedTransaction.deserialize(b.raw), { sigVerify: false })
  console.log('   changing the shares again:', sim.value.err ? `refused ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).filter((l) => /Error/.test(l)).join(' ').slice(0, 160)}` : '⚠ ACCEPTED')
} catch (e) { console.log('   changing the shares again: refused', String(e.message).slice(0, 200)) }
