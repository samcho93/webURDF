// Regenerates examples/manifest.json from the files under examples/.
//   node tools/build-manifest.mjs
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../examples/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const GROUPS = [
  {
    id: 'mentorpi', name: 'MentorPi', dir: 'mentorpi', repo: 'https://github.com/samcho93/studyMentorPi',
    description: 'Hiwonder MentorPi 모바일 로봇 — 애커만 / 메카넘 휠 (STL)',
    entries: [['mentorpi_ackermann.urdf', '애커만'], ['mentorpi_mecanum.urdf', '메카넘']],
  },
  {
    id: 'tiki', name: 'TIKI', dir: 'tiki', repo: 'https://github.com/samcho93/studyTIKI',
    description: 'TIKI MINI 차동 구동 로봇 — package:// 경로, xacro (STL)',
    entries: [['tiki_description/urdf/tiki_mini.urdf', 'URDF'], ['tiki_gazebo/urdf/tiki_gazebo.urdf.xacro', 'Gazebo xacro']],
  },
  {
    id: 'so101', name: 'SO-ARM101', dir: 'so101', repo: 'https://github.com/samcho93/studySOArm101',
    description: 'SO-ARM101 6축 로봇팔 — CAD 메시 URDF / 매크로 xacro',
    entries: [['so_arm101_description/urdf/so101_new_calib.urdf', 'CAD 메시'], ['so_arm101_description/urdf/so_arm101.urdf.xacro', 'xacro (기본도형)']],
  },
  {
    id: 'go2', name: 'Unitree GO2', dir: 'go2', repo: 'https://github.com/samcho93/studyGO2',
    description: 'Unitree GO2 4족 보행 로봇 — 12 자유도 (GLB)',
    entries: [['go2_description.urdf', 'GO2']],
  },
  {
    id: 'delta', name: 'Delta Robot', dir: 'delta', repo: 'https://github.com/samcho93/studyDeltaRobot',
    description: '델타 병렬 로봇 — 설계 프리셋별 생성 URDF (기본도형)',
    entries: [
      ['delta_edu_dynamixel.urdf', '교육용 Dynamixel'], ['delta_edu_servo.urdf', '교육용 서보'],
      ['delta_printer_stepper.urdf', '3D 프린터 스테퍼'], ['delta_industrial_picker.urdf', '산업용 피커'],
    ],
  },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push({ path: relative(ROOT, p).replace(/\\/g, '/'), size: st.size });
  }
  return out;
}

const groups = GROUPS.map((g) => ({
  id: g.id, name: g.name, description: g.description, repo: g.repo,
  entries: g.entries.map(([f, label]) => ({ path: `${g.dir}/${f}`, label })),
  files: walk(join(ROOT, g.dir)),
}));
for (const g of groups) for (const e of g.entries) if (!g.files.some((f) => f.path === e.path)) throw new Error(`missing entry ${e.path}`);
writeFileSync(join(ROOT, 'manifest.json'), JSON.stringify({ version: 1, groups }, null, 1) + '\n');
console.log(groups.map((g) => `${g.id}: ${g.files.length} files`).join('\n'));
