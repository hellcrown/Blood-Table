/**
 * 血色猎场 · 棋盘几何共享纯函数（服务端校验与客户端高亮共用同一实现，杜绝两端口径漂移）
 *
 * 口径（RULES-TACTICS §距离与移动）：
 * - 移动：四向逐格，墙与棋子（野怪/玩家）均为障碍，不可穿越、不可停留；
 * - 距离/射程：忽略墙的最短路径格数——四向移动下等价于曼哈顿距离（墙挡脚不挡手）。
 */

/** 每格地形：0=平地 1=墙（涂黑格，阻挡移动但不阻挡距离/射程） */
export type Grid = readonly number[];

export function cellIndex(cols: number, r: number, c: number): number {
  return r * cols + c;
}

/** 曼哈顿距离 = 忽略障碍时四向最短路径的格数（射程/范围的统一口径） */
export function manhattan(r1: number, c1: number, r2: number, c2: number): number {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}

const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/**
 * 从 start 出发、步数 ≤ maxSteps 的全部可达格（BFS：墙与 blocked 均不可穿越）。
 * 返回 Map<格索引, 耗费步数>，不含起点。
 */
export function movementRange(
  rows: number,
  cols: number,
  grid: Grid,
  blocked: Iterable<number>,
  start: number,
  maxSteps: number,
): Map<number, number> {
  const result = new Map<number, number>();
  if (maxSteps <= 0) return result;
  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked);
  const seen = new Set<number>([start]);
  let frontier = [start];
  for (let step = 1; step <= maxSteps && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const i of frontier) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      for (const [dr, dc] of DIRS) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const j = rr * cols + cc;
        if (seen.has(j) || blockedSet.has(j) || grid[j] === 1) continue;
        seen.add(j);
        result.set(j, step);
        next.push(j);
      }
    }
    frontier = next;
  }
  return result;
}

/** start → goal 最短路径（格索引数组，含 goal、不含 start）；不可达返回 null */
export function shortestPath(
  rows: number,
  cols: number,
  grid: Grid,
  blocked: Iterable<number>,
  start: number,
  goal: number,
): number[] | null {
  if (start === goal) return [];
  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked);
  const parent = new Map<number, number>([[start, start]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (const [dr, dc] of DIRS) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (parent.has(j) || blockedSet.has(j) || grid[j] === 1) continue;
      parent.set(j, i);
      if (j === goal) {
        const path: number[] = [];
        for (let cur = goal; cur !== start; cur = parent.get(cur)!) path.push(cur);
        return path.reverse();
      }
      queue.push(j);
    }
  }
  return null;
}
