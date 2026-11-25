/**
 * 勿停 · 仪表盘（canvas 2D → 贴图贴在 3D 仪表台上；纯绘制，node 可单测）
 *
 * 左：速度表（表针带惯量，取平滑车速）；中：车道位置（偏离车道一眼可见）+ 状态行
 *（无人驾驶 / 被扒车 / 被合围 / 尾距）；右：油量、耐久、双车窗、大灯。
 * 驾驶员没有导航地图，这块表盘就是他关于「车本身」的全部信息。
 */
import { LANE_W_M, ROAD_HALF_M, type DriveSide, type DriveView } from '@shared/driveProtocol';

export interface ClusterData {
  /** 平滑车速（表针用，km/h） */
  speed: number;
  fuel: number;
  durability: number;
  maxDurability: number;
  lamp: boolean;
  windows: DriveView['windows'];
  offRoad: boolean;
  /** 横向位置（米，正=路中心右侧） */
  lateral: number;
  drivers: number;
  hunting: number;
  latched: number;
  gap: number;
  /** 没人在开车（单人局恒为 false） */
  noDriver: boolean;
  now: number;
}

const C = {
  bg: '#0b0c10',
  bezel: '#1c1d24',
  tick: '#3d414d',
  tickLabel: '#8b8f9c',
  needle: '#f2f4ff',
  text: '#d6d9e2',
  dim: '#7c8090',
  red: '#e03131',
  redDim: '#5a1d1d',
  amber: '#e0a031',
  green: '#58a55c',
  blue: '#4f8fc4',
  fuel: '#d9a13c',
};

const BLINK = (now: number, ms: number): boolean => now % ms < ms / 2;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** 车道名：左 / 中 / 右（按车道中心判定）；不在路面上返回 null */
export function laneName(lateral: number): 'L' | 'M' | 'R' | null {
  if (Math.abs(lateral) > ROAD_HALF_M) return null;
  return lateral < -LANE_W_M / 2 ? 'L' : lateral > LANE_W_M / 2 ? 'R' : 'M';
}

/** 速度 → 表针角度（度，0 朝上，负=左） */
export function needleDeg(speed: number): number {
  return (Math.min(120, Math.max(0, speed)) / 120) * 240 - 120;
}

/** 表盘角度（度，0 朝上、顺时针为正）→ canvas 弧度角（canvas 的 0 在 +x、顺时针为正） */
function arcOf(deg: number): number {
  return -Math.PI / 2 + (deg * Math.PI) / 180;
}

export function paintCluster(ctx: CanvasRenderingContext2D, w: number, h: number, d: ClusterData): void {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = C.bezel;
  ctx.lineWidth = 2;
  roundRect(ctx, 3, 3, w - 6, h - 6, 14);
  ctx.stroke();

  /* ---------------- 左：速度表 ---------------- */
  const gx = w * 0.205;
  const gy = h * 0.62;
  const gr = Math.min(w * 0.155, h * 0.46);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = C.tick;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(gx, gy, gr, arcOf(needleDeg(0)), arcOf(needleDeg(120)));
  ctx.stroke();
  // 勿停线 30km/h：红色刻度段
  ctx.strokeStyle = C.red;
  ctx.beginPath();
  ctx.arc(gx, gy, gr, arcOf(needleDeg(0)), arcOf(needleDeg(30)));
  ctx.stroke();
  ctx.strokeStyle = C.tick;
  ctx.lineWidth = 2;
  ctx.fillStyle = C.tickLabel;
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= 120; v += 20) {
    const a = arcOf(needleDeg(v));
    const x0 = gx + Math.cos(a) * (gr - 8);
    const y0 = gy + Math.sin(a) * (gr - 8);
    const x1 = gx + Math.cos(a) * (gr + 4);
    const y1 = gy + Math.sin(a) * (gr + 4);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const xl = gx + Math.cos(a) * (gr - 22);
    const yl = gy + Math.sin(a) * (gr - 22);
    ctx.fillText(`${v}`, xl, yl);
  }
  const na = arcOf(needleDeg(d.speed));
  ctx.strokeStyle = C.needle;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(gx - Math.cos(na) * 10, gy - Math.sin(na) * 10);
  ctx.lineTo(gx + Math.cos(na) * (gr - 16), gy + Math.sin(na) * (gr - 16));
  ctx.stroke();
  ctx.fillStyle = C.bezel;
  ctx.beginPath();
  ctx.arc(gx, gy, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = d.speed < 30 ? C.red : C.text;
  ctx.font = '700 38px system-ui';
  ctx.fillText(`${Math.round(d.speed)}`, gx, gy + gr * 0.52);
  ctx.fillStyle = C.dim;
  ctx.font = '12px system-ui';
  ctx.fillText('km/h', gx, gy + gr * 0.52 + 24);

  /* ---------------- 中：车道位置 + 状态 ---------------- */
  const cx = w * 0.5;
  const lanes: { key: 'L' | 'M' | 'R'; label: string; off: number }[] = [
    { key: 'L', label: '左', off: -1 },
    { key: 'M', label: '中', off: 0 },
    { key: 'R', label: '右', off: 1 },
  ];
  const active = laneName(d.lateral);
  const laneW = 26;
  const laneH = 54;
  for (const ln of lanes) {
    const x = cx + ln.off * (laneW + 6) - laneW / 2;
    ctx.fillStyle = active === ln.key ? C.blue : '#171820';
    roundRect(ctx, x, 26, laneW, laneH, 5);
    ctx.fill();
    ctx.fillStyle = active === ln.key ? '#0b0c10' : C.dim;
    ctx.font = '700 15px system-ui';
    ctx.fillText(ln.label, x + laneW / 2, 26 + laneH / 2);
  }
  ctx.font = '12px system-ui';
  if (d.offRoad) {
    ctx.fillStyle = BLINK(d.now, 400) ? C.red : C.redDim;
    ctx.fillText('路肩！开回路面', cx, 100);
  } else {
    ctx.fillStyle = C.dim;
    ctx.fillText('车道位置', cx, 100);
  }
  // 状态行：取最严重的一条
  let status: string;
  let color: string;
  if (d.noDriver) {
    status = '无人驾驶！';
    color = BLINK(d.now, 400) ? C.red : C.redDim;
  } else if (d.latched > 0) {
    status = `被扒车 ×${d.latched}！开起来！`;
    color = BLINK(d.now, 300) ? C.red : C.redDim;
  } else if (d.hunting > 0) {
    status = `它们冲过来了 ×${d.hunting}`;
    color = C.amber;
  } else {
    status = '';
    color = C.text;
  }
  if (status) {
    ctx.fillStyle = color;
    ctx.font = '700 17px system-ui';
    ctx.fillText(status, cx, 126);
  }
  // 尾距条
  const barW = 92;
  const bx = cx - barW / 2;
  const by = 150;
  ctx.fillStyle = '#171820';
  roundRect(ctx, bx, by, barW, 10, 5);
  ctx.fill();
  const gapRatio = Math.min(1, Math.max(0, d.gap / 100));
  ctx.fillStyle = d.gap < 25 ? C.red : d.gap < 50 ? C.amber : C.green;
  if (gapRatio > 0.02) {
    roundRect(ctx, bx, by, Math.max(10, barW * gapRatio), 10, 5);
    ctx.fill();
  }
  ctx.fillStyle = d.gap < 25 ? C.red : C.dim;
  ctx.font = '12px system-ui';
  ctx.fillText(`尾距 ${Math.round(d.gap)}%`, cx, by + 28);

  /* ---------------- 右：油量 / 耐久 / 车窗 / 大灯 ---------------- */
  const rx = w * 0.665;
  const rw = w * 0.315;
  // 油量
  const fuelRatio = Math.min(1, Math.max(0, d.fuel / 100));
  ctx.fillStyle = '#171820';
  roundRect(ctx, rx, 28, rw, 14, 6);
  ctx.fill();
  const lowFuel = d.fuel < 20;
  ctx.fillStyle = lowFuel ? (BLINK(d.now, 600) ? C.red : C.redDim) : C.fuel;
  if (fuelRatio > 0.02) {
    roundRect(ctx, rx, 28, Math.max(12, rw * fuelRatio), 14, 6);
    ctx.fill();
  }
  ctx.fillStyle = lowFuel ? C.red : C.dim;
  ctx.font = '13px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(lowFuel ? `油量 ${Math.round(d.fuel)}% 快没了` : `油量 ${Math.round(d.fuel)}%`, rx, 58);
  // 耐久
  const pip = 26;
  for (let i = 0; i < d.maxDurability; i++) {
    ctx.fillStyle = i < d.durability ? C.green : C.redDim;
    roundRect(ctx, rx + i * (pip + 5), 74, pip, 12, 3);
    ctx.fill();
  }
  ctx.fillStyle = d.durability <= 1 ? C.red : C.dim;
  ctx.fillText(`耐久 ${Math.max(0, d.durability)}/${d.maxDurability}`, rx, 104);
  // 双车窗
  for (const side of ['L', 'R'] as DriveSide[]) {
    const win = d.windows[side];
    const x = rx + (side === 'L' ? 0 : 78);
    let col = '#171820';
    let text = C.dim;
    if (win.climbLeft != null) {
      col = BLINK(d.now, 250) ? C.red : C.redDim;
      text = '#fff';
    } else if (win.warn) {
      col = C.amber;
      text = '#1a1200';
    } else if (win.open) {
      col = '#23303d';
      text = C.blue;
    }
    ctx.fillStyle = col;
    roundRect(ctx, x, 120, 70, 24, 5);
    ctx.fill();
    ctx.fillStyle = text;
    ctx.font = '700 13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(side === 'L' ? '左窗' : '右窗', x + 35, 132);
  }
  // 大灯
  ctx.textAlign = 'left';
  ctx.fillStyle = d.lamp ? '#e8c26a' : '#3a3b42';
  ctx.beginPath();
  ctx.arc(rx + 7, 166, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = d.lamp ? C.text : C.dim;
  ctx.font = '13px system-ui';
  ctx.fillText(d.lamp ? '大灯 开' : '大灯 关', rx + 19, 171);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
