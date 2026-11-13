/**
 * Prices and market data. Figures are for display; nothing on chain depends on them.
 *
 * ⛔ A graduated pump.fun coin's BondingCurve reads ALL ZEROES (memory: pumpfun-migrated-curve-reads-zero),
 * so a curve-priced market cap would show a live coin as $0. pump.fun's own API is read first, and
 * the curve is used only while `complete` is false.
 */
import { PublicKey } from '@solana/web3.js'
import { COIN_DECIMALS, POOL_INDEXES, bondingCurveAddress, decodeBondingCurve, decodePool, poolAddress, tokenAccountAmount } from '../lib/pump.mjs'

const SOL = 'So11111111111111111111111111111111111111112'
let solCache = { usd: 0, at: 0 }

/** SOL in USD from two sources; the last good price is kept through an outage. */
// ⛔ one fetch at a time, and a stale price is served while it refreshes: at launch traffic every request needs the price,
// and a 60 s expiry would send them all to Jupiter at once (memory launch-traffic-cache-stampede, jupiter-ratelimits-shared-box)
let solInFlight = null
export async function solUsd() {
  if (Date.now() - solCache.at < 60_000 && solCache.usd) return solCache.usd
  if (!solInFlight) solInFlight = fetchSolUsd().finally(() => { solInFlight = null })
  if (solCache.usd) { solInFlight.catch(() => {}); return solCache.usd }
  return solInFlight
}
async function fetchSolUsd() {
  const sources = [
    async () => (await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, { signal: AbortSignal.timeout(5000) })).json())[SOL]?.usdPrice,
    async () => (await (await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(5000) })).json()).data?.amount,
  ]
  for (const s of sources) {
    try { const v = Number(await s()); if (v > 0) { solCache = { usd: v, at: Date.now() }; return v } } catch {}
  }
  if (solCache.usd) return solCache.usd
  throw new Error('SOL price unavailable')
}

export const lamportsToUsd = (lamports, price) => (Number(lamports) / 1e9) * price

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const tokenPrices = new Map()
/**
 * One whole token of `mint` in USD (a paired coin's quote token), from DexScreener's deepest pair; USDC is 1. Null when
 * unknown: callers show the token amount and leave the USD figure out rather than guess.
 */
export async function tokenUsd(mint) {
  if (!mint) return null
  if (mint === USDC_MINT) return 1
  const hit = tokenPrices.get(mint)
  if (hit && Date.now() - hit.at < 120_000) return hit.usd
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(String(r.status))
    const pairs = ((await r.json()) ?? []).filter((x) => x?.baseToken?.address === mint && Number(x.priceUsd) > 0)
    const best = pairs.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0]
    const usd = best ? Number(best.priceUsd) : null
    tokenPrices.set(mint, { usd, at: Date.now() })
    if (tokenPrices.size > 500) tokenPrices.delete(tokenPrices.keys().next().value)
    return usd
  } catch { return hit?.usd ?? null }
}

/** pump.fun's public coin endpoint (the same one its site uses). */
// pump.fun moved single-coin lookups to /coins-v2 (Sep 2026); the old /coins/<mint> answers 404 for every coin.
export const pumpCoinUrl = (mint) => `https://frontend-api-v3.pump.fun/coins-v2/${mint}`

async function pumpCoin(mint) {
  const res = await fetch(pumpCoinUrl(mint), { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`pump.fun coin ${res.status}`)
  return res.json()
}

/**
 * A migrated coin's market cap from its PumpSwap pool: price = quote reserve / base reserve, times the
 * total supply. ⛔ The bonding curve of a migrated coin reads ALL ZEROES (memory
 * pumpfun-migrated-curve-reads-zero), so a curve-priced cap would show a live coin as $0.
 * Returns { marketCapUsd, pool } or null. Tries the pool address the API named first, then the PDAs.
 */
export async function poolMarketCap(conn, mint, price, knownPool = null, quote = null) {
  const m = new PublicKey(mint)
  const qMint = quote?.mint ? new PublicKey(quote.mint) : undefined, qDec = quote?.mint ? quote.decimals : 9
  const candidates = [...(knownPool ? [new PublicKey(knownPool)] : []), ...POOL_INDEXES.map((i) => poolAddress(m, qMint, i))]
  const infos = await conn.getMultipleAccountsInfo(candidates)
  const i = infos.findIndex((x) => x && x.data.length > 200)
  if (i < 0) return null
  const pool = decodePool(infos[i].data)
  const [base, qAcc] = await conn.getMultipleAccountsInfo([pool.pool_base_token_account, pool.pool_quote_token_account])
  if (!base || !qAcc) return null
  const b = Number(tokenAccountAmount(base.data)) / 10 ** COIN_DECIMALS, q = Number(tokenAccountAmount(qAcc.data)) / 10 ** qDec
  if (!(b > 0) || !(q > 0)) return null
  const supply = Number((await conn.getTokenSupply(m)).value.amount) / 10 ** COIN_DECIMALS
  return { marketCapUsd: (q / b) * price * supply, pool: candidates[i].toBase58() }
}

/** Market fields for one token row. Never throws: a failed read keeps the previous figures. */
export async function refreshMarket(db, conn, mint, price) {
  const update = {}
  const current = db.prepare('SELECT image, pool, quote_mint, quote_decimals, venue FROM tokens WHERE mint = ?').get(mint)
  // ⭐ a Float coin (Raydium LaunchLab, then its CPMM pool): DexScreener alone, no pump.fun reads
  if (current?.venue === 'float') return refreshFloatMarket(db, mint)
  // a paired coin is priced in its quote token: the fallbacks below need that token's USD price, not SOL's
  const quote = current?.quote_mint ? { mint: current.quote_mint, decimals: current.quote_decimals ?? 6 } : null
  if (quote) { const qp = await tokenUsd(quote.mint); if (!(qp > 0)) price = 0; else price = qp }
  const curveInfo = await conn.getAccountInfo(bondingCurveAddress(new PublicKey(mint))).catch(() => null)
  try {
    const c = await pumpCoin(mint)
    update.market_cap_usd = Number(c.usd_market_cap ?? 0)
    update.graduated = c.complete ? 1 : 0
    if (c.pump_swap_pool) update.pool = c.pump_swap_pool
    if (c.total_supply) update.price_usd = update.market_cap_usd / (Number(c.total_supply) / 1e6)
    if (c.image_uri && !current?.image) update.image = c.image_uri // never let the API replace a stored logo
  } catch {
    try {
      if (curveInfo) {
        const curve = decodeBondingCurve(curveInfo.data)
        if (!curve.complete) {
          const priceQ = Number(curve.virtual_quote_reserves) / 10 ** (quote ? quote.decimals : 9) / (Number(curve.virtual_token_reserves) / 1e6)
          if (price > 0) update.price_usd = priceQ * price
          if (update.price_usd != null) update.market_cap_usd = update.price_usd * (Number(curve.token_total_supply) / 1e6)
        } else update.graduated = 1
      }
    } catch {}
  }
  // Graduated (by either source): the pool is the price, whatever the API said the cap was.
  if (update.graduated === 1 || (curveInfo && decodeBondingCurve(curveInfo.data).complete)) {
    update.graduated = 1
    try {
      const pm = price > 0 ? await poolMarketCap(conn, mint, price, update.pool ?? current?.pool ?? null, quote) : null
      if (pm) { update.market_cap_usd = pm.marketCapUsd; update.pool = pm.pool; update.price_usd = pm.marketCapUsd / 1e9 }
    } catch {}
  }
  // 24h volume, trades and price change: DexScreener (free, no key; pump.fun curves and PumpSwap pools both listed).
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    if (r.ok) {
      const pairs = (await r.json()).filter?.((x) => x?.baseToken?.address === mint) ?? []
      if (pairs.length) {
        update.volume_24h_usd = pairs.reduce((s, x) => s + Number(x.volume?.h24 ?? 0), 0)
        update.trades_24h = pairs.reduce((s, x) => s + Number(x.txns?.h24?.buys ?? 0) + Number(x.txns?.h24?.sells ?? 0), 0)
        const main = pairs.slice().sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0]
        if (main?.priceChange?.h24 != null) update.change_24h = Number(main.priceChange.h24) / 100
      }
    }
  } catch {}
  try {
    if (curveInfo) {
      const curve = decodeBondingCurve(curveInfo.data)
      // 793.1M of the 1B supply is sold on the curve; progress is how much of that is gone.
      const INITIAL_REAL = 793_100_000_000_000
      update.curve_progress = curve.complete ? 1 : Math.max(0, Math.min(1, 1 - Number(curve.real_token_reserves) / INITIAL_REAL))
    }
  } catch {}
  if (!Object.keys(update).length) return
  update.market_at = Math.floor(Date.now() / 1000)
  const cols = Object.keys(update)
  db.prepare(`UPDATE tokens SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE mint = ?`).run(...cols.map((c) => update[c]), mint)
}

/** A Float coin's market numbers from DexScreener (it lists LaunchLab curves and Raydium pools). */
async function refreshFloatMarket(db, mint) {
  const update = {}
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    if (!r.ok) return
    const pairs = (await r.json()).filter?.((x) => x?.baseToken?.address === mint) ?? []
    if (!pairs.length) return
    const main = pairs.slice().sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0]
    if (Number(main.priceUsd) > 0) { update.price_usd = Number(main.priceUsd); update.market_cap_usd = Number(main.marketCap ?? main.fdv ?? update.price_usd * 1e9) }
    update.volume_24h_usd = pairs.reduce((s, x) => s + Number(x.volume?.h24 ?? 0), 0)
    update.trades_24h = pairs.reduce((s, x) => s + Number(x.txns?.h24?.buys ?? 0) + Number(x.txns?.h24?.sells ?? 0), 0)
    if (main?.priceChange?.h24 != null) update.change_24h = Number(main.priceChange.h24) / 100
    // graduated: its liquidity sits in a Raydium CPMM pool rather than the LaunchLab curve
    if (pairs.some((x) => (x.labels ?? []).some((l) => /cpmm/i.test(l)))) update.graduated = 1
  } catch { return }
  update.market_at = Math.floor(Date.now() / 1000)
  const cols = Object.keys(update)
  db.prepare(`UPDATE tokens SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE mint = ?`).run(...cols.map((c) => update[c]), mint)
}

