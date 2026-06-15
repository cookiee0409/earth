# 🌍 Neon Earth

보랏빛 · 파랏빛 · 초록빛 네온으로 빛나는 인터랙티브 지구본입니다. 실제 대륙 외곽선(Natural Earth) 데이터를 정사영(orthographic) 투영으로 그렸습니다.

## 기능

- **회전** — 마우스/터치로 드래그해 지구본을 돌립니다. 손을 떼면 잠시 후 자동 회전이 재개됩니다.
- **확대·축소** — 마우스 휠, 화면 우측 하단의 `+` / `−` 버튼, 또는 모바일 핀치 제스처로 줌인·줌아웃.
- **초기화** — `⟳` 버튼으로 초기 위치·배율로 되돌립니다.
- **항공 노선** — 주요 국제선 대권 항로를 따라 작은 비행기 아이콘이 날아갑니다. 화면 하단 슬라이더로 날짜를 바꾸면 **그 날의 운항량만큼** 비행기 수가 늘고 줄며, `▶` 버튼으로 날짜를 자동 재생합니다.
- 강렬한 네온 형광빛 글로우, 대기 헤일로, 별이 반짝이는 우주 배경.

## 기술 스택

- 순수 HTML / CSS / Canvas 2D
- [d3-geo](https://github.com/d3/d3-geo) — 정사영 투영, 경로 생성, 대권(`geoInterpolate`) 보간
- [topojson-client](https://github.com/topojson/topojson-client) — 대륙 데이터 디코딩

빌드 단계가 없는 정적 사이트입니다.

## 데이터

| 파일 | 내용 | 출처 |
|---|---|---|
| `countries-110m.json` | 육지 외곽선 + 국가 경계 | [world-atlas](https://github.com/topojson/world-atlas) |
| `routes.json` | 주요 항공 노선 상위 1,600개(공항 좌표쌍 + 운항 가중치) | [OpenFlights](https://openflights.org/data) `routes.dat` |
| `daily.json` | 2019–2025 일별 운항량 | **모델(대표값)** — 실측 아님 |

> ⚠️ **`daily.json`은 실측이 아닌 모델 데이터입니다.** 주별 주기·여름 성수기·2020 COVID 급감/회복·완만한 장기 성장 등 실제 추세의 *형태*만 재현합니다. 실측으로 바꾸려면 [OpenSky Network](https://opensky-network.org/) REST API(`/flights/all`를 일 단위로 집계)나 Eurocontrol(유럽) 데이터를 `{ start, counts }` 형식으로 넣으면 그대로 동작합니다. `scripts/build-daily.js` 상단 주석 참고.

### 데이터 재생성

```bash
# OpenFlights 원본 내려받기 (저장소에는 가공본 routes.json만 포함)
curl -L -o routes.dat   https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat
curl -L -o airports.dat https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat

node scripts/process-routes.js   # routes.dat + airports.dat -> routes.json
node scripts/build-daily.js      # -> daily.json (모델)
```

## 로컬 실행

`fetch`로 데이터를 불러오므로 정적 서버가 필요합니다(파일 직접 열기 ❌).

```bash
npx serve .
# 또는
python -m http.server 8000
```

브라우저에서 `http://localhost:3000` (serve) 또는 `http://localhost:8000` 접속.

## Vercel 배포

빌드 설정 없이 그대로 배포됩니다.

**방법 1 — CLI**

```bash
npm i -g vercel
vercel        # 미리보기 배포
vercel --prod # 프로덕션 배포
```

**방법 2 — GitHub 연동**

1. 이 저장소를 GitHub에 푸시합니다.
2. [vercel.com/new](https://vercel.com/new)에서 저장소를 import합니다.
3. Framework Preset는 **Other**, Build Command·Output Directory는 비워둔 채 그대로 **Deploy**.

## 라이선스

MIT
