import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { cn, formatDate } from '../lib/format';
import { Badge, ErrorNotice, Spinner, useToast } from '../components/ui';
import type { Plan } from '../lib/types';

/**
 * Plans and billing.
 *
 * Checkout and the billing portal are both Stripe-hosted: this app never sees
 * a card number, and cancellation happens in the portal rather than behind a
 * support email. When Stripe keys are absent the plan grid still renders as a
 * comparison table with the buttons disabled, because the limits it describes
 * are real and enforced whether or not payments are switched on.
 */
export default function PricingPage() {
  const toast = useToast();
  const { session, can } = useSession();

  const plans = useQuery({ queryKey: ['plans'], queryFn: api.plans, staleTime: 300_000 });

  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: api.billing,
    enabled: can('billing:manage'),
    staleTime: 60_000,
  });

  const checkout = useMutation({
    mutationFn: (plan: 'team' | 'scale') => api.checkout(plan),
    // Stripe owns the next screen, so this navigates away rather than
    // rendering a payment form.
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not start checkout', { tone: 'error' }),
  });

  const portal = useMutation({
    mutationFn: () => api.portal(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not open the billing portal', {
        tone: 'error',
      }),
  });

  const org = session?.org;
  const billingEnabled = session?.features.billing ?? false;
  const currentPlan = org?.entitledPlan ?? 'free';

  return (
    <main id="main" className="mx-auto max-w-[1000px] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5">
        <h1 className="text-base font-semibold">Plans</h1>
        <p className="mt-0.5 text-xs text-muted">
          {org ? (
            <>
              {org.name} is on <strong className="font-semibold text-ink">{org.planName}</strong>
              {org.subscriptionStatus === 'trialing' && org.currentPeriodEnd && (
                <> · trial ends {formatDate(org.currentPeriodEnd)}</>
              )}
              {org.cancelAtPeriodEnd && org.currentPeriodEnd && (
                <> · cancels {formatDate(org.currentPeriodEnd)}</>
              )}
            </>
          ) : null}
        </p>
      </div>

      {!billingEnabled && (
        <p className="mb-4 rounded-lg border border-line bg-raised px-3 py-2 text-xs text-muted">
          Payments are not configured on this deployment, so upgrades are unavailable. The limits
          below are still enforced.
        </p>
      )}

      {plans.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted">
          <Spinner />
          Loading plans
        </div>
      ) : plans.isError ? (
        <ErrorNotice error={plans.error} onRetry={() => void plans.refetch()} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(plans.data ?? []).map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              isCurrent={plan.id === currentPlan}
              billingEnabled={billingEnabled}
              canManageBilling={can('billing:manage')}
              isPending={checkout.isPending}
              onChoose={() => checkout.mutate(plan.id as 'team' | 'scale')}
            />
          ))}
        </div>
      )}

      {can('billing:manage') && billing.data?.has_billing_account && (
        <section className="card mt-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xs font-semibold">Billing</h2>
              <p className="mt-0.5 text-2xs text-subtle">
                Update your card, download invoices, or cancel. Handled by Stripe.
              </p>
            </div>
            <button
              onClick={() => portal.mutate()}
              disabled={portal.isPending}
              className="btn-secondary py-1.5 text-xs"
            >
              {portal.isPending && <Spinner />}
              Open billing portal
            </button>
          </div>
        </section>
      )}

      {!can('billing:manage') && (
        <p className="mt-4 text-center text-xs text-subtle">
          Only the workspace owner can change the plan.{' '}
          <Link to="/team" className="underline underline-offset-2 hover:text-brand">
            See who that is
          </Link>
          .
        </p>
      )}
    </main>
  );
}

function PlanCard({
  plan,
  isCurrent,
  billingEnabled,
  canManageBilling,
  isPending,
  onChoose,
}: {
  plan: Plan;
  isCurrent: boolean;
  billingEnabled: boolean;
  canManageBilling: boolean;
  isPending: boolean;
  onChoose: () => void;
}) {
  const buyable = plan.purchasable && billingEnabled && canManageBilling && !isCurrent;

  return (
    <section
      className={cn(
        'card flex flex-col p-4',
        isCurrent && 'border-brand ring-2 ring-brand/20',
      )}
      aria-current={isCurrent ? 'true' : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{plan.name}</h2>
        {isCurrent && <Badge tone="brand">Current</Badge>}
      </div>

      <p className="mt-1 text-2xs text-subtle">{plan.blurb}</p>

      <p className="mt-3 font-mono text-xl font-semibold">{plan.priceLabel}</p>
      {plan.trialDays > 0 && !isCurrent && (
        <p className="mt-0.5 text-2xs text-brand">{plan.trialDays}-day free trial</p>
      )}

      <ul className="mt-3 flex-1 space-y-1.5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-1.5 text-2xs text-muted">
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              className="mt-0.5 shrink-0 text-positive"
              aria-hidden="true"
            >
              <path
                d="M3 8.5l3.5 3.5L13 5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-4">
        {isCurrent ? (
          <button disabled className="btn-secondary w-full py-1.5 text-xs">
            Your plan
          </button>
        ) : plan.purchasable ? (
          <button
            onClick={onChoose}
            disabled={!buyable || isPending}
            title={
              !billingEnabled
                ? 'Payments are not configured on this deployment'
                : !canManageBilling
                  ? 'Only the workspace owner can change the plan'
                  : undefined
            }
            className="btn-primary w-full py-1.5 text-xs"
          >
            {isPending && <Spinner />}
            {plan.trialDays > 0 ? 'Start free trial' : `Choose ${plan.name}`}
          </button>
        ) : (
          <button disabled className="btn-secondary w-full py-1.5 text-xs">
            Included
          </button>
        )}
      </div>
    </section>
  );
}
