export const languages = {
  ko: '한국어', en: 'English', zh: '中文', ja: '日本語', mn: 'Монгол',
  vi: 'Tiếng Việt', id: 'Bahasa Indonesia', es: 'Español', nl: 'Nederlands'
};

export function parseSrt(srt) {
  const time = value => {
    const [h, m, s] = value.replace(',', '.').split(':').map(Number);
    return h * 3600 + m * 60 + s;
  };
  return srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/).flatMap(block => {
    const lines = block.split('\n');
    const index = lines.findIndex(line => /^\s*\d+:\d+:\d+[,.]\d+\s+-->/.test(line));
    if (index < 0) return [];
    const [start, end] = lines[index].match(/\d+:\d+:\d+[,.]\d+/g) || [];
    const body = lines.slice(index + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    return start && end && body && time(end) > time(start) ? [{ start: time(start), end: time(end), body }] : [];
  });
}

export function splitScript(raw) {
  return raw.replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n+/).filter(Boolean).map(block => {
    const [first, ...remaining] = block.trim().split('\n');
    const hasTitle = remaining.length && first.trim().length <= 30;
    return { title: hasTitle ? first.trim() : '', body: (hasTitle ? remaining.join('\n') : block).trim() };
  });
}
