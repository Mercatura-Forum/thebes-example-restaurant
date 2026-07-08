import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  reserveTable, seatReservation, completeReservation, cancelReservation, advanceOrder,
  type FloorTable,
} from '../lib/restaurant-api'
import { Button, ErrorNote } from './ui'

/**
 * The floor — the restaurant drawn live from chain state. Every table renders
 * its DERIVED status (free / reserved / occupied / ready), the chairs match
 * its seat count, and clicking a table opens the right action for who you are:
 * guests book free tables; the kitchen seats parties, advances orders and
 * frees tables. The floor cannot lie: it is a query over the allocation laws.
 */

const STATUS_LABEL: Record<string, string> = {
  free: 'free', reserved: 'reserved', occupied: 'occupied', ready: 'order ready',
}

function tableShape(seats: number): { w: number; h: number; round: string } {
  if (seats <= 2) return { w: 84, h: 84, round: '999px' }
  if (seats <= 4) return { w: 104, h: 104, round: '20px' }
  if (seats <= 6) return { w: 150, h: 96, round: '22px' }
  return { w: 184, h: 96, round: '22px' }
}

/** Chair pips around the table: half along the top edge, half along the bottom
 *  (2-seaters sit face to face, left/right). */
function chairSpots(seats: number, w: number, h: number): { x: number; y: number }[] {
  if (seats <= 2) return [{ x: -14, y: h / 2 - 9 }, { x: w - 4, y: h / 2 - 9 }]
  const top = Math.ceil(seats / 2)
  const bottom = seats - top
  const spots: { x: number; y: number }[] = []
  for (let i = 0; i < top; i++) spots.push({ x: ((i + 1) * w) / (top + 1) - 9, y: -14 })
  for (let i = 0; i < bottom; i++) spots.push({ x: ((i + 1) * w) / (bottom + 1) - 9, y: h - 4 })
  return spots
}

function fmtClock(ns: bigint, offsetNs: bigint): string {
  const ms = Number((ns + offsetNs) / 1_000_000n)
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function FloorView({
  tables, isKitchen, onChanged,
}: {
  tables: FloorTable[]
  isKitchen: boolean
  onChanged: () => void
}) {
  const [openTable, setOpenTable] = useState<bigint>()
  // chain→wall offset from the view's own nowNs
  const offsetNs = useMemo(() => {
    const now = tables[0]?.nowNs
    return now ? BigInt(Date.now()) * 1_000_000n - now : 0n
  }, [tables])

  const picked = tables.find((t) => t.number === openTable)

  return (
    <div>
      <div className="floor rise">
        {tables.map((t, i) => {
          const seats = Number(t.seats)
          const { w, h, round } = tableShape(seats)
          return (
            <button
              key={t.number.toString()}
              className="table-spot"
              data-status={t.status}
              style={{ width: w, height: h, borderRadius: round, animationDelay: `${i * 60}ms` }}
              onClick={() => setOpenTable(openTable === t.number ? undefined : t.number)}
              aria-label={`Table ${t.number}, ${seats} seats, ${STATUS_LABEL[t.status] ?? t.status}`}
            >
              {chairSpots(seats, w, h).map((c, j) => (
                <span key={j} className="chair" style={{ left: c.x, top: c.y }} aria-hidden />
              ))}
              <span className="font-display text-2xl font-semibold">{t.number.toString()}</span>
              <span className="text-[10px] uppercase tracking-wide opacity-70">
                {t.status === 'reserved' ? (t.resSeated ? `${t.guestName} · seated` : `${t.guestName} · ${fmtClock(t.resStart, offsetNs)}`)
                  : t.status === 'occupied' || t.status === 'ready' ? `order #${t.orderId.toString()}`
                  : t.nextResAt > 0n ? `free · booked ${fmtClock(t.nextResAt, offsetNs)}`
                  : `${seats} seats`}
              </span>
            </button>
          )
        })}
        {tables.length === 0 && (
          <p className="py-14 text-center text-sm text-ink-soft">
            The floor is bare — the kitchen adds tables (or loads the demo room).
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-ink-soft">
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="free" /> free</span>
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="reserved" /> reserved</span>
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="occupied" /> occupied</span>
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="ready" /> order ready</span>
      </div>

      {picked && (
        <TableSheet
          t={picked}
          isKitchen={isKitchen}
          offsetNs={offsetNs}
          onClose={() => setOpenTable(undefined)}
          onChanged={() => { setOpenTable(undefined); onChanged() }}
        />
      )}
    </div>
  )
}

/** The action sheet for one table — books, seats, advances, frees. */
function TableSheet({ t, isKitchen, offsetNs, onClose, onChanged }: {
  t: FloorTable; isKitchen: boolean; offsetNs: bigint; onClose: () => void; onChanged: () => void
}) {
  const nav = useNavigate()
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [party, setParty] = useState(2)
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 30 * 60_000)
    d.setMinutes(d.getMinutes() - (d.getMinutes() % 15), 0, 0)
    return d.toISOString().slice(0, 16)
  })
  const [hours, setHours] = useState(2)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(undefined)
    try { await fn(); onChanged() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function book() {
    const startWall = new Date(when).getTime()
    const startNs = BigInt(startWall) * 1_000_000n - offsetNs
    const endNs = startNs + BigInt(Math.round(hours * 3600)) * 1_000_000_000n
    await run(() => reserveTable(name.trim() || 'Guest', t.number, party, startNs, endNs))
  }

  return (
    <div className="card rise mx-auto mt-4 max-w-lg p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-xl">Table {t.number.toString()} <span className="text-sm text-ink-soft">· {t.seats.toString()} seats · {STATUS_LABEL[t.status]}</span></h3>
        <button className="text-sm text-ink-soft hover:text-ink" onClick={onClose}>close</button>
      </div>

      {err && <div className="mt-3"><ErrorNote message={err} /></div>}

      {t.status === 'free' && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-ink-soft">Book this table — the contract rejects any overlap, so a confirmed booking is yours.</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Name for the booking</span>
              <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Guest name" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Party of</span>
              <input className="inp nums" type="number" min={1} max={Number(t.seats)} value={party}
                onChange={(e) => setParty(Math.max(1, Math.min(Number(t.seats), Number(e.target.value) || 1)))} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">From</span>
              <input className="inp" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">For</span>
              <select className="inp" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                <option value={1}>1 hour</option><option value={1.5}>1½ hours</option>
                <option value={2}>2 hours</option><option value={3}>3 hours</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => nav(`/?t=${t.number}`)}>Order here now</Button>
            <Button onClick={book} disabled={busy}>{busy ? 'Booking…' : 'Book this table'}</Button>
          </div>
        </div>
      )}

      {t.status === 'reserved' && (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            {t.resSeated ? <b>{t.guestName}'s party is seated.</b> : <><b>{t.guestName}</b> holds this table {fmtClock(t.resStart, offsetNs)}–{fmtClock(t.resEnd, offsetNs)} (party of {t.partySize.toString()}).</>}
          </p>
          {isKitchen && (
            <div className="flex flex-wrap justify-end gap-2">
              {!t.resSeated && <Button onClick={() => run(() => seatReservation(t.reservationId))} disabled={busy}>Seat the party</Button>}
              {!t.resSeated && <Button variant="ghost" onClick={() => run(() => completeReservation(t.reservationId, false))} disabled={busy}>No-show</Button>}
              {t.resSeated && <Button onClick={() => run(() => completeReservation(t.reservationId, true))} disabled={busy}>Party left — free the table</Button>}
              <Button variant="ghost" onClick={() => run(() => cancelReservation(t.reservationId))} disabled={busy}>Cancel booking</Button>
            </div>
          )}
        </div>
      )}

      {(t.status === 'occupied' || t.status === 'ready') && (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            Order <b>#{t.orderId.toString()}</b> is {t.orderStatus} here{t.orderIsMine ? ' — it\'s yours' : ''}.
          </p>
          {isKitchen && (
            <div className="flex flex-wrap justify-end gap-2">
              {t.orderStatus === 'pending' && <Button onClick={() => run(() => advanceOrder('startPreparingOrderOrTrap', t.orderId))} disabled={busy}>Start preparing</Button>}
              {t.orderStatus === 'preparing' && <Button onClick={() => run(() => advanceOrder('markOrderReadyOrTrap', t.orderId))} disabled={busy}>Mark ready</Button>}
              {t.orderStatus === 'ready' && <Button onClick={() => run(() => advanceOrder('markDeliveredOrTrap', t.orderId))} disabled={busy}>Delivered — free the table</Button>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
