import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import type { User } from '@supabase/supabase-js';
import AuthPage from './components/AuthPage';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import ReportDetail from './components/ReportDetail';
import SettingsPage from './components/SettingsPage';
import PublicReportPage from './components/PublicReportPage';
import ChoosePlanPage from './components/ChoosePlanPage';
import { Layers } from 'lucide-react';

const VALID_PLANS = ['starter', 'pro', 'unlimited', 'single_report'] as const;
type PlanSlug = typeof VALID_PLANS[number];

const PLAN_SESSION_KEY = 'perciq_pending_plan';
const INTERVAL_SESSION_KEY = 'perciq_pending_interval';

function capturePlanParam() {
  const params = new URLSearchParams(window.location.search);
  const plan = params.get('plan');
  const interval = params.get('interval');
  if (plan && VALID_PLANS.includes(plan as PlanSlug)) {
    sessionStorage.setItem(PLAN_SESSION_KEY, plan);
    if (interval === 'annual') {
      sessionStorage.setItem(INTERVAL_SESSION_KEY, 'annual');
    }
  }
}

function consumePendingPlan(): { plan: PlanSlug; interval: 'monthly' | 'annual' | 'one_time' } | null {
  const plan = sessionStorage.getItem(PLAN_SESSION_KEY) as PlanSlug | null;
  if (plan && VALID_PLANS.includes(plan)) {
    const interval = sessionStorage.getItem(INTERVAL_SESSION_KEY) as 'annual' | null;
    sessionStorage.removeItem(PLAN_SESSION_KEY);
    sessionStorage.removeItem(INTERVAL_SESSION_KEY);
    const resolvedInterval = plan === 'single_report' ? 'one_time' : (interval ?? 'monthly');
    return { plan, interval: resolvedInterval };
  }
  return null;
}

function getPublicReportId(): string | null {
  const match = window.location.pathname.match(/^\/report\/([a-f0-9-]{36})$/i);
  return match ? match[1] : null;
}

type Page = 'dashboard' | 'settings';
type SettingsTab = 'profile' | 'billing';

function getReportIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('report');
}

function setReportIdInUrl(reportId: string | null) {
  const url = new URL(window.location.href);
  if (reportId) {
    url.searchParams.set('report', reportId);
  } else {
    url.searchParams.delete('report');
  }
  window.history.replaceState(null, '', url.toString());
}

async function redirectToStripeCheckout(
  plan: PlanSlug,
  interval: 'monthly' | 'annual' | 'one_time',
  authToken: string
) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const origin = window.location.origin;
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/stripe-checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan,
        interval,
        successUrl: `${origin}/?checkout=success`,
        cancelUrl: `${origin}/`,
      }),
    });
    const data = await resp.json() as { url?: string; error?: string };
    if (data.url) {
      window.location.href = data.url;
    }
  } catch (e) {
    console.error('[stripe-redirect] failed:', e);
  }
}

function isSubscribed(status: string | null | undefined): boolean {
  return status === 'active' || status === 'trialing';
}

function AuthenticatedApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [subChecked, setSubChecked] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile');
  const [viewingReportId, setViewingReportId] = useState<string | null>(getReportIdFromUrl);

  // Capture ?plan= (and ?interval=) param on every page load so it survives auth redirect
  useEffect(() => { capturePlanParam(); }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });

    supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === 'SIGNED_IN' && session) {
        (async () => {
          const pending = consumePendingPlan();
          if (pending) {
            await redirectToStripeCheckout(pending.plan, pending.interval, session.access_token);
          }
        })();
      }
    });
  }, []);

  // Load subscription status whenever user changes
  useEffect(() => {
    if (!user) { setSubChecked(false); return; }
    setSubChecked(false);
    supabase
      .from('user_profiles')
      .select('subscription_status')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setSubscriptionStatus(data?.subscription_status ?? null);
        setSubChecked(true);
      });
  }, [user]);

  function handleNavigate(page: Page, tab?: SettingsTab) {
    setCurrentPage(page);
    if (tab) setSettingsTab(tab);
    setViewingReportId(null);
    setReportIdInUrl(null);
  }

  function handleViewReport(reportId: string) {
    setViewingReportId(reportId);
    setReportIdInUrl(reportId);
  }

  async function handleCreateReport(parcelId: string) {
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    if (!currentUser) return;

    const { data: existingReport } = await supabase
      .from('reports')
      .select('id')
      .eq('parcel_id', parcelId)
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (existingReport) {
      handleViewReport(existingReport.id);
      return;
    }

    const { data: report } = await supabase
      .from('reports')
      .insert({ user_id: currentUser.id, parcel_id: parcelId, status: 'pending' })
      .select()
      .single();

    if (report) {
      handleViewReport(report.id);
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-navy-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-white/10 border-t-primary-400 rounded-full animate-spin" />
          <p className="text-white/30 text-sm">Loading PercIQ...</p>
        </div>
      </div>
    );
  }

  // Unauthenticated user visiting a shared report link — public read-only view
  if (!user && viewingReportId) {
    return (
      <div className="min-h-screen bg-navy-900 flex flex-col" style={{ height: '100vh' }}>
        {/* Minimal public header */}
        <header className="h-14 bg-navy-800/60 border-b border-white/5 flex items-center px-5 gap-4 sticky top-0 z-10 backdrop-blur-sm flex-shrink-0">
          <a
            href="https://app.perciq.co"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
          >
            <div className="w-7 h-7 bg-primary-500/20 border border-primary-500/40 rounded-lg flex items-center justify-center">
              <Layers className="w-3.5 h-3.5 text-primary-400" />
            </div>
            <span className="font-bold text-sm tracking-tight text-white">PercIQ</span>
          </a>
          <div className="flex-1" />
          <a
            href="https://app.perciq.co"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all"
            style={{
              background: 'rgba(34,197,94,0.12)',
              border: '1px solid rgba(34,197,94,0.30)',
              color: '#22C55E',
            }}
          >
            Get your free analysis
          </a>
        </header>
        <main className="flex-1 overflow-hidden">
          <ReportDetail
            reportId={viewingReportId}
            onBack={() => {}}
            isPublic
          />
        </main>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  // Still loading subscription status — show spinner to avoid flicker
  if (!subChecked) {
    return (
      <div className="min-h-screen bg-navy-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-white/10 border-t-primary-400 rounded-full animate-spin" />
          <p className="text-white/30 text-sm">Loading PercIQ...</p>
        </div>
      </div>
    );
  }

  // Unsubscribed users must choose a plan before accessing the app
  if (!isSubscribed(subscriptionStatus)) {
    return <ChoosePlanPage userEmail={user.email ?? ''} />;
  }

  if (viewingReportId) {
    return (
      <Layout
        currentPage={currentPage}
        onNavigate={handleNavigate}
        userEmail={user.email ?? ''}
        fullHeight
      >
        <ReportDetail
          reportId={viewingReportId}
          onBack={() => { setViewingReportId(null); setReportIdInUrl(null); }}
        />
      </Layout>
    );
  }

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={handleNavigate}
      userEmail={user.email ?? ''}
    >
      {currentPage === 'dashboard' && (
        <Dashboard
          onViewReport={handleViewReport}
          onCreateReport={handleCreateReport}
          onNavigateSettings={() => handleNavigate('settings')}
        />
      )}
      {currentPage === 'settings' && (
        <SettingsPage user={user} initialTab={settingsTab} />
      )}
    </Layout>
  );
}

export default function App() {
  const publicReportId = getPublicReportId();
  if (publicReportId) {
    return <PublicReportPage reportId={publicReportId} />;
  }
  return <AuthenticatedApp />;
}
