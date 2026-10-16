// Gyroscope aiming: turn the phone left / right to look left / right, tilt it
// to look up / down, the way PUBG Mobile's gyroscope option works.
//
// The phone's rotation rate (devicemotion, degrees per second around the
// device's own axes) is projected onto two axes: "up" from the gravity
// reading, so turning your whole body works however the phone is tilted,
// and the screen's horizontal axis for pitch, which depends on which way the
// phone is held in landscape. The game pulls the accumulated angles once per
// frame with consume().

const D2R = Math.PI / 180;
const DEADZONE = 0.025;   // rad/s: sensor noise below this is ignored (no drift)

export class Gyro {
  constructor() {
    this.enabled = false;
    this.available = typeof window !== "undefined" && "DeviceMotionEvent" in window;
    this.sensitivity = 1.15;
    // iOS reports accelerationIncludingGravity with the opposite sign to Android
    this._gSign = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 0 ? -1 : 1;
    this._yaw = 0;
    this._pitch = 0;
    this._up = { x: 0, y: 0, z: 1 };
    this._hasUp = false;
    this._onMotion = this._onMotion.bind(this);
  }

  /** Must be called from a tap (iPhones ask for permission). Resolves true if it's on. */
  async enable() {
    if (!this.available) return false;
    try {
      if (typeof DeviceMotionEvent.requestPermission === "function") {
        if ((await DeviceMotionEvent.requestPermission()) !== "granted") return false;
      }
    } catch {
      return false;
    }
    window.addEventListener("devicemotion", this._onMotion);
    this.enabled = true;
    this._yaw = this._pitch = 0;
    return true;
  }

  disable() {
    window.removeEventListener("devicemotion", this._onMotion);
    this.enabled = false;
  }

  _onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (g && g.x !== null) {
      // Low-pass so walking / shaking doesn't swing the "up" axis around
      const len = (Math.hypot(g.x, g.y, g.z) || 1) * this._gSign;
      const k = this._hasUp ? 0.08 : 1;
      this._up.x += (g.x / len - this._up.x) * k;
      this._up.y += (g.y / len - this._up.y) * k;
      this._up.z += (g.z / len - this._up.z) * k;
      this._hasUp = true;
    }
    const r = e.rotationRate;
    if (!r || r.alpha === null || !this._hasUp) return;
    const dt = Math.min(0.1, (e.interval || 16) / (e.interval > 1 ? 1000 : 1)); // ms on most browsers, s on a few
    // Device frame: x = beta, y = gamma, z = alpha (rad/s)
    const wx = (r.beta || 0) * D2R, wy = (r.gamma || 0) * D2R, wz = (r.alpha || 0) * D2R;
    const u = this._up, ul = Math.hypot(u.x, u.y, u.z) || 1;
    let yaw = (wx * u.x + wy * u.y + wz * u.z) / ul;
    // Screen's horizontal axis in device coordinates, for the current orientation
    const angle = ((screen.orientation?.angle ?? window.orientation ?? 0) * D2R);
    let pitch = wx * Math.cos(angle) - wy * Math.sin(angle);
    if (Math.abs(yaw) < DEADZONE) yaw = 0;
    if (Math.abs(pitch) < DEADZONE) pitch = 0;
    this._yaw += yaw * dt * this.sensitivity;
    this._pitch += pitch * dt * this.sensitivity;
  }

  /** Radians turned since the last call: { yaw (+ = left), pitch (+ = up) }. */
  consume(out) {
    out.yaw = this._yaw;
    out.pitch = this._pitch;
    this._yaw = this._pitch = 0;
    return out;
  }
}
