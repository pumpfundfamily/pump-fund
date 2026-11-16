import { useMemo, useState } from 'react'
import { ProofList, type ProofRecord } from '../components/Proof'
import { Chip, ErrorNote, Loading, PageHead } from '../components/ui'
import { api } from '../lib/api'
import { useData } from '../lib/useData'

const PAGE = 30
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Which filter a record belongs to. */
const groupOf = (r: ProofRecord) => (r.kind === 'seal' ? 'seal' : r.kind === 'wallet' ? 'wallet' : r.kind === 'pumpfun' ? 'pumpfun' : r.platform === 'xmoney' ? 'xmoney' : 'apps')
const GROUPS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'xmoney', label: 'X Money' }, { key: 'apps', label: 'Payment apps' },
  { key: 'wallet', label: 'Solana wallet' }, { key: 'pumpfun', label: 'Pumpfun' }, { key: 'seal', label: 'SEAL' },
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
      <PageHead eyebrow="Payouts" title="Payouts">Every payment made for a Pump Fund token</PageHead>

      {/* operator 14 Nov: "Paid out" = delivered + listed on Peer waiting for a payer */}
      <div className="pf-stats pf-stats-pay">
        <div className="pf-stat"><div className="pf-stat-k">Paid out</div><div className="pf-stat-v">${t ? money(t.paidUsd + t.listedUsd) : '0.00'}</div></div>
        <div className="pf-stat"><div className="pf-stat-k">Payouts</div><div className="pf-stat-v">{(d.data?.total ?? 0).toLocaleString('en-US')}</div></div>
        <div className="pf-stat"><div className="pf-stat-k">People paid</div><div className="pf-stat-v">{(t?.people ?? 0).toLocaleString('en-US')}</div></div>
      </div>

      {recs.length > 0 && (
        <div className="pf-pay-bar">
          <div className="chips">
            {/* no "All" chip (operator 14 Nov): an active filter clicked again shows everything */}
            {GROUPS.filter((g) => g.key !== 'all' && counts[g.key]).map((g) => (
              <Chip key={g.key} active={group === g.key} onClick={() => setGroup((cur) => (cur === g.key ? 'all' : g.key))}>{g.label}<span className="pf-chip-n">{counts[g.key]}</span></Chip>
            ))}
          </div>
        </div>
      )}

      {d.loading && !d.data ? <Loading /> : d.error && !d.data ? <ErrorNote error={d.error} /> : list.length ? (
        <ProofList records={list} empty="" />
      ) : (
        <div className="pf-pay-empty">
          <img src="/logo.png" alt="" width={56} height={56} />
          <div className="pf-pay-empty-t">Payments are listed here as they are made.</div>
        </div>
      )}
      {d.data && d.data.total > recs.length && <div className="pf-more"><button type="button" className="btn ghost" onClick={() => setShown((n) => n + PAGE)}>Show more</button></div>}
    </div>
  )
}
