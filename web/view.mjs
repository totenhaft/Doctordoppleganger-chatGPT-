const token = new URLSearchParams(location.search).get('s');
const element = id => document.getElementById(id);
try {
  if (!/^[a-f0-9]{48}$/.test(token)) throw Error();
  const response = await fetch(`/share/${token}`);
  if (!response.ok) throw Error();
  const data = await response.json();
  for (const [id, key] of [['clinic', 'clinic'], ['headline', 'headline'], ['video-title', 'title'], ['message', 'message'], ['notice', 'notice']]) {
    element(id).textContent = data[key];
  }
  document.title = `${data.title} | ${data.clinic}`;
  const video = element('video');
  video.classList.toggle('portrait', data.ratio === '9:16');
  video.src = `/share/${token}/video`;
  video.hidden = false;
  element('notice').hidden = false;
} catch {
  element('message').textContent = '이 링크에서 영상을 볼 수 없습니다. 병원에 새 링크를 문의해 주세요.';
}
