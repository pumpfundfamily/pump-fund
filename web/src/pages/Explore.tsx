import { useEffect, useState } from 'react'
import { Chip, ErrorNote, Loading, TokenTile, PageHead } from '../components/ui'
import { api } from '../lib/api'
import { useData } from '../lib/useData'

const PER = 24

/**
 * Explore (operator 13 Nov, like ponscharity.family/explore): two sections, Graduated and On the curve, each with its own
 * Newest / Most paid order. "Most paid" = most creator rewards earned for the recipients.
 */
export function Explore() {
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get('q') ?? '')
  useEffect(() => {
    const on = () => setQ(new URLSearchParams(location.search).get('q') ?? '')
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return (
    <div className="page">
      <PageHead eyebrow="Explore" title="Every token launched here">Every token sends its creator rewards to the people and causes it was launched for.{q && <> Showing results for <span className="hl">{q}</span>.</>}</PageHead>
      <Stage stage="graduated" title="Graduated" sub="Tokens that graduated." q={q} initial="fees" />
      <Stage stage="curve" title="On the curve" sub="Tokens still climbing toward graduation." q={q} initial="new" />
    </div>
  )
}

function Stage({ stage, title, sub, q, initial }: { stage: 'graduated' | 'curve'; title: string; sub: string; q: string; initial: 'new' | 'fees' }) {
  const [sort, setSort] = useState<'new' | 'fees'>(initial)
  const [shown, setShown] = useState(PER)
  useEffect(() => setShown(PER), [q, sort])
  const d = useData(() => api.tokens(sort, q, shown, 0, stage), [sort, q, shown, stage], 30_000)
  const list = d.data?.tokens ?? []
  return (
    <section className="pf-stage">
      <div className="pf-stage-head">
        <div><h2>{title}</h2><p className="muted small">{sub}</p></div>
        <div className="chips">
          <Chip active={sort === 'new'} onClick={() => setSort('new')}>Newest</Chip>
          <Chip active={sort === 'fees'} onClick={() => setSort('fees')}>Most paid</Chip>
        </div>
      </div>
      {d.error && !d.data ? <ErrorNote error={d.error} /> : d.loading && !d.data ? <Loading /> : list.length ? (
        <>
          <div className="ct-grid wide">{list.map((t) => <TokenTile key={t.mint} t={t} />)}</div>
          {(d.data?.total ?? 0) > list.length && <div className="pf-more"><button type="button" className="btn ghost" onClick={() => setShown((n) => n + PER)}>Show more</button></div>}
        </>
      ) : <div className="pf-empty">{q ? 'Nothing matches here.' : stage === 'graduated' ? 'No token has graduated yet.' : 'No tokens on the curve yet.'}</div>}
    </section>
  )
}
