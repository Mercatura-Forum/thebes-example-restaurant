import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  reserveTable, seatReservation, completeReservation, cancelReservation, advanceOrder,
  setTablePosition,
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

/** Grid footprint by table size — mirrors the contract's footprint(). */
function footprintCells(seats: number): { fw: number; fh: number } {
  if (seats <= 4) return { fw: 2, fh: 2 }
  if (seats <= 6) return { fw: 3, fh: 2 }
  return { fw: 4, fh: 2 }
}

export function FloorView({
  tables, isKitchen, onChanged,
}: {
  tables: FloorTable[]
  isKitchen: boolean
  onChanged: () => void
}) {
  const [openTable, setOpenTable] = useState<bigint>()
  const [editing, setEditing] = useState(false)
  const [editErr, setEditErr] = useState<string>()
  const [drag, setDrag] = useState<{ number: bigint; seats: number } | undefined>(undefined)
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | undefined>(undefined)
  const gridRef = useRef<HTMLDivElement>(null)
  // chain→wall offset from the view's own nowNs
  const offsetNs = useMemo(() => {
    const now = tables[0]?.nowNs
    return now ? BigInt(Date.now()) * 1_000_000n - now : 0n
  }, [tables])

  const gridW = Number(tables[0]?.gridW ?? 12n)
  const gridH = Number(tables[0]?.gridH ?? 8n)
  const placed = tables.filter((t) => t.posX > 0n)
  const shelf = tables.filter((t) => t.posX === 0n)
  const usePlan = placed.length > 0 || editing

  const cellFrom = useCallback((clientX: number, clientY: number) => {
    const el = gridRef.current
    if (!el) return undefined
    const r = el.getBoundingClientRect()
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return undefined
    const x = Math.min(gridW, Math.max(1, Math.floor(((clientX - r.left) / r.width) * gridW) + 1))
    const y = Math.min(gridH, Math.max(1, Math.floor(((clientY - r.top) / r.height) * gridH) + 1))
    return { x, y }
  }, [gridW, gridH])

  // Drag lifecycle on the window, so drops land even with fast pointers.
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => setHoverCell(cellFrom(e.clientX, e.clientY))
    const up = async (e: PointerEvent) => {
      const cell = cellFrom(e.clientX, e.clientY)
      const d = drag
      setDrag(undefined)
      setHoverCell(undefined)
      if (!cell || !d) return
      try {
        setEditErr(undefined)
        await setTablePosition(d.number, cell.x, cell.y)
        onChanged()
      } catch (err) {
        setEditErr(err instanceof Error ? err.message : String(err))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [drag, cellFrom, onChanged])

  async function toShelf(number: bigint) {
    try {
      setEditErr(undefined)
      await setTablePosition(number, 0, 0)
      onChanged()
    } catch (err) {
      setEditErr(err instanceof Error ? err.message : String(err))
    }
  }

  const spot = (t: FloorTable, planPlaced: boolean, i: number) => {
    const seats = Number(t.seats)
    const { w, h, round } = tableShape(seats)
    const { fw, fh } = footprintCells(seats)
    const posStyle = planPlaced
      ? {
          position: 'absolute' as const,
          left: `${((Number(t.posX) - 1) / gridW) * 100}%`,
          top: `${((Number(t.posY) - 1) / gridH) * 100}%`,
          width: `${(fw / gridW) * 100}%`,
          height: `${(fh / gridH) * 100}%`,
          borderRadius: round,
        }
      : { width: w, height: h, borderRadius: round, animationDelay: `${i * 60}ms` }
    return (
      <button
        key={t.number.toString()}
        className={`table-spot ${planPlaced ? 'placed' : ''} ${editing ? 'editing' : ''}`}
        data-status={t.status}
        data-table={t.number.toString()}
        style={posStyle}
        onClick={() => { if (!editing) setOpenTable(openTable === t.number ? undefined : t.number) }}
        onPointerDown={(e) => { if (editing) { e.preventDefault(); setDrag({ number: t.number, seats }) } }}
        aria-label={`Table ${t.number}, ${seats} seats, ${STATUS_LABEL[t.status] ?? t.status}`}
      >
        {(planPlaced
          ? chairSpotsPct(seats)
          : chairSpots(seats, w, h).map((c) => ({ style: { left: c.x, top: c.y } }))
        ).map((c, j) => (
          <span key={j} className="chair" style={c.style} aria-hidden />
        ))}
        <span className="font-display text-2xl font-semibold">{t.number.toString()}</span>
        <span className="text-[10px] uppercase tracking-wide opacity-70">
          {t.status === 'reserved' ? (t.resSeated ? `${t.guestName} · seated` : `${t.guestName} · ${fmtClock(t.resStart, offsetNs)}`)
            : t.status === 'occupied' || t.status === 'ready' ? `order #${t.orderId.toString()}`
            : t.nextResAt > 0n ? `free · booked ${fmtClock(t.nextResAt, offsetNs)}`
            : `${seats} seats`}
        </span>
        {editing && t.posX > 0n && (
          <span
            role="button"
            className="shelve"
            title="Send back to the shelf"
            onClick={(e) => { e.stopPropagation(); toShelf(t.number) }}
            onPointerDown={(e) => e.stopPropagation()}
          >✕</span>
        )}
      </button>
    )
  }

  const ghost = editing && drag && hoverCell ? (() => {
    const { fw, fh } = footprintCells(drag.seats)
    const x = Math.min(hoverCell.x, gridW - fw + 1)
    const y = Math.min(hoverCell.y, gridH - fh + 1)
    return (
      <span className="ghost-cell" aria-hidden style={{
        left: `${((x - 1) / gridW) * 100}%`, top: `${((y - 1) / gridH) * 100}%`,
        width: `${(fw / gridW) * 100}%`, height: `${(fh / gridH) * 100}%`,
      }} />
    )
  })() : null

  const picked = tables.find((t) => t.number === openTable)

  return (
    <div>
      {isKitchen && (
        <div className="mb-3 flex items-center justify-end gap-3">
          {editErr && <span className="text-xs text-[var(--color-chili)]">{editErr}</span>}
          <Button variant={editing ? 'primary' : 'ghost'} onClick={() => { setEditing(!editing); setEditErr(undefined); setOpenTable(undefined) }}>
            {editing ? 'Done arranging' : 'Arrange the floor'}
          </Button>
        </div>
      )}

      {usePlan ? (
        <div>
          <div ref={gridRef} className={`floor-plan ${editing ? 'editing' : ''}`} style={{ aspectRatio: `${gridW} / ${gridH}` }}>
            {ghost}
            {placed.map((t, i) => spot(t, true, i))}
            {placed.length === 0 && !drag && (
              <p className="absolute inset-0 grid place-items-center text-sm text-ink-soft">
                Drag tables from the shelf onto the floor.
              </p>
            )}
          </div>
          {(shelf.length > 0 || editing) && (
            <div className="mt-4">
              <p className="mb-2 text-xs uppercase tracking-wide text-ink-soft">
                The shelf{editing ? ' — drag a table onto the floor plan' : ''}
              </p>
              <div className="flex flex-wrap items-end justify-start gap-8 rounded-2xl border border-dashed border-[var(--color-line)] p-5">
                {shelf.map((t, i) => spot(t, false, i))}
                {shelf.length === 0 && <p className="text-sm text-ink-soft">Every table is on the floor.</p>}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="floor rise">
          {tables.map((t, i) => spot(t, false, i))}
          {tables.length === 0 && (
            <p className="py-14 text-center text-sm text-ink-soft">
              The floor is bare — the kitchen adds tables (or loads the demo room).
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-ink-soft">
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="free" /> free</span>
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="reserved" /> reserved</span>
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="occupied" /> occupied</span>
        <span className="inline-flex items-center gap-1.5"><span className="legend" data-status="ready" /> order ready</span>
      </div>

      {picked && !editing && (
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

/** Chair pips in percentage space (for plan-placed tables of fluid size). */
function chairSpotsPct(seats: number): { style: Record<string, string | number> }[] {
  if (seats <= 2) return [
    { style: { left: -14, top: '50%', marginTop: -9 } },
    { style: { right: -14, top: '50%', marginTop: -9 } },
  ]
  const top = Math.ceil(seats / 2)
  const bottom = seats - top
  const out: { style: Record<string, string | number> }[] = []
  for (let i = 0; i < top; i++) out.push({ style: { left: `${((i + 1) * 100) / (top + 1)}%`, marginLeft: -9, top: -14 } })
  for (let i = 0; i < bottom; i++) out.push({ style: { left: `${((i + 1) * 100) / (bottom + 1)}%`, marginLeft: -9, bottom: -14 } })
  return out
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
