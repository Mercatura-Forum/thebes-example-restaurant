import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import { RESTAURANT_CID, M, decodeMenu, placeOrder, type MenuItem } from '../lib/restaurant-api'
import { fmtE8s } from '../lib/config'
import { MediaImage } from '../components/MediaImage'
import { Price, Button, Spinner, EmptyState, ErrorNote } from '../components/ui'

export function Menu() {
  const nav = useNavigate()
  // /menu?t=3 = dine-in at table 3 (picked on the floor); no t = take-away.
  const [params] = useSearchParams()
  const tableNumber = Number(params.get('t') ?? '0') || 0
  const { data, loading, error } = useQuery<MenuItem[]>(RESTAURANT_CID, M.menu, undefined, decodeMenu)
  const [qty, setQty] = useState<Record<string, number>>({})
  const [placing, setPlacing] = useState(false)
  const [err, setErr] = useState<string>()

  const menu = data ?? []
  const bump = (id: bigint, d: number) => setQty((q) => ({ ...q, [id.toString()]: Math.max(0, (q[id.toString()] ?? 0) + d) }))

  const lines = useMemo(
    () => menu.filter((m) => (qty[m.id.toString()] ?? 0) > 0).map((m) => ({ item: m, qty: qty[m.id.toString()] })),
    [menu, qty],
  )
  const total = lines.reduce((acc, l) => acc + l.item.priceE8s * BigInt(l.qty), 0n)

  async function order() {
    setPlacing(true); setErr(undefined)
    try {
      const id = await placeOrder(lines.map((l) => ({ id: l.item.id, qty: l.qty })), tableNumber)
      setQty({})
      nav('/orders', { state: { placed: id.toString() } })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPlacing(false)
    }
  }

  if (loading) return <Spinner label="Loading the menu" />
  if (error) return <ErrorNote message={error} />
  if (menu.length === 0) return <EmptyState title="The menu is empty" hint="Add dishes with photos from the Kitchen tab." />

  return (
    <div className="pb-28">
      <h1 className="font-display text-4xl font-semibold">Tonight's menu</h1>
      <p className="mt-2 text-sm text-ink-soft">
        {tableNumber > 0 ? (
          <>Ordering for <b className="text-ink">table {tableNumber}</b> — the table is claimed the moment the order lands. <Link className="text-[var(--color-chili)] hover:underline" to="/menu">Switch to take-away</Link></>
        ) : (
          <>Take-away order — or <Link className="text-[var(--color-chili)] hover:underline" to="/">pick a table on the floor</Link> to dine in.</>
        )}
      </p>
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {menu.map((m) => {
          const n = qty[m.id.toString()] ?? 0
          return (
            <article key={m.id.toString()} className={`card overflow-hidden ${!m.available ? 'opacity-60' : ''}`}>
              <MediaImage path={m.photoPath} alt={m.name} ratio="4 / 3" />
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-display text-lg font-semibold leading-tight">{m.name}</p>
                  <Price e8s={m.priceE8s} />
                </div>
                <div className="mt-3">
                  {!m.available ? (
                    <span className="text-xs text-[var(--color-off)]">Sold out</span>
                  ) : n === 0 ? (
                    <Button variant="ghost" className="w-full" onClick={() => bump(m.id, 1)}>Add</Button>
                  ) : (
                    <div className="flex items-center justify-between rounded-full ring-1 ring-[var(--color-line)]">
                      <button className="px-4 py-1.5 text-lg" onClick={() => bump(m.id, -1)} aria-label="Less">−</button>
                      <span className="nums font-semibold">{n}</span>
                      <button className="px-4 py-1.5 text-lg" onClick={() => bump(m.id, 1)} aria-label="More">+</button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          )
        })}
      </div>

      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[var(--color-line)] bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
            <div className="text-sm">
              <span className="text-ink-soft">{lines.reduce((a, l) => a + l.qty, 0)} items · </span>
              <span className="price">◈ {fmtE8s(total)}</span>
            </div>
            <div className="flex items-center gap-3">
              {err && <ErrorNote message={err} />}
              <Button onClick={order} disabled={placing}>{placing ? 'Placing…' : 'Place order'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
