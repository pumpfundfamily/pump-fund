/**
 * ⛔ OPERATOR ONLY, ONCE: queues the launch of the project token ($FUND, "Pump Fund", the heart logo). The running api
 * (pumpfund-api) launches it from the queue within seconds, and its landing OPENS launching for everyone in the same
 * database transaction (api/launch.mjs recordLaunch). A pump.fun launch cannot be undone.
 *
 *   on the box:  cd /root/pumpfund-api && set -a && . /root/pumpfund-ops/api.env && set +a && DATA_DIR=/var/lib/pumpfund node api/platform-launch.mjs
 *                (prints what would happen and changes NOTHING)
 *                … node api/platform-launch.mjs --launch        queues it for real
 *
 * The coin is launched FROM the operator's own wallet (PLATFORM_LAUNCH_KEY): that wallet pays (~0.02 SOL), is the coin's
 * pump.fun creator and receives its creator rewards on pump.fun. Its address ends in `fund` like every coin here.
 * ⛔ There is no rehearsal mode that touches the chain (memory rehearsal-spent-real-money): without --launch this only reads.
 */
import { Connection, Keypair } from '@solana/web3.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, now, kvGet, launchingOpen } from './db.mjs'
import { freshCount } from './vanity.mjs'
import { MIN_LAUNCH_BALANCE, SITE_URL } from './launch.mjs'

export const PLATFORM_ROW_ID = 'site-platform'

/** Everything that must hold before the project token may be queued. Returns { ok, problems[], plan }. Reads only. */
export async function platformPlan({ db, conn, env = process.env }) {
  const ticker = String(env.PROJECT_TICKER ?? '').replace(/^\$/, '').toUpperCase()
  const name = String(env.PROJECT_NAME ?? '').trim()
  const problems = []
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(ticker)) problems.push('PROJECT_TICKER is not set')
  if (!name || new TextEncoder().encode(name).length > 32) problems.push('PROJECT_NAME is not set (up to 32 bytes)')
  if (kvGet(db, 'platform_mint')) problems.push(`the project token already launched: ${kvGet(db, 'platform_mint')}`)
  if (db.prepare("SELECT 1 FROM mentions WHERE platform = 1 AND state IN ('queued', 'launching', 'launched')").get()) problems.push('a project token launch is already queued or in flight')
  let wallet = null
  if (!env.PLATFORM_LAUNCH_KEY || !existsSync(env.PLATFORM_LAUNCH_KEY)) problems.push('PLATFORM_LAUNCH_KEY is not set: the wallet that launches the project token and receives its creator rewards')
  else wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.PLATFORM_LAUNCH_KEY, 'utf8')))).publicKey
  let balance = null
  if (wallet) {
    balance = await conn.getBalance(wallet, 'confirmed')
    if (balance < MIN_LAUNCH_BALANCE) problems.push(`the launch wallet ${wallet.toBase58()} holds ${balance / 1e9} SOL; it needs at least ${MIN_LAUNCH_BALANCE / 1e9}`)
  }
  const keys = freshCount(db)
  if (keys < 1) problems.push('no …fund mint keys are ready (deploy/ship-vanity.sh, or wait for the grinder)')
  if (!env.PINATA_JWT) problems.push('PINATA_JWT is not set (the logo and metadata cannot be pinned)')
  return { ok: problems.length === 0, problems, plan: { ticker, name, wallet: wallet?.toBase58() ?? null, balanceSol: balance == null ? null : balance / 1e9, mintKeysReady: keys, launchingOpen: launchingOpen(db), website: SITE_URL } }
}

/** Writes the one platform row (idempotent on its fixed id; a second project launch is also refused by the queue itself). */
export function queuePlatformLaunch(db, { ticker, name, env = process.env }) {
  const handle = String(env.X_HANDLE ?? '').replace(/^@/, '')
  const r = db.prepare(`INSERT OR IGNORE INTO mentions (tweet_id, author_id, author_handle, text, url, tweeted_at, seen_at, updated_at, state, symbol, name, mode, platform, venue, source, reply_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 'creator', 1, 'pump', 'site', 'skipped')`)
    .run(PLATFORM_ROW_ID, String(env.PLATFORM_X_ID || 'platform'), handle || 'pumpfund', `project token $${ticker} ${name}`, handle ? `https://x.com/${handle}` : '', now(), now(), now(), ticker, name)
  return r.changes === 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env
  if (!env.RPC_URL) { console.error('RPC_URL is not set: load /root/pumpfund-ops/api.env first'); process.exit(1) }
  const db = openDb(env.DB_PATH ?? join(env.DATA_DIR ?? './data', 'pumpfund.db'))
  const conn = new Connection(env.RPC_URL, 'confirmed')
  const { ok, problems, plan } = await platformPlan({ db, conn, env })
  console.log(`project token   $${plan.ticker}  "${plan.name}"  (logo: api/assets/project-token.png)`)
  console.log(`launch wallet   ${plan.wallet ?? 'not set'}${plan.balanceSol == null ? '' : `  (${plan.balanceSol} SOL)`}: pays the launch, is the creator, receives the creator rewards`)
  console.log(`mint keys ready ${plan.mintKeysReady} (address will end in fund)`)
  console.log(`launching now   ${plan.launchingOpen ? 'OPEN' : 'closed: opens when this launch lands'}`)
  if (!ok) { for (const p of problems) console.error(`⛔ ${p}`); process.exit(1) }
  if (!process.argv.includes('--launch')) { console.log('\nNothing was changed. Add --launch to queue it for real: it launches within seconds and cannot be undone.'); process.exit(0) }
  if (!queuePlatformLaunch(db, { ticker: plan.ticker, name: plan.name, env })) { console.error('⛔ already queued'); process.exit(1) }
  console.log('\nqueued. Waiting for the api to launch it …')
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const row = db.prepare('SELECT state, mint, signature, reason FROM mentions WHERE tweet_id = ?').get(PLATFORM_ROW_ID)
    if (row.state === 'launched') { console.log(`\n$${plan.ticker} is live.\n\nCA: ${row.mint}\n\ntx ${row.signature}\nlaunching is now ${launchingOpen(db) ? 'OPEN' : 'still closed (check the api log)'}`); process.exit(0) }
    if (row.state === 'failed' || row.state === 'rejected') { console.error(`⛔ ${row.state}: ${row.reason ?? ''}. Nothing launched. Delete the row to try again: DELETE FROM mentions WHERE tweet_id = '${PLATFORM_ROW_ID}'`); process.exit(1) }
  }
  console.error('still not landed after 3 minutes: is pumpfund-api running? (journalctl -u pumpfund-api -n 50)'); process.exit(1)
}
