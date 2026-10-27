'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_IDEA_LENGTH = 280;
  const PHASES = ['lobby', 'writing', 'reveal'];
  let auth = null, db = null, ready = false;
  let role = null, code = '', uid = '', phase = 'lobby', duration = 5, endsAt = 0;
  let guestConnected = false, networkConnected = true, serverOffset = 0;
  let ideas = [], ownIdeas = [], liveNotes = {host: [], guest: []};
  let listeners = [], noteListeners = new Set(), attachedDisconnect = null;
  let busy = false, operationId = 0, changingPhase = false, toastTimeout = null;
  const initialRoom = new URLSearchParams(location.search).get('room');

  function newCode() { return Array.from(crypto.getRandomValues(new Uint8Array(6)), v => CODE_CHARS[v % CODE_CHARS.length]).join(''); }
  function cleanCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0,6); }
  function validCode(value) { return value.length === 6 && [...value].every(c => CODE_CHARS.includes(c)); }
  function roomPath(sub = '') { return `rooms/${code}${sub ? '/' + sub : ''}`; }
  function serverNow() { return Date.now() + serverOffset; }
  function remainingMs() { return Math.max(0, endsAt - serverNow()); }
  function show(id, showIt) { $(id).classList.toggle('hidden', !showIt); }
  function showToast(message) {
    clearTimeout(toastTimeout); $('toast').textContent = message; $('toast').classList.add('show');
    toastTimeout = setTimeout(() => $('toast').classList.remove('show'), 6500);
  }
  function setBusy(value) {
    busy = value;
    $('createBtn').disabled = value; $('joinBtn').disabled = value;
    $('createBtn').textContent = value ? 'Creating…' : 'Create a room →';
    $('joinBtn').textContent = value ? 'Connecting…' : 'Join room →';
  }
  function friendlyError(err) {
    console.warn('Brainwrite connection error:', err);
    const message = String(err?.code || err?.message || '');
    if (message.includes('auth/operation-not-allowed')) return 'Enable Anonymous sign-in in Firebase Authentication.';
    if (message.includes('permission_denied') || message.includes('PERMISSION_DENIED')) return 'Firebase blocked access. Check the Realtime Database rules (database.rules.json).';
    if (message.includes('auth/unauthorized-domain')) return 'Add your GitHub Pages domain to Firebase Authentication > Settings > Authorized domains.';
    if (message.includes('auth/invalid-api-key') || message.includes('app/invalid')) return 'Firebase configuration is incorrect. Check firebase-config.js.';
    if (message.includes('NETWORK_ERROR') || message.includes('network-request-failed')) return 'Network error. Check your connection and retry.';
    return 'Connection failed. Verify Firebase setup and try again.';
  }
  function subscribe(reference, handler) {
    reference.on('value', handler, error => showToast(friendlyError(error)));
    listeners.push({reference, handler});
  }
  function unlistenAll() {
    listeners.forEach(({reference, handler}) => reference.off('value', handler));
    listeners = []; noteListeners.clear();
  }
  async function ensureFirebase() {
    if (ready) return;
    const cfg = window.BRAINWRITE_FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || !cfg.authDomain || !cfg.databaseURL || !cfg.projectId || !cfg.appId || cfg.apiKey.includes('YOUR_')) {
      throw new Error('setup-missing');
    }
    if (typeof firebase === 'undefined') throw new Error('firebase-not-loaded');
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    auth = firebase.auth(); db = firebase.database();
    const user = await new Promise((resolve, reject) => {
      const unsubscribe = auth.onAuthStateChanged(u => { unsubscribe(); resolve(u); }, reject);
    });
    uid = (user || (await auth.signInAnonymously()).user).uid;
    // Firebase uses a server time offset, so two people in different time zones share a timer.
    db.ref('.info/serverTimeOffset').on('value', s => { serverOffset = Number(s.val()) || 0; });
    db.ref('.info/connected').on('value', s => {
      networkConnected = s.val() === true;
      updateConnectionLabel();
      // onDisconnect runs once. Re-arm after each reconnect.
      if (networkConnected && role && attachedDisconnect && attachedDisconnect.refPath === roomPath(attachedDisconnect.sub)) {
        const snapshotRole = role;
        const target = db.ref(roomPath(attachedDisconnect.sub));
        target.onDisconnect().remove().catch(err => { if (role === snapshotRole) showToast(friendlyError(err)); });
      }
    });
    ready = true;
  }
  function resetState(message = '') {
    operationId++;
    unlistenAll(); role = null; code = ''; phase = 'lobby'; duration = 5; endsAt = 0;
    guestConnected = false; ideas = []; ownIdeas = []; liveNotes = {host:[],guest:[]};
    attachedDisconnect = null; changingPhase = false; setBusy(false);
    show('homeView', true); show('sessionView', false); updateBrowserUrl();
    if (message) showToast(message);
  }
  function updateBrowserUrl(suffix = '') {
    if (location.protocol.startsWith('http')) {
      try { history.replaceState({}, '', location.pathname + suffix); } catch (_) {}
    }
  }
  function updateConnectionLabel() {
    if (!role) return;
    const connected = networkConnected && (role === 'host' ? guestConnected : true);
    $('connectionDot').classList.toggle('connected', connected);
    $('connectionText').textContent = !networkConnected ? 'Reconnecting…' : role === 'host' ? (connected ? '2 people in room' : 'Waiting for partner') : 'Connected to room';
    $('startBtn').disabled = role !== 'host' || !networkConnected || !guestConnected || busy;
  }
  function render() {
    show('homeView', !role); show('sessionView', Boolean(role)); if (!role) return;
    $('roomChip').textContent = code; $('roomCodeDisplay').textContent = code;
    show('lobbyView', phase === 'lobby'); show('writingView', phase === 'writing'); show('revealView', phase === 'reveal');
    show('hostControls', role === 'host'); show('guestWaiting', role === 'guest');
    show('endEarlyArea', role === 'host'); show('newRoundBtn', role === 'host');
    $('lobbyDescription').textContent = role === 'host'
      ? 'Share the code. When your partner joins, you can start the timer together.'
      : 'You’re in the waiting room! The host will start when you’re both ready.';
    $('guestWaiting').textContent = 'You’re connected! Wait here for the host to start the timer.';
    updateConnectionLabel();
    if (phase === 'writing') { updateTimer(); renderOwnIdeas(); }
    if (phase === 'reveal') renderBoard();
  }
  function renderOwnIdeas() {
    const list = $('myIdeaList'); list.replaceChildren();
    $('ownCount').textContent = `${ownIdeas.length} ${ownIdeas.length === 1 ? 'note' : 'notes'}`;
    show('myIdeasEmpty', ownIdeas.length === 0);
    ownIdeas.forEach((item,i) => {
      const li = document.createElement('li');
      const number = document.createElement('span'); number.className = 'num-small'; number.textContent = String(i+1).padStart(2,'0');
      const content = document.createElement('span'); content.style.whiteSpace = 'pre-wrap'; content.textContent = item.text;
      li.append(number, content); list.appendChild(li);
    });
  }
  function renderBoard() {
    const board = $('board'); board.replaceChildren();
    $('totalCount').textContent = `${ideas.length} ${ideas.length === 1 ? 'idea' : 'ideas'}`;
    if (!ideas.length) {
      const empty = document.createElement('div'); empty.className = 'board-empty';
      empty.textContent = 'No ideas yet. If someone just joined, notes may still be syncing.';
      board.appendChild(empty); return;
    }
    ideas.forEach((item,i) => {
      const card = document.createElement('article'); card.className = 'sticky';
      card.style.setProperty('--angle', `${[-1.4,1.1,-.8,1.4,.3][i%5]}deg`);
      const count = document.createElement('span'); count.className = 'count'; count.textContent = `IDEA ${String(i+1).padStart(2,'0')}`;
      const words = document.createElement('div'); words.className = 'words'; words.textContent = item.text;
      card.append(count,words); board.appendChild(card);
    });
  }
  function updateTimer() {
    if (phase !== 'writing') return;
    const remain = remainingMs(), seconds = Math.ceil(remain/1000);
    $('timerBig').textContent = `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
    $('timerFill').style.width = `${Math.max(0,Math.min(100,remain/(duration*60000)*100))}%`;
  }
  setInterval(() => {
    if (role && phase === 'writing') { updateTimer(); if (remainingMs() <= 0) finishRound(false); }
  }, 300);
  function updateIdeaLists() {
    ownIdeas = [...liveNotes[role] || []];
    if (phase === 'writing') renderOwnIdeas();
    if (phase === 'reveal') {
      ideas = [...liveNotes.host, ...liveNotes.guest].sort((a,b) => a.id.localeCompare(b.id));
      renderBoard();
    }
  }
  function listenNotes(which) {
    if (noteListeners.has(which)) return;
    noteListeners.add(which);
    subscribe(db.ref(roomPath(`notes/${which}`)), snapshot => {
      const raw = snapshot.val() || {};
      liveNotes[which] = Object.entries(raw).filter(([,text]) => typeof text === 'string').map(([id,text]) => ({id, text, author:which}));
      updateIdeaLists();
    });
  }
  function watchRoom() {
    subscribe(db.ref(roomPath('hostUid')), snapshot => {
      if (role && !snapshot.exists()) resetState('The host left. This room has closed.');
    });
    subscribe(db.ref(roomPath('guestUid')), snapshot => {
      if (!role) return;
      const partnerUid = snapshot.val();
      guestConnected = role === 'host' ? Boolean(partnerUid) : partnerUid === uid;
      updateConnectionLabel();
      // If Firebase reconnected after a short outage and removed your guest slot, rejoin.
      if (role === 'guest' && !guestConnected) {
        showToast('You were disconnected. Join again with the same room code.');
        resetState();
      }
    });
    subscribe(db.ref(roomPath('status')), snapshot => {
      if (!role || !snapshot.exists()) return;
      const state = snapshot.val();
      if (!PHASES.includes(state.phase)) return;
      const oldPhase = phase;
      phase = state.phase; duration = Number(state.duration) || 5; endsAt = Number(state.endsAt) || 0;
      changingPhase = false;
      if (phase === 'reveal') { listenNotes('host'); listenNotes('guest'); }
      render();
      if (oldPhase !== phase && phase === 'writing') $('ideaInput').focus();
    });
    listenNotes(role);
    if (role === 'host') listenNotes('guest');
  }
  async function createRoom() {
    if (busy || role) return;
    const op = ++operationId;
    setBusy(true);
    try {
      await ensureFirebase();
      let created = false;
      for (let attempt=0; attempt<6 && !created; attempt++) {
        code = newCode();
        const initial = {hostUid:uid, status:{phase:'lobby',duration:5,endsAt:0}};
        try {
          // Rules permit creating a code only if it does not already exist (atomic).
          await db.ref(roomPath()).set(initial);
          created = true;
        } catch (e) {
          if (String(e.code || '').includes('permission_denied')) {
            // A duplicate room is exceptionally unlikely. Any other permission
            // failure will surface after retries with a clearer setup message.
            if (attempt === 5) throw e;
          } else { throw e; }
        }
        if (op !== operationId) return;
      }
      if (!created) throw new Error('Could not reserve a unique room code');
      role = 'host'; phase='lobby'; guestConnected=false; liveNotes={host:[],guest:[]};
      await db.ref(roomPath()).onDisconnect().remove();
      attachedDisconnect = {refPath:roomPath(),sub:''};
      if (op !== operationId) return;
      watchRoom(); updateBrowserUrl(); render();
    } catch (err) {
      const message = err.message === 'setup-missing' ? 'Site owner: add Firebase settings to firebase-config.js (see README).'
        : err.message === 'firebase-not-loaded' ? 'Firebase library did not load. Check your internet connection.' : friendlyError(err);
      resetState(message);
    } finally { if (op === operationId) setBusy(false); }
  }
  async function joinRoom(input) {
    if (busy || role) return;
    const roomCode = cleanCode(input);
    if (!validCode(roomCode)) return showToast('Enter a valid six-character code.');
    const op = ++operationId; setBusy(true); code = roomCode;
    try {
      await ensureFirebase();
      const hostSnapshot = await db.ref(roomPath('hostUid')).once('value');
      if (op !== operationId) return;
      if (!hostSnapshot.exists()) throw new Error('room-not-found');
      if (hostSnapshot.val() === uid) throw new Error('same-browser');
      const memberRef = db.ref(roomPath('guestUid'));
      const taken = await memberRef.transaction(current => {
        if (current === null || current === uid) return uid;
        return undefined;
      }, undefined, false);
      if (op !== operationId) return;
      if (!taken.committed) throw new Error('room-full');
      // The guest slot is automatically freed if the guest closes their browser.
      await memberRef.onDisconnect().remove();
      attachedDisconnect = {refPath:roomPath('guestUid'),sub:'guestUid'};
      if (op !== operationId) return;
      role = 'guest'; phase='lobby'; guestConnected=true; liveNotes={host:[],guest:[]};
      watchRoom(); updateBrowserUrl('?room='+encodeURIComponent(code)); render();
    } catch (err) {
      let message = 'Could not join this room. Please retry.';
      if (err.message === 'room-not-found') message = 'No room with that code is open. Ask the host to create a room first.';
      else if (err.message === 'room-full') message = 'This room already has two people.';
      else if (err.message === 'same-browser') message = 'Open the invite in another browser or device. You cannot join your own room.';
      else if (err.message === 'setup-missing') message = 'Site owner: add Firebase settings to firebase-config.js (see README).';
      else if (err.message === 'firebase-not-loaded') message = 'Firebase library did not load. Check your internet connection.';
      else message = friendlyError(err);
      resetState(message);
    } finally { if (op === operationId) setBusy(false); }
  }
  async function startRound() {
    if (role !== 'host' || phase !== 'lobby' || !guestConnected || !networkConnected || changingPhase) return;
    changingPhase = true;
    try {
      duration = Number($('durationSelect').value) || 5;
      const started = serverNow();
      await db.ref(roomPath('status')).set({ phase:'writing',duration,endsAt:started+duration*60000 });
    } catch (e) { changingPhase = false; showToast(friendlyError(e)); }
  }
  function addIdea() {
    if (!role || phase !== 'writing' || remainingMs() <= 0) return;
    if (!networkConnected) return showToast('You are offline. Reconnect before adding notes.');
    const text = String($('ideaInput').value || '').trim().slice(0,MAX_IDEA_LENGTH);
    if (!text) { $('ideaInput').focus(); return; }
    $('ideaInput').value = ''; $('charCounter').textContent = '0/280';
    const noteRef = db.ref(roomPath(`notes/${role}`)).push();
    ownIdeas.push({id:noteRef.key,text,author:role}); renderOwnIdeas();
    $('myIdeaList').scrollTop = $('myIdeaList').scrollHeight; $('ideaInput').focus();
    noteRef.set(text).catch(e => { showToast(friendlyError(e)); $('ideaInput').value = text; });
  }
  async function finishRound(early) {
    if (!role || phase !== 'writing' || changingPhase || (!early && remainingMs() > 0)) return;
    if (early && role !== 'host') return;
    changingPhase = true;
    try {
      await db.ref(roomPath('status')).set({phase:'reveal',duration,endsAt});
    } catch (e) { changingPhase = false; if (early) showToast(friendlyError(e)); }
  }
  async function newRound() {
    if (role !== 'host' || phase !== 'reveal' || changingPhase) return;
    changingPhase = true;
    try {
      await db.ref(roomPath('notes')).remove();
      await db.ref(roomPath('status')).set({phase:'lobby',duration:5,endsAt:0});
      liveNotes={host:[],guest:[]}; ideas=[]; ownIdeas=[];
    } catch(e) { changingPhase = false; showToast(friendlyError(e)); }
  }
  async function leaveRoom() {
    if (!role) return;
    const roomToRemove = db.ref(roomPath(role==='host' ? '' : 'guestUid'));
    unlistenAll();
    resetState('You left the room.');
    try { await roomToRemove.remove(); await roomToRemove.onDisconnect().cancel(); } catch(e) { console.warn('Room cleanup:',e); }
  }
  function downloadText() {
    const content = ['BRAINWRITE — SESSION IDEAS',`Room: ${code}`,`Date: ${new Date().toLocaleString()}`,`${ideas.length} ideas`,'',...ideas.map((idea,i) => `${i+1}. ${idea.text}`)].join('\n\n');
    const url = URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));
    const a = document.createElement('a'); a.href=url; a.download=`brainwrite-${code.toLowerCase()}-ideas.txt`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url),1600);
  }
  function downloadPdf() {
    if (!window.jspdf?.jsPDF) { showToast('PDF library unavailable: Print → Save as PDF.'); window.print(); return; }
    try {
      const doc = new window.jspdf.jsPDF({unit:'mm',format:'a4'});
      const pageWidth = doc.internal.pageSize.getWidth(), margin=18, usableWidth=pageWidth-margin*2;
      let y = 20;
      const heading = () => {
        doc.setFillColor(247,245,251); doc.rect(0,0,pageWidth,37,'F');
        doc.setTextColor(60,48,138); doc.setFont('helvetica','bold'); doc.setFontSize(23); doc.text('Brainwrite',margin,22);
        doc.setTextColor(116,109,133); doc.setFontSize(9); doc.setFont('helvetica','normal');
        doc.text(`Room ${code} | ${new Date().toLocaleDateString()} | ${ideas.length} ideas`, margin,31); y=47;
      };
      heading();
      ideas.forEach((idea,i) => {
        const lines=doc.splitTextToSize(idea.text,usableWidth-18);
        const cardHeight=Math.max(22,lines.length*6+12);
        if (y+cardHeight >277) { doc.addPage(); heading(); }
        const bg=[[255,241,199],[232,225,255],[218,242,231],[255,229,230]][i%4];
        doc.setFillColor(...bg); doc.roundedRect(margin,y,usableWidth,cardHeight,3,3,'F');
        doc.setTextColor(112,103,117); doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(`#${String(i+1).padStart(2,'0')}`, margin+6,y+8);
        doc.setTextColor(43,40,58); doc.setFont('helvetica','normal'); doc.setFontSize(12); doc.text(lines,margin+6,y+16);
        y+=cardHeight+5;
      });
      if (!ideas.length) { doc.setTextColor(90); doc.text('No ideas were written in this session.',margin,y+5); }
      doc.save(`brainwrite-${code.toLowerCase()}-ideas.pdf`);
    } catch(e) { console.warn('PDF error:',e); showToast('PDF export failed: Print → Save as PDF.'); window.print(); }
  }
  const inviteLink = () => `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
  async function copyString(value, message) {
    try { await navigator.clipboard.writeText(value); showToast(message); }
    catch(_) { showToast(`Copy manually: ${value}`); }
  }
  $('createBtn').addEventListener('click', createRoom);
  $('joinForm').addEventListener('submit', event => { event.preventDefault(); joinRoom($('joinCode').value); });
  $('joinCode').addEventListener('input', () => { $('joinCode').value = cleanCode($('joinCode').value); });
  $('startBtn').addEventListener('click', startRound);
  $('addIdeaBtn').addEventListener('click', addIdea);
  $('ideaInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); addIdea(); } });
  $('ideaInput').addEventListener('input', () => { $('charCounter').textContent = `${$('ideaInput').value.length}/280`; });
  $('endEarlyBtn').addEventListener('click', () => { if (confirm('Reveal the ideas now?')) finishRound(true); });
  $('newRoundBtn').addEventListener('click', () => { if (confirm('Start a fresh round? Download the existing ideas first.')) newRound(); });
  $('leaveBtn').addEventListener('click', () => { if (confirm('Leave this room? Download your ideas first if needed.')) leaveRoom(); });
  $('copyCodeBtn').addEventListener('click', () => copyString(code,'Room code copied!'));
  $('copyLinkBtn').addEventListener('click', () => copyString(inviteLink(),'Invite link copied!'));
  $('downloadTxtBtn').addEventListener('click', downloadText);
  $('downloadPdfBtn').addEventListener('click', downloadPdf);
  $('homeLogo').addEventListener('click', event => { if (role) { event.preventDefault(); if (confirm('Leave this room?')) leaveRoom(); } });
  const setup = window.BRAINWRITE_FIREBASE_CONFIG;
  if (!setup || !setup.apiKey || setup.apiKey.includes('YOUR_') || !setup.databaseURL || setup.databaseURL.includes('YOUR_')) {
    $('setupNotice').style.display = 'block';
  }
  if (initialRoom) { $('joinCode').value = cleanCode(initialRoom); $('joinCode').focus(); }
})();
