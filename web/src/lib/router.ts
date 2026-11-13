import { useEffect, useState } from 'react'

/** Real paths. ⚠ The host must fall back to index.html (Caddy `try_files {path} /index.html`). */
export type Route =
  | { name: 'home' } | { name: 'payouts' } | { name: 'explore' } | { name: 'launch' } | { name: 'account' } | { name: 'docs' } | { name: 'terms' } | { name: 'privacy' }
  | { name: 'token'; mint: string } | { name: 'creator'; handle: string } | { name: 'paypal'; handle: string } | { name: 'not-found' }

const SIMPLE = ['explore', 'launch', 'account', 'docs', 'terms', 'privacy', 'payouts'] as const

export function parse(pathname: string): Route {
  let parts: string[]
  try { parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean).map(decodeURIComponent) } catch { return { name: 'not-found' } }
  if (parts.length === 0) return { name: 'home' }
  const [a, b] = parts
  if (parts.length === 1 && (SIMPLE as readonly string[]).includes(a!)) return { name: a as (typeof SIMPLE)[number] }
  if (parts.length === 2 && (a === 't' || a === 'token') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b!)) return { name: 'token', mint: b! }
  if (parts.length === 2 && a === 'paypal' && /^[A-Za-z0-9._-]{1,40}$/.test(b!)) return { name: 'paypal', handle: b!.toLowerCase() }
  if (parts.length === 2 && a === 'x' && /^[A-Za-z0-9_]{1,15}$/.test(b!)) return { name: 'creator', handle: b! }
  return { name: 'not-found' }
}

export function navigate(to: string) {
  const [path, hash] = to.split('#')
  if (path && path !== location.pathname + location.search) {
    history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  requestAnimationFrame(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView({ block: 'start' })
    else window.scrollTo(0, 0)
  })
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname))
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname))
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return route
}
