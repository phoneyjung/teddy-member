// Shared helpers — no innerHTML with data anywhere (all text goes through textContent)
(function () {
  'use strict';
  // refuse to run inside someone else's frame (clickjacking)
  if (window.top !== window.self) { document.documentElement.textContent = ''; throw new Error('framed'); }

  const T = {};
  T.$ = (sel, root) => (root || document).querySelector(sel);

  // h('div', {class:'x', onclick: fn}, 'text', child, [children])
  T.h = function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  };
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => add(el, x)); return; }
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  T.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  T.mount = (el, ...kids) => { T.clear(el); kids.forEach((k) => add(el, k)); return el; };

  T.money = (satang, sign) => {
    const n = Math.abs(satang) / 100;
    const s = n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (sign && satang > 0 ? '+' : sign && satang < 0 ? '−' : satang < 0 ? '−' : '') + '฿' + s;
  };
  T.baht = (satang) => (satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  T.date = (s) => {
    if (!s) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?/.exec(s);
    if (!m) return s;
    return `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${String(Number(m[1]) + 543).slice(2)}${m[4] ? ' · ' + m[4] : ''}`;
  };
  T.unix = (u) => {
    if (!u) return '';
    const d = new Date(u * 1000 + 7 * 3600e3).toISOString();
    return T.date(d.slice(0, 10) + ' ' + d.slice(11, 16));
  };
  T.shop = (b) => (window.TEDDY_SHOPS && window.TEDDY_SHOPS[b]) || '';
  T.pct = (bp) => (bp / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 }) + '%';
  T.cid = () => {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return 'w' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  };

  // API call with timeout; throws {status, error, message}
  T.api = async function api(path, body, token) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res, data;
    try {
      res = await fetch(window.TEDDY_API + path, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: JSON.stringify(body || {}), signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw { status: 0, error: 'network', message: 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' };
    }
    clearTimeout(timer);
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw { status: res.status, error: data.error || 'error', message: data.message || 'เกิดข้อผิดพลาด (' + res.status + ')' };
    return data;
  };

  // sign out after a period without touches
  T.idle = function (minutes, onIdle) {
    let t;
    const reset = () => { clearTimeout(t); t = setTimeout(onIdle, minutes * 60000); };
    ['pointerdown', 'keydown', 'scroll'].forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => clearTimeout(t);
  };

  T.digits = (input, max) => input.addEventListener('input', () => {
    const v = input.value.replace(/\D/g, '').slice(0, max);
    if (v !== input.value) input.value = v;
  });

  T.store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (_) {} },
  };
  T.pref = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  T.bear = function () {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 64 64');
    const c = (cx, cy, r, f) => { const e = document.createElementNS(ns, 'circle'); e.setAttribute('cx', cx); e.setAttribute('cy', cy); e.setAttribute('r', r); e.setAttribute('fill', f); s.appendChild(e); };
    c(16, 18, 9, '#E9C9A0'); c(48, 18, 9, '#E9C9A0'); c(16, 18, 4.5, '#C68B4A'); c(48, 18, 4.5, '#C68B4A');
    c(32, 36, 22, '#F1D6B0'); c(32, 44, 9, '#FBF0E0'); c(32, 41, 3.2, '#5A3B22');
    c(24, 32, 2.8, '#2B2B2B');
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M37 32 q3 -3 6 0'); p.setAttribute('stroke', '#2B2B2B'); p.setAttribute('stroke-width', '2.4'); p.setAttribute('fill', 'none'); p.setAttribute('stroke-linecap', 'round'); s.appendChild(p);
    return s;
  };

  window.T = T;
})();
