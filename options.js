'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const ORIGINS = { origins: ['https://boardgamegeek.com/*'] };

const ERRORS = {
  NO_TOKEN: "Aucun jeton enregistré.",
  BAD_TOKEN: 'BGG refuse ce jeton (vérifie-le, ou attends la validation de ton application).',
  NETWORK: "Impossible de joindre boardgamegeek.com (vérifie l'autorisation d'accès ci-dessous).",
  RATE_LIMIT: 'BGG est surchargé, réessaie dans un moment.',
};

const $ = (id) => document.getElementById(id);

function show(el, text, ok) {
  el.textContent = text;
  el.className = `status ${ok ? 'ok' : 'err'}`;
}

async function send(msg) {
  const res = await api.runtime.sendMessage(msg);
  if (!res?.ok) throw Object.assign(new Error(res?.message || 'Erreur'), { code: res?.error });
  return res.result;
}

async function refreshStats() {
  try {
    const s = await send({ type: 'stats' });
    $('stats').textContent =
      `${s.cached} jeu(x) en cache (${s.found} trouvé(s), ${s.notFound} introuvable(s)), ` +
      `${s.overrides} correction(s) manuelle(s).`;
  } catch (e) {
    $('stats').textContent = `Statistiques indisponibles : ${e.message}`;
  }
}

async function refreshPermission() {
  const granted = await api.permissions.contains(ORIGINS);
  $('permStatus').textContent = granted ? '✅ Accès autorisé' : '⚠ Accès non autorisé';
  $('perm').hidden = granted;
}

$('toggle').addEventListener('click', () => {
  const input = $('token');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('toggle').textContent = input.type === 'password' ? 'Afficher' : 'Masquer';
});

$('save').addEventListener('click', async () => {
  const token = $('token').value.trim();
  await api.storage.local.set({ token });
  if (!token) return show($('tokenStatus'), 'Jeton effacé.', true);
  show($('tokenStatus'), 'Jeton enregistré. Recharge les pages Okkazeo ouvertes.', true);
});

$('test').addEventListener('click', async () => {
  const token = $('token').value.trim();
  await api.storage.local.set({ token });
  show($('tokenStatus'), 'Test en cours…', true);
  try {
    const r = await send({ type: 'testToken' });
    show($('tokenStatus'), `✅ Jeton valide : BGG répond (${r.count} résultat(s) pour « Catan »).`, true);
  } catch (e) {
    show($('tokenStatus'), `❌ ${ERRORS[e.code] || e.message}`, false);
  }
});

$('perm').addEventListener('click', async () => {
  try {
    await api.permissions.request(ORIGINS);
  } finally {
    refreshPermission();
  }
});

$('clearCache').addEventListener('click', async () => {
  const n = await send({ type: 'clearCache' });
  show($('cacheStatus'), `Cache vidé (${n} entrée(s)).`, true);
  refreshStats();
});

$('clearOverrides').addEventListener('click', async () => {
  if (!confirm('Effacer toutes tes corrections manuelles ?')) return;
  await send({ type: 'clearOverrides' });
  show($('cacheStatus'), 'Corrections effacées.', true);
  refreshStats();
});

(async () => {
  const { token } = await api.storage.local.get('token');
  $('token').value = token || '';
  refreshPermission();
  refreshStats();
})();
