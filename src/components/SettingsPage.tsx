import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { UserProfile } from '../types/database';
import type { User } from '@supabase/supabase-js';
import { User as UserIcon, CreditCard, Lock, Building2, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

type Tab = 'profile' | 'billing';

const INPUT =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-white/25 focus:outline-none focus:border-primary-500/60 focus:bg-white/8 transition-all';

const LABEL = 'block text-xs font-medium text-white/50 mb-1.5 uppercase tracking-wide';

interface Props {
  user: User;
}

export default function SettingsPage({ user }: Props) {
  const [tab, setTab] = useState<Tab>('profile');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingBilling, setSavingBilling] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Profile fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [organization, setOrganization] = useState('');

  // Password fields
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Billing fields
  const [addr1, setAddr1] = useState('');
  const [addr2, setAddr2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postal, setPostal] = useState('');
  const [country, setCountry] = useState('US');

  useEffect(() => {
    loadProfile();
  }, []);

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

  const initials = (firstName || lastName)
    ? `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
    : user.email?.charAt(0).toUpperCase() ?? '?';

  const displayName = (firstName || lastName)
    ? `${firstName} ${lastName}`.trim()
    : user.email ?? '';

  const planStatus = profile?.plan_status ?? 'Active';
  const planName = profile?.plan ?? 'Free';
  const renewalDate = profile?.plan_renewal_date
    ? new Date(profile.plan_renewal_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' })
    : null;

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
            onClick={() => setTab(id)}
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

      {/* Profile Tab */}
      {tab === 'profile' && (
        <div className="space-y-6">
          {/* Profile Info */}
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
                <div className="flex gap-2">
                  <input className={INPUT + ' flex-1 opacity-60 cursor-not-allowed'} value={user.email ?? ''} readOnly />
                </div>
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

          {/* Security */}
          <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-1">
              <Lock className="w-4 h-4 text-primary-400" />
              <h2 className="text-base font-semibold text-white">Security</h2>
            </div>
            <p className="text-xs text-white/35 mb-5">Manage your password and security settings</p>

            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className={LABEL}>New Password</label>
                <input
                  className={INPUT}
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  autoComplete="new-password"
                />
                <p className="text-xs text-white/25 mt-1.5">Must be at least 8 characters</p>
              </div>
              <div>
                <label className={LABEL}>Confirm New Password</label>
                <input
                  className={INPUT}
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                />
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

      {/* Billing Tab */}
      {tab === 'billing' && (
        <div className="space-y-6">
          {/* Current Subscription */}
          <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-4 h-4 text-primary-400" />
              <h2 className="text-base font-semibold text-white">Current Subscription</h2>
            </div>
            <p className="text-xs text-white/35 mb-5">View your subscription details and membership information</p>

            <div className="space-y-3">
              <div className="flex items-center justify-between py-3 border-b border-white/5">
                <span className="text-sm text-white/50">Status</span>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full
                  ${planStatus === 'Active'
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                    : 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
                  }`}>
                  {planStatus}
                </span>
              </div>
              <div className="flex items-center justify-between py-3 border-b border-white/5">
                <span className="text-sm text-white/50">Plan</span>
                <span className="text-sm font-semibold text-white">{planName}</span>
              </div>
              {renewalDate && (
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-white/50">Renewal Date</span>
                  <span className="text-sm text-white/70">{renewalDate}</span>
                </div>
              )}
              {!renewalDate && (
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-white/50">Renewal Date</span>
                  <span className="text-sm text-white/30">—</span>
                </div>
              )}
            </div>
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
    </div>
  );
}
