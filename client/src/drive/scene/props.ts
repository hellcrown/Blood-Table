/**
 * 勿停 · 路面物件（three.js）：路障 / 尸群带 / 搜掠点 / 加油站 / 路牌
 *
 * 物件挂在 World.group 下、用道路坐标（里程 + 横向）摆放，所以世界在车下滑动时它们跟着走。
 * 视图每帧都是新对象，物件按「种类:里程:位置」这种稳定键复用，事件驶出视野才销毁。
 */
import * as THREE from 'three';
import { ROAD_HALF_M, type DriveEvent, type DriveView } from '@shared/driveProtocol';
import { placeAt, type RoadSample } from '../roadPath';
import { crawlGeometry } from './figures';
import { glowTexture, labelTexture, stripeTexture } from './textures';

/** 一条尸群带里的个体数 */
const SWARM_N = 8;
const SWARM_LEN = 40;

interface Prop {
  object: THREE.Object3D;
  /** 物件的里程（算离车多远：远处的加油站不开那盏真实的灯） */
  at: number;
  place: (path: readonly RoadSample[]) => void;
  /** 每帧：闪烁/蠕动/按距离开关灯 */
  tick?: (now: number, distance: number) => void;
  dispose: () => void;
}

function eventKey(ev: DriveEvent): string {
  return `${ev.kind}:${ev.at}:${ev.side ?? ''}:${ev.lat ?? ''}`;
}

/** 把物件摆到道路坐标处（朝向随道路切线） */
function putAt(object: THREE.Object3D, path: readonly RoadSample[], at: number, lat: number): void {
  const p = placeAt(path, at, lat);
  object.position.set(p.x, 0, -p.y);
  object.rotation.y = -p.theta;
}

export class Props {
  readonly group = new THREE.Group();
  private readonly items = new Map<string, Prop>();
  private readonly stripe = stripeTexture();
  private readonly glow = glowTexture();
  private readonly signTex = new Map<number, THREE.Texture>();
  private readonly swarmMat = new THREE.MeshStandardMaterial({ color: 0x3d1f1f, roughness: 1 });

  sync(view: DriveView, path: readonly RoadSample[], pos: number, now: number): void {
    const wanted = new Map<string, () => Prop>();
    for (const ev of view.events) wanted.set(eventKey(ev), () => this.make(ev));
    // 只画下一块路牌
    if (view.nextSignAt > pos - 30) {
      const no = view.signs + 1;
      const goal = view.targetSigns > 0 && no >= view.targetSigns;
      wanted.set(`sign:${view.nextSignAt}`, () => this.makeSign(no, goal, view.nextSignAt));
    }
    for (const [key, make] of wanted) {
      if (this.items.has(key)) continue;
      const prop = make();
      this.group.add(prop.object);
      this.items.set(key, prop);
    }
    for (const [key, prop] of this.items) {
      if (!wanted.has(key)) {
        this.group.remove(prop.object);
        prop.dispose();
        this.items.delete(key);
        continue;
      }
      prop.place(path);
      prop.tick?.(now, Math.abs(prop.at - pos));
    }
  }

  clear(): void {
    for (const prop of this.items.values()) {
      this.group.remove(prop.object);
      prop.dispose();
    }
    this.items.clear();
  }

  /** 按事件种类建对应物件 */
  private make(ev: DriveEvent): Prop {
    switch (ev.kind) {
      case 'barrier':
        return this.makeBarrier(ev);
      case 'swarm':
        return this.makeSwarm(ev);
      case 'loot':
        return this.makeLoot(ev);
      case 'station':
        return this.makeStation(ev);
    }
  }

  /* ---------------- 路障 ---------------- */

  private makeBarrier(ev: DriveEvent): Prop {
    const width = (ev.half ?? 1.3) * 2;
    const geo = new THREE.BoxGeometry(width, 0.95, 0.16);
    // 条纹沿宽度每 2.6m 重复一次（盒子侧面的 u 本来是 0..1）
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (width / 2.6));
    const mat = new THREE.MeshStandardMaterial({
      map: this.stripe,
      emissiveMap: this.stripe,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.07, // 反光膜：车灯照到之前也隐约可见
      roughness: 0.6,
    });
    const g = new THREE.Group();
    const board = new THREE.Mesh(geo, mat);
    board.position.y = 0.8;
    g.add(board);
    const legGeo = new THREE.BoxGeometry(0.09, 0.62, 0.09);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x4a4d55, roughness: 0.7 });
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set((sx * width) / 2 - sx * 0.22, 0.31, 0);
      g.add(leg);
    }
    return {
      object: g,
      at: ev.at,
      place: (path) => putAt(g, path, ev.at, ev.lat ?? 0),
      dispose: () => {
        geo.dispose();
        legGeo.dispose();
        mat.dispose();
        legMat.dispose();
      },
    };
  }

  /* ---------------- 尸群带 ---------------- */

  private makeSwarm(ev: DriveEvent): Prop {
    const mesh = new THREE.InstancedMesh(crawlGeometry(), this.swarmMat, SWARM_N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    const pts: { x: number; z: number; yaw: number }[] = [];
    const dummy = new THREE.Object3D();
    const write = (now: number): void => {
      for (let i = 0; i < SWARM_N; i++) {
        const p = pts[i];
        if (!p) continue;
        dummy.position.set(p.x + Math.sin(now / 160 + i * 1.9) * 0.12, 0, p.z);
        dummy.rotation.set(0, p.yaw + Math.sin(now / 130 + i) * 0.35, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    return {
      object: mesh,
      at: ev.at,
      place: (path) => {
        const half = (ev.half ?? 3.6) * 0.85;
        for (let i = 0; i < SWARM_N; i++) {
          const lat = (ev.lat ?? 0) + (i / (SWARM_N - 1) - 0.5) * 2 * half;
          const s = ev.at + ((i * 17) % SWARM_LEN);
          const p = placeAt(path, s, lat);
          pts[i] = { x: p.x, z: -p.y, yaw: -p.theta + (i % 2 ? 0.4 : -0.3) };
        }
        write(0);
      },
      tick: (now) => write(now),
      dispose: () => {
        mesh.dispose();
      },
    };
  }

  /* ---------------- 搜掠点 ---------------- */

  private makeLoot(ev: DriveEvent): Prop {
    const color = ev.content === 'repair' ? 0x58a55c : 0xd9a13c;
    const g = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.5, 10);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, emissive: new THREE.Color(color), emissiveIntensity: 1.1, roughness: 0.5 });
    const can = new THREE.Mesh(bodyGeo, bodyMat);
    can.position.y = 0.25;
    g.add(can);
    const capGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.1, 8);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.6 });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.55;
    g.add(cap);
    // 光晕收着点：加色混合的光晕在后视镜里不过曝光，太大会糊成一团刺眼的黄
    const glowMat = new THREE.SpriteMaterial({ map: this.glow, color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(2.0);
    glow.position.y = 0.55;
    g.add(glow);
    const lat = (ev.side === 'L' ? -1 : 1) * (ROAD_HALF_M + 1.4);
    return {
      object: g,
      at: ev.at,
      place: (path) => putAt(g, path, ev.at, lat),
      tick: (now) => {
        glowMat.opacity = 0.22 + 0.12 * Math.sin(now / 260); // 呼吸：夜里远远就能看到路肩有东西
      },
      dispose: () => {
        bodyGeo.dispose();
        capGeo.dispose();
        bodyMat.dispose();
        capMat.dispose();
        glowMat.dispose();
      },
    };
  }

  /* ---------------- 加油站 ---------------- */

  private makeStation(ev: DriveEvent): Prop {
    const g = new THREE.Group();
    const geos: THREE.BufferGeometry[] = [];
    const box = (w: number, h: number, d: number, color: number, x: number, y: number, z: number): THREE.Mesh => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
      geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    box(10, 0.12, 8, 0x1c1d22, 0, 0.06, 0); // 地坪
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.28, 4.3, 0.28, 0x8a8f99, sx * 3.6, 2.15, sz * 2.6); // 立柱
    box(10, 0.4, 8, 0x2d3340, 0, 4.5, 0); // 顶棚
    box(0.75, 1.5, 0.5, 0x9b2f2f, -1.5, 0.75, 0); // 加油机
    box(0.75, 1.5, 0.5, 0x9b2f2f, 1.5, 0.75, 0);
    // 棚顶下的灯管（自发光条，不占真实光源）
    const tubeGeo = new THREE.BoxGeometry(6.5, 0.05, 0.3);
    const tubeMat = new THREE.MeshBasicMaterial({ color: 0xffe6b0 });
    geos.push(tubeGeo);
    for (const sz of [-1.5, 1.5]) {
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.position.set(0, 4.27, sz);
      g.add(tube);
    }
    // 灯箱：朝向驶来的车
    const tex = labelTexture('加油', '#14212e', '#ffd98a', 256, 96, '700 60px system-ui');
    const signGeo = new THREE.PlaneGeometry(4.4, 1.35);
    const signMat = new THREE.MeshBasicMaterial({ map: tex });
    geos.push(signGeo);
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0, 5.45, 0.01);
    g.add(sign);
    const light = new THREE.PointLight(0xffd9a0, 70, 44, 1.7);
    light.position.set(0, 4.0, 0);
    g.add(light);
    const side = ev.side === 'L' ? -1 : 1;
    const at = ev.at + 15;
    const lat = side * (ROAD_HALF_M + 1.0 + 5);
    return {
      object: g,
      at,
      place: (path) => putAt(g, path, at, lat),
      tick: (now, distance) => {
        // 灯箱偶尔闪一下灭；离得远就不开那盏真实的灯（省光照开销）
        sign.visible = Math.sin(now / 90 + ev.at) > -0.93;
        light.visible = distance < 170;
      },
      dispose: () => {
        for (const geo of geos) geo.dispose();
        for (const m of g.children) {
          const mat = (m as THREE.Mesh).material as THREE.Material | undefined;
          if (mat) mat.dispose();
        }
        tubeMat.dispose();
        tex.dispose();
      },
    };
  }

  /* ---------------- 路牌 ---------------- */

  private makeSign(no: number, goal: boolean, at: number): Prop {
    let tex = this.signTex.get(no);
    if (!tex) {
      tex = labelTexture(goal ? '终点' : `${no}`, goal ? '#7a5a12' : '#1f5a36', '#f2f4ff', 128, 128, '700 78px system-ui');
      this.signTex.set(no, tex);
      if (this.signTex.size > 16) {
        const oldest = this.signTex.keys().next().value;
        if (oldest != null) {
          this.signTex.get(oldest)?.dispose();
          this.signTex.delete(oldest);
        }
      }
    }
    const g = new THREE.Group();
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.07, 3.4, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x7d828c, roughness: 0.6 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 1.7;
    g.add(pole);
    const panelGeo = new THREE.BoxGeometry(1.5, 1.5, 0.06);
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x3a3d46, roughness: 0.7 });
    const faceMat = new THREE.MeshBasicMaterial({ map: tex }); // 反光标志：黑暗里也看得见
    const panel = new THREE.Mesh(panelGeo, [edgeMat, edgeMat, edgeMat, edgeMat, faceMat, faceMat]);
    panel.position.y = 3.0;
    g.add(panel);
    return {
      object: g,
      at,
      place: (path) => putAt(g, path, at, ROAD_HALF_M + 3.9), // 立在护栏外的右侧
      dispose: () => {
        poleGeo.dispose();
        panelGeo.dispose();
        poleMat.dispose();
        edgeMat.dispose();
        faceMat.dispose();
      },
    };
  }

  dispose(): void {
    this.clear();
    this.stripe.dispose();
    this.glow.dispose();
    for (const t of this.signTex.values()) t.dispose();
    this.swarmMat.dispose();
  }
}
