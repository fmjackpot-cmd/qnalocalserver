// tocParsers.js
// ---------------------------------------------------------------------------
// 목적:
//   각 TOC 레이아웃 파서를 "detect + parse" 한 쌍의 레지스트리로 관리한다.
//   오케스트레이터 runTocParsers 는 등록 순서대로 detect 가 true 인 파서만 호출하고,
//   첫 번째 성공을 결과로 쓴다.  폴백 체인이 더 이상 두 군데(parseQuestionsHeuristic,
//   parseUploadedPdf)에 중복으로 존재하지 않는다.
//
// 반환 타입 (모든 파서 공통) :
//   { ok: true,  items }                 — 성공
//   { ok: false, reason: 'no-match'      — 이 레이아웃이 아님 (조용히 다음 파서로)
//                      | 'structure-error',
//     message? }
//
// 기존 app.js 의 parser 함수들(parseGroupedAuditToc, parseAuditToc,
// parseOfficerToc, parseDottedToc, parseTableToc, parseQuestionsHeuristic,
// parseReceiptToc)는 그대로 둔 채, 얇은 어댑터로 감싸 등록한다.
//
// 로드:
//   <script src="tocConstants.js"></script>
//   <script src="tocParsers.js"></script>
//   const res = await TocParsers.run(pageTexts, structure, ctx);
// ---------------------------------------------------------------------------
(function (global) {
  'use strict';
  const { EMPTY_REFS } = global.TocConst;

  // -----------------------------------------------------------------------
  // 스키마 팩토리 — 모든 파서는 반드시 이걸로 item 을 만든다.
  // '{settle:"", explain:"", ...}' 를 매 파서가 반복하던 보일러플레이트 제거.
  // -----------------------------------------------------------------------
  function makeItem(fields) {
    return Object.assign({
      id: 0,
      categoryNumber: null,
      team: '',
      category: '일반',
      officer: '',
      title: '',
      docPage: '',
      startPdfPage: null,
      tocPage: 1
    }, EMPTY_REFS, fields || {});
  }

  // Gemini/수동 파서 결과를 공통 스키마로 정규화 (기존 1226~1248 로직)
  function normalizeItem(item, idx) {
    const rawId = item.id !== undefined ? item.id : (item.no || item.num || item.order);
    const parsedId = parseInt(rawId, 10);
    const validId = (!isNaN(parsedId) && parsedId > 0) ? parsedId : (idx + 1);
    return makeItem({
      id: validId,
      categoryNumber: Number(item.categoryNumber) || null,
      team: (item.team || item.department || '').trim(),
      category: (item.category || item.team || '일반').trim(),
      officer: (item.officer || item.author || '').trim(),
      title: (item.title || '').trim(),
      docPage: item.docPage ? String(item.docPage).trim() : '',
      startPdfPage: item.startPdfPage || null,
      tocPage: item.tocPage || 1,
      settle: item.settle ? String(item.settle).trim() : '',
      explain: item.explain ? String(item.explain).trim() : '',
      attach: item.attach ? String(item.attach).trim() : '',
      opinion: item.opinion ? String(item.opinion).trim() : ''
    });
  }

  // 결과 헬퍼
  const ok = (items) => ({ ok: true, items });
  const fail = (reason, message) => ({ ok: false, reason, message: message || '' });

  // -----------------------------------------------------------------------
  // 어댑터 : 기존 "빈 배열 반환 / throw" 파서를 통일 타입으로 포장.
  //   - 빈 배열 → no-match
  //   - throw   → structure-error
  //   - 비었지만 "요구건수 선언"이 있었던 parseGroupedAuditToc 의 경우는
  //     throw 가 유지되어 structure-error 로 전달된다 (사용자에게 alert 가능).
  // -----------------------------------------------------------------------
  function adapt(fn) {
    return function (pageTexts, structure) {
      try {
        const items = fn(pageTexts, structure);
        if (!items || items.length === 0) return fail('no-match');
        return ok(items);
      } catch (e) {
        return fail('structure-error', e && e.message);
      }
    };
  }

  // -----------------------------------------------------------------------
  // detect 헬퍼 : parse 를 한 번 더 돌리지 않도록 가벼운 사전점검만 한다.
  //              애매하면 true 를 돌려 parse 가 no-match 로 가게 두어도 OK.
  // -----------------------------------------------------------------------
  function hasReceiptMarker(_pageTexts, _structure, ctx) {
    return ctx && ctx.documentType === 'receipt';
  }
  function hasGroupedAuditHint(pageTexts) {
    // 기존 isGroupedAuditToc(line text) 와 동일 성격의 전역 확인
    const joined = (pageTexts || []).map((p) => p.text || '').join('\n');
    return /(?:공통\s*질의|요구자료)\b/.test(joined) &&
           /(?:\d+\s*건\s*\))/.test(joined);
  }
  function always() { return true; }

  // -----------------------------------------------------------------------
  // 레지스트리 — 순서가 곧 폴백 우선순위.
  // app.js 가 이 모듈을 로드한 뒤 TocParsers.register() 로 실제 파서들을
  // 연결한다.  이렇게 하면 레지스트리 파일이 기존 파서 구현을 몰라도 된다.
  // -----------------------------------------------------------------------
  const registry = [];

  function register(entry) {
    // entry: { name, detect, parse, kind? }
    if (!entry || !entry.name || typeof entry.parse !== 'function') {
      throw new Error('TocParsers.register: invalid entry');
    }
    entry.detect = entry.detect || always;
    registry.push(entry);
  }
  function clear() { registry.length = 0; }
  function list() { return registry.map((e) => e.name); }

  // -----------------------------------------------------------------------
  // 오케스트레이터
  //   ctx : { documentType, geminiApiKey, onStage(name) }
  //     - documentType 은 receipt 분기에 쓰임
  //     - onStage 는 로딩 UI 문구 갱신 훅
  // -----------------------------------------------------------------------
  async function run(pageTexts, structure, ctx) {
    ctx = ctx || {};
    const diagnostics = [];
    for (const entry of registry) {
      let matches = true;
      try { matches = !!entry.detect(pageTexts, structure, ctx); }
      catch (_) { matches = false; }
      if (!matches) { diagnostics.push({ parser: entry.name, skipped: true }); continue; }

      if (typeof ctx.onStage === 'function') ctx.onStage(entry.name);
      const res = await entry.parse(pageTexts, structure, ctx);
      diagnostics.push({ parser: entry.name, ok: res.ok, reason: res.reason });
      if (res.ok) {
        const items = res.items.map(normalizeItem);
        return { items, parser: entry.name, diagnostics };
      }
      // structure-error 는 사용자에게 명시적으로 알려야 하므로 즉시 중단
      if (res.reason === 'structure-error') {
        return { items: [], parser: entry.name, error: res.message, diagnostics };
      }
    }
    return { items: [], parser: null, diagnostics };
  }

  global.TocParsers = { register, clear, list, run, adapt, makeItem, normalizeItem, ok, fail,
                        hasReceiptMarker, hasGroupedAuditHint, always };
})(typeof window !== 'undefined' ? window : globalThis);
