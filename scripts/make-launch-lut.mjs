/**
 * Creates the launch lookup table a site launch WITH A DEV BUY needs (create + buy, three signers: ~1,390 bytes without it,
 * ~1,100 with), and stores its address in the store (kv `launch_lut`), where the API reads it within 5 minutes (no restart).
 * Its contents are derived from pump.fun's own instructions (lib/lut.mjs), so run it again if pump.fun adds an account.
 *
 *   on the box:  set -a; . /root/pumpfund-ops/api.env; set +a; DATA_DIR=/var/lib/pumpfund node scripts/make-launch-lut.mjs
 *
 * ⛔ Spends real SOL from LAUNCH_KEY: the table's rent, about 0.003 SOL, plus fees. The OPERATOR runs this, once.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, kvGet, kvSet } from '../api/db.mjs'
import { loadGlobal, pumpProgram } from '../lib/pump.mjs'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'

const env = process.env
if (!env.RPC_URL || !env.LAUNCH_KEY) { console.error('RPC_URL and LAUNCH_KEY are needed (load api.env first)'); process.exit(1) }
const conn = new Connection(env.RPC_URL, 'confirmed')
const db = openDb(env.DB_PATH ?? join(env.DATA_DIR ?? './data', 'pumpfund.db'))
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.LAUNCH_KEY, 'utf8'))))
const addresses = await staticLaunchAccounts(pumpProgram(conn), await loadGlobal(conn))
const have = kvGet(db, 'launch_lut')
if (have && !process.argv.includes('--new')) {
  const cur = (await conn.getAddressLookupTable(new PublicKey(have))).value
  const missing = cur ? addresses.filter((a) => !cur.state.addresses.some((k) => k.toBase58() === a)) : addresses
  if (cur && !missing.length) { console.log(`launch table ${have} is current (${cur.state.addresses.length} addresses). Nothing to do.`); process.exit(0) }
  console.log(`launch table ${have} ${cur ? `lacks ${missing.length} addresses` : 'is not on chain'}: making a new one`)
}
console.log(`creating a lookup table with ${addresses.length} addresses, paid by ${authority.publicKey.toBase58()} (${(await conn.getBalance(authority.publicKey)) / 1e9} SOL)`)
const table = await createLaunchTable(conn, authority, addresses)
kvSet(db, 'launch_lut', table.toBase58())
console.log(`launch table ${table.toBase58()} stored. Dev buys switch on within 5 minutes.`)
