/**
 * 你画我猜 · 画布纯逻辑（无 React/DOM 依赖，node 环境可测）
 *
 * 与服务端 dStroke 同一套操作语义：b=落笔即入列（叠放顺序与服务端一致）、a=只给最后一笔续点、
 * u=撤销最后一笔、x=清空。修订号口径同服务端：每一批远端操作 +1（不是每个操作 +1），
 * 远端增量必须同回合且修订号连续才应用，否则丢弃等整幅快照。
 * 画手本地：立即画、攒进发送队列，按 100ms 节拍取一批发送（≤20 操作、≤600 数，超长笔画拆段续发）。
 */
import {
  DRAW_COLORS,
  DRAW_ERASER_SCALE,
  DRAW_H,
  DRAW_MAX_POINTS,
  DRAW_MAX_STROKES,
  DRAW_NUMS_PER_MSG,
  DRAW_OPS_PER_MSG,
  DRAW_PAPER,
  DRAW_W,
  DRAW_WIDTHS,
  type DrawOp,
  type DrawStroke,
} from '@shared/drawProtocol';

/** 把一个操作应用到笔画数组（与服务端语义一致；非法/越权的操作此前已被服务端滤掉） */
export function applyOp(strokes: DrawStroke[], op: DrawOp): void {
  if (op.k === 'b') strokes.push({ id: op.id, c: op.c, w: op.w, p: [...op.p] });
  else if (op.k === 'a') {
    const last = strokes[strokes.length - 1];
    if (last && last.id === op.id) last.p.push(...op.p);
  } else if (op.k === 'u') strokes.pop();
  else strokes.length = 0;
}

/** 本地完整画面：远端增量/快照与画手本地操作共用 */
export class DrawBoard {
  turn = -1;
  rev = 0;
  strokes: DrawStroke[] = [];
  /** 画手：下一笔 id 与正在画的一笔 */
  private nextId = 0;
  private liveId: number | null = null;

  get pointCount(): number {
    let n = 0;
    for (const s of this.strokes) n += s.p.length / 2;
    return n;
  }

  /** 远端增量：同回合且修订号恰好 +1 才应用；对不上返回 false（调用方等快照） */
  applyRemote(turn: number, rev: number, ops: DrawOp[]): boolean {
    if (turn !== this.turn || rev !== this.rev + 1) return false;
    for (const op of ops) applyOp(this.strokes, op);
    this.rev = rev;
    return true;
  }

  /** 整幅快照替换（新回合/新进房/重连/补发）；画手的下一笔 id 接在快照之后，防撞服务端已有 id */
  replace(turn: number, rev: number, strokes: DrawStroke[]): void {
    this.turn = turn;
    this.rev = rev;
    this.strokes = strokes.map((s) => ({ ...s, p: [...s.p] }));
    this.nextId = strokes.reduce((m, s) => Math.max(m, s.id + 1), 0);
    this.liveId = null;
  }

  /** 画手落笔：新开一笔（含首点），返回要发送的 b 操作；超出每回合上限返回 null */
  begin(c: number, w: number, x: number, y: number): DrawOp | null {
    this.liveId = null;
    if (this.strokes.length >= DRAW_MAX_STROKES || this.pointCount >= DRAW_MAX_POINTS) return null;
    const op: DrawOp = { k: 'b', id: this.nextId++, c, w, p: [x, y] };
    applyOp(this.strokes, op);
    this.liveId = op.id;
    return op;
  }

  /** 画手续点：只续正在画的一笔；离上一点不足 3 个单位的抖动点丢弃（省流量），超上限返回 null */
  extend(x: number, y: number): DrawOp | null {
    const last = this.strokes[this.strokes.length - 1];
    if (this.liveId == null || !last || last.id !== this.liveId) return null;
    const px = last.p[last.p.length - 2]!;
    const py = last.p[last.p.length - 1]!;
    if ((x - px) ** 2 + (y - py) ** 2 < 9) return null;
    if (this.pointCount >= DRAW_MAX_POINTS) return null;
    const op: DrawOp = { k: 'a', id: last.id, p: [x, y] };
    applyOp(this.strokes, op);
    return op;
  }

  /** 抬笔 */
  end(): void {
    this.liveId = null;
  }

  undo(): DrawOp | null {
    this.liveId = null;
    if (this.strokes.length === 0) return null;
    const op: DrawOp = { k: 'u' };
    applyOp(this.strokes, op);
    return op;
  }

  clear(): DrawOp | null {
    this.liveId = null;
    if (this.strokes.length === 0) return null;
    const op: DrawOp = { k: 'x' };
    applyOp(this.strokes, op);
    return op;
  }
}

/**
 * 画手发送队列：连续续点并进同一个操作（大幅减少操作数），take() 取一条消息的量
 *（≤20 操作、≤600 数），放不下的长笔画拆成「本条的头 + 下一条的 a 续段」。
 */
export class OpQueue {
  private q: DrawOp[] = [];

  push(op: DrawOp): void {
    const last = this.q[this.q.length - 1];
    if (op.k === 'a' && last && (last.k === 'b' || last.k === 'a') && last.id === op.id) {
      last.p.push(...op.p);
      return;
    }
    this.q.push(op.k === 'b' || op.k === 'a' ? { ...op, p: [...op.p] } : op);
  }

  get size(): number {
    return this.q.length;
  }

  take(): DrawOp[] {
    const out: DrawOp[] = [];
    let nums = 0;
    while (this.q.length > 0 && out.length < DRAW_OPS_PER_MSG) {
      const op = this.q[0]!;
      if (op.k === 'u' || op.k === 'x') {
        out.push(op);
        this.q.shift();
        continue;
      }
      const room = (DRAW_NUMS_PER_MSG - nums) & ~1;
      if (room < 2) break;
      if (op.p.length <= room) {
        out.push(op);
        nums += op.p.length;
        this.q.shift();
        continue;
      }
      const head = op.p.slice(0, room);
      out.push(op.k === 'b' ? { ...op, p: head } : { k: 'a', id: op.id, p: head });
      this.q[0] = { k: 'a', id: op.id, p: op.p.slice(room) };
      break;
    }
    return out;
  }
}

/** 指针位置（相对画布 CSS 盒左上角）→ 虚拟画布整数坐标 */
export function toCanvasPoint(offsetX: number, offsetY: number, cssW: number, cssH: number): [number, number] {
  if (cssW <= 0 || cssH <= 0) return [0, 0];
  const x = Math.round(Math.min(DRAW_W, Math.max(0, (offsetX / cssW) * DRAW_W)));
  const y = Math.round(Math.min(DRAW_H, Math.max(0, (offsetY / cssH) * DRAW_H)));
  return [x, y];
}

/** 画布 backing store 像素尺寸（DPR 感知，封顶 3 倍防超大内存） */
export function backingSize(cssW: number, cssH: number, dpr: number): [number, number] {
  const d = Math.min(3, Math.max(1, dpr || 1));
  return [Math.max(1, Math.round(cssW * d)), Math.max(1, Math.round(cssH * d))];
}

/** 一笔的实际线宽（CSS 像素）：色板 0 号是橡皮，按 2.5 倍加粗 */
export function lineWidthOf(s: DrawStroke, cssW: number): number {
  const base = DRAW_WIDTHS[s.w] ?? DRAW_WIDTHS[1]!;
  return Math.max(1, base * (s.c === 0 ? DRAW_ERASER_SCALE : 1) * (cssW / DRAW_W));
}

/**
 * 画一笔：从第 fromPt 个点接着画（增量续画只补尾段，不重画整笔）。
 * 单点笔画画成圆点（点按一下也能留下痕迹）。坐标按 CSS 尺寸缩放，DPR 由调用方 setTransform 承担。
 */
export function paintStroke(ctx: CanvasRenderingContext2D, s: DrawStroke, fromPt: number, cssW: number, cssH: number): void {
  const n = s.p.length / 2;
  if (n === 0 || fromPt >= n) return;
  const kx = cssW / DRAW_W;
  const ky = cssH / DRAW_H;
  const color = DRAW_COLORS[s.c] ?? DRAW_COLORS[1]!;
  const lw = lineWidthOf(s, cssW);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(s.p[0]! * kx, s.p[1]! * ky, lw / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const start = Math.max(0, fromPt - 1);
  ctx.beginPath();
  ctx.moveTo(s.p[start * 2]! * kx, s.p[start * 2 + 1]! * ky);
  for (let i = start + 1; i < n; i++) ctx.lineTo(s.p[i * 2]! * kx, s.p[i * 2 + 1]! * ky);
  ctx.stroke();
}

/** 整幅重绘：铺画纸色后逐笔绘制 */
export function paintAll(ctx: CanvasRenderingContext2D, strokes: DrawStroke[], cssW: number, cssH: number, dpr: number): void {
  const d = Math.min(3, Math.max(1, dpr || 1));
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = DRAW_PAPER;
  ctx.fillRect(0, 0, cssW, cssH);
  for (const s of strokes) paintStroke(ctx, s, 0, cssW, cssH);
}
