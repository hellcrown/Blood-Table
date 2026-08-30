import { useEffect, useMemo, useState } from 'react';
import type { BloodSettleCardView } from '@shared/bloodProtocol';
import { SD_TIMING, coreOrder, showdownReadyMs, sortHandByType } from '@shared/bloodShowdown';
import { BCard } from './BloodCard';
import { CardView } from './Card';

export interface ShowdownEffect {
  chipName: string;
  chipText: string;
}

export interface ShowdownRow {
  seat: number;
  name: string;
  cards: BloodSettleCardView[];
  catName: string;
  pips: number;
  /** 牌型数值（bloodEval：高牌0 ~ 七条14），用于排序与核心牌特效 */
  cat: number;
  rank: number;
  gainTickets: number;
  gainBlood: number;
  effects: ShowdownEffect[];
}

/** 单张牌的 3D 翻牌：先背朝上，轮到它时翻成正面（transition-delay 控制依次展开） */
function DealCard({
  c,
  dealt,
  delay,
  coreIdx,
}: {
  c: BloodSettleCardView;
  dealt: boolean;
  delay: number;
  coreIdx: number;
}) {
  const chipped = c.chipIds.length > 0;
  const isCore = coreIdx >= 0;
  return (
    <div
      className={`sd-card ${dealt ? 'dealt' : ''} ${chipped ? 'chipped' : ''} ${isCore ? 'core' : ''}`}
      style={{ '--sd-delay': `${delay}ms`, '--core-i': coreIdx } as React.CSSProperties}
    >
      <div className="sd-card-inner">
        <div className="sd-card-face back">
          <CardView faceDown size="lg" />
        </div>
        <div className="sd-card-face front">
          <BCard c={c} size="lg" />
        </div>
      </div>
      {isCore && <span className="sd-light" />}
    </div>
  );
}

/** 芯片爆炸粒子：8 个方向的金色火花 */
function BurstFx({ go }: { go: boolean }) {
  return (
    <div className={`sd-burst ${go ? 'go' : ''}`}>
      <span className="sd-ring" />
      {Array.from({ length: 8 }, (_, k) => {
        const a = (k * 45 * Math.PI) / 180;
        return (
          <span
            key={k}
            className="sd-spark"
            style={{ '--i': k, '--dx': `${Math.cos(a) * 74}px`, '--dy': `${Math.sin(a) * 74}px` } as React.CSSProperties}
          />
        );
      })}
    </div>
  );
}

/**
 * 对决演示：所有玩家（默认 2 人局）的牌摊在同一张桌面上，
 * 魁首在前依次翻牌展开，随后各自亮出牌型与总点数，最后居中判定。
 * 演示完整播完（关键牌高亮、判定收尾）后才开始 30s 确认倒计时（服务端 deadline 权威）：
 * 双方都确认 → 服务端立即进入购买阶段、弹窗关闭；倒计时归零 → 服务端超时托管自动确认推进。
 * 演示时间轴与服务端共用 @shared/bloodShowdown，保证倒计时起点两端一致。
 */
export function Showdown({
  rows,
  winnerSeat,
  comparePipsFirst,
  mySeat,
  wait,
  myConfirmed,
  deadline,
  timeOffset,
  onConfirm,
}: {
  rows: ShowdownRow[];
  winnerSeat: number;
  comparePipsFirst: boolean;
  mySeat?: number | null;
  /** settle 阶段确认进度（done/total），用于"等待对方确认"提示 */
  wait: { done: number; total: number } | null;
  /** 自己是否已确认（服务端 sdSeen） */
  myConfirmed: boolean;
  /** 服务端对决展示截止时间（演示播完 + 30s 上限） */
  deadline: number | null;
  /** 客户端与服务端时钟偏移（serverTime - Date.now()） */
  timeOffset: number;
  onConfirm: () => void;
}) {
  // 0 等待 → 1 翻牌 → 2 牌型点数（关键牌高亮）→ 3 判定（停留展示）；ready = 演示完整播完，开始倒计时
  const [phase, setPhase] = useState(0);
  const [ready, setReady] = useState(false);
  const winner = rows.find((r) => r.seat === winnerSeat) ?? rows[0];

  // 每方牌按牌型排序展示 + 计算核心牌（高亮顺序 = 排序后的展示顺序，从左到右依次激发）
  const rowsView = useMemo(
    () =>
      rows.map((r) => {
        const sorted = sortHandByType(r.cards, r.cat);
        const coreIds = new Set(coreOrder(r.cards, r.cat).map((c) => c.id));
        const coreIdxOf = new Map<string, number>();
        let ci = 0;
        for (const c of sorted) {
          if (coreIds.has(c.id)) coreIdxOf.set(c.id, ci++);
        }
        return { ...r, cards: sorted, coreIdxOf };
      }),
    [rows],
  );

  // 演示时间轴（与服务端共用）：翻牌 → 分数 → 判定 → 倒计时起点
  const timeline = useMemo(() => {
    const maxCards = Math.max(0, ...rows.map((r) => r.cards.length));
    const maxCores = Math.max(0, ...rowsView.map((r) => r.coreIdxOf.size));
    const dealTotal = (rows.length - 1) * SD_TIMING.seatGap + maxCards * SD_TIMING.cardGap + SD_TIMING.flipTail;
    return {
      phase1At: SD_TIMING.firstDelay,
      phase2At: SD_TIMING.firstDelay + dealTotal + SD_TIMING.scoreLead,
      phase3At: SD_TIMING.firstDelay + dealTotal + SD_TIMING.scoreTail + (rows.length - 1) * SD_TIMING.scoreStagger,
      readyAt: showdownReadyMs(rows.length, maxCards, maxCores),
    };
  }, [rows, rowsView]);

  useEffect(() => {
    const t1 = window.setTimeout(() => setPhase(1), timeline.phase1At);
    const t2 = window.setTimeout(() => setPhase(2), timeline.phase2At);
    const t3 = window.setTimeout(() => setPhase(3), timeline.phase3At);
    const t4 = window.setTimeout(() => setReady(true), timeline.readyAt);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
    };
  }, [timeline]);

  // 倒计时（演示播完后显示，服务端 deadline 权威；归零由服务端超时托管自动确认推进）
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [ready]);
  const remainSec =
    ready && deadline != null ? Math.max(0, Math.ceil((deadline - (Date.now() + timeOffset)) / 1000)) : 0;

  const advance = () => {
    if (phase < 3) setPhase(phase + 1);
    else if (!myConfirmed) onConfirm();
  };

  const cardDelay = (seatIdx: number, cardIdx: number) => seatIdx * SD_TIMING.seatGap + cardIdx * SD_TIMING.cardGap;

  return (
    <div className="overlay showdown" onClick={advance}>
      <div className="panel showdown-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sd-title-row">
          <span className="sd-title">⚔️ 对决亮牌</span>
          {comparePipsFirst && <span className="sd-note">⚖️ 荷官证生效：先比总点数，平局再比牌型</span>}
        </div>

        {/* 演示播完后：倒计时 + 确认状态 */}
        <div className={`sd-status ${phase >= 3 ? 'on' : ''}`}>
          {!ready ? (
            phase < 3 ? (
              <span>⚔️ 双方依次亮牌…</span>
            ) : (
              <span>⚔️ 判定展示中…</span>
            )
          ) : myConfirmed ? (
            <span>
              已确认 · 等待对方确认（{wait?.done ?? 1}/{wait?.total ?? 2}）· 剩余 <b>{remainSec}s</b>
            </span>
          ) : (
            <span>
              判定展示中 · 剩余 <b>{remainSec}s</b>，倒计时结束自动确认关闭
            </span>
          )}
        </div>

        <div className="sd-seats">
          {rowsView.map((r, i) => {
            const hasFx = r.effects.length > 0;
            return (
              <div
                key={r.seat}
                className={`sd-seat ${phase >= 2 ? 'phase2' : ''} ${phase >= 3 ? 'phase3' : ''} ${r.rank === 1 ? 'winner' : ''} ${hasFx && phase >= 2 ? 'boom' : ''}`}
              >
                {hasFx && <BurstFx go={phase >= 2} />}
                <div className="sd-seat-head">
                  <span className="sd-seat-name">
                    {r.name}
                    {r.seat === mySeat && <em className="sd-me">（你）</em>}
                  </span>
                  {r.rank === 1 && <span className="sd-crown">👑</span>}
                </div>

                <div className="sd-cards">
                  {r.cards.map((c, j) => (
                    <DealCard
                      key={c.id}
                      c={c}
                      dealt={phase >= 1}
                      delay={cardDelay(i, j)}
                      coreIdx={r.coreIdxOf.get(c.id) ?? -1}
                    />
                  ))}
                </div>

                <div className="sd-score-block" style={{ transitionDelay: `${i * SD_TIMING.scoreStagger}ms` }}>
                  <span className="sd-rank">第{r.rank}名</span>
                  <span className="sd-cat">{r.catName}</span>
                  <span className="sd-pips">{r.pips} 点</span>
                  <span className="sd-reward">
                    {r.gainTickets > 0 && <span className="pos">+{r.gainTickets}🎫</span>}
                    {r.gainBlood > 0 && <span className="pos">+{r.gainBlood}🩸</span>}
                  </span>
                </div>

                {hasFx && (
                  <div className="sd-chips">
                    {r.effects.map((e, k) => (
                      <span key={k} title={e.chipText}>
                        【{e.chipName}】
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={`sd-verdict ${phase >= 3 ? 'on' : ''}`}>
          <span className="sd-verdict-banner">🏆 {winner?.name ?? ''} 夺魁，获得临时特权证</span>
        </div>

        <div className="sd-controls">
          <span className="sd-hint">
            {myConfirmed
              ? '等待对方确认，或倒计时结束后自动关闭'
              : phase < 3
                ? '点击画面可加速演示 · 按钮可提前确认'
                : '点击画面或按钮立即确认 · 倒计时结束自动关闭'}
          </span>
          <button
            className="btn small"
            disabled={myConfirmed}
            onClick={(e) => {
              e.stopPropagation();
              onConfirm();
            }}
          >
            {myConfirmed ? '已确认' : phase < 3 ? '提前确认' : '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
