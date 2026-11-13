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
          <div className="pf-head"><p className="pf-eyebrow">How it works</p><h2>Tokens that fund someone</h2></div>
          <div className="pf-steps">
            <div className="pf-step"><div className="pf-step-n">01</div><h3>You launch</h3><p>Connect a wallet, pick a ticker and choose who the token funds: an X account, a Venmo, Cash App, Zelle, Chime or PayPal account, a GitHub account, a charity, or up to five of them in a split. It goes live on Pumpfun in seconds, with an address ending in fund.</p></div>
            <div className="pf-step"><div className="pf-step-n">02</div><h3>Rewards collect on their own</h3><p>Pumpfun pays a creator reward on every buy and sell. All of it belongs to the recipients the token was launched for. Pump Fund takes no cut.</p></div>
            <div className="pf-step"><div className="pf-step-n">03</div><h3>It reaches them</h3><p>An X account is paid to its X Money in dollars, through Peer, without ever signing in. GitHub accounts and charities are paid by Pumpfun itself, with their share locked on chain at launch.</p></div>
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
          <div className="pf-pay-head">
            <div>
              <div className="pf-pay-title"><h2>Payouts</h2>{payouts.data && <span className="pf-pay-count">{payouts.data.totals.payouts.toLocaleString('en-US')}</span>}</div>
              <p className="muted">Every payout our launchpad has made to a recipient.</p>
            </div>
            {payouts.data && <div className="pf-pay-total"><div className="pf-pay-total-v">{payouts.data.totals.paidUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="muted small">USD delivered</div></div>}
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
