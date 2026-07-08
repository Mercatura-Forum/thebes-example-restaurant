import { useRef, useState } from 'react'
import { useQuery, useUpdate, useMediaUpload } from '@thebes/sdk'
import {
  RESTAURANT_CID, M, decodeMenu, decodeOrders, decodeBookRows, addMenuItem, setItemAvailable,
  advanceOrder, seedDemo, addTable, seatReservation, completeReservation, cancelReservation,
  type MenuItem, type OrderRow, type ReservationRow,
} from '../lib/restaurant-api'
import { MEDIA_CID, fmtE8s, relTime } from '../lib/config'
import { MediaImage } from '../components/MediaImage'
import { Button, Spinner, ErrorNote, StatusPill } from '../components/ui'

const NEXT: Record<string, { method: 'startPreparingOrderOrTrap' | 'markOrderReadyOrTrap' | 'markDeliveredOrTrap'; label: string } | undefined> = {
  pending: { method: 'startPreparingOrderOrTrap', label: 'Start preparing' },
  preparing: { method: 'markOrderReadyOrTrap', label: 'Mark ready' },
  ready: { method: 'markDeliveredOrTrap', label: 'Mark delivered' },
}

export function Kitchen() {
  const { call } = useUpdate()
  const menu = useQuery<MenuItem[]>(RESTAURANT_CID, M.menu, undefined, decodeMenu)
  const queue = useQuery<OrderRow[]>(RESTAURANT_CID, M.kitchen, undefined, decodeOrders)
  const media = useMediaUpload(MEDIA_CID)
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [photoPath, setPhotoPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [err, setErr] = useState<string>()

  async function pickPhoto(file: File | undefined) {
    if (!file) return
    setErr(undefined)
    try { setPhotoPath((await media.upload(file, 'photo')).path) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function addDish() {
    setBusy(true); setErr(undefined)
    try {
      await addMenuItem(name.trim() || 'Dish', BigInt(Math.round(Number(price || '0') * 1e8)), photoPath)
      setName(''); setPrice(''); setPhotoPath(null)
      if (fileRef.current) fileRef.current.value = ''
      menu.refetch()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function claim() {
    setErr(undefined)
    try { await call(RESTAURANT_CID, 'claimOwner') } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function toggle(m: MenuItem) {
    setErr(undefined)
    try { await setItemAvailable(m.id, !m.available); menu.refetch() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function seed() {
    setSeeding(true); setErr(undefined)
    try { await seedDemo(); menu.refetch() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setSeeding(false) }
  }
  async function advance(o: OrderRow) {
    const next = NEXT[o.status]
    if (!next) return
    setErr(undefined)
    try { await advanceOrder(next.method, o.id); queue.refetch() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
      <section className="space-y-6">
        <div className="card p-4">
          <h2 className="font-display text-xl font-semibold">Kitchen</h2>
          <p className="mt-1 text-sm text-ink-soft">Claim the restaurant, add dishes, and move orders forward.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={claim}>Claim ownership</Button>
            <Button variant="ghost" onClick={seed} disabled={seeding}>{seeding ? 'Loading…' : 'Load demo menu'}</Button>
          </div>
        </div>

        <div className="card p-4">
          <h2 className="font-display text-xl font-semibold">Add a dish</h2>
          <div className="mt-3 flex items-center gap-4">
            <div className="w-28 shrink-0 overflow-hidden rounded-xl border border-[var(--color-line)]"><MediaImage path={photoPath ?? ''} alt="New dish" ratio="4 / 3" /></div>
            <div>
              <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickPhoto(e.target.files?.[0])}
                className="block text-sm file:mr-3 file:rounded-full file:border-0 file:bg-[var(--color-chili)] file:px-3 file:py-1.5 file:text-white" />
              {media.busy && <p className="mt-2 text-xs text-ink-soft nums">Uploading… {Math.round(media.progress * 100)}%</p>}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto] gap-3">
            <input className="rounded-lg border border-[var(--color-line)] bg-paper px-3 py-2 text-sm" placeholder="Dish name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="w-28 rounded-lg border border-[var(--color-line)] bg-paper px-3 py-2 text-sm nums" placeholder="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          {err && <div className="mt-3"><ErrorNote message={err} /></div>}
          <Button className="mt-3 w-full" onClick={addDish} disabled={busy || !name.trim() || !price}>{busy ? 'Adding…' : 'Add dish'}</Button>
        </div>

        <div className="card p-4">
          <h3 className="font-display text-lg font-semibold">Availability</h3>
          {menu.loading ? <div className="mt-2"><Spinner /></div> : menu.error ? <div className="mt-2"><ErrorNote message={menu.error} /></div> : menu.data && menu.data.length > 0 ? (
            <ul className="mt-2 divide-y divide-[var(--color-line)]">
              {menu.data.map((m) => (
                <li key={m.id.toString()} className="flex items-center justify-between py-2">
                  <span className="truncate text-sm">{m.name}</span>
                  <button onClick={() => toggle(m)}
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${m.available ? 'bg-[var(--color-chili)]/10 text-[var(--color-chili-ink)]' : 'bg-[var(--color-ink)]/8 text-ink-soft'}`}>
                    {m.available ? 'Available' : 'Sold out'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">No dishes yet — add one above, or load the demo menu.</p>
          )}
        </div>
      </section>

      <section className="space-y-8">
        <FloorDesk />
        <div>
        <h2 className="font-display text-xl font-semibold">Order queue</h2>
        {queue.loading ? <div className="mt-4"><Spinner /></div> : queue.error ? <div className="mt-4"><ErrorNote message={queue.error} /></div> : (
          <ul className="mt-4 space-y-3">
            {(queue.data ?? []).map((o) => (
              <li key={o.id.toString()} className="card flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="font-display text-lg font-semibold">Order #{o.id.toString()}</p>
                  <p className="text-xs text-ink-soft nums">{o.itemCount.toString()} items · ◈ {fmtE8s(o.totalAmount)} · {relTime(o.timestamp)}</p>
                  <div className="mt-1"><StatusPill status={o.status} /></div>
                </div>
                {NEXT[o.status] && <Button onClick={() => advance(o)}>{NEXT[o.status]!.label}</Button>}
              </li>
            ))}
            {queue.data?.length === 0 && <p className="text-sm text-ink-soft">No open orders. (Kitchen view is owner/staff-only.)</p>}
          </ul>
        )}
        </div>
      </section>
    </div>
  )
}

/** Floor desk: number new tables onto the floor, and work today's book —
 *  seat arriving parties, close no-shows, cancel on request. */
function FloorDesk() {
  const book = useQuery<ReservationRow[]>(RESTAURANT_CID, M.book, undefined, decodeBookRows)
  const [num, setNum] = useState('')
  const [seats, setSeats] = useState('4')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(undefined)
    try { await fn(); book.refetch() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const off = (r: ReservationRow) => BigInt(Date.now()) * 1_000_000n - r.nowNs
  const clock = (ns: bigint, r: ReservationRow) =>
    new Date(Number((ns + off(r)) / 1_000_000n)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="card p-4">
      <h2 className="font-display text-xl font-semibold">The floor desk</h2>
      <p className="mt-1 text-sm text-ink-soft">Number a new table onto the floor; work today's reservation book.</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-soft">Table #</span>
          <input className="inp w-20 nums" inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value)} placeholder="7" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-soft">Seats</span>
          <input className="inp w-20 nums" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} />
        </label>
        <Button onClick={() => run(() => addTable(Number(num), Number(seats)))} disabled={busy || !num || !seats}>
          Add table
        </Button>
      </div>
      {err && <div className="mt-3"><ErrorNote message={err} /></div>}

      <h3 className="font-display mt-5 text-lg font-semibold">The book</h3>
      {book.loading ? <div className="mt-2"><Spinner /></div> : (book.data ?? []).length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">No live bookings.</p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--color-line)]">
          {(book.data ?? []).map((r) => (
            <li key={r.id.toString()} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                <b>{r.guestName || 'Guest'}</b> · table {r.tableNumber.toString()} · party {r.partySize.toString()}
                <span className="text-ink-soft nums"> · {clock(r.startNs, r)}</span>
                {r.status === 'seated' && <span className="ml-1 text-[var(--color-chili-ink)]">(seated)</span>}
              </span>
              <span className="flex gap-1.5">
                {r.status === 'booked' && <Button className="px-2.5 py-1 text-xs" onClick={() => run(() => seatReservation(r.id))} disabled={busy}>Seat</Button>}
                {r.status === 'booked' && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => run(() => completeReservation(r.id, false))} disabled={busy}>No-show</Button>}
                {r.status === 'seated' && <Button className="px-2.5 py-1 text-xs" onClick={() => run(() => completeReservation(r.id, true))} disabled={busy}>Done</Button>}
                {r.status === 'booked' && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => run(() => cancelReservation(r.id))} disabled={busy}>Cancel</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
