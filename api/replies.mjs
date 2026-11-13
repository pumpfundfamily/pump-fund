/**
 * What @PumpFund says back. Ported from TAG's replies.ts.
 *
 * ⭐ Variation is seeded from the MINT, never Math.random(): a failed send is retried, and a retry must say the same
 * thing (TAG's old account died of 35 identical link replies in 4 hours, so the shapes vary per coin).
 * ⛔ Copy rules: no emojis, no hashtags, no em dash or `--` (memory social-text-no-dashes-hashtags-emojis).
 * The CA is always in the reply: FOMO's X cashtag button trades "all Solana tokens", and how it picks between coins that
 * share a ticker is not documented, so the address is the only unambiguous handle.
 */
export const TWEET_LIMIT = 280

/**
 * ⛔ Operator rule (10 Nov): replies NEVER contain emojis, hashtags or "--" (nor long dashes). Applied to every reply as the
 * last step, so a coin name typed with an emoji or a hashtag cannot carry one into our post either.
 */
export function cleanReply(text) {
  return String(text)
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '') // emojis, flags, joiners
    .replace(/#/g, '') // never a hashtag
    .replace(/\s*(?:--+|—|–)\s*/g, ', ') // never "--" or long dashes
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([,.])/g, '$1').replace(/,\s*,/g, ',').replace(/ +\n/g, '\n').replace(/\n +/g, '\n')
    .trim()
}
const TCO = 23

export function tweetLength(text) {
  return Array.from(text.replace(/https?:\/\/\S+/g, 'x'.repeat(TCO))).length
}

function pick(seed, options) {
  let acc = 0
  for (const ch of String(seed).toLowerCase()) acc = (acc * 31 + ch.charCodeAt(0)) % 1_000_003
  return options[acc % options.length]
}

const OPENINGS = ['is live', 'just launched', 'is trading now', 'is live on Pumpfun']

// operator 11 Nov: every launch reply ends with "CA: <mint>", no fee line, no link
export function launchedReply({ symbol, name, mint, mode = 'creator', pair = null, venue = 'pump', forHandle = null }) {
  // the platform token (operator 10 Nov): exactly the ticker and the CA, nothing else
  if (mode === 'platform') return cleanReply(`$${symbol} is live.\n\nCA: ${mint}`)
  // a Float coin says where it is (operator 11 Nov); a pump.fun coin keeps the rotating openings
  const opening = venue === 'float' ? 'is live on Float' : pick(mint, OPENINGS)
  // operator 11 Nov: the ticker only, never the coin's name ("$FROG just launched.", "$PILL is live paired with $PUMP")
  const head = pair
    ? `$${symbol} is live${venue === 'float' ? ' on Float' : ''} paired with ${/^[A-Za-z][A-Za-z0-9.]*$/.test(pair) ? '$' + pair.toUpperCase() : pair}`
    : `$${symbol} ${opening}.`
  // a coin launched FOR someone (12 Nov) says whose it is: its creator rewards go to their X Money
  const forLine = forHandle ? `\n\nLaunched for @${forHandle}: its creator rewards go to their X Money.` : ''
  return cleanReply(`${head}${forLine}\n\nCA: ${mint}`)
}

export function rejectedReply(reason) {
  let text = cleanReply(reason)
  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (!/[.!?]$/.test(text)) text += '.'
  return tweetLength(text) <= TWEET_LIMIT ? text : `${Array.from(text).slice(0, TWEET_LIMIT - 1).join('')}…`
}

export const failedReply = () => 'That launch did not go through. Posting again puts it back in the queue.'
