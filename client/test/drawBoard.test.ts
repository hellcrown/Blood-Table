/**
 * 你画我猜 · 画布纯逻辑：画面模型（落笔/续点去抖/撤销/清空/快照/远端增量修订号）、
 * 发送队列（续点合并、超长拆段、单条上限）、坐标换算与绘制指令。
 */
import { describe, expect, it } from 'vitest';
import { DRAW_NUMS_PER_MSG, DRAW_OPS_PER_MSG } from '@shared/drawProtocol';
import { DrawBoard, OpQueue, applyOp, backingSize, lineWidthOf, paintAll, paintStroke, toCanvasPoint } from '../src/net/drawBoard';

/** 记录调用的假 2D 上下文 */
function fakeCtx() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    setTransform: (...a: number[]) => calls.push(`setTransform(${a.join(',')})`),
    fillRect: (...a: number[]) => calls.push(`fillRect(${a.join(',')})`),
    beginPath: () => calls.push('beginPath'),
    moveTo: (x: number, y: number) => calls.push(`moveTo(${x},${y})`),
    lineTo: (x: number, y: number) => calls.push(`lineTo(${x},${y})`),
    stroke: () => calls.push('stroke'),
    arc: (x: number, y: number) => calls.push(`arc(${x},${y})`),
    fill: () => calls.push('fill'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx };
}

describe('DrawBoard · 画面模型', () => {
  it('画手：落笔即入列、续点只续当前笔、抖动点（<3 单位）丢弃、抬笔后不能续', () => {
    const b = new DrawBoard();
    b.replace(3, 7, []);
    expect(b.begin(1, 0, 10, 10)).toEqual({ k: 'b', id: 0, c: 1, w: 0, p: [10, 10] });
    expect(b.extend(11, 11)).toBeNull(); // 距离² = 2 < 9
    expect(b.extend(20, 10)).toEqual({ k: 'a', id: 0, p: [20, 10] });
    b.end();
    expect(b.extend(40, 40)).toBeNull();
    expect(b.strokes).toEqual([{ id: 0, c: 1, w: 0, p: [10, 10, 20, 10] }]);
    expect(b.pointCount).toBe(2);
    expect(b.begin(2, 1, 5, 5)?.k).toBe('b');
    expect(b.undo()).toEqual({ k: 'u' });
    expect(b.strokes.map((s) => s.id)).toEqual([0]);
    expect(b.clear()).toEqual({ k: 'x' });
    expect(b.strokes).toEqual([]);
    expect(b.undo()).toBeNull(); // 空画布无可撤销
    expect(b.clear()).toBeNull();
  });

  it('快照替换后下一笔 id 接在已有笔画之后（防撞服务端已有 id）', () => {
    const b = new DrawBoard();
    b.replace(1, 4, [
      { id: 5, c: 1, w: 0, p: [1, 1] },
      { id: 9, c: 2, w: 1, p: [2, 2] },
    ]);
    expect(b.begin(1, 0, 0, 0)).toMatchObject({ id: 10 });
  });

  it('远端增量：同回合且修订号恰好 +1 才应用（每批 +1，不按操作个数）；跨回合/跳号拒绝', () => {
    const b = new DrawBoard();
    b.replace(2, 10, []);
    expect(
      b.applyRemote(2, 11, [
        { k: 'b', id: 0, c: 1, w: 0, p: [1, 1] },
        { k: 'a', id: 0, p: [5, 5] },
      ]),
    ).toBe(true);
    expect(b.rev).toBe(11);
    expect(b.strokes[0]?.p).toEqual([1, 1, 5, 5]);
    expect(b.applyRemote(2, 13, [{ k: 'u' }])).toBe(false); // 跳号
    expect(b.applyRemote(3, 12, [{ k: 'u' }])).toBe(false); // 别的回合
    expect(b.applyRemote(2, 12, [{ k: 'u' }])).toBe(true);
    expect(b.strokes).toEqual([]);
  });

  it('applyOp：续点只认最后一笔（与服务端叠放语义一致）', () => {
    const s = [
      { id: 1, c: 1, w: 0, p: [0, 0] },
      { id: 2, c: 1, w: 0, p: [9, 9] },
    ];
    applyOp(s, { k: 'a', id: 1, p: [3, 3] });
    expect(s[0]?.p).toEqual([0, 0]);
    applyOp(s, { k: 'a', id: 2, p: [3, 3] });
    expect(s[1]?.p).toEqual([9, 9, 3, 3]);
  });
});

describe('OpQueue · 发送队列', () => {
  it('同一笔的连续续点并进前一个操作；撤销/清空单独成项', () => {
    const q = new OpQueue();
    q.push({ k: 'b', id: 0, c: 1, w: 0, p: [1, 1] });
    q.push({ k: 'a', id: 0, p: [2, 2] });
    q.push({ k: 'a', id: 0, p: [3, 3] });
    q.push({ k: 'u' });
    expect(q.size).toBe(2);
    expect(q.take()).toEqual([{ k: 'b', id: 0, c: 1, w: 0, p: [1, 1, 2, 2, 3, 3] }, { k: 'u' }]);
    expect(q.size).toBe(0);
  });

  it('入队的是副本：之后改原数组不影响待发内容', () => {
    const q = new OpQueue();
    const op = { k: 'b' as const, id: 0, c: 1, w: 0, p: [1, 1] };
    q.push(op);
    op.p.push(9, 9);
    expect(q.take()[0]).toMatchObject({ p: [1, 1] });
  });

  it('单条不超 600 个数：长笔画拆成「本条头段 + 下一条 a 续段」；操作数不超 20', () => {
    const q = new OpQueue();
    q.push({ k: 'b', id: 0, c: 1, w: 0, p: Array.from({ length: 1000 }, (_, i) => i) });
    const first = q.take();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ k: 'b', id: 0 });
    expect((first[0] as { p: number[] }).p).toHaveLength(DRAW_NUMS_PER_MSG);
    const second = q.take();
    expect(second[0]).toMatchObject({ k: 'a', id: 0 });
    expect((second[0] as { p: number[] }).p).toHaveLength(1000 - DRAW_NUMS_PER_MSG);
    expect((second[0] as { p: number[] }).p[0]).toBe(DRAW_NUMS_PER_MSG); // 接着上一段

    const many = new OpQueue();
    for (let i = 0; i < 30; i++) many.push({ k: 'u' });
    expect(many.take()).toHaveLength(DRAW_OPS_PER_MSG);
    expect(many.size).toBe(10);
  });
});

describe('坐标与绘制', () => {
  it('指针位置按画布 CSS 尺寸换算到 1000×750 并钳边；尺寸为 0 时安全返回原点', () => {
    expect(toCanvasPoint(200, 150, 400, 300)).toEqual([500, 375]);
    expect(toCanvasPoint(-5, 999, 400, 300)).toEqual([0, 750]);
    expect(toCanvasPoint(10, 10, 0, 0)).toEqual([0, 0]);
    expect(backingSize(400, 300, 2)).toEqual([800, 600]);
    expect(backingSize(400, 300, 9)).toEqual([1200, 900]); // DPR 封顶 3
  });

  it('线宽随画布缩放；橡皮（色板 0）加粗 2.5 倍', () => {
    expect(lineWidthOf({ id: 0, c: 1, w: 1, p: [] }, 500)).toBe(5); // 10 × 0.5
    expect(lineWidthOf({ id: 0, c: 0, w: 1, p: [] }, 500)).toBe(12.5);
  });

  it('整幅重绘先铺画纸；单点画圆点；增量续画从上一段末点接着画', () => {
    const { ctx, calls, raw } = fakeCtx();
    paintAll(
      ctx,
      [
        { id: 0, c: 1, w: 0, p: [100, 100] },
        { id: 1, c: 2, w: 1, p: [0, 0, 500, 375, 1000, 750] },
      ],
      400,
      300,
      2,
    );
    expect(calls[0]).toBe('setTransform(2,0,0,2,0,0)');
    expect(calls[1]).toBe('fillRect(0,0,400,300)');
    expect(calls).toContain('arc(40,40)');
    expect(calls).toContain('lineTo(400,300)');
    expect(raw.lineCap).toBe('round');
    calls.length = 0;
    paintStroke(ctx, { id: 1, c: 2, w: 1, p: [0, 0, 500, 375, 1000, 750] }, 2, 400, 300);
    expect(calls).toEqual(['beginPath', 'moveTo(200,150)', 'lineTo(400,300)', 'stroke']);
    calls.length = 0;
    paintStroke(ctx, { id: 1, c: 2, w: 1, p: [0, 0] }, 1, 400, 300); // 已画完：不出指令
    expect(calls).toEqual([]);
  });
});
