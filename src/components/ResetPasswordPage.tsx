import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Lock, AlertCircle, ArrowRight, CheckCircle2 } from 'lucide-react';

export default function ResetPasswordPage() {
  const [sessionReady, setSessionReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) setSessionReady(true);
        setChecking(false);
      });
    }, 500);
    return () => clearTimeout(timeout);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setSuccess(true);
    }
  }

  return (
    <div className="min-h-screen bg-navy-900 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg%20width%3D%2260%22%20height%3D%2260%22%20viewBox%3D%220%200%2060%2060%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Cg%20fill%3D%22none%22%20fill-rule%3D%22evenodd%22%3E%3Cg%20fill%3D%22%23ffffff%22%20fill-opacity%3D%220.03%22%3E%3Cpath%20d%3D%22M36%2034v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6%2034v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6%204V0H4v4H0v2h4v4h2V6h4V4H6z%22/%3E%3C/g%3E%3C/g%3E%3C/svg%3E')] opacity-50" />

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <img src="/perciq-logo-mark-dark.svg" alt="" className="h-10 w-auto" />
            <span className="text-2xl font-extrabold tracking-tight text-white">PERC<span className="text-[#21C55E] font-light">IQ</span></span>
          </div>
        </div>

        {checking ? (
          <div className="card p-8 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-white/10 border-t-primary-400 rounded-full animate-spin" />
          </div>
        ) : !sessionReady ? (
          <div className="card p-8 space-y-4">
            <div className="flex items-start gap-2 bg-danger-500/10 border border-danger-500/30 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 text-danger-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-danger-400">This reset link is invalid or has expired. Request a new one.</p>
            </div>
            <a
              href="/"
              className="btn-primary w-full flex items-center justify-center gap-2 py-2.5"
            >
              Back to login
              <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        ) : success ? (
          <div className="card p-8 space-y-4">
            <div className="flex items-start gap-2 bg-primary-500/10 border border-primary-500/30 rounded-lg p-3">
              <CheckCircle2 className="w-4 h-4 text-primary-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-primary-400">Your password has been updated.</p>
            </div>
            <button
              onClick={() => { window.location.href = '/'; }}
              className="btn-primary w-full flex items-center justify-center gap-2 py-2.5"
            >
              Continue to PercIQ
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="card p-8">
            <h2 className="text-lg font-semibold text-white mb-1">Set new password</h2>
            <p className="text-sm text-white/50 mb-6">Choose a new password for your PercIQ account.</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1.5">New Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="input pl-9"
                    placeholder="••••••••"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>
                <p className="text-xs text-white/25 mt-1.5">Must be at least 8 characters</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-white/70 mb-1.5">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="input pl-9"
                    placeholder="••••••••"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 bg-danger-500/10 border border-danger-500/30 rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 text-danger-400 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-danger-400">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full flex items-center justify-center gap-2 py-2.5 mt-2"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    Update password
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
