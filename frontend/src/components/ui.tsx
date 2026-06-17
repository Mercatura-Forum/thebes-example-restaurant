import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { fmtE8s } from '../lib/config'

export function Price({ e8s, className = '' }: { e8s: bigint; className?: string }) {
  return <span className={`price ${className}`}><span aria-hidden className="opacity-50 text-[0.8em]">◈</span> {fmtE8s(e8s)}</span>
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }
export function Button({ variant = 'primary', className = '', ...props }: BtnProps) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed'
  const styles: Record<string, string> = {
    primary: 'bg-[var(--color-chili)] text-white hover:brightness-110 active:brightness-95',
    ghost: 'bg-transparent text-ink ring-1 ring-[var(--color-line)] hover:bg-[var(--color-paper)]',
  }
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-ink-soft text-sm" role="status">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-chili)]" />
      {label}…
    </div>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="card border-dashed p-10 text-center">
      <p className="font-display text-xl text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-soft">{hint}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-lg bg-[var(--color-chili)]/8 px-3 py-2 text-sm text-[var(--color-chili-ink)]">{message}</p>
}

const STAGES = ['pending', 'preparing', 'ready', 'delivered'] as const
export function StatusPill({ status }: { status: string }) {
  const at = Math.max(0, STAGES.indexOf(status as (typeof STAGES)[number]))
  const done = status === 'delivered'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${done ? 'bg-[var(--color-ink)]/8 text-ink-soft' : 'bg-[var(--color-chili)]/10 text-[var(--color-chili-ink)]'}`}>
      <span className="nums">{at + 1}/4</span> {status}
    </span>
  )
}
