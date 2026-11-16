// No chain, no network: parser, replies, guards, money buckets, airdrop plan, and the bot's queue rules.
import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { parseTweet, isLaunchRequest, hasLaunchIntent } from '../api/parse.mjs'
import { launchedReply, rejectedReply, failedReply, tweetLength } from '../api/replies.mjs'
import { checkGuards, guardConfig, rampFor } from '../api/guards.mjs'
import { openDb, buckets, owedTo, kvSet, kvDel, lockCoin, unlockCoin, LAUNCHING_CLOSED, now } from '../api/db.mjs'
import { creditSurplus, planAirdrop } from '../api/keeper.mjs'
import { feeWallet, parseSeed } from '../api/feewallet.mjs'
import { RENT_FLOOR, isAllowedImageHost, describe, chooseImage, tweetLink, SITE_URL } from '../api/launch.mjs'
import { createBot } from '../api/bot.mjs'
import { FixtureX } from '../api/x.mjs'

const H = 'PumpFund'

test('parse: the common shapes', () => {
  const ok = (t) => { const r = parseTweet(t); assert.ok(r.ok, `${t}: ${r.message}`); return r.request }
  assert.deepEqual(ok('@PumpFund $PEPE'), { symbol: 'PEPE', name: 'PEPE', mode: null, pair: null })
  assert.deepEqual(ok('@PumpFund launch $DOGE Doge Coin'), { symbol: 'DOGE', name: 'Doge Coin', mode: null, pair: null })
  assert.deepEqual(ok('@PumpFund deploy "Space Cats" $SCAT'), { symbol: 'SCAT', name: 'Space Cats', mode: null, pair: null })
  assert.equal(ok('hey @PumpFund make me a token called Bread, ticker $BREAD').name, 'Bread')
  assert.equal(ok('@PumpFund make me a token called Token Cat $TCAT').name, 'Token Cat')
  assert.equal(ok('@PumpFund $doge').symbol, 'DOGE')
  assert.equal(ok('@PumpFund $DOGE https://t.co/abc123').name, 'DOGE')
  assert.equal(ok('@PumpFund $DOGE for @alice').name, 'DOGE')
})

test('parse: the fee phrase is lifted out of the name (the mode itself is the site setting)', () => {
  const r = parseTweet('@PumpFund $DOGE Doge Coin, fees to holders')
  assert.deepEqual(r.request, { symbol: 'DOGE', name: 'Doge Coin', mode: 'holders', pair: null })
  assert.equal(parseTweet('@PumpFund launch $X for holders').request.mode, 'holders')
  assert.equal(parseTweet('@PumpFund $DH Diamond Holders').request.name, 'Diamond Holders')
  assert.equal(parseTweet('@PumpFund $DH Diamond Holders').request.mode, null)
  // quoted names are the author's exact words
  assert.deepEqual(parseTweet('@PumpFund "Fees To Holders" $FTH').request, { symbol: 'FTH', name: 'Fees To Holders', mode: null, pair: null })
})

test('parse: a custom pair is lifted out (ticker or address) and never taken for the coin\'s ticker or name', () => {
  const r = (t) => parseTweet(t).request
  assert.deepEqual(r('@PumpFund launch $FROG paired with $BONK'), { symbol: 'FROG', name: 'FROG', mode: null, pair: '$BONK' })
  assert.deepEqual(r('@PumpFund $FROG Frog Club pair with 3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump'), { symbol: 'FROG', name: 'Frog Club', mode: null, pair: '3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump' })
  assert.equal(r('@PumpFund pair with $bonk launch $FROG').symbol, 'FROG')
  assert.equal(r('@PumpFund pair with $bonk launch $FROG').pair, '$BONK')
  assert.equal(r('@PumpFund $FROG pairing it against $USDC').pair, '$USDC')
  assert.equal(r('@PumpFund $FROG "Frog paired with Bonk"').pair, null, 'a quoted name is the author\'s words')
  assert.equal(r('@PumpFund $FROG "Frog paired with Bonk"').name, 'Frog paired with Bonk')
  assert.equal(r('@PumpFund $PAIR pair').pair, null)
  assert.ok(hasLaunchIntent('@PumpFund $FROG paired with $BONK'))
})

test('parse: refusals', () => {
  assert.equal(parseTweet('@PumpFund launch something').code, 'no-ticker')
  assert.equal(parseTweet('@PumpFund $ABCDEFGHIJK').code, 'bad-ticker')
  assert.equal(parseTweet('@PumpFund $X ' + 'n'.repeat(40)).code, 'name-too-long')
  // pump.fun counts BYTES: 11 CJK characters are 33 bytes and would fail on chain
  assert.equal(parseTweet('@PumpFund $X ' + '猫'.repeat(11)).code, 'name-too-long')
  assert.equal(parseTweet('@PumpFund $X ' + '猫'.repeat(10)).request.name, '猫'.repeat(10))
  assert.equal(parseTweet('@PumpFund $X​​').request.name, 'X') // zero-width stripped
})

test('isLaunchRequest: retweets, own posts, unrelated mentions', () => {
  const m = (text, extra = {}) => ({ text, authorHandle: 'alice', ...extra })
  assert.ok(isLaunchRequest(m('@PumpFund $DOGE'), H))
  assert.ok(isLaunchRequest(m('@PumpFund launch $DOGE Doge Coin'), H))
  assert.ok(isLaunchRequest(m('hey @PumpFund can you make $BREAD'), H))
  assert.ok(!isLaunchRequest(m('@PumpFund gm, follow back?'), H))
  assert.ok(!isLaunchRequest(m('@PumpFund launch something'), H), 'no ticker: not answered')
  assert.ok(!isLaunchRequest(m('@PumpFund $BTC $ETH $SOL all pumping'), H), 'shill list')
  assert.ok(!isLaunchRequest(m('$SOL looking strong today @PumpFund'), H), 'market comment: ticker not first, no launch word')
  assert.ok(!isLaunchRequest(m('@PumpFund @bob nice one $DOGE', { inReplyToId: '5' }), H), 'only tagged by the thread')
  assert.ok(isLaunchRequest(m('@PumpFund @bob launch $FROG', { inReplyToId: '5' }), H), 'in a thread with a launch word')
  assert.ok(!isLaunchRequest(m('@PumpFund $DOGE', { isRetweet: true }), H))
  assert.ok(!isLaunchRequest(m('@alice $DOGE is live', { authorHandle: 'PumpFund' }), H))
  assert.ok(isLaunchRequest(m('@PumpFund $CASHTAG', { authorHandle: 'PumpFund' }), H, { allowSelf: true }))
  assert.ok(!isLaunchRequest(m('@PumpFundFan $DOGE'), H))
})

test('replies: carry ticker and CA, end with "CA: <mint>"; fit a tweet; deterministic; no banned characters', () => {
  const mint = Keypair.generate().publicKey.toBase58()
  const r = launchedReply({ symbol: 'DOGE', name: 'Doge Coin', mint, url: `https://pumpfund.family/t/${mint}` })
  assert.ok(r.includes('$DOGE') && r.endsWith(`\n\nCA: ${mint}`) && !r.includes('http'), r)
  assert.equal(r, launchedReply({ symbol: 'DOGE', name: 'Doge Coin', mint, url: `https://pumpfund.family/t/${mint}` }))
  const long = launchedReply({ symbol: 'ABCDEFGHIJ', name: 'N'.repeat(32), mint, url: `https://pumpfund.family/t/${mint}`, mode: 'holders', pair: null })
  assert.ok(tweetLength(long) <= 280)
  for (const t of [r, long, rejectedReply('a — b')]) assert.ok(!/—|--|#|\p{Extended_Pictographic}/u.test(t), t)
})

test('replies never carry emojis, hashtags, "--" or long dashes, even from the name someone typed', () => {
  const mint = Keypair.generate().publicKey.toBase58()
  const bad = /[\p{Extended_Pictographic}#—–]|--/u
  for (const name of ['Doge 🚀🚀 #moon', 'Rocket -- Ship', 'Frog — Club', '🇺🇸 Freedom ❤️', 'Coin.', '#️⃣ Hash']) {
    const r = launchedReply({ symbol: 'DOGE', name, mint, url: `https://pumpfund.family/t/${mint}` })
    assert.ok(!bad.test(r), r)
    assert.ok(r.includes(mint))
    assert.ok(!r.includes('..'), r)
  }
  assert.ok(!launchedReply({ symbol: 'DOGE', name: 'Doge 🚀 #moon', mint, url: 'u' }).includes('moon'))
  for (const reason of ['an account needs 25 followers -- sorry 😢', 'a ticker is 1 to 10 characters', 'You can launch 3 coins a day. Try again tomorrow.']) {
    const r = rejectedReply(reason)
    assert.ok(!bad.test(r), r)
    assert.match(r, /^[A-Z].*[.!?]$/)
  }
  assert.ok(!bad.test(failedReply()))
})

test('images: only X media is fetched; description is short', () => {
  assert.ok(isAllowedImageHost('https://pbs.twimg.com/media/abc.jpg'))
  assert.ok(!isAllowedImageHost('http://pbs.twimg.com/media/abc.jpg'))
  assert.ok(!isAllowedImageHost('https://evil.example/pbs.twimg.com.jpg'))
  assert.ok(describe({ symbol: 'ABCDEFGHIJ', handle: 'a'.repeat(15), publicUrl: 'https://pumpfund.family' }).length < 200)
})

test('fee wallets: deterministic per mint, different per mint and per seed', () => {
  const s1 = parseSeed('11'.repeat(32)), s2 = parseSeed('22'.repeat(32))
  const m1 = Keypair.generate().publicKey.toBase58(), m2 = Keypair.generate().publicKey.toBase58()
  assert.equal(feeWallet(s1, m1).publicKey.toBase58(), feeWallet(s1, m1).publicKey.toBase58())
  assert.notEqual(feeWallet(s1, m1).publicKey.toBase58(), feeWallet(s1, m2).publicKey.toBase58())
  assert.notEqual(feeWallet(s1, m1).publicKey.toBase58(), feeWallet(s2, m1).publicKey.toBase58())
  assert.throws(() => parseSeed('abc'))
})

function coinDb() {
  const db = openDb(':memory:')
  const mint = Keypair.generate().publicKey.toBase58()
  db.prepare("INSERT INTO users (x_id, handle, seen_at) VALUES ('1', 'alice', 0)").run()
  db.prepare(`INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at) VALUES (?, 'Doge', 'DOGE', '1', 'alice', ?, 'creator', 0)`).run(mint, Keypair.generate().publicKey.toBase58())
  return { db, mint, coin: db.prepare('SELECT * FROM tokens').get() }
}

test('buckets: credits go to the mode at the time; outflows reserve; expired releases', () => {
  const { db, mint, coin } = coinDb()
  assert.equal(creditSurplus(db, coin, RENT_FLOOR), 0) // just the floor: nothing new
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1000), 1000)
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1000), 0) // idempotent: same balance credits nothing
  db.prepare("UPDATE tokens SET mode = 'holders' WHERE mint = ?").run(mint)
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1500), 500)
  assert.deepEqual([buckets(db, mint).creator, buckets(db, mint).holders], [1000, 500])
  // a payout in flight blocks credits and reserves its amount
  db.prepare("INSERT INTO outflows (mint, bucket, lamports, kind, state, time) VALUES (?, 'creator', 600, 'payout', 'sending', 0)").run(mint)
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1500 + 999), 0)
  assert.equal(buckets(db, mint).creator, 400)
  db.prepare("UPDATE outflows SET state = 'expired'").run()
  assert.equal(buckets(db, mint).creator, 1000)
  assert.equal(owedTo(db, '1').total, 1000)
})

test('coin lock: a conditional UPDATE, one holder at a time', () => {
  const { db, mint } = coinDb()
  assert.ok(lockCoin(db, mint))
  assert.ok(!lockCoin(db, mint))
  unlockCoin(db, mint)
  assert.ok(lockCoin(db, mint))
})

test('airdrop plan: pro rata, wallets only, minimums, rent-safe, sums within the pot', () => {
  const w = () => Keypair.generate().publicKey.toBase58()
  const pda = PublicKey.findProgramAddressSync([Buffer.from('x')], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0].toBase58()
  const [a, b, c, dust, empty] = [w(), w(), w(), w(), w()]
  const T = 1_000_000n
  const holders = [
    { owner: a, amount: 600_000n * T }, { owner: b, amount: 300_000n * T }, { owner: c, amount: 100_000n * T },
    { owner: dust, amount: 10n * T }, { owner: pda, amount: 5_000_000n * T }, { owner: empty, amount: 200_000n * T },
  ]
  const lamportsOf = new Map([[a, 1e9], [b, 1e9], [c, 1e9], [dust, 1e9], [empty, 0]])
  const plan = planAirdrop(holders, 100_000_000, { holderMinTokens: 100_000n * T, maxHolders: 100, minShare: 10_000, lamportsOf })
  const by = Object.fromEntries(plan.map((p) => [p.owner, p.lamports]))
  assert.ok(!(pda in by), 'program accounts are never paid')
  assert.ok(!(dust in by), 'below the token minimum')
  // `empty` would get 100M*200k/1.2M = 16.6M > rent floor: kept
  assert.ok(empty in by)
  assert.equal(by[a], Math.floor(100_000_000 * 600_000 / 1_200_000))
  assert.ok(plan.reduce((s, p) => s + p.lamports, 0) <= 100_000_000)
  // a tiny pot: an empty wallet's share under the rent floor is dropped and the rest re-divided
  const small = planAirdrop(holders, 2_000_000, { holderMinTokens: 100_000n * T, maxHolders: 100, minShare: 10_000, lamportsOf })
  assert.ok(!small.some((p) => p.owner === empty))
  assert.equal(small.find((p) => p.owner === a).lamports, Math.floor(2_000_000 * 600 / 1000))
})

test('guards: personal rules refuse, capacity defers, closed launching defers everyone', () => {
  const db = openDb(':memory:')
  const g = guardConfig({ MIN_FOLLOWERS: '25', MIN_ACCOUNT_AGE_DAYS: '14', LAUNCH_RAMP: '0', MIN_SPACING_SECONDS: '45', PER_AUTHOR_COOLDOWN_SECONDS: '3600' })
  const s = { authorId: '1', authorHandle: 'alice', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'DOGE' }
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  assert.equal(checkGuards(db, g, { ...s, authorFollowers: 3 }).code, 'too-few-followers')
  assert.equal(guardConfig({}).perAuthorDailyLimit, 0, 'no daily cap (operator 11 Nov)')
  assert.equal(guardConfig({}).perAuthorCooldownSeconds, 0, 'no cooldown: launch as many times as wanted (operator 15 Nov)')
  assert.equal(checkGuards(db, g, { ...s, authorCreatedAt: now() - 86400 }).code, 'account-too-new')
  kvSet(db, LAUNCHING_CLOSED, 'x')
  const v = checkGuards(db, g, s)
  assert.equal(v.code, 'launching-closed'); assert.ok(v.defer)
  kvDel(db, LAUNCHING_CLOSED)
  db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, launched_at, updated_at) VALUES ('t1', '1', 'alice', '', 0, 0, 'launched', ?, 0)").run(now() - 10)
  assert.equal(checkGuards(db, g, s).code, 'cooldown')
  const other = { ...s, authorId: '2', authorHandle: 'bob' }
  const sp = checkGuards(db, g, other)
  assert.equal(sp.code, 'spacing'); assert.ok(sp.defer)
  // the ramp can only make it quieter
  const ramped = rampFor(db, { ...g, rampEnabled: true })
  assert.ok(ramped.spacing >= g.minSpacingSeconds && ramped.hourly <= g.globalHourlyLimit)
})

test('bot: known tweets skipped before any billable read, rejections replied once a day, platform request bypasses closure', async () => {
  const db = openDb(':memory:')
  kvSet(db, LAUNCHING_CLOSED, 'x')
  const x = new FixtureX(H)
  const t = now()
  const author = { authorId: '7', authorHandle: 'alice', authorName: 'Alice', authorFollowers: 500, authorCreatedAt: t - 400 * 86400, authorAvatar: null, mediaUrl: null, isRetweet: false }
  x.mentions.push({ ...author, id: '100', text: '@PumpFund $DOGE', createdAt: t, inReplyToId: '55', url: 'u' })
  x.mentions.push({ ...author, id: '101', text: '@PumpFund launch $ABCDEFGHIJKLM', createdAt: t, inReplyToId: null, url: 'u' })
  x.mentions.push({ ...author, id: '102', text: '@PumpFund launch $ABCDEFGHIJKLMN again', createdAt: t, inReplyToId: null, url: 'u' })
  x.mentions.push({ ...author, id: '103', text: '@PumpFund gm', createdAt: t, inReplyToId: null, url: 'u' })
  x.mentions.push({ ...author, authorId: '999', authorHandle: H, id: '104', text: `@${H} $CASHTAG`, createdAt: t, inReplyToId: null, url: 'u' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0' }), env: { X_HANDLE: H, PLATFORM_X_ID: '999', PROJECT_TICKER: 'CASHTAG' }, publicUrl: 'https://pumpfund.family' })
  const r = await bot.poll()
  assert.equal(r.added, 4) // gm is not a request
  const st = Object.fromEntries(db.prepare('SELECT tweet_id, state, reply_state, platform FROM mentions').all().map((m) => [m.tweet_id, m]))
  assert.equal(st['100'].state, 'queued')
  assert.equal(st['101'].reply_state, 'pending')
  assert.equal(st['102'].reply_state, 'skipped') // one rejection reply per account per day
  assert.equal(st['104'].platform, 1)
  const again = await bot.poll()
  assert.equal(again.added, 0)
  assert.equal(x.calls.tweet, 0, 'no billable per-tweet lookups at poll time')
  // the queue defers strangers while closed (the platform request is first in line, and needs the chain: not run here)
  db.prepare("UPDATE mentions SET state = 'rejected' WHERE tweet_id = '104'").run()
  const q = await bot.processQueue()
  assert.equal(q.deferred, 'launching-closed')
})

test('bot: "fees to holders" in a post does not choose the mode (the site setting does), and stays out of the name', async () => {
  const db = openDb(':memory:')
  const x = new FixtureX(H)
  x.mentions.push({ id: '300', text: '@PumpFund $FROG Frog Club, fees to holders', createdAt: now(), authorHandle: 'erin', authorId: '31', authorName: 'Erin',
    authorFollowers: 500, authorCreatedAt: now() - 400 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'u' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0' }), env: { X_HANDLE: H }, publicUrl: 'https://pumpfund.family' })
  await bot.poll()
  const m = db.prepare("SELECT name, mode FROM mentions WHERE tweet_id = '300'").get()
  assert.equal(m.name, 'Frog Club')
  assert.equal(m.mode, null)
})

test('guards: no daily cap, one launch per account every 30 minutes, refused with a clean sentence', () => {
  const db = openDb(':memory:')
  const g = guardConfig({ LAUNCH_RAMP: '0', MIN_SPACING_SECONDS: '0', PER_AUTHOR_COOLDOWN_SECONDS: '1800' })
  const s = { authorId: '9', authorHandle: 'zed', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'X' }
  const add = (i, ago) => db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, launched_at, updated_at) VALUES (?, '9', 'zed', '', 0, 0, 'launched', ?, 0)").run(`d${i}`, now() - ago)
  // 20 launches earlier today, each 31+ minutes apart: the next one is still allowed
  for (let i = 0; i < 20; i++) add(i, 31 * 60 * (i + 1))
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  add(99, 18 * 60)
  const v = checkGuards(db, g, s)
  assert.equal(v.code, 'cooldown')
  assert.equal(v.reason, 'You can launch one token every 30 minutes. Try again in 12 minutes.')
})

test('bot filter: automated, default avatar, digit handles, follow farms and firehoses are dropped silently', async () => {
  const { botReason } = await import('../api/botfilter.mjs')
  const t = now()
  const real = { authorHandle: 'alice', authorFollowers: 300, authorFollowing: 400, authorTweets: 2000, authorCreatedAt: t - 400 * 86400, authorAvatar: 'https://pbs.twimg.com/profile_images/1/a.jpg', authorAutomated: false, authorVerified: false }
  assert.equal(botReason(real, t), null)
  assert.match(botReason({ ...real, authorAutomated: true }, t), /automated/)
  assert.match(botReason({ ...real, authorAvatar: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png' }, t), /default/)
  assert.match(botReason({ ...real, authorHandle: 'user8812345678' }, t), /handle/)
  assert.match(botReason({ ...real, authorFollowers: 40, authorFollowing: 4000 }, t), /follows/)
  assert.match(botReason({ ...real, authorTweets: 200000 }, t), /hundreds/)
  assert.equal(botReason({ ...real, authorHandle: 'user8812345678', authorVerified: true }, t), null, 'blue-verified: only the X label counts')
  // through the bot: recorded, never queued, never answered
  const db = openDb(':memory:')
  const x = new FixtureX(H)
  x.mentions.push({ ...real, authorId: '66', authorName: 'b', id: '400', text: '@PumpFund $SPAM', createdAt: t, authorAutomated: true, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'u' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({}), env: { X_HANDLE: H }, publicUrl: 'https://pumpfund.family' })
  await bot.poll()
  const row = db.prepare("SELECT state, code, reply_state FROM mentions WHERE tweet_id = '400'").get()
  assert.deepEqual({ ...row }, { state: 'rejected', code: 'bot', reply_state: 'skipped' })
})

test('refusals: only fixable mistakes and the daily limit are answered; too few followers or too new is silent', async () => {
  const db = openDb(':memory:')
  kvSet(db, 'initialised', '1')
  const x = new FixtureX(H)
  const t = now()
  const base = { authorName: 'n', authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'u', createdAt: t, authorCreatedAt: t - 400 * 86400 }
  x.mentions.push({ ...base, id: '500', authorId: '71', authorHandle: 'tiny', authorFollowers: 2, text: '@PumpFund $TINY' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0' }), env: { X_HANDLE: H }, publicUrl: 'https://pumpfund.family' })
  await bot.poll()
  const q = await bot.processQueue()
  assert.equal(q.rejected, 'too-few-followers')
  assert.equal(db.prepare("SELECT reply_state FROM mentions WHERE tweet_id = '500'").get().reply_state, 'skipped')
})

test('coin image priority: own image, then the replied-to post, then the quoted post, then the Pump Fund logo', async () => {
  const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)])
  const served = { 'own.jpg': png(16), 'parent.jpg': png(17), 'quoted.jpg': png(18) }
  const fetched = []
  const fetchImpl = async (url) => { const k = new URL(url).pathname.split('/').pop(); fetched.push(k); if (!served[k]) throw new Error('404'); return served[k] }
  const x = { fetchTweet: async (id) => (id === 'p1' ? { mediaUrl: 'https://pbs.twimg.com/media/parent.jpg' } : null) }
  const M = (o) => ({ symbol: 'DOGE', mediaUrl: null, inReplyToId: null, quotedMediaUrl: null, ...o })
  const own = 'https://pbs.twimg.com/media/own.jpg', parent = 'p1', quoted = 'https://pbs.twimg.com/media/quoted.jpg'
  assert.equal((await chooseImage({ mention: M({ mediaUrl: own, inReplyToId: parent, quotedMediaUrl: quoted }), x, fetchImpl })).source, 'tweet', 'own image wins over the parent')
  fetched.length = 0
  assert.equal((await chooseImage({ mention: M({ inReplyToId: parent, quotedMediaUrl: quoted }), x, fetchImpl })).source, 'parent')
  assert.equal((await chooseImage({ mention: M({ quotedMediaUrl: quoted }), x, fetchImpl })).source, 'quoted')
  const none = await chooseImage({ mention: M({}), x, fetchImpl })
  assert.equal(none.source, 'logo')
  assert.ok(none.bytes.equals(readFileSync(new URL('../api/assets/project-token.png', import.meta.url))), 'the Pump Fund logo')
  // own image fails to download: falls back to the parent, not straight to a letter
  assert.equal((await chooseImage({ mention: M({ mediaUrl: 'https://pbs.twimg.com/media/gone.jpg', inReplyToId: parent }), x, fetchImpl })).source, 'parent')
  // never fetched from anywhere but X's media host
  assert.equal((await chooseImage({ mention: M({ mediaUrl: 'https://evil.example/own.jpg' }), x, fetchImpl })).source, 'logo')
  // the medium size is asked for
  const urls = []
  await chooseImage({ mention: M({ mediaUrl: own }), x, fetchImpl: async (u) => { urls.push(u); return png(16) } })
  assert.match(urls[0], /name=medium/)
})

test('a mention keeps its own, parent and quoted image sources from the X payload', async () => {
  const { toMention } = await import('../api/x.mjs')
  const m = toMention({ id: '1', text: '@PumpFund $DOGE', author: { userName: 'a', id: '2' }, inReplyToId: '9',
    extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/own.jpg' }] },
    quoted_tweet: { extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/q.jpg' }] } } })
  assert.equal(m.mediaUrl, 'https://pbs.twimg.com/media/own.jpg')
  assert.equal(m.inReplyToId, '9')
  assert.equal(m.quotedMediaUrl, 'https://pbs.twimg.com/media/q.jpg')
})

test('coin links: the launch post as the X link (always x.com form), the site as the website', () => {
  assert.equal(SITE_URL, 'https://pumpfund.family/')
  assert.equal(tweetLink({ tweet_id: '1855', author_handle: 'alice', url: 'https://twitter.com/alice/status/1855?s=20' }), 'https://x.com/alice/status/1855')
  assert.equal(tweetLink({ id: '77', authorHandle: '@bob' }), 'https://x.com/bob/status/77')
})

test('a ticker with no name (or only filler like lfg) is named after the ticker; reply wording per operator 10 Nov', async () => {
  const { parseTweet } = await import('../api/parse.mjs')
  const { launchedReply, failedReply } = await import('../api/replies.mjs')
  for (const t of ['@PumpFund $PEPE', '@PumpFund launch $PEPE', '@PumpFund $PEPE lfg', '@PumpFund $PEPE now pls ser']) assert.equal(parseTweet(t).request.name, 'PEPE', t)
  assert.equal(parseTweet('@PumpFund $PEPE Pepe The Frog').request.name, 'Pepe The Frog')
  const banned = /is out\b|Claim or set payouts|Details at|Tag us with a ticker/
  for (let i = 0; i < 60; i++) {
    const mint = `${i}abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQcash`
    for (const mode of ['creator', 'holders', 'platform']) assert.doesNotMatch(launchedReply({ symbol: 'PEPE', name: 'PEPE', mint, url: 'https://pumpfund.family', mode }), banned)
  }
  assert.equal(launchedReply({ symbol: 'CASHTAG', name: 'Cashtag', mint: 'Mintcash', url: 'https://pumpfund.family', mode: 'platform' }), '$CASHTAG is live.\n\nCA: Mintcash')
  assert.ok(launchedReply({ symbol: 'PILL', name: 'PILL', mint: 'Mintcash', url: 'https://pumpfund.family/t/Mintcash', mode: 'holders', pair: 'Pump' })=== '$PILL is live paired with $PUMP\n\nCA: Mintcash')
  assert.ok(launchedReply({ symbol: 'PILL', name: 'Pill Club', mint: 'Mintcash', url: 'https://x', mode: 'creator', pair: 'Pump' })=== '$PILL is live paired with $PUMP\n\nCA: Mintcash')
  assert.ok(/^\$FROG [a-zA-Z ]+\.\n\nCA: Mintcash$/.test(launchedReply({ symbol: 'FROG', name: 'Frog Club', mint: 'Mintcash' })))
  assert.equal(failedReply(), 'That launch did not go through. Posting again puts it back in the queue.')
})

test('a store made by an older version gains every newer column (the live box had xmoney_payouts before carry_usdc)', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(mkdtempSync(join(tmpdir(), 'ct-old-')), 'old.db')
  const old = new DatabaseSync(path)
  // the table exactly as the first X Money deploy (04:19 UTC 11 Nov) created it
  old.exec(`CREATE TABLE xmoney_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, x_id TEXT NOT NULL, handle TEXT NOT NULL, state TEXT NOT NULL,
    collect_sigs TEXT NOT NULL DEFAULT '[]', lamports INTEGER NOT NULL DEFAULT 0, refund_mint TEXT, sol_usd REAL, relay_request TEXT, relay_sig TEXT,
    relay_lvh INTEGER, relay_attempts INTEGER NOT NULL DEFAULT 0, usdc INTEGER NOT NULL DEFAULT 0, deposit_id TEXT, list_started_at INTEGER,
    listed_at INTEGER, relists INTEGER NOT NULL DEFAULT 0, filled_usdc INTEGER NOT NULL DEFAULT 0, paid_usd REAL NOT NULL DEFAULT 0,
    cur_filled_usdc INTEGER NOT NULL DEFAULT 0, cur_paid_usd REAL NOT NULL DEFAULT 0, return_usdc INTEGER NOT NULL DEFAULT 0, return_request TEXT,
    return_started_at INTEGER, returned_lamports INTEGER NOT NULL DEFAULT 0, credit_sig TEXT, credit_lvh INTEGER, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER)`)
  old.close()
  const db = openDb(path)
  const cols = db.prepare('PRAGMA table_info(xmoney_payouts)').all().map((c) => c.name)
  for (const c of ['carry_usdc', 'carry_used', 'cur_filled_usdc', 'cur_paid_usd']) assert.ok(cols.includes(c), c)
  // the X Money pass runs its queries against it without throwing
  const { xmoneyPass } = await import('../api/xmoney.mjs')
  const out = await xmoneyPass({ db, conn: null, keeper: null, seed: Buffer.alloc(32), rails: null, cfg: { minLamports: 1, dustUsdc: 500_000 }, log: { error() {} } })
  assert.deepEqual(out, [])
})

test('operator 15 Nov: no global cap, no spacing, no ramp, no per-wallet cooldown by default', () => {
  const db = openDb(':memory:')
  const g = guardConfig({})
  assert.equal(g.globalHourlyLimit, Infinity); assert.equal(g.minSpacingSeconds, 0); assert.equal(g.rampEnabled, false)
  const ins = db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, launched_at, updated_at) VALUES (?, ?, ?, '', 0, 0, 'launched', ?, 0)")
  for (let i = 0; i < 200; i++) ins.run(`b${i}`, String(5000 + i), `u${i}`, now() - 5 - i) // 200 launches by others in the last minutes
  const s = { authorId: '42', authorHandle: 'new', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'X' }
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  ins.run('mine', '42', 'new', now() - 60)
  ins.run('mine2', '42', 'new', now() - 1)
  assert.deepEqual(checkGuards(db, g, s), { allowed: true }, 'the same wallet launches again right away')
})

test('the operator replying "@PumpFund launch $CASHTAG" under their own intro post is caught even when X leaves it out of the mentions', async () => {
  const db = openDb(':memory:')
  kvSet(db, LAUNCHING_CLOSED, 'x')
  const x = new FixtureX('PumpFund')
  const t = now()
  const op = { authorId: '2120180575294099456', authorHandle: 'PumpFund', authorName: 'Pump Fund', authorFollowers: 10, authorCreatedAt: t - 86400, authorAvatar: null, mediaUrl: null, isRetweet: false, url: 'u' }
  const stranger = { ...op, authorId: '55', authorHandle: 'eve', authorName: 'Eve', authorFollowers: 900, authorCreatedAt: t - 900 * 86400 }
  // X's mention search returns NOTHING for it; the reply sits only under the intro post (2120402994042941692)
  x.replyThreads = new Map([['2120402994042941692', [
    { ...stranger, id: '900', text: '@PumpFund launch $CASHTAG', createdAt: t - 30, inReplyToId: '2120402994042941692' },
    { ...op, id: '901', text: '@PumpFund launch $CASHTAG', createdAt: t - 10, inReplyToId: '2120402994042941692' },
  ]]])
  const env = { X_HANDLE: 'PumpFund', PLATFORM_X_ID: '2120180575294099456', PROJECT_TICKER: 'CASHTAG', PROJECT_NAME: 'CASHTAG', PLATFORM_WATCH_TWEET: '2120402994042941692' }
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({}), env, publicUrl: 'https://pumpfund.family' })
  const r = await bot.poll()
  assert.equal(r.read, 0, 'nothing came through the mention search')
  assert.deepEqual(r.platformWatch, { replies: 2, mine: 1, added: 1 })
  const row = db.prepare("SELECT * FROM mentions WHERE tweet_id = '901'").get()
  assert.equal(row.platform, 1); assert.equal(row.state, 'queued'); assert.equal(row.symbol, 'CASHTAG'); assert.equal(row.name, 'CASHTAG')
  assert.equal(db.prepare("SELECT count(*) n FROM mentions WHERE tweet_id = '900'").get().n, 0, "a stranger's reply under the intro post is not taken from there")
  // once it is queued the watch stops reading (no paid reads after the platform request exists)
  kvSet(db, 'platform_watch_at', 0)
  const calls = x.calls.replies
  await bot.poll()
  assert.equal(x.calls.replies, calls)
  // the by-hand fallback: the same post by id is recognised as already taken (never a second platform row)
  x.tweets.set('901', { mention: { ...op, id: '901', text: '@PumpFund launch $CASHTAG', createdAt: t - 10, inReplyToId: '2120402994042941692' } })
  const again = await bot.ingestTweetId('901')
  assert.equal(again.added, 0); assert.equal(again.row.platform, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM mentions WHERE platform = 1').get().n, 1)
})

test('the by-hand fallback alone: a post id the watch never saw becomes the platform request', async () => {
  const db = openDb(':memory:')
  const x = new FixtureX('PumpFund')
  const t = now()
  x.tweets.set('777', { mention: { id: '777', text: '@PumpFund launch $CASHTAG', createdAt: t, authorId: '2120180575294099456', authorHandle: 'PumpFund', authorName: 'Pump Fund',
    authorFollowers: 10, authorCreatedAt: t - 86400, authorAvatar: null, mediaUrl: null, isRetweet: false, url: 'u', inReplyToId: '2120402994042941692' } })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({}),
    env: { X_HANDLE: 'PumpFund', PLATFORM_X_ID: '2120180575294099456', PROJECT_TICKER: 'CASHTAG', PROJECT_NAME: 'CASHTAG' }, publicUrl: 'https://pumpfund.family' })
  const r = await bot.ingestTweetId('777')
  assert.equal(r.added, 1); assert.equal(r.row.platform, 1); assert.equal(r.row.state, 'queued')
})

test('feetrack: a holder-reward coin counts every lamport collected into its holder-rewards account and paid out of it, oldest first, nothing twice or skipped', async () => {
  const { trackExternalFees } = await import('../api/feetrack.mjs')
  const { holderRewardsAddress } = await import('../lib/pump.mjs')
  const db = openDb(':memory:')
  const mint = Keypair.generate().publicKey.toBase58()
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at, native_holders) VALUES (?, 'x', 'X', '1', 'x', 'w', 'holders', 0, 1)").run(mint)
  const pda = holderRewardsAddress(new PublicKey(mint)).toBase58()
  // newest first, as the RPC returns them: created+collect, distribute, collect, distribute
  let sigs = [
    { signature: 's4', err: null, blockTime: 400 }, { signature: 's3', err: null, blockTime: 300 },
    { signature: 's2', err: null, blockTime: 200 }, { signature: 's1', err: null, blockTime: 100 },
  ]
  const txs = { s1: [0, 890_880 + 5_000_000], s2: [5_890_880, 890_880], s3: [890_880, 3_890_880], s4: [3_890_880, 1_890_880] }
  const conn = {
    async _rpcRequest(method, params) {
      if (method === 'getSignaturesForAddress') { const until = params[1].until; const i = until ? sigs.findIndex((s) => s.signature === until) : sigs.length; return { result: sigs.slice(0, i < 0 ? sigs.length : i) } }
      if (method === 'getTransaction') { const [pre, post] = txs[params[0]]; return { result: { transaction: { message: { accountKeys: ['payer', pda] } }, meta: { preBalances: [1e9, pre], postBalances: [1e9, post], fee: 5000, logMessages: [] } } } }
    },
    async getMultipleAccountsInfo(keys) { return keys.map(() => null) },
  }
  const row = () => db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint)
  // a budget of 2: the OLDEST two are counted first, the rest next pass (never the newest first)
  await trackExternalFees(db, conn, row(), { maxTx: 2 })
  assert.equal(row().ext_sig, 's2'); assert.equal(row().ext_in, 5_890_880); assert.equal(row().ext_out, 5_000_000)
  await trackExternalFees(db, conn, row())
  assert.equal(row().ext_in, 5_890_880 + 3_000_000, 'every lamport in: no rent is assumed (pump.fun drains the PDA below it)')
  assert.equal(row().ext_out, 5_000_000 + 2_000_000, 'paid out to holders: 5M + 2M')
  assert.equal(row().ext_sig, 's4')
  // a second pass with no new transactions changes nothing
  await trackExternalFees(db, conn, row())
  assert.equal(row().ext_in, 8_890_880); assert.equal(row().ext_out, 7_000_000)
  // a new collect arrives: only it is counted
  sigs = [{ signature: 's5', err: null, blockTime: 500 }, ...sigs]; txs.s5 = [1_890_880, 2_390_880]
  await trackExternalFees(db, conn, row())
  assert.equal(row().ext_in, 9_390_880); assert.equal(row().ext_sig, 's5')
  assert.equal(row().ext_in - row().ext_out, 2_390_880, 'in − out = what the account holds now')
})

test('cashtag protection: a cashtag launched by anyone is refused for 24 hours (any case), then free again', () => {
  const db = openDb(':memory:')
  const g = guardConfig({})
  assert.equal(g.tickerHoldSeconds, 86400)
  const s = { authorId: '42', authorHandle: 'new', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'frog' }
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at) VALUES ('M1', 'Frog', 'FROG', '7', 'alice', 'w1', 'holders', ?)").run(now() - 3 * 3600)
  const v = checkGuards(db, g, s)
  assert.equal(v.code, 'ticker-taken')
  assert.equal(v.reason, '$FROG was launched in the last 24 hours. Pick another ticker, or try again in 21 hours.')
  // even the account that launched it, and even an exempt account
  assert.equal(checkGuards(db, { ...g, exempt: ['new'] }, s).code, 'ticker-taken')
  // another cashtag is unaffected; after 24 hours FROG is free again
  assert.deepEqual(checkGuards(db, g, { ...s, symbol: 'TOAD' }), { allowed: true })
  db.prepare("UPDATE tokens SET created_at = ? WHERE mint = 'M1'").run(now() - 86400 - 10)
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
})


test('launching FOR @someone: parsed from the raw text, never from a quoted name; "for holders" stays the fee phrase', () => {
  assert.equal(parseTweet('@PumpFund launch $DOGE for @alice').request.forHandle, 'alice')
  assert.equal(parseTweet('@PumpFund Launch $CASHTAG for @user').request.symbol, 'CASHTAG')
  const r = parseTweet('@PumpFund $FROG Frog Coin for @bob_99, fees to holders').request
  assert.deepEqual([r.forHandle, r.name], ['bob_99', 'Frog Coin'])
  assert.equal(parseTweet('@PumpFund launch $CAT for holders').request.forHandle, undefined)
  assert.equal(parseTweet('@PumpFund $Q "made for @nobody"').request.forHandle, undefined)
  assert.equal(parseTweet('@PumpFund $X for: @Carol paired with $BONK').request.pair, '$BONK')
})

test('launching FOR @someone: resolved to their X id before launch; unknown refused with a reply; outage waits; self/bot ignored; X Money set up for a new account only', async () => {
  const db = openDb(':memory:')
  const x = new FixtureX(H)
  const t = now()
  const a = { authorId: '7', authorHandle: 'alice', authorName: 'Alice', authorFollowers: 500, authorCreatedAt: t - 400 * 86400, authorAvatar: null, mediaUrl: null, isRetweet: false, inReplyToId: null, url: 'u', createdAt: t }
  x.users = new Map([['bob', { id: '4242', handle: 'Bob', name: 'Bob', followers: 10 }], ['chosen', { id: '5151', handle: 'chosen', name: 'C', followers: 10 }]])
  x.mentions.push({ ...a, id: '500', text: '@PumpFund launch $GM for @bob' })
  x.mentions.push({ ...a, id: '501', authorId: '8', authorHandle: 'dan', text: '@PumpFund launch $NOPE for @ghost' })
  x.mentions.push({ ...a, id: '502', authorId: '9', authorHandle: 'erin', text: '@PumpFund launch $ME for @erin' })
  x.mentions.push({ ...a, id: '503', authorId: '10', authorHandle: 'fay', text: '@PumpFund launch $BOT for @PumpFund' })
  x.mentions.push({ ...a, id: '504', authorId: '11', authorHandle: 'gus', text: '@PumpFund launch $KEPT for @chosen' })
  // an account that already chose its own payout (claim to a wallet) keeps it
  db.prepare("INSERT INTO users (x_id, handle, seen_at, payout_kind, payout_wallet, payout_confirmed, settings_at) VALUES ('5151', 'chosen', 0, 'wallet', 'So11111111111111111111111111111111111111112', 1, 1)").run()
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0', PER_AUTHOR_COOLDOWN_SECONDS: '0' }), env: { X_HANDLE: H, PLATFORM_X_ID: '999' }, publicUrl: 'https://pumpfund.family' })
  await bot.poll()
  const row = (id) => db.prepare('SELECT * FROM mentions WHERE tweet_id = ?').get(id)
  assert.equal(row('500').for_handle, 'bob'); assert.equal(row('500').mode, 'creator', 'a launch for someone is always creator mode')
  assert.equal(row('502').for_handle, null, 'for yourself = an ordinary launch')
  assert.equal(row('503').for_handle, null, 'never for the bot itself')
  // the queue resolves each target before its launch claim (no chain here: we stop the launch at the claim by having no launcher)
  x.userInfoFails = true
  const d = await bot.processQueue()
  assert.equal(d.deferred, 'for-wait', 'a lookup outage waits, never guesses')
  assert.equal(row('500').for_id, null)
  x.userInfoFails = false
  db.prepare('UPDATE mentions SET next_try_at = 0').run()
  try { await bot.processQueue() } catch {} // resolves @bob, then the launch itself fails without a launcher
  assert.equal(row('500').for_id, '4242', 'the coin is keyed on the X id')
  assert.equal(row('500').for_handle, 'Bob', 'the handle as X spells it')
  const bob = db.prepare("SELECT payout_kind, payout_auto, payout_confirmed FROM users WHERE x_id = '4242'").get()
  assert.deepEqual({ ...bob }, { payout_kind: 'xmoney', payout_auto: 1, payout_confirmed: 0 }, 'X Money set up for an account that never chose')
  db.prepare("UPDATE mentions SET state = 'rejected' WHERE tweet_id = '500'").run()
  const r = await bot.processQueue()
  assert.equal(r.rejected, 'for-unknown')
  assert.equal(row('501').reply_state, 'pending', 'an unknown handle is answered')
  assert.match(row('501').reason, /@ghost was not found on X/)
  db.prepare("UPDATE mentions SET state = 'rejected' WHERE tweet_id IN ('502', '503')").run()
  try { await bot.processQueue() } catch {}
  assert.equal(row('504').for_id, '5151')
  const kept = db.prepare("SELECT payout_kind, payout_auto FROM users WHERE x_id = '5151'").get()
  assert.deepEqual({ ...kept }, { payout_kind: 'wallet', payout_auto: 0 }, 'an account that chose keeps its own payout')
})

test('launch reply and description say who the coin is for', () => {
  const text = launchedReply({ symbol: 'GM', name: 'GM', mint: 'Mint1111111111111111111111111111111111cash', forHandle: 'Bob' })
  assert.match(text, /Launched for @Bob: its creator rewards go to their X Money\./)
  assert.match(text, /CA: Mint1111111111111111111111111111111111cash$/)
  assert.ok(tweetLength(text) <= 280)
})

test('operator override: one post may pass the 24 h cashtag rule; every other rule still applies', () => {
  const db = openDb(':memory:')
  const g = guardConfig({ LAUNCH_RAMP: '0' })
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, created_at) VALUES ('M1', 'X', 'X', '1', 'a', 'FW1', ?)").run(now() - 3600)
  const s = { authorId: '7', authorHandle: 'pix', authorFollowers: 500, authorCreatedAt: now() - 400 * 86400, symbol: 'X' }
  assert.equal(checkGuards(db, g, s).code, 'ticker-taken')
  assert.equal(checkGuards(db, g, { ...s, tickerOverride: true }).allowed, true)
  assert.equal(checkGuards(db, g, { ...s, tickerOverride: true, authorFollowers: 3 }).allowed, false, 'the follower rule still applies')
})

// ── launching on the site (13 Nov) ──
import { ComputeBudgetProgram as CB, SystemProgram as SP, TransactionInstruction as TI, TransactionMessage as TM, VersionedTransaction as VT } from '@solana/web3.js'
import { LIGHTHOUSE, SiteError, cleanFor, sameLaunch, signedBy, validateSiteLaunch } from '../api/sitelaunch.mjs'
import { siteFields, pinOnce } from '../api/launch.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('site launch form: fields are cleaned and checked before anything is pinned (all of it is permanent on chain)', () => {
  const ok = validateSiteLaunch({ for: 'bob', symbol: '$doge', name: '  Doge​   Coin ', description: 'much‮ wow', website: 'doge.example/path', twitter: '@dogecoin', telegram: 't.me/doge', mode: 'creator', image: PNG.toString('base64'), devBuy: { wallet: Keypair.generate().publicKey.toBase58(), sol: '0.5' } })
  assert.equal(ok.symbol, 'DOGE')
  assert.equal(ok.name, 'Doge Coin', 'zero-width characters and runs of spaces are gone')
  assert.equal(ok.description, 'much wow')
  assert.equal(ok.website, 'https://doge.example/path')
  assert.equal(ok.twitter, 'https://x.com/dogecoin')
  assert.equal(ok.telegram, 'https://t.me/doge')
  assert.equal(ok.devBuy.lamports, 500_000_000)
  assert.ok(ok.image.equals(PNG))
  // nothing else written: the name is the ticker, no dev buy, one account at 100%
  const bare = validateSiteLaunch({ symbol: 'frog', for: '@bob', devBuy: { sol: '' } })
  assert.deepEqual([bare.name, bare.mode, bare.devBuy, bare.website], ['FROG', 'creator', null, ''])
  assert.deepEqual(bare.recipients, [{ kind: 'x', handle: 'bob', bps: 10000 }])
  // ⭐ Pump Fund: rewards are always the named accounts'. A request cannot ask for holders or a pair.
  const pushy = validateSiteLaunch({ symbol: 'frog', mode: 'holders', pair: 'BONK', for: ' @Some_One ' })
  assert.deepEqual([pushy.mode, pushy.pair, pushy.recipients[0].handle], ['creator', undefined, 'Some_One'])
  // the handle as people paste it
  for (const [raw, want] of [['@bob', 'bob'], ['bob', 'bob'], ['https://x.com/bob', 'bob'], ['x.com/Bob_1?s=20', 'Bob_1'], ['bob smith!', null], ['https://twitter.com/Bob_1/status/1', 'Bob_1'], ['', ''], ['\u200b@bob\u200b', 'bob']]) {
    if (want === null) assert.throws(() => cleanFor(raw), SiteError)
    else assert.equal(cleanFor(raw), want, raw)
  }
  const bad = (body, re) => assert.throws(() => validateSiteLaunch(body), (e) => e instanceof SiteError && re.test(e.message), JSON.stringify(body))
  bad({}, /ticker/)
  bad({ symbol: 'ABCDEFGHIJK' }, /up to 10/)
  bad({ symbol: '1DOGE' }, /starting with a letter/)
  bad({ symbol: 'DO GE' }, /letters and numbers/)
  bad({ symbol: 'A', name: '猫'.repeat(11) }, /up to 32/) // 33 bytes: pump.fun counts bytes
  bad({ symbol: 'A', description: 'x'.repeat(501) }, /description/)
  bad({ symbol: 'A' }, /Name the X account/) // ⛔ no launch without a recipient: the launcher never gets the rewards by default
  bad({ symbol: 'A', for: 'sixteen_chars_xx' }, /X handle/)
  bad({ symbol: 'A', for: 'bob; drop' }, /X handle/)
  bad({ symbol: 'A', for: '$bob' }, /X handle/)
  bad({ for: 'bob', symbol: 'A', website: 'javascript:alert(1)' }, /website/)
  bad({ for: 'bob', symbol: 'A', website: 'http://user:pw@evil.example' }, /website/)
  bad({ for: 'bob', symbol: 'A', twitter: 'https://evil.example/x.com' }, /X link/)
  bad({ for: 'bob', symbol: 'A', telegram: 'https://x.com/a' }, /Telegram/)
  bad({ for: 'bob', symbol: 'A', image: Buffer.from('<svg onload=alert(1)>').toString('base64') }, /PNG, JPG/)
  bad({ for: 'bob', symbol: 'A', devBuy: { sol: '0.5' } }, /Connect the wallet/)
  bad({ for: 'bob', symbol: 'A', devBuy: { sol: '0.0001', wallet: Keypair.generate().publicKey.toBase58() } }, /smallest/)
  bad({ for: 'bob', symbol: 'A', devBuy: { sol: '51', wallet: Keypair.generate().publicKey.toBase58() } }, /largest/)
  bad({ for: 'bob', symbol: 'A', devBuy: { sol: '1', wallet: PublicKey.findProgramAddressSync([Buffer.from('x')], SP.programId)[0].toBase58() } }, /program account/)
})

test('site launch: the signed message must be the launch we built; a wallet may only add its own guard instructions', () => {
  const launcher = Keypair.generate(), mint = Keypair.generate(), buyer = Keypair.generate(), thief = Keypair.generate()
  const bh = Keypair.generate().publicKey.toBase58()
  const ours = [CB.setComputeUnitLimit({ units: 400_000 }), SP.transfer({ fromPubkey: launcher.publicKey, toPubkey: mint.publicKey, lamports: 890_880 }),
    new TI({ programId: Keypair.generate().publicKey, keys: [{ pubkey: mint.publicKey, isSigner: true, isWritable: true }, { pubkey: buyer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) })]
  const msg = (ixs, blockhash = bh) => new TM({ payerKey: launcher.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
  const who = { launcher: launcher.publicKey, mint: mint.publicKey, buyer: buyer.publicKey }
  const guardIx = (keys) => new TI({ programId: new PublicKey(LIGHTHOUSE), keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data: Buffer.from([9]) })
  const original = msg(ours)
  assert.deepEqual(sameLaunch(original, msg(ours), who), { ok: true, changed: false })
  assert.deepEqual(sameLaunch(original, msg([...ours, guardIx([buyer.publicKey])]), who), { ok: true, changed: true }, 'Phantom-style guard on the buyer account')
  const refused = (m, re) => { const r = sameLaunch(original, m, who); assert.equal(r.ok, false); assert.match(r.reason, re) }
  refused(msg([...ours, SP.transfer({ fromPubkey: launcher.publicKey, toPubkey: thief.publicKey, lamports: 1e9 })]), /not part of the launch/)
  refused(msg([...ours, guardIx([launcher.publicKey])]), /names the launch wallet/)
  refused(msg(ours.slice(0, 2)), /other signers|missing/)
  refused(msg([ours[0], SP.transfer({ fromPubkey: launcher.publicKey, toPubkey: thief.publicKey, lamports: 890_880 }), ours[2]]), /not part of the launch/)
  refused(msg(ours, Keypair.generate().publicKey.toBase58()), /blockhash/)
  refused(new TM({ payerKey: buyer.publicKey, recentBlockhash: bh, instructions: ours }).compileToV0Message(), /other signers/)

  // the buyer's signature is checked against the exact bytes we will send
  const tx = new VT(original); tx.sign([buyer])
  const at = original.staticAccountKeys.findIndex((k) => k.equals(buyer.publicKey))
  assert.equal(signedBy(buyer.publicKey, original.serialize(), tx.signatures[at]), true)
  assert.equal(signedBy(thief.publicKey, original.serialize(), tx.signatures[at]), false)
  assert.equal(signedBy(buyer.publicKey, msg([...ours, guardIx([buyer.publicKey])]).serialize(), tx.signatures[at]), false)
  assert.equal(signedBy(buyer.publicKey, original.serialize(), new Uint8Array(64)), false)
})

test('site launch metadata: the form\'s picture and links, sensible defaults, and one pin per exact content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-site-'))
  const { storeImage } = await import('../api/images.mjs')
  const file = storeImage({ logoDir: dir, publicUrl: 'https://pumpfund.family' }, PNG).split('/').pop()
  const full = siteFields({ mention: { symbol: 'DOGE', author_handle: 'alice', opts: JSON.stringify({ description: 'much wow', website: 'https://doge.example/', twitter: 'https://x.com/doge', telegram: 'https://t.me/doge', imageFile: file }) }, publicUrl: 'https://pumpfund.family', logoDir: dir })
  assert.deepEqual([full.description, full.website, full.twitter, full.telegram, full.img.source], ['much wow', 'https://doge.example/', 'https://x.com/doge', 'https://t.me/doge', 'upload'])
  assert.ok(full.img.bytes.equals(PNG))
  const bare = siteFields({ mention: { symbol: 'DOGE', author_handle: 'alice', opts: JSON.stringify({ imageFile: '../../etc/passwd' }) }, publicUrl: 'https://pumpfund.family', logoDir: dir })
  assert.deepEqual([bare.description, bare.website, bare.twitter, bare.telegram, bare.img.source], ['$DOGE was launched by @alice on Pump Fund. Its creator rewards go to @alice: pumpfund.family', SITE_URL, 'https://x.com/alice', '', 'logo'])
  // launched for someone: the default description names whose rewards they are
  const forBob = siteFields({ mention: { symbol: 'DOGE', author_handle: 'alice', for_id: '7', for_handle: 'Bob', opts: '{}' }, publicUrl: 'https://pumpfund.family', logoDir: dir })
  assert.equal(forBob.description, '$DOGE was launched for @Bob by @alice on Pump Fund. Its creator rewards go to @Bob: pumpfund.family')
  assert.ok(forBob.description.length < 200)
  const db = openDb(':memory:')
  let calls = 0
  const pin = async () => ({ uri: `https://gateway.pinata.cloud/ipfs/meta${++calls}`, imageUri: 'https://gateway.pinata.cloud/ipfs/img' })
  const f = { image: PNG, imageType: 'image/png', name: 'Doge', symbol: 'DOGE', description: 'd', website: 'w', twitter: 't', telegram: '' }
  assert.equal((await pinOnce(db, pin, f)).uri, (await pinOnce(db, pin, { ...f })).uri)
  assert.equal(calls, 1, 'the same content again pins nothing')
  await pinOnce(db, pin, { ...f, description: 'other' })
  assert.equal(calls, 2)
})

test('a store made before site launches gains the source column, and old rows read as posts', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, updated_at) VALUES ('1', '1', 'a', 't', 0, 0, 'queued', 0)").run()
  assert.equal(db.prepare("SELECT source FROM mentions WHERE tweet_id = '1'").get().source, 'x')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'site_drafts'").get())
})

test('mint keys: only an address ending in fund enters the pool, and each key is handed out once', async () => {
  const { addKey, issueKey, SUFFIX, freshCount } = await import('../api/vanity.mjs')
  assert.equal(SUFFIX, 'fund')
  const db = openDb(':memory:')
  assert.throws(() => addKey(db, Keypair.generate()), /not a fund key/)
  assert.equal(freshCount(db), 0)
  // a real ground key from this repo's grinder, when one is on disk (keys/ is never committed)
  const { readdirSync, readFileSync, existsSync } = await import('node:fs')
  const dir = new URL('../keys/mainnet/vanity-extra/', import.meta.url)
  const f = existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith('fund.json')) : null
  if (!f) return
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(f, dir), 'utf8'))))
  assert.ok(kp.publicKey.toBase58().endsWith('fund'))
  addKey(db, kp)
  assert.equal(issueKey(db, 'a').publicKey.toBase58(), kp.publicKey.toBase58())
  assert.equal(issueKey(db, 'b'), null, 'issued once')
})

// ── splits (13 Nov) ──
test('splits on the form: up to 5 accounts, whole percentages of at least 5, 100 together, nobody twice', async () => {
  const { cleanRecipients } = await import('../api/sitelaunch.mjs')
  assert.deepEqual(cleanRecipients({ recipients: [{ handle: '@bob', pct: 70 }, { handle: 'x.com/carol', pct: '30' }] }), [{ kind: 'x', handle: 'bob', bps: 7000 }, { kind: 'x', handle: 'carol', bps: 3000 }])
  assert.deepEqual(cleanRecipients({ recipients: [{ handle: 'a', pct: 5 }, { handle: 'b', pct: 95 }, { handle: '', pct: '' }] }).map((r) => r.bps), [500, 9500], 'an untouched empty row is ignored')
  assert.equal(cleanRecipients({ recipients: ['a', 'b', 'c', 'd', 'e'].map((h) => ({ handle: h, pct: 20 })) }).length, 5)
  const bad = (recipients, re) => assert.throws(() => cleanRecipients({ recipients }), (e) => e instanceof SiteError && re.test(e.message), JSON.stringify(recipients))
  bad([], /Name the X account/)
  bad([{ handle: '', pct: 100 }], /Name the X account/)
  bad([{ handle: 'a', pct: 96 }, { handle: 'b', pct: 4 }], /at least 5%/)
  bad([{ handle: 'a', pct: 60 }, { handle: 'b', pct: 30 }], /add up to 100%/)
  bad([{ handle: 'a', pct: 60 }, { handle: 'b', pct: 50 }], /add up to 100%/)
  bad([{ handle: 'a', pct: 50.5 }, { handle: 'b', pct: 49.5 }], /whole percentage/)
  bad([{ handle: 'a', pct: 'half' }, { handle: 'b', pct: 50 }], /whole percentage/)
  bad([{ handle: 'bob', pct: 50 }, { handle: '@BOB', pct: 50 }], /listed once/)
  bad(['a', 'b', 'c', 'd', 'e', 'f'].map((h, i) => ({ handle: h, pct: i ? 10 : 50 })), /up to 5/)
  bad([{ handle: 'not a handle!', pct: 100 }], /X handle/)
})

test('splits in the ledger: every credit is divided to the unit, each account can only be paid its own part, and the parts always add up to the bucket', async () => {
  const { splitAmount, shareOf, sharesOf, mintsOf } = await import('../api/db.mjs')
  const { creditSurplus } = await import('../api/keeper.mjs')
  const { launchShares } = await import('../api/launch.mjs')
  // the arithmetic: rounded down, the leftover to the first-named account, never a unit lost or made
  for (const [amount, bps] of [[100, [7000, 3000]], [1, [5000, 5000]], [999_999_937, [500, 500, 3333, 3333, 2334]], [7, [9500, 500]], [0, [6000, 4000]]]) {
    const parts = splitAmount(amount, bps.map((b, i) => ({ id: String(i), bps: b })))
    assert.equal(parts.reduce((t, p) => t + p.amount, 0), amount, `${amount} over ${bps}`)
    parts.forEach((p, i) => { if (i) assert.equal(p.amount, Math.floor((amount * p.bps) / 10000)) })
  }
  const db = openDb(':memory:')
  const coin = (mint, creator) => db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at) VALUES (?, 'n', 'S', ?, 'h', ?, 'creator', 0)").run(mint, creator, `fw-${mint}`)
  coin('SPLIT', '1'); coin('SOLO', '1')
  for (const [slot, id, bps] of [[0, '1', 6000], [1, '2', 3500], [2, '3', 500]]) db.prepare("INSERT INTO token_shares (mint, slot, kind, recipient_id, handle, bps) VALUES ('SPLIT', ?, 'x', ?, ?, ?)").run(slot, id, `u${id}`, bps)
  assert.deepEqual(sharesOf(db, 'SOLO'), [{ slot: 0, kind: 'x', id: '1', handle: 'h', bps: 10000 }], 'a coin without share rows has one owner')
  // 1,000,003 lamports above the rent floor arrive: 600,001 + 350,001 + 50,000 with the 1 left over to the first account
  assert.equal(creditSurplus(db, { mint: 'SPLIT' }, 890_880 + 1_000_003), 1_000_003)
  assert.deepEqual(['1', '2', '3'].map((id) => shareOf(db, 'SPLIT', id).owed), [600_002, 350_001, 50_000])
  assert.equal(buckets(db, 'SPLIT').creator, 1_000_003)
  assert.equal(creditSurplus(db, { mint: 'SPLIT' }, 890_880 + 1_000_003), 0, 'the same balance again is not new money')
  // account 2 is paid its part: the others' parts are untouched, and an expired payout gives the part back
  const out = db.prepare("INSERT INTO outflows (mint, bucket, lamports, kind, destination, x_id, state, time) VALUES ('SPLIT', 'creator', 350001, 'payout', 'w', '2', 'sending', 0)").run().lastInsertRowid
  assert.deepEqual(['1', '2', '3'].map((id) => shareOf(db, 'SPLIT', id).owed), [600_002, 0, 50_000])
  assert.equal(['1', '2', '3'].reduce((t, id) => t + shareOf(db, 'SPLIT', id).owed, 0), buckets(db, 'SPLIT').creator, 'the parts add up to the bucket')
  db.prepare("UPDATE outflows SET state = 'expired' WHERE id = ?").run(out)
  assert.equal(shareOf(db, 'SPLIT', '2').owed, 350_001)
  assert.deepEqual(owedTo(db, '2'), { total: 350_001, perCoin: [{ mint: 'SPLIT', lamports: 350_001 }] })
  assert.equal(owedTo(db, '9').total, 0, 'a stranger is owed nothing')
  assert.deepEqual(mintsOf(db, '1').sort(), ['SOLO', 'SPLIT'])
  // the shares a launch records: the form's, or the single account; a malformed split is refused before anything is sent
  assert.deepEqual(launchShares({ author_id: '5', author_handle: 'd', for_id: '7', for_handle: 'Bob', opts: null }), [{ kind: 'x', id: '7', handle: 'Bob', bps: 10000 }])
  const m = (shares) => ({ author_id: '5', author_handle: 'd', for_id: '7', for_handle: 'Bob', opts: JSON.stringify({ shares }) })
  assert.deepEqual(launchShares(m([{ id: '7', handle: 'Bob', bps: 7000 }, { id: '8', handle: 'Cy', bps: 3000 }])).map((r) => [r.id, r.bps]), [['7', 7000], ['8', 3000]])
  for (const bad of [[{ id: '7', bps: 7000 }, { id: '8', bps: 2000 }], [{ id: '7', bps: 9900 }, { id: '8', bps: 100 }], [{ id: '7', bps: 5000 }, { id: '7', bps: 5000 }], [{ id: 'x', bps: 10000 }], [{ id: '7', bps: 5000.5 }, { id: '8', bps: 4999.5 }]])
    assert.throws(() => launchShares(m(bad)), /malformed/, JSON.stringify(bad))
})

// ── GitHub accounts and charities as recipients (Pumpfun's own fee sharing, 13 Nov) ──
test('recipient kinds on the form: X by default, a GitHub username, a charity only by its directory id', async () => {
  const { cleanRecipients } = await import('../api/sitelaunch.mjs')
  const { cleanLogin } = await import('../api/github.mjs')
  const { charityById, searchCharities, charityCount } = await import('../api/charities.mjs')
  const JUDE = '0xdc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46'
  assert.deepEqual(cleanRecipients({ recipients: [{ handle: 'bob', pct: 50 }, { kind: 'github', handle: 'github.com/Octocat', pct: 30 }, { kind: 'charity', handle: JUDE.toUpperCase().replace('0X', '0x'), pct: 20 }] }),
    [{ kind: 'x', handle: 'bob', bps: 5000 }, { kind: 'github', handle: 'Octocat', bps: 3000 }, { kind: 'charity', handle: JUDE, bps: 2000 }])
  // the same name as an X account and as a GitHub account are two recipients; the same one twice is not
  assert.equal(cleanRecipients({ recipients: [{ handle: 'bob', pct: 50 }, { kind: 'github', handle: 'bob', pct: 50 }] }).length, 2)
  const bad = (recipients, re) => assert.throws(() => cleanRecipients({ recipients }), (e) => e instanceof SiteError && re.test(e.message), JSON.stringify(recipients))
  bad([{ kind: 'github', handle: 'Bob', pct: 50 }, { kind: 'github', handle: 'bob', pct: 50 }], /listed once/)
  bad([{ kind: 'github', handle: '-bad-', pct: 100 }], /GitHub username/)
  bad([{ kind: 'github', handle: 'a--b', pct: 100 }], /GitHub username/)
  bad([{ kind: 'charity', handle: 'St. Jude', pct: 100 }], /from the list/) // ⛔ never a typed name or id
  bad([{ kind: 'charity', handle: '0x1234', pct: 100 }], /from the list/)
  bad([{ kind: 'wallet', handle: 'So11111111111111111111111111111111111111112', pct: 100 }], /X account, a GitHub account, a charity/)
  for (const [raw, want] of [['@octocat', 'octocat'], ['https://github.com/torvalds/linux', 'torvalds'], ['a', 'a'], ['', ''], ['has space', 'hasspace'], ['under_score', null], ['x'.repeat(40), null]]) assert.equal(cleanLogin(raw), want, raw)
  // the directory: found by words in any order, the id looked up exactly, a made-up id is nobody
  assert.ok(charityCount() > 2000)
  assert.equal(charityById(JUDE).name, "St. Jude Children's Research Hospital")
  assert.equal(charityById(JUDE.toUpperCase().replace('0X', '0x')).id, JUDE)
  assert.equal(charityById('0x' + '11'.repeat(32)), null)
  assert.ok(searchCharities('jude st').some((c) => c.id === JUDE))
  assert.deepEqual(searchCharities('   '), [])
  for (const c of searchCharities('ranch', 12)) assert.doesNotMatch(c.name, /--|[\u2013\u2014]/)
})

test('a natively split coin: what goes on chain, what our ledger divides, and which launches are refused before anything is sent', async () => {
  const { nativeShareholders, isNative } = await import('../api/nativesplit.mjs')
  const { launchShares } = await import('../api/launch.mjs')
  const { socialFeeAddress, donationFeeAddress, charityKey, sameShareholders } = await import('../lib/feeshare.mjs')
  const { splitAmount, ledgerShares } = await import('../api/db.mjs')
  const { creditSurplus } = await import('../api/keeper.mjs')
  const JUDE = '0xdc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46'
  const mint = Keypair.generate().publicKey, fw = Keypair.generate().publicKey
  const shares = [{ kind: 'x', id: '7', handle: 'Bob', bps: 3000 }, { kind: 'github', id: '583231', handle: 'octocat', bps: 2500 }, { kind: 'x', id: '8', handle: 'Cy', bps: 2000 }, { kind: 'charity', id: JUDE, handle: 'St. Jude', bps: 2500 }]
  assert.equal(isNative(shares), true)
  assert.equal(isNative(shares.filter((s) => s.kind === 'x')), false)
  // on chain: ONE shareholder for both X accounts (their 50% together, our reward wallet), then GitHub and the charity
  const want = nativeShareholders(mint, fw, shares)
  assert.deepEqual(want.map((h) => [h.kind, h.bps, h.address.toBase58()]), [['wallet', 5000, fw.toBase58()], ['github', 2500, socialFeeAddress('583231').toBase58()], ['charity', 2500, donationFeeAddress(mint, JUDE).toBase58()]])
  // the address rules proven on mainnet: a GitHub account's is the same for every coin, a charity's is per coin
  assert.equal(socialFeeAddress('583231').toBase58(), socialFeeAddress(583231).toBase58())
  assert.notEqual(donationFeeAddress(mint, JUDE).toBase58(), donationFeeAddress(Keypair.generate().publicKey, JUDE).toBase58())
  assert.equal(Buffer.from(charityKey(JUDE).toBytes()).toString('hex'), JUDE.slice(2))
  assert.throws(() => socialFeeAddress('octocat'), /numeric/)
  // no X account at all: the reward wallet is not a shareholder
  assert.deepEqual(nativeShareholders(mint, fw, [shares[1], shares[3]]).map((h) => h.kind), ['github', 'charity'])
  // what the chain must hold after the lock: these, in this order, locked
  const cfg = { locked: true, shareholders: want.map((h) => ({ address: h.address.toBase58(), bps: h.bps })) }
  assert.equal(sameShareholders(cfg, want), true)
  assert.equal(sameShareholders({ ...cfg, locked: false }, want), false)
  assert.equal(sameShareholders({ locked: true, shareholders: [...cfg.shareholders].reverse() }, want), false)
  // our ledger divides what reaches the reward wallet between the X accounts only, 3000:2000
  const db = openDb(':memory:')
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at, share_config) VALUES ('N', 'n', 'S', '7', 'Bob', 'fwN', 'creator', 0, 'cfg')").run()
  shares.forEach((s, i) => db.prepare("INSERT INTO token_shares (mint, slot, kind, recipient_id, handle, bps) VALUES ('N', ?, ?, ?, ?, ?)").run(i, s.kind, s.id, s.handle, s.bps))
  assert.deepEqual(ledgerShares(db, 'N').map((s) => s.id), ['7', '8'])
  assert.equal(creditSurplus(db, { mint: 'N' }, 890_880 + 1_000_001), 1_000_001)
  assert.deepEqual([owedTo(db, '7').total, owedTo(db, '8').total, owedTo(db, '583231').total], [600_001, 400_000, 0], 'a GitHub id is never an X id in our books')
  assert.deepEqual(splitAmount(10, [{ bps: 2500 }, { bps: 2500 }]).map((p) => p.amount), [5, 5])
  // the launch's own last check: a charity id that is not in the directory, or a GitHub login instead of an id, never launches
  const m = (list) => ({ author_id: '5', author_handle: 'd', opts: JSON.stringify({ shares: list }) })
  assert.equal(launchShares(m(shares)).length, 4)
  assert.equal(launchShares(m([{ kind: 'charity', id: JUDE.toUpperCase().replace('0X', '0x'), handle: 'x', bps: 10000 }]))[0].id, JUDE)
  for (const bad of [[{ kind: 'charity', id: '0x' + '22'.repeat(32), bps: 10000 }], [{ kind: 'github', id: 'octocat', bps: 10000 }], [{ kind: 'x', id: '7', bps: 5000 }, { kind: 'x', id: '7', bps: 5000 }], [{ kind: 'bank', id: '7', bps: 10000 }]])
    assert.throws(() => launchShares(m(bad)), /malformed/, JSON.stringify(bad))
  assert.equal(launchShares(m([{ kind: 'x', id: '7', bps: 5000 }, { kind: 'github', id: '7', bps: 5000 }])).length, 2, 'x:7 and github:7 are two different recipients')
})

// ── payment apps as recipients (Venmo, Cash App, Zelle, Chime via Peer, 13 Nov) ──
test('payment apps: payees are cleaned to the form Peer pays, keyed lowercase, a Zelle payee is masked wherever it is shown', async () => {
  const { cleanPayee, appKey, parseAppKey, appShown, isOurs, APP_KINDS } = await import('../api/rails.mjs')
  assert.deepEqual(APP_KINDS, ['venmo', 'cashapp', 'chime', 'zelle', 'paypal'])
  for (const [kind, raw, want] of [
    ['venmo', '@Jane-Doe', 'Jane-Doe'], ['venmo', 'ab', null], ['venmo', 'has space', null], ['venmo', 'x'.repeat(31), null],
    ['cashapp', '$Jane', 'Jane'], ['cashapp', '$$jane99', 'jane99'], ['cashapp', '12345', null], ['cashapp', 'a'.repeat(21), null], ['cashapp', 'jane-doe', null],
    ['chime', '$Jane', '$jane'], ['chime', 'jane', '$jane'], ['chime', '$', null],
    ['zelle', ' Jane.Doe@Example.com ', 'jane.doe@example.com'], ['zelle', '(212) 555-0100', '2125550100'], ['zelle', '+1 212 555 0100', '2125550100'],
    ['zelle', '555-0100', null], ['zelle', '1125550100', null], ['zelle', 'not an email', null],
    ['venmo', 'Jane​-Doe', 'Jane-Doe'], // a zero-width character is stripped, never kept in a payee
    ['wise', 'jane', null], ['x', 'jane', null],
  ]) assert.equal(cleanPayee(kind, raw), want, `${kind} ${raw}`)
  assert.equal(appKey('venmo', 'Jane-Doe'), 'venmo:jane-doe')
  assert.deepEqual(parseAppKey('zelle:jane@x.com'), { kind: 'zelle', payee: 'jane@x.com' })
  assert.equal(parseAppKey('1234567'), null, 'an X id is not an app key')
  assert.equal(appShown('zelle', 'jane.doe@example.com'), 'Zelle j•••@example.com')
  assert.equal(appShown('zelle', '2125550100'), 'Zelle (•••) •••-0100')
  assert.equal(appShown('cashapp', 'Jane'), 'Cash App $Jane')
  assert.equal(appShown('chime', '$jane'), 'Chime $jane')
  assert.ok(isOurs('x') && isOurs('venmo') && isOurs(undefined) && !isOurs('github') && !isOurs('charity'))
})

test('payment apps on the form and in the ledger: splittable with X accounts, paid by our ledger (never Pumpfun fee sharing), a dev buy is allowed, a forged key is refused', async () => {
  const { cleanRecipients } = await import('../api/sitelaunch.mjs')
  const { launchShares } = await import('../api/launch.mjs')
  const { nativeShareholders, isNative } = await import('../api/nativesplit.mjs')
  const { creditSurplus } = await import('../api/keeper.mjs')
  const { mintsOf, ledgerShares } = await import('../api/db.mjs')
  assert.deepEqual(cleanRecipients({ recipients: [{ handle: 'bob', pct: 60 }, { kind: 'venmo', handle: '@Jane-Doe', pct: 25 }, { kind: 'cashapp', handle: '$Jane', pct: 15 }] }),
    [{ kind: 'x', handle: 'bob', bps: 6000 }, { kind: 'venmo', handle: 'Jane-Doe', bps: 2500 }, { kind: 'cashapp', handle: 'Jane', bps: 1500 }])
  const bad = (recipients, re) => assert.throws(() => cleanRecipients({ recipients }), (e) => e instanceof SiteError && re.test(e.message), JSON.stringify(recipients))
  bad([{ kind: 'venmo', handle: 'Jane-Doe', pct: 50 }, { kind: 'venmo', handle: '@jane-doe', pct: 50 }], /listed once/)
  bad([{ kind: 'zelle', handle: 'nope', pct: 100 }], /valid Zelle email or US phone number/)
  bad([{ kind: 'wise', handle: 'jane', pct: 100 }], /Zelle, Chime or PayPal/)
  // launchShares: the key must be exactly the cleaned payee's key
  const m = (shares) => ({ author_id: '5', author_handle: 'd', for_id: '7', for_handle: 'Bob', opts: JSON.stringify({ shares }) })
  const good = [{ kind: 'x', id: '7', handle: 'Bob', bps: 5000 }, { kind: 'venmo', id: 'venmo:jane-doe', handle: 'Jane-Doe', bps: 5000 }]
  assert.deepEqual(launchShares(m(good)).map((r) => [r.kind, r.id]), [['x', '7'], ['venmo', 'venmo:jane-doe']])
  for (const forged of [[{ kind: 'venmo', id: 'venmo:someone-else', handle: 'Jane-Doe', bps: 10000 }], [{ kind: 'venmo', id: 'venmo:jane-doe', handle: '@Jane-Doe', bps: 10000 }], [{ kind: 'cashapp', id: '7', handle: 'Jane', bps: 10000 }]])
    assert.throws(() => launchShares(m(forged)), /malformed/, JSON.stringify(forged))
  // not native: the whole creator reward reaches our reward wallet; with a GitHub account too, ours is ONE shareholder
  assert.equal(isNative(good), false)
  const fw = Keypair.generate().publicKey
  const withGh = [...good.map((s) => ({ ...s, bps: s.bps * 0.8 })), { kind: 'github', id: '583231', bps: 2000 }]
  assert.equal(isNative(withGh), true)
  assert.deepEqual(nativeShareholders(Keypair.generate().publicKey, fw, withGh).map((h) => [h.kind, h.bps]), [['wallet', 8000], ['github', 2000]])
  // the ledger: one credit row per recipient under its key; the app account's mints and balance are found by that key
  const db = openDb(':memory:')
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at) VALUES ('APP', 'n', 'S', '7', 'Bob', 'fw-APP', 'creator', 0)").run()
  good.forEach((s, i) => db.prepare('INSERT INTO token_shares (mint, slot, kind, recipient_id, handle, bps) VALUES (?, ?, ?, ?, ?, ?)').run('APP', i, s.kind, s.id, s.handle, s.bps))
  assert.equal(ledgerShares(db, 'APP').length, 2)
  assert.equal(creditSurplus(db, { mint: 'APP' }, 890_880 + 1_000_001), 1_000_001)
  assert.deepEqual([owedTo(db, '7').total, owedTo(db, 'venmo:jane-doe').total], [500_001, 500_000])
  assert.deepEqual(mintsOf(db, 'venmo:jane-doe'), ['APP'])
  assert.deepEqual(mintsOf(db, 'Jane-Doe'), [], 'only by its key')
})

test('payment apps: a payee nobody pays backs off (7 days per unfilled payout in a row) and stops after 3; a paid payout resets it', async () => {
  const { appMayStart, xmoneyConfig } = await import('../api/xmoney.mjs')
  const db = openDb(':memory:')
  const cfg = xmoneyConfig({})
  const key = 'venmo:jane-doe', t0 = 1_800_000_000
  const done = (paid, back, at, listed = 1) => db.prepare("INSERT INTO xmoney_payouts (x_id, handle, platform, state, paid_usd, returned_lamports, listed_at, created_at, updated_at, done_at) VALUES (?, 'Jane-Doe', 'venmo', 'done', ?, ?, ?, 0, 0, ?)").run(key, paid, back, listed, at)
  assert.deepEqual(appMayStart(db, key, cfg, t0), { ok: true })
  done(5, 0, t0)
  assert.deepEqual(appMayStart(db, key, cfg, t0), { ok: true }, 'paid: go again at once')
  done(0, 1000, t0)
  assert.equal(appMayStart(db, key, cfg, t0 + 6 * 86400).ok, false)
  assert.equal(appMayStart(db, key, cfg, t0 + 7 * 86400).ok, true)
  done(0, 1000, t0 + 7 * 86400)
  assert.equal(appMayStart(db, key, cfg, t0 + 20 * 86400).ok, false, 'two in a row: 14 days')
  assert.equal(appMayStart(db, key, cfg, t0 + 21 * 86400).ok, true)
  done(0, 1000, t0 + 21 * 86400)
  assert.match(appMayStart(db, key, cfg, t0 + 400 * 86400).why, /3 payouts in a row found nobody/)
  done(9, 0, t0 + 401 * 86400) // the operator paid it by hand, or a late buyer
  assert.equal(appMayStart(db, key, cfg, t0 + 401 * 86400).ok, true)
})

test('review 15 Nov: the back-off counts only payouts Peer could not get paid; ones that never reached Peer are skipped; it applies to X accounts too', async () => {
  const { appMayStart, xmoneyConfig } = await import('../api/xmoney.mjs')
  const db = openDb(':memory:')
  const cfg = xmoneyConfig({}), t0 = 1_800_000_000
  const ins = (key, f) => db.prepare("INSERT INTO xmoney_payouts (x_id, handle, platform, state, paid_usd, returned_lamports, return_usdc, listed_at, list_attempts, created_at, updated_at, done_at) VALUES (?, 'h', ?, 'done', ?, ?, ?, ?, ?, ?, 0, ?)")
    .run(key, f.platform ?? 'venmo', f.paid ?? 0, f.back ?? 0, f.ret ?? 0, f.listed ?? null, f.tries ?? 0, f.made ?? 0, f.at)
  // three bridges that failed (the SOL came back, never listed): says nothing about the payee
  for (let i = 0; i < 3; i++) ins('venmo:a', { back: 1e8, at: t0 + i })
  assert.deepEqual(appMayStart(db, 'venmo:a', cfg, t0 + 10), { ok: true })
  // a PayPal that was not connected yet (USDC came home, never listed, Peer did not refuse the payee as such)
  ins('paypal:b', { platform: 'paypal', ret: 5e6, back: 3e7, at: t0 })
  assert.deepEqual(appMayStart(db, 'paypal:b', cfg, t0 + 10), { ok: true })
  // listed and unpaid, then an empty "nothing collected" row on top: the wait still holds (it used to be reset)
  ins('venmo:c', { back: 1e8, ret: 5e6, listed: 1, at: t0 })
  ins('venmo:c', { at: t0 + 5 })
  assert.equal(appMayStart(db, 'venmo:c', cfg, t0 + 86400).ok, false)
  // Peer refused to list the payee at all (list_attempts at the cap): counts as unpayable
  for (let i = 0; i < 3; i++) ins('venmo:d', { back: 1e8, ret: 5e6, tries: cfg.maxAttempts, at: t0 + i })
  assert.match(appMayStart(db, 'venmo:d', cfg, t0 + 400 * 86400).why, /stopped/)
  // an X account (digits): the same rule; saving its payout choice again (`since`) starts it afresh
  for (let i = 0; i < 3; i++) ins('4242', { platform: 'xmoney', back: 1e8, ret: 5e6, listed: 1, made: t0 + i, at: t0 + i })
  assert.match(appMayStart(db, '4242', cfg, t0 + 400 * 86400).why, /stopped/)
  assert.deepEqual(appMayStart(db, '4242', cfg, t0 + 400 * 86400, t0 + 100), { ok: true })
})

test('review 15 Nov: a listing Peer keeps refusing comes home after 5 tries; an X account that is gone comes home at once; a lookup outage waits', async () => {
  const { xmoneyConfig, xmoneyPass } = await import('../api/xmoney.mjs')
  const cfg = { ...xmoneyConfig({}), adoptSeconds: 0 }, quiet = { error() {}, info() {} }
  const base = { ethBalance: async () => 10n ** 18n }
  const mk = (xId, platform) => { const db = openDb(':memory:'); db.prepare("INSERT INTO xmoney_payouts (x_id, handle, platform, state, lamports, usdc, created_at, updated_at) VALUES (?, 'jane-doe', ?, 'listing', 100000000, 20000000, ?, ?)").run(xId, platform, now(), now()); return db }
  const row = (db) => db.prepare('SELECT * FROM xmoney_payouts').get()
  // a payment app Peer refuses
  let db = mk('venmo:jane-doe', 'venmo'), calls = 0
  let rails = { baseAddress: '0x0', base, peer: { orders: async () => [], cashout: async () => { calls++; throw new Error('payee not accepted') } } }
  for (let i = 0; i < 4; i++) await xmoneyPass({ db, conn: null, keeper: null, seed: Buffer.alloc(32), rails, cfg, log: quiet })
  assert.deepEqual([row(db).state, row(db).list_attempts, calls], ['listing', 4, 4])
  db.prepare("UPDATE xmoney_payouts SET state = 'done' WHERE 0").run()
  rails.relay = { quote: async () => { throw new Error('stop here') } }
  await xmoneyPass({ db, conn: null, keeper: { publicKey: { toBase58: () => 'K' } }, seed: Buffer.alloc(32), rails, cfg, log: quiet })
  assert.deepEqual([row(db).state, row(db).return_usdc, row(db).list_attempts], ['returning', 20000000, cfg.maxAttempts], 'the USDC goes home, marked as unpayable')
  assert.match(row(db).error, /could not be listed on Peer|stop here/)
  // an X account set up by a launch whose account no longer exists: home at once, never listed
  db = mk('777', 'xmoney'); calls = 0
  db.prepare("INSERT INTO users (x_id, handle, seen_at, payout_kind, payout_auto) VALUES ('777', 'gone', 0, 'xmoney', 1)").run()
  rails = { baseAddress: '0x0', base, handleOf: async () => null, peer: { orders: async () => [], cashout: async () => { calls++; return { depositId: 'e_1' } } } }
  await xmoneyPass({ db, conn: null, keeper: null, seed: Buffer.alloc(32), rails, cfg, log: quiet })
  assert.deepEqual([row(db).state, calls], ['returning', 0])
  // the lookup is down: it waits (30 tries), nothing is listed under a handle that was not confirmed
  db = mk('777', 'xmoney')
  db.prepare("INSERT INTO users (x_id, handle, seen_at, payout_kind, payout_auto) VALUES ('777', 'gone', 0, 'xmoney', 1)").run()
  rails.handleOf = async () => { throw new Error('503') }
  for (let i = 0; i < 6; i++) await xmoneyPass({ db, conn: null, keeper: null, seed: Buffer.alloc(32), rails, cfg, log: quiet })
  assert.deepEqual([row(db).state, row(db).list_attempts, calls], ['listing', 6, 0])
})

test('review 15 Nov: the launch cost grows with GitHub accounts / charities beyond two, so it covers what the launch wallet pays', async () => {
  const { nativeFeeLamports } = await import('../api/sitelaunch.mjs')
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => nativeFeeLamports(n) / 1e9), [0.025, 0.025, 0.028, 0.031, 0.034])
  // measured on a mainnet clone 15 Nov: what each mix cost the launch wallet
  for (const [n, cost] of [[1, 0.0188], [4, 0.0269], [5, 0.0285]]) assert.ok(nativeFeeLamports(n) / 1e9 > cost, `${n} recipients`)
})

test('review 15 Nov: a Relay refund is credited at what reached the keeper (never the full amount on Relay\'s word); a failed bridge is not final', async () => {
  const { xmoneyConfig, xmoneyPass, refundIn, REFUND_GAS_MAX } = await import('../api/xmoney.mjs')
  const cfg = xmoneyConfig({}), quiet = { error() {}, info() {} }, K = 'KEEPER', keeper = { publicKey: { toBase58: () => K } }
  const DEP = '5'.repeat(88), REF = '4'.repeat(88), OTHER = '3'.repeat(88), OWN = '2'.repeat(88)
  // the chain: txs by signature → the keeper's balance change, and whether the keeper signed
  const txs = { [REF]: { delta: 99_990_000, signed: false }, [OTHER]: { delta: 60_000_000, signed: false }, [OWN]: { delta: 99_995_000, signed: true } }
  const conn = {
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'finalized', err: null }] }),
    getSignaturesForAddress: async () => [OWN, OTHER, REF, DEP].filter((s) => s === DEP || txs[s]).map((signature) => ({ signature, err: null })),
    _rpcRequest: async (_m, [sig]) => { const t = txs[sig]; if (!t) return { result: null }
      return { result: { meta: { err: null, preBalances: [0, 1_000_000_000], postBalances: [0, 1_000_000_000 + t.delta] }, transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: t.signed ? [K, 'x'] : ['solver', K] } } } } },
  }
  const mk = () => { const db = openDb(':memory:'); db.prepare("INSERT INTO xmoney_payouts (x_id, handle, state, lamports, relay_sig, relay_lvh, relay_request, refund_mint, created_at, updated_at) VALUES ('42', 'bob', 'bridging', 100000000, ?, 1, 'req-1', 'M', ?, ?)").run(DEP, now(), now()); return db }
  const row = (db) => db.prepare('SELECT * FROM xmoney_payouts').get()
  const rails = (st) => ({ baseAddress: '0x0', relay: { status: async () => st } })
  const pass = (db, st) => xmoneyPass({ db, conn, keeper, seed: Buffer.alloc(32), rails: rails(st), cfg, log: quiet })
  // failed: waits (Relay may still fill it or refund it), nothing is credited
  let db = mk()
  await pass(db, { status: 'failure' })
  assert.deepEqual([row(db).state, row(db).returned_lamports], ['bridging', 0])
  // failed and Relay says it will not refund by itself: stopped for the operator, nothing credited
  await pass(db, { status: 'failure', refundFailReason: 'MANUAL_REFUND_REQUIRED' })
  assert.equal(row(db).state, 'failed'); assert.match(row(db).error, /MANUAL_REFUND_REQUIRED/)
  // refunded: exactly what arrived (deposit minus the refund's gas), found in the keeper's history; not a transaction
  // the keeper signed itself, not one of another size
  db = mk()
  await pass(db, { status: 'refund' })
  assert.deepEqual([row(db).state, row(db).returned_lamports, row(db).return_dest_tx], ['crediting', 99_990_000, REF])
  // a refund that has not arrived: waits, never credited blind
  delete txs[REF]
  db = mk()
  await pass(db, { status: 'refund' })
  assert.deepEqual([row(db).state, row(db).returned_lamports], ['bridging', 0])
  // a refund another payout was already matched to is not counted twice
  txs[REF] = { delta: 99_990_000, signed: false }
  db = mk()
  db.prepare("INSERT INTO xmoney_payouts (x_id, handle, state, return_dest_tx, created_at, updated_at) VALUES ('43', 'c', 'done', ?, 0, 0)").run(REF)
  assert.equal(await refundIn(db, conn, keeper, row(db), {}), null)
  assert.ok(REFUND_GAS_MAX <= 5_000_000)
})

test('review 15 Nov: a lost cashout is adopted from the order of its own corridor; a signed-in X account is listed under the handle it holds now', async () => {
  const { xmoneyConfig, xmoneyPass } = await import('../api/xmoney.mjs')
  const cfg = xmoneyConfig({}), quiet = { error() {}, info() {} }, base = { ethBalance: async () => 10n ** 18n }
  let db = openDb(':memory:')
  db.prepare("INSERT INTO xmoney_payouts (x_id, handle, platform, state, lamports, usdc, list_started_at, created_at, updated_at) VALUES ('venmo:jane-doe', 'jane-doe', 'venmo', 'listing', 1, 20000000, ?, ?, ?)").run(now(), now(), now())
  const orders = [{ depositId: 'e_zelle', totalAmount: '20000000', payouts: [{ platform: 'zelle' }] }, { depositId: 'e_venmo', totalAmount: '20000000', payouts: [{ platform: 'venmo' }] }]
  await xmoneyPass({ db, conn: null, keeper: null, seed: Buffer.alloc(32), rails: { baseAddress: '0x0', base, peer: { orders: async () => orders } }, cfg, log: quiet })
  assert.deepEqual({ ...db.prepare('SELECT state, deposit_id FROM xmoney_payouts').get() }, { state: 'listed', deposit_id: 'e_venmo' })
  // a confirmed (signed-in) X account that renamed since: paid under its current handle, which is stored
  db = openDb(':memory:')
  db.prepare("INSERT INTO users (x_id, handle, seen_at, payout_kind, payout_confirmed, payout_auto) VALUES ('900', 'oldname', 0, 'xmoney', 1, 0)").run()
  db.prepare("INSERT INTO xmoney_payouts (x_id, handle, state, lamports, usdc, created_at, updated_at) VALUES ('900', 'oldname', 'listing', 1, 20000000, ?, ?)").run(now(), now())
  let payee = null
  await xmoneyPass({ db, conn: null, keeper: null, seed: Buffer.alloc(32), cfg, log: quiet,
    rails: { baseAddress: '0x0', base, handleOf: async () => 'newname', peer: { orders: async () => [], cashout: async (a) => { payee = a.payee; return { depositId: 'e_1' } } } } })
  assert.deepEqual([payee, db.prepare('SELECT handle FROM xmoney_payouts').get().handle, db.prepare("SELECT handle FROM users WHERE x_id = '900'").get().handle], ['newname', 'newname', 'newname'])
})

test('review 15 Nov: the bridge back is never sent twice on a failed status call or because the shared Base wallet holds enough; only a deposit known unsent is redone', async () => {
  const { xmoneyConfig, xmoneyPass } = await import('../api/xmoney.mjs')
  const cfg = xmoneyConfig({}), quiet = { error() {}, info() {} }, keeper = { publicKey: { toBase58: () => 'KEEPER' } }
  const mk = (txs, steps) => { const db = openDb(':memory:'); db.prepare("INSERT INTO xmoney_payouts (x_id, handle, state, usdc, return_usdc, return_request, return_started_at, return_txs, return_steps, created_at, updated_at) VALUES ('42', 'bob', 'returning', 20000000, 20000000, 'req-1', ?, ?, ?, ?, ?)").run(now() - 2000, txs, steps, now() - 3000, now() - 2000); return db }
  const sends = []
  const rails = (status) => ({ baseAddress: '0x0', relay: { status, quote: async () => ({ steps: [{ kind: 'transaction', requestId: 'req-2', items: [{ data: { chainId: 8453, to: '0xrelay' } }] }] }) },
    base: { ethBalance: async () => 10n ** 18n, usdcBalance: async () => 50_000_000n, send: async (d) => { sends.push(d.to); return '0xsecond' } } })
  const run = async (db, r) => { for (let i = 0; i < 3; i++) await xmoneyPass({ db, conn: null, keeper, seed: Buffer.alloc(32), rails: r, cfg, log: quiet }); return db.prepare('SELECT * FROM xmoney_payouts').get() }
  // Relay cannot be asked: wait
  let r = await run(mk('["0xapprove","0xdeposit"]', 2), rails(async () => { throw new Error('relay 503') }))
  assert.deepEqual([r.return_request, sends.length], ['req-1', 0])
  // Relay says waiting, every step was sent: wait for Relay, whatever the wallet holds
  r = await run(mk('["0xapprove","0xdeposit"]', 2), rails(async () => ({ status: 'waiting' })))
  assert.deepEqual([r.return_request, sends.length], ['req-1', 0])
  // Relay says waiting and the deposit was never recorded (a crash after the approve): redone, once
  r = await run(mk('["0xapprove"]', 2), rails(async (id) => ({ status: id === 'req-1' ? 'waiting' : 'pending' })))
  assert.deepEqual([r.return_request, sends.length, r.return_steps], ['req-2', 1, 1])
})

test('PayPal: usernames cleaned like Peer does; a connection starts only for an account we pay, with a real email, and is rate limited', async () => {
  const { cleanPayee, appShown } = await import('../api/rails.mjs')
  const { createPaypalConnector } = await import('../api/paypal.mjs')
  for (const [raw, want] of [['https://www.paypal.me/JaneDoe', 'janedoe'], ['paypal.me/jane.doe/10', 'jane.doe'], ['@JaneDoe', 'janedoe'], ['paypal.me/', null], ['jane doe', null], ['...', null], ['a'.repeat(41), null]])
    assert.equal(cleanPayee('paypal', raw), want, raw)
  assert.equal(appShown('paypal', 'janedoe'), 'PayPal paypal.me/janedoe')
  const asked = []
  const client = async () => ({ prepare: async (i) => { asked.push(i); return { ...i, requestId: 'r', expiresAt: Date.now() + 1e6, url: 'u', appUrl: 'a' } }, status: async () => ({ status: 'pending' }), isConnected: async () => false })
  const c = createPaypalConnector({ client, isRecipient: (h) => h === 'janedoe' })
  await assert.rejects(c.start({ handle: 'other', email: 'a@b.co', ip: '1' }), (e) => e.status === 404)
  await assert.rejects(c.start({ handle: 'janedoe', email: 'not-an-email', ip: '1' }), (e) => e.status === 400)
  const r = await c.start({ handle: 'janedoe', email: 'a@b.co', ip: '1' })
  assert.ok(r.id && r.url === 'u' && r.appUrl === 'a' && !('requestId' in r))
  assert.deepEqual(asked[0], { platform: 'paypal', payeeHandle: 'janedoe', paypalEmail: 'a@b.co', returnUrl: 'https://app.peer.xyz/', currencies: ['USD'] })
  assert.deepEqual(await c.status(r.id), { status: 'pending' })
  assert.deepEqual(await c.status('nope'), { status: 'expired' })
  for (let i = 0; i < 8; i++) await c.start({ handle: 'janedoe', email: 'a@b.co', ip: '9' })
  await c.start({ handle: 'janedoe', email: 'a@b.co', ip: '9' }).catch(() => {})
  await c.start({ handle: 'janedoe', email: 'a@b.co', ip: '9' }).catch(() => {})
  await assert.rejects(c.start({ handle: 'janedoe', email: 'a@b.co', ip: '9' }), (e) => e.status === 429)
})

test('centred page heads: one component only, and it centres every box, not just the text (launch page drifted 14 Nov)', async () => {
  const { readdirSync } = await import('node:fs')
  const pages = readdirSync('web/src/pages').filter((f) => f.endsWith('.tsx'))
  for (const f of pages) {
    const src = readFileSync(`web/src/pages/${f}`, 'utf8')
    assert.doesNotMatch(src, /className="pf-pagehead|pf-pagehead-center|pf-explore-head/, `${f} builds a page head by hand: use <PageHead> from components/ui`)
  }
  const css = readFileSync('web/src/pumpfund.css', 'utf8')
  assert.match(css, /\.pf-pagehead\.pf-center > \* \{ margin-left: auto; margin-right: auto; \}/, 'the centred head must centre its child boxes')
  assert.match(css, /\.pf-pagehead\.pf-center > \.pf-eyebrow \{ max-width: none; \}/)
  for (const f of ['Launch.tsx', 'Explore.tsx', 'Payouts.tsx', 'Docs.tsx']) assert.match(readFileSync(`web/src/pages/${f}`, 'utf8'), /<PageHead /, `${f} uses PageHead`)
})

test('project token watch: only a Pumpfun create SIGNED by the operator wallet counts; a mention, a failed transaction or another program does not', async () => {
  const { pumpCreateBy, normTicker } = await import('../api/official.mjs')
  const { BorshCoder } = await import('@coral-xyz/anchor')
  const { readFileSync } = await import('node:fs')
  const bs58 = (await import('bs58')).default
  const { Keypair, PublicKey } = await import('@solana/web3.js')
  const idl = JSON.parse(readFileSync(new URL('../lib/pump-sweep.idl.json', import.meta.url)))
  const W = Keypair.generate().publicKey.toBase58(), MINT = Keypair.generate().publicKey.toBase58(), PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
  const data = bs58.encode(new BorshCoder(idl).instruction.encode('create', { name: 'Pump Fund', symbol: 'FUND', uri: 'https://x/y', creator: new PublicKey(W) }))
  const tx = (o = {}) => ({ meta: { err: o.err ?? null, innerInstructions: o.inner ? [{ instructions: [{ programId: PUMP, accounts: [MINT, 'x'], data }] }] : [] },
    transaction: { signatures: ['SIG'], message: { accountKeys: [{ pubkey: o.signer ?? W, signer: true }, { pubkey: W, signer: false }], instructions: o.inner ? [] : [{ programId: o.program ?? PUMP, accounts: [MINT, 'x'], data }] } } })
  assert.deepEqual(pumpCreateBy(tx(), W), { mint: MINT, name: 'Pump Fund', symbol: 'FUND', uri: 'https://x/y', via: 'create', signature: 'SIG' })
  assert.equal(pumpCreateBy(tx({ inner: true }), W)?.mint, MINT, 'a create inside another program\'s call (a launch tool) counts')
  assert.equal(pumpCreateBy(tx({ signer: 'someone-else' }), W), null, 'named in the transaction but not a signer')
  assert.equal(pumpCreateBy(tx({ err: { InstructionError: [0, 'Custom'] } }), W), null, 'a failed transaction')
  assert.equal(pumpCreateBy(tx({ program: '11111111111111111111111111111111' }), W), null, 'another program')
  assert.equal(pumpCreateBy(null, W), null)
  assert.deepEqual(['$fund', ' Fund ', 'FUND'].map(normTicker), ['FUND', 'FUND', 'FUND'])
})

test('graduated price: a PumpSwap pool\'s virtual SOL is read as a SIGNED i128 @245 (negative since 30 Sep 2026), the old u64 layout still read', async () => {
  const { poolVirtualQuote } = await import('../api/market.mjs')
  const i128 = (v) => { const d = Buffer.alloc(301), u = BigInt.asUintN(128, v); d.writeBigUInt64LE(u & (2n ** 64n - 1n), 245); d.writeBigUInt64LE(u >> 64n, 253); return d }
  assert.equal(poolVirtualQuote(i128(17_584_505_000n)), 17_584_505_000n)
  assert.equal(poolVirtualQuote(i128(-5_000_000n)), -5_000_000n, 'negative, never ~2^64')
  const old = Buffer.alloc(253); old.writeBigUInt64LE(17_000_000_000n, 245)
  assert.equal(poolVirtualQuote(old), 17_000_000_000n)
  assert.equal(poolVirtualQuote(Buffer.alloc(244)), 0n)
})
