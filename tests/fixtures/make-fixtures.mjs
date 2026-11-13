// Local-validator fixtures for the pair tests (throwaway keys, local only):
//   node tests/fixtures/make-fixtures.mjs
//   usdc-mint.json + usdc-authority.json   the real USDC mint with its authority swapped (from ~/earn)
//   bonk-mint.json + bonk-authority.json   the real BONK mint (on pump.fun's pair list) with an authority we hold,
//                                          so tests can mint BONK, buy a BONK-paired coin and earn fees in BONK
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { existsSync, writeFileSync } from 'node:fs'
const here = new URL('./', import.meta.url)
const conn = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
async function swapAuthority(name, address) {
  if (existsSync(new URL(`${name}-mint.json`, here))) return
  const authority = Keypair.generate()
  writeFileSync(new URL(`${name}-authority.json`, here), JSON.stringify([...authority.secretKey]))
  const info = await conn.getAccountInfo(new PublicKey(address))
  const data = Buffer.from(info.data)
  data.writeUInt32LE(1, 0) // COption<Pubkey> mint_authority = Some
  authority.publicKey.toBuffer().copy(data, 4)
  writeFileSync(new URL(`${name}-mint.json`, here), JSON.stringify({ pubkey: address, account: { lamports: info.lamports, data: [data.toString('base64'), 'base64'], owner: info.owner.toBase58(), executable: false, rentEpoch: 0, space: data.length } }))
  console.log(`${name}-mint.json (authority ${authority.publicKey.toBase58()})`)
}
await swapAuthority('bonk', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')
