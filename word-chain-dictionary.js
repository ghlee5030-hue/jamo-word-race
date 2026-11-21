const entries = require("./word-chain-definitions.json");
const reviewedMeanings = require("./word-chain-reviewed-meanings.json");

const reviewed = new Map([
  ["요단강", {
    definition: "성경에서 요르단강을 부르는 이름.",
    source: "국립국어원 표준국어대사전",
    url: "https://stdict.korean.go.kr/search/searchView.do?word_no=246283"
  }],
  ["점수판", { definition: "경기나 게임에서 참가자의 점수를 표시하는 판." }],
  ["적토마", { definition: "삼국지 이야기에서 여포와 관우가 탔다고 전해지는 붉은 말." }],
  ["치와와", { definition: "멕시코에서 유래한 몸집이 아주 작은 개 품종." }],
  ["장발장", { definition: "빅토르 위고의 소설 《레 미제라블》의 주인공." }]
]);

function lookup(value) {
  const word = String(value || "").trim().normalize("NFC");
  if (!/^[가-힣]{3,4}$/.test(word)) return null;
  if (reviewed.has(word)) {
    return { source: "단어배틀 용어 설명", ...reviewed.get(word) };
  }
  const entry = entries[word];
  if (!entry) return reviewedMeanings[word] ? { definition: reviewedMeanings[word], source: "단어배틀 용어 설명" } : null;
  const [kind, definition, id] = entry;
  const basic = kind === "basic";
  const record = /^\d+$/.test(id || "");
  const url = basic
    ? (record ? `https://krdict.korean.go.kr/kor/dicSearch/SearchView?ParaWordNo=${id}`
      : `https://krdict.korean.go.kr/kor/dicMarinerSearch/search?mainSearchWord=${encodeURIComponent(word)}`)
    : (record ? `https://stdict.korean.go.kr/search/searchView.do?word_no=${id}` : "https://stdict.korean.go.kr/");
  return {
    definition,
    source: basic ? "국립국어원 한국어기초사전" : "국립국어원 표준국어대사전",
    url
  };
}

module.exports = { lookup };
