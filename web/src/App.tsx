import { useEffect } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Shell } from './components/Shell'
import { Empty, Link } from './components/ui'
import { useRoute, type Route } from './lib/router'
import { Account } from './pages/Account'
import { Creator } from './pages/Creator'
import { Paypal } from './pages/Paypal'
import { Payouts } from './pages/Payouts'
import { Docs } from './pages/Docs'
import { Explore } from './pages/Explore'
import { Home } from './pages/Home'
import { Launch } from './pages/Launch'
import { Privacy, Terms } from './pages/Legal'
import { Token } from './pages/Token'

function page(r: Route) {
  switch (r.name) {
    case 'home': return <Home />
    case 'explore': return <Explore />
    case 'launch': return <Launch />
    case 'account': return <Account />
    case 'docs': return <Docs />
    case 'terms': return <Terms />
    case 'privacy': return <Privacy />
    case 'token': return <Token key={r.mint} mint={r.mint} />
    case 'creator': return <Creator key={r.handle} handle={r.handle} />
    case 'paypal': return <Paypal key={r.handle} handle={r.handle} />
    case 'payouts': return <Payouts />
    case 'not-found': return <div className="page"><Empty title="Nothing here"><Link to="/" className="u">Back home</Link></Empty></div>
  }
}

export function App() {
  const route = useRoute()
  useEffect(() => { document.title = 'Pump Fund' }, [route])
  return <Shell route={route}><ErrorBoundary resetKey={location.pathname}>{page(route)}</ErrorBoundary></Shell>
}
