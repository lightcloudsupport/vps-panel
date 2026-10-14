(function () {
  const T = [
    {id:"neon",name:"Neon Blue",sub:"Default futuristic",a:'#3b82f6',b:'#22d3ee',bg:'#050a14',bg2:'#0d1f4a'},
    {id:"tvm",name:"TVM Panel",sub:"Classic dark blue",a:'#2563eb',b:'#60a5fa',bg:'#070d1c',bg2:'#112a5c'},
    {id:"arix",name:"Arix",sub:"Slate & indigo",a:'#6366f1',b:'#a78bfa',bg:'#0a0c1c',bg2:'#1c1f4d'},
    {id:"nebula",name:"Nebula",sub:"Deep space purple",a:'#9333ea',b:'#ec4899',bg:'#0b0618',bg2:'#2a0f4d',on:'#fff'},
    {id:"cyan",name:"Cyber Cyan",sub:"Electric teal",a:'#06b6d4',b:'#67e8f9',bg:'#021014',bg2:'#053a47'},
    {id:"violet",name:"Ultra Violet",sub:"Rich purple",a:'#7c3aed',b:'#c084fc',bg:'#08050f',bg2:'#2a1450',on:'#fff'},
    {id:"synth",name:"Synthwave",sub:"Retro neon",a:'#e879f9',b:'#22d3ee',bg:'#0d0618',bg2:'#36104d'},
    {id:"crimson",name:"Crimson",sub:"Hot red",a:'#ef4444',b:'#fb7185',bg:'#100507',bg2:'#4a0f1a',on:'#fff'},
    {id:"lava",name:"Lava",sub:"Red to amber",a:'#ef4444',b:'#f59e0b',bg:'#0f0605',bg2:'#4a1a0a'},
    {id:"sunset",name:"Sunset",sub:"Orange glow",a:'#f97316',b:'#f43f5e',bg:'#0f0804',bg2:'#4a240c'},
    {id:"gold",name:"Gold Rush",sub:"Gold on green-black",a:'#eab308',b:'#fde68a',bg:'#050a07',bg2:'#1a2a12'},
    {id:"matrix",name:"Matrix",sub:"Hacker green",a:'#10b981',b:'#84cc16',bg:'#020a05',bg2:'#05301c'},
    {id:"aurora",name:"Aurora",sub:"Northern lights",a:'#14b8a6',b:'#a78bfa',bg:'#04100f',bg2:'#0f3a3a'},
    {id:"ocean",name:"Deep Ocean",sub:"Sea blue",a:'#0ea5e9',b:'#2dd4bf',bg:'#020c14',bg2:'#063a5c'},
    {id:"midnight",name:"Midnight",sub:"Dark indigo",a:'#4f46e5',b:'#38bdf8',bg:'#05051a',bg2:'#14145a',on:'#fff'},
    {id:"sakura",name:"Sakura",sub:"Soft pink",a:'#ec4899',b:'#f9a8d4',bg:'#10060d',bg2:'#4a1634'},
    {id:"ice",name:"Ice",sub:"Cool silver",a:'#94a3b8',b:'#bae6fd',bg:'#070a0f',bg2:'#1e2a3a'},
    {id:"mono",name:"Mono",sub:"Black & white",a:'#9ca3af',b:'#f3f4f6',bg:'#050505',bg2:'#262626'}
  ];
  const KEY = 'lc-theme';
  const get = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const post = s => fetch('/api/profile/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: JSON.stringify(s) }) }).catch(() => {});
  function apply(s) {
    const t = T.find(x => x.id === s.id) || T[0], r = document.documentElement.style;
    r.setProperty('--a', s.accent || t.a);
    r.setProperty('--b', s.accent ? 'color-mix(in srgb,' + s.accent + ' 60%,#fff)' : t.b);
    r.setProperty('--bg', t.bg); r.setProperty('--bg2', t.bg2); r.setProperty('--on', t.on || '#04101f');
  }
  const LC = window.LCTheme = {
    themes: T, get, apply,
    set(s) { apply(s); try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} post(s); },
    sync(server) {
      if (!server) { const l = get(); if (l.id) post(l); return; }
      try { const s = JSON.parse(server); apply(s); localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
    },
    mount() {
      if (document.getElementById('pal')) return;
      const b = document.createElement('button');
      b.id = 'pal'; b.className = 'pal'; b.title = 'Themes'; b.setAttribute('aria-label', 'Change theme'); b.textContent = '\u{1F3A8}';
      const p = document.createElement('div'); p.className = 'pp hide'; p.id = 'pp';
      document.body.append(b, p);
      const draw = () => {
        const s = get(), cur = T.find(x => x.id === s.id) || T[0];
        p.innerHTML = '';
        const h = document.createElement('h4'); h.textContent = 'Themes';
        const a = document.createElement('p'); a.textContent = 'Active: ' + cur.name + (s.accent ? ' (custom accent)' : '');
        const g = document.createElement('div'); g.className = 'tg';
        T.forEach(t => {
          const c = document.createElement('button'); c.type = 'button'; c.className = 'tc' + (t.id === cur.id ? ' on' : '');
          const sw = document.createElement('i'); sw.style.background = 'linear-gradient(120deg,' + t.bg2 + ',' + t.a + ',' + t.b + ')';
          const n = document.createElement('b'); n.textContent = t.name;
          const d = document.createElement('small'); d.textContent = t.sub;
          c.append(sw, n, d); c.onclick = () => { LC.set({ id: t.id }); draw(); }; g.append(c);
        });
        const f = document.createElement('div'); f.className = 'pf';
        const l = document.createElement('span'); l.textContent = 'Custom accent';
        const i = document.createElement('input'); i.type = 'color'; i.value = s.accent || cur.a;
        i.oninput = () => apply({ id: cur.id, accent: i.value });
        i.onchange = () => { LC.set({ id: cur.id, accent: i.value }); draw(); };
        const r = document.createElement('button'); r.type = 'button'; r.className = 'btn ghost'; r.textContent = 'Reset'; r.style.marginLeft = 'auto';
        r.onclick = () => { LC.set({ id: 'neon' }); draw(); };
        f.append(l, i, r); p.append(h, a, g, f);
      };
      b.onclick = () => { p.classList.toggle('hide'); if (!p.classList.contains('hide')) draw(); };
      document.addEventListener('keydown', e => { if (e.key === 'Escape') p.classList.add('hide'); });
      document.addEventListener('click', e => { if (!p.contains(e.target) && e.target !== b) p.classList.add('hide'); });
    }
  };
  apply(get());
})();
