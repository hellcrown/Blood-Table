import { describe, expect, it } from 'vitest';
import {
  buildTacticsView,
  createTacticsGame,
  tAttack,
  tEndTurn,
  tLeave,
  tMove,
  tSkill,
  tacticsForceEnd,
  tacticsTick,
  type TacticsState,
} from '../src/tactics/engine';
import {
  TACTICS_MAP_PRESETS,
  TACTICS_MONSTERS,
  type TacticsMonsterState,
} from '@shared/tacticsProtocol';

const NOW = 1_700_000_000_000;

const players = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, seat: i }));

/** 清空墙与野怪的空白局：供确定性场景白盒布子 */
function flat(n = 2, size: 'small' | 'medium' | 'large' = 'small'): TacticsState {
  const gs = createTacticsGame(size, players(n), NOW);
  gs.grid = new Array(gs.rows * gs.cols).fill(0);
  gs.monsters = [];
  return gs;
}

const pOf = (gs: TacticsState, id: string) => gs.players.find((p) => p.id === id)!;

function place(gs: TacticsState, id: string, r: number, c: number): void {
  const p = pOf(gs, id);
  p.r = r;
  p.c = c;
}

function addMonster(gs: TacticsState, type: 'leech' | 'crossbow' | 'golem', r: number, c: number): TacticsMonsterState {
  const def = TACTICS_MONSTERS[type];
  const m: TacticsMonsterState = { id: `mx${gs.monsters.length + 1}`, type, hp: def.hp, maxHp: def.hp, r, c, gold: def.gold };
  gs.monsters.push(m);
  return m;
}

const wall = (gs: TacticsState, r: number, c: number) => {
  gs.grid[r * gs.cols + c] = 1;
};

function connectedAll(gs: TacticsState, required: number[]): boolean {
  const seen = new Set<number>([required[0]]);
  const queue = [required[0]];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const r = Math.floor(i / gs.cols);
    const c = i % gs.cols;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= gs.rows || cc < 0 || cc >= gs.cols) continue;
      const j = rr * gs.cols + cc;
      if (seen.has(j) || gs.grid[j] === 1) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return required.every((i) => seen.has(i));
}

describe('血色猎场 · 地图生成', () => {
  it('多档位多种子：180° 对称、出生点合规、野怪守恒且不压出生点', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      for (const n of [2, 3, 4]) {
        for (let seed = 0; seed < 8; seed++) {
          const gs = createTacticsGame(size, players(n), NOW);
          const cells = gs.rows * gs.cols;
          for (let i = 0; i < cells; i++) expect(gs.grid[i]).toBe(gs.grid[cells - 1 - i]);

          const mid = (gs.rows - 1) / 2;
          const expected =
            n <= 2
              ? [[1, 1], [gs.rows - 2, gs.cols - 2]]
              : n === 3
                ? [[1, 1], [gs.rows - 2, gs.cols - 2], [mid, mid]]
                : [[1, 1], [1, gs.cols - 2], [gs.rows - 2, 1], [gs.rows - 2, gs.cols - 2]];
          gs.players.forEach((p, i) => {
            expect([p.r, p.c]).toEqual(expected[i]);
            expect(gs.grid[p.r * gs.cols + p.c]).toBe(0); // 出生点必为平地
          });

          const preset = TACTICS_MAP_PRESETS[size];
          const totalMonsters = preset.monsters.reduce((s, m) => s + m.count, 0);
          expect(gs.monsters.length).toBe(totalMonsters);
          const spots = new Set<number>();
          for (const m of gs.monsters) {
            const i = m.r * gs.cols + m.c;
            expect(gs.grid[i]).toBe(0); // 怪窝必为平地
            expect(spots.has(i)).toBe(false);
            spots.add(i);
            const def = TACTICS_MONSTERS[m.type];
            expect(m.hp).toBe(def.hp);
            for (const p of gs.players) {
              const d = Math.abs(p.r - m.r) + Math.abs(p.c - m.c);
              if (m.type !== 'golem') expect(d).toBeGreaterThanOrEqual(2); // 非精英远离出生点
            }
          }
          expect(connectedAll(gs, [...gs.players.map((p) => p.r * gs.cols + p.c), ...spots])).toBe(true);
        }
      }
    }
  });
});

describe('血色猎场 · 移动', () => {
  it('直线移动按路径扣 AP，走满 4 AP 自动结束回合', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p0', 5, 1, NOW);
    expect(pOf(gs, 'p0').ap).toBe(0); // 4 格 = 4 AP
    expect([pOf(gs, 'p0').r, pOf(gs, 'p0').c]).toEqual([5, 1]);
    expect(gs.currentId).toBe('p1'); // 0 AP 自动移交
    expect(gs.turnNumber).toBe(2);
  });

  it('绕墙按真实路径计费：2 格直线变 4 步', () => {
    const gs = flat(2);
    wall(gs, 2, 3);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p0', 2, 4, NOW);
    expect([pOf(gs, 'p0').r, pOf(gs, 'p0').c]).toEqual([2, 4]);
    expect(pOf(gs, 'p0').ap).toBe(0);
  });

  it('AP 不足的远格不可达', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p0', 2, 8, NOW); // 6 步 > 4 AP
    expect([pOf(gs, 'p0').r, pOf(gs, 'p0').c]).toEqual([2, 2]);
    expect(pOf(gs, 'p0').ap).toBe(4);
  });

  it('墙隔断、目标为墙/被占格、停在原地均忽略', () => {
    const gs = flat(2);
    for (let r = 0; r < gs.rows; r++) wall(gs, r, 5);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 2, 8);
    tMove(gs, 'p0', 2, 8, NOW); // 整列墙隔断
    expect([pOf(gs, 'p0').r, pOf(gs, 'p0').c]).toEqual([2, 2]);

    const gs2 = flat(2);
    wall(gs2, 2, 3);
    place(gs2, 'p0', 2, 2);
    place(gs2, 'p1', 9, 9);
    tMove(gs2, 'p0', 2, 3, NOW); // 目标是墙
    expect([pOf(gs2, 'p0').r, pOf(gs2, 'p0').c]).toEqual([2, 2]);
    tMove(gs2, 'p0', 2, 2, NOW); // 原地
    expect(pOf(gs2, 'p0').ap).toBe(4);

    const gs3 = flat(2);
    place(gs3, 'p0', 2, 2);
    place(gs3, 'p1', 2, 5);
    tMove(gs3, 'p0', 2, 5, NOW); // 目标被他人占用
    expect([pOf(gs3, 'p0').r, pOf(gs3, 'p0').c]).toEqual([2, 2]);
  });

  it('野怪格阻挡移动', () => {
    const gs = flat(2);
    addMonster(gs, 'leech', 2, 5);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p0', 2, 5, NOW);
    expect([pOf(gs, 'p0').r, pOf(gs, 'p0').c]).toEqual([2, 2]);
  });

  it('非当前回合玩家的移动被忽略', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p1', 9, 8, NOW);
    expect([pOf(gs, 'p1').r, pOf(gs, 'p1').c]).toEqual([9, 9]);
  });
});

describe('血色猎场 · 野怪（全静态守卫）', () => {
  it('移动结束停在怪射程内被拦截，射程外不触发', () => {
    const gs = flat(2);
    const golem = addMonster(gs, 'golem', 5, 5);
    place(gs, 'p0', 5, 7);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p0', 5, 6, NOW); // 曼哈顿 1 ≤ 射程 1
    expect(pOf(gs, 'p0').hp).toBe(10 - TACTICS_MONSTERS.golem.atk);
    expect(gs.log.some((l) => l.text.includes('拦截'))).toBe(true);
    expect(golem.hp).toBe(TACTICS_MONSTERS.golem.hp); // 怪未受伤

    place(gs, 'p0', 5, 8); // 直接挪位模拟下一次场景（不走 tMove）
    pOf(gs, 'p0').ap = 4;
    tMove(gs, 'p0', 5, 6, NOW); // 已在射程内挪动仍触发
    expect(pOf(gs, 'p0').hp).toBe(10 - 2 * TACTICS_MONSTERS.golem.atk);
  });

  it('移动结束在射程外不触发拦截', () => {
    const gs = flat(2);
    addMonster(gs, 'leech', 5, 5); // 射程 1
    place(gs, 'p0', 5, 8);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p0', 5, 7, NOW); // 距离 2
    expect(pOf(gs, 'p0').hp).toBe(10);
  });

  it('同一次行动每怪至多反应一次：双怪夹击各打一下', () => {
    const gs = flat(2);
    addMonster(gs, 'leech', 5, 4);
    addMonster(gs, 'leech', 5, 6);
    place(gs, 'p0', 3, 5);
    place(gs, 'p1', 9, 9);
    tMove(gs, 'p0', 5, 5, NOW); // 落点同时进入两只血蛭射程
    expect(pOf(gs, 'p0').hp).toBe(10 - 2);
  });

  it('怪击杀移动者：2 人局直接终局', () => {
    const gs = flat(2);
    addMonster(gs, 'golem', 5, 5);
    place(gs, 'p0', 5, 7);
    place(gs, 'p1', 9, 9);
    pOf(gs, 'p0').hp = 1;
    tMove(gs, 'p0', 5, 6, NOW);
    expect(pOf(gs, 'p0').alive).toBe(false);
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe('p1');
    expect(gs.ranking[0].name).toBe('玩家1');
  });

  it('攻击怪未死被反击；打死怪无反击且怪移除', () => {
    const gs = flat(2);
    const golem = addMonster(gs, 'golem', 5, 5);
    place(gs, 'p0', 5, 6);
    place(gs, 'p1', 9, 9);
    tAttack(gs, 'p0', 5, 5, NOW);
    expect(golem.hp).toBe(4);
    expect(pOf(gs, 'p0').hp).toBe(8); // 反击 -2
    expect(pOf(gs, 'p0').ap).toBe(3);

    golem.hp = 2;
    pOf(gs, 'p0').ap = 4;
    gs.currentId = 'p0';
    tAttack(gs, 'p0', 5, 5, NOW);
    expect(gs.monsters.length).toBe(0);
    expect(pOf(gs, 'p0').hp).toBe(8); // 击杀无反击
  });

  it('野怪拦截可击杀当前行动者并移交回合（3 人局）', () => {
    const gs = flat(3);
    addMonster(gs, 'golem', 5, 5);
    place(gs, 'p0', 5, 7);
    place(gs, 'p1', 0, 0);
    place(gs, 'p2', 9, 9);
    pOf(gs, 'p0').hp = 1;
    tMove(gs, 'p0', 5, 6, NOW);
    expect(pOf(gs, 'p0').alive).toBe(false);
    expect(gs.phase).toBe('playing'); // 还剩 2 人
    expect(gs.currentId).toBe('p1'); // 座位序下一个存活者
  });
});

describe('血色猎场 · 攻击玩家与胜负', () => {
  it('射程外/无目标/非本回合的攻击被忽略且不扣 AP', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 2, 6); // 距离 4 > 射程 1
    tAttack(gs, 'p0', 2, 6, NOW);
    expect(pOf(gs, 'p1').hp).toBe(10);
    expect(pOf(gs, 'p0').ap).toBe(4);
    tAttack(gs, 'p0', 5, 5, NOW); // 空格
    expect(pOf(gs, 'p0').ap).toBe(4);
    tAttack(gs, 'p1', 2, 2, NOW); // 非本回合
    expect(pOf(gs, 'p0').hp).toBe(10);
  });

  it('击倒对手获胜并生成排名', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 2, 3);
    pOf(gs, 'p1').hp = 2;
    tAttack(gs, 'p0', 2, 3, NOW);
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe('p0');
    expect(gs.ranking.map((r) => r.name)).toEqual(['玩家0', '玩家1']);
    expect(gs.ranking[0].alive).toBe(true);
    expect(gs.ranking[1].alive).toBe(false);
  });

  it('3 人局击倒一人后对局继续', () => {
    const gs = flat(3);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 2, 3);
    place(gs, 'p2', 9, 9);
    pOf(gs, 'p1').hp = 2;
    tAttack(gs, 'p0', 2, 3, NOW);
    expect(gs.phase).toBe('playing');
    expect(pOf(gs, 'p1').alive).toBe(false);
    // 轮转会跳过死者
    tEndTurn(gs, 'p0', NOW);
    expect(gs.currentId).toBe('p2');
    tEndTurn(gs, 'p2', NOW);
    expect(gs.currentId).toBe('p0');
  });
});

describe('血色猎场 · 技能与冷却', () => {
  it('包扎：回复不溢出、进冷却、同回合不可复用', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    pOf(gs, 'p0').hp = 5;
    tSkill(gs, 'p0', 1, undefined, undefined, NOW);
    expect(pOf(gs, 'p0').hp).toBe(8);
    expect(pOf(gs, 'p0').ap).toBe(3);
    expect(pOf(gs, 'p0').cooldowns[1]).toBe(4);
    tSkill(gs, 'p0', 1, undefined, undefined, NOW); // 冷却中
    expect(pOf(gs, 'p0').hp).toBe(8);
    expect(pOf(gs, 'p0').ap).toBe(3);

    pOf(gs, 'p0').hp = 9; // 回复量钳制到上限
    gs.currentId = 'p0';
    pOf(gs, 'p0').cooldowns[1] = 0;
    tSkill(gs, 'p0', 1, undefined, undefined, NOW);
    expect(pOf(gs, 'p0').hp).toBe(10);
  });

  it('重击：伤害 4、冷却 3 回合按自己回合数递减', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 2, 3);
    tSkill(gs, 'p0', 0, 2, 3, NOW);
    expect(pOf(gs, 'p1').hp).toBe(6);
    expect(pOf(gs, 'p0').cooldowns[0]).toBe(3);
    expect(pOf(gs, 'p0').ap).toBe(3);

    const cdAfterUse = (): number => pOf(gs, 'p0').cooldowns[0];
    // 轮转三个自己回合：每回合开始 -1，第三回合起可用
    for (let i = 0; i < 6; i++) {
      tEndTurn(gs, gs.currentId, NOW);
      if (gs.currentId === 'p0') {
        if (i < 4) {
          expect(cdAfterUse()).toBeGreaterThan(0);
          tSkill(gs, 'p0', 0, 2, 3, NOW); // 冷却中无效
          expect(pOf(gs, 'p1').hp).toBe(6);
        } else {
          expect(cdAfterUse()).toBe(0);
        }
      }
    }
  });

  it('打击技能无目标/超射程时不扣 AP 不进冷却', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    tSkill(gs, 'p0', 0, 9, 9, NOW); // 射程 1 外
    expect(pOf(gs, 'p0').ap).toBe(4);
    expect(pOf(gs, 'p0').cooldowns[0]).toBe(0);
    tSkill(gs, 'p0', 0, 5, 5, NOW); // 空格
    expect(pOf(gs, 'p0').ap).toBe(4);
  });
});

describe('血色猎场 · 回合与超时', () => {
  it('结束回合：移交、AP 重置、回合数递增', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    pOf(gs, 'p0').ap = 2;
    tEndTurn(gs, 'p1', NOW); // 非当前回合
    expect(gs.currentId).toBe('p0');
    tEndTurn(gs, 'p0', NOW);
    expect(gs.currentId).toBe('p1');
    expect(gs.turnNumber).toBe(2);
    tEndTurn(gs, 'p1', NOW);
    expect(gs.currentId).toBe('p0');
    expect(pOf(gs, 'p0').ap).toBe(4); // 新回合重置
  });

  it('超时自动结束回合（不做托管代操作）', () => {
    const gs = flat(2);
    expect(tacticsTick(gs, NOW + 1000)).toBe(false); // 未到 deadline
    expect(tacticsTick(gs, NOW + 60_000)).toBe(true);
    expect(gs.currentId).toBe('p1');
    expect(gs.log.some((l) => l.text.includes('超时'))).toBe(true);
  });

  it('最后一次行动耗尽 AP 自动移交（攻击同理）', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 2, 3);
    pOf(gs, 'p0').ap = 1;
    tAttack(gs, 'p0', 2, 3, NOW);
    expect(gs.currentId).toBe('p1');
  });
});

describe('血色猎场 · 离场与强制终局', () => {
  it('进行中离场=淘汰：2 人局对手直接获胜', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    tLeave(gs, 'p0', NOW + 5);
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe('p1');
  });

  it('离场者是当前行动者时移交回合（3 人局）', () => {
    const gs = flat(3);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 0, 8);
    place(gs, 'p2', 9, 9);
    tLeave(gs, 'p0', NOW + 5);
    expect(gs.phase).toBe('playing');
    expect(gs.currentId).toBe('p1'); // p0 离场 → 座位序下一个存活者 p1
  });

  it('离场者不是当前行动者时不移交', () => {
    const gs = flat(3);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 0, 8);
    place(gs, 'p2', 9, 9);
    tLeave(gs, 'p2', NOW + 5);
    expect(gs.currentId).toBe('p0');
    expect(gs.phase).toBe('playing');
  });

  it('全员断线强制终局：存活者按剩余 HP 排名', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 9, 9);
    pOf(gs, 'p1').hp = 3;
    expect(tacticsForceEnd(gs, NOW + 10)).toBe(true);
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe('p0');
    expect(gs.ranking[0].hp).toBe(10);
    expect(tacticsForceEnd(gs, NOW + 20)).toBe(false); // 已终局
  });
});

describe('血色猎场 · 视图', () => {
  it('参与者/观战者视角与字段守卫：内部字段绝不下发', () => {
    const gs = flat(3);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 0, 8);
    place(gs, 'p2', 9, 9);
    const mine = buildTacticsView(gs, 'p1', 'ABCD', 'host1', new Set(['p1']));
    expect(mine.kind).toBe('tactics');
    expect(mine.youId).toBe('p1');
    expect(mine.spectator).toBe(false);
    const raw = JSON.stringify(mine);
    expect(raw).not.toContain('turnMs');
    expect(mine.players.find((p) => p.id === 'p1')!.connected).toBe(true);
    expect(mine.players.find((p) => p.id === 'p0')!.connected).toBe(false);

    const watched = buildTacticsView(gs, 'nobody', 'ABCD', 'host1');
    expect(watched.youId).toBeNull();
    expect(watched.spectator).toBe(true);
    expect(watched.deadline).toBeGreaterThan(0);
  });

  it('终局视图：deadline 置空并带排名', () => {
    const gs = flat(2);
    place(gs, 'p0', 2, 2);
    place(gs, 'p1', 2, 3);
    pOf(gs, 'p1').hp = 1;
    tAttack(gs, 'p0', 2, 3, NOW);
    const view = buildTacticsView(gs, 'p0', 'ABCD', 'host1');
    expect(view.phase).toBe('gameover');
    expect(view.deadline).toBeNull();
    expect(view.ranking.length).toBe(2);
    expect(view.winnerId).toBe('p0');
  });
});
