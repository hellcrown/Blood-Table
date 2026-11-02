/**
 * 血色猎场 · 机器人决策器（服务端内存 bot，不占用 WebSocket 连接）
 * 棋面完全公开、无隐藏信息 → 无需跨回合记忆，逐行动即时决策（血色 bot 的 Brain 在此没有价值）。
 * 策略定位「可被击败的合格猎手」：
 * 1. 斩杀优先：射程内有 HP≤普攻伤害的目标 → 直接打死（玩家 > 血薄怪）
 * 2. 残血自保：HP≤4 且包扎就绪 → 包扎；接敌落点排除野怪射程圈
 * 3. 技能价值：重击就绪且贴脸玩家/石像守卫（普攻打不死）→ 重击省回合
 * 4. 接敌：沿共享 BFS 最短路逼近（玩家优先于怪，权 +3），走到相邻下一拍开打
 * 5. 闲着也是闲着：离目标太远且包扎就绪 → 先回血
 * 6. 无路可走 → 结束回合
 * 决策异常由 rooms.runTacticsBots 捕获并回退结束回合，绝不软锁。
 */
import type { TacticsState, TacticsPlayerState } from '@shared/tacticsProtocol';
import { TACTICS_CHARACTERS, TACTICS_MONSTERS, type MonsterType } from '@shared/tacticsProtocol';
import { manhattan, shortestPath } from '@shared/tacticsGrid';

export type TacticsBotAction =
  | { kind: 'move'; r: number; c: number }
  | { kind: 'attack'; r: number; c: number }
  | { kind: 'skill'; skillIdx: number; r?: number; c?: number }
  | { kind: 'endTurn' };

interface BotTarget {
  r: number;
  c: number;
  hp: number;
  isPlayer: boolean;
  monsterType?: MonsterType;
}

/** 野怪射程圈：落点是否在任一存活怪的射程内（残血自保用） */
function inMonsterRange(state: TacticsState, r: number, c: number): boolean {
  return state.monsters.some((m) => {
    const def = TACTICS_MONSTERS[m.type];
    return manhattan(m.r, m.c, r, c) <= def.range;
  });
}

export function tacticsBotDecide(state: TacticsState, botId: string): TacticsBotAction {
  const me: TacticsPlayerState | undefined = state.players.find((p) => p.id === botId);
  if (state.phase !== 'playing' || !me || !me.alive || state.currentId !== botId) return { kind: 'endTurn' };
  const charDef = TACTICS_CHARACTERS[me.charId] ?? Object.values(TACTICS_CHARACTERS)[0];
  const skills = charDef.skills;
  const strikeIdx = skills.findIndex((s) => s.kind === 'strike');
  const healIdx = skills.findIndex((s) => s.kind === 'heal');
  const smashReady = strikeIdx >= 0 && (me.cooldowns[strikeIdx] ?? 0) === 0;
  const healReady = healIdx >= 0 && (me.cooldowns[healIdx] ?? 0) === 0;

  // 目标集：其他存活玩家 + 野怪
  const targets: BotTarget[] = [
    ...state.players
      .filter((q) => q.alive && q.id !== botId)
      .map((q) => ({ r: q.r, c: q.c, hp: q.hp, isPlayer: true })),
    ...state.monsters.map((m) => ({ r: m.r, c: m.c, hp: m.hp, isPlayer: false, monsterType: m.type })),
  ];
  const adjacent = targets.filter((t) => manhattan(me.r, me.c, t.r, t.c) <= charDef.atkRange);
  // 打死目标排序：玩家最优先，怪按血薄优先
  const byKillValue = (a: BotTarget, b: BotTarget): number =>
    Number(b.isPlayer) - Number(a.isPlayer) || a.hp - b.hp;

  // 1. 斩杀：普攻就能打死的直接打
  const killable = adjacent.filter((t) => t.hp <= charDef.atk).sort(byKillValue);
  if (killable[0]) return { kind: 'attack', r: killable[0].r, c: killable[0].c };

  // 2. 残血自保：先奶一口
  if (healReady && me.hp <= 4 && me.hp < me.maxHp) return { kind: 'skill', skillIdx: healIdx };

  // 3. 重击价值：贴脸玩家/石像守卫且普攻打不死 → 重击
  if (smashReady && adjacent.length > 0) {
    const smashWorthy = adjacent
      .filter((t) => t.hp > charDef.atk && (t.isPlayer || t.monsterType === 'golem'))
      .sort(byKillValue);
    if (smashWorthy[0]) {
      return { kind: 'skill', skillIdx: strikeIdx, r: smashWorthy[0].r, c: smashWorthy[0].c };
    }
  }

  // 4. 贴脸就打：玩家优先，怪按血薄优先
  if (adjacent.length > 0) {
    const best = adjacent.slice().sort(byKillValue)[0]!;
    return { kind: 'attack', r: best.r, c: best.c };
  }

  // 5. 接敌：沿最短路走到目标旁（路径长 L → 走 min(L-1, AP) 步，落在相邻格）
  const blocked = new Set<number>([
    ...state.monsters.map((m) => m.r * state.cols + m.c),
    ...state.players.filter((q) => q.alive && q.id !== botId).map((q) => q.r * state.cols + q.c),
  ]);
  const start = me.r * state.cols + me.c;
  let best: { dest: { r: number; c: number }; score: number } | null = null;
  for (const t of targets) {
    const goal = t.r * state.cols + t.c;
    const blocks = new Set(blocked);
    blocks.delete(goal); // 目标格被占，寻路豁免、走到它旁
    const path = shortestPath(state.rows, state.cols, state.grid, blocks, start, goal);
    if (!path || path.length < 2) continue;
    const effLen = path.length + (t.isPlayer ? 0 : 3); // 玩家优先于打野
    if (best && effLen >= best.score) continue;
    // 落点选择：优先走满 min(L-1, AP) 步贴到目标旁；残血时依次退而求其次停到野怪射程圈外
    let dest: { r: number; c: number } | null = null;
    const maxK = Math.min(path.length - 1, me.ap);
    for (let k = maxK; k >= 1; k--) {
      const step = path[k - 1]!;
      const cand = { r: Math.floor(step / state.cols), c: step % state.cols };
      if (me.hp <= 4 && inMonsterRange(state, cand.r, cand.c)) continue;
      dest = cand;
      break;
    }
    if (!dest) {
      // 全程都在圈里（或非残血）：照走满步数——怪是静态的，蹲着不动更危险
      const step = path[maxK - 1]!;
      dest = { r: Math.floor(step / state.cols), c: step % state.cols };
    }
    best = { dest, score: effLen };
  }
  if (best) return { kind: 'move', r: best.dest.r, c: best.dest.c };

  // 6. 够不着任何目标：闲着回血
  if (healReady && me.hp < me.maxHp) return { kind: 'skill', skillIdx: healIdx };
  return { kind: 'endTurn' };
}
