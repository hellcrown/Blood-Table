/**
 * 勿停 · 程序生成的怪物与追兵（three.js；零素材：带骨骼层级的人形全部由胶囊体拼出）
 *
 * Figure：骨盆为根，躯干/头/双臂（肩、肘两节）/双腿（髋、膝两节）各有枢轴，
 * 姿态全部由代码按时间摆出——站立摇晃、冲刺、走动、扒车、爬窗、匍匐。
 * 黑暗里身体只被车灯照亮；眼睛用不受雾影响的自发光材质，远处只剩一对反光的眼睛。
 * Monsters：按服务端下发的夜行者跟踪状态摆放全部个体（游荡/冲刺/回位/扒车/被甩飞）。
 * Shadow：车后的猎影（高大黑影 + 红眼），只在后视镜/回头时可见。
 * Crawler：按调度爬窗的窗爬者，真的扒在车窗外。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRIVE_CLIMB_MS, type DriveSide, type DriveView } from '@shared/driveProtocol';
import { placeAt, type RoadSample } from '../roadPath';
import { glowTexture } from './textures';
import type { MonsterTrack } from '../fx';

export type FigurePose = 'idle' | 'run' | 'walk' | 'latched' | 'climb' | 'crawl';

interface Shared {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  foreArm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  body: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
}

let shared: Shared | null = null;

function assets(): Shared {
  if (!shared) {
    shared = {
      torso: new THREE.CapsuleGeometry(0.17, 0.3, 4, 8),
      head: new THREE.SphereGeometry(0.13, 10, 8),
      eye: new THREE.SphereGeometry(0.026, 6, 6),
      upperArm: new THREE.CapsuleGeometry(0.055, 0.24, 3, 6),
      foreArm: new THREE.CapsuleGeometry(0.045, 0.22, 3, 6),
      thigh: new THREE.CapsuleGeometry(0.08, 0.32, 3, 6),
      shin: new THREE.CapsuleGeometry(0.062, 0.33, 3, 6),
      body: new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.95 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x08080c, roughness: 1 }),
    };
  }
  return shared;
}

export interface FigureOpts {
  scale?: number;
  /** 纯黑剪影（猎影） */
  dark?: boolean;
  eyeColor?: number;
  eyeScale?: number;
  /** 纵向拉伸（细长的猎影） */
  stretchY?: number;
}

const UP_LEN = { arm: 0.35, leg: 0.48 };
const LOW_LEN = { arm: 0.31, leg: 0.45 };
const HIP_Y = 0.94;

/**
 * 眼神光：真实眼球只有几厘米，几十米外不足一个像素——「照不到的地方只剩一对反光的眼睛」靠眼球本身做不到。
 * 每只人形在眼睛位置另挂一对按距离放大的光斑，在屏幕上始终保持固定的几个像素：黑暗里看得见「有东西」，
 * 看不清在哪条道。车灯射程之外没有反光可看，所以 GLINT_FAR_M 外淡出。
 * glintK 把「屏幕像素」换算成「世界尺寸」，随相机视场角与画布高度变化（主画面与后视镜各有一个）。
 */
const GLINT_FAR_M = 130;
const GLINT_FADE_M = 40;
const GLINT_PX = 10;
const glintFigs = new Set<Figure>();
let glintK = 0.01;

/** 换相机渲染前调用（主画面 / 后视镜）：按该相机的视场与画布高度重排全部眼神光的尺寸 */
export function applyGlints(k: number): void {
  glintK = k;
  for (const f of glintFigs) f.applyGlintK(k);
}

/** 由视场角（度）与画布像素高度算出 glintK */
export function glintScaleFactor(fovDeg: number, bufferH: number): number {
  return (2 * Math.tan((fovDeg * Math.PI) / 360) * GLINT_PX) / Math.max(1, bufferH);
}

export class Figure {
  readonly group = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly foreL = new THREE.Group();
  private readonly foreR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly shinL = new THREE.Group();
  private readonly shinR = new THREE.Group();
  readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly glintMat: THREE.SpriteMaterial;
  private readonly glints: THREE.Sprite[] = [];
  /** 到车的距离（米）；0=不亮眼神光（贴在车边时眼球本身已经看得见） */
  private glintDist = 0;

  constructor(opts: FigureOpts = {}) {
    const a = assets();
    const body = opts.dark ? a.dark : a.body;
    const add = (geo: THREE.BufferGeometry, parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Mesh => {
      const m = new THREE.Mesh(geo, body);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const limb = (pivot: THREE.Group, joint: THREE.Group, parent: THREE.Object3D, x: number, y: number, upper: THREE.BufferGeometry, lower: THREE.BufferGeometry, up: number, low: number): void => {
      pivot.position.set(x, y, 0);
      parent.add(pivot);
      add(upper, pivot, 0, -up / 2);
      joint.position.set(0, -up, 0);
      pivot.add(joint);
      add(lower, joint, 0, -low / 2);
    };
    this.pelvis.position.y = HIP_Y;
    this.group.add(this.pelvis);
    add(a.torso, this.pelvis, 0, 0.4);
    this.head.position.set(0, 0.76, 0);
    this.pelvis.add(this.head);
    add(a.head, this.head, 0, 0.13);
    // 眼睛：自发光、不受雾影响（远处只剩这对反光的眼睛）；材质按个体独立以便各自淡出
    this.eyeMat = new THREE.MeshBasicMaterial({ color: opts.eyeColor ?? 0xffe2a0, fog: false, transparent: true });
    const eyeScale = opts.eyeScale ?? 1;
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(a.eye, this.eyeMat);
      eye.position.set(sx * 0.05, 0.15, -0.115);
      eye.scale.setScalar(eyeScale);
      eye.userData.eye = true;
      this.head.add(eye);
    }
    // 眼神光（见 GLINT 说明）：加色混合的软光斑，不被头挡住（贴在脸面稍前）
    this.glintMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: opts.eyeColor ?? 0xffe2a0,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    for (const sx of [-1, 1]) {
      const g = new THREE.Sprite(this.glintMat);
      g.position.set(sx * 0.05, 0.15, -0.125);
      g.visible = false;
      g.renderOrder = 10;
      this.head.add(g);
      this.glints.push(g);
    }
    glintFigs.add(this);
    limb(this.armL, this.foreL, this.pelvis, -0.24, 0.66, a.upperArm, a.foreArm, UP_LEN.arm, LOW_LEN.arm);
    limb(this.armR, this.foreR, this.pelvis, 0.24, 0.66, a.upperArm, a.foreArm, UP_LEN.arm, LOW_LEN.arm);
    limb(this.legL, this.shinL, this.pelvis, -0.105, 0, a.thigh, a.shin, UP_LEN.leg, LOW_LEN.leg);
    limb(this.legR, this.shinR, this.pelvis, 0.105, 0, a.thigh, a.shin, UP_LEN.leg, LOW_LEN.leg);
    const s = opts.scale ?? 0.92;
    this.group.scale.set(s, s * (opts.stretchY ?? 1), s);
  }

  /** 摆姿态（每帧调用；t 为秒）。旋转约定：绕 x 正角把肢体的下端甩向前方（−z） */
  pose(mode: FigurePose, t: number, speed = 0): void {
    const p = this;
    p.pelvis.position.set(0, HIP_Y, 0);
    p.pelvis.rotation.set(0, 0, 0);
    p.head.rotation.set(0, 0, 0);
    for (const j of [p.armL, p.armR, p.foreL, p.foreR, p.legL, p.legR, p.shinL, p.shinR]) j.rotation.set(0, 0, 0);
    switch (mode) {
      case 'idle': {
        const s = Math.sin(t * 1.1);
        p.pelvis.rotation.z = 0.05 * Math.sin(t * 0.7);
        p.pelvis.position.y += 0.012 * s;
        p.armL.rotation.set(0.08 * s, 0, 0.12);
        p.armR.rotation.set(-0.08 * s, 0, -0.12);
        p.foreL.rotation.x = 0.25;
        p.foreR.rotation.x = 0.25;
        p.head.rotation.x = 0.16 + 0.06 * Math.sin(t * 0.9); // 微微低头
        p.head.rotation.z = 0.14 * Math.sin(t * 0.45);
        break;
      }
      case 'run':
      case 'walk': {
        const run = mode === 'run';
        const amp = run ? 0.95 : 0.5;
        const ph = t * (run ? 8 + Math.min(6, speed * 1.5) : 3.4);
        const swing = Math.sin(ph);
        const lift = Math.cos(ph);
        p.legL.rotation.x = amp * swing;
        p.legR.rotation.x = -amp * swing;
        p.shinL.rotation.x = -amp * 0.9 * Math.max(0, lift);
        p.shinR.rotation.x = -amp * 0.9 * Math.max(0, -lift);
        p.armL.rotation.x = -amp * 0.85 * swing;
        p.armR.rotation.x = amp * 0.85 * swing;
        p.foreL.rotation.x = run ? 1.3 : 0.5;
        p.foreR.rotation.x = run ? 1.3 : 0.5;
        p.pelvis.rotation.x = run ? -0.32 : -0.06;
        p.pelvis.position.y += (run ? 0.06 : 0.02) * Math.abs(lift);
        p.head.rotation.x = run ? 0.1 : 0;
        break;
      }
      case 'latched': {
        // 扒在车门外拍打：双臂举过头顶砸向车窗，腿悬空乱蹬
        const reach = Math.sin(t * 9);
        p.armL.rotation.set(2.45 + 0.25 * reach, 0, 0.25);
        p.armR.rotation.set(2.45 - 0.25 * reach, 0, -0.25);
        p.foreL.rotation.x = 0.55;
        p.foreR.rotation.x = 0.55;
        p.legL.rotation.x = 0.22 * Math.sin(t * 5);
        p.legR.rotation.x = -0.22 * Math.sin(t * 5);
        p.shinL.rotation.x = -0.55;
        p.shinR.rotation.x = -0.55;
        p.pelvis.rotation.x = -0.12;
        p.head.rotation.x = 0.22;
        p.head.rotation.z = 0.12 * Math.sin(t * 7);
        break;
      }
      case 'climb': {
        // 往车里爬：身体拔高，双臂交替往窗里探
        const reach = Math.sin(t * 7);
        p.armL.rotation.set(1.55 + 0.35 * reach, 0, 0.3);
        p.armR.rotation.set(1.55 - 0.35 * reach, 0, -0.3);
        p.foreL.rotation.x = 0.5 + 0.3 * reach;
        p.foreR.rotation.x = 0.5 - 0.3 * reach;
        p.legL.rotation.x = 0.45 + 0.2 * reach;
        p.legR.rotation.x = 0.2 - 0.2 * reach;
        p.shinL.rotation.x = -1.0;
        p.shinR.rotation.x = -0.7;
        p.pelvis.rotation.x = -0.2;
        p.head.rotation.x = 0.3;
        break;
      }
      case 'crawl': {
        // 匍匐（尸群用；只用于烘焙静态合并网格）
        p.pelvis.rotation.x = -1.25;
        p.pelvis.position.y = 0.42;
        p.legL.rotation.x = -0.9;
        p.legR.rotation.x = -1.2;
        p.shinL.rotation.x = -1.6;
        p.shinR.rotation.x = -1.4;
        p.armL.rotation.x = 1.5;
        p.armR.rotation.x = 1.2;
        p.foreL.rotation.x = 0.4;
        p.foreR.rotation.x = 0.6;
        p.head.rotation.x = -0.9;
        break;
      }
    }
  }

  /**
   * 眼睛可见度：alpha 为眼球亮度（远处淡出，1=全亮）；dist（米，>0）为到车的距离，眼神光按它缩放；
   * facing=false（背对着车，比如走回原位的）时眼神光不亮；far 为眼神光的淡出起点（默认 GLINT_FAR_M）。
   */
  setEyeAlpha(alpha: number, dist = 0, facing = true, far = GLINT_FAR_M): void {
    this.eyeMat.opacity = Math.min(1, Math.max(0, alpha));
    this.glintDist = dist;
    this.glintMat.opacity = facing ? Math.min(1, Math.max(0, (far - dist) / GLINT_FADE_M)) : 0;
    this.applyGlintK(glintK);
  }

  applyGlintK(k: number): void {
    const on = this.glintDist > 0 && this.glintMat.opacity > 0.01;
    for (const g of this.glints) {
      g.visible = on;
      if (on) g.scale.setScalar(this.glintDist * k);
    }
  }

  dispose(): void {
    glintFigs.delete(this);
    this.eyeMat.dispose();
    this.glintMat.map?.dispose();
    this.glintMat.dispose();
  }
}

/** 把某个姿态下的身体烘成一个合并网格（尸群实例化用：一只尸群带只占一次绘制） */
let crawlGeo: THREE.BufferGeometry | null = null;
export function crawlGeometry(): THREE.BufferGeometry {
  if (crawlGeo) return crawlGeo;
  const fig = new Figure({ scale: 0.8 });
  fig.pose('crawl', 0, 0);
  fig.group.updateMatrixWorld(true);
  const geos: THREE.BufferGeometry[] = [];
  fig.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData.eye) geos.push(m.geometry.clone().applyMatrix4(m.matrixWorld));
  });
  fig.dispose();
  crawlGeo = mergeGeometries(geos, false) ?? new THREE.BufferGeometry();
  for (const g of geos) g.dispose();
  return crawlGeo;
}

/* ---------------- 夜行者（全部个体） ---------------- */

interface Item {
  fig: Figure;
  /** 当前挂在车体（扒车）还是挂在世界 */
  attached: boolean;
  thrownAt: number;
  mode: MonsterTrack['mode'];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export class Monsters {
  private readonly items = new Map<number, Item>();

  constructor(
    private readonly world: THREE.Object3D,
    private readonly car: THREE.Object3D,
  ) {}

  sync(tracks: Iterable<MonsterTrack>, path: readonly RoadSample[], pos: number, lateral: number, now: number): void {
    const seen = new Set<number>();
    const t = now / 1000;
    for (const m of tracks) {
      seen.add(m.id);
      let it = this.items.get(m.id);
      if (!it) {
        it = { fig: new Figure({}), attached: false, thrownAt: now, mode: m.mode };
        this.world.add(it.fig.group);
        this.items.set(m.id, it);
      }
      if (m.mode !== it.mode && m.mode === 'thrown') it.thrownAt = now;
      it.mode = m.mode;
      const fig = it.fig;
      const attached = m.mode === 'latched';
      if (attached !== it.attached) {
        (attached ? this.car : this.world).add(fig.group); // 换父节点（局部变换随后每帧重设）
        it.attached = attached;
      }
      const local = t + m.id * 0.37; // 每只相位错开
      if (attached) {
        const side = m.side === 'R' ? 1 : -1;
        const jitter = 0.015;
        // 挂在车门上、脚离地：头正好落在车窗高度（站着的话头在车顶后面，看不到脸）
        fig.group.position.set(side * 1.38 + Math.sin(t * 31 + m.id) * jitter, -0.42 + Math.abs(Math.sin(t * 23 + m.id)) * jitter, -0.22 + Math.cos(t * 27 + m.id) * jitter);
        fig.group.rotation.set(0, (side * Math.PI) / 2, 0);
        fig.pose(m.climbLeft != null ? 'climb' : 'latched', local, 0);
        fig.setEyeAlpha(1);
        continue;
      }
      const p = placeAt(path, m.at, m.lat);
      const thrown = m.mode === 'thrown';
      const age = thrown ? (now - it.thrownAt) / 1000 : 0;
      fig.group.position.set(p.x, thrown ? -Math.min(0.8, age * 1.5) : 0, -p.y);
      let yaw: number;
      if (!thrown && (m.mode === 'hunt' || m.mode === 'return') && Math.abs(m.vs) + Math.abs(m.vx) > 0.3) {
        yaw = Math.atan2(-m.vx, m.vs); // 面朝运动方向
      } else {
        yaw = Math.PI - p.theta; // 面朝驶来的车
      }
      fig.group.rotation.set(thrown ? Math.min(1.5, age * 5) : 0, yaw, thrown ? Math.sin(age * 9) * 0.6 : 0);
      if (thrown) fig.pose('latched', local, 0); // 被甩飞：四肢张开翻滚
      else if (m.mode === 'hunt') fig.pose('run', local, Math.hypot(m.vs, m.vx));
      else if (m.mode === 'return') fig.pose('walk', local, 0);
      else fig.pose('idle', local, 0);
      // 眼球：200m 内全亮，260m 外淡出；眼神光按到车的距离缩放（回位的背对着车、被甩飞的都不亮）
      const dist = Math.hypot(m.at - pos, m.lat - lateral);
      fig.setEyeAlpha(clamp01((260 - dist) / 60), dist, !thrown && m.mode !== 'return');
    }
    for (const [id, it] of this.items) {
      if (seen.has(id)) continue;
      it.fig.group.parent?.remove(it.fig.group);
      it.fig.dispose();
      this.items.delete(id);
    }
  }

  dispose(): void {
    for (const it of this.items.values()) it.fig.dispose();
    this.items.clear();
  }
}

/* ---------------- 猎影（车后） ---------------- */

export class Shadow {
  readonly group = new THREE.Group();
  private readonly fig: Figure;
  /** 它脚下的红光：把身后的路面映红，后视镜里才看得清这个黑影 */
  readonly glow: THREE.PointLight;

  constructor() {
    this.fig = new Figure({ dark: true, eyeColor: 0xff2020, eyeScale: 2.6, stretchY: 1.18, scale: 1.0 });
    this.group.add(this.fig.group);
    this.glow = new THREE.PointLight(0xff1a1a, 14, 16, 1.6);
    this.glow.position.y = 1.4;
    this.group.add(this.glow);
  }

  /** gap 0-100 → 车后 10m ~ 130m */
  update(path: readonly RoadSample[], pos: number, gap: number, now: number): void {
    const behind = 10 + Math.min(100, Math.max(0, gap)) * 1.2;
    const s = Math.max((path[0]?.s ?? pos - 60) + 3, pos - behind);
    const p = placeAt(path, s, Math.sin(now / 700) * 0.8); // 在路面上左右横跳
    this.group.position.set(p.x, 0, -p.y);
    this.group.rotation.y = Math.PI - p.theta;
    this.fig.pose('run', now / 1000, 6);
    // 红眼是后视镜里唯一看得见的东西：不管多远都是一小团红光（不随距离淡出，越来越近靠身形变大）
    this.fig.setEyeAlpha(1, pos - s, true, Infinity);
    const closeness = 1 - Math.min(100, Math.max(0, gap)) / 100;
    this.glow.intensity = 6 + closeness * 26;
  }

  dispose(): void {
    this.fig.dispose();
  }
}

/* ---------------- 窗爬者（按调度爬开着的窗） ---------------- */

export class Crawler {
  private readonly fig: Figure;
  private shown = false;

  constructor(car: THREE.Object3D) {
    this.fig = new Figure({ scale: 0.92, eyeColor: 0xd8f0ff });
    this.fig.group.visible = false;
    car.add(this.fig.group);
  }

  update(windows: DriveView['windows'], now: number): void {
    let side: DriveSide | null = null;
    let progress = 0;
    for (const s of ['L', 'R'] as DriveSide[]) {
      const w = windows[s];
      if (w.climbLeft != null) {
        side = s;
        progress = 1 - Math.min(DRIVE_CLIMB_MS, Math.max(0, w.climbLeft)) / DRIVE_CLIMB_MS;
        break;
      }
      if (w.warn && !side) {
        side = s;
        progress = 0;
      }
    }
    if (!side) {
      this.fig.group.visible = false;
      this.shown = false;
      return;
    }
    this.fig.group.visible = true;
    this.shown = true;
    const dir = side === 'R' ? 1 : -1;
    // 预警时只露出抓着窗沿的手（在视野下方），爬入计时中逐渐拔高到脸贴着玻璃
    const lift = -0.95 + Math.min(1, progress * 1.15) * 1.15;
    this.fig.group.position.set(dir * 1.3, lift + Math.sin(now / 60) * 0.012, 0.32);
    this.fig.group.rotation.set(0, (dir * Math.PI) / 2, 0);
    this.fig.pose('climb', now / 1000, 0);
    this.fig.setEyeAlpha(1);
  }

  get visible(): boolean {
    return this.shown;
  }

  dispose(): void {
    this.fig.dispose();
  }
}
