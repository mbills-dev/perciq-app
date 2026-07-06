import { Check, ArrowRight, Loader2 } from 'lucide-react';
import type { PlanTier } from '../types/database';

export interface PricingPlan {
  id: PlanTier;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  analyses: string;
  features: string[];
  highlight?: boolean;
}

export const PLANS: PricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    monthlyPrice: 19,
    annualPrice: 15,
    analyses: '15 analyses/month',
    features: [
      '15 parcel analyses per month',
      'Full SI Score report',
      'SSURGO + FEMA + wetlands data',
      'GPS perc test coordinates',
      'PDF report export',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyPrice: 49,
    annualPrice: 39,
    analyses: '50 analyses/month',
    highlight: true,
    features: [
      '50 parcel analyses per month',
      'Everything in Starter',
      'Priority analysis queue',
      'Shareable public report links',
      'Email support',
    ],
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    monthlyPrice: 99,
    annualPrice: 79,
    analyses: 'Unlimited analyses',
    features: [
      'Unlimited parcel analyses',
      'Everything in Pro',
      'Bulk upload (CSV)',
      'API access',
      'Dedicated support',
    ],
  },
];

interface Props {
  billingInterval: 'monthly' | 'annual';
  currentPlan?: PlanTier | null;
  checkoutLoading?: string | null;
  isTrial?: boolean;
  /** Label for the CTA button. Defaults to "Select {name}". Only used when not trialing. */
  ctaLabel?: (plan: PricingPlan) => string;
  onSelect: (planId: PlanTier) => void;
}

export function PlanCards({ billingInterval, currentPlan, checkoutLoading, isTrial, ctaLabel, onSelect }: Props) {
  return (
    <div className="space-y-4">
      {PLANS.map(plan => {
        const price = billingInterval === 'annual' ? plan.annualPrice : plan.monthlyPrice;
        const isCurrent = currentPlan === plan.id;
        const isLoading = checkoutLoading === plan.id;

        // For trialing users, the current plan card is active (not disabled)
        const isDisabled = isCurrent && !isTrial;
        const isTrialCurrent = isTrial && isCurrent;

        function getLabel() {
          if (isDisabled) return 'Current Plan';
          if (isTrialCurrent) return `Start ${plan.name} now`;
          if (isTrial) return 'Upgrade & start now';
          if (ctaLabel) return ctaLabel(plan);
          return `Select ${plan.name}`;
        }

        return (
          <div
            key={plan.id}
            className={`rounded-2xl p-6 border transition-all ${
              plan.highlight
                ? 'bg-primary-500/8 border-primary-500/40 shadow-[0_0_0_1px_rgba(34,197,94,0.15)]'
                : 'bg-white/[0.03] border-white/8'
            }`}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-bold text-white">{plan.name}</h3>
                  {plan.highlight && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary-500/20 border border-primary-500/35 text-primary-400 uppercase tracking-wide">Most Popular</span>
                  )}
                  {isCurrent && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/10 border border-white/15 text-white/50 uppercase tracking-wide">Current</span>
                  )}
                </div>
                <p className="text-xs text-white/40">{plan.analyses}</p>
              </div>
              <div className="text-right">
                <span className="text-2xl font-bold text-white">${price}</span>
                <span className="text-sm text-white/40">/mo</span>
                {billingInterval === 'annual' && (
                  <p className="text-xs text-white/30 mt-0.5">billed annually</p>
                )}
              </div>
            </div>

            <ul className="space-y-2 mb-5">
              {plan.features.map(f => (
                <li key={f} className="flex items-start gap-2 text-sm text-white/60">
                  <Check className="w-3.5 h-3.5 text-primary-400 flex-shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <button
              onClick={() => onSelect(plan.id)}
              disabled={isLoading || isDisabled}
              className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all duration-200 disabled:opacity-50 ${
                isDisabled
                  ? 'bg-white/5 border border-white/10 text-white/30 cursor-default'
                  : plan.highlight || isTrialCurrent
                    ? 'bg-primary-500 hover:bg-primary-400 text-white'
                    : 'bg-white/8 hover:bg-white/12 border border-white/10 text-white'
              }`}
            >
              {isLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <>
                  {getLabel()}
                  {!isDisabled && <ArrowRight className="w-3.5 h-3.5" />}
                </>
              )}
            </button>

            {/* Trial-current subtext */}
            {isTrialCurrent && (
              <p className="text-xs text-white/35 mt-2.5 text-center leading-relaxed">
                End your free trial early — your card will be charged ${price} today and your full {plan.analyses} unlocks immediately.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
