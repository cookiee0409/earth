# 🌍 Neon Earth

보랏빛 · 파랏빛 · 초록빛 네온으로 빛나는 인터랙티브 지구본입니다. 실제 대륙 외곽선(Natural Earth) 데이터를 정사영(orthographic) 투영으로 그렸습니다.

## 기능

- **회전** — 마우스/터치로 드래그해 지구본을 돌립니다. 손을 떼면 잠시 후 자동 회전이 재개됩니다.
- **확대·축소** — 마우스 휠, 화면 우측 하단의 `+` / `−` 버튼, 또는 모바일 핀치 제스처로 줌인·줌아웃.
- **초기화** — `⟳` 버튼으로 초기 위치·배율로 되돌립니다.
- 강렬한 네온 형광빛 글로우, 대기 헤일로, 별이 반짝이는 우주 배경.

## 기술 스택

- 순수 HTML / CSS / Canvas 2D
- [d3-geo](https://github.com/d3/d3-geo) — 정사영 투영 및 경로 생성
- [topojson-client](https://github.com/topojson/topojson-client) — 대륙 데이터 디코딩
- 대륙 데이터: [world-atlas](https://github.com/topojson/world-atlas) `land-110m` (저장소에 포함, 가벼우면서 대륙 식별 가능)

빌드 단계가 없는 정적 사이트입니다.

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
