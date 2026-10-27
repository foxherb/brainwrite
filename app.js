'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_LENGTH = 280;
  const PHASES = ['lobby', 'writing', 'building', 'reveal'];
  let auth, db, ready = false, role = null, code = '', uid = '';
  let phase = 'lobby', duration = 5, endsAt = 0, buildUsed = false;
  let guestConnected = false, networkConnected = true, serverOffset = 0;
  let ownNotes = [], sharedNotes = {host: [], guest: []}, additions = {};
  let sharedNotesReady = false, additionsReady = false;
  let listeners = [], ownSubscription = null, sharedSubscriptions = {};
  let syncRetry = {}, syncAttempts = {}, attachedDisconnect = null;
  let busy = false, operationId = 0, changingPhase = false;
  let toastTimeout, drafts = new Map();
  const initialRoom = new URLSearchParams(location.search).get('room');

  const roomPath = (sub = '') => `rooms/${code}${sub ? '/' + sub : ''}`;
  const serverNow = () => Date.now() + serverOffset;
  const remainingMs = () => Math.max(0, endsAt - serverNow());
  const allSynced = () => sharedNotesReady && additionsReady;
  const partnerRole = () => role === 'host' ? 'guest' : 'host';
  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, v => CODE_CHARS[v % CODE_CHARS.length]).join('');
  }
  const cleanCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const validCode = value => value.length === 6 && [...value].every(c => CODE_CHARS.includes(c));
  function show(id, yes) { $(id).classList.toggle('hidden', !yes); }
  function toast(message) {
    clearTimeout(toastTimeout); $('toast').textContent = message;
    $('toast').classList.add('show');
    toastTimeout = setTimeout(() => $('toast').classList.remove('show'), 6500);
  }
  function friendlyError(err) {
    console.warn('Brainwrite Firebase error:', err);
    const msg = String(err?.code || err?.message || '');
    if (msg.includes('auth/operation-not-allowed')) return 'Enable Anonymous sign-in in Firebase Authentication.';
    if (/permission.denied/i.test(msg)) return 'Firebase access denied. Publish the NEW database.rules.json file in Realtime Database → Rules.';
    if (msg.includes('auth/unauthorized-domain')) return 'Add your GitHub Pages domain to Firebase Authentication → Authorized domains.';
    if (msg.includes('auth/invalid-api-key')) return 'Check your Firebase settings in firebase-config.js.';
    if (msg.includes('NETWORK_ERROR') || msg.includes('network-request-failed')) return 'Network error. Please reconnect.';
    return 'Could not connect. Check your Firebase setup and try again.';
  }
  function setBusy(value) {
    busy = value;
    $('createBtn').disabled = value; $('joinBtn').disabled = value;
    $('createBtn').textContent = value ? 'Creating…' : 'Create a room →';
    $('joinBtn').textContent = value ? 'Connecting…' : 'Join room →';
  }
  function subscribe(ref, handler) {
    ref.on('value', handler, error => toast(friendlyError(error)));
    listeners.push({ref, handler});
  }
  function disconnectOwnNotes() {
    if (!ownSubscription) return;
    ownSubscription.ref.off('value', ownSubscription.handler);
    ownSubscription = null;
  }
  function stopShared() {
    for (const name of Object.keys(sharedSubscriptions)) {
      const sub = sharedSubscriptions[name];
      sub.ref.off('value', sub.handler);
    }
    sharedSubscriptions = {};
    for (const timer of Object.values(syncRetry)) clearTimeout(timer);
    syncRetry = {}; syncAttempts = {};
    sharedNotesReady = false; additionsReady = false;
  }
  function unlistenAll() {
    listeners.forEach(({ref, handler}) => ref.off('value', handler));
    listeners = [];
    disconnectOwnNotes(); stopShared();
  }
  function updateUrl(suffix = '') {
    if (location.protocol.startsWith('http')) {
      try { history.replaceState({}, '', location.pathname + suffix); } catch (_) {}
    }
  }
  function resetState(message = '') {
    operationId++; unlistenAll();
    role = null; code = ''; phase = 'lobby'; duration = 5; endsAt = 0; buildUsed = false;
    guestConnected = false; ownNotes = []; sharedNotes = {host: [], guest: []}; additions = {};
    attachedDisconnect = null; drafts.clear(); changingPhase = false; setBusy(false);
    show('homeView', true); show('sessionView', false); updateUrl();
    if (message) toast(message);
  }
  async function ensureFirebase() {
    if (ready) return;
    const cfg = window.BRAINWRITE_FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || cfg.apiKey.includes('YOUR_') || !cfg.authDomain || !cfg.databaseURL || !cfg.projectId || !cfg.appId) throw new Error('setup-missing');
    if (typeof firebase === 'undefined') throw new Error('firebase-not-loaded');
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    auth = firebase.auth(); db = firebase.database();
    const existing = await new Promise((resolve, reject) => {
      const unsubscribe = auth.onAuthStateChanged(u => { unsubscribe(); resolve(u); }, reject);
    });
    uid = (existing || (await auth.signInAnonymously()).user).uid;
    db.ref('.info/serverTimeOffset').on('value', s => { serverOffset = Number(s.val()) || 0; });
    db.ref('.info/connected').on('value', s => {
      networkConnected = s.val() === true;
      updateConnection();
      if (networkConnected && role && attachedDisconnect && attachedDisconnect.path === roomPath(attachedDisconnect.sub)) {
        const sameRole = role;
        db.ref(attachedDisconnect.path).onDisconnect().remove().catch(e => { if (role === sameRole) toast(friendlyError(e)); });
        if (phase === 'reveal' || phase === 'building') startShared();
      }
    });
    ready = true;
  }
  function updateConnection() {
    if (!role) return;
    const ok = networkConnected && (role === 'host' ? guestConnected : true);
    $('connectionDot').classList.toggle('connected', ok);
    $('connectionText').textContent = !networkConnected ? 'Reconnecting…' : role === 'host' ? (guestConnected ? '2 people in room' : 'Waiting for partner') : 'Connected to room';
    $('startBtn').disabled = role !== 'host' || !ok || busy || changingPhase;
    updateBuildButton();
  }
  function updateBuildButton() {
    const allowed = role === 'host' && phase === 'reveal' && !buildUsed && guestConnected && networkConnected && allSynced() && getAllNotes().length > 0;
    $('buildStartBtn').disabled = !allowed || changingPhase;
  }
  function render() {
    show('homeView', !role); show('sessionView', !!role);
    if (!role) return;
    $('roomChip').textContent = code; $('roomCodeDisplay').textContent = code;
    for (const item of PHASES) show(item === 'lobby' ? 'lobbyView' : item === 'writing' ? 'writingView' : item === 'building' ? 'buildingView' : 'revealView', phase === item);
    show('hostControls', role === 'host'); show('guestWaiting', role === 'guest');
    show('endEarlyArea', role === 'host'); show('endBuildArea', role === 'host');
    show('newRoundBtn', role === 'host');
    show('buildStartControls', role === 'host' && phase === 'reveal' && !buildUsed);
    show('buildCompletedLabel', phase === 'reveal' && buildUsed);
    $('lobbyDescription').textContent = role === 'host'
      ? 'Share the code. When your partner joins, you can start the timer together.'
      : 'You’re in the waiting room! The host will start when you’re both ready.';
    updateConnection();
    if (phase === 'writing') { updateTimer(); renderOwnNotes(); }
    if (phase === 'building') { updateTimer(); renderBuildBoard(); }
    if (phase === 'reveal') renderBoard();
    updateSyncStatus();
  }
  function updateSyncStatus() {
    const syncing = (phase === 'reveal' || phase === 'building') && !allSynced();
    show('revealSync', phase === 'reveal' && syncing);
    show('buildSync', phase === 'building' && syncing);
    $('downloadPdfBtn').disabled = !allSynced();
    $('downloadTxtBtn').disabled = !allSynced();
    $('retrySyncBtn').disabled = !networkConnected;
    updateBuildButton();
  }
  function renderOwnNotes() {
    const list = $('myIdeaList'); list.replaceChildren();
    $('ownCount').textContent = `${ownNotes.length} ${ownNotes.length === 1 ? 'note' : 'notes'}`;
    show('myIdeasEmpty', ownNotes.length === 0);
    ownNotes.forEach((note, i) => {
      const li = document.createElement('li');
      const number = document.createElement('span'); number.className = 'num-small'; number.textContent = String(i+1).padStart(2,'0');
      const content = document.createElement('span'); content.style.whiteSpace = 'pre-wrap'; content.textContent = note.text;
      li.append(number, content); list.appendChild(li);
    });
  }
  function parseNotes(raw) {
    return ['host','guest'].reduce((obj, who) => {
      obj[who] = Object.entries(raw?.[who] || {}).filter(([,text]) => typeof text === 'string')
        .map(([id, text]) => ({id, text, author: who}));
      return obj;
    }, {});
  }
  function parseAdditions(raw) {
    const result = {};
    for (const [origin, byNote] of Object.entries(raw || {})) {
      for (const [noteId, byWriter] of Object.entries(byNote || {})) {
        const key = `${origin}/${noteId}`;
        result[key] ||= [];
        for (const [writer, items] of Object.entries(byWriter || {})) {
          for (const [id, text] of Object.entries(items || {})) {
            if (typeof text === 'string') result[key].push({id, text, author: writer});
          }
        }
        result[key].sort((a,b) => a.id.localeCompare(b.id));
      }
    }
    return result;
  }
  function getAllNotes() { return [...sharedNotes.host, ...sharedNotes.guest].sort((a,b) => a.id.localeCompare(b.id)); }
  function extensionsFor(note) { return additions[`${note.author}/${note.id}`] || []; }
  function listenOwn() {
    if (!role || ownSubscription) return;
    const ref = db.ref(roomPath(`notes/${role}`));
    const handler = snapshot => {
      const raw = snapshot.val() || {};
      ownNotes = Object.entries(raw).filter(([,text]) => typeof text === 'string')
        .map(([id,text]) => ({id, text, author:role}));
      if (phase === 'writing') renderOwnNotes();
    };
    ref.on('value', handler, e => { disconnectOwnNotes(); toast(friendlyError(e)); });
    ownSubscription = {ref, handler};
  }
  function startShared() {
    if (!role || !['building','reveal'].includes(phase) || !networkConnected) return;
    attachShared('notes'); attachShared('additions');
  }
  function attachShared(name) {
    if (sharedSubscriptions[name] || syncRetry[name] || !role || !['reveal','building'].includes(phase)) return;
    const currentCode = code, currentOp = operationId;
    const ref = db.ref(roomPath(name));
    const handler = snapshot => {
      if (role === null || currentCode !== code || currentOp !== operationId) return;
      if (name === 'notes') {
        sharedNotes = parseNotes(snapshot.val()); sharedNotesReady = true;
      } else {
        additions = parseAdditions(snapshot.val()); additionsReady = true;
      }
      syncAttempts[name] = 0;
      updateSyncStatus();
      if (phase === 'reveal') renderBoard();
      if (phase === 'building') renderBuildBoard();
    };
    sharedSubscriptions[name] = {ref, handler};
    ref.on('value', handler, error => {
      ref.off('value', handler);
      delete sharedSubscriptions[name];
      if (currentCode !== code || currentOp !== operationId) return;
      if (name === 'notes') sharedNotesReady = false; else additionsReady = false;
      updateSyncStatus();
      console.warn(`Shared ${name} sync failed; retrying`, error);
      const attempts = (syncAttempts[name] || 0) + 1;
      syncAttempts[name] = attempts;
      syncRetry[name] = setTimeout(() => {
        delete syncRetry[name];
        if (currentCode === code && currentOp === operationId) attachShared(name);
      }, Math.min(8000, 500 * Math.pow(2, Math.min(attempts, 4))));
    });
  }
  function retryShared() {
    stopShared();
    if (phase === 'reveal' || phase === 'building') {
      updateSyncStatus(); startShared();
    }
  }
  function renderBoard() {
    const board = $('board'); board.replaceChildren();
    updateSyncStatus();
    if (!allSynced()) {
      $('totalCount').textContent = 'Syncing ideas…';
      const empty = document.createElement('div'); empty.className = 'board-empty';
      empty.textContent = 'Collecting everyone’s notes. Please keep this tab open.';
      board.appendChild(empty); return;
    }
    const notes = getAllNotes();
    const countAdditions = notes.reduce((n, item) => n + extensionsFor(item).length, 0);
    $('totalCount').textContent = `${notes.length} ${notes.length === 1 ? 'idea' : 'ideas'} · ${countAdditions} additions`;
    if (!notes.length) {
      const empty = document.createElement('div'); empty.className = 'board-empty';
      empty.textContent = 'No ideas written this round.';
      board.appendChild(empty); return;
    }
    notes.forEach((item, i) => {
      const card = document.createElement('article'); card.className = 'sticky';
      card.style.setProperty('--angle', `${[-1.4,1.1,-.8,1.4,.3][i%5]}deg`);
      const count = document.createElement('span'); count.className = 'count';
      count.textContent = `IDEA ${String(i+1).padStart(2,'0')} · ${item.author === role ? 'YOUR IDEA' : 'PARTNER’S IDEA'}`;
      const words = document.createElement('div'); words.className = 'words'; words.textContent = item.text;
      card.append(count, words);
      const more = extensionsFor(item);
      if (more.length) {
        const wrap = document.createElement('div'); wrap.className = 'additions-stack';
        for (const add of more) {
          const line = document.createElement('div'); line.className = 'addition-line';
          const label = document.createElement('small'); label.textContent = `${add.author === role ? 'Your' : 'Partner’s'} addition`;
          const value = document.createElement('div'); value.textContent = add.text; value.style.whiteSpace = 'pre-wrap';
          line.append(label,value); wrap.appendChild(line);
        }
        card.appendChild(wrap);
      }
      board.appendChild(card);
    });
  }
  function renderBuildBoard() {
    const target = $('buildBoard');
    const previousActive = document.activeElement?.dataset?.ideaKey;
    target.replaceChildren();
    updateSyncStatus();
    if (!allSynced()) {
      const empty = document.createElement('div'); empty.className='board-empty';
      empty.textContent = 'Waiting for your partner’s original ideas to sync…';
      target.appendChild(empty); return;
    }
    const partnerNotes = sharedNotes[partnerRole()];
    $('buildNoteCount').textContent = `${partnerNotes.length} ${partnerNotes.length === 1 ? 'idea' : 'ideas'} to build on`;
    if (!partnerNotes.length) {
      const empty = document.createElement('div'); empty.className = 'board-empty';
      empty.textContent = 'Your partner did not submit any ideas in the first round.';
      target.appendChild(empty); return;
    }
    partnerNotes.forEach((item, i) => {
      const key = `${item.author}/${item.id}`;
      const card = document.createElement('article'); card.className='build-card';
      const label = document.createElement('div'); label.className='eyebrow'; label.textContent=`PARTNER’S IDEA ${i+1}`;
      const words = document.createElement('div'); words.className='build-original'; words.textContent=item.text;
      const list = document.createElement('div'); list.className='build-added-list';
      const own = extensionsFor(item).filter(add => add.author === role);
      own.forEach((add) => {
        const p = document.createElement('p'); p.textContent = `✓ ${add.text}`; list.appendChild(p);
      });
      const input = document.createElement('textarea'); input.className='field build-input';
      input.placeholder='Build on this idea…'; input.maxLength=MAX_LENGTH; input.rows=2;
      input.dataset.ideaKey = key; input.value = drafts.get(key) || '';
      input.disabled = remainingMs() <= 0 || !networkConnected;
      input.addEventListener('input', () => drafts.set(key, input.value));
      const btn = document.createElement('button'); btn.className='btn btn-soft'; btn.textContent='+ Add to this idea';
      btn.disabled = remainingMs() <= 0 || !networkConnected;
      btn.addEventListener('click', () => addExtension(item, input));
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addExtension(item, input); }
      });
      const hint = document.createElement('small'); hint.className='build-hint'; hint.textContent='Enter to add · Shift + Enter for new line';
      card.append(label,words,list,input,btn,hint);
      target.appendChild(card);
    });
    if (previousActive) target.querySelectorAll('.build-input').forEach(inp => {
      if (inp.dataset.ideaKey === previousActive) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    });
  }
  function updateTimer() {
    if (phase !== 'writing' && phase !== 'building') return;
    const remain = remainingMs(), sec = Math.ceil(remain / 1000);
    const formatted = `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
    const percent = `${Math.max(0,Math.min(100,remain/(duration*60000)*100))}%`;
    if (phase === 'writing') {
      $('timerBig').textContent = formatted; $('timerFill').style.width = percent;
    } else {
      $('buildTimerBig').textContent = formatted; $('buildTimerFill').style.width = percent;
      if (remain <= 0) {
        $('buildBoard').querySelectorAll('button,textarea').forEach(control => control.disabled = true);
      }
    }
  }
  setInterval(() => {
    if (!role || !['writing','building'].includes(phase)) return;
    updateTimer();
    if (remainingMs() <= 0) finishPhase(false);
  }, 300);

  function watchRoom() {
    subscribe(db.ref(roomPath('hostUid')), snapshot => {
      if (role && !snapshot.exists()) resetState('The host left. This room has closed.');
    });
    subscribe(db.ref(roomPath('guestUid')), snapshot => {
      if (!role) return;
      const member = snapshot.val();
      guestConnected = role === 'host' ? Boolean(member) : member === uid;
      updateConnection();
      if (role === 'guest' && !guestConnected) resetState('You were disconnected. Join the room again with its code.');
    });
    subscribe(db.ref(roomPath('status')), snapshot => {
      if (!role || !snapshot.exists()) return;
      const next = snapshot.val();
      if (!PHASES.includes(next.phase)) return;
      const oldPhase = phase;
      phase = next.phase; duration = Number(next.duration) || 5;
      endsAt = Number(next.endsAt) || 0; buildUsed = Boolean(next.buildUsed);
      changingPhase = false;
      if (oldPhase !== phase) {
        if (phase === 'writing') {
          stopShared(); sharedNotes={host:[],guest:[]}; additions={}; ownNotes=[]; drafts.clear();
          listenOwn();
        } else if (phase === 'lobby') {
          disconnectOwnNotes(); stopShared();
          sharedNotes={host:[],guest:[]}; additions={}; ownNotes=[]; drafts.clear();
        } else {
          disconnectOwnNotes();
          if (oldPhase === 'writing') {
            // Never attach shared notes during the private writing phase.
            sharedNotesReady=false; additionsReady=false;
          }
          startShared();
        }
      }
      render();
      if (oldPhase !== phase && phase === 'writing') $('ideaInput').focus();
    });
    if (phase === 'writing') listenOwn();
  }

  async function createRoom() {
    if (busy || role) return;
    const op = ++operationId; setBusy(true);
    try {
      await ensureFirebase();
      let created = false;
      for (let attempt=0; attempt<6 && !created; attempt++) {
        code = newCode();
        const initial = {hostUid:uid, status:{phase:'lobby',duration:5,endsAt:0,buildUsed:false}};
        try { await db.ref(roomPath()).set(initial); created = true; }
        catch (e) { if (!String(e.code || '').includes('permission_denied') || attempt === 5) throw e; }
        if (op !== operationId) return;
      }
      if (!created) throw new Error('Room could not be created');
      role='host'; phase='lobby'; guestConnected=false;
      await db.ref(roomPath()).onDisconnect().remove();
      attachedDisconnect={path:roomPath(),sub:''};
      if (op !== operationId) return;
      watchRoom(); updateUrl(); render();
    } catch(err) {
      const msg=err.message==='setup-missing'?'Site owner: configure firebase-config.js first.':err.message==='firebase-not-loaded'?'Firebase scripts failed to load.':friendlyError(err);
      resetState(msg);
    } finally { if (op === operationId) setBusy(false); }
  }
  async function joinRoom(input) {
    if (busy || role) return;
    const roomCode=cleanCode(input);
    if (!validCode(roomCode)) return toast('Enter a valid six-character code.');
    const op=++operationId; setBusy(true); code=roomCode;
    try {
      await ensureFirebase();
      const owner=await db.ref(roomPath('hostUid')).once('value');
      if (op !== operationId) return;
      if (!owner.exists()) throw new Error('room-not-found');
      if (owner.val() === uid) throw new Error('same-browser');
      const member=db.ref(roomPath('guestUid'));
      const res=await member.transaction(current => (current===null || current===uid) ? uid : undefined,undefined,false);
      if (op !== operationId) return;
      if (!res.committed) throw new Error('room-full');
      await member.onDisconnect().remove();
      attachedDisconnect={path:roomPath('guestUid'),sub:'guestUid'};
      if (op !== operationId) return;
      role='guest'; phase='lobby'; guestConnected=true;
      watchRoom(); updateUrl(`?room=${encodeURIComponent(code)}`); render();
    } catch(err) {
      let msg = 'Could not join. Please try again.';
      if (err.message==='room-not-found') msg='No room with that code is open. Ask the host to create it first.';
      else if (err.message==='room-full') msg='This room already has two people.';
      else if (err.message==='same-browser') msg='You cannot join your own room using the same browser. Try another browser/device.';
      else if (err.message==='setup-missing') msg='Site owner: configure firebase-config.js first.';
      else msg=friendlyError(err);
      resetState(msg);
    } finally { if (op === operationId) setBusy(false); }
  }
  async function startRound() {
    if (role!=='host' || phase!=='lobby' || !guestConnected || !networkConnected || changingPhase) return;
    changingPhase=true; updateConnection();
    try {
      duration=Number($('durationSelect').value)||5;
      await db.ref(roomPath('status')).set({phase:'writing',duration,endsAt:serverNow()+duration*60000,buildUsed:false});
    } catch(e) { changingPhase=false; updateConnection(); toast(friendlyError(e)); }
  }
  function addIdea() {
    if (!role || phase!=='writing' || remainingMs()<=0) return;
    if (!networkConnected) return toast('You are offline. Reconnect before submitting.');
    const text=String($('ideaInput').value||'').trim().slice(0,MAX_LENGTH);
    if (!text) return $('ideaInput').focus();
    $('ideaInput').value=''; $('charCounter').textContent='0/280';
    const ref=db.ref(roomPath(`notes/${role}`)).push();
    ownNotes.push({id:ref.key,text,author:role}); renderOwnNotes();
    $('myIdeaList').scrollTop=$('myIdeaList').scrollHeight; $('ideaInput').focus();
    ref.set(text).catch(e => { toast(friendlyError(e)); $('ideaInput').value=text; });
  }
  async function startBuild() {
    if (role!=='host' || phase!=='reveal' || buildUsed || !guestConnected || !networkConnected || !allSynced() || !getAllNotes().length || changingPhase) return;
    changingPhase=true; updateBuildButton();
    try {
      const buildDuration=Number($('buildDurationSelect').value)||3;
      await db.ref(roomPath('status')).set({phase:'building',duration:buildDuration,endsAt:serverNow()+buildDuration*60000,buildUsed:true});
    } catch(e) { changingPhase=false; updateBuildButton(); toast(friendlyError(e)); }
  }
  function addExtension(note, input) {
    if (!role || phase!=='building' || remainingMs()<=0 || !allSynced() || note.author===role) return;
    if (!networkConnected) return toast('You are offline. Reconnect to add to an idea.');
    const text=String(input.value||'').trim().slice(0,MAX_LENGTH);
    if (!text) return input.focus();
    const key=`${note.author}/${note.id}`;
    input.value=''; drafts.delete(key);
    const ref=db.ref(roomPath(`additions/${note.author}/${note.id}/${role}`)).push();
    additions[key] ||= [];
    additions[key].push({id:ref.key,text,author:role});
    additions[key].sort((a,b)=>a.id.localeCompare(b.id));
    renderBuildBoard();
    ref.set(text).catch(e => { toast(friendlyError(e)); drafts.set(key,text); });
  }
  async function finishPhase(early) {
    if (!role || !['writing','building'].includes(phase) || changingPhase || (!early && remainingMs()>0)) return;
    if (early && role!=='host') return;
    changingPhase=true;
    try { await db.ref(roomPath('status')).set({phase:'reveal',duration,endsAt,buildUsed}); }
    catch(e) { changingPhase=false; if (early) toast(friendlyError(e)); }
  }
  async function newRound() {
    if (role!=='host' || phase!=='reveal' || changingPhase) return;
    changingPhase=true;
    try {
      await db.ref(roomPath('notes')).remove();
      await db.ref(roomPath('additions')).remove();
      await db.ref(roomPath('status')).set({phase:'lobby',duration:5,endsAt:0,buildUsed:false});
    } catch(e) { changingPhase=false; toast(friendlyError(e)); }
  }
  async function leaveRoom() {
    if (!role) return;
    const ref=db.ref(roomPath(role==='host'?'':'guestUid'));
    resetState('You left the room.');
    try { await ref.remove(); await ref.onDisconnect().cancel(); }
    catch(e) { console.warn('Room cleanup:',e); }
  }
  function exportText() {
    if (!allSynced()) return toast('Please wait for both sets of notes to sync.');
    const parts=['BRAINWRITE — SESSION IDEAS',`Room: ${code}`,`Date: ${new Date().toLocaleString()}`,''];
    getAllNotes().forEach((idea,i)=>{
      parts.push(`${i+1}. ${idea.text}`);
      extensionsFor(idea).forEach(add => parts.push(`    ↳ ${add.text}`));
      parts.push('');
    });
    const url=URL.createObjectURL(new Blob([parts.join('\n')],{type:'text/plain;charset=utf-8'}));
    const a=document.createElement('a'); a.href=url; a.download=`brainwrite-${code.toLowerCase()}-ideas.txt`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1600);
  }
  function exportPdf() {
    if (!allSynced()) return toast('Please wait for all notes to sync.');
    if (!window.jspdf?.jsPDF) { toast('PDF library unavailable. Choose Print → Save as PDF.'); window.print(); return; }
    try {
      const doc=new window.jspdf.jsPDF({unit:'mm',format:'a4'});
      const width=doc.internal.pageSize.getWidth(), margin=18, usable=width-2*margin;
      let y=0, page=0;
      function heading() {
        page++; doc.setFillColor(247,245,251); doc.rect(0,0,width,37,'F');
        doc.setTextColor(60,48,138); doc.setFont('helvetica','bold'); doc.setFontSize(23); doc.text('Brainwrite',margin,22);
        doc.setTextColor(116,109,133); doc.setFont('helvetica','normal'); doc.setFontSize(9);
        doc.text(`${new Date().toLocaleDateString()} | ${getAllNotes().length} ideas | Page ${page}`,margin,31);
        y=45;
      }
      function block(label,text,fill,isAddition=false) {
        const lines=doc.splitTextToSize(text,usable-18);
        const bg=fill;
        let cursor=0;
        while (cursor<lines.length || (lines.length===0 && cursor===0)) {
          let available=Math.floor((274-y-21)/5.7);
          if (available<1) { doc.addPage(); heading(); available=Math.floor((274-y-21)/5.7); }
          const chunk=lines.slice(cursor,cursor+Math.max(1,available));
          cursor+=chunk.length;
          const height=Math.max(23,chunk.length*5.7+17);
          doc.setFillColor(...bg); doc.roundedRect(margin+(isAddition?5:0),y,usable-(isAddition?5:0),height,3,3,'F');
          doc.setTextColor(108,96,126); doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(label,margin+7,y+8);
          doc.setTextColor(45,40,57); doc.setFont('helvetica','normal'); doc.setFontSize(11);
          doc.text(chunk,margin+7,y+15); y+=height+4;
          if (cursor<lines.length) { doc.addPage(); heading(); }
        }
      }
      heading();
      const bg=[[255,241,199],[232,225,255],[218,242,231],[255,229,230]];
      getAllNotes().forEach((idea,i)=>{
        block(`IDEA ${String(i+1).padStart(2,'0')}`,idea.text,bg[i%4]);
        extensionsFor(idea).forEach((ext,j)=>block(`ADDITION ${j+1}`,ext.text,[244,242,248],true));
        y+=2;
      });
      if (!getAllNotes().length) { doc.setTextColor(100); doc.text('No ideas were written this session.',margin,y+6); }
      doc.save(`brainwrite-${code.toLowerCase()}-ideas.pdf`);
    } catch(e) { console.warn('PDF export failed',e); toast('PDF export failed. Try Print → Save as PDF.'); window.print(); }
  }
  const invite=()=>`${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
  async function copyString(str,msg) {
    try { await navigator.clipboard.writeText(str); toast(msg); }
    catch(_) { toast(`Copy manually: ${str}`); }
  }
  $('createBtn').addEventListener('click',createRoom);
  $('joinForm').addEventListener('submit',e=>{e.preventDefault();joinRoom($('joinCode').value);});
  $('joinCode').addEventListener('input',()=>{$('joinCode').value=cleanCode($('joinCode').value);});
  $('startBtn').addEventListener('click',startRound);
  $('addIdeaBtn').addEventListener('click',addIdea);
  $('ideaInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();addIdea();}});
  $('ideaInput').addEventListener('input',()=>{$('charCounter').textContent=`${$('ideaInput').value.length}/280`;});
  $('endEarlyBtn').addEventListener('click',()=>{if(confirm('Reveal the ideas now?'))finishPhase(true);});
  $('endBuildBtn').addEventListener('click',()=>{if(confirm('Finish building on ideas and show the results?'))finishPhase(true);});
  $('buildStartBtn').addEventListener('click',startBuild);
  $('retrySyncBtn').addEventListener('click',retryShared);
  $('buildRetryBtn').addEventListener('click',retryShared);
  $('newRoundBtn').addEventListener('click',()=>{if(confirm('Start a fresh round? Download the existing ideas first.'))newRound();});
  $('leaveBtn').addEventListener('click',()=>{if(confirm('Leave this room? Download your ideas first if needed.'))leaveRoom();});
  $('copyCodeBtn').addEventListener('click',()=>copyString(code,'Room code copied!'));
  $('copyLinkBtn').addEventListener('click',()=>copyString(invite(),'Invite link copied!'));
  $('downloadTxtBtn').addEventListener('click',exportText);
  $('downloadPdfBtn').addEventListener('click',exportPdf);
  $('homeLogo').addEventListener('click',e=>{if(role){e.preventDefault();if(confirm('Leave this room?'))leaveRoom();}});
  const setup=window.BRAINWRITE_FIREBASE_CONFIG;
  if (!setup || !setup.apiKey || setup.apiKey.includes('YOUR_') || !setup.databaseURL || setup.databaseURL.includes('YOUR_')) $('setupNotice').style.display='block';
  if (initialRoom) { $('joinCode').value=cleanCode(initialRoom); $('joinCode').focus(); }
})();
