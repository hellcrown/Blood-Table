import { describe, expect, it } from 'vitest';
import { manhattan, movementRange, shortestPath } from '@shared/tacticsGrid';

const ROWS = 5;
const COLS = 5;
const idx = (r: number, c: number) => r * COLS + c;

function flatGrid(): number[] {
  return new Array(ROWS * COLS).fill(0);
}

describe('战棋几何 · 曼哈顿距离（距离/射程统一口径）', () => {
  it('横向、纵向与斜向的格数', () => {
    expect(manhattan(2, 2, 2, 5)).toBe(3);
    expect(manhattan(2, 2, 4, 2)).toBe(2);
    expect(manhattan(0, 0, 3, 4)).toBe(7);
    expect(manhattan(1, 1, 1, 1)).toBe(0);
  });

  it('墙不影响曼哈顿距离（墙挡脚不挡手）', () => {
    const grid = flatGrid();
    grid[idx(2, 3)] = 1;
    expect(manhattan(2, 2, 2, 4)).toBe(2);
    expect(grid[idx(2, 3)]).toBe(1);
  });
});

describe('战棋几何 · movementRange（BFS 可达范围，墙与棋子阻挡）', () => {
  it('平地 2 步范围 = 曼哈顿 ≤2 的全部格（含对角绕步格）', () => {
    const range = movementRange(ROWS, COLS, flatGrid(), new Set<number>(), idx(2, 2), 2);
    expect(range.size).toBe(12); // 距离1：4 格；距离2：8 格
    expect(range.get(idx(2, 4))).toBe(2);
    expect(range.get(idx(1, 1))).toBe(2); // 斜角格由两步直走到达
    expect(range.has(idx(2, 2))).toBe(false); // 不含起点
    expect(range.has(idx(0, 0))).toBe(false); // 3 步之外
  });

  it('墙阻挡穿越：2 步绕不过单格墙', () => {
    const grid = flatGrid();
    grid[idx(2, 3)] = 1;
    const range = movementRange(ROWS, COLS, grid, new Set<number>(), idx(2, 2), 2);
    expect(range.has(idx(1, 3))).toBe(true); // 上绕可达
    expect(range.has(idx(2, 4))).toBe(false); // 直线被墙挡，绕行需 4 步
  });

  it('棋子（blocked）同样阻挡且不可停留', () => {
    const grid = flatGrid();
    const range = movementRange(ROWS, COLS, grid, new Set([idx(2, 3)]), idx(2, 2), 4);
    expect(range.has(idx(2, 3))).toBe(false);
    expect(range.has(idx(2, 4))).toBe(true); // 4 步从上绕到
    expect(range.get(idx(2, 4))).toBe(4);
  });

  it('maxSteps=0 与边界收口', () => {
    expect(movementRange(ROWS, COLS, flatGrid(), new Set<number>(), idx(0, 0), 0).size).toBe(0);
    const range = movementRange(ROWS, COLS, flatGrid(), new Set<number>(), idx(0, 0), 10);
    expect(range.size).toBe(ROWS * COLS - 1);
  });
});

describe('战棋几何 · shortestPath（移动按真实路径扣 AP）', () => {
  it('绕单格墙的最短路 = 4 步', () => {
    const grid = flatGrid();
    grid[idx(2, 3)] = 1;
    const path = shortestPath(ROWS, COLS, grid, new Set<number>(), idx(2, 2), idx(2, 4));
    expect(path).not.toBeNull();
    expect(path!.length).toBe(4);
    expect(path![path!.length - 1]).toBe(idx(2, 4));
  });

  it('整列墙完全隔断 → null', () => {
    const grid = flatGrid();
    for (let r = 0; r < ROWS; r++) grid[idx(r, 2)] = 1;
    expect(shortestPath(ROWS, COLS, grid, new Set<number>(), idx(1, 1), idx(1, 3))).toBeNull();
  });

  it('目标格被棋子占用 → null（不可停留）', () => {
    expect(shortestPath(ROWS, COLS, flatGrid(), new Set([idx(2, 4)]), idx(2, 2), idx(2, 4))).toBeNull();
  });

  it('起点 = 目标 → 空路径', () => {
    expect(shortestPath(ROWS, COLS, flatGrid(), new Set<number>(), idx(2, 2), idx(2, 2))).toEqual([]);
  });
});
