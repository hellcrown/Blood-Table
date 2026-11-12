/**
 * 你画我猜 · 引擎单测：轮转/选词/猜词判定/计分/提示/笔画清洗/离场与断线/终局排名/视图隐私。
 * rng 固定为 0：每档候选取词库该档第一个未出过的词（第 1 回合 猫/恐龙/打喷嚏，第 2 回合 狗/袋鼠/打哈欠）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDrawView,
  createDrawGame,
  dGuess,
  dLeave,
  dPick,
  drawAbort,
  drawForceEnd,
  drawTick,
  dStroke,
  maskDrawAnswer,
  resolveCycles,
  resolveTurnSec,
  type DrawState,
} from '../src/draw/engine';
import { drawDrawerShare, drawGuessPoints, normalizeGuess, DRAW_MAX_POINTS } from '@shared/drawProtocol';

const NOW = 1_000_000;
const zero = (): number => 0;
const PLAYERS = [
  { id: 'a', name: '甲', seat: 0 },
  { id: 'b', name: '乙', seat: 1 },
  { id: 'c', name: '丙', seat: 2 },
  { id: 'd', name: '丁', seat: 3 },
];

function game(n = 3, opts: { turnSec?: number; cycles?: number } = {}): DrawState {
  return createDrawGame(PLAYERS.slice(0, n), NOW, opts, zero);
}
const everyone = (s: DrawState): Set<string> => new Set(s.players.map((p) => p.id));
const view = (s: DrawState, id: string) => buildDrawView(s, id, 'TEST', 'a', everyone(s), NOW);

describe('建局与轮转', () => {
  it('按座位排期 × 每人次数；首回合座位最小者选词；候选三档各一且 15 秒选词', () => {
    const s = createDrawGame([PLAYERS[2]!, PLAYERS[0]!, PLAYERS[1]!], NOW, { cycles: 2 }, zero);
    expect(s.players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(s.schedule).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    expect(s.phase).toBe('choosing');
    expect(s.turn.drawerId).toBe('a');
    expect(s.turn.no).toBe(1);
    expect(s.turn.choices.map((c) => [c.word, c.d])).toEqual([
      ['猫', 1],
      ['恐龙', 2],
      ['打喷嚏', 3],
    ]);
    expect(s.turn.deadline).toBe(NOW + 15_000);
    expect(view(s, 'a').totalTurns).toBe(6);
  });

  it('设置口径：0/非选项值回落默认（80 秒、每人 2 次）', () => {
    expect(resolveTurnSec(0)).toBe(80);
    expect(resolveTurnSec(77)).toBe(80);
    expect(resolveTurnSec(120)).toBe(120);
    expect(resolveCycles(0)).toBe(2);
    expect(resolveCycles(9)).toBe(2);
    expect(resolveCycles(3)).toBe(3);
    expect(game(2, { turnSec: 60 }).turn.turnMs).toBe(60_000);
  });

  it('选词：非画手忽略、越界报错；选中后进入作画，三字及以上的词设半程揭字', () => {
    const s = game();
    expect(dPick(s, 'b', 0, NOW)).toBe(false);
    expect(() => dPick(s, 'a', 3, NOW)).toThrow(/选词/);
    expect(dPick(s, 'a', 0, NOW)).toBe(true); // 猫（1 字）
    expect(s.phase).toBe('drawing');
    expect(s.turn.deadline).toBe(NOW + 80_000);
    expect(s.turn.hintAt).toBe(0);
    const s2 = game();
    dPick(s2, 'a', 2, NOW); // 打喷嚏（3 字）
    expect(s2.turn.hintAt).toBe(NOW + 40_000);
  });
});

describe('视图隐私', () => {
  it('候选只给选词中的画手；答案只给画手；猜词者/观战者看掩码；日志不含答案', () => {
    const s = game();
    expect(view(s, 'a').choices?.length).toBe(3);
    expect(view(s, 'b').choices).toBeNull();
    expect(view(s, 'zz').choices).toBeNull();
    dPick(s, 'a', 2, NOW);
    expect(view(s, 'a').word).toBe('打喷嚏');
    expect(view(s, 'a').hint).toBeNull();
    for (const id of ['b', 'zz']) {
      const v = view(s, id);
      expect(v.word).toBeNull();
      expect(v.hint).toBe('＿＿＿');
      expect(v.wordLen).toBe(3);
      expect(v.category).toBe('动作');
      expect(JSON.stringify(v)).not.toContain('打喷嚏');
    }
    expect(view(s, 'zz').spectator).toBe(true);
    expect(s.log.map((l) => l.text).join()).not.toContain('打喷嚏');
  });

  it('猜对后看得到答案；揭晓后全员可见答案', () => {
    const s = game();
    dPick(s, 'a', 0, NOW);
    dGuess(s, 'b', '猫', NOW + 1000);
    expect(view(s, 'b').word).toBe('猫');
    expect(view(s, 'c').word).toBeNull();
    dGuess(s, 'c', '猫', NOW + 2000); // 全员猜对 → 揭晓
    expect(s.phase).toBe('reveal');
    expect(view(s, 'zz').word).toBe('猫');
  });
});

describe('猜词判定与计分', () => {
  it('猜错公开；接近（包含答案/两字以上片段/差一个字）只给本人；归一化与别称都算猜对', () => {
    const s = game(4);
    dPick(s, 'a', 2, NOW); // 打喷嚏
    dGuess(s, 'b', '咳嗽', NOW);
    expect(view(s, 'c').feed.some((f) => f.kind === 'guess' && f.text === '咳嗽')).toBe(true);
    dGuess(s, 'b', '打喷涕', NOW); // 差一个字
    dGuess(s, 'c', '喷嚏', NOW); // 两字片段
    expect(view(s, 'b').feed.some((f) => f.kind === 'close' && f.text.includes('打喷涕'))).toBe(true);
    expect(view(s, 'c').feed.some((f) => f.text.includes('打喷涕'))).toBe(false);
    expect(view(s, 'a').feed.some((f) => f.text.includes('打喷涕'))).toBe(false);
    expect(view(s, 'c').feed.some((f) => f.kind === 'close' && f.text.includes('喷嚏'))).toBe(true);
    dGuess(s, 'd', ' 打 喷 嚏！', NOW + 40_000); // 空格/全角标点归一化
    expect(s.turn.solved.map((x) => x.id)).toEqual(['d']);

    const s2 = game();
    dPick(s2, 'a', 0, NOW); // 猫：别称「猫咪」也算对，「黑猫」只是接近
    dGuess(s2, 'b', '黑猫', NOW);
    expect(s2.turn.solved).toHaveLength(0);
    dGuess(s2, 'b', '猫咪', NOW);
    expect(s2.turn.solved.map((x) => x.id)).toEqual(['b']);
  });

  it('单字别称不触发「接近」（鸡蛋 ≠ 公鸡），但单字词本身参与包含判定', () => {
    const s = game();
    dPick(s, 'a', 0, NOW);
    s.turn.word = { word: '公鸡', cat: '动物', d: 1 };
    dGuess(s, 'b', '鸡蛋', NOW);
    expect(view(s, 'b').feed.at(-1)?.kind).toBe('guess');
    dGuess(s, 'b', '大公鸡', NOW); // 别称完全命中
    expect(s.turn.solved.map((x) => x.id)).toEqual(['b']);
  });

  it('计分：猜对 (40+60×剩余比例)×倍率，画手每人 +25×倍率；全员猜对提前揭晓', () => {
    expect(drawGuessPoints(80_000, 80_000, 1)).toBe(100);
    expect(drawGuessPoints(40_000, 80_000, 1)).toBe(70);
    expect(drawGuessPoints(0, 80_000, 1)).toBe(40);
    expect(drawGuessPoints(80_000, 80_000, 3)).toBe(200);
    expect(drawDrawerShare(2)).toBe(38);
    const s = game();
    dPick(s, 'a', 1, NOW); // 恐龙（中等 ×1.5）
    dGuess(s, 'b', '恐龙', NOW); // 满时 → 150
    dGuess(s, 'c', '霸王龙', NOW + 40_000); // 别称；半程 → 105
    const pts = Object.fromEntries(s.players.map((p) => [p.id, p.score]));
    expect(pts).toEqual({ a: 76, b: 150, c: 105 });
    expect(s.phase).toBe('reveal');
    expect(s.turn.endReason).toBe('all');
    expect(view(s, 'zz').players.find((p) => p.id === 'a')?.gained).toBe(76);
    expect(s.history[0]).toMatchObject({ drawerId: 'a', word: '恐龙', solvedIds: ['b', 'c'], endReason: 'all' });
  });

  it('猜对后的发言只对画手与已猜对者可见，回合结束后公开；画手选词/作画中禁言', () => {
    const s = game(4);
    expect(() => dGuess(s, 'a', '我选猫', NOW)).toThrow(/画手/);
    dPick(s, 'a', 0, NOW);
    expect(() => dGuess(s, 'a', '猫', NOW)).toThrow(/画手/);
    dGuess(s, 'b', '猫', NOW);
    dGuess(s, 'b', '好简单', NOW);
    expect(view(s, 'a').feed.some((f) => f.text === '好简单')).toBe(true);
    expect(view(s, 'c').feed.some((f) => f.text === '好简单')).toBe(false);
    expect(view(s, 'zz').feed.some((f) => f.text === '好简单')).toBe(false);
    expect(view(s, 'c').feed.some((f) => f.kind === 'solved' && f.name === '乙')).toBe(true);
    dGuess(s, 'c', '猫', NOW);
    expect(view(s, 'c').feed.some((f) => f.text === '好简单')).toBe(true); // 猜对后加入「知情圈」
    dGuess(s, 'd', '猫', NOW); // 全员猜对 → 揭晓
    expect(view(s, 'zz').feed.some((f) => f.text === '好简单')).toBe(true);
  });

  it('归一化：全半角/大小写/空格/标点不敏感', () => {
    expect(normalizeGuess(' ＥＴ！ ')).toBe('et');
    expect(normalizeGuess('苹 果~')).toBe('苹果');
  });
});

describe('计时、提示与回合推进', () => {
  it('选词超时随机选词；作画超时揭晓；揭晓 5 秒后轮到下一位画手', () => {
    const s = game();
    expect(drawTick(s, NOW + 14_000, everyone(s), zero)).toBe(false);
    expect(drawTick(s, NOW + 15_000, everyone(s), zero)).toBe(true);
    expect(s.phase).toBe('drawing');
    expect(s.turn.word?.word).toBe('猫'); // rng=0 → 第一个候选
    expect(s.feed.some((f) => f.text.includes('超时随机选词'))).toBe(true);
    const end = s.turn.deadline;
    drawTick(s, end, everyone(s), zero);
    expect(s.phase).toBe('reveal');
    expect(s.turn.endReason).toBe('time');
    expect(drawTick(s, end + 4_999, everyone(s), zero)).toBe(false);
    drawTick(s, end + 5_000, everyone(s), zero);
    expect(s.phase).toBe('choosing');
    expect(s.turn.drawerId).toBe('b');
    expect(s.turn.no).toBe(2);
    expect(s.turn.choices.map((c) => c.word)).toEqual(['狗', '袋鼠', '打哈欠']); // 整局不重复
  });

  it('半程揭一个字（三字及以上）；两字词不揭', () => {
    const s = game();
    dPick(s, 'a', 2, NOW); // 打喷嚏
    drawTick(s, NOW + 39_000, everyone(s), zero);
    expect(view(s, 'b').hint).toBe('＿＿＿');
    expect(drawTick(s, NOW + 40_000, everyone(s), zero)).toBe(true);
    expect(view(s, 'b').hint).toBe('打＿＿');
    const s2 = game();
    dPick(s2, 'a', 1, NOW); // 恐龙
    drawTick(s2, NOW + 60_000, everyone(s2), zero);
    expect(view(s2, 'b').hint).toBe('＿＿');
  });

  it('全部回合画完 → 终局；同分并列；视图总回合数随排期推进', () => {
    const s = game(2, { cycles: 1 });
    dPick(s, 'a', 0, NOW);
    dGuess(s, 'b', '猫', NOW + 40_000); // b +70，a +25
    drawTick(s, s.turn.deadline, everyone(s), zero); // 揭晓到期 → 第 2 回合
    expect(s.turn.drawerId).toBe('b');
    dPick(s, 'b', 0, NOW + 50_000);
    s.turn.deadline = NOW + 50_000 + 80_000;
    dGuess(s, 'a', '狗', NOW + 50_000 + 40_000); // a +70 → 95；b +25 → 95
    expect(s.phase).toBe('reveal');
    drawTick(s, s.turn.deadline, everyone(s), zero);
    expect(s.phase).toBe('gameover');
    expect(s.result).toEqual({ reason: 'done', turns: 2 });
    expect(s.ranking.map((r) => [r.name, r.score, r.rank])).toEqual([
      ['甲', 95, 1],
      ['乙', 95, 1],
    ]);
    expect(view(s, 'a').deadline).toBeNull();
  });
});

describe('画面操作', () => {
  it('仅画手作画阶段生效：落笔/续点/撤销/清空；坐标取整钳制；drawRev 每批 +1', () => {
    const s = game();
    expect(dStroke(s, 'a', [{ k: 'b', id: 1, c: 1, w: 0, p: [1, 2] }], NOW)).toBeNull(); // 选词中
    dPick(s, 'a', 0, NOW);
    const rev0 = s.drawRev;
    expect(dStroke(s, 'b', [{ k: 'b', id: 1, c: 1, w: 0, p: [1, 2] }], NOW)).toBeNull(); // 非画手
    const ops = dStroke(s, 'a', [{ k: 'b', id: 1, c: 1, w: 0, p: [10.6, 20.2, -5, 9999] }], NOW);
    expect(ops).toEqual([{ k: 'b', id: 1, c: 1, w: 0, p: [11, 20, 0, 750] }]);
    expect(s.drawRev).toBe(rev0 + 1);
    dStroke(s, 'a', [{ k: 'a', id: 1, p: [30, 30] }], NOW);
    expect(s.strokes[0]?.p).toEqual([11, 20, 0, 750, 30, 30]);
    expect(dStroke(s, 'a', [{ k: 'a', id: 9, p: [1, 1] }], NOW)).toBeNull(); // 只能给最后一笔续点
    dStroke(s, 'a', [{ k: 'b', id: 2, c: 0, w: 2, p: [5, 5] }], NOW);
    expect(s.pointCount).toBe(4);
    dStroke(s, 'a', [{ k: 'u' }], NOW);
    expect(s.strokes.map((x) => x.id)).toEqual([1]);
    expect(s.pointCount).toBe(3);
    dStroke(s, 'a', [{ k: 'x' }], NOW);
    expect(s.strokes).toEqual([]);
    expect(s.pointCount).toBe(0);
  });

  it('非法操作静默丢弃：色板/粗细越界、非有限坐标、重复 id、奇数坐标截偶', () => {
    const s = game();
    dPick(s, 'a', 0, NOW);
    expect(
      dStroke(
        s,
        'a',
        [
          { k: 'b', id: 1, c: 99, w: 0, p: [1, 1] },
          { k: 'b', id: 2, c: 1, w: 5, p: [1, 1] },
          { k: 'b', id: 3, c: 1, w: 0, p: [1, Number.NaN] },
          { k: 'b', id: 4, c: 1, w: 0, p: ['x', 1] },
          null,
          { k: 'zz' },
        ],
        NOW,
      ),
    ).toBeNull();
    dStroke(s, 'a', [{ k: 'b', id: 7, c: 1, w: 0, p: [1, 2, 3] }], NOW);
    expect(s.strokes[0]?.p).toEqual([1, 2]);
    expect(dStroke(s, 'a', [{ k: 'b', id: 7, c: 1, w: 0, p: [4, 4] }], NOW)).toBeNull();
  });

  it('单条消息最多 600 个数；每回合点数上限；换回合清空画面并 drawRev+1', () => {
    const s = game();
    dPick(s, 'a', 0, NOW);
    const big = Array.from({ length: 2000 }, (_, i) => i % 700);
    const ops = dStroke(s, 'a', [{ k: 'b', id: 1, c: 1, w: 0, p: big }], NOW);
    expect(ops?.[0] && 'p' in ops[0] ? ops[0].p.length : 0).toBe(600);
    s.pointCount = DRAW_MAX_POINTS - 1;
    const tail = dStroke(s, 'a', [{ k: 'a', id: 1, p: [1, 1, 2, 2, 3, 3] }], NOW);
    expect(tail?.[0] && 'p' in tail[0] ? tail[0].p : null).toEqual([1, 1]);
    expect(dStroke(s, 'a', [{ k: 'a', id: 1, p: [4, 4] }], NOW)).toBeNull();
    const rev = s.drawRev;
    drawTick(s, s.turn.deadline, everyone(s), zero);
    drawTick(s, s.turn.deadline, everyone(s), zero); // 揭晓到期 → 新回合
    expect(s.strokes).toEqual([]);
    expect(s.drawRev).toBe(rev + 1);
  });
});

describe('离场、断线与终止', () => {
  it('画手离开：本回合作废；剩 1 人：终局 leave；离场者排后且不再轮到', () => {
    const s = game(3);
    dPick(s, 'a', 0, NOW);
    dGuess(s, 'b', '猫', NOW); // b +100、a +25
    expect(dLeave(s, 'a', NOW + 1000)).toBe(true);
    expect(s.phase).toBe('reveal');
    expect(s.turn.endReason).toBe('left');
    drawTick(s, s.turn.deadline, everyone(s), zero);
    expect(s.turn.drawerId).toBe('b');
    // 第 2 回合进行中；剩余排期 c、(a 已离场跳过)、b、c → 总数 2 + 3
    expect(view(s, 'b').totalTurns).toBe(5);
    dLeave(s, 'c', NOW + 2000);
    expect(s.phase).toBe('gameover');
    expect(s.result?.reason).toBe('leave');
    expect(s.ranking.map((r) => [r.name, r.left])).toEqual([
      ['乙', false],
      ['甲', true],
      ['丙', true],
    ]);
  });

  it('猜词者离开后剩余猜词者都已猜对 → 提前揭晓', () => {
    const s = game(3);
    dPick(s, 'a', 0, NOW);
    dGuess(s, 'b', '猫', NOW);
    dLeave(s, 'c', NOW);
    expect(s.phase).toBe('reveal');
    expect(s.turn.endReason).toBe('all');
  });

  it('画手断线 10 秒作废本回合；期间重连则清零', () => {
    const s = game();
    dPick(s, 'a', 0, NOW); // 从作画阶段测（选词 15s 超时会先于断线判定触发）
    const noA = new Set(['b', 'c']);
    drawTick(s, NOW + 1000, noA, zero);
    drawTick(s, NOW + 5000, everyone(s), zero); // 重连
    drawTick(s, NOW + 6000, noA, zero);
    expect(drawTick(s, NOW + 15_999, noA, zero)).toBe(false);
    expect(drawTick(s, NOW + 16_000, noA, zero)).toBe(true);
    expect(s.phase).toBe('reveal');
    expect(s.turn.endReason).toBe('away');
  });

  it('房主终止：中途答案公开到猜词流；全员断线强制结束记 idle', () => {
    const s = game();
    dPick(s, 'a', 2, NOW);
    expect(drawAbort(s, NOW)).toBe(true);
    expect(s.result?.reason).toBe('abort');
    expect(view(s, 'b').feed.some((f) => f.text.includes('打喷嚏'))).toBe(true);
    expect(drawAbort(s, NOW)).toBe(false);
    const s2 = game();
    expect(drawForceEnd(s2, NOW)).toBe(true);
    expect(s2.result?.reason).toBe('idle');
  });
});

describe('房间聊天防泄题', () => {
  it('作画中答案与中文别称打码；选词中三个候选一起打码；其他阶段原样', () => {
    const s = game();
    expect(maskDrawAnswer(s, '我觉得是猫或者恐龙')).toBe('我觉得是＊或者＊＊');
    dPick(s, 'a', 0, NOW);
    expect(maskDrawAnswer(s, '小猫咪好可爱')).toBe('＊＊＊好可爱');
    expect(maskDrawAnswer(s, '恐龙')).toBe('恐龙');
    dGuess(s, 'b', '猫', NOW);
    dGuess(s, 'c', '猫', NOW);
    expect(maskDrawAnswer(s, '猫')).toBe('猫'); // 揭晓阶段不再打码
  });
});
