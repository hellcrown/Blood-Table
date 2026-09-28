/**
 * 程序化音效引擎（零音频资产，Web Audio 合成）。
 * - SFX：点击/发牌/暗扣/亮牌揭晓/得筹/购买/胜/负/错误，音量 localStorage 持久化
 * - BGM：低音量暗夜赌场氛围（低频铺底 + 缓慢心跳），默认关闭，局内可开
 * - AudioContext 在首次用户手势时创建（浏览器自动播放策略）；未就绪时静默跳过
 */

const SFX_KEY = 'blood.sfxVol'; // 0-100，默认 60
const BGM_KEY = 'blood.bgmVol'; // 0-100，0=关闭，默认 0

export type SfxName =
  | 'tap' // 选牌/按钮：纸牌轻拂（用户反馈高频方波难受，统一用低频噪声拂动）
  | 'deal' // 发牌/换牌
  | 'lock' // 暗扣确认
  | 'reveal' // 亮牌揭晓
  | 'coin' // 购买/血筹
  | 'ticket' // 结算车票
  | 'win' // 终局胜利
  | 'lose' // 终局失败
  | 'error'; // 错误提示

function loadVol(key: string, dflt: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return dflt; // 从未设置过：用默认值（Number(null) 是 0，不能直接转）
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 100) return v / 100;
  } catch {
    /* 忽略 */
  }
  return dflt;
}

function saveVol(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(Math.round(v * 100)));
  } catch {
    /* 忽略 */
  }
}

let ctx: AudioContext | null = null;
let sfxVol = loadVol(SFX_KEY, 0.6);
let bgmVol = loadVol(BGM_KEY, 0);

/** 首次用户手势时创建/恢复 AudioContext（惰性） */
function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null; // 环境不支持
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => void ensureCtx(), { once: true, capture: true });
  // 全局按钮点击音（capture 兜底 stopPropagation 的按钮）——与选牌同款纸牌轻拂，无高频
  document.addEventListener(
    'click',
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.('button');
      if (el && !(el as HTMLButtonElement).disabled) playSfx('tap');
    },
    { capture: true },
  );
}

/** 噪声缓冲（发牌沙沙声用），首次用时创建 */
let noiseBuf: AudioBuffer | null = null;
function getNoise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 0.3, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

/** 单音：type 波形 / freq 起→止 / dur 时长 / vol 相对音量 / delay 起始偏移 */
function tone(
  c: AudioContext,
  out: AudioNode,
  type: OscillatorType,
  f0: number,
  f1: number,
  dur: number,
  vol: number,
  delay = 0,
): void {
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** 噪声脉冲（bandpass 滤波，牌的沙沙/摩擦感） */
function noise(c: AudioContext, out: AudioNode, freq: number, dur: number, vol: number, delay = 0): void {
  const t = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 0.9;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.05);
}

/** 播放一个音效（音量为 0 或上下文未就绪时静默跳过） */
export function playSfx(name: SfxName): void {
  if (sfxVol <= 0) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running') return;
  const master = c.createGain();
  master.gain.value = sfxVol;
  master.connect(c.destination);
  try {
    switch (name) {
      case 'tap':
        // 选牌/按钮：低沉咔擦——短噪声"咔" + 低频正弦"沉" + 弱噪声"擦"尾
        noise(c, master, 1100, 0.025, 0.24);
        tone(c, master, 'sine', 210, 110, 0.08, 0.3);
        noise(c, master, 800, 0.02, 0.1, 0.045);
        break;
      case 'deal':
        noise(c, master, 1300, 0.09, 0.22);
        noise(c, master, 1700, 0.06, 0.12, 0.04);
        break;
      case 'lock':
        tone(c, master, 'sine', 180, 90, 0.16, 0.3);
        noise(c, master, 700, 0.05, 0.1);
        break;
      case 'reveal': {
        // 双音悬念 sting：低→五度（三角波，无高频谐波）
        tone(c, master, 'triangle', 147, 147, 0.28, 0.12);
        tone(c, master, 'triangle', 220, 220, 0.34, 0.14, 0.14);
        noise(c, master, 900, 0.12, 0.08, 0.02);
        break;
      }
      case 'coin':
        tone(c, master, 'sine', 720, 720, 0.09, 0.16);
        tone(c, master, 'sine', 1080, 1080, 0.14, 0.13, 0.05);
        break;
      case 'ticket':
        tone(c, master, 'triangle', 523, 523, 0.12, 0.2);
        tone(c, master, 'triangle', 659, 659, 0.16, 0.18, 0.08);
        tone(c, master, 'triangle', 784, 784, 0.2, 0.14, 0.16);
        break;
      case 'win': {
        // 上行四音琶音（上限 784Hz）
        const seq = [392, 523, 659, 784];
        seq.forEach((f, i) => tone(c, master, 'triangle', f, f, 0.22, 0.14, i * 0.11));
        tone(c, master, 'sine', 196, 196, 0.7, 0.08, 0.1);
        break;
      }
      case 'lose': {
        tone(c, master, 'triangle', 220, 110, 0.55, 0.12);
        tone(c, master, 'sine', 165, 82, 0.7, 0.1, 0.08);
        break;
      }
      case 'error':
        tone(c, master, 'triangle', 170, 150, 0.14, 0.09);
        tone(c, master, 'triangle', 140, 120, 0.14, 0.09, 0.12);
        break;
    }
  } catch {
    /* 音频失败不影响游戏 */
  } finally {
    // master 独立于全局图，播完即弃（GC 回收节点）
    window.setTimeout(() => master.disconnect(), 1500);
  }
}

/* ---------------- BGM：低频铺底 + 缓慢心跳 ---------------- */

let bgmNodes: { oscs: OscillatorNode[]; gain: GainNode; timer: number } | null = null;

function heartbeatThump(c: AudioContext, out: AudioNode, vol: number, strong: boolean): void {
  const t = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(strong ? 58 : 50, t);
  o.frequency.exponentialRampToValueAtTime(36, t + 0.13);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol * (strong ? 0.55 : 0.32), t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.25);
}

/** 开启 BGM（音量 >0 时）；已开启则只更新音量 */
export function startBgm(): void {
  if (bgmVol <= 0) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running' || bgmNodes) return;
  try {
    const gain = c.createGain();
    gain.gain.value = bgmVol;
    gain.connect(c.destination);

    // 暗色铺底：两只失谐锯齿过低通，LFO 缓慢扫滤波频率
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 150;
    lp.Q.value = 0.6;
    lp.connect(gain);
    const lfo = c.createOscillator();
    const lfoGain = c.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 60;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();
    const oscs: OscillatorNode[] = [lfo];
    for (const [f, det] of [
      [55, 0],
      [55, 7],
      [82.5, -5],
    ] as const) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      const og = c.createGain();
      og.gain.value = 0.05;
      o.connect(og).connect(lp);
      o.start();
      oscs.push(o);
    }
    // 心跳：强-弱双拍，每 1.15s 一组
    let beat = 0;
    const timer = window.setInterval(() => {
      try {
        heartbeatThump(c, gain, bgmVol, beat % 2 === 0);
        window.setTimeout(() => {
          try {
            heartbeatThump(c, gain, bgmVol, false);
          } catch {
            /* 忽略 */
          }
        }, 190);
        beat++;
      } catch {
        /* 忽略 */
      }
    }, 1150);
    bgmNodes = { oscs, gain, timer };
  } catch {
    /* 音频失败不影响游戏 */
  }
}

export function stopBgm(): void {
  if (!bgmNodes) return;
  const { oscs, gain, timer } = bgmNodes;
  bgmNodes = null;
  window.clearInterval(timer);
  try {
    gain.gain.setTargetAtTime(0, ctx!.currentTime, 0.15);
    window.setTimeout(() => {
      for (const o of oscs) {
        try {
          o.stop();
        } catch {
          /* 忽略 */
        }
      }
      gain.disconnect();
    }, 500);
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 音量设置（localStorage 持久化） ---------------- */

export function getSfxVol(): number {
  return sfxVol;
}

export function getBgmVol(): number {
  return bgmVol;
}

export function setSfxVol(v: number): void {
  sfxVol = Math.min(1, Math.max(0, v));
  saveVol(SFX_KEY, sfxVol);
}

/** BGM 音量：>0 自动开播，=0 停止 */
export function setBgmVol(v: number): void {
  const nv = Math.min(1, Math.max(0, v));
  const wasOff = bgmVol <= 0;
  bgmVol = nv;
  saveVol(BGM_KEY, bgmVol);
  if (bgmVol <= 0) {
    stopBgm();
  } else if (wasOff || !bgmNodes) {
    startBgm();
  } else if (bgmNodes) {
    bgmNodes.gain.gain.setTargetAtTime(bgmVol, ctx?.currentTime ?? 0, 0.1);
  }
}
