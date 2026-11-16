import { IX } from '../components/Icons'
import { Avatar, CopyCA, Empty, ErrorNote, Ext, Link, Loading, SOLSCAN, SafeImg, SectionHead, Stat } from '../components/ui'
import { api, signInUrl } from '../lib/api'
import { ago, dateTime, mcap } from '../lib/format'
import { sol } from '../lib/site'
import type { Token } from '../lib/types'
import { useData } from '../lib/useData'
import { ProofList } from '../components/Proof'

type Share = Token['shares'][number]
/** How a recipient is named in a sentence: @handle, "octocat on GitHub", or the charity's name. */
const APP_KINDS: Share['kind'][] = ['venmo', 'cashapp', 'zelle', 'chime', 'paypal']
/** A Venmo / Cash App / Zelle / Chime account: paid by our ledger in that app through Peer. `handle` arrives display-ready ("Venmo @jane"). */
const isApp = (s: Share) => APP_KINDS.includes(s.kind)
const label = (s: Share) => (s.kind === 'x' ? `@${s.handle}` : s.kind === 'github' ? `${s.handle} on GitHub` : isApp(s) ? s.handle : s.name)
const listed = (parts: string[]) => parts.join(', ').replace(/, ([^,]*)$/, ' and $1')
/** A recipient's name as a link: our own page for an X account, GitHub or Donate.gg for the others. */
function ShareLink({ s, className = 'u' }: { s: Share; className?: string }) {
  if (s.kind === 'x') return <Link to={`/x/${s.handle}`} className={className}>@{s.handle}</Link>
  if (s.connectPath) return <Link to={s.connectPath} className={className}>{s.handle}</Link>
  if (isApp(s)) return <span>{s.handle}</span>
  return s.url ? <Ext href={s.url} className={className}>{s.kind === 'github' ? s.handle : s.name}</Ext> : <span>{s.name}</span>
}
const KIND_NOTE: Record<Share['kind'], string> = { x: 'X Money', github: 'GitHub, claimed on Pumpfun', charity: 'Charity, through Donate.gg',
  venmo: 'Paid in dollars through Peer', cashapp: 'Paid in dollars through Peer', zelle: 'Paid in dollars through Peer', chime: 'Paid in dollars through Peer', paypal: 'Paid in dollars through Peer' }
/** A PayPal share whose owner has not connected it with Peer yet: its payouts wait. */
const unconnected = (s: Share) => !!s.connectPath && s.connected === false // null = Peer was not asked yet: say nothing

export function Token({ mint }: { mint: string }) {
  const d = useData(() => api.token(mint), [mint], 30_000)
  const me = useData(() => api.me().catch(() => null), [mint])
  if (d.loading && !d.data) return <div className="page"><Loading /></div>
  if (!d.data) return <div className="page">{d.status === 404 ? <Empty title="Not a Pump Fund token">This address was not launched here.</Empty> : <ErrorNote error={d.error ?? 'unknown'} />}</div>
  const t = d.data.token
  const split = t.shares.length > 1
  // ours = paid by Pump Fund's own ledger (X Money or a payment app); others = paid by Pumpfun's fee sharing
  const xShares = t.shares.filter((s) => s.kind === 'x'), appShares = t.shares.filter(isApp), ours = [...xShares, ...appShares]
  const others = t.shares.filter((s) => s.kind === 'github' || s.kind === 'charity')
  const native = others.length > 0
  const myShare = xShares.find((s) => s.id === me.data?.user.id) ?? null
  const mine = !!myShare
  const who = listed(t.shares.map(label))
  const pumpPaid = others.every((s) => s.earned != null) ? others.reduce((n, s) => n + (s.earned ?? 0), 0) : null
  return (
    <div className="page">
      <section className="ct-token-head">
        <SafeImg src={t.image} label={t.symbol} size={96} radius={20} />
        <div className="grow">
          <div className="row-gap"><h1 className="ct-token-sym">${t.symbol}</h1>{t.platform ? <span className="pill pf-pill-accent">The Pump Fund token</span> : <span className="pill pf-pill-accent">{split ? `Funds ${t.shares.length} recipients` : `Funds ${label(t.shares[0]!)}`}</span>}</div>
          <div className="ct-token-name">{t.name}</div>
          {t.description && !t.platform && <p className="muted small pf-tk-desc">{t.description}</p>}
          <div className="muted small row-gap">
            {t.platform ? <span>Launched by Pump Fund</span>
              : <span>For {t.shares.map((s, i) => <span key={s.kind + s.id}>{i > 0 && ', '}<ShareLink s={s} /></span>)}{t.launchedBy && <> · launched by {t.launchedBy.handle ? `@${t.launchedBy.handle}` : <Ext href={SOLSCAN('account', t.launchedBy.id)} className="u mono">{t.launchedBy.id.slice(0, 4)}…{t.launchedBy.id.slice(-4)}</Ext>}</>}</span>}
            <span title={dateTime(t.createdAt)}>{ago(t.createdAt) === 'now' ? 'just now' : `${ago(t.createdAt)} ago`}</span>
          </div>
        </div>
      </section>

      <section className="ct-trade card">
        <CopyCA value={t.mint} />
        <div className="ct-trade-btns">
          <Ext href={t.links.pump} className="btn white sm">Trade on Pumpfun</Ext>
          <Ext href={t.links.x} className="btn ghost sm pf-x-btn" label={`$${t.symbol} on X`}><IX size={14} /></Ext>
        </div>
      </section>

      {/* operator 13 Nov: no "Creator rewards earned" figure here */}
      <section className="stat-grid ct-stats pf-stats-2col">
        <Stat label="Market cap" value={mcap(t.marketCapUsd)} />
        {t.ownCreator ? <Stat label="Claimed on Pumpfun" value={sol(t.creatorPaid)} sub={t.creatorOwed > 0 ? `${sol(t.creatorOwed)} waiting` : undefined} />
          : native ? <Stat label="Paid by Pumpfun" value={pumpPaid != null ? sol(pumpPaid) : 'On chain'} sub={listed(others.map((s) => (s.kind === 'github' ? s.handle : s.name))).slice(0, 60)} />
          : <Stat label={split ? 'Sent to the accounts' : `Sent to ${who}`} value={sol(t.creatorPaid)} sub={t.creatorOwed > 0 ? `${sol(t.creatorOwed)} waiting` : undefined} />}
      </section>

      {/* operator 16 Nov: "payouts and where the rewards go are chaotic": one recipient list (it was shown twice), the
          explanations under it, the on-chain links in one row, and Payouts as its own full-width block. Wording unchanged. */}
      <section className="pf-tk-section">
        <div className="ct-center-head"><SectionHead title="Where the rewards go" /></div>
        <div className="card pf-rw">
          <p className="pf-rw-lead">
            {t.ownCreator
              ? 'This is the Pump Fund token. Its Pumpfun creator is the wallet below: creator rewards from every trade go to it and are claimed on Pumpfun.'
              : `Pumpfun pays a creator reward on every trade of $${t.symbol}. All of it belongs to ${who}${split ? ', in the shares below. The split was fixed at launch and cannot be changed' : ''}.`}
          </p>
          {!t.platform && (
            <>
              {split && <SplitBar shares={t.shares} />}
              <div className="pf-rw-list">
                {t.shares.map((s, i) => (
                  <div key={s.kind + s.id} className="pf-rw-row">
                    {split && <span className={`pf-split-dot s${i}`} aria-hidden="true" />}
                    <Avatar src={s.avatar} size={40} label={s.handle} round={s.kind !== 'charity'} />
                    <div className="pf-rw-who">
                      <div className="pf-rw-name">{s.name}</div>
                      <div className="muted small pf-rw-sub"><ShareLink s={s} /> · {KIND_NOTE[s.kind]}</div>
                    </div>
                    <div className="pf-rw-right">
                      <div className="pf-rw-nums">
                        <div className="pf-rw-earned">{s.earned != null ? `${sol(s.earned)} earned` : s.kind === 'github' ? 'claimed on Pumpfun' : s.kind === 'charity' ? 'donated by Pumpfun' : ''}</div>
                        {((s.owed ?? 0) > 0 || unconnected(s)) && <div className="muted tiny">{(s.owed ?? 0) > 0 ? `${sol(s.owed!)} waiting` : ''}{unconnected(s) ? `${(s.owed ?? 0) > 0 ? ' · ' : ''}waiting for its owner to connect it` : ''}</div>}
                      </div>
                      {split && <span className="pill pf-rw-pct">{s.pct}%</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {(() => {
            const notes = [
              !t.ownCreator && xShares.length > 0 && <p key="x">{xShares.length > 1 ? 'Each X account\'s share' : native ? `${label(xShares[0]!)}'s share` : 'It'} is sent to {xShares.length > 1 ? 'that account\'s' : 'their'} X Money in dollars once it reaches 0.1 SOL, unless they chose a Solana wallet instead.</p>,
              !t.ownCreator && appShares.length > 0 && <p key="app">{appShares.length > 1 ? 'Each payment app account\'s share is' : `${label(appShares[0]!)}'s share is`} paid in dollars in that app once it reaches 0.1 SOL: a buyer on Peer pays the account and receives our USDC only after Peer has verified the payment.</p>,
              ...appShares.filter(unconnected).map((s) => <p key={'c' + s.id}>{s.handle} is paid once its owner connects it with Peer. <Link to={s.connectPath!} className="u">Is it yours? Connect it</Link>.</p>),
              others.some((s) => s.kind === 'github') && <p key="gh">A GitHub account's share is paid by Pumpfun: the owner signs in on <Ext href="https://pump.fun" className="u">Pumpfun</Ext> with GitHub and claims it.</p>,
              others.some((s) => s.kind === 'charity') && <p key="ch">A charity's share is paid by Pumpfun through Donate.gg, which delivers the donation.</p>,
              !t.ownCreator && xShares.length > 0 && !mine && !me.data && <p key="in">{xShares.length > 1 ? 'Is one of these X accounts yours?' : `Are you ${label(xShares[0]!)}?`} <a className="u" href={signInUrl('/account')}>Sign in with X</a> to see your rewards or choose where they are paid.</p>,
              mine && <p key="mine">{split ? `${myShare!.pct}% of these rewards is yours.` : 'These rewards are yours.'} <Link to="/account" className="u">Choose where they are paid</Link>.</p>,
            ].filter(Boolean)
            return notes.length ? <div className="pf-rw-notes muted small">{notes}</div> : null
          })()}
          {(t.shareConfig || t.ownCreator || ours.length > 0 || t.launchTx) && (
            <div className="pf-rw-meta small">
              {t.shareConfig && <div><span className="muted">Locked on Pumpfun</span><Ext href={SOLSCAN('account', t.shareConfig)} className="mono u">{t.shareConfig.slice(0, 6)}…{t.shareConfig.slice(-6)}</Ext></div>}
              {(t.ownCreator || ours.length > 0) && <div><span className="muted">{t.ownCreator ? 'Creator wallet' : 'Reward wallet'}</span><Ext href={SOLSCAN('account', t.feeWallet)} className="mono u">{t.feeWallet.slice(0, 6)}…{t.feeWallet.slice(-6)}</Ext></div>}
              {t.launchTx && <div><span className="muted">Launch</span><Ext href={SOLSCAN('tx', t.launchTx)} className="mono u">{t.launchTx.slice(0, 10)}…</Ext></div>}
            </div>
          )}
        </div>
      </section>

      <section className="pf-tk-section">
        {/* ⭐ only payments THIS token's rewards made, each step with its transaction (api/proof.mjs) */}
        <div className="ct-center-head"><SectionHead title="Payouts" /></div>
        {d.data.proof?.length ? (
          <>
            <p className="muted small pf-tk-sub">Every payment made from ${t.symbol}'s rewards. Open one to check each step on chain. <Link to="/payouts" className="u">All payouts</Link></p>
            <ProofList records={d.data.proof} empty="" />
          </>
        ) : t.ownCreator ? (
          <Empty title="Paid to the creator wallet">Creator rewards from every trade go to the creator wallet shown here and are claimed on Pumpfun.</Empty>
        ) : native && !ours.length ? (
          <Empty title="Paid by Pumpfun">Pumpfun pays these recipients itself. Nothing passes through Pump Fund.</Empty>
        ) : <Empty title="No payouts yet">Creator rewards are collected every few minutes. A recipient's share is sent once it reaches 0.1 SOL.</Empty>}
      </section>
    </div>
  )
}

/** The split as one bar: a segment per recipient, in launch order (its colour is the dot on that recipient's row). */
function SplitBar({ shares }: { shares: Share[] }) {
  return (
    <div className="pf-split-bar" role="img" aria-label={shares.map((s) => `${label(s)} ${s.pct}%`).join(', ')}>
      {shares.map((s, i) => <span key={s.kind + s.id} className={`pf-split-seg s${i}`} style={{ width: `${s.pct}%` }} />)}
    </div>
  )
}
