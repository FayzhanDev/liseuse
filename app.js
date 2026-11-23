/* Ma Liseuse — bibliothèque + lecteur EPUB (epub.js)
 * Deux façons de stocker les livres :
 *  - "serveur" : le PC lance server.js, les livres sont dans E:\Liseuse\livres (partagés PC + téléphone)
 *  - "appareil" : version en ligne (GitHub Pages), les livres sont gardés dans le navigateur de l'appareil
 */
'use strict';

// Numéro de version affiché en bas du panneau « Aa » (le même que VERSION dans sw.js)
const VERSION_APPLI = '9';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Préférences (propres à chaque appareil) ----------
const ECRAN_TACTILE = matchMedia('(pointer: coarse)').matches;
const PREFS_DEFAUT = {
  taille: ECRAN_TACTILE ? 110 : 100,
  theme: 'nuit',              // ambiance : nuit | abysse | tamisee
  police: 'Literata',
  interligne: '1.74',
  mode: 'pages',
  tamiseur: 0,                // voile sombre, de 0 à 60 %
  zen: false,
};
const CLE_PREFS = 'liseuse.prefs.v3';
const AMBIANCES = ['nuit', 'abysse', 'tamisee'];
const POLICES = ['Literata', 'Lora', 'Atkinson Hyperlegible', ''];
function lirePrefs() {
  let p;
  try { p = { ...PREFS_DEFAUT, ...JSON.parse(localStorage.getItem(CLE_PREFS) || '{}') }; }
  catch { p = { ...PREFS_DEFAUT }; }
  // Anciennes valeurs (Clair/Sépia/Noir, Georgia…) → nouvelle charte
  if (!AMBIANCES.includes(p.theme)) p.theme = 'nuit';
  if (!POLICES.includes(p.police)) p.police = 'Literata';
  if (!['1.5', '1.74', '2'].includes(String(p.interligne))) p.interligne = '1.74';
  return p;
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
  ranger: (id, dossier) => fetch('/api/books/' + encodeURIComponent(id) + '/meta', {
    method: 'PUT', body: JSON.stringify({ dossier }), headers: { 'Content-Type': 'application/json' },
  }),
  annotations: (id) => fetch('/api/books/' + encodeURIComponent(id) + '/annotations').then(r => (r.ok ? r.json() : {})),
  sauverAnnotations: (id, data) => fetch('/api/books/' + encodeURIComponent(id) + '/annotations', {
    method: 'PUT', body: JSON.stringify(data), keepalive: true, headers: { 'Content-Type': 'application/json' },
  }),
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
  async ranger(id, dossier) {
    const l = await lire('livres', id);
    if (l) { l.dossier = dossier; await ecrire('livres', l); }
  },
  async annotations(id) { return (await lire('livres', id))?.annotations || {}; },
  async sauverAnnotations(id, data) {
    const l = await lire('livres', id);
    if (l) { l.annotations = data; await ecrire('livres', l); }
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
      const lignes = await verifier(await sb.from('livres').select('id,title,author,cover,size,fichier,added,progress,annotations,dossier'));
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
  async ranger(id, dossier) {
    await verifier(await sb.from('livres').update({ dossier }).eq('id', id));
    const local = await cache.lire('livres', id);
    if (local) { local.dossier = dossier; await cache.ecrire('livres', local); }
  },
  async annotations(id) {
    const enAttente = lireAttenteNotes()[id];
    if (enAttente) return enAttente.data;
    try {
      const ligne = await verifier(await sb.from('livres').select('annotations').eq('id', id).maybeSingle());
      const local = await cache.lire('livres', id);
      if (local) { local.annotations = ligne?.annotations || {}; await cache.ecrire('livres', local); }
      return ligne?.annotations || {};
    } catch {
      return (await cache.lire('livres', id))?.annotations || {};
    }
  },
  async sauverAnnotations(id, data) {
    const attente = lireAttenteNotes(); attente[id] = { data, updated: Date.now() }; ecrireAttenteNotes(attente);
    const local = await cache.lire('livres', id);
    if (local) { local.annotations = data; await cache.ecrire('livres', local); }
    await envoyerAttente();
  },
};

// Marque-pages et surlignages enregistrés hors connexion
const CLE_ATTENTE_NOTES = 'liseuse.annotations-en-attente';
function lireAttenteNotes() { try { return JSON.parse(localStorage.getItem(CLE_ATTENTE_NOTES) || '{}'); } catch { return {}; } }
function ecrireAttenteNotes(a) { try { localStorage.setItem(CLE_ATTENTE_NOTES, JSON.stringify(a)); } catch { /* ignoré */ } }

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
    for (const [id, n] of Object.entries(lireAttenteNotes())) {
      const { error } = await sb.from('livres').update({ annotations: n.data }).eq('id', id);
      if (error) break;
      const reste = lireAttenteNotes();
      if (reste[id]?.updated === n.updated) { delete reste[id]; ecrireAttenteNotes(reste); }
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

// Écran « choisis ton mot de passe » (annulable = false pour une invitation)
function demanderNouveauMotDePasse(texte, annulable = false) {
  $('#connexion').hidden = true;
  $('#bibliotheque').hidden = true;
  $('#nouveauMdp').hidden = false;
  $('#texteNouveauMdp').textContent = texte;
  $('#erreurNouveauMdp').hidden = true;
  $('#btnAnnulerMdp').hidden = !annulable;
  return new Promise((ok) => {
    $('#btnAnnulerMdp').onclick = () => {
      $('#mdp1').value = ''; $('#mdp2').value = '';
      $('#nouveauMdp').hidden = true;
      ok(false);
    };
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
      ok(true);
    };
  });
}

// Bouton « Changer mon mot de passe » (par ex. après un mot de passe provisoire)
$('#btnMotDePasse').addEventListener('click', async () => {
  const change = await demanderNouveauMotDePasse('Choisis ton nouveau mot de passe.', true);
  $('#bibliotheque').hidden = false;
  if (change) message('Mot de passe changé ✔');
});

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
      if (l.dossier) await apiCloud.ranger(l.id, l.dossier);
      const notes = await l.depuis.annotations(l.id).catch(() => null);
      if (notes?.marques?.length || notes?.surlignages?.length) {
        await verifier(await sb.from('livres').update({ annotations: notes }).eq('id', l.id));
      }
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

// ---------- Dossiers ----------
// Chaque livre a un champ "dossier" : un chemin comme "ASOIAF/Le Trône de fer" ("" = racine).
// Les dossiers n'existent que s'ils contiennent au moins un livre (directement ou dans un sous-dossier).
let dossierCourant = '';
try { dossierCourant = sessionStorage.getItem('liseuse.dossier') || ''; } catch { /* ignoré */ }

const nettoyerNom = (nom) => String(nom || '').replace(/\//g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
const parent = (chemin) => chemin.split('/').slice(0, -1).join('/');
const dernierNom = (chemin) => chemin.split('/').pop();
const dansDossier = (l, chemin) => (l.dossier || '') === chemin || (l.dossier || '').startsWith(chemin + '/');
// Numéro de tome trouvé dans le titre : « Tome 3 », « L'intégrale 1 », « Vol. 2 », « Livre 4 », « #5 »…
function numeroTome(titre) {
  const m = String(titre || '').match(/(?:tome|t\.|vol(?:ume)?\.?|int[ée]grale|livre|partie|#)\s*[-:]?\s*(\d+)/i);
  return m ? Number(m[1]) : Infinity;
}
// Tri des livres d'un dossier : d'abord par numéro de tome, puis par titre
const trierTitres = (a, b) => (numeroTome(a.title) - numeroTome(b.title)) ||
  (a.title || '').localeCompare(b.title || '', 'fr', { numeric: true });

// Tous les dossiers existants (et leurs parents), triés
function tousLesDossiers() {
  const set = new Set();
  for (const l of livresCache) {
    const parts = (l.dossier || '').split('/').filter(Boolean);
    parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/')));
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
}

function allerDossier(chemin) {
  dossierCourant = chemin;
  try { sessionStorage.setItem('liseuse.dossier', chemin); } catch { /* ignoré */ }
  rendreBibliotheque();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const ICONE_DOSSIER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

async function afficherBibliotheque() {
  livresCache = await api.livres();
  rendreBibliotheque();
}

function rendreBibliotheque() {
  const grille = $('#grille');
  $('#vide').hidden = livresCache.length > 0;
  $('#titreListe').hidden = livresCache.length === 0;
  // Si le dossier courant n'existe plus (livres déplacés ou supprimés), on remonte
  while (dossierCourant && !livresCache.some(l => dansDossier(l, dossierCourant))) dossierCourant = parent(dossierCourant);

  const progres = (l) => {
    const pct = Math.round((l.progress?.percent || 0) * 100);
    return `
      <div class="ligne-progres"><span>${esc(l.progress?.chapter || (l.progress ? 'En cours' : 'Pas encore commencé'))}</span><b>${pct} %</b></div>
      <div class="jauge"><div style="width:${pct}%"></div></div>`;
  };

  // Sous-dossiers directs du dossier courant
  const prefixe = dossierCourant ? dossierCourant + '/' : '';
  const sousDossiers = [...new Set(livresCache
    .map(l => l.dossier || '')
    .filter(d => d.startsWith(prefixe) && d.length > prefixe.length)
    .map(d => prefixe + d.slice(prefixe.length).split('/')[0]))]
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  const livresIci = livresCache.filter(l => (l.dossier || '') === dossierCourant).sort(trierTitres);

  const carteDossier = (chemin) => {
    const contenu = livresCache.filter(l => dansDossier(l, chemin));
    const nbSous = new Set(contenu.map(l => l.dossier).filter(d => d !== chemin).map(d => d.slice(chemin.length + 1).split('/')[0])).size;
    const couvertures = contenu.filter(l => l.cover).sort(trierTitres).slice(0, 4);
    const lus = contenu.filter(l => (l.progress?.percent || 0) >= 0.995).length;
    const pct = Math.round(contenu.reduce((s, l) => s + (l.progress?.percent || 0), 0) / Math.max(1, contenu.length) * 100);
    return `
      <article class="livre dossier" data-dossier="${esc(chemin)}" tabindex="0">
        <div class="couverture">${couvertures.length
          ? `<div class="mosaique">${couvertures.map(l => `<img src="${esc(l.cover)}" alt="" loading="lazy">`).join('')}</div>`
          : `<span class="icone-dossier">${ICONE_DOSSIER}</span>`}</div>
        <div class="infos">
          <div class="badge-dossier">Dossier</div>
          <div class="nom">${esc(dernierNom(chemin))}</div>
          <div class="auteur">${contenu.length} livre${contenu.length > 1 ? 's' : ''}${nbSous ? ` · ${nbSous} sous-dossier${nbSous > 1 ? 's' : ''}` : ''}${lus ? ` · ${lus} terminé${lus > 1 ? 's' : ''}` : ''}</div>
          <div class="ligne-progres"><span>Progression moyenne</span><b>${pct} %</b></div>
          <div class="jauge"><div style="width:${pct}%"></div></div>
        </div>
        <div class="actions-carte">
          <button class="mini" data-renommer-dossier="${esc(chemin)}" title="Renommer ou déplacer ce dossier" aria-label="Renommer le dossier">✎</button>
          <button class="mini" data-suppr-dossier="${esc(chemin)}" title="Supprimer le dossier (les livres sont gardés)" aria-label="Supprimer le dossier">✕</button>
        </div>
      </article>`;
  };

  grille.innerHTML = sousDossiers.map(carteDossier).join('') + livresIci.map(l => `
      <article class="livre" data-id="${esc(l.id)}" tabindex="0">
        <div class="couverture">${htmlCouverture(l)}</div>
        <div class="infos">
          <div class="nom">${esc(l.title)}</div>
          <div class="auteur">${esc(l.author) || '&nbsp;'}</div>
          ${progres(l)}
        </div>
        <div class="actions-carte">
          <button class="mini" data-ranger="${esc(l.id)}" title="Ranger dans un dossier" aria-label="Ranger dans un dossier">${ICONE_DOSSIER.replace(/18/g, '14')}</button>
          <button class="mini" data-suppr="${esc(l.id)}" title="Supprimer ce livre" aria-label="Supprimer">✕</button>
        </div>
      </article>`).join('');
  $('#dossierVide').hidden = !(livresCache.length && !sousDossiers.length && !livresIci.length);

  // En-tête : racine ou dossier (avec fil d'Ariane)
  const total = dossierCourant ? livresCache.filter(l => dansDossier(l, dossierCourant)).length : livresCache.length;
  $('#compteurLivres').textContent = `${total} livre${total > 1 ? 's' : ''}`;
  if (dossierCourant) {
    const parts = dossierCourant.split('/');
    $('#filAriane').innerHTML = `<button data-chemin="">Bibliothèque</button>` + parts.map((p, i) =>
      `<span class="sep">›</span>${i < parts.length - 1 ? `<button data-chemin="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>` : `<span>${esc(p)}</span>`}`).join('');
    $('#filAriane').hidden = false;
    $('#titreDossier').textContent = dernierNom(dossierCourant);
    $('#sousTitreDossier').textContent = 'Les livres de ce dossier, rangés par titre.';
  } else {
    $('#filAriane').hidden = true;
    $('#titreDossier').textContent = 'Bibliothèque de la veillée';
    $('#sousTitreDossier').textContent = 'Choisis un livre ou un dossier pour l’ouvrir en lumière tamisée.';
  }

  afficherEspace();

  const enCours = !dossierCourant && livresCache.find(l => l.progress && l.progress.percent < 0.995);
  $('#reprendre').hidden = !enCours;
  if (enCours) {
    $('#carteReprendre').innerHTML = `
      <div class="reprendre" data-id="${esc(enCours.id)}">
        <div class="couverture">${htmlCouverture(enCours)}</div>
        <div class="infos">
          <div class="nom">${esc(enCours.title)}</div>
          <div class="auteur">${esc(enCours.author) || '&nbsp;'}</div>
          ${progres(enCours)}
        </div>
      </div>`;
  }
}

document.addEventListener('click', async (e) => {
  // Dossiers : fil d'Ariane, ranger, renommer, supprimer, ouvrir
  const chemin = e.target.closest('#filAriane [data-chemin]');
  if (chemin) return allerDossier(chemin.dataset.chemin);
  const ranger = e.target.closest('[data-ranger]');
  if (ranger) { e.stopPropagation(); return ouvrirRanger(ranger.dataset.ranger); }
  const renommer = e.target.closest('[data-renommer-dossier]');
  if (renommer) { e.stopPropagation(); return renommerDossier(renommer.dataset.renommerDossier); }
  const supprDossier = e.target.closest('[data-suppr-dossier]');
  if (supprDossier) { e.stopPropagation(); return supprimerDossier(supprDossier.dataset.supprDossier); }
  const dossier = e.target.closest('#bibliotheque [data-dossier]');
  if (dossier) return allerDossier(dossier.dataset.dossier);

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
  if (e.key !== 'Enter' || !e.target.matches?.('.livre')) return;
  if (e.target.dataset.dossier !== undefined) allerDossier(e.target.dataset.dossier);
  else ouvrirLivre(e.target.dataset.id);
});

// Déplace plusieurs livres d'un coup (renommer / supprimer un dossier)
async function deplacerLivres(livres, nouveauChemin) {
  for (const { id, dossier } of livres) await api.ranger(id, nouveauChemin(dossier));
}

async function renommerDossier(chemin) {
  const nouveau = prompt(
    `Nouveau nom pour « ${dernierNom(chemin)} ».\nTu peux aussi le déplacer en écrivant un chemin avec « / », par exemple :  ASOIAF/${dernierNom(chemin)}`,
    chemin,
  );
  if (nouveau === null) return;
  const propre = nouveau.split('/').map(nettoyerNom).filter(Boolean).join('/');
  if (!propre || propre === chemin) return;
  if (propre.startsWith(chemin + '/')) return message('Un dossier ne peut pas être rangé dans lui-même.', 5000);
  const concernes = livresCache.filter(l => dansDossier(l, chemin)).map(l => ({ id: l.id, dossier: l.dossier }));
  try {
    message('Renommage…', 0);
    await deplacerLivres(concernes, (d) => propre + d.slice(chemin.length));
    message('Dossier renommé ✔');
    if (dossierCourant === chemin || dossierCourant.startsWith(chemin + '/')) dossierCourant = propre + dossierCourant.slice(chemin.length);
    await afficherBibliotheque();
  } catch (err) { message('Erreur : ' + err.message, 8000); }
}

async function supprimerDossier(chemin) {
  const haut = parent(chemin);
  const concernes = livresCache.filter(l => dansDossier(l, chemin)).map(l => ({ id: l.id, dossier: l.dossier }));
  if (!confirm(`Supprimer le dossier « ${dernierNom(chemin)} » ?\nSes ${concernes.length} livre(s) ne sont pas effacés : ils sont remis dans « ${haut ? dernierNom(haut) : 'Bibliothèque'} ».`)) return;
  try {
    // Les sous-dossiers remontent d'un niveau avec leurs livres
    await deplacerLivres(concernes, (d) => [haut, d.slice(chemin.length + 1)].filter(Boolean).join('/'));
    message('Dossier supprimé, livres conservés ✔');
    await afficherBibliotheque();
  } catch (err) { message('Erreur : ' + err.message, 8000); }
}

// ---------- Fenêtre « Ranger dans un dossier » ----------
let rangerLivreId = null, rangerChoix = '';

function rendreChoixDossiers() {
  const options = ['', ...tousLesDossiers()];
  $('#listeDossiers').innerHTML = options.map(d => {
    const profondeur = d ? d.split('/').length : 0;
    return `<button type="button" class="choix-dossier${d === rangerChoix ? ' actif' : ''}" data-choix="${esc(d)}"
      role="radio" aria-checked="${d === rangerChoix}" style="padding-left:${12 + profondeur * 18}px">
      ${ICONE_DOSSIER}<span>${d ? esc(dernierNom(d)) : 'Bibliothèque (aucun dossier)'}</span></button>`;
  }).join('');
  $('#nouveauDans').textContent = rangerChoix ? `(dans « ${dernierNom(rangerChoix)} »)` : '(à la racine)';
}

function ouvrirRanger(id) {
  const l = livresCache.find(x => x.id === id);
  if (!l) return;
  rangerLivreId = id;
  rangerChoix = l.dossier || dossierCourant || '';
  $('#titreRanger').textContent = `Ranger « ${l.title} »`;
  $('#nomNouveauDossier').value = '';
  rendreChoixDossiers();
  $('#dialogueRanger').showModal();
}

$('#listeDossiers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-choix]');
  if (!b) return;
  rangerChoix = b.dataset.choix;
  rendreChoixDossiers();
});
$('#annulerRanger').addEventListener('click', () => $('#dialogueRanger').close());
$('#formRanger').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nouveau = nettoyerNom($('#nomNouveauDossier').value);
  const cible = [rangerChoix, nouveau].filter(Boolean).join('/');
  $('#dialogueRanger').close();
  try {
    await api.ranger(rangerLivreId, cible);
    message(cible ? `Rangé dans « ${cible.split('/').join(' › ')} » ✔` : 'Remis à la racine de la bibliothèque ✔');
    await afficherBibliotheque();
  } catch (err) { message('Erreur : ' + err.message, 8000); }
});

// ---------- Espace utilisé ----------
const LIMITE_GRATUITE = 1024 ** 3; // 1 Go offert par Supabase (partagé entre tous les comptes du projet)
function formaterTaille(o) {
  if (o < 1024 * 1024) return (o / 1024).toFixed(0) + ' Ko';
  if (o < 1024 ** 3) return (o / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Mo';
  return (o / 1024 ** 3).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' Go';
}
async function afficherEspace() {
  const total = livresCache.reduce((s, l) => s + (Number(l.size) || 0), 0);
  const zone = $('#espace');
  zone.hidden = !livresCache.length;
  if (!livresCache.length) return;
  let limite = null, detail = '';
  if (api.nom === 'cloud') {
    limite = LIMITE_GRATUITE;
    const restants = Math.max(0, Math.floor((limite - total) / Math.max(1, total / livresCache.length)));
    detail = `Tes ${livresCache.length} livre${livresCache.length > 1 ? 's' : ''} dans ton espace en ligne. Le projet gratuit offre 1 Go, partagé entre tous les comptes de la liseuse : encore environ ${restants.toLocaleString('fr-FR')} livres de cette taille.`;
  } else if (api.nom === 'appareil') {
    try {
      const est = await navigator.storage.estimate();
      if (est.quota) { limite = est.quota; detail = 'Espace que le navigateur de cet appareil réserve à la liseuse.'; }
    } catch { /* non disponible */ }
  } else {
    detail = 'Livres rangés dans le dossier « livres » du PC.';
  }
  $('#espaceTexte').textContent = limite ? `${formaterTaille(total)} sur ${formaterTaille(limite)}` : formaterTaille(total);
  $('#espaceJauge').style.width = limite ? Math.max(1, Math.min(100, total / limite * 100)).toFixed(1) + '%' : '0%';
  $('#espaceDetail').textContent = detail;
}

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

// Couleurs des ambiances dans le livre : [fond, texte, liens, fond de l'application]
const THEMES = {
  nuit: ['#141918', '#DCE4E0', '#2E9E7B', '#0E1211'],
  abysse: ['#0F1D20', '#D5E2E3', '#3FA8B2', '#0A1416'],
  tamisee: ['#101312', '#AEB9B3', '#2A7F65', '#0B0D0C'],
};
const COULEURS_SURLIGNAGE = { emeraude: '#2E9E7B', canard: '#23848E' };
const URL_POLICES = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=Lora:ital,wght@0,400;0,600;1,400&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap';

// Une seule feuille de style "liseuse" par page du livre, réécrite à chaque changement de réglage
// (les thèmes intégrés à epub.js s'empilent au lieu de se remplacer).
function cssLecture() {
  const [fond, texte, lien] = THEMES[prefs.theme] || THEMES.nuit;
  const police = prefs.police ? `font-family: "${prefs.police}", Georgia, serif !important;` : '';
  return `
    @import url("${URL_POLICES}");
    html, body { background: ${fond} !important; color: ${texte} !important; }
    ::selection { background: ${COULEURS_SURLIGNAGE.emeraude}66; }
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
  document.body.dataset.ambiance = prefs.theme;
  const [fondLecture, , , fondAppli] = THEMES[prefs.theme];
  document.querySelector('meta[name=theme-color]').content = lect.hidden ? fondAppli : fondLecture;
  $('#tamiseur').style.opacity = String(prefs.tamiseur / 100);
  $('#tamiseurCurseur').value = prefs.tamiseur;
  $('#valeurTamiseur').textContent = prefs.tamiseur + ' %';
  lect.classList.toggle('mode-defilement', prefs.mode === 'defilement');
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('actif', b.dataset.mode === prefs.mode));
  $('#tailleValeur').textContent = prefs.taille + ' %';
  document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('actif', b.dataset.theme === prefs.theme));
  document.querySelectorAll('[data-police]').forEach(b => b.classList.toggle('actif', b.dataset.police === prefs.police));
  document.querySelectorAll('[data-interligne]').forEach(b => b.classList.toggle('actif', b.dataset.interligne === prefs.interligne));
  if (!rendition) return;
  rendition.themes.fontSize(prefs.taille + '%');
  for (const c of rendition.getContents?.() || []) injecterCss(c.document);
  if (annotationsLivre.surlignages.length) rafraichirSurlignages(500);
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
  if (prefs.zen) return; // en mode Zen, les barres restent cachées
  $('#lecteur').classList.toggle('immersif', forcer);
}

// ---------- Mode Zen : seulement le texte ----------
function appliquerZen() {
  const lect = $('#lecteur');
  lect.classList.toggle('zen', prefs.zen);
  $('#sortieZen').hidden = !prefs.zen || lect.hidden;
  $('#btnZen').setAttribute('aria-pressed', String(prefs.zen));
  if (!prefs.zen) lect.classList.remove('immersif');
  // La zone de lecture change de taille : on recalcule la mise en page puis les surlignages
  setTimeout(() => { rendition?.resize?.(); rafraichirSurlignages(); }, 260);
}
function basculerZen(actif = !prefs.zen) {
  prefs.zen = actif; ecrirePrefs();
  fermerPanneaux();
  appliquerZen();
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

// ---------- Sécurité : nettoyage de chaque chapitre avant affichage ----------
// Safari (iPhone) ne transmet les touchers à la liseuse que si le cadre du livre autorise les scripts.
// On les autorise donc, MAIS on retire tout code du livre avant de l'afficher :
// un EPUB piégé ne peut ainsi rien exécuter (ni lire ta session de connexion).
const BALISES_INTERDITES = 'script, iframe, frame, frameset, object, embed, applet, base, form, meta[http-equiv]';
function nettoyerChapitre(doc) {
  doc.querySelectorAll(BALISES_INTERDITES).forEach(el => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const nom = attr.name.toLowerCase();
      const valeur = attr.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
      if (nom.startsWith('on')) el.removeAttribute(attr.name); // onclick, onload, onerror…
      else if (/(^|:)(href|src|action|formaction|data|xlink:href)$/.test(nom) &&
               (valeur.startsWith('javascript:') || valeur.startsWith('vbscript:') || valeur.startsWith('data:text/html'))) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

// Crée l'affichage du livre selon le mode choisi (pages ou défilement)
function creerRendu() {
  const defilement = prefs.mode === 'defilement';
  $('#zoneLecture').innerHTML = '';
  // allowScriptedContent: true est nécessaire pour Safari iOS (voir nettoyerChapitre plus haut)
  rendition = book.renderTo('zoneLecture', defilement
    ? { width: '100%', height: '100%', flow: 'scrolled', manager: 'continuous', allowScriptedContent: true }
    : { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', minSpreadWidth: 900, allowScriptedContent: true });
  appliquerPrefs();

  // Gestes (glisser / toucher / clavier) à l'intérieur du livre
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    injecterCss(doc);
    const zone = $('#zoneLecture');
    let debutX = null, debutY = null, debutT = 0, horizontal = null, glisse = false;
    let dernierToucher = 0; // pour ignorer le « clic » que certains navigateurs envoient après un toucher

    const texteSelectionne = () => !!doc.getSelection()?.toString().trim();

    // Un toucher (ou un clic) à la position clientX : bord gauche / centre / bord droit
    const toucherA = (clientX) => {
      $('#barreSurlignage').hidden = true;
      if (prefs.mode !== 'pages') return basculerBarres(); // défilement : un toucher affiche/cache les barres
      const cadre = contents.window.frameElement.getBoundingClientRect();
      const z = zone.getBoundingClientRect();
      const x = (cadre.left + clientX - z.left) / z.width;
      // Tiers gauche = page précédente, tiers droit = page suivante, centre = menu
      if (x < 0.33) pagePrecedente();
      else if (x > 0.67) pageSuivante();
      else basculerBarres();
    };

    doc.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) { debutX = null; return; }
      const t = e.touches[0];
      debutX = t.screenX; debutY = t.screenY; debutT = Date.now(); horizontal = null;
      // La page ne suit le doigt qu'en mode Pages, hors sélection de texte
      glisse = prefs.mode === 'pages' && !animationEnCours && !texteSelectionne();
      if (glisse) zone.style.transition = 'none';
    }, { passive: true });

    doc.addEventListener('touchmove', (e) => {
      if (debutX === null || !glisse) return;
      const t = e.touches[0];
      const dx = t.screenX - debutX, dy = t.screenY - debutY;
      if (horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) {
        // La page suit le doigt
        zone.style.transform = `translateX(${dx}px)`;
        zone.style.opacity = String(1 - Math.min(Math.abs(dx) / zone.clientWidth, 1) * 0.6);
      }
    }, { passive: true });

    const finToucher = (e) => {
      if (debutX === null) return;
      const t = e.changedTouches[0];
      const dx = t.screenX - debutX, dy = t.screenY - debutY;
      const duree = Date.now() - debutT;
      const etaitHorizontal = horizontal;
      debutX = null; horizontal = null;

      // 1. Simple toucher (court, sans bouger) : on le gère nous-mêmes.
      //    Sur iPhone, Safari n'envoie pas toujours de « clic » sur du texte.
      if (e.type === 'touchend' && Math.abs(dx) < 10 && Math.abs(dy) < 10 && duree < 400) {
        if (glisse) annulerGlissement();
        if (e.target.closest?.('a') || texteSelectionne()) return;
        dernierToucher = Date.now();
        toucherA(t.clientX);
        return;
      }
      if (!glisse) return;
      // 2. Glissement : pendant une sélection de texte (appui long), on ne tourne pas la page
      if (!etaitHorizontal || texteSelectionne()) { annulerGlissement(); return; }
      // On tourne si le doigt a parcouru assez de distance, ou s'il a été lancé rapidement
      const vitesse = Math.abs(dx) / Math.max(1, duree);
      if (Math.abs(dx) > zone.clientWidth * 0.18 || (Math.abs(dx) > 25 && vitesse > 0.35)) {
        dx < 0 ? pageSuivante() : pagePrecedente();
      } else {
        annulerGlissement();
      }
    };
    doc.addEventListener('touchend', finToucher, { passive: true });
    doc.addEventListener('touchcancel', finToucher, { passive: true });

    // Souris (PC) — et clic envoyé après un toucher, qu'on ignore car déjà traité
    doc.addEventListener('click', (e) => {
      if (Date.now() - dernierToucher < 700) return;
      if (e.target.closest('a')) return;
      if (texteSelectionne()) return;
      toucherA(e.clientX);
    });
    doc.addEventListener('keydown', gererClavier);
  });

  rendition.on('relocated', surDeplacement);
  rendition.on('selected', surSelection);
  rendition.on('resized', () => rafraichirSurlignages());
  appliquerSurlignages();
}

// =============== MARQUE-PAGES ET SURLIGNAGES ===============
// annotationsLivre = { marques: [{ cfi, pct, chapitre, extrait, date }],
//                      surlignages: [{ cfi, couleur, texte, chapitre, date }] }
let annotationsLivre = { marques: [], surlignages: [] };
let selectionEnCours = null;

function sauverAnnotations() {
  if (!livreId) return;
  Promise.resolve(api.sauverAnnotations(livreId, annotationsLivre)).catch(() => {});
  afficherNotes();
}

// Compare deux positions CFI (-1, 0, 1)
function comparerCfi(a, b) {
  try { return new ePub.CFI().compare(a, b); } catch { return a === b ? 0 : (a < b ? -1 : 1); }
}

// Marque-page dans la page actuellement affichée ?
function marqueSurLaPage() {
  const loc = rendition?.currentLocation();
  if (!loc?.start) return null;
  return annotationsLivre.marques.find(m =>
    comparerCfi(m.cfi, loc.start.cfi) >= 0 && comparerCfi(m.cfi, loc.end.cfi) <= 0) || null;
}

function majBoutonMarque() {
  const actif = !!marqueSurLaPage();
  const b = $('#btnMarque');
  b.setAttribute('aria-pressed', String(actif));
  b.setAttribute('aria-label', actif ? 'Retirer le marque-page' : 'Ajouter un marque-page');
}

async function extraitA(cfi) {
  try {
    const range = await book.getRange(cfi);
    const texte = (range.startContainer.textContent || '').slice(range.startOffset);
    return texte.replace(/\s+/g, ' ').trim().slice(0, 140);
  } catch { return ''; }
}

async function basculerMarque() {
  if (!rendition?.manager) return;
  const existante = marqueSurLaPage();
  if (existante) {
    annotationsLivre.marques = annotationsLivre.marques.filter(m => m !== existante);
  } else {
    const loc = rendition.currentLocation();
    annotationsLivre.marques.push({
      cfi: loc.start.cfi,
      pct: derniereProgression?.percent || 0,
      chapitre: chapitrePour(loc.start.href),
      extrait: await extraitA(loc.start.cfi),
      date: Date.now(),
    });
    annotationsLivre.marques.sort((a, b) => comparerCfi(a.cfi, b.cfi));
  }
  majBoutonMarque();
  sauverAnnotations();
}

// Dessine un surlignage dans le livre (un clic dessus propose de le retirer)
function dessinerSurlignage(s) {
  try {
    rendition.annotations.highlight(s.cfi, { couleur: s.couleur }, () => {
      if (confirm('Retirer ce surlignage ?')) retirerSurlignage(s.cfi);
    }, 'surlignage-' + s.couleur, {
      fill: COULEURS_SURLIGNAGE[s.couleur] || COULEURS_SURLIGNAGE.emeraude,
      'fill-opacity': '0.35',
      'mix-blend-mode': 'normal',
    });
  } catch (err) { console.warn('Surlignage impossible', err); }
}
function appliquerSurlignages() {
  if (!rendition) return;
  for (const s of annotationsLivre.surlignages) dessinerSurlignage(s);
}
// Après un changement de mise en page (Zen, taille du texte, rotation…), les surlignages
// doivent être recalculés pour suivre le texte.
let minuterieSurlignages = null;
function rafraichirSurlignages(delai = 350) {
  clearTimeout(minuterieSurlignages);
  minuterieSurlignages = setTimeout(() => {
    if (!rendition) return;
    for (const s of annotationsLivre.surlignages) {
      try { rendition.annotations.remove(s.cfi, 'highlight'); } catch { /* ignoré */ }
    }
    appliquerSurlignages();
  }, delai);
}
function retirerSurlignage(cfi) {
  try { rendition.annotations.remove(cfi, 'highlight'); } catch { /* déjà retiré */ }
  annotationsLivre.surlignages = annotationsLivre.surlignages.filter(s => s.cfi !== cfi);
  sauverAnnotations();
}

// Texte sélectionné dans le livre → on propose de le surligner
function surSelection(cfiRange, contents) {
  const texte = contents?.window?.getSelection()?.toString().replace(/\s+/g, ' ').trim() || '';
  if (!texte) return;
  selectionEnCours = { cfi: cfiRange, texte: texte.slice(0, 500), contents };
  $('#barreSurlignage').hidden = false;
}
function surligner(couleur) {
  if (!selectionEnCours) return;
  const s = {
    cfi: selectionEnCours.cfi,
    couleur,
    texte: selectionEnCours.texte,
    chapitre: chapitrePour(rendition.currentLocation()?.start?.href),
    date: Date.now(),
  };
  annotationsLivre.surlignages = annotationsLivre.surlignages.filter(x => x.cfi !== s.cfi);
  annotationsLivre.surlignages.push(s);
  annotationsLivre.surlignages.sort((a, b) => comparerCfi(a.cfi, b.cfi));
  dessinerSurlignage(s);
  annulerSelection();
  sauverAnnotations();
}
function annulerSelection() {
  try { selectionEnCours?.contents?.window?.getSelection()?.removeAllRanges(); } catch { /* ignoré */ }
  selectionEnCours = null;
  $('#barreSurlignage').hidden = true;
}

// Listes dans le panneau (onglets Marque-pages / Surlignages)
function afficherNotes() {
  const { marques, surlignages } = annotationsLivre;
  $('#listeMarques').innerHTML = marques.length
    ? marques.map((m, i) => `
      <div class="element-note" data-aller="${esc(m.cfi)}">
        <div class="corps">
          <div class="meta">${esc(m.chapitre || 'Marque-page')} · ${Math.round((m.pct || 0) * 100)} %</div>
          <div class="extrait">${esc(m.extrait || '…')}</div>
        </div>
        <button class="icone petite" data-suppr-marque="${i}" aria-label="Supprimer ce marque-page">✕</button>
      </div>`).join('')
    : '<p class="vide-liste">Aucun marque-page pour l’instant. Touche l’icône marque-page en haut de l’écran pour garder ta place.</p>';
  $('#listeSurlignages').innerHTML = surlignages.length
    ? surlignages.map((s, i) => `
      <div class="element-note" data-aller="${esc(s.cfi)}">
        <div class="corps">
          <div class="meta">${esc(s.chapitre || 'Surlignage')}</div>
          <div class="extrait surligne-${esc(s.couleur)}">${esc(s.texte)}</div>
        </div>
        <button class="icone petite" data-suppr-surlignage="${i}" aria-label="Supprimer ce surlignage">✕</button>
      </div>`).join('')
    : '<p class="vide-liste">Aucun surlignage. Sélectionne un passage du livre (appui long sur téléphone), puis choisis une couleur.</p>';
}

function changerOnglet(nom) {
  document.querySelectorAll('.onglet').forEach(o => o.classList.toggle('actif', o.dataset.onglet === nom));
  document.querySelectorAll('.liste-onglet').forEach(l => { l.hidden = l.dataset.contenu !== nom; });
}

function surDeplacement(loc) {
  const chapitre = chapitrePour(loc.start.href);
  $('#titreChapitre').textContent = chapitre;
  let pct;
  if (locationsPretes) pct = book.locations.percentageFromCfi(loc.start.cfi);
  else pct = (loc.start.index || 0) / Math.max(1, book.spine.length);
  $('#pourcentage').textContent = Math.round(pct * 100) + ' %';
  $('#repere').textContent = Math.round(pct * 100) + ' %';
  if (locationsPretes) $('#curseur').value = Math.round(pct * 1000);
  document.querySelectorAll('#listeSommaire a').forEach(a => a.classList.toggle('actuel', a.textContent === chapitre));
  derniereProgression = { cfi: loc.start.cfi, percent: pct, chapter: chapitre };
  majBoutonMarque();
  $('#barreSurlignage').hidden = true;
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
  annotationsLivre = { marques: [], surlignages: [] };
  afficherNotes();
  changerOnglet('sommaire');
  $('#bibliotheque').hidden = true;
  $('#lecteur').hidden = false;
  document.body.classList.add('dans-lecteur');
  appliquerPrefs();
  appliquerZen();
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
    // Chaque chapitre est nettoyé dès son chargement, avant d'être mis dans la page
    book.spine.hooks.content.register((doc) => nettoyerChapitre(doc));
    creerRendu();
    await Promise.race([
      book.opened,
      new Promise((_, rejeter) => setTimeout(() => rejeter(new Error('le fichier ne se charge pas')), 30000)),
    ]);
    const [nav, meta, progres, notes] = await Promise.all([
      book.loaded.navigation, book.loaded.metadata, api.progression(id), Promise.resolve(api.annotations(id)).catch(() => ({})),
    ]);
    annotationsLivre = { marques: notes?.marques || [], surlignages: notes?.surlignages || [] };
    afficherNotes();
    appliquerSurlignages();
    sommairePlat = aplatirSommaire(nav.toc || []);
    $('#listeSommaire').innerHTML = sommairePlat.length
      ? sommairePlat.map((it, i) => `<a href="#" data-i="${i}" class="${it.niveau ? 'sous' : ''}">${esc(it.label)}</a>`).join('')
      : '<p style="padding:16px">Ce livre n’a pas de sommaire.</p>';
    if (meta.title) $('#titreLivre').textContent = meta.title;

    await rendition.display(progres?.cfi || undefined);
    // Sur téléphone, on lit en plein écran : les barres réapparaissent en touchant le centre
    if (ECRAN_TACTILE) setTimeout(() => basculerBarres(true), 1200);

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
  annulerSelection();
  fermerPanneaux();
  $('#lecteur').hidden = true;
  $('#sortieZen').hidden = true;
  $('#bibliotheque').hidden = false;
  document.body.classList.remove('dans-lecteur');
  appliquerPrefs();
  afficherBibliotheque();
}

function gererClavier(e) {
  if (!rendition?.manager) return; // livre pas encore affiché
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); pageSuivante(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); pagePrecedente(); }
  else if (e.key === 'Escape') {
    if (!$('#barreSurlignage').hidden) annulerSelection();
    else if (!$('#panneauSommaire').hidden || !$('#panneauReglages').hidden) fermerPanneaux();
    else if (prefs.zen) basculerZen(false);
    else history.back();
  }
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
$('#btnAmbiance').addEventListener('click', () => { $('#panneauReglages').hidden = !$('#panneauReglages').hidden; });
$('#btnZen').addEventListener('click', () => basculerZen(true));
$('#sortieZen').addEventListener('click', () => basculerZen(false));
$('#btnMarque').addEventListener('click', basculerMarque);
$('#tamiseurCurseur').addEventListener('input', (e) => { prefs.tamiseur = Number(e.target.value); ecrirePrefs(); appliquerPrefs(); });

// Onglets du panneau : Sommaire / Marque-pages / Surlignages
document.querySelectorAll('.onglet').forEach(o => o.addEventListener('click', () => changerOnglet(o.dataset.onglet)));
['#listeMarques', '#listeSurlignages'].forEach(sel => $(sel).addEventListener('click', (e) => {
  const supprM = e.target.closest('[data-suppr-marque]');
  const supprS = e.target.closest('[data-suppr-surlignage]');
  if (supprM) {
    annotationsLivre.marques.splice(+supprM.dataset.supprMarque, 1);
    majBoutonMarque(); sauverAnnotations(); return;
  }
  if (supprS) { retirerSurlignage(annotationsLivre.surlignages[+supprS.dataset.supprSurlignage].cfi); return; }
  const aller = e.target.closest('[data-aller]');
  if (aller) { rendition.display(aller.dataset.aller); fermerPanneaux(); basculerBarres(true); }
}));

// Barre de surlignage
document.querySelectorAll('.puce-couleur').forEach(b => b.addEventListener('click', () => surligner(b.dataset.couleur)));
$('#annulerSurlignage').addEventListener('click', annulerSelection);
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
  $('#numeroVersion').textContent = `Ma Liseuse · version ${VERSION_APPLI}`;
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
