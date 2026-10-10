import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BookOpenText,
  Clapperboard,
  Film,
  ImagePlus,
  Layers,
  ListOrdered,
  MessageSquareQuote,
  Sparkles,
  Users,
  Wand2,
} from 'lucide-react';
import { Logo } from '../components/ui.tsx';
import { Scene, SCENES } from '../components/Scene.tsx';
import { useStore } from '../lib/store.ts';
import { cx, useReveal } from '../lib/util.ts';

const PROMPTS = [
  '黄昏下的赛博城市，镜头缓慢推进，霓虹倒映在雨后街道',
  '少女站在麦田中央回头微笑，风吹起她的红色围巾，电影感',
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
        'fixed inset-x-0 top-0 z-40 transition-[background,border-color,backdrop-filter] duration-500',
        scrolled ? 'glass border-x-0 border-t-0' : 'border-b border-transparent',
      )}
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="织影首页">
          <Logo />
        </Link>
        <div className="hidden items-center gap-8 text-sm text-fg-2 md:flex">
          <a href="#capabilities" className="transition-colors hover:text-fg">能力</a>
          <a href="#story" className="transition-colors hover:text-fg">故事工坊</a>
          <a href="#queue" className="transition-colors hover:text-fg">任务队列</a>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <Link
              to="/studio/create"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-fg px-4 text-sm font-medium text-ink transition hover:bg-white"
            >
              进入工作台 <ArrowRight className="size-4" />
            </Link>
          ) : (
            <>
              <Link to="/login" className="hidden h-9 items-center rounded-full px-4 text-sm text-fg-2 hover:text-fg sm:inline-flex">
                登录
              </Link>
              <Link
                to="/register"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-fg px-4 text-sm font-medium text-ink transition hover:bg-white"
              >
                开始创作 <ArrowRight className="size-4" />
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

function Aurora() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-[10%] -top-[20%] size-[60vmax] rounded-full bg-violet/30 blur-[120px] animate-float" />
      <div
        className="absolute -right-[15%] top-[10%] size-[50vmax] rounded-full bg-cyan/20 blur-[120px] animate-float"
        style={{ animationDelay: '-4s' }}
      />
      <div
        className="absolute bottom-[-30%] left-[30%] size-[45vmax] rounded-full bg-pink/20 blur-[120px] animate-float"
        style={{ animationDelay: '-8s' }}
      />
      <div className="grid-lines absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="noise absolute inset-0 opacity-[0.06]" />
    </div>
  );
}

function HeroComposer() {
  const text = useTypewriter(PROMPTS);
  return (
    <div className="glass ring-brand mx-auto w-full max-w-2xl rounded-3xl p-3 text-left shadow-[0_30px_120px_-30px_rgb(139_92_246/0.6)] sm:p-4">
      <div className="flex items-start gap-3">
        <div className="hidden size-14 shrink-0 overflow-hidden rounded-xl sm:block">
          <Scene index={2} showCaption={false} className="size-full" animated={false} />
        </div>
        <p className="min-h-[3.25rem] flex-1 text-[15px] leading-relaxed text-fg sm:text-base">
          {text}
          <span className="ml-0.5 inline-block h-5 w-[2px] translate-y-1 animate-pulse bg-cyan" />
        </p>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
          <span className="chip" data-active="true"><Film className="size-3.5" />视频生成</span>
          <span className="chip">16:9</span>
          <span className="chip">5s</span>
          <span className="chip hidden sm:inline-flex">1080P</span>
        </div>
        <Link
          to="/studio/create"
          aria-label="生成"
          className="bg-brand inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white shadow-lg transition hover:brightness-110 active:scale-95"
        >
          <ArrowRight className="size-5" />
        </Link>
      </div>
    </div>
  );
}

function Marquee({ reverse, offset }: { reverse?: boolean; offset: number }) {
  const items = [...SCENES.keys()].map((i) => (i + offset) % SCENES.length);
  const loop = [...items, ...items];
  return (
    <div className="group relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
      <div
        className="flex w-max gap-3 animate-marquee group-hover:[animation-play-state:paused] sm:gap-4"
        style={{ animationDirection: reverse ? 'reverse' : 'normal' }}
      >
        {loop.map((sceneIndex, i) => (
          <Scene
            key={i}
            index={sceneIndex}
            showPlay
            animated={false}
            className="aspect-video w-64 shrink-0 rounded-2xl sm:w-80 lg:w-96"
          />
        ))}
      </div>
    </div>
  );
}

const CAPABILITIES = [
  { icon: Film, title: '文生视频', desc: '一句话描述画面与运镜，生成 1080P 电影级视频片段，支持多种画幅与时长。', scene: 0 },
  { icon: Clapperboard, title: '图生视频', desc: '上传首帧或使用生成的关键帧，让静态画面动起来，角色与构图保持一致。', scene: 1 },
  { icon: Sparkles, title: '文生图', desc: '高质量图像生成，适合定妆照、概念设计、分镜关键帧。', scene: 2 },
  { icon: ImagePlus, title: '图生图', desc: '以参考图为基础重绘，控制风格、构图与角色一致性。', scene: 5 },
];

const STORY_STEPS = [
  { icon: BookOpenText, title: '故事大纲', desc: '一句话灵感扩写为完整的世界观与起承转合' },
  { icon: Users, title: '角色设定', desc: '外貌描述 + 定妆照，跨镜头保持角色一致' },
  { icon: Layers, title: '章节与剧本', desc: '长篇故事拆分章节、场次，支持无限扩展' },
  { icon: MessageSquareQuote, title: '台词对白', desc: 'AI 编写对白，标注情绪，生成字幕' },
  { icon: Clapperboard, title: '分镜设计', desc: '景别、运镜、时长逐镜头可控，一键批量生成' },
  { icon: Film, title: '成片预览', desc: '按时间线串联所有镜头，实时预览整部作品' },
];

const QUEUE_DEMO = [
  { title: '第一章 · 镜头 01 关键帧', status: '已完成', tone: 'text-ok', progress: 1 },
  { title: '第一章 · 镜头 01 视频', status: '生成中', tone: 'text-violet', progress: 0.62 },
  { title: '第一章 · 镜头 02 视频', status: '排队中', tone: 'text-cyan', progress: 0 },
  { title: '角色定妆照 · 林昔', status: '等待服务', tone: 'text-warn', progress: 0 },
];

export default function Landing() {
  const ref = useReveal<HTMLDivElement>();
  const user = useStore((s) => s.user);
  const cta = user ? '/studio/create' : '/register';
  return (
    <div ref={ref} className="relative overflow-x-clip">
      <Nav />

      {/* Hero */}
      <section className="relative isolate flex min-h-[100svh] flex-col items-center justify-center px-4 pt-24 pb-16 text-center sm:px-6">
        <Aurora />
        <div className="animate-fade-up">
          <span className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-fg-2">
            <span className="bg-brand size-1.5 rounded-full" />
            多镜头叙事 · 文生图 · 文生视频 · 图生视频
          </span>
        </div>
        <h1
          className="mt-7 max-w-5xl text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.03em] animate-fade-up sm:text-7xl lg:text-[5.5rem]"
          style={{ animationDelay: '80ms' }}
        >
          一句话，
          <br />
          <span className="text-gradient">织成一部电影</span>
        </h1>
        <p
          className="mt-6 max-w-xl text-[15px] leading-relaxed text-fg-2 animate-fade-up sm:text-lg"
          style={{ animationDelay: '160ms' }}
        >
          从灵感、大纲、角色、台词到分镜与成片，织影把 AI 图像与视频生成串成一条完整的创作流水线。
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3 animate-fade-up" style={{ animationDelay: '240ms' }}>
          <Link
            to={cta}
            className="bg-brand inline-flex h-12 items-center gap-2 rounded-full px-7 text-[15px] font-medium text-white shadow-[0_10px_40px_-10px_rgb(139_92_246/0.8)] transition hover:brightness-110 active:scale-[0.98]"
          >
            免费开始创作 <ArrowRight className="size-4" />
          </Link>
          <a
            href="#story"
            className="glass inline-flex h-12 items-center gap-2 rounded-full px-6 text-[15px] text-fg transition hover:bg-white/10"
          >
            <Wand2 className="size-4" /> 了解故事工坊
          </a>
        </div>
        <div className="mt-14 w-full animate-fade-up" style={{ animationDelay: '320ms' }}>
          <HeroComposer />
        </div>
      </section>

      {/* Showcase marquee */}
      <section className="space-y-3 pb-24 sm:space-y-4">
        <Marquee offset={0} />
        <Marquee offset={4} reverse />
      </section>

      {/* Capabilities */}
      <section id="capabilities" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 sm:py-28">
        <div className="max-w-2xl" data-reveal>
          <p className="text-sm font-medium text-cyan">CAPABILITIES</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">四种生成模式，一个工作台</h2>
          <p className="mt-4 text-fg-2 sm:text-lg">文字与图像自由组合，从一张概念图到一段镜头，所见即所得。</p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {CAPABILITIES.map((item, index) => (
            <div
              key={item.title}
              data-reveal
              style={{ ['--reveal-delay' as string]: `${index * 80}ms` }}
              className="panel group overflow-hidden transition-colors duration-500 hover:border-line-strong"
            >
              <Scene
                index={item.scene}
                showCaption={false}
                className="aspect-[16/8] transition-transform duration-[1.2s] ease-[var(--ease-out-expo)] group-hover:scale-[1.04]"
              />
              <div className="flex items-start gap-4 p-5 sm:p-6">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                  <item.icon className="size-5" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">{item.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-fg-2">{item.desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Story workshop */}
      <section id="story" className="relative scroll-mt-20 py-20 sm:py-28">
        <div className="pointer-events-none absolute inset-x-0 top-1/3 -z-10 mx-auto h-96 max-w-4xl rounded-full bg-violet/15 blur-[120px]" />
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mx-auto max-w-3xl text-center" data-reveal>
            <p className="text-sm font-medium text-pink">STORY WORKSHOP</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">
              从一个念头，
              <br className="sm:hidden" />
              到一部完整的故事
            </h2>
            <p className="mt-4 text-fg-2 sm:text-lg">
              故事工坊用“章节 → 场次 → 镜头”的结构组织长篇内容，AI 辅助每一步，镜头再多也井井有条。
            </p>
          </div>

          <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STORY_STEPS.map((step, index) => (
              <div
                key={step.title}
                data-reveal
                style={{ ['--reveal-delay' as string]: `${index * 60}ms` }}
                className="panel relative overflow-hidden p-5 sm:p-6"
              >
                <span className="absolute right-5 top-4 font-mono text-5xl font-bold text-white/[0.04]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <step.icon className="size-6 text-cyan" />
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-sm text-fg-2">{step.desc}</p>
              </div>
            ))}
          </div>

          {/* storyboard strip */}
          <div className="panel mt-6 overflow-hidden p-4 sm:p-6" data-reveal>
            <div className="mb-4 flex items-center justify-between text-sm">
              <span className="font-medium">第一章 · 静默之城</span>
              <span className="text-fg-3">6 个镜头 · 00:25</span>
            </div>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-6 sm:px-0">
              {['远景 · 升降', '全景 · 跟', '近景 · 推', '特写 · 固定', '中景 · 摇', '远景 · 拉'].map((label, index) => (
                <div key={label} className="w-40 shrink-0 sm:w-auto">
                  <Scene index={index + 1} showCaption={false} animated={false} className="aspect-video rounded-xl" />
                  <p className="mt-2 text-xs text-fg-3">
                    <span className="font-mono text-fg-2">#{index + 1}</span> {label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Queue */}
      <section id="queue" className="mx-auto grid max-w-7xl scroll-mt-20 items-center gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-2">
        <div data-reveal>
          <p className="text-sm font-medium text-lime">TASK QUEUE</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">算力时有时无？交给队列</h2>
          <p className="mt-4 text-fg-2 sm:text-lg">
            编辑好的任务统一进入队列。生成服务可用时自动提交，不可用时定时重试；也可以随时手动启动、暂停或调整优先级。
          </p>
          <ul className="mt-8 space-y-3 text-sm text-fg-2">
            {['定时轮询生成服务，恢复后自动继续', '失败自动重试，指数退避不刷屏', '批量提交整章分镜，进度实时推送'].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <ListOrdered className="size-4 text-lime" /> {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="panel p-3 sm:p-4" data-reveal>
          {QUEUE_DEMO.map((item, index) => (
            <div key={item.title} className={cx('flex items-center gap-3 rounded-xl p-3', index % 2 === 0 && 'bg-white/[0.02]')}>
              <Scene index={index + 3} showCaption={false} animated={false} className="size-12 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{item.title}</p>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="bg-brand h-full rounded-full" style={{ width: `${item.progress * 100}%` }} />
                </div>
              </div>
              <span className={cx('text-xs whitespace-nowrap', item.tone)}>{item.status}</span>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-24 sm:px-6">
        <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[2rem] border border-line" data-reveal>
          <div className="absolute inset-0">
            <Scene index={4} showCaption={false} className="size-full" />
          </div>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative flex flex-col items-center px-6 py-20 text-center sm:py-28">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-6xl">现在，开始你的第一个镜头</h2>
            <p className="mt-4 max-w-lg text-white/75">注册即可使用全部创作功能。</p>
            <Link
              to={cta}
              className="mt-8 inline-flex h-12 items-center gap-2 rounded-full bg-white px-7 text-[15px] font-medium text-ink transition hover:bg-white/90 active:scale-[0.98]"
            >
              开始创作 <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line px-4 py-10 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-sm text-fg-3 sm:flex-row">
          <Logo />
          <p>© {new Date().getFullYear()} 织影 Weave · AI 影像创作平台</p>
        </div>
      </footer>
    </div>
  );
}
