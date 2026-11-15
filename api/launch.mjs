/**
 * Launches one queued mention as a pump.fun coin, paid by the platform's launch wallet.
 *
 *   transfer   launch wallet → the coin's fee wallet: the rent floor, so pump.fun's small first collections land
 *              (a system account under 890,880 lamports refuses a deposit below that)
 *   create_v2  mint = a fresh `…fund` key from the vanity pool, creator = the coin's fee wallet (api/feewallet.mjs)
 *
 * Order of writes (crash safety): the mention row gets mint + signature + last valid height BEFORE the first send, so a
 * restart can always ask the chain what happened (api/bot.mjs recover). A coin is recorded only once its bonding curve
 * exists on chain AND names our fee wallet as creator.
 *
 * ⛔ pump.fun metadata has no update authority (memory pumpfun-create-v2-metadata-has-no-authority): name, ticker, image
 * and links are permanent. Only content-addressed IPFS links on a gateway wallets can read are written.
 * ⛔ A mint key is used for ONE attempt. Once a transaction carrying it has left this server, anyone could pre-create
 * the curve's token account and make that address unlaunchable, so a failed or expired attempt burns its key.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js'
import { appKey, appShown, cleanPayee, isApp, isOurs } from './rails.mjs'
import { TOKEN_2022, ata, bondingCurveAddress, buyExactSolInIx, createV2Ix, curveCreator, decodeBondingCurve, holderRewardsAddress, loadGlobal, resolveQuote } from '../lib/pump.mjs'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { buildTx, sendUntilFate, fateOf } from '../lib/tx.mjs'
import { feeWallet } from './feewallet.mjs'
import { issueKey, markLaunched } from './vanity.mjs'
import { now, kvDel, LAUNCHING_CLOSED, DEFAULT_MODE } from './db.mjs'
import { fetchImage, imageType, storeImage } from './images.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { charityById } from './charities.mjs'
import { isNative, settleNativeSplit } from './nativesplit.mjs'
import { createSharingConfigIx, sharingConfigAddress } from '../lib/feeshare.mjs'
import { F as FLOAT_PDA, TOKEN as SPL_TOKEN, WSOL as FLOAT_WSOL, floatLaunchIx, launchState } from '../lib/float.mjs'

export const RENT_FLOOR = 890_880
/** pump.fun create rent (~0.02 SOL) + the fee wallet's rent floor + fees: the launch wallet keeps this much spare. */
export const MIN_LAUNCH_BALANCE = 35_000_000

export class LaunchError extends Error { constructor(msg, { code = 'launch', retry = true } = {}) { super(msg); this.code = code; this.retry = retry } }

/** Only X's own media host is fetched for a coin image: nothing a tweet links to elsewhere. */
export function isAllowedImageHost(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'pbs.twimg.com') } catch { return false }
}

/** The Pump Fund $ logo (api/assets/project-token.png): the picture of any coin launched without one. */
export const brandLogo = () => readFileSync(new URL('./assets/project-token.png', import.meta.url))

/** (Unused since 10 Nov: no-picture launches get brandLogo.) A tile with the ticker's first character, white on black. */
export function letterTile(symbol) {
  const ch = String(symbol || '?')[0].toUpperCase()
  const name = /[A-Z0-9]/.test(ch) ? ch : 'unknown'
  const p = new URL(`./assets/letters/${name}.png`, import.meta.url)
  return existsSync(p) ? readFileSync(p) : readFileSync(new URL('./assets/letters/unknown.png', import.meta.url))
}

/**
 * The coin's picture, in this order (operator 10 Nov), each tried until one downloads as a real image:
 *   1. the image attached to the launch post itself
 *   2. the image of the post it replies to (looked up only when 1 is missing or unusable: one billed read)
 *   3. the image of the post it quotes (already in the mention, free)
 *   4. the Pump Fund logo (operator 10 Nov: no image anywhere = our logo)
 * Only X's own media host is fetched. Returns { bytes, type, source }.
 */
export async function chooseImage({ mention, x, fetchImpl = fetchImage }) {
  const tryUrl = async (url) => {
    if (!url || !isAllowedImageHost(url)) return null
    // X serves the original with ?name=large; a 4096px original is not needed for a 512px logo.
    const u = new URL(url); u.searchParams.set('name', 'medium')
    try { const bytes = await fetchImpl(u.toString(), 10_000); const type = imageType(bytes); return type ? { bytes, type } : null } catch { return null }
  }
  let got = await tryUrl(mention.mediaUrl)
  if (got) return { ...got, source: 'tweet' }
  if (mention.inReplyToId && x?.fetchTweet) {
    let parentUrl = null
    try { parentUrl = (await x.fetchTweet(mention.inReplyToId))?.mediaUrl ?? null } catch {}
    got = await tryUrl(parentUrl)
    if (got) return { ...got, source: 'parent' }
  }
  got = await tryUrl(mention.quotedMediaUrl)
  if (got) return { ...got, source: 'quoted' }
  return { bytes: brandLogo(), type: 'image/png', source: 'logo' }
}

/**
 * Pins the image, then pump.fun's metadata JSON, on Pinata (pump.fun closed its open uploader 19 Oct 2026). Links are
 * written on IPFS_GATEWAY (gateway.pinata.cloud): ipfs.io 403s wallets and indexers (memory ipfs-io-service-worker-only).
 */
export async function pinMetadata({ image, imageType: type, name, symbol, description, website, twitter, telegram }, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.PINATA_JWT) throw new LaunchError('PINATA_JWT is not set', { code: 'config', retry: true })
  const gateway = String(env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '')
  const pin = async (blob, fileName) => {
    const f = new FormData()
    f.append('file', blob, fileName); f.append('network', 'public'); f.append('name', fileName)
    const r = await fetchImpl('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { authorization: `Bearer ${env.PINATA_JWT}` }, body: f, signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new LaunchError(`Pinata refused ${fileName} (${r.status})`)
    const cid = (await r.json().catch(() => ({})))?.data?.cid
    if (!/^[A-Za-z0-9]{40,100}$/.test(cid || '')) throw new LaunchError('Pinata returned no content hash')
    return cid
  }
  const ext = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[type] ?? '.jpg'
  const imageCid = await pin(new Blob([image], { type }), `${symbol}-image${ext}`)
  const metadata = { name, symbol, description, image: `${gateway}/${imageCid}`, showName: true, createdOn: 'https://pump.fun', twitter, website, ...(telegram ? { telegram } : {}) }
  const metaCid = await pin(new Blob([JSON.stringify(metadata)], { type: 'application/json' }), `${symbol}-metadata.json`)
  const uri = `${gateway}/${metaCid}`
  if (uri.length > 200) throw new LaunchError('metadata address too long', { retry: false })
  return { uri, imageUri: metadata.image }
}

/** The website every coin carries (operator 10 Nov): exactly this, trailing slash included. */
export const SITE_URL = 'https://pumpfund.family/'

/** The coin's X link: the post that launched it, always as https://x.com/<handle>/status/<id>. */
export function tweetLink(mention) {
  const id = String(mention.tweet_id ?? mention.id ?? '')
  const handle = String(mention.author_handle ?? mention.authorHandle ?? '').replace(/^@/, '')
  if (/^\d+$/.test(id) && /^[A-Za-z0-9_]{1,15}$/.test(handle)) return `https://x.com/${handle}/status/${id}`
  return mention.url ?? ''
}

export function describe({ symbol, handle, publicUrl, forHandle = null, shares = null }) {
  const site = publicUrl.replace(/^https?:\/\//, '')
  // ⭐ a wallet launcher has no handle (operator 14 Nov): the sentence leaves the launcher out
  const by = handle ? ` by @${handle}` : ''
  // a split: every account with its share, in the order they were named
  const who = (s) => (s.kind === 'charity' ? s.handle : s.kind === 'github' ? `${s.handle} on GitHub` : isApp(s.kind) ? appShown(s.kind, s.handle) : `@${s.handle}`)
  if (shares?.length > 1) return `$${symbol} was launched${by} on Pump Fund. Its creator rewards are split between ${shares.map((s) => `${who(s)} (${s.bps / 100}%)`).join(', ')}: ${site}`
  if (shares?.length === 1 && shares[0].kind && shares[0].kind !== 'x') return `$${symbol} was launched${by} on Pump Fund. Its creator rewards go to ${who(shares[0])}: ${site}`
  if (forHandle) return `$${symbol} was launched for @${forHandle}${by} on Pump Fund. Its creator rewards go to @${forHandle}: ${site}`
  return `$${symbol} was launched${by} on Pump Fund. Its creator rewards go to @${handle || forHandle}: ${site}`
}

/**
 * The launch instructions: rent floor to the fee wallet, then create_v2, then (site launches only) a dev buy.
 * ⭐ `devBuy` { user, lamports } (13 Nov): the buyer's OWN wallet buys in the same transaction, right after the create,
 * so nobody can trade before it. The launch wallet still pays the creation; the buyer pays the buy, its own token
 * account and nothing else (every instruction is built here, the buyer only signs).
 */
export async function buildLaunchIxs({ conn, pump, launcher, mint, feeWalletPk, name, symbol, uri, holderReward = false, ownCreator = false, quote = null, devBuy = null, native = null, priorityMicroLamports = 150_000 }) {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: devBuy || native ? 400_000 : 260_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
  ]
  // A native holder-reward coin's fees never reach our fee wallet (pump.fun makes its holder-rewards PDA the creator).
  // An own-wallet creator (the platform token) is a funded wallet already: no rent floor to prefund.
  // A paired coin's fees arrive in its quote token: the fee wallet needs no SOL (the keeper opens its token account).
  const paired = !!quote && quote.kind !== 'sol'
  // ⭐ `native` { prefund }: a coin with GitHub / charity recipients (api/nativesplit.mjs). Its Pumpfun creator is the launch
  // wallet (which must sign the fee-sharing set-up) and fee sharing is turned on in this same transaction; the reward
  // wallet gets its rent floor only when it will be a shareholder (the coin also funds X accounts).
  if (native) {
    if (devBuy || paired || holderReward || ownCreator) throw new LaunchError('a coin with GitHub or charity recipients launches plain', { code: 'native-plain', retry: false })
    if (native.prefund) { const have = await conn.getBalance(feeWalletPk, 'confirmed'); if (have < RENT_FLOOR) ixs.push(SystemProgram.transfer({ fromPubkey: launcher, toPubkey: feeWalletPk, lamports: RENT_FLOOR - have })) }
    ixs.push(await createV2Ix(pump, { mint, user: launcher, name, symbol, uri, creator: launcher }))
    ixs.push(await createSharingConfigIx(conn, { mint, creator: launcher }))
    return ixs
  }
  if (!holderReward && !ownCreator && !paired) {
    const have = await conn.getBalance(feeWalletPk, 'confirmed')
    if (have < RENT_FLOOR) ixs.push(SystemProgram.transfer({ fromPubkey: launcher, toPubkey: feeWalletPk, lamports: RENT_FLOOR - have }))
  }
  ixs.push(await createV2Ix(pump, { mint, user: launcher, name, symbol, uri, creator: feeWalletPk, holderReward, quote: paired ? quote : null }))
  if (devBuy) {
    if (paired) throw new LaunchError('a dev buy needs a SOL pair', { code: 'dev-buy-pair', retry: false })
    const buyer = new PublicKey(devBuy.user)
    // pump.fun replaces a holder-reward coin's creator with its holder-rewards PDA: the buy must name that vault
    const creator = holderReward ? holderRewardsAddress(mint) : feeWalletPk
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(buyer, ata(buyer, mint, TOKEN_2022), buyer, mint, TOKEN_2022))
    ixs.push(await buyExactSolInIx(pump, await loadGlobal(conn), { mint, user: buyer, creator, lamports: BigInt(devBuy.lamports) }))
  }
  return ixs
}

/** The launch transaction, signed by the launch wallet and the mint. */
export async function buildLaunchTx({ conn, pump, launcher, mintKp, feeWalletPk, name, symbol, uri, holderReward = false, ownCreator = false, quote = null, native = null, lookupTables = [], priorityMicroLamports = 150_000 }) {
  const ixs = await buildLaunchIxs({ conn, pump, launcher: launcher.publicKey, mint: mintKp.publicKey, feeWalletPk, name, symbol, uri, holderReward, ownCreator, quote, native, priorityMicroLamports })
  return buildTx(conn, { payer: launcher.publicKey, ixs, signers: [launcher, mintKp], lookupTables })
}

/**
 * True when `mint`'s bonding curve exists as we built it: creator = our fee wallet, or for a native holder-reward launch
 * is_holder_reward set and creator = pump.fun's holder-rewards PDA (pump.fun replaces the creator we pass, proven 10 Nov).
 */
export async function curveIsOurs(conn, mint, feeWalletPk, holderReward = false, quoteMint = null) {
  const info = await conn.getAccountInfo(bondingCurveAddress(new PublicKey(mint)), 'confirmed')
  if (!info) return false
  const c = decodeBondingCurve(info.data)
  // a paired launch must have landed against the pair it was built for
  if (quoteMint && !c.quote_mint.equals(new PublicKey(quoteMint))) return false
  if (!holderReward) return !!curveCreator(info.data)?.equals(feeWalletPk)
  return JSON.stringify(c.is_holder_reward).includes('true') && c.creator.equals(holderRewardsAddress(new PublicKey(mint)))
}

/**
 * Records a landed launch (idempotent). `mode` is what the coin's fees do from its first trade.
 * The platform launch (the operator's project token) also opens launching, in the same transaction as its record.
 */
export function recordLaunch(db, { mention, mint, feeWalletPk, signature, uri, image, description, mode, platform = false, nativeHolders = false, ownCreator = false, quote = null, venue = 'pump', shareConfig = null }) {
  // tokens.creator_id is the first X account the coin funds (our ledger's and the pages' anchor). ⛔ A GitHub id or a charity
  // id is never written there: ids are unique per kind only, and that column is read as an X id everywhere.
  const shares = ownCreator ? [] : launchShares(mention), firstX = shares.find((s) => s.kind === 'x')
  const creatorId = ownCreator ? mention.author_id : firstX ? firstX.id : '-', creatorHandle = ownCreator ? mention.author_handle : firstX ? firstX.handle ?? '' : isApp(shares[0]?.kind) ? appShown(shares[0].kind, shares[0].handle) : shares[0]?.handle ?? ''
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT OR IGNORE INTO tokens (mint, name, symbol, image, metadata_uri, description, creator_id, creator_handle, tweet_id, tweet_url,
      fee_wallet, mode, mode_at, launch_sig, created_at, platform, native_holders, own_creator, quote_mint, quote_symbol, quote_decimals, quote_program, venue)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mint, mention.name, mention.symbol, image, uri, description, creatorId, creatorHandle, mention.tweet_id, mention.url,
        feeWalletPk.toBase58(), nativeHolders ? 'holders' : mode, now(), signature, now(), platform ? 1 : 0, nativeHolders ? 1 : 0, ownCreator ? 1 : 0,
        quote?.mint ?? null, quote?.mint ? (quote.symbol ?? null) : null, quote?.mint ? quote.decimals : null, quote?.mint ? quote.tokenProgram : null, venue)
    // launched FOR someone: the coin (and its rewards) is theirs; who asked is kept for the page
    if (mention.for_id || mention.source === 'site') db.prepare('UPDATE tokens SET launched_by_id = ?, launched_by_handle = ? WHERE mint = ?').run(mention.author_id, mention.author_handle, mint)
    // ⭐ the coin's recipients and their shares, written once with the coin and never changed (db token_shares). The
    // project token has none: its creator is the operator's own wallet.
    if (shareConfig) db.prepare('UPDATE tokens SET share_config = ? WHERE mint = ?').run(shareConfig, mint)
    if (!ownCreator) {
      const ins = db.prepare('INSERT OR IGNORE INTO token_shares (mint, slot, kind, recipient_id, handle, bps) VALUES (?, ?, ?, ?, ?, ?)')
      shares.forEach((s, i) => ins.run(mint, i, s.kind ?? 'x', String(s.id), s.handle ?? null, s.bps))
    }
    db.prepare(`UPDATE mentions SET state = 'launched', mint = ?, signature = ?, launched_at = COALESCE(launched_at, ?), reply_state = CASE WHEN reply_state = 'none' THEN 'pending' ELSE reply_state END, updated_at = ? WHERE tweet_id = ?`)
      .run(mint, signature, now(), now(), mention.tweet_id)
    markLaunched(db, mint)
    if (platform) {
      kvDel(db, LAUNCHING_CLOSED)
      db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('platform_mint', ?)").run(mint)
      // everyone who waited for the opening is eligible at once (still paced by the spacing rule and the ramp)
      db.prepare("UPDATE mentions SET next_try_at = 0 WHERE state = 'queued' AND code = 'launching-closed'").run()
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

export const MAX_ATTEMPTS = 3

/**
 * One attempt at launching a mention already claimed into state 'launching' (api/bot.mjs). Returns
 * { outcome: 'launched' | 'retry' | 'failed' | 'unknown', mint?, error? }. Never leaves the row ambiguous: 'unknown'
 * keeps mint + signature on it for recover().
 */
export async function launchMention({ db, conn, pump, launcher, platformLauncher = null, seed, mention, x, publicUrl, logoDir, lookupTables, pin = pinMetadata, log = console }) {
  const attempt = mention.attempts + 1
  db.prepare('UPDATE mentions SET attempts = ?, updated_at = ? WHERE tweet_id = ?').run(attempt, now(), mention.tweet_id)
  const user = db.prepare('SELECT default_mode FROM users WHERE x_id = ?').get(mention.author_id)
  // a coin launched FOR someone always pays its creator rewards to them (their X Money), never to holders
  const mode = mention.for_id ? 'creator' : mention.mode ?? user?.default_mode ?? DEFAULT_MODE
  const platform = !!mention.platform
  // ⭐ Operator 10 Nov: the platform token is launched FROM the operator's own wallet (PLATFORM_LAUNCH_KEY), which is also
  // its pump.fun creator: its creator fees go to that wallet (claimed on pump.fun), never to holders or a fee wallet.
  const own = platform && platformLauncher ? platformLauncher : null
  if (own) launcher = own

  // ⛔ the recipients are checked BEFORE anything is sent: recordLaunch reads the same data after the coin exists, where a
  // refusal would leave a live coin unrecorded
  const shares = own ? [] : launchShares(mention)
  // ⭐ GitHub accounts / charities among them: Pumpfun's own fee sharing pays those (api/nativesplit.mjs)
  const native = isNative(shares) ? { prefund: shares.some((s) => isOurs(s.kind)) } : null

  const balance = await conn.getBalance(launcher.publicKey, 'confirmed')
  if (balance < MIN_LAUNCH_BALANCE) return { outcome: 'retry', error: `launch wallet holds ${balance / 1e9} SOL`, hold: true }

  // Image + metadata first (cheap to redo; nothing on chain yet). Stored payload makes a retry reuse the same pin.
  let payload = mention.payload ? JSON.parse(mention.payload) : null
  if (!payload?.uri) {
    // The platform token always carries the staged logo (api/assets/project-token.png) and its own description.
    const staged = platform ? new URL('./assets/project-token.png', import.meta.url) : null
    // ⭐ a launch made on the site (13 Nov) carries its own picture, description and links (api/sitelaunch.mjs)
    const site = mention.source === 'site' && !platform ? siteFields({ mention, publicUrl, logoDir }) : null
    const img = site ? site.img : staged && existsSync(staged)
      ? { bytes: readFileSync(staged), type: 'image/png', source: 'project' }
      : await chooseImage({ mention: { ...mention, mediaUrl: mention.image_url, inReplyToId: mention.in_reply_to_id, quotedMediaUrl: mention.quoted_image_url }, x })
    const image = storeImage({ logoDir, publicUrl }, img.bytes)
    const description = site ? site.description : platform
      ? `Launch Pumpfun tokens whose creator rewards fund people and good causes. ${publicUrl.replace(/^https?:\/\//, '')}`
      : describe({ symbol: mention.symbol, handle: mention.author_handle, publicUrl, forHandle: mention.for_id ? mention.for_handle : null })
    const pinned = site
      ? await pinOnce(db, pin, { image: img.bytes, imageType: img.type, name: mention.name, symbol: mention.symbol, description, website: site.website, twitter: site.twitter, telegram: site.telegram })
      : await pin({ image: img.bytes, imageType: img.type, name: mention.name, symbol: mention.symbol, description, website: SITE_URL, twitter: tweetLink(mention) })
    payload = { uri: pinned.uri, image, description, imageSource: img.source }
    db.prepare('UPDATE mentions SET payload = ?, updated_at = ? WHERE tweet_id = ?').run(JSON.stringify(payload), now(), mention.tweet_id)
  }
  // ⭐ Float (operator 11 Nov): its own launch path (lib/float.mjs); the platform token is always a pump.fun coin
  if (mention.venue === 'float' && !platform) return launchFloat({ db, conn, launcher, seed, mention: { ...mention, attempts: attempt }, payload, mode, log })

  // Holders at launch = pump.fun's native holder rewards (operator 10 Nov): locked, paid by pump.fun. Decided once per
  // attempt and kept in the payload, so a recovery after a crash checks the curve the way it was built.
  const holderReward = !own && !native && mode === 'holders' && process.env.NATIVE_HOLDER_REWARDS !== '0'
  // The pair, re-read from the chain now (a pump coin pair may have moved from its curve to its pool since the queue
  // checked it). The platform token is always SOL-paired.
  let quote = null
  if (!own && mention.pair) {
    const saved = JSON.parse(mention.pair)
    const listed = db.prepare('SELECT mint FROM pair_tokens').all().map((r) => r.mint)
    const fresh = await resolveQuote(conn, saved.mint, listed.length ? { listed } : {})
    if (!fresh.ok && fresh.code === 'pair-wait') return { outcome: 'retry', error: `pair ${saved.symbol ?? saved.mint}: ${fresh.reason}`, hold: true }
    if (!fresh.ok || fresh.kind === 'sol') {
      // nothing was sent: the request is answered with the reason instead of launched against a pair pump.fun refuses
      db.prepare("UPDATE mentions SET state = 'rejected', code = 'bad-pair', reason = ?, reply_state = 'pending', updated_at = ? WHERE tweet_id = ? AND state = 'launching' AND signature IS NULL")
        .run(fresh.reason ?? 'Pumpfun cannot pair with that token.', now(), mention.tweet_id)
      return { outcome: 'rejected', error: fresh.reason }
    }
    quote = { ...fresh, symbol: saved.symbol ?? null, name: saved.name ?? null }
  }
  if (quote && mode === 'holders' && !holderReward) {
    // holders of a paired coin can only be paid by pump.fun's holder rewards (we never airdrop a pair token)
    db.prepare("UPDATE mentions SET state = 'rejected', code = 'bad-pair', reason = ?, reply_state = 'pending', updated_at = ? WHERE tweet_id = ? AND state = 'launching' AND signature IS NULL")
      .run('Paired coins are paused right now. Post again without a pair to launch against SOL.', now(), mention.tweet_id)
    return { outcome: 'rejected', error: 'holder rewards off, paired holders coin refused' }
  }
  payload = { ...payload, holderReward, ownCreator: own ? own.publicKey.toBase58() : null, quote, native: native ? { ...native, creator: launcher.publicKey.toBase58() } : null }
  db.prepare('UPDATE mentions SET payload = ? WHERE tweet_id = ?').run(JSON.stringify(payload), mention.tweet_id)
  const mintKp = issueKey(db, `tweet:${mention.tweet_id}:${attempt}`)
  if (!mintKp) return { outcome: 'retry', error: 'no …fund keys ready', hold: true }
  const mint = mintKp.publicKey.toBase58()
  const fw = own ? own.publicKey : feeWallet(seed, mint).publicKey
  // The curve could still be taken by someone who saw this key (it was never sent before, but check anyway).
  if (await conn.getAccountInfo(bondingCurveAddress(mintKp.publicKey), 'confirmed')) {
    db.prepare("UPDATE vanity SET state = 'burned' WHERE pubkey = ?").run(mint)
    return { outcome: 'retry', error: 'mint address already used' }
  }
  const built = await buildLaunchTx({ conn, pump, launcher, mintKp, feeWalletPk: fw, name: mention.name, symbol: mention.symbol, uri: payload.uri, holderReward, ownCreator: !!own, quote, native, lookupTables })
  // ⛔ Written BEFORE the send: from here on the chain may have it.
  db.prepare('UPDATE mentions SET mint = ?, signature = ?, last_valid_height = ?, updated_at = ? WHERE tweet_id = ?')
    .run(mint, built.signature, built.lastValidBlockHeight, now(), mention.tweet_id)
  const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
  return settleAttempt(db, conn, { mention: { ...mention, attempts: attempt }, mint, feeWalletPk: fw, signature: built.signature, fate: f, payload, mode: own ? 'creator' : mode, platform, launcher, log })
}

/** Turns a chain answer into the mention's next state. Shared by launchMention and recover(). */
export async function settleAttempt(db, conn, { mention, mint, feeWalletPk: fw, signature, fate, payload, mode, platform, launcher = null, log = console }) {
  if (fate.fate === 'landed' && payload?.native) {
    // ⭐ the coin exists with fee sharing on; its shares are locked next (idempotent: repeated by recover() until done)
    const curve = await conn.getAccountInfo(bondingCurveAddress(new PublicKey(mint)), 'confirmed')
    const creator = curve ? curveCreator(curve.data) : null
    const cfgAddr = sharingConfigAddress(new PublicKey(mint))
    if (!creator || !(creator.equals(cfgAddr) || creator.toBase58() === payload.native.creator)) { log.error?.(`launch ${signature} landed but curve ${mint} is not ours`); return failAttempt(db, mention, mint, 'landed without our curve') }
    if (!launcher || launcher.publicKey.toBase58() !== payload.native.creator) return { outcome: 'unknown', mint, error: 'the launch wallet that created this coin is needed to lock its shares' }
    const save = (state) => { payload = { ...payload, native: { ...payload.native, state } }; db.prepare('UPDATE mentions SET payload = ?, updated_at = ? WHERE tweet_id = ?').run(JSON.stringify(payload), now(), mention.tweet_id) }
    const r = await settleNativeSplit({ conn, launcher, mint, feeWalletPk: fw, shares: launchShares(mention), state: payload.native.state ?? {}, save, log })
    if (r.wait && !r.locked) return { outcome: 'unknown', mint, error: r.wait }
    if (r.failed) {
      // ⛔ the coin is live on Pumpfun and cannot be undone; it is NOT listed here, and the reason is kept for the operator
      log.error?.(`native split ${mint}: ${r.failed}`)
      db.prepare("UPDATE mentions SET state = 'failed', code = 'split-failed', reason = ?, updated_at = ? WHERE tweet_id = ?").run(`The token was created but its reward split could not be locked: ${r.failed}`.slice(0, 300), now(), mention.tweet_id)
      return { outcome: 'failed', mint, error: r.failed }
    }
    recordLaunch(db, { mention, mint, feeWalletPk: fw, signature, uri: payload?.uri, image: payload?.image, description: payload?.description, mode: 'creator', platform: false, shareConfig: r.config })
    // ⭐ locked exactly as asked but with chores left (a GitHub account to open, first rewards to forward): the coin is
    // listed now and finishNative() repeats the chores on the side, so they never hold up the launch queue
    if (r.wait) {
      payload = { ...payload, native: { ...payload.native, pending: true, tries: 0 } }
      db.prepare('UPDATE mentions SET payload = ?, next_try_at = ?, updated_at = ? WHERE tweet_id = ?').run(JSON.stringify(payload), now() + 30, now(), mention.tweet_id)
      log.info?.(`native split ${mint}: locked; still to do: ${r.wait}`)
    }
    return { outcome: 'launched', mint }
  }
  if (fate.fate === 'landed') {
    const holderReward = !!payload?.holderReward
    const ownCreator = payload?.ownCreator ?? null
    if (ownCreator) { fw = new PublicKey(ownCreator); mode = 'creator' }
    const quote = payload?.quote ?? null
    if (payload?.venue === 'float') {
      const st = await launchState(conn, mint).catch(() => null)
      if (!st || !st.fee_receiver.equals(fw)) {
        log.error?.(`float launch ${signature} landed but ${mint} does not name our fee wallet`)
        return failAttempt(db, mention, mint, 'landed without our Float launch')
      }
      // a token-paired Float coin can only pay its creator (we never airdrop a pair token)
      recordLaunch(db, { mention, mint, feeWalletPk: fw, signature, uri: payload?.uri, image: payload?.image, description: payload?.description, mode: quote?.mint ? 'creator' : mode, platform, quote, venue: 'float' })
      return { outcome: 'launched', mint }
    }
    if (!(await curveIsOurs(conn, mint, fw, holderReward, quote?.mint ?? null))) {
      // Landed, but no curve naming our wallet: never record a coin we cannot prove.
      log.error?.(`launch ${signature} landed but curve ${mint} is not ours`)
      return failAttempt(db, mention, mint, 'landed without our curve')
    }
    recordLaunch(db, { mention, mint, feeWalletPk: fw, signature, uri: payload?.uri, image: payload?.image, description: payload?.description, mode, platform, nativeHolders: holderReward, ownCreator: !!ownCreator, quote })
    return { outcome: 'launched', mint }
  }
  if (fate.fate === 'unknown') return { outcome: 'unknown', mint, error: fate.error }
  return failAttempt(db, mention, mint, fate.error ?? JSON.stringify(fate.err ?? fate.fate))
}

export const NATIVE_FINISH_TRIES = 12
/**
 * The chores of natively split coins that were listed with some left (settleAttempt): repeated here, each with a growing
 * pause (30 s doubling, an hour at most), NATIVE_FINISH_TRIES times. After that it is left for the operator: the lock
 * itself is done, the keeper opens a missing GitHub account before it distributes, and only rewards earned in the
 * seconds before the lock (state.interim) may still sit in the launch wallet.
 */
export async function finishNative(db, conn, { launcher, seed, log = console }) {
  const rows = db.prepare("SELECT * FROM mentions WHERE state = 'launched' AND mint IS NOT NULL AND payload LIKE '%\"pending\":true%' AND next_try_at <= ?").all(now())
  for (const m of rows) {
    let payload = JSON.parse(m.payload)
    const n = payload.native
    if (!n?.pending || !launcher || launcher.publicKey.toBase58() !== n.creator) continue
    const write = (native, nextTry = now()) => { payload = { ...payload, native }; db.prepare('UPDATE mentions SET payload = ?, next_try_at = ? WHERE tweet_id = ?').run(JSON.stringify(payload), nextTry, m.tweet_id) }
    let r
    try {
      r = await settleNativeSplit({ conn, launcher, mint: m.mint, feeWalletPk: feeWallet(seed, m.mint).publicKey, shares: launchShares(m), state: n.state ?? {},
        save: (state) => write({ ...payload.native, state }, m.next_try_at), log })
    } catch (e) { r = { wait: e.message } }
    if (r.done) { write({ ...payload.native, pending: false }); log.info?.(`native split ${m.mint}: chores done`); continue }
    const tries = (payload.native.tries ?? 0) + 1
    if (tries >= NATIVE_FINISH_TRIES || r.failed) {
      write({ ...payload.native, pending: false, stuck: String(r.failed ?? r.wait).slice(0, 200), tries })
      log.error?.(`native split ${m.mint}: gave up after ${tries} tries (${r.failed ?? r.wait}); interim ${payload.native.state?.interim ?? 0} lamports may still be in the launch wallet. Needs the operator.`)
    } else write({ ...payload.native, tries }, now() + Math.min(3600, 30 * 2 ** tries))
  }
}

function failAttempt(db, mention, mint, error) {
  db.prepare("UPDATE vanity SET state = 'burned' WHERE pubkey = ? AND state != 'launched'").run(mint)
  const final = mention.attempts >= MAX_ATTEMPTS
  db.prepare(`UPDATE mentions SET state = ?, mint = NULL, signature = NULL, last_valid_height = NULL, code = ?, reason = ?,
    reply_state = CASE WHEN ? AND source = 'x' THEN 'pending' ELSE reply_state END, updated_at = ? WHERE tweet_id = ?`)
    .run(final ? 'failed' : 'queued', final ? 'launch-failed' : 'retrying', String(error).slice(0, 300), final ? 1 : 0, now(), mention.tweet_id)
  return { outcome: final ? 'failed' : 'retry', error }
}

export { fateOf }

/**
 * A request's recipients → [{ kind, id, handle, bps }]: the form's `opts.shares` when they are well-formed (whole bps, each
 * at least 5%, 10000 together, distinct), otherwise the single account the coin is for. ⛔ Checked again here, at the last
 * step before the ledger: a malformed split must never reach it.
 */
export function launchShares(mention) {
  const single = [{ kind: 'x', id: String(mention.for_id ?? mention.author_id), handle: mention.for_id ? mention.for_handle : mention.author_handle, bps: 10000 }]
  let s
  try { s = mention.opts ? JSON.parse(mention.opts).shares : null } catch { s = null }
  if (!Array.isArray(s) || !s.length) return single
  const idOk = (r) => (r.kind ?? 'x') === 'x' ? /^[0-9]{1,25}$/.test(String(r.id)) : r.kind === 'github' ? /^[0-9]{1,20}$/.test(String(r.id))
    : r.kind === 'charity' ? !!charityById(r.id) /* ⛔ only an id from Donate.gg's directory: the relay accepts any */
    // a payment app: the id is the ledger key of exactly the payee it will pay (api/rails.mjs)
    : isApp(r.kind) ? (() => { const p = cleanPayee(r.kind, r.handle); return !!p && p === r.handle && String(r.id) === appKey(r.kind, p) })() : false
  const ok = s.length <= 5 && s.every((r) => r && idOk(r) && Number.isInteger(r.bps) && r.bps >= 500) &&
    s.reduce((t, r) => t + r.bps, 0) === 10000 && new Set(s.map((r) => `${r.kind ?? 'x'}:${String(r.id).toLowerCase()}`)).size === s.length
  if (!ok) throw new LaunchError('the recipients of this launch are malformed', { code: 'bad-shares', retry: false })
  return s.map((r) => ({ kind: r.kind ?? 'x', id: r.kind === 'charity' ? String(r.id).toLowerCase() : String(r.id), handle: r.handle ?? null, bps: r.bps }))
}

/** What a site launch's metadata carries: the uploaded picture (else the Pump Fund logo), the form's description and links. */
export function siteFields({ mention, publicUrl, logoDir }) {
  const o = mention.opts ? JSON.parse(mention.opts) : {}
  let img = null
  if (o.imageFile && /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(o.imageFile)) {
    const file = join(logoDir, o.imageFile)
    if (existsSync(file)) { const bytes = readFileSync(file); const type = imageType(bytes); if (type) img = { bytes, type, source: 'upload' } }
  }
  img ??= { bytes: brandLogo(), type: 'image/png', source: 'logo' }
  const handle = String(mention.author_handle ?? '').replace(/^@/, '')
  return {
    img,
    // the default description says whose X Money the creator rewards go to
    description: o.description || describe({ symbol: mention.symbol, handle, publicUrl, forHandle: mention.for_id ? mention.for_handle : null, shares: Array.isArray(o.shares) ? o.shares : null }),
    website: o.website || SITE_URL,
    twitter: o.twitter || (/^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : ''),
    telegram: o.telegram || '',
  }
}

/** Pins once per exact content: the same fields and picture again (a retry, a refused wallet prompt) reuse the stored link. */
export async function pinOnce(db, pin, fields) {
  const hash = createHash('sha256').update(JSON.stringify([fields.name, fields.symbol, fields.description, fields.website, fields.twitter, fields.telegram ?? '', createHash('sha256').update(fields.image).digest('hex')])).digest('hex')
  const hit = db.prepare('SELECT uri, image FROM pins WHERE hash = ?').get(hash)
  if (hit) return { uri: hit.uri, imageUri: hit.image }
  const pinned = await pin(fields)
  db.prepare('INSERT OR REPLACE INTO pins (hash, uri, image, at) VALUES (?, ?, ?, ?)').run(hash, pinned.uri, pinned.imageUri ?? '', now())
  return pinned
}

/**
 * ⭐ A Float launch (lib/float.mjs): Float's `launch` from the shared launch wallet. The mint is Float's PDA
 * ["mint", launcher, nonce]: the nonce is fixed per attempt and kept in the payload BEFORE the send, so a crash after the
 * send finds the same mint. The coin's fee wallet (derived like every fee wallet) is its fee receiver: Float sends it the
 * dev share (5% of the trading fee) in the pair token; for a SOL pair the keeper unwraps it into plain SOL.
 * ⛔ max_takeover 0: a ticker already on Float makes the launch fail (we never pay Float's 2..5 SOL takeover fee).
 */
async function launchFloat({ db, conn, launcher, seed, mention, payload, mode, log = console }) {
  const pair = mention.pair ? JSON.parse(mention.pair) : null
  const quoteMint = pair?.mint ? new PublicKey(pair.mint) : FLOAT_WSOL
  const attempt = mention.attempts
  let nonce = payload.floatNonce && payload.floatAttempt === attempt ? BigInt(payload.floatNonce) : null
  if (nonce == null) {
    const r = new BigUint64Array(1); crypto.getRandomValues(r); nonce = r[0]
    payload = { ...payload, venue: 'float', floatNonce: String(nonce), floatAttempt: attempt, quote: pair?.mint ? pair : null }
    db.prepare('UPDATE mentions SET payload = ? WHERE tweet_id = ?').run(JSON.stringify(payload), mention.tweet_id)
  }
  const mint = FLOAT_PDA.coinMint(launcher.publicKey, nonce)
  const fw = feeWallet(seed, mint.toBase58()).publicKey
  const { ix } = await floatLaunchIx(conn, { creator: launcher.publicKey, name: mention.name, ticker: mention.symbol, uri: payload.uri, feeReceiver: fw, quoteMint, tier: 0, nonce })
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }), ix]
  // a SOL coin's fee wallet receives unwrapped SOL later: it must already hold the rent floor
  if (!pair?.mint) ixs.push(SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: fw, lamports: RENT_FLOOR }))
  const built = await buildTx(conn, { payer: launcher.publicKey, ixs, signers: [launcher] })
  // ⛔ Written BEFORE the send: from here on the chain may have it.
  db.prepare('UPDATE mentions SET mint = ?, signature = ?, last_valid_height = ?, updated_at = ? WHERE tweet_id = ?')
    .run(mint.toBase58(), built.signature, built.lastValidBlockHeight, now(), mention.tweet_id)
  const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
  // the ticker was taken on Float between the queue's check and this send: answer it, never retry into a fee
  if (f.fate === 'rejected' && /0x1797|0x177b|TakeoverFeeTooHigh|TickerProtected/.test(`${f.error ?? ''} ${(f.logs ?? []).join(' ')}`)) {
    db.prepare(`UPDATE mentions SET state = 'rejected', code = 'float-ticker-taken', reason = ?, mint = NULL, signature = NULL, last_valid_height = NULL,
      reply_state = 'pending', updated_at = ? WHERE tweet_id = ? AND state = 'launching'`)
      .run(`$${mention.symbol.toUpperCase()} is already taken on Float. Pick another ticker, or launch it on Pumpfun.`, now(), mention.tweet_id)
    return { outcome: 'rejected', error: 'ticker taken on Float' }
  }
  return settleAttempt(db, conn, { mention, mint: mint.toBase58(), feeWalletPk: fw, signature: built.signature, fate: f, payload, mode, platform: false, log })
}

