/**
 * 勿停 · 3D 场景总装（three.js / WebGL）
 *
 * 职责：把服务端的车辆状态（经 DriveFx 预测平滑后）变成一帧画面。
 * - 渲染器/场景/雾；世界（道路+环境+物件+怪物+猎影）与车（驾驶舱+车灯）两个坐标系；
 * - 每帧：按需重排世界（锚点每 4m 变一次）→ 用「车在道路上的位姿的逆」设置世界矩阵
 *   （车永远在原点朝 −z，是路在车下滑动与转动）→ 摆车、开关车灯、环顾与震动、
 *   更新物件/怪物/猎影/窗爬者 → 10Hz 重画仪表盘；
 * - 渲染：后视镜（朝后的相机 → 低分辨率贴图，隔帧一次，那一遍隐藏车厢）+ 主画面。
 *
 * 这个类需要真实的 WebGL，无法在 node 里单测；纯逻辑都抽在 roadPath/fx/map/cluster 里，
 * 组件测试用桩替换本模块。WebGL 不可用时构造函数会抛错，由页面给出提示。
 */
import * as THREE from 'three';
import type { DriveView } from '@shared/driveProtocol';
import type { ClusterData } from '../cluster';
import type { DriveFx } from '../fx';
import { PATH_STEP_M, buildRoadPath, placeAt, sampleAt, type RoadSample } from '../roadPath';
import { Cockpit, type Seat } from './cockpit';
import { Crawler, Monsters, Shadow } from './figures';
import { Props } from './props';
import { Sky, World, WORLD_AHEAD_M, WORLD_BACK_M } from './world';

/** 镜头竖直视场角（度）——与驾驶舱相机一致 */
const FOV = 60;
/** 车灯强度：衰减为线性（decay 1），近处不能过曝到吞掉车道线 */
const HEADLIGHT = 120;
const HEADLIGHT_FILL = 5;

export class DriveScene3D {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  /** 车体坐标系：+x 右、+y 上、−z 前；车永远在原点 */
  private readonly car = new THREE.Group();
  private readonly world = new World();
  private readonly sky = new Sky();
  private readonly props = new Props();
  private readonly monsters: Monsters;
  private readonly shadow = new Shadow();
  private readonly crawler: Crawler;
  private readonly cockpit = new Cockpit();
  private readonly headL: THREE.SpotLight;
  private readonly headR: THREE.SpotLight;
  private readonly fill: THREE.SpotLight;
  private readonly hemi: THREE.HemisphereLight;
  /** 左右车窗外的红色警示灯：夜行者扒着 / 窗爬者在爬的那一侧亮，把贴在玻璃上的脸照出来 */
  private readonly warnL: THREE.PointLight;
  private readonly warnR: THREE.PointLight;
  /** 车在采样坐标系里的位姿（用于求世界矩阵的逆） */
  private readonly frame = new THREE.Object3D();
  private readonly tmp = new THREE.Vector3();
  private path: RoadSample[] = [];
  private anchor = NaN;
  private frameNo = 0;
  private lastClusterAt = 0;
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    const night = new THREE.Color(0x05060c);
    this.scene.background = night;
    // 指数雾：约 230m 外一切没入黑暗（车灯照不到、也看不见弯后的东西）
    this.scene.fog = new THREE.FogExp2(night, 0.0105);

    this.scene.add(this.sky.group);
    this.scene.add(this.world.group);
    this.scene.add(this.car);
    this.car.add(this.cockpit.group);
    this.world.group.add(this.props.group);
    this.world.group.add(this.shadow.group);
    this.monsters = new Monsters(this.world.group, this.car);
    this.crawler = new Crawler(this.car);

    /* 灯：极暗的天光（只剩轮廓）+ 两个真实的聚光车灯 + 近处补光 */
    this.hemi = new THREE.HemisphereLight(0x27314f, 0x05060a, 0.42);
    this.scene.add(this.hemi);
    const head = (x: number, aimX: number): THREE.SpotLight => {
      const l = new THREE.SpotLight(0xfff1d2, HEADLIGHT, 230, 0.42, 0.6, 1.0);
      l.position.set(x, 0.82, -2.0);
      l.target.position.set(aimX, 0, -50);
      this.car.add(l);
      this.car.add(l.target);
      return l;
    };
    this.headL = head(-0.68, -1.6);
    this.headR = head(0.68, 1.6);
    this.fill = new THREE.SpotLight(0xffe8c0, HEADLIGHT_FILL, 34, 1.0, 0.9, 1.0);
    this.fill.position.set(0, 1.0, -1.6);
    this.fill.target.position.set(0, 0, -9);
    this.car.add(this.fill);
    this.car.add(this.fill.target);
    const warn = (x: number): THREE.PointLight => {
      const l = new THREE.PointLight(0xff2418, 0, 6.5, 1.5);
      l.position.set(x, 1.35, 0.05);
      this.car.add(l);
      return l;
    };
    this.warnL = warn(-2.1);
    this.warnR = warn(2.1);
    // 本机开发时的诊断入口（量真实帧耗时用）：只在 localhost 生效，线上不暴露
    if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      (window as unknown as { __drv?: DriveScene3D }).__drv = this;
    }
  }

  /**
   * 诊断：连渲若干帧，每帧等 GPU 真正画完再计时，返回平均每帧毫秒（含后视镜那一遍）。
   * 页面上的帧率读数只反映浏览器给了多少帧，这个才反映「画一帧到底多贵」。
   */
  bench(frames = 60): number {
    const gl = this.renderer.getContext() as WebGLRenderingContext;
    this.render(); // 预热：着色器编译、缓冲上传不摊进测量
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      this.render();
      gl.finish();
    }
    return (performance.now() - t0) / frames;
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(this.width, this.height, false);
    this.cockpit.camera.aspect = this.width / this.height;
    this.cockpit.camera.fov = FOV;
    this.cockpit.camera.updateProjectionMatrix();
  }

  /** 每帧把最新状态灌进场景（在 render 之前调用） */
  update(view: DriveView, fx: DriveFx, seat: Seat, yaw: number, pitch: number, now: number): void {
    const pos = fx.pos;
    // 世界重排：只在锚点（每 4m）变化时做
    const anchor = Math.floor(pos / PATH_STEP_M) * PATH_STEP_M;
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      this.path = buildRoadPath(view.curves, anchor, WORLD_BACK_M, WORLD_AHEAD_M);
      this.world.layout(this.path);
    }
    // 车在道路上的位姿 → 世界矩阵取它的逆：车固定在原点朝 −z，路在车下滑动与转动
    const pose = sampleAt(this.path, pos);
    this.frame.position.set(pose.x, 0, -pose.y);
    this.frame.rotation.set(0, -pose.theta, 0);
    this.frame.updateMatrix();
    this.world.group.matrix.copy(this.frame.matrix).invert();
    this.world.group.matrixWorldNeedsUpdate = true;

    // 车自身的横向位置与车头角
    this.car.position.set(fx.lateral, 0, 0);
    this.car.rotation.set(0, -fx.rel, 0);

    // 车灯：关灯后只剩一点天光，几乎什么都看不见
    const lamp = view.lamp;
    this.headL.visible = lamp;
    this.headR.visible = lamp;
    this.fill.visible = lamp;
    this.hemi.intensity = lamp ? 0.42 : 0.16;

    // 环顾 + 震动（撞击/路肩/被扒车）
    const s = fx.shake;
    this.cockpit.setLook(
      seat,
      yaw,
      pitch,
      Math.sin(now / 17) * 0.012 * s,
      Math.cos(now / 23) * 0.009 * s,
      Math.sin(now / 19) * 0.012 * s,
    );
    this.cockpit.setWheel(fx.wheel);

    // 哪一侧有东西扒着/在爬：那一侧窗外亮起急促闪烁的红灯（副驾驶据此知道该关哪边的窗）
    const pulse = 26 + 14 * Math.sin(now / 70);
    this.warnL.intensity = Math.max(fx.maulL, Math.min(1, fx.crawlL * 1.4)) * pulse;
    this.warnR.intensity = Math.max(fx.maulR, Math.min(1, fx.crawlR * 1.4)) * pulse;

    this.props.sync(view, this.path, pos, now);
    this.monsters.sync(fx.monsters.values(), this.path, pos, fx.lateral, now);
    this.shadow.update(this.path, pos, fx.gap, now);
    this.crawler.update(view.windows, now);

    // 仪表盘 10Hz 重绘
    if (now - this.lastClusterAt >= 100) {
      this.lastClusterAt = now;
      const data: ClusterData = {
        speed: fx.speedSmooth,
        fuel: view.fuel,
        durability: view.durability,
        maxDurability: view.maxDurability,
        lamp: view.lamp,
        windows: view.windows,
        offRoad: view.offRoad,
        lateral: fx.lateral,
        drivers: view.drivers,
        hunting: fx.hunting,
        latched: fx.latched,
        gap: fx.gap,
        noDriver: !view.solo && view.drivers === 0,
        now,
      };
      this.cockpit.updateCluster(data);
    }
  }

  render(): void {
    this.frameNo++;
    if (this.frameNo % 2 === 0) {
      // 后视镜：朝后的相机看一遍（车厢隐藏，否则被仪表台挡住），隔帧一次
      this.cockpit.group.visible = false;
      this.renderer.setRenderTarget(this.cockpit.mirrorTarget);
      this.renderer.render(this.scene, this.cockpit.rearCamera);
      this.renderer.setRenderTarget(null);
      this.cockpit.group.visible = true;
    }
    this.renderer.render(this.scene, this.cockpit.camera);
  }

  /**
   * 把道路坐标（里程 + 横向 + 高度）投影到屏幕归一化坐标（x、y ∈ −1..1，原点在画面中心）。
   * 页面用它摆放 HUD 标记（副驾驶放的旗标）。inFront=false 表示在镜头背后或视野外。
   */
  project(at: number, lat: number, height = 1.6): { x: number; y: number; inFront: boolean } {
    if (this.path.length === 0) return { x: 0, y: 0, inFront: false };
    const p = placeAt(this.path, at, lat);
    this.tmp.set(p.x, height, -p.y).applyMatrix4(this.world.group.matrix);
    this.cockpit.camera.updateMatrixWorld();
    this.tmp.project(this.cockpit.camera);
    const inFront = this.tmp.z > -1 && this.tmp.z < 1;
    return { x: this.tmp.x, y: this.tmp.y, inFront };
  }

  dispose(): void {
    this.monsters.dispose();
    this.shadow.dispose();
    this.crawler.dispose();
    this.props.dispose();
    this.world.dispose();
    this.sky.dispose();
    this.cockpit.dispose();
    this.renderer.dispose();
  }
}
