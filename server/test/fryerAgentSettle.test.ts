/**
 * 特工 × 炸鸡店老板 结算确认时序回归（用户实测报障：老板没确认演示就被扔进删牌，
 * 删完 sdConfirm 没有浮层可关，全桌干等 30s 自动确认，特工「卡在等待确认」）。
 *
 * 根因：view.ts promptFor 的挂起 switch 对 pend.seat===p.id 直接返回互动提示，
 * settle 分支里的「未确认演示先返回 sdConfirm」门被整个短路成死代码。
 * 修复：门上提到挂起 switch 之前。本文件钉死修复后的提示顺序。
 */
import { describe, expect, it } from 'vitest';
import {
  bAgentAsk,
  bAgentDecide,
  bCrownBid,
  bFryerDel,
  bPickChar,
  bPlay,
  bSetup,
  bShowdownDone,
  bSwapStop,
  bloodTick,
  createBloodGame,
} from '../src/blood/engine';
import { promptFor } from '../src/blood/view';
import type { BloodState } from '../src/blood/types';

const NOW = 1_000_000;

function makeAgentFryerGame(): { gs: BloodState; t: number } {
  const gs = createBloodGame(2, [
    { id: 'p0', name: '特工玩家', seat: 0 },
    { id: 'p1', name: '炸鸡玩家', seat: 1 },
  ], NOW);
  for (const [id, cid] of [
    ['p0', 'agent'],
    ['p1', 'fryer'],
  ] as const) {
    const p = gs.players.find((x) => x.id === id)!;
    p.charOptions = [cid, 'dealer'];
    bPickChar(gs, p.id, cid, NOW);
  }
  bCrownBid(gs, 'p0', 0, NOW);
  bCrownBid(gs, 'p1', 0, NOW);
  for (const p of gs.players) bSetup(gs, p.id, [], NOW);
  let t = NOW;
  for (let i = 0; i < 30 && gs.phase !== 'swap'; i++) {
    t += 61_000;
    bloodTick(gs, t);
  }
  for (const p of gs.players) bSwapStop(gs, p.id, t);
  for (const p of gs.players) bPlay(gs, p.id, p.hand.slice(-5).map((c) => c.id), t + 1000);
  return { gs, t: t + 1000 };
}

/** 特工发起询问、炸鸡店老板拒绝（拒绝路径下老板的 fryerDel 挂起会创建，与报障场景一致） */
function reachSettleViaRefusal(gs: BloodState, t: number): number {
  bAgentAsk(gs, 'p0', 1, t + 1000);
  bAgentDecide(gs, 'p1', false, t + 2000); // 拒绝：付 2 血筹，无换牌
  let now = t + 2000;
  for (let i = 0; i < 30 && gs.phase !== 'settle'; i++) {
    now += 61_000;
    bloodTick(gs, now);
  }
  return now;
}

describe('特工×炸鸡店老板 · 结算确认时序', () => {
  it('fryerDel 挂在老板身上且未确认演示时，prompt 必须是 sdConfirm（门不得被挂起分支短路）', () => {
    const { gs, t } = makeAgentFryerGame();
    const now = reachSettleViaRefusal(gs, t);
    expect(gs.phase).toBe('settle');
    expect(gs.secretPending?.kind).toBe('fryerDel');
    expect(gs.secretPending?.seat).toBe('p1');
    expect(gs.players[1]!.sdSeen).toBe(false);
    // 回归点：修复前这里返回 {"k":"fryerDel"}（演示被客户端自动收起、跳过确认直接删牌）
    expect(promptFor(gs, gs.players[1]!).k).toBe('sdConfirm');
    expect(promptFor(gs, gs.players[0]!).k).toBe('sdConfirm');
  });

  it('老板确认演示后才拿到删牌提示；特工确认后为 wait；删完队列清空且全员已确认即进购买', () => {
    const { gs, t } = makeAgentFryerGame();
    const now = reachSettleViaRefusal(gs, t);
    bShowdownDone(gs, 'p0', now); // 特工先确认
    expect(promptFor(gs, gs.players[0]!).k).toBe('wait');
    expect(promptFor(gs, gs.players[1]!).k).toBe('sdConfirm'); // 老板仍需先确认演示

    bShowdownDone(gs, 'p1', now + 1000); // 老板确认演示
    expect(gs.players[1]!.sdSeen).toBe(true);
    expect(promptFor(gs, gs.players[1]!)).toMatchObject({ k: 'fryerDel', max: 3 }); // 此刻才切互动

    // 删 1 张后收尾（done=true，不再续删）
    const p1 = gs.players[1]!;
    const row1 = gs.result?.rows.find((r) => r.seat === p1.seat)?.cards?.map((c) => c.id) ?? [];
    const delable = p1.discard.filter((c) => row1.includes(c.id));
    expect(delable.length).toBeGreaterThan(0);
    bFryerDel(gs, 'p1', [delable[0]!.id], true, now + 2000);
    expect(gs.secretPending).toBeNull();
    expect(gs.phase).toBe('buy'); // 全员已确认 + 队列清空 → 立即购买，全桌不再空等
  });

  it('老板删牌 60s 托管后若仍未确认演示，确认窗补足 30s 并最终自动确认推进（不卡死）', () => {
    const { gs, t } = makeAgentFryerGame();
    let now = reachSettleViaRefusal(gs, t);
    bShowdownDone(gs, 'p0', now); // 只有特工确认
    // 老板一直不动作：驱动 tick 越过 60s 挂起托管 → 30s 确认窗 → 自动确认
    for (let i = 0; i < 6 && gs.phase === 'settle'; i++) {
      now += 31_000;
      bloodTick(gs, now);
    }
    expect(gs.phase).toBe('buy');
    expect(gs.players[1]!.sdSeen).toBe(true); // 被自动确认（wasAuto），全桌不卡死
  });
});
