// End to end on a local validator with pump.fun cloned from mainnet (./validator.sh, port 8931):
// launching starts CLOSED → the operator's go-live command launches $FUND from the operator wallet → launching opens →
// a signed-in account launches a coin FOR an X account → trades → the keeper collects and credits that account →
// X Money pays it (Relay + Peer stood in, the Solana side real) → the public pages show it.
// Every number is checked against what the chain says.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { openDb, buckets, owedTo, shareOf, now, kvGet, kvSet, launchingOpen, LAUNCHING_CLOSED } from '../api/db.mjs'
import { createApp } from '../api/server.mjs'
import { FixtureX } from '../api/x.mjs'
import { feeWallet } from '../api/feewallet.mjs'
import { keeperPass, keeperConfig, forwardDonations, shareholdersOf } from '../api/keeper.mjs'
import { RENT_FLOOR } from '../api/launch.mjs'
import { TOKEN_2022, ata, bondingCurveAddress, buyExactSolInIx, curveCreator, loadGlobal, pumpProgram, tokenAccountAmount } from '../lib/pump.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'
import { xmoneyPass, xmoneyConfig, appMayStart } from '../api/xmoney.mjs'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'
import { platformPlan, queuePlatformLaunch, PLATFORM_ROW_ID } from '../api/platform-launch.mjs'
import { buildLaunchTx } from '../api/launch.mjs'
import { nativeShareholders, settleNativeSplit } from '../api/nativesplit.mjs'
import { donationFeeAddress, feesProgram, readSharingConfig, sharingConfigAddress, socialFeeAddress } from '../lib/feeshare.mjs'
import { creatorVaultAddress } from '../lib/pump.mjs'

const RPC = `http://127.0.0.1:${process.env.LOCAL_RPC_PORT ?? 8931}`
const conn = new Connection(RPC, 'confirmed')
const pump = pumpProgram(conn)
const SEED = 'ab'.repeat(32)
const PORT = 5593
const BASE = `http://127.0.0.1:${PORT}`
const launcher = Keypair.generate(), keeper = Keypair.generate(), platformWallet = Keypair.generate()
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
const payee = Keypair.generate(), buyer = Keypair.generate()
// the DEV stub signs a handle in as this id (api/providers/stub.mjs)
const stubId = (h) => BigInt('0x' + createHash('sha256').update(`x:${h}`).digest('hex').slice(0, 12)).toString()
const DAVE = stubId('dave'), CAROL = stubId('carol'), BOB = '7777777777777777777'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function fund(to, sol) { const s = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
async function buy(trader, mint, creator, sol) {
  const global = await loadGlobal(conn)
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, mint, TOKEN_2022), trader.publicKey, mint, TOKEN_2022),
    await buyExactSolInIx(pump, global, { mint, user: trader.publicKey, creator, lamports: BigInt(Math.round(sol * 1e9)) })]
  const b = await buildTx(conn, { payer: trader.publicKey, ixs, signers: [trader] })
  const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  assert.equal(f.fate, 'landed', JSON.stringify(f))
}

// GitHub's public API, stood in: logins → numeric ids
const GH = new Map([['octocat', { id: '583231', login: 'octocat', name: 'The Octocat', avatar: 'https://avatars.githubusercontent.com/u/583231' }]])
const ghCalls = []
const github = async (login) => { ghCalls.push(login); if (github.down) throw new Error('GitHub answered 503'); return GH.get(String(login).toLowerCase()) ?? null }
const JUDE = '0xdc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46'
let app, db, x, cookie = ''
const ENV = { PUBLIC_URL: BASE, DEV_STUBS: '1', PROJECT_TICKER: 'FUND', PROJECT_NAME: 'Pump Fund', PER_AUTHOR_COOLDOWN_SECONDS: '0', FEE_SEED: SEED, PINATA_JWT: 'test',
  XMONEY_ENABLED: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'pf-')), MIN_COLLECT_LAMPORTS: '1', MIN_WITHDRAW_LAMPORTS: '1000000', SITE_SWEEPS: '0' }
const pins = []
const pin = async ({ name, symbol, description, twitter, website }) => {
  pins.push({ name, symbol, description, twitter, website })
  // a worst-case-length gateway link (memory test-the-worst-case-input-size)
  return { uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`, imageUri: 'https://gateway.pinata.cloud/ipfs/bafkreiimage' }
}
const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, { redirect: 'manual', ...opts, headers: { origin: BASE, cookie, 'content-type': 'application/json', ...(opts.headers ?? {}) } })
  const sc = r.headers.getSetCookie?.() ?? []
  for (const c of sc) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (k === 'pf_sid' || k === 'pf_auth') cookie = [...cookie.split('; ').filter((p) => p && !p.startsWith(k + '=')), `${k}=${v}`].join('; ') }
  return r
}
// ⭐ launches are by wallet (14 Nov): the test launcher's wallet signs every payment the form asks for
const daveWallet = Keypair.generate()
const DW = daveWallet.publicKey.toBase58()
const signerOf = (addr) => [daveWallet, buyer].find((k) => k.publicKey.toBase58() === addr)
const post = async (path, body, { pay = true } = {}) => {
  if (path === '/api/launch' && body && body.wallet === undefined) body = { ...body, wallet: body.devBuy?.wallet ?? DW }
  const r = await api(path, { method: 'POST', body: JSON.stringify(body) })
  const out = { status: r.status, body: await r.json() }
  if (pay && path === '/api/launch' && out.status === 200 && out.body.kind === 'pay') {
    const tx = VersionedTransaction.deserialize(Buffer.from(out.body.transaction, 'base64'))
    tx.sign([signerOf(out.body.wallet)])
    return post('/api/launch/sign', { id: out.body.id, transaction: Buffer.from(tx.serialize()).toString('base64') })
  }
  return out
}
const signInAs = async (h) => {
  cookie = ''
  let r = await api(`/api/auth/x/start?as=${h}&return=/launch`)
  r = await api(new URL(r.headers.get('location')).pathname + new URL(r.headers.get('location')).search)
  assert.equal(r.headers.get('location'), '/launch')
}
const settled = async (id) => { for (let i = 0; i < 300; i++) { const s = await (await api(`/api/launch/${id}`)).json(); if (!['queued', 'launching'].includes(s.state)) return s; await new Promise((r) => setTimeout(r, 500)) } throw new Error('launch never settled') }
const tokensOf = async (owner, m) => { const a = await conn.getAccountInfo(ata(owner, new PublicKey(m), TOKEN_2022)); return a ? tokenAccountAmount(a.data) : 0n }
// test mint keys stand in for …fund keys (the grinder and the suffix rule are unit-tested)
const addVanity = () => { const k = Keypair.generate(); db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now()) }
const quietKeeper = (extra = {}) => keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: { ...keeperConfig({ MIN_COLLECT_LAMPORTS: '1' }), collectQSeconds: 0, ...extra }, log: { info() {}, error: console.error } })

test.before(async () => {
  for (const k of [launcher, keeper, platformWallet, buyer, daveWallet, ...traders]) await fund(k.publicKey, 30)
  db = openDb(':memory:')
  x = new FixtureX('pumpfund')
  x.users = new Map([
    ['dave', { id: DAVE, handle: 'dave', name: 'Dave', avatar: null, followers: 500, createdAt: now() - 400 * 86400 }],
    ['bob', { id: BOB, handle: 'Bob', name: 'Bob the Builder', avatar: 'https://pbs.twimg.com/bob.jpg', followers: 3, createdAt: now() - 30 * 86400 }],
    ['carol', { id: CAROL, handle: 'carol', name: 'Carol', avatar: null, followers: 40, createdAt: now() - 200 * 86400 }],
  ])
  // ⛔ no START_OPEN: a fresh Pump Fund store starts with launching CLOSED, exactly as the box will
  app = createApp({ env: ENV, db, conn, x, keeper, launcher, platformLauncher: platformWallet, pin, github, sar: async () => sarFake })
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r))
})
test.after(() => app?.server.close())

/**
 * Stand-in rails for Relay / Base / Peer (none of them run locally). The SOLANA side is real: the bridge deposit is a
 * real transfer from the keeper to a "Relay depository" wallet on the validator, and the way back is a real transfer
 * from it to the keeper, so the fee wallets, buckets and keeper balance are all checked against the chain.
 */
/** Stand-in for Peer's PayPal connect (Curator): which handles are connected, what was asked, and a link's state. */
const sarFake = {
  live: new Set(), asked: [], state: 'pending',
  async prepare(input) { this.asked.push(input); return { ...input, requestId: 'p' + this.asked.length, expiresAt: Date.now() + 900_000, url: 'https://mobile.peer.xyz/clip/connect?request=x', appUrl: 'https://mobile.peer.xyz/connect?request=x' } },
  async status(link) { if (this.state === 'connected') this.live.add(link.payeeHandle); return { status: this.state } },
  async isConnected({ payeeHandle }) { return this.live.has(payeeHandle) },
}

function fakeRails() {
  const depository = Keypair.generate()
  const st = { quotes: 0, requests: new Map(), deposits: new Map(), baseSends: 0, usdc: 0n, lostOrder: null }
  const usdPerSol = 150n
  const rails = {
    depository, st, baseAddress: '0x00000000000000000000000000000000000ba5e0',
    relay: {
      async quote(b) {
        const requestId = `req-${++st.quotes}`
        if (b.originChainId === 792703809) {
          const ix = SystemProgram.transfer({ fromPubkey: new PublicKey(b.user), toPubkey: depository.publicKey, lamports: Number(b.amount) })
          st.requests.set(requestId, { dir: 'out', lamports: BigInt(b.amount) })
          return { steps: [{ id: 'deposit', kind: 'transaction', requestId, items: [{ data: { addressLookupTableAddresses: [],
            instructions: [{ programId: ix.programId.toBase58(), data: Buffer.from(ix.data).toString('hex'), keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) }] } }] }] }
        }
        st.requests.set(requestId, { dir: 'back', usdc: BigInt(b.amount), recipient: b.recipient })
        return { steps: [{ id: 'approve', kind: 'transaction', items: [{ data: { chainId: 8453, to: '0xusdc' } }] },
          { id: 'deposit', kind: 'transaction', requestId, items: [{ data: { chainId: 8453, to: '0xrelay' } }] }] }
      },
      async status(id) {
        const r = st.requests.get(id)
        if (!r) return { status: 'unknown' }
        if (r.dir === 'out') return { status: 'success', txHashes: [`0xfill-${id}`] }
        if (!r.sent) return { status: 'waiting' }
        if (!r.fill) {
          // Relay's solver pays the keeper on Solana: 1 USDC buys 1/150 SOL
          const lamports = Number(r.usdc * 1_000_000_000n / (usdPerSol * 1_000_000n))
          const b = await buildTx(conn, { payer: depository.publicKey, signers: [depository], ixs: [SystemProgram.transfer({ fromPubkey: depository.publicKey, toPubkey: new PublicKey(r.recipient), lamports })] })
          const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
          assert.equal(f.fate, 'landed')
          r.fill = b.signature; r.lamports = lamports
        }
        return { status: 'success', txHashes: [r.fill] }
      },
    },
    base: {
      ethBalance: async () => 10n ** 17n,
      usdcBalance: async () => st.usdc,
      async send(d) { st.baseSends++; if (d.to === '0xrelay') { for (const r of st.requests.values()) if (r.dir === 'back' && !r.sent) { r.sent = true; st.usdc -= r.usdc } } return '0xsent' },
      async usdcIn(hash) {
        const r = st.requests.get(hash.replace('0xfill-', ''))
        const usdc = r.lamports * usdPerSol * 1_000_000n / 1_000_000_000n
        st.usdc += usdc
        return usdc
      },
    },
    peer: {
      async cashout({ amount, payee, platform = 'xmoney' }) {
        const depositId = `escrow_${st.deposits.size + 1}`
        st.deposits.set(depositId, { depositId, payee, platform, totalAmount: amount, filledAmount: 0n, pendingAmount: 0n, returnedAmount: 0n, state: 'awaiting-buyer', fills: [], withdrawn: false })
        st.usdc -= amount
        return { depositId, txHash: `0xdeposit${st.deposits.size}`.padEnd(66, '0') }
      },
      async order(id) { return { ...st.deposits.get(id) } },
      async connected(platform, payee) { return platform === 'paypal' && sarFake.live.has(payee) },
      async orders() { return [...st.deposits.values()].map((d) => ({ ...d })) },
      async withdraw(id) {
        const d = st.deposits.get(id)
        const open = d.totalAmount - d.filledAmount - d.pendingAmount - d.returnedAmount
        d.returnedAmount += open; d.withdrawn = true; d.state = 'returned'
        st.usdc += open
        return { depositId: id, withdrawTxHash: '0xw' }
      },
    },
    // a buyer pays `usd` of the order to the X Money handle and proves it
    fill(id, usdc) { const d = st.deposits.get(id); d.filledAmount += usdc; d.fills.push({ intentHash: `0xintent${d.fills.length + 1}${id}`, status: 'FULFILLED', buyer: '0x00000000000000000000000000000000000b0b01', releasedAmount: usdc, fiatPaid: Number(usdc) / 1e6, paidCurrency: 'USD', fulfilledAt: 1 }); if (d.filledAmount === d.totalAmount) d.state = 'delivered' },
  }
  return rails
}


test('before $FUND exists launching is closed: the form says so, nothing is queued, and the go-live command only reads until told to launch', async () => {
  assert.equal(launchingOpen(db), false)
  const stats = await (await api('/api/stats')).json()
  assert.deepEqual([stats.launchingOpen, stats.platformMint, stats.ticker], [false, null, 'FUND'])
  assert.equal((await (await api('/api/launch/options')).json()).open, false)
  await signInAs('dave')
  addVanity()
  const closed = await post('/api/launch', { symbol: 'EARLY', for: 'bob' })
  assert.equal(closed.status, 409)
  assert.match(closed.body.error, /closed/)
  assert.equal(db.prepare('SELECT count(*) n FROM mentions').get().n, 0)
  assert.equal(x.calls.user ?? 0, 0, 'closed is answered before any paid X read')

  // the go-live plan: every precondition named, nothing written
  const plan = await platformPlan({ db, conn, env: { ...ENV, PLATFORM_LAUNCH_KEY: '/nonexistent' } })
  assert.equal(plan.ok, false)
  assert.match(plan.problems.join(' | '), /PLATFORM_LAUNCH_KEY/)
  assert.equal(db.prepare('SELECT count(*) n FROM mentions').get().n, 0, 'planning changed nothing')
})

test('go-live: $FUND "Pump Fund" launches from the operator wallet (its creator), with the heart logo, and its landing opens launching; it can never be queued twice', async () => {
  const before = { op: await conn.getBalance(platformWallet.publicKey), launcher: await conn.getBalance(launcher.publicKey) }
  assert.equal(queuePlatformLaunch(db, { ticker: 'FUND', name: 'Pump Fund', env: ENV }), true)
  assert.equal(queuePlatformLaunch(db, { ticker: 'FUND', name: 'Pump Fund', env: ENV }), false, 'a second queue is a no-op')
  const out = await app.bot.tick({ doPoll: false })
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(out.queue.mint)
  assert.deepEqual([t.symbol, t.name, t.platform, t.own_creator, t.mode, t.fee_wallet], ['FUND', 'Pump Fund', 1, 1, 'creator', platformWallet.publicKey.toBase58()])
  const curve = await conn.getAccountInfo(bondingCurveAddress(new PublicKey(t.mint)))
  assert.ok(curveCreator(curve.data).equals(platformWallet.publicKey), 'pump.fun creator is the operator wallet')
  assert.ok(before.op - await conn.getBalance(platformWallet.publicKey) > 0, 'the operator wallet paid')
  assert.equal(await conn.getBalance(launcher.publicKey), before.launcher, 'the shared launch wallet paid nothing')
  const p = pins.at(-1)
  assert.deepEqual([p.name, p.symbol, p.website, p.twitter], ['Pump Fund', 'FUND', 'https://pumpfund.family/', ''])
  assert.match(p.description, /fund people and good causes/)
  assert.equal(launchingOpen(db), true, 'launching opened with the landing')
  assert.equal(kvGet(db, 'platform_mint'), t.mint)
  const stats = await (await fetch(`${BASE}/api/stats?fresh=1`)).json()
  assert.deepEqual([stats.launchingOpen, stats.platformMint], [true, t.mint])
  // never again
  const plan = await platformPlan({ db, conn, env: ENV })
  assert.equal(plan.ok, false)
  assert.match(plan.problems.join(' | '), /already launched/)
  assert.equal(db.prepare('SELECT state FROM mentions WHERE tweet_id = ?').get(PLATFORM_ROW_ID).state, 'launched')
})

let mint, fw
test('a signed-in account launches a coin FOR @bob: the handle is resolved to his X id on the form, the coin is his, its description says so, and his rewards are set to go to his X Money', async () => {
  // no wallet: refused before anything is read (launching is by wallet, operator 14 Nov)
  const anon = await fetch(`${BASE}/api/launch`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(anon.status, 400)
  assert.match((await anon.json()).error, /Connect a wallet/)
  const o = await (await api('/api/launch/options')).json()
  assert.equal(o.open, true)
  assert.equal(o.devBuy.enabled, false, 'no lookup table yet: no dev buys offered')
  assert.equal(o.pairs, undefined)

  // as-you-type: the ticker is free, @bob exists (shown with his name), a stranger does not; signed out, no lookup is made
  const calls = x.calls.user ?? 0
  let chk = await (await api('/api/launch/check?symbol=help&for=@bob')).json()
  assert.deepEqual(chk.ticker, { symbol: 'HELP', free: true, reason: null })
  assert.deepEqual(chk.for, { ok: true, id: BOB, handle: 'Bob', name: 'Bob the Builder', avatar: 'https://pbs.twimg.com/bob.jpg', self: false })
  chk = await (await api('/api/launch/check?for=bob')).json()
  assert.equal(x.calls.user, calls + 1, 'one paid lookup per handle: the second check came from the cache')
  chk = await (await api('/api/launch/check?for=nobodyhere')).json()
  assert.deepEqual(chk.for, { ok: false, reason: '@nobodyhere was not found on X. Check the handle.' })
  // no sign-in is needed for a lookup any more: it is limited per IP instead
  const signedOut = await (await fetch(`${BASE}/api/launch/check?for=someoneelse`)).json()
  assert.equal(signedOut.for.ok, false)
  assert.equal(x.calls.user, calls + 3)

  // an unknown handle and a malformed one are refused on the form; nothing is queued
  let bad = await post('/api/launch', { symbol: 'HELP', for: 'nobodyhere' })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /not found on X/)
  bad = await post('/api/launch', { symbol: 'HELP', for: 'not a handle!' })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /X handle/)
  // X is down: refused with "try again", never guessed
  x.userInfoFails = true
  bad = await post('/api/launch', { symbol: 'HELP', for: 'erin' })
  assert.equal(bad.status, 503); assert.match(bad.body.error, /could not be looked up/)
  x.userInfoFails = false
  assert.equal(db.prepare("SELECT count(*) n FROM mentions WHERE source = 'site' AND platform = 0").get().n, 0)

  addVanity()
  const pinsBefore = pins.length, launcherBefore = await conn.getBalance(launcher.publicKey)
  const sub = await post('/api/launch', { symbol: 'help', name: 'Help Bob', for: '@BOB', image: PNG.toString('base64'), mode: 'holders', pair: 'BONK' })
  assert.equal(sub.status, 200, JSON.stringify(sub.body))
  assert.equal(sub.body.state, 'queued')
  // a second submit while the first is in the queue
  assert.equal((await post('/api/launch', { symbol: 'other', for: 'bob' })).status, 409)
  const out = await app.bot.tick({ doPoll: false })
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const st = await settled(sub.body.id)
  assert.equal(st.state, 'launched')
  mint = new PublicKey(st.mint)
  fw = feeWallet(Buffer.from(SEED, 'hex'), mint).publicKey
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(st.mint)
  assert.deepEqual([t.symbol, t.name, t.creator_id, t.creator_handle, t.launched_by_id, t.launched_by_handle], ['HELP', 'Help Bob', BOB, 'Bob', DW, ''])
  assert.deepEqual([t.mode, t.native_holders, t.quote_mint, t.venue], ['creator', 0, null, 'pump'], 'always the creator\'s rewards, always SOL-paired on Pumpfun, whatever the request carried')
  assert.ok(curveCreator((await conn.getAccountInfo(bondingCurveAddress(mint))).data).equals(fw), 'pump.fun creator is the coin\'s derived fee wallet')
  assert.equal(await conn.getBalance(fw), RENT_FLOOR, 'fee wallet prefunded to the rent floor')
  assert.deepEqual(pins[pinsBefore], { name: 'Help Bob', symbol: 'HELP', description: `$HELP was launched for @Bob on Pump Fund. Its creator rewards go to @Bob: 127.0.0.1:${PORT}`, twitter: '', website: 'https://pumpfund.family/' })
  assert.ok(Math.abs(launcherBefore - await conn.getBalance(launcher.publicKey)) < 0.01e9, 'the launcher\'s payment covered the creation')
  assert.equal(JSON.parse(db.prepare('SELECT opts FROM mentions WHERE tweet_id = ?').get(sub.body.id).opts).fee.payer, DW, 'paid by the connected wallet')
  const bob = db.prepare('SELECT * FROM users WHERE x_id = ?').get(BOB)
  assert.deepEqual([bob.payout_kind, bob.payout_auto, bob.payout_confirmed, bob.settings_at], ['xmoney', 1, 0, null], 'X Money set up for bob, who never signed in')
  assert.equal(x.replies.length, 0, 'nothing is ever posted on X')
  // the public pages say whose coin it is and who launched it
  const view = await (await api(`/api/token/${st.mint}`)).json()
  assert.equal(view.token.creator.id, BOB)
  assert.deepEqual(view.token.launchedBy, { id: DW, handle: '' })
  assert.equal((await (await api('/api/creator/bob')).json()).tokens.length, 1)
  // the ticker is now held for 24 hours, on the form too
  assert.equal((await (await api('/api/launch/check?symbol=help')).json()).ticker.free, false)
  const again = await post('/api/launch', { symbol: 'HELP', for: 'bob' })
  assert.equal(again.status, 409)
  assert.match(again.body.error, /launched in the last 24 hours/)
})

test('trades pay creator rewards; the keeper collects them and credits BOB exactly; X Money sends them to the handle he holds now, and the public pages show every step', async () => {
  await buy(traders[0], mint, fw, 3); await buy(traders[1], mint, fw, 3)
  await quietKeeper()
  const m = mint.toBase58()
  const owed = buckets(db, m).creator
  assert.equal(owed, await conn.getBalance(fw) - RENT_FLOOR, 'credited exactly what the chain holds above the floor')
  assert.ok(owed > 1_000_000, `owed ${owed}`)
  assert.equal(owedTo(db, BOB).total, owed, 'owed to bob')
  assert.equal(owedTo(db, DAVE).total, 0, 'nothing to the launcher')
  console.log(`creator rewards on 6 SOL of buys: ${owed / 1e9} SOL`)

  // 6 SOL of test trades earn ~0.02 SOL: under the default 0.05 SOL threshold (correctly not paid yet), so lower it here
  db.prepare('UPDATE users SET auto_min_lamports = 1000000 WHERE x_id = ?').run(BOB)
  const rails = fakeRails()
  rails.handleOf = async (id) => (id === BOB ? 'BobNewName' : null)
  await fund(rails.depository.publicKey, 1)
  const cfg = { ...xmoneyConfig({ XMONEY_ENABLED: '1' }), minLamports: 1_000_000, adoptSeconds: 0 }
  const pass = () => xmoneyPass({ db, conn, keeper, seed: Buffer.from(SEED, 'hex'), rails, cfg, solUsd: 150, log: { info() {}, error: console.error } })
  const row = () => db.prepare('SELECT * FROM xmoney_payouts WHERE x_id = ? ORDER BY id DESC LIMIT 1').get(BOB)
  for (let i = 0; i < 6 && row()?.state !== 'listed'; i++) await pass()
  assert.equal(row()?.state, 'listed', JSON.stringify(row() ?? null))
  assert.equal(row().lamports, owed, 'all of bob\'s rewards went out')
  assert.equal(buckets(db, m).creator, 0)
  assert.equal(rails.st.deposits.get(row().deposit_id).payee, 'BobNewName', 'paid to the handle bob holds NOW, looked up by his X id')
  let page = await (await api(`/api/token/${m}`)).json()
  assert.equal(page.xmoney[0].status, 'Listed on Peer, waiting for a payer')
  assert.ok(page.xmoney[0].collectTxs.length >= 1 && page.xmoney[0].bridgeTx && page.xmoney[0].peerOrder, JSON.stringify(page.xmoney[0]))
  let pay = await (await fetch(`${BASE}/api/payouts?a=1`)).json()
  assert.equal(pay.payouts.length, 1)
  assert.deepEqual([pay.payouts[0].handle, pay.payouts[0].status, pay.payouts[0].paidUsd], ['BobNewName', 'Listed on Peer, waiting for a payer', 0])
  assert.ok(pay.totals.listedUsd > 0 && pay.totals.paidUsd === 0)
  // a buyer pays bob's X Money in full: done
  rails.fill(row().deposit_id, BigInt(row().usdc))
  await pass()
  assert.equal(row().state, 'done', JSON.stringify(row()))
  page = await (await api(`/api/token/${m}`)).json()
  assert.equal(page.xmoney[0].status, "Paid to @BobNewName's X Money")
  // ⭐ the proof: every step of bob's payout, each with its transaction, on the token page and on /api/proof
  const rec = page.proof.find((x) => x.kind === 'peer')
  assert.deepEqual(rec.steps.map((x) => x.step), ['collect', 'bridge', 'bridged', 'listed', 'paid'], JSON.stringify(rec.steps))
  assert.ok(rec.steps.every((x) => x.tx && x.url), JSON.stringify(rec.steps))
  assert.match(rec.steps[0].url, /^https:\/\/solscan\.io\/tx\//)
  assert.match(rec.steps.find((x) => x.step === 'listed').url, /^https:\/\/basescan\.org\/tx\/0xdeposit/)
  assert.deepEqual([rec.who, rec.status, rec.done], ['@BobNewName', 'Paid', true])
  const all = await (await fetch(`${BASE}/api/proof?a=1`)).json()
  assert.ok(all.records.some((x) => x.id === rec.id) && all.total >= 1)
  pay = await (await fetch(`${BASE}/api/payouts?a=2`)).json()
  assert.ok(pay.totals.paidUsd > 0 && pay.totals.listedUsd === 0 && pay.totals.people === 1, JSON.stringify(pay.totals))
  assert.match(pay.wallet, /^0x[0-9a-fA-F]{40}$/)
  const stats = await (await fetch(`${BASE}/api/stats?a=3`)).json()
  assert.equal(stats.xmoney.paidUsd, pay.totals.paidUsd)
  assert.equal(stats.launches, 2)
})

test('a split: the launcher can never be a recipient; a token for @bob 70% and @carol 30% credits each to the lamport, carol withdraws exactly her part and bob\'s is untouched', async () => {
  // a launch names who it funds (a wallet launcher has no X account of its own to refuse: operator 14 Nov)
  const none = await post('/api/launch', { symbol: 'MINE' })
  assert.equal(none.status, 400); assert.match(none.body.error, /Name the X account/)
  assert.equal((await (await api('/api/launch/check?for=dave')).json()).for.ok, true)
  // a bad split is refused on the form; an unknown account in a split refuses the whole launch and sets nobody up
  let bad = await post('/api/launch', { symbol: 'SPLT', recipients: [{ handle: 'bob', pct: 97 }, { handle: 'carol', pct: 3 }] })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /at least 5%/)
  bad = await post('/api/launch', { symbol: 'SPLT', recipients: [{ handle: 'carol', pct: 50 }, { handle: 'nobodyhere', pct: 50 }] })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /not found on X/)
  assert.equal(db.prepare('SELECT 1 FROM users WHERE x_id = ?').get(CAROL), undefined, 'carol was not stored by a launch that was refused')
  assert.equal(db.prepare("SELECT count(*) n FROM mentions WHERE symbol IN ('MINE', 'SPLT')").get().n, 0)
  const o = await (await api('/api/launch/options')).json()
  assert.deepEqual([o.maxRecipients, o.minSharePct], [5, 5])

  addVanity()
  const bobBefore = owedTo(db, BOB).total
  const sub = await post('/api/launch', { symbol: 'SPLT', name: 'Split It', website: 'split.example', twitter: '@split', recipients: [{ handle: 'bob', pct: 70 }, { handle: '@carol', pct: 30 }] })
  assert.equal(sub.status, 200, JSON.stringify(sub.body))
  const out = await app.bot.tick({ doPoll: false })
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'SPLT'").get()
  assert.deepEqual([t.creator_id, t.launched_by_id, t.mode], [BOB, DW, 'creator'])
  assert.deepEqual(db.prepare('SELECT slot, kind, recipient_id, handle, bps FROM token_shares WHERE mint = ? ORDER BY slot').all(t.mint).map((r) => ({ ...r })),
    [{ slot: 0, kind: 'x', recipient_id: BOB, handle: 'Bob', bps: 7000 }, { slot: 1, kind: 'x', recipient_id: CAROL, handle: 'carol', bps: 3000 }])
  assert.equal(pins.at(-1).description, `$SPLT was launched on Pump Fund. Its creator rewards are split between @Bob (70%), @carol (30%): 127.0.0.1:${PORT}`)
  const carol = db.prepare('SELECT * FROM users WHERE x_id = ?').get(CAROL)
  assert.deepEqual([carol.payout_kind, carol.payout_auto], ['xmoney', 1], 'X Money set up for every recipient')
  // the earlier single-recipient token has exactly one share row, at 100%
  assert.deepEqual(db.prepare('SELECT recipient_id, bps FROM token_shares WHERE mint = ?').all(mint.toBase58()).map((r) => ({ ...r })), [{ recipient_id: BOB, bps: 10000 }])

  const m = new PublicKey(t.mint), f = feeWallet(Buffer.from(SEED, 'hex'), m).publicKey
  await buy(traders[2], m, f, 2); await buy(traders[0], m, f, 1.3)
  await quietKeeper()
  const total = await conn.getBalance(f) - RENT_FLOOR
  assert.ok(total > 1_000_000, `collected ${total}`)
  const carolPart = Math.floor(total * 3000 / 10000), bobPart = total - carolPart
  assert.equal(buckets(db, t.mint).creator, total)
  assert.deepEqual([owedTo(db, BOB).total - bobBefore, owedTo(db, CAROL).total, owedTo(db, DAVE).total], [bobPart, carolPart, 0], 'each account is owed its share to the lamport; the launcher nothing')
  console.log(`split of ${total / 1e9} SOL: @bob ${bobPart / 1e9}, @carol ${carolPart / 1e9}`)
  // the public pages show the split with each account's own figures
  const view = await (await api(`/api/token/${t.mint}`)).json()
  assert.deepEqual(view.token.shares.map((s) => [s.handle, s.pct, Math.round(s.owed * 1e9)]), [['Bob', 70, bobPart], ['carol', 30, carolPart]])
  const cpage = await (await fetch(`${BASE}/api/creator/carol`)).json()
  assert.equal(cpage.tokens.length, 1)
  assert.equal(Math.round(cpage.earnedSol * 1e9), carolPart, 'her page counts her share, not the whole token')

  // carol signs in, sees her part only, chooses a wallet (clearing the automatic X Money) and withdraws exactly it
  await signInAs('carol')
  const me = await (await api('/api/me')).json()
  assert.equal(me.user.id, CAROL)
  assert.equal(Math.round(me.owedSol * 1e9), carolPart)
  assert.equal(me.settings.payoutKind, 'xmoney')
  let r = await post('/api/settings', { payoutKind: 'wallet', payoutWallet: bondingCurveAddress(m).toBase58() })
  assert.equal(r.status, 400, 'a program address is refused')
  r = await post('/api/settings', { payoutKind: 'wallet', payoutWallet: payee.publicKey.toBase58(), autoMinSol: 0.5 })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const after = db.prepare('SELECT * FROM users WHERE x_id = ?').get(CAROL)
  assert.deepEqual([after.payout_kind, after.payout_auto, after.payout_confirmed], ['wallet', 0, 1])
  // a later launch for her does not switch her back to X Money
  await app.site.resolveFor(db.prepare('SELECT * FROM users WHERE x_id = ?').get(DAVE), 'carol', { write: true })
  assert.equal(db.prepare('SELECT payout_kind FROM users WHERE x_id = ?').get(CAROL).payout_kind, 'wallet')
  // cross-site and signed-out withdrawals are refused
  assert.equal((await fetch(`${BASE}/api/withdraw`, { method: 'POST', headers: { origin: BASE }, body: '{}' })).status, 401)
  assert.equal((await fetch(`${BASE}/api/withdraw`, { method: 'POST', headers: { origin: 'https://evil.example', cookie }, body: '{}' })).status, 403)
  r = await post('/api/withdraw', { destination: payee.publicKey.toBase58() })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(await conn.getBalance(payee.publicKey), carolPart, 'she received her 30%, not a lamport of bob\'s')
  assert.equal(owedTo(db, CAROL).total, 0)
  assert.equal(owedTo(db, BOB).total - bobBefore, bobPart, 'bob\'s 70% is still his')
  assert.equal(await conn.getBalance(f), RENT_FLOOR + bobPart, 'the reward wallet holds its floor and bob\'s part')
  assert.equal((await post('/api/withdraw', { destination: payee.publicKey.toBase58() })).status, 409, 'nothing left for her: refused, not sent')
  // more trades: the next credit is split again, on top of what is already owed
  await buy(traders[1], m, f, 1)
  await quietKeeper()
  const more = await conn.getBalance(f) - RENT_FLOOR - bobPart
  assert.equal(owedTo(db, CAROL).total, Math.floor(more * 3000 / 10000))
  assert.equal(owedTo(db, BOB).total - bobBefore, bobPart + more - Math.floor(more * 3000 / 10000))
  // the removed holders switch stays removed
  assert.equal((await post(`/api/token/${t.mint}/mode`, { mode: 'holders' })).status, 404)
  await signInAs('dave')
})

test('GitHub + charity + X on one coin: Pumpfun\'s own fee sharing is locked at launch, pays the GitHub account and the charity itself, and our ledger divides the X accounts\' part', async () => {
  // the form: the picker searches the directory; a GitHub name is resolved to its numeric id; bad ones are refused
  const found = await (await fetch(`${BASE}/api/charities?q=st+jude+children`)).json()
  assert.ok(found.charities.some((c) => c.id === JUDE && c.name === "St. Jude Children's Research Hospital"))
  assert.deepEqual((await (await api('/api/launch/check?github=Octocat')).json()).github, { ok: true, id: '583231', handle: 'octocat', name: 'The Octocat', avatar: 'https://avatars.githubusercontent.com/u/583231' })
  assert.equal((await (await api('/api/launch/check?github=ghost-nobody')).json()).github.ok, false)
  const mix = [{ handle: 'bob', pct: 40 }, { kind: 'github', handle: 'octocat', pct: 30 }, { handle: 'carol', pct: 10 }, { kind: 'charity', handle: JUDE, pct: 20 }]
  let bad = await post('/api/launch', { symbol: 'MIX', recipients: [{ kind: 'github', handle: 'ghost-nobody', pct: 100 }] })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /not found on GitHub/)
  bad = await post('/api/launch', { symbol: 'MIX', recipients: [{ kind: 'charity', handle: '0x' + '11'.repeat(32), pct: 100 }] })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /from the list/)
  github.down = true
  bad = await post('/api/launch', { symbol: 'MIX', recipients: [{ kind: 'github', handle: 'torvalds', pct: 100 }] })
  assert.equal(bad.status, 503); assert.match(bad.body.error, /could not be looked up on GitHub/)
  github.down = false
  bad = await post('/api/launch', { symbol: 'MIX', recipients: mix, devBuy: { wallet: buyer.publicKey.toBase58(), sol: '1' } })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /GitHub account or a charity/)
  assert.equal(db.prepare("SELECT count(*) n FROM mentions WHERE symbol = 'MIX'").get().n, 0)

  addVanity()
  const launcherBefore = await conn.getBalance(launcher.publicKey)
  const sub = await post('/api/launch', { symbol: 'MIX', name: 'Mixed Good', recipients: mix })
  assert.equal(sub.status, 200, JSON.stringify(sub.body))
  const out = await app.bot.tick({ doPoll: false })
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'MIX'").get()
  const m = new PublicKey(t.mint), f = feeWallet(Buffer.from(SEED, 'hex'), m).publicKey
  // our books: the four recipients as asked, the first X account as the coin's anchor (never a GitHub or charity id)
  assert.deepEqual(db.prepare('SELECT kind, recipient_id, handle, bps FROM token_shares WHERE mint = ? ORDER BY slot').all(t.mint).map((r) => ({ ...r })), [
    { kind: 'x', recipient_id: BOB, handle: 'Bob', bps: 4000 }, { kind: 'github', recipient_id: '583231', handle: 'octocat', bps: 3000 },
    { kind: 'x', recipient_id: CAROL, handle: 'carol', bps: 1000 }, { kind: 'charity', recipient_id: JUDE, handle: "St. Jude Children's Research Hospital", bps: 2000 }])
  assert.deepEqual([t.creator_id, t.launched_by_id, t.share_config, t.fee_wallet], [BOB, DW, sharingConfigAddress(m).toBase58(), f.toBase58()])
  // the chain: the curve's creator is the sharing config, LOCKED with exactly reward wallet 50% / GitHub 30% / charity 20%
  assert.ok(curveCreator((await conn.getAccountInfo(bondingCurveAddress(m))).data).equals(sharingConfigAddress(m)))
  const cfg = await readSharingConfig(conn, m)
  assert.equal(cfg.locked, true)
  const social = socialFeeAddress('583231'), donation = donationFeeAddress(m, JUDE)
  assert.deepEqual(cfg.shareholders, [{ address: f.toBase58(), bps: 5000 }, { address: social.toBase58(), bps: 3000 }, { address: donation.toBase58(), bps: 2000 }])
  const owners = (await conn.getMultipleAccountsInfo([social, donation])).map((a) => a?.owner.toBase58())
  assert.deepEqual(owners, ['pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'], 'the GitHub account and the charity account are open')
  assert.equal(await conn.getBalance(f), RENT_FLOOR)
  console.log(`a GitHub + charity + X launch cost the launch wallet ${(launcherBefore - await conn.getBalance(launcher.publicKey)) / 1e9} SOL`)
  assert.match(pins.at(-1).description, /split between @Bob \(40%\), octocat on GitHub \(30%\), @carol \(10%\), St\. Jude Children's Research Hospital \(20%\)/)

  // trades, then the keeper: Pumpfun pays each shareholder, our ledger divides the reward wallet's half 4:1
  const before = { bob: owedTo(db, BOB).total, carol: owedTo(db, CAROL).total, social: await conn.getBalance(social), donation: await conn.getBalance(donation) }
  await buy(traders[0], m, sharingConfigAddress(m), 6); await buy(traders[1], m, sharingConfigAddress(m), 4)
  await quietKeeper()
  const x = await conn.getBalance(f) - RENT_FLOOR, gh = await conn.getBalance(social) - before.social, ch = await conn.getBalance(donation) - before.donation
  assert.ok(x > 5_000_000, `the reward wallet received ${x}`)
  const total = x + gh + ch
  assert.ok(Math.abs(gh - total * 0.3) <= 2 && Math.abs(ch - total * 0.2) <= 2 && Math.abs(x - total * 0.5) <= 2, `50/30/20 of ${total}: ${x} / ${gh} / ${ch}`)
  const carolPart = Math.floor(x * 1000 / 5000)
  assert.deepEqual([owedTo(db, BOB).total - before.bob, owedTo(db, CAROL).total - before.carol], [x - carolPart, carolPart], 'bob 40 : carol 10 of what reached the reward wallet')
  assert.equal(owedTo(db, '583231').total, 0, 'the GitHub id is not an X account in our books')
  console.log(`native split of ${total / 1e9} SOL: reward wallet ${x / 1e9} (bob ${(x - carolPart) / 1e9}, carol ${carolPart / 1e9}), GitHub ${gh / 1e9}, charity ${ch / 1e9}`)
  // the charity's part: under the keeper's 0.01 SOL minimum it waits in the charity's own account; above it, the keeper
  // forwards it through the donation relay and Pumpfun's account records the donation
  const rent = await conn.getMinimumBalanceForRentExemption((await conn.getAccountInfo(donation)).data.length)
  assert.equal(await conn.getBalance(donation) - rent, ch, 'under the minimum: not forwarded yet')
  const fwd = await forwardDonations(conn, keeper, { ...t, shareholders: shareholdersOf(db, t) }, { ...keeperConfig({}), donationMin: 1_000_000 }, { info() {}, error: console.error })
  assert.equal(fwd.length, 1, JSON.stringify(fwd))
  assert.equal(fwd[0].lamports, ch)
  const dAcc = feesProgram(conn).coder.accounts.decode('donationFeePda', (await conn.getAccountInfo(donation)).data)
  assert.equal(Number(dAcc.totalDonated), ch, 'Pumpfun recorded the donation')
  assert.equal(await conn.getBalance(donation), rent, 'the charity account is back to its rent')
  console.log(`charity share forwarded through the donation relay: ${ch / 1e9} SOL`)
  // the public page: every recipient with its kind, and what Pumpfun paid the other two derived from the X part
  const view = await (await api(`/api/token/${t.mint}`)).json()
  assert.deepEqual(view.token.shares.map((s) => [s.kind, s.handle, s.pct]), [['x', 'Bob', 40], ['github', 'octocat', 30], ['x', 'carol', 10], ['charity', "St. Jude Children's Research Hospital", 20]])
  assert.ok(Math.abs(view.token.shares[1].earned * 1e9 - gh) <= 2 && Math.abs(view.token.shares[3].earned * 1e9 - ch) <= 2, JSON.stringify(view.token.shares))
  assert.ok(Math.abs(view.token.creatorEarned * 1e9 - total) <= 3)
  assert.equal(view.token.shareConfig, sharingConfigAddress(m).toBase58())
  // carol (signed in earlier, pays to a wallet) can withdraw her part of it like any other
  assert.equal((await (await fetch(`${BASE}/api/creator/carol`)).json()).tokens.length, 2)
})

test('rewards earned between a launch and its lock are forwarded to the recipients, not kept; a crash anywhere is picked up from the chain', async () => {
  // the two steps by hand, with trades in between (the queue runs them back to back)
  const L = Keypair.generate(), mintKp = Keypair.generate(), m = mintKp.publicKey, f = Keypair.generate().publicKey
  await fund(L.publicKey, 3)
  const shares = [{ kind: 'x', id: BOB, bps: 5000 }, { kind: 'github', id: '9919', bps: 2500 }, { kind: 'charity', id: JUDE, bps: 1500 }, { kind: 'charity', id: '0xb02173170bada3eb8162396b27744f9c5ac99bed3a632b1c4d2bc9b1b366b0e8', bps: 1000 }]
  const b = await buildLaunchTx({ conn, pump, launcher: L, mintKp, feeWalletPk: f, name: 'W'.repeat(32), symbol: 'ABCDEFGHIJ', uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`, native: { prefund: true } })
  console.log(`worst-case launch of a natively split coin: ${b.raw.length} bytes`)
  assert.equal((await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })).fate, 'landed')
  let cfg = await readSharingConfig(conn, m)
  assert.deepEqual([cfg.locked, cfg.shareholders], [false, [{ address: L.publicKey.toBase58(), bps: 10000 }]], 'fee sharing is on from the first block, not yet locked')
  await buy(traders[2], m, sharingConfigAddress(m), 5) // someone trades before the lock lands
  const want = nativeShareholders(m, f, shares)
  const balances = async () => Promise.all(want.map((h) => conn.getBalance(h.address)))
  const before = await balances(), launcherBefore = await conn.getBalance(L.publicKey)
  // a crash right after the lock was sent: the saved state is all the next call has
  let state = {}, saves = 0
  const save = (st) => { state = st; saves++ }
  let r = await settleNativeSplit({ conn, launcher: L, mint: m, feeWalletPk: f, shares, state, save, log: { info() {}, error: console.error } })
  assert.equal(r.done, true, JSON.stringify(r))
  cfg = await readSharingConfig(conn, m)
  assert.equal(cfg.locked, true)
  assert.deepEqual(cfg.shareholders.map((s) => s.bps), [5000, 2500, 1500, 1000])
  const got = (await balances()).map((v, i) => v - before[i])
  // the three accounts opened here each also received their rent (paid by the launch wallet): compare against their share only
  const rents = await Promise.all(want.map(async (h, i) => (i === 0 ? 0 : (await conn.getMinimumBalanceForRentExemption((await conn.getAccountInfo(h.address)).data.length)))))
  const fwd = got.map((g, i) => g - rents[i])
  assert.ok(state.interim > 10_000_000, `interim ${state.interim}`)
  assert.equal(fwd.reduce((a, c) => a + c, 0), state.interim, 'every lamport Pumpfun paid the launch wallet at the lock went on')
  assert.deepEqual(fwd.slice(1), [Math.floor(state.interim * 0.25), Math.floor(state.interim * 0.15), Math.floor(state.interim * 0.10)])
  const spent = launcherBefore - await conn.getBalance(L.publicKey)
  assert.ok(spent > 0 && spent < 0.012e9, `the launch wallet kept none of it: it is down ${spent / 1e9} SOL (rents and fees)`)
  console.log(`rewards before the lock: ${state.interim / 1e9} SOL forwarded ${fwd.map((v) => v / 1e9).join(' / ')}; locking cost ${spent / 1e9} SOL`)
  // again, from the saved state and from nothing: nothing is sent twice, nothing changes
  const settled = await balances()
  for (const st of [state, {}]) {
    r = await settleNativeSplit({ conn, launcher: L, mint: m, feeWalletPk: f, shares, state: st, save: () => {}, log: { info() {}, error: console.error } })
    assert.equal(r.done, true)
    assert.deepEqual(await balances(), settled, 'a repeat forwards nothing')
  }
  // a lock that does not match what was asked is never reported as done
  r = await settleNativeSplit({ conn, launcher: L, mint: m, feeWalletPk: f, shares: [{ kind: 'x', id: BOB, bps: 6000 }, { kind: 'github', id: '9919', bps: 4000 }], state: {}, save: () => {}, log: { info() {}, error() {} } })
  assert.match(r.failed, /other shareholders/)
  void creatorVaultAddress
})

test('review 15 Nov: chores left after the lock never hold up the queue (the coin is listed, the chores are finished on the side); a lock that cannot be made in time is given up', async () => {
  GH.set('newdev', { id: '424242', login: 'newdev', name: 'New Dev', avatar: '' })
  addVanity()
  const sub = await post('/api/launch', { symbol: 'CHORE', name: 'Chores', recipients: [{ handle: 'bob', pct: 60 }, { kind: 'github', handle: 'newdev', pct: 40 }] })
  assert.equal(sub.status, 200, JSON.stringify(sub.body))
  // the chain refuses everything after the launch and the lock (the third send = opening the GitHub account)
  const real = conn.sendRawTransaction.bind(conn)
  let sends = 0
  conn.sendRawTransaction = async (...a) => { if (++sends > 2) throw new Error('Transaction simulation failed: test outage'); return real(...a) }
  let out
  try { out = await app.bot.tick({ doPoll: false }) } finally { conn.sendRawTransaction = real }
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'CHORE'").get(), m = new PublicKey(t.mint)
  assert.equal(t.share_config, sharingConfigAddress(m).toBase58(), 'listed as soon as its shares are locked')
  assert.equal((await readSharingConfig(conn, m)).locked, true)
  const social = socialFeeAddress('424242')
  assert.equal(await conn.getAccountInfo(social), null, 'the GitHub account could not be opened yet')
  const native = () => JSON.parse(db.prepare('SELECT payload FROM mentions WHERE mint = ?').get(t.mint).payload).native
  assert.equal(native().pending, true)
  assert.equal(db.prepare("SELECT count(*) n FROM mentions WHERE state = 'launching'").get().n, 0, 'nothing is left unresolved: the next launch is not held up')
  assert.deepEqual((await app.bot.processQueue()), { idle: 'queue empty' })
  // the chores are repeated on the side once their pause is over, and finish
  db.prepare('UPDATE mentions SET next_try_at = 0 WHERE mint = ?').run(t.mint)
  await app.bot.tick({ doPoll: false })
  assert.equal(native().pending, false)
  assert.equal((await conn.getAccountInfo(social))?.owner.toBase58(), 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', 'the GitHub account is open')

  // a lock that could not be made for 15 minutes is given up, so the queue moves on (the coin then needs the operator)
  const L = Keypair.generate(), mintKp = Keypair.generate(), f = Keypair.generate().publicKey
  await fund(L.publicKey, 1)
  const b = await buildLaunchTx({ conn, pump, launcher: L, mintKp, feeWalletPk: f, name: 'Late', symbol: 'LATE', uri: 'https://gateway.pinata.cloud/ipfs/bafkreilate', native: { prefund: true } })
  assert.equal((await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })).fate, 'landed')
  const r = await settleNativeSplit({ conn, launcher: L, mint: mintKp.publicKey, feeWalletPk: f, shares: [{ kind: 'x', id: BOB, bps: 5000 }, { kind: 'github', id: '9919', bps: 5000 }], state: { startedAt: Date.now() - 16 * 60_000 }, save: () => {}, log: { info() {}, error() {} } })
  assert.match(r.failed, /in time/)
  assert.equal((await readSharingConfig(conn, mintKp.publicKey)).locked, false, 'nothing was locked')
})

test('a dev buy on a coin for @bob: the buyer\'s wallet signs only its own buy, the launch wallet pays the creation, the worst-case sizes fit, a swapped or foreign signature is refused', async () => {
  const noLut = await post('/api/launch', { symbol: 'DEVA', for: 'bob', devBuy: { wallet: buyer.publicKey.toBase58(), sol: '1' } })
  assert.equal(noLut.status, 503)
  assert.match(noLut.body.error, /Dev buys are switched off/)
  const table = await createLaunchTable(conn, launcher, await staticLaunchAccounts(pump, await loadGlobal(conn)))
  kvSet(db, 'launch_lut', table.toBase58())
  const lut = await app.site.launchLut()
  assert.ok(lut)

  // worst case: 32-byte name, 10-letter ticker, the longest metadata link, the rent-floor transfer
  addVanity()
  const before = { launcher: await conn.getBalance(launcher.publicKey), buyer: await conn.getBalance(buyer.publicKey) }
  const prep = await post('/api/launch', { symbol: 'ABCDEFGHIZ', name: 'W'.repeat(32), for: 'bob', image: PNG.toString('base64'), devBuy: { wallet: buyer.publicKey.toBase58(), sol: '1.5' } })
  assert.equal(prep.status, 200, JSON.stringify(prep.body))
  assert.equal(prep.body.state, 'signing')
  const unsigned = Buffer.from(prep.body.transaction, 'base64')
  assert.ok(unsigned.length <= 1232, `${unsigned.length} bytes`)
  console.log(`worst-case launch with a dev buy: ${unsigned.length} bytes`)
  const tx = VersionedTransaction.deserialize(unsigned)
  assert.ok(tx.message.staticAccountKeys[0].equals(launcher.publicKey), 'the launch wallet is the fee payer')
  assert.ok(tx.signatures.every((s) => s.every((b) => b === 0)), 'nothing of ours is signed until the wallet has signed')

  // ⛔ a wallet (or a page) that swaps the message: adds a transfer out of the launch wallet. Refused, nothing sent.
  const ixs = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [lut] }).instructions
  const evil = new VersionedTransaction(new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: tx.message.recentBlockhash,
    instructions: [...ixs, SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: buyer.publicKey, lamports: 5e9 })] }).compileToV0Message([lut]))
  evil.sign([buyer])
  const swapped = await post('/api/launch/sign', { id: prep.body.id, transaction: Buffer.from(evil.serialize()).toString('base64') })
  assert.equal(swapped.status, 400)
  assert.match(swapped.body.error, /changed the transaction/)
  // signed by some other wallet: 64 bytes that are not the buyer's signature over this message
  const stranger = VersionedTransaction.deserialize(unsigned)
  stranger.signatures[tx.message.staticAccountKeys.findIndex((k) => k.equals(buyer.publicKey))] = new Uint8Array(64).fill(7)
  const wrong = await post('/api/launch/sign', { id: prep.body.id, transaction: Buffer.from(stranger.serialize()).toString('base64') })
  assert.equal(wrong.status, 400)
  assert.match(wrong.body.error, /not signed by the connected wallet/)
  assert.equal(db.prepare('SELECT count(*) n FROM mentions WHERE tweet_id = ?').get(prep.body.id).n, 0, 'no launch row for a refused signature')

  // the real one: the wallet signs and hands it back
  tx.sign([buyer])
  const sent = await post('/api/launch/sign', { id: prep.body.id, transaction: Buffer.from(tx.serialize()).toString('base64') })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  const st = await settled(prep.body.id)
  assert.equal(st.state, 'launched', JSON.stringify(st))
  assert.equal(st.mint, prep.body.mint)
  const mintPk = new PublicKey(st.mint)
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(st.mint)
  assert.deepEqual([t.symbol, t.name, t.creator_id, t.launched_by_id, t.mode, t.launch_sig], ['ABCDEFGHIZ', 'W'.repeat(32), BOB, buyer.publicKey.toBase58(), 'creator', sent.body.signature])
  assert.match(pins.at(-1).description, /launched for @Bob on Pump Fund/)
  const f = feeWallet(Buffer.from(SEED, 'hex'), mintPk).publicKey
  assert.ok(curveCreator((await conn.getAccountInfo(bondingCurveAddress(mintPk))).data).equals(f))
  const held = await tokensOf(buyer.publicKey, st.mint)
  assert.ok(held > 49_000_000_000_000n && held < 52_000_000_000_000n, `1.5 SOL bought ${Number(held) / 1e6} tokens`)
  const paid = { launcher: before.launcher - await conn.getBalance(launcher.publicKey), buyer: before.buyer - await conn.getBalance(buyer.publicKey) }
  assert.ok(Math.abs(paid.launcher) < 0.01e9, `launch wallet net ${paid.launcher / 1e9} SOL: the launcher's payment covered the creation`)
  assert.ok(paid.buyer >= 1.51e9 && paid.buyer < 1.51e9 + 6_000_000, `buyer paid ${paid.buyer / 1e9} SOL: the buy, its own accounts and the 0.01 SOL launch payment`)
  console.log(`launch with a 1.5 SOL dev buy: launch wallet paid ${paid.launcher / 1e9} SOL, buyer paid ${paid.buyer / 1e9} SOL for ${Number(held) / 1e6} tokens`)
  // the same signed transaction again: the draft was used
  assert.equal((await post('/api/launch/sign', { id: prep.body.id, transaction: Buffer.from(tx.serialize()).toString('base64') })).status, 409)
  // the dev buy paid creator rewards into the coin's wallet: they are bob's
  await quietKeeper()
  assert.ok(buckets(db, st.mint).creator > 0)
  assert.equal(db.prepare('SELECT bps FROM token_shares WHERE mint = ?').get(st.mint).bps, 10000)

  // a wallet that cannot afford it, and a draft the wallet never signed in time
  const broke = await post('/api/launch', { symbol: 'DEVQ', for: 'bob', devBuy: { wallet: Keypair.generate().publicKey.toBase58(), sol: '2' } })
  assert.equal(broke.status, 400)
  assert.match(broke.body.error, /holds 0\.0000 SOL/)
  addVanity()
  const late = await post('/api/launch', { symbol: 'DEVL', for: 'bob', devBuy: { wallet: buyer.publicKey.toBase58(), sol: '0.1' } })
  assert.equal(late.status, 200, JSON.stringify(late.body))
  db.prepare('UPDATE site_drafts SET expires_at = ? WHERE id = ?').run(now() - 1, late.body.id)
  const ltx = VersionedTransaction.deserialize(Buffer.from(late.body.transaction, 'base64')); ltx.sign([buyer])
  assert.equal((await post('/api/launch/sign', { id: late.body.id, transaction: Buffer.from(ltx.serialize()).toString('base64') })).status, 409)
  assert.equal(db.prepare("SELECT 1 FROM tokens WHERE symbol = 'DEVL'").get(), undefined)
})

test('payment apps as recipients: @bob 50%, Venmo 30%, Zelle 20% is paid by our own ledger (no Pumpfun fee sharing); each app account is paid in its own app via Peer; a Zelle payee is never shown in full; an app nobody pays backs off', async () => {
  let bad = await post('/api/launch', { symbol: 'APPS', recipients: [{ handle: 'bob', pct: 50 }, { kind: 'venmo', handle: 'ab', pct: 50 }] })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /valid Venmo username/)
  bad = await post('/api/launch', { symbol: 'APPS', recipients: [{ kind: 'zelle', handle: '555-0100', pct: 100 }] })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /valid Zelle email or US phone/)
  addVanity()
  const sub = await post('/api/launch', { symbol: 'APPS', name: 'App Paid', recipients: [{ handle: 'bob', pct: 50 }, { kind: 'venmo', handle: '@Jane-Doe', pct: 30 }, { kind: 'zelle', handle: ' Jane.Doe@Example.com ', pct: 20 }] })
  assert.equal(sub.status, 200, JSON.stringify(sub.body))
  const out = await app.bot.tick({ doPoll: false })
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'APPS'").get()
  const m = new PublicKey(t.mint), f = feeWallet(Buffer.from(SEED, 'hex'), m).publicKey
  assert.deepEqual(db.prepare('SELECT kind, recipient_id, handle, bps FROM token_shares WHERE mint = ? ORDER BY slot').all(t.mint).map((r) => ({ ...r })), [
    { kind: 'x', recipient_id: BOB, handle: 'Bob', bps: 5000 }, { kind: 'venmo', recipient_id: 'venmo:jane-doe', handle: 'Jane-Doe', bps: 3000 },
    { kind: 'zelle', recipient_id: 'zelle:jane.doe@example.com', handle: 'jane.doe@example.com', bps: 2000 }])
  // ours alone: the curve's creator is the coin's reward wallet, no sharing config
  assert.equal(t.share_config, null)
  assert.ok(curveCreator((await conn.getAccountInfo(bondingCurveAddress(m))).data).equals(f))
  assert.match(pins.at(-1).description, /split between @Bob \(50%\), Venmo @Jane-Doe \(30%\), Zelle j•••@example\.com \(20%\)/)
  assert.doesNotMatch(pins.at(-1).description, /jane\.doe@/i, 'the Zelle email is not in the token metadata')

  await buy(traders[1], m, f, 2); await buy(traders[2], m, f, 1.5)
  await quietKeeper()
  const total = await conn.getBalance(f) - RENT_FLOOR
  assert.equal(buckets(db, t.mint).creator, total)
  const venmo = Math.floor(total * 3000 / 10000), zelle = Math.floor(total * 2000 / 10000)
  assert.deepEqual([shareOf(db, t.mint, 'venmo:jane-doe').owed, shareOf(db, t.mint, 'zelle:jane.doe@example.com').owed, shareOf(db, t.mint, BOB).owed], [venmo, zelle, total - venmo - zelle])
  const pageText = await (await api(`/api/token/${t.mint}`)).text()
  assert.doesNotMatch(pageText, /jane\.doe@/i, 'the token page never carries the Zelle payee')
  const view = JSON.parse(pageText)
  assert.deepEqual(view.token.shares.map((s) => [s.kind, s.handle, s.pct, Math.round(s.owed * 1e9)]),
    [['x', 'Bob', 50, total - venmo - zelle], ['venmo', 'Venmo @Jane-Doe', 30, venmo], ['zelle', 'Zelle j•••@example.com', 20, zelle]])

  const rails = fakeRails()
  rails.handleOf = async (id) => (id === BOB ? 'BobNewName' : null)
  await fund(rails.depository.publicKey, 1)
  // test trades earn cents: bring even a small unfilled amount home (the real floor is $0.50)
  const cfg = { ...xmoneyConfig({ XMONEY_ENABLED: '1' }), minLamports: 1_000_000, adoptSeconds: 0, dustUsdc: 1 }
  const pass = () => xmoneyPass({ db, conn, keeper, seed: Buffer.from(SEED, 'hex'), rails, cfg, solUsd: 150, log: { info() {}, error: console.error } })
  const row = (key) => db.prepare('SELECT * FROM xmoney_payouts WHERE x_id = ? ORDER BY id DESC LIMIT 1').get(key)
  for (let i = 0; i < 6 && (row('venmo:jane-doe')?.state !== 'listed' || row('zelle:jane.doe@example.com')?.state !== 'listed'); i++) await pass()
  const v = row('venmo:jane-doe'), z = row('zelle:jane.doe@example.com')
  assert.deepEqual([v.state, v.platform, v.lamports], ['listed', 'venmo', venmo], JSON.stringify(v))
  assert.deepEqual([z.state, z.platform, z.lamports], ['listed', 'zelle', zelle], JSON.stringify(z))
  assert.deepEqual([rails.st.deposits.get(v.deposit_id).platform, rails.st.deposits.get(v.deposit_id).payee], ['venmo', 'Jane-Doe'], 'paid in Venmo to the username as it was typed')
  assert.deepEqual([rails.st.deposits.get(z.deposit_id).platform, rails.st.deposits.get(z.deposit_id).payee], ['zelle', 'jane.doe@example.com'])
  assert.equal(shareOf(db, t.mint, 'venmo:jane-doe').owed, 0)
  // the collect outflows say which app, never who
  const labels = db.prepare("SELECT DISTINCT destination FROM outflows WHERE mint = ? AND kind = 'payout' AND x_id LIKE '%:%'").all(t.mint).map((r) => r.destination).sort()
  assert.deepEqual(labels, ['peer:venmo', 'peer:zelle'])

  // a buyer pays the Venmo account in full
  rails.fill(v.deposit_id, BigInt(v.usdc))
  await pass()
  assert.equal(row('venmo:jane-doe').state, 'done')
  const payText = await (await fetch(`${BASE}/api/payouts?apps=1`)).text()
  assert.doesNotMatch(payText, /jane\.doe@/i, 'the public payout list never carries the Zelle payee')
  const pay = JSON.parse(payText)
  const vp = pay.payouts.find((p) => p.id === v.id), zp = pay.payouts.find((p) => p.id === z.id)
  assert.deepEqual([vp.platform, vp.handle, vp.status], ['venmo', 'Venmo @Jane-Doe', 'Paid to Venmo @Jane-Doe'])
  assert.deepEqual([zp.platform, zp.handle], ['zelle', 'Zelle j•••@example.com'])
  // a token page lists only payments that took ITS rewards, each counting only its own collect transfers
  const tp = await (await api(`/api/token/${t.mint}?proof=1`)).json()
  for (const r of tp.proof) for (const st of r.steps.filter((x) => x.step === 'collect')) assert.equal(st.label, 'Collected from $APPS', JSON.stringify(st))
  assert.ok(tp.proof.some((r) => r.platform === 'venmo') && tp.proof.some((r) => r.platform === 'zelle'))
  assert.doesNotMatch(JSON.stringify(tp.proof), /jane\.doe@/i, 'no Zelle payee in the proof either')

  // nobody pays the Zelle account: after XMONEY_MAX_DAYS its USDC comes home and is owed to it again, and it waits
  db.prepare('UPDATE xmoney_payouts SET listed_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - cfg.maxDays * 86400 - 60, z.id)
  for (let i = 0; i < 8 && row('zelle:jane.doe@example.com').state !== 'done'; i++) await pass()
  const zd = row('zelle:jane.doe@example.com')
  assert.equal(zd.id, z.id, 'no new payout started')
  assert.ok(zd.state === 'done' && zd.returned_lamports > 0, JSON.stringify(zd))
  const zrec = (await (await api(`/api/token/${t.mint}?proof=2`)).json()).proof.find((r) => r.id === `peer-${z.id}`)
  assert.deepEqual(zrec.steps.map((x) => x.step), ['collect', 'bridge', 'bridged', 'listed', 'withdrawn', 'bridge-back', 'bridge-back', 'returned', 'credited'], JSON.stringify(zrec.steps.map((x) => x.step)))
  assert.equal(shareOf(db, t.mint, 'zelle:jane.doe@example.com').owed, zd.returned_lamports, 'back in its balance')
  assert.deepEqual(appMayStart(db, 'zelle:jane.doe@example.com', cfg), { ok: false, why: 'waiting after an unfilled payout' })
  await pass()
  assert.equal(row('zelle:jane.doe@example.com').id, z.id, 'the next try waits')
})

test('PayPal: a share waits until its owner connects it with Peer on /paypal/<username>; the email only goes to Peer; then it is paid in PayPal', async () => {
  addVanity()
  const sub = await post('/api/launch', { symbol: 'PAYP', name: 'Pay Pal', recipients: [{ handle: 'bob', pct: 60 }, { kind: 'paypal', handle: 'https://paypal.me/JaneDoe', pct: 40 }] })
  assert.equal(sub.status, 200, JSON.stringify(sub.body))
  assert.equal((await app.bot.tick({ doPoll: false })).queue.outcome, 'launched')
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'PAYP'").get()
  assert.deepEqual({ ...db.prepare("SELECT kind, recipient_id, handle, bps FROM token_shares WHERE mint = ? AND slot = 1").get(t.mint) }, { kind: 'paypal', recipient_id: 'paypal:janedoe', handle: 'janedoe', bps: 4000 })
  const m = new PublicKey(t.mint), f = feeWallet(Buffer.from(SEED, 'hex'), m).publicKey
  await buy(traders[0], m, f, 2)
  await quietKeeper()
  const part = shareOf(db, t.mint, 'paypal:janedoe').owed
  assert.ok(part > 0)

  // the page: not connected; the token page links the owner there
  let acct = await (await api('/api/paypal/janedoe')).json()
  assert.deepEqual([acct.handle, acct.connected, acct.tokens.map((x) => [x.symbol, x.pct]), Math.round(acct.owedSol * 1e9)], ['janedoe', false, [['PAYP', 40]], part])
  assert.equal((await api('/api/paypal/somebodyelse')).status, 404)
  const share = (await (await api(`/api/token/${t.mint}`)).json()).token.shares[1]
  assert.deepEqual([share.kind, share.handle, share.connected, share.connectPath], ['paypal', 'PayPal paypal.me/janedoe', false, '/paypal/janedoe'])

  // nothing is collected or bridged while it is not connected
  const rails = fakeRails()
  await fund(rails.depository.publicKey, 1)
  const cfg = { ...xmoneyConfig({ XMONEY_ENABLED: '1' }), minLamports: 1_000_000, adoptSeconds: 0 }
  const pass = () => xmoneyPass({ db, conn, keeper, seed: Buffer.from(SEED, 'hex'), rails, cfg, solUsd: 150, log: { info() {}, error: console.error } })
  const row = () => db.prepare("SELECT * FROM xmoney_payouts WHERE x_id = 'paypal:janedoe' ORDER BY id DESC LIMIT 1").get()
  await pass()
  assert.equal(row(), undefined, 'no payout for an unconnected PayPal')
  assert.equal(shareOf(db, t.mint, 'paypal:janedoe').owed, part)

  // the owner connects: a bad email is refused, an unknown account cannot be started, the email goes to Peer only
  let r = await post('/api/paypal/connect', { handle: 'janedoe', email: 'nope' })
  assert.equal(r.status, 400)
  r = await post('/api/paypal/connect', { handle: 'somebodyelse', email: 'x@example.com' })
  assert.equal(r.status, 404)
  r = await post('/api/paypal/connect', { handle: 'janedoe', email: 'Jane@Example.com' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.match(r.body.id, /^[A-Za-z0-9_-]{16}$/)
  assert.equal(r.body.requestId, undefined, 'the bearer request id stays on the server')
  assert.deepEqual(sarFake.asked.at(-1), { platform: 'paypal', payeeHandle: 'janedoe', paypalEmail: 'Jane@Example.com', returnUrl: 'https://app.peer.xyz/', currencies: ['USD'] })
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM kv").all()).includes('Jane@Example.com'), false)
  assert.deepEqual(await (await api(`/api/paypal/connect/${r.body.id}`)).json(), { status: 'pending' })
  sarFake.state = 'connected'
  assert.deepEqual(await (await api(`/api/paypal/connect/${r.body.id}`)).json(), { status: 'connected' })
  acct = await (await api('/api/paypal/janedoe')).json()
  assert.equal(acct.connected, true)

  // now it is paid in PayPal, to the username
  for (let i = 0; i < 6 && row()?.state !== 'listed'; i++) await pass()
  assert.deepEqual([row().state, row().platform, row().lamports], ['listed', 'paypal', part], JSON.stringify(row()))
  const dep = rails.st.deposits.get(row().deposit_id)
  assert.deepEqual([dep.platform, dep.payee], ['paypal', 'janedoe'])
})

test('wallet launches: the form asks the connected wallet to pay; a changed payment is refused; a paid launch that fails is refunded to the payer once', async () => {
  addVanity()
  // the payment: our message only, signed by the connected wallet
  const prep = await post('/api/launch', { symbol: 'REFD', recipients: [{ handle: 'bob', pct: 100 }] }, { pay: false })
  assert.equal(prep.status, 200, JSON.stringify(prep.body))
  assert.deepEqual([prep.body.kind, prep.body.wallet, prep.body.feeSol], ['pay', DW, 0.01])
  const tx = VersionedTransaction.deserialize(Buffer.from(prep.body.transaction, 'base64'))
  assert.ok(tx.message.staticAccountKeys[0].equals(daveWallet.publicKey), 'the launcher\'s wallet pays the network fee too')
  const ixs = TransactionMessage.decompile(tx.message).instructions
  const evil = new VersionedTransaction(new TransactionMessage({ payerKey: daveWallet.publicKey, recentBlockhash: tx.message.recentBlockhash,
    instructions: ixs.map((ix) => ix.programId.equals(SystemProgram.programId) ? SystemProgram.transfer({ fromPubkey: daveWallet.publicKey, toPubkey: daveWallet.publicKey, lamports: 1 }) : ix) }).compileToV0Message())
  evil.sign([daveWallet])
  const swapped = await post('/api/launch/sign', { id: prep.body.id, transaction: Buffer.from(evil.serialize()).toString('base64') })
  assert.equal(swapped.status, 400); assert.match(swapped.body.error, /changed the transaction/)
  tx.sign([daveWallet])
  const before = await conn.getBalance(daveWallet.publicKey)
  const paid = await post('/api/launch/sign', { id: prep.body.id, transaction: Buffer.from(tx.serialize()).toString('base64') })
  assert.deepEqual([paid.status, paid.body.state], [200, 'queued'], JSON.stringify(paid.body))
  const afterPay = await conn.getBalance(daveWallet.publicKey)
  assert.ok(before - afterPay >= 0.01e9 && before - afterPay < 0.0102e9, `paid ${(before - afterPay) / 1e9}`)
  // the launch fails for good (here: by hand): refunded to the paying wallet, exactly once
  db.prepare("UPDATE mentions SET state = 'failed' WHERE tweet_id = ?").run(prep.body.id)
  await app.site.refundFailed()
  await app.site.refundFailed()
  assert.equal(await conn.getBalance(daveWallet.publicKey) - afterPay, 0.01e9, 'the 0.01 SOL came back once')
  assert.equal(JSON.parse(db.prepare('SELECT opts FROM mentions WHERE tweet_id = ?').get(prep.body.id).opts).fee.refunded, true)

  // review 15 Nov: a paid launch that is still queued after half an hour (launching closed again, a long hold) is ended
  // and refunded; one whose token WAS created but whose split could not be locked is not refunded automatically
  const paidRow = (id, state, code, seenAgo) => db.prepare(`INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, updated_at, state, code, symbol, name, source, opts)
    VALUES (?, ?, '', 'x', 0, ?, 0, ?, ?, 'ZZ', 'ZZ', 'site', ?)`).run(id, DW, now() - seenAgo, state, code, JSON.stringify({ fee: { payer: DW, lamports: 0.01e9, sig: 'x' } }))
  paidRow('site-aaaaaaaaaaaaaaaaaa', 'queued', null, 1900); paidRow('site-bbbbbbbbbbbbbbbbbb', 'queued', null, 60); paidRow('site-cccccccccccccccccc', 'failed', 'split-failed', 60)
  const b0 = await conn.getBalance(daveWallet.publicKey)
  await app.site.refundFailed(); await app.site.refundFailed()
  assert.equal(await conn.getBalance(daveWallet.publicKey) - b0, 0.01e9, 'only the launch that waited too long was refunded')
  const st = (id) => db.prepare('SELECT state, code FROM mentions WHERE tweet_id = ?').get(id)
  assert.deepEqual([{ ...st('site-aaaaaaaaaaaaaaaaaa') }, st('site-bbbbbbbbbbbbbbbbbb').state], [{ state: 'failed', code: 'timed-out' }, 'queued'])
  assert.equal(JSON.parse(db.prepare("SELECT opts FROM mentions WHERE tweet_id = 'site-cccccccccccccccccc'").get().opts).fee.refunded, undefined)
  assert.match((await (await api('/api/launch/site-aaaaaaaaaaaaaaaaaa')).json()).reason, /waited too long/)
  db.prepare("DELETE FROM mentions WHERE tweet_id IN ('site-aaaaaaaaaaaaaaaaaa', 'site-bbbbbbbbbbbbbbbbbb', 'site-cccccccccccccccccc')").run()
})

test('closing launching again refuses the form at once', async () => {
  kvSet(db, LAUNCHING_CLOSED, 'test')
  const closed = await post('/api/launch', { symbol: 'SITEC', for: 'bob' })
  assert.equal(closed.status, 409)
  assert.match(closed.body.error, /closed/)
  db.prepare('DELETE FROM kv WHERE k = ?').run(LAUNCHING_CLOSED)
})

test('the operator launches $FUND on Pumpfun from their own wallet: it is picked up by itself, listed as the project token, and launching opens; nothing else can open it', async () => {
  const { watchOfficial } = await import('../api/official.mjs')
  const { createV2Ix } = await import('../lib/pump.mjs')
  const db2 = openDb(':memory:'), W = Keypair.generate(), other = Keypair.generate()
  kvSet(db2, LAUNCHING_CLOSED, 'until the project token')
  await fund(W.publicKey, 2); await fund(other.publicKey, 2)
  const quiet = { info() {}, error: console.error }
  const opts = { db: db2, conn, wallet: W.publicKey.toBase58(), env: { PROJECT_TICKER: 'FUND', PROJECT_NAME: 'Pump Fund' }, publicUrl: BASE, logoDir: app.logoDir, log: quiet }
  const create = async (signer, symbol, name, extra = []) => {
    const mintKp = Keypair.generate()
    const b = await buildTx(conn, { payer: signer.publicKey, signers: [signer, mintKp], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      await createV2Ix(pump, { mint: mintKp.publicKey, user: signer.publicKey, name, symbol, uri: 'https://gateway.pinata.cloud/ipfs/bafkreifund', creator: signer.publicKey }), ...extra] })
    assert.equal((await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })).fate, 'landed')
    return mintKp.publicKey.toBase58()
  }
  // a $FUND the wallet created BEFORE the watch started is history: never looked at
  await create(W, 'FUND', 'Old Fund')
  assert.deepEqual(await watchOfficial(opts), { waiting: 'started', checked: 0 })
  assert.equal((await watchOfficial(opts)).checked, 0)
  // someone else creates a $FUND and touches the operator's wallet in the same transaction: not signed by it
  await create(other, 'FUND', 'Pump Fund', [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: W.publicKey, lamports: 1000 })])
  // the operator's wallet creates another coin: not the project ticker
  await create(W, 'OTHER', 'Something Else')
  let r = await watchOfficial(opts)
  assert.deepEqual([r.done, r.checked, launchingOpen(db2), kvGet(db2, 'platform_mint')], [undefined, 2, false, null])
  // the real one
  const fundMint = await create(W, 'fund', 'Pump Fund')
  r = await watchOfficial(opts)
  assert.deepEqual([r.done, r.mint, r.ticker, r.name], [true, fundMint, 'FUND', 'Pump Fund'])
  assert.equal(launchingOpen(db2), true, 'launching opened by itself')
  assert.equal(kvGet(db2, 'platform_mint'), fundMint)
  const t = db2.prepare('SELECT * FROM tokens WHERE mint = ?').get(fundMint)
  assert.deepEqual([t.symbol, t.name, t.platform, t.own_creator, t.fee_wallet, t.metadata_uri], ['FUND', 'Pump Fund', 1, 1, W.publicKey.toBase58(), 'https://gateway.pinata.cloud/ipfs/bafkreifund'])
  assert.match(t.image, /\/api\/logos\/[a-f0-9]{32}\.png$/, 'the heart logo')
  assert.deepEqual({ ...db2.prepare("SELECT state, platform, mint FROM mentions WHERE platform = 1").get() }, { state: 'launched', platform: 1, mint: fundMint }, 'never queued: the queue cannot launch a second one')
  // found once, for good: a later $FUND from the same wallet changes nothing, and no more reads are made
  await create(W, 'FUND', 'Pump Fund')
  assert.deepEqual(await watchOfficial(opts), { done: true, mint: fundMint })
  assert.equal(db2.prepare('SELECT count(*) n FROM tokens').get().n, 1)
})
