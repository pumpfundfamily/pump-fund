/**
 * GitHub accounts as recipients. A login is resolved to GitHub's NUMERIC user id through GitHub's public API, once, before
 * a launch: Pumpfun keys the account's rewards on that id (lib/feeshare.mjs socialFeeAddress), and a login can be renamed
 * and re-registered by someone else, so a login is never what is stored as the recipient.
 * Unauthenticated the API allows 60 lookups an hour per IP; GITHUB_TOKEN (any token, no scopes) raises that to 5,000.
 * Answers are kept 10 minutes per login, failures 20 seconds.
 */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

/** "@octocat", "github.com/octocat" → "octocat"; '' when empty; null when it cannot be a login. */
export function cleanLogin(raw) {
  const v = String(raw ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '')
  if (!v) return ''
  return GITHUB_LOGIN.test(v) && !v.includes('--') ? v : null
}

export function githubLookup({ token = process.env.GITHUB_TOKEN ?? '', fetchImpl = fetch } = {}) {
  const cache = new Map()
  /** { id, login, name, avatar } | null (no such user or not a person/organisation account). Throws when GitHub cannot be asked. */
  return async function lookup(login) {
    const k = String(login).toLowerCase(), hit = cache.get(k)
    if (hit && hit.until > Date.now()) { if (hit.error) throw hit.error; return hit.user }
    if (cache.size > 2000) cache.clear()
    try {
      const r = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'pumpfund', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(8000) })
      if (r.status === 404) { cache.set(k, { user: null, until: Date.now() + 600_000 }); return null }
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
      const u = await r.json()
      const user = Number.isSafeInteger(u?.id) && u.id > 0 && typeof u.login === 'string' ? { id: String(u.id), login: u.login, name: String(u.name || u.login), avatar: /^https:\/\/avatars\.githubusercontent\.com\//.test(u.avatar_url ?? '') ? u.avatar_url : '' } : null
      cache.set(k, { user, until: Date.now() + 600_000 })
      return user
    } catch (error) { cache.set(k, { error, until: Date.now() + 20_000 }); throw error }
  }
}
