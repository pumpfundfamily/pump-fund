// LOCAL validator only (8931). Can a Pump Fund coin be paired with another token, (1) with our own ledger and
// (2) with Pumpfun's fee sharing (GitHub + charity)? Prints what the chain says at each step.
const R = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = await import(`${R}/node_modules/@solana/web3.js/lib/index.cjs.js`)
const spl = await import(`${R}/node_modules/@solana/spl-token/lib/cjs/index.js`)
const { readFileSync } = await import('node:fs')
const P = await import(`${R}/lib/pump.mjs`)
const { buildTx, sendUntilFate } = await import(`${R}/lib/tx.mjs`)
const { buildLaunchTx } = await import(`${R}/api/launch.mjs`)
const F = await import(`${R}/lib/feeshare.mjs`)
const K = await import(`${R}/api/keeper.mjs`)
const { TOKEN_2022, TOKEN_PROGRAM_ID, ata, bondingCurveAddress, creatorVaultAddress, ammCreatorVaultAuthority, loadGlobal, pumpProgram, resolveQuote, createV2Ix, buyExactQuoteInV2Ix, tokenAccountAmount } = P

const conn = new Connection('http://127.0.0.1:8931', 'confirmed')
const pump = pumpProgram(conn), fees = F.feesProgram(conn)
const fund = async (pk, sol) => { const s = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
const key = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${R}/tests/fixtures/${f}`))))
const QS = { USDC: { mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), auth: key('usdc-authority.json'), unit: 1e6 }, BONK: { mint: new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), auth: key('bonk-authority.json'), unit: 1e5 } }
const JUDE = '0xdc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46'
const trader = Keypair.generate(), keeper = Keypair.generate()
await fund(trader.publicKey, 50); await fund(keeper.publicKey, 5)
const bal = async (owner, Q) => { const i = await conn.getAccountInfo(ata(owner, Q, TOKEN_PROGRAM_ID)); return i ? Number(tokenAccountAmount(i.data)) : 0 }

async function send(label, payer, ixs, signers, { quiet = false } = {}) {
  let b
  try { b = await buildTx(conn, { payer: payer.publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ...ixs], signers }) } catch (e) { console.log(`   ✗ ${label}: ${e.message}`); return false }
  const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  if (f.fate === 'landed') { if (!quiet) console.log(`   ✓ ${label} (${b.raw.length} B)`); return true }
  const logs = (f.logs ?? []).filter((l) => /Error|error|failed|invoke \[1\]/.test(l)).slice(-4).join(' | ')
  console.log(`   ✗ ${label}: ${f.fate} ${String(f.error ?? JSON.stringify(f.err)).slice(0, 160)}\n      ${logs.slice(0, 600)}`)
  return false
}
async function buy(mint, creator, q, whole) {
  const g = await loadGlobal(conn), Q = q.mint, units = BigInt(Math.round(whole * q.unit))
  const feeR = [g.fee_recipient, ...g.fee_recipients].find((k) => !k.equals(PublicKey.default)), bb = g.buyback_fee_recipients.find((k) => !k.equals(PublicKey.default))
  const mk = (o) => spl.createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(o, Q, TOKEN_PROGRAM_ID), o, Q, TOKEN_PROGRAM_ID, undefined)
  await send('fund trader', trader, [mk(trader.publicKey), mk(feeR), mk(bb), spl.createMintToInstruction(Q, ata(trader.publicKey, Q, TOKEN_PROGRAM_ID), q.auth.publicKey, units)], [trader, q.auth], { quiet: true })
  return send(`buy with ${whole}`, trader, [spl.createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, mint, TOKEN_2022), trader.publicKey, mint, TOKEN_2022),
    await buyExactQuoteInV2Ix(pump, g, { mint, user: trader.publicKey, creator, quoteMint: Q, quoteProgram: TOKEN_PROGRAM_ID, amountIn: units })], [trader], { quiet: true })
}
const fields = { name: 'W'.repeat(32), symbol: 'ABCDEFGHIJ', uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}` }

for (const [sym, q] of Object.entries(QS)) {
  console.log(`\n══ paired with ${sym}`)
  const quote = await resolveQuote(conn, q.mint.toBase58())
  console.log(`   Pumpfun accepts it as a pair: ${quote.ok} (kind ${quote.kind ?? quote.reason})`)
  if (!quote.ok) continue
  const Q = q.mint

  // ── 1. our own ledger (X Money / payment apps / wallet): creator = the coin's reward wallet
  {
    const L = Keypair.generate(), mintKp = Keypair.generate(), fw = Keypair.generate().publicKey
    await fund(L.publicKey, 1)
    const b = await buildLaunchTx({ conn, pump, launcher: L, mintKp, feeWalletPk: fw, ...fields, quote })
    const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
    console.log(`   1. plain paired launch: ${f.fate} (${b.raw.length} B, worst-case name/ticker/link)`)
    if (f.fate === 'landed') {
      await buy(mintKp.publicKey, fw, q, 500)
      const coin = { mint: mintKp.publicKey.toBase58(), fee_wallet: fw.toBase58(), quote_mint: Q.toBase58(), quote_program: TOKEN_PROGRAM_ID.toBase58(), quote_decimals: Math.log10(q.unit), pool: null }
      const r = await K.readCoinQ(conn, coin)
      const ok = await send('keeper collect', keeper, await K.collectIxsQ(conn, pump, coin, r, keeper.publicKey), [keeper], { quiet: true })
      console.log(`      waiting ${(r.vault + r.curveFee) / q.unit} ${sym}; collected ${ok}: reward wallet now holds ${(await bal(fw, Q)) / q.unit} ${sym}`)
    }
  }

  // ── 2. Pumpfun's own fee sharing on a paired coin: reward wallet 50%, GitHub 30%, charity 20%
  {
    const L = Keypair.generate(), mintKp = Keypair.generate(), m = mintKp.publicKey, fw = Keypair.generate().publicKey
    await fund(L.publicKey, 1); await fund(fw, 0.01)
    const cfg = F.sharingConfigAddress(m), vault = creatorVaultAddress(cfg), amm = ammCreatorVaultAuthority(cfg)
    const ok1 = await send('2. create_v2 (paired) + fee sharing on, one transaction', L, [await createV2Ix(pump, { mint: m, user: L.publicKey, ...fields, creator: L.publicKey, quote }), await F.createSharingConfigIx(conn, { mint: m, creator: L.publicKey })], [L, mintKp])
    if (!ok1) continue
    await buy(m, cfg, q, 300) // rewards earned before the lock
    const social = F.socialFeeAddress('583231'), donation = F.donationFeeAddress(m, JUDE)
    const holders = [{ address: fw, shareBps: 5000 }, { address: social, shareBps: 3000 }, { address: donation, shareBps: 2000 }]
    const okD = await send('   open the charity account', L, [await F.createDonationIx(conn, { payer: L.publicKey, mint: m, configId: JUDE })], [L])
    const upd = (remaining) => fees.methods.updateFeeSharesV2(holders).accountsPartial({ authority: L.publicKey, mint: m, sharingConfig: cfg, pumpCreatorVault: vault, pumpCreatorVaultAta: ata(vault, Q, TOKEN_PROGRAM_ID),
      quoteMint: Q, tokenProgram: TOKEN_PROGRAM_ID, coinCreatorVaultAuthority: amm, coinCreatorVaultAta: ata(amm, Q, TOKEN_PROGRAM_ID) }).remainingAccounts(remaining.map((k) => ({ pubkey: k, isSigner: false, isWritable: true }))).instruction()
    const lq = ata(L.publicKey, Q, TOKEN_PROGRAM_ID)
    const mkL = spl.createAssociatedTokenAccountIdempotentInstruction(L.publicKey, lq, L.publicKey, Q, TOKEN_PROGRAM_ID)
    let locked = false
    for (const [how, rem] of [['old shareholder = its token account', [lq]], ['old shareholder = its wallet', [L.publicKey]], ['wallet + token account', [L.publicKey, lq]]]) {
      if (await send(`   lock (update_fee_shares_v2; ${how})`, L, [mkL, await upd(rem)], [L])) { locked = true; break }
    }
    if (!locked) { console.log('   lock v2 refused; trying the SOL lock (update_fee_shares)'); locked = await send('   lock (v1)', L, [await F.updateSharesIx(conn, { mint: m, authority: L.publicKey, shareholders: holders.map((h) => ({ address: h.address, bps: h.shareBps })), current: [L.publicKey] })], [L]) }
    const c = await F.readSharingConfig(conn, m)
    console.log(`      on chain: locked ${c?.locked}, ${c?.shareholders.map((s) => s.bps).join('/')}; launch wallet got ${(await bal(L.publicKey, Q)) / q.unit} ${sym} of pre-lock rewards`)
    if (!c?.locked) continue
    await send('   open the GitHub account', L, [await F.createSocialIx(conn, { payer: L.publicKey, githubId: '583231' })], [L], { quiet: true })
    await buy(m, cfg, q, 1000)
    const vq = ata(vault, Q, TOKEN_PROGRAM_ID)
    console.log(`      creator vault holds ${(await bal(vault, Q)) / q.unit} ${sym} after a 1000 ${sym} buy`)
    const dist = (remaining) => pump.methods.distributeCreatorFeesV2(true).accountsPartial({ payer: keeper.publicKey, mint: m, bondingCurve: bondingCurveAddress(m), sharingConfig: cfg, creatorVault: vault, creatorVaultQuoteTokenAccount: vq, quoteMint: Q, quoteTokenProgram: TOKEN_PROGRAM_ID })
      .remainingAccounts(remaining.map((k) => ({ pubkey: k, isSigner: false, isWritable: true }))).instruction()
    const addrs = holders.map((h) => h.address), atas = addrs.map((a) => ata(a, Q, TOKEN_PROGRAM_ID))
    const sweep = await P.sweepCurveCreatorFeeQIx(conn, { mint: m, payer: keeper.publicKey, creator: cfg, quoteMint: Q, quoteProgram: TOKEN_PROGRAM_ID }).catch(() => null)
    let paid = false
    for (const [how, rem] of [['shareholders then their token accounts', [...addrs, ...atas]], ['pairs (holder, token account)', addrs.flatMap((a, i) => [a, atas[i]])], ['token accounts only', atas], ['shareholders only', addrs]]) {
      for (const pre of [[], sweep ? [sweep] : null].filter(Boolean)) {
        if (await send(`   distribute_creator_fees_v2 (${how}${pre.length ? ', after a sweep' : ''})`, keeper, [...pre, await dist(rem)], [keeper])) { paid = true; break }
      }
      if (paid) break
    }
    const got = await Promise.all(addrs.map((a) => bal(a, Q)))
    console.log(`      paid in ${sym}: reward wallet ${got[0] / q.unit}, GitHub account ${got[1] / q.unit}, charity account ${got[2] / q.unit}`)
    if (got[2] > 0) {
      const crank = fees.methods.crankDonationFeePda().accountsPartial({ payer: keeper.publicKey, donationFeePda: donation, quoteMint: Q, donationFeePdaAta: ata(donation, Q, TOKEN_PROGRAM_ID), donationRelayProgram: F.DONATION_RELAY,
        donationRelayEventAuthority: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], F.DONATION_RELAY)[0], mintWhitelist: PublicKey.findProgramAddressSync([Buffer.from('mint_whitelist_v1')], F.DONATION_RELAY)[0],
        epochTracker: PublicKey.findProgramAddressSync([Buffer.from('epoch_tracker_v1'), F.charityKey(JUDE).toBuffer(), Q.toBuffer()], F.DONATION_RELAY)[0],
        debouncer: PublicKey.findProgramAddressSync([Buffer.from('debouncer_v1'), F.charityKey(JUDE).toBuffer(), Q.toBuffer()], F.DONATION_RELAY)[0],
        debouncerAta: ata(PublicKey.findProgramAddressSync([Buffer.from('debouncer_v1'), F.charityKey(JUDE).toBuffer(), Q.toBuffer()], F.DONATION_RELAY)[0], Q, TOKEN_PROGRAM_ID) }).instruction()
      const okC = await send(`   forward the charity's ${sym} through the donation relay`, keeper, [await crank], [keeper])
      console.log(`      charity account after: ${(await bal(donation, Q)) / q.unit} ${sym} (forwarded: ${okC})`)
    }
  }
}
