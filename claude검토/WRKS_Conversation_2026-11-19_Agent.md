# Chat Export - Agent
**Exported**: 2026-11-19 13:28:04
**Timezone**: UTC+09:00

---

**User**:
이거 지금 쓰고있는 예상질의서 파일에서 목차뽑아내는 스크립트코든데 예외있을때마다 보완시켰더니 너무 어지러워짐. 개선방안 있을수가 있음?

---

**Assistant** (Claude Opus 4.7):
읽어봤습니다. TOC 파서 체인(약 1,000줄)이 "예외가 생기면 if 하나 더" 방식으로 커진 전형적인 구조라서 **구조 자체의 책임 분리**만 해도 유지보수 비용이 많이 낮아집니다. 코드를 다 보고 뽑은 진단과 개선안입니다.

---

## 1. 현재 구조의 근본 통증점

| 증상 | 원인 | 위치 |
|---|---|---|
| 파서 추가 = 두 곳 수정 | 폴백 체인이 `parseQuestionsHeuristic`과 `parseUploadedPdf` 두 군데에 중복 존재 | 860–868, 1100–1103 |
| 성공/실패 신호가 제각각 | 어떤 파서는 `[]` 반환, 어떤 파서는 `throw`, 어떤 파서는 "n개 이상이면 성공" | parseGroupedAuditToc(throw), parseTableToc(≥5), parseOfficerToc([]) |
| 감지와 추출이 섞여 있음 | `isTableToc` 판정이 `parseQuestionsHeuristic` 안에 있고, `isGroupedAuditToc`만 밖으로 빠져 있음 | 774, 876 |
| 200자짜리 정규식 | `parseTableToc`의 `rowPattern` 하나에 ID·제목·쪽수·비고·부록 lookahead를 전부 담음 | 606 |
| 242줄짜리 함수 | `locateQuestionsByContent`에 전처리·스코어링·선택·범위계산·docPage 포맷이 다 들어감 | 341–579 |
| 매직 넘버 산재 | 220, 300, 450, 500, 1000, 15, 5 등 임계값이 로직 바닥에 흩뿌려짐 | 349, 512, 517 |
| 하드코딩된 업무 상수 | `team: "재정복지과"`, `category: "일반"`이 파서 본문에 박힘 | 638, 889 |
| 전역 상태 의존 | `printedToPdfMap`, `currentDocumentType` 등 전역을 암묵적으로 읽음 | 전역 다수 |
| 중간 상태 mutation | 매칭 중 `item.title = pureTitle`로 입력 아이템을 뒤덮음 | 399 |
| AI 프롬프트가 함수 본문에 | 60줄 프롬프트가 `parseUploadedPdf` 중간에 인라인 | 1123–1158 |

---

## 2. 리팩터링 방향 — Parser Registry 패턴

핵심 아이디어: **각 TOC 유형을 "자기가 이 레이아웃인지 판정하는 함수 + 파싱 함수"가 한 묶음인 객체**로 만들고, 오케스트레이터는 그 목록을 돌면서 첫 성공을 쓰면 끝입니다.

```js
// tocParsers.js
const PARSERS = [
  { name: 'receipt',         detect: isReceiptLayout,   parse: parseReceiptToc },
  { name: 'groupedAudit',    detect: isGroupedAuditToc, parse: parseGroupedAuditToc },
  { name: 'audit',           detect: isAuditLayout,     parse: parseAuditToc },
  { name: 'officerTable',    detect: isOfficerLayout,   parse: parseOfficerToc },
  { name: 'dottedLeader',    detect: isDottedLayout,    parse: parseDottedToc },
  { name: 'fourColumnTable', detect: isTableLayout,     parse: parseTableToc },
  { name: 'aiGemini',        detect: () => !!geminiApiKey, parse: parseWithGemini },
  { name: 'heuristic',       detect: () => true,        parse: parseQuestionsHeuristic },
];

// 모든 파서가 동일한 반환 타입을 쓰게 통일
// { ok: true, items } | { ok: false, reason: 'no-match' | 'structure-error', message? }

async function runTocParsers(pageTexts, structure) {
  const diagnostics = [];
  for (const p of PARSERS) {
    if (!p.detect(structure, pageTexts)) continue;
    const r = await p.parse(pageTexts, structure);
    diagnostics.push({ parser: p.name, ok: r.ok, reason: r.reason });
    if (r.ok) return { items: r.items, parser: p.name, diagnostics };
  }
  return { items: [], parser: null, diagnostics };
}
```

이러면 `parseUploadedPdf`가 다음으로 줄어듭니다:

```js
async function parseUploadedPdf(pdfDoc, fileName) {
  const pageTexts = await extractAllPagesText(pdfDoc);
  const structure = analyzeDocumentStructure(pageTexts);
  const { items, parser } = await runTocParsers(pageTexts, structure);
  const normalized = items.map(toTocItem);                      // 스키마 통일
  const located = locateQuestionsByContent(normalized, pdfDoc, pageTexts, structure.tocPages);
  currentItems = located;
  tocPages = structure.tocPages.length ? structure.tocPages : [1];
}
```

**얻는 것**
- 새 레이아웃 = 파일 하나 추가 + 배열에 한 줄.
- 폴백 순서가 한 곳에 명시적으로 쓰여 있음(지금은 두 군데).
- 각 파서를 독립 테스트 가능.
- `throw`/`[]`/"n개 이상" 세 가지 성공 신호가 한 타입으로 통일.

---

## 3. 세부 개선(큰 리팩터링 없이 당장 적용 가능한 것)

### 3-1. 공통 스키마 팩토리로 보일러플레이트 제거
`settle: '', explain: '', attach: '', opinion: ''`가 거의 모든 파서에 반복됩니다.

```js
const EMPTY_REFS = { settle: '', explain: '', attach: '', opinion: '' };
const makeItem = (fields) => ({
  id: 0, categoryNumber: null, team: '', category: '일반',
  officer: '', title: '', docPage: '', startPdfPage: null, tocPage: 1,
  ...EMPTY_REFS, ...fields,
});
```

### 3-2. 매직 넘버를 명명된 상수로
`locateQuestionsByContent` 상단에:

```js
const SCORING = {
  SUBSTRING_HIT: 1000,
  HEADER_BOOST:  500,
  TOKEN_OVERLAP_MAX: 450,
  BRACKET_NUMBER: 300,
  ACCEPT_THRESHOLD: 220,
  MIN_PAGE_TEXT_LEN: 15,
};
```

### 3-3. 242줄 함수 쪼개기

```
locateQuestionsByContent(items, pdfDoc, pageTexts, tocPages)
  ├─ buildPageIndex(pageTexts)                 // 지금 354–378
  ├─ normalizeTitle(item)                       // 지금 395–404 (mutation 제거)
  ├─ scoreCandidate(item, page) → {total, br}   // 지금 각 가중치 블록
  ├─ pickBestPage(item, pages, prevPage)        // 지금 512–518
  └─ computeRanges(items, pdfDoc, pdfToPrinted) // 지금 530–577
```

### 3-4. 200자 정규식을 2단계로

지금(`parseTableToc` 606줄):
```js
const rowPattern = /(?:^|\s)(\d{1,3})\s+([^?？\n\r]{3,250}[?？])\s+(\d{1,3})(?:\s+([\uAC00-\uD7AF\s\<\>]+?))?(?=\s+\d{1,3}\s+[^?？\n\r]{3,250}[?？]|\s+(?:자산|부채|수익|비용|법령|용어)\s+|\s*-\s*\d+\s*-|$)/g;
```

개선:
```js
// 1) 물음표 기준으로 조각 분할 (훨씬 안전함)
const segments = combined.split(/(?<=[?？])/);
// 2) 각 조각을 간단한 패턴으로 해석
const ROW = /^\s*(\d{1,3})\s+(.+?[?？])\s+(\d{1,3})(?:\s+(.*))?$/;
```

디버깅 시 "7번 행에서 쪽수 열을 못 찾음" 같은 정확한 에러 리포트가 가능해집니다.

### 3-5. 도메인 사전 분리

여기저기 박혀 있는 키워드를 한 곳으로:

```js
// tocDictionary.js
export const APPENDIX_KEYWORDS = ['자산','부채','수익','비용','법령','용어'];
export const TEAM_SUFFIXES    = ['팀','과','담당'];
export const OFFICER_TAGS     = ['의원','언론','현안'];
export const STOPWORDS        = new Set([ /* 지금 381–385 */ ]);
export const TOC_TITLES       = /목\s*차|차\s*례|질의\s*순서|질의\s*목록/i;
```

### 3-6. 진단은 수집해서 한 번에 플러시

지금 `console.log`/`console.warn`이 매칭 루프마다 찍히는데, 이걸 배열에 쌓아뒀다가 마지막에 한 번에 보여주면:
- 운영 모드에선 로그 억제
- 디버그 모드에선 UI에 "N번 문항 스코어 180 → 이전 위치에 배치" 같은 걸 띄울 수 있음
- 사용자 PDF가 왜 틀리게 매칭됐는지 추적 가능

```js
const diag = {
  warnings: [], info: [],
  warn(msg) { this.warnings.push(msg); },
  log(msg)  { this.info.push(msg); },
};
```

### 3-7. 회귀 방지: 픽스처 기반 골든 테스트

예외 하나 고칠 때마다 또 다른 PDF가 깨지는 게 지금 코드의 진짜 비용인 듯합니다. **"예외마다 분기"가 아니라 "예외마다 픽스처"** 로 바꾸세요:

```
/fixtures/
  grouped-audit-2024.pageTexts.json   (extractAllPagesText 결과 캡처)
  dotted-education-2023.pageTexts.json
  receipt-2025.pageTexts.json
  table-fiscal-2024.pageTexts.json
/tests/
  parsers.test.js  → 각 픽스처에 대해 items.length, 첫/마지막 title, docPage 확인
```

문제 리포트가 들어오면:
1. 그 PDF에서 `pageTexts`를 JSON으로 덤프 → 픽스처 추가
2. 실패 테스트 보면서 파서 수정
3. 다른 픽스처가 깨지지 않았는지 확인

이 루프만 들여놔도 "예외 때마다 보완했더니 어지러워진" 상태가 재발하지 않습니다.

---

## 4. 우선순위 추천

| 작업 | 투자 | 회수 |
|---|---|---|
| 공통 반환 타입 `{ok, items, reason}` 통일 | 반나절 | 폴백 체인 중복 제거의 전제 |
| Parser Registry로 묶기 | 1–2일 | 새 레이아웃 추가 비용이 1/3로 |
| `locateQuestionsByContent` 4분할 | 1일 | 스코어링 버그 디버깅이 쉬워짐 |
| 픽스처 + 골든 테스트 | 1일 + 축적 | 회귀 재발 방지(가장 중요) |
| AI 프롬프트 외부화, 매직 넘버 상수화, 사전 분리 | 반나절 | 가독성 |

리팩터링 전후의 호출 그래프와 "이 파서가 왜 선택됐는가"를 디버그 패널에 띄우는 UI까지 만들어두면, 다음에 또 예외가 생겨도 "어느 가지에서 실패했는지" 눈으로 바로 보입니다.

원하시면 위 구조대로 **`tocParsers.js` + 리팩터링된 `parseUploadedPdf` 초안**을 바로 만들어 드릴 수 있고, 아니면 가장 통증이 큰 한두 개(예: Parser Registry만, 또는 locator 분할만)부터 집중해서 패치 형태로 보여드릴 수도 있습니다.

---

**User**:
응 둘다 수정해주고, codex에 적용 제안하는 이유와 업로드할 파일까지 만들어줘

---

**Assistant** (Claude Opus 4.7):
좋습니다. 방금 전체 소스를 다시 확인해서, 그 구조를 그대로 꽂아 넣을 수 있는 리팩터링 패키지를 만들었습니다. 코드 수정본 4개 파일 + Codex에 보낼 지시서 1개입니다.
완성입니다. 다섯 개 파일이 생성됐고, 위에 첨부되어 있습니다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| **tocConstants.js** | 매직 넘버·정규식·상투어·EMPTY_REFS를 한 곳으로. 이후 임계값 튜닝은 여기만 |
| **tocParsers.js** | 레지스트리 + 공통 반환타입 `{ok, items, reason}` + `makeItem` 팩토리 + `adapt()` 어댑터 (기존 파서 구현을 손대지 않고 감쌈) |
| **tocLocator.js** | 242줄 함수를 **buildPageIndex / normalizeItemTitle / scoreCandidate / pickBestPage / computeRanges** 5개로 분해, 오케스트레이터 `locate()` 추가 |
| **parseUploadedPdf.refactored.js** | app.js의 1076~1264줄을 대체할 짧은 버전(40여 줄) + `parseWithGemini` / `buildGeminiPrompt` / `registerTocParsers` 분리본 |
| **CODEX_PROMPT.md** | Codex에 붙여넣을 제안서 — 왜(통증점 9가지 표), 뭘(파일 구성·로드 순서), 어떻게(작업 지시 체크리스트), 수용 기준, 리스크까지 |

## Codex에 보낼 때 추천 흐름

1. Codex에 **CODEX_PROMPT.md 전문을 그대로 붙여넣기**
2. 같은 세션에 나머지 4개 JS 파일 첨부
3. 현재 `app.js`도 첨부 (Codex가 직접 삭제·교체 지점을 찾을 수 있게)
4. "위 지시대로 PR 패치 만들어줘" 한 줄

## 핵심 설계 원칙 (요약)

- **기존 파서 7개는 코드 수정 0줄**. `adapt()`가 "빈 배열→no-match / throw→structure-error"로 자동 변환해서 호환성 유지
- **폴백 순서는 기존과 동일**: groupedAudit → audit → officerTable → dottedLeader → fourColTable → aiGemini → heuristic
- **입력 mutation 제거**: `item.title = pureTitle`가 사라지고 `locate()`가 돌려주는 복사본에만 정화된 title이 담김
- **디버깅 가시화**: `console.table(res.diagnostics)` 한 줄로 어느 파서가 뽑혔는지, 다른 파서는 왜 no-match였는지 즉시 확인

제안서(CODEX_PROMPT.md) 4번 "수용 기준"에 샘플 PDF 6종 비교 체크리스트까지 넣어뒀으니, Codex가 패치를 올리고 나면 그 기준으로 회귀 검증만 돌리시면 됩니다.

---
