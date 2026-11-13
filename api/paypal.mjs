/**
 * ⭐ PayPal recipients (13 Nov, operator: "add paypal too").
 *
 * Peer pays a PayPal account only once its OWNER has connected it with Peer (Curator's "SAR connect": the Peer App
 * Clip on iPhone, the Peer app on Android). Until then a cash-out to that handle is refused by Peer's server
 * (PAYEE_VERIFICATION_REQUIRED). After it, anyone's cash-out to that handle reuses the connection.
 *
 * So a PayPal share waits in its balance until the owner connects; the keeper asks Peer (read-only) before it bridges
 * anything (`connected`), and the site offers the connect step on /paypal/<username>.
 *
 * ⛔ Peer only accepts return addresses on its own list: pumpfund.family is refused (probed 13 Nov), Peer's own app
 *    origin is accepted. The owner lands on Peer after connecting and comes back to our page, which polls.
 * ⛔ The PayPal email the owner types goes to Peer in that one request and is never stored or logged here.
 * ⛔ A link's requestId is a 15-minute bearer capability: kept server-side only, the page polls by our own id.
 */
import { randomBytes } from 'node:crypto'

export const PAYPAL_RETURN_URL = 'https://app.peer.xyz/'
const LINK_SECONDS = 15 * 60

/** The real Peer connect client (loaded on first use). Tests pass their own with the same three methods. */
export async function realSarClient() {
  const { createSarConnectClient } = await import('@zkp2p/cash')
  const c = createSarConnectClient({ environment: 'production' })
  return { prepare: (input) => c.prepare(input), status: (link) => c.status(link), isConnected: (account) => c.isConnected(account) }
}

export class ConnectError extends Error { constructor(message, status = 400) { super(message); this.status = status } }

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i

/**
 * `client` = () => Promise<{ prepare, status, isConnected }>. `isRecipient(handle)` = is this PayPal handle a recipient of
 * one of our tokens (we only start connections for accounts we pay).
 */
export function createPaypalConnector({ client = realSarClient, isRecipient, now = () => Date.now(), cacheMs = 10 * 60_000 } = {}) {
  let c = null
  const sar = async () => (c ??= await client())
  const links = new Map() // our id → { link, handle, at }
  const known = new Map() // handle → { connected, at }
  const starts = new Map() // ip → [times]

  /** Is the PayPal handle connected with Peer? Cached; `fresh` skips the cache. Throws when Peer cannot answer. */
  async function connected(handle, { fresh = false } = {}) {
    const k = known.get(handle)
    if (!fresh && k && now() - k.at < (k.connected ? cacheMs * 6 : cacheMs)) return k.connected
    const v = await (await sar()).isConnected({ platform: 'paypal', payeeHandle: handle })
    known.set(handle, { connected: !!v, at: now() })
    return !!v
  }
  /** What the pages show: true / false / null (not asked yet). Never waits on Peer. */
  function connectedCached(handle) {
    const k = known.get(handle)
    if (!k || now() - k.at > cacheMs) connected(handle).catch(() => {})
    return k ? k.connected : null
  }

  async function start({ handle, email, ip = '' }) {
    if (!handle || !isRecipient(handle)) throw new ConnectError('No Pump Fund token pays this PayPal account.', 404)
    const mail = String(email ?? '').trim()
    if (!EMAIL_RE.test(mail) || mail.length > 254) throw new ConnectError('Enter the email address of your PayPal account.')
    const t = now(), recent = (starts.get(ip) ?? []).filter((x) => t - x < 3_600_000)
    if (recent.length >= 10) throw new ConnectError('Too many tries. Wait a while and try again.', 429)
    starts.set(ip, [...recent, t])
    if (await connected(handle, { fresh: true }).catch(() => false)) return { connected: true }
    let link
    try {
      link = await (await sar()).prepare({ platform: 'paypal', payeeHandle: handle, paypalEmail: mail, returnUrl: PAYPAL_RETURN_URL, currencies: ['USD'] })
    } catch (e) {
      throw new ConnectError(e?.code === 'invalid_account' ? 'Peer did not accept that PayPal username and email.' : 'Peer could not be reached just now. Try again in a minute.', e?.code === 'invalid_account' ? 400 : 503)
    }
    for (const [k, v] of links) if (t - v.at > LINK_SECONDS * 1000) links.delete(k)
    const id = randomBytes(12).toString('base64url')
    links.set(id, { link, handle, at: t })
    return { id, url: link.url, appUrl: link.appUrl, expiresAt: link.expiresAt }
  }

  /** A started connection: 'pending' | 'connecting' | 'connected' | 'cancelled' | 'expired'. */
  async function status(id) {
    const e = links.get(id)
    if (!e) return { status: 'expired' }
    let r
    try { r = await (await sar()).status(e.link) } catch { return { status: 'pending' } }
    if (r.status === 'connected') { known.set(e.handle, { connected: true, at: now() }); links.delete(id) }
    if (r.status === 'expired' || r.status === 'cancelled') links.delete(id)
    return { status: r.status }
  }

  return { connected, connectedCached, start, status }
}
