import { useState } from 'react'
import { Ext, Link } from './ui'
import { ago, dateTime } from '../lib/format'

/** One step of a payment and the public transaction that proves it (api/proof.mjs). */
export type ProofStep = { step: string; label: string; amount: string | null; chain: 'solana' | 'base'; tx: string | null; url: string | null; note?: string; account?: string }
export type ProofRecord = { id: string; kind: 'peer' | 'wallet' | 'pumpfun'; platform: string; time: number; who: string; whoLink: string | null; rail: string; status: string; done: boolean
  sol: number; usd: number | null; paidUsd: number | null; steps: ProofStep[]; baseWallet?: string | null }

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const shortTx = (t: string) => (t.length > 18 ? `${t.slice(0, 8)}…${t.slice(-6)}` : t)

/**
 * Payments as a list (laid out like ponscharity.family's donations). Each row opens to show every step with its
 * transaction on Solscan or Basescan, so anyone can check where the money went.
 */
export function ProofList({ records, empty }: { records: ProofRecord[]; empty: string }) {
  if (!records.length) return <div className="pf-empty">{empty}</div>
  return <div className="pf-pay-list">{records.map((r) => <ProofRow key={r.id} r={r} />)}</div>
}

function ProofRow({ r }: { r: ProofRecord }) {
  const [open, setOpen] = useState(false)
  const amount = r.paidUsd && r.paidUsd > 0 ? { v: money(r.paidUsd), u: 'USD' } : r.usd && r.usd > 0 && r.kind === 'peer' ? { v: money(r.usd), u: 'USD' } : { v: r.sol.toLocaleString('en-US', { maximumFractionDigits: 4 }), u: 'SOL' }
  const mark = r.who.replace(/^[@$]/, '').replace(/^(Venmo|Cash App|Zelle|Chime|PayPal)\s+[@$]?/, '').slice(0, 1).toUpperCase() || '·'
  return (
    <div className="pf-pay-item">
      <div className="pf-pay-row">
        <span className="pf-pay-mark" aria-hidden="true">{mark}</span>
        <div className="grow">
          <div className="muted pf-pay-meta">{r.whoLink ? <Link to={r.whoLink} className="u">{r.who}</Link> : r.who} <span title={dateTime(r.time)}>· {ago(r.time)}</span> · {r.rail}{!r.done || r.kind !== 'peer' || r.status !== 'Paid' ? <> · {r.status}</> : null}</div>
          <div className="pf-pay-amt">{amount.v}<span className="pf-pay-unit">{amount.u}</span></div>
        </div>
        <button type="button" className="btn ghost pf-pay-tx" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide proof' : `Proof (${r.steps.length})`}</button>
      </div>
      {open && (
        <ol className="pf-proof">
          {r.steps.map((s, i) => (
            <li key={i} className="pf-proof-step">
              <span className={`pf-chain ${s.chain}`}>{s.chain === 'solana' ? 'Solana' : 'Base'}</span>
              <div className="grow">
                <div className="pf-proof-label">{s.label}{s.amount ? <span className="muted"> · {s.amount}</span> : null}</div>
                {s.tx && <div className="mono tiny muted pf-proof-tx" title={s.note ?? s.tx}>{shortTx(s.tx)}</div>}
              </div>
              {s.url && <Ext href={s.url} className="u small">{s.chain === 'solana' ? 'Solscan' : 'Basescan'}</Ext>}
            </li>
          ))}
          {r.kind === 'peer' && r.baseWallet && <li className="pf-proof-step muted small">Our Base wallet for Peer: <Ext href={`https://basescan.org/address/${r.baseWallet}`} className="u mono">{shortTx(r.baseWallet)}</Ext></li>}
        </ol>
      )}
    </div>
  )
}
