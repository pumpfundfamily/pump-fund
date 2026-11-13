/**
 * Custom pairs: "@PumpFund $FROG paired with $BONK" (or with a contract address) launches $FROG against BONK instead of
 * SOL, exactly as pump.fun's own create screen can (lib/pump.mjs resolveQuote; proven on a mainnet clone 11 Nov).
 *
 *   by ticker    only tokens on pump.fun's own pair list (the quote-control account, 231 mints on 11 Nov, every ticker
 *                unique) plus USDC. ⛔ Never pick a pump.fun coin by its ticker: tickers are shared, the address is the
 *                only unambiguous handle (memory pons-graduated-unclaimed-fees). A ticker that is not on the list is
 *                refused with a reply asking for the address.
 *   by address   anything pump.fun accepts: a listed token, USDC, or a pump.fun coin on its curve or on PumpSwap.
 *   $SOL         the default pair; same as writing nothing.
 *
 * The list's tickers are read from each mint's metadata (Metaplex, or the Token-2022 metadata extension) once a day.
 */
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022, USDC, WSOL, readQuoteControl, resolveQuote } from '../lib/pump.mjs'
import { now, kvGet, kvSet } from './db.mjs'

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const REFRESH_SECONDS = 86_400

const readStr = (b, o) => {
  const n = b.readUInt32LE(o)
  if (n > 200 || o + 4 + n > b.length) throw new Error('bad string')
  return [b.subarray(o + 4, o + 4 + n).toString('utf8').replace(/\0+$/g, '').trim(), o + 4 + n]
}
/** Ticker and name from a mint's metadata: Metaplex account first, then Token-2022's own metadata extension. */
export function readTokenMeta(mintInfo, metaplexInfo) {
  try {
    if (metaplexInfo) { let o = 65, name, symbol; [name, o] = readStr(metaplexInfo.data, o); [symbol] = readStr(metaplexInfo.data, o); return { name, symbol } }
    if (mintInfo?.owner.equals(TOKEN_2022) && mintInfo.data.length > 166) {
      const d = mintInfo.data
      for (let o = 166; o + 4 <= d.length;) {
        const type = d.readUInt16LE(o), len = d.readUInt16LE(o + 2)
        if (type === 19) { let p = o + 4 + 64, name, symbol; [name, p] = readStr(d, p); [symbol] = readStr(d, p); return { name, symbol } }
        o += 4 + len
      }
    }
  } catch {}
  return { name: null, symbol: null }
}
const metaplexAddress = (mint) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0]
/** A stored ticker is compared without a leading $ and case-insensitively ("$WIF" and "Bonk" are on the list as written). */
export const normTicker = (s) => String(s ?? '').trim().replace(/^\$/, '').toUpperCase()

/** Metadata for a batch of mints: [{ mint, symbol, name, decimals, program }] (null entries for non-mints). */
export async function tokenInfos(conn, mints) {
  const out = []
  for (let i = 0; i < mints.length; i += 50) {
    const chunk = mints.slice(i, i + 50).map((m) => new PublicKey(m))
    const [mi, me] = [await conn.getMultipleAccountsInfo(chunk), await conn.getMultipleAccountsInfo(chunk.map(metaplexAddress))]
    chunk.forEach((m, j) => {
      if (!mi[j] || mi[j].data.length < 82) return out.push(null)
      out.push({ mint: m.toBase58(), ...readTokenMeta(mi[j], me[j]), decimals: mi[j].data[44], program: mi[j].owner.toBase58() })
    })
  }
  return out
}

/** Re-reads pump.fun's pair list into pair_tokens (at most daily unless forced). Returns the row count. */
export async function refreshPairList(db, conn, { force = false } = {}) {
  if (!force && now() - Number(kvGet(db, 'pair_list_at') ?? 0) < REFRESH_SECONDS && db.prepare('SELECT 1 FROM pair_tokens LIMIT 1').get()) {
    return db.prepare('SELECT count(*) n FROM pair_tokens').get().n
  }
  const listed = await readQuoteControl(conn)
  if (!listed.length) return 0 // an unreadable list keeps yesterday's rows
  const infos = (await tokenInfos(conn, [...listed, USDC.toBase58()])).filter(Boolean)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM pair_tokens').run()
    const ins = db.prepare('INSERT OR REPLACE INTO pair_tokens (mint, symbol, name, decimals, program, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const t of infos) ins.run(t.mint, t.symbol, t.name, t.decimals, t.program, now())
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  kvSet(db, 'pair_list_at', now())
  return infos.length
}

/** The ticker a pair shows as: the list's own spelling without a leading $, else the mint's metadata, else a short address. */
const displayTicker = (sym, mint) => (sym ? String(sym).replace(/^\$/, '').slice(0, 12) : `${mint.slice(0, 4)}…${mint.slice(-4)}`)

/**
 * `input` as written in the post ('$BONK', 'BONK', or an address) → { ok: true, quote } where `quote` is a resolveQuote()
 * result plus { symbol, name } (kind 'sol' for SOL), or { ok: false, code, reason }. code 'pair-wait' = try again shortly.
 */
export async function resolvePair(db, conn, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: true, quote: { kind: 'sol' } }
  let mint = null
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
    try { mint = new PublicKey(raw).toBase58() } catch { return { ok: false, code: 'bad-pair', reason: 'That pair is not a token address.' } }
  } else {
    const t = normTicker(raw)
    if (!/^[A-Z0-9.]{1,12}$/.test(t)) return { ok: false, code: 'bad-pair', reason: 'Pair with a $CASHTAG from Pumpfun\'s pair list or a contract address.' }
    if (t === 'SOL' || t === 'WSOL') return { ok: true, quote: { kind: 'sol' } }
    await refreshPairList(db, conn).catch(() => 0)
    const hits = db.prepare("SELECT * FROM pair_tokens WHERE upper(replace(symbol, '$', '')) = ?").all(t)
    if (hits.length !== 1) {
      return { ok: false, code: 'bad-pair', reason: hits.length
        ? `More than one token is called $${t}. Pair with its contract address instead.`
        : `$${t} is not on Pumpfun's pair list. To pair with a Pumpfun token, use its contract address.` }
    }
    mint = hits[0].mint
  }
  if (mint === WSOL.toBase58()) return { ok: true, quote: { kind: 'sol' } }
  const listed = db.prepare('SELECT mint FROM pair_tokens').all().map((r) => r.mint)
  const q = await resolveQuote(conn, mint, listed.length ? { listed } : {})
  if (!q.ok) return { ok: false, code: q.code ?? 'bad-pair', reason: q.reason }
  if (q.kind === 'sol') return { ok: true, quote: q }
  const known = db.prepare('SELECT symbol, name FROM pair_tokens WHERE mint = ?').get(mint)
  const meta = known ?? (await tokenInfos(conn, [mint]))[0] ?? {}
  return { ok: true, quote: { ...q, symbol: displayTicker(meta.symbol, mint), name: meta.name ?? null } }
}
