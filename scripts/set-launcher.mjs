// Replaces the launch wallet with the key pasted into keys/mainnet/launcher-new.txt, ONLY if it derives the expected address.
//   node scripts/set-launcher.mjs <expected address>
// Accepts a base58 private key (Phantom/Solflare export) or a JSON byte array. Prints addresses only, never the key.
// The old launcher.json is kept as launcher.replaced-<time>.json; the pasted file is overwritten and deleted.
import { Keypair } from '@solana/web3.js'
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync, statSync } from 'node:fs'

const want = process.argv[2]
const IN = 'keys/mainnet/launcher-new.txt', OUT = 'keys/mainnet/launcher.json'
if (!want) { console.error('usage: node scripts/set-launcher.mjs <expected address>'); process.exit(1) }
const raw = readFileSync(IN, 'utf8').trim()
if (!raw) { console.error(`${IN} is empty: paste the private key, save, and run again`); process.exit(1) }
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58decode(s) {
  let n = 0n
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('not base58'); n = n * 58n + BigInt(i) }
  const bytes = []
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break }
  return Uint8Array.from(bytes)
}
let secret
try { secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : b58decode(raw) } catch { console.error('could not read that key: paste the private key exactly as exported'); process.exit(1) }
let kp
try { kp = secret.length === 64 ? Keypair.fromSecretKey(secret) : secret.length === 32 ? Keypair.fromSeed(secret) : null } catch { kp = null }
if (!kp) { console.error(`that is not a Solana private key (${secret.length} bytes)`); process.exit(1) }
const got = kp.publicKey.toBase58()
if (got !== want) { console.error(`that key belongs to ${got}, not ${want}: nothing changed`); process.exit(1) }
if (existsSync(OUT)) {
  const old = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(OUT, 'utf8')))).publicKey.toBase58()
  if (old === got) console.log('launcher.json already holds this wallet')
  else { const bak = `keys/mainnet/launcher.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; renameSync(OUT, bak); console.log(`old launcher ${old} kept as ${bak}`) }
}
writeFileSync(OUT, JSON.stringify([...kp.secretKey]), { mode: 0o600 })
writeFileSync(IN, '0'.repeat(statSync(IN).size)); rmSync(IN)
console.log(`launch wallet is now ${got} (${OUT}); the pasted file was wiped and deleted`)
