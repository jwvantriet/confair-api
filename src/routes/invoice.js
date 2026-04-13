'use client';
import { Suspense } from 'react';
import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loginCarerix, api } from '@/lib/api';
import { saveSession, UserSession } from '@/lib/auth';

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const [username,     setUsername]     = useState('');
  const [password,     setPassword]     = useState('');
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [mode,         setMode]         = useState<'login' | 'forgot'>('login');
  const [resetSent,    setResetSent]    = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  useEffect(() => {
    const err = searchParams.get('error');
    if (err) setError(decodeURIComponent(err));
  }, [searchParams]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      // All users authenticate via Carerix — role auto-detected server-side
      const res = await loginCarerix(username, password, 'company');
      const { accessToken, refreshToken, expiresAt, user } = res.data;
      saveSession(accessToken, refreshToken, expiresAt, user as UserSession);
      // Route by role
      const role = (user as {role?: string}).role || '';
      if (role === 'placement') router.push('/dashboard/roster/placement');
      else router.push('/dashboard/roster');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setError(e.response?.data?.error || e.message || 'Invalid credentials. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) { setError('Please enter your username or email address.'); return; }
    setResetLoading(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { username });
      setResetSent(true);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Could not send reset link. Please contact your administrator.');
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-navy flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex items-center gap-3 mb-10">
          <div className="flex flex-col gap-0.5">
            <div className="flex gap-1">
              <div className="w-3 h-3 bg-navy-200" style={{clipPath:'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)'}} />
              <div className="w-4 h-4 bg-yellow" style={{clipPath:'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)'}} />
            </div>
            <div className="flex gap-1">
              <div className="w-4 h-4 bg-yellow" style={{clipPath:'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)'}} />
              <div className="w-3 h-3 bg-navy-200" style={{clipPath:'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)'}} />
            </div>
          </div>
          <div>
            <div className="font-heading font-bold text-white text-2xl tracking-tight">confair</div>
            <div className="text-navy-200 text-xs font-light tracking-wider uppercase">recruitment made human</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-8 shadow-2xl">

          {/* Login mode */}
          {mode === 'login' && (
            <>
              <h1 className="font-heading font-bold text-navy text-xl mb-1">Welcome back</h1>
              <p className="text-navy-400 text-xs font-light mb-6">Sign in to your workspace</p>
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-5">
                  <p className="text-red-600 text-xs font-light">{error}</p>
                </div>
              )}
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold font-heading text-navy-400 uppercase tracking-wider mb-1.5">Username or email</label>
                  <input type="text" required autoComplete="username" value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="w-full border border-navy-100 rounded-lg px-3 py-2.5 text-sm text-navy focus:outline-none focus:border-cblue focus:ring-2 focus:ring-cblue/10 transition-all" />
                </div>
                <div>
                  <label className="block text-xs font-semibold font-heading text-navy-400 uppercase tracking-wider mb-1.5">Password</label>
                  <input type="password" required autoComplete="current-password" value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full border border-navy-100 rounded-lg px-3 py-2.5 text-sm text-navy focus:outline-none focus:border-cblue focus:ring-2 focus:ring-cblue/10 transition-all" />
                </div>
                <button type="submit" disabled={loading}
                  className="w-full btn-navy py-3 text-sm rounded-lg disabled:opacity-60 disabled:cursor-not-allowed mt-2">
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
              <div className="text-center mt-5">
                <button onClick={() => { setMode('forgot'); setError(''); }}
                  className="text-navy-400 text-xs font-light hover:text-navy transition-colors underline underline-offset-2">
                  Forgot your password?
                </button>
              </div>
            </>
          )}

          {/* Forgot password mode */}
          {mode === 'forgot' && !resetSent && (
            <>
              <h1 className="font-heading font-bold text-navy text-xl mb-1">Reset password</h1>
              <p className="text-navy-400 text-xs font-light mb-6">Enter your username or email and we&apos;ll send you a reset link.</p>
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-5">
                  <p className="text-red-600 text-xs font-light">{error}</p>
                </div>
              )}
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold font-heading text-navy-400 uppercase tracking-wider mb-1.5">Username or email</label>
                  <input type="text" required value={username} onChange={e => setUsername(e.target.value)}
                    className="w-full border border-navy-100 rounded-lg px-3 py-2.5 text-sm text-navy focus:outline-none focus:border-cblue focus:ring-2 focus:ring-cblue/10 transition-all" />
                </div>
                <button type="submit" disabled={resetLoading}
                  className="w-full btn-navy py-3 text-sm rounded-lg disabled:opacity-60 mt-2">
                  {resetLoading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
              <div className="text-center mt-5">
                <button onClick={() => { setMode('login'); setError(''); }}
                  className="text-navy-400 text-xs font-light hover:text-navy transition-colors">
                  ← Back to sign in
                </button>
              </div>
            </>
          )}

          {/* Reset sent */}
          {mode === 'forgot' && resetSent && (
            <>
              <div className="text-center py-4">
                <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2">
                    <polyline points="20,6 9,17 4,12" />
                  </svg>
                </div>
                <h2 className="font-heading font-bold text-navy text-base mb-2">Check your inbox</h2>
                <p className="text-navy-400 text-xs font-light leading-relaxed">
                  If an account exists for <span className="font-medium text-navy">{username}</span>, a password reset link has been sent.
                </p>
              </div>
              <div className="text-center mt-6">
                <button onClick={() => { setMode('login'); setResetSent(false); setError(''); }}
                  className="text-navy-400 text-xs font-light hover:text-navy transition-colors">
                  ← Back to sign in
                </button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-navy-400 text-xs mt-6 font-light">confair.com · Platform v1.0</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-navy flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-white/20 border-t-yellow rounded-full animate-spin" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
