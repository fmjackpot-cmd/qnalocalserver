# Codex 적용 제안서 — TOC 파서 체인 리팩터링

> 이 문서를 Codex 에 **그대로 붙여넣고** 함께 지정한 4개 파일을 첨부하면,
> 아래 "Codex 작업 지시"의 체크리스트대로 PR 수준의 패치를 만들어 준다.
> 저장 경로는 `/public/js/toc/` 를 권장한다 (기존 `app.js` 는 같은 디렉토리).

---

## 1. 왜 지금 리팩터링해야 하는가 (Rationale)

현재 `app.js` 의 목차 파싱 블록은 PDF 레이아웃 예외가 들어올 때마다
`if` 와 정규식을 한 줄씩 늘리는 방식으로 성장해 왔고, 그 결과 다음과 같은
구조적 통증이 쌓였다.

| # | 통증점 | 현행 위치 | 리팩터링 후 |
|---|---|---|---|
| 1 | **폴백 체인이 두 군데**에 중복 존재 | `parseQuestionsHeuristic`(860–868) + `parseUploadedPdf`(1100–1103) | `tocParsers.js` 레지스트리 한 곳 |
| 2 | 성공 신호가 파서마다 다름 (빈 배열 / throw / "n개 이상") | 전역 | 공통 반환 `{ok, items, reason}` |
| 3 | 242줄 함수 `locateQuestionsByContent` 하나에 전처리·스코어링·선택·범위계산·라벨링이 뒤섞임 | 341–579 | 5개 순수 함수로 분리 |
| 4 | 매직 넘버 (220·300·450·500·1000·1200·1600·-500 등) 가 로직 바닥에 흩뿌려짐 | 350·445·450·497·506·512 등 | `tocConstants.js` `SCORING` 객체 |
| 5 | 60줄짜리 Gemini 프롬프트가 함수 본문에 인라인 | 1123–1158 | `buildGeminiPrompt()` |
| 6 | 하드코딩된 업무 상수 (`team:"재정복지과"`, `category:"재무결산 질의"`) 가 **레이아웃 파서 본문에 직접** 박혀 있어, 같은 레이아웃을 다른 부서가 써도 전부 재정복지과로 찍히고, 다른 부서 지원 시 **파서가 복제 번식**한다 | 638(parseGroupedAuditToc)·889·977 | 레지스트리에서 **defaults 옵션 주입** (`{defaultTeam, defaultCategory}`) |
| 7 | 입력 `item.title` 을 매칭 중에 **mutate** | 399 | `normalizeItemTitle()` 가 순수값만 반환 |
| 8 | 전역 `printedToPdfMap`·`pdfToPrintedMap`·`geminiApiKey` 를 암묵적으로 읽음 | 전역 | `ctx` 로 명시 주입 (locator 는 하위호환 유지) |
| 9 | 파서 추가 비용이 두 파일 동시 수정 | — | **"파일 하나 + 배열에 한 줄"** |

### 리팩터링이 가져오는 구체적 개선

- **신규 TOC 레이아웃 지원 시**: 지금은 ① `parseXxx` 를 새로 짜고 ② 폴백 2곳에 등록해야 하지만, 이후엔 ① 파서 함수 1개 ② `registerTocParsers()` 에 한 줄 추가로 끝.
- **디버깅**: `res.diagnostics` 로 "어느 파서가 뽑혔고, 어느 파서는 왜 no-match 였는지"가 `console.table` 한 줄에 찍힘.
- **회귀 방지**: 각 파서가 독립이라 픽스처(`pageTexts` JSON 캡처) 단위로 골든 테스트를 붙일 수 있다. 예외가 생길 때마다 "if 추가" 가 아니라 **"픽스처 추가 → 실패 → 그 파서만 수정"** 루프로 바뀐다.
- **성능**: `buildPageIndex` 는 1회, `locate` 안에서 파서별로 중복되던 cleanNoSpace 계산이 사라진다 (현재도 1회지만, 모듈화되면서 재사용이 쉬워진다).
- **타입 안정성**: `makeItem` 과 `normalizeItem` 이 모든 아이템 스키마를 보장 → "`settle` 필드가 undefined 라서 `.trim()` 터지는" 류의 사고 차단.

### 리팩터링이 깨지 않는 것 (호환성 보장)

- 모든 기존 파서 구현(`parseGroupedAuditToc` 등)은 **코드 수정 없이** 그대로 사용된다.  어댑터 `TocParsers.adapt(fn)` 가 "빈 배열 → no-match / throw → structure-error" 로 자동 변환한다.
- `printedToPdfMap`·`pdfToPrintedMap` 전역은 그대로 유지한다. (locator 는 `global.*` 로 읽어서 하위호환.)
- `currentDocumentType === 'receipt'` 조기 분기도 그대로 유지한다.
- Gemini 프롬프트의 **문자열 자체는 그대로**. 위치만 분리.

---

## 2. 파일 구성

```
public/js/toc/
  tocConstants.js   (2.6 KB)  상수/사전/정규식 — 다른 파일이 이걸 읽는다
  tocParsers.js     (6.3 KB)  레지스트리 + 공통 반환타입 + makeItem
  tocLocator.js     (10 KB)   buildPageIndex / normalizeItemTitle /
                              scoreCandidate / pickBestPage / computeRanges
                              + 오케스트레이터 locate()
public/
  parseUploadedPdf.refactored.js   (6.7 KB)  app.js 에 꽂을 패치본
```

로드 순서 (index.html 등) :

```html
<script src="js/toc/tocConstants.js"></script>
<script src="js/toc/tocParsers.js"></script>
<script src="js/toc/tocLocator.js"></script>
<script src="app.js"></script>
```

---

## 3. Codex 작업 지시 (이대로 수행)

1. 위 4개 파일을 리포지토리에 추가한다 (`public/js/toc/*` 3개, 그리고
   `parseUploadedPdf.refactored.js` 는 **패치 가이드**로서 `app.js` 에 반영).

2. `app.js` 수정 :
   - **삭제** : 기존 `locateQuestionsByContent` 함수(341–580 줄 전체).
     대체는 `window.TocLocator.locate(...)`.
   - **교체** : 기존 `parseUploadedPdf` 전체(1076–1264 줄)를
     `parseUploadedPdf.refactored.js` 의 `parseUploadedPdf` / `parseWithGemini`
     / `buildGeminiPrompt` / `registerTocParsers` 네 함수로 치환.
   - **추가** : 애플리케이션 부팅 지점 (예: `initApiKey()` 호출 다음) 에
     `registerTocParsers();` 1 줄 호출.
   - 기존 파서 함수 7개 (`parseGroupedAuditToc`, `parseAuditToc`,
     `parseOfficerToc`, `parseDottedToc`, `parseTableToc`,
     `parseQuestionsHeuristic`, `parseReceiptToc`) 는 **본문 수정 금지**.

3. **레이아웃 파서의 업무 상수 외부화 (defaults 주입)** — 필수 작업 :

   현행 `parseGroupedAuditToc` 안쪽에 다음과 같은 블록이 있다 :
   ```js
   items.push({
     id: qId,
     team: "재정복지과",                    // ← 레이아웃 파서에 업무 상수가 박힘
     category: lastCategory || "재무결산 질의",
     ...
   });
   ```
   이것은 **"이 레이아웃 = 재정복지과 결산 심사 문서"** 라는 전제로 짜여 있어,
   같은 레이아웃을 다른 부서가 쓰면 전부 재정복지과로 찍히고, 다른 부서 지원
   요청이 들어오면 `parseGroupedAuditTocEducation` 같은 식으로 **파서가 복제**된다.
   이는 "하나의 레이아웃 = 하나의 파서" 원칙을 깨뜨리는 가장 큰 위험 요소다.

   조치 :
   - `parseGroupedAuditToc` 시그니처에 세 번째 인자 `opts = {}` 를 추가하고,
     내부의 `team: "재정복지과"` / `lastCategory || "재무결산 질의"` 를
     각각 `opts.defaultTeam ?? "재정복지과"` / `lastCategory || opts.defaultCategory || "재무결산 질의"` 로 바꾼다.
     (**기본값은 유지** → 기존 호출부·기존 PDF 는 그대로 동작한다.)
   - 같은 패턴을 `parseAuditToc`, `parseOfficerToc` 등 **레이아웃 본문에 업무 상수를 박아 둔 파서 전부**에 적용한다 (638·889·977 라인 주변을 검색).
   - `tocParsers.js` 의 레지스트리 등록 지점에서 옵션을 주입한다 :
     ```js
     {
       name: "groupedAudit",
       detect: isGroupedAuditToc,
       parse: adapt((pt, st) => parseGroupedAuditToc(pt, st, {
         defaultTeam:     "재정복지과",
         defaultCategory: "재무결산 질의",
       })),
     },
     ```
   - 이렇게 되면 **다른 부서·다른 양식이 같은 레이아웃으로 내려올 때** 파서 복제
     대신 레지스트리에 "같은 파서 + 다른 defaults" 한 줄만 추가하면 된다.
   - 디버깅 효용 : "이 PDF 가 왜 재정복지과로 찍혔지?" 가 레지스트리 한 곳만
     보면 즉시 추적된다.

4. 선택 개선 (여유되면 적용) :
   - 기존 파서 7개의 반복되는 `settle:'', explain:'', attach:'', opinion:''` 리터럴을
     `window.TocParsers.makeItem({...})` 호출로 치환.  이 작업은 **파서 1개씩**
     분리된 커밋으로 올리고, 각 커밋마다 샘플 PDF 1종으로 수동 확인한다.
   - `parseTableToc` 내부의 200자 `rowPattern` 을 "물음표 split → 조각별 간단 매칭"
     2단계로 재작성. 본 리팩터링의 범위 밖이므로 별도 PR 로 다룬다.

5. 수용 기준 (Acceptance) :
   - 아래 샘플 PDF 들이 **리팩터링 전후로 동일한 `currentItems` 를 산출**해야 한다.
     각 PDF 로드 직후 `console.table(currentItems.map(i => ({id:i.id, title:i.title.slice(0,20), docPage:i.docPage, startPdfPage:i.startPdfPage})))` 결과를 캡처해 비교:
       · 그룹형 감사 (요구자료 n건 선언 양식)
       · 일반 감사 (의원 컬럼 포함)
       · 리더-닷 TOC
       · 4열 재무결산 TOC (부록 자산/부채/… 섹션 포함)
       · Gemini 로만 풀리던 교육청 양식 (API 키 있을 때)
       · 수감자료 (`documentType === 'receipt'`)
   - `console.table(res.diagnostics)` 에 선택된 파서 이름이 하나는 `ok:true`
     로 찍혀야 한다.

6. 후속 작업 (이 PR 범위 밖, 이슈로만 열어 둘 것) :
   - 각 파서별 픽스처(JSON) 디렉토리 `tests/fixtures/toc/*.json` 생성 및
     Vitest/Jest 로 스냅샷 테스트 추가.
   - `console.log / console.warn` 을 `diag` 수집기로 바꿔 디버그 패널에 노출.
   - `parseTableToc` 정규식 2단계 분해.

---

## 4. 리스크와 완화

- **리스크 1 — 파서 등록 순서 변경** : 현재 폴백 순서는
  `groupedAudit → audit → officerTable → dottedLeader → fourColTable → aiGemini → heuristic`
  로 **기존 코드와 동일**하게 맞췄다. 변경 시 매칭 결과가 바뀔 수 있으니
  수용 기준의 샘플 PDF 세트로 반드시 비교한다.
- **리스크 2 — structure-error 즉시 중단** : `parseGroupedAuditToc` 가 던지는
  "n건 중 m건만 읽었습니다" 에러는 기존에도 사용자에게 보여야 했던 값이다.
  리팩터링 후엔 `res.error` 로 올라오고, `parseUploadedPdf` 안에서
  `alert(res.error)` 로 노출되므로 UX 는 동등하다.
- **리스크 3 — 입력 mutation 제거** : 기존 `item.title = pureTitle`(399 줄)
  이 사라진다. `locate()` 가 반환하는 복사본에만 정화된 title 이 담긴다.
  호출부 (`currentItems = ...`) 는 반환값만 사용하므로 영향 없음.
- **리스크 4 — defaults 기본값 유지 원칙** : `opts.defaultTeam ?? "재정복지과"` 와
  같이 **nullish 병합 연산자**로 기본값을 유지한다. 레지스트리에서 defaults 를
  주입하지 않더라도 기존 거동과 동일해야 한다. 이 원칙이 깨지면 기존 PDF 가
  빈 team 으로 찍혀서 UI 의 부서 필터가 먹통이 된다.

---

## 5. 요약

- **"예외 하나 = if 하나"** 모델을 **"예외 하나 = 파서 하나 + 레지스트리 한 줄"** 로 바꾼다.
- **242줄 locator 를 5개 함수** 로 쪼개 디버깅과 테스트 가능성을 확보한다.
- **기존 7개 파서 구현은 거의 수정 0줄**. 어댑터로 감싸서 등록만 바꾸고, 
  레이아웃 파서에 박혀 있던 업무 상수만 `opts` 인자로 외부화한다 (기본값 유지 → 기존 거동 그대로).
- 작업 범위는 app.js 1곳 교체 + 신규 3 파일 추가 + 1 줄 초기화. 
