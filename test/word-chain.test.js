const test = require("node:test");
const assert = require("node:assert/strict");
const chain = require("../word-chain");
const lexicon = require("../word-chain-lexicon");
const dictionary = require("../word-chain-dictionary");

test("the chosen mode determines the syllable count", () => {
  assert.equal(chain.modeLength("chain3"), 3);
  assert.equal(chain.modeLength("chain4"), 4);
  assert.equal(chain.modeLength("jamo"), 0);
  assert.throws(() => chain.validate("나무", 3, "카메라", new Set()), /3글자/);
  assert.throws(() => chain.validate("나들이", 4, "카메라", new Set()), /4글자/);
});

test("supports initial sound changes, rejecting duplicates and unknown words", () => {
  assert.deepEqual(chain.starts("리"), ["리", "이"]);
  assert.deepEqual(chain.starts("라"), ["라", "나"]);
  assert.equal(chain.validate("나들이", 3, "카메라", new Set()), "나들이");
  assert.throws(() => chain.validate("나들이", 3, "카메라", new Set(["나들이"])), /이미/);
  assert.throws(() => chain.validate("나갸탸", 3, "카메라", new Set()), /단어 목록/);
  assert.throws(() => chain.validate("고구마", 3, "카메라", new Set()), /시작/);
});

test("both lengths have openings and legal computer replies", () => {
  for (const length of [3, 4]) {
    assert.ok(chain.size(length) > 300);
    const opening = chain.starter(length);
    const used = new Set([opening]);
    assert.equal(opening.length, length);
    const word = chain.computer(length, opening, used);
    assert.equal(chain.validate(word, length, opening, used), word);
    used.add(word);
    assert.notEqual(chain.computer(length, opening, used), word);
  }
});

test("accepts common three-syllable words from the reported chains", () => {
  for (const words of [
    ["장미꽃", "꽃놀이", "이야기", "기차역"],
    ["장미꽃", "꽃미남", "남동생", "생선회", "회전문", "문지기"]
  ]) {
    const used = new Set([words[0]]);
    for (let i = 1; i < words.length; i += 1) {
      assert.equal(chain.validate(words[i], 3, words[i - 1], used), words[i]);
      used.add(words[i]);
    }
  }
});

test("accepts familiar four-syllable words and rejects truncated strings", () => {
  const words = ["초등학교", "교통신호", "호랑나비", "비눗방울"];
  const used = new Set([words[0]]);
  for (let i = 1; i < words.length; i += 1) {
    assert.equal(chain.validate(words[i], 4, words[i - 1], used), words[i]);
    used.add(words[i]);
  }
  for (const word of ["엘리베", "오토바", "전자레인", "무인자동"]) {
    assert.throws(() => chain.validate(word, word.length, "단어" + word[0], new Set()), /단어 목록/);
  }
});

test("accepts reported three-syllable words after the matching final syllable", () => {
  for (const [previous, word] of [["출발점", "점수판"], ["역사적", "적토마"], ["때까치", "치와와"], ["운동장", "장발장"]]) {
    assert.equal(chain.validate(word, 3, previous, new Set([previous])), word);
  }
});

test("every generated headword is distinct and accepted in its own mode", () => {
  for (const [length, minimum] of [[3, 10000], [4, 2700]]) {
    const { common, other } = lexicon[length];
    const words = `${common} ${other}`.trim().split(/\s+/);
    assert.equal(new Set(words).size, words.length);
    assert.equal(chain.size(length), words.length);
    assert.ok(words.length >= minimum);
    for (const word of words) {
      assert.match(word, new RegExp(`^[가-힣]{${length}}$`));
      assert.equal(chain.validate(word, length, "단어" + word[0], new Set()), word);
      assert.ok(dictionary.lookup(word)?.definition, `Missing meaning for ${word}`);
    }
  }
});

test("answers the reported spellings without guessing a meaning for an unknown word", () => {
  assert.match(dictionary.lookup("이만치").definition, /정도/);
  assert.equal(chain.validate("요단강", 3, "필요", new Set()), "요단강");
  assert.match(dictionary.lookup("요단강").definition, /요르단강/);
  assert.equal(dictionary.lookup("와자항"), null);
  assert.throws(() => chain.validate("와자항", 3, "치와와", new Set()), /단어 목록/);
});

test("chain hints reveal exactly one later syllable in both lengths", () => {
  for (const [length, previous] of [[3, "출발점"], [4, "초등학교"]]) {
    const parts = chain.hint(length, previous, new Set([previous])).split(" ");
    assert.equal(parts.length, length);
    assert.match(parts[0], /^[ㄱ-ㅎ]$/);
    assert.equal(parts.filter((part) => /^[가-힣]$/.test(part)).length, 1);
    assert.equal(parts.filter((part) => /^[ㄱ-ㅎ]$/.test(part)).length, length - 1);
  }
  assert.equal(chain.hint(4, "바깥똠", new Set(["바깥똠"])), "");
});
