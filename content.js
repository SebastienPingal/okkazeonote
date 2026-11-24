(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;

  const AD_PATH = /^\/annonces\/\d+\/[^/]+\/?$/;
  const GAME_PATH = /^\/jeux\/\d+\/[^/]+\/?$/;
  const SKIP_TEXT = /^(voir|faire|cr[ée]er|contacter|signaler|vendre|acheter|lot de)\b/i;
  const SKIP_CONTAINERS = '.okb, .okb-panel, nav, footer, .breadcrumb, [aria-label="breadcrumb"]';
  const DONE = 'okbDone';

  const ERROR_TEXT = {
    NO_TOKEN: 'Jeton BGG manquant : clique pour ouvrir les réglages.',
    BAD_TOKEN: 'Jeton BGG refusé : clique pour ouvrir les réglages.',
    NETWORK: "BGG injoignable (ou accès à boardgamegeek.com non autorisé) : clique pour ouvrir les réglages.",
    RATE_LIMIT: 'BGG est surchargé : clique pour réessayer.',
  };
  const SETTINGS_ERRORS = new Set(['NO_TOKEN', 'BAD_TOKEN', 'NETWORK']);

  // ---------------------------------------------------------------------------
  // Helpers

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const cleanTitle = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  const titleKey = (t) => t.toLowerCase();

  function ratingClass(r) {
    if (r === null || r === undefined || r <= 0) return 'okb-rnone';
    if (r >= 8) return 'okb-r8';
    if (r >= 7.5) return 'okb-r75';
    if (r >= 7) return 'okb-r7';
    if (r >= 6.5) return 'okb-r65';
    if (r >= 6) return 'okb-r6';
    return 'okb-rlow';
  }

  function fmtVotes(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(1).replace('.0', '')}k`;
    return `${Math.round(n / 1000)}k`;
  }

  const fmtNumber = (n) => n.toLocaleString('fr-FR');
  const fmtRating = (r) => (r > 0 ? r.toFixed(1).replace('.', ',') : '–');

  function range(a, b, unit) {
    if (!a && !b) return null;
    if (!b || a === b) return `${a || b} ${unit}`;
    if (!a) return `${b} ${unit}`;
    return `${a}–${b} ${unit}`;
  }

  const bggUrl = (r) => `https://boardgamegeek.com/${r.type || 'boardgame'}/${r.id}`;
  const bggSearchUrl = (title) =>
    `https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=${encodeURIComponent(title)}`;

  function describe(r) {
    const parts = [`${r.name}${r.year ? ` (${r.year})` : ''}`];
    parts.push(r.votes ? `Note ${fmtRating(r.rating)} / 10 sur ${fmtNumber(r.votes)} votes` : 'Pas encore de note');
    if (r.rank) parts.push(`Rang #${fmtNumber(r.rank)}`);
    if (r.weight) parts.push(`Complexité ${r.weight.toFixed(1).replace('.', ',')} / 5`);
    const players = range(r.minPlayers, r.maxPlayers, 'joueurs');
    if (players) parts.push(players);
    if (r.approx) parts.push('⚠ Correspondance approximative, vérifie le jeu');
    if (r.manual) parts.push('Jeu choisi manuellement');
    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Messaging with the background (one request per title per page)

  const memo = new Map();

  async function send(msg) {
    let res;
    try {
      res = await api.runtime.sendMessage(msg);
    } catch (e) {
      throw Object.assign(new Error(String(e?.message || e)), { code: 'EXTENSION' });
    }
    if (!res) throw Object.assign(new Error('Pas de réponse'), { code: 'EXTENSION' });
    if (!res.ok) throw Object.assign(new Error(res.message || res.error), { code: res.error });
    return res.result;
  }

  function lookup(title) {
    const key = titleKey(title);
    if (!memo.has(key)) {
      const p = send({ type: 'lookup', title });
      p.catch(() => memo.delete(key)); // never memoize errors
      memo.set(key, p);
    }
    return memo.get(key);
  }

  // Every place showing a given title, so a correction updates them all.
  const renderers = new Map(); // titleKey -> Set<{render, start}>

  function register(title, entry) {
    const key = titleKey(title);
    if (!renderers.has(key)) renderers.set(key, new Set());
    renderers.get(key).add(entry);
  }

  function refresh(title) {
    const key = titleKey(title);
    memo.delete(key);
    for (const entry of renderers.get(key) || []) entry.start();
  }

  async function correct(title) {
    const input = window.prompt(
      `Jeu BoardGameGeek pour « ${title} » :\n\n` +
        '• colle le lien de la fiche BGG (ou juste son numéro)\n' +
        "• 0 = ce n'est pas un jeu présent sur BGG\n" +
        '• laisse vide pour revenir à la recherche automatique',
      ''
    );
    if (input === null) return;
    const s = input.trim();
    let bggId;
    if (s === '') bggId = null;
    else if (s === '0') bggId = 0;
    else {
      const m = s.match(/boardgame(?:expansion|accessory)?\/(\d+)/i) || s.match(/^(\d+)$/);
      if (!m) {
        window.alert('Lien ou numéro BGG non reconnu.');
        return;
      }
      bggId = parseInt(m[1], 10);
    }
    try {
      await send({ type: 'setOverride', title, bggId });
    } catch (e) {
      window.alert(`Impossible d'enregistrer la correction : ${e.message}`);
      return;
    }
    refresh(title);
  }

  function onErrorClick(err, retry) {
    if (SETTINGS_ERRORS.has(err.code)) send({ type: 'openOptions' }).catch(() => {});
    else retry();
  }

  // ---------------------------------------------------------------------------
  // Small badge next to each game title in lists

  function createBadge(title) {
    const link = h('a', { class: 'okb-badge okb-loading', target: '_blank', rel: 'noopener noreferrer' }, 'BGG …');
    const edit = h(
      'button',
      {
        class: 'okb-edit',
        type: 'button',
        title: 'Pas le bon jeu ? Corriger',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          correct(title);
        },
      },
      '✎'
    );
    const wrap = h('span', { class: 'okb', onclick: (e) => e.stopPropagation() }, link, edit);
    let onClick = null;
    link.addEventListener('click', (e) => {
      if (onClick) {
        e.preventDefault();
        onClick();
      }
    });

    const setState = (cls, content, tip, href, click = null) => {
      link.className = `okb-badge ${cls}`;
      link.replaceChildren(...content);
      link.title = tip;
      if (href) link.href = href;
      else link.removeAttribute('href');
      onClick = click;
    };

    const entry = {
      start() {
        setState('okb-loading', ['BGG …'], 'Recherche sur BoardGameGeek…');
        lookup(title).then(entry.render, entry.fail);
      },
      render(r) {
        if (r.status === 'ok') {
          const content = [
            r.approx ? '≈ ' : '',
            `★ ${fmtRating(r.rating)}`,
            r.votes ? h('small', {}, fmtVotes(r.votes)) : null,
          ].filter(Boolean);
          setState(`${ratingClass(r.rating)}${r.approx ? ' okb-approx' : ''}`, content, describe(r), bggUrl(r));
        } else if (r.status === 'excluded') {
          setState('okb-rnone okb-muted', ['BGG –'], 'Marqué comme absent de BGG (✎ pour modifier)', null);
        } else {
          setState(
            'okb-rnone',
            ['BGG ?'],
            'Pas trouvé sur BGG : clique pour chercher, ✎ pour indiquer le bon jeu',
            bggSearchUrl(title)
          );
        }
      },
      fail(err) {
        const settings = SETTINGS_ERRORS.has(err.code);
        setState(
          'okb-rnone okb-error',
          [settings ? 'BGG ⚙' : 'BGG ⟳'],
          ERROR_TEXT[err.code] || `Erreur (${err.message}) : clique pour réessayer.`,
          null,
          () => onErrorClick(err, entry.start)
        );
      },
    };
    register(title, entry);
    return { wrap, entry };
  }

  // Only query BGG for badges that actually scroll into view.
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        visibility.unobserve(e.target);
        e.target.okbEntry?.start();
      }
    },
    { rootMargin: '300px' }
  );

  function scanLinks(root) {
    for (const a of root.querySelectorAll('a[href]')) {
      if (a.dataset[DONE]) continue;
      a.dataset[DONE] = '1';

      let url;
      try {
        url = new URL(a.href, location.href);
      } catch {
        continue;
      }
      if (!/(^|\.)okkazeo\.com$/.test(url.hostname)) continue;
      if (!AD_PATH.test(url.pathname) && !GAME_PATH.test(url.pathname)) continue;
      if (url.pathname === location.pathname) continue; // handled by the panel
      if (a.closest(SKIP_CONTAINERS)) continue;

      const title = cleanTitle(a.textContent);
      if (title.length < 2 || SKIP_TEXT.test(title)) continue; // image-only or generic links

      const { wrap, entry } = createBadge(title);
      a.insertAdjacentElement('afterend', wrap);
      wrap.okbEntry = entry;
      visibility.observe(wrap);
    }
  }

  // ---------------------------------------------------------------------------
  // Detailed panel under the title on an ad page or a game page

  function createPanel(title) {
    const panel = h('div', { class: 'okb-panel' });

    const entry = {
      start() {
        panel.replaceChildren(h('div', { class: 'okb-panel-head' }, 'BoardGameGeek'), h('div', { class: 'okb-panel-msg' }, 'Recherche…'));
        lookup(title).then(entry.render, entry.fail);
      },
      render(r) {
        const editBtn = h('button', { class: 'okb-link-btn', type: 'button', onclick: () => correct(title) }, 'Pas le bon jeu ? Corriger');

        if (r.status !== 'ok') {
          const msg =
            r.status === 'excluded'
              ? 'Marqué comme absent de BGG.'
              : ['Jeu non trouvé sur BGG. ', h('a', { href: bggSearchUrl(title), target: '_blank', rel: 'noopener noreferrer' }, 'Chercher sur BGG')];
          panel.replaceChildren(
            h('div', { class: 'okb-panel-head' }, 'BoardGameGeek'),
            h('div', { class: 'okb-panel-msg' }, msg),
            h('div', { class: 'okb-panel-foot' }, editBtn)
          );
          return;
        }

        const facts = [
          r.votes ? `${fmtNumber(r.votes)} votes` : 'Pas encore de vote',
          r.rank ? `Rang #${fmtNumber(r.rank)}` : null,
          r.weight ? `Complexité ${r.weight.toFixed(1).replace('.', ',')} / 5` : null,
          range(r.minPlayers, r.maxPlayers, 'joueurs'),
          range(r.minTime, r.maxTime, 'min'),
        ].filter(Boolean);

        panel.replaceChildren(
          h(
            'div',
            { class: 'okb-panel-head' },
            'BoardGameGeek',
            r.type === 'boardgameexpansion' ? h('span', { class: 'okb-tag' }, 'extension') : null,
            r.manual ? h('span', { class: 'okb-tag' }, 'choix manuel') : null
          ),
          h(
            'div',
            { class: 'okb-panel-body' },
            h('a', { class: `okb-score ${ratingClass(r.rating)}`, href: bggUrl(r), target: '_blank', rel: 'noopener noreferrer', title: 'Note moyenne des joueurs BGG' }, fmtRating(r.rating)),
            h(
              'div',
              { class: 'okb-panel-info' },
              h('a', { class: 'okb-name', href: bggUrl(r), target: '_blank', rel: 'noopener noreferrer' }, r.name, r.year ? ` (${r.year})` : ''),
              h('div', { class: 'okb-facts' }, facts.join(' · '))
            )
          ),
          r.approx
            ? h('div', { class: 'okb-panel-warn' }, '⚠ Correspondance approximative : vérifie que c’est bien ce jeu.')
            : null,
          h('div', { class: 'okb-panel-foot' }, editBtn)
        );
      },
      fail(err) {
        const settings = SETTINGS_ERRORS.has(err.code);
        panel.replaceChildren(
          h('div', { class: 'okb-panel-head' }, 'BoardGameGeek'),
          h(
            'div',
            { class: 'okb-panel-msg' },
            ERROR_TEXT[err.code] || `Erreur : ${err.message}. `,
            ' ',
            h('button', { class: 'okb-link-btn', type: 'button', onclick: () => onErrorClick(err, entry.start) }, settings ? 'Ouvrir les réglages' : 'Réessayer')
          )
        );
      },
    };
    register(title, entry);
    return { panel, entry };
  }

  function scanTitle() {
    if (!AD_PATH.test(location.pathname) && !GAME_PATH.test(location.pathname)) return;
    for (const h1 of document.querySelectorAll('h1')) {
      if (h1.dataset[DONE]) continue;
      h1.dataset[DONE] = '1';
      const title = cleanTitle(h1.textContent);
      if (title.length < 2) continue;
      const { panel, entry } = createPanel(title);
      h1.insertAdjacentElement('afterend', panel);
      entry.start();
    }
  }

  // ---------------------------------------------------------------------------
  // Run now and whenever the page adds content (infinite scroll, search popup…)

  function scan() {
    scanTitle();
    scanLinks(document);
  }

  let pending = null;
  new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      scan();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  scan();
})();
