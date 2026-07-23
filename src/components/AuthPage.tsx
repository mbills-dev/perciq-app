import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Mail, Lock, ArrowRight, AlertCircle } from 'lucide-react';

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.user) {
          await supabase.from('user_profiles').upsert(
            { id: data.user.id, terms_accepted_at: new Date().toISOString() },
            { onConflict: 'id' }
          );
          // Best-effort welcome email + CRM tag — never blocks or surfaces errors to the user
          supabase.functions.invoke('send-welcome-email', {
            body: { email, userId: data.user.id },
          }).catch(err => console.error('[welcome-email] failed to invoke', err));
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-navy-900 flex items-center justify-center p-4">
      {/* Background grid pattern */}
      <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg%20width%3D%2260%22%20height%3D%2260%22%20viewBox%3D%220%200%2060%2060%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Cg%20fill%3D%22none%22%20fill-rule%3D%22evenodd%22%3E%3Cg%20fill%3D%22%23ffffff%22%20fill-opacity%3D%220.03%22%3E%3Cpath%20d%3D%22M36%2034v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6%2034v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6%204V0H4v4H0v2h4v4h2V6h4V4H6z%22/%3E%3C/g%3E%3C/g%3E%3C/svg%3E')] opacity-50" />

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <img src="/perciq-logo-mark-dark.svg" alt="" className="h-10 w-auto" />
            <span className="text-2xl font-extrabold tracking-tight text-white">PERC<span className="text-[#21C55E] font-light">IQ</span></span>
          </div>
          <p className="text-white/50 text-sm">Soil intelligence for land professionals</p>
        </div>

        {/* Card */}
        <div className="card p-8">
          {/* Tabs */}
          <div className="flex bg-navy-900/60 rounded-lg p-1 mb-6">
            {(['login', 'signup'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => { setMode(tab); setError(''); }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all duration-200 ${
                  mode === tab
                    ? 'bg-primary-500 text-white shadow-sm'
                    : 'text-white/50 hover:text-white/80'
                }`}
              >
                {tab === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1.5">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9"
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-white/70 mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9"
                  placeholder="••••••••"
                  required
                  minLength={6}
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
                  {mode === 'login' ? 'Sign In' : 'Create Account'}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {mode === 'signup' && (
            <p className="text-xs text-white/30 text-center mt-4">
              By creating an account, you agree to our{' '}
              <a
                href="https://perciq.co/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-white/50 transition-colors"
              >
                Terms of Service
              </a>{' '}
              and{' '}
              <a
                href="https://perciq.co/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-white/50 transition-colors"
              >
                Privacy Policy
              </a>
              .
            </p>
          )}
        </div>

        <p className="text-center text-xs text-white/20 mt-6">
          Data powered soil intelligence
        </p>
      </div>
    </div>
  );
}
