/* FaceSort Studio — browser-only face grouping. Images/videos never leave this browser. */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const CDN = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
  const LIB_CDN = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
  const ZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  const DEFAULTS = { detector: 'fast', sampleEvery: 4, maxFrames: 300, matchThreshold: .50, reviewThreshold: .60 };
  const state = { sources: [], faces: [], groups: [], ignoredPairs: [], dismissedFaceIds: [], settings: { ...DEFAULTS }, nextPerson: 1, activeTab: 'people', activeGroup: null, search: '', showLimit: 120, reviewSuggestions: [], selectedFaces: new Set(), scanning: false, stopRequested: false, engineReady: false, accurateReady: false };
  const runtimeFiles = new Map(); // Only handles to files user selected in this browser session.
  const mediaUrls = new Map();
  let database = null;
  let saveTimer = null;
  let currentTaskPromise = null;
  let renderPending = false;
  let enginePromise = null;

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timeLabel = n => { if (n == null || !Number.isFinite(n)) return ''; const s = Math.max(0, Math.floor(n)); return `${Math.floor(s/3600)>0 ? String(Math.floor(s/3600)).padStart(2,'0')+':' : ''}${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; };
  const sourceOf = id => state.sources.find(s => s.id === id);
  const groupOf = id => state.groups.find(g => g.id === id);
  const facesOf = id => state.faces.filter(f => f.groupId === id);
  const pairKey = (a, b) => [a,b].sort().join('|');
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const asset = relative => new URL(relative, document.baseURI).href;
  const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  function toast(message, isError = false) {
    const element = document.createElement('div');
    element.className = `toast${isError ? ' error' : ''}`;
    element.textContent = message;
    $('#toastRegion').appendChild(element);
    setTimeout(() => element.remove(), 4600);
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = url;
      script.onload = () => resolve(); script.onerror = () => { script.remove(); reject(new Error(`Could not load ${url}`)); };
      document.head.appendChild(script);
    });
  }

  async function modelLoad(model, localPath) {
    try { await model.loadFromUri(asset('./models')); }
    catch (error) {
      console.info(`Local ${localPath} assets unavailable; using pinned public model mirror.`, error);
      await model.loadFromUri(CDN);
    }
  }

  async function loadEngine() {
    if (state.engineReady) return;
    if (enginePromise) return enginePromise;
    enginePromise = loadEngineOnce();
    try { return await enginePromise; } finally { enginePromise = null; }
  }
  async function loadEngineOnce() {
    const badge = $('#modelBadge'); badge.className = 'model-chip'; badge.textContent = 'Loading face engine…';
    try {
      try { await loadScript(asset('./vendor/face-api.min.js')); }
      catch { await loadScript(LIB_CDN); }
      if (!window.faceapi) throw new Error('Face recognition script did not initialize.');
      await Promise.all([
        modelLoad(faceapi.nets.tinyFaceDetector, 'tiny detector'),
        modelLoad(faceapi.nets.faceLandmark68TinyNet, 'landmarks'),
        modelLoad(faceapi.nets.faceRecognitionNet, 'recognition')
      ]);
      state.engineReady = true; badge.textContent = '● Recognition ready'; badge.className = 'model-chip ready';
    } catch (error) {
      badge.textContent = '⚠ Engine unavailable'; badge.className = 'model-chip error';
      toast(`Face engine unavailable: ${error.message}. Check internet and reload.`, true);
      throw error;
    }
  }

  async function ensureAccurateDetector() {
    if (state.accurateReady) return;
    $('#modelBadge').textContent = 'Loading detailed detector…';
    await modelLoad(faceapi.nets.ssdMobilenetv1, 'detailed detector');
    state.accurateReady = true;
    $('#modelBadge').textContent = '● Recognition ready';
  }

  async function openDB() {
    if (!('indexedDB' in window)) return null;
    return new Promise(resolve => {
      let request;
      try { request = indexedDB.open('facesort-studio-v1', 1); } catch { resolve(null); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('projects')) request.result.createObjectStore('projects'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  async function restore() {
    database = await openDB();
    if (!database) { toast('Local database unavailable. Export a backup before leaving this page.', true); return; }
    const value = await new Promise(resolve => {
      const tx = database.transaction('projects', 'readonly'); const rq = tx.objectStore('projects').get('current');
      rq.onsuccess = () => resolve(rq.result); rq.onerror = () => resolve(null);
    });
    if (value && Array.isArray(value.faces) && Array.isArray(value.sources) && Array.isArray(value.groups)) {
      for (const key of ['sources','faces','groups','ignoredPairs','dismissedFaceIds']) if (Array.isArray(value[key])) state[key] = value[key];
      if (value.settings) state.settings = sanitizeSettings(value.settings);
      state.nextPerson = Math.max(1, Number(value.nextPerson) || 1);
      toast(`Restored ${state.groups.length} people and ${state.faces.length} face examples.`);
    }
    state.sources.forEach(source => { if (source.status === 'scanning' || source.status === 'queued') source.status = 'paused'; });
    updateSettingsControls(); computeReviews(); render();
  }
  function snapshot() { return { version: 1, savedAt: new Date().toISOString(), sources: state.sources, faces: state.faces, groups: state.groups, ignoredPairs: state.ignoredPairs, dismissedFaceIds: state.dismissedFaceIds, settings: state.settings, nextPerson: state.nextPerson }; }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
  async function save() {
    if (!database) return;
    try {
      const tx = database.transaction('projects', 'readwrite'); tx.objectStore('projects').put(snapshot(), 'current');
      tx.onerror = () => toast('Browser storage is full or blocked. Export a project backup.', true);
    } catch (error) { toast(`Could not save library: ${error.message}`, true); }
  }
  function sanitizeSettings(v) {
    return { detector: v.detector === 'accurate' ? 'accurate' : 'fast', sampleEvery: [1,2,4,8,15,30].includes(Number(v.sampleEvery)) ? Number(v.sampleEvery) : 4, maxFrames: [100,300,750,1500].includes(Number(v.maxFrames)) ? Number(v.maxFrames) : 300, matchThreshold: clamp(Number(v.matchThreshold) || .5,.38,.64), reviewThreshold: .60 };
  }
  function updateSettingsControls() {
    $('#detectorMode').value = state.settings.detector; $('#sampleEvery').value = String(state.settings.sampleEvery);
    $('#maxFrames').value = String(state.settings.maxFrames); $('#matchThreshold').value = String(state.settings.matchThreshold);
    $('#matchLabel').textContent = `${state.settings.matchThreshold < .47 ? 'Very careful' : state.settings.matchThreshold > .56 ? 'Flexible' : 'Careful'} · ${state.settings.matchThreshold.toFixed(2)}`;
  }

  function distance(a, b) { let total = 0; for (let i=0;i<128;i++) { const d = a[i] - b[i]; total += d*d; } return Math.sqrt(total); }
  function prototypes(groupId, count=18) {
    const all = facesOf(groupId).filter(f => Array.isArray(f.descriptor) && f.descriptor.length === 128);
    if (all.length <= count) return all;
    // Sample across the entire group's history, rather than using only its earliest appearances.
    return Array.from({length: count}, (_, i) => all[Math.floor(i * (all.length-1)/(count-1))]);
  }
  function candidateGroups(descriptor) {
    return state.groups.map(g => {
      const examples = prototypes(g.id);
      let nearest = Infinity;
      for (const face of examples) nearest = Math.min(nearest, distance(descriptor, face.descriptor));
      return {groupId: g.id, dist: nearest};
    }).sort((a,b) => a.dist - b.dist);
  }
  function createGroup() { const number = state.nextPerson++; const group = { id: uid(), name: `Person ${String(number).padStart(2,'0')}`, createdAt: Date.now() }; state.groups.push(group); return group.id; }
  function cropFace(canvas, box) {
    const pad = Math.max(box.width,box.height)*.30;
    const side = Math.max(20, Math.max(box.width,box.height) + 2*pad);
    const cx = box.x + box.width/2, cy = box.y + box.height/2;
    const out = document.createElement('canvas'); out.width=176; out.height=176;
    const ctx = out.getContext('2d', { alpha:false }); ctx.fillStyle='#242a3c';ctx.fillRect(0,0,176,176);
    ctx.drawImage(canvas,cx-side/2,cy-side/2,side,side,0,0,176,176);
    return out.toDataURL('image/jpeg', .84);
  }
  function options() {
    return state.settings.detector === 'accurate' ? new faceapi.SsdMobilenetv1Options({minConfidence:.42}) : new faceapi.TinyFaceDetectorOptions({inputSize:608,scoreThreshold:.37});
  }
  async function detectFaces(canvas, source, timestamp) {
    const found = await faceapi.detectAllFaces(canvas, options()).withFaceLandmarks(true).withFaceDescriptors();
    let added = 0;
    for (const result of found) {
      if (state.stopRequested) break;
      const descriptor = Array.from(result.descriptor);
      const box = result.detection.box;
      if (!Number.isFinite(box.width) || box.width < 12 || box.height < 12) continue;
      const ranked = candidateGroups(descriptor);
      const first = ranked[0], second = ranked[1];
      const groupId = first && first.dist <= state.settings.matchThreshold ? first.groupId : createGroup();
      const ambiguous = Boolean(first && second && (second.dist-first.dist)<.045 && first.dist <= .58);
      const borderline = Boolean(first && first.dist >= state.settings.matchThreshold-.055 && first.dist <= state.settings.matchThreshold);
      const lowQuality = box.width < 60 || result.detection.score < .56;
      state.faces.push({ id:uid(), groupId, sourceId:source.id, timestamp, thumb:cropFace(canvas,box), descriptor, box:{x:box.x/canvas.width,y:box.y/canvas.height,width:box.width/canvas.width,height:box.height/canvas.height}, score:result.detection.score, needsReview:ambiguous||borderline||lowQuality, addedAt:Date.now() });
      added++;
    }
    return added;
  }

  function openImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); }; img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image cannot be decoded.')); }; img.src = url;
    });
  }
  function canvasFor(media, maxDimension=1920) {
    const width = media.videoWidth || media.naturalWidth || media.width;
    const height = media.videoHeight || media.naturalHeight || media.height;
    if (!width || !height) throw new Error('File has no readable image dimensions.');
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement('canvas'); canvas.width=Math.max(1,Math.round(width*scale)); canvas.height=Math.max(1,Math.round(height*scale));
    canvas.getContext('2d',{willReadFrequently:true}).drawImage(media,0,0,canvas.width,canvas.height);
    return canvas;
  }
  function fingerprint(file) { return `${file.webkitRelativePath || file.name}::${file.size}::${file.lastModified}`; }
  function isSupported(file) { return file.type.startsWith('image/') || file.type.startsWith('video/') || /\.(jpe?g|png|gif|webp|bmp|avif|mp4|webm|mov|m4v|mkv)$/i.test(file.name); }
  function isVideo(file) { return file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name); }

  async function handleFiles(fileList) {
    const selected = Array.from(fileList).filter(isSupported).sort((a,b)=>a.name.localeCompare(b.name));
    if (!selected.length) { toast('No supported photos or videos were found.', true); return; }
    const pending = [];
    for (const file of selected) {
      const key = fingerprint(file);
      let source = state.sources.find(s => s.fingerprint === key);
      if (source) { runtimeFiles.set(source.id,file); continue; }
      source={id:uid(), name:file.webkitRelativePath || file.name, fingerprint:key, type:isVideo(file)?'video':'image', size:file.size, duration:null, faces:0, scannedFrames:0, status:'queued', error:null, addedAt:Date.now()};
      state.sources.push(source); runtimeFiles.set(source.id,file); pending.push(source);
    }
    render(); saveSoon();
    if (!pending.length) { toast('Files already in your library have been reattached for preview.'); return; }
    toast(`Added ${pending.length} new file${pending.length===1?'':'s'} to the scan queue.`);
    if (state.scanning) return; // The running scan loop will also process newly queued files.
    await runQueue();
  }
  async function runQueue() {
    if (state.scanning) return;
    state.scanning=true; state.stopRequested=false;
    $('#scanProgress').hidden=false;
    try {
      await loadEngine();
      if (state.settings.detector==='accurate') await ensureAccurateDetector();
      let source;
      while (!state.stopRequested && (source=state.sources.find(s => s.status==='queued'))) {
        const file=runtimeFiles.get(source.id);
        if (!file) { source.status='error';source.error='Select this file again to scan it.';continue; }
        source.status='scanning';source.error=null;source.scannedFrames=0;
        try {
          if (source.type==='video') await scanVideo(file, source); else await scanImage(file, source);
          source.status=state.stopRequested?'paused':'done';
        } catch(error) {
          source.status=state.stopRequested?'paused':'error';source.error=error.message;
          toast(`Could not process ${source.name}: ${error.message}`,true);
        }
        saveSoon();computeReviews(); render();
      }
      if (state.stopRequested) toast('Scan stopped. Partial results were saved.');
      else toast('Scanning complete. Review suggested matches to fix any splits.');
    } catch(error) {
      toast(`Scan could not start: ${error.message}`,true);
      state.sources.filter(s=>s.status==='queued').forEach(s=>{s.status='error';s.error='Recognition engine unavailable. Retry after connecting to the internet.';});
    } finally {
      state.scanning=false; $('#scanProgress').hidden=true;saveSoon();computeReviews();render();
    }
  }
  async function scanImage(file, source) {
    progress(source.name,'Reading photo…',0,1);
    let img;
    // Browser img decoding generally applies the photo's EXIF orientation.
    try { img = await createImageBitmap(file, { imageOrientation:'from-image' }); }
    catch { img = await openImage(file); }
    try {
      if (state.stopRequested) return;
      source.faces+=await detectFaces(canvasFor(img), source, null);
      source.scannedFrames=1; progress(source.name,`${source.faces} faces detected`,1,1);
    } finally { if (img.close) img.close(); }
    await nextPaint();
  }
  async function createVideo(file) {
    const video = document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';
    video.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1';
    const url=URL.createObjectURL(file);document.body.appendChild(video);video.src=url;
    const timer=(ms,label)=>new Promise((_,reject)=>setTimeout(()=>reject(new Error(label)),ms));
    try {
      await Promise.race([new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Video format is not supported by this browser. Try MP4 H.264 or WebM.'));video.load();}),timer(18000,'Video took too long to load.')]);
      if (!Number.isFinite(video.duration)||video.duration<=0) throw new Error('Video has no seekable duration.');
      return {video,url};
    } catch (error) { video.remove();URL.revokeObjectURL(url);throw error; }
  }
  async function seekVideo(video,time) {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('Timed out seeking this video frame.')),12000);
      const onseek=()=>{ if (video.readyState>=2) finish(); else video.addEventListener('loadeddata',onseek,{once:true}); };
      const onerror=()=>finish(new Error('Could not decode the video frame.'));
      function finish(error) { clearTimeout(timer);video.removeEventListener('seeked',onseek);video.removeEventListener('error',onerror);video.removeEventListener('loadeddata',onseek);error?reject(error):resolve(); }
      video.addEventListener('seeked',onseek);video.addEventListener('error',onerror);
      try { video.currentTime=time; if (Math.abs(video.currentTime-time)<.01 && video.readyState>=2 && !video.seeking) finish(); }
      catch(error) { finish(error); }
    });
  }
  async function scanVideo(file,source) {
    progress(source.name,'Opening video…',0,1);
    const {video,url} = await createVideo(file);
    try {
      source.duration=video.duration;
      const steps=Math.min(state.settings.maxFrames, Math.max(1,Math.ceil(video.duration/state.settings.sampleEvery)));
      const interval=Math.max(state.settings.sampleEvery,video.duration/steps);
      let errors=0;
      for (let i=0;i<steps;i++) {
        if (state.stopRequested) break;
        const timestamp=Math.min(Math.max(.04, i*interval),Math.max(.04,video.duration-.08));
        try {
          await seekVideo(video,timestamp);
          if (state.stopRequested) break;
          source.faces+=await detectFaces(canvasFor(video,1440),source,timestamp);
          errors=0;
        } catch(error) { errors++;if (errors>=5) throw new Error(`Failed to decode 5 consecutive frames: ${error.message}`); }
        source.scannedFrames=i+1;
        progress(source.name,`Frame ${i+1} / ${steps} · ${timeLabel(timestamp)} · ${source.faces} faces`,i+1,steps);
        if (i%2===0) { renderSummary();await nextPaint(); }
      }
    } finally {video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);}
  }
  function progress(title, detail, done, total) { $('#scanTitle').textContent=`Scanning ${title.split('/').pop()}`;$('#scanDetail').textContent=detail;$('#progressFill').style.width=`${Math.round(done/Math.max(1,total)*100)}%`;$('#progressPercent').textContent=`${Math.round(done/Math.max(1,total)*100)}%`; }

  function computeReviews() {
    const suggestions=[];
    const groups=state.groups.filter(g => state.faces.some(f=>f.groupId===g.id));
    const reps=new Map(groups.map(g=>[g.id,prototypes(g.id,7)]));
    for(let i=0;i<groups.length;i++) for(let j=i+1;j<groups.length;j++) {
      const a=groups[i].id,b=groups[j].id,key=pairKey(a,b);
      if(state.ignoredPairs.includes(key)) continue;
      let best=Infinity;
      for(const x of reps.get(a)) for(const y of reps.get(b)) best=Math.min(best,distance(x.descriptor,y.descriptor));
      if(best <= state.settings.reviewThreshold) suggestions.push({type:'pair',id:key,a,b,distance:best});
    }
    suggestions.sort((a,b)=>a.distance-b.distance);
    const uncertain=state.faces.filter(f=>f.needsReview&&!state.dismissedFaceIds.includes(f.id)).map(f=>({type:'face',id:f.id,faceId:f.id}));
    state.reviewSuggestions=[...suggestions,...uncertain];
  }
  function renderSummary() {
    $('#personCount').textContent=state.groups.length.toLocaleString();$('#appearanceCount').textContent=state.faces.length.toLocaleString();$('#mediaCount').textContent=state.sources.length.toLocaleString();$('#reviewCount').textContent=state.reviewSuggestions.length.toLocaleString();
    $('#peopleTabCount').textContent=state.groups.length;$('#reviewTabCount').textContent=state.reviewSuggestions.length;$('#filesTabCount').textContent=state.sources.length;
    for(const setting of ['detectorMode','sampleEvery','maxFrames','matchThreshold']) $(`#${setting}`).disabled=state.scanning;
    $('#rescanButton').disabled=state.scanning || !state.faces.length;
    $('#exportButton').disabled=!state.faces.length;$('#clearButton').disabled=state.scanning || !state.sources.length;
  }
  function render() {
    if (renderPending) return;
    renderPending=true;requestAnimationFrame(()=>{
      renderPending=false;renderSummary();
      document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===state.activeTab));
      const content=$('#workspaceContent');
      if(state.activeTab==='people') content.innerHTML=renderPeople();
      else if(state.activeTab==='review') content.innerHTML=renderReviews();
      else content.innerHTML=renderSources();
    });
  }
  function empty(icon,title,description) { return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p></div>`; }
  function renderPeople() {
    if(!state.groups.length) return empty('◎','People will appear here','Upload photos or videos to automatically collect appearances of the same person into one gallery.');
    let groups=state.groups.filter(g=>g.name.toLowerCase().includes(state.search.toLowerCase()) || facesOf(g.id).some(f=>(sourceOf(f.sourceId)?.name||'').toLowerCase().includes(state.search.toLowerCase()))).sort((a,b)=>facesOf(b.id).length-facesOf(a.id).length);
    const selected=groupOf(state.activeGroup);
    const active=selected && groups.some(g=>g.id===selected.id) ? selected : groups[0];
    const faceCards=active?facesOf(active.id):[];
    const checked=faceCards.filter(f=>state.selectedFaces.has(f.id));
    const cards=faceCards.slice(0,state.showLimit).map(f=>{
      const source=sourceOf(f.sourceId);
      return `<article class="face-card${state.selectedFaces.has(f.id)?' checked':''}"><input class="face-select" type="checkbox" data-face-select="${f.id}" aria-label="Select face example" ${state.selectedFaces.has(f.id)?'checked':''}><img loading="lazy" src="${f.thumb}" data-open-face="${f.id}" alt="Face appearance in ${escapeHTML(source?.name||'file')}">${f.needsReview&&!state.dismissedFaceIds.includes(f.id)?'<span class="face-review-dot">review</span>':''}<div class="face-caption"><b title="${escapeHTML(source?.name)}">${escapeHTML(source?.name?.split('/').pop()||'Unknown source')}</b><small>${f.timestamp!=null?timeLabel(f.timestamp):'Photo'} · ${Math.round(f.score*100)}% detector</small></div></article>`;
    }).join('');
    const selectedGroupOptions=state.groups.filter(g=>g.id!==active?.id).map(g=>`<option value="${g.id}">${escapeHTML(g.name)}</option>`).join('');
    return `<div class="toolbar"><input id="peopleSearch" type="search" placeholder="Search people or source files…" value="${escapeHTML(state.search)}"><span>Click a face to open its source · select faces to move them</span></div><div class="people-layout"><aside class="people-sidebar" aria-label="People">${groups.map(g=>{const faces=facesOf(g.id);return `<button type="button" data-open-group="${g.id}" class="person-option${active?.id===g.id?' active':''}"><img src="${faces[0]?.thumb||''}" alt=""><span class="person-info"><strong>${escapeHTML(g.name)}</strong><small>${faces.length} example${faces.length===1?'':'s'}</small></span></button>`;}).join('')||'<p class="muted-text">No matching people.</p>'}</aside><div class="person-detail">${active?`<div class="person-head"><img class="person-avatar" src="${faceCards[0]?.thumb||''}" alt=""><div><h3>${escapeHTML(active.name)}</h3><p>${faceCards.length} face appearances across ${new Set(faceCards.map(f=>f.sourceId)).size} file(s)</p></div></div><div class="person-controls"><button type="button" class="button secondary small" data-rename="${active.id}">✎ Rename</button><select id="mergeTarget" aria-label="Choose person to merge into"><option value="">Merge with another…</option>${selectedGroupOptions}</select><button class="button secondary small" data-merge="${active.id}">Merge people</button></div><span class="section-caption">ALL APPEARANCES · Select an example to split it away or correct its group.</span>${checked.length?`<div class="selection-bar"><strong>${checked.length} selected</strong><button type="button" class="button small secondary" data-new-group="${active.id}">Move to new person</button><select id="moveTarget" aria-label="Choose person"><option value="">Move to existing person…</option>${selectedGroupOptions}</select><button type="button" class="button small secondary" data-move-existing="${active.id}">Move</button><button type="button" class="button subtle small" data-select-clear="1">Clear selection</button></div>`:''}<div class="face-grid">${cards}</div>${faceCards.length>state.showLimit?`<button type="button" class="button secondary small" data-show-more="1" style="margin-top:17px">Show more (${faceCards.length-state.showLimit} remaining)</button>`:''}`:empty('⌕','No match','Try another search term.')}</div></div>`;
  }
  function renderReviews() {
    if(!state.faces.length) return empty('◇','Nothing to review yet','Scan media and the review engine will look for potentially split people and uncertain face assignments.');
    const rows=state.reviewSuggestions.slice(0,80).map(s=>{
      if(s.type==='pair'){
        const a=groupOf(s.a),b=groupOf(s.b),fa=facesOf(s.a)[0],fb=facesOf(s.b)[0];
        if(!a||!b||!fa||!fb) return '';
        return `<article class="review-card"><div class="review-card-head"><div><h3>Could these be the same person?</h3><p class="muted-text">Embedding distance ${s.distance.toFixed(3)} · lower means more similar, not a probability</p></div><span class="pill">Possible split</span></div><div class="review-avatars"><div class="review-person"><img src="${fa.thumb}" alt=""><strong>${escapeHTML(a.name)} <span class="muted-text">(${facesOf(a.id).length})</span></strong></div><span class="review-middle">≈</span><div class="review-person"><img src="${fb.thumb}" alt=""><strong>${escapeHTML(b.name)} <span class="muted-text">(${facesOf(b.id).length})</span></strong></div></div><div class="review-actions"><button class="button primary small" data-review-merge="${escapeHTML(s.id)}">✓ Same person — merge</button><button class="button secondary small" data-review-reject="${escapeHTML(s.id)}">Different people — keep apart</button></div></article>`;
      }
      const f=state.faces.find(x=>x.id===s.faceId);if(!f)return '';
      const g=groupOf(f.groupId),source=sourceOf(f.sourceId);
      return `<article class="review-card"><div class="review-card-head"><div><h3>Check this face assignment</h3><p class="muted-text">${escapeHTML(source?.name||'Unknown file')} ${f.timestamp!=null?'· '+timeLabel(f.timestamp):''} · Small, low-confidence, or borderline match</p></div><span class="pill">Needs check</span></div><div class="review-avatars"><div class="review-person"><img src="${f.thumb}" alt=""><strong>This appearance</strong></div><span class="review-middle">→</span><div class="review-person"><img src="${facesOf(g?.id)[0]?.thumb||''}" alt=""><strong>${escapeHTML(g?.name||'Unknown person')}</strong></div></div><div class="review-actions"><button type="button" class="button secondary small" data-review-ok="${f.id}">Looks correct</button><button type="button" class="button secondary small" data-review-split="${f.id}">Separate into new person</button><select data-review-move-select="${f.id}" aria-label="Correct person"><option value="">Move to another person…</option>${state.groups.filter(x=>x.id!==f.groupId).map(g=>`<option value="${g.id}">${escapeHTML(g.name)}</option>`).join('')}</select><button type="button" class="button primary small" data-review-move="${f.id}">Move</button></div></article>`;
    }).join('');
    return `<div class="hint">A second pass compares person galleries and flags faces with uncertain detection or assignment. These are <strong>suggestions, not identity claims</strong>. You decide whether to merge groups, keep them separate, or move examples. Reviews are saved.</div>${state.reviewSuggestions.length?`${rows}${state.reviewSuggestions.length>80?`<p class="muted-text">Showing the first 80 of ${state.reviewSuggestions.length} suggestions. Resolve these to reveal more.</p>`:''}`:empty('✓','All caught up','No possible duplicates or questionable assignments remain under the current review rules.')}`;
  }
  function renderSources(){
    if(!state.sources.length) return empty('▤','No files added yet','Select a folder or a collection of photos and videos to begin.');
    return `<p class="muted-text" style="margin-bottom:20px">Original media is not saved in this site's database. If you reload, add the same files or folder to reattach them without rescanning. The face thumbnails and group assignments are saved locally.</p>${state.sources.map(s=>`<div class="file-row"><div class="file-thumb">${s.type==='video'?'▣':'▧'}</div><div class="file-meta"><strong title="${escapeHTML(s.name)}">${escapeHTML(s.name)}</strong><small><span class="file-status${s.status==='error'?' error':''}">${escapeHTML(s.status)}</span> · ${s.faces} faces · ${s.type==='video'?(s.duration?timeLabel(s.duration)+' · ':'')+s.scannedFrames+' frames':'photo'} · ${(s.size/1024/1024).toFixed(1)} MB${s.error?` · ${escapeHTML(s.error)}`:''}</small></div><div class="file-actions"><button class="button secondary small" data-open-source="${s.id}">Open</button>${['error','paused'].includes(s.status)?`<button class="button secondary small" data-retry-source="${s.id}">Rescan</button>`:''}<button class="button subtle small" data-remove-source="${s.id}">Remove</button></div></div>`).join('')}`;
  }

  function makeMediaUrl(sourceId) {
    if(mediaUrls.has(sourceId))return mediaUrls.get(sourceId);
    const file=runtimeFiles.get(sourceId);if(!file)return null;
    const url=URL.createObjectURL(file);mediaUrls.set(sourceId,url);return url;
  }
  function closeModal() { $('#modalHost').innerHTML='';document.body.classList.remove('modal-open'); }
  function showModal(content, wide=false) {
    $('#modalHost').innerHTML=`<div class="modal-backdrop" data-modal-backdrop="1"><div role="dialog" aria-modal="true" class="modal${wide?' wide':''}">${content}</div></div>`;
    document.body.classList.add('modal-open');
    $('[data-close-modal]')?.focus();
  }
  function openSource(sourceId, faceId) {
    const source=sourceOf(sourceId);if(!source)return;
    const face=state.faces.find(f=>f.id===faceId);
    const url=makeMediaUrl(sourceId);
    const preview=url?(source.type==='video'?`<video id="previewVideo" class="preview-media" src="${url}" controls playsinline preload="metadata"></video>`:`<img class="preview-media" src="${url}" alt="${escapeHTML(source.name)}">`):face?`<img class="preview-media" src="${face.thumb}" alt="Face thumbnail">`:'<p>Original file is not connected in this browser session.</p>';
    showModal(`<div class="modal-head"><h3>${escapeHTML(source.name.split('/').pop())}</h3><button data-close-modal="1" class="close" aria-label="Close">×</button></div>${preview}<p>${url?'Showing the local original file.':'Original file is not attached. Re-add the same file or folder to view it without rescanning.'}${face?.timestamp!=null?' · Appearance at '+timeLabel(face.timestamp):''}</p>`,true);
    if(source.type==='video'&&face?.timestamp!=null&&url){const v=$('#previewVideo');v.addEventListener('loadedmetadata',()=>{v.currentTime=Math.min(face.timestamp,v.duration-.1);},{once:true});}
  }

  function mergeGroups(targetId, fromId) {
    if(!groupOf(targetId)||!groupOf(fromId)||targetId===fromId)return;
    state.faces.forEach(f=>{if(f.groupId===fromId){f.groupId=targetId;f.needsReview=false;}});
    state.groups=state.groups.filter(g=>g.id!==fromId);
    state.ignoredPairs=state.ignoredPairs.filter(k=>!k.split('|').includes(fromId));
    state.activeGroup=targetId;state.selectedFaces.clear();computeReviews();saveSoon();render();
    toast('People merged. All face examples are together.');
  }
  function moveFaces(ids, targetId) {
    if(!groupOf(targetId))return;
    for(const face of state.faces){if(ids.includes(face.id)){face.groupId=targetId;face.needsReview=false;state.dismissedFaceIds.push(face.id);}}
    state.groups=state.groups.filter(g=>state.faces.some(f=>f.groupId===g.id));
    state.ignoredPairs=state.ignoredPairs.filter(k=>k.split('|').every(id=>!!groupOf(id)));
    state.activeGroup=targetId;state.selectedFaces.clear();computeReviews();saveSoon();render();
    toast(`Moved ${ids.length} face example${ids.length===1?'':'s'}.`);
  }
  function renameGroup(id) {
    const g=groupOf(id);if(!g)return;
    showModal(`<div class="modal-head"><h3>Rename person</h3><button class="close" data-close-modal="1">×</button></div><p>Only you assign names; FaceSort does not discover anyone's identity.</p><input id="renameInput" type="text" maxlength="100" value="${escapeHTML(g.name)}" aria-label="Person name"><button class="button primary" data-save-name="${id}">Save name</button>`);
    $('#renameInput')?.focus();$('#renameInput')?.select();
  }
  function cleanSource(id) {
    state.sources=state.sources.filter(s=>s.id!==id);
    state.faces=state.faces.filter(f=>f.sourceId!==id);
    state.groups=state.groups.filter(g=>state.faces.some(f=>f.groupId===g.id));
    state.ignoredPairs=state.ignoredPairs.filter(k=>k.split('|').every(x=>!!groupOf(x)));
    if(mediaUrls.has(id)){URL.revokeObjectURL(mediaUrls.get(id));mediaUrls.delete(id);}runtimeFiles.delete(id);
    state.selectedFaces.clear();computeReviews();saveSoon();render();
  }
  function resetLibrary() {
    for(const url of mediaUrls.values())URL.revokeObjectURL(url);
    mediaUrls.clear();runtimeFiles.clear();
    state.sources=[];state.faces=[];state.groups=[];state.ignoredPairs=[];state.dismissedFaceIds=[];state.reviewSuggestions=[];state.selectedFaces.clear();state.nextPerson=1;state.activeGroup=null;state.search='';state.showLimit=120;
    saveSoon();render();toast('Local library cleared.');
  }

  function downloadBlob(filename,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
  const makeCSV = () => {
    const rows=[['person','source_file','source_type','video_time','detector_score','face_id']];
    for(const f of state.faces){const g=groupOf(f.groupId),s=sourceOf(f.sourceId);rows.push([g?.name||'',s?.name||'',s?.type||'',f.timestamp!=null?timeLabel(f.timestamp):'',f.score.toFixed(3),f.id]);}
    return '\ufeff'+rows.map(row=>row.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  };
  async function exportFacesZip(){
    if(!window.JSZip){try{await loadScript(asset('./vendor/jszip.min.js'));}catch{await loadScript(ZIP_CDN);}}
    if(!window.JSZip)throw new Error('ZIP library unavailable');
    const zip=new JSZip();zip.file('face-index.csv',makeCSV());
    for(const [index,f] of state.faces.entries()){
      const g=groupOf(f.groupId),s=sourceOf(f.sourceId);
      const folder=(g?.name||'Unassigned').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,70);
      const filename=(s?.name?.split('/').pop()||'image').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,50);
      zip.file(`${folder}/${String(index+1).padStart(5,'0')}_${filename}_${f.timestamp==null?'photo':timeLabel(f.timestamp).replace(/:/g,'-')}.jpg`,f.thumb.split(',')[1],{base64:true});
    }
    toast('Preparing face gallery ZIP…');const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:3}});downloadBlob('facesort-face-galleries.zip',blob);
  }
  function exportMenu(){showModal(`<div class="modal-head"><h3>Export your library</h3><button class="close" data-close-modal="1">×</button></div><p><strong>Project backup</strong> includes group corrections, face thumbnails and numerical face descriptors. Treat backups as sensitive biometric data. Original photos and videos are not included.</p><button class="button secondary" data-export="json">↓ Full project backup (.json)</button><button class="button secondary" data-export="csv">↓ Person-to-file index (.csv)</button><button class="button primary" data-export="zip">↓ All face crops, grouped by person (.zip)</button>`);}

  async function importBackup(file) {
    if (!file || file.size > 150 * 1024 * 1024) { toast('Project must be a JSON backup under 150 MB.',true); return; }
    if (state.scanning) { toast('Stop the current scan before importing a backup.',true); return; }
    try {
      const project=JSON.parse(await file.text());
      if (project.version!==1 || !Array.isArray(project.faces) || !Array.isArray(project.groups) || !Array.isArray(project.sources)) throw new Error('Not a FaceSort Studio version 1 backup.');
      if (project.faces.length>100000 || project.groups.length>100000 || project.sources.length>100000) throw new Error('Backup exceeds safe library limits.');
      for(const f of project.faces){
        if(typeof f.id!=='string'||typeof f.groupId!=='string'||!Array.isArray(f.descriptor)||f.descriptor.length!==128||!f.descriptor.every(Number.isFinite)||!Number.isFinite(f.score)||(f.timestamp!=null&&!Number.isFinite(f.timestamp))||typeof f.thumb!=='string'||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(f.thumb)||f.thumb.length>1000000) throw new Error('Backup contains an invalid face record.');
      }
      for(const g of project.groups)if(typeof g.id!=='string'||typeof g.name!=='string')throw new Error('Backup contains an invalid person record.');
      for(const source of project.sources)if(typeof source.id!=='string'||typeof source.name!=='string')throw new Error('Backup contains an invalid file record.');
      if(state.sources.length&&!confirm('Replace your current local library with this backup?'))return;
      for(const url of mediaUrls.values())URL.revokeObjectURL(url);
      mediaUrls.clear();runtimeFiles.clear();
      state.faces=project.faces;state.groups=project.groups;state.sources=project.sources.map(src=>({...src,status:src.status==='done'?'done':'paused'}));
      state.ignoredPairs=Array.isArray(project.ignoredPairs)?project.ignoredPairs.filter(v=>typeof v==='string'):[];
      state.dismissedFaceIds=Array.isArray(project.dismissedFaceIds)?project.dismissedFaceIds.filter(v=>typeof v==='string'):[];
      state.settings=sanitizeSettings(project.settings||DEFAULTS);
      state.nextPerson=Math.max(1,Number(project.nextPerson)||1);state.activeGroup=null;state.selectedFaces.clear();
      updateSettingsControls();computeReviews();render();saveSoon();
      toast(`Imported ${state.faces.length} face examples. Reattach original media to preview it.`);
    } catch(error){toast(`Import failed: ${error.message}`,true);}
  }
  function bindEvents() {
    $('#addFiles').onclick=()=>$('#filesInput').click();$('#addFolder').onclick=()=>$('#folderInput').click();
    $('#filesInput').onchange=async(e)=>{const f=Array.from(e.target.files);e.target.value='';await handleFiles(f);};
    $('#folderInput').onchange=async(e)=>{const f=Array.from(e.target.files);e.target.value='';await handleFiles(f);};
    $('#cancelScan').onclick=()=>{state.stopRequested=true;$('#scanDetail').textContent='Stopping after current frame…';};
    $('#importButton').onclick=()=>$('#backupInput').click();
    $('#backupInput').onchange=async(e)=>{const file=e.target.files[0];e.target.value='';if(file)await importBackup(file);};
    $('#rescanButton').onclick=()=>{computeReviews();state.activeTab='review';render();toast('Similarity and uncertainty review updated.');};
    $('#exportButton').onclick=exportMenu;
    $('#clearButton').onclick=()=>{if(confirm('Clear all locally saved faces, people, and corrections? This cannot be undone unless you exported a backup.'))resetLibrary();};
    for(const id of ['detectorMode','sampleEvery','maxFrames','matchThreshold'])$( `#${id}` ).addEventListener('change',()=>{
      if(state.scanning){toast('Wait until the scan stops before changing its settings.');updateSettingsControls();return;}
      state.settings=sanitizeSettings({detector:$('#detectorMode').value,sampleEvery:$('#sampleEvery').value,maxFrames:$('#maxFrames').value,matchThreshold:$('#matchThreshold').value});
      updateSettingsControls();computeReviews();saveSoon();render();
    });
    $('#matchThreshold').addEventListener('input',()=>{$('#matchLabel').textContent=`${Number($('#matchThreshold').value).toFixed(2)} · ${Number($('#matchThreshold').value)<.49?'More separate groups':'More automatic matching'}`;});
    document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{state.activeTab=b.dataset.tab;state.selectedFaces.clear();state.showLimit=120;render();});
    const drop=$('#dropzone');
    drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragging');});
    drop.addEventListener('dragleave',e=>{if(!drop.contains(e.relatedTarget))drop.classList.remove('dragging');});
    drop.addEventListener('drop',async e=>{e.preventDefault();drop.classList.remove('dragging');const files=await droppedFiles(e.dataTransfer);await handleFiles(files);});
    drop.addEventListener('keydown',e=>{if(e.target===drop&&(e.key==='Enter'||e.key===' ')){e.preventDefault();$('#filesInput').click();}});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();if(e.key==='Enter'&&e.target.id==='renameInput')$('[data-save-name]')?.click();});
    document.addEventListener('input',e=>{if(e.target.id==='peopleSearch'){const start=e.target.selectionStart;state.search=e.target.value;render();requestAnimationFrame(()=>{const input=$('#peopleSearch');input?.focus();input?.setSelectionRange(start,start);});}});
    document.addEventListener('change',e=>{if(e.target.dataset.faceSelect){const id=e.target.dataset.faceSelect;if(e.target.checked)state.selectedFaces.add(id);else state.selectedFaces.delete(id);render();}});
    document.addEventListener('click',async e=>{
      if(e.target.dataset.modalBackdrop){closeModal();return;}
      const b=e.target.closest('[data-close-modal],[data-open-group],[data-open-face],[data-open-source],[data-rename],[data-save-name],[data-merge],[data-new-group],[data-move-existing],[data-select-clear],[data-show-more],[data-review-merge],[data-review-reject],[data-review-ok],[data-review-split],[data-review-move],[data-retry-source],[data-remove-source],[data-export]');
      if(!b)return;
      const d=b.dataset;
      if('closeModal' in d){closeModal();return;}
      if(d.openGroup){state.activeGroup=d.openGroup;state.selectedFaces.clear();state.showLimit=120;render();}
      else if(d.openFace){const f=state.faces.find(x=>x.id===d.openFace);if(f)openSource(f.sourceId,f.id);}
      else if(d.openSource)openSource(d.openSource);
      else if(d.rename)renameGroup(d.rename);
      else if(d.saveName){const g=groupOf(d.saveName);const name=$('#renameInput')?.value.trim();if(g&&name){g.name=name;closeModal();saveSoon();render();}}
      else if(d.merge){const from=$('#mergeTarget')?.value;if(!from){toast('Choose a person to merge with.',true);return;}if(confirm(`Merge ${groupOf(from)?.name} into ${groupOf(d.merge)?.name}?`))mergeGroups(d.merge,from);}
      else if(d.newGroup){if(state.selectedFaces.size)moveFaces([...state.selectedFaces],createGroup());}
      else if(d.moveExisting){const to=$('#moveTarget')?.value;if(!to){toast('Choose another person first.',true);return;}moveFaces([...state.selectedFaces],to);}
      else if(d.selectClear){state.selectedFaces.clear();render();}
      else if(d.showMore){state.showLimit+=120;render();}
      else if(d.reviewMerge){const [a,c]=d.reviewMerge.split('|');mergeGroups(a,c);}
      else if(d.reviewReject){state.ignoredPairs.push(d.reviewReject);computeReviews();saveSoon();render();toast('These people will stay separate.');}
      else if(d.reviewOk){state.dismissedFaceIds.push(d.reviewOk);computeReviews();saveSoon();render();}
      else if(d.reviewSplit){moveFaces([d.reviewSplit],createGroup());}
      else if(d.reviewMove){const to=document.querySelector(`[data-review-move-select="${d.reviewMove}"]`)?.value;if(!to){toast('Choose the correct person first.',true);return;}moveFaces([d.reviewMove],to);}
      else if(d.retrySource){const s=sourceOf(d.retrySource);if(!s)return;if(!runtimeFiles.has(s.id)){toast('Re-add the original file or folder before retrying.',true);return;}s.status='queued';s.faces=0;s.scannedFrames=0;state.faces=state.faces.filter(f=>f.sourceId!==s.id);state.groups=state.groups.filter(g=>state.faces.some(f=>f.groupId===g.id));computeReviews();render();runQueue();}
      else if(d.removeSource){const s=sourceOf(d.removeSource);if(s&&!state.scanning&&confirm(`Remove ${s.name} and its detected face examples?`))cleanSource(s.id);}
      else if(d.export){closeModal();try{
        if(d.export==='json')downloadBlob('facesort-project-backup.json',new Blob([JSON.stringify(snapshot())],{type:'application/json'}));
        else if(d.export==='csv')downloadBlob('facesort-face-index.csv',new Blob([makeCSV()],{type:'text/csv;charset=utf-8'}));
        else if(d.export==='zip')await exportFacesZip();
      }catch(err){toast(`Export failed: ${err.message}`,true);}}
    });
  }
  async function droppedFiles(dt) {
    const items=Array.from(dt?.items||[]);
    const entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
    if(!entries.length)return Array.from(dt.files||[]);
    const out=[];
    async function walk(entry,path=''){
      if(entry.isFile){const f=await new Promise((resolve,reject)=>entry.file(resolve,reject)); // Dragged directory entries don't set webkitRelativePath.
        try{Object.defineProperty(f,'webkitRelativePath',{configurable:true,value:path+f.name});}catch{}out.push(f);return;}
      if(entry.isDirectory){const reader=entry.createReader();let batch;do{batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));for(const child of batch)await walk(child,`${path}${entry.name}/`);}while(batch.length);}
    }
    for(const entry of entries)await walk(entry);
    return out;
  }
  async function init(){bindEvents();updateSettingsControls();await restore();loadEngine().catch(()=>{});}
  init().catch(error=>{console.error(error);toast(`Startup error: ${error.message}`,true);});
})();
