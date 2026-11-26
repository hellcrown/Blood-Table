/**
 * 勿停 · 引擎单测 v2：建局与设置口径、弯道生成与曲率、转向积分与弯道外甩、出路面/撞护栏、
 * 路面事件按横向位置判定、岗位默认与权限、喊话与标记、夜行者全套（发车宽限/停车惊动/冲刺合围/
 * 扒车撕扯节奏/开窗爬入/关窗打断/甩飞/放弃回位/行驶撞击）、窗爬者、猎影、路牌与胜负、视图。
 * rng 固定为 0：首个事件 150m 且为左侧车道路障（车在中道驶过不受影响）；首段弯道 310m 起（左弯）。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateInputs,
  buildDriveView,
  createDriveGame,
  driveAbort,
  driveForceEnd,
  driveIntent,
  driveLeave,
  driveTick,
  escapeSpeedOf,
  isSolo,
  monsterRunSpeed,
  resolveCrawl,
  resolveCurveSetting,
  resolveDurability,
  resolveSignGap,
  resolveTail,
  resolveTarget,
  type DriveOptions,
  type DriveState,
} from '../src/drive/engine';
import {
  DRIVE_ATTACK_RESET,
  DRIVE_CLIMB_MS,
  DRIVE_CURVE_CHAIN_MAX,
  DRIVE_CRAWL_FIRST_MS,
  DRIVE_FUEL_MAX,
  DRIVE_GAP_MAX,
  DRIVE_GUARD_M,
  DRIVE_HUNT_RANGE,
  DRIVE_LATCH_CLIMB_MS,
  DRIVE_REL_MAX,
  DRIVE_WARN_MS,
  ROAD_HALF_M,
  curvatureAt,
  stepSteering,
  type DriveCurve,
  type DriveMonsterState,
} from '@shared/driveProtocol';

const NOW = 1_000_000;
const zero = (): number => 0;
const PLAYERS = [
  { id: 'a', name: '甲', seat: 0 },
  { id: 'b', name: '乙', seat: 1 },
];

/** 默认测试局关掉夜行者的自动生成（生成流另有专门用例）：其余用例都是手工摆怪物 */
function game(n = 2, opts: DriveOptions = {}): DriveState {
  const s = createDriveGame(PLAYERS.slice(0, n), NOW, opts, zero);
  s.monsters = [];
  s.monsterSeq = 0;
  s.road.nextMonsterAt = Infinity;
  return s;
}
const everyone = (s: DriveState): Set<string> => new Set(s.players.filter((p) => !p.left).map((p) => p.id));
const view = (s: DriveState, id: string) => buildDriveView(s, id, 'TEST', 'a', everyone(s), NOW);
const at = (s: DriveState): number => s.lastTickAt;

/** 以 66ms 一拍（同线上 tick）模拟推进 untilMs；end 先快照，防循环条件被 tick 里的 lastTickAt 拖着走 */
function run(s: DriveState, untilMs: number, step = 66): void {
  const end = s.lastTickAt + untilMs;
  for (let t = s.lastTickAt + step; t <= end; t += step) driveTick(s, t, everyone(s), zero);
}

/** 定速推进：每拍把车速钉在 speed（隔离转向/弯道行为，不受油门滑行干扰） */
function runAt(s: DriveState, speed: number, untilMs: number, step = 66): void {
  const end = s.lastTickAt + untilMs;
  for (let t = s.lastTickAt + step; t <= end; t += step) {
    s.speed = speed;
    driveTick(s, t, everyone(s), zero);
  }
}

const gas = (s: DriveState, id: string, on = true): boolean => driveIntent(s, id, { k: 'gas', on }, at(s));
const steer = (s: DriveState, id: string, dir: -1 | 0 | 1): boolean => driveIntent(s, id, { k: 'steer', dir }, at(s));

/** 手工放一只夜行者（amp=0 原地不动，便于断言） */
function addMonster(s: DriveState, atM: number, lat = 0, over: Partial<DriveMonsterState> = {}): DriveMonsterState {
  const m: DriveMonsterState = {
    id: ++s.monsterSeq,
    home: atM,
    at: atM,
    lat,
    center: lat,
    amp: 0,
    w: 0.3,
    phase: 0,
    mode: 'wander',
    side: null,
    climbSince: 0,
    thrownAt: 0,
    vs: 0,
    vx: 0,
    ...over,
  };
  s.monsters.push(m);
  return m;
}

describe('建局与设置口径', () => {
  it('建局：车在路中心、灯亮、未发车；座位最靠前的是驾驶员；首段弯道在开局直路之后', () => {
    const s = game();
    expect(s.phase).toBe('driving');
    expect([s.speed, s.lateral, s.rel, s.fuel, s.gap]).toEqual([0, 0, 0, DRIVE_FUEL_MAX, DRIVE_GAP_MAX]);
    expect(s.lamp).toBe(true);
    expect(s.moved).toBe(false);
    expect(s.durability).toBe(s.maxDurability);
    expect(s.players.map((p) => p.role)).toEqual(['drive', 'navigate']);
    expect(s.monsters).toHaveLength(0); // 第 1 号路牌之前不出夜行者
    expect(s.road.curves[0]!.at).toBeGreaterThanOrEqual(200);
    expect(s.road.curvesTo).toBeGreaterThanOrEqual(900);
    expect(curvatureAt(s.road.curves, 0)).toBe(0);
    expect(resolveCurveSetting('absurd' as never)).toBe('normal');
    expect(resolveCurveSetting('fierce')).toBe('fierce');
    expect(resolveSignGap(777)).toBe(400);
    expect(resolveDurability(4)).toBe(3);
    expect(resolveTail('absurd' as never)).toBe('normal');
    expect(resolveCrawl('high')).toBe('high');
    expect(resolveTarget(10)).toBe(10);
  });

  it('curvatureAt：两端各 20m 线性渐变，弯中为 k，弯外为 0', () => {
    const curves: DriveCurve[] = [{ at: 100, len: 100, k: 0.01 }];
    expect(curvatureAt(curves, 50)).toBe(0);
    expect(curvatureAt(curves, 100)).toBe(0);
    expect(curvatureAt(curves, 110)).toBeCloseTo(0.005, 10);
    expect(curvatureAt(curves, 150)).toBeCloseTo(0.01, 10);
    expect(curvatureAt(curves, 190)).toBeCloseTo(0.005, 10);
    expect(curvatureAt(curves, 200)).toBe(0);
    expect(curvatureAt(curves, 300)).toBe(0);
  });

  it('弯道生成：同向连续弯道的总转角不超上限（保证前方道路落在地图里）', () => {
    // rng 恒 0.99：永远倾向同向 → 靠链上限强制换向
    const s = createDriveGame(PLAYERS, NOW, {}, () => 0.99);
    s.pos = 9000; // 推进生成窗口
    driveTick(s, NOW + 66, everyone(s), () => 0.99);
    const cs = s.road.curves;
    expect(cs.length).toBeGreaterThan(6);
    let chain = 0;
    let prevDir = 0;
    for (const c of cs) {
      const dir = Math.sign(c.k);
      const turn = Math.abs(c.k) * c.len;
      chain = dir === prevDir ? chain + turn : turn;
      prevDir = dir;
      expect(chain).toBeLessThanOrEqual(DRIVE_CURVE_CHAIN_MAX + 1e-9);
    }
    // 凶度只放大曲率，不改变弯道位置与长度
    const gentle = createDriveGame(PLAYERS, NOW, { curves: 'lenient' }, zero);
    const fierce = createDriveGame(PLAYERS, NOW, { curves: 'fierce' }, zero);
    expect(gentle.road.curves[0]!.at).toBe(fierce.road.curves[0]!.at);
    expect(fierce.road.curves[0]!.k / gentle.road.curves[0]!.k).toBeCloseTo(1.3 / 0.7, 6);
  });
});

describe('转向', () => {
  it('stepSteering：按住转车头并横移、松键回正、静止打不动方向、车头角有上限', () => {
    const b = { lateral: 0, rel: 0, speed: 36 };
    for (let i = 0; i < 10; i++) stepSteering(b, 1, 0, 0.05);
    expect(b.rel).toBeCloseTo(DRIVE_REL_MAX, 6); // 1.0 rad/s × 0.5s = 0.5，恰在上限
    expect(b.lateral).toBeGreaterThan(0.5);
    const relBefore = b.rel;
    for (let i = 0; i < 20; i++) stepSteering(b, 0, 0, 0.05);
    expect(b.rel).toBeLessThan(relBefore);
    expect(b.rel).toBeGreaterThan(0);
    const still = { lateral: 0, rel: 0, speed: 0 };
    for (let i = 0; i < 20; i++) stepSteering(still, 1, 0, 0.05);
    expect(still.rel).toBe(0);
    expect(still.lateral).toBe(0);
  });

  it('引擎：油门下右转 → 车向右横移；松开方向键车头角回落', () => {
    const s = game();
    s.speed = 60;
    gas(s, 'a');
    steer(s, 'a', 1);
    run(s, 500);
    expect(s.rel).toBeGreaterThan(0.3);
    expect(s.lateral).toBeGreaterThan(1);
    const relBefore = s.rel;
    steer(s, 'a', 0);
    run(s, 600);
    expect(s.rel).toBeLessThan(relBefore);
  });

  it('弯道外甩：直路上行驶的车在右弯里不打了方向会被甩向弯外；反打方向能压住', () => {
    const s = game();
    s.road.curves = [{ at: 0, len: 1000, k: 0.005 }]; // 右弯
    runAt(s, 60, 4000);
    expect(s.rel).toBeLessThan(0); // 车头被甩向弯外（左）
    expect(s.lateral).toBeLessThan(-3); // 持续向左漂

    const t = game();
    t.road.curves = [{ at: 0, len: 1000, k: 0.005 }];
    steer(t, 'a', 1);
    runAt(t, 60, 600); // 只打一小段：再打下去就该撞上弯外的护栏了（那是另一个用例）
    expect(t.rel).toBeGreaterThan(0.3); // 往弯里打方向：车头角被压回弯内（不打了是负的）
    expect(t.lateral).toBeGreaterThan(0); // 车往弯内走
    expect(t.durability).toBe(t.maxDurability);
  });

  it('出路面：路肩额外减速 + 刮擦噪音喂猎影；撞护栏扣耐久并弹回，冷却内不重复', () => {
    const s = game();
    s.lateral = ROAD_HALF_M + 0.3;
    s.speed = 20; // 已在勿停线下：尾压只降不升
    s.gap = 100;
    run(s, 1000);
    expect(s.offRoad).toBe(true);
    expect(s.speed).toBe(0); // 滑行 15 + 路肩 35，0.4s 内刹停
    expect(s.gap).toBeLessThan(95); // 尾压 6 + 刮擦 2
    expect(s.log.some((l) => l.text.includes('驶出了路面'))).toBe(true);

    const c = game();
    c.lateral = DRIVE_GUARD_M + 0.1;
    c.speed = 60;
    c.gap = 100;
    driveTick(c, NOW + 66, everyone(c), zero);
    expect(c.durability).toBe(c.maxDurability - 1);
    expect(c.speed).toBeLessThan(20);
    expect(c.lateral).toBeLessThan(DRIVE_GUARD_M);
    expect(c.rel).toBeLessThan(0); // 弹回时车头朝向路面
    expect(Math.abs(c.lateral)).toBeLessThan(ROAD_HALF_M); // 弹回路面内侧，而不是停在护栏边的路肩上
    expect(c.offRoad).toBe(false);
    c.lateral = DRIVE_GUARD_M + 0.1;
    driveTick(c, NOW + 132, everyone(c), zero);
    expect(c.durability).toBe(c.maxDurability - 1); // 冷却内
    c.lateral = DRIVE_GUARD_M + 0.1;
    driveTick(c, NOW + 1500, everyone(c), zero);
    expect(c.durability).toBe(c.maxDurability - 2);
  });
});

describe('被扒车的活路', () => {
  it('甩脱线跟着夜行者的速度走：基础约 32 码，路牌越多越高，封顶 +50%', () => {
    expect(monsterRunSpeed(0)).toBeCloseTo(9, 9); // 约 32km/h：全力奔跑的人形
    expect(escapeSpeedOf(0)).toBeCloseTo(32.4, 6);
    expect(escapeSpeedOf(6)).toBeCloseTo(9 * 1.3 * 3.6, 6); // 6 块路牌：+30%
    expect(escapeSpeedOf(10)).toBeCloseTo(9 * 1.5 * 3.6, 6); // 封顶 +50%（约 48.6 码）
    expect(escapeSpeedOf(999)).toBe(escapeSpeedOf(10));
  });

  it('车开得比它慢它不放弃（30 码 < 基础甩脱线）；开得比它快才掉头回去', () => {
    const s = game();
    s.moved = true;
    s.speed = 0;
    const m = addMonster(s, 60, 3);
    run(s, 200);
    expect(m.mode).toBe('hunt');
    runAt(s, 30, 600);
    expect(m.mode).toBe('hunt'); // 30 码甩不掉基础档的夜行者
    runAt(s, 45, 400);
    expect(m.mode).toBe('return');
  });

  it('车停着被扒住的瞬间立刻满油门：在第一次撕扯之前冲过甩脱线，一下都不挨', () => {
    const s = game();
    s.moved = true;
    addMonster(s, 3, 1);
    while (!s.monsters.some((m) => m.mode === 'latched')) driveTick(s, s.lastTickAt + 66, everyone(s), zero);
    gas(s, 'a'); // 扒上的同一刻踩死油门
    const dur0 = s.durability;
    run(s, 2200);
    expect(s.speed).toBeGreaterThanOrEqual(escapeSpeedOf(0)); // 冲过了甩脱线
    expect(s.monsters.every((m) => m.mode !== 'latched')).toBe(true); // 全部甩飞
    expect(s.durability).toBe(dur0); // 第一次撕扯（约 2.1s 后）还没到就甩掉了
  });
});

describe('不会卡死', () => {
  it('撞护栏后满油门：车能重新加速，不会一路减速停死在路肩上', () => {
    const s = game();
    s.moved = true;
    s.lateral = DRIVE_GUARD_M + 0.1;
    s.speed = 60;
    gas(s, 'a');
    run(s, 3000);
    expect(s.durability).toBe(s.maxDurability - 1);
    expect(s.speed).toBeGreaterThan(20); // 撞完从 15 km/h 重新提速
    expect(s.offRoad).toBe(false);
  });

  it('停在路肩上踩油门开得出来：路肩减速小于油门加速，配合打方向能回到路面', () => {
    const s = game();
    s.moved = true;
    s.lateral = ROAD_HALF_M + 0.8;
    s.speed = 0;
    gas(s, 'a');
    run(s, 1500);
    expect(s.speed).toBeGreaterThan(5); // 先能动起来
    steer(s, 'a', -1); // 往路里打一把
    run(s, 1000);
    steer(s, 'a', 0); // 回正
    run(s, 1500);
    expect(s.offRoad).toBe(false); // 回到路面上
    expect(s.speed).toBeGreaterThan(25); // 并且在正常提速
    expect(s.durability).toBe(s.maxDurability); // 全程没再撞护栏
  });
});

describe('路面事件按横向位置判定', () => {
  it('路障：同车道撞上扣耐久；换到旁边车道躲开', () => {
    const s = game();
    s.road.events = [{ at: 150, kind: 'barrier', lat: 0, half: 1.3 }];
    s.pos = 140;
    s.lateral = 0;
    s.speed = 60;
    gas(s, 'a');
    run(s, 2000);
    expect(s.durability).toBe(s.maxDurability - 1);

    const d = game();
    d.road.events = [{ at: 150, kind: 'barrier', lat: 0, half: 1.3 }];
    d.pos = 140;
    d.lateral = 3.5;
    d.rel = 0;
    d.speed = 60;
    d.gap = 100;
    runAt(d, 60, 2000);
    expect(d.durability).toBe(d.maxDurability);
  });

  it('尸群：碾过减速并制造噪音，不伤车；贴外侧车道绕开', () => {
    const s = game();
    s.road.events = [{ at: 150, kind: 'swarm', lat: 0, half: 3.6 }];
    s.pos = 140;
    s.gap = 100;
    runAt(s, 20, 8000); // 低于勿停线：尾压只降不升，降幅全部来自尸群噪音
    expect(s.durability).toBe(s.maxDurability);
    expect(s.gap).toBeLessThan(60);

    const d = game();
    d.road.events = [{ at: 150, kind: 'swarm', lat: -1.75, half: 3.6 }];
    d.pos = 140;
    d.lateral = 3.6;
    runAt(d, 60, 2000);
    expect(d.log.some((l) => l.text.includes('尸群'))).toBe(false);
  });

  it('搜掠：同侧外侧车道 + 该侧窗开 + 车速≤50 才收；归因开窗者', () => {
    const mk = (): DriveState => {
      const s = game();
      s.road.events = [{ at: 150, kind: 'loot', side: 'R', content: 'fuel' }];
      s.pos = 140;
      s.fuel = 40;
      return s;
    };
    const ok = mk();
    ok.lateral = 3.5;
    driveIntent(ok, 'b', { k: 'window', side: 'R' }, NOW);
    runAt(ok, 20, 6000);
    expect(ok.players[1]!.loots).toBe(1);
    expect(ok.fuel).toBeGreaterThan(40);

    expect(ok.fuel).toBeGreaterThan(45); // 40 + 至少 15，扣掉这几秒的油耗

    const mid = mk(); // 没贴外侧车道
    mid.lateral = 0;
    driveIntent(mid, 'b', { k: 'window', side: 'R' }, NOW);
    runAt(mid, 20, 6000);
    expect(mid.fuel).toBeLessThan(40); // 只烧油，没搜到
    expect(mid.players[1]!.loots).toBe(0);

    const closed = mk(); // 窗没开
    closed.lateral = 3.5;
    runAt(closed, 20, 6000);
    expect(closed.fuel).toBeLessThan(40);

    const fast = mk(); // 太快
    fast.lateral = 3.5;
    driveIntent(fast, 'b', { k: 'window', side: 'R' }, NOW);
    runAt(fast, 80, 3000);
    expect(fast.fuel).toBeLessThanOrEqual(40.1);
    expect(fast.players[1]!.loots).toBe(0);
  });

  it('加油站：停稳（<5km/h）在区内每秒 +30 油', () => {
    const s = game();
    s.road.events = [{ at: 120, kind: 'station', side: 'R' }];
    s.pos = 125;
    s.speed = 4;
    s.fuel = 40;
    run(s, 1000);
    expect(s.fuel).toBeGreaterThan(40);
    expect(s.fuel).toBeLessThanOrEqual(DRIVE_FUEL_MAX);
  });
});

describe('岗位与权限', () => {
  it('默认岗位：座位最靠前的驾驶员、其余副驾驶；权限随岗位', () => {
    const s = game();
    const va = view(s, 'a');
    const vb = view(s, 'b');
    expect([va.myRole, va.canDrive, va.canNavigate, va.solo]).toEqual(['drive', true, false, false]);
    expect([vb.myRole, vb.canDrive, vb.canNavigate]).toEqual(['navigate', false, true]);
    expect(isSolo(s)).toBe(false);
  });

  it('非驾驶位发油门/转向被拒；驾驶位发导航操作被拒；导航位可开窗/大灯/标记/喊话', () => {
    const s = game();
    expect(gas(s, 'b')).toBe(false);
    expect(steer(s, 'b', 1)).toBe(false);
    expect(s.inputs.b).toBeUndefined();
    expect(driveIntent(s, 'a', { k: 'window', side: 'L' }, NOW)).toBe(false);
    expect(driveIntent(s, 'a', { k: 'lamp' }, NOW)).toBe(false);
    expect(driveIntent(s, 'a', { k: 'ping', at: 200, lat: 0 }, NOW)).toBe(false);
    expect(driveIntent(s, 'a', { k: 'call', i: 0 }, NOW)).toBe(false);
    expect(s.windows.L.open).toBe(false);
    expect(s.lamp).toBe(true);
    expect(s.pings).toHaveLength(0);
    expect(s.calls).toHaveLength(0);

    expect(driveIntent(s, 'b', { k: 'window', side: 'L' }, NOW)).toBe(true);
    expect(driveIntent(s, 'b', { k: 'lamp' }, NOW)).toBe(true);
    expect(driveIntent(s, 'b', { k: 'ping', at: 200, lat: 1 }, NOW)).toBe(true);
    expect(driveIntent(s, 'b', { k: 'call', i: 2 }, NOW)).toBe(true);
    expect([s.windows.L.open, s.lamp, s.pings.length, s.calls.length]).toEqual([true, false, 1, 1]);
    expect(gas(s, 'a')).toBe(true);
  });

  it('单人局一人全占：驾驶与导航权限皆有', () => {
    const s = game(1);
    expect(gas(s, 'a')).toBe(true);
    expect(steer(s, 'a', -1)).toBe(true);
    expect(driveIntent(s, 'a', { k: 'window', side: 'R' }, NOW)).toBe(true);
    expect(driveIntent(s, 'a', { k: 'call', i: 8 }, NOW)).toBe(true);
    const v = view(s, 'a');
    expect([v.solo, v.canDrive, v.canNavigate, v.drivers]).toEqual([true, true, true, 1]);
  });

  it('切岗位：即时生效并松手（原岗位持键清零）；视图片限随之翻转', () => {
    const s = game();
    gas(s, 'a');
    steer(s, 'a', 1);
    expect(driveIntent(s, 'a', { k: 'role', role: 'navigate' }, NOW)).toBe(true);
    expect(s.players[0]!.role).toBe('navigate');
    expect(s.inputs.a).toMatchObject({ gas: false, brake: false, steer: 0 });
    const va = view(s, 'a');
    expect([va.myRole, va.canDrive, va.canNavigate, va.drivers]).toEqual(['navigate', false, true, 0]);
    expect(driveIntent(s, 'a', { k: 'role', 'role': 'navigate' }, NOW)).toBe(false); // 重复切换幂等
    expect(driveIntent(s, 'a', { k: 'role', role: 'pilot' as never }, NOW)).toBe(false);
  });

  it('多人同驾：转向输入求和钳制、油门取或；只计驾驶位的在线在场玩家', () => {
    const s = game();
    s.players[1]!.role = 'drive';
    steer(s, 'a', 1);
    steer(s, 'b', -1);
    gas(s, 'b');
    expect(aggregateInputs(s, everyone(s))).toEqual({ gas: true, brake: false, steer: 0 });
    expect(steer(s, 'b', 1)).toBe(true);
    expect(aggregateInputs(s, everyone(s)).steer).toBe(1);
    // 掉线的驾驶员不计入
    expect(aggregateInputs(s, new Set(['a']))).toEqual({ gas: false, brake: false, steer: 1 });
  });
});

describe('喊话与标记', () => {
  it('喊话：只存下标、有冷却、非法下标丢弃、过期清出视图', () => {
    const s = game();
    expect(driveIntent(s, 'b', { k: 'call', i: 99 }, NOW)).toBe(false);
    expect(driveIntent(s, 'b', { k: 'call', i: 4 }, NOW)).toBe(true);
    expect(s.calls).toMatchObject([{ by: '乙', i: 4 }]);
    expect(driveIntent(s, 'b', { k: 'call', i: 5 }, NOW + 500)).toBe(false); // 冷却中
    expect(driveIntent(s, 'b', { k: 'call', i: 5 }, NOW + 1300)).toBe(true);
    expect(s.calls).toHaveLength(2);
    s.lastTickAt = NOW + 1300;
    run(s, 6500);
    expect(s.calls).toHaveLength(0);
  });

  it('标记：位置钳进车附近、最多 6 个、过期清出', () => {
    const s = game();
    for (let i = 0; i < 7; i++) driveIntent(s, 'b', { k: 'ping', at: 99_999, lat: -999 }, NOW + i);
    expect(s.pings).toHaveLength(6);
    expect(s.pings[0]).toMatchObject({ at: 600, lat: -40, by: '乙' });
    run(s, 8500);
    expect(s.pings).toHaveLength(0);
  });
});

describe('夜行者', () => {
  it('发车宽限：车还没跑起来时，停车不会惊动夜行者', () => {
    const s = game();
    addMonster(s, 30);
    run(s, 1000);
    expect(s.monsters[0]!.mode).toBe('wander');
  });

  it('停车惊动：停稳后惊动范围内的冲过来，范围外的不动；行驶中不惊动', () => {
    const s = game();
    s.moved = true;
    const near = addMonster(s, 30);
    const far = addMonster(s, DRIVE_HUNT_RANGE + 5);
    run(s, 200);
    expect(near.mode).toBe('hunt');
    expect(far.mode).toBe('wander');

    const d = game();
    d.moved = true;
    const m = addMonster(d, 30);
    runAt(d, 60, 500);
    expect(m.mode).toBe('wander');
  });

  it('冲刺合围：追上车就扒住，按方位决定左右侧，之后贴着车走', () => {
    const s = game();
    s.moved = true;
    const m = addMonster(s, 12, 1);
    run(s, 3000);
    expect(m.mode).toBe('latched');
    expect(m.side).toBe('R');
    expect(m.at).toBeCloseTo(s.pos, 5);
    expect(s.log.some((l) => l.text.includes('扒住了右侧车门'))).toBe(true);
    const l = game();
    l.moved = true;
    const left = addMonster(l, 12, -1);
    run(l, 3000);
    expect(left.side).toBe('L');
  });

  it('扒车撕扯：追上约 2.1s 后开始，之后每 2.5s 耐久 -1；多只共用节奏', () => {
    const s = game();
    s.moved = true;
    const m = addMonster(s, 6, 1);
    while (m.mode !== 'latched') driveTick(s, s.lastTickAt + 66, everyone(s), zero); // 逐拍推进到真正扒上
    const latchedAt = s.lastTickAt;
    expect(s.durability).toBe(s.maxDurability);
    let until = latchedAt; // 相对「扒上的那一拍」累加推进
    const advance = (ms: number): void => {
      until += ms;
      while (s.lastTickAt + 66 <= until) driveTick(s, s.lastTickAt + 66, everyone(s), zero);
    };
    advance(2000); // 扒上 2.0s：还没开始扣（下一拍才起计时，首次在约 2.1s）
    expect(s.durability).toBe(s.maxDurability);
    advance(400); // 扒上 2.4s：首次撕扯已发生
    expect(s.durability).toBe(s.maxDurability - 1);
    expect(s.mauls).toBe(1);
    advance(3000); // 扒上 5.4s：第二次撕扯（首次后 2.5s）已发生、第三次未到
    expect(s.durability).toBe(s.maxDurability - 2);
    expect(s.mauls).toBe(2);

    const two = game();
    two.moved = true;
    addMonster(two, 5, 1);
    addMonster(two, 5, -1);
    run(two, 4000); // 约 0.3s 扒上，首次撕扯在约 2.4s，第二次在约 4.9s 之外
    expect(two.monsters.filter((m) => m.mode === 'latched')).toHaveLength(2);
    expect(two.mauls).toBe(1); // 两只也只按一个节奏扣
    expect(two.durability).toBe(two.maxDurability - 1);
  });

  it('开着的那侧窗：扒着持续 2.5s 就爬进来——拖走开窗者；关窗即打断', () => {
    const s = game();
    s.moved = true;
    driveIntent(s, 'b', { k: 'window', side: 'R' }, NOW); // 乙开了右窗
    addMonster(s, 6, 1);
    run(s, 5500);
    expect(s.players[1]!.downed).toBe(true);
    expect(s.players[1]!.dragged).toBe(1);
    expect(s.monsters).toHaveLength(0); // 进车后移除
    expect(s.windows.R.open).toBe(false);
    expect(s.log.some((l) => l.text.includes('拖出了车外'))).toBe(true);

    const c = game();
    c.moved = true;
    driveIntent(c, 'b', { k: 'window', side: 'R' }, NOW);
    addMonster(c, 6, 1);
    run(c, 1800); // 已扒上并在爬窗
    const climbing = c.monsters[0]!;
    expect(climbing.mode).toBe('latched');
    expect(climbing.climbSince).toBeGreaterThan(0);
    driveIntent(c, 'b', { k: 'window', side: 'R' }, at(c)); // 乙及时关窗
    run(c, 3000);
    expect(c.players[1]!.downed).toBe(false);
    expect(climbing.mode).toBe('latched');
    expect(climbing.climbSince).toBe(0);
  });

  it('甩脱：车速过了甩脱线（基础 32 码）扒着的才被甩飞（计入搏斗），翻滚一小段后移除', () => {
    const s = game();
    s.moved = true;
    const m = addMonster(s, 6, 1);
    run(s, 1500);
    expect(m.mode).toBe('latched');
    s.speed = escapeSpeedOf(0) - 2;
    driveTick(s, at(s) + 66, everyone(s), zero);
    expect(m.mode).toBe('latched'); // 差一点没到线：还扒着
    s.speed = escapeSpeedOf(0) + 5;
    driveTick(s, at(s) + 66, everyone(s), zero);
    expect(m.mode).toBe('thrown');
    expect(s.crawls).toBe(1);
    expect(s.maulAt).toBe(0);
    run(s, 1400);
    expect(s.monsters).toHaveLength(0);
  });

  it('放弃：车跑起来后没追上的走回原位，回到游荡', () => {
    const s = game();
    s.moved = true;
    const m = addMonster(s, 40, 3); // 偏在右侧，车从它旁边驶过不会撞上
    run(s, 300);
    expect(m.mode).toBe('hunt');
    runAt(s, 45, 300); // 车开得比它快：它放弃
    expect(m.mode).toBe('return');
    runAt(s, 45, 3000);
    expect(m.mode).toBe('wander');
    expect(m.at).toBeCloseTo(40, 0);

    // 再次停车且仍在惊动范围内：会被再次惊动（状态机闭环）
    s.moved = true;
    s.speed = 0; // 停回它附近
    s.pos = m.at - 40;
    driveTick(s, at(s) + 66, everyone(s), zero);
    expect(m.mode).toBe('hunt');
  });

  it('行驶中撞上：耐久 -1、骤降速、噪音；低速撞开只减速不伤车', () => {
    const s = game();
    addMonster(s, 30);
    s.gap = 100;
    runAt(s, 60, 2000); // 16.7m/s，约 1.8s 撞上
    expect(s.durability).toBe(s.maxDurability - 1);
    expect(s.gap).toBeLessThan(100);
    expect(s.monsters[0]!.mode).toBe('thrown');
    run(s, 1400);
    expect(s.monsters).toHaveLength(0);

    const slow = game();
    addMonster(slow, 30);
    runAt(slow, 15, 8000); // 4.2m/s，约 7.2s 撞上
    expect(slow.durability).toBe(slow.maxDurability);
    expect(slow.monsters[0]!.mode).toBe('thrown');
  });

  it('生成流：第一只在第一块路牌之后；开局窗口全在路牌之前时一只都没有', () => {
    const wide = createDriveGame(PLAYERS, NOW, { signGap: 600 }, () => 0.5);
    expect(wide.monsters).toHaveLength(0); // 首只在 600+40+60=700m，超出开局 600m 的生成窗口
    const near = createDriveGame(PLAYERS, NOW, { signGap: 200 }, () => 0.5);
    expect(near.monsters.length).toBeGreaterThan(0);
    expect(near.monsters.every((m) => m.home >= 200)).toBe(true); // 都在第一块路牌之后
    expect(near.monsters[0]!.mode).toBe('wander');
    expect(Math.abs(near.monsters[0]!.lat)).toBeLessThanOrEqual(4.2); // 在路面上游荡
  });

  it('生成流：路牌越多越密（间隔随路牌数缩短，最短 150m）', () => {
    // 同样开 6000m，比较生成总数（monsterSeq 是累计计数，不受已驶过清理的影响）
    const countOver6km = (signs: number): number => {
      const s = createDriveGame(PLAYERS, NOW, {}, () => 0.5);
      s.monsters = [];
      s.monsterSeq = 0;
      s.road.nextMonsterAt = 0;
      for (let pos = 0; pos < 6000; pos += 600) {
        s.pos = pos;
        s.signs = signs;
        s.nextSignAt = 0; // 这一段全在「已过 signs 块路牌」之后
        driveTick(s, NOW + 66 + pos, everyone(s), () => 0.5);
      }
      return s.monsterSeq;
    };
    const early = countOver6km(0);
    const mid = countOver6km(6);
    const late = countOver6km(20);
    expect(early).toBe(20); // 6000m ÷ 315m（抖动因子 1.0）：0、315、…、5985 共 20 只
    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);
    expect(late).toBe(40); // 6000m ÷ 最短间隔 150m：0、150、…、5850 共 40 只
  });

  it('生成流：第 4 号路牌起会成对出现（相距 12~30m）', () => {
    const s = createDriveGame(PLAYERS, NOW, {}, () => 0.1);
    s.monsters = [];
    s.monsterSeq = 0;
    s.road.nextMonsterAt = 0;
    s.pos = 0;
    s.signs = 3; // 开到这里已是第 4 块路牌之后
    s.nextSignAt = 0;
    driveTick(s, NOW + 66, everyone(s), () => 0.1);
    expect(s.monsters.length).toBeGreaterThanOrEqual(4);
    expect(s.monsters.length % 2).toBe(0);
    for (let i = 0; i < s.monsters.length; i += 2) {
      const gap = s.monsters[i + 1]!.home - s.monsters[i]!.home;
      expect(gap).toBeGreaterThanOrEqual(12);
      expect(gap).toBeLessThanOrEqual(30);
    }
    // 路牌数不够时不成对
    const t = createDriveGame(PLAYERS, NOW, {}, () => 0.1);
    t.monsters = [];
    t.monsterSeq = 0;
    t.road.nextMonsterAt = 0;
    t.signs = 0;
    t.nextSignAt = 0;
    driveTick(t, NOW + 66, everyone(t), () => 0.1);
    for (let i = 1; i < t.monsters.length; i++) expect(t.monsters[i]!.home - t.monsters[i - 1]!.home).toBeGreaterThan(100);
  });
});

describe('窗爬者', () => {
  it('预警→爬入→开窗者被拖走（不扣耐久）；下个路牌复活', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'role', role: 'navigate' }, NOW);
    driveIntent(s, 'a', { k: 'window', side: 'L' }, NOW);
    run(s, DRIVE_CRAWL_FIRST_MS + DRIVE_WARN_MS + DRIVE_CLIMB_MS + 300);
    expect(s.crawls).toBe(1);
    expect(s.players[0]!.downed).toBe(true);
    expect(s.durability).toBe(s.maxDurability);
    expect(driveIntent(s, 'a', { k: 'gas', on: true }, at(s))).toBe(false); // 被拖走的人不能操作
    expect(view(s, 'a').iDowned).toBe(true);
    s.speed = 30;
    s.pos = s.nextSignAt - 1;
    run(s, 500);
    expect(s.players[0]!.downed).toBe(false);
  });

  it('两窗全关：爬窗无从下手，无伤害', () => {
    const s = game();
    run(s, DRIVE_CRAWL_FIRST_MS + DRIVE_WARN_MS + DRIVE_CLIMB_MS + 300);
    expect(s.crawls).toBe(0);
    expect(s.durability).toBe(s.maxDurability);
    expect(s.nextCrawlAt).toBeGreaterThan(s.lastTickAt - 2_100);
  });
});

describe('猎影与胜负', () => {
  it('低于勿停线按凶度衰减，归零扑击扣耐久并回置', () => {
    const s = game();
    run(s, 2000);
    expect(s.gap).toBeCloseTo(88.12, 2);
    s.tail = 'fierce';
    s.gap = 8;
    run(s, 1500);
    expect(s.attacks).toBe(1);
    expect(s.durability).toBe(s.maxDurability - 1);
    // 扑击后回置 50，但车仍停着：凶档继续衰减，此刻已低于回置值
    expect(s.gap).toBeLessThan(DRIVE_ATTACK_RESET);
    expect(s.gap).toBeGreaterThan(40);
  });

  it('到达目标路牌全员逃生；耐久归零车毁；终止与断线终局', () => {
    const s = game();
    s.targetSigns = 1;
    s.speed = 30;
    s.pos = s.nextSignAt - 1;
    run(s, 500);
    expect(s.result).toMatchObject({ reason: 'won', signs: 1 });

    const d = game();
    d.durability = 1;
    d.road.events = [{ at: 10, kind: 'barrier', lat: 0, half: 1.3 }];
    d.speed = 60;
    gas(d, 'a');
    run(d, 3000);
    expect(d.result?.reason).toBe('dead');

    const a = game();
    expect(driveAbort(a, NOW + 5000)).toBe(true);
    expect(a.result?.reason).toBe('abort');
    const f = game();
    expect(driveForceEnd(f, NOW + 9000)).toBe(true);
    expect(f.result).toMatchObject({ reason: 'idle', durationMs: 9000 });
  });

  it('离开：清持键与喊话冷却、清开窗归因；全员离开即终局', () => {
    const s = game();
    gas(s, 'a');
    driveIntent(s, 'b', { k: 'window', side: 'R' }, NOW);
    driveIntent(s, 'b', { k: 'call', i: 0 }, NOW);
    driveLeave(s, 'b', NOW + 100);
    expect(s.inputs.b).toBeUndefined();
    expect(s.callAt.b).toBeUndefined();
    expect(s.windows.R.open).toBe(true); // 窗还开着，但归因已清空
    expect(s.windows.R.opener).toBeNull();
    expect(s.phase).toBe('driving');
    driveLeave(s, 'a', NOW + 200);
    expect(s.result?.reason).toBe('leave');
    expect(driveLeave(s, 'b', NOW + 300)).toBe(false);
  });
});

describe('视图', () => {
  it('下发车辆状态、总转向输入、附近的夜行者与弯道；局外会话按观战处理', () => {
    const s = game();
    steer(s, 'a', 1);
    const near = addMonster(s, 120, 2, { mode: 'hunt', vs: -5, vx: -1 });
    addMonster(s, 2000);
    const v = view(s, 'a');
    expect(v.steerIn).toBe(1);
    expect(v.escapeSpeed).toBe(32); // 基础甩脱线
    s.signs = 6;
    expect(view(s, 'a').escapeSpeed).toBe(42); // 路牌越多，夜行者越快，甩脱线越高
    expect(v.myInputs).toMatchObject({ steer: 1 });
    expect(v.monsters).toHaveLength(1);
    expect(v.monsters[0]).toMatchObject({ id: near.id, mode: 'hunt', side: null, climbLeft: null });
    expect(v.curves.every((c) => c.at < s.pos + 450)).toBe(true);
    const vz = view(s, 'zz');
    expect([vz.spectator, vz.myInputs, vz.canDrive, vz.canNavigate]).toEqual([true, null, false, false]);
    const vb = view(s, 'b');
    expect(vb.myInputs).toMatchObject({ gas: false, brake: false, steer: 0 });
  });
});
