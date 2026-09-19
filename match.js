// Links follow-up episodes (e.g. "Чадо из ада - Предки") to the original-show episodes
// with the same people, using the names in each episode's description.
// Pure functions, shared by the extension and the Node tests.

// Capitalised words that are never people, even though they may start a sentence.
const STOP = new Set([
  'чадо', 'ада', 'предки', 'ю', 'реалити', 'шоу', 'проект', 'телеканал', 'телеканале', 'встречайте', 'премьера', 'премьеру',
  'москва', 'москвы', 'москве', 'россия', 'россии', 'петербург', 'петербурга', 'санкт', 'спб', 'мск', 'европа', 'европе', 'европу',
  'новые', 'испытания', 'бывшие', 'дом', 'интернет', 'инстаграм', 'тикток', 'телеграм',
  // words that often start a sentence
  'благодаря', 'например', 'однако', 'поэтому', 'теперь', 'также', 'кроме', 'после', 'когда', 'если', 'чтобы', 'хотя', 'пока',
  'вместе', 'сначала', 'затем', 'потом', 'именно', 'конечно', 'возможно', 'кстати', 'зато', 'впрочем', 'помимо', 'ведь', 'даже',
  'вместо', 'итак', 'наконец', 'только', 'лишь', 'сегодня', 'вчера', 'завтра', 'сейчас', 'раньше', 'позже', 'спустя', 'несмотря',
  'удастся', 'сможет', 'смогут', 'получится', 'почему', 'зачем', 'сколько', 'какой', 'какая', 'какие', 'каково', 'чем',
  'правда', 'кажется', 'похоже', 'видимо', 'пожалуй', 'разумеется', 'естественно', 'действительно', 'увы', 'вдобавок',
  'более', 'менее', 'тем', 'еще', 'уже', 'все', 'этот', 'эта', 'это', 'эти', 'такой', 'такая', 'такие', 'вот', 'там', 'тут',
  'здесь', 'сам', 'сама', 'сами', 'каждый', 'каждая', 'каждое', 'новый', 'новая', 'новое', 'главный', 'главная', 'сегодняшний',
]);

// Short forms used alongside full names.
const NICK = {
  лера: 'валерия', саша: 'александр', женя: 'евгений', дима: 'дмитрий', миша: 'михаил', сережа: 'сергей', коля: 'николай',
  вова: 'владимир', володя: 'владимир', леша: 'алексей', паша: 'павел', петя: 'петр', ваня: 'иван', костя: 'константин',
  даня: 'даниил', гоша: 'георгий', юра: 'юрий', слава: 'вячеслав', катя: 'екатерина', настя: 'анастасия', маша: 'мария',
  даша: 'дарья', лиза: 'елизавета', наташа: 'наталья', таня: 'татьяна', оля: 'ольга', аня: 'анна', юля: 'юлия',
  ксюша: 'ксения', соня: 'софья', вика: 'виктория', света: 'светлана', лена: 'елена', ира: 'ирина', надя: 'надежда',
  поля: 'полина', макс: 'максим', артемка: 'артем', темa: 'артем', тема: 'артем', вилечка: 'вилена',
};

const ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ой', 'ей', 'ый', 'ая', 'яя', 'ую', 'юю', 'ом', 'ем',
  'ам', 'ям', 'ах', 'ях', 'ых', 'их', 'ым', 'им', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и', 'о', 'ь'];

/** Reduces a Russian name in any case form to a shared stem. */
export function stem(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  if (NICK[w]) w = NICK[w].replace(/ё/g, 'е');
  let m;
  // Реуцкий / Реуцкая / Реуцких / Реуцкие, Борисовский …
  if ((m = w.match(/^(.{2,}(?:ск|цк))(ий|ая|ой|ую|ого|ому|им|ом|ие|их|ими|ое)$/))) return m[1];
  // Изотов / Изотова / Изотовой / Изотовых, Гаджиев, Лунеговы, Хикматуллин …
  if ((m = w.match(/^(.{2,}(?:ов|ев|ин|ын))(а|ой|у|ым|ом|е|ых|ыми|ы|ым)?$/))) return m[1];
  // Артемий / Артемия / Артемию, Валерия / Валерии, Ксения … (keeps them apart from Артем)
  if ((m = w.match(/^(.{3,}и)(й|я|ю|ем|е|и)$/))) return m[1];
  for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length);
  return w;
}

const WORD = /(?<![А-ЯЁа-яё])[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)?/g;

/** Lower-case words seen anywhere in the texts: a capitalised word that also appears in lower case isn't a name. */
export function commonWords(texts) {
  const out = new Set();
  for (const t of texts) {
    for (const m of String(t).matchAll(WORD)) {
      const w = m[0];
      if (w[0] === w[0].toLowerCase()) out.add(w.replace(/ё/g, 'е'));
    }
  }
  return out;
}

/** Stems of the capitalised words (names, surnames) in a description. */
export function nameStems(text, common = new Set()) {
  const out = new Set();
  // «…» holds show and segment titles, not people.
  const plain = String(text).replace(/«[^»]*»/g, ' ').replace(/"[^"]*"/g, ' ');
  for (const m of plain.matchAll(WORD)) {
    const w = m[0];
    if (w.length < 3 || w[0] !== w[0].toUpperCase() || w[1] !== w[1].toLowerCase()) continue;
    const low = w.toLowerCase().replace(/ё/g, 'е');
    if (STOP.has(low) || common.has(low)) continue;
    out.add(stem(low));
  }
  return out;
}

const SURNAME_STEM = /(ов|ев|ин|ын|ск|цк|ук|юк|ко|ич|дзе|швили|ян)$/;

/**
 * originals / followUps: [{ id, description }]
 * Returns Map followId -> [{ originalId, names: [stems], confidence: 'high'|'medium' }], best first.
 * A name only counts if exactly one original episode mentions it, so a follow-up is linked to
 * the episode(s) whose people it names. Nothing is guessed when the evidence is weak.
 */
export function matchEpisodes(originals, followUps) {
  const common = commonWords([...originals, ...followUps].map((e) => e.description));
  const orig = originals.map((e) => ({ e, stems: nameStems(e.description, common) }));
  const seenIn = new Map();
  for (const o of orig) for (const s of o.stems) seenIn.set(s, (seenIn.get(s) || 0) + 1);

  const links = new Map();
  for (const f of followUps) {
    const fStems = nameStems(f.description, common);
    const found = [];
    for (const o of orig) {
      const shared = [...fStems].filter((s) => o.stems.has(s));
      const unique = shared.filter((s) => seenIn.get(s) === 1);
      if (!unique.length) continue;
      const surname = unique.some((s) => SURNAME_STEM.test(s) && s.length >= 5);
      const confidence = unique.length >= 2 || surname ? 'high' : 'medium';
      found.push({ originalId: o.e.id, names: shared, unique: unique.length, confidence });
    }
    found.sort((a, b) => (b.confidence === 'high') - (a.confidence === 'high') || b.unique - a.unique || b.names.length - a.names.length);
    // With a surname-backed match in hand, first-name-only hits are coincidences
    // (a parent's first name that happens to appear in some other episode).
    const kept = found.some((l) => l.confidence === 'high') ? found.filter((l) => l.confidence === 'high') : found;
    if (kept.length) links.set(f.id, kept);
  }
  return links;
}
