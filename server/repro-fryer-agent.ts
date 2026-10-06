/** 复现：特工+炸鸡店老板 对决阶段确认时序 */
import {
  createBloodGame, bPickChar, bCrownBid, bPlay, bAgentAsk, bAgentDecide,
  bShowdownDone, bFryerDel, bloodTick,
} from './src/blood/engine';
import { promptFor } from './src/blood/view';
import type { BloodState } from './src/blood/types';

const NOW = 1_000_000;
const gs: BloodState = createBloodGame(2, [
  { id: 'p0', name: '特工玩家', seat: 0 },
  { id: 'p1', name: '炸鸡玩家', seat: 1 },
], NOW);
for (const [i, cid] of [['p0', 'agent'], ['p1', 'fryer']] as const) {
  const p = gs.players.find((x) => x.id === i)!;
  p.charOptions = [cid, 'dealer'];
  bPickChar(gs, p.id, cid, NOW);
}
bCrownBid(gs, 'p0', 0, NOW);
bCrownBid(gs, 'p1', 0, NOW);

const step = (tag: string): void => {
  console.log(`\n== ${tag} ==`);
  console.log(`phase=${gs.phase} pending=${JSON.stringify(gs.secretPending?.kind)}/${gs.secretPending?.seat ?? '-'} deadlineIn=${gs.deadline ? gs.deadline - NOW : 'null'}`);
  for (const p of gs.players) {
    console.log(`  ${p.id}(${p.name}) prompt=${JSON.stringify(promptFor(gs, p))} sdSeen=${p.sdSeen} locked=${p.locked} hand=${p.hand.length} play=${p.play.length} discard=${p.discard.length} blood=${p.blood}`);
  }
};

// 推进到出牌阶段：构筑全跳过
import { bSetup, bSwapStop, bSwap, bSkipDecision } from './src/blood/engine';
for (const p of gs.players) bSetup(gs, p.id, [], NOW);
// 构筑→摸牌→换牌：用 tick 推进自动阶段
let t0 = NOW;
for (let i = 0; i < 30 && gs.phase !== 'swap'; i++) {
  t0 += 61_000;
  bloodTick(gs, t0);
}
step('到达换牌阶段');
// 换牌：直接结束
for (const p of gs.players) bSwapStop(gs, p.id, t0);
step('换牌结束，进入出牌');

// 各出 5 张
for (const p of gs.players) {
  bPlay(gs, p.id, p.hand.slice(-5).map((c) => c.id), NOW + 1000);
}
step('双方出牌后（特工 agentAsk 挂起）');

// 特工询问炸鸡店老板换出牌区
bAgentAsk(gs, 'p0', 1, NOW + 2000);
step('特工发起询问（agentDecide 挂在 p1）');

// 炸鸡店老板【拒绝】换牌（用户场景变体：拒绝后炸鸡店老板的删牌挂起才会创建）
bAgentDecide(gs, 'p1', false, NOW + 3000);
step('炸鸡店老板接受换牌 → 应进入对决/结算');

// 推进 reveal 窗口（无道具）：直接把 deadline 推到未来驱动 tick
let t = NOW + 4000;
for (let i = 0; i < 30 && gs.phase !== 'settle'; i++) {
  t += 61_000;
  bloodTick(gs, t);
}
step('到达结算（对决展示 + 结算队列）');
console.log('settleQueue 残留:', JSON.stringify(gs.settleQueue));
console.log('result rows:', JSON.stringify(gs.result?.rows.map((r) => ({ seat: r.seat, cards: r.cards?.length }))));

// 特工确认对决展示；炸鸡店老板一直不确认
bShowdownDone(gs, 'p0', t);
step('特工确认后（老板未确认，fryerDel 挂起存活）');

// 驱动 tick：deadline(60s) 到 → 强制结束删牌 → 30s 确认窗 → 自动确认 → 购买？
let tt = t;
for (let i = 0; i < 6; i++) {
  tt += 31_000;
  const changed = bloodTick(gs, tt);
  step(`tick @+31s (changed=${changed})`);
  if (gs.phase !== 'settle') break;
}
console.log('最终 phase:', gs.phase);
