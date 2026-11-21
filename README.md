# Pay Brief

결제·핀테크 뉴스를 매일 아침 07:00(KST)에 자동으로 모아 **상품기획팀 관점으로 요약·분류**해 보여 주는 한 페이지 웹사이트.

```
Google 뉴스 RSS(키워드 6개) → 수집·중복 제거 → Claude 요약·분류 → data/YYYY-MM-DD.json → index.html
                      (Claude Code 예약 작업, 매일 07:10경 KST)                        (Vercel 자동 배포)
```

## 구성

| 파일 | 역할 |
|---|---|
| `scripts/build-brief.js` | RSS 수집 → 중복 제거 → 기사별 요약·분류 → JSON 저장 |
| `data/YYYY-MM-DD.json` | 날짜별 브리프. `data/index.json`은 날짜 목록 |
| `index.html` | 정적 페이지. JSON을 읽어 핵심 3건 / 분야 탭 / 카드 목록을 그림 |
| `vercel.json` | 빌드 없이 정적 배포, `data/`는 캐시하지 않음 |

## 로컬 실행

```bash
npm install
npm run brief:collect      # 수집·중복 제거만 (API 키 불필요)
export ANTHROPIC_API_KEY=sk-ant-...
npm run brief:try          # 3건만 요약해 저장 (품질 확인)
npm run brief              # 전체 실행 (최대 30건)
npm run serve              # http://localhost:8000 에서 화면 확인
```

## 자동 실행 방식

Anthropic API 키 없이 운영한다. Claude Code 예약 작업이 매일 아침 아래 순서로 실행하고 결과를 push하면 Vercel이 재배포한다.

```bash
npm ci
node scripts/build-brief.js --candidates work/candidates.json        # 1) 수집·중복 제거
# 2) Claude가 후보마다 요약 규칙(buildPrompt)에 따라 work/summaries.json 작성
node scripts/build-brief.js --assemble work/summaries.json --candidates work/candidates.json   # 3) 검증·저장
```

API 키가 생기면 `ANTHROPIC_API_KEY`를 설정하고 `node scripts/build-brief.js` 한 번으로 같은 결과를 만들 수 있다(모델 `claude-haiku-5-5`).

## 배포

1. 이 저장소를 Vercel에서 Import → Framework Preset "Other" → Deploy (빌드 설정은 `vercel.json`)
2. 새 브리프가 커밋될 때마다 Vercel이 자동 재배포

## 수집 규칙

- 출처: Google 뉴스 RSS 키워드 검색 — `간편결제`, `PG사`, `정산 결제`, `스테이블코인 결제`, `AI 에이전트 결제`, `금융위원회 핀테크`
- **수집 구간 고정**: 브리프 날짜 D = 전날(D-1) 07:00 ~ D 07:00 (KST). 실행 시각과 상관없이 같은 날짜는 같은 구간을 쓴다 (`--date YYYY-MM-DD`로 지정, 기본 오늘). 07:00 전에 실행하면 그때까지 나온 기사만 모인다
- 키워드별 최대 6건, 하루 최대 30건
- 브리프 JSON에 `window: { from, to }`(실제 수집 구간)를 저장하고 페이지 상단에 "수집 11.20 07:00 ~ 11.21 07:00"으로 표시
- 모든 피드 수집이 실패하면(네트워크 차단 등) 0건으로 조용히 끝내지 않고 오류로 종료
- 중복 제거: ① 링크 정규화 ② 제목 앞 30자(공백·특수문자 제거) 일치 ③ 제목 2글자 조각 겹침 60% 이상, 또는 같은 주어(쉼표 앞) + 겹침 35% 이상 → 최신 1건만 남김
- 기사 본문은 가져오지 않고 RSS 제목·설명만 요약 입력으로 사용

### 변경 이력

- **2026-11-21 수집 시간 정리**: 이전에는 "실행 시각부터 24시간 전까지"라 밤에 돌리면 그날 낮 기사가 들어가고 날짜도 실행일로 붙었다. 수집 구간을 07:00 마감으로 고정했다. 11/18 밤 23:18 테스트 실행분(11/18 08:50~20:28 기사)은 새 기준에 맞춰 `2026-11-19.json`으로 옮겼다.

### 지시서와 달라진 점 (2026-11-18 확인)

- **세계파이낸스 RSS 제외**: `https://www.segyefn.com/views/rss/finance.xml`이 HTTPS 인증서 불일치, HTTP는 DNS 실패로 응답 없음
- **키워드 교체**: `PG사 OR 전자결제대행` → `PG사`, `정산 핀테크` → `정산 결제` (24시간 기사가 0건인 날이 많음)
- **중복 제거 강화**: 같은 발표를 다룬 보도가 제목만 달라 여러 장 뜨는 문제 때문에 위 ③ 규칙 추가
- **참고**: Google 뉴스 RSS의 설명(description)은 제목+언론사명뿐이라 사실상 제목만으로 요약된다. 지시서 프롬프트 규칙에 따라 요약이 1문장, 중요도 1인 기사가 많을 수 있다.

## 저작권

기사 원문의 저작권은 각 언론사에 있습니다. 이 페이지는 제목·링크와 자체 요약만 제공합니다. 개인 포트폴리오 프로젝트.
