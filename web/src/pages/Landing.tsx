import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BookOpenText,
  Check,
  Clapperboard,
  Film,
  ImagePlus,
  Layers,
  ListOrdered,
  MessageSquareQuote,
  MousePointer2,
  Sparkles,
  Users,
} from 'lucide-react';
import { DotField } from '../components/DotField.tsx';
import { Logo } from '../components/ui.tsx';
import { useStore } from '../lib/store.ts';
import { cx, useReveal } from '../lib/util.ts';

const PROMPTS = [
  '黄昏下的赛博城市，镜头缓慢推进，霓虹倒映在雨后街道',
  '少女站在麦田中央回头微笑，风吹起她的红色围巾',
  '一只机械鸟穿过漂浮的图书馆，书页在空中翻飞',
  '雪山之巅，登山者插下旗帜，航拍环绕镜头',
];

function useTypewriter(lines: string[]) {
  const [state, setState] = useState({ line: 0, length: 0, deleting: false });
  useEffect(() => {
    const full = lines[state.line];
    const done = !state.deleting && state.length === full.length;
    const empty = state.deleting && state.length === 0;
    const delay = done ? 2200 : empty ? 300 : state.deleting ? 18 : 55;
    const timer = setTimeout(() => {
      setState((prev) => {
        if (done) return { ...prev, deleting: true };
        if (empty) return { line: (prev.line + 1) % lines.length, length: 0, deleting: false };
        return { ...prev, length: prev.length + (prev.deleting ? -1 : 1) };
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [state, lines]);
  return lines[state.line].slice(0, state.length);
}

function Nav() {
  const user = useStore((s) => s.user);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <header
      className={cx(
        'fixed inset-x-0 top-0 z-40 border-b transition-colors duration-300',
        scrolled ? 'border-line bg-ink/85 backdrop-blur-xl' : 'border-transparent',
      )}
    >
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="织影首页">
          <Logo />
        </Link>
        <div className="hidden items-center gap-7 text-[13px] text-fg-2 md:flex">
          <a href="#capabilities" className="hover:text-fg">能力</a>
          <a href="#story" className="hover:text-fg">故事工坊</a>
          <a href="#queue" className="hover:text-fg">任务队列</a>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <Link to="/studio/create" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-[13px] font-medium text-ink hover:bg-white">
              进入工作台 <ArrowRight className="size-3.5" />
            </Link>
          ) : (
            <>
              <Link to="/login" className="hidden h-8 items-center rounded-md px-3 text-[13px] text-fg-2 hover:text-fg sm:inline-flex">
                登录
              </Link>
              <Link to="/register" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-[13px] font-medium text-ink hover:bg-white">
                免费注册 <ArrowRight className="size-3.5" />
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

function HeroComposer({ to }: { to: string }) {
  const text = useTypewriter(PROMPTS);
  return (
    <div className="mx-auto w-full max-w-2xl rounded-xl border border-line-strong bg-ink-1/90 p-3 text-left shadow-[0_24px_64px_-16px_rgb(0_0_0/0.9)] backdrop-blur-md">
      <p className="min-h-[3rem] px-1 text-[15px] leading-relaxed text-fg">
        {text}
        <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent" />
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
          <span className="chip !h-7 !text-xs" data-active="true"><Film className="size-3.5" />视频</span>
          <span className="chip !h-7 !text-xs">16:9</span>
          <span className="chip !h-7 !text-xs">5s</span>
          <span className="chip !h-7 !text-xs hidden sm:inline-flex">1080P</span>
        </div>
        <Link to={to} aria-label="开始生成" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition hover:bg-accent-hover active:scale-95">
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}

/** 点阵占位画面，代替真实关键帧缩略图 */
function Frame({ label, done, className }: { label: string; done?: boolean; className?: string }) {
  return (
    <div className={cx('dots-bg relative flex items-end overflow-hidden rounded-md border border-line bg-ink-2', className)}>
      <span className={cx('m-1.5 rounded px-1 font-mono text-[10px]', done ? 'bg-accent/20 text-accent' : 'bg-black/40 text-fg-3')}>{label}</span>
    </div>
  );
}

const CAPABILITIES = [
  { icon: Sparkles, title: '文生图', desc: '定妆照、概念图、分镜关键帧' },
  { icon: ImagePlus, title: '图生图', desc: '以参考图重绘，保持角色一致' },
  { icon: Film, title: '文生视频', desc: '描述画面与运镜，直出 1080P 片段' },
  { icon: Clapperboard, title: '图生视频', desc: '关键帧做首帧，让画面动起来' },
];

const STEPS = [
  { icon: BookOpenText, title: '设定与大纲', desc: '一句话灵感扩写为完整故事' },
  { icon: Users, title: '角色', desc: '外貌 + 定妆照，跨镜头一致' },
  { icon: Layers, title: '章节场次', desc: '长篇拆成章节，无限追加' },
  { icon: MessageSquareQuote, title: '剧本台词', desc: '每场剧情与对白，标注情绪' },
  { icon: Clapperboard, title: '分镜', desc: '景别、运镜、时长逐镜可控' },
  { icon: Film, title: '成片', desc: '按时间线串联，带字幕预览' },
];

export default function Landing() {
  const ref = useReveal<HTMLDivElement>();
  const user = useStore((s) => s.user);
  const cta = user ? '/studio/create' : '/register';
  return (
    <div ref={ref} className="relative overflow-x-clip">
      <Nav />

      {/* Hero：可交互点阵画布 */}
      <section className="relative isolate flex min-h-[100svh] flex-col items-center justify-center px-4 pt-20 pb-16 text-center sm:px-6">
        <DotField />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,transparent_30%,var(--color-ink)_85%)]" />
        <span className="animate-fade-up inline-flex items-center gap-2 rounded-md border border-line bg-ink/70 px-2.5 py-1 font-mono text-[11px] tracking-wide text-fg-2 backdrop-blur">
          <span className="size-1.5 rounded-full bg-accent" />
          AI 影像创作平台 · 文生图 / 文生视频 / 故事分镜
        </span>
        <h1 className="animate-fade-up mt-6 max-w-4xl text-[2.6rem] leading-[1.08] font-semibold tracking-[-0.035em] sm:text-6xl lg:text-7xl" style={{ animationDelay: '80ms' }}>
          在画布上，
          <br />
          把故事<span className="text-accent">画</span>成电影
        </h1>
        <p className="animate-fade-up mt-5 max-w-lg text-[15px] leading-relaxed text-fg-2 sm:text-base" style={{ animationDelay: '160ms' }}>
          从一句灵感开始，一步步搭出章节、角色、台词与分镜，再逐镜生成画面和视频。
        </p>
        <div className="animate-fade-up mt-8 flex flex-wrap items-center justify-center gap-2.5" style={{ animationDelay: '240ms' }}>
          <Link to={cta} className="inline-flex h-11 items-center gap-2 rounded-lg bg-fg px-5 text-sm font-medium text-ink transition hover:bg-white active:scale-[0.98]">
            开始创作 <ArrowRight className="size-4" />
          </Link>
          <a href="#story" className="inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-ink/60 px-5 text-sm text-fg backdrop-blur transition hover:bg-white/[0.06]">
            看看故事工坊
          </a>
        </div>
        <div className="animate-fade-up mt-12 w-full" style={{ animationDelay: '320ms' }}>
          <HeroComposer to={cta} />
        </div>
        <p className="pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 items-center gap-1.5 font-mono text-[11px] text-fg-3 sm:flex">
          <MousePointer2 className="size-3" /> 移动鼠标，在点阵上作画
        </p>
      </section>

      {/* 能力 */}
      <section id="capabilities" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-20 sm:px-6 sm:py-24">
        <div data-reveal className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-accent">01 / CAPABILITIES</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-4xl">四种生成模式，一个输入框</h2>
          </div>
          <p className="max-w-sm text-sm text-fg-3">加参考图自动切换图生图，加首帧自动切换图生视频，不用记模式。</p>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4">
          {CAPABILITIES.map((item, index) => (
            <div key={item.title} data-reveal style={{ ['--reveal-delay' as string]: `${index * 60}ms` }} className="bg-ink p-5 sm:p-6">
              <item.icon className="size-5 text-accent" />
              <h3 className="mt-6 text-[15px] font-medium">{item.title}</h3>
              <p className="mt-1 text-[13px] text-fg-3">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 故事工坊：产品界面示意 */}
      <section id="story" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-20 sm:px-6 sm:py-24">
        <div data-reveal className="max-w-2xl">
          <p className="font-mono text-xs text-accent">02 / STORY WORKSHOP</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-4xl">再长的故事，也一眼看清全貌</h2>
          <p className="mt-3 text-sm leading-relaxed text-fg-3 sm:text-[15px]">六个步骤带你从零搭起完整脚本。总览页把章节、场次、关键帧和进度放在同一屏里。</p>
        </div>

        <div data-reveal className="mt-8 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          {STEPS.map((step, index) => (
            <div key={step.title} className="bg-ink p-4">
              <div className="flex items-center gap-2">
                <span className={cx('flex size-5 items-center justify-center rounded font-mono text-[10px]', index < 3 ? 'bg-accent text-white' : 'bg-white/[0.08] text-fg-2')}>
                  {index < 3 ? <Check className="size-3" /> : index + 1}
                </span>
                <step.icon className="size-3.5 text-fg-3" />
              </div>
              <p className="mt-3 text-[13px] font-medium">{step.title}</p>
              <p className="mt-0.5 text-xs text-fg-3">{step.desc}</p>
            </div>
          ))}
        </div>

        <div data-reveal className="panel mt-3 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[13px]">
            <span className="font-medium">回声之城 · 总览</span>
            <span className="font-mono text-xs text-fg-3">3 章 · 9 场 · 42 镜 · 关键帧 18/42</span>
          </div>
          <div className="grid md:grid-cols-[200px_minmax(0,1fr)]">
            <div className="hidden border-r border-line p-3 text-[13px] md:block">
              {['第一章 · 静默之城', '第二章 · 地下回响', '第三章 · 钟塔之巅'].map((title, index) => (
                <div key={title} className="mb-2">
                  <p className={cx('rounded px-2 py-1.5', index === 0 ? 'bg-white/[0.06] text-fg' : 'text-fg-3')}>{title}</p>
                  {index === 0 && (
                    <div className="mt-1 space-y-0.5 pl-3 text-xs text-fg-3">
                      <p className="flex justify-between px-2 py-1"><span>1-1 废墟街道</span><span className="text-accent">6/6</span></p>
                      <p className="flex justify-between px-2 py-1"><span>1-2 地铁隧道</span><span>3/5</span></p>
                      <p className="flex justify-between px-2 py-1"><span>1-3 天台</span><span>0/4</span></p>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="space-y-4 p-3 sm:p-4">
              {[
                { title: '1-1 废墟街道 · 黄昏', done: 6, total: 6 },
                { title: '1-2 地铁隧道 · 深夜', done: 3, total: 5 },
              ].map((scene) => (
                <div key={scene.title}>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-fg-2">{scene.title}</span>
                    <span className="font-mono text-fg-3">{scene.done}/{scene.total}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                    {Array.from({ length: 6 }, (_, i) => (
                      <Frame key={i} label={i < scene.total ? `#${String(i + 1).padStart(2, '0')}` : '+'} done={i < scene.done} className={cx('aspect-video', i >= scene.total && 'border-dashed opacity-50')} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 队列 */}
      <section id="queue" className="mx-auto grid max-w-6xl scroll-mt-16 items-center gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2">
        <div data-reveal>
          <p className="font-mono text-xs text-accent">03 / TASK QUEUE</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-4xl">算力时有时无，交给队列</h2>
          <p className="mt-3 text-sm leading-relaxed text-fg-3 sm:text-[15px]">编辑好的任务统一排队。服务可用时自动提交，不可用时定时重试，也能随时手动启动、暂停、调整优先级。</p>
          <ul className="mt-6 space-y-2.5 text-[13px] text-fg-2">
            {['定时检查生成服务，恢复后自动继续', '失败自动重试，超过次数才标记失败', '整章分镜一键入队，进度实时推送'].map((item) => (
              <li key={item} className="flex items-center gap-2.5">
                <ListOrdered className="size-3.5 text-accent" /> {item}
              </li>
            ))}
          </ul>
        </div>
        <div data-reveal className="panel divide-y divide-line">
          {[
            { title: '1-1 · #01 关键帧', status: '已完成', tone: 'text-ok', progress: 1 },
            { title: '1-1 · #01 视频', status: '生成中 62%', tone: 'text-accent', progress: 0.62 },
            { title: '1-1 · #02 视频', status: '排队中', tone: 'text-fg-2', progress: 0 },
            { title: '定妆照 · 林昔', status: '等待服务', tone: 'text-warn', progress: 0 },
          ].map((item, index) => (
            <div key={item.title} className="flex items-center gap-3 px-4 py-3">
              <Frame label={`#${index + 1}`} done={item.progress === 1} className="h-9 w-14 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px]">{item.title}</p>
                <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full bg-accent" style={{ width: `${item.progress * 100}%` }} />
                </div>
              </div>
              <span className={cx('font-mono text-xs whitespace-nowrap', item.tone)}>{item.status}</span>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-20 sm:px-6">
        <div data-reveal className="relative isolate mx-auto max-w-6xl overflow-hidden rounded-xl border border-line">
          <DotField spacing={18} idle={false} />
          <div className="relative flex flex-col items-center px-6 py-16 text-center sm:py-20">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">现在，画下你的第一个镜头</h2>
            <p className="mt-3 text-sm text-fg-3">注册即可使用全部创作功能</p>
            <Link to={cta} className="mt-7 inline-flex h-11 items-center gap-2 rounded-lg bg-fg px-5 text-sm font-medium text-ink transition hover:bg-white active:scale-[0.98]">
              开始创作 <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-xs text-fg-3 sm:flex-row">
          <Logo />
          <p>© {new Date().getFullYear()} 织影 Weave</p>
        </div>
      </footer>
    </div>
  );
}
