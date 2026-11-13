/**
 * Turns a tweet into a coin request, or into a reason it cannot be one. Pure: no network, no chain, no clock.
 * Ported from TAG (~/tag/server/src/parse.ts), which ran this on X in the open; Pons pairing removed, a fee-mode
 * phrase added. Everything decided here is permanent on chain (pump.fun metadata has NO update authority), so every
 * rule errs towards keeping what the author wrote.
 *
 *   @PumpFund $DOGE
 *   @PumpFund launch $DOGE Doge Coin
 *   @PumpFund deploy "Space Cats" $SCAT
 *   hey @PumpFund make me a token called Bread, ticker $BREAD
 *   @PumpFund $DOGE Doge Coin, fees to holders
 *   @PumpFund launch $FROG paired with $BONK          (a custom pair: api/pairs.mjs resolves it)
 *   @PumpFund $FROG Frog Club pair with <contract address>
 */

export const SYMBOL_MAX = 10 // pump.fun
export const NAME_MAX = 32 // pump.fun, in UTF-8 BYTES: a 33-byte name fails create_v2 with 6043 (proven 11 Nov: 32 CJK chars = 96 B)
const nameBytes = (s) => new TextEncoder().encode(s).length

const COMMAND_WORDS = new Set(['launch', 'launches', 'launching', 'deploy', 'deploys', 'deploying', 'create', 'creates', 'creating',
  'make', 'makes', 'making', 'mint', 'mints', 'minting', 'please', 'pls', 'plz', 'hey', 'yo', 'gm', 'can', 'you', 'u', 'a', 'an',
  'me', 'my', 'us', 'the', 'token', 'coin', 'called', 'named', 'name', 'ticker', 'symbol', 'for', 'with', 'new', 'i', 'want',
  'would', 'like', 'to', 'and'])
const NAMING_WORDS = new Set(['called', 'named', 'name'])
/** Hype/filler that is never a coin name: "@PumpFund $PEPE lfg" names the coin PEPE (operator 10 Nov: no name = the ticker). */
const FILLER_ONLY = new Set(['lfg', 'lfgg', 'lfggg', 'now', 'asap', 'rn', 'fr', 'wagmi', 'go', 'gogo', 'gogogo', 'ser', 'sir', 'bro', 'fam',
  'thanks', 'thx', 'ty', 'tysm', 'please', 'pls', 'plz', 'gm', 'yo', 'hey', 'pump', 'it', 'this', 'one', 'send', 'lets', "let's", 'cto'])
const isFillerOnly = (s) => { const w = s.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean); return w.length > 0 && w.every((x) => FILLER_ONLY.has(x)) }
const TRAILING_NOISE = new Set(['ticker', 'symbol', 'called', 'named', 'name', 'with', 'for', 'and', 'the', 'a', 'an', 'to', 'is', 'please', 'pls', 'plz'])
const QUOTES = `"“”'‘’`
const QUOTED = new RegExp(`[${QUOTES}]([^${QUOTES}]{1,80})[${QUOTES}]`)
const QUOTED_ALL = new RegExp(`[${QUOTES}][^${QUOTES}]{1,80}[${QUOTES}]`, 'g')

/** `$DOGE` anywhere; the first wins. Any length is matched so an over-long ticker is refused, not ignored. */
export const SYMBOL_PATTERN = /\$([A-Za-z][A-Za-z0-9]*)\b/

/**
 * "fees to holders" / "for holders" / "holders mode". ⭐ Since 10 Nov the fee mode is ONLY the author's setting on the site
 * (operator); the phrase no longer chooses anything, but it is still lifted OUT of the text so a coin never launches as
 * "Doge fees to holders" for ever. `request.mode` reports it for logs only. ⚠ A bare "holders" is NOT the phrase.
 */
export const HOLDERS_PATTERN = /\b(?:(?:creator\s+)?fees?\s+(?:go\s+)?(?:to|for)\s+(?:the\s+)?holders|for\s+(?:the\s+)?holders|holders?\s+mode)\b/i

/**
 * A custom pair (11 Nov): "paired with $BONK", "pair with <address>", "pairing it against $USDC", "pair $BONK". The phrase
 * is lifted out before the ticker and the name are read, so $BONK is never taken for the coin's own ticker or name.
 */
/** ⭐ Float (11 Nov): "on Float" / "via Float" picks Float for this post; "on Pumpfun" / "on pump.fun" picks pump.fun. */
export const VENUE_PATTERN = /\b(?:on|via|using|thru|through)\s+(float(?:launch)?|pump(?:\.?fun)?)(?:\.xyz|\.fun)?\b/i
/**
 * Launching FOR someone (operator 12 Nov): "launch $DOGE for @alice", "$DOGE for @alice", "for: @alice". The coin is
 * @alice's: its creator rewards are hers (paid to her X Money). The handle is resolved to X's numeric id before launch.
 * ⚠ "for holders" (the fee phrase) has no @, so the two never collide.
 */
export const FOR_PATTERN = /\bfor:?\s+@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/i
export const PAIR_PATTERN = /\b(?:paired|pairing|pair)\s+(?:it\s+)?(?:with|w\/|against|to|on|vs\.?)?\s*(?:\$([A-Za-z][A-Za-z0-9.]{0,11})|([1-9A-HJ-NP-Za-km-z]{32,44}))(?![A-Za-z0-9])/i

export function stripNoise(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ') // t.co links X appends for media
    .replace(/@[A-Za-z0-9_]{1,15}/g, ' ') // every mention, not only ours
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

export function findSymbol(text) {
  const m = String(text).match(SYMBOL_PATTERN)
  return m?.[1] ? m[1].toUpperCase() : null
}

const bare = (w) => w.replace(/[^A-Za-z]/g, '').toLowerCase()

export function stripLeadingCommand(text) {
  const words = text.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const b = bare(words[i])
    if (!b || !COMMAND_WORDS.has(b)) break
    i++
    if (NAMING_WORDS.has(b)) break // what follows "called" is the name as given
  }
  return words.slice(i).join(' ')
}

export function stripTrailingNoise(text) {
  const words = text.split(/\s+/).filter(Boolean)
  let end = words.length
  while (end > 0) {
    const b = bare(words[end - 1])
    if (!b || !TRAILING_NOISE.has(b)) break
    end--
  }
  return words.slice(0, end).join(' ')
}

export function firstClause(text) {
  for (const seg of text.split(',')) {
    const c = stripTrailingNoise(stripLeadingCommand(seg.trim()))
    if (c) return c
  }
  return ''
}

const tidy = (s) => s.replace(/\s+/g, ' ').replace(/^[\s,.:;!?\-–—/|]+/, '').replace(/[\s,.:;\-–—/|]+$/, '').trim()

/** Removes characters that render as nothing (zero-width, bidi controls): memory nfkc-misses-zero-width-chars. */
const clean = (s) => s.normalize('NFKC').replace(/\p{Cf}/gu, '')

/**
 * @returns {{ ok: true, request: { symbol, name, mode: 'creator'|'holders'|null, pair: string|null, venue: 'pump'|'float'|null, forHandle?: string } } | { ok: false, code, message }}
 * `mode` is null when the tweet did not say (the author's site setting applies). `pair` is '$BONK' or an address as
 * written, null for the default (SOL); api/pairs.mjs decides whether pump.fun accepts it.
 */
export function parseTweet(text) {
  // "for @alice" first, from the raw text: stripNoise removes every @mention
  let forHandle = null
  const raw = clean(String(text ?? '')).replace(QUOTED_ALL, (m) => ' '.repeat(m.length)) // never from inside a quoted name
  const fm = raw.match(FOR_PATTERN)
  if (fm) { forHandle = fm[1]; text = String(text).slice(0, fm.index) + ' ' + String(text).slice(fm.index + fm[0].length) }
  let t = clean(stripNoise(text))
  if (!t.trim()) return { ok: false, code: 'empty', message: 'There was nothing in that post to launch. Add a cashtag like $COIN.' }

  // The fee-mode phrase comes out first, outside quotes only (a quoted name is the author's exact words).
  let mode = null
  const quoted = []
  let searchable = t.replace(QUOTED_ALL, (m) => { quoted.push(m); return `\u0000${quoted.length - 1}\u0000` })
  if (HOLDERS_PATTERN.test(searchable)) { mode = 'holders'; searchable = searchable.replace(HOLDERS_PATTERN, ' ') }
  let venue = null
  const vm = searchable.match(VENUE_PATTERN)
  if (vm) { venue = /^float/i.test(vm[1]) ? 'float' : 'pump'; searchable = searchable.replace(VENUE_PATTERN, ' ') }
  let pair = null
  const pm = searchable.match(PAIR_PATTERN)
  if (pm) { pair = pm[1] ? `$${pm[1].toUpperCase()}` : pm[2]; searchable = searchable.replace(PAIR_PATTERN, ' ') }
  t = searchable.replace(/\u0000(\d+)\u0000/g, (_m, i) => quoted[Number(i)] ?? '')

  const symbol = findSymbol(t)
  if (!symbol) return { ok: false, code: 'no-ticker', message: 'Add a cashtag with a dollar sign, like $COIN, and it will launch.' }
  if (symbol.length > SYMBOL_MAX) return { ok: false, code: 'bad-ticker', message: `A cashtag can be up to ${SYMBOL_MAX} letters or numbers. Try a shorter one.` }

  const q = t.match(QUOTED)?.[1]?.trim()
  if (q) {
    const name = tidy(q)
    if (nameBytes(name) > NAME_MAX) return { ok: false, code: 'name-too-long', message: `A token name can be up to ${NAME_MAX} characters. Try a shorter one.` }
    return { ok: true, request: { symbol, name: name || symbol, mode, pair, ...(venue ? { venue } : {}), ...(forHandle ? { forHandle } : {}) } }
  }
  let rest = tidy(firstClause(tidy(t.replace(SYMBOL_PATTERN, ' '))))
  if (isFillerOnly(rest)) rest = ''
  if (nameBytes(rest) > NAME_MAX) return { ok: false, code: 'name-too-long', message: `A token name can be up to ${NAME_MAX} characters. Try a shorter one.` }
  return { ok: true, request: { symbol, name: rest || symbol, mode, pair, ...(venue ? { venue } : {}), ...(forHandle ? { forHandle } : {}) } }
}

const LAUNCH_VERBS = /\b(?:launch(?:es|ing)?|deploy(?:s|ing)?|creat(?:e|es|ing)|mint(?:s|ing)?|mak(?:e|es|ing))\b/i

/**
 * Somebody trying to launch a coin, as opposed to talking to (or about) the account. Only these are queued or answered
 * (operator 10 Nov): one or two distinct $TICKERs (a longer list is a shill post) AND either a launch word, or the ticker
 * DIRECTLY after the @mentions that include ours: `@PumpFund $DOGE`, or `@someone @PumpFund $DOGE` in a reply
 * (launching a meme with the parent post's picture). `$SOL looking strong @PumpFund` and a thread where we are only
 * carried along (`@PumpFund @bob nice one $DOGE`) are not requests.
 */
export function hasLaunchIntent(text, handle = 'PumpFund') {
  const b = stripNoise(text).replace(QUOTED_ALL, ' ')
  const tickers = new Set([...b.matchAll(/\$([A-Za-z][A-Za-z0-9]*)\b/g)].map((x) => x[1].toUpperCase()))
  if (tickers.size === 0 || tickers.size > 2) return false
  if (LAUNCH_VERBS.test(b)) return true
  const tickerAfterUs = new RegExp(`(?:^|\\s)(?:@[A-Za-z0-9_]{1,15}\\s+)*@${handle}\\b(?:\\s+@[A-Za-z0-9_]{1,15})*[\\s,:]+\\$[A-Za-z]`, 'i')
  return tickerAfterUs.test(String(text ?? ''))
}

export function isLaunchRequest(m, handle, { allowSelf = false } = {}) {
  if (m.isRetweet) return false
  if (!allowSelf && m.authorHandle.toLowerCase() === handle.toLowerCase()) return false
  if (!new RegExp(`@${handle}\\b`, 'i').test(m.text)) return false
  return hasLaunchIntent(m.text, handle)
}
