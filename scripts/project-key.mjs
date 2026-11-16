// Reads keys/mainnet/project-wallet.key (the operator pastes the private key of the wallet $FUND is launched from: base58
// as Phantom exports it, or a [..] array), writes it as a Solana keypair JSON to `out` (0600), and prints ONLY the public
// address. ⛔ Never prints, logs or echoes the secret. Used by deploy/push-env.sh.
//   node scripts/project-key.mjs <in> <out>       → prints the address
//   node scripts/project-key.mjs <in>             → prints the address, writes nothing
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

const [inPath, outPath] = process.argv.slice(2)
const text = readFileSync(inPath, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('').trim()
if (!text) { console.error(`${inPath} has no key yet (paste it on the empty line, save)`); process.exit(2) }
let secret
try {
  secret = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text.replace(/\s+/g, ''))
} catch { console.error(`${inPath}: not a base58 key or a [..] array`); process.exit(2) }
let kp
try {
  kp = secret.length === 64 ? Keypair.fromSecretKey(secret) : secret.length === 32 ? Keypair.fromSeed(secret) : null
} catch { kp = null }
if (!kp) { console.error(`${inPath}: not a valid Solana private key (${secret.length} bytes)`); process.exit(2) }
if (outPath) { writeFileSync(outPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 }); chmodSync(outPath, 0o600) }
console.log(kp.publicKey.toBase58())
