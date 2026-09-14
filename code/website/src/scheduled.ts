// Cron handler that enforces per-org proxy and browser spend budgets.
// Runs every minute. Does 1 D1 read + 1 batch write per invocation.
//
// Flow:
//   1. Single query: all active cloud_session rows with org spend/budget
//   2. Parallel Browser Use API calls to read costs per session
//   3. Compute deltas (current cost - last known cost) for proxy and browser separately
//   4. Single batch write: update session costs + org cumulative spend
//   5. If any org exceeds budget or has no subscription: stop VMs + delete rows
//
// Budget resets each billing period: when subscription.currentPeriodStart
// changes (new month), both spend counters reset to 0.
//
// Proxy and browser costs are tracked separately so each has its own budget.

import { env } from 'cloudflare:workers'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { getDb } from './db.ts'
import { BrowserUseClient, BrowserUseApiError } from './lib/browser-use.ts'
import { ACTIVE_SUBSCRIPTION_STATUSES } from './lib/billing-rules.ts'

function getBrowserUse() {
  return new BrowserUseClient({ apiKey: env.BROWSER_USE_API_KEY as string })
}

/** Parse Browser Use cost string (e.g. "0.05") to integer cents. */
function parseCostToCents(cost: string): number {
  const parsed = parseFloat(cost)
  if (Number.isNaN(parsed)) return 0
  return Math.round(parsed * 100)
}

export async function enforceProxyBudgets(): Promise<void> {
  const db = getDb()
  const bu = getBrowserUse()

  // 1. Single D1 read: all cloud sessions joined with org + subscription data.
  //    LEFT JOIN subscription so we can detect orgs without active subscriptions.
  //    Skip pending placeholder rows (they have no real BU VM yet).
  const rows = await db
    .select({
      session: schema.cloudSession,
      orgId: schema.org.id,
      proxySpendCents: schema.org.proxySpendCents,
      proxyBudgetCents: schema.org.proxyBudgetCents,
      browserSpendCents: schema.org.browserSpendCents,
      browserBudgetCents: schema.org.browserBudgetCents,
      spendPeriodStart: schema.org.spendPeriodStart,
      subscriptionPeriodStart: schema.subscription.currentPeriodStart,
      subscriptionStatus: schema.subscription.status,
    })
    .from(schema.cloudSession)
    .innerJoin(schema.org, orm.eq(schema.cloudSession.orgId, schema.org.id))
    .leftJoin(schema.subscription, orm.and(
      orm.eq(schema.subscription.orgId, schema.org.id),
      orm.inArray(schema.subscription.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
    ))
    .where(
      // Skip pending placeholder rows (they have no real BU VM yet)
      orm.not(orm.like(schema.cloudSession.browserUseSessionId, 'pending-%')),
    )

  if (rows.length === 0) return

  // 2. Parallel BU API calls to get current costs per session.
  //    Use allSettled so one failure doesn't block the rest.
  const buResults = await Promise.allSettled(
    rows.map((row) => {
      return bu.getBrowser(row.session.browserUseSessionId)
    }),
  )

  // 3. Compute per-session deltas and group by org.
  const orgDeltas = new Map<string, {
    proxyDeltaCents: number
    browserDeltaCents: number
    proxySpendCents: number
    proxyBudgetCents: number
    browserSpendCents: number
    browserBudgetCents: number
    spendPeriodStart: number | null
    subscriptionPeriodStart: number | null
    hasActiveSubscription: boolean
    sessionUpdates: Array<{
      id: string
      buSessionId: string
      newProxyCostCents: number
      prevProxyCostCents: number
      newBrowserCostCents: number
      prevBrowserCostCents: number
    }>
    killSessionIds: string[]
  }>()

  const deadSessionIds: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const result = buResults[i]!

    // BU API failed. Treat 404 and 400 (malformed ID) as dead.
    // Transient errors (500, rate limit, network) leave the row intact
    // so the next cron tick can retry.
    if (result.status === 'rejected') {
      const err = result.reason
      if (err instanceof BrowserUseApiError && (err.status === 404 || err.status === 400)) {
        deadSessionIds.push(row.session.id)
      }
      continue
    }

    // Parse costs even for stopped VMs so we capture the final spend
    // between the last cron tick and when the session ended.
    const vm = result.value
    const currentProxyCents = parseCostToCents(vm.proxyCost)
    const currentBrowserCents = parseCostToCents(vm.browserCost)
    const proxyDelta = Math.max(0, currentProxyCents - row.session.lastProxyCostCents)
    const browserDelta = Math.max(0, currentBrowserCents - row.session.lastBrowserCostCents)

    if (vm.status !== 'active') {
      deadSessionIds.push(row.session.id)
    }

    let orgEntry = orgDeltas.get(row.orgId)
    if (!orgEntry) {
      orgEntry = {
        proxyDeltaCents: 0,
        browserDeltaCents: 0,
        proxySpendCents: row.proxySpendCents,
        proxyBudgetCents: row.proxyBudgetCents,
        browserSpendCents: row.browserSpendCents,
        browserBudgetCents: row.browserBudgetCents,
        spendPeriodStart: row.spendPeriodStart,
        subscriptionPeriodStart: row.subscriptionPeriodStart,
        hasActiveSubscription: row.subscriptionStatus != null,
        sessionUpdates: [],
        killSessionIds: [],
      }
      orgDeltas.set(row.orgId, orgEntry)
    }

    orgEntry.proxyDeltaCents += proxyDelta
    orgEntry.browserDeltaCents += browserDelta
    orgEntry.sessionUpdates.push({
      id: row.session.id,
      buSessionId: row.session.browserUseSessionId,
      newProxyCostCents: currentProxyCents,
      prevProxyCostCents: row.session.lastProxyCostCents,
      newBrowserCostCents: currentBrowserCents,
      prevBrowserCostCents: row.session.lastBrowserCostCents,
    })
  }

  // 4. Build batch writes: update session costs + org spend.
  //    Detect orgs over budget or without subscription and queue termination.
  //
  //    Uses atomic SQL increments for org spend to avoid race conditions
  //    if two cron invocations overlap. The session baseline update uses a
  //    conditional WHERE to prevent double-counting: if another invocation
  //    already advanced the baseline, our update is a no-op.
  const statements: Parameters<typeof db.batch>[0] = []

  for (const [orgId, entry] of orgDeltas) {
    // Detect billing period rollover: if the subscription's currentPeriodStart
    // differs from the org's stored spendPeriodStart, a new billing cycle
    // started. Reset cumulative spend to 0 and start fresh.
    const periodRolledOver = entry.subscriptionPeriodStart != null
      && entry.spendPeriodStart !== entry.subscriptionPeriodStart

    if (periodRolledOver) {
      // Reset both spend counters for new billing period, then add this tick's deltas
      statements.push(
        db.update(schema.org)
          .set({
            proxySpendCents: entry.proxyDeltaCents,
            browserSpendCents: entry.browserDeltaCents,
            spendPeriodStart: entry.subscriptionPeriodStart,
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.org.id, orgId)),
      )
    } else {
      // Atomic increments: safe against overlapping cron invocations.
      const setFields: Record<string, unknown> = { updatedAt: Date.now() }
      if (entry.proxyDeltaCents > 0) {
        setFields.proxySpendCents = orm.sql`${schema.org.proxySpendCents} + ${entry.proxyDeltaCents}`
      }
      if (entry.browserDeltaCents > 0) {
        setFields.browserSpendCents = orm.sql`${schema.org.browserSpendCents} + ${entry.browserDeltaCents}`
      }
      if (entry.proxyDeltaCents > 0 || entry.browserDeltaCents > 0) {
        statements.push(
          db.update(schema.org)
            .set(setFields)
            .where(orm.eq(schema.org.id, orgId)),
        )
      }
    }

    // Conditionally update session baselines: only advance if the baseline
    // hasn't already been updated by a concurrent cron run. The WHERE clause
    // on both previous values ensures we don't overwrite values that another
    // invocation already advanced.
    for (const su of entry.sessionUpdates) {
      statements.push(
        db.update(schema.cloudSession)
          .set({
            lastProxyCostCents: su.newProxyCostCents,
            lastBrowserCostCents: su.newBrowserCostCents,
          })
          .where(orm.and(
            orm.eq(schema.cloudSession.id, su.id),
            orm.eq(schema.cloudSession.lastProxyCostCents, su.prevProxyCostCents),
            orm.eq(schema.cloudSession.lastBrowserCostCents, su.prevBrowserCostCents),
          )),
      )
    }

    // Kill sessions if org has no active subscription (cancelled/expired)
    if (!entry.hasActiveSubscription) {
      for (const su of entry.sessionUpdates) {
        entry.killSessionIds.push(su.id)
      }
      continue
    }

    // Kill sessions if org exceeded either budget. For overlapping cron
    // safety we read the pessimistic value: current DB spend + our delta.
    const estimatedProxySpend = periodRolledOver
      ? entry.proxyDeltaCents
      : entry.proxySpendCents + entry.proxyDeltaCents
    const estimatedBrowserSpend = periodRolledOver
      ? entry.browserDeltaCents
      : entry.browserSpendCents + entry.browserDeltaCents
    if (estimatedProxySpend >= entry.proxyBudgetCents || estimatedBrowserSpend >= entry.browserBudgetCents) {
      for (const su of entry.sessionUpdates) {
        entry.killSessionIds.push(su.id)
      }
    }
  }

  // Clean up dead sessions discovered during BU API checks
  if (deadSessionIds.length > 0) {
    statements.push(
      db.delete(schema.cloudSession)
        .where(orm.inArray(schema.cloudSession.id, deadSessionIds)),
    )
  }

  // 5. Execute all D1 writes in one batch call (minimizes D1 round trips).
  if (statements.length > 0) {
    await db.batch(statements as [typeof statements[0], ...typeof statements])
  }

  // 6. Kill VMs for over-budget or subscription-less orgs. Done after D1
  //    writes so the spend is recorded even if the stop calls fail.
  const killPromises: Promise<unknown>[] = []
  const killSessionIds: string[] = []

  for (const [, entry] of orgDeltas) {
    if (entry.killSessionIds.length === 0) continue
    killSessionIds.push(...entry.killSessionIds)
    for (const su of entry.sessionUpdates) {
      killPromises.push(
        bu.stopBrowser(su.buSessionId).catch(() => {
          // VM might already be stopped
        }),
      )
    }
  }

  // Wait for all stop calls, then delete the session rows
  if (killPromises.length > 0) {
    await Promise.allSettled(killPromises)
  }
  if (killSessionIds.length > 0) {
    await db.delete(schema.cloudSession)
      .where(orm.inArray(schema.cloudSession.id, killSessionIds))
  }
}
