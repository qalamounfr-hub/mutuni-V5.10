import type {NavigateFn, ScreenParams} from './router';
import {listMatns, listBabs, listBayts} from './mutuniDB';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));

export function renderChaptersScreen(root: HTMLElement, params: ScreenParams, navigate: NavigateFn) {
  const {matnId} = params;
  if (!matnId) { root.innerHTML = `<div class="app-error">Matn non spécifié.</div>`; return; }

  root.innerHTML = `
    <header class="screen-header">
      <button class="screen-back" id="back">←</button>
      <div class="screen-title" id="title">Chapitres</div>
      <div class="screen-header-spacer"></div>
    </header>
    <div class="chapters-toolbar" id="toolbar"></div>
    <div class="chapters-list" id="list">Chargement…</div>
  `;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  $('back').addEventListener('click', () => navigate('home'));

  // Mode continu (5.8.0) : bouton global pour réciter tout le matn d'affilée,
  // sans repasser par la liste des chapitres entre chaque bab — utile pour
  // tester la reconnaissance sur du long terme plutôt que bayt par bayt.
  $('toolbar').innerHTML = `<button class="matn-continuous-btn" id="reciteAll">🎙️ Réciter tout le matn</button>`;
  $('toolbar').addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#reciteAll')) return;
    navigate('recite', {matnId, baytIdx: 0, mode: 'continuous'});
  });

  void (async () => {
    const [matns, babs] = await Promise.all([listMatns(), listBabs(matnId)]);
    const matn = matns.find(m => m.id === matnId);
    $('title').textContent = matn?.title ?? matnId;
    if (!babs.length) { $('list').innerHTML = '<div class="home-empty">Aucun chapitre.</div>'; return; }

    const baytCounts = await Promise.all(babs.map(b => listBayts(b.id)));
    // Chaque carte de bab porte deux actions distinctes : le clic sur la
    // carte elle-même ouvre le mode bayt-par-bayt habituel (par défaut,
    // inchangé) ; le bouton "en continu" (5.8.0) ouvre le même bab mais en
    // mode 'continuous' (récitation ininterrompue, pour tester la
    // reconnaissance sur un bab entier sans réappuyer sur le micro).
    // `chapter-card` est un <div role="button"> (pas un <button>) car il
    // contient maintenant un vrai <button> imbriqué pour l'action "en
    // continu" — un <button> dans un <button> est invalide en HTML et se
    // comporte de façon incohérente selon les navigateurs.
    $('list').innerHTML = babs.map((b, i) => `
      <div class="chapter-card" role="button" tabindex="0" data-bab="${esc(b.id)}" style="${b.clr ? `border-color:${esc(b.clr[0])}` : ''}">
        <span class="chapter-title">${esc(b.title)}</span>
        ${b.sub ? `<span class="chapter-sub">${esc(b.sub)}</span>` : ''}
        <span class="chapter-count">${baytCounts[i].length} bayts</span>
        <button class="chapter-continuous" data-bab-continuous="${esc(b.id)}" title="Réciter ce chapitre en continu">🎙️ En continu</button>
      </div>
    `).join('');
    $('list').addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const continuousBtn = target.closest<HTMLElement>('[data-bab-continuous]');
      if (continuousBtn) {
        navigate('recite', {matnId, babId: continuousBtn.dataset.babContinuous, baytIdx: 0, mode: 'continuous'});
        return;
      }
      const card = target.closest<HTMLElement>('[data-bab]');
      if (!card) return;
      navigate('recite', {matnId, babId: card.dataset.bab, baytIdx: 0});
    });
    $('list').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-bab-continuous]')) return; // le <button> natif gère déjà son propre Enter/Espace
      const card = target.closest<HTMLElement>('[data-bab][role="button"]');
      if (!card) return;
      e.preventDefault();
      navigate('recite', {matnId, babId: card.dataset.bab, baytIdx: 0});
    });
  })();
}
