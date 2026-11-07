/**
 * The Spatial Studio camera. The stage is rendered with CSS 3D transforms, and
 * this module computes the same projection in JavaScript, so cables, drops and
 * drags land exactly where the browser draws the floor.
 *
 * Stage coordinates are pixels on the floor (x right, y towards the viewer at
 * top view) and z is height above the floor.
 */

export type Camera = {
  /** Turn around the vertical axis, in degrees. */
  yaw: number;
  /** Lean of the floor away from the viewer: 0 is the top view. */
  tilt: number;
  zoom: number;
  /** The floor point at the middle of the screen. */
  target: { x: number; y: number };
};

export type Viewport = { width: number; height: number };
export type Point2 = { x: number; y: number };
export type Point3 = { x: number; y: number; z: number };

export const PERSPECTIVE_PX = 1500;
export const LIMITS = { tilt: { min: 0, max: 62 }, yaw: { min: -75, max: 75 }, zoom: { min: 0.2, max: 2 } } as const;
export const PERSPECTIVE_VIEW = { yaw: -10, tilt: 40 } as const;
export const DEFAULT_CAMERA: Camera = { ...PERSPECTIVE_VIEW, zoom: 0.8, target: { x: 0, y: 0 } };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const radians = (degrees: number) => (degrees * Math.PI) / 180;

export const clampCamera = (camera: Camera): Camera => ({
  yaw: clamp(camera.yaw, LIMITS.yaw.min, LIMITS.yaw.max),
  tilt: clamp(camera.tilt, LIMITS.tilt.min, LIMITS.tilt.max),
  zoom: clamp(camera.zoom, LIMITS.zoom.min, LIMITS.zoom.max),
  target: camera.target,
});

/** The CSS transform for the world element (transform-origin 0 0, parent has `perspective`). */
export const cameraTransform = (camera: Camera, viewport: Viewport): string =>
  [
    `translate3d(${viewport.width / 2}px, ${viewport.height / 2}px, 0)`,
    `rotateX(${camera.tilt}deg)`,
    `rotateZ(${camera.yaw}deg)`,
    `scale3d(${camera.zoom}, ${camera.zoom}, ${camera.zoom})`,
    `translate3d(${-camera.target.x}px, ${-camera.target.y}px, 0)`,
  ].join(' ');

/** Rotation and scale only (the linear part of the transform), applied to a vector. */
const linear = (camera: Camera, vector: Point3): Point3 => {
  const s = camera.zoom;
  const yaw = radians(camera.yaw);
  const tilt = radians(camera.tilt);
  const x1 = s * vector.x * Math.cos(yaw) - s * vector.y * Math.sin(yaw);
  const y1 = s * vector.x * Math.sin(yaw) + s * vector.y * Math.cos(yaw);
  const z1 = s * vector.z;
  return { x: x1, y: y1 * Math.cos(tilt) - z1 * Math.sin(tilt), z: y1 * Math.sin(tilt) + z1 * Math.cos(tilt) };
};

export type Projected = Point2 & { /** Size multiplier from perspective. */ scale: number; /** Distance towards the viewer. */ depth: number };

/** Where a stage point appears on screen, relative to the viewport's top-left corner. */
export const project = (camera: Camera, viewport: Viewport, point: Point3): Projected => {
  const view = linear(camera, { x: point.x - camera.target.x, y: point.y - camera.target.y, z: point.z });
  const w = 1 - view.z / PERSPECTIVE_PX;
  return { x: viewport.width / 2 + view.x / w, y: viewport.height / 2 + view.y / w, scale: 1 / w, depth: view.z };
};

/**
 * The stage point under a screen position, on the horizontal plane at height
 * `planeZ`. Solves the projection backwards (two linear equations).
 */
export const unproject = (camera: Camera, viewport: Viewport, screen: Point2, planeZ = 0): Point2 => {
  const u = screen.x - viewport.width / 2;
  const v = screen.y - viewport.height / 2;
  const a1 = linear(camera, { x: 1, y: 0, z: 0 });
  const a2 = linear(camera, { x: 0, y: 1, z: 0 });
  const a3 = linear(camera, { x: 0, y: 0, z: 1 });
  const p = PERSPECTIVE_PX;
  const m11 = a1.x + (u * a1.z) / p;
  const m12 = a2.x + (u * a2.z) / p;
  const m21 = a1.y + (v * a1.z) / p;
  const m22 = a2.y + (v * a2.z) / p;
  const r1 = u - planeZ * (a3.x + (u * a3.z) / p);
  const r2 = v - planeZ * (a3.y + (v * a3.z) / p);
  const determinant = m11 * m22 - m12 * m21;
  if (Math.abs(determinant) < 1e-9) return { ...camera.target };
  return { x: camera.target.x + (r1 * m22 - m12 * r2) / determinant, y: camera.target.y + (m11 * r2 - r1 * m21) / determinant };
};

/** Zooms by `factor` keeping the floor point under `screen` still, as maps do. */
export const zoomAt = (camera: Camera, viewport: Viewport, screen: Point2, factor: number): Camera => {
  const before = unproject(camera, viewport, screen);
  const zoomed = clampCamera({ ...camera, zoom: camera.zoom * factor });
  const after = unproject(zoomed, viewport, screen);
  return { ...zoomed, target: { x: zoomed.target.x + before.x - after.x, y: zoomed.target.y + before.y - after.y } };
};

/** Pans so the floor point grabbed at `grabbed` (stage) sits under `screen`. */
export const panTo = (camera: Camera, viewport: Viewport, grabbed: Point2, screen: Point2): Camera => {
  const now = unproject(camera, viewport, screen);
  return { ...camera, target: { x: camera.target.x + grabbed.x - now.x, y: camera.target.y + grabbed.y - now.y } };
};

export const orbit = (camera: Camera, deltaYaw: number, deltaTilt: number): Camera => clampCamera({ ...camera, yaw: camera.yaw + deltaYaw, tilt: camera.tilt + deltaTilt });

export type Box = { minX: number; minY: number; maxX: number; maxY: number; height: number };

/** Fitting never zooms past life size, so one small step does not fill the screen. */
export const FIT_MAX_ZOOM = 1;

/** Frames a box of the stage with `margin` pixels to spare, keeping yaw and tilt. */
export const fitCamera = (camera: Camera, viewport: Viewport, box: Box, margin = 48): Camera => {
  let fitted = clampCamera({ ...camera, target: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } });
  const corners: Point3[] = [box.minX, box.maxX].flatMap((x) => [box.minY, box.maxY].flatMap((y) => [0, box.height].map((z) => ({ x, y, z }))));
  const available = { width: Math.max(40, viewport.width - 2 * margin), height: Math.max(40, viewport.height - 2 * margin) };
  for (let pass = 0; pass < 6; pass += 1) {
    const points = corners.map((corner) => project(fitted, viewport, corner));
    const left = Math.min(...points.map((point) => point.x));
    const right = Math.max(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const bottom = Math.max(...points.map((point) => point.y));
    const centre = unproject(fitted, viewport, { x: (left + right) / 2, y: (top + bottom) / 2 });
    const ratio = Math.min(available.width / Math.max(1, right - left), available.height / Math.max(1, bottom - top));
    fitted = clampCamera({ ...fitted, target: centre, zoom: Math.min(FIT_MAX_ZOOM, fitted.zoom * ratio) });
  }
  return fitted;
};
