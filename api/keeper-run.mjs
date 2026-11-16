/**
 * One keeper pass, then exit (systemd timer: deploy/pumpfund-keeper.timer). See api/keeper.mjs.
 *   node api/keeper-run.mjs            a real pass
 *   DRY=1 node api/keeper-run.mjs      reads and prints what each coin holds; sends nothing
 */
import { Connection, Keypair } from '@solana/web3.js'
import { pacedFetch } from '../lib/paced.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, buckets } from './db.mjs'
import { keeperPass, keeperConfig, readCoin } from './keeper.mjs'
import { parseSeed, feeWallet } from './feewallet.mjs'
import { pumpProgram } from '../lib/pump.mjs'
import { solUsd } from './market.mjs'
import { xmoneyConfig, xmoneyPass, realRails } from './xmoney.mjs'
import { trackAllExternal } from './feetrack.mjs'
import { fundPass } from './projectfund.mjs'

const env = process.env
const db = openDb(env.DB_PATH ?? join(env.DATA_DIR ?? './data', 'pumpfund.db'))
// ⛔ every keeper RPC call is spaced (~6/s): the key is shared with the site's launches and other projects
const conn = new Connection(env.RPC_URL ?? 'http://127.0.0.1:8899', { commitment: 'confirmed', fetch: pacedFetch(Number(env.KEEPER_RPC_GAP_MS ?? 160)) })
const seed = parseSeed(env.FEE_SEED)
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.KEEPER_KEY, 'utf8'))))
const log = { info: (m) => console.log(m), error: (m) => console.error(m) }

if (env.DRY === '1') {
  for (const coin of db.prepare('SELECT * FROM tokens').all()) {
    const ok = feeWallet(seed, coin.mint).publicKey.toBase58() === coin.fee_wallet
    const r = await readCoin(conn, coin)
    const b = buckets(db, coin.mint)
    console.log(`$${coin.symbol} ${coin.mint} mode=${coin.mode} seed=${ok ? 'ok' : 'MISMATCH'} wallet=${r.wallet / 1e9} waiting=${(r.vault + r.ammVault + r.curveFee + r.poolFee) / 1e9} creator=${b.creator / 1e9} holders=${b.holders / 1e9}`)
  }
  process.exit(0)
}

const balance = await conn.getBalance(keeper.publicKey)
if (balance < 5_000_000) { console.error(`keeper ${keeper.publicKey.toBase58()} holds ${balance / 1e9} SOL: fund it to collect and pay`); process.exit(1) }
const price = await solUsd().catch(() => null)
const results = await keeperPass({ db, conn, pump: pumpProgram(conn), keeper, seed, cfg: keeperConfig(env), solUsd: price, log })
if (results.length) console.log(JSON.stringify(results))
// ⭐ $FUND: half of its rewards to SEAL (api/projectfund.mjs). The project wallet's key is needed only until the split is
// locked; a problem here is logged, never allowed to stop the rest of the pass
try {
  const project = env.PROJECT_WALLET_KEY && existsSync(env.PROJECT_WALLET_KEY) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.PROJECT_WALLET_KEY, 'utf8')))) : null
  const f = await fundPass({ db, conn, pump: pumpProgram(conn), keeper, seed, project, env, log })
  if (f && Object.keys(f).length && !f.idle) console.log(JSON.stringify({ fund: f }))
} catch (e) { console.error(`$FUND pass: ${e.message}`) }
// fees pump.fun pays out itself (holder-reward coins, the platform coin): counted from the chain for the site
try { const f = await trackAllExternal(db, conn, { log }); if (f.length) console.log(JSON.stringify({ feetrack: f })) } catch (e) { console.error(`feetrack: ${e.message}`) }
// X Money payouts (api/xmoney.mjs): only when switched on; Relay, Base and Peer are loaded only then
const xcfg = xmoneyConfig(env)
if (xcfg.enabled) {
  // an X Money problem is logged, never allowed to fail the keeper (fees, payouts and airdrops already ran above)
  try {
    const x = await xmoneyPass({ db, conn, keeper, seed, rails: await realRails(seed, xcfg), cfg: xcfg, solUsd: price, log })
    if (x.length) console.log(JSON.stringify(x))
  } catch (e) { console.error(`xmoney pass: ${e.message}`) }
}
process.exit(0)
