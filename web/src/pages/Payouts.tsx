import { useMemo, useState } from 'react'
import { ProofList, type ProofRecord } from '../components/Proof'
import { Chip, ErrorNote, Loading, PageHead } from '../components/ui'
import { api } from '../lib/api'
import { useData } from '../lib/useData'

const PAGE = 30
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Which filter a record belongs to. */
const groupOf = (r: ProofRecord) => (r.kind === 'wallet' ? 'wallet' : r.kind === 'pumpfun' ? 'pumpfun' : r.platform === 'xmoney' ? 'xmoney' : 'apps')
const GROUPS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'xmoney', label: 'X Money' }, { key: 'apps', label: 'Payment apps' },
  { key: 'wallet', label: 'Solana wallet' }, { key: 'pumpfun', label: 'Pumpfun' },
]

/**
 * /payouts: every payment made for a Pump Fund token, each step with its on-chain transaction.
 * Layout reworked 14 Nov (operator: "make the payouts page look nicer"): centred head, a figures strip, filters by how
 * the money was paid, and the shared proof rows. The wording is unchanged.
 */
export function Payouts() {
  const [shown, setShown] = useState(PAGE)
  const [group, setGroup] = useState('all')
  const d = useData(() => api.proof(shown), [shown], 30_000)
  const recs: ProofRecord[] = d.data?.records ?? []
  const counts = useMemo(() => { const c: Record<string, number> = { all: recs.length }; for (const r of recs) c[groupOf(r)] = (c[groupOf(r)] ?? 0) + 1; return c }, [recs])
  const list = group === 'all' ? recs : recs.filter((r) => groupOf(r) === group)
  const t = d.data?.totals
  return (
    <div className="page pf-payouts-page">
      <PageHead eyebrow="Payouts" title="Payouts">Every payment made for a Pump Fund token, with each step's transaction on Solana or Base. Open a payment to check it yourself.</PageHead>

      <div className="pf-stats pf-stats-4">
        <div className="pf-stat"><div className="pf-stat-k">USD delivered</div><div className="pf-stat-v">${t ? money(t.paidUsd) : '0.00'}</div></div>
        <div className="pf-stat"><div className="pf-stat-k">Payouts</div><div className="pf-stat-v">{(d.data?.total ?? 0).toLocaleString('en-US')}</div></div>
        <div className="pf-stat"><div className="pf-stat-k">People paid</div><div className="pf-stat-v">{(t?.people ?? 0).toLocaleString('en-US')}</div></div>
        <div className="pf-stat"><div className="pf-stat-k">Waiting for a payer</div><div className="pf-stat-v">${t ? money(t.listedUsd) : '0.00'}</div></div>
      </div>

      <div className="pf-pay-bar">
        <div className="chips">
          {GROUPS.filter((g) => g.key === 'all' || counts[g.key]).map((g) => (
            <Chip key={g.key} active={group === g.key} onClick={() => setGroup(g.key)}>{g.label}{counts[g.key] ? <span className="pf-chip-n">{counts[g.key]}</span> : null}</Chip>
          ))}
        </div>
        <div className="pf-chain-key muted small"><span className="pf-chain solana">Solana</span><span className="pf-chain base">Base</span>every step links to its transaction</div>
      </div>

      {d.loading && !d.data ? <Loading /> : d.error && !d.data ? <ErrorNote error={d.error} /> : list.length ? (
        <ProofList records={list} empty="" />
      ) : (
        <div className="pf-pay-empty">
          <img src="/logo.png" alt="" width={56} height={56} />
          <div className="pf-pay-empty-t">Payments are listed here as they are made.</div>
          <div className="pf-pay-empty-steps">
            <span><span className="pf-chain solana">Solana</span> Collected from the token</span>
            <span aria-hidden="true">→</span>
            <span><span className="pf-chain base">Base</span> Arrived on Base as USDC</span>
            <span aria-hidden="true">→</span>
            <span><span className="pf-chain base">Base</span> Buyer paid, verified by Peer</span>
          </div>
        </div>
      )}
      {d.data && d.data.total > recs.length && <div className="pf-more"><button type="button" className="btn ghost" onClick={() => setShown((n) => n + PAGE)}>Show more</button></div>}
    </div>
  )
}
