/**
 * The charities a coin's creator rewards can go to: Donate.gg's directory as collected for Pons Charity (2,705 entries,
 * api/assets/charities.json: n name, s slug, c config id 0x…64, e EIN, l logo, p place, m mission).
 *
 * ⛔ A charity is ALWAYS picked from this list, by its id, and the id is looked up here again at launch. Pumpfun's donation
 * relay does not validate ids: a typed or altered id still "works" and the money goes to nobody (memory
 * pumpfun-social-and-donation-fee-pdas). There is no free-text path to a charity id anywhere.
 */
import { readFileSync } from 'node:fs'

let list = null, byId = null
function load() {
  if (list) return
  list = JSON.parse(readFileSync(new URL('./assets/charities.json', import.meta.url), 'utf8'))
    .filter((c) => /^0x[0-9a-fA-F]{64}$/.test(c.c) && c.n)
    .map((c) => ({ id: c.c.toLowerCase(), name: String(c.n).replace(/\s*--+\s*/g, ', ').replace(/\s*[\u2013\u2014]\s*/g, ', '), slug: String(c.s ?? ''), ein: String(c.e ?? ''), logo: /^https:\/\//.test(c.l ?? '') ? c.l : '', place: String(c.p ?? ''), mission: String(c.m ?? ''), key: `${c.n} ${c.s ?? ''} ${c.e ?? ''}`.toLowerCase() }))
  byId = new Map(list.map((c) => [c.id, c]))
}
const view = (c) => ({ id: c.id, name: c.name, slug: c.slug, logo: c.logo, place: c.place, mission: c.mission.slice(0, 180), url: c.slug ? `https://donate.gg/${c.slug}` : '' })

/** The charity with exactly this id, or null. */
export function charityById(id) { load(); const c = byId.get(String(id ?? '').toLowerCase()); return c ? view(c) : null }

/** Up to `limit` charities whose name, slug or EIN contains every word of `q`; names that START with q first. */
export function searchCharities(q, limit = 12) {
  load()
  const words = String(q ?? '').toLowerCase().replace(/[^a-z0-9 &'.-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6)
  if (!words.length) return []
  const first = words.join(' ')
  return list.filter((c) => words.every((w) => c.key.includes(w)))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(first)) - Number(a.name.toLowerCase().startsWith(first)) || a.name.length - b.name.length)
    .slice(0, limit).map(view)
}
export function charityCount() { load(); return list.length }
