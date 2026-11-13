import { useEffect, useState } from 'react'

export type Loaded<T> = { data: T | undefined; error: string | null; loading: boolean; status?: number; reload: () => void }

/** Loads `fn` whenever `deps` change (and every `everyMs` if given); ignores answers that arrive after a newer request. */
export function useData<T>(fn: () => Promise<T>, deps: unknown[], everyMs = 0): Loaded<T> {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<Omit<Loaded<T>, 'reload'>>({ data: undefined, error: null, loading: true })
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false, status: (e as { status?: number }).status })),
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  useEffect(() => {
    if (!everyMs) return
    const t = setInterval(() => setTick((n) => n + 1), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return { ...state, reload: () => setTick((n) => n + 1) }
}
