import { IExternal, IX } from '../components/Icons'
import { Avatar, Empty, ErrorNote, Ext, Loading, SectionHead, Stat, TokenTile } from '../components/ui'
import { api } from '../lib/api'
import { sol } from '../lib/site'
import { useData } from '../lib/useData'

export function Creator({ handle }: { handle: string }) {
  const d = useData(() => api.creator(handle), [handle], 60_000)
  if (d.loading && !d.data) return <div className="page"><Loading /></div>
  if (!d.data) return <div className="page">{d.status === 404 ? <Empty title={`No tokens fund @${handle} yet`}>Anyone can launch one for them on the Launch page.</Empty> : <ErrorNote error={d.error ?? 'unknown'} />}</div>
  const { creator, tokens } = d.data
  return (
    <div className="page">
      <section className="profile-head row-gap ct-profile-center">
        <Avatar src={creator.avatar} size={72} label={creator.handle} />
        <div>
          <h1>{creator.name}</h1>
          <Ext href={`https://x.com/${creator.handle}`} className="muted u"><IX size={12} /> @{creator.handle} <IExternal /></Ext>
        </div>
      </section>
      <section className="stat-grid ct-stats pf-stats-3">
        <Stat label="Tokens funding them" value={tokens.length} />
        <Stat label="Their share of the rewards" value={sol(d.data.earnedSol)} />
        <Stat label="Paid out" value={sol(d.data.paidSol)} />
      </section>
      <div className="ct-center-head"><SectionHead title="Tokens" /></div>
      <div className="ct-grid wide">{tokens.map((t) => <TokenTile key={t.mint} t={t} />)}</div>
    </div>
  )
}
