/**
 * ⭐ PAYMENT APPS as recipients (13 Nov, operator: "new recipient kinds"; Venmo, Cash App, Zelle, Chime).
 *
 * A launcher can name a Venmo / Cash App / Zelle / Chime account as a recipient, splittable like an X account. It is paid
 * the same way as X Money (api/xmoney.mjs): its SOL → Relay → Base USDC → a Peer Cash order whose buyer pays that
 * account in that app, proven to Peer before our USDC is released. Only Peer corridors that need NO verification by the
 * payee are here (capabilities().platforms[].requiresIdentityAttestation false, read 13 Nov); PayPal, Wise and Alipay
 * need the payee to connect their account in Peer's app first and are not offered.
 *
 * ⛔ Ledger key: an app recipient's token_shares.recipient_id is `<app>:<payee>` (lowercase), and that same string is the
 *    `x_id` of its credits, outflows and payout rows. X ids are digits only, so the two can never collide.
 * ⛔ Nobody signs in as an app account: what it is owed is paid automatically, never withdrawn by hand.
 * ⛔ A launcher CAN name their own app account (there is no identity to check it against). Operator chose this knowingly.
 * ⛔ A Zelle payee is an email or a phone number: it is never shown in full on a public page or in token metadata.
 */

export const APP_RAILS = {
  venmo: {
    label: 'Venmo', currency: 'USD', hint: 'Venmo username, like @jane-doe',
    // Venmo usernames: 5 to 30 letters, digits, - and _ ; paid as typed (without @), keyed lowercase
    clean: (v) => { const s = v.replace(/^@+/, ''); return /^[A-Za-z0-9_-]{5,30}$/.test(s) ? s : null },
    shown: (h) => `@${h}`,
  },
  cashapp: {
    label: 'Cash App', currency: 'USD', hint: 'Cashtag, like $jane',
    // a cashtag: up to 20 letters and digits with at least one letter (Peer's SAR_CONNECT_CASHTAG_PATTERN is the same idea)
    clean: (v) => { const s = v.replace(/^\$+/, ''); return /^[A-Za-z0-9]{1,20}$/.test(s) && /[A-Za-z]/.test(s) ? s : null },
    shown: (h) => `$${h}`,
  },
  chime: {
    label: 'Chime', currency: 'USD', hint: 'ChimeSign, like $jane',
    // Peer keeps the leading $ on a ChimeSign (normalizeCashPayee lowercases it, nothing else)
    clean: (v) => { const s = v.replace(/^\$+/, '').toLowerCase(); return /^[a-z0-9_-]{1,30}$/.test(s) ? `$${s}` : null },
    shown: (h) => h,
  },
  zelle: {
    label: 'Zelle', currency: 'USD', hint: 'Zelle email or US phone number',
    clean: (v) => {
      const s = v.trim().toLowerCase()
      if (/^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/.test(s) && s.length <= 254) return s
      const d = s.replace(/[\s().-]/g, '').replace(/^\+?1(?=\d{10}$)/, '')
      return /^[2-9]\d{9}$/.test(d) ? d : null
    },
    shown: (h) => maskZelle(h),
  },
  // ⭐ PayPal (13 Nov): Peer pays it only after its OWNER connected it with Peer (api/paypal.mjs). Until then the share
  // waits in its balance. Payee = the PayPal.Me username, lowercase (Peer's normalizePaypalHandle / its username rule).
  paypal: {
    label: 'PayPal', currency: 'USD', hint: 'PayPal.Me username, like paypal.me/janedoe', needsConnect: true,
    clean: (v) => {
      const s = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^paypal\.me\//i, '').split(/[/?#]/)[0].replace(/^@+/, '').trim().toLowerCase()
      return /^[a-z0-9._-]{1,40}$/.test(s) && /[a-z0-9]/.test(s) ? s : null
    },
    shown: (h) => `paypal.me/${h}`,
  },
}
export const APP_KINDS = Object.keys(APP_RAILS)
/** Kinds our own ledger pays (X Money or a payment app). GitHub and charities are paid by Pumpfun's fee sharing. */
export const OUR_KINDS = ['x', ...APP_KINDS]
export const isApp = (kind) => APP_KINDS.includes(kind)
export const isOurs = (kind) => OUR_KINDS.includes(kind ?? 'x')

/** A payee as typed → its canonical form for that app, or null when it is not one. */
export function cleanPayee(kind, raw) {
  const r = APP_RAILS[kind]
  if (!r) return null
  const v = String(raw ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').trim()
  return v ? r.clean(v) : null
}

/** The ledger key of an app account: `venmo:jane-doe`. */
export const appKey = (kind, payee) => `${kind}:${String(payee).toLowerCase()}`
export const APP_KEY_RE = new RegExp(`^(${APP_KINDS.join('|')}):(.{1,254})$`)
/** `venmo:jane-doe` → { kind, payee } (payee lowercase), or null for an X id. */
export function parseAppKey(key) {
  const m = APP_KEY_RE.exec(String(key ?? ''))
  return m ? { kind: m[1], payee: m[2] } : null
}

function maskZelle(h) {
  const s = String(h ?? '')
  if (/^\d{10}$/.test(s)) return `(•••) •••-${s.slice(-4)}`
  const [user, domain] = s.split('@')
  if (!domain) return '•••'
  return `${user.slice(0, 1)}•••@${domain}`
}

/** How a payee is shown publicly: "Venmo @jane-doe", "Zelle j•••@gmail.com". */
export const appShown = (kind, handle) => `${APP_RAILS[kind]?.label ?? kind} ${APP_RAILS[kind]?.shown(handle) ?? handle}`
