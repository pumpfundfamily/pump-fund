import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, signInUrl } from '../lib/api'
import { navigate, type Route } from '../lib/router'
import { X_HANDLE } from '../lib/site'
import { useData } from '../lib/useData'
import { IChevron, IGithub, IX } from './Icons'
import type { Me } from '../lib/types'
import { Avatar, Ext, Link, Mark } from './ui'

const NAV: { to: string; label: string; match: Route['name'][] }[] = [
  { to: '/launch', label: 'Launch', match: ['launch'] },
  { to: '/explore', label: 'Explore', match: ['explore', 'token', 'creator'] },
  { to: '/payouts', label: 'Payouts', match: ['payouts'] },
  { to: '/docs', label: 'How it works', match: ['docs'] },
]

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const me = useData(() => api.me().catch(() => null), [route.name === 'account'])
  const myHandle = me.data?.user?.handle ?? null
  return (
    <div className="pf-app">
      <header className="pf-hdr">
        <div className="pf-hdr-in">
          <Link to="/" className="pf-brand" aria-label="Pump Fund home"><span className="pf-brand-tile"><Mark size={22} /></span><span className="pf-brand-name">Pump Fund</span></Link>
          <nav className="pf-nav" aria-label="Sections">
            {NAV.map((n) => {
              const on = n.match.includes(route.name)
              return <Link key={n.to} to={n.to} className={`pf-nav-item ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined}>{n.label}</Link>
            })}
          </nav>
          <div className="pf-hdr-right">
            <a href="https://x.com/pumpfundfamily" target="_blank" rel="noopener noreferrer" className="btn ghost sm pf-hdr-x" aria-label="Pump Fund on X"><IX size={14} /></a>
            {me.data ? <UserMenu me={me.data} /> : (
              <a href={signInUrl('/account')} className="btn sm pf-signin">Connect</a>
            )}
          </div>
        </div>
      </header>

      <main className="pf-main">{children}</main>
      <Footer myHandle={myHandle} />
    </div>
  )
}

/** The signed-in account: a button that opens a small menu (closes on outside click, Escape, or picking an item). */
function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const go = (to: string) => { setOpen(false); navigate(to) }
  return (
    <span className="wallet-wrap" ref={box}>
      <button type="button" className="btn sm pf-signin" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar src={me.user.avatar} size={22} label={me.user.handle} /> <span className="hide-sm">@{me.user.handle}</span> <IChevron dir="down" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => go('/account')}>Rewards and payouts</button>
          <button type="button" role="menuitem" onClick={() => go(`/x/${me.user.handle}`)}>Public page</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); api.logout().then(() => { location.href = '/' }) }}>Sign out</button>
        </div>
      )}
    </span>
  )
}

function Footer({ myHandle }: { myHandle: string | null }) {
  return (
    <footer className="pf-ftr">
      <div className="pf-wrap pf-ftr-grid">
        <div>
          <div className="pf-brand"><span className="pf-brand-tile"><Mark size={22} /></span><span className="pf-brand-name">Pump Fund</span></div>
          <p className="pf-ftr-line">Turn Pumpfun creator rewards into funding for anything.</p>
        </div>
        <div>
          <h4>Site</h4>
          <div className="pf-ftr-links"><Link to="/launch">Launch</Link><Link to="/explore">Explore</Link><Link to="/docs">How it works</Link><Link to={myHandle ? '/account' : '/account'}>Your rewards</Link></div>
        </div>
        <div>
          <h4>Built on</h4>
          <div className="pf-ftr-links"><Ext href="https://pump.fun">Pumpfun</Ext><Ext href="https://peer.xyz">Peer</Ext><Ext href="https://solana.com">Solana</Ext></div>
        </div>
        <div>
          <h4>More</h4>
          <div className="pf-ftr-links">
            <Ext href={`https://x.com/${X_HANDLE || 'pumpfundfamily'}`}><IX size={13} /> Pump Fund</Ext>
            <Ext href="https://github.com/pumpfundfamily/pump-fund"><IGithub size={13} /> Pump Fund</Ext>
          </div>
        </div>
      </div>
    </footer>
  )
}
