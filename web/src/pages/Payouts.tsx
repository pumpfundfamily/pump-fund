import { useState } from 'react'
import { ProofList, type ProofRecord } from '../components/Proof'
import { ErrorNote, Loading } from '../components/ui'
import { api } from '../lib/api'
import { useData } from '../lib/useData'

const PAGE = 30

/** /payouts: every payment Pump Fund and Pumpfun made for its tokens, each step with its on-chain transaction. */
export function Payouts() {
  const [shown, setShown] = useState(PAGE)
  const d = useData(() => api.proof(shown), [shown], 30_000)
  const recs: ProofRecord[] = d.data?.records ?? []
  return (
    <div className="page">
      <div className="pf-pay-head">
        <div>
          <div className="pf-pay-title"><h1>Payouts</h1>{d.data && <span className="pf-pay-count">{d.data.total.toLocaleString('en-US')}</span>}</div>
          <p className="muted">Every payment made for a Pump Fund token, with each step's transaction on Solana or Base. Open a payment to check it yourself.</p>
        </div>
        {d.data && <div className="pf-pay-total"><div className="pf-pay-total-v">{d.data.totals.paidUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="muted small">USD delivered</div></div>}
      </div>
      {d.loading && !d.data ? <Loading /> : d.error && !d.data ? <ErrorNote error={d.error} /> : <ProofList records={recs} empty="Payments are listed here as they are made." />}
      {d.data && d.data.total > recs.length && <div className="pf-more"><button type="button" className="btn ghost" onClick={() => setShown((n) => n + PAGE)}>Show more</button></div>}
    </div>
  )
}
