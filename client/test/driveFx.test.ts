/**
 * 勿停 · 帧间平滑单测（node）：新视图对齐、转向预测领先于服务端、向服务端校正、
 * 停顿后直接对齐、特效按帧衰减与持续震动、怪物位置插值与增删、被惊动脉冲。
 */
import { describe, expect, it } from 'vitest';
import { stepSteering } from '@shared/driveProtocol';
import { DriveFx } from '../src/drive/fx';
import { drvView } from './driveFixture';

/** 以 stepMs 一帧推进 count 帧，返回结束时刻 */
function frames(fx: DriveFx, view: ReturnType<typeof drvView>, from: number, count: number, stepMs = 16): number {
  let now = from;
  for (let i = 0; i < count; i++) {
    now += stepMs;
    fx.frame(now, stepMs, view);
  }
  return now;
}

describe('DriveFx · 对齐与校正', () => {
  it('新一局：里程/横向/车头角直接对齐服务端', () => {
    const fx = new DriveFx();
    fx.onView(drvView({ pos: 100, lateral: 0.5, rel: 0.1, speed: 48 }), 0);
    expect([fx.pos, fx.lateral, fx.rel]).toEqual([100, 0.5, 0.1]);
    expect(fx.speed).toBe(48);
  });

  it('里程按车速外推：60km/h 一秒前进约 16.7m', () => {
    const fx = new DriveFx();
    const v = drvView({ speed: 60 });
    fx.onView(v, 0);
    frames(fx, v, 0, 60);
    expect(fx.pos - 1000).toBeGreaterThan(15);
    expect(fx.pos - 1000).toBeLessThan(17.5);
  });

  it('松键回正的预测：本地按下转向，第一帧车头角就开始动（服务端还没跟上）', () => {
    const fx = new DriveFx();
    const v = drvView({ speed: 36 });
    fx.onView(v, 0);
    fx.steerLocal = 1;
    fx.frame(16, 16, v);
    expect(fx.rel).toBeGreaterThan(0);
    expect(fx.wheel).toBeGreaterThan(0);
    let now = 16;
    now = frames(fx, v, now, 9);
    expect(fx.rel).toBeGreaterThan(0.08);
    expect(fx.lateral).toBeGreaterThan(0);
    expect(v.rel).toBe(0); // 服务端那一帧确实还是 0
  });

  it('预测与服务端同方程：服务端 100ms 才收到一次按键，之后客户端平滑值紧跟真实值', () => {
    const fx = new DriveFx();
    // 「真实」车：与服务端同样的积分，只是步长更粗（视图 10Hz 一次）
    const truth = { lateral: 0, rel: 0, speed: 36 };
    let v = drvView({ speed: 36 });
    fx.onView(v, 0);
    fx.steerLocal = 1;
    let now = 0;
    let serverAt = 0;
    let maxErr = 0;
    let leadAtAck = 0;
    while (now < 1500) {
      now += 16;
      fx.frame(now, 16, v);
      if (now - serverAt >= 100) {
        // 服务端这一拍才收到按键并积分（之前它不知道玩家按了键）
        if (serverAt === 0) leadAtAck = fx.rel;
        stepSteering(truth, 1, 0, (now - serverAt) / 1000);
        serverAt = now;
        v = drvView({ speed: 36, lateral: truth.lateral, rel: truth.rel, steerIn: 1 });
        fx.onView(v, now);
      } else if (now >= 400) {
        // 与解析真值比（车头角 1 rad/s 增长、0.5s 触顶）：两次下发之间真值也在连续变化
        maxErr = Math.max(maxErr, Math.abs(fx.rel - Math.min(0.5, now / 1000)));
      }
    }
    expect(leadAtAck).toBeGreaterThan(0.04); // 服务端确认之前，预测已经先把车头转起来了
    expect(maxErr).toBeLessThan(0.02); // 确认之后只剩那一点尚未衰减完的领先量，越来越小
    expect(fx.rel).toBeCloseTo(0.5, 6); // 触顶后与服务端完全一致（稳态误差为零）
  });

  it('服务端位置跳变（丢包后补帧）：平滑值在几百毫秒内贴过去，不瞬移', () => {
    const fx = new DriveFx();
    const v0 = drvView({ speed: 0 });
    fx.onView(v0, 0);
    let now = frames(fx, v0, 0, 5);
    fx.onView(drvView({ speed: 0, lateral: 2 }), now);
    now = frames(fx, drvView({ speed: 0, lateral: 2 }), now, 3);
    expect(fx.lateral).toBeGreaterThan(0);
    expect(fx.lateral).toBeLessThan(1.5); // 没有瞬移
    now = frames(fx, drvView({ speed: 0, lateral: 2 }), now, 60);
    expect(Math.abs(fx.lateral - 2)).toBeLessThan(0.02);
  });

  it('长时间没有帧（后台页）：回来时直接对齐，不做大步追赶', () => {
    const fx = new DriveFx();
    const v = drvView({ speed: 60 });
    fx.onView(v, 0);
    let now = frames(fx, v, 0, 5);
    now += 5000;
    fx.frame(now, 16, v); // 停顿后的第一帧：里程直接贴回服务端那一帧的值
    expect(fx.pos).toBe(1000);
  });
});

describe('DriveFx · 特效', () => {
  it('过路牌闪现、耐久下降震屏红闪，均按帧衰减归零', () => {
    const fx = new DriveFx();
    let v = drvView({ signs: 2, durability: 3, speed: 0 });
    fx.onView(v, 0);
    let now = frames(fx, v, 0, 2);
    expect(fx.signFlash).toBe(0);
    v = drvView({ signs: 3, durability: 2, speed: 0 });
    fx.onView(v, now);
    expect([fx.signFlash, fx.signNo, fx.flash]).toEqual([1, 3, 1]);
    now = frames(fx, v, now, 1);
    expect(fx.shake).toBeGreaterThan(0.9); // 震屏从下一帧起生效
    now = frames(fx, v, now, 10);
    expect(fx.flash).toBeLessThan(1);
    now = frames(fx, v, now, 200);
    expect(fx.flash).toBe(0);
    expect(fx.signFlash).toBe(0);
    expect(fx.shake).toBe(0);
  });

  it('持续震动：路肩颠簸 / 被扒车，情况解除即恢复平静', () => {
    const fx = new DriveFx();
    let v = drvView({ speed: 0, offRoad: true });
    fx.onView(v, 0);
    let now = frames(fx, v, 0, 3);
    expect(fx.shake).toBeGreaterThan(0.05);
    v = drvView({ speed: 0, offRoad: false });
    fx.onView(v, now);
    now = frames(fx, v, now, 60);
    expect(fx.shake).toBe(0);
    v = drvView({ speed: 0, monsters: [{ id: 1, at: 1000, lat: 2.3, mode: 'latched', side: 'R', vs: 0, vx: 0, climbLeft: null }] });
    fx.onView(v, now);
    expect(fx.latched).toBe(1);
    now = frames(fx, v, now, 3);
    expect(fx.shake).toBeGreaterThanOrEqual(0.28);
  });

  it('被扒的是哪一侧：maulL / maulR 随扒车怪的所在侧切换，甩掉后归零', () => {
    const fx = new DriveFx();
    const latched = (id: number, side: 'L' | 'R') => ({ id, at: 1000, lat: side === 'L' ? -2.3 : 2.3, mode: 'latched' as const, side, vs: 0, vx: 0, climbLeft: null });
    fx.onView(drvView({ speed: 0, monsters: [latched(1, 'L')] }), 0);
    expect([fx.maulL, fx.maulR]).toEqual([1, 0]);
    fx.onView(drvView({ speed: 0, monsters: [latched(1, 'L'), latched(2, 'R')] }), 100);
    expect([fx.maulL, fx.maulR]).toEqual([1, 1]); // 两边都被扒：两边都亮
    fx.onView(drvView({ speed: 30, monsters: [] }), 200);
    expect([fx.maulL, fx.maulR]).toEqual([0, 0]);
  });

  it('爬窗红光由窗状态驱动：预警半亮、爬入全亮', () => {
    const fx = new DriveFx();
    fx.onView(drvView({ windows: { L: { open: false, warn: true, climbLeft: null }, R: { open: false, warn: false, climbLeft: null } } }), 0);
    expect([fx.crawlL, fx.crawlR]).toEqual([0.55, 0]);
    fx.onView(drvView({ windows: { L: { open: true, warn: false, climbLeft: 1800 }, R: { open: false, warn: false, climbLeft: null } } }), 100);
    expect(fx.crawlL).toBe(1);
  });
});

describe('DriveFx · 怪物插值', () => {
  it('按速度外推并跟随目标；视图里消失即移除', () => {
    const fx = new DriveFx();
    const monster = { id: 7, at: 1000, lat: 0, mode: 'hunt' as const, side: null, vs: 5, vx: -1, climbLeft: null };
    let v = drvView({ speed: 0, monsters: [monster] });
    fx.onView(v, 0);
    expect(fx.monsters.size).toBe(1);
    let now = frames(fx, v, 0, 60); // 约 1 秒
    const m = fx.monsters.get(7)!;
    expect(m.at - 1000).toBeGreaterThan(4.4);
    expect(m.at - 1000).toBeLessThan(5.6);
    expect(m.lat).toBeLessThan(-0.9);
    expect(m.mode).toBe('hunt');
    // 服务端之后报告它被甩飞
    v = drvView({ speed: 0, monsters: [{ ...monster, at: 1005, lat: -1, mode: 'thrown', vs: 8, vx: 2 }] });
    fx.onView(v, now);
    expect(fx.monsters.get(7)!.mode).toBe('thrown');
    now = frames(fx, v, now, 10);
    expect(fx.monsters.get(7)!.vs).toBeLessThan(8); // 被甩飞后减速
    fx.onView(drvView({ speed: 0, monsters: [] }), now);
    expect(fx.monsters.size).toBe(0);
  });

  it('被惊动数量与脉冲：数量上升的那一帧取到一次，之后不再重复', () => {
    const fx = new DriveFx();
    const hunt = { id: 1, at: 1040, lat: 0, mode: 'hunt' as const, side: null, vs: -5, vx: 0, climbLeft: null };
    fx.onView(drvView({ speed: 0 }), 0);
    expect(fx.takeHuntPulse()).toBe(false);
    fx.onView(drvView({ speed: 0, monsters: [hunt] }), 100);
    expect(fx.hunting).toBe(1);
    expect(fx.takeHuntPulse()).toBe(true);
    expect(fx.takeHuntPulse()).toBe(false);
    fx.onView(drvView({ speed: 0, monsters: [hunt] }), 200); // 数量没变：不再响
    expect(fx.takeHuntPulse()).toBe(false);
  });
});
