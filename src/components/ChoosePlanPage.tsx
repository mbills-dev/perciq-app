import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Layers } from 'lucide-react';
import { PlanCards, PLANS } from './PlanCards';
import type { PlanTier } from '../types/database';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

interface Props {
  userEmail: string;
}

export default function ChoosePlanPage({ userEmail }: Props) {
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly');
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  async function handleSelectPlan(planId: PlanTier) {
    setCheckoutLoading(planId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const origin = window.location.origin;
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/stripe-checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan: planId,
          interval: billingInterval,
          successUrl: `${origin}/?checkout=success`,
          cancelUrl: `${origin}/`,
        }),
      });
      const data = await resp.json() as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (e) {
      console.error('[choose-plan] checkout error:', e);
    } finally {
      setCheckoutLoading(null);
    }
  }

  function handleSignOut() {
    supabase.auth.signOut();
  }

  return (
    <div className="min-h-screen bg-navy-900 flex flex-col">
      {/* Header */}
      <header className="h-14 bg-navy-800/60 border-b border-white/5 flex items-center px-5 gap-4 sticky top-0 z-10 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-primary-500/20 border border-primary-500/40 rounded-lg flex items-center justify-center">
            <Layers className="w-3.5 h-3.5 text-primary-400" />
          </div>
          <span className="font-bold text-sm tracking-tight text-white">PercIQ</span>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-white/30 hidden sm:block">{userEmail}</span>
        <button
          onClick={handleSignOut}
          className="text-xs text-white/30 hover:text-white/60 transition-colors"
        >
          Sign out
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 flex items-start justify-center py-12 px-4 overflow-y-auto">
        <div className="w-full max-w-lg">

          {/* Hero text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-extrabold text-white tracking-tight mb-3">
              Start your free trial
            </h1>
            <p className="text-white/50 text-sm leading-relaxed max-w-sm mx-auto">
              Get full access to PercIQ for 7 days — no charge until your trial ends.
              Cancel before day 7 and you won't be charged.
            </p>
          </div>

          {/* Trial badge */}
          <div className="flex items-center justify-center gap-2 mb-7">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/12 border border-emerald-500/25 text-emerald-400 text-xs font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              7-day free trial on all plans
            </span>
          </div>

          {/* Interval toggle */}
          <div className="flex items-center justify-center gap-3 mb-7">
            <button
              onClick={() => setBillingInterval('monthly')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${billingInterval === 'monthly' ? 'bg-primary-500/20 text-primary-400 border border-primary-500/30' : 'text-white/40 hover:text-white/60'}`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBillingInterval('annual')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${billingInterval === 'annual' ? 'bg-primary-500/20 text-primary-400 border border-primary-500/30' : 'text-white/40 hover:text-white/60'}`}
            >
              Annual
              <span className="ml-1.5 text-xs font-semibold text-emerald-400">Save 20%</span>
            </button>
          </div>

          {/* Plan cards */}
          <PlanCards
            billingInterval={billingInterval}
            currentPlan={null}
            checkoutLoading={checkoutLoading}
            ctaLabel={(_plan) => 'Start Free Trial'}
            onSelect={handleSelectPlan}
          />

          {/* Footer note */}
          <p className="text-xs text-white/25 text-center mt-6 leading-relaxed">
            7-day free trial on all plans. Card required. Cancel before day 7 and you won't be charged.{' '}
            Have a beta code? Enter it at checkout.
          </p>

          {/* Already subscribed hint (edge case: webhook delay) */}
          <p className="text-xs text-white/20 text-center mt-3">
            Already subscribed?{' '}
            <button
              onClick={() => window.location.reload()}
              className="underline hover:text-white/40 transition-colors"
            >
              Refresh to continue
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
