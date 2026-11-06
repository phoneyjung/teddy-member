(function () {
  'use strict';
  const { h, mount, api, money, date, shop, pct, store, digits } = window.T;
  const app = document.getElementById('app');
  document.getElementById('logo').appendChild(window.T.bear());
  const KEY = 'tm_member';
  let token = store.get(KEY);
  let stopIdle = null;

  function errBox(e) { return h('div', { class: 'msg err', role: 'alert' }, e.message || String(e)); }
  function logout(msg) {
    if (token) api('/api/logout', {}, token).catch(() => {});
    token = null; store.del(KEY);
    if (stopIdle) stopIdle();
    loginView(msg);
  }

  // ---------------------------------------------------------------- login
  function loginView(note) {
    const id = h('input', { id: 'mid', inputmode: 'numeric', autocomplete: 'username', maxlength: 7, placeholder: 'เช่น 2967770', class: 'code' });
    const pin = h('input', { id: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxlength: 6, placeholder: '••••••', class: 'code' });
    digits(id, 7); digits(pin, 6);
    const out = h('div');
    const btn = h('button', { class: 'btn', type: 'button' }, 'ดูยอดเครดิต');
    async function go() {
      out.textContent = '';
      if (!/^\d{7}$/.test(id.value)) { out.appendChild(errBox({ message: 'กรอกเบอร์โทร 7 หลักท้ายให้ครบ' })); id.focus(); return; }
      if (!/^\d{6}$/.test(pin.value)) { out.appendChild(errBox({ message: 'กรอก PIN 6 หลักให้ครบ' })); pin.focus(); return; }
      btn.disabled = true; btn.textContent = 'กำลังตรวจสอบ…';
      try {
        const r = await api('/api/login', { id: id.value, pin: pin.value });
        token = r.token; store.set(KEY, token);
        if (r.mustChangePin) changePinView(pin.value, true);
        else home();
      } catch (e) {
        pin.value = '';
        out.appendChild(errBox(e));
      } finally { btn.disabled = false; btn.textContent = 'ดูยอดเครดิต'; }
    }
    btn.addEventListener('click', go);
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    mount(app,
      h('div', { class: 'card' },
        h('h2', null, 'เข้าดูยอดของฉัน'),
        note ? h('div', { class: 'msg info' }, note) : null,
        h('label', { for: 'mid' }, 'เบอร์โทร 7 หลักท้าย'),
        id,
        h('p', { class: 'muted small' }, 'เช่น เบอร์ 091-296-7770 ให้กรอก 2967770'),
        h('label', { for: 'pin' }, 'PIN 6 หลัก'),
        pin,
        h('div', { class: 'sp' }),
        btn, out),
      h('div', { class: 'card' },
        h('h3', null, 'ลืม PIN หรือยังไม่มี PIN?'),
        h('p', { class: 'muted' }, 'ติดต่อแม่บ้านที่ร้าน หรือทัก LINE ร้าน Teddy 1 ' + window.TEDDY_LINE.teddy1 + ' · Teddy 2 ' + window.TEDDY_LINE.teddy2 + ' ร้านจะออก PIN ชั่วคราวให้ แล้วคุณตั้ง PIN ใหม่เองตอนเข้าครั้งแรก')));
    id.focus();
  }

  // ---------------------------------------------------------------- change PIN
  function changePinView(oldPinKnown, first) {
    const oldPin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxlength: 6, class: 'code', placeholder: '••••••' });
    const p1 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 6, class: 'code', placeholder: '••••••' });
    const p2 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 6, class: 'code', placeholder: '••••••' });
    [oldPin, p1, p2].forEach((x) => digits(x, 6));
    const out = h('div');
    const btn = h('button', { class: 'btn', type: 'button' }, 'บันทึก PIN ใหม่');
    btn.addEventListener('click', async () => {
      out.textContent = '';
      const op = oldPinKnown || oldPin.value;
      if (!/^\d{6}$/.test(op)) return out.appendChild(errBox({ message: 'กรอก PIN เดิม 6 หลัก' }));
      if (!/^\d{6}$/.test(p1.value)) return out.appendChild(errBox({ message: 'PIN ใหม่ต้องเป็นตัวเลข 6 หลัก' }));
      if (p1.value !== p2.value) return out.appendChild(errBox({ message: 'PIN ใหม่ 2 ช่องไม่ตรงกัน' }));
      btn.disabled = true;
      try {
        const r = await api('/api/change-pin', { oldPin: op, newPin: p1.value }, token);
        token = r.token; store.set(KEY, token);
        home('ตั้ง PIN ใหม่เรียบร้อย ครั้งหน้าใช้ PIN นี้เข้าดูยอด');
      } catch (e) {
        if (e.status === 401 && e.error === 'auth') return logout('หมดเวลา กรุณาเข้าสู่ระบบอีกครั้ง');
        out.appendChild(errBox(e));
      } finally { btn.disabled = false; }
    });
    mount(app, h('div', { class: 'card' },
      h('h2', null, first ? 'ตั้ง PIN ของคุณเอง' : 'เปลี่ยน PIN'),
      first ? h('div', { class: 'msg info' }, 'PIN ที่ได้จากร้านใช้ได้ครั้งเดียว กรุณาตั้ง PIN ใหม่ที่คุณจำได้') : null,
      oldPinKnown ? null : [h('label', null, 'PIN เดิม'), oldPin],
      h('label', null, 'PIN ใหม่ 6 หลัก'), p1,
      h('label', null, 'ยืนยัน PIN ใหม่'), p2,
      h('p', { class: 'muted small' }, 'ตัวเลข 6 หลักอะไรก็ได้ แต่ต้องไม่ซ้ำกับ PIN เดิม'),
      h('div', { class: 'sp' }), btn, out,
      first ? null : h('div', { class: 'sp' }),
      first ? null : h('button', { class: 'btn ghost', type: 'button', onclick: () => home() }, 'ยกเลิก')));
    (oldPinKnown ? p1 : oldPin).focus();
  }

  // ---------------------------------------------------------------- home
  async function home(flash) {
    mount(app, h('div', { class: 'card center muted' }, 'กำลังโหลด…'));
    let d;
    try { d = await api('/api/me', {}, token); }
    catch (e) {
      if (e.error === 'mustchange') return changePinView(null, true);
      if (e.status === 401) return logout('หมดเวลา กรุณาเข้าสู่ระบบอีกครั้ง');
      return mount(app, h('div', { class: 'card' }, errBox(e), h('div', { class: 'sp' }),
        h('button', { class: 'btn blue', type: 'button', onclick: () => home() }, 'ลองใหม่')));
    }
    if (!stopIdle) stopIdle = window.T.idle(10, () => logout('ออกจากระบบอัตโนมัติ เพราะไม่ได้ใช้งาน 10 นาที'));

    const tops = d.txns.filter((t) => t.type === 'topup');
    const lastTop = tops[0];

    const list = h('ul', { class: 'list' });
    if (!d.txns.length) list.appendChild(h('li', { class: 'item muted' }, 'ยังไม่มีรายการ'));
    for (const t of d.txns) {
      const isTop = t.type === 'topup';
      list.appendChild(h('li', { class: 'item' },
        h('div', { class: 'dot ' + (isTop ? 'in' : 'out') }, isTop ? '+' : '−'),
        h('div', { class: 'main' },
          h('div', { class: 't' }, isTop ? 'เติมเงิน ' + money(t.amount) : 'ใช้เครดิต', isTop && t.bonusBp ? [' ', h('span', { class: 'badge gold' }, 'โบนัส ' + pct(t.bonusBp))] : null),
          h('div', { class: 's' }, date(t.at), t.branch ? ' · ' + shop(t.branch) : '')),
        h('div', { class: 'amt' },
          h('div', { class: 'a ' + (isTop ? 'in' : 'out') }, money(t.delta, true)),
          h('div', { class: 'b' }, 'คงเหลือ ' + money(t.bal)))));
    }

    mount(app,
      flash ? h('div', { class: 'msg ok' }, flash) : null,
      h('div', { class: 'card sky' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'bal-label' }, 'สวัสดี คุณ' + d.member.nickname + ' · สมาชิก •••' + d.member.id.slice(-4))),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => home() }, 'รีเฟรช')),
        h('div', { class: 'bal-label' }, 'เครดิตคงเหลือ'),
        h('div', { class: 'bal' }, money(d.balance)),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'k' }, 'เติมล่าสุด'), h('div', { class: 'v' }, lastTop ? date(lastTop.at).split(' · ')[0] : '-')),
          h('div', { class: 'stat' }, h('div', { class: 'k' }, 'ใช้ไปแล้วทั้งหมด'), h('div', { class: 'v' }, money(d.used))))),
      h('div', { class: 'card' }, h('h3', null, 'ประวัติล่าสุด'), list,
        d.txns.length >= 100 ? h('p', { class: 'muted small center' }, 'แสดง 100 รายการล่าสุด') : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => changePinView(null, false) }, 'เปลี่ยน PIN'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => logout('ออกจากระบบแล้ว') }, 'ออกจากระบบ')));
  }

  if (!window.TEDDY_API) mount(app, h('div', { class: 'card' }, errBox({ message: 'ยังไม่ได้ตั้งค่า config.js' })));
  else if (token) home();
  else loginView();
})();
