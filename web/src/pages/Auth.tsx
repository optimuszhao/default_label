import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Logo } from '../components/ui.tsx';
import { Scene } from '../components/Scene.tsx';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.ts';

export default function Auth({ mode }: { mode: 'login' | 'register' }) {
  const user = useStore((s) => s.user);
  const setSession = useStore((s) => s.setSession);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const next = params.get('next') || '/studio/create';

  if (user) return <Navigate to={next} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const session =
        mode === 'login' ? await api.login(email, password) : await api.register(email, name, password);
      setSession(session.user, session.settings);
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const isLogin = mode === 'login';
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden lg:block">
        <div className="absolute inset-0">
          <Scene index={4} showCaption={false} className="size-full" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-r from-black/20 to-ink" />
        <div className="absolute bottom-12 left-12 max-w-md">
          <p className="text-4xl font-semibold leading-tight tracking-tight">
            每个故事，
            <br />
            <span className="text-gradient">都值得被看见</span>
          </p>
          <p className="mt-4 text-fg-2">大纲 · 角色 · 台词 · 分镜 · 成片，一站完成。</p>
        </div>
      </div>

      <div className="relative flex flex-col px-5 py-6 sm:px-10">
        <div className="pointer-events-none absolute -top-40 right-0 size-96 rounded-full bg-violet/20 blur-[120px] lg:hidden" />
        <Link to="/" className="self-start">
          <Logo />
        </Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="text-3xl font-semibold tracking-tight animate-fade-up">{isLogin ? '欢迎回来' : '创建账号'}</h1>
          <p className="mt-2 text-sm text-fg-3 animate-fade-up">
            {isLogin ? '登录后继续你的创作' : '注册即可开始生成图片与视频'}
          </p>
          <form onSubmit={submit} className="mt-8 space-y-4 animate-fade-up" style={{ animationDelay: '80ms' }}>
            {!isLogin && (
              <div>
                <label className="label" htmlFor="name">昵称</label>
                <input id="name" className="field h-12" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoComplete="nickname" placeholder="你的创作者名字" />
              </div>
            )}
            <div>
              <label className="label" htmlFor="email">邮箱</label>
              <input id="email" type="email" className="field h-12" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" />
            </div>
            <div>
              <label className="label" htmlFor="password">密码</label>
              <input
                id="password"
                type="password"
                className="field h-12"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                placeholder="至少 6 位"
              />
            </div>
            {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
            <Button type="submit" variant="brand" size="lg" className="w-full" loading={loading}>
              {isLogin ? '登录' : '注册并开始'}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-fg-3">
            {isLogin ? '还没有账号？' : '已有账号？'}
            <Link to={`${isLogin ? '/register' : '/login'}${params.toString() ? `?${params}` : ''}`} className="ml-1 text-fg hover:text-cyan">
              {isLogin ? '立即注册' : '去登录'}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
