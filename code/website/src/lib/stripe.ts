// Stripe helpers: client construction, customer management, price lookup, and
// the subscription webhook handler that mirrors Stripe state into D1.
//
// One Stripe customer per org (org.stripeCustomerId). The subscription quantity
// determines max concurrent cloud browser sessions. getOrCreateStripeCustomer is
// the ONLY place that creates Stripe customers — never call
// stripe.customers.create anywhere else.

import Stripe from 'stripe'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { env } from 'cloudflare:workers'
import { getDb } from '../db.ts'
import { CLOUD_PRICE_LOOKUP_KEYS, type BillingInterval } from './billing-rules.ts'

// ── Stripe client ───────────────────────────────────────────────────

export function getStripe(): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY as string, {
    httpClient: Stripe.createFetchHttpClient(),
  })
}

// ── Customer management ─────────────────────────────────────────────

/** Get or create the Stripe customer for an org. Idempotent and the single
 *  source of truth — never call stripe.customers.create anywhere else. Writes
 *  metadata.orgId so webhooks can always resolve the org from the customer.
 *  Pass stripeCustomerId from ensureOrg to skip the D1 re-read when the org
 *  already has a Stripe customer. If null/undefined, always re-reads D1 to
 *  avoid concurrent requests creating duplicate Stripe customers. */
export async function getOrCreateStripeCustomer({
  orgId,
  email,
  stripeCustomerId,
}: {
  orgId: string
  email: string | null | undefined
  /** Pre-fetched from ensureOrg. When truthy, skips the D1 read. When null
   *  or undefined, always re-reads the org to get the freshest value. */
  stripeCustomerId?: string | null
}): Promise<string | Error> {
  // Only skip D1 when we already have a known Stripe customer. If the caller
  // passed null, re-read because another concurrent request may have created
  // the customer between when ensureOrg ran and now.
  if (stripeCustomerId) return stripeCustomerId

  const db = getDb()
  const org = await db.query.org.findFirst({ where: { id: orgId } })
  if (!org) return new Error(`Org ${orgId} not found`)
  if (org.stripeCustomerId) return org.stripeCustomerId

  const stripe = getStripe()
  let customer: Stripe.Customer
  try {
    customer = await stripe.customers.create({
      email: email || undefined,
      metadata: { orgId },
    })
  } catch (cause) {
    return new Error('Failed to create Stripe customer', { cause })
  }

  try {
    await db
      .update(schema.org)
      .set({ stripeCustomerId: customer.id, updatedAt: Date.now() })
      .where(orm.eq(schema.org.id, orgId))
      .limit(1)
  } catch (cause) {
    return new Error('Failed to save Stripe customer ID', { cause })
  }

  return customer.id
}

// ── Price lookup ────────────────────────────────────────────────────

export type CloudPrice = {
  interval: BillingInterval
  priceId: string
  productId: string
  unitAmount: number | null
  currency: string
}

/** Fetch cloud browser prices by lookup key. References stable lookup keys
 *  rather than hardcoded price ids so prices can be rotated without redeploys. */
export async function getCloudPrices(): Promise<CloudPrice[] | Error> {
  const stripe = getStripe()
  const lookupKeys = Object.values(CLOUD_PRICE_LOOKUP_KEYS)
  let list: Stripe.ApiList<Stripe.Price>
  try {
    list = await stripe.prices.list({
      lookup_keys: lookupKeys,
      active: true,
      expand: ['data.product'],
    })
  } catch (cause) {
    return new Error('Failed to fetch prices from Stripe', { cause })
  }

  const byLookup = new Map(list.data.map((p) => {
    return [p.lookup_key, p]
  }))

  const prices: CloudPrice[] = []
  for (const interval of Object.keys(CLOUD_PRICE_LOOKUP_KEYS) as BillingInterval[]) {
    const price = byLookup.get(CLOUD_PRICE_LOOKUP_KEYS[interval])
    if (!price) {
      return new Error(`No Stripe price found for lookup key ${CLOUD_PRICE_LOOKUP_KEYS[interval]}`)
    }
    prices.push({
      interval,
      priceId: price.id,
      productId: typeof price.product === 'string' ? price.product : price.product.id,
      unitAmount: price.unit_amount,
      currency: price.currency,
    })
  }
  return prices
}

export async function getCloudPriceId(interval: BillingInterval): Promise<string | Error> {
  const prices = await getCloudPrices()
  if (prices instanceof Error) return prices
  const match = prices.find((p) => {
    return p.interval === interval
  })
  if (!match) {
    return new Error(`No Stripe price found for lookup key ${CLOUD_PRICE_LOOKUP_KEYS[interval]}`)
  }
  return match.priceId
}

const EXISTING_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'incomplete',
])

export async function hasExistingStripeSubscription(customerId: string): Promise<boolean | Error> {
  const stripe = getStripe()
  let subscriptions: Stripe.ApiList<Stripe.Subscription>
  try {
    subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    })
  } catch (cause) {
    return new Error('Failed to list Stripe subscriptions', { cause })
  }
  return subscriptions.data.some((subscription) => {
    return EXISTING_SUBSCRIPTION_STATUSES.has(subscription.status)
  })
}

// ── Webhook handler: mirror subscription state into D1 ──────────────

/** Re-fetch the latest subscription from Stripe, resolve its orgId, and upsert
 *  the local subscription row. Idempotent on subscriptionId so at-least-once
 *  webhook delivery is safe. */
export async function handleSubscriptionChange(
  sub: Stripe.Subscription,
): Promise<Error | null> {
  const stripe = getStripe()

  let latest: Stripe.Subscription
  try {
    latest = await stripe.subscriptions.retrieve(sub.id)
  } catch (cause) {
    return new Error('Failed to retrieve subscription from Stripe', { cause })
  }

  const orgId = await resolveOrgId({
    metadataOrgId: latest.metadata?.orgId,
    customerId: typeof latest.customer === 'string' ? latest.customer : null,
  })
  if (!orgId) {
    console.warn(`Could not resolve orgId for subscription ${latest.id}`)
    return null
  }

  const firstItem = latest.items.data[0]
  if (!firstItem) {
    return new Error(`No items in subscription ${latest.id}`)
  }

  const db = getDb()
  const record = {
    subscriptionId: latest.id,
    orgId,
    customerId: typeof latest.customer === 'string' ? latest.customer : null,
    priceId: firstItem.price.id,
    productId: typeof firstItem.price.product === 'string'
      ? firstItem.price.product
      : firstItem.price.product.id,
    status: latest.status,
    quantity: firstItem.quantity ?? 1,
    planName: firstItem.price.nickname ?? null,
    currentPeriodStart: latest.current_period_start * 1000,
    currentPeriodEnd: latest.current_period_end * 1000,
    cancelAtPeriodEnd: latest.cancel_at_period_end,
    updatedAt: Date.now(),
  }

  try {
    await db
      .insert(schema.subscription)
      .values({ ...record, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: schema.subscription.subscriptionId,
        set: record,
      })
  } catch (cause) {
    return new Error('Failed to upsert subscription', { cause })
  }

  return null
}

/** Resolve orgId from subscription metadata or Stripe customer metadata.
 *  When both metadataOrgId and customerId are available, batches the two
 *  D1 lookups into one round-trip. */
async function resolveOrgId({
  metadataOrgId,
  customerId,
}: {
  metadataOrgId: string | undefined
  customerId: string | null
}): Promise<string | null> {
  const db = getDb()

  // Batch both lookups when we have both identifiers (common case).
  if (metadataOrgId && customerId) {
    const [byId, byCustomer] = await db.batch([
      db.query.org.findFirst({ where: { id: metadataOrgId } }),
      db.query.org.findFirst({ where: { stripeCustomerId: customerId } }),
    ] as const)
    if (byId) return byId.id
    if (byCustomer) return byCustomer.id
  } else if (metadataOrgId) {
    const org = await db.query.org.findFirst({ where: { id: metadataOrgId } })
    if (org) return org.id
  } else if (customerId) {
    const org = await db.query.org.findFirst({ where: { stripeCustomerId: customerId } })
    if (org) return org.id
  }

  // Last resort: check Stripe customer metadata.orgId
  if (customerId) {
    try {
      const stripe = getStripe()
      const customer = await stripe.customers.retrieve(customerId)
      if (!customer.deleted && customer.metadata?.orgId) {
        const org = await db.query.org.findFirst({
          where: { id: customer.metadata.orgId },
        })
        if (org) return org.id
      }
    } catch {
      // Can't reach Stripe, give up on this fallback
    }
  }

  return null
}
