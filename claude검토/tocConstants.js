// tocConstants.js
// ---------------------------------------------------------------------------
// 목적:
//   app.js 전역에 흩어져 있던 "매직 넘버 / 정규식 / 사전"을 한 곳으로 모은다.
//   파서 추가·수정 시 이 파일만 열면 임계값과 어휘를 바꿀 수 있어야 한다.
// 로드:
//   <script src="tocConstants.js"></script>  (app.js 보다 먼저)
//   window.TocConst 로 노출.
// ---------------------------------------------------------------------------
(function (global) {
  'use strict';

  // 스코어링 임계값 (기존 locateQuestionsByContent 내부 하드코딩 값)
  const SCORING = {
    SUMMARY_TAIL_MATCH: 1600,   // 본문 요지 꼬리와 제목 끝이 일치
    FULL_TITLE_HIT:     1000,   // 제목 전체가 본문에 통째로 포함
    HEADER_FULL_BOOST:   500,   // 위의 매치가 페이지 상단에 있을 때
    PREFIX_HIT:          400,   // 앞 8~12자 접두 일치
    HEADER_PREFIX_BOOST: 300,
    MID_HIT:             250,
    TOKEN_HIGH:          400,   // 토큰 매치율 >= 0.8
    TOKEN_MID:           250,   // >= 0.5
    TOKEN_LOW:           120,   // >= 0.3 && count >= 2
    TOKEN_HEADER_UNIT:   100,
    BRACKET_HIT:         400,   // 【문항 N】 등 번호 패턴
    TABLE_HEAVY_PENALTY: -500,

    EARLY_BREAK_THRESHOLD: 1200, // 한 페이지에서 이 점수 이상이면 이후 페이지 탐색 중단
    ACCEPT_THRESHOLD:       220, // 이 미만이면 이전 위치로 fallback
    MIN_PAGE_TEXT_LEN:       20, // 이보다 짧은 페이지는 스킵
    BLANK_TRANSITION_LEN:    15, // TOC 직후 이보다 짧으면 "빈 전이 페이지"
    HEADER_SLICE:           600  // 페이지 상단으로 간주할 문자 수
  };

  // 제목 토큰 추출 시 제외할 상투어
  const STOPWORDS = new Set([
    '현황은', '사유는', '대책은', '계획은', '의견은', '방안은',
    '최근', '대한', '관련', '따른', '기준', '운영', '지원',
    '내역은', '이유는', '결과는', '사업', '추진', '어떠한가', '무엇인가'
  ]);

  // 수감자료/재무결산 부록 섹션 식별 키워드
  const APPENDIX_KEYWORDS = ['자산', '부채', '수익', '비용', '법령', '용어'];

  // 공통 정규식 — 유지보수 지점을 분산시키지 않는다
  const RX = {
    // 문장부호·공백을 전부 걷어낼 때 (제목/본문 정규화 공용)
    PUNCT_STRIP: /[\s\(\)\[\]\.\,\?\!\-_·ㆍ•「」『』<>\/\\~○●■▶◆\:\;]/g,

    // 제목 선두에 붙은 번호/기호 노이즈
    TITLE_LEAD_NOISE: /^(?:【\s*(?:문항\s*)?\d+\s*】|\[\s*문항\s*\d+\s*\]|\d{1,3}[.)]\s+)?\s*[○●■▶]?\s*/,

    // 목차 페이지 식별
    TOC_TITLES: /목\s*차|차\s*례|질의\s*순서|질의\s*목록/i,

    // 본문의 "질의요지 … 답변내용" 블록 (요지 꼬리 추출용)
    SUMMARY_BLOCK: /질\s*의\s*요\s*지\s*([\s\S]{3,300}?)\s*답\s*변\s*내\s*용/,

    // 표·수치 과다 페이지 판정 (TABLE_HEAVY_PENALTY 적용 대상)
    TABLE_HEAVY_HINT: /(?:위원회명|집행률|예산액|집행액|불용액|천원|\b\d{1,3},\d{3}\b)/,
    TABLE_HEAVY_NUMBERS: /\b\d{1,3},\d{3}\b/g,

    // 의원·언론·현안 등 질의자 태그
    OFFICER_TAG: /([가-힣]{2,4}\s*의원|언론|현안)/,

    // 중기 라벨은 본문 제목에서 떨어지므로 매칭용 변형에서 제거
    MIDTERM_PREFIX: /^\(\s*중기\s*\)\s*/
  };

  // 비어있는 참조 쪽수 필드 (거의 모든 파서가 공통으로 쓴다)
  const EMPTY_REFS = Object.freeze({
    settle: '', explain: '', attach: '', opinion: ''
  });

  global.TocConst = { SCORING, STOPWORDS, APPENDIX_KEYWORDS, RX, EMPTY_REFS };
})(typeof window !== 'undefined' ? window : globalThis);
