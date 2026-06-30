import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { UserProfile, PlanTier } from '../types/database';
import { PLAN_LIMITS } from '../types/database';
import type { User } from '@supabase/supabase-js';
import {
  User as UserIcon, CreditCard, Lock, Building2,
  CheckCircle2, AlertCircle, Loader2, Zap, ArrowRight,
  Check, ExternalLink, ChevronDown, X, XCircle,
} from 'lucide-react';

type Tab = 'profile' | 'billing';
type BillingView = 'overview' | 'upgrade';
// Step sequence for the cancellation modal flow — insert future retention steps between 'survey' and 'confirm'
type CancelStep = 'confirm' | 'survey' | 'done' | null;

const INPUT =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-white/25 focus:outline-none focus:border-primary-500/60 focus:bg-white/8 transition-all';
const LABEL = 'block text-xs font-medium text-white/50 mb-1.5 uppercase tracking-wide';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

interface StripeData {
  plan: PlanTier;
  subscription_status: string;
  plan_renewal_date: string | null;
  monthly_analyses_used: number;
  analyses_reset_at: string | null;
}

interface PricingPlan {
  id: PlanTier;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  analyses: string;
  features: string[];
  highlight?: boolean;
}

const PLANS: PricingPlan[] = [
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
  user: User;
  initialTab?: Tab;
}

async function callEdgeFunction(slug: string, body: unknown, token: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

export default function SettingsPage({ user, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'profile');
  const [billingView, setBillingView] = useState<BillingView>('overview');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingBilling, setSavingBilling] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [stripeData, setStripeData] = useState<StripeData | null>(null);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeLoaded, setStripeLoaded] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly');

  // Cancel subscription modal state
  const [cancelStep, setCancelStep] = useState<CancelStep>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelPeriodEnd, setCancelPeriodEnd] = useState<string | null>(null);
  const [surveyWhat, setSurveyWhat] = useState('');
  const [surveyLiked, setSurveyLiked] = useState('');

  // Profile fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [organization, setOrganization] = useState('');

  // Password fields
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Billing address fields
  const [addr1, setAddr1] = useState('');
  const [addr2, setAddr2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postal, setPostal] = useState('');
  const [country, setCountry] = useState('US');

  useEffect(() => { loadProfile(); }, []);

  function showToast(type: 'success' | 'error', message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }

  async function loadProfile() {
    setLoading(true);
    const { data } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (data) {
      setProfile(data as UserProfile);
      setFirstName(data.first_name ?? '');
      setLastName(data.last_name ?? '');
      setPhone(data.phone ?? '');
      setOrganization(data.organization ?? '');
      setAddr1(data.billing_address_1 ?? '');
      setAddr2(data.billing_address_2 ?? '');
      setCity(data.billing_city ?? '');
      setState(data.billing_state ?? '');
      setPostal(data.billing_postal_code ?? '');
      setCountry(data.billing_country ?? 'US');
    }
    setLoading(false);
  }

  async function loadStripeData() {
    setStripeLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const result = await callEdgeFunction('stripe-subscription', {}, session.access_token);
      if (!result.error) setStripeData(result as StripeData);
    } catch {
      // silently fail — local profile data still shows
    } finally {
      setStripeLoading(false);
      setStripeLoaded(true);
    }
  }

  useEffect(() => {
    if (tab === 'billing') {
      setStripeLoaded(false);
      loadStripeData();
    }
  }, [tab]);

  async function upsertProfile(fields: Partial<UserProfile>) {
    const { error } = await supabase
      .from('user_profiles')
      .upsert({ id: user.id, ...fields }, { onConflict: 'id' });
    return error;
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const error = await upsertProfile({ first_name: firstName, last_name: lastName, phone, organization });
    setSaving(false);
    if (error) showToast('error', 'Failed to save profile.');
    else showToast('success', 'Profile saved successfully.');
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) { showToast('error', 'Password must be at least 8 characters.'); return; }
    if (newPassword !== confirmPassword) { showToast('error', 'Passwords do not match.'); return; }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) showToast('error', error.message);
    else { showToast('success', 'Password updated.'); setNewPassword(''); setConfirmPassword(''); }
  }

  async function handleSaveBilling(e: React.FormEvent) {
    e.preventDefault();
    setSavingBilling(true);
    const error = await upsertProfile({
      billing_address_1: addr1,
      billing_address_2: addr2,
      billing_city: city,
      billing_state: state,
      billing_postal_code: postal,
      billing_country: country,
    });
    setSavingBilling(false);
    if (error) showToast('error', 'Failed to save billing address.');
    else showToast('success', 'Billing address saved.');
  }

  async function handleManageSubscription() {
    setPortalLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const result = await callEdgeFunction('stripe-portal', {
        returnUrl: window.location.href,
      }, session.access_token);
      if (result.url) window.location.href = result.url;
      else showToast('error', result.error ?? 'Could not open billing portal.');
    } catch {
      showToast('error', 'Could not open billing portal.');
    } finally {
      setPortalLoading(false);
    }
  }

  async function handleSelectPlan(planId: PlanTier) {
    setCheckoutLoading(planId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const result = await callEdgeFunction('stripe-checkout', {
        plan: planId,
        interval: billingInterval,
        successUrl: `${window.location.origin}${window.location.pathname}?billing=success`,
        cancelUrl: window.location.href,
      }, session.access_token);
      if (result.url) window.location.href = result.url;
      else showToast('error', result.error ?? 'Could not start checkout.');
    } catch {
      showToast('error', 'Could not start checkout.');
    } finally {
      setCheckoutLoading(null);
    }
  }

  function closeCancelFlow() {
    setCancelStep(null);
    setCancelError(null);
    setCancelPeriodEnd(null);
    setSurveyWhat('');
    setSurveyLiked('');
  }

  async function handleCancelSubscription() {
    setCancelLoading(true);
    setCancelError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setCancelError('Session expired — please refresh and try again.'); return; }

      // FUTURE: optional retention-offer step(s) insert here, before calling cancel-subscription

      const result = await callEdgeFunction('cancel-subscription', {}, session.access_token) as { success?: boolean; current_period_end?: string; error?: string };

      if (!result.success) {
        setCancelError(result.error ?? 'Cancellation failed — please try again.');
        return;
      }

      setCancelPeriodEnd(result.current_period_end ?? null);

      // Save survey feedback if either field is non-empty — fire-and-forget so a
      // feedback insert failure never blocks the confirmed cancellation flow
      if (surveyWhat.trim() || surveyLiked.trim()) {
        supabase.from('subscription_feedback').insert({
          user_id: user.id,
          what_didnt_work: surveyWhat.trim() || null,
          what_liked: surveyLiked.trim() || null,
        }).then(({ error }) => {
          if (error) console.warn('[cancel] feedback insert failed (non-blocking):', error.message);
        });
      }

      setCancelStep('done');
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Cancellation failed — please try again.');
    } finally {
      setCancelLoading(false);
    }
  }

  const initials = (firstName || lastName)
    ? `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
    : user.email?.charAt(0).toUpperCase() ?? '?';

  const displayName = (firstName || lastName)
    ? `${firstName} ${lastName}`.trim()
    : user.email ?? '';

  const activePlan = (stripeData?.plan ?? profile?.plan ?? 'free') as PlanTier;
  const subStatus = stripeData?.subscription_status ?? profile?.subscription_status ?? 'inactive';
  const renewalDate = stripeData?.plan_renewal_date ?? profile?.plan_renewal_date;
  const renewalFormatted = renewalDate
    ? new Date(renewalDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' })
    : null;
  const analysesUsed = stripeData?.monthly_analyses_used ?? profile?.monthly_analyses_used ?? 0;
  const analysesLimit = PLAN_LIMITS[activePlan];
  const isPaid = activePlan !== 'free';

  const statusColor = subStatus === 'active' || subStatus === 'trialing'
    ? { bg: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/25' }
    : { bg: 'bg-amber-500/15', text: 'text-amber-400', border: 'border-amber-500/25' };

  const tabs: { id: Tab; label: string; icon: typeof UserIcon }[] = [
    { id: 'profile', label: 'Profile', icon: UserIcon },
    { id: 'billing', label: 'Billing', icon: CreditCard },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-5 h-5 text-primary-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-6 relative">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium shadow-xl border backdrop-blur-sm transition-all
          ${toast.type === 'success'
            ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/15 border-red-500/30 text-red-400'
          }`}>
          {toast.type === 'success'
            ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-4 mb-1">
          <div className="w-12 h-12 rounded-full bg-primary-500/20 border border-primary-500/30 flex items-center justify-center flex-shrink-0">
            <span className="text-base font-bold text-primary-400">{initials}</span>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">
              {displayName ? `Hey, ${firstName || displayName}` : 'Account Settings'}
            </h1>
            <p className="text-sm text-white/40">Manage your account preferences and profile settings</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 bg-white/5 p-1 rounded-xl w-fit">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => { setTab(id); if (id === 'billing') setBillingView('overview'); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
              ${tab === id
                ? 'bg-primary-500/20 text-primary-400 border border-primary-500/30'
                : 'text-white/40 hover:text-white/70'
              }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Profile Tab ── */}
      {tab === 'profile' && (
        <div className="space-y-6">
          <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-1">
              <UserIcon className="w-4 h-4 text-primary-400" />
              <h2 className="text-base font-semibold text-white">Profile</h2>
            </div>
            <p className="text-xs text-white/35 mb-5">Update your personal information</p>

            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={LABEL}>First Name</label>
                  <input className={INPUT} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name" />
                </div>
                <div>
                  <label className={LABEL}>Last Name</label>
                  <input className={INPUT} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name" />
                </div>
              </div>
              <div>
                <label className={LABEL}>Email</label>
                <input className={INPUT + ' opacity-60 cursor-not-allowed'} value={user.email ?? ''} readOnly />
                <p className="text-xs text-white/25 mt-1.5">Contact support to change your email address</p>
              </div>
              <div>
                <label className={LABEL}>Phone</label>
                <input className={INPUT} value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 000-0000" type="tel" />
              </div>
              <div>
                <label className={LABEL}>Organization</label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25 pointer-events-none" />
                  <input className={INPUT + ' pl-9'} value={organization} onChange={e => setOrganization(e.target.value)} placeholder="Company or LLC name" />
                </div>
              </div>
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full py-2.5 rounded-xl bg-primary-500 hover:bg-primary-400 text-white text-sm font-semibold transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save Profile
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-1">
              <Lock className="w-4 h-4 text-primary-400" />
              <h2 className="text-base font-semibold text-white">Security</h2>
            </div>
            <p className="text-xs text-white/35 mb-5">Manage your password and security settings</p>

            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className={LABEL}>New Password</label>
                <input className={INPUT} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Enter new password" autoComplete="new-password" />
                <p className="text-xs text-white/25 mt-1.5">Must be at least 8 characters</p>
              </div>
              <div>
                <label className={LABEL}>Confirm New Password</label>
                <input className={INPUT} type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Confirm new password" autoComplete="new-password" />
              </div>
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={savingPassword || !newPassword}
                  className="w-full py-2.5 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white text-sm font-semibold transition-all duration-200 disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {savingPassword && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Update Password
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Billing Tab — Overview ── */}
      {tab === 'billing' && billingView === 'overview' && (
        <div className="space-y-6">

          {/* Current Subscription */}
          <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-primary-400" />
                <h2 className="text-base font-semibold text-white">Current Subscription</h2>
              </div>
              {stripeLoading && <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />}
            </div>
            <p className="text-xs text-white/35 mb-5">Your plan and usage for this billing period</p>

            {!stripeLoaded ? (
              <div>
                <div className="space-y-0 mb-5">
                  {[
                    { left: 'w-12', right: 'w-16' },
                    { left: 'w-8',  right: 'w-20' },
                    { left: 'w-20', right: 'w-24' },
                    { left: 'w-28', right: 'w-14' },
                  ].map((widths, i) => (
                    <div key={i} className="flex items-center justify-between py-3.5 border-b border-white/5">
                      <div className={`h-2.5 ${widths.left} bg-white/8 rounded-full animate-pulse`} />
                      <div className={`h-2.5 ${widths.right} bg-white/8 rounded-full animate-pulse`} style={{ animationDelay: `${i * 80}ms` }} />
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <div className="flex-1 h-10 bg-white/5 border border-white/8 rounded-xl animate-pulse" />
                  <div className="w-32 h-10 bg-primary-500/8 border border-primary-500/15 rounded-xl animate-pulse" />
                </div>
              </div>
            ) : isPaid ? (
              <>
                <div className="space-y-0 mb-5">
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <span className="text-sm text-white/50">Status</span>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${statusColor.bg} ${statusColor.text} ${statusColor.border}`}>
                      {subStatus.charAt(0).toUpperCase() + subStatus.slice(1)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <span className="text-sm text-white/50">Plan</span>
                    <span className="text-sm font-semibold text-white capitalize">{activePlan}</span>
                  </div>
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <span className="text-sm text-white/50">Renewal Date</span>
                    <span className="text-sm text-white/70">{renewalFormatted ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between py-3">
                    <span className="text-sm text-white/50">Analyses this month</span>
                    <span className="text-sm font-semibold text-white">
                      {analysesUsed} / {analysesLimit === null ? '∞' : analysesLimit}
                    </span>
                  </div>
                </div>

                {/* Usage bar */}
                {analysesLimit !== null && (
                  <div className="mb-5">
                    <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(100, (analysesUsed / analysesLimit) * 100)}%`,
                          background: analysesUsed >= analysesLimit ? '#EF4444' : analysesUsed >= analysesLimit * 0.8 ? '#F59E0B' : '#22C55E',
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={handleManageSubscription}
                    disabled={portalLoading}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white text-sm font-semibold transition-all duration-200 disabled:opacity-50"
                  >
                    {portalLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                    Manage Subscription
                  </button>
                  <button
                    onClick={() => setBillingView('upgrade')}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary-500/15 hover:bg-primary-500/25 border border-primary-500/30 text-primary-400 text-sm font-semibold transition-all duration-200"
                  >
                    <ChevronDown className="w-3.5 h-3.5 rotate-[-90deg]" />
                    Change Plan
                  </button>
                </div>

                {/* Cancel button — only shown for active/trialing paid subscriptions */}
                {(subStatus === 'active' || subStatus === 'trialing') && (
                  <div className="mt-3 pt-3 border-t border-white/5">
                    <button
                      onClick={() => setCancelStep('confirm')}
                      className="text-xs text-red-400/70 hover:text-red-400 transition-colors underline underline-offset-2"
                    >
                      Cancel subscription
                    </button>
                  </div>
                )}
              </>
            ) : (
              /* Free plan state */
              <div>
                <div className="flex items-center justify-between py-3 border-b border-white/5 mb-3">
                  <span className="text-sm text-white/50">Plan</span>
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/60">Free Trial</span>
                </div>
                <div className="flex items-center justify-between py-3 border-b border-white/5 mb-5">
                  <span className="text-sm text-white/50">Analyses used</span>
                  <span className="text-sm font-semibold text-white">{analysesUsed} / 3</span>
                </div>
                <div className="mb-5">
                  <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, (analysesUsed / 3) * 100)}%`,
                        background: analysesUsed >= 3 ? '#EF4444' : '#22C55E',
                      }}
                    />
                  </div>
                  <p className="text-xs text-white/30 mt-1.5">
                    {analysesUsed >= 3 ? 'Trial limit reached — upgrade to continue.' : `${3 - analysesUsed} free anal${3 - analysesUsed === 1 ? 'ysis' : 'yses'} remaining`}
                  </p>
                </div>
                <button
                  onClick={() => setBillingView('upgrade')}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-400 text-white text-sm font-bold transition-all duration-200"
                >
                  <Zap className="w-3.5 h-3.5" />
                  Upgrade Plan
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Billing Address */}
          <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
            <h2 className="text-base font-semibold text-white mb-1">Billing Address</h2>
            <p className="text-xs text-white/35 mb-5">Manage your billing and mailing address</p>

            <form onSubmit={handleSaveBilling} className="space-y-4">
              <div>
                <label className={LABEL}>Address Line 1</label>
                <input className={INPUT} value={addr1} onChange={e => setAddr1(e.target.value)} placeholder="Street address" />
              </div>
              <div>
                <label className={LABEL}>Address Line 2</label>
                <input className={INPUT} value={addr2} onChange={e => setAddr2(e.target.value)} placeholder="Apt, suite, unit (optional)" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={LABEL}>City</label>
                  <input className={INPUT} value={city} onChange={e => setCity(e.target.value)} placeholder="City" />
                </div>
                <div>
                  <label className={LABEL}>State</label>
                  <input className={INPUT} value={state} onChange={e => setState(e.target.value)} placeholder="NC" maxLength={2} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={LABEL}>Postal Code</label>
                  <input className={INPUT} value={postal} onChange={e => setPostal(e.target.value)} placeholder="27701" />
                </div>
                <div>
                  <label className={LABEL}>Country</label>
                  <input className={INPUT} value={country} onChange={e => setCountry(e.target.value)} placeholder="US" maxLength={2} />
                </div>
              </div>
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={savingBilling}
                  className="w-full py-2.5 rounded-xl bg-primary-500 hover:bg-primary-400 text-white text-sm font-semibold transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {savingBilling && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save Billing Address
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Billing Tab — Upgrade / Pricing ── */}
      {tab === 'billing' && billingView === 'upgrade' && (
        <div>
          {/* Back */}
          <button
            onClick={() => setBillingView('overview')}
            className="flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 transition-colors mb-6"
          >
            <ChevronDown className="w-3.5 h-3.5 rotate-90" />
            Back to billing
          </button>

          <div className="mb-6">
            <h2 className="text-xl font-bold text-white mb-1">Choose your plan</h2>
            <p className="text-sm text-white/40">Use coupon code <span className="font-mono text-primary-400 bg-primary-500/10 px-1.5 py-0.5 rounded text-xs">BETAPERCIQ</span> at checkout for a discount.</p>
          </div>

          {/* Monthly / Annual toggle */}
          <div className="flex items-center gap-3 mb-7">
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
          <div className="space-y-4">
            {PLANS.map(plan => {
              const price = billingInterval === 'annual' ? plan.annualPrice : plan.monthlyPrice;
              const isCurrent = activePlan === plan.id;
              const isLoading = checkoutLoading === plan.id;

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
                    onClick={() => handleSelectPlan(plan.id)}
                    disabled={isLoading || isCurrent}
                    className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all duration-200 disabled:opacity-50 ${
                      isCurrent
                        ? 'bg-white/5 border border-white/10 text-white/30 cursor-default'
                        : plan.highlight
                          ? 'bg-primary-500 hover:bg-primary-400 text-white'
                          : 'bg-white/8 hover:bg-white/12 border border-white/10 text-white'
                    }`}
                  >
                    {isLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isCurrent ? (
                      'Current Plan'
                    ) : (
                      <>
                        Select {plan.name}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-white/25 text-center mt-6">
            All plans include a 7-day money-back guarantee. Cancel anytime.
          </p>
        </div>
      )}

      {/* ── Cancellation Modal Flow ── */}
      {cancelStep !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">

          {/* Modal A — "Are You Sure?" */}
          {cancelStep === 'confirm' && (
            <div className="relative w-full max-w-md bg-navy-800 border border-white/10 rounded-2xl p-6 shadow-2xl">
              <button
                onClick={closeCancelFlow}
                className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/25 flex items-center justify-center flex-shrink-0">
                  <XCircle className="w-4.5 h-4.5 text-red-400" />
                </div>
                <h2 className="text-base font-bold text-white">Are You Sure?</h2>
              </div>

              <p className="text-sm text-white/55 mb-6 leading-relaxed">
                Your subscription will be canceled at the end of your current billing period. You'll retain full access until then.
              </p>

              <div className="flex flex-col gap-2.5">
                <button
                  onClick={() => setCancelStep('survey')}
                  className="w-full py-2.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-400 text-sm font-semibold transition-all duration-200"
                >
                  Cancel Subscription
                </button>
                <button
                  onClick={closeCancelFlow}
                  className="w-full py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm font-semibold transition-all duration-200"
                >
                  Never mind, I'll stay
                </button>
              </div>
            </div>
          )}

          {/* Modal B — Survey */}
          {cancelStep === 'survey' && (
            <div className="relative w-full max-w-md bg-navy-800 border border-white/10 rounded-2xl p-6 shadow-2xl">
              <button
                onClick={closeCancelFlow}
                className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>

              <h2 className="text-base font-bold text-white mb-1">We're Sorry to See You Go</h2>
              <p className="text-xs text-white/35 mb-5">Both fields are optional — any feedback helps us improve.</p>

              <div className="space-y-4 mb-5">
                <div>
                  <label className={LABEL}>What didn't work for you?</label>
                  <textarea
                    className={INPUT + ' resize-none h-20'}
                    value={surveyWhat}
                    onChange={e => setSurveyWhat(e.target.value)}
                    placeholder="Pricing, missing features, didn't need it…"
                  />
                </div>
                <div>
                  <label className={LABEL}>What did you like?</label>
                  <textarea
                    className={INPUT + ' resize-none h-20'}
                    value={surveyLiked}
                    onChange={e => setSurveyLiked(e.target.value)}
                    placeholder="What worked well for you?"
                  />
                </div>
              </div>

              {cancelError && (
                <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-4">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  {cancelError}
                </div>
              )}

              <div className="flex flex-col gap-2.5">
                <button
                  onClick={handleCancelSubscription}
                  disabled={cancelLoading}
                  className="w-full py-2.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-400 text-sm font-semibold transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {cancelLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Continue
                </button>
                <button
                  onClick={closeCancelFlow}
                  disabled={cancelLoading}
                  className="w-full py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm font-semibold transition-all duration-200 disabled:opacity-40"
                >
                  Never mind, I'll stay
                </button>
              </div>
            </div>
          )}

          {/* Modal C — Confirmation */}
          {cancelStep === 'done' && (
            <div className="relative w-full max-w-md bg-navy-800 border border-white/10 rounded-2xl p-6 shadow-2xl">
              <div className="flex flex-col items-center text-center mb-5">
                <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                </div>
                <h2 className="text-base font-bold text-white mb-2">Subscription Canceled</h2>
                <p className="text-sm text-white/55 leading-relaxed">
                  Your subscription is canceled and will remain active until{' '}
                  {cancelPeriodEnd
                    ? <strong className="text-white font-bold">
                        {new Date(cancelPeriodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                      </strong>
                    : 'the end of your billing period'
                  }.
                </p>
              </div>

              <button
                onClick={() => {
                  closeCancelFlow();
                  // Best-effort re-fetch to update the Billing tab.
                  // The webhook (customer.subscription.updated) owns the user_profiles write,
                  // so this may briefly still show the old status if the webhook hasn't landed yet — that is expected and fine.
                  loadStripeData();
                }}
                className="w-full py-2.5 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white text-sm font-semibold transition-all duration-200"
              >
                Got it
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
