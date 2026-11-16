import { useState } from 'react'
import { Link, Loading, TokenTile } from '../components/ui'
import { api } from '../lib/api'
import { useData } from '../lib/useData'
import { ProofList } from '../components/Proof'

const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function Home() {
  const stats = useData(() => api.stats(), [], 15_000)
  const tokens = useData(() => api.tokens('new', '', 8), [], 30_000)
  const payouts = useData(() => api.payouts(1), [], 30_000)
  const proof = useData(() => api.proof(5), [], 30_000)
  const s = stats.data
  return (
    <div className="pf-home">
      <section className="pf-hero">
        <div className="pf-wrap">
          <div className="pf-hero-in">
            <img src="/logo.png" alt="" className="pf-hero-mark" width={150} height={150} />
            <h1>Pump Fund</h1>
            <p className="pf-hero-lede">Turn Pumpfun creator rewards into funding for anything.</p>
            <div className="pf-hero-cta">
              <Link to="/launch" className="btn white pf-btn-lg">Launch a token</Link>
              <Link to="/docs" className="btn pf-btn-lg">How it works</Link>
            </div>
            {s && <CaStrip mint={s.platformMint} ticker={s.ticker} />}
          </div>
          {/* operator 13 Nov: two figures, like ponscharity.family's strip. Funded = every creator reward earned for recipients */}
          <div className="pf-stats pf-stats-2">
            <div className="pf-stat"><div className="pf-stat-k">Funded</div><div className="pf-stat-v">{s ? dollars(s.feesUsd) : '$0.00'}</div></div>
            <div className="pf-stat"><div className="pf-stat-k">Tokens launched</div><div className="pf-stat-v">{s ? s.launches.toLocaleString('en-US') : '0'}</div></div>
          </div>
        </div>
      </section>

      <section className="pf-section pf-section-alt" id="how">
        <div className="pf-wrap">
          <div className="pf-head"><h2>How it works</h2></div>
          <div className="pf-steps">
            <div className="pf-step"><div className="pf-step-top"><div className="pf-step-n">01</div><h3>Launch</h3></div><p>Create a Pumpfun token and choose who it funds. Direct creator rewards to a payment app, a X account, a GitHub account, a charity or split them between up to five recipients.</p></div>
            <div className="pf-step"><div className="pf-step-top"><div className="pf-step-n">02</div><h3>Creator rewards</h3></div><p>Pumpfun creator rewards are generated on every buy and sell. Instead of going to the person who launched the token, 100% goes to the selected recipients. Pump Fund takes no cut.</p></div>
            <div className="pf-step"><div className="pf-step-top"><div className="pf-step-n">03</div><h3>Funding</h3></div><p>X accounts receive dollars through X Money, GitHub accounts and charities receive their share directly through Pumpfun, and payment apps are paid through Peer.</p></div>
          </div>
        </div>
      </section>

      <section className="pf-section">
        <div className="pf-wrap">
          <div className="pf-head"><p className="pf-eyebrow">Explore</p><h2>Recent launches</h2></div>
          {tokens.loading && !tokens.data ? <Loading /> : tokens.data?.tokens.length ? (
            <>
              <div className="ct-grid wide pf-grid">{tokens.data.tokens.map((t) => <TokenTile key={t.mint} t={t} />)}</div>
              {tokens.data.total > tokens.data.tokens.length && <div className="pf-more"><Link to="/explore" className="btn">See all {tokens.data.total} launches</Link></div>}
            </>
          ) : <div className="pf-empty">{s && !s.launchingOpen ? `Launching opens when $${s.ticker} is live.` : 'Nothing here yet. Launch the first one.'}</div>}
        </div>
      </section>

      <section className="pf-section pf-section-alt">
        <div className="pf-wrap">
          {/* operator 13 Nov: laid out like ponscharity.family's donations list */}
          <div className="pf-pay-head pf-pay-head-center">
            <div>
              <div className="pf-pay-title"><h2>Payouts</h2>{proof.data && <span className="pf-pay-count">{proof.data.total.toLocaleString('en-US')}</span>}</div>
              <p className="muted">Every payout Pump Fund has made to a recipient.</p>
            </div>
            {payouts.data && <div className="pf-pay-total"><div className="pf-pay-total-v">${(payouts.data.totals.paidUsd + payouts.data.totals.listedUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="muted small">Paid out</div></div>}
          </div>
          <ProofList records={proof.data?.records ?? []} empty="Payouts are listed here as they are sent." />
          {(proof.data?.total ?? 0) > 0 && <div className="pf-more"><Link to="/payouts" className="btn ghost">View all payouts</Link></div>}
        </div>
      </section>
    </div>
  )
}

function CaStrip({ mint, ticker }: { mint: string | null; ticker: string }) {
  const [copied, setCopied] = useState(false)
  if (!mint) return <p className="pf-ca pf-ca-tba"><span className="pf-ca-k">CA:</span><span>TBA</span></p>
  const copy = () => { void navigator.clipboard?.writeText(mint).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }
  return (
    <button type="button" className={`pf-ca pf-ca-btn ${copied ? 'copied' : ''}`} onClick={copy} title="Copy the contract address" aria-label={`Copy the $${ticker} contract address ${mint}`}>
      <span className="pf-ca-k">{copied ? 'Copied' : 'CA:'}</span><span className="mono pf-ca-v">{mint}</span>
    </button>
  )
}
