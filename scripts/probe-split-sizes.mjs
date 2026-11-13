// PROBE (local validator only): how many charity / GitHub recipients fit in the ONE launch transaction, and does it land.
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js'
import { randomBytes } from 'node:crypto'
import { createV2Ix, loadGlobal, pumpProgram, creatorVaultAddress } from '../lib/pump.mjs'
import { createDonationIx, createSharingConfigIx, donationFeeAddress, readSharingConfig, socialFeeAddress, updateSharesIx, sharingConfigAddress } from '../lib/feeshare.mjs'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'
const conn = new Connection('http://127.0.0.1:8931', 'confirmed'), pump = pumpProgram(conn)
const launcher = Keypair.generate()
const s = await conn.requestAirdrop(launcher.publicKey, 5 * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) })
const global = await loadGlobal(conn)
const statics = async () => { const m = Keypair.generate().publicKey, c = Keypair.generate().publicKey, ch = '0x' + randomBytes(32).toString('hex')
  const ixs = [await createSharingConfigIx(conn, { mint: m, creator: c }), await updateSharesIx(conn, { mint: m, authority: c, shareholders: [{ address: c, bps: 10000 }], current: [c] }), await createDonationIx(conn, { payer: c, mint: m, configId: ch })]
  return new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58())) }
const [a, b] = [await statics(), await statics()]
const addresses = [...new Set([...(await staticLaunchAccounts(pump, global)), ...[...a].filter((k) => b.has(k))])]
const lutKey = await createLaunchTable(conn, launcher, addresses)
let lut; for (let i = 0; i < 20; i++) { lut = (await conn.getAddressLookupTable(lutKey)).value; if (lut.state.addresses.length === addresses.length) break; await new Promise((r) => setTimeout(r, 500)) }
console.log('lookup table accounts:', lut.state.addresses.length)
async function build({ x, charities, github }) {
  const mintKp = Keypair.generate(), mint = mintKp.publicKey, reward = Keypair.generate().publicKey
  const ch = Array.from({ length: charities }, () => '0x' + randomBytes(32).toString('hex')), gh = Array.from({ length: github }, () => String(BigInt('0x' + randomBytes(5).toString('hex'))))
  const t = [...(x ? [reward] : []), ...ch.map((c) => donationFeeAddress(mint, c)), ...gh.map((g) => socialFeeAddress(g))]
  const per = Math.floor(10000 / t.length), shareholders = t.map((address, i) => ({ address, bps: per + (i === 0 ? 10000 - per * t.length : 0) }))
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }),
    ...(x ? [SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: reward, lamports: 890_880 })] : []),
    await createV2Ix(pump, { mint, user: launcher.publicKey, name: 'W'.repeat(32), symbol: 'ABCDEFGHIJ', uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`, creator: launcher.publicKey }),
    await createSharingConfigIx(conn, { mint, creator: launcher.publicKey }),
    ...(await Promise.all(ch.map((c) => createDonationIx(conn, { payer: launcher.publicKey, mint, configId: c })))),
    await updateSharesIx(conn, { mint, authority: launcher.publicKey, shareholders, current: [launcher.publicKey] })]
  return { mint, ixs, signers: [launcher, mintKp], shareholders }
}
for (const o of [{ x: 1, charities: 1, github: 0 }, { x: 0, charities: 1, github: 0 }, { x: 1, charities: 2, github: 0 }, { x: 1, charities: 1, github: 3 }, { x: 1, charities: 2, github: 2 }, { x: 1, charities: 3, github: 0 }, { x: 0, charities: 3, github: 2 }, { x: 1, charities: 4, github: 0 }, { x: 0, charities: 5, github: 0 }, { x: 1, charities: 0, github: 4 }]) {
  const t = await build(o); let line
  try { const bt = await buildTx(conn, { payer: launcher.publicKey, ixs: t.ixs, signers: t.signers, lookupTables: [lut] })
    const f = await sendUntilFate(conn, { raw: bt.raw, signature: bt.signature, lastValidBlockHeight: bt.lastValidBlockHeight })
    const tx = f.fate === 'landed' ? await conn.getTransaction(bt.signature, { maxSupportedTransactionVersion: 0 }) : null
    line = `${bt.raw.length} bytes, ${f.fate}${tx ? `, ${tx.meta.computeUnitsConsumed} CU, cost ${(tx.meta.preBalances[0] - tx.meta.postBalances[0]) / 1e9} SOL, locked ${(await readSharingConfig(conn, t.mint)).locked}` : ' ' + JSON.stringify(f.error ?? '').slice(0, 200)}`
  } catch (e) { line = 'does not fit: ' + (String(e.message).match(/\d+ bytes/)?.[0] ?? e.message) }
  console.log(`X ${o.x ? 'yes' : 'no '} · charities ${o.charities} · GitHub ${o.github}: ${line}`)
}
