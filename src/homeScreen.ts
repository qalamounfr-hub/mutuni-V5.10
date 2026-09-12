import type {NavigateFn} from './router';
import {listMatns} from './mutuniDB';
import {listSessions, computeStreak, minutesToday, getDueBayts} from './srs';
import {VERSION} from './version';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));

export function renderHomeScreen(root: HTMLElement, _params: unknown, navigate: NavigateFn) {
  root.innerHTML = `
    <header class="home-header">
      <div class="home-logo">مُتُونِي</div>
      <div class="home-tagline">Révision des mutūn à voix haute</div>
    </header>
    <div class="home-stats" id="stats"></div>
    <div class="home-due" id="due"></div>
    <section class="home-section">
      <h2>Mutûn disponibles</h2>
      <div class="home-matn-list" id="matnList">Chargement…</div>
    </section>
    <footer class="home-footer">Mutuni v${esc(VERSION)} · 100% local, aucune donnée envoyée</footer>
  `;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;

  void (async () => {
    const [sessions, due] = await Promise.all([listSessions(), getDueBayts(5)]);
    const streak = computeStreak(sessions);
    const minutes = minutesToday(sessions);
    $('stats').innerHTML = `
      <div class="home-stat"><div class="home-stat-value">🔥 ${streak}</div><div class="home-stat-label">jours de suite</div></div>
      <div class="home-stat"><div class="home-stat-value">${minutes}</div><div class="home-stat-label">min aujourd'hui</div></div>
    `;
    $('due').innerHTML = due.length
      ? `<div class="home-due-title">À réviser (${due.length})</div>` +
        due.map(d => `<button class="home-due-item" data-matn="${esc(d.matnId)}" data-bab="${esc(d.babId)}" data-bayt="${d.baytIdx}">${esc(d.babId)} · bayt ${d.baytIdx + 1} <span class="home-due-overdue">${Math.round(d.overdueDays)}j de retard</span></button>`).join('')
      : '';
    $('due').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-matn]');
      if (!btn) return;
      navigate('recite', {matnId: btn.dataset.matn, babId: btn.dataset.bab, baytIdx: Number(btn.dataset.bayt)});
    });
  })();

  void (async () => {
    const matns = await listMatns();
    if (!matns.length) { $('matnList').innerHTML = '<div class="home-empty">Aucun matn chargé.</div>'; return; }
    $('matnList').innerHTML = matns.map(m => `<button class="home-matn-card" data-matn="${esc(m.id)}"><span class="home-matn-title">${esc(m.title)}</span></button>`).join('');
    $('matnList').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-matn]');
      if (!btn) return;
      navigate('chapters', {matnId: btn.dataset.matn});
    });
  })();
}
