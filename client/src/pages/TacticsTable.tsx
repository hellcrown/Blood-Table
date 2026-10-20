/**
 * 血色猎场 · 对局页
 * 棋盘：DOM 格子 + CSS Grid（照扫雷），棋子为独立浮层（transform 过渡做移动动画）。
 * 交互（双按钮模式切换，照扫雷 ⛏/🚩 范式）：🚶移动 / ⚔攻击 / 两个技能按钮（增益即时生效、
 * 打击技进入点选模式）；可达格与射程高亮用 @shared/tacticsGrid 与服务端同源计算，口径不会漂移。
 */
import { useEffect, useMemo, useState } from 'react';
import type { TacticsView } from '@shared/tacticsProtocol';
import { TACTICS_CHARACTERS, TACTICS_MONSTERS } from '@shared/tacticsProtocol';
import { manhattan, movementRange } from '@shared/tacticsGrid';
import { net } from '../net/socket';
import { ChatModal } from '../components/ChatModal';

const MAP_LABEL = { small: '小图 11×11', medium: '中图 15×15', large: '大图 19×19' } as const;
const MONSTER_ICON = { leech: '🪱', crossbow: '🏹', golem: '🗿' } as const;
const SEAT_COLORS = ['#e5484d', '#46a758', '#8e4ec6', '#f5a524'];

type Mode = 'move' | 'attack' | 'skill';

/** 对局进行中每 500ms 强刷一次（倒计时跳动用） */
function useTicker(active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setN((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [active]);
}

/** 血色猎场 · 对局页 */
export function TacticsTable({ view }: { view: TacticsView }) {
  const [mode, setMode] = useState<Mode>('move');
  const [skillIdx, setSkillIdx] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);

  const me = view.players.find((p) => p.id === net.playerId);
  const spectating = !me;
  const myTurn = view.phase === 'playing' && !!me && me.alive && view.currentId === me.id;
  const charDef = TACTICS_CHARACTERS[me?.charId ?? 'hunter'] ?? TACTICS_CHARACTERS.hunter!;

  // 换人行动时回落到移动模式（上个玩家的攻击选点模式不该跨回合残留）
  useEffect(() => {
    setMode('move');
  }, [view.currentId, view.phase]);

  useTicker(view.phase === 'playing');

  const timeOffset = view.serverTime - Date.now();
  const secsLeft = view.deadline != null ? Math.max(0, Math.ceil((view.deadline - (Date.now() + timeOffset)) / 1000)) : null;

  /** 移动障碍：其他存活玩家 + 野怪（墙在 grid 里） */
  const reachable = useMemo(() => {
    if (!myTurn || mode !== 'move' || !me) return new Map<number, number>();
    const blocked = new Set<number>();
    for (const p of view.players) if (p.alive && p.id !== me.id) blocked.add(p.r * view.cols + p.c);
    for (const m of view.monsters) blocked.add(m.r * view.cols + m.c);
    return movementRange(view.rows, view.cols, view.grid, blocked, me.r * view.cols + me.c, me.ap);
  }, [myTurn, mode, me, view]);

  const activeRange = useMemo(() => {
    if (!myTurn || !me) return 0;
    if (mode === 'attack') return charDef.atkRange;
    if (mode === 'skill') {
      const skill = charDef.skills[skillIdx];
      return skill?.kind === 'strike' ? skill.range : 0;
    }
    return 0;
  }, [myTurn, mode, skillIdx, charDef, me]);

  /** 射程内可攻击格（野怪或他人占据） */
  const attackable = useMemo(() => {
    const out = new Set<number>();
    if (!myTurn || !me || activeRange <= 0) return out;
    for (const m of view.monsters) {
      if (manhattan(me.r, me.c, m.r, m.c) <= activeRange) out.add(m.r * view.cols + m.c);
    }
    for (const p of view.players) {
      if (p.alive && p.id !== me.id && manhattan(me.r, me.c, p.r, p.c) <= activeRange) out.add(p.r * view.cols + p.c);
    }
    return out;
  }, [myTurn, me, activeRange, view]);

  const monsterAt = (r: number, c: number) => view.monsters.find((m) => m.r === r && m.c === c);
  const playerAt = (r: number, c: number) => view.players.find((p) => p.alive && p.r === r && p.c === c);

  const onCellClick = (r: number, c: number): void => {
    if (!myTurn || !me) return;
    if (mode === 'move') {
      if (reachable.has(r * view.cols + c)) net.send({ t: 'tMove', to: { r, c } });
    } else if (mode === 'attack') {
      if (attackable.has(r * view.cols + c)) net.send({ t: 'tAttack', r, c });
    } else {
      const skill = charDef.skills[skillIdx];
      if (skill?.kind === 'strike' && attackable.has(r * view.cols + c)) {
        net.send({ t: 'tSkill', skill: skillIdx, r, c });
      }
    }
  };

  const onSkillButton = (idx: number): void => {
    if (!myTurn) return;
    const skill = charDef.skills[idx];
    if (!skill) return;
    if (skill.kind === 'heal') {
      net.send({ t: 'tSkill', skill: idx }); // 增益即时生效
      setMode('move');
    } else if (mode === 'skill' && skillIdx === idx) {
      setMode('move'); // 再点一次取消选点
    } else {
      setSkillIdx(idx);
      setMode('skill');
    }
  };

  const aliveCount = view.players.filter((p) => p.alive).length;
  const actor = view.players.find((p) => p.id === view.currentId);

  /* ---------------- 棋盘 ---------------- */
  const cells: React.ReactNode[] = [];
  for (let r = 0; r < view.rows; r++) {
    for (let c = 0; c < view.cols; c++) {
      const i = r * view.cols + c;
      const isWall = view.grid[i] === 1;
      const canReach = mode === 'move' && reachable.has(i);
      const canHit = (mode === 'attack' || (mode === 'skill' && charDef.skills[skillIdx]?.kind === 'strike')) && attackable.has(i);
      let cls = 'tac-cell' + ((r + c) % 2 === 1 ? ' alt' : '');
      if (isWall) cls += ' wall';
      if (canReach) cls += ' reach';
      if (canHit) cls += ' atkable';
      cells.push(
        <div
          key={i}
          className={cls}
          onClick={() => onCellClick(r, c)}
          title={isWall ? '岩壁：不可通行（距离与射程按可穿越计算）' : undefined}
        />,
      );
    }
  }

  const pieces: React.ReactNode[] = [];
  for (const p of view.players) {
    if (!p.alive) continue;
    pieces.push(
      <div
        key={p.id}
        className={`tac-piece${p.id === view.currentId ? ' cur' : ''}${p.id === net.playerId ? ' mine' : ''}`}
        style={{ transform: `translate(calc(${p.c} * var(--tac-cell)), calc(${p.r} * var(--tac-cell)))` }}
        title={`${p.name} · HP ${p.hp}/${p.maxHp} · AP ${p.ap}`}
      >
        <div className="tac-disc" style={{ background: SEAT_COLORS[p.seat % SEAT_COLORS.length] ?? undefined }}>
          {p.seat + 1}
        </div>
        <div className="tac-hp">
          <span style={{ width: `${Math.max(0, (p.hp / p.maxHp) * 100)}%` }} />
        </div>
      </div>,
    );
  }
  for (const m of view.monsters) {
    const def = TACTICS_MONSTERS[m.type];
    pieces.push(
      <div
        key={m.id}
        className="tac-piece monster"
        style={{ transform: `translate(calc(${m.c} * var(--tac-cell)), calc(${m.r} * var(--tac-cell)))` }}
        title={`${def.name} · HP ${m.hp}/${m.maxHp} · 攻 ${def.atk} · 射程 ${def.range}`}
      >
        <div className="tac-disc">{MONSTER_ICON[m.type]}</div>
        <div className="tac-hp">
          <span style={{ width: `${Math.max(0, (m.hp / m.maxHp) * 100)}%` }} />
        </div>
      </div>,
    );
  }

  const hint = !myTurn
    ? view.phase === 'playing'
      ? `等待 ${actor?.name ?? '…'} 行动`
      : '对局已结束'
    : mode === 'move'
      ? '点高亮格移动（每格 1 AP）'
      : mode === 'attack'
        ? '点射程内目标发起攻击（1 AP）'
        : `点目标发动【${charDef.skills[skillIdx]?.name ?? ''}】`;

  return (
    <div className="tac-page">
      <header className="page-bar">
        <span className="brand">血色猎场</span>
        <span className="room-code">
          房间码 <b>{view.code}</b>
        </span>
        <span className="spacer" />
        <button className="btn tiny ghost" onClick={() => setChatOpen(true)} title="聊天：房间成员 / 全服在线玩家">
          💬
        </button>
        <button className="btn small ghost" onClick={() => net.leaveRoom()}>
          退出房间
        </button>
      </header>

      <div className="phase-bar">
        <span>
          {MAP_LABEL[view.mapSize]} · 第 {view.turnNumber} 回合 ·{' '}
        </span>
        {view.phase === 'playing' ? (
          <>
            <span>🎯 {actor?.name ?? '…'}</span>
            {secsLeft != null && <span className={secsLeft <= 10 ? 'danger' : ''}>⏱ {secsLeft}s</span>}
          </>
        ) : (
          <span>🏁 终局</span>
        )}
        <span>
          存活 {aliveCount}/{view.players.length}
        </span>
      </div>

      <div className="tac-legend">🧱 岩壁＝不可通行（距离与射程可隔墙计算） · 圆片＝猎人（金圈＝行动中） · 🪱🏹🗿＝野怪</div>

      {spectating && <div className="spectate-banner">🔭 观战中</div>}
      {!spectating && me && !me.alive && view.phase === 'playing' && (
        <div className="spectate-banner">💀 你已被淘汰 —— 观战中，等待对局结束</div>
      )}

      {view.phase === 'gameover' && view.ranking.length > 0 && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <h3>🏁 猎场之王：{view.players.find((p) => p.id === view.winnerId)?.name ?? '无'}</h3>
          <ol className="ranking">
            {view.ranking.map((r) => (
              <li key={r.seat} className={r.rank === 1 ? 'champ' : ''}>
                {r.rank}. {r.name} — {r.alive ? '存活' : `HP ${r.hp} 淘汰`}
                {r.rank === 1 ? ' 👑' : ''}
              </li>
            ))}
          </ol>
          <div className="panel-actions">
            {view.hostId === net.playerId ? (
              <button className="btn primary" onClick={() => net.send({ t: 'tRematch' })}>
                再来一局（新地图）
              </button>
            ) : (
              <span className="hint">等待房主开始下一局…</span>
            )}
            <button className="btn" onClick={() => net.send({ t: 'backToRoom' })}>
              返回房间
            </button>
          </div>
        </div>
      )}

      <div className="tac-layout">
        <div className="tac-board-col">
          <div className="tac-board-wrap">
            <div
              className="tac-board"
              style={{ ['--tac-cols' as string]: view.cols, ['--tac-rows' as string]: view.rows } as React.CSSProperties}
            >
              {cells}
              {pieces}
            </div>
          </div>

          <div className="act-row" style={{ marginTop: 10 }}>
        {myTurn && (
          <>
            <button className={`btn ${mode === 'move' ? 'primary' : ''}`} onClick={() => setMode('move')}>
              🚶 移动
            </button>
            <button className={`btn ${mode === 'attack' ? 'primary' : ''}`} onClick={() => setMode('attack')}>
              ⚔ 攻击
            </button>
            {charDef.skills.map((skill, idx) => {
              const cd = me?.cooldowns[idx] ?? 0;
              return (
                <button
                  key={skill.id}
                  className={`btn ${mode === 'skill' && skillIdx === idx ? 'primary' : ''}`}
                  disabled={cd > 0}
                  onClick={() => onSkillButton(idx)}
                  title={skill.kind === 'strike' ? `伤害 ${skill.power} · 冷却 ${skill.cooldown} 回合` : `回复 ${skill.power} HP · 冷却 ${skill.cooldown} 回合`}
                >
                  {skill.kind === 'strike' ? '✦' : '✚'} {skill.name}
                  {cd > 0 ? `（冷却${cd}）` : ''}
                </button>
              );
            })}
            <button className="btn ghost" onClick={() => net.send({ t: 'tEndTurn' })}>
              结束回合
            </button>
          </>
        )}
        <span className="hint">{hint}</span>
          </div>
        </div>

        <div className="tac-side">
          <div className="panel">
            <div className="box-title">猎人状态</div>
            {view.players.map((p) => (
              <div key={p.id} className="result-row tac-row">
                <span className="tac-dot" style={{ background: SEAT_COLORS[p.seat % SEAT_COLORS.length] }} />
                <span className="r-name">
                  {p.name}
                  {p.id === net.playerId && <em>（你）</em>}
                  {!p.alive && <em> 💀</em>}
                  {!p.connected && <em> ⚠掉线</em>}
                </span>
                <span className="tac-hpbar">
                  <span style={{ width: `${Math.max(0, (p.hp / p.maxHp) * 100)}%` }} />
                </span>
                <span className="tac-nums">
                  {'♥'.repeat(Math.max(0, Math.min(5, Math.ceil(p.hp / 2))))} {p.hp}/{p.maxHp} · AP {p.ap}/{p.maxAp}
                  {myTurnView(p, view) && ' ◀行动中'}
                </span>
              </div>
            ))}
          </div>

          <div className="panel">
            <div className="box-title">野怪</div>
            {view.monsters.length === 0 && <p className="hint">猎场已被清空</p>}
            {view.monsters.map((m) => {
              const def = TACTICS_MONSTERS[m.type];
              return (
                <div key={m.id} className="result-row">
                  <span className="r-name">
                    {MONSTER_ICON[m.type]} {def.name}
                  </span>
                  <span className="r-hand">
                    HP {m.hp}/{m.maxHp} · 攻 {def.atk} · 射程 {def.range}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="panel">
            <div className="box-title">战报</div>
            <div className="tac-log">
              {view.log.slice(-14).reverse().map((l) => (
                <div key={l.seq} className={`tac-log-line k-${l.kind}`}>
                  {l.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {chatOpen && <ChatModal onClose={() => setChatOpen(false)} roomScope />}
    </div>
  );

  function myTurnView(p: { id: string }, v: TacticsView): boolean {
    return v.phase === 'playing' && v.currentId === p.id;
  }
}
