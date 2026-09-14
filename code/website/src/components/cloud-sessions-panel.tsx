// Dashboard panel showing cloud browser slots in a table.
// Shows all slots based on subscription quantity: active sessions fill some,
// remaining slots show as "Available". Fetches /api/cloud/status client-side
// and auto-refreshes every 10s.
'use client'

import { useEffect, useState } from 'react'

interface CloudSession {
  cloudSessionId: string
  browserUseSessionId: string
  index: number
  createdAt: number
  status: 'active' | 'stopped'
  cdpUrl: string | null
  liveUrl: string | null
  timeoutAt: string
}

function formatDuration(startMs: number): string {
  const diffMs = Date.now() - startMs
  const totalMinutes = Math.floor(diffMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

function formatRelativeTime(isoString: string): string {
  const target = new Date(isoString).getTime()
  const diffMs = target - Date.now()
  if (diffMs <= 0) return 'expired'
  const totalMinutes = Math.floor(diffMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m left`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m left`
}

/** Build the full slot list: active sessions placed at their index, empty slots fill the rest.
 *  If a session exists above totalSlots (e.g. user downgraded), still render it. */
function buildSlotRows({ sessions, totalSlots }: { sessions: CloudSession[]; totalSlots: number }): Array<{ index: number; session: CloudSession | null }> {
  const slotMap = new Map<number, CloudSession>()
  for (const s of sessions) {
    slotMap.set(s.index, s)
  }
  const maxSessionIndex = sessions.reduce((max, s) => {
    return Math.max(max, s.index)
  }, 0)
  const rowCount = Math.max(totalSlots, maxSessionIndex)
  return Array.from({ length: rowCount }, (_, i) => {
    const index = i + 1
    return { index, session: slotMap.get(index) ?? null }
  })
}

export function CloudSessionsPanel({ totalSlots }: { totalSlots: number }) {
  const [sessions, setSessions] = useState<CloudSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchSessions = async () => {
      try {
        const res = await fetch('/api/cloud/status')
        if (!res.ok) {
          if (res.status === 401) {
            if (!cancelled) {
              setSessions([])
              setError(null)
            }
            return
          }
          throw new Error(`${res.status}`)
        }
        const data = await res.json() as { sessions: CloudSession[] }
        if (!cancelled) {
          setSessions(data.sessions)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchSessions()
    const interval = setInterval(fetchSessions, 10_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Force re-render every 30s to keep duration/expiry text current
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => {
        return t + 1
      })
    }, 30_000)
    return () => {
      clearInterval(timer)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex w-full flex-col gap-4 rounded-xl border border-border bg-background p-6">
        <h2 className="text-base font-semibold">Browsers</h2>
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex w-full flex-col gap-4 rounded-xl border border-border bg-background p-6">
        <h2 className="text-base font-semibold">Browsers</h2>
        <div className="text-sm text-muted-foreground">Could not load sessions.</div>
      </div>
    )
  }

  const slots = buildSlotRows({ sessions, totalSlots })

  return (
    <div className="flex w-full flex-col gap-4 rounded-xl border border-border bg-background p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Browsers</h2>
        <span className="text-xs text-muted-foreground">
          {sessions.length}/{totalSlots} active
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 pr-4 font-medium">#</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">Duration</th>
              <th className="pb-2 pr-4 font-medium">Expires</th>
              <th className="pb-2 font-medium">Live</th>
            </tr>
          </thead>
          <tbody>
            {slots.map(({ index, session: s }) => {
              return (
                <tr key={index} className="border-b border-border/50 last:border-b-0">
                  <td className="py-2.5 pr-4 font-mono text-xs">cloud-{index}</td>
                  <td className="py-2.5 pr-4">
                    {s ? (
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className="size-1.5 rounded-full bg-green-500" />
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="size-1.5 rounded-full bg-neutral-400" />
                        Available
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                    {s ? formatDuration(s.createdAt) : '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                    {s ? formatRelativeTime(s.timeoutAt) : '—'}
                  </td>
                  <td className="py-2.5">
                    {s?.status === 'active' && s.liveUrl ? (
                      <a
                        href={s.liveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Watch live
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
