import { useState, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { mcap, short, usd } from '../lib/format'
import { navigate } from '../lib/router'
import type { Token, User } from '../lib/types'
import { IArrow, IChevron, ICopy } from './Icons'

export const SOLSCAN = (kind: 'tx' | 'account' | 'token', id: string) => `https://solscan.io/${kind}/${id}`

/** An in-app link: real href (open in new tab still works), client-side navigation on click. */
export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={to} {...rest} onClick={(e) => {
      rest.onClick?.(e)
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      navigate(to)
    }}>{children}</a>
  )
}

export const Ext = ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className={className}>{children}</a>
)

/** The heart (web/brand/pumpfund-logo-source.png → public/logo.png, transparent). */
export function Mark({ size = 28 }: { size?: number }) {
  return <img src="/logo.png" width={size} height={size} alt="Pump Fund" style={{ display: 'block' }} />
}

export function SafeImg({ src, label = '', size, radius, className }: { src: string; label?: string; size?: number; radius?: number | string; className?: string }) {
  const [failed, setFailed] = useState(false)
  const style = size ? { width: size, height: size, borderRadius: radius } : { borderRadius: radius }
  if (!src || failed) {
    const letter = (label.replace(/^[@$]/, '')[0] ?? '$').toUpperCase()
    return <span className={`img-fallback ${className ?? ''}`} style={{ ...style, fontSize: size ? Math.max(10, size * 0.42) : undefined }} aria-hidden>{letter}</span>
  }
  return <img src={sizedSrc(src, size)} alt="" className={className} width={size} height={size} style={{ ...style, objectFit: 'cover' }} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

/** X serves `_normal` (48 px) avatars; anything shown larger gets the 400 px file. */
export function sizedSrc(src: string, size?: number): string {
  if (!src.includes('pbs.twimg.com')) return src
  return size && size > 48 ? src.replace(/_normal(\.[a-z]+)?(\?|$)/, '_400x400$1$2') : src
}

export function Avatar({ src, size = 40, round = true, label = '' }: { src: string; size?: number; round?: boolean; label?: string }) {
  return <span className="avatar" style={{ width: size, height: size }}><SafeImg src={src} label={label} size={size} radius={round ? '50%' : 12} /></span>
}

export function UserLink({ u }: { u: User }) {
  return <Link to={`/x/${u.handle}`} className="creator-link">@{u.handle}</Link>
}

export function CopyCA({ value, label = 'CA' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button type="button" className="ca-pill" onClick={() => { navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) }) }} title="Copy">
      <span className="ca-label">{copied ? 'Copied' : label}</span>
      <span className="ca-addr mono">{short(value, 6, 6)}</span>
      <ICopy />
    </button>
  )
}

/** Who a token funds, in a few words: the first recipient, and how many more. */
function tileFunds(t: Token): string {
  const s = t.shares[0]
  if (!s) return `@${t.creator.handle}`
  const first = s.kind === 'x' ? `@${s.handle}` : s.kind === 'github' ? `${s.handle} (GitHub)` : s.name
  return t.shares.length > 1 ? `${first} +${t.shares.length - 1}` : first
}

/**
 * A token card, laid out like ponscharity.family's (operator 14 Nov): the image edge to edge with a "Graduated" badge
 * (or the curve's progress along its foot), then ticker, name, market cap, what it has funded, and who it funds.
 */
export function TokenTile({ t }: { t: Token }) {
  const pct = Math.round(Math.max(0, Math.min(1, t.curveProgress ?? 0)) * 100)
  return (
    <Link to={`/t/${t.mint}`} className="tile ct-tile pf-card">
      <div className="pf-card-art">
        <SafeImg src={t.image} label={t.symbol} className="ct-tile-img pf-card-img" radius={0} />
        {t.graduated ? <span className="pf-card-badge">Graduated</span>
          : <span className="pf-card-curve" title={`${pct}% of the bonding curve`}><span style={{ width: `${pct}%` }} /></span>}
      </div>
      <div className="pf-card-body">
        <div className="pf-card-sym mono">${t.symbol}</div>
        <div className="pf-card-name ct-trunc">{t.name}</div>
        <div className="pf-card-mc"><strong>{mcap(t.marketCapUsd)}</strong><span>Market cap</span></div>
        <div className="pf-card-funded">{usd(t.feesUsd ?? 0, true)} funded</div>
        <div className="pf-card-foot">
          <div className="pf-card-k">{t.platform ? 'Token' : 'Funds'}</div>
          <div className="pf-card-v">{t.platform ? 'Pump Fund' : tileFunds(t)}</div>
        </div>
      </div>
    </Link>
  )
}

/**
 * ⛔ THE centred page head (eyebrow, title, one line under it). Every centred page uses this one component: on 14 Nov a
 * hand-made copy on the launch page centred its text but not its boxes, so the label and the line under the title sat
 * off to the left of the title. One implementation, one set of rules (pumpfund.css .pf-pagehead.pf-center).
 */
export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="pf-pagehead pf-center">
      <p className="pf-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {children ? <p className="muted">{children}</p> : null}
    </header>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return <div className="stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>
}

export function Chip({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return <button type="button" className={`chip ${active ? 'on' : ''}`} onClick={onClick}>{children}</button>
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null
  return (
    <span className="pager">
      <button type="button" aria-label="Previous" disabled={page <= 0} onClick={() => onPage(page - 1)}><IChevron dir="left" /></button>
      <span className="mono">{page + 1} / {pages}</span>
      <button type="button" aria-label="Next" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}><IChevron /></button>
    </span>
  )
}

export function SectionHead({ title, children, viewAll }: { title: ReactNode; children?: ReactNode; viewAll?: string }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <div className="section-tools">{children}{viewAll && <Link to={viewAll} className="view-all">View all <IArrow /></Link>}</div>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-title">{title}</div>{children && <div className="muted">{children}</div>}</div>
}
export function Loading() { return <div className="loading"><span /><span /><span /></div> }
export function ErrorNote({ error }: { error: string }) { return <div className="note error">Could not load this: {error}</div> }
