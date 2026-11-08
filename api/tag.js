// SIP Discovery Engine: live tagging endpoint (Vercel serverless function)
// Purpose : tags one pasted item with the same prompt (v1.5), model and
//           message format as the full 38,963-item run, then runs
//           code-based quality checks on the answer before returning it.
// Needs   : environment variable ANTHROPIC_API_KEY (engine-demo key, capped
//           at the Console workspace level); optional MODEL.
// Returns : { ok: true, context, item, checks } or
//           { ok: false, fallback: true, reason } when the live tagger is
//           unavailable, so the page can show pre-tagged examples instead.
// Privacy : nothing the visitor sends is stored or logged.

const PROMPT = require('../lib/prompt_v1_5.json');

const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const PARENT_MAX = 600, ITEM_MAX = 1500, TITLE_MAX = 300;   // same limits as the full run
const HARD_MAX = 4000;                                     // reject anything longer outright
const PER_VISITOR_LIMIT = 15, WINDOW_MS = 60 * 60 * 1000;  // best-effort limit per visitor per hour

const CODEBOOK = {"Q1": {"type": "one", "options": ["MF explicit", "MF inferred", "Stock, ETF or Gold", "Unclear"]}, "Q2": {"type": "one", "options": ["First-time, stated", "First-time, inferred", "Experienced", "Not clear"]}, "Q3a": {"type": "several", "options": ["Tax saving", "Retirement", "Education", "Specific purchase or life event", "Emergency fund or safety net", "Grow wealth (no specific goal)", "Build a saving habit", "Trying it out / easy small start"]}, "Q3b": {"type": "several", "options": ["High returns", "Quick results", "Steady growth, no drops", "Money is safe, like FD/RD", "Easy access to money", "Ups and downs", "Growth over years", "Didn't know what to expect"]}, "Q4": {"type": "several", "options": ["Family or partner", "Friends or colleagues", "Online creator or content", "Financial advisor, CA or bank", "Course, college or workshop", "General MF or SIP awareness ad", "Groww or other app's ad or offer", "Own research or decision"]}, "Q5": {"type": "one", "options": ["Not started yet", "Month 0 to 1", "Months 2 to 3", "Months 4 to 6", "Months 7 to 12", "Under 12 months, exact unclear", "Over 12 months"]}, "Q6": {"type": "several", "options": ["Still continuing", "Increased or added a SIP", "Reduced amount", "Changed SIP date", "Skipped", "Cancelled", "Stopped (method unclear)", "Moved to another app", "Payment failed", "Auto-cancelled", "Resumed after a gap", "Considering stopping", "Not started yet", "Withdrew money"]}, "Q7": {"type": "several", "options": ["Income dropped or job change", "Expenses went up or new priority", "Needed money (emergency or expense)", "Goal completed", "Saw losses", "Returns lower than expected", "Markets fell (news)", "Markets rose", "Wanted to pause", "Wanted to change amount or date", "Not enough balance", "Bank or mandate issue", "App technical issue", "Unexpected charges or tax", "KYC or account verification issue", "Advice from family or friends", "Influencer or online content", "Stopped believing SIPs work for them", "Unhappy with Groww", "Found a better option elsewhere", "Forgot or lost interest"]}, "Q8": {"type": "several", "options": ["Reading returns, terms and charts", "Fund types and categories", "Whether a drop is normal / why it moves", "How long until results", "Setting up AutoPay or mandate", "Failed instalment", "Unexpected or extra debit", "SIP status (is it running)", "Payment taken, investment not showing", "KYC or account status", "How to skip, pause, change or cancel", "What happens to invested money / withdrawing", "Charges, tax and lock-ins", "Am I doing it right", "Safety of money and platform"]}, "Q9a": {"type": "several", "options": ["Overall portfolio value or returns", "A single fund's value or returns", "Projected returns", "Statements and reports", "SIP and payment status", "Other or new funds", "Market, index or news"]}, "Q9b": {"type": "one", "options": ["Daily or more", "Weekly", "Monthly", "Rarely", "Never / stopped checking", "Around the SIP date", "When prompted"]}, "Q10": {"type": "several", "options": ["Family or partner", "Friends or colleagues", "Videos or creators", "Online communities or forums", "Search, articles or finance websites", "AI chatbots", "CA, advisor or other professional", "Official sources", "Their bank", "Groww help pages", "Groww customer support", "Didn't ask anyone"]}, "Q11": {"type": "several", "options": ["Pause option", "Easier ways to change, skip or restart", "Reminders and payment alerts", "Easier recovery after a failed instalment", "Clear SIP status", "Simpler numbers and terms on screen", "Learning content", "Knowing what's normal", "Goal progress tracking", "Better or faster support", "Personal guidance or fund recommendations", "Clear charges and tax info"]}, "S1": {"type": "several", "options": ["SIP setup", "AutoPay or mandate", "Fund page or explore", "KYC or onboarding", "Skip", "Cancel flow", "Edit amount or date", "Step-up or top-up", "Withdraw or redeem", "Portfolio or returns screen", "SIP calculator", "Statements and reports", "Notifications", "Customer support or help", "Other feature"]}, "S2": {"type": "several", "options": ["Zerodha", "INDmoney", "ET Money", "Paytm Money", "Kuvera", "Other app"]}, "S4": {"type": "one", "options": ["Own experience", "Someone they know", "People in general or clients", "Not clear"]}, "S3_age": {"type": "one", "options": ["Under 25", "25 to 34", "35 to 44", "45 and over"]}, "S3_income": {"type": "one", "options": ["Salaried", "Self-employed or business", "Freelance, gig or irregular", "Student or no income"]}, "S3_source": {"type": "one", "options": ["Salary", "Business or freelance income", "Family or pocket money", "Bonus or one-off money"]}};

const FALLBACK = { Q1: 'Unclear', Q2: 'Not clear', S4: 'Not clear',
  S3_age: 'Not stated', S3_income: 'Not stated', S3_source: 'Not stated' };

const APPS = ['Groww', 'INDmoney', 'Zerodha Coin', 'ET Money', 'Paytm Money', 'Kuvera'];

// ---------- Prompt: rebuilt exactly as build_system_prompt() did in the notebook ----------
function buildSystem() {
  const parts = [PROMPT.instructions, '\nEXAMPLES (for guidance only)'];
  PROMPT.examples.forEach(([ctx, ans], i) => {
    const id = 'ex' + (i + 1);
    parts.push('\nItem:\n[id: ' + id + ']\n' + ctx + '\nAnswer: ' + pyJson({ id, ...ans }));
  });
  return parts.join('\n');
}
// json.dumps(..., ensure_ascii=False) style: ", " and ": " separators
function pyJson(v) {
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).map(k => JSON.stringify(k) + ': ' + pyJson(v[k])).join(', ') + '}';
  return JSON.stringify(v);
}
const SYSTEM = buildSystem();

// ---------- Text helpers: same cleaning and trimming as the full run ----------
function clean(t) {
  t = typeof t === 'string' ? t : '';
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/\S*\s*\d{2,5}\s*[×x]\s*\d{2,5}\s+[\d.]+\s*(?:KB|MB)/gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}
function trim(t, n) {
  t = clean(t);
  return t.length <= n ? t : t.slice(0, n).trimEnd() + ' …';
}

// ---------- Context: same line labels the AI saw in the full run ----------
function buildContext(b) {
  const text = trim(b.text, ITEM_MAX);
  const title = trim(b.title, TITLE_MAX);
  const parent = trim(b.parent, PARENT_MAX);
  switch (b.source) {
    case 'app_review':
      return 'App: ' + (APPS.includes(b.app) ? b.app : 'Groww') + '\nReview: ' + text;
    case 'youtube':
      return parent
        ? 'Video title: ' + title + '\nReplying to: ' + parent + '\nReply: ' + text
        : 'Video title: ' + title + '\nComment: ' + text;
    case 'reddit_post':
      return 'Post title: ' + title + '\nPost: ' + text;
    case 'reddit_comment':
      return 'Post title: ' + title + '\n' + (parent ? 'Replying to: ' + parent : 'Replying to: (parent not found)') + '\nComment: ' + text;
    case 'forum_question':
      return 'Thread title: ' + title + '\nQuestion: ' + text;
    case 'forum_reply':
      return 'Thread title: ' + title + '\n' + (parent ? 'Replying to: ' + parent : 'Replying to: (parent not found)') + '\nReply: ' + text;
    default:
      return null;
  }
}

// ---------- Quality checks (code, not AI) ----------
const norm = s => clean(String(s || '')).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function clueFound(clue, source) {
  const c = norm(clue);
  if (!c) return true;
  const s = norm(source);
  if (s.includes(c)) return true;
  const words = c.split(' ').filter(w => w.length > 2);
  if (!words.length) return true;
  const hit = words.filter(w => s.includes(w)).length;
  return hit / words.length >= 0.6;
}

function checkItem(raw, context, itemText) {
  const tags = (raw && typeof raw.tags === 'object' && raw.tags) || {};
  const out = {}, removed = [], ungrounded = [], fixedOne = [];
  for (const [field, spec] of Object.entries(CODEBOOK)) {
    let t = tags[field];
    if (t === undefined || t === null) continue;
    if (typeof t !== 'object' || Array.isArray(t)) t = { v: t };
    let vals = Array.isArray(t.v) ? t.v : (t.v === undefined || t.v === null ? [] : [t.v]);
    vals = vals.map(x => String(x).trim()).filter(Boolean);
    const valid = vals.filter(v => spec.options.includes(v));
    vals.filter(v => !spec.options.includes(v)).forEach(v => removed.push(field + ': "' + v + '"'));
    let finalVals = valid;
    if (spec.type === 'one' && valid.length > 1) { finalVals = [valid[0]]; fixedOne.push(field); }
    if (!finalVals.length) continue;
    const clue = typeof t.clue === 'string' ? t.clue : '';
    const src = field === 'Q1' && t.src === 'context' ? 'context' : 'item';
    const isFallback = finalVals.every(v => Object.values(FALLBACK).includes(v));
    const grounded = isFallback || clueFound(clue, src === 'context' ? context : itemText);
    if (!grounded) ungrounded.push(field);
    out[field] = { v: finalVals, clue, src, grounded };
  }
  for (const f of ['Q1', 'S4']) if (!out[f]) out[f] = { v: [FALLBACK[f]], clue: '', src: 'item', grounded: true, defaulted: true };

  const conf = ['high', 'medium', 'low'].includes(String(raw && raw.confidence).toLowerCase()) ? String(raw.confidence).toLowerCase() : 'unknown';
  const answered = Object.keys(out).filter(f => !out[f].v.every(v => Object.values(FALLBACK).includes(v)));
  const sipSignal = answered.some(f => !['Q1', 'Q2', 'S4', 'S2', 'S3_age', 'S3_income', 'S3_source'].includes(f));

  const checks = [
    { id: 'format', label: 'Answer came back in the expected format', pass: true },
    { id: 'codebook', label: 'Every tag is an option from the codebook', pass: removed.length === 0,
      detail: removed.length ? 'Removed: ' + removed.join(', ') : '' },
    { id: 'single', label: 'One-answer questions have one answer', pass: fixedOne.length === 0,
      detail: fixedOne.length ? 'Kept the first answer for ' + fixedOne.join(', ') : '' },
    { id: 'grounded', label: 'Each tag quotes words that appear in the text', pass: ungrounded.length === 0,
      detail: ungrounded.length ? 'Quote not found for ' + ungrounded.join(', ') + ' (shown with a warning)' : '' },
    { id: 'confidence', label: 'The model is confident in its reading', pass: conf === 'high' || conf === 'medium',
      detail: conf === 'low' ? 'Low confidence: treat these tags as a rough reading' : (conf === 'unknown' ? 'No confidence given' : '') },
    { id: 'signal', label: 'The text says something about a SIP or mutual fund experience', pass: sipSignal,
      detail: sipSignal ? '' : 'No SIP-related tags: in the real pipeline the relevance step would most likely have filtered this item out before tagging' },
  ];
  const failed = checks.filter(c => !c.pass).length;
  const verdict = !sipSignal ? 'not_relevant' : (failed === 0 ? 'passed' : 'warnings');
  return { tags: out, reason: String((raw && raw.reason) || ''), confidence: conf, checks, verdict };
}

function parseReply(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data = JSON.parse(t);
  if (data && !Array.isArray(data)) data = data.items || data.results || [data];
  return Array.isArray(data) ? data.find(a => a && typeof a === 'object') : null;
}

// ---------- Best-effort per-visitor limit (resets when the function restarts) ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= PER_VISITOR_LIMIT) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  return false;
}

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'Use POST.' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  const raw = [b.text, b.title, b.parent].map(x => (typeof x === 'string' ? x : '')).join('');
  if (!clean(b.text)) return send(res, 400, { ok: false, reason: 'Paste the text you want tagged.' });
  if (raw.length > HARD_MAX) return send(res, 400, { ok: false, reason: 'That is too long. Keep the text under 1,500 characters.' });
  const context = buildContext(b);
  if (!context) return send(res, 400, { ok: false, reason: 'Choose where the text comes from.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return send(res, 200, { ok: false, fallback: true, reason: 'limit',
    message: 'You have reached the demo limit of ' + PER_VISITOR_LIMIT + ' live tags an hour. The pre-tagged examples below show the same output.' });

  if (!process.env.ANTHROPIC_API_KEY) return send(res, 200, { ok: false, fallback: true, reason: 'not_configured',
    message: 'The live tagger is switched off right now. The pre-tagged examples below show what it produces.' });

  const started = Date.now();
  let reply;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, system: SYSTEM,
        messages: [{ role: 'user', content: 'Tag these items:\n\n[id: 1]\n' + context }] }),
      signal: AbortSignal.timeout(50000),
    });
    reply = await r.json().catch(() => ({}));
    if (!r.ok) {
      const capped = r.status === 429 || r.status === 402 || /limit|credit|billing/i.test(JSON.stringify(reply));
      return send(res, 200, { ok: false, fallback: true, reason: capped ? 'capacity' : 'api_error',
        message: capped ? 'The live demo has reached its usage limit. The pre-tagged examples below show the same output.'
                        : 'The live tagger could not reach the AI service just now. The pre-tagged examples below show what it produces.' });
    }
  } catch (e) {
    return send(res, 200, { ok: false, fallback: true, reason: 'timeout',
      message: 'The AI service took too long to answer. Try again, or look at the pre-tagged examples below.' });
  }

  const text = (reply.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let item;
  try { item = parseReply(text); } catch { item = null; }
  if (!item) return send(res, 200, { ok: false, fallback: true, reason: 'unreadable',
    message: 'The AI answer failed the format check, so it is not shown. Try again, or look at the pre-tagged examples below.' });

  const result = checkItem(item, context, clean(b.text));
  const u = reply.usage || {};
  return send(res, 200, { ok: true, context, model: MODEL, prompt: PROMPT.version,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0 }, ...result });
};

module.exports._internals = { SYSTEM, buildContext, checkItem, parseReply };
