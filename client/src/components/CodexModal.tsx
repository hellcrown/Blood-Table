import { useState } from 'react';
import { BLOOD_CHARS } from '@shared/bloodChars';
import { BLOOD_MARKET_DEFS, BLOOD_MARKET_EXPANSION_DEFS, type BloodMarketDef, type MarketKind } from '@shared/bloodCards';
import { CharDetail, CharPortrait } from './CharCard';
import { useEscClose } from './useOverlayClose';

const KIND_CN: Record<MarketKind, string> = { chip: '芯片', item: '道具', secret: '交易' };

/** 黑市卡面（图鉴用静态渲染：名称/类别/文本/价格/张数） */
function MarketCardFace({ def }: { def: BloodMarketDef }) {
  return (
    <div className="market-card codex-card">
      <div className="mc-head">
        <b>{def.name}</b>
        <span className={`mc-kind k-${def.kind}`}>{KIND_CN[def.kind]}</span>
      </div>
      <div className="mc-text">{def.text}</div>
      <div className="mc-foot">
        <span className="mc-cost">🩸{def.cost}</span>
        <span className="spacer" />
        <span className="hint">×{def.count}{def.expansion ? ' · 拓展' : ''}</span>
      </div>
    </div>
  );
}

/**
 * 图鉴弹窗：角色（58 名，点击看技能）与黑市牌（基础+拓展全览）两个页签，
 * 数据直接读 shared 定义，无需请求服务端。
 */
export function CodexModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'chars' | 'cards'>('chars');
  const [charPool, setCharPool] = useState<'all' | 'basic' | 'exp'>('all');
  const [diff, setDiff] = useState<'all' | 1 | 2 | 3>('all');
  const [kind, setKind] = useState<'all' | MarketKind>('all');
  const [withExp, setWithExp] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);
  useEscClose(onClose);

  const chars = BLOOD_CHARS.filter(
    (c) =>
      (charPool === 'all' ? true : charPool === 'basic' ? !!c.basic : !c.basic) &&
      (diff === 'all' || c.difficulty === diff),
  );
  const allCards = [...BLOOD_MARKET_DEFS, ...BLOOD_MARKET_EXPANSION_DEFS];
  const cards = allCards.filter((d) => (withExp || !d.expansion) && (kind === 'all' || d.kind === kind));

  const chip = (active: boolean, label: string, onClick: () => void, key?: string) => (
    <button key={key ?? label} className={`btn tiny ${active ? 'primary' : 'ghost'}`} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <div className="codex-tabs">
            {chip(tab === 'chars', '角色图鉴', () => setTab('chars'))}
            {chip(tab === 'cards', '黑市图鉴', () => setTab('cards'))}
          </div>
          <div className="codex-filters">
            {tab === 'chars' ? (
              <>
                {chip(charPool === 'all', `全部 ${BLOOD_CHARS.length}`, () => setCharPool('all'))}
                {chip(charPool === 'basic', `基础 ${BLOOD_CHARS.filter((c) => c.basic).length}`, () => setCharPool('basic'))}
                {chip(charPool === 'exp', `拓展 ${BLOOD_CHARS.filter((c) => !c.basic).length}`, () => setCharPool('exp'))}
                <span className="codex-sep" />
                {chip(diff === 'all', '全部难度', () => setDiff('all'))}
                {chip(diff === 1, '★ 入门', () => setDiff(1))}
                {chip(diff === 2, '★★ 进阶', () => setDiff(2))}
                {chip(diff === 3, '★★★ 硬核', () => setDiff(3))}
              </>
            ) : (
              <>
                {chip(kind === 'all', `全部 ${(withExp ? allCards : allCards.filter((d) => !d.expansion)).length}`, () => setKind('all'))}
                {chip(kind === 'chip', '强化芯片', () => setKind('chip'))}
                {chip(kind === 'item', '备用道具', () => setKind('item'))}
                {chip(kind === 'secret', '秘密交易', () => setKind('secret'))}
                {chip(withExp, withExp ? '含拓展 ✓' : '仅基础', () => setWithExp((v) => !v))}
              </>
            )}
          </div>
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="codex-body">
          {tab === 'chars' ? (
            <div className="codex-grid chars">
              {chars.map((c) => (
                <CharPortrait key={c.id} def={c} size="sm" onClick={() => setDetail(c.id)} />
              ))}
            </div>
          ) : (
            <div className="codex-grid cards">
              {cards.map((d) => (
                <MarketCardFace key={d.id} def={d} />
              ))}
            </div>
          )}
        </div>
        <p className="hint codex-note">
          {tab === 'chars'
            ? '点击角色卡查看技能详情；难度 = 技能理解成本+操作复杂度+失误惩罚（★入门 / ★★进阶 / ★★★硬核）；「部分实装」角色的自动化范围见详情页说明'
            : '价格为牌面原价（窥天师天意 -2、魏王芯片 -2 等角色折扣另计）；×N 为牌库中该牌张数'}
        </p>
      </div>
      {detail && <CharDetail charId={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
