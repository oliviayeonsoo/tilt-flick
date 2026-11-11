// node test-core.js — 판정 엔진 시나리오 테스트 (센서값을 합성해서 넣는다)
const C = require('./tilt-core.js');
let pass = 0, fail = 0;
function check(name, cond, info) { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, info ?? ''); } }

// 3x3 행렬 곱
function mul(A, B) { return A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j])); }
const D = Math.PI / 180;
// 기기 x축(오른쪽)을 축으로 deg만큼 회전 = 위쪽 끝을 앞뒤로 기울이기 (기기 좌표에서 오른쪽 곱)
function pitchBy(R, deg) { const c = Math.cos(deg * D), s = Math.sin(deg * D); return mul(R, [[1, 0, 0], [0, c, -s], [0, s, c]]); }
function rollBy(R, deg) { const c = Math.cos(deg * D), s = Math.sin(deg * D); return mul(R, [[c, 0, s], [0, 1, 0], [-s, 0, c]]); }

// 각도 경로(시간 ms → pitch 변화량)를 60Hz로 엔진에 흘려 넣기
function run(engine, base, path, opt = {}) {
  const ev = []; let t = opt.t0 || 0;
  for (const [dur, from, to, rollFrom = 0, rollTo = 0] of path) {
    const n = Math.max(1, Math.round(dur / 16.7));
    for (let i = 1; i <= n; i++) {
      const p = from + (to - from) * i / n, r = rollFrom + (rollTo - rollFrom) * i / n;
      t += 16.7;
      const res = engine.update(t, rollBy(pitchBy(base, p), r));
      ev.push(...res.events.map(e => ({ ...e, t })));
    }
  }
  return ev;
}
const flips = ev => ev.filter(e => e.type === 'flip');

const seated = C.rotFromEuler(0, 60, 0);          // 앉아서 60도 세워 든 자세

console.log('1) 기본 동작');
{
  const e = new C.TiltEngine({ mode: 'fixed' }); e.setReference(seated);
  const ev = run(e, seated, [[300, 0, 0], [150, 0, -25], [150, -25, 0], [500, 0, 0]]);
  check('밀었다 돌아오면 한 번 넘김(음수 방향)', flips(ev).length === 1 && flips(ev)[0].sign === -1, ev);
}
{
  const e = new C.TiltEngine({ mode: 'fixed' }); e.setReference(seated);
  const ev = run(e, seated, [[150, 0, 25], [150, 25, 0], [500, 0, 0]]);
  check('당겼다 돌아오면 반대 방향(양수)', flips(ev).length === 1 && flips(ev)[0].sign === 1);
}
{
  const e = new C.TiltEngine({ mode: 'fixed' }); e.setReference(seated);
  const ev = run(e, seated, [[150, 0, -25], [2000, -25, -25], [150, -25, 0]]);
  check('기울인 채로 있으면 넘기지 않음(held 기록)', flips(ev).length === 0 && ev.some(x => x.type === 'held'));
}
{
  const e = new C.TiltEngine({ mode: 'fixed' }); e.setReference(seated);
  const ev = run(e, seated, [[150, 0, -25], [100, -25, 10], [100, 10, 0], [400, 0, 0]]);
  check('되돌아오며 반대로 살짝 넘어가도 한 번만', flips(ev).length === 1);
}
{
  const e = new C.TiltEngine({ mode: 'fixed' }); e.setReference(seated);
  const ev = run(e, seated, [[150, 0, -10, 0, 30], [150, -10, 0, 30, 0]]);
  check('옆으로 기울이기(roll)는 넘김 아님', flips(ev).length === 0);
}
{
  const e = new C.TiltEngine({ mode: 'fixed' }); e.setReference(seated);
  const ev = run(e, seated, [[150, 0, -12], [150, -12, 0]]);
  check('15도 못 미치는 흔들림은 무시', flips(ev).length === 0);
}

console.log('2) 고쳐 잡은 뒤 기준이 틀어진 경우');
// (a) 바깥으로 6도 틀어진 채 정착 → 10도짜리 흔들림
{
  const settle = [[300, 0, -6], [1500, -6, -6]];
  const wobble = [[120, -6, -16], [120, -16, -6], [400, -6, -6]];
  const ef = new C.TiltEngine({ mode: 'fixed' }); ef.setReference(seated);
  run(ef, seated, settle);
  check('고정: 6도 틀어진 뒤 10도 흔들림 → 넘김(오작동)', flips(run(ef, seated, wobble, { t0: 2000 })).length === 1);
  const ea = new C.TiltEngine({ mode: 'adaptive' }); ea.setReference(seated);
  const ev0 = run(ea, seated, settle);
  check('적응: 가만히 1초 뒤 기준 다시 잡음', ev0.some(x => x.type === 'rebase'));
  check('적응: 같은 흔들림은 무시', flips(run(ea, seated, wobble, { t0: 2000 })).length === 0);
}
// (b) 바깥으로 12도 틀어진 채 정착 → 진짜로 25도 밀기
{
  const settle = [[300, 0, -12], [1500, -12, -12]];
  const push = [[150, -12, -37], [150, -37, -12], [400, -12, -12]];
  const ef = new C.TiltEngine({ mode: 'fixed' }); ef.setReference(seated);
  run(ef, seated, settle);
  check('고정: 12도 틀어진 뒤 25도 밀기 → 못 넘김(놓침)', flips(run(ef, seated, push, { t0: 2000 })).length === 0);
  const ea = new C.TiltEngine({ mode: 'adaptive' }); ea.setReference(seated);
  run(ea, seated, settle);
  const ev = run(ea, seated, push, { t0: 2000 });
  check('적응: 같은 밀기 → 정상 넘김', flips(ev).length === 1 && flips(ev)[0].sign === -1);
}

console.log('3) 옆으로 누운 자세: 폰 오른쪽 축이 바닥 쪽으로 70도');
// beta=0, gamma=70 → 기기 x축이 수직에서 20도만 벗어남 (옆으로 누워 폰을 세워 든 자세)
const sideLying = C.rotFromEuler(0, 0, 70);
const flick = deg => [[150, 0, -deg], [150, -deg, 0], [400, 0, 0]];
{
  const e = new C.TiltEngine({ mode: 'fixed' }); e.setReference(sideLying);
  check('자세값 사용(고정): 25도 밀기 감지', flips(run(e, sideLying, flick(25))).length === 1);
}
{
  const e = new C.TiltEngine({ mode: 'gravity' }); e.setReference(sideLying);
  check('중력만 사용(기존 앱 방식): 25도 밀기를 못 봄', flips(run(e, sideLying, flick(25))).length === 0);
  const e2 = new C.TiltEngine({ mode: 'gravity' }); e2.setReference(sideLying);
  check('중력만 사용: 60도는 젖혀야 넘어감("더 젖혀야 한다" 후기와 일치)', flips(run(e2, sideLying, flick(60))).length === 1);
}

console.log('4) 캘리브레이션');
check('떨림 작을 때 하한 4도/초', C.stillSpeedFromCalibration([0.5, 0.6, 0.4]) === 4);
check('떨림 클수록 가만히 기준이 커짐', C.stillSpeedFromCalibration([3, 3, 3]) === 11);

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
