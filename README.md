# 🌍 Neon Earth

보랏빛 · 파랏빛 · 초록빛 네온으로 빛나는 인터랙티브 지구본입니다. 실제 대륙 외곽선(Natural Earth) 데이터를 정사영(orthographic) 투영으로 그렸습니다.

## 기능

- **회전** — 마우스/터치로 드래그해 지구본을 돌립니다. 손을 떼면 잠시 후 자동 회전이 재개됩니다.
- **확대·축소** — 마우스 휠, 화면 우측 하단의 `+` / `−` 버튼, 또는 모바일 핀치 제스처로 줌인·줌아웃.
- **초기화** — `⟳` 버튼으로 초기 위치·배율로 되돌립니다.
- **항공 노선** — 주요 국제선 대권 항로를 따라 작은 비행기 아이콘이 날아갑니다. 하단에서 슬라이더 또는 **날짜 직접 입력**으로 날짜를 바꾸면 **그 날의 운항량만큼** 비행기 수가 늘고 줄며, `▶`로 자동 재생(기본은 느리게)하고 `1× 2× 4× 8×` 배속 버튼으로 속도를 조절합니다. 기간은 2019-01-01 ~ **오늘**까지.
- **출발 / 도착 필터** — 좌상단에 **출발**·**도착** 트리가 따로 있습니다. 대륙 클릭 → 국가 목록, 국가 클릭 → 그 국가의 공항 이름. 규칙: 출발만 선택하면 그 국가에서 **출발하는** 모든 항공편, 도착만 선택하면 그 국가로 **도착하는** 모든 항공편, 둘 다 선택하면 **그 루트(출발지→도착지)만** 표시됩니다. 접속 국가가 기본으로 '출발'에 선택됩니다(Vercel geo).
- **비행 경로 선 + 클릭** — 표시 중인 노선은 대권 곡선으로 그려지고, 경로를 **클릭하면 대략적인 운항 기록 수**(항공사·노선 수 기준)가 표시됩니다. 자전이 멈춘 상태(일시정지)에서 클릭하기 쉽습니다.
- **대륙별 색상** — 출발 대륙(LIVE 모드에서는 현재 위치 대륙)에 따라 비행기·경로 색이 달라집니다.
- **LIVE 실측 모드** — `LIVE` 버튼을 누르면 [adsb.lol](https://adsb.lol/) 커뮤니티 ADS-B에서 **지금 하늘을 나는 실제 항공기**를 받아 실제 좌표·방위·속도로 표시합니다(폴 사이에는 속도·방위로 추측 항법하여 부드럽게 이동). 전 세계에서 항공 트래픽과 ADS-B 수신기가 가장 조밀한 권역(유럽·북미·동아시아 등)이 가장 빽빽하게 보입니다.
- **화면 크기 자동 조절** — 뷰포트 넓이에 맞춰 노선 수(400~1,700)와 비행기 상한(90~560대)을 자동 조정해, 작은 화면·저사양 기기에서도 부드럽게 동작합니다.
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
| `routes.json` | 주요 항공 노선 상위 1,700개(출발·도착 공항 IATA·이름·국가·대륙 + 운항 가중치) | [OpenFlights](https://openflights.org/data) + Natural Earth |
| `daily.json` | 2019–2025 일별 운항량 | **모델(대표값)** — 실측 아님 |

> ⚠️ **`daily.json`은 실측이 아닌 모델 데이터입니다.** 주별 주기·여름 성수기·2020 COVID 급감/회복·완만한 장기 성장 등 실제 추세의 *형태*만 재현합니다. 다년치 전 세계 일별 운항량을 무료로 받을 수 있는 정적 소스가 없어 모델로 대체했습니다. **실측이 필요하면 `LIVE` 모드**를 쓰거나(아래), `{ start, counts }` 형식으로 실측 일별 집계를 넣으면 슬라이더가 그대로 동작합니다.

## 실시간(LIVE) 데이터

`LIVE` 버튼은 Vercel 서버리스 함수 [`api/live.js`](api/live.js)를 호출합니다. 이 함수는 [adsb.lol](https://adsb.lol/)의 반경 쿼리로 주요 항공권역 몇 곳을 **순차 조회**(레이트리밋 회피)해 받은 항공기를 hex로 중복제거하고, 권역별로 고르게 샘플링·대륙 분류해 반환합니다. 엣지 캐시(`s-maxage`)와 웜 람다 캐시로 업스트림 호출을 공유합니다. API 키는 필요 없습니다.

**구현 메모 / 한계**

- 원래 [OpenSky Network](https://opensky-network.org/)를 쓰려 했으나, OpenSky가 **Vercel 데이터센터 IP의 연결을 차단**(`UND_ERR_CONNECT_TIMEOUT`)하고 브라우저 CORS도 자기 도메인만 허용해 서버·클라이언트 양쪽에서 접근 불가였습니다. 그래서 adsb.lol로 전환했습니다.
- adsb.lol에는 단일 전역 엔드포인트가 없어 권역별 반경 쿼리를 합칩니다. 클라우드 IP는 레이트리밋이 빡빡해 한 번에 보통 **상위 3개 권역(유럽·북미·동아시아) 정도가 안정적으로** 채워집니다 — 마침 전 세계 트래픽이 가장 집중된 곳입니다. 받지 못한 권역이 있어도 받은 만큼만 그리고, 실패 시 직전 캐시를 제공합니다.

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
