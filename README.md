# webURDF

브라우저에서 **URDF / xacro 로봇 모델을 열고, 보고, 편집하고, 검사하는** 웹 도구입니다.
설치나 빌드 없이 정적 파일만으로 동작하며, 모든 처리는 브라우저 안에서 이루어집니다 (파일이 서버로 업로드되지 않음).

## 실행

정적 웹 서버로 저장소 루트를 열면 됩니다.

```bash
python -m http.server 8765
```

브라우저에서 <http://localhost:8765> 를 엽니다. GitHub Pages 로 배포하려면 저장소 **Settings → Pages → Deploy from a branch → `main` / `(root)`** 를 선택하세요.

## 기능

### 불러오기
| 방법 | 설명 |
| --- | --- |
| 파일 열기 | `.urdf`, `.xacro` 와 메시 파일을 여러 개 함께 선택 |
| **폴더 열기** | ROS 패키지/워크스페이스 폴더를 통째로 선택 — URDF·xacro 를 찾아 목록으로 보여줌 |
| 드래그 앤 드롭 | 파일, 폴더, ZIP 을 창에 드롭. 모델이 열려 있을 때 메시만 드롭하면 현재 모델에 추가 |
| ZIP | ZIP 압축 파일을 열어 내부의 URDF 를 탐색 |
| **URL / GitHub 링크** | raw 파일 링크, GitHub `blob` 파일 링크, `tree` 폴더 링크, 저장소 링크, ZIP 링크 지원. GitHub 링크는 저장소 파일 목록을 읽어 메시까지 찾아 줌 (Git LFS 포함). 비공개 저장소는 토큰 입력 |
| 예제 | 아래 예제 로봇을 메뉴/시작 화면에서 바로 열기 |
| 붙여넣기 | URL 이나 URDF 텍스트를 페이지에 붙여넣기 |
| 링크 공유 | `?url=<링크>`, `?example=<id>&file=<경로>` 로 바로 열리는 주소 |

메시 경로 해석: `package://이름/...` (폴더 이름 또는 `package.xml` 의 `<name>` 으로 패키지 탐색), 상대 경로, `file://`, 절대 경로를 모두 지원하고,
찾지 못하면 파일 이름/경로 끝부분으로 추정 매칭합니다. 메시 형식: **STL, DAE(Collada), OBJ(+MTL), GLB/glTF, PLY**.

### 보기
- 비주얼 / 충돌 형상, 와이어프레임, 투명도, 링크 좌표계, 관절 축, 질량 중심(COM), 관성 상자, 링크 이름 라벨
- ROS(+Z 위) / +Y 위 전환, 격자·그림자, 자동 회전, 정면/측면/위/등각 뷰, 화면 맞춤
- 3D 뷰에서 링크 클릭으로 선택, 더블클릭으로 확대, **링크를 드래그해서 관절 움직이기**
- 라이트/다크 테마, 패널 크기 조절, 모바일 레이아웃

### 관절
- 모든 가동 관절(revolute / continuous / prismatic) 슬라이더와 숫자 입력, 도/라디안 전환
- mimic 관절 자동 추종, 한계 무시 옵션, 0 자세 / 무작위 자세 / 사인 스윕 애니메이션
- 자세 JSON 저장·불러오기

### 편집
- **코드 편집기**: XML 문법 강조, 줄 번호, 실시간 반영, 오류 줄 표시, 찾기/바꾸기, 자동 들여쓰기, 정렬(포맷)
- **속성 편집기**: 링크/조인트 이름 변경(참조 자동 갱신), 조인트 타입·부모·원점(xyz/rpy)·축·한계·dynamics,
  비주얼/충돌 형상(box/cylinder/sphere/mesh)·위치·색상, 관성(질량·COM·텐서, 기본 도형으로 자동 계산), 재질 색상
- 자식 링크 추가, 하위 트리 복제, 링크(하위 트리) 삭제, 비주얼→충돌 복사
- 새 로봇 템플릿 (빈 로봇, 2축 로봇팔, 차동 구동 로봇)
- 실행 취소 / 다시 실행

### xacro
브라우저 안에서 xacro 를 전개합니다: `property`(값/블록/default/scope), `arg` / `$(arg)`, `include` + `$(find pkg)`,
`macro`(기본값 `:=`, `^`/`^|` 상속, `*블록`, `**블록`), `insert_block`, `if` / `unless`, `element`, `attribute`, `call`,
`${수식}`(파이썬식 산술·비교·논리·삼항, `math` 함수), `$(eval)`, `$(env)`, `$(optenv)`, `$(dirname)`.
수식은 자체 인터프리터로 계산하므로 `eval()` 로 코드를 실행하지 않습니다. [정보] 탭에서 xacro 인자를 바꿔 다시 전개할 수 있습니다.

### 검사 · 정보
- **검사**: 이름 중복, 없는 부모/자식 링크, 다중 루트·순환, 트리 구조 위반, limit 누락·역전, 0/비단위 축, mimic 대상,
  관성 텐서의 양의 정부호·삼각 부등식, 질량 0, 빈 geometry, 메시 로드 실패 / 추정 매칭
- **정보**: 링크·조인트 수, 자유도, 조인트 타입 분포, 트리 깊이, 총 질량, 전체 질량 중심, 크기, 삼각형 수, 질량 분포 막대, 조인트 표(CSV 저장)
- **자세**: 선택한 링크의 위치·RPY·쿼터니언 (로봇 루트 또는 다른 링크 기준 — 두 링크 사이 거리 측정)
- **그래프**: 기구학 트리 다이어그램 (확대/이동/선택, SVG 저장)

### 내보내기
URDF, 전개된 URDF(xacro), **URDF + 메시 ZIP 패키지**, **MJCF(MuJoCo) 변환**, GLB 3D 모델, PNG 스크린샷, 자세 JSON, 조인트 CSV, 트리 SVG

## 예제 로봇

`examples/` 에 들어 있으며 메뉴 **🤖 예제** 에서 열 수 있습니다.

| 예제 | 출처 | 내용 |
| --- | --- | --- |
| MentorPi | [samcho93/studyMentorPi](https://github.com/samcho93/studyMentorPi) | 애커만 / 메카넘 모바일 로봇 (STL) |
| TIKI | [samcho93/studyTIKI](https://github.com/samcho93/studyTIKI) | 차동 구동 로봇, `package://` 경로, Gazebo xacro |
| SO-ARM101 | [samcho93/studySOArm101](https://github.com/samcho93/studySOArm101) | 6축 로봇팔 CAD 메시 URDF, 매크로 xacro. STL 은 [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100) (Apache-2.0) |
| Unitree GO2 | [samcho93/studyGO2](https://github.com/samcho93/studyGO2) | 12 자유도 4족 보행 로봇 (GLB) |
| Delta Robot | [samcho93/studyDeltaRobot](https://github.com/samcho93/studyDeltaRobot) | 설계 프리셋 4종에서 생성한 델타 로봇 URDF |

예제를 추가/수정한 뒤에는 목록을 다시 만듭니다.

```bash
node tools/build-manifest.mjs
```

## 구조

```
index.html          화면 레이아웃, import map (three.js, urdf-loader — jsDelivr CDN)
css/style.css       스타일 (라이트/다크)
js/main.js          앱 상태, 불러오기 흐름, 패널 UI, 단축키
js/vfs.js           가상 파일 시스템 + 메시/패키지 경로 해석
js/sources.js       로컬 파일·폴더·드롭·ZIP·URL·GitHub·예제 소스
js/xacro.js         xacro 처리기 + 안전한 수식 인터프리터
js/meshes.js        메시 로더(STL/DAE/OBJ/GLB/PLY) + 캐시
js/model.js         URDF 구조 추출, 검사, 통계, 편집 도구, XML 정렬, 템플릿
js/viewer.js        three.js 뷰어 (오버레이, 선택, 관절 드래그, 내보내기)
js/convert.js       URDF → MJCF 변환
js/ui/*.js          코드 편집기, 그래프, DOM 도우미
examples/           예제 로봇과 manifest.json
tools/              예제 목록 생성 스크립트
```

사용 라이브러리: [three.js](https://threejs.org), [urdf-loader](https://github.com/gkjohnson/urdf-loaders), [JSZip](https://stuk.github.io/jszip/) (ZIP 사용 시 동적 로드).
