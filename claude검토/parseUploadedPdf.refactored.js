// parseUploadedPdf.refactored.js
// ---------------------------------------------------------------------------
// 적용 위치 : app.js 내부의 async function parseUploadedPdf(...) 블록 전체를
//            아래 내용으로 교체한다 (1076~1264 줄).  그리고 파일 맨 아래쪽
//            IIFE 의 registerTocParsers() 호출을 app.js 초기화 흐름에
//            한 번만 넣어둔다 (예: initApiKey 다음).
//
// 전제 : tocConstants.js, tocParsers.js, tocLocator.js 가 이미 로드되어 있다.
//        기존 파서 함수(parseGroupedAuditToc, parseAuditToc, parseOfficerToc,
//        parseDottedToc, parseTableToc, parseQuestionsHeuristic,
//        parseReceiptToc) 는 손대지 않고 그대로 둔다 — 어댑터로 감싸서 등록.
// ---------------------------------------------------------------------------

// ── 1) 애플리케이션 부팅 시 1회 호출 : 레지스트리 조립 ────────────────
function registerTocParsers() {
  const T = window.TocParsers;
  T.clear();

  // 수감자료 (별도 규격) : documentType === 'receipt' 일 때만
  T.register({
    name: 'receipt',
    detect: T.hasReceiptMarker,
    parse: function (pageTexts) {
      const parsed = parseReceiptToc(pageTexts);   // 기존 함수
      // parseReceiptToc 는 {items, tocPages} 를 돌려주므로 tocPages 를 보존하기
      // 위해 items 에 tocPagesOverride 를 심는 방식 대신, run() 호출부에서
      // 별도로 가져다 쓴다.  여기서는 items 만 전달.
      if (!parsed || !parsed.items || !parsed.items.length) return T.fail('no-match');
      return T.ok(parsed.items);
    }
  });

  // 그룹형 감사 TOC (요구자료 건수 선언이 있는 양식)
  T.register({
    name: 'groupedAudit',
    detect: T.hasGroupedAuditHint,
    parse: T.adapt(parseGroupedAuditToc)
  });

  // 일반 감사 TOC
  T.register({ name: 'audit',       parse: T.adapt(parseAuditToc) });
  // 담당자/의원 컬럼이 선명한 TOC
  T.register({ name: 'officerTable', parse: T.adapt(parseOfficerToc) });
  // 리더-닷 ( …… 123 ) 스타일
  T.register({ name: 'dottedLeader', parse: T.adapt(parseDottedToc) });
  // 4열 표 (재무결산)
  T.register({ name: 'fourColTable', parse: T.adapt(parseTableToc) });

  // Gemini AI — API 키가 있을 때만 시도
  T.register({
    name: 'aiGemini',
    detect: () => !!geminiApiKey,
    parse: async function (pageTexts, structure) {
      try {
        const items = await parseWithGemini(pageTexts, structure);   // 아래에서 분리
        return items && items.length ? T.ok(items) : T.fail('no-match');
      } catch (e) {
        return T.fail('no-match', e && e.message);  // 폴백 유지
      }
    }
  });

  // 최후 폴백 : 휴리스틱 파서 (항상 돌되, 빈 배열이면 no-match)
  T.register({ name: 'heuristic', parse: T.adapt(parseQuestionsHeuristic) });
}

// ── 2) Gemini 호출을 함수 하나로 분리 (기존 1105~1204 인라인 블록) ────
async function parseWithGemini(pageTexts, structure) {
  const targetPageNums = structure.tocPages.length > 0
    ? structure.tocPages
    : [1, 2, 3, 4].filter((p) => p <= pageTexts.length);

  let contextText = '';
  for (const p of targetPageNums) {
    contextText += `\n--- [PDF Page ${p}] ---\n` + (pageTexts[p - 1]?.text || '');
  }

  const prompt = buildGeminiPrompt(contextText);  // ← 프롬프트도 별도 함수
  const candidateModels = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest'];

  for (const modelName of candidateModels) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        })
      });
      if (!response.ok) continue;

      const data = await response.json();
      let rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      rawReply = rawReply.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(rawReply);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`Gemini(${modelName}) parsed ${parsed.length} questions`);
        return parsed;
      }
    } catch (e) {
      console.warn(`Gemini(${modelName}) failed:`, e.message);
    }
  }
  return [];
}

function buildGeminiPrompt(contextText) {
  // 60줄짜리 프롬프트를 데이터로 분리 — 수정 시 이 함수만 건드린다.
  return `당신은 공공기관/교육청 결산 및 행정감사 질의서 분석 전문가입니다.
제공된 텍스트는 PDF 문서의 앞부분(목차 및 관련 페이지) 텍스트입니다.

[중요 파싱 규칙]:
1. id 필드: 전체 질의의 고유 순번(1부터 시작).  categoryNumber: 카테고리별 번호가 따로 있으면 보존, 없으면 null.
2. title 필드: 번호·기호·의원명·팀명을 제외한 순수 제목 전문.
3. category 필드: 목차 표 좌측 컬럼의 부서·주제명을 우선. 질의 유형(공통/현안 등) 사용 금지.
4. team 필드: 팀명.
5. officer 필드: 의원명/언론/현안 등 (없으면 "").
6. docPage 필드: '쪽수' 컬럼의 시작 쪽수.
7. 목차에 '결산서 쪽수' 등 명시적 컬럼이 없으면 settle/explain/attach/opinion 은 반드시 "".
8. 순수 JSON 배열만 반환. 마크다운 코드블록 금지.

[문서 텍스트]:
${contextText}
`;
}

// ── 3) 180줄짜리 parseUploadedPdf 를 아래 40여 줄로 축약 ──────────────
async function parseUploadedPdf(pdfDoc, fileName) {
  const overlay = document.getElementById('ai-loading-overlay');
  const title   = document.getElementById('ai-loading-title');
  const desc    = document.getElementById('ai-loading-desc');
  if (overlay) overlay.style.display = 'flex';
  if (title) title.innerText = 'PDF 전체 텍스트 및 구조 분석 중...';
  if (desc)  desc.innerText  = '문서의 표지, 목차, 질문 목록 및 본문 쪽수를 정밀 스캔하고 있습니다.';

  const pageTexts = await extractAllPagesText(pdfDoc);

  // 수감자료는 receipt 파서만 돌고 바로 끝낸다 (기존 분기 보존)
  if (currentDocumentType === 'receipt') {
    const parsed = parseReceiptToc(pageTexts);
    currentItems = parsed.items;
    tocPages = parsed.tocPages;
    if (overlay) overlay.style.display = 'none';
    return;
  }

  const structure = analyzeDocumentStructure(pageTexts);
  tocPages = structure.tocPages;

  // 파서 레지스트리 실행 — 폴백 체인이 여기 한 곳에 명시적으로 존재한다
  const res = await window.TocParsers.run(pageTexts, structure, {
    documentType: currentDocumentType,
    geminiApiKey,
    onStage: (name) => {
      if (title) title.innerText = `목차 해석 중 (${name})...`;
    }
  });

  if (res.error) {
    if (overlay) overlay.style.display = 'none';
    alert(res.error);        // parseGroupedAuditToc 가 던지던 메시지가 여기로
    return;
  }
  console.table(res.diagnostics);   // 어느 파서가 뽑혔는지 즉시 확인 가능

  let rawItems = res.items;
  // 아무 파서도 못 뽑았을 때 : 페이지당 더미 아이템 (기존 1205~1223 로직)
  if (!rawItems.length) {
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      rawItems.push(window.TocParsers.makeItem({
        id: p, category: '문서 내용',
        title: `${p}쪽 내용`, docPage: `${p}`, startPdfPage: p
      }));
    }
  }

  if (title) title.innerText = '실제 PDF 본문 페이지 위치 매핑 중...';
  if (desc)  desc.innerText  = '각 문항의 실제 시작 및 끝 페이지를 정밀 매칭하고 있습니다.';

  const diag = { log: (m) => console.log(m), warn: (m) => console.warn(m) };
  currentItems = window.TocLocator.locate(rawItems, pdfDoc, pageTexts, structure.tocPages, diag);
  tocPages = structure.tocPages.length > 0 ? structure.tocPages : [1];

  if (overlay) overlay.style.display = 'none';
}
