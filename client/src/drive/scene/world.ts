/**
 * 勿停 · 道路与两侧环境（three.js）
 *
 * 世界坐标：以「车当前所在里程处的道路切线」为基准，+x 向右、+y 向上、−z 向前；
 * 整个世界挂在 World.group 下，每帧由场景用「车在采样坐标系里的位姿的逆」设置它的矩阵——
 * 所以车永远在原点朝向 −z，是路在车下滑动（包括过弯时的转动），不会有任何跳变。
 *
 * 窗口：车后 96m ~ 车前 400m（雾在 230m 外把一切吞掉，400m 是余量）。
 * 只有锚点（每 4m）变化时才重排几何与实例；帧间只动 group 的矩阵。
 * 路面是一条带路面贴图的条带，车道线/边线画在贴图里沿路滚动；
 * 护栏、反光柱（左红右白，自发光——黑暗里像真反光牌）、松林（实例化、按世界位置确定性散布）
 * 共同构成弯道的遮挡：看不见弯后是物理事实。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRIVE_GUARD_M, DRIVE_SHOULDER_M, ROAD_HALF_M } from '@shared/driveProtocol';
import { PATH_STEP_M, type RoadSample } from '../roadPath';
import { glowTexture, roadTexture } from './textures';

export const WORLD_BACK_M = 96;
export const WORLD_AHEAD_M = 400;

/** 反光柱 / 护栏立柱 / 松树的间距（米）与松林排数 */
const POLE_SLOT = 30;
const POST_SLOT = 8;
const TREE_SLOT = 4.2;
const TREE_ROWS = 3;
/** 路面贴图沿路每 16m 重复一次（与贴图里的虚线周期一致） */
const ROAD_TEX_PERIOD = 16;
/** 路面半宽 / 路肩宽 / 护栏横向位置（米） */
const ROAD_W = ROAD_HALF_M;
const SHOULDER_W = DRIVE_SHOULDER_M;
const GUARD_W = DRIVE_GUARD_M;

/** 确定性伪随机（按世界位置散布树木，窗口滑动时不会重排跳动） */
function hash(a: number, b: number, c: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 多列条带几何：每个采样点落 K 列顶点，faces 指定哪些相邻列之间铺面。
 * 顶点数固定，layout 时只改位置属性（不改索引），避免每 4m 重新分配显存。
 */
class Ribbon {
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos: THREE.BufferAttribute;
  private readonly uv: THREE.BufferAttribute;
  private readonly n: number;
  private readonly cols: number;

  constructor(n: number, cols: number, faces: readonly [number, number][]) {
    this.n = n;
    this.cols = cols;
    const pos = new Float32Array(n * cols * 3);
    const uv = new Float32Array(n * cols * 2);
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      for (const [a, b] of faces) {
        const l0 = i * cols + a;
        const r0 = i * cols + b;
        const l1 = (i + 1) * cols + a;
        const r1 = (i + 1) * cols + b;
        index.push(l0, l1, r0, r0, l1, r1);
      }
    }
    this.pos = new THREE.BufferAttribute(pos, 3);
    this.uv = new THREE.BufferAttribute(uv, 2);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.pos);
    this.geometry.setAttribute('uv', this.uv);
    this.geometry.setIndex(index);
  }

  /** vertex(sample, col) → [x, y, z, u, v]；用 NaN 填满未用到的采样点（退化为不可见的面） */
  fill(path: readonly RoadSample[], vertex: (p: RoadSample, col: number, i: number) => [number, number, number, number, number]): void {
    const arr = this.pos.array as Float32Array;
    const uvs = this.uv.array as Float32Array;
    const count = Math.min(path.length, this.n);
    for (let i = 0; i < this.n; i++) {
      for (let c = 0; c < this.cols; c++) {
        const k = i * this.cols + c;
        const p = path[Math.min(i, count - 1)];
        if (i >= count || !p) {
          arr[k * 3] = NaN;
          arr[k * 3 + 1] = NaN;
          arr[k * 3 + 2] = NaN;
          continue;
        }
        const v = vertex(p, c, i);
        arr[k * 3] = v[0];
        arr[k * 3 + 1] = v[1];
        arr[k * 3 + 2] = v[2];
        uvs[k * 2] = v[3];
        uvs[k * 2 + 1] = v[4];
      }
    }
    this.pos.needsUpdate = true;
    this.uv.needsUpdate = true;
  }
}

function withColor(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** 低多边形松树：树干 + 三层锥形树冠，顶点着色 → 一个网格一次绘制（实例化） */
function treeGeometry(): THREE.BufferGeometry {
  const parts = [
    withColor(new THREE.CylinderGeometry(0.14, 0.24, 2.4, 5).translate(0, 1.2, 0), 0x2a2018),
    withColor(new THREE.ConeGeometry(2.3, 4.2, 7).translate(0, 3.9, 0), 0x14201a),
    withColor(new THREE.ConeGeometry(1.7, 3.6, 7).translate(0, 6.0, 0), 0x17261e),
    withColor(new THREE.ConeGeometry(1.05, 3.0, 7).translate(0, 7.9, 0), 0x1a2b22),
  ];
  const merged = mergeGeometries(parts, false) ?? parts[0]!;
  for (const p of parts) p.dispose();
  return merged;
}

/** 星空与月亮：不受雾影响，挂在场景原点（车永远在原点，所以它永远在无穷远处） */
export class Sky {
  readonly group = new THREE.Group();

  constructor() {
    const count = 900;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // 确定性散布在上半球
      const el = Math.asin(0.03 + hash(i, 1, 0) * 0.97);
      const az = hash(i, 2, 0) * Math.PI * 2;
      const r = 360;
      pos[i * 3] = Math.cos(el) * Math.sin(az) * r;
      pos[i * 3 + 1] = Math.sin(el) * r;
      pos[i * 3 + 2] = -Math.cos(el) * Math.cos(az) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xcdd6ee, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0.6, fog: false, depthWrite: false }),
    );
    stars.frustumCulled = false;
    this.group.add(stars);

    const moon = new THREE.Mesh(new THREE.CircleGeometry(13, 40), new THREE.MeshBasicMaterial({ color: 0xe9eefb, fog: false }));
    moon.position.set(-0.42, 0.46, -0.78).normalize().multiplyScalar(340);
    moon.lookAt(0, 0, 0);
    moon.frustumCulled = false;
    this.group.add(moon);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: 0x9fb4e8, transparent: true, opacity: 0.22, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.position.copy(moon.position);
    halo.scale.setScalar(95);
    this.group.add(halo);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) mat.dispose();
    });
  }
}

export class World {
  readonly group = new THREE.Group();
  private readonly road: THREE.Mesh;
  private readonly roadRibbon: Ribbon;
  private readonly shoulderRibbon: Ribbon;
  private readonly railRibbon: Ribbon;
  private readonly posts: THREE.InstancedMesh;
  private readonly polePosts: THREE.InstancedMesh;
  private readonly reflectors: THREE.InstancedMesh;
  private readonly trees: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly n: number;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor() {
    this.group.matrixAutoUpdate = false; // 矩阵由场景每帧直接写入（世界在车下滑动）
    this.n = Math.ceil((WORLD_BACK_M + WORLD_AHEAD_M) / PATH_STEP_M) + 1;
    const tex = roadTexture();
    this.roadRibbon = new Ribbon(this.n, 2, [[0, 1]]);
    this.road = new THREE.Mesh(
      this.roadRibbon.geometry,
      this.track(new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissive: new THREE.Color(0xb9bab2),
        emissiveIntensity: 0.03, // 车灯照不到时车道线不该自己发光：路面只靠车灯看得见
        roughness: 0.9,
        side: THREE.DoubleSide,
      })),
    );
    this.shoulderRibbon = new Ribbon(this.n, 4, [
      [0, 1],
      [2, 3],
    ]);
    const shoulders = new THREE.Mesh(
      this.shoulderRibbon.geometry,
      this.track(new THREE.MeshStandardMaterial({ color: 0x17150f, roughness: 1, side: THREE.DoubleSide })),
    );
    // 护栏板：左右各一条竖直窄带（下沿 0.55m、上沿 0.82m）
    this.railRibbon = new Ribbon(this.n, 4, [
      [0, 1],
      [2, 3],
    ]);
    const rails = new THREE.Mesh(
      this.railRibbon.geometry,
      this.track(new THREE.MeshStandardMaterial({ color: 0x8a8e98, roughness: 0.5, metalness: 0.25, emissive: new THREE.Color(0x14161c), side: THREE.DoubleSide })),
    );
    for (const m of [this.road, shoulders, rails]) {
      m.frustumCulled = false;
      this.group.add(m);
    }

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(520, 720), this.track(new THREE.MeshStandardMaterial({ color: 0x0a0d09, roughness: 1 })));
    this.geometries.push(ground.geometry);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.04, -(WORLD_AHEAD_M - WORLD_BACK_M) / 2);
    ground.frustumCulled = false;
    this.group.add(ground);

    const span = WORLD_BACK_M + WORLD_AHEAD_M;
    const maxPosts = (Math.ceil(span / POST_SLOT) + 2) * 2;
    const maxPoles = (Math.ceil(span / POLE_SLOT) + 2) * 2;
    this.posts = this.instances(new THREE.BoxGeometry(0.12, 0.78, 0.12), new THREE.MeshStandardMaterial({ color: 0x6a6e78, roughness: 0.6, metalness: 0.3 }), maxPosts);
    this.polePosts = this.instances(new THREE.CylinderGeometry(0.035, 0.045, 1.05, 6), new THREE.MeshStandardMaterial({ color: 0x3a3d46, roughness: 0.7 }), maxPoles);
    this.reflectors = this.instances(new THREE.BoxGeometry(0.09, 0.13, 0.02), new THREE.MeshBasicMaterial({ color: 0xffffff }), maxPoles);
    this.trees = this.instances(treeGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), 640);
  }

  private track<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private instances(geo: THREE.BufferGeometry, mat: THREE.Material, max: number): THREE.InstancedMesh {
    this.geometries.push(geo);
    this.materials.push(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    return mesh;
  }

  /** 锚点变化时重排：条带顶点 + 护栏立柱 / 反光柱 / 松林实例 */
  layout(path: readonly RoadSample[]): void {
    this.roadRibbon.fill(path, (p, c) => {
      const lat = c === 0 ? -ROAD_W : ROAD_W;
      return [p.x + p.nx * lat, 0, -(p.y + p.ny * lat), c, p.s / ROAD_TEX_PERIOD];
    });
    this.shoulderRibbon.fill(path, (p, c) => {
      const lat = [-ROAD_W - SHOULDER_W, -ROAD_W, ROAD_W, ROAD_W + SHOULDER_W][c]!;
      return [p.x + p.nx * lat, 0.004, -(p.y + p.ny * lat), 0, 0];
    });
    this.railRibbon.fill(path, (p, c) => {
      const lat = c < 2 ? -GUARD_W : GUARD_W;
      const y = c % 2 === 0 ? 0.55 : 0.82;
      return [p.x + p.nx * lat, y, -(p.y + p.ny * lat), 0, 0];
    });

    const first = path[0];
    const last = path[path.length - 1];
    if (!first || !last) return;
    const place = (mesh: THREE.InstancedMesh, i: number, s: number, lat: number, y: number, yaw: number, sx = 1, sy = 1, sz = 1): void => {
      const p = path[Math.min(path.length - 1, Math.max(0, Math.round((s - first.s) / PATH_STEP_M)))];
      if (!p) return;
      this.dummy.position.set(p.x + p.nx * lat, y, -(p.y + p.ny * lat));
      this.dummy.rotation.set(0, -p.theta + yaw, 0);
      this.dummy.scale.set(sx, sy, sz);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    };

    // 护栏立柱
    let n = 0;
    for (let s = Math.ceil(first.s / POST_SLOT) * POST_SLOT; s <= last.s; s += POST_SLOT) {
      for (const side of [-1, 1]) {
        if (n >= this.posts.instanceMatrix.count) break;
        place(this.posts, n++, s, side * GUARD_W, 0.39, 0);
      }
    }
    this.finish(this.posts, n);

    // 反光柱：左红右白，反光片朝向驶来的车
    n = 0;
    const red = new THREE.Color(0xff2a2a);
    const white = new THREE.Color(0xf2f4ff);
    for (let s = Math.ceil(first.s / POLE_SLOT) * POLE_SLOT; s <= last.s; s += POLE_SLOT) {
      for (const side of [-1, 1]) {
        if (n >= this.polePosts.instanceMatrix.count) break;
        place(this.polePosts, n, s, side * (ROAD_W + 1.0), 0.52, 0);
        place(this.reflectors, n, s, side * (ROAD_W + 1.0), 0.94, 0);
        this.reflectors.setColorAt(n, side < 0 ? red : white);
        n++;
      }
    }
    this.finish(this.polePosts, n);
    this.finish(this.reflectors, n);
    if (this.reflectors.instanceColor) this.reflectors.instanceColor.needsUpdate = true;

    // 松林：紧贴路肩的一排最密（弯道内侧真正挡住视线），越往外越稀
    n = 0;
    const maxTrees = this.trees.instanceMatrix.count;
    for (let k = Math.ceil((first.s - 6) / TREE_SLOT); k * TREE_SLOT <= last.s && n < maxTrees; k++) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < TREE_ROWS && n < maxTrees; row++) {
          const h1 = hash(k, row, side + 2);
          const h2 = hash(k, row + 7, side + 5);
          if (row > 0 && h2 < 0.3) continue;
          const s = k * TREE_SLOT + (h2 - 0.5) * 3;
          const lat = side * (ROAD_W + 6 + row * 8 + h1 * 6);
          const sc = 0.8 + hash(k, row + 13, side) * 0.7;
          place(this.trees, n++, s, lat, 0, h1 * 6.28, sc, sc * (0.9 + h2 * 0.4), sc);
        }
      }
    }
    this.finish(this.trees, n);
  }

  private finish(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) {
      const map = (m as THREE.MeshStandardMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
    this.roadRibbon.geometry.dispose();
    this.shoulderRibbon.geometry.dispose();
    this.railRibbon.geometry.dispose();
  }
}
