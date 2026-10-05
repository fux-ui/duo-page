// 線上客服的前端。只做三件事：開關面板、把訊息送去 /api/chat、把串流回來的字寫上畫面。
// 客服「會說什麼」不在這裡，在 api/_kb.js。
(() => {
  const root = document.getElementById('chat');
  if (!root) return;
  const panel = document.getElementById('chat-panel');
  const toggle = document.getElementById('chat-toggle');
  const closeBtn = root.querySelector('.chat-close');
  const log = document.getElementById('chat-log');
  const chips = document.getElementById('chat-chips');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');

  // 回答的是兩隻貓。模型在每段話前面標 [NuNu] 或 [Gojo]（規則寫在 api/_kb.js），
  // 這裡依標記把一則回覆拆成各自的泡泡。沒標的話一律算 NuNu 說的。
  const GREETING = '[Gojo] 我是 Gojo，戴帽子這隻，老大。你現在看到的雙客服，就是一頁雙聲會幫你做的東西。方案、流程、AI 費用怎麼算，都可以問我。\n[NuNu] 我是 NuNu，跟著姊。報價這種事，交給地位最低的阿福。';
  const FALLBACK = '先加 LINE 問阿福比較快：https://lin.ee/XbfihdD';
  // 只保留送去 API 的對話；重新整理就重來，不留在裝置上。
  const history = [];
  let busy = false;
  let greeted = false;
  let open = false;
  let typing = false;   // 輸入框有沒有焦點。用來分辨「鍵盤彈出來」與「網址列在收合」。

  // 純文字轉節點，網址變成連結。用 textContent 逐段塞，不碰 innerHTML——
  // 回覆是模型產的，永遠當成資料而不是標記。
  const URL_RE = /(https?:\/\/[^\s，。）)]+)/g;
  function write(el, text) {
    el.textContent = '';
    for (const part of text.split(URL_RE)) {
      if (!part) continue;
      if (/^https?:\/\//.test(part)) {
        const a = document.createElement('a');
        a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = part.replace(/^https?:\/\//, '');
        el.appendChild(a);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    }
  }

  function bubble(kind, text) {
    const el = document.createElement('div');
    el.className = `chat-msg ${kind}`;
    write(el, text);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  const TAG_RE = /\[(NuNu|Gojo)\]\s*/g;
  function speakers(text) {
    // 串流可能剛好停在半個標記上（「[Go」），先藏起來，下一批字到了再說。
    const safe = text.replace(/\[[A-Za-z]{0,4}$/, '');
    const parts = [];
    const push = (who, body) => {
      body = body.trim();
      if (!body) return;
      const last = parts[parts.length - 1];
      if (last && last.who === who) last.text += `\n${body}`;
      else parts.push({who, text: body});
    };
    let who = 'NuNu', from = 0, m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(safe))) {
      push(who, safe.slice(from, m.index));
      who = m[1];
      from = TAG_RE.lastIndex;
    }
    push(who, safe.slice(from));
    return parts;
  }

  // 一則回覆 = 一串泡泡。每次有新字就整串重排：泡泡不夠就補、多的（只會是等待中的那顆）
  // 就收掉。名字只寫在換貓說話的那一顆上。
  function render(group, text) {
    const parts = speakers(text);
    while (group.length < parts.length) group.push(bubble('bot', ''));
    parts.forEach(({who, text: body}, i) => {
      const el = group[i];
      el.classList.remove('is-waiting');
      el.dataset.who = who;
      write(el, body);
      const prev = el.previousElementSibling;
      if (prev && prev.classList.contains('bot') && prev.dataset.who === who) delete el.dataset.name;
      else el.dataset.name = who;
    });
    log.scrollTop = log.scrollHeight;
  }

  // 抽屜底部那一節：電話、地址、社群。跟頁尾同源，都讀 JSON-LD，不會各說各話。
  (() => {
    const strip = root.querySelector('.chat-contact');
    let data = {};
    try { data = JSON.parse(document.getElementById('business')?.textContent || '{}'); } catch { /* 留空 */ }
    const address = data.address
      ? [data.address.addressRegion, data.address.addressLocality, data.address.streetAddress].filter(Boolean).join('')
      : '';
    const rows = [];
    if (data.telephone) rows.push([data.telephone, `tel:${data.telephone.replace(/[^0-9+]/g, '')}`]);
    if (address) rows.push([address, null, 'chat-addr']);
    for (const url of data.sameAs || []) {
      const label = /instagram/.test(url) ? 'Instagram' : /facebook/.test(url) ? 'Facebook'
        : /lin\.ee|line\./.test(url) ? 'LINE' : '官網';
      rows.push([label, url]);
    }
    for (const [label, href, cls] of rows) {
      const el = document.createElement(href ? 'a' : 'span');
      el.textContent = label;
      if (cls) el.className = cls;
      if (href) { el.href = href; if (href.startsWith('http')) { el.target = '_blank'; el.rel = 'noopener noreferrer'; } }
      strip.appendChild(el);
    }
  })();

  // iOS 的鍵盤不會改變版面視窗，只改變「看得見的」那塊：固定在底部的東西因此會被鍵盤
  // 蓋住，或整個被頂上去跑位。visualViewport 是唯一知道真相的東西——把底部內縮與可用
  // 高度寫成 CSS 變數，面板與貓都吃同一組值，鍵盤收起來就自動還原。
  //
  // 但這組值只在「面板開著、而且鍵盤真的彈出來」時才量。手機捲動時網址列連續收合，
  // vv.height 每一幀都在變，lastFit 那道關卡完全擋不住；跟著它走等於每幀重排面板與貓，
  // 面板與貓頭都是大圖層，重繪不便宜。其餘時候一律把 inline 值拿掉，交還給 CSS 的
  // --chat-open-h —— 那是 svh，不隨網址列變動。
  //
  // 值也不再寫回 :root：custom property 寫在 :root 上會讓整份文件重算樣式，
  // #chat 的 contain:layout paint 完全擋不住。改成寫在真正吃這組值的兩個元素上。
  const vv = window.visualViewport;
  const cats = document.getElementById('chat-cats');
  let lastFit = '';
  function fitToViewport() {
    if (!vv || (!open && !lastFit)) return;
    const inset = open ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
    // 只認鍵盤。單看 inset 會被網址列收合誤觸（它一樣能輕易超過 40），常見問題與
    // 店家資訊就會在捲動途中無故消失、然後又跑回來。
    const on = open && typing && inset > 40;
    const tall = on ? Math.round(Math.min(innerHeight * .66, vv.height - 12)) : 0;
    const now = on ? `${inset}/${tall}` : '';
    if (now === lastFit) return;
    lastFit = now;
    for (const el of [root, cats]) {
      if (!el) continue;
      if (on) {
        el.style.setProperty('--chat-bottom', `${inset}px`);
        el.style.setProperty('--chat-open-h', `${tall}px`);
      } else {
        el.style.removeProperty('--chat-bottom');
        el.style.removeProperty('--chat-open-h');
      }
    }
    root.classList.toggle('is-tight', on);
  }
  if (vv) {
    vv.addEventListener('resize', fitToViewport);
    vv.addEventListener('scroll', fitToViewport);
  }

  // 銷售頁沒有捲動驅動的動畫，按鈕一開始就在（CSS 直接顯示），這裡只管開關。
  window.__chat = {
    open() {
      if (open) return;
      open = true;
      fitToViewport();
      root.classList.add('is-open');
      document.documentElement.classList.add('is-chat-open');
      if (!greeted) { render([], GREETING); greeted = true; }
      if (!matchMedia('(pointer:coarse)').matches) input.focus();
    },
  };

  function close() {
    open = false;
    typing = false;
    root.classList.remove('is-open');
    document.documentElement.classList.remove('is-chat-open');
    fitToViewport();          // 收回 inline 量測值，回到 CSS 的固定高度
  }

  toggle.addEventListener('click', () => window.__chat.open());
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) close(); });
  // 頁面上標了 data-chat 的按鈕都是召喚鍵（開場、預約諮詢）。
  document.addEventListener('click', e => {
    const cta = e.target.closest('[data-chat]');
    if (!cta) return;
    e.preventDefault();
    window.__chat.open();
  });

  chips.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (button) ask(button.textContent.trim());
  });

  // 鍵盤的有無沒有事件可聽，但「輸入框拿到焦點」就是它唯一可靠的前置條件。
  input.addEventListener('focus', () => { typing = true; fitToViewport(); });
  input.addEventListener('blur', () => { typing = false; fitToViewport(); });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(96, input.scrollHeight)}px`;
  });
  // 手機上 Enter 是換行（送出按鈕就在旁邊）；桌機 Enter 送出、Shift+Enter 換行。
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    ask(input.value);
  });

  async function ask(text) {
    const question = (text || '').trim();
    if (!question || busy) return;
    busy = true;
    send.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    bubble('me', question);
    history.push({role: 'user', content: question});
    const reply = [bubble('bot', '')];
    reply[0].classList.add('is-waiting');
    let answer = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({messages: history}),
      });
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || '一時連不上，等幾秒再試一次。');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const line = block.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let event;
          try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (event.t) {
            answer += event.t;
            if (speakers(answer).length) render(reply, answer);
          } else if (event.error && !answer) {
            throw new Error(event.error);
          }
        }
      }
      if (answer) history.push({role: 'assistant', content: answer});
      else throw new Error(FALLBACK);
    } catch (error) {
      for (const el of reply) el.remove();
      history.pop();
      bubble('err', `${error.message}\n${error.message.includes('lin.ee') ? '' : FALLBACK}`.trim());
    } finally {
      busy = false;
      send.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }
})();
