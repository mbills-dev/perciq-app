import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  Layers, LogOut,
  Bell, User, CreditCard, Building2, ChevronDown,
} from 'lucide-react';

type Page = 'dashboard' | 'settings';

interface LayoutProps {
  children: React.ReactNode;
  currentPage: Page;
  onNavigate: (page: Page) => void;
  userEmail: string;
  fullHeight?: boolean;
}

export default function Layout({ children, currentPage, onNavigate, userEmail, fullHeight }: LayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [organization, setOrganization] = useState('');
  const [plan, setPlan] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase
        .from('user_profiles')
        .select('first_name, last_name, organization, plan')
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setFirstName(data.first_name ?? '');
            setLastName(data.last_name ?? '');
            setOrganization(data.organization ?? '');
            setPlan(data.plan ?? '');
          }
        });
    });
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  const displayName = (firstName || lastName)
    ? `${firstName} ${lastName}`.trim()
    : userEmail;

  const initials = (firstName || lastName)
    ? `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
    : userEmail.charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-navy-900 flex flex-col">
      <header className="h-14 bg-navy-800/60 border-b border-white/5 flex items-center px-5 gap-4 sticky top-0 z-10 backdrop-blur-sm">
        {/* Brand — click to go to dashboard */}
        <button
          onClick={() => onNavigate('dashboard')}
          className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
        >
          <div className="w-7 h-7 bg-primary-500/20 border border-primary-500/40 rounded-lg flex items-center justify-center">
            <Layers className="w-3.5 h-3.5 text-primary-400" />
          </div>
          <span className="font-bold text-sm tracking-tight text-white">PercIQ</span>
        </button>

        {/* Page label — only when not on dashboard */}
        {currentPage === 'settings' && (
          <div className="flex items-center gap-2 text-white/30 text-xs">
            <span>/</span>
            <span className="text-white/60 font-medium">Settings</span>
          </div>
        )}

        <div className="flex-1" />

        {/* Bell */}
        <button className="w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition-all">
          <Bell className="w-4 h-4" />
        </button>

        {/* User avatar + dropdown */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="flex items-center gap-2.5 pl-1.5 pr-2.5 py-1.5 rounded-xl hover:bg-white/5 transition-all duration-200"
          >
            <div className="w-7 h-7 rounded-full bg-primary-500/25 border border-primary-500/40 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-bold text-primary-400">{initials}</span>
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-xs font-semibold text-white leading-tight">{displayName}</p>
              {organization && (
                <p className="text-[10px] text-white/35 leading-tight truncate max-w-[120px]">{organization}</p>
              )}
            </div>
            <ChevronDown className={`w-3 h-3 text-white/30 transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-2 w-60 bg-navy-800 border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-50">
              {/* Identity block */}
              <div className="px-4 py-3.5 border-b border-white/[0.06]">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-9 h-9 rounded-full bg-primary-500/25 border border-primary-500/40 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-bold text-primary-400">{initials}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white leading-tight truncate">{displayName}</p>
                    {organization && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <Building2 className="w-2.5 h-2.5 text-primary-400/60 flex-shrink-0" />
                        <p className="text-[11px] text-primary-400/70 truncate">{organization}</p>
                      </div>
                    )}
                  </div>
                </div>
                {plan && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary-500/15 border border-primary-500/25 text-primary-400 uppercase tracking-wide">
                      {plan} Plan
                    </span>
                  </div>
                )}
              </div>

              {/* Nav links */}
              <div className="py-1.5">
                <button
                  onClick={() => { onNavigate('settings'); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-white/60 hover:text-white hover:bg-white/5 transition-all"
                >
                  <User className="w-4 h-4" />
                  Profile Settings
                </button>
                <button
                  onClick={() => { onNavigate('settings'); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-white/60 hover:text-white hover:bg-white/5 transition-all"
                >
                  <CreditCard className="w-4 h-4" />
                  Billing
                </button>
              </div>

              {/* Sign out */}
              <div className="border-t border-white/[0.06] py-1.5">
                <button
                  onClick={handleSignOut}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400/70 hover:text-red-400 hover:bg-red-500/8 transition-all"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className={`flex-1 ${fullHeight ? 'overflow-hidden' : 'p-6 overflow-auto'}`}>
        {children}
      </main>
    </div>
  );
}
