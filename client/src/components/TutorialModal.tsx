import { useState } from 'react';
import { useEscClose } from './useOverlayClose';

interface TutorialPage {
  title: string;
  /** 页面主体：h4 小节 + 列表 */
  sections: { head: string; items: string[] }[];
}

const PAGES: TutorialPage[] = [
  {
    title: '你要做什么',
    sections: [
      {
        head: '🎯 目标',
        items: [
          '血色牌局是 2-4 人的卡牌对决：每人拥有一副独立的 54 张扑克（含大小王）。',
          '🩸 血筹是钱——用来购买黑市牌、删牌；归零不会出局。',
          '🎫 车票是胜利分数——每回合按名次发放：第1名 +4🎫、第2名 +2🎫+2🩸（2人局第2名 +4🩸）、第3名 +1🎫+3🩸（仅4人局）、第4名 +4🩸；2人局另有速攻加成：本局首个夺魁再 +1🎫、连续夺魁每次再 +1🎫。',
          '最先集齐目标车票即获胜：2 人局 24 张 · 3 人局 20 张 · 4 人局 16 张（房主可自定义 8-30）。',
        ],
      },
      {
        head: '💡 一句话理解',
        items: ['修一副强牌库 → 每回合暗扣 5 张和大家比牌型 → 赢家拿更多车票和血筹 → 滚雪球到目标票数。'],
      },
    ],
  },
  {
    title: '开局准备',
    sections: [
      {
        head: '🎭 角色牌',
        items: [
          '开局抽 2 张角色牌选 1 张，每名角色有一个整局生效的专属技能。',
          '全部 58 名角色可在左下「📖 图鉴」查看；带「已实装」徽标的技能全自动结算。',
        ],
      },
      {
        head: '✂️ 初始构筑（2 轮）',
        items: [
          '每轮从自己牌堆抽 8 张，选择最多删掉其中 4 张——把牌库修成你想要的套路。',
          '例：想冲「七条」就保留同点数的牌；想冲同花就保留同花色。',
          '构筑阶段没用的删牌机会不会补偿；进对局后删牌要花钱（见第 5 页）。',
        ],
      },
    ],
  },
  {
    title: '回合八阶段',
    sections: [
      {
        head: '🔁 每回合按顺序进行',
        items: [
          '① 抽牌：从自己牌堆补到手牌上限（6 张，魔术师 7）。',
          '② 换牌：默认 3 次，每次可弃任意张并补等量；剩余次数折算成血筹（1 次 = 1🩸）。',
          '③ 出牌：从手牌暗扣 5 张到出牌区，别人看不到你的牌。',
          '④ 对决：全员同时亮牌并宣告牌型。',
          '⑤ 结算：按名次发放车票与血筹，魁首拿最多。',
          '⑥ 购买：黑市五格按名次轮流买/跳过。',
          '⑦ 删牌：免费删 1 张，追加删每张 2🩸。',
          '⑧ 重整：选择重洗自己牌库，或 +2🩸。',
        ],
      },
      {
        head: '⏱ 兜底机制',
        items: ['每个阶段 60 秒超时自动托管（终局计分板会标 🤖）；断线重连自动回到座位，手牌不丢。'],
      },
    ],
  },
  {
    title: '牌型大小',
    sections: [
      {
        head: '🃏 常规牌型（低 → 高）',
        items: ['高牌 < 对子 < 两对 < 三条 < 顺子 < 同花 < 葫芦 < 四条 < 同花顺。'],
      },
      {
        head: '⭐ 本作特殊牌型（芯片合成的魅力）',
        items: [
          '同花葫芦 < 五条 < 同花五条 < 六条 < 同花六条 < 七条（最高）。',
          '强化芯片可以改点数/花色，把普通牌「焊」成这些稀有牌型。',
        ],
      },
      {
        head: '⚖️ 特殊规则',
        items: [
          'A 恒为 14 点：A-2-3-4-5 不是顺子；2-10 按点数，J/Q/K = 11/12/13，王 = 0。',
          '大小王是万能牌：对决时视为任意花色与点数。',
          '牌型相同比总点数总和；再相同比特权证距离，特权证持有者占优。',
        ],
      },
    ],
  },
  {
    title: '黑市与血筹',
    sections: [
      {
        head: '🏪 黑市购买（每回合一次）',
        items: [
          '黑市亮 5 格，按本回合名次顺序轮流「买」或「跳过」，想要的热门牌会被下家抢走。',
          '三类牌：强化芯片（改点数/花色，插入自己的牌永久生效）、备用道具（荷官证等，在关键时机手动使用）、秘密交易（买后立即结算）。',
          '最右两格牌上的绿色「带走 🩸N」是奖励不是加价：每轮购买阶段结束各叠 1 血筹，买下的人连血筹一起拿走。',
        ],
      },
      {
        head: '🩸 血筹怎么花',
        items: [
          '买黑市牌、追加删牌（2🩸/张）、部分角色技能发动。',
          '收入来源：每回合结算按名次发放、换牌剩余次数折算、角色/道具技能。',
        ],
      },
      {
        head: '🧩 拓展黑市',
        items: ['房主开局前可开启「拓展黑市」：牌库并入 27 种拓展牌（弹簧夹层、复制芯片、防护屏障等强交互牌）。'],
      },
    ],
  },
  {
    title: '实战建议',
    sections: [
      {
        head: '🧠 新手四条',
        items: [
          '构筑定套路：开局就想好冲七条/同花/葫芦哪条线，删牌别舍不得。',
          '血筹是节奏：留钱抢关键芯片，还是早删牌提纯牌库，取决于你的套路成型速度。',
          '对决是明牌：亮牌后所有人都看得到彼此的牌，据此推测对手牌库剩余什么、黑市想买什么。',
          '盯紧车票榜：快到目标的对手是公共敌人，黑市里压制类道具可以考虑针对他。',
        ],
      },
      {
        head: '🔒 好友局',
        items: ['建房时设置密码，把房间码 + 密码发给朋友即可私密开局。'],
      },
    ],
  },
  {
    title: '附：经典德州速成',
    sections: [
      {
        head: '♠️ 与血色模式并列的另一种玩法',
        items: [
          '每人 2 张底牌，桌上发 5 张公共牌，组成最大七选五牌型。',
          '四轮下注（翻牌前/翻牌/转牌/河牌）：弃牌、过牌、跟注、加注或全下。',
          '筹码打光即出局，最后留在桌上的人获胜。',
          '血筹/车票/黑市/角色技能均不参与本模式，纯牌技与筹码管理。',
        ],
      },
    ],
  },
];

/** 新手教程弹窗：分页讲解规则（大厅「📚 教程」入口） */
export function TutorialModal({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(0);
  const total = PAGES.length;
  const cur = PAGES[page];
  const last = page === total - 1;
  useEscClose(onClose);

  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel tutorial-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <h3 style={{ margin: 0 }}>📚 血色牌局 · 新手教程</h3>
          <span className="hint">
            {page + 1} / {total} · {cur.title}
          </span>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="codex-body tutorial-page">
          {cur.sections.map((s) => (
            <div key={s.head} className="tutorial-section">
              <h4>{s.head}</h4>
              <ul>
                {s.items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="tutorial-foot">
          <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← 上一步
          </button>
          <span className="tutorial-dots">
            {PAGES.map((p, i) => (
              <i key={p.title} className={i === page ? 'on' : i < page ? 'done' : ''} title={p.title} />
            ))}
          </span>
          {last ? (
            <button className="btn primary" onClick={onClose}>
              开始游戏 🎉
            </button>
          ) : (
            <button className="btn primary" onClick={() => setPage((p) => p + 1)}>
              下一步 →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
