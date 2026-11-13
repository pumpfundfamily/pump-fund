/**
 * A fetch that spaces requests at least `gapMs` apart (one queue per process). For background work sharing a
 * rate-limited RPC key with live traffic: Helius limits BURSTS (memory rpc-rate-limit-is-a-burst-limit), and the
 * keeper reading ~80 coins back to back drew 429s for the site and the box's other projects (11 Nov).
 */
export function pacedFetch(gapMs = 160, base = globalThis.fetch) {
  let next = 0
  return async (...args) => {
    const at = Math.max(Date.now(), next)
    next = at + gapMs
    if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()))
    return base(...args)
  }
}
