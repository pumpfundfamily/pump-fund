// DEV ONLY: the API on :5590 against the LOCAL validator (./validator.sh), with the sign-in stub, a stub pin, the bot loop
// working the queue and the launch lookup table made, so the launch page can be used end to end at http://localhost:5595
// (cd web && npm run dev). Sign in at /api/auth/x/start?as=alice&return=/launch. Refuses any RPC that is not localhost.
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { openDb, now, kvSet } from '../api/db.mjs'
import { createApp } from '../api/server.mjs'
import { FixtureX } from '../api/x.mjs'
import { loadGlobal, pumpProgram } from '../lib/pump.mjs'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8931'
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(RPC)) throw new Error('dev-site runs against a local validator only')
const conn = new Connection(RPC, 'confirmed')
for (const f of ['data/dev-site.db', 'data/dev-site.db-wal', 'data/dev-site.db-shm']) rmSync(f, { force: true })
const db = openDb('data/dev-site.db')
const launcher = Keypair.generate(), keeper = Keypair.generate()
const fund = async (pk, sol) => { const s = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
await fund(launcher.publicKey, 10); await fund(keeper.publicKey, 10)
for (let i = 0; i < 20; i++) { const k = Keypair.generate(); db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now()) }
const x = new FixtureX('PumpFund')
// every signed-in stub account passes the follower and age rules; any other handle "exists" on X with a made-up id
// (a handle starting with "nobody" does not), so the "who it funds" field can be tried end to end
x.userInfo = async (handle) => {
  const u = db.prepare('SELECT * FROM users WHERE lower(handle) = lower(?)').get(handle)
  if (u) return { id: u.x_id, handle: u.handle, name: u.name, avatar: null, followers: 500, createdAt: now() - 400 * 86400 }
  if (/^nobody/i.test(handle)) return null
  const id = String(BigInt('0x' + createHash('sha256').update(`devx:${handle.toLowerCase()}`).digest('hex').slice(0, 14)))
  return { id, handle, name: handle[0].toUpperCase() + handle.slice(1), avatar: null, followers: 12, createdAt: now() - 90 * 86400 }
}
const app = createApp({ env: { PUBLIC_URL: 'http://localhost:5595', DEV_STUBS: '1', FEE_SEED: 'cd'.repeat(32), START_OPEN: '1', PER_AUTHOR_COOLDOWN_SECONDS: '0', DATA_DIR: 'data' },
  db, conn, x, keeper, launcher, pin: async () => ({ uri: 'https://gateway.pinata.cloud/ipfs/bafkreidev', imageUri: '' }) })
if (process.env.NO_LUT !== '1') kvSet(db, 'launch_lut', (await createLaunchTable(conn, launcher, await staticLaunchAccounts(pumpProgram(conn), await loadGlobal(conn)))).toBase58())
app.server.listen(5590, '127.0.0.1', () => console.log('dev api on :5590 (local validator, stub sign-in)'))
app.bot.start(20_000, 1500)
