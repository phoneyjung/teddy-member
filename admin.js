(function () {
  'use strict';
  const { h, mount, clear, api, money, baht, date, unix, shop, pct, cid, store, pref, digits } = window.T;
  const app = document.getElementById('app');
  const who = document.getElementById('who');
  const topbtn = document.getElementById('topbtn');
  document.getElementById('logo').appendChild(window.T.bear());
  const KEY = 'tm_admin';
  let token = store.get(KEY);
  let role = store.get(KEY + '_role');
  let settings = null;
  let stopIdle = null;
  const BANKS = ['', 'กสิกรไทย', 'ไทยพาณิชย์', 'กรุงไทย', 'กรุงเทพ', 'ทีทีบี', 'กรุงศรี', 'ออมสิน', 'ธ.ก.ส.', 'ยูโอบี', 'ซีไอเอ็มบี', 'เกียรตินาคินภัทร', 'แลนด์ แอนด์ เฮ้าส์', 'อื่นๆ'];
  const memberUrl = new URL('index.html', location.href).href;

  const errBox = (e) => h('div', { class: 'msg err', role: 'alert' }, e.message || String(e));
  const okBox = (t) => h('div', { class: 'msg ok' }, t);
  const isOwner = () => role === 'owner';
  const bkkToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

  async function call(path, body) {
    try { return await api(path, body, token); }
    catch (e) {
      if (e.status === 401 && e.error === 'auth') { signOut('หมดเวลา กรุณาเข้าสู่ระบบใหม่'); }
      throw e;
    }
  }
  function signOut(msg) {
    if (token) api('/api/admin/logout', {}, token).catch(() => {});
    token = null; role = null; store.del(KEY); store.del(KEY + '_role');
    if (stopIdle) { stopIdle(); stopIdle = null; }
    closeSheet();
    loginView(msg);
  }

  // ---------------------------------------------------------------- sheet (bottom modal)
  let sheetEl = null;
  function openSheet(...kids) {
    closeSheet();
    const sheet = h('div', { class: 'sheet', role: 'dialog' }, kids);
    sheetEl = h('div', { class: 'scrim', onclick: (e) => { if (e.target === sheetEl) closeSheet(); } }, sheet);
    document.body.appendChild(sheetEl);
    const f = sheet.querySelector('input'); if (f) setTimeout(() => f.focus(), 50);
    return sheet;
  }
  function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; } }

  function chips(options, value, onPick) {
    const wrap = h('div', { class: 'chips' });
    const draw = (v) => {
      clear(wrap);
      for (const [val, label] of options) wrap.appendChild(h('button', { type: 'button', class: 'chip' + (val === v ? ' on' : ''), onclick: () => { draw(val); onPick(val); } }, label));
    };
    draw(value);
    return wrap;
  }

  // ---------------------------------------------------------------- login
  function loginView(note) {
    who.textContent = 'ระบบสมาชิกเครดิต Teddy 1 + Teddy 2'; clear(topbtn);
    const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'รหัสผ่านแอดมิน' });
    const out = h('div');
    const btn = h('button', { class: 'btn', type: 'button' }, 'เข้าสู่ระบบ');
    async function go() {
      out.textContent = ''; if (!pw.value) return;
      btn.disabled = true;
      try {
        const r = await api('/api/admin/login', { password: pw.value });
        token = r.token; role = r.role; store.set(KEY, token); store.set(KEY + '_role', role);
        pw.value = '';
        start();
      } catch (e) { out.appendChild(errBox(e)); pw.value = ''; }
      finally { btn.disabled = false; }
    }
    btn.addEventListener('click', go);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    mount(app, h('div', { class: 'card' }, h('h2', null, 'เข้าสู่ระบบแอดมิน'),
      note ? h('div', { class: 'msg info' }, note) : null,
      h('label', null, 'รหัสผ่าน (เจ้าของ หรือ แม่บ้าน)'), pw, h('div', { class: 'sp' }), btn, out,
      h('p', { class: 'muted small' }, 'ผิดเกิน 8 ครั้ง/15 นาที ระบบจะล็อกเครื่องนี้ชั่วคราว · ทุกการกระทำถูกบันทึกไว้')));
    pw.focus();
  }

  // ---------------------------------------------------------------- shell
  let tab = 'members';
  async function start() {
    who.textContent = isOwner() ? 'เข้าระบบเป็น: เจ้าของร้าน' : 'เข้าระบบเป็น: แม่บ้าน (เติม/หักยอดได้)';
    mount(topbtn, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => signOut('ออกจากระบบแล้ว') }, 'ออก'));
    if (!stopIdle) stopIdle = window.T.idle(30, () => signOut('ออกจากระบบอัตโนมัติ (ไม่ได้ใช้งาน 30 นาที)'));
    try { const s = await call('/api/admin/summary', {}); settings = s.settings; }
    catch (e) { if (e.status === 401) return; mount(app, errBox(e)); return; }
    render();
  }
  function render() {
    const tabs = [['members', 'สมาชิก'], ['summary', 'สรุปยอด']];
    if (isOwner()) tabs.push(['settings', 'ตั้งค่าโปร'], ['import', 'นำเข้าข้อมูล'], ['audit', 'ประวัติแอดมิน']);
    const bar = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { type: 'button', class: 'tab' + (tab === k ? ' on' : ''), onclick: () => { tab = k; render(); } }, l)));
    const body = h('div');
    mount(app, bar, body);
    ({ members: membersTab, summary: summaryTab, settings: settingsTab, import: importTab, audit: auditTab })[tab](body);
  }

  // ---------------------------------------------------------------- members
  let lastQ = '';
  function membersTab(root) {
    const q = h('input', { type: 'search', placeholder: 'ค้นหา: เบอร์ 3–7 หลัก หรือชื่อเล่น', value: lastQ, autocomplete: 'off' });
    const results = h('div');
    let timer;
    const run = async () => {
      lastQ = q.value.trim();
      try {
        const r = await call('/api/admin/search', { q: lastQ });
        const list = h('ul', { class: 'list' });
        if (!r.results.length) list.appendChild(h('li', { class: 'item muted' }, 'ไม่พบสมาชิก'));
        for (const m of r.results) list.appendChild(h('li', { class: 'item', onclick: () => memberView(m.id) },
          h('div', { class: 'dot out' }, (m.nickname || '?').slice(0, 1)),
          h('div', { class: 'main' }, h('div', { class: 't' }, m.nickname || '-'), h('div', { class: 's' }, m.id + (m.gender ? ' · ' + m.gender : ''))),
          h('div', { class: 'muted' }, '›')));
        mount(results, list);
      } catch (e) { mount(results, errBox(e)); }
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
    mount(root, h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, q), h('button', { class: 'btn sm blue', type: 'button', onclick: newMemberSheet }, '+ สมาชิกใหม่')),
      h('div', { class: 'sp' }), results));
    run();
  }

  async function memberView(id) {
    const root = h('div', { class: 'card center muted' }, 'กำลังโหลด…');
    mount(app, root);
    let d;
    try { d = await call('/api/admin/member', { id }); } catch (e) { if (e.status !== 401) mount(app, errBox(e), backBtn()); return; }
    const m = d.member;
    const badges = [];
    if (m.status !== 'active') badges.push(h('span', { class: 'badge red' }, 'ปิดบัญชี'));
    if (m.locked) badges.push(h('span', { class: 'badge red' }, 'ล็อก (PIN ผิดหลายครั้ง)'));
    else if (m.recentFails) badges.push(h('span', { class: 'badge gold' }, 'PIN ผิดล่าสุด ' + m.recentFails + ' ครั้ง'));
    badges.push(m.must_change ? h('span', { class: 'badge gold' }, 'ยังไม่ได้ตั้ง PIN เอง') : h('span', { class: 'badge green' }, 'ตั้ง PIN แล้ว'));

    const hist = h('ul', { class: 'list' });
    if (!d.txns.length) hist.appendChild(h('li', { class: 'item muted' }, 'ยังไม่มีรายการ'));
    for (const t of d.txns) {
      const isTop = t.type === 'topup';
      const voided = !!t.voided_at;
      hist.appendChild(h('li', { class: 'item' + (voided ? ' voided' : '') },
        h('div', { class: 'dot ' + (voided ? 'void' : isTop ? 'in' : 'out') }, isTop ? '+' : '−'),
        h('div', { class: 'main' },
          h('div', { class: 't' }, isTop ? 'เติม ' + money(t.amount) + (t.bonus_bp ? ' (โบนัส ' + pct(t.bonus_bp) + ')' : '') : 'ใช้เครดิต'),
          h('div', { class: 's' }, [date(t.occurred_at), shop(t.branch), isTop && t.method ? (t.method === 'cash' ? 'เงินสด' : 'โอน') : '', t.bank, 'โดย ' + t.created_by].filter(Boolean).join(' · ')),
          t.note ? h('div', { class: 's' }, t.note) : null,
          voided ? h('div', { class: 's' }, 'ยกเลิกแล้ว: ' + (t.void_reason || '') + ' (' + unix(t.voided_at) + ')') : null),
        h('div', { class: 'amt' }, h('div', { class: 'a ' + (isTop ? 'in' : 'out') }, money(t.delta, true)),
          isOwner() && !voided ? h('button', { class: 'chip', type: 'button', onclick: () => voidSheet(t, m) }, 'ยกเลิก') : null)));
    }

    const ownerTools = isOwner() ? h('div', { class: 'row wrapr' },
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => resetPin(m) }, 'ออก PIN ใหม่'),
      m.locked || m.recentFails ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => simple('/api/admin/unlock', { id: m.id }, 'ปลดล็อกแล้ว', m.id) }, 'ปลดล็อก') : null,
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => simple('/api/admin/status', { id: m.id, status: m.status === 'active' ? 'disabled' : 'active' }, m.status === 'active' ? 'ปิดบัญชีแล้ว' : 'เปิดบัญชีแล้ว', m.id) }, m.status === 'active' ? 'ปิดบัญชี' : 'เปิดบัญชี')) : null;

    mount(app,
      backBtn(),
      h('div', { class: 'card sky' },
        h('div', { class: 'bal-label' }, m.nickname + ' · ' + m.id + (m.gender ? ' · ' + m.gender : '')),
        h('div', { class: 'bal' }, money(d.balance)),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'k' }, 'เครดิตที่ได้รวม'), h('div', { class: 'v' }, money(d.credit))),
          h('div', { class: 'stat' }, h('div', { class: 'k' }, 'ใช้ไปรวม'), h('div', { class: 'v' }, money(d.used))))),
      h('div', { class: 'card' }, h('div', { class: 'chips' }, badges),
        h('p', { class: 'muted small' }, 'เข้าดูยอดล่าสุด: ' + (m.last_login ? unix(m.last_login) : 'ยังไม่เคย')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => topupSheet(m), disabled: m.status !== 'active' }, '+ เติมเงิน'),
          h('button', { class: 'btn blue', type: 'button', onclick: () => useSheet(m, d.balance), disabled: m.status !== 'active' }, '− หักยอดใช้')),
        ownerTools ? h('div', { class: 'sp' }) : null, ownerTools),
      h('div', { class: 'card' }, h('h3', null, 'ประวัติ'), hist));
  }
  function backBtn() { return h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { tab = 'members'; render(); } }, '‹ กลับไปรายชื่อ'); }

  async function simple(path, body, okText, id) {
    try { await call(path, body); await memberView(id); app.insertBefore(okBox(okText), app.firstChild); }
    catch (e) { if (e.status !== 401) app.insertBefore(errBox(e), app.firstChild); }
  }

  function bonusPreview(amountSatang) {
    const p = settings && settings.promo; const today = bkkToday();
    if (!p || today < p.start || today > p.end) return 0;
    let bp = 0; for (const t of p.tiers || []) if (amountSatang >= t.min && t.bp > bp) bp = t.bp;
    return bp;
  }

  function topupSheet(m) {
    let branch = pref.get('tm_branch') || 'teddy2';
    let method = 'transfer';
    const amt = h('input', { inputmode: 'decimal', placeholder: 'ยอดเงินที่ลูกค้าจ่าย (บาท)' });
    const bank = h('select', null, BANKS.map((b) => h('option', { value: b }, b || '— ธนาคารที่โอน (ไม่บังคับ) —')));
    const note = h('input', { maxlength: 120, placeholder: 'หมายเหตุ (ไม่บังคับ)' });
    const prev = h('div', { class: 'msg info' }, 'ใส่ยอดเงินก่อน');
    const out = h('div');
    const btn = h('button', { class: 'btn', type: 'button' }, 'ยืนยันเติมเงิน');
    const parse = () => { const v = Number(String(amt.value).replace(/,/g, '')); return isFinite(v) && v > 0 ? Math.round(v * 100) : 0; };
    const upd = () => {
      const a = parse();
      if (!a) { prev.textContent = 'ใส่ยอดเงินก่อน'; return; }
      const bp = bonusPreview(a); const credit = a + Math.round(a * bp / 10000);
      prev.textContent = 'ลูกค้าจ่าย ' + money(a) + ' → ได้เครดิต ' + money(credit) + (bp ? ' (โบนัส ' + pct(bp) + ' ' + (settings.promo.name || '') + ')' : ' (ไม่มีโบนัส)');
    };
    amt.addEventListener('input', upd);
    const id = cid();
    btn.addEventListener('click', async () => {
      out.textContent = '';
      const a = parse(); if (!a) return out.appendChild(errBox({ message: 'ใส่ยอดเงิน' }));
      btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
      try {
        const r = await call('/api/admin/topup', { id: m.id, amount: a / 100, branch, method, bank: bank.value, note: note.value, clientId: id });
        pref.set('tm_branch', branch);
        closeSheet(); await memberView(m.id);
        app.insertBefore(okBox('เติมสำเร็จ ได้เครดิต ' + money(r.credit) + (r.bonusBp ? ' (โบนัส ' + pct(r.bonusBp) + ')' : '') + ' · คงเหลือ ' + money(r.balance)), app.firstChild);
      } catch (e) { if (e.status !== 401) out.appendChild(errBox(e)); btn.disabled = false; btn.textContent = 'ยืนยันเติมเงิน'; }
    });
    openSheet(h('h2', null, 'เติมเงิน · ' + m.nickname + ' (' + m.id + ')'),
      h('label', null, 'ยอดเงินที่ลูกค้าจ่าย'), amt,
      chips([[100000, '1,000'], [150000, '1,500'], [200000, '2,000'], [50000, '500'], [30000, '300']], null, (v) => { amt.value = String(v / 100); upd(); }),
      h('label', null, 'สาขาที่รับเงิน'), chips([['teddy1', 'Teddy 1'], ['teddy2', 'Teddy 2']], branch, (v) => { branch = v; }),
      h('label', null, 'ช่องทาง'), chips([['transfer', 'โอน'], ['cash', 'เงินสด']], method, (v) => { method = v; }),
      h('label', null, 'ธนาคาร'), bank, h('label', null, 'หมายเหตุ'), note,
      prev, h('div', { class: 'sp' }), btn, out, h('div', { class: 'sp' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'ยกเลิก'));
  }

  function useSheet(m, balance) {
    let branch = pref.get('tm_branch') || 'teddy2';
    const amt = h('input', { inputmode: 'decimal', placeholder: 'ยอดที่ใช้ (บาท)' });
    const note = h('input', { maxlength: 120, placeholder: 'เช่น ซัก 17kg + อบ (ไม่บังคับ)' });
    const prev = h('div', { class: 'msg info' }, 'คงเหลือตอนนี้ ' + money(balance));
    const out = h('div');
    const btn = h('button', { class: 'btn blue', type: 'button' }, 'ยืนยันหักยอด');
    const parse = () => { const v = Number(String(amt.value).replace(/,/g, '')); return isFinite(v) && v > 0 ? Math.round(v * 100) : 0; };
    amt.addEventListener('input', () => {
      const a = parse();
      prev.className = 'msg ' + (a > balance ? 'err' : 'info');
      prev.textContent = a ? (a > balance ? 'เครดิตไม่พอ (คงเหลือ ' + money(balance) + ')' : 'หัก ' + money(a) + ' → เหลือ ' + money(balance - a)) : 'คงเหลือตอนนี้ ' + money(balance);
    });
    const id = cid();
    btn.addEventListener('click', async () => {
      out.textContent = '';
      const a = parse(); if (!a) return out.appendChild(errBox({ message: 'ใส่ยอดที่ใช้' }));
      btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
      try {
        const r = await call('/api/admin/use', { id: m.id, amount: a / 100, branch, note: note.value, clientId: id });
        pref.set('tm_branch', branch);
        closeSheet(); await memberView(m.id);
        app.insertBefore(okBox('หักยอด ' + money(r.amount) + ' แล้ว · คงเหลือ ' + money(r.balance)), app.firstChild);
      } catch (e) { if (e.status !== 401) out.appendChild(errBox(e)); btn.disabled = false; btn.textContent = 'ยืนยันหักยอด'; }
    });
    openSheet(h('h2', null, 'หักยอดใช้ · ' + m.nickname + ' (' + m.id + ')'),
      h('label', null, 'ยอดที่ใช้'), amt,
      chips([[4000, '40'], [5000, '50'], [6000, '60'], [7000, '70'], [8000, '80'], [10000, '100'], [12000, '120']], null, (v) => { amt.value = String(v / 100); amt.dispatchEvent(new Event('input')); }),
      h('label', null, 'สาขาที่ใช้'), chips([['teddy1', 'Teddy 1'], ['teddy2', 'Teddy 2']], branch, (v) => { branch = v; }),
      h('label', null, 'หมายเหตุ'), note, prev, h('div', { class: 'sp' }), btn, out, h('div', { class: 'sp' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'ยกเลิก'));
  }

  function voidSheet(t, m) {
    const reason = h('input', { maxlength: 120, placeholder: 'เหตุผล เช่น กดผิดยอด / ลูกค้าขอคืน' });
    const out = h('div');
    const btn = h('button', { class: 'btn red', type: 'button' }, 'ยืนยันยกเลิกรายการ');
    btn.addEventListener('click', async () => {
      out.textContent = ''; btn.disabled = true;
      try { await call('/api/admin/void', { txnId: t.id, reason: reason.value }); closeSheet(); await memberView(m.id); app.insertBefore(okBox('ยกเลิกรายการแล้ว'), app.firstChild); }
      catch (e) { if (e.status !== 401) out.appendChild(errBox(e)); btn.disabled = false; }
    });
    openSheet(h('h2', null, 'ยกเลิกรายการ'),
      h('p', null, (t.type === 'topup' ? 'เติม ' + money(t.amount) : 'ใช้ ' + money(t.amount)) + ' · ' + date(t.occurred_at)),
      h('p', { class: 'muted small' }, 'รายการจะไม่ถูกลบ แต่ขีดฆ่าและไม่นับในยอด (ตรวจย้อนหลังได้)'),
      h('label', null, 'เหตุผล'), reason, h('div', { class: 'sp' }), btn, out, h('div', { class: 'sp' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'ไม่ยกเลิก'));
  }

  function pinSheet(id, nickname, pin) {
    const text = 'PIN ชั่วคราวสมาชิก Teddy ของคุณ' + nickname + ' (เบอร์ ' + id + '): ' + pin + '\nเข้าดูยอดเครดิตที่ ' + memberUrl + '\nเข้าแล้วระบบจะให้ตั้ง PIN ใหม่ทันที';
    const copied = h('div');
    openSheet(h('h2', null, 'PIN ชั่วคราว · ' + nickname),
      h('p', { class: 'muted' }, 'แสดงครั้งเดียว ระบบไม่เก็บ PIN ตัวจริง (เก็บแบบเข้ารหัสทางเดียว)'),
      h('div', { class: 'pinbox' }, pin),
      h('button', { class: 'btn blue', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(text); mount(copied, okBox('คัดลอกข้อความแล้ว ส่งให้ลูกค้าทาง LINE ส่วนตัวได้เลย')); }
        catch (_) { mount(copied, errBox({ message: 'คัดลอกไม่ได้ ให้จด PIN แทน' })); }
      } }, 'คัดลอกข้อความส่งลูกค้า'), copied, h('div', { class: 'sp' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'ปิด'));
  }

  async function resetPin(m) {
    const out = h('div');
    const btn = h('button', { class: 'btn red', type: 'button' }, 'ออก PIN ใหม่');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { const r = await call('/api/admin/reset-pin', { id: m.id }); await memberView(m.id); pinSheet(m.id, m.nickname, r.pin); }
      catch (e) { if (e.status !== 401) out.appendChild(errBox(e)); btn.disabled = false; }
    });
    openSheet(h('h2', null, 'ออก PIN ใหม่ให้ ' + m.nickname),
      h('p', null, 'PIN เดิมจะใช้ไม่ได้ทันที และลูกค้าถูกออกจากระบบทุกเครื่อง'),
      h('p', { class: 'muted small' }, 'ทำเมื่อลูกค้ายืนยันตัวตนแล้วเท่านั้น (เช่น มาที่ร้าน หรือทักจาก LINE ที่ร้านรู้จัก)'),
      btn, out, h('div', { class: 'sp' }), h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'ยกเลิก'));
  }

  function newMemberSheet() {
    let gender = '';
    const id = h('input', { inputmode: 'numeric', maxlength: 7, class: 'code', placeholder: '7 หลักท้าย' });
    digits(id, 7);
    const nick = h('input', { maxlength: 40, placeholder: 'ชื่อเล่น' });
    const out = h('div');
    const btn = h('button', { class: 'btn', type: 'button' }, 'สร้างสมาชิก');
    btn.addEventListener('click', async () => {
      out.textContent = '';
      if (!/^\d{7}$/.test(id.value)) return out.appendChild(errBox({ message: 'เบอร์ 7 หลักท้าย' }));
      if (!nick.value.trim()) return out.appendChild(errBox({ message: 'ใส่ชื่อเล่น' }));
      btn.disabled = true;
      try { const r = await call('/api/admin/member/create', { id: id.value, nickname: nick.value, gender }); await memberView(r.id); pinSheet(r.id, nick.value.trim(), r.pin); }
      catch (e) { if (e.status !== 401) out.appendChild(errBox(e)); btn.disabled = false; }
    });
    openSheet(h('h2', null, 'สมาชิกใหม่'),
      h('label', null, 'เบอร์โทร 7 หลักท้าย (ใช้เป็นเลขสมาชิก)'), id,
      h('label', null, 'ชื่อเล่น'), nick,
      h('label', null, 'เพศ'), chips([['ชาย', 'ชาย'], ['หญิง', 'หญิง'], ['', 'ไม่ระบุ']], '', (v) => { gender = v; }),
      h('div', { class: 'sp' }), btn, out, h('div', { class: 'sp' }), h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'ยกเลิก'));
  }

  // ---------------------------------------------------------------- summary
  async function summaryTab(root) {
    mount(root, h('div', { class: 'card center muted' }, 'กำลังโหลด…'));
    try {
      const s = await call('/api/admin/summary', {}); settings = s.settings;
      const p = s.settings.promo;
      const active = s.today >= p.start && s.today <= p.end;
      mount(root,
        h('div', { class: 'card sky' }, h('div', { class: 'bal-label' }, 'เครดิตคงเหลือในมือลูกค้า (ยอดที่ร้านต้องให้บริการ)'), h('div', { class: 'bal' }, money(s.balance)),
          h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('div', { class: 'k' }, 'เงินที่รับมา'), h('div', { class: 'v' }, money(s.paid))),
            h('div', { class: 'stat' }, h('div', { class: 'k' }, 'โบนัสที่แจก'), h('div', { class: 'v' }, money(s.credit - s.paid))))),
        h('div', { class: 'card' }, h('div', { class: 'kv' },
          h('div', { class: 'k' }, 'สมาชิก'), h('div', null, s.members.toLocaleString('th-TH') + ' คน'),
          h('div', { class: 'k' }, 'ตั้ง PIN เองแล้ว'), h('div', null, (s.pinSet || 0).toLocaleString('th-TH') + ' คน'),
          h('div', { class: 'k' }, 'เคยเข้าดูยอด'), h('div', null, (s.loggedIn || 0).toLocaleString('th-TH') + ' คน'),
          h('div', { class: 'k' }, 'รายการเติม'), h('div', null, s.nTop.toLocaleString('th-TH') + ' รายการ · เครดิต ' + money(s.credit)),
          h('div', { class: 'k' }, 'รายการใช้'), h('div', null, s.nUse.toLocaleString('th-TH') + ' รายการ · ' + money(s.used)),
          h('div', { class: 'k' }, 'โปรตอนนี้'), h('div', null, active ? p.name + ' (ถึง ' + date(p.end) + ')' : 'ไม่มีโปร — เติมแล้วไม่ได้โบนัส'))));
    } catch (e) { if (e.status !== 401) mount(root, errBox(e)); }
  }

  // ---------------------------------------------------------------- settings
  async function settingsTab(root) {
    let cur;
    try { cur = await call('/api/admin/settings', {}); } catch (e) { if (e.status !== 401) mount(root, errBox(e)); return; }
    const p = cur.promo;
    const name = h('input', { value: p.name || '', maxlength: 60 });
    const startI = h('input', { type: 'date', value: p.start }); const endI = h('input', { type: 'date', value: p.end });
    const rows = h('div');
    const addRow = (minB, pc) => {
      const a = h('input', { inputmode: 'decimal', value: minB === undefined ? '' : String(minB), placeholder: 'เติมตั้งแต่ (บาท)' });
      const b = h('input', { inputmode: 'decimal', value: pc === undefined ? '' : String(pc), placeholder: 'โบนัส %' });
      const r = h('div', { class: 'row' }, h('div', { class: 'grow' }, a), h('div', { class: 'grow' }, b), h('button', { class: 'chip', type: 'button', onclick: () => r.remove() }, 'ลบ'));
      r._get = () => ({ min: Number(a.value), bp: Math.round(Number(b.value) * 100) });
      rows.appendChild(r);
    };
    (p.tiers || []).forEach((t) => addRow(t.min / 100, t.bp / 100));
    const out = h('div');
    const btn = h('button', { class: 'btn', type: 'button' }, 'บันทึกโปร');
    btn.addEventListener('click', async () => {
      out.textContent = ''; btn.disabled = true;
      const tiers = Array.from(rows.children).map((r) => r._get()).filter((t) => t.min > 0);
      try { const r = await call('/api/admin/settings', { set: { promo: { name: name.value, start: startI.value, end: endI.value, tiers } } }); settings = r; mount(out, okBox('บันทึกแล้ว ใช้กับการเติมเงินครั้งต่อไป')); }
      catch (e) { if (e.status !== 401) out.appendChild(errBox(e)); }
      btn.disabled = false;
    });
    mount(root, h('div', { class: 'card' }, h('h2', null, 'โปรโบนัสเติมเงิน'),
      h('p', { class: 'muted small' }, 'โบนัสคิดจากวันที่เติม (เวลาไทย) และขั้นสูงสุดที่ยอดถึง · เติมนอกช่วงวัน = ไม่มีโบนัส · แก้แล้วไม่กระทบรายการเก่า'),
      h('label', null, 'ชื่อโปร'), name,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', null, 'เริ่ม'), startI), h('div', { class: 'grow' }, h('label', null, 'สิ้นสุด'), endI)),
      h('label', null, 'ขั้นโบนัส (เติมตั้งแต่กี่บาท → ได้เพิ่มกี่ %)'), rows,
      h('button', { class: 'chip', type: 'button', onclick: () => addRow() }, '+ เพิ่มขั้น'),
      h('div', { class: 'sp' }), btn, out));
  }

  // ---------------------------------------------------------------- import
  function importTab(root) {
    const file = h('input', { type: 'file', accept: '.json,application/json' });
    const info = h('div'); const bar = h('div'); const out = h('div');
    const prog = h('div', { class: 'progress hidden' }, bar);
    let data = null;
    const btn = h('button', { class: 'btn', type: 'button', disabled: true }, 'เริ่มนำเข้า');
    file.addEventListener('change', async () => {
      out.textContent = ''; info.textContent = ''; data = null; btn.disabled = true;
      const f = file.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (j.format !== 'teddy-member-import' || !Array.isArray(j.members) || !Array.isArray(j.txns)) throw new Error('ไม่ใช่ไฟล์นำเข้าของระบบนี้');
        data = j;
        const tops = j.txns.filter((t) => t.type === 'topup');
        mount(info, h('div', { class: 'msg info' }, 'สมาชิก ' + j.members.length + ' คน · เติมเงิน ' + tops.length + ' รายการ · ใช้ ' + (j.txns.length - tops.length) + ' รายการ' + (j.source ? ' · ที่มา: ' + j.source : '')));
        btn.disabled = false;
      } catch (e) { mount(info, errBox({ message: 'อ่านไฟล์ไม่ได้: ' + e.message })); }
    });
    btn.addEventListener('click', async () => {
      if (!data) return;
      btn.disabled = true; file.disabled = true; prog.classList.remove('hidden'); out.textContent = '';
      const pins = []; let written = 0;
      const jobs = [];
      for (let i = 0; i < data.members.length; i += 100) jobs.push({ members: data.members.slice(i, i + 100) });
      for (let i = 0; i < data.txns.length; i += 250) jobs.push({ txns: data.txns.slice(i, i + 250) });
      try {
        for (let k = 0; k < jobs.length; k++) {
          let tries = 0;
          for (;;) {
            try { const r = await call('/api/admin/import', jobs[k]); pins.push(...r.pins); written += r.rowsWritten; break; }
            catch (e) { if (e.status === 401 || ++tries >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * tries)); }
          }
          bar.style.width = Math.round((k + 1) / jobs.length * 100) + '%';
        }
        mount(out, okBox('นำเข้าเสร็จ: สมาชิกใหม่ ' + pins.length + ' คน · บันทึก ' + written + ' แถว (แถวที่มีอยู่แล้วจะข้าม ไม่ซ้ำ)'));
      } catch (e) {
        out.appendChild(errBox({ message: 'หยุดกลางทาง: ' + e.message + ' — กดนำเข้าไฟล์เดิมซ้ำได้ ระบบจะข้ามของที่เข้าแล้ว' }));
      }
      if (pins.length) {
        const csv = '﻿เบอร์7หลัก,ชื่อเล่น,PINชั่วคราว\n' + pins.map((p) => [p.id, '"' + String(p.nickname).replace(/"/g, '""') + '"', p.pin].join(',')).join('\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        out.appendChild(h('div', { class: 'msg err' }, 'ไฟล์ PIN มีครั้งเดียว ระบบเก็บ PIN แบบเข้ารหัส ดูซ้ำไม่ได้ · เก็บไฟล์เป็นความลับ ส่งให้ลูกค้าทีละคนแล้วลบทิ้ง (ถ้าทำหาย ใช้ "ออก PIN ใหม่" รายคน)'));
        out.appendChild(h('a', { class: 'btn', href: url, download: 'teddy-member-pins.csv' }, 'ดาวน์โหลดไฟล์ PIN (' + pins.length + ' คน)'));
      }
      file.disabled = false; settings = (await call('/api/admin/summary', {}).catch(() => ({}))).settings || settings;
    });
    mount(root, h('div', { class: 'card' }, h('h2', null, 'นำเข้าข้อมูลสมาชิก'),
      h('p', { class: 'muted small' }, 'เลือกไฟล์ teddy-member-import.json · นำเข้าซ้ำได้ไม่ซ้ำ (ข้ามรายการที่มีแล้ว) · สมาชิกใหม่ทุกคนได้ PIN ชั่วคราว ต้องตั้งเองตอนเข้าครั้งแรก'),
      file, info, h('div', { class: 'sp' }), btn, h('div', { class: 'sp' }), prog, out));
  }

  // ---------------------------------------------------------------- audit
  async function auditTab(root) {
    const NAMES = { admin_login: 'เข้าระบบ', admin_login_fail: 'รหัสผิด', topup: 'เติมเงิน', use: 'หักยอด', void: 'ยกเลิกรายการ', reset_pin: 'ออก PIN ใหม่', unlock: 'ปลดล็อก', status: 'เปิด/ปิดบัญชี', settings: 'แก้โปร', import: 'นำเข้า', member_create: 'สมาชิกใหม่' };
    try {
      const r = await call('/api/admin/audit', {});
      const tb = h('tbody');
      for (const a of r.results) {
        let d = '';
        try { const o = a.detail ? JSON.parse(a.detail) : null; if (o) d = o.amount ? money(o.amount) : o.reason || o.status || (o.members !== undefined ? o.members + ' คน / ' + o.txns + ' รายการ' : ''); } catch (_) {}
        tb.appendChild(h('tr', null, h('td', null, unix(a.at)), h('td', null, a.actor === 'owner' ? 'เจ้าของ' : a.actor === 'staff' ? 'แม่บ้าน' : a.actor), h('td', null, NAMES[a.action] || a.action), h('td', null, a.member_id || ''), h('td', null, d), h('td', { class: 'muted' }, a.ip || '')));
      }
      mount(root, h('div', { class: 'card' }, h('h2', null, 'ประวัติแอดมิน 200 รายการล่าสุด'),
        h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['เวลา', 'ใคร', 'ทำอะไร', 'สมาชิก', 'รายละเอียด', 'IP'].map((x) => h('th', null, x)))), tb)));
    } catch (e) { if (e.status !== 401) mount(root, errBox(e)); }
  }

  if (token && role) start(); else loginView();
})();
