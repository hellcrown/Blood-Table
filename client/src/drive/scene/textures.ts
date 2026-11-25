/**
 * 勿停 · 程序生成的贴图（零素材：沥青路面/路障条纹/光晕/标牌文字全部用 canvas 画出来）
 */
import * as THREE from 'three';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

/**
 * 路面贴图：u 横跨整条路（三车道 10.5m），v 沿路每 16m 重复一次（6m 虚线 + 10m 间隔）。
 * 两侧实线边线、两条虚线车道线；底色是很暗的沥青加噪点。
 */
export function roadTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const [canvas, ctx] = makeCanvas(w, h);
  if (ctx) {
    ctx.fillStyle = '#24252a';
    ctx.fillRect(0, 0, w, h);
    // 沥青噪点（确定性伪随机，不闪）
    for (let i = 0; i < 2600; i++) {
      const x = ((i * 97) % 251) / 251 * w;
      const y = ((i * 193) % 509) / 509 * h;
      const v = 26 + ((i * 37) % 23);
      ctx.fillStyle = `rgb(${v}, ${v + 1}, ${v + 5})`;
      ctx.fillRect(x, y, 2, 2);
    }
    // 边线（贴图左右各 3px）
    ctx.fillStyle = '#b4b5ad';
    ctx.fillRect(5, 0, 3, h);
    ctx.fillRect(w - 8, 0, 3, h);
    // 车道虚线：位置 1/3、2/3，只在 v 的前 6/16 段
    ctx.fillStyle = '#c0c1b9';
    ctx.fillRect(Math.round(w / 3) - 1, 0, 3, Math.round((6 / 16) * h));
    ctx.fillRect(Math.round((2 * w) / 3) - 1, 0, 3, Math.round((6 / 16) * h));
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 路障条纹：红白相间（沿宽度方向重复） */
export function stripeTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 32);
  if (ctx) {
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#e8e4da' : '#c23b3b';
      ctx.fillRect(i * 16, 0, 16, 32);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** 径向光晕（搜掠点/月亮/车灯晕用），加色混合 */
export function glowTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(64, 64);
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 31);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 标牌：纯色底 + 居中文字（路牌 / 加油站灯箱） */
export function labelTexture(text: string, bg: string, fg: string, w = 256, h = 128, font = '700 64px system-ui'): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(w, h);
  if (ctx) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 6;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = fg;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
