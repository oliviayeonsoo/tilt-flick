/*
 * tilt-core.js — 기울기 넘기기 판정 엔진 (화면과 분리된 순수 계산 부분)
 *
 * 하는 일
 *  1. 폰 자세(deviceorientation의 alpha/beta/gamma)를 회전행렬로 바꾼다.
 *  2. "기준 자세"에 대해 위쪽 끝이 앞뒤로 얼마나 기울었는지(pitch),
 *     옆으로 얼마나 기울었는지(roll)를 구한다.
 *  3. "탁 기울였다 돌아오기"를 한 번의 넘김으로 판정한다.
 *  4. 적응형이면, 폰이 1초 이상 가만히 있을 때 그 자세를 새 기준으로 삼는다.
 *
 * 방식(mode)
 *  - 'fixed'    : 시작할 때 잡은 기준을 끝까지 유지 (고정 기울기)
 *  - 'adaptive' : 가만히 1초 → 기준 다시 잡기 (적응 기울기)
 *  - 'gravity'  : 중력 방향만으로 기울기 계산, 기준 고정 (기존 앱 재현용)
 *
 * 브라우저에서는 window.TiltCore, Node에서는 module.exports 로 쓴다.
 */
(function (root) {
  'use strict';
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  // W3C DeviceOrientation 정의: R = Rz(alpha) · Rx(beta) · Ry(gamma)
  // R의 각 열 = 기기 x(오른쪽) / y(위쪽) / z(화면에서 나오는 방향)를 지구 좌표로 쓴 것
  function rotFromEuler(alpha, beta, gamma) {
    const ca = Math.cos(alpha * D2R), sa = Math.sin(alpha * D2R);
    const cb = Math.cos(beta * D2R), sb = Math.sin(beta * D2R);
    const cg = Math.cos(gamma * D2R), sg = Math.sin(gamma * D2R);
    return [
      [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
      [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
      [-cb * sg, sb, cb * cg],
    ];
  }

  function col(R, j) { return [R[0][j], R[1][j], R[2][j]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function wrap(d) { while (d > 180) d -= 360; while (d < -180) d += 360; return d; }

  // 기준 자세 R0에서 본 현재 자세 R의 앞뒤(pitch)·옆(roll) 기울기
  // pitch > 0 : 위쪽 끝이 내 얼굴 쪽으로 (당기기)
  // pitch < 0 : 위쪽 끝이 바깥쪽으로 (밀기)
  // 자이로가 섞인 자세값을 쓰므로, 회전축이 중력과 나란해도(옆으로 누운 자세) 잡힌다.
  function relativeAngles(R0, R) {
    const x0 = col(R0, 0), y0 = col(R0, 1), z0 = col(R0, 2);
    const yw = col(R, 1), xw = col(R, 0);
    const pitch = Math.atan2(dot(z0, yw), dot(y0, yw)) * R2D;
    const roll = Math.atan2(dot(z0, xw), dot(x0, xw)) * R2D;
    return { pitch, roll };
  }

  // 지구 위쪽 방향을 기기 좌표로 = R의 3번째 행. 가속도계(중력)만 쓰는 앱이 보는 정보와 같다.
  function upInDevice(R) { return [R[2][0], R[2][1], R[2][2]]; }

  // 중력(가속도계)만으로 구한 기울기 — Android 기울기 앱들이 흔히 쓰는 방식.
  // 화면 위쪽 축(y)과 오른쪽 축(x)이 수평면에서 몇 도 들렸는지를 시작 때와 비교한다.
  // 회전축이 중력과 나란하면(옆으로 누워 폰을 세운 자세) 축의 높이가 거의 안 변해서
  // 같은 동작도 작게 보인다 → "누우면 더 젖혀야 넘어간다"는 후기와 같은 현상.
  function gravityAngles(u0, R) {
    const u = upInDevice(R);
    const el = v => Math.asin(Math.max(-1, Math.min(1, v))) * R2D;
    const pitch = el(u[1]) - el(u0[1]);
    const roll = el(u[0]) - el(u0[0]);
    return { pitch, roll };
  }

  const DEFAULTS = {
    mode: 'fixed',
    T: 15,            // 넘김 각도(도): 기준에서 이만큼 넘어가야 후보
    Tret: 8,          // 복귀 판정(도): 이 안으로 돌아오면 "돌아옴"
    W: 500,           // 복귀 제한 시간(ms): 이 안에 돌아와야 넘김
    refractory: 350,  // 넘긴 뒤 무시 시간(ms): 되돌아오며 반대쪽으로 넘어가는 것 막기
    crossRatio: 0.8,  // 옆 기울기가 앞뒤 기울기의 80%를 넘으면 넘김으로 안 침
    stillSpeed: 6,    // 가만히 판정 속도(도/초) — 캘리브레이션에서 개인 떨림으로 다시 정함
    stillTime: 1000,  // 적응형: 이만큼 가만히 있으면 기준 다시 잡기(ms)
    minRebase: 2,     // 기준과 2도 이상 달라졌을 때만 다시 잡기
  };

  class TiltEngine {
    constructor(opts) {
      this.o = Object.assign({}, DEFAULTS, opts || {});
      this.R0 = null; this.u0 = null;
      this.state = 'armed';      // armed → cand → (flip) armed | (시간 초과) held → armed
      this.cand = null;
      this.refractUntil = -Infinity;
      this.prev = null;          // 직전 {t, pitch, roll}
      this.speed = 0;            // 각속도(도/초), 지수 평활
      this.stillSince = null;
      this.rebaseCount = 0;
    }

    setReference(R) {
      this.R0 = R; this.u0 = upInDevice(R);
      this.state = 'armed'; this.cand = null; this.prev = null; this.stillSince = null;
    }

    angles(R) {
      return this.o.mode === 'gravity' ? gravityAngles(this.u0, R) : relativeAngles(this.R0, R);
    }

    // t: ms, R: 현재 회전행렬. 반환: {pitch, roll, speed, state, events[]}
    update(t, R) {
      const o = this.o, ev = [];
      if (!this.R0) this.setReference(R);
      let { pitch, roll } = this.angles(R);

      // 각속도 추정
      if (this.prev && t > this.prev.t) {
        const dt = (t - this.prev.t) / 1000;
        const inst = Math.hypot(wrap(pitch - this.prev.pitch), wrap(roll - this.prev.roll)) / dt;
        this.speed = this.speed * 0.7 + inst * 0.3;
      }
      this.prev = { t, pitch, roll };

      // 넘김 판정
      const ap = Math.abs(pitch), sign = Math.sign(pitch);
      if (this.state === 'armed') {
        if (t >= this.refractUntil && ap >= o.T && Math.abs(roll) <= ap * o.crossRatio) {
          this.state = 'cand';
          this.cand = { sign, t0: t, peak: ap };
        }
      } else if (this.state === 'cand') {
        this.cand.peak = Math.max(this.cand.peak, ap);
        const returned = ap < o.Tret || (sign !== 0 && sign !== this.cand.sign);
        if (returned) {
          const dur = t - this.cand.t0;
          if (dur <= o.W) {
            ev.push({ type: 'flip', sign: this.cand.sign, peak: this.cand.peak, dur });
            this.refractUntil = t + o.refractory;
          }
          this.state = 'armed'; this.cand = null;
        } else if (t - this.cand.t0 > o.W) {
          // 기울인 채로 머묾: 넘기지 않음. 넘기려다 실패했는지 분석할 때 쓰도록 기록
          ev.push({ type: 'held', sign: this.cand.sign, peak: this.cand.peak });
          this.state = 'held'; this.cand = null;
        }
      } else if (this.state === 'held') {
        if (ap < o.Tret) this.state = 'armed';
      }

      // 가만히 판정 + 적응형 기준 다시 잡기
      if (this.speed < o.stillSpeed) { if (this.stillSince === null) this.stillSince = t; }
      else this.stillSince = null;

      if (o.mode === 'adaptive' && this.state !== 'cand' && this.stillSince !== null &&
          t - this.stillSince >= o.stillTime &&
          (Math.abs(pitch) >= o.minRebase || Math.abs(roll) >= o.minRebase)) {
        ev.push({ type: 'rebase', pitch, roll, fromState: this.state });
        this.rebaseCount++;
        this.setReference(R);
        this.stillSince = t;
        this.prev = { t, pitch: 0, roll: 0 };
        pitch = 0; roll = 0;
      }

      return { pitch, roll, speed: this.speed, state: this.state, events: ev };
    }
  }

  // 캘리브레이션: 가만히 들고 있는 동안의 각속도로 개인 떨림 크기를 잰다
  function stillSpeedFromCalibration(speeds) {
    if (!speeds.length) return DEFAULTS.stillSpeed;
    const rms = Math.sqrt(speeds.reduce((s, v) => s + v * v, 0) / speeds.length);
    return Math.min(15, Math.max(4, 3 * rms + 2));
  }

  const api = { rotFromEuler, relativeAngles, gravityAngles, upInDevice, TiltEngine, DEFAULTS, stillSpeedFromCalibration, wrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TiltCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
