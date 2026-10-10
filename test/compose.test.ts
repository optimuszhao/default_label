// 创作台 2.0 · 提示词编译器、诊断、种子数据的单元测试（不需要起服务）
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cleanPunctuation, compose, dedupeClauses, emptyRecipe, fillVariables, MAX_PROMPT_LENGTH, resolvePresets, templateVariables, togglePreset } from '../shared/compose.ts';
import { applyMoveToNegative, countActions, lint } from '../shared/lint.ts';
import { DEFAULT_CAPABILITIES, type Capabilities } from '../shared/operator.ts';
import type { Preset, PromptTemplate, Recipe } from '../shared/presets.ts';
import { SEED_PRESETS, SEED_TEMPLATES } from '../shared/seed.ts';

const catalog = new Map(SEED_PRESETS.map((preset) => [preset.slug, preset]));
const templates = new Map(SEED_TEMPLATES.map((template) => [template.id, template]));

/** comfyweb 的能力：不支持视频反向词、视频尺寸固定 */
const COMFY: Capabilities = {
  operator: 'comfyweb',
  image: { ...DEFAULT_CAPABILITIES.image, maxReferences: 1, strength: false, cfg: false },
  video: {
    ...DEFAULT_CAPABILITIES.video,
    lastFrame: false,
    cfg: false,
    steps: false,
    negativePrompt: false,
    durations: [4, 5, 6, 8, 10, 12, 15],
    resolutions: [],
    sizes: [
      { aspectRatio: '16:9', width: 1344, height: 768 },
      { aspectRatio: '9:16', width: 768, height: 1344 },
    ],
    sizeStep: 32,
  },
};

const recipe = (patch: Partial<Recipe> = {}): Recipe => ({ ...emptyRecipe('image'), ...patch });
const run = (r: Recipe, template?: PromptTemplate, caps: Capabilities = DEFAULT_CAPABILITIES) => compose({ recipe: r, template, catalog, caps });

describe('变量', () => {
  test('用户填写优先，其次默认值', () => {
    const t = templates.get('movie-poster')!;
    assert.equal(fillVariables('{主体}在{场景}', t, { 主体: '机器人' }), '机器人在燃烧的古城');
  });
  test('没有默认值时为空，并清理多余标点', () => {
    assert.equal(fillVariables('{甲}，{乙}，{丙}', { variables: [] }, { 甲: '猫', 丙: '狗' }), '猫，狗');
  });
  test('{{ 和 }} 是字面量', () => {
    assert.equal(fillVariables('{{不是变量}} {名字}', { variables: [] }, { 名字: '小明' }), '{不是变量} 小明');
  });
  test('变量名带空格或过长不识别', () => {
    assert.equal(fillVariables('{有 空格}', { variables: [] }, {}), '{有 空格}');
    assert.equal(fillVariables('{这是一个超过十六个字的非常非常长的变量名}', { variables: [] }, {}), '{这是一个超过十六个字的非常非常长的变量名}');
  });
  test('列出变量名并去重', () => {
    assert.deepEqual(templateVariables('{甲}和{乙}和{甲}{{丙}}'), ['甲', '乙']);
  });
  test('所有模板的变量都在 variables 里有说明', () => {
    for (const template of SEED_TEMPLATES) {
      for (const key of templateVariables(template.body)) {
        assert.ok(template.variables.some((v) => v.key === key), `${template.id} 缺少变量 ${key}`);
      }
    }
  });
});

describe('标点与去重', () => {
  test('清理连续和首尾标点', () => {
    assert.equal(cleanPunctuation('，，猫，，，狗，'), '猫，狗');
    assert.equal(cleanPunctuation('  猫 ， 狗 '), '猫，狗');
  });
  test('按短句去重，忽略大小写和空格', () => {
    assert.equal(dedupeClauses('浅景深，电影感，浅景深，35mm， 35MM'), '浅景深，电影感，35mm');
  });
});

describe('预设', () => {
  test('同一互斥组只保留最后选中的：先电影感再水墨 → 水墨', () => {
    const { presets } = resolvePresets(['style-cinematic', 'style-ink'], catalog, 'image');
    assert.deepEqual(presets.map((p) => p.slug), ['style-ink']);
  });
  test('togglePreset 选中时替换同组，再点一次取消', () => {
    let selected = togglePreset([], 'style-cinematic', catalog);
    selected = togglePreset(selected, 'light-golden', catalog);
    selected = togglePreset(selected, 'style-ink', catalog);
    assert.deepEqual(selected, ['light-golden', 'style-ink']);
    assert.deepEqual(togglePreset(selected, 'style-ink', catalog), ['light-golden']);
  });
  test('负向可以多选', () => {
    const selected = togglePreset(togglePreset([], 'neg-quality', catalog), 'neg-text', catalog);
    assert.deepEqual(selected, ['neg-quality', 'neg-text']);
  });
  test('运镜只适用视频，图片模式忽略并给出提示', () => {
    const result = run(recipe({ text: '一只猫', presets: ['camera-push'] }));
    assert.equal(result.prompt, '一只猫');
    assert.match(result.warnings.join(), /只适用于视频/);
  });
  test('suffix 按 构图 → 光线 → 色调 → 风格 排序', () => {
    const result = run(recipe({ text: '少女', presets: ['style-film', 'tone-warm', 'light-golden', 'shot-close'] }));
    const order = ['近景镜头', '黄金时刻', '暖色调', '胶片摄影'].map((word) => result.prompt.indexOf(word));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(result.prompt.startsWith('少女'));
  });
  test('停用的预设不生效', () => {
    const disabled = new Map(catalog);
    disabled.set('style-ink', { ...catalog.get('style-ink')!, enabled: false });
    const result = compose({ recipe: recipe({ text: '山', presets: ['style-ink'] }), catalog: disabled, caps: DEFAULT_CAPABILITIES });
    assert.equal(result.prompt, '山');
  });
  test('prefix 预设放在正文前', () => {
    const custom = new Map(catalog);
    custom.set('x-prefix', { ...catalog.get('style-ink')!, slug: 'x-prefix', group: 'x', position: 'prefix', prompt: '杰作' });
    const result = compose({ recipe: recipe({ text: '山', presets: ['x-prefix'] }), catalog: custom, caps: DEFAULT_CAPABILITIES });
    assert.ok(result.prompt.startsWith('杰作，山'));
  });
});

describe('编译', () => {
  test('模板 + 补充描述 + 模板预设', () => {
    const t = templates.get('movie-poster')!;
    const result = run(recipe({ templateId: t.id, vars: { 主体: '机甲少女' }, text: '背景有烟花' }), t);
    assert.ok(result.prompt.startsWith('机甲少女，置身于燃烧的古城'));
    assert.match(result.prompt, /背景有烟花/);
    assert.match(result.prompt, /电影感画面/);
    assert.equal(result.params.aspectRatio, '3:4', '模板里的竖版海报预设');
  });
  test('用户明确修改的参数优先于模板和预设', () => {
    const t = templates.get('movie-poster')!;
    const result = run(recipe({ templateId: t.id, overrides: { aspectRatio: '16:9', count: 2 } }), t);
    assert.equal(result.params.aspectRatio, '16:9');
    assert.equal(result.params.count, 2);
  });
  test('反向词合并用户、模板、预设并去重', () => {
    const result = run(recipe({ text: '人像', negative: '模糊，水印', presets: ['neg-quality', 'neg-text'] }));
    assert.equal(result.negativePrompt.split('，').filter((x) => x === '模糊').length, 1);
    assert.match(result.negativePrompt, /签名/);
  });
  test('算子不支持反向词：预设 fallback 改成正向约束并警告', () => {
    const result = run({ ...emptyRecipe('video'), text: '海浪拍打礁石', negative: '模糊', presets: ['neg-flicker'] }, undefined, COMFY);
    assert.equal(result.negativePrompt, '');
    assert.match(result.prompt, /画面稳定连贯/);
    assert.match(result.warnings.join(), /不支持反向提示词/);
  });
  test('视频尺寸用算子原生尺寸，时长收进支持范围', () => {
    const result = run({ ...emptyRecipe('video'), text: '海浪', overrides: { aspectRatio: '16:9', duration: 20 } }, undefined, COMFY);
    assert.equal(result.params.width, 1344);
    assert.equal(result.params.height, 768);
    assert.equal(result.params.duration, 15);
    assert.match(result.warnings.join(), /时长已调整为 15 秒/);
  });
  test('视频张数固定为 1', () => {
    const result = run({ ...emptyRecipe('video'), text: '海浪', overrides: { count: 4 } }, undefined, COMFY);
    assert.equal(result.params.count, 1);
  });
  test('图片张数不超过算子上限', () => {
    const result = run(recipe({ text: '猫', overrides: { count: 9 } }));
    assert.equal(result.params.count, 4);
  });
  test('锁定的种子原样带上，没锁时为 null', () => {
    assert.equal(run(recipe({ text: '猫', overrides: { seed: 42 } })).params.seed, 42);
    assert.equal(run(recipe({ text: '猫' })).params.seed, null);
  });
  test('步数只在算子支持时带上', () => {
    assert.equal(run(recipe({ text: '猫', overrides: { steps: 30 } })).params.steps, 30);
    assert.equal(run({ ...emptyRecipe('video'), text: '海', overrides: { steps: 30 } }, undefined, COMFY).params.steps, undefined);
  });
  test('超长时从末尾修饰片段删起，并警告', () => {
    const long = '很长的描述'.repeat(298);
    const result = run(recipe({ text: long, presets: ['style-cinematic', 'light-golden', 'tone-warm'] }));
    assert.ok(result.prompt.length <= MAX_PROMPT_LENGTH);
    assert.ok(result.prompt.startsWith('很长的描述'));
    assert.match(result.warnings.join(), /超过/);
  });
  test('同一组输入多次编译结果一致', () => {
    const r = recipe({ text: '猫', presets: ['style-ink', 'light-moon'] });
    assert.deepEqual(run(r), run(structuredClone(r)));
  });
  test('模板和模式不一致时提示', () => {
    const t = templates.get('product-360')!;
    assert.match(run(recipe({ templateId: t.id }), t).warnings.join(), /视频模板/);
  });
  test('运镜（旧参数）只在视频里带上', () => {
    assert.equal(run({ ...emptyRecipe('video'), text: '海', overrides: { cameraMotion: '推镜' } }, undefined, COMFY).params.cameraMotion, '推镜');
    assert.equal(run(recipe({ text: '海', overrides: { cameraMotion: '推镜' } })).params.cameraMotion, undefined);
  });
});

describe('诊断', () => {
  const hints = (r: Recipe, extra: Partial<Parameters<typeof lint>[1]> = {}) =>
    lint(r, { finalPrompt: r.text, presets: [], ...extra }).map((h) => h.code);

  test('提示词太短', () => {
    assert.ok(hints(recipe({ text: '猫' })).includes('too-short'));
    assert.ok(!hints(recipe({ text: '一只橘猫坐在窗台上晒太阳' })).includes('too-short'));
  });
  test('正向里的否定词，可一键移到反向', () => {
    const r = recipe({ text: '海边日落，不要有人物，暖色' });
    const hint = lint(r, { finalPrompt: r.text, presets: [] }).find((h) => h.code === 'negation')!;
    assert.ok(hint.fix);
    const fixed = applyMoveToNegative(r, hint.fix!.phrase, hint.fix!.replacement);
    assert.equal(fixed.text, '海边日落，暖色');
    assert.equal(fixed.negative, '有人物');
  });
  test('风格冲突', () => {
    assert.ok(hints(recipe({ text: '写实摄影风格的二次元少女' })).includes('style-conflict'));
    const ink = catalog.get('style-ink')!;
    assert.ok(hints(recipe({ text: '赛博朋克的霓虹街道' }), { presets: [ink] }).includes('style-conflict'));
  });
  test('视频没有动作', () => {
    assert.ok(hints({ ...emptyRecipe('video'), text: '雪山湖泊美景' }).includes('video-no-action'));
    assert.ok(!hints({ ...emptyRecipe('video'), text: '雪山湖泊，云层缓缓流动' }).includes('video-no-action'));
  });
  test('选了运镜预设就不算没有动作', () => {
    const push = catalog.get('camera-push')!;
    assert.ok(!hints({ ...emptyRecipe('video'), text: '雪山湖泊美景' }, { presets: [push] }).includes('video-no-action'));
  });
  test('长视频只有一个动作', () => {
    assert.ok(hints({ ...emptyRecipe('video'), text: '女孩慢慢走向海边', overrides: { duration: 10 } }).includes('long-video-one-action'));
  });
  test('图生视频复述首帧', () => {
    const text = '画面里有一位穿红色长裙的女孩站在金色麦田中央，远处是连绵的群山和夕阳，天空有粉紫色的晚霞，麦穗金黄饱满，她的头发很长很黑，裙摆很大，一切都非常美丽安静祥和温暖，像一幅油画一样的完美的黄昏';
    assert.ok(hints({ ...emptyRecipe('video'), text }, { hasFirstFrame: true }).includes('i2v-restate'));
  });
  test('动作计数按短句', () => {
    assert.equal(countActions('女孩走过街道，回头微笑，风吹起头发'), 3);
  });
});

describe('种子数据', () => {
  test('至少 70 个预设、22 个模板，slug 唯一', () => {
    assert.ok(SEED_PRESETS.length >= 70, `${SEED_PRESETS.length}`);
    assert.ok(SEED_TEMPLATES.length >= 22, `${SEED_TEMPLATES.length}`);
    assert.equal(new Set(SEED_PRESETS.map((p) => p.slug)).size, SEED_PRESETS.length);
    assert.equal(new Set(SEED_TEMPLATES.map((t) => t.id)).size, SEED_TEMPLATES.length);
  });
  test('模板引用的预设都存在，且适用于模板的模式', () => {
    for (const template of SEED_TEMPLATES) {
      for (const slug of template.presets) {
        const preset = catalog.get(slug);
        assert.ok(preset, `${template.id} 引用了不存在的预设 ${slug}`);
        assert.ok(preset.applies === 'both' || preset.applies === template.mode, `${template.id} 的预设 ${slug} 不适用于${template.mode}`);
      }
    }
  });
  test('所有模板用默认值都能编出非空提示词', () => {
    for (const template of SEED_TEMPLATES) {
      const result = compose({ recipe: { ...emptyRecipe(template.mode), templateId: template.id }, template, catalog, caps: COMFY });
      assert.ok(result.prompt.length > 10, template.id);
      assert.ok(!/[{}]/.test(result.prompt), `${template.id} 有没填的变量：${result.prompt}`);
    }
  });
  test('负向预设都有 fallback', () => {
    for (const preset of SEED_PRESETS.filter((p: Preset) => p.kind === 'negative')) assert.ok(preset.fallbackPrompt, preset.slug);
  });
  test('预设里没有品牌名或常见工作室名', () => {
    const banned = /皮克斯|迪士尼|吉卜力|宫崎骏|新海诚|漫威|Pixar|Disney|Ghibli/i;
    for (const preset of SEED_PRESETS) assert.doesNotMatch(preset.prompt + preset.name, banned, preset.slug);
    for (const template of SEED_TEMPLATES) assert.doesNotMatch(template.body + template.name, banned, template.id);
  });
});
