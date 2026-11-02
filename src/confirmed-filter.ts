// Response filtering is primary. This fallback reconciles native copies that
// X already holds with successful decisions made under the current policy.
// Never mutate X's React state or remove its DOM nodes.
export class ConfirmedFilter {
  private ids = new Set<string>();
  private marked = new Set<HTMLElement>();

  remember(id: string) {
    if (!/^\d{1,30}$/.test(id)) return;
    this.ids.add(id);
    if (this.ids.size > 1000) this.ids.delete(this.ids.values().next().value!);
  }

  clear() { this.ids.clear(); this.sync(false); }

  sync(active: boolean): number {
    const desired = new Set<HTMLElement>();
    if (active && this.ids.size) {
      for (const article of document.querySelectorAll<HTMLElement>('[data-testid="primaryColumn"] article[data-testid="tweet"]')) {
        if (article.closest('[data-pf-ui]')) continue;
        // X's own timestamp permalink identifies the outer displayed post.
        // Do not match arbitrary links in text or quoted-post previews.
        const time = article.querySelector('[data-testid="User-Name"] time') ?? article.querySelector('time');
        const link = time?.closest<HTMLAnchorElement>('a[href]');
        if (!link || link.closest('[data-testid="tweetText"]') || link.parentElement?.closest('[role="link"]')) continue;
        let id: string | undefined;
        try {
          const url = new URL(link.href);
          if (url.origin !== location.origin) continue;
          id = url.pathname.match(/^\/(?:[^/]+|i\/web)\/status\/(\d+)\/?$/)?.[1];
        } catch { continue; }
        if (!id || !this.ids.has(id)) continue;
        const cell = article.closest<HTMLElement>('[data-testid="cellInnerDiv"]');
        // Collapse the cell only when it contains this one card. Never hide a
        // multi-card conversation/module just because one child was filtered.
        desired.add(cell && cell.querySelectorAll('article[data-testid="tweet"]').length === 1 ? cell : article);
      }
    }
    for (const node of this.marked) if (!desired.has(node)) node.removeAttribute('data-pf-confirmed-filter');
    for (const node of desired) node.setAttribute('data-pf-confirmed-filter', '');
    this.marked = desired;
    return desired.size;
  }
}
