/* Google Support bulk → Sheet (Topic recursion + Upsert)
 * Sheets:
 *  - Articles: title | link | pubDate | description | guid
 *  - Queue: type(topic|answer) | url | status(pending|done) | ts
 *
 * Menu:
 *  - Support2Sheet → Seed from topic URL
 *  - Support2Sheet → Crawl step (N items)
 */

const ARTICLES_SHEET = 'Articles';
const QUEUE_SHEET = 'Queue';
const DEFAULT_LANG = 'ko';

const VERSION = 'bulk-2025-11-03';

// ===== Utilities =====
function md5hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s)
    .map(b => (b + 256) % 256).map(b => b.toString(16).padStart(2, '0')).join('');
}

function decodeAllEntities(s) {
  if (!s) return '';
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/gi, ' ');
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d,10)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h,16)));
  s = s.replace(/&([a-zA-Z]+);/g, (m, name) => (named[name] ?? m));
  return s;
}

function unescapeJsonEscapes_(html) {
  if (!html) return '';
  return html.replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>')
             .replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/')
             .replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function normalizeLink(u, lang) {
  try {
    const safe = decodeAllEntities(u).trim();
    let x = safe;
    if (/^\.\.\//.test(x)) x = '/a/' + x.replace(/^(\.\.\/)+/, '');
    else if (/^\/\//.test(x)) x = 'https:' + x;
    const url = new URL(x, 'https://support.google.com');
    url.searchParams.delete('ref_topic');
    if (lang) url.searchParams.set('hl', lang);
    if (url.protocol === 'mailto:') return url.toString();
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  } catch { return u; }
}

function htmlToText(html, lang) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
    const text = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const rawHref = decodeAllEntities(href).trim();
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('?') || /^javascript:/i.test(rawHref)) return text || '';
    const full = normalizeLink(rawHref, lang);
    return text ? `${text} (${full})` : full;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
       .replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '')
       .replace(/<\/h[1-6]>/gi, '\n\n').replace(/<h[1-6][^>]*>/gi, '\n')
       .replace(/<\/tr>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<t[dh][^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeAllEntities(s).replace(/\t/g, '  ').replace(/[ \u00A0]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function parseAnswerPage(html, lang) {
  const t1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const rawTitle = t1 ? t1[1] : 'Support article';
  const b1 = html.match(/<article[\s\S]*?class="[^"]*?article-container[^"]*?"[\s\S]*?>([\s\S]*?)<\/article>/i) ||
             html.match(/<div[^>]+class="[^"]*\bcc\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const rawBody = b1 ? b1[1] : html;
  const title = htmlToText(rawTitle, lang);
  const textBody = htmlToText(rawBody, lang);
  return { title, text: textBody };
}

// ===== Link extraction (answers + topics) =====
function extractLinks_(rawHtml, lang, maxAnswers=200, maxTopics=200) {
  const html = unescapeJsonEscapes_(rawHtml);
  const PATH_ANS = String.raw`\/(?:[a-z0-9-]+\/)*(?:a\/)?answer\/\d+`;
  const PATH_TOP = String.raw`\/(?:[a-z0-9-]+\/)*(?:a\/)?topic\/\d+`;
  const ABS = (p)=>String.raw`https:\/\/support\.google\.com${p}`;

  const patterns = [
    new RegExp(`(["'])?(${PATH_ANS}[^"'<\\s]*)\\1`, 'g'),
    new RegExp(`(["'])?(${PATH_TOP}[^"'<\\s]*)\\1`, 'g'),
    new RegExp(`(["'])?(${ABS(PATH_ANS)}[^"'<\\s]*)\\1`, 'g'),
    new RegExp(`(["'])?(${ABS(PATH_TOP)}[^"'<\\s]*)\\1`, 'g'),
    // href / data-href
    new RegExp(`<a[^>]+href="(${PATH_ANS}[^"]*|${ABS(PATH_ANS)}[^"]*)"[^>]*>`, 'gi'),
    new RegExp(`<a[^>]+href="(${PATH_TOP}[^"]*|${ABS(PATH_TOP)}[^"]*)"[^>]*>`, 'gi'),
    new RegExp(`data-href="(${PATH_ANS}[^"]*|${ABS(PATH_ANS)}[^"]*)"`, 'gi'),
    new RegExp(`data-href="(${PATH_TOP}[^"]*|${ABS(PATH_TOP)}[^"]*)"`, 'gi'),
  ];

  const seenA = new Set(), seenT = new Set();
  const answers = [], topics = [];
  const ABS_ANS = /^https:\/\/support\.google\.com\/(?:[a-z0-9-]+\/)*(?:a\/)?answer\/\d+/i;
  const ABS_TOP = /^https:\/\/support\.google\.com\/(?:[a-z0-9-]+\/)*(?:a\/)?topic\/\d+/i;

  function normPush(u, isAnswer) {
    if (isAnswer && answers.length >= maxAnswers) return;
    if (!isAnswer && topics.length >= maxTopics) return;
    const full = normalizeLink(u.replace(/&amp;/g,'&'), DEFAULT_LANG);
    if (isAnswer) {
      if (!ABS_ANS.test(full) || seenA.has(full)) return;
      seenA.add(full); answers.push(full);
    } else {
      if (!ABS_TOP.test(full) || seenT.has(full)) return;
      seenT.add(full); topics.push(full);
    }
  }

  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(html))) {
      const link = m[2] || m[1];
      if (!link) continue;
      if (/\/answer\/\d+/.test(link)) normPush(link, true);
      else if (/\/topic\/\d+/.test(link)) normPush(link, false);
      if (answers.length >= maxAnswers && topics.length >= maxTopics) break;
    }
  }
  return { answers, topics };
}

// ===== Sheets helpers =====
function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const cur = sh.getRange(1,1,1,headers.length).getValues()[0];
  if (cur.join('') === '' || cur.some((v,i)=>v!==headers[i])) {
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  }
  return sh;
}

function queueAdd_(type, url) {
  const sh = ensureSheet_(QUEUE_SHEET, ['type','url','status','ts']);
  const last = sh.getLastRow();
  // dedupe: if already pending/done, skip
  const range = last>1 ? sh.getRange(2,1,last-1,2).getValues() : [];
  const exists = range.some(r => r[0]===type && r[1]===url);
  if (exists) return false;
  sh.appendRow([type, url, 'pending', new Date()]);
  return true;
}

function queuePopBatch_(limit=20) {
  const sh = ensureSheet_(QUEUE_SHEET, ['type','url','status','ts']);
  const last = sh.getLastRow();
  if (last <= 1) return [];
  const rows = sh.getRange(2,1,last-1,4).getValues();
  const out = [];
  for (let i=0;i<rows.length && out.length<limit;i++) {
    if (rows[i][2] === 'pending') out.push({row:i+2, type:rows[i][0], url:rows[i][1]});
  }
  // mark as in-progress
  out.forEach(it => sh.getRange(it.row, 3).setValue('in-progress'));
  return out;
}

function queueMarkDone_(rows) {
  const sh = ensureSheet_(QUEUE_SHEET, ['type','url','status','ts']);
  rows.forEach(r => sh.getRange(r, 3).setValue('done'));
}

function upsertArticles_(items) {
  if (!items || !items.length) return {updated:0, inserted:0};
  const sh = ensureSheet_(ARTICLES_SHEET, ['title','link','pubDate','description','guid']);
  const last = sh.getLastRow();
  const map = new Map();
  if (last>1) {
    const guids = sh.getRange(2,5,last-1,1).getValues().map(r=>String(r[0]||''));
    guids.forEach((g,i)=>{ if (g) map.set(g, i+2); });
  }
  let upd=0, ins=0;
  items.forEach(it=>{
    const row = [it.title||'', it.link||'', it.pubDate||'', it.description||'', it.guid||''];
    if (map.has(it.guid)) {
      sh.getRange(map.get(it.guid), 1, 1, 5).setValues([row]); upd++;
    } else {
      sh.appendRow(row); ins++;
    }
  });
  return {updated:upd, inserted:ins};
}

// ===== Core fetchers =====
function fetchHtml_(url, lang=DEFAULT_LANG) {
  const resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (AppsScript)', 'Accept-Language': `${lang},en;q=0.7` }
  });
  return resp.getContentText('UTF-8');
}

function parseAnswerToItem_(url, html, lang=DEFAULT_LANG) {
  const now = new Date().toUTCString();
  const { title, text } = parseAnswerPage(html, lang);
  return { title, link: normalizeLink(url, lang), pubDate: now, description: text, guid: md5hex(url + text) };
}

// ===== Public flows =====
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Support2Sheet')
    .addItem('Seed from topic URL', 'menuSeedFromPrompt_')
    .addItem('Crawl step (N items)', 'menuCrawlStepPrompt_')
    .addToUi();
}

function menuSeedFromPrompt_() {
  const ui = SpreadsheetApp.getUi();
  const url = ui.prompt('Seed topic URL', '예) https://support.google.com/a#topic=4388346', ui.ButtonSet.OK_CANCEL).getResponseText();
  if (!url) return;
  seedFromTopic_(url, DEFAULT_LANG);
  ui.alert('큐에 시드 완료. 이제 "Crawl step"을 실행하세요.');
}

function menuCrawlStepPrompt_() {
  const ui = SpreadsheetApp.getUi();
  const n = Number(ui.prompt('처리 개수', '한 번에 처리할 큐 아이템 수 (예: 20)', ui.ButtonSet.OK_CANCEL).getResponseText() || '20');
  const res = crawlStep_(DEFAULT_LANG, Math.max(1, Math.min(100, n)));
  ui.alert(`처리 완료\nanswers: ${res.answers}\ntopics: ${res.topics}\ninserted: ${res.inserted}\nupdated: ${res.updated}\npending left: ${res.pending}`);
}

// 최초 시드: 토픽 URL에서 answers+topics 추출 → 큐에 추가
function seedFromTopic_(topicUrl, lang=DEFAULT_LANG) {
  const html = fetchHtml_(topicUrl, lang);
  const { answers, topics } = extractLinks_(html, lang, 500, 500);
  topics.forEach(u=>queueAdd_('topic', u));
  answers.forEach(u=>queueAdd_('answer', u));
  // 시드한 첫 토픽도 큐에 넣어 재귀 진행되게
  queueAdd_('topic', normalizeLink(topicUrl, lang));
}

// 한 스텝: 큐에서 N개 꺼내 처리 (topic은 재귀 확장, answer는 파싱/업서트)
function crawlStep_(lang=DEFAULT_LANG, batchSize=20) {
  const batch = queuePopBatch_(batchSize);
  let cntAns=0, cntTop=0, ins=0, upd=0;
  const doneRows = [];
  batch.forEach(item=>{
    try {
      if (item.type === 'topic') {
        const html = fetchHtml_(item.url, lang);
        const {answers, topics} = extractLinks_(html, lang, 500, 500);
        topics.forEach(u=>queueAdd_('topic', u));
        answers.forEach(u=>queueAdd_('answer', u));
        cntTop++;
      } else if (item.type === 'answer') {
        const html = fetchHtml_(item.url, lang);
        const it = parseAnswerToItem_(item.url, html, lang);
        const r = upsertArticles_([it]);
        ins += r.inserted; upd += r.updated;
        cntAns++;
      }
      doneRows.push(item.row);
      Utilities.sleep(200); // 예의상 딜레이
    } catch (err) {
      // 실패하면 상태를 in-progress 그대로 두어도 되고, 재처리하게 두는 전략
      console.error('crawlStep error', item, err);
    }
  });
  queueMarkDone_(doneRows);
  const pendingLeft = countPending_();
  return { answers:cntAns, topics:cntTop, inserted:ins, updated:upd, pending: pendingLeft };
}

function countPending_() {
  const sh = ensureSheet_(QUEUE_SHEET, ['type','url','status','ts']);
  const last = sh.getLastRow(); if (last<=1) return 0;
  const statuses = sh.getRange(2,3,last-1,1).getValues().flat();
  return statuses.filter(s=>s==='pending' || s==='in-progress').length;
}
