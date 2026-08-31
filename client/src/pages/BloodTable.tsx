import { useEffect, useMemo, useRef, useState } from 'react';
import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
import { applyCharEval } from '@shared/bloodChars';
import { evalBloodHand, toEvalCard, type EvalCard } from '@shared/bloodEval';
import type { BloodCardView, BloodView } from '@shared/bloodProtocol';
import { net } from '../net/socket';
import { BLOOD_CHAR_BY_ID } from '@shared/bloodChars';
import { CharDetail, CharPortrait } from '../components/CharCard';
import { CardView } from '../components/Card';
import { BCard, cardLabel, effLabel, effRankOf, sortHandByType } from '../components/BloodCard';
import { Showdown, type ShowdownRow } from '../components/Showdown';

/** 牌型天梯（高→低），与规则书牌型提示卡一致 */
const HAND_LADDER: { name: string; desc: string; chipOnly?: boolean }[] = [
  { name: '七条', desc: '7 张点数相同的牌', chipOnly: true },
  { name: '同花六条', desc: '6 张点数、花色皆相同', chipOnly: true },
  { name: '六条', desc: '6 张点数相同的牌', chipOnly: true },
  { name: '同花五条', desc: '5 张点数、花色皆相同', chipOnly: true },
  { name: '同花葫芦', desc: '3+2 同点数，且 5 张同花色', chipOnly: true },
  { name: '同花顺', desc: '连续点数的 5 张牌，且同一花色' },
  { name: '五条', desc: '5 张点数相同的牌', chipOnly: true },
  { name: '四条', desc: '4 张点数相同的牌' },
  { name: '葫芦', desc: '3 张同点 + 另 2 张同点' },
  { name: '同花', desc: '同一花色的 5 张牌（不连续）' },
  { name: '顺子', desc: '连续点数的 5 张牌（23456 最小，10JQKA 最大）' },
  { name: '三条', desc: '3 张点数相同的牌' },
  { name: '两对', desc: '2 组不同点数的对子' },
  { name: '一对', desc: '2 张点数相同的牌' },
  { name: '高牌', desc: '不构成以上任何牌型' },
];

const PHASES: { key: BloodView['phase']; label: string }[] = [
  { key: 'pick', label: '选将' },
  { key: 'swap', label: '换牌' },
  { key: 'play', label: '出牌' },
  { key: 'reveal', label: '对决' },
  { key: 'settle', label: '结算' },
  { key: 'buy', label: '购买' },
  { key: 'remove', label: '删牌' },
  { key: 'reorg', label: '重整' },
];

/** 骰子点数面（对赌协议特效） */
const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

/** 黑市牌动画资源（client/src/assets/fx/<defId>.webp|gif，存在则替代 emoji 水印） */
const FX_MODULES = import.meta.glob('../assets/fx/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
Object.assign(
  FX_MODULES,
  import.meta.glob('../assets/fx/*.gif', { eager: true, query: '?url', import: 'default' }) as Record<
    string,
    string
  >,
);
const fxUrlOf = (defId: string): string | undefined =>
  FX_MODULES[`../assets/fx/${defId}.webp`] ?? FX_MODULES[`../assets/fx/${defId}.gif`];

/** 拓展牌目标选择提示（点击对方面板执行） */
const TARGET_LABELS: Record<string, string> = {
  poisonTarget: '投毒（下回合换牌-2）',
  freezeTarget: '冻结（跳过本回合重整）',
  amnesiaTarget: '失忆（下回合技能失效）',
  boxRobTarget: '黑厢抢夺（掷骰）',
  signalTarget: '随机弃1抽1',
  demagTarget: '消磁其一张芯片',
};

/** 已有专属特效的宣告效果类型 */
const ANNOUNCE_FX_KINDS = new Set([
  'rollDice',
  'deleteUpTo',
  'violentDelete',
  'topOfMarket',
  'privilegeBonus',
  'refreshMarket',
  'dealerLicense',
]);

/** 其它效果的通用宣告动画 emoji */
const ANNOUNCE_FX_EMOJI: Record<string, string> = {
  closingGift: '🩸',
  bloodShare: '🩸',
  stealPrivilege: '👑',
  settleWinTicket: '🎫',
  selfDestruct: '💥',
  magCoil: '🧲',
  imitate: '🔖',
  copyChip: '🧬',
  settleWin: '👑',
  settleLose: '🩸',
  revealGain: '🩸',
  revealSteal: '🏴‍☠️',
  rankMod: '🔧',
  suit: '♦️',
  suitWild: '🎨',
  rankWild: '🎯',
  wild: '🃏',
  dupe: '🪞',
  todo: '✨',
};

type SortMode = 'none' | 'suit' | 'rank';

/** 手牌排序：花色 = 同花色数量多者在前、王牌恒最左，组内按点数从小到大；点数 = 从小到大 */
function sortHand(cards: BloodCardView[], mode: SortMode): BloodCardView[] {
  const arr = [...cards];
  if (mode === 'rank') {
    return arr.sort((a, b) => {
      const ar = a.s == null || a.r === 0 ? -1 : a.r;
      const br = b.s == null || b.r === 0 ? -1 : b.r;
      return ar - br;
    });
  }
  if (mode === 'suit') {
    const groups = new Map<string, BloodCardView[]>();
    for (const c of arr) {
      const key = c.s ?? '★';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    for (const g of groups.values()) {
      g.sort((a, b) => (a.s == null || a.r === 0 ? -1 : b.s == null || b.r === 0 ? 1 : a.r - b.r));
    }
    const suitOrder = ['s', 'h', 'd', 'c'];
    const keys = [...groups.keys()].sort((x, y) => {
      if (x === '★') return -1;
      if (y === '★') return 1;
      const d = groups.get(y)!.length - groups.get(x)!.length;
      if (d !== 0) return d;
      return suitOrder.indexOf(x) - suitOrder.indexOf(y);
    });
    return keys.flatMap((k) => groups.get(k)!);
  }
  return arr;
}

/** 粒子飞出方向（暴力删除特效）：6 个方向 */
function sparkStyle(k: number): React.CSSProperties {
  const a = (k * 60 * Math.PI) / 180;
  return { '--dx': `${Math.cos(a) * 52}px`, '--dy': `${Math.sin(a) * 52}px` } as React.CSSProperties;
}

/** 倒计时：rAF 直接写 DOM，设备端逐帧计算，不受 React 渲染影响 */
function Countdown({
  deadline,
  offsetRef,
}: {
  deadline: number | null;
  offsetRef: React.MutableRefObject<number>;
}) {
  const numRef = useRef<HTMLSpanElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      if (deadline != null) {
        const remain = Math.max(0, deadline - (Date.now() + offsetRef.current));
        const txt = `${Math.ceil(remain / 1000)}s`;
        if (numRef.current && numRef.current.textContent !== txt) numRef.current.textContent = txt;
        if (barRef.current) barRef.current.style.width = `${Math.min(100, (remain / 60000) * 100)}%`;
      } else {
        if (numRef.current && numRef.current.textContent !== '') numRef.current.textContent = '';
        if (barRef.current) barRef.current.style.width = '0%';
      }
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [deadline, offsetRef]);
  return (
    <div className="countdown-row">
      <div className="timer-bar blood">
        <span ref={barRef} />
      </div>
      <span className="timer-mini" ref={numRef} />
    </div>
  );
}

/** 由手牌视图构建评估输入（含芯片效果） */
function toEval(cv: BloodCardView): EvalCard {
  return toEvalCard(
    cv.id,
    cv.r,
    cv.s,
    cv.chipIds.map((id) => BLOOD_MARKET_BY_ID.get(id)!.effect),
  );
}

type ZoneModal = null | { kind: 'discard' | 'removed' | 'items' };

export function BloodTable({ view }: { view: BloodView }) {
  const me = view.players.find((p) => p.seat === view.me.seat) ?? view.players[0];
  const opp = view.players.find((p) => p.seat !== view.me.seat);
  const isHost = view.hostId === net.playerId;

  // 阶段/回合切换时清空各阶段的选择状态（防止上一阶段的残留占用选择上限）
  useEffect(() => {
    setSelSetup([]);
    setSelSwap([]);
    setSelPlay([]);
    setSelRemove([]);
    setDelPick([]);
    setRefreshPick([]);
    setPinSeat(-1);
    setIrisSeat(-1);
    setPrecisePick([]);
  }, [view.round, view.phase]);

  const offsetRef = useRef(0);
  // 只在收到新视图（携带新的服务器时间）时校准时钟偏移。
  // 不能在每次渲染时计算：点击界面等重渲染会用“过期视图时间”污染偏移，导致倒计时跳变。
  useEffect(() => {
    offsetRef.current = view.serverTime - Date.now();
  }, [view]);

  const [selSetup, setSelSetup] = useState<string[]>([]);
  const [selSwap, setSelSwap] = useState<string[]>([]);
  const [selPlay, setSelPlay] = useState<string[]>([]);
  const [selRemove, setSelRemove] = useState<string[]>([]);
  const [pinSeat, setPinSeat] = useState(-1);
  const [irisSeat, setIrisSeat] = useState(-1);
  const [irisCat, setIrisCat] = useState(1);
  const [eraserCat, setEraserCat] = useState(1);
  const [precisePick, setPrecisePick] = useState<string[]>([]);
  const [delPick, setDelPick] = useState<string[]>([]);
  const [refreshPick, setRefreshPick] = useState<number[]>([]);
  /** 芯片购买：{defId, slot} —— 点购买后立即弹出弃牌区选牌 */
  const [chipBuying, setChipBuying] = useState<{ defId: string; slot: number } | null>(null);
  const [zoneModal, setZoneModal] = useState<ZoneModal>(null);
  /** 角色技能详情弹层（选将确认 / 座位徽章查看共用） */
  const [charDetail, setCharDetail] = useState<string | null>(null);
  const [detail, setDetail] = useState<BloodCardView | null>(null);
  const [ladderOpen, setLadderOpen] = useState(false);
  /** 牌局记录侧栏：宽屏默认展开，手机端默认收起（左缘小箭头切换） */
  const [logOpen, setLogOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 900);
  const [annHiddenAt, setAnnHiddenAt] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('none');
  const lockRef = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  // 黑市宣告特效数据（按效果类型定制）
  const annDef = view.announce ? BLOOD_MARKET_BY_ID.get(view.announce.defId) : undefined;
  const annFx = annDef?.effect.k ?? null;
  const annRoll = Number(/掷出\s*(\d)/.exec(view.announce?.extra ?? '')?.[1] ?? 0);

  // 对决演示：结算数据 → 双方摊牌（魁首在前，同一桌面依次翻牌展开，同屏对比牌型与点数）
  const [showdown, setShowdown] = useState<{
    rows: ShowdownRow[];
    winnerSeat: number;
    comparePipsFirst: boolean;
  } | null>(null);
  const lastShowdownRound = useRef<number | null>(null);

  useEffect(() => {
    if (!view.result) return;
    if (lastShowdownRound.current === view.round) return;
    lastShowdownRound.current = view.round;
    const rows: ShowdownRow[] = view.result.rows.map((r) => {
      // 每张牌上挂载的强化芯片（同种合并显示 ×n；含未来“复制对手芯片”类效果的扩展点）
      const effects: ShowdownRow['effects'] = [];
      const seen = new Map<string, number>();
      for (const c of r.cards ?? []) {
        for (const id of c.chipIds) seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      for (const [id, n] of seen) {
        const d = BLOOD_MARKET_BY_ID.get(id);
        if (d) effects.push({ chipName: n > 1 ? `${d.name}×${n}` : d.name, chipText: d.text });
      }
      return {
        seat: r.seat,
        name: r.name,
        cards: r.cards ?? [],
        catName: r.catName,
        pips: r.pips,
        cat: r.cat, // 服务端权威牌型（含角色技能修正）
        rank: r.rank,
        gainTickets: r.gainTickets,
        gainBlood: r.gainBlood,
        effects,
      };
    });
    setShowdown({
      rows,
      winnerSeat: view.result.winnerSeat,
      comparePipsFirst: view.result.comparePipsFirst,
    });
  }, [view.result, view.round, view.phase]);

  // 对决展示结束（全员确认 / 演示播完后 30s 超时推进）→ 弹窗自动关闭；终局模式由用户手动关闭
  useEffect(() => {
    if (showdown && !view.showdownWait && view.phase !== 'gameover') setShowdown(null);
  }, [view.showdownWait, view.phase, showdown]);

  // 日志自动滚到底部
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.logSeq]);

  // 拔除芯片：自动打开弃牌区选择带芯片的牌
  useEffect(() => {
    if (view.prompt.k === 'pullChip') setZoneModal({ kind: 'discard' });
  }, [view.prompt.k]);

  const send = (msg: Parameters<typeof net.send>[0]) => {
    const t = Date.now();
    if (t - lockRef.current < 250) return; // 防连点重复发送
    lockRef.current = t;
    net.send(msg);
  };

  const toggle = (list: string[], setList: (v: string[]) => void, id: string, max: number) => {
    if (list.includes(id)) setList(list.filter((x) => x !== id));
    else if (list.length < max) setList([...list, id]);
  };

  // 自己的角色技能对评估的修正（特型演员/枪手/杂技演员/女仆）
  const myCharId = view.players.find((p) => p.seat === view.me.seat)?.charId ?? null;
  const toEvalMe = (cv: BloodCardView): EvalCard => applyCharEval([toEval(cv)], myCharId)[0];

  const playHint = useMemo(() => {
    if (view.prompt.k !== 'play') return null;
    const chosen = view.me.hand.filter((c) => selPlay.includes(c.id));
    if (chosen.length === 0) return null;
    return evalBloodHand(chosen.map(toEvalMe));
  }, [view.prompt.k, view.me.hand, selPlay, myCharId]);

  const phaseIdx = PHASES.findIndex((p) => p.key === view.phase);

  const myTurnText = (): string => {
    switch (view.prompt.k) {
      case 'pick':
        return '选将：点击角色牌放大查看技能，选择其一（超时自动选择）';
      case 'setup':
        return '初始构筑：选择至多 4 张删除（也可以全保留）';
      case 'swap':
        return `换牌：选至多 3 张弃置并抽满（剩 ${view.me.swapLeft} 次，未用次数按 1次=1血筹 返还）`;
      case 'play':
        return '出牌：恰好选 5 张暗扣';
      case 'steal':
        return '血幕镀层（夺）：点击对方面板掠夺 1 血筹';
      case 'revealItem':
        return '对决宣告：是否使用道具';
      case 'sdConfirm':
        return '对决展示：关闭演示浮层即确认，全员确认后统一进入购买阶段';
      case 'buy':
        return '购买：点击黑市牌购买（芯片会弹出弃牌区选插入目标），或跳过';
      case 'insertChip':
        return '强化芯片：从弃牌区选一张牌插入（每张牌限 1 枚，点数范围 2-14）';
      case 'secretDelete':
        return `廉价删除：从弃牌区选至多 ${view.prompt.max ?? 0} 张删除`;
      case 'violentTarget':
        return '暴力删除：选择一方抽牌堆顶 3 张删除（需至少 3 张）';
      case 'refreshPick':
        return `再来一批：点选至多 ${view.prompt.max ?? 2} 张黑市牌换掉，之后可立即再买一次`;
      case 'remove':
        return '删牌：第 1 张免费，之后每张 2 血筹（点开弃牌区选择）';
      case 'reorg':
        return '重整：二选一';
      case 'poisonTarget':
        return '餐车投毒：点击对方面板选择目标';
      case 'freezeTarget':
        return '冻结车厢：点击对方面板选择目标';
      case 'amnesiaTarget':
        return '暂时失忆：点击对方面板选择目标';
      case 'boxRobTarget':
        return '黑厢抢夺：点击对方面板进行掷骰对决';
      case 'signalTarget':
        return '信号干扰器：点击对方面板，其随机弃1抽1';
      case 'demagTarget':
        return '消磁枪：点击对方面板，使其一张强化芯片失效';
      case 'pinpointClaim':
        return '定点爆破：点击对方面板选目标，再选点数确认';
      case 'irisGuess':
        return '赌徒虹膜：选择竞猜目标与牌型后确认';
      case 'eraserClaim':
        return '魔术橡皮：选择一种牌型，本回合其视为高牌';
      case 'pullChip':
        return '拔除芯片：点击弃牌区中带芯片的牌（+4🩸）';
      case 'preciseDel':
        return '精准删除：从抽到的 3 张中选择 0-2 张删除';
      default:
        return '等待对方操作…';
    }
  };

  const handList = useMemo(() => {
    const base = view.prompt.k === 'setup' ? view.me.setupHand : view.me.hand;
    return sortHand(base, sortMode);
  }, [view.prompt.k, view.me.setupHand, view.me.hand, sortMode]);
  const handClickable = view.prompt.k === 'setup' || view.prompt.k === 'swap' || view.prompt.k === 'play';
  const handSel = view.prompt.k === 'setup' ? selSetup : view.prompt.k === 'play' ? selPlay : selSwap;
  const handSetSel = view.prompt.k === 'setup' ? setSelSetup : view.prompt.k === 'play' ? setSelPlay : setSelSwap;
  const handMax = view.prompt.k === 'setup' ? 4 : view.prompt.k === 'play' ? 5 : 3;

  // 芯片插入模式下弃牌区点击
  const onDiscardClick = (c: BloodCardView) => {
    if (chipBuying) {
      if (c.chipIds.length > 0) return;
      send({ t: 'bBuy', slot: chipBuying.slot, insertInto: c.id });
      setChipBuying(null);
      return;
    }
    // 待插入芯片状态（如货箱盲掏免费获得的芯片）：点击弃牌区的牌完成插入
    if (view.prompt.k === 'insertChip') {
      if (c.chipIds.length > 0) return;
      send({ t: 'bInsertChip', cardId: c.id });
      setZoneModal(null);
      return;
    }
    if (view.prompt.k === 'secretDelete') {
      toggle(delPick, setDelPick, c.id, view.prompt.max ?? 2);
      return;
    }
    if (view.prompt.k === 'pullChip') {
      send({ t: 'bPullChip', cardId: c.id });
      setZoneModal(null);
      return;
    }
    if (view.prompt.k === 'remove') {
      toggle(selRemove, setSelRemove, c.id, 99);
    }
  };

  const zoneTitle =
    zoneModal?.kind === 'discard'
      ? view.prompt.k === 'insertChip'
        ? `弃牌区（${view.me.discard.length}）· 点击一张牌插入芯片`
        : view.prompt.k === 'secretDelete'
          ? `弃牌区（${view.me.discard.length}）· 点击选择要删除的牌`
          : view.prompt.k === 'pullChip'
            ? `弃牌区（${view.me.discard.length}）· 点击带芯片的牌拔除（+4🩸）`
            : `弃牌区（${view.me.discard.length}）`
      : zoneModal?.kind === 'removed'
        ? `删牌区（${view.me.removed.length}）`
        : '道具区';
  const zoneCards: BloodCardView[] =
    zoneModal?.kind === 'discard' ? view.me.discard : zoneModal?.kind === 'removed' ? view.me.removed : [];

  return (
    <div className="blood-shell">
      {/* 左侧：牌局记录列（小箭头可收起/展开；手机端为左侧抽屉） */}
      <aside className={`blood-side ${logOpen ? 'open' : ''}`}>
        <div className="box-title">牌局记录</div>
        <div className="blood-loglist" ref={logRef}>
          {view.log.map((l) => (
            <div key={l.seq} className={`log-line k-${l.kind}`}>
              {l.text}
            </div>
          ))}
        </div>
      </aside>
      <button
        className={`blood-side-toggle ${logOpen ? 'open' : ''}`}
        title={logOpen ? '收起牌局记录' : '展开牌局记录'}
        onClick={() => setLogOpen((v) => !v)}
      >
        {logOpen ? '‹' : '›'}
      </button>

      {/* 右侧：竖屏牌桌 */}
      <div className="blood-main">
        <header className="page-bar">
          <span className="brand">血色牌局</span>
          <span>
            房间 <b>{view.code}</b> · 第 {view.round + 1} 回合 · 目标 {view.target} 车票
          </span>
          <span className="spacer" />
          {view.phase !== 'gameover' && (
            <button
              className="btn small danger"
              onClick={() => {
                if (window.confirm('确定投降？本局判负并立即结束对局。')) send({ t: 'bResign' });
              }}
            >
              投降
            </button>
          )}
          <button
            className="btn small ghost"
            onClick={() => {
              if (window.confirm('确定退出房间？')) net.leaveRoom();
            }}
          >
            退出房间
          </button>
        </header>

        <div className="phase-bar">
          {PHASES.map((p, i) => (
            <span key={p.key} className={`ph-step ${i === phaseIdx ? 'cur' : i < phaseIdx ? 'done' : ''}`}>
              {p.label}
            </span>
          ))}
          <span className="spacer" />
          <Countdown deadline={view.deadline} offsetRef={offsetRef} />
        </div>

        {/* 对决展示确认等待条：全员确认后服务端统一进入购买，倒计时同步 */}
        {view.showdownWait && (
          <div className="sd-wait">
            <span className="sd-wait-text">
              ⚔️ 等待所有玩家确认对决展示…
              <b>
                {view.showdownWait.done}/{view.showdownWait.total}
              </b>
            </span>
            <div className="sd-wait-track">
              <span style={{ width: `${(view.showdownWait.done / Math.max(1, view.showdownWait.total)) * 100}%` }} />
            </div>
          </div>
        )}

        <div className="blood-area">
          {opp && (
            <div className={`bp-panel ${view.turnSeat === opp.seat ? 'to-act' : ''}`}>
              <div className="bp-head">
                <span className="bp-name">
                  {opp.name}
                  {!opp.connected && <span className="tag off">掉线</span>}
                </span>
                {opp.privilege && <span className="tag priv">👑特权证</span>}
                {opp.charId && (
                  <button className="tag char" onClick={() => setCharDetail(opp.charId)}>
                    🎭 {BLOOD_CHAR_BY_ID.get(opp.charId)?.name}
                  </button>
                )}
                <span className="spacer" />
                <span className="bp-res">
                  🩸{opp.blood} · 🎫{opp.tickets}
                </span>
              </div>
              <div className="bp-body">
                <div className="bp-cards">
                  {opp.played && view.phase === 'reveal'
                    ? opp.played.map((c) => <BCard key={c.id} c={c} size="sm" />)
                    : Array.from({ length: opp.locked ? 5 : 0 }, (_, i) => <CardView key={i} faceDown size="sm" />)}
                </div>
                <div className="bp-stats">
                  手牌 {opp.handCount} · 牌库 {opp.drawCount} · 道具 {opp.itemCount}
                  {view.phase === 'swap' && !opp.swapDone && ` · 还可换 ${opp.swapLeft} 次`}
                  {opp.lastAction && <div className="bp-action">{opp.lastAction}</div>}
                  {opp.handName && (
                    <div className="bp-handname">
                      {opp.handName} {opp.pips}点
                    </div>
                  )}
                  {view.prompt.k === 'steal' && (
                    <button className="btn small danger" onClick={() => send({ t: 'bSteal', seat: opp.seat })}>
                      掠夺 1 血筹
                    </button>
                  )}
                  {TARGET_LABELS[view.prompt.k] && (
                    <button
                      className="btn small danger"
                      onClick={() => send({ t: 'bSecretTarget', seat: opp.seat })}
                    >
                      {TARGET_LABELS[view.prompt.k]}
                    </button>
                  )}
                  {view.prompt.k === 'pinpointClaim' && (
                    <button
                      className={`btn small ${pinSeat === opp.seat ? 'primary' : 'danger'}`}
                      onClick={() => setPinSeat(opp.seat)}
                    >
                      {pinSeat === opp.seat ? '✓ 爆破目标' : '选为爆破目标'}
                    </button>
                  )}
                  {view.prompt.k === 'irisGuess' && (
                    <button
                      className={`btn small ${irisSeat === opp.seat ? 'primary' : 'danger'}`}
                      onClick={() => setIrisSeat(opp.seat)}
                    >
                      {irisSeat === opp.seat ? '✓ 竞猜目标' : '选为竞猜目标'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="market-strip">
            <div className="market-title">
              黑市 <span className="hint">供应堆 {view.supplyCount} · 回收站 {view.recycleCount}</span>
            </div>
            <div className="market-slots">
              {view.market.map((m, i) => {
                const pickable = view.prompt.k === 'refreshPick';
                const selected = pickable && refreshPick.includes(i);
                return (
                  <div
                    key={i}
                    className={`market-card ${i >= 3 ? 'hot' : ''} ${selected ? 'sel' : ''} ${pickable && m.defId ? 'clickable' : ''}`}
                    onClick={
                      pickable && m.defId
                        ? () =>
                            setRefreshPick((s) =>
                              s.includes(i) ? s.filter((x) => x !== i) : s.length < (view.prompt.max ?? 2) ? [...s, i] : s,
                            )
                        : undefined
                    }
                  >
                    {m.defId ? (
                      <>
                        <div className="mc-head">
                          <b>{m.name}</b>
                          <span className={`mc-kind k-${m.kind}`}>
                            {m.kind === 'chip' ? '芯片' : m.kind === 'item' ? '道具' : '交易'}
                          </span>
                        </div>
                        <div className="mc-text">{m.text}</div>
                        <div className="mc-foot">
                          <span className="mc-cost">🩸{m.cost}</span>
                          {m.bonus > 0 && <span className="mc-bonus">+{m.bonus}🩸</span>}
                          <span className="spacer" />
                          {view.prompt.k === 'buy' && (
                            <button
                              className="btn tiny"
                              disabled={
                                view.me.blood < m.cost ||
                                (BLOOD_MARKET_BY_ID.get(m.defId)?.kind === 'chip' && view.me.discard.length === 0)
                              }
                              title={
                                BLOOD_MARKET_BY_ID.get(m.defId)?.kind === 'chip' && view.me.discard.length === 0
                                  ? '弃牌区没有可插芯片的牌'
                                  : undefined
                              }
                              onClick={() => {
                                const def = BLOOD_MARKET_BY_ID.get(m.defId!);
                                if (def?.kind === 'chip') {
                                  setChipBuying({ defId: m.defId!, slot: i });
                                  setZoneModal({ kind: 'discard' });
                                } else {
                                  send({ t: 'bBuy', slot: i });
                                }
                              }}
                            >
                              购买
                            </button>
                          )}
                          {selected && <span className="mc-bonus">已选</span>}
                        </div>
                      </>
                    ) : (
                      <div className="mc-empty">已售空</div>
                    )}
                  </div>
                );
              })}
            </div>
            {view.prompt.k === 'refreshPick' && (
              <div className="act-row" style={{ marginTop: 8 }}>
                <button
                  className="btn primary"
                  onClick={() => {
                    send({ t: 'bRefreshPick', slots: refreshPick });
                    setRefreshPick([]);
                  }}
                >
                  确认换一批（{refreshPick.length} 张），之后可再买一次
                </button>
              </div>
            )}
          </div>

          <div className={`bp-panel mine ${view.turnSeat === view.me.seat ? 'to-act' : ''}`}>
            <div className="bp-head">
              <span className="bp-name">
                {me.name}
                <em>（你）</em>
              </span>
              {me.privilege && <span className="tag priv">👑特权证</span>}
              {me.charId && (
                <button className="tag char" onClick={() => setCharDetail(me.charId)}>
                  🎭 {BLOOD_CHAR_BY_ID.get(me.charId)?.name}
                </button>
              )}
              <span className="spacer" />
              <span className="bp-res">
                🩸{view.me.blood} · 🎫{me.tickets}
              </span>
            </div>
            <div className="zone-buttons">
              <button className="btn small" onClick={() => setZoneModal({ kind: 'discard' })}>
                弃牌区 {view.me.discard.length}
              </button>
              <button className="btn small" onClick={() => setZoneModal({ kind: 'removed' })}>
                删牌区 {view.me.removed.length}
              </button>
              <button className="btn small" onClick={() => setZoneModal({ kind: 'items' })}>
                道具区 {view.me.items.length}
              </button>
              <span className="hint">牌库 {view.me.drawCount}</span>
            </div>
            <div className="hand-sort-row">
              <span className="hint">手牌排序</span>
              <button
                className={`btn tiny ${sortMode === 'suit' ? 'on' : ''}`}
                onClick={() => setSortMode((m) => (m === 'suit' ? 'none' : 'suit'))}
              >
                花色
              </button>
              <button
                className={`btn tiny ${sortMode === 'rank' ? 'on' : ''}`}
                onClick={() => setSortMode((m) => (m === 'rank' ? 'none' : 'rank'))}
              >
                点数
              </button>
            </div>
            <div className="my-hand">
              {handList.map((c) => (
                <div key={c.id} className="hand-cell">
                  <BCard
                    c={c}
                    size="lg"
                    selected={handClickable && handSel.includes(c.id)}
                    onClick={handClickable ? () => toggle(handSel, handSetSel, c.id, handMax) : undefined}
                  />
                  {c.chipIds.length > 0 && (
                    <div className="zone-chips">
                      {c.chipIds.map((id) => (
                        <span key={id}>【{BLOOD_MARKET_BY_ID.get(id)?.name}】</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {handList.length === 0 && <span className="hint">…</span>}
            </div>

            <div className="blood-actions">
              <div className="act-hint">{myTurnText()}</div>
              {view.prompt.k === 'play' && playHint && (
                <div className="play-hint">
                  当前选择：{selPlay.length < 5 ? `还需 ${5 - selPlay.length} 张` : `【${playHint.name}】· ${playHint.pips} 点`}
                </div>
              )}
              <div className="act-row">
                {view.prompt.k === 'setup' && (
                  <button
                    className="btn primary"
                    onClick={() => {
                      send({ t: 'bSetup', removed: selSetup });
                      setSelSetup([]);
                    }}
                  >
                    {selSetup.length > 0 ? `删除 ${selSetup.length} 张并保留其余` : '全部保留'}
                  </button>
                )}
                {view.prompt.k === 'swap' && (
                  <>
                    <button
                      className="btn primary"
                      disabled={selSwap.length === 0}
                      onClick={() => {
                        send({ t: 'bSwap', cardIds: selSwap });
                        setSelSwap([]);
                      }}
                    >
                      换掉选中的 {selSwap.length} 张
                    </button>
                    <button className="btn" onClick={() => send({ t: 'bSwapStop' })}>
                      停止换牌（剩余 {view.me.swapLeft} 次兑 {view.me.swapLeft}🩸）
                    </button>
                    {view.me.items.some((it) => it.name === '皮下密信') && (
                      <button
                        className="btn"
                        disabled={view.me.blood < 2}
                        onClick={() =>
                          send({ t: 'bUseItem', itemId: view.me.items.find((it) => it.name === '皮下密信')!.id })
                        }
                      >
                        📜 皮下密信（2🩸抽3张）
                      </button>
                    )}
                    {view.me.items.some((it) => it.name === '信号干扰器') && (
                      <button
                        className="btn"
                        onClick={() =>
                          send({ t: 'bUseItem', itemId: view.me.items.find((it) => it.name === '信号干扰器')!.id })
                        }
                      >
                        📡 信号干扰器（选一名玩家弃1抽1）
                      </button>
                    )}
                  </>
                )}
                {view.prompt.k === 'play' &&
                  ['魔术橡皮', '广播喇叭', '赌徒虹膜'].map((nm) => {
                    const it = view.me.items.find((i) => i.name === nm);
                    return it ? (
                      <button key={it.id} className="btn" onClick={() => send({ t: 'bUseItem', itemId: it.id })}>
                        使用【{nm}】
                      </button>
                    ) : null;
                  })}
                {view.prompt.k === 'play' && view.me.items.some((it) => it.name === '荷官证') && (
                  <button
                    className="btn"
                    onClick={() =>
                      send({ t: 'bUseItem', itemId: view.me.items.find((it) => it.name === '荷官证')!.id })
                    }
                  >
                    ⚖️ 使用荷官证（宣告先比总点数）
                  </button>
                )}
                {view.prompt.k === 'play' && (
                  <button
                    className="btn primary"
                    disabled={selPlay.length !== 5}
                    onClick={() => {
                      // 按牌型排序后发送，对决亮牌时自然有序（三条在前、顺子按序等）
                      const chosen = handList.filter((c) => selPlay.includes(c.id));
                      const ev = evalBloodHand(chosen.map(toEvalMe));
                      const ordered = sortHandByType(chosen, ev.cat);
                      send({ t: 'bPlay', cardIds: ordered.map((c) => c.id) });
                      setSelPlay([]);
                    }}
                  >
                    确认出牌
                  </button>
                )}
                {view.prompt.k === 'revealItem' && (
                  <>
                    {view.me.items.map((it) => (
                      <button key={it.id} className="btn primary" onClick={() => send({ t: 'bUseItem', itemId: it.id })}>
                        使用【{it.name}】
                      </button>
                    ))}
                    <button className="btn" onClick={() => send({ t: 'bUseItem', itemId: null })}>
                      跳过宣告
                    </button>
                  </>
                )}
                {view.prompt.k === 'buy' && (
                  <button className="btn" onClick={() => send({ t: 'bPassBuy' })}>
                    跳过购买
                  </button>
                )}
                {view.prompt.k === 'insertChip' && (
                  <button
                    className="btn"
                    onClick={() => {
                      send({ t: 'bInsertSkip' });
                      setChipBuying(null);
                    }}
                  >
                    放弃（芯片进回收站）
                  </button>
                )}
                {view.prompt.k === 'secretDelete' && (
                  <>
                    <button
                      className="btn primary"
                      onClick={() => {
                        send({ t: 'bSecretDelete', cardIds: delPick });
                        setDelPick([]);
                      }}
                    >
                      确认删除（{delPick.length} 张）
                    </button>
                    <button className="btn" onClick={() => send({ t: 'bSecretDelete', cardIds: [] })}>
                      不删
                    </button>
                  </>
                )}
                {view.prompt.k === 'violentTarget' && (
                  <>
                    <button className="btn primary" onClick={() => send({ t: 'bViolent', seat: view.me.seat })}>
                      删自己牌堆顶3张（{view.me.drawCount} 张）
                    </button>
                    {opp && (
                      <button
                        className="btn danger"
                        disabled={opp.drawCount < 3}
                        onClick={() => send({ t: 'bViolent', seat: opp.seat })}
                      >
                        删对方牌堆顶3张（{opp.drawCount} 张）
                      </button>
                    )}
                    <button className="btn" onClick={() => send({ t: 'bViolent', seat: -1 })}>
                      放弃
                    </button>
                  </>
                )}
                {view.prompt.k === 'remove' && (
                  <>
                    <button
                      className="btn primary"
                      disabled={selRemove.length === 0}
                      onClick={() => {
                        send({ t: 'bRemove', cardIds: selRemove });
                        setSelRemove([]);
                      }}
                    >
                      删除 {selRemove.length} 张（费用 {Math.max(0, selRemove.length - 1) * 2}🩸）
                    </button>
                    <button className="btn" onClick={() => send({ t: 'bRemoveDone' })}>
                      结束（不删牌）
                    </button>
                  </>
                )}
                {view.prompt.k === 'pinpointClaim' && (
                  <div className="act-row wrap">
                    <span className="hint">
                      爆破目标：{pinSeat >= 0 ? view.players.find((p) => p.seat === pinSeat)?.name : '先点击对方面板选择'}
                    </span>
                    {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((r) => (
                      <button
                        key={r}
                        className="btn tiny"
                        disabled={pinSeat < 0}
                        onClick={() => {
                          send({ t: 'bPinpoint', seat: pinSeat, rank: r });
                          setPinSeat(-1);
                        }}
                      >
                        {r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : r}
                      </button>
                    ))}
                  </div>
                )}
                {view.prompt.k === 'eraserClaim' && (
                  <div className="act-row wrap">
                    <span className="hint">宣告视为高牌的牌型：</span>
                    <select value={eraserCat} onChange={(e) => setEraserCat(Number(e.target.value))}>
                      {HAND_LADDER.filter((h) => !h.chipOnly).map((h, i) => (
                        <option key={h.name} value={14 - i}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                    <button className="btn primary" onClick={() => send({ t: 'bEraserClaim', cat: eraserCat })}>
                      宣告
                    </button>
                  </div>
                )}
                {view.prompt.k === 'irisGuess' && (
                  <>
                    <div className="act-row wrap">
                      <span className="hint">竞猜目标：</span>
                      {view.players
                        .filter((p) => p.seat !== view.me.seat)
                        .map((p) => (
                          <button
                            key={p.seat}
                            className={`btn tiny ${irisSeat === p.seat ? 'primary' : ''}`}
                            onClick={() => setIrisSeat(p.seat)}
                          >
                            {p.name}
                          </button>
                        ))}
                      <button
                        className={`btn tiny ${irisSeat === view.me.seat ? 'primary' : ''}`}
                        onClick={() => setIrisSeat(view.me.seat)}
                      >
                        自己
                      </button>
                    </div>
                    <div className="act-row wrap">
                      <span className="hint">猜测牌型：</span>
                      <select value={irisCat} onChange={(e) => setIrisCat(Number(e.target.value))}>
                        {HAND_LADDER.map((h, i) => (
                          <option key={h.name} value={14 - i}>
                            {h.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn primary"
                        disabled={irisSeat < 0}
                        onClick={() => {
                          send({ t: 'bIrisGuess', seat: irisSeat, cat: irisCat });
                          setIrisSeat(-1);
                        }}
                      >
                        确认竞猜（猜中+3🩸，其车票-4）
                      </button>
                    </div>
                  </>
                )}
                {view.prompt.k === 'preciseDel' && (
                  <>
                    <div className="my-hand">
                      {(view.prompt.cards ?? []).map((c) => (
                        <div key={c.id} className="hand-cell">
                          <BCard
                            c={{ ...c, s: c.s as BloodCardView['s'], chipIds: [] }}
                            size="lg"
                            selected={precisePick.includes(c.id)}
                            onClick={() =>
                              setPrecisePick((s2) =>
                                s2.includes(c.id) ? s2.filter((x) => x !== c.id) : s2.length < 2 ? [...s2, c.id] : s2,
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <div className="act-row">
                      <button
                        className="btn primary"
                        onClick={() => {
                          send({ t: 'bPreciseDel', cardIds: precisePick });
                          setPrecisePick([]);
                        }}
                      >
                        删除选中的 {precisePick.length} 张（其余弃置）
                      </button>
                    </div>
                  </>
                )}
                {view.prompt.k === 'reorg' && (
                  <>
                    <button className="btn primary" onClick={() => send({ t: 'bReorg', choice: 'reshuffle' })}>
                      重洗牌库（弃牌堆+牌库合成新牌库）
                    </button>
                    <button className="btn" onClick={() => send({ t: 'bReorg', choice: 'blood' })}>
                      获得 2 血筹
                    </button>
                  </>
                )}
              </div>
              {view.prompt.k === 'remove' && selRemove.length > 0 && (
                <div className="hint" style={{ marginTop: 6 }}>
                  已选：{view.me.discard.filter((c) => selRemove.includes(c.id)).map(cardLabel).join(' ')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 牌型天梯（右下角） */}
      <button className={`ladder-toggle ${ladderOpen ? 'open' : ''}`} onClick={() => setLadderOpen(!ladderOpen)}>
        {ladderOpen ? '收起天梯' : '牌型天梯'}
      </button>
      {ladderOpen && (
        <div className="ladder-panel">
          <div className="ladder-row ladder-head">
            <span>牌型（高 → 低）</span>
            <span>说明</span>
          </div>
          {HAND_LADDER.map((h, i) => (
            <div key={h.name} className={`ladder-row ${h.chipOnly ? 'chip-row' : ''}`}>
              <span>
                {h.name}
                {h.chipOnly && <em>芯片</em>}
              </span>
              <span className="ladder-desc">{h.desc}</span>
            </div>
          ))}
          <div className="hint" style={{ marginTop: 6 }}>
            同牌型比较出牌区所有牌点数总和；A 恒为 14 点
          </div>
        </div>
      )}

      {/* 牌区弹窗 */}
      {zoneModal && (
        <div className="overlay" onClick={() => setZoneModal(null)}>
          <div className="panel zone-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{zoneTitle}</h3>
            {zoneModal.kind === 'items' ? (
              <div className="item-list">
                {view.me.items.length === 0 && <span className="hint">空</span>}
                {view.me.items.map((it) => (
                  <div key={it.id} className="result-row">
                    <span className="r-name">{it.name}</span>
                    <span className="r-hand">{it.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <>
              {detail && (
                <div className="card-detail">
                  <BCard c={detail} size="lg" />
                  <div className="detail-info">
                    <div className="detail-line">
                      牌面：<b>{effLabel(detail)}</b>
                      {(detail.s == null || detail.r === 0) && '（对决阶段可视为任意点数与花色）'}
                    {(() => {
                      const { mod } = effRankOf(detail);
                      return mod !== null && mod !== 0 ? (
                        <span className={mod > 0 ? 'mod-note up' : 'mod-note down'}>
                          （原 {cardLabel(detail)}，{mod > 0 ? '+' : ''}
                          {mod}）
                        </span>
                      ) : null;
                    })()}
                    </div>
                    {detail.chipIds.length === 0 && <div className="detail-line hint">未插入强化芯片</div>}
                    {detail.chipIds.map((id) => {
                      const d = BLOOD_MARKET_BY_ID.get(id)!;
                      return (
                        <div key={id} className="detail-chip">
                          <b>【{d.name}】</b>
                          <span>{d.text}</span>
                        </div>
                      );
                    })}
                    <button className="btn small" onClick={() => setDetail(null)}>
                      收起详情
                    </button>
                  </div>
                </div>
              )}
              <div className="zone-grid">
                {zoneCards.map((c) => {
                  const pickMode =
                    (zoneModal.kind === 'discard' && !!chipBuying) ||
                    (zoneModal.kind === 'discard' && view.prompt.k === 'secretDelete') ||
                    (zoneModal.kind === 'discard' && view.prompt.k === 'remove') ||
                    (zoneModal.kind === 'discard' && view.prompt.k === 'insertChip');
                  const list = view.prompt.k === 'secretDelete' ? delPick : selRemove;
                  const selected = pickMode && !chipBuying && list.includes(c.id);
                  return (
                    <div key={c.id} className="zone-cell">
                      <BCard
                        c={c}
                        size="md"
                        selected={selected}
                        dim={chipBuying != null && c.chipIds.length > 0}
                        onClick={() => (pickMode ? onDiscardClick(c) : setDetail(c))}
                      />
                      {c.chipIds.length > 0 && (
                        <div className="zone-chips">
                          {c.chipIds.map((id) => (
                            <span key={id}>【{BLOOD_MARKET_BY_ID.get(id)?.name}】</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {zoneCards.length === 0 && <span className="hint">空</span>}
              </div>
              </>
            )}
            <div className="panel-actions" style={{ marginTop: 12 }}>
              {(zoneModal.kind === 'discard' && view.prompt.k === 'secretDelete') && (
                <button
                  className="btn primary"
                  onClick={() => {
                    send({ t: 'bSecretDelete', cardIds: delPick });
                    setDelPick([]);
                    setZoneModal(null);
                  }}
                >
                  确认删除（{delPick.length} 张）
                </button>
              )}
              {(zoneModal.kind === 'discard' && view.prompt.k === 'remove') && (
                <button
                  className="btn primary"
                  disabled={selRemove.length === 0}
                  onClick={() => {
                    send({ t: 'bRemove', cardIds: selRemove });
                    setSelRemove([]);
                    setZoneModal(null);
                  }}
                >
                  确认删除 {selRemove.length} 张（费用 {Math.max(0, selRemove.length - 1) * 2}🩸）
                </button>
              )}
              {chipBuying && zoneModal.kind === 'discard' && (
                <button
                  className="btn"
                  onClick={() => {
                    send({ t: 'bInsertSkip' });
                    setChipBuying(null);
                    setZoneModal(null);
                  }}
                >
                  放弃购买（费用不退，芯片进回收站）
                </button>
              )}
              <button className="btn small" onClick={() => setZoneModal(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 黑市牌宣告浮窗：全员可见（按效果类型定制特效） */}
      {view.announce && annHiddenAt !== view.announce.at && (
        <div className={`announce-float fx-${annFx ?? 'none'}`} onClick={() => setAnnHiddenAt(view.announce!.at)}>
          <div className="announce-head">
            <b>【{view.announce.name}】</b>
            <span className={`mc-kind k-${view.announce.kind}`}>
              {view.announce.kind === 'chip' ? '强化芯片' : view.announce.kind === 'item' ? '备用道具' : '秘密交易'}
            </span>
            <span className="announce-buyer">
              {view.announce.buyerName}
              {view.announce.cost > 0 ? ` · 支付 ${view.announce.cost}🩸` : ' · 免费获得'}
            </span>
          </div>
          <div className="announce-text">{view.announce.text}</div>
          {view.announce.extra && <div className="announce-extra">{view.announce.extra}</div>}
          <div className="announce-tip">已向所有人宣告 · 点击关闭</div>

          {/* 自定义动画（assets/fx/<defId>）：全亮度显示在右侧，文字自动让位 */}
          {view.announce && fxUrlOf(view.announce.defId) && (
            <img className="fx-img" src={fxUrlOf(view.announce.defId)} alt="" />
          )}

          {/* 效果特效层（emoji 水印，仅无自定义动画的牌显示） */}
          <div className="announce-fx">
            {annFx === 'rollDice' && (
              <div className="fx-dice">
                <span className="fx-dice-face">{DICE_FACES[annRoll - 1] ?? '⚄'}</span>
              </div>
            )}
            {annFx === 'deleteUpTo' && (
              <div className="fx-ash">
                {Array.from({ length: 6 }, (_, k) => (
                  <span key={k} className="ash-bit" style={{ '--i': k } as React.CSSProperties} />
                ))}
              </div>
            )}
            {annFx === 'violentDelete' && (
              <div className="fx-blast">
                <span className="blast-emoji">💥</span>
                {Array.from({ length: 6 }, (_, k) => (
                  <span key={k} className="blast-bit" style={sparkStyle(k)} />
                ))}
              </div>
            )}
            {annFx === 'topOfMarket' && (
              <div className="fx-crate">
                <span className="crate-glow" />
                <span className="crate-emoji">📦</span>
                <span className="crate-rays">✦</span>
              </div>
            )}
            {annFx === 'privilegeBonus' && (
              <div className="fx-crown">
                <span className="crown-emoji">👑</span>
                <span className="crown-coins">🪙🪙🪙</span>
              </div>
            )}
            {annFx === 'refreshMarket' && (
              <div className="fx-refresh">
                <span className="refresh-emoji">🔁</span>
                <span className="refresh-wave" />
              </div>
            )}
            {annFx === 'dealerLicense' && (
              <div className="fx-scale">
                <span className="scale-emoji">⚖️</span>
              </div>
            )}
            {annFx != null &&
              !ANNOUNCE_FX_KINDS.has(annFx) &&
              !(view.announce && fxUrlOf(view.announce.defId)) && (
                <div className="fx-generic">
                  <span>{ANNOUNCE_FX_EMOJI[annFx] ?? '✨'}</span>
                </div>
              )}
          </div>
        </div>
      )}

      {/* 选将：从随机两张角色牌中选择一张（点击放大查看技能） */}
      {view.phase === 'pick' && (
        <div className="overlay char-pick">
          <div className="panel char-pick-panel" onClick={(e) => e.stopPropagation()}>
            <h3>🎭 选将 · 从两张随机角色牌中选择一张</h3>
            {(() => {
              const mine = view.players.find((p) => p.seat === view.me.seat);
              const myChar = mine?.charId ?? null;
              const oppP = view.players.find((p) => p.seat !== view.me.seat);
              if (myChar) {
                return (
                  <div className="char-pick-waiting">
                    <CharPortrait def={BLOOD_CHAR_BY_ID.get(myChar)!} size="md" />
                    <p>
                      已选择【{BLOOD_CHAR_BY_ID.get(myChar)?.name}】
                      {oppP && !oppP.charId && ' · 等待对方选择…'}
                      {oppP?.charId && ` · 对方已选择【${BLOOD_CHAR_BY_ID.get(oppP.charId)?.name}】`}
                    </p>
                  </div>
                );
              }
              return (
                <div className="char-pick-row">
                  {(view.me.charOptions ?? []).map((id) => (
                    <CharPortrait key={id} def={BLOOD_CHAR_BY_ID.get(id)!} size="lg" onClick={() => setCharDetail(id)} />
                  ))}
                </div>
              );
            })()}
            <p className="hint">点击角色牌放大查看技能 · 超时将自动选择第一张</p>
          </div>
        </div>
      )}

      {/* 角色技能详情（选将确认 / 座位徽章查看） */}
      {charDetail && (
        <CharDetail
          charId={charDetail}
          pickable={view.phase === 'pick' && (view.me.charOptions ?? []).includes(charDetail)}
          onPick={() => {
            send({ t: 'bPickChar', charId: charDetail });
            setCharDetail(null);
          }}
          onClose={() => setCharDetail(null)}
        />
      )}

      {/* 对决演示：同一桌面双方摊牌对比；演示播完后开始 30s 倒计时，双方确认或超时后自动关闭 */}
      {showdown && (
        <Showdown
          rows={showdown.rows}
          winnerSeat={showdown.winnerSeat}
          comparePipsFirst={showdown.comparePipsFirst}
          mySeat={view.me.seat}
          wait={view.showdownWait}
          myConfirmed={view.players.find((p) => p.seat === view.me.seat)?.sdSeen ?? false}
          deadline={view.deadline}
          timeOffset={offsetRef.current}
          final={view.phase === 'gameover'}
          onClose={() => setShowdown(null)}
          onConfirm={() => net.send({ t: 'bShowdownDone' })}
        />
      )}

      {/* 结算：右上角浮动卡片，每回合只弹一次，不遮挡操作 */}
      {/* 终局 */}
      {view.final && !showdown && (
        <div className="overlay">
          <div className="panel">
            <h3>🏆 整场结束</h3>
            <ol className="ranking">
              {view.final.ranking.map((r, i) => (
                <li key={r.seat} className={i === 0 ? 'champ' : ''}>
                  {i + 1}. {r.name} — {r.tickets} 车票 / {r.blood} 血筹 {i === 0 ? '👑' : ''}
                </li>
              ))}
            </ol>
            <div className="panel-actions">
              {isHost ? (
                <button className="btn primary" onClick={() => send({ t: 'bRematch' })}>
                  再来一场
                </button>
              ) : (
                <span className="hint">等待房主开始新一场…</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
