// tocLocator.js
// ---------------------------------------------------------------------------
// 목적:
//   기존 locateQuestionsByContent(약 240줄 단일 함수)를 다음 5단계로 쪼갠다.
//     1) buildPageIndex       : 모든 페이지의 정규화/헤더/요지 캐시 생성
//     2) normalizeItemTitle   : 입력 item mutation 없이 순수 제목·토큰 산출
//     3) scoreCandidate       : 한 (item × page) 쌍의 매치 점수 계산
//     4) pickBestPage         : 한 item에 대해 범위 안에서 최고점 페이지 선택
//     5) computeRanges        : locatedItems 전체에 endPdfPage·docPage 라벨 부여
//   오케스트레이터 locateQuestions(...)는 이 5개를 순서대로 호출한다.
//
// 외부 의존성 (기존 app.js 전역을 그대로 사용):
//   printedToPdfMap, pdfToPrintedMap   — 쪽수 ↔ PDF 페이지 매핑
//   TocConst                           — tocConstants.js 가 노출
//
// 로드:
//   <script src="tocConstants.js"></script>
//   <script src="tocLocator.js"></script>
//   window.TocLocator.locate(items, pdfDoc, pageTexts, tocPages) 호출.
// ---------------------------------------------------------------------------
(function (global) {
  'use strict';
  const { SCORING, STOPWORDS, RX } = global.TocConst;

  // -----------------------------------------------------------------------
  // 1) 페이지 인덱스 : 전 페이지의 정규화 결과를 한 번만 만들어 둔다.
  // -----------------------------------------------------------------------
  function buildPageIndex(pdfDoc, pageTexts) {
    const cache = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const rawText = pageTexts[p - 1]?.text || '';
      const cleanNoSpace = rawText.replace(RX.PUNCT_STRIP, '');
      const headerRaw = rawText.substring(0, SCORING.HEADER_SLICE);
      const headerCleanNoSpace = headerRaw.replace(RX.PUNCT_STRIP, '');
      const summaryMatch = headerRaw.match(RX.SUMMARY_BLOCK);
      const summaryClean = summaryMatch
        ? summaryMatch[1].replace(/[^가-힣a-zA-Z0-9]/g, '')
        : '';

      const nums = rawText.match(RX.TABLE_HEAVY_NUMBERS) || [];
      const isTableHeavy = RX.TABLE_HEAVY_HINT.test(rawText) && nums.length >= 5;

      cache.push({
        pageNum: p, rawText, cleanNoSpace, headerCleanNoSpace,
        summaryClean, isTableHeavy
      });
    }
    return cache;
  }

  // -----------------------------------------------------------------------
  // 2) 입력 item 을 바꾸지 않고, 매칭에 필요한 파생값만 반환.
  //    (기존 코드가 item.title 을 직접 덮어쓰던 부분을 분리한다.)
  // -----------------------------------------------------------------------
  function normalizeItemTitle(item) {
    const originalTitle = (item.title || '').trim();
    let pureTitle = originalTitle.replace(RX.TITLE_LEAD_NOISE, '').trim();
    if (!pureTitle) pureTitle = originalTitle;

    // 중기 라벨은 TOC 전용이라 본문엔 없을 수 있다.
    const matchTitle = pureTitle.replace(RX.MIDTERM_PREFIX, '');
    const titleNoSpace = matchTitle.replace(RX.PUNCT_STRIP, '');
    const tokens = matchTitle
      .replace(RX.PUNCT_STRIP, ' ')
      .split(' ')
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

    const prefixSnippet = titleNoSpace.length >= 8
      ? titleNoSpace.substring(0, Math.min(12, titleNoSpace.length))
      : titleNoSpace;
    const midSnippet = titleNoSpace.length >= 16
      ? titleNoSpace.substring(4, 14)
      : '';
    const normalizedTail = titleNoSpace.replace(/[^가-힣a-zA-Z0-9]/g, '');

    return { originalTitle, pureTitle, titleNoSpace, tokens, prefixSnippet, midSnippet, normalizedTail };
  }

  // -----------------------------------------------------------------------
  // 3) (item × page) 한 쌍의 점수.  모든 임계값은 SCORING 에서 읽는다.
  // -----------------------------------------------------------------------
  function scoreCandidate(norm, bracketRegex, pageInfo) {
    let score = 0;

    // 요지 꼬리가 TOC 제목의 꼬리와 일치 — 가장 강한 증거
    if (pageInfo.summaryClean.length >= 6 && norm.normalizedTail.endsWith(pageInfo.summaryClean)) {
      score += SCORING.SUMMARY_TAIL_MATCH;
    }
    // Tier 1 : 제목 전체 포함
    if (norm.titleNoSpace.length >= 5 && pageInfo.cleanNoSpace.includes(norm.titleNoSpace)) {
      score += SCORING.FULL_TITLE_HIT;
      if (pageInfo.headerCleanNoSpace.includes(norm.titleNoSpace)) {
        score += SCORING.HEADER_FULL_BOOST;
      }
    }
    // Tier 2 : 접두 스니펫
    if (norm.prefixSnippet.length >= 6 && pageInfo.cleanNoSpace.includes(norm.prefixSnippet)) {
      score += SCORING.PREFIX_HIT;
      if (pageInfo.headerCleanNoSpace.includes(norm.prefixSnippet)) {
        score += SCORING.HEADER_PREFIX_BOOST;
      }
    }
    // Tier 3 : 중간 스니펫
    if (norm.midSnippet.length >= 6 && pageInfo.cleanNoSpace.includes(norm.midSnippet)) {
      score += SCORING.MID_HIT;
    }
    // Tier 4 : 토큰 오버랩
    if (norm.tokens.length > 0) {
      let matchCount = 0, headerMatchCount = 0;
      for (const token of norm.tokens) {
        if (pageInfo.cleanNoSpace.includes(token)) {
          matchCount++;
          if (pageInfo.headerCleanNoSpace.includes(token)) headerMatchCount++;
        }
      }
      const ratio = matchCount / norm.tokens.length;
      if (ratio >= 0.8) score += SCORING.TOKEN_HIGH;
      else if (ratio >= 0.5) score += SCORING.TOKEN_MID;
      else if (ratio >= 0.3 && matchCount >= 2) score += SCORING.TOKEN_LOW;
      score += headerMatchCount * SCORING.TOKEN_HEADER_UNIT;
    }
    // Tier 5 : 【문항 N】 직접 매치
    if (bracketRegex.test(pageInfo.rawText)) score += SCORING.BRACKET_HIT;

    // 안티-오탐 : 숫자 과다 페이지는 헤더에 접두가 없는 한 감점
    if (pageInfo.isTableHeavy && !pageInfo.headerCleanNoSpace.includes(norm.prefixSnippet)) {
      score += SCORING.TABLE_HEAVY_PENALTY;
    }
    return score;
  }

  // -----------------------------------------------------------------------
  // 4) 한 item 에 대해 range [start..end] 를 훑으며 최고점 페이지를 고른다.
  //    - printedToPdfMap 또는 item.startPdfPage 가 있으면 바로 사용.
  //    - 조기 종료 : EARLY_BREAK_THRESHOLD 이상이면 즉시 리턴.
  // -----------------------------------------------------------------------
  function pickBestPage(item, qId, norm, pageCache, pdfDoc, prevFoundPage, searchStart, diag) {
    // 직매핑 우선
    if (item.startPdfPage && item.startPdfPage >= searchStart && item.startPdfPage <= pdfDoc.numPages) {
      diag.log(`Q${qId} direct map → PDF ${item.startPdfPage}`);
      return item.startPdfPage;
    }
    const printed = parseInt(item.docPage, 10);
    if (!isNaN(printed) && global.printedToPdfMap && global.printedToPdfMap[printed]) {
      const pg = global.printedToPdfMap[printed];
      diag.log(`Q${qId} docPage ${printed} → PDF ${pg}`);
      return pg;
    }

    const bracketRegex = new RegExp(
      '【\\s*' + qId + '\\s*】|\\[\\s*문항\\s*' + qId + '\\s*\\]|' +
      '【\\s*문항\\s*' + qId + '\\s*】|\\b문항\\s*' + qId + '\\b',
      'i'
    );

    let bestPage = null, highest = 0;
    const from = Math.max(searchStart, prevFoundPage);
    for (let p = from; p <= pdfDoc.numPages; p++) {
      const pageInfo = pageCache[p - 1];
      if (!pageInfo || pageInfo.cleanNoSpace.length < SCORING.MIN_PAGE_TEXT_LEN) continue;

      const score = scoreCandidate(norm, bracketRegex, pageInfo);
      if (score > highest) { highest = score; bestPage = p; }
      if (score >= SCORING.EARLY_BREAK_THRESHOLD) break;
    }

    if (highest >= SCORING.ACCEPT_THRESHOLD && bestPage !== null) {
      diag.log(`Q${qId} matched PDF ${bestPage} (score ${highest})`);
      return bestPage;
    }
    const fallback = Math.min(pdfDoc.numPages, prevFoundPage);
    diag.warn(`Q${qId} low score ${highest} → fallback PDF ${fallback}`);
    return fallback;
  }

  // -----------------------------------------------------------------------
  // 5) locatedItems 전체에 endPdfPage / pageCount / docPage 라벨을 부여한다.
  //    (기존 541~577 로직 그대로, 전역 pdfToPrintedMap 사용)
  // -----------------------------------------------------------------------
  function computeRanges(located, pdfDoc) {
    const map = global.pdfToPrintedMap || {};
    for (let i = 0; i < located.length; i++) {
      const curr = located[i];
      const next = located[i + 1];
      if (next && next.startPdfPage > curr.startPdfPage) {
        curr.endPdfPage = next.startPdfPage - 1;
      } else if (next && next.startPdfPage === curr.startPdfPage) {
        curr.endPdfPage = curr.startPdfPage;
      } else {
        curr.endPdfPage = pdfDoc.numPages;
      }
      curr.pageCount = Math.max(1, curr.endPdfPage - curr.startPdfPage + 1);

      let startPrinted = map[curr.startPdfPage];
      if (!startPrinted) {
        for (let sp = curr.startPdfPage; sp <= curr.endPdfPage; sp++) {
          if (map[sp]) { startPrinted = map[sp]; break; }
        }
      }
      if (!startPrinted) startPrinted = curr.docPage || curr.startPdfPage;

      let endPrinted = map[curr.endPdfPage];
      if (!endPrinted) {
        for (let ep = curr.endPdfPage; ep >= curr.startPdfPage; ep--) {
          if (map[ep]) { endPrinted = map[ep]; break; }
        }
      }
      if (!endPrinted) endPrinted = startPrinted;

      curr.docPage = (startPrinted !== endPrinted)
        ? `${startPrinted}~${endPrinted}` : `${startPrinted}`;
      curr.physicalPageLabel = (curr.startPdfPage === curr.endPdfPage)
        ? `PDF ${curr.startPdfPage}p`
        : `PDF ${curr.startPdfPage}~${curr.endPdfPage}p`;
    }
    return located;
  }

  // -----------------------------------------------------------------------
  // 오케스트레이터 — 기존 locateQuestionsByContent 를 대체.
  // -----------------------------------------------------------------------
  function locate(items, pdfDoc, pageTexts, detectedTocPages, diag) {
    if (!items || items.length === 0) return [];
    diag = diag || { log(){}, warn(){} };

    const lastToc = (detectedTocPages && detectedTocPages.length > 0)
      ? Math.max(...detectedTocPages) : 0;
    let searchStart = Math.max(1, lastToc + 1);
    while (
      searchStart <= pdfDoc.numPages &&
      (pageTexts[searchStart - 1]?.text || '').replace(/[^가-힣a-zA-Z0-9]/g, '').length
        < SCORING.BLANK_TRANSITION_LEN
    ) {
      searchStart++;
    }

    const pageCache = buildPageIndex(pdfDoc, pageTexts);
    const located = [];
    let prev = searchStart;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const qId = Number(item.id) || (i + 1);
      const norm = normalizeItemTitle(item);
      const foundPage = pickBestPage(item, qId, norm, pageCache, pdfDoc, prev, searchStart, diag);
      prev = foundPage;
      // 입력을 바꾸지 않는다 — 정화된 title 을 복사본에만 반영
      located.push({ ...item, id: qId, title: norm.pureTitle, startPdfPage: foundPage });
    }

    return computeRanges(located, pdfDoc);
  }

  global.TocLocator = { locate, buildPageIndex, normalizeItemTitle, scoreCandidate, pickBestPage, computeRanges };
})(typeof window !== 'undefined' ? window : globalThis);
