import type {NavigateFn} from './router';
import {listSessions, computeStreak, minutesToday, listAllSrsStates} from './srs';

export function renderProgressScreen(root: HTMLElement, _params: unknown, navigate: NavigateFn) {
  root.innerHTML = `
    <header class="screen-header">
      <button class="screen-back" id="back">←</button>
      <div class="screen-title">Ma progression</div>
      <div class="screen-header-spacer"></div>
    </header>
    <div class="progress-stats" id="stats">Chargement…</div>
  `;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  $('back').addEventListener('click', () => navigate('home'));

  void (async () => {
    const [sessions, srsStates] = await Promise.all([listSessions(), listAllSrsStates()]);
    const streak = computeStreak(sessions);
    const minutes = minutesToday(sessions);
    const byStatus: Record<string, number> = {};
    for (const row of srsStates) byStatus[row.state.status] = (byStatus[row.state.status] ?? 0) + 1;
    const total = srsStates.length;

    $('stats').innerHTML = `
      <div class="home-stat"><div class="home-stat-value">🔥 ${streak}</div><div class="home-stat-label">jours de suite</div></div>
      <div class="home-stat"><div class="home-stat-value">${minutes}</div><div class="home-stat-label">min aujourd'hui</div></div>
      <div class="home-stat"><div class="home-stat-value">${total}</div><div class="home-stat-label">bayts travaillés</div></div>
      <div class="progress-breakdown">
        <div class="progress-row"><span>Nouveaux</span><span>${byStatus['new'] ?? 0}</span></div>
        <div class="progress-row"><span>En apprentissage</span><span>${byStatus['learning'] ?? 0}</span></div>
        <div class="progress-row"><span>En révision</span><span>${byStatus['review'] ?? 0}</span></div>
        <div class="progress-row"><span>Maîtrisés</span><span>${byStatus['mastered'] ?? 0}</span></div>
      </div>
    `;
  })();
}
