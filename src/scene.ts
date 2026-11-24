import * as THREE from "three";
import { z } from "zod";
import { Buffer } from "node:buffer";

export const BASE = "/labs/fiend";
export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const sceneID = z.uuid();
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color, e.g. #a78bfa");
const name = z.string().trim().min(1).max(120);
const transform = {
  position: vector.optional(),
  rotation: vector.describe("Euler rotation in radians, XYZ order").optional(),
  scale: vector.optional(),
};
// Shapes need one, two or three dimensions; requiring three forced callers to
// invent a dummy value for a torus tube or a plane height.
const size = z.array(z.number().finite()).min(1).max(3)
  .describe("Box: width/height/depth. Cylinder: radiusTop/radiusBottom/height. Cone: radius/height. Sphere/icosahedron/dodecahedron: radius. Torus and torus knot: radius/tube. Plane: width/height. Capsule: radius/length. Supply only the values the shape uses; a no-op third value is not required.");
// Dimensions each primitive actually reads, in order.
const SIZE_ARITY: Record<string, number> = {
  box: 3, cylinder: 3, cone: 2, sphere: 1, icosahedron: 1, dodecahedron: 1,
  torus: 2, torus_knot: 2, plane: 2, capsule: 2,
};
function checkedSize(geometry: string, input?: number[]): [number, number, number] {
  const arity = SIZE_ARITY[geometry] ?? 3;
  const values = input ? [...input] : new Array(arity).fill(1);
  if (values.length < arity) throw new SceneError(`${geometry} needs ${arity} size value${arity === 1 ? "" : "s"}`);
  const used = values.slice(0, arity);
  if (used.some((value) => !(value > 0))) throw new SceneError(`Geometry dimensions must be greater than 0`);
  if (used.some((value) => value > 10000)) throw new SceneError("Geometry dimensions must be between 0 and 10,000");
  return [values[0]!, values[1] ?? 1, values[2] ?? 1];
}
const material = z.object({
  color: color.optional(),
  metalness: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  emissive: color.optional(),
  emissiveIntensity: z.number().min(0).max(100).optional(),
  wireframe: z.boolean().optional(),
});
export const operation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_mesh"), name,
    geometry: z.enum(["box", "sphere", "cylinder", "cone", "torus", "plane", "icosahedron", "capsule", "torus_knot", "dodecahedron"]),
    size: size.optional(),
    material: material.optional(), parent: z.string().optional(), ...transform,
  }),
  z.object({ type: z.literal("add_extrusion"), name, points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(3).max(128).describe("Closed 2D XY outline; do not repeat the first point. Extrudes along +Z."), depth: z.number().positive().max(1000).default(0.5), bevel: z.number().min(0).max(10).default(0), material: material.optional(), parent: z.string().optional(), ...transform }),
  z.object({ type: z.literal("add_lathe"), name, points: z.array(z.tuple([z.number().min(0).max(1000), z.number().finite()])).min(2).max(128).describe("Ordered [radius, height] profile, revolved around Y. Ideal for bottles, barrels, vases and turned parts."), segments: z.number().int().min(3).max(64).default(24), material: material.optional(), parent: z.string().optional(), ...transform }),
  z.object({ type: z.literal("add_tube"), name, points: z.array(vector).min(2).max(128).describe("3D centerline control points, joined with a Catmull-Rom spline."), radius: z.number().positive().max(100).default(0.1), closed: z.boolean().default(false), material: material.optional(), parent: z.string().optional(), ...transform }),
  z.object({ type: z.literal("add_group"), name, parent: z.string().optional(), ...transform }),
  z.object({
    type: z.literal("add_light"), name,
    kind: z.enum(["ambient", "directional", "point", "hemisphere"]),
    color: color.optional(), groundColor: color.optional(),
    intensity: z.number().min(0).max(1000).optional(),
    position: vector.optional(), parent: z.string().optional(),
  }),
  z.object({ type: z.literal("transform"), object: z.string(), ...transform, visible: z.boolean().optional() }),
  z.object({ type: z.literal("material"), object: z.string(), material }),
  z.object({ type: z.literal("light"), object: z.string(), color: color.optional(), groundColor: color.optional(), intensity: z.number().min(0).max(1000).optional(), distance: z.number().min(0).optional(), decay: z.number().min(0).max(10).optional() }),
  z.object({ type: z.literal("duplicate"), object: z.string(), name, parent: z.string().optional(), ...transform }),
  z.object({ type: z.literal("frame"), object: z.string().default("Scene"), direction: vector.default([1, 0.65, 1]), padding: z.number().min(1).max(5).default(1.4) }),
  z.object({ type: z.literal("rename"), object: z.string(), name }),
  z.object({ type: z.literal("remove"), object: z.string() }),
  z.object({ type: z.literal("reparent"), object: z.string(), parent: z.string().describe("UUID or unique name. Use Scene for the root. Local transform is preserved.") }),
  z.object({ type: z.literal("background"), color }),
  z.object({ type: z.literal("camera"), position: vector, target: vector, fov: z.number().min(5).max(150).optional() }),
]);
export const createInput = z.object({
  name: name.default("Untitled scene"),
  template: z.enum(["empty", "starter"]).default("starter"),
  source_id: sceneID.optional().describe("Optional public scene ID to copy. Creates an independent editable scene with a new ID and secret."),
});
export const editInput = z.object({
  operations: z.array(operation).min(1).max(100),
  revision: z.number().int().nonnegative().optional().describe("Optional optimistic concurrency check against scene_inspect's revision"),
});

export type Node = { uuid: string; type: string; name?: string; children?: Node[]; matrix?: number[]; material?: string | string[]; [key: string]: unknown };
export type Asset = { uuid: string; [key: string]: unknown };
export type SceneJSON = {
  metadata?: unknown;
  object: Node;
  geometries?: Asset[];
  materials?: Asset[];
  shapes?: Asset[];
  textures?: Asset[];
  images?: Asset[];
  [key: string]: unknown;
};
export type Document = {
  scene: SceneJSON;
  camera: SceneJSON;
  controls?: { center: number[] };
  backgroundType: string;
  environmentType: string;
};
export type Snapshot = { id: string; name: string; revision: number; document: Document; updatedAt: string; source: string };

export class SceneError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function validateDocument(input: unknown): Document {
  const parsed = z.object({
    scene: z.looseObject({ object: z.looseObject({ uuid: z.string(), type: z.literal("Scene") }) }),
    camera: z.looseObject({ object: z.looseObject({ uuid: z.string(), type: z.enum(["PerspectiveCamera", "OrthographicCamera"]) }) }),
    controls: z.object({ center: z.array(z.number().finite()).length(3) }).optional(),
    backgroundType: z.string().default("Color"),
    environmentType: z.string().default("None"),
  }).parse(input) as Document;
  const bytes = Buffer.byteLength(JSON.stringify(parsed));
  if (bytes > MAX_BYTES) throw new SceneError(`Scene JSON is ${(bytes / 1024 / 1024).toFixed(2)} MiB; the limit is 50 MiB.`, 413);
  const ids = new Set<string>();
  function visit(node: Node, depth: number) {
    if (depth > 64 || ids.size >= 2000) throw new SceneError("Scene exceeds 2,000 objects or 64 levels");
    if (!node || typeof node.uuid !== "string" || typeof node.type !== "string" || ids.has(node.uuid)) throw new SceneError("Invalid or duplicate scene object");
    ids.add(node.uuid);
    if (node.children !== undefined && !Array.isArray(node.children)) throw new SceneError("Invalid children");
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(parsed.scene.object, 0);
  return parsed;
}

export function initialDocument(template: "empty" | "starter"): Document {
  const scene = new THREE.Scene();
  scene.name = "Scene";
  scene.background = new THREE.Color("#16171b");
  const ambient = new THREE.HemisphereLight("#dae7ff", "#45404e", 2.4);
  ambient.name = "Sky light";
  const sun = new THREE.DirectionalLight("#fff1dd", 4);
  sun.name = "Key light";
  sun.position.set(4, 7, 5);
  scene.add(ambient, sun);
  if (template === "starter") {
    const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.32, 128, 24), new THREE.MeshStandardMaterial({ color: "#b3ef72", roughness: 0.28, metalness: 0.35 }));
    mesh.name = "Little fiend";
    mesh.position.y = 1.8;
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 0.18, 64), new THREE.MeshStandardMaterial({ color: "#393b42", roughness: 0.7 }));
    floor.name = "Plinth";
    scene.add(mesh, floor);
  }
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(6, 4, 7);
  camera.lookAt(0, 1, 0);
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  return { scene: scene.toJSON() as unknown as SceneJSON, camera: camera.toJSON() as unknown as SceneJSON, controls: { center: [0, 1, 0] }, backgroundType: "Color", environmentType: "None" };
}

export function find(root: Node, selector: string): Node {
  if (selector === "Scene" || selector === root.uuid) return root;
  const matches: Node[] = [];
  function walk(node: Node) {
    if (node.uuid === selector || node.name === selector) matches.push(node);
    for (const child of node.children ?? []) walk(child);
  }
  walk(root);
  if (!matches.length) throw new SceneError(`Object not found: ${selector}`, 404);
  if (matches.length > 1) throw new SceneError(`Ambiguous name: ${selector}. Use a UUID.`);
  return matches[0]!;
}

function parentOf(root: Node, child: Node): Node | undefined {
  if (root.children?.includes(child)) return root;
  for (const node of root.children ?? []) {
    const parent = parentOf(node, child);
    if (parent) return parent;
  }
}

function setTransform(node: Node, input: { position?: number[]; rotation?: number[]; scale?: number[] }) {
  const matrix = new THREE.Matrix4();
  if (node.matrix) matrix.fromArray(node.matrix);
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  if (input.position) position.fromArray(input.position);
  if (input.rotation) quaternion.setFromEuler(new THREE.Euler(...input.rotation as [number, number, number]));
  if (input.scale) scale.fromArray(input.scale);
  node.matrix = Array.from(matrix.compose(position, quaternion, scale).toArray());
}

function setMaterial(target: Asset, input: z.infer<typeof material>) {
  for (const [key, value] of Object.entries(input)) {
    target[key] = key === "color" || key === "emissive" ? new THREE.Color(value as string).getHex() : value;
  }
  if (input.opacity !== undefined) target.transparent = input.opacity < 1;
}

export function editDocument(original: Document, operations: z.infer<typeof operation>[]) {
  // Copy mutable graph records, sharing large immutable geometry/image payloads.
  function copyNode(node: Node): Node { return { ...node, ...(node.children ? { children: node.children.map(copyNode) } : {}) }; }
  const document: Document = { ...original, scene: {
    ...original.scene, object: copyNode(original.scene.object),
    geometries: [...(original.scene.geometries ?? [])], materials: [...(original.scene.materials ?? [])], shapes: [...(original.scene.shapes ?? [])],
  } };
  const root = document.scene.object;
  const created: { uuid: string; name: string }[] = [];
  for (const op of operations) {
    if (op.type === "background") {
      root.background = new THREE.Color(op.color).getHex();
      document.backgroundType = "Color";
      continue;
    }
    if (op.type === "camera") {
      const camera = new THREE.PerspectiveCamera(op.fov ?? 45, 1, 0.1, 1000);
      camera.uuid = document.camera.object.uuid;
      camera.position.fromArray(op.position);
      camera.lookAt(new THREE.Vector3(...op.target));
      camera.updateMatrixWorld(true);
      document.camera = camera.toJSON() as unknown as SceneJSON;
      document.controls = { center: op.target };
      continue;
    }
    if (op.type === "add_mesh" || op.type === "add_group" || op.type === "add_light" || op.type === "add_extrusion" || op.type === "add_lathe" || op.type === "add_tube") {
      let object: THREE.Object3D;
      if (op.type === "add_group") object = new THREE.Group();
      else if (op.type === "add_light") {
        const c = op.color ?? "#ffffff", i = op.intensity ?? 2;
        object = op.kind === "ambient" ? new THREE.AmbientLight(c, i)
          : op.kind === "directional" ? new THREE.DirectionalLight(c, i)
          : op.kind === "hemisphere" ? new THREE.HemisphereLight(c, op.groundColor ?? "#444444", i)
          : new THREE.PointLight(c, i);
      } else if (op.type === "add_extrusion" || op.type === "add_lathe" || op.type === "add_tube") {
        const geometry = op.type === "add_extrusion" ? new THREE.ExtrudeGeometry(new THREE.Shape(op.points.map(([x, y]) => new THREE.Vector2(x, y))), { depth: op.depth, bevelEnabled: op.bevel > 0, bevelSize: op.bevel, bevelThickness: op.bevel, bevelSegments: 2, steps: 1 })
          : op.type === "add_lathe" ? new THREE.LatheGeometry(op.points.map(([x, y]) => new THREE.Vector2(x, y)), op.segments)
          : new THREE.TubeGeometry(new THREE.CatmullRomCurve3(op.points.map((point) => new THREE.Vector3(...point)), op.closed), 64, op.radius, 12, op.closed);
        // Three.js can serialize these recipes directly. Baking them into vertex
        // arrays made tiny tool inputs expand into hundreds of kilobytes of JSON.
        object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#b3ef72", roughness: 0.5 }));
      } else {
        const [a, b, c] = checkedSize(op.geometry, op.size);
        const geometry = op.geometry === "box" ? new THREE.BoxGeometry(a, b, c)
          : op.geometry === "sphere" ? new THREE.SphereGeometry(a, 32, 20)
          : op.geometry === "cylinder" ? new THREE.CylinderGeometry(a, b, c, 32)
          : op.geometry === "cone" ? new THREE.ConeGeometry(a, b, 32)
          : op.geometry === "torus" ? new THREE.TorusGeometry(a, op.size ? b : 0.25, 16, 64)
          : op.geometry === "plane" ? new THREE.PlaneGeometry(a, b)
          : op.geometry === "capsule" ? new THREE.CapsuleGeometry(a, b, 4, 16)
          : op.geometry === "torus_knot" ? new THREE.TorusKnotGeometry(a, op.size ? b : 0.25, 96, 16)
          : op.geometry === "dodecahedron" ? new THREE.DodecahedronGeometry(a, 0)
          : new THREE.IcosahedronGeometry(a, 0);
        object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#b3ef72", roughness: 0.5 }));
      }
      object.name = op.name;
      object.updateMatrixWorld(true);
      const json = object.toJSON() as unknown as SceneJSON;
      if ("material" in op && op.material) setMaterial(json.materials![0]!, op.material);
      setTransform(json.object, op);
      const parent = op.parent ? find(root, op.parent) : root;
      (parent.children ??= []).push(json.object);
      for (const key of ["geometries", "materials", "shapes"] as const) if (json[key]) (document.scene[key] ??= []).push(...json[key]);
      created.push({ uuid: object.uuid, name: op.name });
      continue;
    }
    const object = find(root, op.object);
    if (op.type === "frame") {
      const box = bounds(document, op.object);
      if (box.isEmpty()) throw new SceneError("Object has no renderable geometry to frame");
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
      const direction = new THREE.Vector3(...op.direction);
      if (direction.lengthSq() === 0) throw new SceneError("Frame direction cannot be zero");
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
      camera.uuid = document.camera.object.uuid;
      camera.position.copy(center).add(direction.normalize().multiplyScalar(radius / Math.sin(Math.PI / 8) * op.padding));
      camera.lookAt(center);
      camera.updateMatrixWorld(true);
      document.camera = camera.toJSON() as unknown as SceneJSON;
      document.controls = { center: center.toArray() };
    } else if (op.type === "duplicate") {
      if (object === root) throw new SceneError("Duplicate a group or object, not the scene root");
      const copy = copyNode(object);
      function renew(node: Node) { node.uuid = crypto.randomUUID(); for (const child of node.children ?? []) renew(child); }
      renew(copy);
      copy.name = op.name;
      setTransform(copy, op);
      const parent = op.parent ? find(root, op.parent) : parentOf(root, object)!;
      (parent.children ??= []).push(copy);
      created.push({ uuid: copy.uuid, name: op.name });
    } else if (op.type === "light") {
      if (!object.type.endsWith("Light")) throw new SceneError("Object is not a light");
      for (const key of ["color", "groundColor", "intensity", "distance", "decay"] as const) {
        if (op[key] !== undefined) object[key] = key === "color" || key === "groundColor" ? new THREE.Color(op[key] as string).getHex() : op[key];
      }
    } else if (op.type === "transform") {
      setTransform(object, op);
      if (op.visible !== undefined) object.visible = op.visible;
    } else if (op.type === "rename") object.name = op.name;
    else if (op.type === "material") {
      const ids = Array.isArray(object.material) ? object.material : [object.material];
      if (!object.material) throw new SceneError("Object has no material");
      // Give this object its own material instead of changing other meshes sharing it.
      const replacements = ids.map((id) => {
        const existing = document.scene.materials?.find((item) => item.uuid === id);
        if (!existing) throw new SceneError("Material not found");
        const copy = { ...existing, uuid: crypto.randomUUID() };
        setMaterial(copy, op.material);
        document.scene.materials!.push(copy);
        return copy.uuid;
      });
      object.material = Array.isArray(object.material) ? replacements : replacements[0];
    } else {
      if (object === root) throw new SceneError("Cannot remove or reparent the scene root");
      const oldParent = parentOf(root, object)!;
      if (op.type === "reparent") {
        const parent = find(root, op.parent);
        if (parent === object || parentOf(object, parent)) throw new SceneError("Cannot create a cycle");
        oldParent.children = oldParent.children!.filter((child) => child !== object);
        (parent.children ??= []).push(object);
      } else oldParent.children = oldParent.children!.filter((child) => child !== object);
    }
  }
  // Keep unused mesh assets from accumulating after edits/removals.
  const geometries = new Set<unknown>(), materials = new Set<unknown>();
  function collect(node: Node) {
    geometries.add(node.geometry);
    for (const id of Array.isArray(node.material) ? node.material : [node.material]) materials.add(id);
    for (const child of node.children ?? []) collect(child);
  }
  collect(root);
  document.scene.geometries = document.scene.geometries?.filter((item) => geometries.has(item.uuid));
  document.scene.materials = document.scene.materials?.filter((item) => materials.has(item.uuid));
  const shapes = new Set(document.scene.geometries?.flatMap((item) => Array.isArray(item.shapes) ? item.shapes : []));
  document.scene.shapes = document.scene.shapes?.filter((item) => shapes.has(item.uuid));
  return { document: validateDocument(document), created };
}

export function inspect(snapshot: Snapshot) {
  function summarize(node: Node): unknown {
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
    new THREE.Matrix4().fromArray(node.matrix ?? new THREE.Matrix4().toArray()).decompose(position, quaternion, scale);
    const euler = new THREE.Euler().setFromQuaternion(quaternion);
    return {
      uuid: node.uuid, name: node.name, type: node.type, position: position.toArray(),
      rotation: [euler.x, euler.y, euler.z], scale: scale.toArray(), visible: node.visible !== false,
      material: node.material, children: node.children?.map(summarize),
    };
  }
  return { id: snapshot.id, name: snapshot.name, revision: snapshot.revision, updatedAt: snapshot.updatedAt, storage: { bytes: Buffer.byteLength(JSON.stringify(snapshot.document)), limit_bytes: MAX_BYTES }, objects: summarize(snapshot.document.scene.object), materials: snapshot.document.scene.materials, camera: snapshot.document.camera, controls: snapshot.document.controls };
}

export function bounds(document: Document, selector = "Scene") {
  const target = find(document.scene.object, selector);
  // r186 accepts the shape registry as a second argument; @types/three lags it.
  const loader = new THREE.ObjectLoader() as THREE.ObjectLoader & { parseShapes(json: unknown): Record<string, THREE.Shape> };
  const parse: (json: unknown, shapes: Record<string, THREE.Shape>) => ReturnType<THREE.ObjectLoader["parseGeometries"]> = loader.parseGeometries.bind(loader);
  const geometries = parse(document.scene.geometries ?? [], loader.parseShapes(document.scene.shapes));
  const box = new THREE.Box3();
  function walk(node: Node, parent: THREE.Matrix4, inside: boolean) {
    const matrix = new THREE.Matrix4().fromArray(node.matrix ?? new THREE.Matrix4().toArray());
    matrix.premultiply(parent);
    const selected = inside || node === target;
    if (selected && typeof node.geometry === "string") {
      const geometry = geometries[node.geometry];
      if (geometry) { geometry.computeBoundingBox(); if (geometry.boundingBox) box.union(geometry.boundingBox.clone().applyMatrix4(matrix)); }
    }
    for (const child of node.children ?? []) walk(child, matrix, selected);
  }
  walk(document.scene.object, new THREE.Matrix4(), false);
  return box;
}
