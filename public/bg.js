(function () {
  const bg = document.getElementById('bg');
  if (!bg) return;
  const code = ['ssh root@node-1 -p 20001', 'docker run -d --cpus 2 --memory 2g vps', '$ systemctl status panel', 'const vps = await create(plan);',
    'if (vps.status === "running") {', '  notify(user, "VPS ready");', '}', 'import { db } from "./panel";', 'SELECT * FROM vps WHERE user_id=1;',
    'git push origin main', 'npm run build && pm2 restart all', 'for i in range(10): deploy(i)', 'chmod 600 ~/.ssh/id_rsa',
    'tail -f /var/log/panel.log', '200 OK  GET /api/dashboard', 'curl -s -X POST /api/bot/deploy', 'echo "root:$P" | chpasswd', 'docker stop vps-12'];
  const cols = ['var(--b)', 'var(--a)', 'var(--green)', 'var(--b)', 'var(--amber)'];
  const spots = [
    { top: '8%', right: '3%', s: 1 }, { bottom: '5%', left: '2%', s: 1 }, { top: '20%', left: '4%', s: .8 },
    { top: '44%', right: '22%', s: .75 }, { bottom: '8%', right: '4%', s: .9 }];
  spots.forEach((p, i) => {
    const m = document.createElement('div');
    m.className = 'mon m' + i;
    ['top', 'bottom', 'left', 'right'].forEach(k => { if (p[k]) m.style[k] = p[k]; });
    m.style.transform = 'scale(' + p.s + ')';
    m.style.setProperty('--c', cols[i]);
    const lines = code.slice().sort(() => Math.random() - .5).join('\n');
    const scr = document.createElement('div'); scr.className = 'scr';
    const pre = document.createElement('pre');
    pre.textContent = lines + '\n' + lines;
    pre.style.animationDuration = (14 + i * 3) + 's';
    scr.appendChild(pre);
    m.appendChild(scr);
    m.insertAdjacentHTML('beforeend', '<div class="neck"></div><div class="base"></div>');
    bg.appendChild(m);
  });
})();
