/* Спільний код табло (index.html), пульта (remote.html) і талона (talon.html). */
(function (g) {
  'use strict';

  // Безкоштовні публічні MQTT-брокери. Підключаємось до всіх одразу:
  // якщо один недоступний (або порт заблоковано в офісі) — працюють інші.
  // Дублікати команд відсіюються за id, а стану — за rev.
  const BROKERS = [
    { name: 'shiftr', url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' }, // порт 443
    { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
  ];
  const PREFIX = 'cnav-cherga/v1/';

  // Приватний канал (табло ↔ пульт) і публічний (табло ↔ відвідувачі) мають різні коди,
  // тож власник талона не може керувати табло.
  const topics = {
    priv: room => ({ state: `${PREFIX}${room}/state`, cmd: `${PREFIX}${room}/cmd`, online: `${PREFIX}${room}/online` }),
    pub: pub => ({ board: `${PREFIX}p/${pub}/board`, req: `${PREFIX}p/${pub}/req` }),
  };

  const TYPES = {
    quick: { icon: '⚡', name: 'Швидке питання', note: 'насправді хвилин сорок' },
    look:  { icon: '👀', name: '«Просто глянь»', note: 'глянути ≠ подивитися' },
    hard:  { icon: '🧠', name: 'Складне питання', note: 'краще з кавою' },
    vip:   { icon: '🍫', name: 'З фонданом', note: 'без черги' },
    paper: { icon: '🎫', name: 'Без телефона', note: 'видано вручну' },
  };

  // ---------- 7-сегментне табло ----------
  const GLYPHS = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg',
    '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', 'П': 'abcef', '-': 'g',
  };
  function makeSeg7(container, cells) {
    const W = 50, H = 90, t = 10, gp = 1.6, gap = 14, h = t / 2;
    const L = h, R = W - h, T = h, M = H / 2, B = H - h;
    const hs = (x1, x2, y) => `${x1+gp},${y} ${x1+gp+h},${y-h} ${x2-gp-h},${y-h} ${x2-gp},${y} ${x2-gp-h},${y+h} ${x1+gp+h},${y+h}`;
    const vs = (x, y1, y2) => `${x},${y1+gp} ${x+h},${y1+gp+h} ${x+h},${y2-gp-h} ${x},${y2-gp} ${x-h},${y2-gp-h} ${x-h},${y1+gp+h}`;
    const segs = { a: hs(L, R, T), g: hs(L, R, M), d: hs(L, R, B), f: vs(L, T, M), b: vs(R, T, M), e: vs(L, M, B), c: vs(R, M, B) };
    let body = '';
    for (let i = 0; i < cells; i++) {
      body += `<g transform="translate(${i * (W + gap)},0)">` +
        Object.entries(segs).map(([k, p]) => `<polygon class="s" data-c="${i}" data-s="${k}" points="${p}"/>`).join('') + '</g>';
    }
    const vw = cells * (W + gap) - gap;
    container.innerHTML = `<svg viewBox="-2 -2 ${vw + 16} ${H + 4}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g transform="skewX(-6) translate(10,0)">${body}</g></svg>`;
    const els = [...container.querySelectorAll('.s')];
    return {
      set(str) {
        const chars = [...str];
        els.forEach(el => el.classList.toggle('on', (GLYPHS[chars[+el.dataset.c]] || '').includes(el.dataset.s)));
      },
    };
  }

  const ticketStr = n => 'П-' + String(n % 1000).padStart(3, '0');

  function plural(n, [one, few, many]) {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  }

  function randomId(n = 12) {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    return [...crypto.getRandomValues(new Uint8Array(n))].map(x => abc[x % abc.length]).join('');
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // QR-код як SVG (бібліотека qrcode-generator, якщо підключена)
  function qrSvg(text) {
    if (!g.qrcode) return '';
    const q = g.qrcode(0, 'M');
    q.addData(text); q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    return `<svg viewBox="-3 -3 ${n + 6} ${n + 6}" shape-rendering="crispEdges" role="img" aria-label="QR-код"><rect x="-3" y="-3" width="${n + 6}" height="${n + 6}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
  }

  // ---------- шина повідомлень ----------
  // subs — на які теми підписатись; will — «останнє слово», яке брокер опублікує, якщо зв'язок обірветься.
  function createBus({ tag = 'x', subs = [], will, onMessage, onConn, onLinkUp }) {
    const links = [];
    const report = () => onConn && onConn(links.filter(l => l.up).length, links.length, links);

    if (!g.mqtt) { setTimeout(report, 0); return { links, ok: false, publish() {}, close() {} }; }

    const cid = `cnav-${tag}-${randomId(8)}`;
    const dec = new TextDecoder();
    BROKERS.forEach(b => {
      const opts = {
        clientId: `${cid}-${b.name}`,
        keepalive: 30, reconnectPeriod: 4000, connectTimeout: 10000, clean: true,
      };
      if (b.username) { opts.username = b.username; opts.password = b.password; }
      if (will) opts.will = { topic: will.topic, payload: will.payload, retain: true, qos: 1 };

      const link = { name: b.name, up: false, c: null };
      links.push(link);
      let c;
      try { c = link.c = g.mqtt.connect(b.url, opts); } catch (e) { return; }

      c.on('connect', () => {
        link.up = true;
        if (subs.length) c.subscribe(subs, { qos: 1 });
        report();
        onLinkUp && onLinkUp(link);
      });
      const down = () => { if (link.up) { link.up = false; report(); } };
      c.on('close', down);
      c.on('offline', down);
      c.on('error', () => {});
      c.on('message', (topic, payload) => onMessage && onMessage(topic, dec.decode(payload), link));
    });
    setTimeout(report, 0);

    return {
      links, ok: true,
      publish(topic, text, opts = {}) {
        links.forEach(l => { if (l.up) l.c.publish(topic, text, opts); });
      },
      // clear — retained-теми, які треба очистити перед відключенням (наприклад, при зміні коду)
      close(clear = []) {
        links.forEach(l => {
          if (!l.c) return;
          try {
            if (l.up) clear.forEach(t => l.c.publish(t, '', { retain: true }));
            l.c.end(false);
          } catch (e) {}
        });
      },
    };
  }

  g.CNAV = { BROKERS, topics, TYPES, makeSeg7, ticketStr, plural, randomId, esc, qrSvg, createBus };
})(window);
