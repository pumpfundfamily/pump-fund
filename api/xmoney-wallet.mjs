/**
 * Prints the X Money payouts' Base wallet (derived from FEE_SEED) and what it holds. Prints no secret.
 *   FEE_SEED_FILE=keys/mainnet/fee-seed.hex node api/xmoney-wallet.mjs
 * It needs a little ETH on Base for gas: each Peer listing / withdrawal / bridge back costs a few cents at most.
 */
import { readFileSync } from 'node:fs'
import { parseSeed } from './feewallet.mjs'
import { realRails, xmoneyConfig } from './xmoney.mjs'

const hex = process.env.FEE_SEED ?? (process.env.FEE_SEED_FILE ? readFileSync(process.env.FEE_SEED_FILE, 'utf8') : '')
const rails = await realRails(parseSeed(hex), xmoneyConfig())
const eth = await rails.base.ethBalance(), usdc = await rails.base.usdcBalance()
console.log(`Base wallet  ${rails.baseAddress}`)
console.log(`ETH          ${Number(eth) / 1e18}`)
console.log(`USDC         ${Number(usdc) / 1e6}`)
const open = (await rails.peer.orders()).filter((o) => o.isInFlight)
console.log(`Peer orders  ${open.length} open`)
process.exit(0)
