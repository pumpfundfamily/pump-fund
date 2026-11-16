import { useState } from 'react'
import { Ext, Link, SafeImg } from './ui'
import { IChevron, IExternal } from './Icons'
import { ago, dateTime } from '../lib/format'

/** One step of a payment and the public transaction that proves it (api/proof.mjs). */
export type ProofStep = { step: string; label: string; amount: string | null; chain: 'solana' | 'base'; tx: string | null; url: string | null; note?: string; account?: string }
export type ProofRecord = { id: string; kind: 'peer' | 'wallet' | 'pumpfun'; platform: string; time: number; who: string; whoLink: string | null; rail: string; status: string; done: boolean
  sol: number; usd: number | null; paidUsd: number | null; steps: ProofStep[]; baseWallet?: string | null
  /** the token the payout came from: its image is the row's icon (operator 16 Nov) */
  image?: string | null; symbol?: string | null; mint?: string | null }

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const shortTx = (t: string) => (t.length > 18 ? `${t.slice(0, 8)}…${t.slice(-6)}` : t)
/** The status pill's tone: settled, still moving, or came back. */
const tone = (r: ProofRecord) => (/back in the balance|Returning|Delayed|Ended/i.test(r.status) ? 'back' : r.done ? 'ok' : 'wait')

/**
 * Payments as a list (laid out like ponscharity.family's donations). Each row opens to a timeline of every step with
 * its transaction on Solscan or Basescan, so anyone can check where the money went.
 */
export function ProofList({ records, empty }: { records: ProofRecord[]; empty: string }) {
  if (!records.length) return <div className="pf-empty">{empty}</div>
  return <div className="pf-pay-list">{records.map((r) => <ProofRow key={r.id} r={r} />)}</div>
}

function ProofRow({ r }: { r: ProofRecord }) {
  const [open, setOpen] = useState(false)
  const amount = r.paidUsd && r.paidUsd > 0 ? { v: money(r.paidUsd), u: 'USD' } : r.usd && r.usd > 0 && r.kind === 'peer' ? { v: money(r.usd), u: 'USD' } : { v: r.sol.toLocaleString('en-US', { maximumFractionDigits: 4 }), u: 'SOL' }
  const mark = r.who.replace(/^[@$]/, '').replace(/^(Venmo|Cash App|Zelle|Chime|PayPal)\s+[@$]?/, '').replace(/^paypal\.me\//, '').slice(0, 1).toUpperCase() || '·'
  return (
    <div className={`pf-pay-item ${open ? 'open' : ''}`}>
      <div className="pf-pay-row pf-pay-toggle" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}>
        {r.image ? <SafeImg src={r.image} label={r.symbol ?? mark} className="pf-pay-mark pf-pay-img" /> : <span className={`pf-pay-mark k-${r.kind}`} aria-hidden="true">{mark}</span>}
        <span className="grow pf-pay-main">
          <span className="pf-pay-who">{r.whoLink ? <span onClick={(e) => e.stopPropagation()}><Link to={r.whoLink} className="u">{r.who}</Link></span> : r.who}</span>
          <span className="pf-pay-tags">
            <span className="pf-tag">{r.rail}</span>
            <span className={`pf-status ${tone(r)}`}>{r.status}</span>
            <span className="muted small" title={dateTime(r.time)}>{ago(r.time) === 'now' ? 'just now' : `${ago(r.time)} ago`}</span>
          </span>
        </span>
        <span className="pf-pay-amt">{amount.v}<span className="pf-pay-unit">{amount.u}</span></span>
        <span className="pf-pay-open muted small">Proof ({r.steps.length}) <IChevron dir={open ? 'down' : 'right'} /></span>
      </div>
      {open && (
        <ol className="pf-proof">
          {r.steps.map((s, i) => (
            <li key={i} className={`pf-proof-step c-${s.chain}`}>
              <span className="pf-proof-dot" aria-hidden="true" />
              <div className="grow">
                <div className="pf-proof-label"><span className={`pf-chain ${s.chain}`}>{s.chain === 'solana' ? 'Solana' : 'Base'}</span> {s.label}</div>
                <div className="pf-proof-meta">
                  {s.amount && <span className="pf-proof-amt">{s.amount}</span>}
                  {s.tx && <span className="mono tiny muted" title={s.note ?? s.tx}>{shortTx(s.tx)}</span>}
                </div>
              </div>
              {s.url && <Ext href={s.url} className="btn ghost xs pf-proof-link">{s.chain === 'solana' ? 'Solscan' : 'Basescan'} <IExternal /></Ext>}
            </li>
          ))}
          {r.kind === 'peer' && r.baseWallet && <li className="pf-proof-foot muted small">Our Base wallet for Peer: <Ext href={`https://basescan.org/address/${r.baseWallet}`} className="u mono">{shortTx(r.baseWallet)}</Ext></li>}
        </ol>
      )}
    </div>
  )
}
