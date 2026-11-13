import { useEffect, useState } from 'react'
import { Empty, ErrorNote, Ext, Link, Loading, SafeImg, SectionHead, Stat } from '../components/ui'
import { api } from '../lib/api'
import { sol } from '../lib/site'
import { useData } from '../lib/useData'

type Started = { id: string; url: string; appUrl: string; expiresAt: number }
type Phase = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; msg: string } | { kind: 'open'; link: Started; status: string }

/** Which Peer link a device opens: the App Clip on iPhone Safari, the Peer app elsewhere on mobile, none on desktop. */
function device(): 'ios' | 'mobile' | 'desktop' {
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (ios) return 'ios'
  return /Android|Mobile/i.test(ua) ? 'mobile' : 'desktop'
}

/**
 * /paypal/<username>: the owner of a PayPal account a token pays connects it with Peer, once. Peer verifies the account
 * in its own app; until then the account's share waits. The email goes to Peer only (never stored here).
 */
export function Paypal({ handle }: { handle: string }) {
  const d = useData(() => api.paypal(handle), [handle])
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const dev = device()

  // follow a started connection until Peer answers
  const open = phase.kind === 'open' ? phase.link.id : null
  useEffect(() => {
    if (!open) return
    let live = true
    const tick = async () => {
      while (live) {
        await new Promise((r) => setTimeout(r, 3000))
        let s
        try { s = await api.paypalStatus(open) } catch { continue }
        if (!live) return
        if (s.status === 'connected') { setPhase({ kind: 'idle' }); d.reload(); return }
        if (s.status === 'expired' || s.status === 'cancelled') { setPhase({ kind: 'error', msg: s.status === 'expired' ? 'The link expired. Start again.' : 'The connection was cancelled. Start again.' }); return }
        setPhase((p) => (p.kind === 'open' ? { ...p, status: s.status } : p))
      }
    }
    void tick()
    return () => { live = false }
  }, [open])

  if (d.loading && !d.data) return <div className="page"><Loading /></div>
  if (!d.data) return <div className="page">{d.status === 404 ? <Empty title="No token pays this PayPal account">Check the username, or launch a token for it on the Launch page.</Empty> : <ErrorNote error={d.error ?? 'unknown'} />}</div>
  const a = d.data

  async function start() {
    setPhase({ kind: 'busy' })
    try {
      const r = await api.paypalConnect(handle, email.trim())
      if ('connected' in r) { setPhase({ kind: 'idle' }); d.reload(); return }
      setPhase({ kind: 'open', link: r, status: 'pending' })
    } catch (e) { setPhase({ kind: 'error', msg: (e as Error).message }) }
  }
  const copyPage = () => { void navigator.clipboard?.writeText(location.href).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }

  return (
    <div className="page pf-paypal">
      <section className="profile-head ct-profile-center">
        <div>
          <h1>paypal.me/{a.handle}</h1>
          <div className="muted">{a.connected ? 'Connected with Peer. Payouts run on their own.' : a.connected === false ? 'Not connected yet. Its share waits until it is.' : 'Checking with Peer…'}</div>
        </div>
      </section>
      <section className="stat-grid ct-stats pf-stats-3">
        <Stat label="Tokens funding it" value={a.tokens.length} />
        <Stat label="Waiting to be paid" value={sol(a.owedSol)} />
        <Stat label="Status" value={a.connected ? 'Connected' : 'Not connected'} />
      </section>

      {!a.connected && (
        <section className="card stack pf-paypal-connect">
          <SectionHead title="Is this your PayPal? Connect it" />
          <p className="muted small" style={{ margin: 0 }}>Pump Fund pays PayPal through <Ext href="https://peer.xyz" className="u">Peer</Ext>: a buyer sends dollars to your PayPal and only receives our USDC once Peer has verified the payment. Peer needs you to connect your PayPal once, in its app, to prove it is yours. It takes a few minutes and moves no money.</p>
          {phase.kind !== 'open' ? (
            <>
              <label className="small" htmlFor="pp-email">Email address of your PayPal account</label>
              <div className="input-row"><input id="pp-email" type="email" inputMode="email" autoComplete="email" value={email} maxLength={254} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} /></div>
              <div className="muted tiny">Sent to Peer for this connection only. Pump Fund does not keep it.</div>
              <button type="button" className="btn white" disabled={phase.kind === 'busy' || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim())} onClick={start}>{phase.kind === 'busy' ? 'Starting…' : 'Connect PayPal'}</button>
              {phase.kind === 'error' && <div className="note error" role="alert">{phase.msg}</div>}
            </>
          ) : (
            <>
              {dev === 'desktop' ? (
                <>
                  <div className="note">Connecting happens in Peer's app on your phone. Open this page on your phone and press Connect PayPal there, or open the link below on your phone.</div>
                  <div className="row-gap"><button type="button" className="btn sm" onClick={copyPage}>{copied ? 'Copied' : 'Copy this page\'s link'}</button><Ext href={phase.link.url} className="btn ghost sm">Open Peer's link</Ext></div>
                </>
              ) : (
                <a href={dev === 'ios' ? phase.link.url : phase.link.appUrl} className="btn white">Continue in Peer</a>
              )}
              <div className="muted small" role="status">{phase.status === 'connecting' ? 'Peer is checking your PayPal…' : 'Waiting for you to finish in Peer. Come back to this page afterwards; it updates on its own.'}</div>
            </>
          )}
        </section>
      )}

      <div className="ct-center-head"><SectionHead title="Tokens" /></div>
      <div className="stack">
        {a.tokens.map((t) => (
          <Link key={t.mint} to={`/t/${t.mint}`} className="row">
            <div className="row-gap"><SafeImg src={t.image} label={t.symbol} size={36} radius={10} /><div><div className="cc-name">${t.symbol}</div><div className="muted small">{t.name}</div></div></div>
            <span className="pill">{t.pct}%</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
