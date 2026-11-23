/* Ma Liseuse — bibliothèque + lecteur EPUB (epub.js)
 * Deux façons de stocker les livres :
 *  - "serveur" : le PC lance server.js, les livres sont dans E:\Liseuse\livres (partagés PC + téléphone)
 *  - "appareil" : version en ligne (GitHub Pages), les livres sont gardés dans le navigateur de l'appareil
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Préférences (propres à chaque appareil) ----------
const ECRAN_TACTILE = matchMedia('(pointer: coarse)').matches;
const PREFS_DEFAUT = {
  taille: ECRAN_TACTILE ? 110 : 100,
  theme: 'sombre',
  police: 'Georgia, serif',
  interligne: '1.6',
  mode: 'pages',
};
const CLE_PREFS = 'liseuse.prefs.v3';
function lirePrefs() {
  try { return { ...PREFS_DEFAUT, ...JSON.parse(localStorage.getItem(CLE_PREFS) || '{}') }; }
  catch { return { ...PREFS_DEFAUT }; }
}
function ecrirePrefs() {
  try { localStorage.setItem(CLE_PREFS, JSON.stringify(prefs)); } catch { /* navigation privée */ }
}
let prefs = lirePrefs();

// ---------- Stockage n°1 : le serveur du PC ----------
const apiServeur = {
  nom: 'serveur',
  async livres() { const r = await fetch('/api/books'); return r.json(); },
  async envoyer(fichier) {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(fichier.name), { method: 'POST', body: fichier });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Échec de l’envoi');
    return d.id;
  },
  supprimer: (id) => fetch('/api/books/' + encodeURIComponent(id), { method: 'DELETE' }),
  progression: (id) => fetch('/api/books/' + encodeURIComponent(id) + '/progress').then(r => r.json()),
  sauverProgression: (id, data) => fetch('/api/books/' + encodeURIComponent(id) + '/progress', {
    method: 'PUT', body: JSON.stringify(data), keepalive: true, headers: { 'Content-Type': 'application/json' },
  }),
  sauverMeta: (id, data) => fetch('/api/books/' + encodeURIComponent(id) + '/meta', {
    method: 'PUT', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
  }),
  async locations(id) {
    const r = await fetch('/api/books/' + encodeURIComponent(id) + '/locations');
    return r.ok ? r.text() : null;
  },
  sauverLocations: (id, txt) => fetch('/api/books/' + encodeURIComponent(id) + '/locations', { method: 'PUT', body: txt }),
  source: async (id) => '/livres/' + encodeURIComponent(id),
};

// ---------- Stockage n°2 : dans le navigateur (IndexedDB) ----------
// 3 "tables" : livres (infos + progression), fichiers (contenu EPUB), locations (positions calculées)
function creerBaseLocale(nomBase) {
  let ouverte = null;
  const base = () => ouverte ||= new Promise((ok, ko) => {
    const req = indexedDB.open(nomBase, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('livres', { keyPath: 'id' });
      db.createObjectStore('fichiers');
      db.createObjectStore('locations');
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ko(req.error);
  });
  const idb = async (table, mode, action) => {
    const db = await base();
    return new Promise((ok, ko) => {
      const tx = db.transaction(table, mode);
      const req = action(tx.objectStore(table));
      tx.oncomplete = () => ok(req?.result);
      tx.onerror = tx.onabort = () => ko(tx.error || new Error('Stockage impossible (mémoire pleine ?)'));
    });
  };
  return {
    lire: (t, cle) => idb(t, 'readonly', s => s.get(cle)),
    ecrire: (t, val, cle) => idb(t, 'readwrite', s => (cle === undefined ? s.put(val) : s.put(val, cle))),
    effacer: (t, cle) => idb(t, 'readwrite', s => s.delete(cle)),
    tout: (t) => idb(t, 'readonly', s => s.getAll()),
    vider: (t) => idb(t, 'readwrite', s => s.clear()),
  };
}
const { lire, ecrire, effacer, tout } = creerBaseLocale('liseuse');      // mode "appareil"
const cache = creerBaseLocale('liseuse-cache-cloud');                     // copie locale du mode "cloud"

const trierLivres = (liste) => liste.sort((a, b) =>
  ((b.progress?.updated || 0) - (a.progress?.updated || 0)) || (a.title || '').localeCompare(b.title || '', 'fr'));

const estEpub = (donnees) => donnees.byteLength >= 4 && new DataView(donnees).getUint32(0, true) === 0x04034b50;

const apiAppareil = {
  nom: 'appareil',
  async livres() { return trierLivres(await tout('livres')); },
  async envoyer(fichier) {
    const donnees = await fichier.arrayBuffer();
    if (!estEpub(donnees)) throw new Error("Ce fichier n'est pas un EPUB valide");
    const id = fichier.name;
    await ecrire('fichiers', donnees, id);
    const ancien = await lire('livres', id);
    await ecrire('livres', { id, title: id.replace(/\.epub$/i, ''), author: '', cover: null, size: fichier.size, added: Date.now(), progress: ancien?.progress || null });
    return id;
  },
  async supprimer(id) { await effacer('fichiers', id); await effacer('livres', id); await effacer('locations', id); },
  async progression(id) { return (await lire('livres', id))?.progress || {}; },
  async sauverProgression(id, data) {
    const l = await lire('livres', id);
    if (l) { l.progress = { ...data, updated: Date.now() }; await ecrire('livres', l); }
  },
  async sauverMeta(id, data) {
    const l = await lire('livres', id);
    if (!l) return;
    if (data.title) l.title = data.title;
    if (data.author) l.author = data.author;
    if (data.cover) l.cover = data.cover;
    await ecrire('livres', l);
  },
  locations: (id) => lire('locations', id).then(v => v || null),
  sauverLocations: (id, txt) => ecrire('locations', txt, id),
  async source(id) {
    const donnees = await lire('fichiers', id);
    if (!donnees) throw new Error('fichier absent de cet appareil');
    return donnees;
  },
};

// ---------- Stockage n°3 : en ligne avec Supabase (compte privé) ----------
// Les livres sont dans un espace de stockage privé, la progression dans une table.
// Une copie est gardée sur l'appareil (cache) pour lire sans connexion.
const CONFIG = window.LISEUSE_CONFIG || {};
let sb = null, utilisateur = null;
const CLE_ATTENTE = 'liseuse.progression-en-attente';

// Progressions enregistrées hors connexion, envoyées dès que le réseau revient
function lireAttente() { try { return JSON.parse(localStorage.getItem(CLE_ATTENTE) || '{}'); } catch { return {}; } }
function ecrireAttente(a) { try { localStorage.setItem(CLE_ATTENTE, JSON.stringify(a)); } catch { /* ignoré */ } }
const plusRecente = (a, b) => (!a ? b : !b ? a : ((b.updated || 0) > (a.updated || 0) ? b : a));

const idAleatoire = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

async function verifier({ data, error }) {
  if (error) throw new Error(error.message || 'Erreur Supabase');
  return data;
}

const apiCloud = {
  nom: 'cloud',
  async livres() {
    const attente = lireAttente();
    try {
      const lignes = await verifier(await sb.from('livres').select('id,title,author,cover,size,fichier,added,progress'));
      const liste = lignes.map(l => ({ ...l, added: Date.parse(l.added), progress: plusRecente(l.progress, attente[l.id]) }));
      // Copie locale de la liste (pour le mode hors connexion)
      await cache.vider('livres');
      for (const l of liste) await cache.ecrire('livres', l);
      return trierLivres(liste);
    } catch (err) {
      const liste = await cache.tout('livres');
      if (!liste.length) throw err;
      message('Hors connexion : seuls les livres déjà ouverts sur cet appareil sont lisibles.', 6000);
      return trierLivres(liste.map(l => ({ ...l, progress: plusRecente(l.progress, attente[l.id]) })));
    }
  },
  async envoyer(fichier) {
    const donnees = await fichier.arrayBuffer();
    if (!estEpub(donnees)) throw new Error("Ce fichier n'est pas un EPUB valide");
    const id = fichier.name;
    const existant = await verifier(await sb.from('livres').select('fichier').eq('id', id).maybeSingle());
    const chemin = existant?.fichier || `${utilisateur.id}/${idAleatoire()}.epub`;
    await verifier(await sb.storage.from('livres').upload(chemin, new Blob([donnees], { type: 'application/epub+zip' }), { upsert: true, contentType: 'application/epub+zip' }));
    await verifier(await sb.from('livres').upsert(
      { user_id: utilisateur.id, id, title: id.replace(/\.epub$/i, ''), size: fichier.size, fichier: chemin },
      { onConflict: 'user_id,id', ignoreDuplicates: false },
    ));
    await cache.ecrire('fichiers', donnees, id);
    return id;
  },
  async supprimer(id) {
    const ligne = await verifier(await sb.from('livres').select('fichier').eq('id', id).maybeSingle());
    if (ligne?.fichier) await verifier(await sb.storage.from('livres').remove([ligne.fichier]));
    await verifier(await sb.from('livres').delete().eq('id', id));
    await cache.effacer('livres', id); await cache.effacer('fichiers', id); await cache.effacer('locations', id);
  },
  async progression(id) {
    const enAttente = lireAttente()[id];
    try {
      const ligne = await verifier(await sb.from('livres').select('progress').eq('id', id).maybeSingle());
      return plusRecente(ligne?.progress, enAttente) || {};
    } catch {
      return plusRecente((await cache.lire('livres', id))?.progress, enAttente) || {};
    }
  },
  async sauverProgression(id, data) {
    const p = { ...data, updated: Date.now() };
    const attente = lireAttente(); attente[id] = p; ecrireAttente(attente); // d'abord en local
    const local = await cache.lire('livres', id);
    if (local) { local.progress = p; await cache.ecrire('livres', local); }
    await envoyerAttente();
  },
  async sauverMeta(id, data) {
    const champs = {};
    if (data.title) champs.title = data.title;
    if (data.author) champs.author = data.author;
    if (data.cover) champs.cover = data.cover;
    if (Object.keys(champs).length) await verifier(await sb.from('livres').update(champs).eq('id', id));
  },
  async locations(id) {
    const local = await cache.lire('locations', id);
    if (local) return local;
    try {
      const ligne = await verifier(await sb.from('livres').select('locations').eq('id', id).maybeSingle());
      if (ligne?.locations) await cache.ecrire('locations', ligne.locations, id);
      return ligne?.locations || null;
    } catch { return null; }
  },
  async sauverLocations(id, txt) {
    await cache.ecrire('locations', txt, id);
    await sb.from('livres').update({ locations: txt }).eq('id', id);
  },
  async source(id) {
    const local = await cache.lire('fichiers', id);
    if (local) return local;
    const ligne = await verifier(await sb.from('livres').select('fichier').eq('id', id).maybeSingle());
    if (!ligne?.fichier) throw new Error('fichier introuvable dans ton espace');
    const blob = await verifier(await sb.storage.from('livres').download(ligne.fichier));
    const donnees = await blob.arrayBuffer();
    await cache.ecrire('fichiers', donnees, id); // gardé sur l'appareil pour la prochaine fois
    return donnees;
  },
};

// Envoie les progressions enregistrées pendant qu'on était hors connexion
let envoiEnCours = false;
async function envoyerAttente() {
  if (!sb || envoiEnCours) return;
  envoiEnCours = true;
  try {
    const attente = lireAttente();
    for (const [id, p] of Object.entries(attente)) {
      const { error } = await sb.from('livres').update({ progress: p }).eq('id', id);
      if (error) break;
      const reste = lireAttente();
      if (reste[id]?.updated === p.updated) { delete reste[id]; ecrireAttente(reste); }
    }
  } catch { /* toujours hors connexion : on réessaiera */ }
  envoiEnCours = false;
}
window.addEventListener('online', envoyerAttente);

// Écran de connexion : attend que l'utilisateur se connecte
function demanderConnexion() {
  $('#connexion').hidden = false;
  $('#bibliotheque').hidden = true;
  return new Promise((ok) => {
    $('#formConnexion').onsubmit = async (e) => {
      e.preventDefault();
      const erreur = $('#erreurConnexion'), bouton = $('#btnConnexion');
      erreur.hidden = true; bouton.disabled = true; bouton.textContent = 'Connexion…';
      const { data, error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#motDePasse').value });
      bouton.disabled = false; bouton.textContent = 'Se connecter';
      if (error) {
        erreur.textContent = /invalid/i.test(error.message) ? 'Email ou mot de passe incorrect.' : 'Connexion impossible : ' + error.message;
        erreur.hidden = false;
        return;
      }
      $('#motDePasse').value = '';
      $('#connexion').hidden = true;
      ok(data.session);
    };
  });
}

// Lien reçu par email (invitation ou mot de passe oublié) : lu AVANT que l'adresse soit nettoyée
const LIEN_EMAIL = (() => {
  const p = new URLSearchParams(location.hash.slice(1));
  return { type: p.get('type'), erreur: p.get('error_code') || p.get('error') };
})();

// Écran « choisis ton mot de passe »
function demanderNouveauMotDePasse(texte) {
  $('#connexion').hidden = true;
  $('#bibliotheque').hidden = true;
  $('#nouveauMdp').hidden = false;
  $('#texteNouveauMdp').textContent = texte;
  return new Promise((ok) => {
    $('#formNouveauMdp').onsubmit = async (e) => {
      e.preventDefault();
      const erreur = $('#erreurNouveauMdp'), bouton = $('#btnNouveauMdp');
      const mdp = $('#mdp1').value;
      erreur.hidden = true;
      if (mdp !== $('#mdp2').value) { erreur.textContent = 'Les deux mots de passe ne sont pas identiques.'; erreur.hidden = false; return; }
      if (mdp.length < 8) { erreur.textContent = 'Au moins 8 caractères.'; erreur.hidden = false; return; }
      bouton.disabled = true; bouton.textContent = 'Enregistrement…';
      const { error } = await sb.auth.updateUser({ password: mdp });
      bouton.disabled = false; bouton.textContent = 'Enregistrer';
      if (error) { erreur.textContent = 'Impossible d’enregistrer : ' + error.message; erreur.hidden = false; return; }
      $('#mdp1').value = ''; $('#mdp2').value = '';
      $('#nouveauMdp').hidden = true;
      ok();
    };
  });
}

// « Mot de passe oublié ? » : envoie un lien par email
$('#btnOubli').addEventListener('click', async () => {
  const email = $('#email').value.trim();
  const info = $('#infoConnexion'), erreur = $('#erreurConnexion');
  erreur.hidden = true;
  if (!email) { erreur.textContent = 'Tape d’abord ton email au-dessus.'; erreur.hidden = false; $('#email').focus(); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) { erreur.textContent = 'Envoi impossible : ' + error.message; erreur.hidden = false; return; }
  info.textContent = `Si un compte existe pour ${email}, un email vient d’être envoyé avec un lien pour choisir un nouveau mot de passe.`;
  info.hidden = false;
});

async function connecterCloud() {
  sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
  const { data } = await sb.auth.getSession(); // lit aussi le lien de l'email s'il y en a un
  let session = data?.session;
  if (LIEN_EMAIL.erreur && !session) {
    $('#infoConnexion').textContent = 'Ce lien n’est plus valable (il a déjà servi ou il a expiré). Connecte-toi, ou utilise « Mot de passe oublié ? ».';
    $('#infoConnexion').hidden = false;
  }
  if (session && (LIEN_EMAIL.type === 'invite' || LIEN_EMAIL.type === 'recovery')) {
    await demanderNouveauMotDePasse(LIEN_EMAIL.type === 'invite'
      ? 'Bienvenue ! Choisis ton mot de passe : c’est celui que tu taperas pour te connecter à la liseuse.'
      : 'Choisis ton nouveau mot de passe.');
  }
  if (!session) session = await demanderConnexion();
  utilisateur = session.user;
  envoyerAttente();
}

$('#btnDeconnexion').addEventListener('click', async () => {
  if (!confirm('Se déconnecter ? Les livres gardés sur cet appareil seront effacés (ils restent dans ton espace en ligne).')) return;
  await envoyerAttente();
  await sb.auth.signOut();
  for (const t of ['livres', 'fichiers', 'locations']) await cache.vider(t).catch(() => {});
  location.reload();
});

// ---------- Choix du stockage ----------
// 1. Supabase configuré (config.js) → bibliothèque en ligne
// 2. sinon, serveur Liseuse du PC qui répond → livres du PC
// 3. sinon → livres gardés sur l'appareil
let api = apiAppareil;
async function serveurDisponible() {
  try {
    const r = await fetch('/api/books', { signal: AbortSignal.timeout(3000) });
    return r.ok && (r.headers.get('content-type') || '').includes('json');
  } catch { return false; }
}
async function choisirStockage() {
  if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) {
    if (!window.supabase) throw new Error('Impossible de charger Supabase (connexion Internet ?)');
    await connecterCloud();
    return apiCloud;
  }
  return (await serveurDisponible()) ? apiServeur : apiAppareil;
}

// ---------- Transfert des livres du PC (ou de l'appareil) vers le compte en ligne ----------
let aTransferer = [];
async function proposerTransfert() {
  if (api !== apiCloud) return;
  const dejaEnLigne = new Set(livresCache.map(l => l.id));
  aTransferer = [];
  if (await serveurDisponible()) {
    for (const l of await apiServeur.livres()) if (!dejaEnLigne.has(l.id)) aTransferer.push({ ...l, depuis: apiServeur });
  }
  for (const l of await apiAppareil.livres().catch(() => [])) {
    if (!dejaEnLigne.has(l.id) && !aTransferer.some(x => x.id === l.id)) aTransferer.push({ ...l, depuis: apiAppareil });
  }
  $('#transfert').hidden = !aTransferer.length;
  if (aTransferer.length) {
    const n = aTransferer.length;
    const ou = aTransferer[0].depuis === apiServeur ? 'ce PC' : 'cet appareil';
    $('#texteTransfert').textContent = n > 1
      ? `${n} livres de ${ou} ne sont pas encore dans ton espace en ligne.`
      : `1 livre de ${ou} n’est pas encore dans ton espace en ligne.`;
  }
}

$('#btnTransfert').addEventListener('click', async () => {
  const bouton = $('#btnTransfert');
  bouton.disabled = true;
  let ok = 0;
  for (const l of aTransferer) {
    try {
      message(`Envoi de « ${l.title} »…`, 0);
      const src = await l.depuis.source(l.id);
      const donnees = typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : src;
      await apiCloud.envoyer(new File([donnees], l.id, { type: 'application/epub+zip' }));
      await apiCloud.sauverMeta(l.id, { title: l.title, author: l.author, cover: l.cover });
      if (l.progress?.cfi) {
        await verifier(await sb.from('livres').update({ progress: l.progress }).eq('id', l.id));
      }
      const loc = await l.depuis.locations(l.id).catch(() => null);
      if (loc) await apiCloud.sauverLocations(l.id, loc);
      ok++;
    } catch (err) {
      message(`Erreur pour « ${l.title} » : ${err.message}`, 8000);
    }
  }
  bouton.disabled = false;
  if (ok) message(`${ok} livre${ok > 1 ? 's' : ''} envoyé${ok > 1 ? 's' : ''} dans ton espace en ligne ✔`);
  await afficherBibliotheque();
  await proposerTransfert();
});

// ---------- Métadonnées (titre, auteur, couverture) ----------
async function couvertureEnDataURL(url) {
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  const largeur = 300, hauteur = Math.round(img.naturalHeight * (largeur / img.naturalWidth));
  const c = document.createElement('canvas');
  c.width = largeur; c.height = hauteur;
  c.getContext('2d').drawImage(img, 0, 0, largeur, hauteur);
  return c.toDataURL('image/jpeg', 0.78);
}

async function extraireMeta(book) {
  const meta = await book.loaded.metadata;
  let cover = null;
  try { cover = await couvertureEnDataURL(await book.coverUrl()); } catch { /* pas de couverture */ }
  return { title: meta.title || '', author: meta.creator || '', cover };
}

// ================= BIBLIOTHÈQUE =================
let livresCache = [];

function message(txt, duree = 4000) {
  const m = $('#message');
  m.textContent = txt; m.hidden = !txt;
  clearTimeout(message.t);
  if (txt && duree) message.t = setTimeout(() => { m.hidden = true; }, duree);
}

function htmlCouverture(l) {
  return l.cover
    ? `<img src="${esc(l.cover)}" alt="" loading="lazy">`
    : `<div class="sans-image">${esc(l.title)}</div>`;
}

async function afficherBibliotheque() {
  livresCache = await api.livres();
  const grille = $('#grille');
  $('#vide').hidden = livresCache.length > 0;
  $('#titreListe').hidden = livresCache.length === 0;

  grille.innerHTML = livresCache.map(l => {
    const pct = Math.round((l.progress?.percent || 0) * 100);
    return `
      <article class="livre" data-id="${esc(l.id)}" tabindex="0">
        <div class="couverture">${htmlCouverture(l)}</div>
        <button class="suppr" data-suppr="${esc(l.id)}" title="Supprimer ce livre" aria-label="Supprimer">✕</button>
        <div class="nom">${esc(l.title)}</div>
        <div class="auteur">${esc(l.author) || '&nbsp;'}</div>
        ${l.progress ? `<div class="jauge"><div style="width:${pct}%"></div></div>` : ''}
      </article>`;
  }).join('');

  const enCours = livresCache.find(l => l.progress && l.progress.percent < 0.995);
  $('#reprendre').hidden = !enCours;
  if (enCours) {
    $('#carteReprendre').innerHTML = `
      <div class="reprendre" data-id="${esc(enCours.id)}">
        <div class="couverture">${htmlCouverture(enCours)}</div>
        <div class="infos">
          <strong>${esc(enCours.title)}</strong>
          <span>${esc(enCours.progress.chapter || '')}</span>
          <div class="jauge"><div style="width:${Math.round(enCours.progress.percent * 100)}%"></div></div>
          <span>${Math.round(enCours.progress.percent * 100)} % lu</span>
        </div>
      </div>`;
  }
}

document.addEventListener('click', async (e) => {
  const suppr = e.target.closest('[data-suppr]');
  if (suppr) {
    e.stopPropagation();
    const l = livresCache.find(x => x.id === suppr.dataset.suppr);
    const ou = {
      serveur: 'Le fichier sera effacé du dossier livres du PC.',
      appareil: 'Le livre sera effacé de cet appareil.',
      cloud: 'Le livre et sa progression seront effacés de ton espace en ligne, sur tous tes appareils.',
    }[api.nom];
    if (confirm(`Supprimer « ${l?.title || suppr.dataset.suppr} » de la bibliothèque ?\n${ou}`)) {
      await api.supprimer(suppr.dataset.suppr);
      afficherBibliotheque();
    }
    return;
  }
  const carte = e.target.closest('#bibliotheque [data-id]');
  if (carte) ouvrirLivre(carte.dataset.id);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('.livre')) ouvrirLivre(e.target.dataset.id);
});

async function importer(fichiers) {
  const liste = [...fichiers].filter(f => /\.epub$/i.test(f.name));
  if (!liste.length) return message('Choisis des fichiers .epub');
  let ok = 0;
  for (const f of liste) {
    try {
      message(`Import de « ${f.name} »…`, 0);
      const id = await api.envoyer(f);
      try {
        const book = ePub(await f.arrayBuffer());
        await api.sauverMeta(id, await extraireMeta(book));
        book.destroy();
      } catch { /* métadonnées facultatives */ }
      ok++;
    } catch (err) {
      message(`Erreur pour « ${f.name} » : ${err.message}`, 8000);
    }
  }
  if (ok) message(`${ok} livre${ok > 1 ? 's' : ''} ajouté${ok > 1 ? 's' : ''} ✔`);
  afficherBibliotheque();
}

$('#choixFichiers').addEventListener('change', (e) => { importer(e.target.files); e.target.value = ''; });

// Glisser-déposer sur PC
let profondeurDrag = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { profondeurDrag++; $('#zoneDepot').hidden = false; } });
window.addEventListener('dragleave', () => { if (--profondeurDrag <= 0) { profondeurDrag = 0; $('#zoneDepot').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); profondeurDrag = 0; $('#zoneDepot').hidden = true;
  if (!$('#bibliotheque').hidden && e.dataTransfer?.files?.length) importer(e.dataTransfer.files);
});

// ================= LECTEUR =================
let book = null, rendition = null, livreId = null, sommairePlat = [];
let minuterieSauvegarde = null, derniereProgression = null, locationsPretes = false;

// Couleurs des thèmes de lecture : [fond, texte, liens]
const THEMES = {
  clair: ['#ffffff', '#222222', '#1a5fb4'],
  sepia: ['#f4ecd8', '#5b4636', '#8a4b14'],
  sombre: ['#000000', '#f0f0f0', '#8ab4f8'],
};

// Une seule feuille de style "liseuse" par page du livre, réécrite à chaque changement de réglage
// (les thèmes intégrés à epub.js s'empilent au lieu de se remplacer).
function cssLecture() {
  const [fond, texte, lien] = THEMES[prefs.theme] || THEMES.sombre;
  const police = prefs.police ? `font-family: ${prefs.police} !important;` : '';
  return `
    html, body { background: ${fond} !important; color: ${texte} !important; }
    body { line-height: ${prefs.interligne} !important; ${police} }
    body * { color: ${texte} !important; background-color: transparent !important; border-color: ${texte}33 !important; }
    p, li, div, span, blockquote { line-height: ${prefs.interligne} !important; ${police} }
    a, a * { color: ${lien} !important; }
    img, svg { background: transparent !important; }`;
}

function injecterCss(doc) {
  let style = doc.getElementById('liseuse-style');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'liseuse-style';
    (doc.head || doc.documentElement).appendChild(style);
  }
  style.textContent = cssLecture();
}

function appliquerPrefs() {
  const lect = $('#lecteur');
  lect.classList.remove('theme-clair', 'theme-sepia', 'theme-sombre');
  lect.classList.add('theme-' + prefs.theme);
  if (!lect.hidden) document.querySelector('meta[name=theme-color]').content = THEMES[prefs.theme][0];
  lect.classList.toggle('mode-defilement', prefs.mode === 'defilement');
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('actif', b.dataset.mode === prefs.mode));
  $('#tailleValeur').textContent = prefs.taille + ' %';
  document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('actif', b.dataset.theme === prefs.theme));
  document.querySelectorAll('[data-police]').forEach(b => b.classList.toggle('actif', b.dataset.police === prefs.police));
  document.querySelectorAll('[data-interligne]').forEach(b => b.classList.toggle('actif', b.dataset.interligne === prefs.interligne));
  if (!rendition) return;
  rendition.themes.fontSize(prefs.taille + '%');
  for (const c of rendition.getContents?.() || []) injecterCss(c.document);
}

function aplatirSommaire(items, niveau = 0, acc = []) {
  for (const it of items) {
    acc.push({ label: (it.label || '').trim(), href: it.href, niveau });
    if (it.subitems?.length) aplatirSommaire(it.subitems, niveau + 1, acc);
  }
  return acc;
}

function chapitrePour(href) {
  if (!href) return '';
  const fichier = href.split('#')[0];
  for (const it of sommairePlat) {
    const f = it.href.split('#')[0];
    if (f === fichier || f.endsWith('/' + fichier) || fichier.endsWith('/' + f)) return it.label;
  }
  return '';
}

function basculerBarres(forcer) {
  $('#lecteur').classList.toggle('immersif', forcer);
}

function fermerPanneaux() {
  $('#panneauSommaire').hidden = true;
  $('#panneauReglages').hidden = true;
}

// ---------- Tourner les pages (avec animation façon livre) ----------
let animationEnCours = false;

async function tournerPage(sens) {
  if (!rendition?.manager || animationEnCours) return;
  animationEnCours = true;
  basculerBarres(true);
  const zone = $('#zoneLecture');
  const largeur = zone.clientWidth;
  const signe = sens === 'suiv' ? -1 : 1; // la page part vers la gauche quand on avance
  const anime = prefs.mode === 'pages';
  try {
    if (anime) {
      // 1. la page actuelle glisse hors de l'écran (à partir de là où le doigt l'a laissée)
      zone.style.transition = 'transform .17s ease-in, opacity .17s ease-in';
      zone.style.transform = `translateX(${signe * largeur * 0.5}px)`;
      zone.style.opacity = '0';
      await attendre(170);
    }
    await (sens === 'suiv' ? rendition.next() : rendition.prev());
  } catch { /* début ou fin du livre */ }
  if (anime) {
    // 2. la nouvelle page arrive de l'autre côté
    zone.style.transition = 'none';
    zone.style.transform = `translateX(${-signe * largeur * 0.3}px)`;
    void zone.offsetWidth; // force le navigateur à appliquer la position de départ
    zone.style.transition = 'transform .22s ease-out, opacity .22s ease-out';
    zone.style.transform = '';
    zone.style.opacity = '';
    await attendre(220);
    zone.style.transition = '';
  }
  animationEnCours = false;
}
const pageSuivante = () => tournerPage('suiv');
const pagePrecedente = () => tournerPage('prec');

// Si le doigt est relâché trop tôt, la page revient à sa place
function annulerGlissement() {
  const zone = $('#zoneLecture');
  zone.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
  zone.style.transform = '';
  zone.style.opacity = '';
  setTimeout(() => { zone.style.transition = ''; }, 200);
}

// Crée l'affichage du livre selon le mode choisi (pages ou défilement)
function creerRendu() {
  const defilement = prefs.mode === 'defilement';
  $('#zoneLecture').innerHTML = '';
  rendition = book.renderTo('zoneLecture', defilement
    ? { width: '100%', height: '100%', flow: 'scrolled', manager: 'continuous', allowScriptedContent: false }
    : { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', minSpreadWidth: 900, allowScriptedContent: false });
  appliquerPrefs();

  // Gestes (glisser / toucher / clavier) à l'intérieur du livre
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    injecterCss(doc);
    const zone = $('#zoneLecture');
    let debutX = null, debutY = null, debutT = 0, horizontal = null;

    doc.addEventListener('touchstart', (e) => {
      if (prefs.mode !== 'pages' || animationEnCours || e.touches.length > 1) return;
      const t = e.touches[0];
      debutX = t.screenX; debutY = t.screenY; debutT = Date.now(); horizontal = null;
      zone.style.transition = 'none';
    }, { passive: true });

    doc.addEventListener('touchmove', (e) => {
      if (debutX === null) return;
      const t = e.touches[0];
      const dx = t.screenX - debutX, dy = t.screenY - debutY;
      if (horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) {
        // La page suit le doigt
        zone.style.transform = `translateX(${dx}px)`;
        zone.style.opacity = String(1 - Math.min(Math.abs(dx) / zone.clientWidth, 1) * 0.6);
      }
    }, { passive: true });

    const finGlissement = (e) => {
      if (debutX === null) return;
      const t = e.changedTouches[0];
      const dx = t.screenX - debutX;
      const vitesse = Math.abs(dx) / Math.max(1, Date.now() - debutT);
      const etaitHorizontal = horizontal;
      debutX = null; horizontal = null;
      if (!etaitHorizontal) { annulerGlissement(); return; }
      // On tourne si le doigt a parcouru assez de distance, ou s'il a été lancé rapidement
      if (Math.abs(dx) > zone.clientWidth * 0.18 || (Math.abs(dx) > 25 && vitesse > 0.35)) {
        dx < 0 ? pageSuivante() : pagePrecedente();
      } else {
        annulerGlissement();
      }
    };
    doc.addEventListener('touchend', finGlissement, { passive: true });
    doc.addEventListener('touchcancel', finGlissement, { passive: true });

    doc.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      if (doc.getSelection()?.toString()) return;
      if (prefs.mode !== 'pages') return basculerBarres(); // défilement : un toucher affiche/cache les barres
      const cadre = contents.window.frameElement.getBoundingClientRect();
      const z = zone.getBoundingClientRect();
      const x = (cadre.left + e.clientX - z.left) / z.width;
      // Toucher : bord gauche = page précédente, bord droit = page suivante, centre = menu
      if (x < 0.25) pagePrecedente();
      else if (x > 0.75) pageSuivante();
      else basculerBarres();
    });
    doc.addEventListener('keydown', gererClavier);
  });

  rendition.on('relocated', surDeplacement);
}

function surDeplacement(loc) {
  const chapitre = chapitrePour(loc.start.href);
  $('#titreChapitre').textContent = chapitre;
  let pct;
  if (locationsPretes) pct = book.locations.percentageFromCfi(loc.start.cfi);
  else pct = (loc.start.index || 0) / Math.max(1, book.spine.length);
  $('#pourcentage').textContent = Math.round(pct * 100) + ' %';
  if (locationsPretes) $('#curseur').value = Math.round(pct * 1000);
  document.querySelectorAll('#listeSommaire a').forEach(a => a.classList.toggle('actuel', a.textContent === chapitre));
  derniereProgression = { cfi: loc.start.cfi, percent: pct, chapter: chapitre };
  clearTimeout(minuterieSauvegarde);
  minuterieSauvegarde = setTimeout(sauvegarder, 1200);
}

// Changer de mode sans perdre sa place
async function changerMode(mode) {
  if (mode === prefs.mode) return;
  prefs.mode = mode; ecrirePrefs();
  if (!book || !rendition) return appliquerPrefs();
  const cfi = rendition.currentLocation()?.start?.cfi || derniereProgression?.cfi;
  rendition.destroy();
  creerRendu();
  await rendition.display(cfi || undefined);
}

async function ouvrirLivre(id) {
  livreId = id;
  locationsPretes = false;
  const infos = livresCache.find(l => l.id === id) || { title: id };
  $('#bibliotheque').hidden = true;
  $('#lecteur').hidden = false;
  appliquerPrefs();
  $('#titreLivre').textContent = infos.title;
  $('#titreChapitre').textContent = '';
  $('#pourcentage').textContent = '…';
  $('#curseur').disabled = true;
  $('#zoneLecture').innerHTML = '<div class="chargement">Ouverture du livre…</div>';
  basculerBarres(false);
  fermerPanneaux();
  history.pushState({ livre: id }, '', '#lire');

  try {
    book = ePub(await api.source(id));
    creerRendu();
    await Promise.race([
      book.opened,
      new Promise((_, rejeter) => setTimeout(() => rejeter(new Error('le fichier ne se charge pas')), 30000)),
    ]);
    const [nav, meta, progres] = await Promise.all([book.loaded.navigation, book.loaded.metadata, api.progression(id)]);
    sommairePlat = aplatirSommaire(nav.toc || []);
    $('#listeSommaire').innerHTML = sommairePlat.length
      ? sommairePlat.map((it, i) => `<a href="#" data-i="${i}" class="${it.niveau ? 'sous' : ''}">${esc(it.label)}</a>`).join('')
      : '<p style="padding:16px">Ce livre n’a pas de sommaire.</p>';
    if (meta.title) $('#titreLivre').textContent = meta.title;

    await rendition.display(progres?.cfi || undefined);

    // Complète les infos de la bibliothèque si le livre a été copié à la main dans "livres"
    if (!infos.cover && !infos.author) extraireMeta(book).then(m => api.sauverMeta(id, m)).catch(() => {});

    preparerLocations(id);
  } catch (err) {
    console.error(err);
    $('#zoneLecture').innerHTML = `<div class="chargement">Impossible d’ouvrir ce livre (${esc(err.message)}).<br>Le fichier est peut-être protégé par DRM.</div>`;
  }
}

// Calcul des positions (pour le % et le curseur) — mis en cache
async function preparerLocations(id) {
  const livre = book;
  const cache = await api.locations(id).catch(() => null);
  if (livre !== book) return;
  if (cache) {
    book.locations.load(cache);
  } else {
    $('#pourcentage').textContent = 'calcul…';
    await book.locations.generate(1600);
    if (livre !== book) return;
    api.sauverLocations(id, book.locations.save());
  }
  locationsPretes = true;
  $('#curseur').disabled = false;
  const loc = rendition.currentLocation();
  if (loc?.start) {
    const pct = book.locations.percentageFromCfi(loc.start.cfi);
    $('#curseur').value = Math.round(pct * 1000);
    $('#pourcentage').textContent = Math.round(pct * 100) + ' %';
    if (derniereProgression) derniereProgression.percent = pct;
  }
}

function sauvegarder() {
  clearTimeout(minuterieSauvegarde);
  if (livreId && derniereProgression) Promise.resolve(api.sauverProgression(livreId, derniereProgression)).catch(() => {});
}

async function fermerLivre() {
  sauvegarder();
  if (book) { book.destroy(); }
  book = null; rendition = null; livreId = null; derniereProgression = null;
  const zone = $('#zoneLecture');
  zone.style.transform = ''; zone.style.opacity = ''; zone.style.transition = '';
  $('#lecteur').hidden = true;
  $('#bibliotheque').hidden = false;
  document.querySelector('meta[name=theme-color]').content = '#1f1b16';
  afficherBibliotheque();
}

function gererClavier(e) {
  if (!rendition?.manager) return; // livre pas encore affiché
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); pageSuivante(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); pagePrecedente(); }
  else if (e.key === 'Escape') { if (!$('#panneauSommaire').hidden || !$('#panneauReglages').hidden) fermerPanneaux(); else history.back(); }
}
document.addEventListener('keydown', (e) => { if (!$('#lecteur').hidden) gererClavier(e); });

// Boutons du lecteur
$('#btnRetour').addEventListener('click', () => history.back());
window.addEventListener('popstate', () => { if (!$('#lecteur').hidden) fermerLivre(); });
$('#pagePrec').addEventListener('click', pagePrecedente);
$('#pageSuiv').addEventListener('click', pageSuivante);
$('#choixMode').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) changerMode(b.dataset.mode); });
$('#btnSommaire').addEventListener('click', () => { $('#panneauReglages').hidden = true; $('#panneauSommaire').hidden = !$('#panneauSommaire').hidden; $('#listeSommaire .actuel')?.scrollIntoView({ block: 'center' }); });
$('#btnReglages').addEventListener('click', () => { $('#panneauSommaire').hidden = true; $('#panneauReglages').hidden = !$('#panneauReglages').hidden; });
document.querySelectorAll('[data-ferme]').forEach(b => b.addEventListener('click', () => { $('#' + b.dataset.ferme).hidden = true; }));

$('#listeSommaire').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-i]');
  if (!a) return;
  e.preventDefault();
  rendition.display(sommairePlat[+a.dataset.i].href);
  fermerPanneaux();
  basculerBarres(true);
});

$('#curseur').addEventListener('input', (e) => { $('#pourcentage').textContent = Math.round(e.target.value / 10) + ' %'; });
$('#curseur').addEventListener('change', (e) => {
  if (locationsPretes) rendition.display(book.locations.cfiFromPercentage(e.target.value / 1000));
});

// Réglages
$('#taillMoins').addEventListener('click', () => { prefs.taille = Math.max(60, prefs.taille - 10); ecrirePrefs(); appliquerPrefs(); });
$('#taillPlus').addEventListener('click', () => { prefs.taille = Math.min(250, prefs.taille + 10); ecrirePrefs(); appliquerPrefs(); });
$('#choixTheme').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b) { prefs.theme = b.dataset.theme; ecrirePrefs(); appliquerPrefs(); } });
$('#choixPolice').addEventListener('click', (e) => { const b = e.target.closest('[data-police]'); if (b) { prefs.police = b.dataset.police; ecrirePrefs(); appliquerPrefs(); } });
$('#choixInterligne').addEventListener('click', (e) => { const b = e.target.closest('[data-interligne]'); if (b) { prefs.interligne = b.dataset.interligne; ecrirePrefs(); appliquerPrefs(); } });

// Sauvegarde quand on quitte l'onglet / verrouille le téléphone
document.addEventListener('visibilitychange', () => { if (document.hidden) sauvegarder(); });
window.addEventListener('resize', () => rendition?.resize?.());

// ---------- Démarrage ----------
(async () => {
  appliquerPrefs();
  $('#bibliotheque').hidden = false;
  try {
    api = await choisirStockage();
  } catch (err) {
    message(err.message, 0);
    return;
  } finally {
    history.replaceState({}, '', location.pathname); // retire le lien de l'email de l'adresse
  }
  $('#bibliotheque').hidden = false;
  document.body.classList.add('stockage-' + api.nom);
  if (api.nom !== 'serveur') {
    // Hors connexion + demande au navigateur de ne pas effacer les livres pour gagner de la place
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.storage?.persist?.().catch(() => {});
  }
  try {
    await afficherBibliotheque();
    proposerTransfert().catch(() => {});
  } catch (err) {
    console.error(err);
    message('Impossible de charger la bibliothèque : ' + err.message, 0);
  }
})();
