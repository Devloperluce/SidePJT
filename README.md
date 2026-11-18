# Pay Brief

결제·핀테크 뉴스를 매일 아침 07:00(KST)에 자동으로 모아 **상품기획팀 관점으로 요약·분류**해 보여 주는 한 페이지 웹사이트.

```
Google 뉴스 RSS(키워드 6개) → 수집·중복 제거 → Claude(claude-haiku-5-5) 요약·분류 → data/YYYY-MM-DD.json → index.html
                         (GitHub Actions, 매일 22:00 UTC)                                   (Vercel 자동 배포)
```

## 구성

| 파일 | 역할 |
|---|---|
| `scripts/build-brief.js` | RSS 수집 → 중복 제거 → 기사별 요약·분류 → JSON 저장 |
| `data/YYYY-MM-DD.json` | 날짜별 브리프. `data/index.json`은 날짜 목록 |
| `index.html` | 정적 페이지. JSON을 읽어 핵심 3건 / 분야 탭 / 카드 목록을 그림 |
| `.github/workflows/daily.yml` | 매일 실행 + 수동 실행 버튼, 결과를 커밋·push |
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

## 배포

1. GitHub에 저장소를 만들고 push
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret**: `ANTHROPIC_API_KEY`
3. **Settings → Actions → General → Workflow permissions**: "Read and write permissions" 선택
4. [Vercel](https://vercel.com/new)에서 저장소 Import → Framework Preset "Other" → Deploy (빌드 설정은 `vercel.json`이 지정)
5. **Actions → Daily Pay Brief → Run workflow**로 한 번 실행 → 새 JSON이 커밋되면 Vercel이 재배포

## 수집 규칙

- 출처: Google 뉴스 RSS 키워드 검색 — `간편결제`, `PG사`, `정산 결제`, `스테이블코인 결제`, `AI 에이전트 결제`, `금융위원회 핀테크`
- 최근 24시간 기사만, 키워드별 최대 6건, 하루 최대 30건
- 중복 제거: ① 링크 정규화 ② 제목 앞 30자(공백·특수문자 제거) 일치 ③ 제목 2글자 조각 겹침 60% 이상, 또는 같은 주어(쉼표 앞) + 겹침 35% 이상 → 최신 1건만 남김
- 기사 본문은 가져오지 않고 RSS 제목·설명만 요약 입력으로 사용

### 지시서와 달라진 점 (2026-11-18 확인)

- **세계파이낸스 RSS 제외**: `https://www.segyefn.com/views/rss/finance.xml`이 HTTPS 인증서 불일치, HTTP는 DNS 실패로 응답 없음
- **키워드 교체**: `PG사 OR 전자결제대행` → `PG사`, `정산 핀테크` → `정산 결제` (24시간 기사가 0건인 날이 많음)
- **중복 제거 강화**: 같은 발표를 다룬 보도가 제목만 달라 여러 장 뜨는 문제 때문에 위 ③ 규칙 추가
- **참고**: Google 뉴스 RSS의 설명(description)은 제목+언론사명뿐이라 사실상 제목만으로 요약된다. 지시서 프롬프트 규칙에 따라 요약이 1문장, 중요도 1인 기사가 많을 수 있다.

## 저작권

기사 원문의 저작권은 각 언론사에 있습니다. 이 페이지는 제목·링크와 자체 요약만 제공합니다. 개인 포트폴리오 프로젝트.
