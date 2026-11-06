import { languages, parseSrt, splitScript } from './shared.mjs';

const main = document.querySelector('#main');
const dialog = document.querySelector('#dialog');
const logout = document.querySelector('#logout');
const toast = document.querySelector('#toast');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const languageOptions = (selected = 'ko', all = false) => (all ? '<option value="">모든 언어</option>' : '') + Object.entries(languages)
  .map(([id, label]) => `<option value="${id}" ${selected === id ? 'selected' : ''}>${label}</option>`).join('');
const date = value => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
const checked = value => value ? 'checked' : '';
const button = (label, action, id = '', more = '') => `<button class="small ${more}" type="button" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const page = (code, title, desc, body) => `<header class="page-head"><p class="eyebrow">${code}</p><h1>${title}</h1><p>${desc}</p></header>${body}`;
const statusLabel = { queued: '대기', generating: '생성 중', decorating: '꾸미는 중', completed: '완료', failed: '생성 실패', decoration_error: '꾸미기 실패', uncertain: '접수 확인 필요' };
const active = job => ['queued', 'generating', 'decorating'].includes(job.status);
const pageId = () => ['script', 'create', 'history', 'message', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'script';
const draftSample = {
  title: '안약 점안 방법 안내', language: 'ko', steps: [
    { title: '점안 준비', body: '안녕하세요. 연세솔안과입니다. 안약을 넣기 전에 손을 씻고, 사용하실 안약 이름을 확인해 주세요.' },
    { title: '점안하기', body: '고개를 살짝 뒤로 젖히고 아래 눈꺼풀을 부드럽게 내립니다. 용기 끝이 눈이나 속눈썹에 닿지 않도록 주의하면서, 의료진이 안내한 방법에 따라 안약을 넣어 주세요.' }
  ]
};
let state;
let scriptFilter = '';
let scriptSearch = '';
let historyFilter = '';
let historySearch = '';
let editor;
let createChoice;
let toastTimer;
let locked = false;

async function api(path, method = 'GET', body) {
  const response = await fetch('/api' + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  if (!response.ok) throw Object.assign(new Error(json.error || '요청을 처리하지 못했습니다.'), { status: response.status });
  return json;
}

function note(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5500);
}

function modal(title, content) {
  dialog.innerHTML = `<div class="toolbar"><h2>${esc(title)}</h2>${button('닫기', 'close')}</div>${content}`;
  if (!dialog.open) dialog.showModal();
}

function navigate(id) {
  if (location.hash === '#' + id) render();
  else location.hash = id;
}

function emptyRow(columns, message) {
  return `<tr><td class="muted empty" colspan="${columns}">${message}</td></tr>`;
}

function scriptRows() {
  const rows = state.scripts.filter(item => (!scriptFilter || item.language === scriptFilter)
    && item.title.toLowerCase().includes(scriptSearch.toLowerCase()));
  return rows.map(item => `<tr><td><strong>${esc(item.title)}</strong></td><td><span class="tag">${languages[item.language]}</span></td>
    <td>${item.steps.length}단계 · ${item.steps.reduce((count, step) => count + step.body.length, 0)}자</td><td>${date(item.createdAt)}</td>
    <td><div class="actions">
      ${button('보기', 'peek', item.id)}${button('수정', 'edit', item.id)}${button('복제', 'duplicate', item.id)}
      ${button('백업', 'backup', item.id)}${button('번역', 'translate', item.id)}${button('삭제', 'deleteScript', item.id, 'danger')}
    </div></td></tr>`).join('') || emptyRow(5, '등록된 원고가 없습니다. 신규 등록으로 첫 원고를 추가해 주세요.');
}

function scriptPage() {
  return page('01 / SCRIPT LIBRARY', '스크립트 등록', '환자에게 전달할 안내 원고를 등록하고 언어별로 관리합니다.',
    `<section class="card"><div class="toolbar"><h2>저장된 스크립트 <span class="tag">${state.scripts.length}개</span></h2>
      <button class="btn primary" type="button" data-action="new">＋ 신규 등록</button></div>
      <div class="two-fields"><label>제목 검색<input type="search" id="script-search" value="${esc(scriptSearch)}" placeholder="예: 안약 점안"></label>
      <label>언어<select id="script-filter">${languageOptions(scriptFilter, true)}</select></label></div>
      <div class="table-box"><table><thead><tr><th>제목</th><th>언어</th><th>분량</th><th>등록일</th><th>작업</th></tr></thead>
      <tbody id="script-rows">${scriptRows()}</tbody></table></div></section>`);
}

function stepFields() {
  return editor.steps.map((item, index) => `<fieldset class="stack"><legend>${index + 1}단계</legend>
    <label>단계 제목<input maxlength="30" name="step-title" value="${esc(item.title)}"></label>
    <label>아바타가 읽을 문장<textarea maxlength="3500" name="step-body" required>${esc(item.body)}</textarea></label>
    ${editor.steps.length > 1 ? `<div>${button('단계 삭제', 'removeStep', index, 'danger')}</div>` : ''}</fieldset>`).join('');
}

function fillEditor(script = { title: '', language: 'ko', steps: [{ title: '', body: '' }] }) {
  editor = structuredClone(script);
  modal(editor.id ? '스크립트 수정' : '새 스크립트',
    `<form id="edit-form" class="stack">
      <div class="two-fields"><label>스크립트 제목<input name="title" maxlength="60" required value="${esc(editor.title)}"></label>
      <label>언어<select name="language">${languageOptions(editor.language)}</select></label></div>
      <details><summary>원고 붙여넣기 · SRT · 백업 가져오기</summary><div class="stack">
        <label>원고 붙여넣기<textarea id="paste" placeholder="빈 줄로 단계를 나눌 수 있습니다. 최대 4단계"></textarea></label>
        <div class="actions">${button('단계에 적용', 'paste')}${button('예시 원고 불러오기', 'sample')}${button('AI 초안', 'draft')}</div>
        <label>SRT 또는 JSON 백업 파일<input type="file" id="import" accept=".srt,.json"></label>
      </div></details>
      <div id="steps" class="stack">${stepFields()}</div>
      <div class="actions">${button('＋ 단계 추가', 'addStep')}<button class="btn primary" type="submit">스크립트 저장</button></div>
    </form>`);
}

function collectEditor() {
  const form = dialog.querySelector('#edit-form');
  if (!form) return editor;
  const data = new FormData(form);
  return { ...editor, title: data.get('title'), language: data.get('language'),
    steps: data.getAll('step-body').map((body, index) => ({ title: data.getAll('step-title')[index], body })) };
}

function decorationFields(value, logoAvailable = !!state.settings.logo) {
  return `<fieldset class="stack"><legend>자막과 로고</legend><div class="toggles">
    <label class="check"><input type="checkbox" name="captions" ${checked(value.captions)}> 대사 자막</label>
    <label class="check"><input type="checkbox" name="badge" ${checked(value.badge)}> 단계 배지</label>
    ${logoAvailable ? `<label class="check"><input type="checkbox" name="showLogo" ${checked(value.showLogo !== false)}> 병원 로고</label>` : ''}
    </div><div class="two-fields"><label>자막 크기<select name="size">${[28,36,44,52].map(size => `<option ${size === value.size ? 'selected' : ''}>${size}</option>`).join('')}</select></label>
    <label>로고 위치<select name="position"><option value="right">오른쪽 아래</option><option value="left" ${value.position === 'left' ? 'selected' : ''}>왼쪽 아래</option></select></label></div></fieldset>`;
}

function readDecor(form) {
  const data = new FormData(form);
  return { size: Number(data.get('size')), position: data.get('position'), captions: data.has('captions'), badge: data.has('badge'), showLogo: data.has('showLogo') };
}

function createPage() {
  const script = state.scripts.find(item => item.id === createChoice?.scriptId) || state.scripts[0];
  const choice = { ...state.settings, ratio: '16:9', ...createChoice };
  return page('02 / VIDEO BUILDER', '영상 만들기', '원고와 아바타를 고른 뒤 자막과 로고가 들어간 환자 안내 영상을 생성합니다.',
    `<div class="grid"><form id="create-form" class="card stack">
      <div class="toolbar"><h2>제작 설정</h2>${button('새 스크립트', 'new')}</div>
      <label>영상 제목<input name="title" maxlength="60" value="${esc(choice.title ?? script?.title)}" required></label>
      <label>스크립트<select name="scriptId" required><option value="">원고를 선택해 주세요</option>
        ${state.scripts.map(item => `<option value="${item.id}" ${item.id === script?.id ? 'selected' : ''}>${esc(item.title)} · ${languages[item.language]}</option>`).join('')}</select></label>
      <div class="two-fields"><label>아바타<select name="avatar">${state.avatars.map(avatar =>
        `<option value="${esc(avatar.id)}" ${avatar.id === choice.avatar ? 'selected' : ''} ${avatar.type === 'portrait' && !state.capabilities.portrait ? 'disabled' : ''}>${esc(avatar.name)}${avatar.type === 'portrait' ? ' · 실사' : ''}</option>`).join('')}</select></label>
        <label>로컬 음성<select name="voice" required><option value="">음성을 확인하는 중입니다</option></select></label></div>
      <div class="actions">${button('사진 아바타 관리', 'avatars')}</div>
      <label>화면비<select name="ratio"><option value="16:9">가로 16:9</option><option value="9:16" ${choice.ratio === '9:16' ? 'selected' : ''}>세로 9:16</option></select></label>
      ${decorationFields(choice)}
      <div class="notice ${state.capabilities.ffmpeg ? '' : 'warn'}">${state.capabilities.ffmpeg
        ? '음성 합성과 영상 렌더링은 이 원내 서버에서 실행됩니다. 사진 아바타는 MuseTalk 모델을 사용합니다.'
        : '영상 제작을 시작하려면 원내 PC에 FFmpeg와 원고 언어에 맞는 로컬 음성을 설치해 주세요.'}</div>
      <div><button class="btn primary" type="submit" disabled>로컬 영상 만들기</button></div>
    </form><section class="card stack"><h2>화면 구성 미리보기</h2><div id="preview"></div>
      <p class="muted">미리보기에서 화면비, 배지, 자막 위치를 확인할 수 있습니다. 실제 음성과 영상은 생성 이력에서 확인합니다.</p></section></div>`);
}

async function updateVoices(form) {
  const script = state.scripts.find(item => item.id === form.elements.scriptId.value);
  const field = form.elements.voice;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  const previous = field.value;
  field.innerHTML = '<option value="">음성을 확인하는 중입니다</option>';
  if (!script) {
    field.innerHTML = '<option value="">스크립트를 먼저 선택해 주세요</option>';
    return;
  }
  try {
    const voices = await api('/voices?language=' + encodeURIComponent(script.language));
    if (!form.isConnected || form.elements.scriptId.value !== script.id) return;
    field.innerHTML = voices.map(voice =>
      `<option value="${esc(voice.id)}" ${voice.id === previous ? 'selected' : ''}>${esc(voice.name)}</option>`).join('')
      || '<option value="">사용 가능한 로컬 음성이 없습니다</option>';
    submit.disabled = !voices.length || !state.capabilities.ffmpeg;
  } catch {
    if (form.isConnected && form.elements.scriptId.value === script.id) field.innerHTML = '<option value="">로컬 음성 목록을 읽지 못했습니다</option>';
  }
}

function updatePreview() {
  const form = main.querySelector('#create-form');
  if (!form) return;
  const data = new FormData(form);
  const decor = readDecor(form);
  const script = state.scripts.find(item => item.id === data.get('scriptId'));
  const first = script?.steps[0];
  main.querySelector('#preview').innerHTML = `<div class="preview ${data.get('ratio') === '9:16' ? 'portrait' : ''}">
    <div class="preview-name">${esc(state.settings.clinic)}</div>
    ${decor.badge ? `<div class="preview-badge">1 / ${script?.steps.length || 1} · ${esc(first?.title || '안내 시작')}</div>` : ''}
    <div class="preview-center">◇<br>${esc(state.avatars.find(avatar => avatar.id === data.get('avatar'))?.name || '아바타 영역')}</div>
    ${decor.captions ? `<div class="preview-caption">${esc(first?.body.slice(0, 44) || '자막 미리보기')}</div>` : ''}
    ${decor.showLogo && state.settings.logo ? `<img alt="병원 로고" class="preview-logo ${decor.position}" src="${esc(state.settings.logo)}">` : ''}</div>`;
}

const videoPath = id => `/api/jobs/${id}/video`;
const shareUrl = id => new URL(`/view?s=${id}`, location.origin).href;

function historyRows() {
  return state.jobs.filter(job => (!historyFilter || job.status === historyFilter)
    && job.title.toLowerCase().includes(historySearch.toLowerCase())).map(job => `<tr>
    <td><strong>${esc(job.title)}</strong><br><span class="muted">${languages[job.language]} · ${job.ratio}</span></td>
    <td><span class="tag ${job.error ? 'alert' : ''}">${statusLabel[job.status]}</span>
      ${active(job) ? ` ${job.progress}/${job.total}` : ''}${job.error ? `<p class="muted">${esc(job.error)}</p>` : ''}</td>
    <td>${date(job.createdAt)}</td><td><div class="actions">
      ${job.available ? `${button('영상 열기', 'play', job.id)}<a class="small" href="${videoPath(job.id)}?download=1">MP4</a>` : ''}
      ${!active(job) && job.available ? button('공유 링크', 'share', job.id) : ''}
      ${!active(job) && job.canDecorate ? button('다시 꾸미기', 'decorate', job.id) : ''}
      ${!active(job) && state.scripts.some(script => script.id === job.scriptId) ? button('원고 수정', 'edit', job.scriptId) : ''}
      ${!active(job) ? button('삭제', 'deleteJob', job.id, 'danger') : ''}
    </div></td></tr>`).join('') || emptyRow(4, '조건에 해당하는 영상이 없습니다.');
}

function historyPage() {
  return page('03 / PRODUCTION HISTORY', '생성 이력', '진행 상태를 확인하고 완성 영상을 재생하거나 내려받습니다.',
    `<section class="card"><div class="toolbar"><h2>영상 작업 <span class="tag">${state.jobs.length}개</span></h2>
      ${button('새로고침', 'refresh')}</div>
      <div class="two-fields"><label>제목 검색<input id="history-search" type="search" value="${esc(historySearch)}"></label>
      <label>상태<select id="history-filter"><option value="">모든 상태</option>
      ${Object.entries(statusLabel).map(([key, value]) => `<option value="${key}" ${historyFilter === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div>
      <div class="table-box"><table><thead><tr><th>영상</th><th>상태</th><th>요청일</th><th>작업</th></tr></thead>
        <tbody id="history-rows">${historyRows()}</tbody></table></div></section>`);
}

function settingsPage(isMessage) {
  const s = state.settings;
  return isMessage
    ? page('04 / PATIENT PAGE', '안내문구 설정', '환자가 공유 링크를 열었을 때 보이는 제목, 안내문과 AI 고지를 관리합니다.',
      `<div class="grid"><form id="message-form" class="card stack"><h2>환자 안내문</h2>
        <label>상단 제목<input name="headline" maxlength="60" required value="${esc(s.headline)}"></label>
        <label>안내 본문<textarea name="message" maxlength="500">${esc(s.message)}</textarea></label>
        <label>AI 고지<textarea name="notice" maxlength="320" required>${esc(s.notice)}</textarea></label>
        <div><button class="btn primary">안내문 저장</button></div></form>
        <section class="card stack"><p class="eyebrow">환자 화면 미리보기</p><h2 data-preview="headline">${esc(s.headline)}</h2>
        <div class="preview"><div class="preview-center">▷ 영상 재생 영역</div></div>
        <div class="muted" data-preview="message">${esc(s.message)}</div><div class="notice" data-preview="notice">${esc(s.notice)}</div></section></div>`)
    : page('05 / CLINIC SETTINGS', '병원 설정', '병원 로고와 자막 기본값을 지정하고 원내 영상 엔진 상태를 확인합니다.',
      `<div class="grid"><form id="settings-form" class="card stack"><h2>브랜딩과 자막</h2>
      <label>병원 이름<input name="clinic" maxlength="30" required value="${esc(s.clinic)}"></label>
      <label>로고 파일 · PNG 또는 JPEG, 1MB 이하<input type="file" name="logo" accept="image/png,image/jpeg"></label>
      ${s.logo ? `<img class="logo" alt="현재 병원 로고" src="${esc(s.logo)}"><label class="check"><input type="checkbox" name="removeLogo"> 현재 로고 지우기</label>` : ''}
      ${decorationFields(s, false)}<div><button class="btn primary">병원 설정 저장</button></div></form>
      <section class="card stack"><h2>원내 엔진 상태</h2>
        <div>기본 아바타 <span class="tag">일러스트 안내자 2종</span></div>
        <div>실사 입 모양 합성 <span class="tag">${state.capabilities.portrait ? 'MuseTalk 경로 설정됨' : '선택 기능 · 미설정'}</span></div>
        <div>로컬 AI 초안·번역 <span class="tag">${state.capabilities.ai ? 'Ollama 모델 설정됨' : '선택 기능 · 미설정'}</span></div>
        <div>FFmpeg 합성 <span class="tag">${state.capabilities.ffmpeg ? '사용 가능' : '설치 필요'}</span></div>
        <div>접속 범위 <span class="tag">${state.capabilities.lan ? '설정한 원내망 주소' : '현재 PC'}</span></div>
        <div class="actions">${button('사용 가이드', 'guide')}</div>
        <div class="notice">설치한 엔진의 경로는 원내 PC의 .env에서 관리합니다. 병원 설정을 바꾸면 새 영상에 적용됩니다.</div></section></div>`);
}

function render() {
  if (!state) return;
  const id = pageId();
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.hash === '#' + id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  logout.hidden = !state.capabilities.lan;
  main.innerHTML = { script: scriptPage, create: createPage, history: historyPage,
    message: () => settingsPage(true), settings: () => settingsPage(false) }[id]();
  if (id === 'create') void updateVoices(main.querySelector('#create-form'));
  updatePreview();
}

async function load() {
  try {
    state = await api('/state');
    render();
  } catch (error) {
    if (error.status !== 401) {
      main.textContent = error.message;
      return;
    }
    state = null;
    logout.hidden = true;
    main.innerHTML = page('CLINIC ACCESS', '원내 관리자 로그인', '원내망 관리자 비밀번호를 입력해 주세요.',
      '<form id="login-form" class="card stack"><label>비밀번호<input type="password" name="password" required autocomplete="current-password"></label><div><button class="btn primary">로그인</button></div></form>');
  }
}

function downloadBackup(script) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, script }, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = script.title.replace(/[<>:"/\\|?*]/g, '-') + '.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function avatarManager() {
  const rows = state.avatars.filter(avatar => avatar.type === 'portrait');
  modal('사진 아바타 관리', `<div class="stack">
    <div class="notice">촬영과 합성에 동의한 성인의 정면 사진을 사용해 주세요. 실사 합성은 원내 서버에 MuseTalk를 설치한 뒤 사용할 수 있습니다.</div>
    <div class="table-box"><table><tbody>${rows.map(avatar => `<tr><td>${esc(avatar.name)}</td>
    <td>${button('등록 사진 삭제', 'deleteAvatar', avatar.id, 'danger')}</td></tr>`).join('') || emptyRow(2, '등록된 사진 아바타가 없습니다.')}</tbody></table></div>
    <form id="avatar-form" class="stack"><label>아바타 이름<input name="name" maxlength="40" required></label>
    <label>정면 사진 · PNG 또는 JPEG<input type="file" name="photo" accept="image/png,image/jpeg" required></label>
    <label class="check"><input type="checkbox" name="consent" required> 사진과 아바타 합성에 대한 사용 동의를 확인했습니다.</label>
    <div><button class="btn primary">사진 아바타 등록</button></div></form></div>`);
}

function showShare(job, token = job.share) {
  const href = token ? shareUrl(token) : '';
  modal('환자용 공유 링크', `<div class="stack"><p class="notice">${state.capabilities.lan
    ? '환자가 원내망과 원내 인증서를 사용할 수 있을 때 재생됩니다. 링크를 가진 사람은 영상을 볼 수 있습니다.'
    : '현재는 단일 PC 모드입니다. 링크는 이 PC에서 열 수 있습니다. 환자 휴대폰 사용은 원내망 모드에서 가능합니다.'}</p>
    ${href ? `<label>공유 주소<input id="share-link" value="${esc(href)}" readonly></label><div class="actions">
    ${button('주소 복사', 'copyShare')} <a class="small" href="${esc(href)}" target="_blank" rel="noopener">환자 화면 열기</a>
    ${button('공유 해제', 'revoke', job.id, 'danger')}</div>` : `<div>${button('공유 링크 만들기', 'makeShare', job.id)}</div>`}</div>`);
}

async function clickAction(action, id) {
  const script = state?.scripts.find(item => item.id === id);
  const job = state?.jobs.find(item => item.id === id);
  switch (action) {
    case 'close': dialog.close(); return;
    case 'new': fillEditor(); return;
    case 'sample': fillEditor({ ...draftSample, id: editor?.id }); return;
    case 'edit': fillEditor(script); return;
    case 'duplicate': fillEditor({ ...script, id: undefined, title: (script.title.slice(0, 54) + ' 사본') }); return;
    case 'backup': downloadBackup(script); return;
    case 'peek':
      modal(script.title, `<div class="stack">${script.steps.map((step, i) => `<fieldset><legend>${i + 1}단계 · ${esc(step.title)}</legend><p class="notice">${esc(step.body)}</p></fieldset>`).join('')}
        <div>${button('이 원고로 영상 만들기', 'useScript', id)}</div></div>`);
      return;
    case 'useScript':
      createChoice = { scriptId: id };
      dialog.close();
      navigate('create');
      return;
    case 'addStep':
    case 'removeStep':
      editor = collectEditor();
      if (action === 'addStep' && editor.steps.length >= 4) throw Error('단계는 최대 4개까지 등록할 수 있습니다.');
      if (action === 'addStep') editor.steps.push({ title: '', body: '' });
      else editor.steps.splice(Number(id), 1);
      dialog.querySelector('#steps').innerHTML = stepFields();
      return;
    case 'paste': {
      const steps = splitScript(dialog.querySelector('#paste').value);
      if (!steps.length || steps.length > 4) throw Error('원고를 입력하고 빈 줄을 기준으로 최대 4단계로 나눠 주세요.');
      editor = { ...collectEditor(), steps };
      dialog.querySelector('#steps').innerHTML = stepFields();
      return;
    }
    case 'draft':
    case 'translate':
      if (!state.capabilities.ai) throw Error('AI 초안과 번역을 사용하려면 원내 PC에 Ollama 모델을 설치하고 .env에 설정해 주세요.');
      if (action === 'draft') editor = collectEditor();
      modal(action === 'draft' ? 'AI 원고 초안' : '원고 번역', `<form id="ai-form" class="stack" data-mode="${action}" data-id="${id}">
        ${action === 'draft' ? '<label>안내 주제<input name="topic" maxlength="200" required></label>' : `<p>${esc(script.title)}</p>`}
        <label>결과 언어<select name="language">${languageOptions(action === 'draft' ? editor.language : 'en')}</select></label>
        <div class="notice">원내 서버의 Ollama 모델에서 처리합니다. 초안은 의료진이 검토한 뒤 저장해 주세요.</div>
        <div><button class="btn primary">AI에 요청</button></div></form>`);
      return;
    case 'deleteScript':
      if (confirm('이 원고를 삭제하시겠습니까? 기존에 만든 영상은 보존됩니다.')) { await api('/scripts/' + id, 'DELETE'); await load(); }
      return;
    case 'avatars': avatarManager(); return;
    case 'deleteAvatar':
      if (confirm('등록 사진을 삭제하시겠습니까? 이미 만든 영상은 보존됩니다.')) {
        await api('/avatars/' + id, 'DELETE');
        await load();
        avatarManager();
      }
      return;
    case 'play':
      modal(job.title, `<video controls playsinline preload="metadata" src="${videoPath(id)}"></video>`);
      return;
    case 'share': showShare(job); return;
    case 'makeShare':
    case 'revoke': {
      const result = await api('/jobs/' + id + '/share', 'POST', { revoke: action === 'revoke' });
      job.share = result.share;
      showShare(job);
      return;
    }
    case 'copyShare':
      dialog.querySelector('#share-link').select();
      if (navigator.clipboard) { await navigator.clipboard.writeText(dialog.querySelector('#share-link').value); note('공유 주소를 복사했습니다.'); }
      else note('선택된 주소를 복사해 주세요.');
      return;
    case 'decorate':
      modal('다시 꾸미기', `<form id="decorate-form" class="stack" data-id="${id}">${decorationFields(job)}
        <p class="muted">저장된 원본 영상으로 자막과 로고를 다시 합성합니다.</p>
        <div><button class="btn primary">다시 꾸미기</button></div></form>`);
      return;
    case 'deleteJob':
      if (confirm('영상과 공유 링크를 삭제하시겠습니까?')) { await api('/jobs/' + id, 'DELETE'); await load(); }
      return;
    case 'refresh': await load(); return;
    case 'guide':
      modal('사용 가이드', '<ol class="stack"><li>스크립트 등록에서 안내 원고를 저장합니다.</li><li>영상 만들기에서 원고, 아바타, 화면비를 선택합니다.</li><li>생성 이력에서 영상과 자막을 검수합니다.</li><li>완성본을 내려받거나 원내망 환자 안내 페이지로 공유합니다.</li></ol>');
      return;
  }
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function submit(form) {
  const data = new FormData(form);
  const fields = Object.fromEntries(data);
  switch (form.id) {
    case 'login-form':
      await api('/login', 'POST', fields);
      await load();
      break;
    case 'edit-form':
      await api('/scripts', 'POST', collectEditor());
      dialog.close();
      await load();
      note('원고를 저장했습니다.');
      break;
    case 'ai-form': {
      const source = state.scripts.find(item => item.id === form.dataset.id);
      const result = await api('/ai', 'POST', { mode: form.dataset.mode, source, ...fields });
      fillEditor({ ...result, id: form.dataset.mode === 'draft' ? editor.id : undefined });
      note('초안을 불러왔습니다. 내용을 확인하고 저장해 주세요.');
      break;
    }
    case 'create-form': {
      form.dataset.requestId ||= crypto.randomUUID();
      await api('/jobs', 'POST', { ...fields, ...readDecor(form), requestId: form.dataset.requestId });
      createChoice = undefined;
      await load();
      navigate('history');
      note('영상 제작을 요청했습니다.');
      break;
    }
    case 'avatar-form': {
      const photo = data.get('photo');
      if (!photo.size || photo.size > 1_000_000) throw Error('1MB 이하의 사진을 선택해 주세요.');
      const result = await api('/avatars', 'POST', { name: fields.name, consent: data.has('consent'), image: await fileAsDataUrl(photo) });
      createChoice = { ...createChoice, avatar: result.id };
      await load();
      avatarManager();
      note('사진 아바타를 등록했습니다.');
      break;
    }
    case 'decorate-form':
      await api('/jobs/' + form.dataset.id + '/decorate', 'POST', readDecor(form));
      dialog.close();
      await load();
      break;
    case 'message-form':
      await api('/settings', 'POST', { section: 'message', ...fields });
      await load();
      note('안내문을 저장했습니다.');
      break;
    case 'settings-form': {
      const file = data.get('logo');
      if (file.size > 1_000_000) throw Error('로고는 1MB 이하여야 합니다.');
      const logo = data.has('removeLogo') ? '' : file.size ? await fileAsDataUrl(file) : state.settings.logo;
      await api('/settings', 'POST', { section: 'branding', ...readDecor(form), clinic: fields.clinic, logo });
      await load();
      note('병원 설정을 저장했습니다.');
      break;
    }
  }
}

async function perform(task, element) {
  if (locked) return;
  locked = true;
  if (element) element.disabled = true;
  try { await task(); } catch (error) { note(error.message || '작업을 완료하지 못했습니다.'); }
  finally {
    locked = false;
    if (element?.isConnected) element.disabled = false;
  }
}

dialog.addEventListener('close', () => { dialog.innerHTML = ''; });
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (target) void perform(() => clickAction(target.dataset.action, target.dataset.id), target);
});
document.addEventListener('submit', event => {
  event.preventDefault();
  void perform(() => submit(event.target), event.submitter);
});
document.addEventListener('input', event => {
  const field = event.target;
  if (field.id === 'script-search' || field.id === 'script-filter') {
    if (field.id === 'script-search') scriptSearch = field.value;
    else scriptFilter = field.value;
    main.querySelector('#script-rows').innerHTML = scriptRows();
  }
  if (field.id === 'history-search' || field.id === 'history-filter') {
    if (field.id === 'history-search') historySearch = field.value;
    else historyFilter = field.value;
    main.querySelector('#history-rows').innerHTML = historyRows();
  }
  if (field.form?.id === 'create-form') {
    if (field.name === 'scriptId') {
      field.form.elements.title.value = state.scripts.find(item => item.id === field.value)?.title || '';
      void updateVoices(field.form);
    }
    updatePreview();
  }
  if (field.form?.id === 'message-form') main.querySelector(`[data-preview="${field.name}"]`).textContent = field.value;
});
document.addEventListener('change', event => {
  if (event.target.id !== 'import') return;
  void perform(async () => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 1_000_000) throw Error('1MB 이하의 파일을 사용해 주세요.');
    const content = await file.text();
    const current = collectEditor();
    if (file.name.toLowerCase().endsWith('.srt')) {
      const body = parseSrt(content).map(cue => cue.body).join('\n');
      if (!body) throw Error('SRT 파일에서 대사를 찾을 수 없습니다.');
      if (body.length > 3500) throw Error('SRT 대사가 3500자를 초과합니다. 파일을 나눠 주세요.');
      fillEditor({ ...current, steps: [{ title: '', body }] });
    } else {
      const payload = JSON.parse(content);
      const script = payload.script;
      if (payload.version !== 1 || !script || !Object.hasOwn(languages, script.language) || !Array.isArray(script.steps)
          || !script.steps.length || script.steps.length > 4 || script.steps.some(step => typeof step?.body !== 'string')) throw Error('영상 스튜디오의 JSON 백업 파일을 사용해 주세요.');
      fillEditor({ ...script, id: current.id });
    }
  });
});
logout.addEventListener('click', () => void perform(async () => { await api('/logout', 'POST', {}); await load(); }, logout));
window.addEventListener('hashchange', render);
setInterval(() => {
  if (!state || pageId() !== 'history' || !state.jobs.some(active) || locked) return;
  api('/jobs').then(jobs => {
    if (!state) return;
    state.jobs = jobs;
    const rows = main.querySelector('#history-rows');
    if (rows) rows.innerHTML = historyRows();
  }).catch(error => { if (error.status === 401) void load(); });
}, 7000);
void load();
