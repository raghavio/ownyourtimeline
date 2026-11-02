import type { SavedTweet, TweetInput } from './shared';
import { fallbackCard, renderTweetCard, sanitizeCard } from './tweet-card';

const MAX_POSTS = 200;
export class FilteredView {
  private posts = new Map<string, SavedTweet>();
  private cards = new Map<string, HTMLElement>();
  private enabled = false;
  private active = false;
  private open = false;
  private tab = document.createElement('button');
  private label = document.createElement('span');
  private panel = document.createElement('section');
  private list = document.createElement('div');
  private nav?: HTMLElement;
  private mount: HTMLElement = this.tab;
  private host?: HTMLElement;
  private nativeSelection = new Map<HTMLElement, string>();
  private selectedLabelStyle?: Record<string, string>;
  private pageScroll?: { x: number; y: number; path: string; gutter: string; gutterPriority: string };

  constructor() {
    this.tab.type = 'button'; this.tab.dataset.pfUi = ''; this.tab.id = 'pf-filtered-tab';
    this.tab.setAttribute('role', 'tab'); this.tab.setAttribute('aria-controls', 'pf-filtered-panel');
    this.label.className = 'pf-tab-label'; this.label.textContent = 'Filtered'; this.tab.append(this.label);
    this.tab.addEventListener('click', () => this.setOpen(true));
    this.tab.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.setOpen(false); event.preventDefault(); return; }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const tabs = this.nativeTabs();
      (event.key === 'ArrowLeft' ? tabs.at(-1) : tabs[0])?.focus(); event.preventDefault();
    });
    this.panel.id = 'pf-filtered-panel'; this.panel.dataset.pfUi = '';
    this.panel.setAttribute('role', 'tabpanel'); this.panel.setAttribute('aria-labelledby', this.tab.id);
    this.panel.addEventListener('keydown', event => { if (event.key === 'Escape') { this.setOpen(false); this.tab.focus(); } });
    this.list.className = 'pf-filtered-list'; this.panel.append(this.list);
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && this.nav?.contains(target) && !this.tab.contains(target)) this.setOpen(false);
    }, true);
    this.render();
  }
  private nativeTabs(): HTMLElement[] {
    return [...(this.nav?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].filter(tab => tab !== this.tab);
  }
  configure(enabled: boolean, active: boolean): void {
    this.enabled = enabled; this.active = active;
    if (!enabled && this.posts.size) this.clear();
    this.sync();
  }
  clear(): void {
    this.posts.clear(); this.cards.clear(); this.list.replaceChildren(); this.render(); this.setOpen(false);
  }
  // The preview comes from X's page world; sanitize it here, at the trust boundary.
  remember(input: TweetInput, preview?: unknown): void {
    if (!this.enabled) return;
    const key = input.id || input.fingerprint;
    const card = sanitizeCard(preview) ?? fallbackCard(input);
    const previous = this.posts.get(key);
    if (previous?.input.fingerprint === input.fingerprint && JSON.stringify(previous.card) === JSON.stringify(card)) return;
    this.posts.delete(key); this.posts.set(key, { input, card });
    const node = renderTweetCard(card);
    this.cards.get(key)?.replaceWith(node);
    this.cards.set(key, node);
    if (this.posts.size > MAX_POSTS) this.posts.delete(this.posts.keys().next().value!);
    this.render();
  }
  sync(): void {
    const primary = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    const nav = primary?.querySelector<HTMLElement>('[role="tablist"]');
    if (!this.enabled || !this.active || !nav) {
      this.setOpen(false); this.mount.remove(); this.panel.remove(); this.nav = undefined; this.host = undefined; return;
    }
    if (this.nav !== nav) this.setOpen(false);
    this.nav = nav;
    const nativeTabs = this.nativeTabs();
    let host = nativeTabs[0]?.parentElement ?? nav;
    const last = nativeTabs.at(-1);
    while (host !== nav && last && !host.contains(last)) host = host.parentElement ?? nav;
    if (this.host !== host) {
      this.mount.remove(); this.host = host;
      // Reproduce the native wrapper chain as well as the tab's dimensions.
      // cloneNode(false) copies no event listeners/React state; retain only
      // layout classes/style, never IDs, test IDs, hrefs or accessibility roles.
      let branch: HTMLElement = this.tab;
      for (let parent = nativeTabs.at(-1)?.parentElement; parent && parent !== host; parent = parent.parentElement) {
        const wrapper = document.createElement('div'); wrapper.className = parent.className; wrapper.style.cssText = parent.style.cssText;
        wrapper.append(branch); branch = wrapper;
      }
      this.mount = branch; this.mount.dataset.pfUi = '';
    }
    if (this.mount.parentElement !== host) host.append(this.mount);
    if (this.open) this.deselectNativeTabs();
    this.skinTab();
    if (this.panel.parentElement !== document.body) document.body.append(this.panel);
    this.position();
  }
  private skinTab(): void {
    const tabs = this.nativeTabs();
    const selected = [...this.nativeSelection.keys()].find(tab => tab.isConnected) ?? tabs.find(tab => tab.getAttribute('aria-selected') === 'true') ?? tabs[0];
    const sample = (this.open ? selected : tabs.find(tab => tab !== selected)) ?? selected;
    if (!sample) return;
    // Native X typography/color often lives on the inner text span rather than
    // the role=tab element. Read it instead of inheriting the browser button font.
    const textElement = (node: HTMLElement) => [node, ...node.querySelectorAll<HTMLElement>('*')].find(element => element instanceof HTMLElement
      && [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) ?? node;
    const properties = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color'];
    // Capture selected typography before temporarily deselecting the native tab.
    // Some themes use aria-selected CSS, others use React-managed classes.
    if (selected && (!this.open || !this.selectedLabelStyle)) {
      const selectedStyle = getComputedStyle(textElement(selected));
      this.selectedLabelStyle = Object.fromEntries(properties.map(property => [property, selectedStyle.getPropertyValue(property)]));
    }
    const labelStyle = getComputedStyle(textElement(sample)), tabStyle = getComputedStyle(sample);
    if (!this.open && this.nav?.style.getPropertyValue('--pf-native-muted') !== labelStyle.color) {
      this.nav?.style.setProperty('--pf-native-muted', labelStyle.color);
    }
    if (this.tab.className !== sample.className) this.tab.className = sample.className;
    for (const property of ['display', 'align-items', 'justify-content', 'flex-grow', 'flex-shrink', 'flex-basis', 'min-width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'box-sizing']) {
      const value = tabStyle.getPropertyValue(property);
      if (this.tab.style.getPropertyValue(property) !== value) this.tab.style.setProperty(property, value);
    }
    for (const property of properties) {
      const value = this.open ? this.selectedLabelStyle?.[property] ?? labelStyle.getPropertyValue(property) : labelStyle.getPropertyValue(property);
      if (this.label.style.getPropertyValue(property) !== value) this.label.style.setProperty(property, value);
    }
    // Sample the real selected indicator's color, including custom accent themes.
    const indicator = selected && [...selected.querySelectorAll<HTMLElement>('*')].find(node => {
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      return rect.height > 0 && rect.height <= 6 && rect.width >= 12 && css.backgroundColor !== 'rgba(0, 0, 0, 0)' && css.backgroundColor !== 'transparent';
    });
    if (this.open) for (const native of tabs) {
      for (const node of native.querySelectorAll<HTMLElement>('*')) {
        const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
        if (rect.height > 0 && rect.height <= 6 && rect.width >= 12
          && css.backgroundColor !== 'rgba(0, 0, 0, 0)' && css.backgroundColor !== 'transparent') {
          if (!node.hasAttribute('data-pf-native-indicator')) node.setAttribute('data-pf-native-indicator', '');
        }
      }
    }
    if (indicator) {
      const accent = getComputedStyle(indicator).backgroundColor;
      if (this.tab.style.getPropertyValue('--pf-tab-accent') !== accent) this.tab.style.setProperty('--pf-tab-accent', accent);
    }
    if (this.tab.getAttribute('aria-selected') !== String(this.open)) this.tab.setAttribute('aria-selected', String(this.open));
    const width = this.label.getBoundingClientRect().width;
    const labelWidth = `${Math.ceil(width)}px`;
    if (width && this.tab.style.getPropertyValue('--pf-label-width') !== labelWidth) this.tab.style.setProperty('--pf-label-width', labelWidth);
  }
  position(): void {
    if (!this.open || !this.nav) return;
    const rect = this.nav.getBoundingClientRect();
    const top = Math.max(0, rect.bottom);
    const style = this.panel.style;
    for (const [key, value] of Object.entries({ left: `${rect.left}px`, width: `${rect.width}px`, top: `${top}px` })) {
      if (style.getPropertyValue(key) !== value) style.setProperty(key, value);
    }
    const body = getComputedStyle(document.body);
    const background = body.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'canvas' : body.backgroundColor;
    if (style.backgroundColor !== background) style.backgroundColor = background;
    if (style.color !== body.color) style.color = body.color;
    // Native tweet text and card borders can differ from document defaults.
    const nativeCard = document.querySelector<HTMLElement>('[data-testid="primaryColumn"] article[data-testid="tweet"]');
    if (nativeCard) {
      const nativeText = nativeCard.querySelector<HTMLElement>('[data-testid="tweetText"]') ?? nativeCard;
      const css = getComputedStyle(nativeText);
      const set = (key: string, value: string) => { if (style.getPropertyValue(key) !== value) style.setProperty(key, value); };
      set('--pf-card-font', css.fontFamily);
      set('--pf-card-size', css.fontSize);
      set('--pf-card-line', css.lineHeight === 'normal' ? '20px' : css.lineHeight);
      const time = nativeCard.querySelector('time');
      if (time) set('--pf-card-muted', getComputedStyle(time).color);
      for (let node: HTMLElement | null = nativeCard, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
        const border = getComputedStyle(node);
        if (parseFloat(border.borderBottomWidth) > 0) { set('--pf-card-border', border.borderBottomColor); break; }
      }
    }
  }
  private deselectNativeTabs(): void {
    for (const tab of this.nativeTabs()) {
      if (tab.getAttribute('aria-selected') !== 'true') continue;
      this.nativeSelection.set(tab, 'true'); tab.setAttribute('aria-selected', 'false');
    }
  }
  private setOpen(open: boolean): void {
    const wasOpen = this.open;
    const root = document.documentElement;
    if (open && !wasOpen) {
      this.skinTab();
      this.pageScroll = { x: window.scrollX, y: window.scrollY, path: location.pathname + location.search,
        gutter: root.style.getPropertyValue('--pf-page-gutter'), gutterPriority: root.style.getPropertyPriority('--pf-page-gutter') };
      // Preserve the viewport width when hiding a classic document scrollbar.
      // Overlay-scrollbar browsers must not gain a new reserved gutter.
      const existing = getComputedStyle(root).scrollbarGutter;
      const gutter = existing.includes('stable') ? existing : window.innerWidth > root.clientWidth ? 'stable' : 'auto';
      root.style.setProperty('--pf-page-gutter', gutter);
    }
    this.open = open; this.tab.setAttribute('aria-selected', String(open)); this.panel.hidden = !open;
    if (open) {
      this.deselectNativeTabs();
    } else {
      for (const indicator of this.nav?.querySelectorAll('[data-pf-native-indicator]') ?? []) indicator.removeAttribute('data-pf-native-indicator');
      for (const [tab, selected] of this.nativeSelection) {
        if (tab.getAttribute('aria-selected') === 'false') tab.setAttribute('aria-selected', selected);
      }
      this.nativeSelection.clear();
      // Stop media/audio when leaving the archive, without reloading it later.
      for (const video of this.list.querySelectorAll('video')) video.pause();
    }
    root.toggleAttribute('data-pf-filtered-view', open);
    if (!open && wasOpen && this.pageScroll) {
      const saved = this.pageScroll;
      if (saved.gutter) root.style.setProperty('--pf-page-gutter', saved.gutter, saved.gutterPriority);
      else root.style.removeProperty('--pf-page-gutter');
      if (location.pathname + location.search === saved.path && (window.scrollX !== saved.x || window.scrollY !== saved.y)) {
        window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
      }
      this.pageScroll = undefined;
    }
    this.skinTab(); this.position();
  }
  private render(): void {
    this.tab.setAttribute('aria-label', `Filtered (${this.posts.size})`);
    this.tab.title = `${this.posts.size} filtered posts in this page session`;
    for (const [key, card] of this.cards) if (!this.posts.has(key)) { card.remove(); this.cards.delete(key); }
    if (!this.posts.size) {
      if (!this.list.firstElementChild) {
        const empty = document.createElement('div'); empty.className = 'pf-filtered-empty';
        const heading = document.createElement('h2'); heading.textContent = 'No filtered posts yet';
        const note = document.createElement('p'); note.textContent = 'Posts hidden while this tab is enabled will appear here.';
        empty.append(heading, note); this.list.append(empty);
      }
      return;
    }
    this.list.querySelector('.pf-filtered-empty')?.remove();
    // Reuse existing card nodes so new arrivals do not reset image/video state,
    // panel scroll position, or keyboard focus in previously rendered posts.
    let cursor = this.list.firstElementChild;
    for (const key of [...this.posts.keys()].reverse()) {
      const card = this.cards.get(key)!;
      if (card !== cursor) this.list.insertBefore(card, cursor);
      else cursor = cursor.nextElementSibling;
    }
  }
}
