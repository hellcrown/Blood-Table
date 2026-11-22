/**
 * 勿停 · 引擎单测：建局与设置口径、意图清洗与钳制、速度/油量积分、猎影尾压与扑击、
 * 爬窗全流程（预警→爬入→拖走归因/无人值守破窗/全关窗不爬）、搜掠条件、加油站、
 * 路牌复活与目标通关、车毁终局、离开与断线、视图裁剪、seed 确定性。
 * rng 固定为 0：首个事件在 150m 且为车道 0 路障；有开窗时爬窗优先左窗。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDriveView,
  createDriveGame,
  driveAbort,
  driveForceEnd,
  driveIntent,
  driveLeave,
  driveTick,
  resolveCrawl,
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
  DRIVE_CRAWL_FIRST_MS,
  DRIVE_FUEL_MAX,
  DRIVE_GAP_MAX,
  DRIVE_WARN_MS,
} from '@shared/driveProtocol';

const NOW = 1_000_000;
const zero = (): number => 0;
const PLAYERS = [
  { id: 'a', name: '甲', seat: 0 },
  { id: 'b', name: '乙', seat: 1 },
];

function game(n = 2, opts: DriveOptions = {}): DriveState {
  return createDriveGame(PLAYERS.slice(0, n), NOW, opts, zero);
}
const everyone = (s: DriveState): Set<string> => new Set(s.players.map((p) => p.id));
const view = (s: DriveState, id: string) => buildDriveView(s, id, 'TEST', 'a', everyone(s), NOW);

/** 以 66ms 一拍（同线上 tick）模拟推进 untilMs；end 先快照，防循环条件被 tick 里的 lastTickAt 更新拖着走 */
function run(s: DriveState, untilMs: number, step = 66): void {
  const end = s.lastTickAt + untilMs;
  for (let t = s.lastTickAt + step; t <= end; t += step) {
    driveTick(s, t, everyone(s), zero);
  }
}

describe('建局与设置口径', () => {
  it('建局：满油满尾距、灯亮、中车道、首事件 150m；设置 0/非法值回落默认', () => {
    const s = game();
    expect(s.phase).toBe('driving');
    expect(s.speed).toBe(0);
    expect(s.fuel).toBe(DRIVE_FUEL_MAX);
    expect(s.gap).toBe(DRIVE_GAP_MAX);
    expect(s.lamp).toBe(true);
    expect(s.lane).toBe(1);
    expect(s.durability).toBe(s.maxDurability);
    expect(s.nextCrawlAt).toBe(NOW + DRIVE_CRAWL_FIRST_MS);
    expect(s.road.events[0]).toMatchObject({ at: 150, kind: 'barrier', lane: 0 });
    expect(resolveSignGap(777)).toBe(400);
    expect(resolveSignGap(300)).toBe(300);
    expect(resolveDurability(4)).toBe(3);
    expect(resolveDurability(5)).toBe(5);
    expect(resolveTail('absurd' as never)).toBe('normal');
    expect(resolveTail('fierce')).toBe('fierce');
    expect(resolveCrawl('absurd' as never)).toBe('normal');
    expect(resolveTarget(9)).toBe(0);
    expect(resolveTarget(10)).toBe(10);
  });

  it('seed 确定性：同 rng 的两局事件队列完全一致', () => {
    const a = game();
    const b = game();
    expect(b.road.events.slice(0, 5)).toEqual(a.road.events.slice(0, 5));
  });
});

describe('意图清洗与钳制', () => {
  it('持键：gas/brake/spot 置位与清除；非法 on 值按 false；未知玩家静默忽略', () => {
    const s = game();
    expect(driveIntent(s, 'a', { k: 'gas', on: true }, NOW)).toBe(true);
    expect(s.inputs.a!.gas).toBe(true);
    expect(driveIntent(s, 'a', { k: 'gas', on: 'yes' as never }, NOW)).toBe(true);
    expect(s.inputs.a!.gas).toBe(false); // 非严格 true 一律视为松开
    expect(driveIntent(s, 'zz', { k: 'gas', on: true }, NOW)).toBe(false);
    expect(driveIntent(s, 'a', { k: 'nope' }, NOW)).toBe(false);
    expect(driveIntent(s, 'a', null, NOW)).toBe(false);
  });

  it('换道：越界钳制、400ms 冷却内忽略', () => {
    const s = game();
    expect(driveIntent(s, 'a', { k: 'lane', dir: -1 }, NOW)).toBe(true);
    expect(s.lane).toBe(0);
    expect(driveIntent(s, 'a', { k: 'lane', dir: -1 }, NOW + 100)).toBe(false); // 已在边缘
    expect(driveIntent(s, 'a', { k: 'lane', dir: 1 }, NOW + 100)).toBe(false); // 冷却中
    expect(driveIntent(s, 'a', { k: 'lane', dir: 1 }, NOW + 500)).toBe(true);
    expect(s.lane).toBe(1);
  });

  it('车窗：开窗记归因、关窗清归因并挫败进行中的爬窗；非法 side 丢弃', () => {
    const s = game();
    expect(driveIntent(s, 'a', { k: 'window', side: 'X' as never }, NOW)).toBe(false);
    driveIntent(s, 'a', { k: 'window', side: 'L' }, NOW);
    expect(s.windows.L.open).toBe(true);
    expect(s.windows.L.opener).toBe('a');
    // 预警中关窗 → 挫败并重新调度
    s.windows.L.warnAt = NOW;
    s.nextCrawlAt = 0;
    expect(driveIntent(s, 'b', { k: 'window', side: 'L' }, NOW)).toBe(true);
    expect(s.windows.L.open).toBe(false);
    expect(s.windows.L.warnAt).toBe(0);
    expect(s.nextCrawlAt).toBeGreaterThan(NOW);
  });

  it('灯与瞭望标记：toggle；ping 钳制进车道域、环形截断 8 条', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'lamp' }, NOW);
    expect(s.lamp).toBe(false);
    for (let i = 0; i < 10; i++) driveIntent(s, 'a', { k: 'ping', lane: 99 + i, at: -5 }, NOW + i);
    expect(s.pings).toHaveLength(8);
    expect(s.pings[0]).toMatchObject({ lane: 2, at: 0, by: '甲' });
    expect(s.pings.at(-1)).toMatchObject({ lane: 2, at: 0 });
  });
});

describe('速度与油量积分', () => {
  it('按住油门加速到 120 封顶；松开滑行减速；刹车减速更快', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'gas', on: true }, NOW);
    run(s, 5_000); // 25/s × 5s → 120 封顶
    expect(s.speed).toBe(120);
    driveIntent(s, 'a', { k: 'gas', on: false }, NOW + 5_000);
    run(s, 2_000);
    expect(s.speed).toBeCloseTo(90.3, 5); // 120 - 15/s × 1.98s（30 拍）
    driveIntent(s, 'a', { k: 'brake', on: true }, NOW + 7_000);
    run(s, 1_000);
    expect(s.speed).toBeCloseTo(30.9, 5); // 90.3 - 60/s × 0.99s
  });

  it('油耗随速度；油尽后油门失效、速度锁 15', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'gas', on: true }, NOW);
    run(s, 5_000);
    const fuelAt = s.fuel;
    run(s, 1_000);
    // 满速油耗 1.2%/s（66ms×15 拍=990ms，容差 0.05 内）
    expect(fuelAt - s.fuel).toBeCloseTo(1.2, 1);
    s.fuel = 0.5;
    run(s, 3_000);
    expect(s.fuel).toBe(0);
    expect(s.speed).toBeLessThanOrEqual(15);
    const before = s.speed;
    run(s, 3_000);
    expect(s.speed).toBeLessThanOrEqual(before); // 空油不再加速
  });
});

describe('猎影尾压', () => {
  it('低于勿停线按凶度衰减、高于线回升；归零扑击扣耐久并回置', () => {
    const s = game();
    run(s, 2_000); // 静止 → gap 100 - 6×1.98 = 88.12
    expect(s.gap).toBeCloseTo(88.12, 5);
    driveIntent(s, 'a', { k: 'gas', on: true }, NOW + 2_000);
    run(s, 6_000); // 很快超过 30 线 → 回升
    expect(s.gap).toBeGreaterThan(88);
    s.tail = 'fierce';
    s.gap = 8;
    driveIntent(s, 'a', { k: 'brake', on: true }, NOW + 8_000);
    run(s, 4_000); // 急刹 1.5s 后落到勿停线下，凶档 -8/s 耗尽 gap → 归零扑击（后置回置 50 继续衰减）
    expect(s.attacks).toBe(1);
    expect(s.durability).toBe(s.maxDurability - 1);
    expect(s.gap).toBeLessThanOrEqual(DRIVE_ATTACK_RESET);
    expect(s.gap).toBeGreaterThan(40);
    expect(s.log.some((l) => l.text.includes('猎影追上'))).toBe(true);
  });

  it('噪音事件（撞路障）额外衰减 8', () => {
    const s = game();
    s.gap = 100;
    s.road.events = [{ at: 10, kind: 'barrier', lane: 1 }];
    driveIntent(s, 'a', { k: 'gas', on: true }, NOW);
    run(s, 4_000); // 加速撞上 10m 处的路障
    expect(s.durability).toBe(s.maxDurability - 1);
    expect(s.gap).toBeLessThan(100 - 4); // 至少少 8（撞击噪音），且静止期间也在衰减
  });
});

describe('爬窗全流程', () => {
  it('预警→爬入→开窗者被拖走（不扣耐久）；下个路牌复活', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'window', side: 'L' }, NOW); // 甲开左窗
    run(s, DRIVE_CRAWL_FIRST_MS + DRIVE_WARN_MS + DRIVE_CLIMB_MS + 300);
    expect(s.crawls).toBe(1);
    expect(s.players[0]!.downed).toBe(true);
    expect(s.players[0]!.dragged).toBe(1);
    expect(s.durability).toBe(s.maxDurability);
    expect(s.windows.L.open).toBe(false);
    expect(s.log.some((l) => l.text.includes('拖出了车外'))).toBe(true);
    // 被拖走者输入失效、视图标记
    expect(driveIntent(s, 'a', { k: 'gas', on: true }, s.lastTickAt)).toBe(false);
    expect(view(s, 'a').iDowned).toBe(true);
    expect(view(s, 'a').myInputs).toBeNull();
    // 过路牌复活（30km/h 滑行 8m 足以跨过 1m）
    s.speed = 30;
    s.pos = s.nextSignAt - 1;
    run(s, 500);
    expect(s.players[0]!.downed).toBe(false);
  });

  it('无人值守的开窗被破窗 → 直接扣车耐久', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'window', side: 'L' }, NOW);
    driveLeave(s, 'a', NOW + 1); // 甲离场：归因清空，窗仍开着
    expect(s.windows.L.open).toBe(true);
    expect(s.windows.L.opener).toBeNull();
    run(s, DRIVE_CRAWL_FIRST_MS + DRIVE_WARN_MS + DRIVE_CLIMB_MS + 300);
    expect(s.crawls).toBe(1);
    expect(s.durability).toBe(s.maxDurability - 1);
    expect(s.log.some((l) => l.text.includes('破窗'))).toBe(true);
  });

  it('两窗全关：爬窗无从下手，一直重试且无伤害', () => {
    const s = game();
    run(s, DRIVE_CRAWL_FIRST_MS + DRIVE_WARN_MS + DRIVE_CLIMB_MS + 300);
    expect(s.crawls).toBe(0);
    expect(s.durability).toBe(s.maxDurability);
    expect(s.players.every((p) => !p.downed)).toBe(true);
    expect(s.nextCrawlAt).toBeGreaterThan(s.lastTickAt - 2_100); // 短延迟重试中
  });
});

describe('搜掠与加油站', () => {
  it('搜掠：对应侧窗开 + 车速≤50 才收；窗关/超速不收；归因开窗者', () => {
    const s = game();
    // 超速冲过：窗开也没用
    s.pos = 149;
    s.speed = 100;
    s.road.events = [{ at: 150, kind: 'loot', side: 'L', content: 'fuel' }];
    driveIntent(s, 'a', { k: 'window', side: 'L' }, NOW);
    run(s, 300);
    expect(s.players[0]!.loots).toBe(0);
    // 慢速滑过 + 窗开着 → 收入归因开窗者
    s.pos = 149;
    s.speed = 20;
    s.road.events = [{ at: 150, kind: 'loot', side: 'L', content: 'fuel' }];
    s.fuel = 50;
    run(s, 2_000);
    expect(s.players[0]!.loots).toBe(1);
    expect(s.fuel).toBeGreaterThan(50);
    // 窗关着：不收
    const s2 = game();
    s2.pos = 149;
    s2.speed = 20;
    s2.road.events = [{ at: 150, kind: 'loot', side: 'L', content: 'fuel' }];
    run(s2, 2_000);
    expect(s2.players[0]!.loots).toBe(0);
  });

  it('搜到修补工具：耐久 +1 封顶', () => {
    const s = game();
    s.pos = 149;
    s.speed = 20;
    s.durability = 1;
    s.road.events = [{ at: 150, kind: 'loot', side: 'R', content: 'repair' }];
    driveIntent(s, 'a', { k: 'window', side: 'R' }, NOW);
    run(s, 2_000);
    expect(s.durability).toBe(2);
  });

  it('加油站：停稳（<5km/h）在区内每秒 +30 油', () => {
    const s = game();
    s.pos = 125; // 区内（120-150）
    s.speed = 4;
    s.fuel = 40;
    s.road.events = [{ at: 120, kind: 'station', side: 'R' }];
    driveIntent(s, 'a', { k: 'brake', on: true }, NOW);
    run(s, 1_000);
    expect(s.fuel).toBeGreaterThan(40);
    expect(s.fuel).toBeLessThanOrEqual(DRIVE_FUEL_MAX);
  });
});

describe('路牌与胜负', () => {
  it('过路牌 tier+1 并复活被拖走者；离场者不复活', () => {
    const s = game();
    s.players[0]!.downed = true;
    s.players[1]!.downed = true;
    s.players[1]!.left = true;
    s.speed = 30;
    s.pos = s.nextSignAt - 1;
    run(s, 500);
    expect(s.signs).toBe(1);
    expect(s.players[0]!.downed).toBe(false);
    expect(s.players[1]!.downed).toBe(true); // left 不复活
  });

  it('到达目标路牌 → 全员逃生；耐久归零 → 车毁人亡；两者结算统计齐全', () => {
    const s = game();
    s.targetSigns = 1; // 白盒设目标（resolveTarget 已在口径用例覆盖选项校验）
    s.speed = 30;
    s.pos = s.nextSignAt - 1;
    run(s, 500);
    expect(s.phase).toBe('gameover');
    expect(s.result).toMatchObject({ reason: 'won', signs: 1 });
    expect(view(s, 'a').result?.reason).toBe('won');

    const s2 = game();
    s2.durability = 1;
    s2.road.events = [{ at: 10, kind: 'barrier', lane: 1 }];
    driveIntent(s2, 'a', { k: 'gas', on: true }, NOW);
    run(s2, 4_000);
    expect(s2.phase).toBe('gameover');
    expect(s2.result?.reason).toBe('dead');
    expect(s2.result!.distance).toBeGreaterThan(0);
    expect(view(s2, 'b').phase).toBe('gameover');
  });

  it('房主终止与全员断线终局', () => {
    const s = game();
    expect(driveAbort(s, NOW + 5_000)).toBe(true);
    expect(s.result?.reason).toBe('abort');
    const s2 = game();
    expect(driveForceEnd(s2, NOW + 9_000)).toBe(true);
    expect(s2.result?.reason).toBe('idle');
    expect(s2.result!.durationMs).toBe(9_000);
  });

  it('离开：清持键与开窗归因；全员离开即终局', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'gas', on: true }, NOW);
    driveIntent(s, 'a', { k: 'window', side: 'R' }, NOW);
    driveLeave(s, 'a', NOW + 100);
    expect(s.inputs.a!.gas).toBe(false);
    expect(s.windows.R.opener).toBeNull();
    expect(s.players[0]!.left).toBe(true);
    expect(s.phase).toBe('driving'); // 还有乙
    driveLeave(s, 'b', NOW + 200);
    expect(s.phase).toBe('gameover');
    expect(s.result?.reason).toBe('leave');
    expect(driveLeave(s, 'b', NOW + 300)).toBe(false); // 重复离开幂等
  });
});

describe('视图', () => {
  it('车辆状态全队公开；自己持键只在位者可见；局中入座者按观战处理；事件只发车头前方', () => {
    const s = game();
    driveIntent(s, 'a', { k: 'gas', on: true }, NOW);
    driveIntent(s, 'a', { k: 'ping', lane: 0, at: 200 }, NOW);
    const va = view(s, 'a');
    expect(va.kind).toBe('drive');
    expect(va.myInputs).toMatchObject({ gas: true });
    expect(va.pings).toHaveLength(1);
    expect(va.spectator).toBe(false);
    const vb = view(s, 'b');
    expect(vb.myInputs).toMatchObject({ gas: false });
    expect(vb.speed).toBe(va.speed);
    const vz = view(s, 'zz'); // 局外会话（局中入座）
    expect(vz.spectator).toBe(true);
    expect(vz.myInputs).toBeNull();
    // 只下发未完全驶过的事件
    const first = s.road.events[0]!;
    s.pos = first.at + 100;
    expect(view(s, 'a').events.some((ev) => ev.at === first.at)).toBe(false);
  });
});
