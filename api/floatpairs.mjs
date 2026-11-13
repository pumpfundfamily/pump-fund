/**
 * Float's pair list (operator 11 Nov): every enabled QuoteAsset account of the Float program (SOL, USDC, ~400 tokenized
 * stocks and coins), refreshed daily into float_pairs with each mint's ticker from its metadata.
 *
 * ⛔ Token-2022 pairs (most tokenized stocks: transfer hooks, pausable, permanent delegate) are refused for now: the dev
 * share would arrive in such a token, and paying it out needs each hook's extra accounts. SOL (unwrapped to plain SOL by
 * the keeper) and classic SPL tokens (paid like any paired coin) are supported.
 */
import bs58 from 'bs58'
import { FLOAT, floatIdl, floatCoder, TOKEN, WSOL } from '../lib/float.mjs'
import { tokenInfos, normTicker } from './pairs.mjs'
import { kvGet, kvSet, now } from './db.mjs'

const REFRESH_SECONDS = 86_400

export async function refreshFloatPairs(db, conn, { force = false } = {}) {
  if (!force && now() - Number(kvGet(db, 'float_pairs_at') ?? 0) < REFRESH_SECONDS && db.prepare('SELECT 1 FROM float_pairs LIMIT 1').get()) {
    return db.prepare('SELECT count(*) n FROM float_pairs').get().n
  }
  const disc = Buffer.from(floatIdl.accounts.find((a) => a.name === 'QuoteAsset').discriminator)
  const accs = await conn.getProgramAccounts(FLOAT, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }] })
  const qas = accs.map((a) => floatCoder.accounts.decode('QuoteAsset', a.account.data)).filter((q) => q.enabled)
  if (!qas.length) return 0 // an unreadable list keeps yesterday's rows
  const infos = await tokenInfos(conn, qas.map((q) => q.mint.toBase58()))
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM float_pairs').run()
    const ins = db.prepare('INSERT OR REPLACE INTO float_pairs (mint, symbol, name, decimals, program, global_config, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    qas.forEach((q, i) => { const t = infos[i]; if (t) ins.run(t.mint, t.symbol, t.name, t.decimals, t.program, q.global_config.toBase58(), now()) })
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  kvSet(db, 'float_pairs_at', now())
  return infos.filter(Boolean).length
}

const sol = { ok: true, quote: { kind: 'sol' } }

/**
 * A Float pair from what the post said: nothing / $SOL = SOL; a ticker from Float's list; or a listed mint address.
 * Returns { ok: true, quote: { kind: 'sol' } | { kind: 'float', mint, symbol, decimals, tokenProgram } } or { ok: false, code, reason }.
 */
export async function resolveFloatPair(db, conn, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return sol
  await refreshFloatPairs(db, conn).catch(() => 0)
  let row
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
    row = db.prepare('SELECT * FROM float_pairs WHERE mint = ?').get(raw)
    if (!row) return { ok: false, code: 'bad-pair', reason: 'That token is not on Float\'s pair list. Pair with SOL, USDC, or a token Float lists.' }
  } else {
    const t = normTicker(raw)
    if (t === 'SOL' || t === 'WSOL') return sol
    const hits = db.prepare("SELECT * FROM float_pairs WHERE upper(replace(symbol, '$', '')) = ?").all(t)
    if (hits.length > 1) return { ok: false, code: 'bad-pair', reason: `More than one Float pair is called $${t}. Pair with its contract address instead.` }
    if (!hits.length) return { ok: false, code: 'bad-pair', reason: `$${t} is not on Float's pair list. Pair with SOL, USDC, or a token Float lists.` }
    row = hits[0]
  }
  if (row.mint === WSOL.toBase58()) return sol
  if (row.program !== TOKEN.toBase58()) {
    return { ok: false, code: 'bad-pair', reason: `Pump Fund can't pay out creator rewards in $${normTicker(row.symbol) || 'that token'} yet. Pair it with SOL or USDC on Float.` }
  }
  return { ok: true, quote: { kind: 'float', mint: row.mint, symbol: normTicker(row.symbol) || null, name: row.name, decimals: row.decimals, tokenProgram: row.program } }
}
