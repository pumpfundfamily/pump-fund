// PROBE (local validator only): the launch Pump Fund would send for a coin with GitHub / charity recipients.
//   ONE transaction: rent floor + create_v2 (creator = launch wallet) + sharing config + shares locked [+ dev buy]
//   then: distribute BEFORE the GitHub/charity accounts exist, create them afterwards, distribute again.
// Prints sizes with and without the launch lookup table for the worst case (32-byte name, 5 shareholders, dev buy).
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { randomBytes } from 'node:crypto'
import { TOKEN_2022, ata, bondingCurveAddress, buyExactSolInIx, createV2Ix, creatorVaultAddress, curveCreator, loadGlobal, pumpProgram } from '../lib/pump.mjs'
import { createDonationIx, createSharingConfigIx, createSocialIx, distributeIx, donationFeeAddress, readSharingConfig, sharingConfigAddress, socialFeeAddress, updateSharesIx, feesProgram } from '../lib/feeshare.mjs'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8931'
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(RPC)) throw new Error('local validator only')
const conn = new Connection(RPC, 'confirmed'), pump = pumpProgram(conn)
const fund = async (pk, sol) => { const s = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
const send = async (label, payer, ixs, signers, lookupTables = []) => {
  let b
  try { b = await buildTx(conn, { payer: payer.publicKey, ixs, signers, lookupTables }) } catch (e) { console.log(`❌ ${label}: ${e.message}`); return false }
  const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  console.log(`${f.fate === 'landed' ? '✅' : '❌'} ${label}: ${b.raw.length} bytes${f.fate === 'landed' ? '' : ' ' + JSON.stringify(f.error ?? f.err ?? f).slice(0, 300) + '\n' + (f.logs ?? []).slice(-6).join('\n')}`)
  return f.fate === 'landed'
}
const size = async (payer, ixs, signers, lookupTables = []) => { try { return (await buildTx(conn, { payer: payer.publicKey, ixs, signers, lookupTables })).raw.length } catch (e) { return String(e.message).match(/\d+ bytes/)?.[0] ?? e.message } }

const launcher = Keypair.generate(), buyer = Keypair.generate(), trader = Keypair.generate()
await fund(launcher.publicKey, 5); await fund(buyer.publicKey, 20); await fund(trader.publicKey, 20)
const global = await loadGlobal(conn)
const lutKey = await createLaunchTable(conn, launcher, await staticLaunchAccounts(pump, global))
const lut = (await conn.getAddressLookupTable(lutKey)).value
// a second table with the fee-sharing statics too (derived the same way: what two different launches share)
const shareStatics = async () => { const m = Keypair.generate().publicKey, c = Keypair.generate().publicKey
  const ixs = [await createSharingConfigIx(conn, { mint: m, creator: c }), await updateSharesIx(conn, { mint: m, authority: c, shareholders: [{ address: c, bps: 10000 }], current: [c] })]
  return new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58())) }
const [sa, sb] = [await shareStatics(), await shareStatics()]
const extra = [...sa].filter((k) => sb.has(k) && !lut.state.addresses.some((a) => a.toBase58() === k))
const lut2Key = await createLaunchTable(conn, launcher, [...lut.state.addresses.map((a) => a.toBase58()), ...extra])
const lut2 = (await conn.getAddressLookupTable(lut2Key)).value
console.log(`lookup tables: launch ${lut.state.addresses.length} accounts, launch + sharing ${lut2.state.addresses.length} accounts (+${extra.length})`)

async function build({ name, nShares, devBuy }) {
  const mintKp = Keypair.generate(), mint = mintKp.publicKey, rewardWallet = Keypair.generate().publicKey
  const github = Array.from({ length: Math.max(0, nShares - 2) }, () => String(BigInt('0x' + randomBytes(4).toString('hex'))))
  const charity = '0x' + randomBytes(32).toString('hex')
  const per = Math.floor(10000 / nShares)
  const targets = [{ kind: 'wallet', address: rewardWallet }, ...(nShares > 1 ? [{ kind: 'charity', id: charity, address: donationFeeAddress(mint, charity) }] : []), ...github.map((id) => ({ kind: 'github', id, address: socialFeeAddress(id) }))]
  const shareholders = targets.map((t, i) => ({ ...t, bps: per + (i === 0 ? 10000 - per * nShares : 0) }))
  const cfg = sharingConfigAddress(mint)
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }),
    SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: rewardWallet, lamports: 890_880 }),
    await createV2Ix(pump, { mint, user: launcher.publicKey, name, symbol: 'ABCDEFGHIJ', uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`, creator: launcher.publicKey }),
    await createSharingConfigIx(conn, { mint, creator: launcher.publicKey }),
    await updateSharesIx(conn, { mint, authority: launcher.publicKey, shareholders, current: [launcher.publicKey] })]
  const signers = [launcher, mintKp]
  if (devBuy) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, ata(buyer.publicKey, mint, TOKEN_2022), buyer.publicKey, mint, TOKEN_2022),
    await buyExactSolInIx(pump, global, { mint, user: buyer.publicKey, creator: cfg, lamports: 1_000_000_000n })); signers.push(buyer) }
  return { mint, mintKp, rewardWallet, shareholders, github, charity, ixs, signers, cfg }
}
for (const [label, o] of [['2 shareholders, no dev buy', { name: 'W'.repeat(32), nShares: 2, devBuy: false }], ['5 shareholders, no dev buy', { name: 'W'.repeat(32), nShares: 5, devBuy: false }], ['5 shareholders + dev buy', { name: 'W'.repeat(32), nShares: 5, devBuy: true }], ['10 shareholders + dev buy', { name: 'W'.repeat(32), nShares: 10, devBuy: true }]]) {
  const b = await build(o)
  console.log(`size, ${label}: no table ${await size(launcher, b.ixs, b.signers)}, launch table ${await size(launcher, b.ixs, b.signers, [lut])}, launch+sharing table ${await size(launcher, b.ixs, b.signers, [lut2])}`)
}

// the real thing: worst case, one transaction, with the dev buy
const b = await build({ name: 'W'.repeat(32), nShares: 5, devBuy: false })
if (!(await send('ONE transaction: create + sharing config + 5 shares locked', launcher, b.ixs, b.signers, [lut2]))) process.exit(1)
const cfg = await readSharingConfig(conn, b.mint)
console.log('   locked:', cfg.locked, '| curve creator is the config:', curveCreator((await conn.getAccountInfo(bondingCurveAddress(b.mint))).data).equals(b.cfg), '| shareholders', cfg.shareholders.map((s) => s.bps / 100 + '%').join(' '))
const addrs = b.shareholders.map((s) => s.address)
const exists = async () => (await conn.getMultipleAccountsInfo(addrs)).map((a) => (a ? (a.owner.equals(SystemProgram.programId) ? 'system' : 'fee program') : 'missing'))
const bal = async () => Promise.all(addrs.map((k) => conn.getBalance(k)))
await send('first buy 4 SOL', trader, [createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, b.mint, TOKEN_2022), trader.publicKey, b.mint, TOKEN_2022), await buyExactSolInIx(pump, global, { mint: b.mint, user: trader.publicKey, creator: b.cfg, lamports: 4_000_000_000n })], [trader])
console.log('   accounts before any are created:', (await exists()).join(', '))
let before = await bal()
const ok1 = await send('distribute BEFORE the GitHub / charity accounts exist', trader, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await distributeIx(pump, { mint: b.mint, shareholders: addrs })], [trader])
let after = await bal(); console.log('   received:', after.map((v, i) => v - before[i]).join(', '), '| vault left', await conn.getBalance(creatorVaultAddress(b.cfg)))
// now open them (permissionless, any payer), with money already sitting at those addresses
await send('open the 3 GitHub accounts afterwards (stranger pays, money already there)', trader, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...(await Promise.all(b.github.map((id) => createSocialIx(conn, { payer: trader.publicKey, githubId: id }))))], [trader])
await send('open the charity account afterwards, as the LAUNCH WALLET (the coin creator), after the lock', launcher, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await createDonationIx(conn, { payer: launcher.publicKey, mint: b.mint, configId: b.charity })], [launcher])
console.log('   accounts now:', (await exists()).join(', '))
await send('another buy', trader, [createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, b.mint, TOKEN_2022), trader.publicKey, b.mint, TOKEN_2022), await buyExactSolInIx(pump, global, { mint: b.mint, user: trader.publicKey, creator: b.cfg, lamports: 5_000_000_000n })], [trader])
before = await bal()
await send('distribute again', trader, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await distributeIx(pump, { mint: b.mint, shareholders: addrs })], [trader])
after = await bal(); const got = after.map((v, i) => v - before[i]); const sum = got.reduce((a, c) => a + c, 0)
console.log('   received:', got.map((g) => `${g} (${(g / sum * 100).toFixed(2)}%)`).join(', '))
const di = await conn.getAccountInfo(addrs[1])
if (di && !di.owner.equals(SystemProgram.programId)) { const d = feesProgram(conn).coder.accounts.decode('donationFeePda', di.data); console.log('   donation account: creator', d.creator.toBase58().slice(0, 6), 'quote', d.quoteMint.toBase58().slice(0, 6), 'lamports', di.lamports) }
void ok1
