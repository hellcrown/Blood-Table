/**
 * 勿停 · 驾驶舱（three.js，零素材：全部由盒体/圆环拼出）
 *
 * 车体坐标系：+x 向右、+y 向上、−z 向前。中国是右舵——驾驶员坐右侧，副驾驶坐左侧。
 * - 仪表台 + 仪表盘（canvas 画好当贴图贴在台上，自发光不受车灯影响）
 * - 方向盘（圆环 + 辐条 + 轮毂，随手上的转向转动）
 * - A 柱、车顶、门框、B/C 柱、后窗框：转头看两侧和后方时看到的是有框的车窗
 * - 后视镜是实时画面：车尾朝后的第二个相机渲染到一张低分辨率贴图上，贴在镜面位置
 *   （水平翻转才是镜像；车厢在后视这一遍里隐藏，否则相机被仪表台挡住）
 */
import * as THREE from 'three';
import { paintCluster, type ClusterData } from '../cluster';

export type Seat = 'driver' | 'navigator';

/** 两只眼睛的位置（车体坐标） */
const SEAT: Record<Seat, [number, number, number]> = {
  driver: [0.37, 1.2, 0.1],
  navigator: [-0.37, 1.2, 0.1],
};
/** 默认视线略向下（rad）：平视时仪表台占掉近四成画面，路面被挤成一条窄带 */
const BASE_PITCH = -0.07;

/** 两点之间拉一根方条（车架用） */
function bar(a: [number, number, number], b: [number, number, number], thick: number, mat: THREE.Material): THREE.Mesh {
  const va = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(va);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thick, len + thick, thick), mat);
  mesh.position.copy(va).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

export class Cockpit {
  readonly group = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly rearCamera: THREE.PerspectiveCamera;
  readonly mirrorTarget: THREE.WebGLRenderTarget;
  private readonly wheelRim = new THREE.Group();
  private readonly clusterCanvas: HTMLCanvasElement;
  private readonly clusterTex: THREE.CanvasTexture;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  constructor() {
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.08, 420);
    this.camera.rotation.order = 'YXZ'; // 先偏航后俯仰：环顾时视线不会歪
    this.camera.position.set(...SEAT.driver);
    this.group.add(this.camera);

    const trim = this.mat(new THREE.MeshStandardMaterial({ color: 0x2a2b31, roughness: 0.82, metalness: 0.04 }));
    const top = this.mat(new THREE.MeshStandardMaterial({ color: 0x31323a, roughness: 0.7, metalness: 0.06 }));
    const leather = this.mat(new THREE.MeshStandardMaterial({ color: 0x2e2422, roughness: 0.85 }));
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh => {
      const geo = new THREE.BoxGeometry(w, h, d);
      this.geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };

    /* 仪表台与仪表盘 */
    box(2.1, 0.3, 0.5, 0, 0.79, -0.6, trim);
    box(2.1, 0.04, 0.26, 0, 0.955, -0.95, top);
    box(0.24, 0.14, 0.42, 0, 0.99, -0.56, top); // 中控台
    this.clusterCanvas = document.createElement('canvas');
    this.clusterCanvas.width = 512;
    this.clusterCanvas.height = 224;
    this.clusterTex = new THREE.CanvasTexture(this.clusterCanvas);
    this.clusterTex.colorSpace = THREE.SRGBColorSpace;
    const clusterGeo = new THREE.PlaneGeometry(0.52, 0.227);
    this.geos.push(clusterGeo);
    const clusterMat = this.mat(new THREE.MeshBasicMaterial({ map: this.clusterTex, toneMapped: false }));
    const cluster = new THREE.Mesh(clusterGeo, clusterMat);
    cluster.position.set(0.37, 0.965, -0.8);
    cluster.rotation.x = -1.05; // 面朝驾驶员斜向上
    this.group.add(cluster);

    /* 方向盘 */
    const wheelBase = new THREE.Group();
    wheelBase.position.set(0.37, 0.93, -0.42);
    wheelBase.rotation.x = -0.55; // 上沿向挡风玻璃倾斜
    this.group.add(wheelBase);
    wheelBase.add(this.wheelRim);
    const rimGeo = new THREE.TorusGeometry(0.185, 0.022, 10, 40);
    const spokeGeo = new THREE.BoxGeometry(0.33, 0.03, 0.02);
    const spokeLowGeo = new THREE.BoxGeometry(0.03, 0.17, 0.02);
    const hubGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12);
    const spokeMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x2b2c33, roughness: 0.5, metalness: 0.4 }));
    this.geos.push(rimGeo, spokeGeo, spokeLowGeo, hubGeo);
    this.wheelRim.add(new THREE.Mesh(rimGeo, leather));
    this.wheelRim.add(new THREE.Mesh(spokeGeo, spokeMat));
    for (const sx of [-1, 1]) {
      const spoke = new THREE.Mesh(spokeLowGeo, spokeMat);
      spoke.position.set(sx * 0.065, -0.08, 0);
      spoke.rotation.z = -sx * 0.5;
      this.wheelRim.add(spoke);
    }
    const hub = new THREE.Mesh(hubGeo, spokeMat);
    hub.rotation.x = Math.PI / 2;
    this.wheelRim.add(hub);

    /* 车窗框架 */
    this.group.add(bar([-1.02, 0.97, -1.0], [-0.84, 1.47, -0.5], 0.075, trim)); // A 柱
    this.group.add(bar([1.02, 0.97, -1.0], [0.84, 1.47, -0.5], 0.075, trim));
    this.group.add(bar([-0.84, 1.47, -0.5], [0.84, 1.47, -0.5], 0.08, trim)); // 前顶梁
    box(1.7, 0.04, 2.0, 0, 1.51, 0.55, trim); // 车顶
    for (const sx of [-1, 1]) {
      this.group.add(bar([sx * 1.04, 1.0, -0.95], [sx * 1.04, 1.0, 1.45], 0.06, trim)); // 窗沿
      box(0.05, 0.42, 2.4, sx * 1.06, 0.79, 0.25, trim); // 门板
      this.group.add(bar([sx * 1.03, 1.0, 0.62], [sx * 0.94, 1.49, 0.62], 0.09, trim)); // B 柱
      this.group.add(bar([sx * 1.03, 1.0, 1.5], [sx * 0.88, 1.49, 1.58], 0.12, trim)); // C 柱
    }
    this.group.add(bar([-0.88, 1.49, 1.58], [0.88, 1.49, 1.58], 0.1, trim)); // 后顶梁
    box(1.9, 0.06, 0.5, 0, 1.0, 1.5, top); // 后窗台
    box(1.8, 0.45, 0.2, 0, 0.78, 1.42, trim); // 后排椅背

    /* 后视镜：实时画面 */
    this.rearCamera = new THREE.PerspectiveCamera(34, 3, 0.3, 320);
    this.rearCamera.position.set(0, 1.3, 0.6);
    this.rearCamera.rotation.y = Math.PI; // 朝后看
    this.group.add(this.rearCamera);
    this.mirrorTarget = new THREE.WebGLRenderTarget(384, 128);
    box(0.34, 0.12, 0.03, 0, 1.36, -0.44, trim);
    this.group.add(bar([0, 1.47, -0.5], [0, 1.42, -0.44], 0.022, trim));
    const mirrorGeo = new THREE.PlaneGeometry(0.32, 0.096);
    this.geos.push(mirrorGeo);
    const mirror = new THREE.Mesh(mirrorGeo, this.mat(new THREE.MeshBasicMaterial({ map: this.mirrorTarget.texture })));
    mirror.position.set(0, 1.36, -0.424); // 镜面朝驾驶员
    mirror.scale.x = -1; // 水平翻转才是镜像
    this.group.add(mirror);

    /* 车内微光：让仪表台和方向盘在黑暗里看得见（后视那一遍随车厢一起隐藏） */
    const interior = new THREE.PointLight(0xd8dcc8, 2.6, 3.6, 2);
    interior.position.set(0, 1.5, 0.15);
    this.group.add(interior);
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  /** 环顾：yaw/pitch 为视线偏角（rad，正 yaw=向右、正 pitch=向上）；其余为撞击/颠簸带来的镜头抖动 */
  setLook(seat: Seat, yaw: number, pitch: number, shakeX: number, shakeY: number, roll: number): void {
    const base = SEAT[seat];
    this.camera.position.set(base[0] + shakeX, base[1] + shakeY, base[2]);
    this.camera.rotation.set(pitch + BASE_PITCH, -yaw, roll);
  }

  /** 方向盘偏转 −1..1（正=右打） */
  setWheel(t: number): void {
    this.wheelRim.rotation.z = -t * 1.9;
  }

  /** 重画仪表盘（10Hz 足够） */
  updateCluster(data: ClusterData): void {
    const ctx = this.clusterCanvas.getContext('2d');
    if (!ctx) return;
    paintCluster(ctx, this.clusterCanvas.width, this.clusterCanvas.height, data);
    this.clusterTex.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.clusterTex.dispose();
    this.mirrorTarget.dispose();
  }
}
