import { useState } from 'react';
import { getBgmVol, getSfxVol, setBgmVol, setSfxVol, playSfx } from '../audio/sound';

/**
 * 音量设置面板：音效 / BGM 双滑杆（localStorage 持久化，无需过服务器）。
 * BGM 默认关闭（0），拖动即开播；音效默认 60。
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [sfx, setSfx] = useState(getSfxVol());
  const [bgm, setBgm] = useState(getBgmVol());

  const row = (label: string, value: number, onChange: (v: number) => void, hint: string, onTest?: () => void) => (
    <div className="vol-row">
      <div className="vol-label">
        <b>{label}</b>
        <span className="hint">{value === 0 ? '关' : `${Math.round(value * 100)}%`}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <div className="vol-foot">
        <span className="hint">{hint}</span>
        {onTest && (
          <button className="btn tiny ghost" onClick={onTest}>
            试听
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel vol-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <h3 style={{ margin: 0 }}>⚙️ 音量设置</h3>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="codex-body">
          {row('🔊 音效', sfx, (v) => {
            setSfxVol(v);
            setSfx(v);
          }, '亮牌 / 购买 / 结算 / 按钮等提示音', () => playSfx('ticket'))}
          {row('🎵 BGM 氛围', bgm, (v) => {
            setBgmVol(v);
            setBgm(v);
          }, '低音量暗夜赌场氛围（心跳 + 铺底），默认关闭，建议 20-40%')}
          <p className="hint" style={{ marginTop: 12 }}>
            设置保存在本机浏览器；BGM 拖离 0 即开始播放。局内随时可从顶部「⚙」再次打开。
          </p>
        </div>
      </div>
    </div>
  );
}
