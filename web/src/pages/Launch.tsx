import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IClose, IGithub, ISearch, IWallet, IX } from '../components/Icons'
import { Avatar, Ext, Link, SOLSCAN } from '../components/ui'
import { api, signInUrl, type Charity, type ForCheck } from '../lib/api'
import { short } from '../lib/format'
import { navigate } from '../lib/router'
import { useData } from '../lib/useData'
import { useModal } from '../lib/useModal'
import { fromBase64, toBase64, useWallet } from '../lib/wallet'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const QUICK_BUYS = ['0.1', '0.5', '1', '2']
const DRAFT = 'pumpfund.launch'
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/
/** "@bob", "x.com/bob" → "bob" */
const handleOf = (raw: string) => raw.trim().replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '')
const nameBytes = (s: string) => new TextEncoder().encode(s).length
const tokensFmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : Math.round(n).toLocaleString('en-US'))

/** One account the token funds: its X handle as typed and its share in whole percent. */
type AppKind = 'venmo' | 'cashapp' | 'zelle' | 'chime' | 'paypal'
type Kind = 'x' | 'github' | 'charity' | AppKind
/** `handle`: an X handle, a GitHub username, an app payee, or (charity) the directory id; `label`/`logo`: the picked charity, for display. */
type Recipient = { kind?: Kind; handle: string; pct: string; label?: string; logo?: string }
const GH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
/** The kind chips. "Payment app" opens the app chips below it (Venmo first). */
const KINDS: { kind: Kind; label: string }[] = [{ kind: 'x', label: 'X account' }, { kind: 'venmo', label: 'Payment app' }, { kind: 'github', label: 'GitHub' }, { kind: 'charity', label: 'Charity' }]
/**
 * Payment apps paid through Peer (api/rails.mjs holds the same rules; the server checks again). `clean` gives the payee
 * exactly as it will be paid, or null. Nothing can look these accounts up, so the form shows the payee back to check.
 */
const APPS: Record<AppKind, { label: string; prefix: string; placeholder: string; hint: string; clean: (v: string) => string | null; shown: (h: string) => string }> = {
  venmo: { label: 'Venmo', prefix: '@', placeholder: 'Venmo username', hint: 'Venmo username, like @jane-doe',
    clean: (v) => { const s = v.trim().replace(/^@+/, ''); return /^[A-Za-z0-9_-]{5,30}$/.test(s) ? s : null }, shown: (h) => `@${h}` },
  cashapp: { label: 'Cash App', prefix: '$', placeholder: 'cashtag', hint: 'Cash App cashtag, like $jane',
    clean: (v) => { const s = v.trim().replace(/^\$+/, ''); return /^[A-Za-z0-9]{1,20}$/.test(s) && /[A-Za-z]/.test(s) ? s : null }, shown: (h) => `$${h}` },
  zelle: { label: 'Zelle', prefix: '', placeholder: 'Email or US phone number', hint: 'Zelle email or US phone number',
    clean: (v) => {
      const s = v.trim().toLowerCase()
      if (/^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/.test(s) && s.length <= 254) return s
      const d = s.replace(/[\s().-]/g, '').replace(/^\+?1(?=\d{10}$)/, '')
      return /^[2-9]\d{9}$/.test(d) ? d : null
    }, shown: (h) => (/^\d{10}$/.test(h) ? `(${h.slice(0, 3)}) ${h.slice(3, 6)}-${h.slice(6)}` : h) },
  chime: { label: 'Chime', prefix: '$', placeholder: 'ChimeSign', hint: 'ChimeSign, like $jane',
    clean: (v) => { const s = v.trim().replace(/^\$+/, '').toLowerCase(); return /^[a-z0-9_-]{1,30}$/.test(s) ? `$${s}` : null }, shown: (h) => h },
  paypal: { label: 'PayPal', prefix: 'paypal.me/', placeholder: 'username', hint: 'PayPal.Me username, like paypal.me/janedoe',
    clean: (v) => { const s = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^paypal\.me\//i, '').split(/[/?#]/)[0]!.replace(/^@+/, '').trim().toLowerCase(); return /^[a-z0-9._-]{1,40}$/.test(s) && /[a-z0-9]/.test(s) ? s : null },
    shown: (h) => `paypal.me/${h}` },
}
const APP_KINDS = Object.keys(APPS) as AppKind[]
const isApp = (k: Kind | undefined): k is AppKind => !!k && k in APPS
type Picture = { preview: string; data: string } | null
type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; msg: string; sub?: string }
  | { kind: 'error'; msg: string }
  /** sent to the network, but this page lost track of it: the coin may exist, so the transaction is shown */
  | { kind: 'sent'; msg: string; signature: string | null }

/** Fields kept across the sign-in round trip (the picture is not: it is picked again). */
type Saved = { name: string; symbol: string; description: string; website: string; twitter: string; telegram: string; devBuy: string; recipients: Recipient[] }
const loadSaved = (): Partial<Saved> => { try { return JSON.parse(sessionStorage.getItem(DRAFT) ?? '{}') as Partial<Saved> } catch { return {} } }

export function Launch() {
  const opts = useData(() => api.launchOptions(), [])
  const me = useData(() => api.me().catch(() => null), [])
  const w = useWallet()
  const o = opts.data
  const saved = useMemo(loadSaved, [])

  const [name, setName] = useState(saved.name ?? '')
  const [symbol, setSymbol] = useState(saved.symbol ?? '')
  const [description, setDescription] = useState(saved.description ?? '')
  const [picture, setPicture] = useState<Picture>(null)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [website, setWebsite] = useState(saved.website ?? '')
  const [twitter, setTwitter] = useState(saved.twitter ?? '')
  const [telegram, setTelegram] = useState(saved.telegram ?? '')
  // who the creator rewards go to: one to five X accounts with a share each (never the launcher)
  const [recipients, setRecipients] = useState<Recipient[]>(saved.recipients?.length ? saved.recipients : [{ handle: '', pct: '100' }])
  // lookups already answered, by lower-case handle (one paid lookup per handle)
  const [checks, setChecks] = useState<Record<string, ForCheck>>({})
  const [devBuy, setDevBuy] = useState(saved.devBuy ?? '')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [picking, setPicking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT, JSON.stringify({ name, symbol, description, website, twitter, telegram, devBuy, recipients } satisfies Saved)) } catch { /* private window */ }
  }, [name, symbol, description, website, twitter, telegram, devBuy, recipients])

  // is the ticker free (a ticker launched in the last 24 hours is taken)
  const [tickerNote, setTickerNote] = useState<string | null>(null)
  useEffect(() => {
    setTickerNote(null)
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(symbol)) return
    let live = true
    const t = setTimeout(() => api.launchCheck(symbol).then((r) => { if (live) setTickerNote(r.ticker && !r.ticker.free ? r.ticker.reason : null) }).catch(() => {}), 400)
    return () => { live = false; clearTimeout(t) }
  }, [symbol])

  // does each X account exist (looked up once the typing stops, signed-in accounts only, each handle once)
  const signedInHandle = me.data?.user.handle ?? null
  const maxRecipients = o?.maxRecipients ?? 5, minPct = o?.minSharePct ?? 5
  const rows = recipients.map((r) => {
    const kind: Kind = r.kind ?? 'x'
    if (kind === 'charity') return { ...r, kind, handle: r.handle, key: `charity:${r.handle}`, self: false, valid: /^0x[0-9a-f]{64}$/.test(r.handle), check: null as ForCheck | null }
    if (isApp(kind)) { const payee = APPS[kind].clean(r.handle); return { ...r, kind, handle: payee ?? r.handle.trim(), key: `${kind}:${(payee ?? r.handle.trim()).toLowerCase()}`, self: false, valid: !!payee, check: null as ForCheck | null } }
    if (kind === 'github') { const handle = r.handle.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, ''); const key = `github:${handle.toLowerCase()}`
      return { ...r, kind, handle, key, self: false, valid: GH_RE.test(handle), check: checks[key] ?? null } }
    const handle = handleOf(r.handle), key = `x:${handle.toLowerCase()}`
    const self = !!signedInHandle && handle.toLowerCase() === signedInHandle.toLowerCase()
    return { ...r, kind, handle, key, self, valid: HANDLE_RE.test(handle), check: self ? null : checks[key] ?? null }
  })
  const pending = rows.filter((r) => (r.kind === 'x' || r.kind === 'github') && r.valid && !r.self && !checks[r.key]).map((r) => r.key).join(',')
  useEffect(() => {
    if (!pending || !signedInHandle) return
    let live = true
    const t = setTimeout(() => {
      for (const k of pending.split(',')) {
        const [kind, h] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)]
        const ask = kind === 'github' ? api.launchCheckGithub(h).then((r) => r.github) : api.launchCheck('', h).then((r) => r.for)
        ask.then((r) => { if (live && r) setChecks((c) => ({ ...c, [k]: r })) }).catch(() => {})
      }
    }, 600)
    return () => { live = false; clearTimeout(t) }
  }, [pending, signedInHandle])
  /** Pumpfun itself pays GitHub accounts and charities (its own fee sharing): such a token launches without a dev buy. */
  const native = rows.some((r) => r.kind === 'github' || r.kind === 'charity')
  const hasApp = rows.some((r) => isApp(r.kind))
  const setRow = (i: number, patch: Partial<Recipient>) => setRecipients((list) => list.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  /** Equal whole shares that add up to 100 (the first rows take the remainder). */
  const evenly = (n: number) => Array.from({ length: n }, (_, i) => String(Math.floor(100 / n) + (i < 100 % n ? 1 : 0)))
  const addRow = () => setRecipients((list) => { const even = evenly(list.length + 1); return [...list, { kind: 'x' as Kind, handle: '', pct: '' }].map((r, i) => ({ ...r, pct: even[i]! })) })
  const removeRow = (i: number) => setRecipients((list) => { const next = list.filter((_, k) => k !== i); const even = evenly(next.length); return next.map((r, k) => ({ ...r, pct: even[k]! })) })
  const pctTotal = rows.reduce((t, r) => t + (Number(r.pct) || 0), 0)
  const split = rows.length > 1
  /** Who gets what, as the summary and the bar show it (rows with something typed in). */
  const shareParts = rows.filter((r) => r.handle).map((r) => ({
    label: r.kind === 'charity' ? r.label ?? 'Charity' : isApp(r.kind) ? `${APPS[r.kind].label} ${r.valid ? APPS[r.kind].shown(r.handle) : r.handle}` : r.kind === 'github' ? `${r.check?.ok ? r.check.handle : r.handle} (GitHub)` : `@${r.check?.ok ? r.check.handle : r.handle}`,
    pct: split ? Number(r.pct) || 0 : 100,
  }))

  function pickPicture(file: File | undefined) {
    if (!file) return
    setPictureError(null)
    if (!IMAGE_TYPES.includes(file.type)) return setPictureError('PNG, JPG, GIF or WebP only.')
    if (file.size > (o?.imageMax ?? 4 * 1024 * 1024)) return setPictureError('That image is over 4 MB.')
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      setPicture({ preview: url, data: url.slice(url.indexOf(',') + 1) })
    }
    reader.onerror = () => setPictureError('That image could not be read.')
    reader.readAsDataURL(file)
  }

  const buy = Number(devBuy || '0')
  const wantsBuy = buy > 0
  const buyOff = !o?.devBuy.enabled ? 'Dev buys are switched off right now. You can buy on Pumpfun as soon as the token is live.'
    : native ? 'A dev buy is not available on a token that funds a GitHub account or a charity. You can buy on Pumpfun as soon as the token is live.' : null
  const estimate = useMemo(() => {
    if (!o || !(buy > 0)) return null
    const net = buy / (1 + o.devBuy.feeBps / 10_000)
    const tokens = (o.curve.virtualTokens * net) / (o.curve.virtualSol + net)
    return { tokens, pct: (tokens / o.curve.supply) * 100 }
  }, [o, buy])

  const problems: string[] = []
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(symbol)) problems.push(symbol ? 'The ticker is letters and numbers, starting with a letter' : 'Add a ticker')
  if (nameBytes(name.trim()) > (o?.nameMax ?? 32)) problems.push('The name is too long')
  if (tickerNote) problems.push('That ticker is taken for now')
  if (rows.some((r) => !r.handle)) problems.push(split ? 'Fill in every recipient, or remove the empty row' : 'Name who it funds')
  else if (rows.some((r) => r.kind === 'x' && !r.valid)) problems.push('Enter an X handle, like @handle')
  else if (rows.some((r) => r.kind === 'github' && !r.valid)) problems.push('Enter a GitHub username')
  else if (rows.some((r) => r.kind === 'charity' && !r.valid)) problems.push('Pick the charity from the list')
  else if (rows.some((r) => isApp(r.kind) && !r.valid)) { const bad = rows.find((r) => isApp(r.kind) && !r.valid)!; problems.push(`Enter a valid ${APPS[bad.kind as AppKind].hint}`) }
  else if (rows.some((r) => r.self)) problems.push('You cannot be a recipient of a token you launch')
  else if (new Set(rows.map((r) => r.key)).size !== rows.length) problems.push('Each recipient can be listed once')
  else if (rows.some((r) => r.check && !r.check.ok)) problems.push('A recipient was not found')
  if (rows.some((r) => !/^\d+$/.test(r.pct) || Number(r.pct) < minPct)) problems.push(`Each account gets at least ${minPct}%`)
  else if (pctTotal !== 100) problems.push(`The shares add up to ${pctTotal}%, not 100%`)

  const busy = phase.kind === 'busy'
  const signedIn = !!me.data
  const closed = !!o && !o.open

  /** Follows a launch until the chain has answered, then opens the coin's page. */
  const follow = useCallback(async (id: string, signature: string | null) => {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, i < 10 ? 1200 : 2500))
      let s
      try { s = await api.launchStatus(id) } catch { continue }
      if (s.state === 'launched' && s.mint) {
        try { sessionStorage.removeItem(DRAFT) } catch { /* private window */ }
        return navigate(`/t/${s.mint}`)
      }
      if (s.state === 'rejected' || s.state === 'failed' || s.state === 'expired') return setPhase({ kind: 'error', msg: s.reason ?? 'The launch did not go through. Try again.' })
      setPhase({ kind: 'busy', msg: s.state === 'queued' ? 'In the queue' : 'Launching on Pumpfun', sub: s.state === 'queued' ? 'Your token launches as soon as its turn comes. Keep this page open.' : 'Waiting for Solana to confirm.' })
    }
    setPhase({ kind: 'sent', msg: 'This is taking longer than usual. Your token shows up on your profile once it is live.', signature })
  }, [])

  async function launch() {
    if (problems.length || busy || !o) return
    const withBuy = wantsBuy && !buyOff
    if (withBuy && !w.address) return setPicking(true)
    try {
      setPhase({ kind: 'busy', msg: 'Preparing your token' })
      const r = await api.launch({
        symbol, name: name.trim(), description: description.trim(), website: website.trim(), twitter: twitter.trim(), telegram: telegram.trim(),
        recipients: rows.map((r) => ({ kind: r.kind, handle: r.handle, pct: Number(r.pct) })), image: picture?.data ?? null,
        devBuy: withBuy ? { wallet: w.address!, sol: devBuy } : null,
      })
      if (r.state === 'signing' && r.transaction) {
        if (!r.mint?.endsWith('fund')) throw new Error('The server returned an unexpected token address. Nothing was signed.')
        setPhase({ kind: 'busy', msg: 'Approve the dev buy in your wallet', sub: `Buying ${devBuy} SOL of $${symbol}. Pump Fund pays for the launch itself.` })
        let signed: Uint8Array
        try { signed = await w.sign(fromBase64(r.transaction)) } catch (e) {
          return setPhase({ kind: 'error', msg: /reject|denied|cancel|declin/i.test((e as Error).message) ? 'You declined in your wallet. Nothing was sent.' : `Your wallet did not sign: ${(e as Error).message}` })
        }
        setPhase({ kind: 'busy', msg: 'Launching on Pumpfun', sub: 'Waiting for Solana to confirm.' })
        const sent = await api.launchSign(r.id, toBase64(signed))
        return follow(r.id, sent.signature ?? null)
      }
      setPhase({ kind: 'busy', msg: 'In the queue', sub: 'Your token launches as soon as its turn comes. Keep this page open.' })
      return follow(r.id, null)
    } catch (e) {
      setPhase({ kind: 'error', msg: (e as Error).message })
    }
  }

  const label = busy ? phase.msg
    : closed ? 'Launching is closed right now'
    : problems[0] ?? (wantsBuy && !buyOff && !w.address ? 'Connect wallet for the dev buy' : wantsBuy && !buyOff ? `Launch and buy ${devBuy} SOL` : 'Launch for free')

  return (
    <div className="page ct-launch">
      <header className="pf-pagehead pf-pagehead-center">
        <p className="pf-eyebrow">Launch</p>
        <h1>Launch a token that funds someone</h1>
        <p className="muted">The recipients and their shares are fixed for the life of the token. Launching is free, and every address ends in <span className="mono">fund</span>.</p>
      </header>
      {closed && <div className="note pf-closed" role="status">Launching opens when $FUND, the Pump Fund token, is live. You can fill in the form now.</div>}

      <div className="launch-layout">
        {/* operator 13 Nov: one form card like ponscharity.family/launch, groups split by rules, a summary card beside it */}
        <div className="ct-launch-form card pf-launch-card">
          <Section title="Your token">
            <div className="pf-lgrid">
              <div>
                <label className="field-label" htmlFor="l-name">Token name</label>
                <input id="l-name" value={name} maxLength={32} placeholder={symbol || 'Clean Water Fund'} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label className="field-label" htmlFor="l-sym">Symbol</label>
                <div className="input-row"><span className="ct-cash">$</span><input id="l-sym" value={symbol} maxLength={o?.symbolMax ?? 10} autoComplete="off" spellCheck={false} placeholder="WATER"
                  onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} /></div>
              </div>
            </div>
            {tickerNote && <div className="note error" role="status">{tickerNote}</div>}
            <label className="field-label">Token image</label>
            <div className="pf-limg">
              <div className="pf-limg-tile">{picture ? <img src={picture.preview} alt="" /> : <img src="/logo.png" alt="" />}</div>
              <div
                className="pf-limg-drop" role="button" tabIndex={0} aria-label="Choose the token image"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click() } }}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pickPicture(e.dataTransfer.files[0]) }}
              >
                <strong>{picture ? 'Drop another image, or click to change' : 'Drop an image, or click to choose'}</strong>
                <span className="muted small">PNG, JPG, GIF or WebP, up to 4 MB</span>
                <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => { pickPicture(e.target.files?.[0]); e.target.value = '' }} />
              </div>
            </div>
            {pictureError && <div className="note error" role="status">{pictureError}</div>}
            <div className="muted tiny">{picture ? <button type="button" className="ct-linkish" onClick={() => setPicture(null)}>Remove the image</button> : 'Without an image the token carries the Pump Fund heart.'} With no name, the token is named after its symbol.</div>
            <label className="field-label" htmlFor="l-desc">Description</label>
            <textarea id="l-desc" rows={3} value={description} maxLength={o?.descMax ?? 500} placeholder="What this token is for." onChange={(e) => setDescription(e.target.value)} />
            <div className="pf-lgrid">
              <div><label className="field-label" htmlFor="l-web">Website</label><input id="l-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" spellCheck={false} /></div>
              <div><label className="field-label" htmlFor="l-x">X / Twitter</label><input id="l-x" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle" spellCheck={false} /></div>
            </div>
            <div><label className="field-label" htmlFor="l-tg">Telegram</label><input id="l-tg" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="t.me/yourgroup" spellCheck={false} /></div>
            <div className="muted tiny">Left empty, your token links to pumpfund.family.</div>
          </Section>

          <Section title="Who it funds" hint="Pumpfun pays a creator reward on every trade. Send it to an X account, a Venmo, Cash App, Zelle, Chime or PayPal account, a GitHub account or a charity, or split it between up to five.">
            <div className="pf-recipients">
              {rows.map((r, i) => (
                <div key={i} className="pf-recipient">
                  <div className="pf-kinds" role="radiogroup" aria-label={`Recipient ${i + 1} is`}>
                    {KINDS.map((k) => { const on = isApp(k.kind) ? isApp(r.kind) : r.kind === k.kind
                      return <button key={k.kind} type="button" role="radio" aria-checked={on} className={`chip ${on ? 'on' : ''}`} onClick={() => { if (!on) setRow(i, { kind: k.kind, handle: '', label: undefined, logo: undefined }) }}>{k.label}</button> })}
                  </div>
                  {isApp(r.kind) && (
                    <div className="pf-kinds pf-apps" role="radiogroup" aria-label={`Payment app of recipient ${i + 1}`}>
                      {APP_KINDS.map((a) => <button key={a} type="button" role="radio" aria-checked={r.kind === a} className={`chip sm ${r.kind === a ? 'on' : ''}`} onClick={() => { if (r.kind !== a) setRow(i, { kind: a, handle: '' }) }}>{APPS[a].label}</button>)}
                    </div>
                  )}
                  <div className="pf-recipient-row">
                    {r.kind === 'charity' ? (
                      r.valid ? <div className="pf-for grow"><Avatar src={r.logo ?? ''} size={36} label={r.label ?? 'C'} round={false} /><div className="grow"><div className="pf-for-name">{r.label}</div><div className="muted small">Charity, through Donate.gg</div></div><button type="button" className="btn ghost xs" onClick={() => setRow(i, { handle: '', label: undefined, logo: undefined })}>Change</button></div>
                        : <CharityPicker onPick={(c) => setRow(i, { handle: c.id, label: c.name, logo: c.logo })} />
                    ) : isApp(r.kind) ? (
                      <div className="input-row grow">{APPS[r.kind].prefix && <span className="ct-cash">{APPS[r.kind].prefix}</span>}<input value={recipients[i]!.handle} maxLength={r.kind === 'zelle' ? 254 : 40} autoComplete="off" spellCheck={false}
                        inputMode={r.kind === 'zelle' ? 'email' : 'text'} placeholder={APPS[r.kind].placeholder} aria-label={`${APPS[r.kind].label} account ${i + 1}`}
                        onChange={(e) => setRow(i, { handle: r.kind === 'zelle' ? e.target.value
                          : r.kind === 'paypal' ? e.target.value.replace(/\s/g, '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^paypal\.me\//i, '').replace(/^@+/, '')
                          : e.target.value.replace(/\s/g, '').replace(/^[@$]+/, '') })} /></div>
                    ) : (
                      <div className="input-row grow"><span className="ct-cash">{r.kind === 'github' ? <IGithub /> : '@'}</span><input id={i === 0 ? 'l-for' : undefined} value={recipients[i]!.handle} maxLength={60} autoComplete="off" spellCheck={false} placeholder={r.kind === 'github' ? 'GitHub username' : 'handle'} aria-label={r.kind === 'github' ? `GitHub account ${i + 1}` : `X account ${i + 1}`}
                        onChange={(e) => setRow(i, { handle: e.target.value.replace(/\s/g, '').replace(/^@+/, '') })} /></div>
                    )}
                    {split && <div className="input-row pf-pct"><input value={r.pct} inputMode="numeric" maxLength={3} aria-label={`Share of recipient ${i + 1} in percent`} onChange={(e) => setRow(i, { pct: e.target.value.replace(/\D/g, '') })} /><span className="muted">%</span></div>}
                    {split && <button type="button" className="icon-btn" aria-label={`Remove recipient ${i + 1}`} onClick={() => removeRow(i)}><IClose size={14} /></button>}
                  </div>
                  {r.kind === 'charity' || !r.handle ? null
                    : isApp(r.kind) ? (!r.valid ? <div className="note error" role="status">Enter a valid {APPS[r.kind].hint}.</div>
                      : <div className="pf-for"><span className="pf-app-mark" aria-hidden="true">{APPS[r.kind].label.slice(0, 1)}</span><div className="grow"><div className="pf-for-name">{APPS[r.kind].label} {APPS[r.kind].shown(r.handle)}</div><div className="muted small">{r.kind === 'paypal' ? 'Paid in dollars on PayPal once its owner connects it with Peer. Check the spelling: it cannot be changed later.' : `Paid in dollars on ${APPS[r.kind].label}. Check the spelling: it cannot be looked up or changed later.`}</div></div><span className="pill">{split ? `Receives ${r.pct || 0}%` : 'Receives the rewards'}</span></div>)
                    : !r.valid ? <div className="note error" role="status">{r.kind === 'github' ? 'Enter a GitHub username, like octocat.' : 'Enter an X handle, like @handle.'}</div>
                    : r.self ? <div className="note error" role="status">You cannot be a recipient of a token you launch.</div>
                    : r.check?.ok ? <div className="pf-for"><Avatar src={r.check.avatar} size={36} label={r.check.handle} /><div className="grow"><div className="pf-for-name">{r.check.name}</div><div className="muted small">{r.kind === 'github' ? `${r.check.handle} on GitHub` : `@${r.check.handle}`}</div></div><span className="pill">{split ? `Receives ${r.pct || 0}%` : 'Receives the rewards'}</span></div>
                    : r.check ? <div className="note error" role="status">{r.check.reason}</div>
                    : signedInHandle ? <div className="muted small">Looking up {r.kind === 'github' ? r.handle : `@${r.handle}`} on {r.kind === 'github' ? 'GitHub' : 'X'}…</div>
                    : <div className="muted small">The account is checked when you sign in.</div>}
                </div>
              ))}
            </div>
            <div className="pf-split-foot">
              {rows.length < maxRecipients && <button type="button" className="btn ghost sm" onClick={addRow}>Add another recipient</button>}
              {split && <span className={`small ${pctTotal === 100 ? 'muted' : 'down'}`}>Total {pctTotal}%</span>}
            </div>
            <ShareBar parts={shareParts} />
            <div className="muted small pf-kind-notes">
              {split && <p>The rewards are split in these shares for the life of the token, at least {minPct}% each. You cannot name your own X account.</p>}
              {rows.some((r) => r.kind === 'x') && <p><strong>X accounts</strong> are paid to their X Money in dollars and never need to sign in here.</p>}
              {hasApp && <p><strong>Payment app</strong> accounts are paid in dollars in that app, through Peer: a buyer pays the account and gets our USDC only once Peer has verified the payment. Payouts start from 0.1 SOL and can take a day or two.</p>}
              {rows.some((r) => r.kind === 'paypal') && <p><strong>PayPal</strong> accounts must be connected with Peer once by their owner before they can be paid, on the token's page here. Until then their share waits safely.</p>}
              {rows.some((r) => r.kind === 'github') && <p><strong>GitHub accounts</strong> are paid by Pumpfun: the owner signs in on Pumpfun with GitHub and claims.</p>}
              {rows.some((r) => r.kind === 'charity') && <p><strong>Charities</strong> are paid by Pumpfun through Donate.gg, which delivers the donation.</p>}
              {native && <p>With a GitHub account or a charity, the shares are locked on Pumpfun itself at launch and nobody can change them.</p>}
            </div>
          </Section>

          <Section title="Developer buy" hint="Optional, in SOL. Buy your own token in the launch transaction itself, before anyone else can.">
            {buyOff ? <div className="note">{buyOff}</div> : (
              <>
                <div className="input-row ct-buy-row">
                  <input id="l-buy" inputMode="decimal" value={devBuy} placeholder="0.00" aria-label="Dev buy in SOL"
                    onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} />
                  <span className="muted">SOL</span>
                </div>
                <div className="ct-quick">
                  {QUICK_BUYS.map((q) => <button key={q} type="button" className={`chip ${devBuy === q ? 'on' : ''}`} onClick={() => setDevBuy(q)}>{q} SOL</button>)}
                  {wantsBuy && <button type="button" className="chip" onClick={() => setDevBuy('')}>None</button>}
                </div>
                {estimate && o && (
                  <div className="ct-buy-est">
                    <div><div className="muted tiny">You receive about</div><div className="amount sm">{tokensFmt(estimate.tokens)} ${symbol || 'tokens'}</div></div>
                    <div><div className="muted tiny">Share of supply</div><div className="amount sm">{estimate.pct.toFixed(2)}%</div></div>
                    <div><div className="muted tiny">From your wallet</div><div className="amount sm">{(buy + o.devBuy.extraSol).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL</div></div>
                  </div>
                )}
                {wantsBuy && (
                  <div className="ct-wallet-row">
                    <IWallet size={18} />
                    {w.address
                      ? <><div className="grow"><div className="small">Paying wallet</div><div className="mono muted small">{short(w.address, 6, 6)}</div></div><button type="button" className="btn ghost xs" onClick={() => w.disconnect()}>Disconnect</button></>
                      : <><div className="grow small muted">The dev buy is paid from your own wallet. It signs for the buy only.</div><button type="button" className="btn sm" onClick={() => setPicking(true)}>Connect wallet</button></>}
                  </div>
                )}
                <div className="muted tiny">Your wallet pays the buy plus about {o?.devBuy.extraSol ?? 0.005} SOL for its token account. The launch itself stays free.</div>
              </>
            )}
          </Section>
        </div>

        <aside className="launch-side">
          <div className="card pf-sign">
            <p className="pf-eyebrow pf-sign-title">What you are launching</p>
            <div className="pf-sign-row"><span>Token</span><span className="mono">{symbol ? `$${symbol}` : '-'}</span></div>
            <div className="pf-sign-row"><span>Launch cost</span><span className="mono">Free</span></div>
            <div className="pf-sign-row"><span>Venue</span><span>Pumpfun</span></div>
            <div className="pf-sign-row"><span>Address</span><span className="mono">…fund</span></div>
            {shareParts.length ? shareParts.map((p, i) => <div key={i} className="pf-sign-row"><span className="ct-trunc">{p.label}</span><span className="pf-sign-pill">{p.pct}%</span></div>)
              : <div className="pf-sign-row"><span>Recipients</span><span className="muted">Name who it funds</span></div>}
            <div className="pf-sign-row"><span>Paid by</span><span>{[...new Set(rows.map((r) => (r.kind === 'x' ? 'X Money' : isApp(r.kind) ? APPS[r.kind].label : 'Pumpfun')))].join(', ')}</span></div>
            <div className="pf-sign-row"><span>Developer buy</span><span className="mono">{wantsBuy && !buyOff ? `${devBuy} SOL` : 'None'}</span></div>
            <ShareBar parts={shareParts} />
          </div>
          <div className="card pf-sign-act">
            {!signedIn && !me.loading ? (
              <>
                <div className="muted">Sign in with X to launch.</div>
                <a href={signInUrl('/launch')} className="btn white block"><IX size={14} /> Sign in with X</a>
                <div className="muted tiny">Signing in only reads your public profile. It keeps launches to one real account at a time.</div>
              </>
            ) : (
              <button type="button" className="btn white block" disabled={busy || closed || !o || (problems.length > 0)} onClick={launch}>{label}</button>
            )}
            {phase.kind === 'busy' && phase.sub && <div className="note" role="status">{phase.sub}</div>}
            {phase.kind === 'error' && <div className="note error" role="alert">{phase.msg}</div>}
            {phase.kind === 'sent' && <div className="note" role="status">{phase.msg}{phase.signature && <> <Ext href={SOLSCAN('tx', phase.signature)} className="u">View the transaction</Ext></>}</div>}
            {opts.error && !o && <div className="note error">The launch form could not load: {opts.error}</div>}
          </div>
          {o && <div className="muted tiny ct-launch-rules">{o.limits.cooldownMinutes > 0 && `One launch every ${o.limits.cooldownMinutes} minutes per account. `}{o.limits.tickerHoldHours > 0 && `A ticker can be launched once every ${o.limits.tickerHoldHours} hours. `} Your X account needs {o.limits.minFollowers} followers and to be {o.limits.minAccountAgeDays} days old. Name, symbol, image and links are permanent once launched. <Link to="/docs#launch" className="u">How it works</Link></div>}
        </aside>
      </div>

      {picking && <WalletPicker w={w} onClose={() => setPicking(false)} />}
    </div>
  )
}

/** One group of the launch card: a plain heading, an optional hint, a rule above every group but the first. */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="pf-lsec">
      <div className="pf-lsec-head"><h2>{title}</h2>{hint && <div className="muted small">{hint}</div>}</div>
      {children}
    </section>
  )
}

/** The split as one dark bar (like ponscharity's "100% charity" bar): a segment per recipient. */
function ShareBar({ parts }: { parts: { label: string; pct: number }[] }) {
  if (!parts.length) return null
  return (
    <div className="pf-lbar" role="img" aria-label={parts.map((p) => `${p.pct}% ${p.label}`).join(', ')}>
      {parts.map((p, i) => <span key={i} className={`pf-lbar-seg s${i}`} style={{ width: `${p.pct}%` }}>{p.pct >= 18 ? `${p.pct}% ${p.label}` : `${p.pct}%`}</span>)}
    </div>
  )
}

/** Search Donate.gg's directory by name and pick one. A charity can only be chosen from the results, never typed in. */
function CharityPicker({ onPick }: { onPick: (c: Charity) => void }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<Charity[] | null>(null)
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setList(null); return }
    let live = true
    const t = setTimeout(() => api.charities(term).then((r) => { if (live) setList(r.charities) }).catch(() => { if (live) setList([]) }), 250)
    return () => { live = false; clearTimeout(t) }
  }, [q])
  return (
    <div className="lookup grow">
      <div className="input-row"><ISearch size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a charity by name" aria-label="Search a charity" spellCheck={false} /></div>
      {list && list.length > 0 && (
        <div className="lookup-list pf-charity-list">
          {list.map((c) => (
            <button type="button" key={c.id} className="palette-row pf-charity-row" onClick={() => onPick(c)}>
              <Avatar src={c.logo} size={30} label={c.name} round={false} /><span className="grow"><b>{c.name}</b>{c.place && <span className="muted small"> · {c.place}</span>}</span>
            </button>
          ))}
        </div>
      )}
      {list && list.length === 0 && <div className="muted small pf-charity-none">No charity by that name in the directory.</div>}
    </div>
  )
}

function WalletPicker({ w, onClose }: { w: ReturnType<typeof useWallet>; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const close = useCallback(() => onClose(), [onClose])
  const box = useModal<HTMLDivElement>(true, close)
  return (
    <div className="overlay" onClick={close}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h3 style={{ margin: 0 }}>Connect a wallet</h3><button type="button" className="icon-btn" aria-label="Close" onClick={close}><IClose /></button></div>
        {w.wallets.length ? (
          <div className="wallet-list">
            {w.wallets.map((x) => (
              <button type="button" key={x.name} className="wallet-row" onClick={() => w.connect(x).then(close).catch((e: Error) => setErr(/reject|denied|cancel|declin/i.test(e.message) ? 'You declined in your wallet.' : e.message))}>
                <img src={x.icon} alt="" width={28} height={28} /> <span>{x.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted small" style={{ margin: 0 }}>No Solana wallet was found in this browser. Install Phantom, Solflare or Backpack, or launch without a dev buy and buy once the token is live.</p>}
        <div className="muted tiny">The wallet pays for your dev buy only. Pump Fund pays for the launch.</div>
        {err && <div className="note error">{err}</div>}
      </div>
    </div>
  )
}
