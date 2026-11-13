import type { FeedItem, Me, Outflow, Stats, Token, User } from './types'
import type { ProofRecord } from '../components/Proof'

/** A PayPal account a token pays (api/server.mjs /api/paypal/:handle). connected: null = Peer could not be asked. */
export type PaypalAccount = { handle: string; connected: boolean | null; owedSol: number; tokens: { mint: string; symbol: string; name: string; image: string; pct: number }[] }

export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg) } }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(body.error ?? `Request failed (${r.status})`, r.status)
  return body as T
}
const post = <T,>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  stats: () => call<Stats>('/api/stats'),
  proof: (limit = 30, offset = 0) => call<{ records: ProofRecord[]; total: number; baseWallet: string | null; totals: XMoneyTotals }>(`/api/proof?limit=${limit}&offset=${offset}`),
  paypal: (handle: string) => call<PaypalAccount>(`/api/paypal/${encodeURIComponent(handle)}`),
  paypalConnect: (handle: string, email: string) => post<{ connected: true } | { id: string; url: string; appUrl: string; expiresAt: number }>('/api/paypal/connect', { handle, email }),
  paypalStatus: (id: string) => call<{ status: 'pending' | 'connecting' | 'connected' | 'cancelled' | 'expired' }>(`/api/paypal/connect/${id}`),
  tokens: (sort = 'new', q = '', limit = 48, offset = 0, stage: '' | 'graduated' | 'curve' = '') => call<{ tokens: Token[]; total: number }>(`/api/tokens?sort=${sort}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}${stage ? `&stage=${stage}` : ''}`),
  token: (mint: string) => call<{ token: Token; activity: Outflow[]; xmoney: XMoneyCoinPayout[]; xmoneyWallet: string | null; proof: ProofRecord[]; proofTotal: number }>(`/api/token/${mint}`),
  creator: (handle: string) => call<{ creator: User; tokens: Token[]; earnedSol: number; paidSol: number }>(`/api/creator/${encodeURIComponent(handle)}`),
  feed: () => call<{ feed: FeedItem[] }>('/api/feed'),
  payouts: (limit = 20) => call<{ payouts: PublicPayout[]; wallet: string | null; totals: XMoneyTotals }>(`/api/payouts?limit=${limit}`),
  me: () => call<Me>('/api/me'),
  settings: (s: Record<string, unknown>) => post<{ ok: true; payoutConfirmed: boolean; payoutWallet: string }>('/api/settings', s),
  withdraw: (destination: string, asset = 'SOL') => post<{ ok: true; asset: string; paid: number; paidSol: number; pending: boolean; signatures: string[] }>('/api/withdraw', { destination, asset }),
  logout: () => post<{ ok: true }>('/api/auth/logout', {}),
  // launching on the site
  launchOptions: () => call<LaunchOptions>('/api/launch/options'),
  launchCheck: (symbol: string, forHandle = '') => call<LaunchCheck>(`/api/launch/check?symbol=${encodeURIComponent(symbol)}&for=${encodeURIComponent(forHandle)}`),
  launchCheckGithub: (login: string) => call<LaunchCheck>(`/api/launch/check?github=${encodeURIComponent(login)}`),
  charities: (q: string) => call<{ charities: Charity[] }>(`/api/charities?q=${encodeURIComponent(q)}`),
  launch: (body: LaunchBody) => post<LaunchResult>('/api/launch', body),
  launchSign: (id: string, transaction: string) => post<LaunchResult>('/api/launch/sign', { id, transaction }),
  launchStatus: (id: string) => call<LaunchStatus>(`/api/launch/${id}`),
}
export const signInUrl = (ret = location.pathname) => `/api/auth/x/start?return=${encodeURIComponent(ret)}`

/** One X Money payout, as the public list shows it. */
export type PublicPayout = { id: number; time: number; handle: string; platform?: string; sol: number; usd: number; paidUsd: number; status: string; done: boolean; bridgeTx: string | null; peerOrder: string | null }
export type XMoneyTotals = { enabled: boolean; paidUsd: number; listedUsd: number; people: number; payouts: number }
/** One X Money payout that took this coin's creator rewards (status + every step's transaction). */
export type XMoneyCoinPayout = { id: number; time: number; handle: string; platform?: string; sol: number; totalSol: number; usd: number; paidUsd: number; status: string; done: boolean;
  collectTxs: string[]; bridgeTx: string | null; peerOrder: string | null; creditTx: string | null }

/** What the launch form needs to draw itself (api/sitelaunch.mjs options). */
export type LaunchOptions = {
  open: boolean; maxRecipients?: number; minSharePct?: number; nameMax: number; symbolMax: number; descMax: number; imageMax: number
  devBuy: { enabled: boolean; minSol: number; maxSol: number; feeBps: number; extraSol: number }
  curve: { virtualSol: number; virtualTokens: number; supply: number }
  limits: { cooldownMinutes: number; minFollowers: number; minAccountAgeDays: number; tickerHoldHours: number }
}
export type ForCheck = { ok: true; id: string; handle: string; name: string; avatar: string; self?: boolean } | { ok: false; reason: string }
export type LaunchCheck = { ticker: { symbol: string; free: boolean; reason: string | null } | null; for: ForCheck | null; github?: ForCheck | null }
/** One entry of Donate.gg's directory (api/charities.mjs). */
export type Charity = { id: string; name: string; slug: string; logo: string; place: string; mission: string; url: string }
export type LaunchBody = {
  symbol: string; name: string; description: string; website: string; twitter: string; telegram: string
  recipients: { kind?: 'x' | 'github' | 'charity' | 'venmo' | 'cashapp' | 'zelle' | 'chime' | 'paypal'; handle: string; pct: number }[]; image: string | null; devBuy: { wallet: string; sol: string } | null
}
export type LaunchResult = { id: string; state: 'queued' | 'signing' | 'launching'; mint?: string; transaction?: string; signature?: string; expiresAt?: number }
export type LaunchStatus = { id: string; state: 'queued' | 'launching' | 'launched' | 'rejected' | 'failed' | 'signing' | 'expired'; symbol?: string; mint: string | null; signature: string | null; reason: string | null }
