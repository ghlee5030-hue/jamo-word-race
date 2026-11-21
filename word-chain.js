(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const rules = factory(isNode ? require("./word-chain-lexicon") : root.WordChainLexicon);
  if (isNode) module.exports = rules;
  else root.WordChain = rules;
})(globalThis, function (lexicon) {
  const TURN_MS = 20000;
  const lists = new Map();
  const commonWords = new Map();
  const byFirst = new Map();

  function wordSet(text) {
    return text.trim() ? text.trim().split(/\s+/) : [];
  }

  for (const length of [3, 4]) {
    const common = new Set(wordSet(lexicon[length].common));
    const list = new Set([...common, ...wordSet(lexicon[length].other)]);
    commonWords.set(length, common);
    lists.set(length, list);
    const index = new Map();
    for (const word of list) {
      if (!index.has(word[0])) index.set(word[0], []);
      index.get(word[0]).push(word);
    }
    byFirst.set(length, index);
  }

  function modeLength(mode) {
    return mode === "chain3" ? 3 : mode === "chain4" ? 4 : 0;
  }

  function starts(last) {
    const code = last.charCodeAt(0) - 0xac00;
    if (!(code >= 0 && code < 11172)) return [last];
    const initial = Math.floor(code / 588);
    const vowel = Math.floor((code % 588) / 28);
    const soft = [2, 6, 7, 12, 17, 20];
    const next = initial === 5 && [0, 1, 8, 11, 13, 18].includes(vowel) ? 2
      : initial === 5 && soft.includes(vowel) || initial === 2 && [6, 12, 17, 20].includes(vowel) ? 11 : initial;
    return next === initial ? [last] : [last, String.fromCharCode(0xac00 + next * 588 + (code % 588))];
  }

  function validate(value, length, previous, used) {
    const word = String(value || "").trim().normalize("NFC");
    if (word.length !== length || !/^[가-힣]+$/.test(word)) throw new Error(`한글 ${length}글자 단어를 입력하세요`);
    const allowed = starts(previous.at(-1));
    if (!allowed.includes(word[0])) throw new Error(`‘${allowed.join("’ 또는 ‘")}’으로 시작하는 단어를 입력하세요`);
    if (used.has(word)) throw new Error("이미 나온 단어예요");
    if (!lists.get(length)?.has(word)) throw new Error("이 게임의 단어 목록에 없어요");
    return word;
  }

  function* choices(length, previous, used) {
    const index = byFirst.get(length);
    for (const letter of starts(previous.at(-1))) {
      for (const word of index?.get(letter) || []) {
        if (!used.has(word)) yield word;
      }
    }
  }

  function pick(items) {
    return items[Math.floor(Math.random() * items.length)] || "";
  }

  function hasPath(length, word, used, depth) {
    for (const next of choices(length, word, used)) {
      if (depth === 1) return true;
      used.add(next);
      const found = hasPath(length, next, used, depth - 1);
      used.delete(next);
      if (found) return true;
    }
    return false;
  }

  function starter(length) {
    const common = commonWords.get(length);
    if (!common) return "";
    const candidates = [...common];
    const start = Math.floor(Math.random() * candidates.length);
    for (let i = 0; i < candidates.length; i += 1) {
      const word = candidates[(start + i) % candidates.length];
      if (hasPath(length, word, new Set([word]), 4)) return word;
    }
    return [...lists.get(length)].find((word) => hasPath(length, word, new Set([word]), 4)) || "";
  }

  function computer(length, previous, used) {
    const options = [...choices(length, previous, used)];
    const played = new Set(used);
    const playable = options.filter((word) => {
      played.add(word);
      const continues = hasPath(length, word, played, 1);
      played.delete(word);
      return continues;
    });
    const best = playable.length ? playable : options;
    const familiar = best.filter((word) => commonWords.get(length).has(word));
    return pick(familiar.length ? familiar : best);
  }

  function hint(length, previous, used) {
    const word = computer(length, previous, used);
    if (!word) return "";
    const initials = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
    const revealed = 1 + Math.floor(Math.random() * (word.length - 1));
    return [...word].map((letter, index) => index === revealed
      ? letter : initials[Math.floor((letter.charCodeAt(0) - 0xac00) / 588)]).join(" ");
  }

  return { TURN_MS, modeLength, starts, validate, starter, computer, hint, size: (length) => lists.get(length)?.size || 0 };
});
