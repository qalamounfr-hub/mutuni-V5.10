// Routeur minimal entre écrans, sans dépendance externe (cohérent avec le
// reste du projet : DOM manipulé directement, pas de framework).
export type ScreenName = 'home' | 'chapters' | 'recite' | 'progress' | 'reviewErrors';

export interface ScreenParams {
  matnId?: string;
  babId?: string;
  baytIdx?: number;
  mode?: 'single' | 'continuous' | 'free';
}

export interface NavigateFn { (screen: ScreenName, params?: ScreenParams): void; }

export type ScreenRenderer = (root: HTMLElement, params: ScreenParams, navigate: NavigateFn) => void | (() => void);

export class Router {
  private root: HTMLElement;
  private screens: Map<ScreenName, ScreenRenderer> = new Map();
  private cleanup: (() => void) | null = null;

  constructor(root: HTMLElement) { this.root = root; }

  register(name: ScreenName, renderer: ScreenRenderer) { this.screens.set(name, renderer); }

  navigate: NavigateFn = (screen, params = {}) => {
    this.cleanup?.();
    this.cleanup = null;
    const renderer = this.screens.get(screen);
    if (!renderer) { this.root.innerHTML = `<div class="app-error">Écran inconnu: ${screen}</div>`; return; }
    this.root.innerHTML = '';
    const result = renderer(this.root, params, this.navigate);
    if (typeof result === 'function') this.cleanup = result;
    window.scrollTo(0, 0);
  };
}
