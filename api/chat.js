// 線上客服：把瀏覽器的訊息轉給模型，再把回覆逐字串流回去。
//
// 支援三條路，由環境變數決定走哪一條（同時設了，就照下面的順序取第一個）：
//
//   GEMINI_API_KEY               → 直接打 Google Gemini 的 OpenAI 相容端點（預設
//   (+ GEMINI_MODEL)               gemini-2.5-flash；要更強就設 GEMINI_MODEL=gemini-2.5-pro）
//   ANTHROPIC_API_KEY            → 直接打 Anthropic Messages API（預設 claude-opus-5）
//   AI_GATEWAY_API_KEY           → 打 OpenAI 相容的 /chat/completions（Vercel AI Gateway
//   + AI_GATEWAY_BASE_URL          就是這個介面），因此 Gemini、Claude、任何模型都能用，
//   + AI_GATEWAY_MODEL             換模型只要改環境變數，這支不用動。
//
// Gemini 與 gateway 說的是同一種格式（/chat/completions），只差網址與金鑰。
// 各條路的差別只在「怎麼問」與「怎麼讀回答」，外層的串流、
// 節流、錯誤處理是同一套。
//
// 這裡刻意用原生 fetch 而不是官方 SDK：這個專案沒有建置步驟（vercel.json 的
// installCommand 是 null），function 端不會有 node_modules，require SDK 在執行期會
// 直接掛掉。
//
// 金鑰只存在伺服器端，永遠不會進到前端。
const {SYSTEM} = require('./_kb');

const trim = url => (url || '').replace(/\/+$/, '');
// base 可能已經帶了 /v1，也可能沒有；兩種都接受，不要疊出 /v1/v1。
const join = (base, path) => /\/v\d+$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`;

function lane() {
  const gemini = process.env.GEMINI_API_KEY;
  if (gemini) {
    return {
      via: 'gemini',
      key: gemini,
      base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    };
  }
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (anthropic) {
    return {
      via: 'anthropic',
      key: anthropic,
      base: trim(process.env.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com',
      model: 'claude-opus-5',
    };
  }
  const gateway = process.env.AI_GATEWAY_API_KEY;
  if (gateway) {
    return {
      via: 'gateway',
      key: gateway,
      base: trim(process.env.AI_GATEWAY_BASE_URL),
      model: process.env.AI_GATEWAY_MODEL || '',
    };
  }
  return null;
}

// 診斷用：GET 這個網址就知道客服有沒有通電，而且不會洩漏金鑰本身。
function status() {
  const it = lane();
  if (!it) {
    return {ready: false, via: null, note: '沒有找到金鑰。Vercel → Settings → Environment Variables 設好 GEMINI_API_KEY、ANTHROPIC_API_KEY 或 AI_GATEWAY_API_KEY，然後 Redeploy 才會生效。'};
  }
  const missing = it.via === 'gateway'
    ? [!it.base && 'AI_GATEWAY_BASE_URL', !it.model && 'AI_GATEWAY_MODEL'].filter(Boolean)
    : [];
  return {
    ready: missing.length === 0,
    via: it.via,
    endpoint: it.base || null,
    model: it.model || null,
    note: missing.length ? `找到 gateway 金鑰，但還缺 ${missing.join('、')}。這兩個值在 Vercel 的 AI Gateway 頁面上。` : 'ok',
  };
}

// 同一段對話，兩種問法。
function request(it, messages) {
  if (it.via === 'anthropic') {
    return {
      url: join(it.base, 'messages'),
      headers: {'content-type': 'application/json', 'x-api-key': it.key, 'anthropic-version': '2023-06-01'},
      body: {
        model: it.model,
        max_tokens: 4000,
        // 系統提示是固定的，切一個快取點；重複的問答就不必每次重付這段的錢。
        system: [{type: 'text', text: SYSTEM, cache_control: {type: 'ephemeral'}}],
        // 客服要的是快，不是深思。thinking 留著（Opus 5 直接關掉有把工具呼叫寫進
        // 內文之類的副作用），用 effort low 壓成本與延遲。
        thinking: {type: 'adaptive'},
        output_config: {effort: 'low'},
        messages,
        stream: true,
      },
    };
  }
  return {
    // Gemini 的 base 結尾是 /openai，不是 /v1，不能交給 join() 去補版本號。
    url: it.via === 'gemini' ? `${it.base}/chat/completions` : join(it.base, 'chat/completions'),
    headers: {'content-type': 'application/json', authorization: `Bearer ${it.key}`},
    body: {
      model: it.model,
      // 2.5 系列會先想再答，思考也吃這個額度；給太少，長一點的回答會被腰斬。
      max_tokens: 8192,
      messages: [{role: 'system', content: SYSTEM}, ...messages],
      stream: true,
    },
  };
}

// 同一串 SSE，兩種讀法。回傳 {text} 就是可以寫出去的字，{error} 就是要說的話。
function decodeEvent(via, raw) {
  if (raw === '[DONE]') return null;
  let event;
  try { event = JSON.parse(raw); } catch { return null; }
  if (via === 'anthropic') {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') return {text: event.delta.text};
    if (event.type === 'message_delta' && event.delta?.stop_reason === 'refusal') return {error: '這個我不太方便回答，換個問題問我吧。'};
    if (event.type === 'error') return {error: '回覆到一半中斷了，再問一次試試。'};
    return null;
  }
  const choice = event.choices?.[0];
  if (typeof choice?.delta?.content === 'string' && choice.delta.content) return {text: choice.delta.content};
  if (choice?.finish_reason === 'content_filter') return {error: '這個我不太方便回答，換個問題問我吧。'};
  if (event.error) return {error: '回覆到一半中斷了，再問一次試試。'};
  return null;
}

const MAX_TURNS = 24;        // 只保留最近幾則，對話再長也不會無限膨脹
const MAX_CHARS = 1200;      // 單則訊息上限
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 30;     // 每個 IP 每十分鐘

// 盡力而為的節流：serverless instance 會被回收，重開就歸零，擋得住手滑與無聊的人，
// 擋不住有心人。真的被打了再上邊緣層的限流。
const hits = new Map();
function overLimit(ip) {
  const now = Date.now();
  const seen = hits.get(ip);
  if (!seen || now > seen.until) { hits.set(ip, {n: 1, until: now + WINDOW_MS}); return false; }
  seen.n += 1;
  if (hits.size > 5000) hits.clear();
  return seen.n > MAX_REQUESTS;
}

const clean = value => typeof value === 'string' ? value.trim().slice(0, MAX_CHARS) : '';

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json(status());
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({error: 'Method not allowed'});
  }

  const body = req.body && typeof req.body === 'object'
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const messages = Array.isArray(body.messages)
    ? body.messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && clean(m.content))
      .slice(-MAX_TURNS)
      .map(m => ({role: m.role, content: clean(m.content)}))
    : [];
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({error: '請先輸入問題。'});
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (overLimit(ip)) {
    return res.status(429).json({error: '訊息有點多，休息一下再問吧。急的話可以直接打 0988-720-396。'});
  }

  const it = lane();
  if (!it || !status().ready) {
    return res.status(503).json({error: '線上客服還沒開機。想問什麼可以加 LINE 或打 0988-720-396，那邊有真人。'});
  }
  const call = request(it, messages);

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 60000);
  req.on('close', () => control.abort());

  let upstream;
  try {
    upstream = await fetch(call.url, {
      method: 'POST',
      signal: control.signal,
      headers: call.headers,
      body: JSON.stringify(call.body),
    });
  } catch (error) {
    clearTimeout(timer);
    if (control.signal.aborted) return res.end();
    return res.status(502).json({error: '一時連不上，等幾秒再試一次。'});
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const status = upstream.status;
    const message = status === 429 ? '現在有點忙，稍等一下再問。'
      : status === 401 || status === 403 ? '線上客服還沒設定好。想問什麼可以加 LINE 或打 0988-720-396。'
      : status >= 500 ? '對方伺服器出了點狀況，等幾秒再試一次。'
      : '這個問題我這邊處理不了，麻煩改用 LINE 問。';
    return res.status(status === 429 ? 429 : 502).json({error: message});
  }

  // 從這裡開始已經在串流，狀態碼改不了了，後面的錯誤只能當成事件送出去。
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawText = false;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      // SSE 以空行分隔事件；最後一段可能只有半個事件，留在 buffer 裡等下一批。
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const piece = decodeEvent(it.via, line.slice(5).trim());
          if (!piece) continue;
          if (piece.text) { sawText = true; send({t: piece.text}); }
          else if (piece.error) send({error: piece.error});
        }
      }
    }
    if (!sawText) send({error: '這題我沒有答案，加 LINE 問真人比較快：https://lin.ee/XbfihdD'});
  } catch (error) {
    if (!control.signal.aborted) send({error: '回覆到一半中斷了，再問一次試試。'});
  } finally {
    clearTimeout(timer);
    send({done: true});
    res.end();
  }
};
