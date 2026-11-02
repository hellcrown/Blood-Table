/**
 * 血色猎场 · 机器人决策器测试：白盒布子钉住策略口径——
 * 斩杀优先（玩家>怪）、残血包扎、重击价值目标（玩家/石像）、贴脸普攻、
 * 接敌走位（落到目标旁）、残血落点避怪圈、无路可走结束回合。
 */
import { describe, expect, it } from 'vitest';
import { tacticsBotDecide } from '../src/tactics/botAI';
import { createTacticsGame, type TacticsState } from '../src/tactics/engine';
import { TACTICS_MONSTERS, type TacticsMonsterState } from '@shared/tacticsProtocol';

const NOW = 1_700_000_000_000;

function flat(n = 2, botId = 'p0'): TacticsState {
  const gs = createTacticsGame(
    'small',
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, seat: i })),
    NOW,
  );
  gs.grid = new Array(gs.rows * gs.cols).fill(0);
  gs.monsters = [];
  gs.currentId = botId;
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

describe('血色猎场 · 机器人决策', () => {
  it('非本回合/已死亡 → 结束回合', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 9, 9);
    gs.currentId = 'p1';
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'endTurn' });
    pOf(gs, 'p0').alive = false;
    gs.currentId = 'p0';
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'endTurn' });
  });

  it('斩杀优先：普攻能打死的目标直接打，玩家优先于怪', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 5, 6);
    const leech = addMonster(gs, 'leech', 4, 5);
    leech.hp = 2; // 怪：普攻可斩杀
    pOf(gs, 'p1').hp = 2; // 玩家也可斩杀
    const act = tacticsBotDecide(gs, 'p0');
    expect(act).toEqual({ kind: 'attack', r: 5, c: 6 }); // 玩家优先
  });

  it('无玩家可打时斩杀血最薄的怪', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 9, 9);
    const leech = addMonster(gs, 'leech', 4, 5);
    const crossbow = addMonster(gs, 'crossbow', 5, 6);
    leech.hp = 1;
    crossbow.hp = 2;
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'attack', r: 4, c: 5 }); // 血薄优先
  });

  it('残血（≤4）且包扎就绪 → 包扎', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 9, 9);
    pOf(gs, 'p0').hp = 3;
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'skill', skillIdx: 1 });
  });

  it('重击价值：贴脸玩家且普攻打不死 → 重击；冷却中退化为普攻', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 5, 6);
    pOf(gs, 'p1').hp = 5; // 普攻 2 打不死、重击 4 也打不死但价值更高
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'skill', skillIdx: 0, r: 5, c: 6 });
    pOf(gs, 'p0').cooldowns[0] = 1; // 重击冷却中
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'attack', r: 5, c: 6 });
  });

  it('重击不打血薄小怪：血蛭用普攻收掉即可', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 9, 9);
    addMonster(gs, 'leech', 5, 6);
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'attack', r: 5, c: 6 });
  });

  it('接敌：沿最短路走到目标旁（落点与目标曼哈顿距离 1）', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 5, 1); // 4 步直线
    const act = tacticsBotDecide(gs, 'p0');
    expect(act.kind).toBe('move');
    if (act.kind !== 'move') return;
    expect(Math.abs(act.r - 5) + Math.abs(act.c - 1)).toBe(1); // AP 4，走 3 步贴脸
  });

  it('残血接敌落点避开野怪射程圈（走半程停在圈外）', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 5, 1);
    pOf(gs, 'p0').hp = 3;
    pOf(gs, 'p0').cooldowns[1] = 2; // 包扎冷却中，无法自愈只能绕
    const golem = addMonster(gs, 'golem', 5, 2); // 射程 1，卡在贴脸格旁
    const act = tacticsBotDecide(gs, 'p0');
    expect(act.kind).toBe('move');
    if (act.kind !== 'move') return;
    const dist = Math.abs(act.r - golem.r) + Math.abs(act.c - golem.c);
    expect(dist).toBeGreaterThan(TACTICS_MONSTERS.golem.range); // 落点在石像射程外
  });

  it('被墙完全围死无路可走 → 结束回合', () => {
    const gs = flat(2);
    place(gs, 'p0', 5, 5);
    place(gs, 'p1', 9, 9);
    wall(gs, 4, 5);
    wall(gs, 6, 5);
    wall(gs, 5, 4);
    wall(gs, 5, 6);
    expect(tacticsBotDecide(gs, 'p0')).toEqual({ kind: 'endTurn' });
  });
});
