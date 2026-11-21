const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

function tar(...args) {
  return execFileSync("tar", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function extractNouns(archive) {
  const shards = tar("-tf", archive).split(/\r?\n/).filter((file) => /\.json$/i.test(file));
  const nouns = new Map([[3, new Map()], [4, new Map()]]);
  const definitions = new Map();
  if (!shards.length) throw new Error("No Korean Basic Dictionary JSON shards found");

  let date;
  for (const shard of shards) {
    const resource = JSON.parse(tar("-xOf", archive, shard)).LexicalResource;
    date ??= resource.GlobalInformation.feat.find(({ att }) => att === "creationDate")?.val;
    for (const entry of resource.Lexicon.LexicalEntry) {
      const features = Object.fromEntries([entry.feat ?? []].flat().map(({ att, val }) => [att, val]));
      if (features.lexicalUnit !== "단어" || features.partOfSpeech !== "명사") continue;
      const lemmas = [entry.Lemma].flat().flatMap((lemma) => [lemma.feat].flat());
      const word = lemmas.find(({ att }) => att === "writtenForm")?.val.normalize("NFC");
      // Strip only internal dictionary hyphens, not spacing or affix markers.
      const normalized = word?.replace(/(?<=[가-힣])-(?=[가-힣])/g, "");
      const list = nouns.get(normalized?.length);
      if (!list || !/^[가-힣]+$/.test(normalized)) continue;
      const common = features.vocabularyLevel === "초급" || features.vocabularyLevel === "중급";
      list.set(normalized, common || list.get(normalized) || false);
      if (!definitions.has(normalized)) {
        const senseFeatures = [entry.Sense ?? []].flat().flatMap((sense) => [sense.feat ?? []].flat());
        const definition = senseFeatures.find(({ att, val }) => att === "definition" && val?.trim())?.val;
        if (definition) definitions.set(normalized, ["basic", definition.trim(), String(entry.att?.val ?? entry.val ?? "")]);
      }
    }
  }
  return { nouns, date, definitions };
}

function build(archive, standardNounsFile, supplementFile, output, definitionsOutput) {
  const { nouns, date, definitions } = extractNouns(archive);
  const standardRows = readFileSync(standardNounsFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const standardNouns = [];
  for (const [word, id, definition] of standardRows) {
    standardNouns.push(word);
    if (definition && !definitions.has(word)) definitions.set(word, ["standard", definition.trim(), id]);
  }
  const supplement = readFileSync(supplementFile, "utf8")
    .split(/\r?\n/).map((line) => line.split("#")[0].trim()).join(" ").split(/\s+/).filter(Boolean);
  for (const word of [...standardNouns, ...supplement]) {
    const list = nouns.get(word.length);
    if (!list || !/^[가-힣]+$/.test(word)) throw new Error(`Invalid supplement: ${word}`);
    if (!list.has(word)) list.set(word, false);
  }
  const lines = [
    "/* License: CC BY-SA 2.0 KR (https://creativecommons.org/licenses/by-sa/2.0/kr/)",
    ` * Source: National Institute of Korean Language, Korean Basic Dictionary (${date}).`,
    " * https://krdict.korean.go.kr/download/downloadPopup",
    " * Source: National Institute of Korean Language, Standard Korean Dictionary (2019 public archive).",
    " * https://stdict.korean.go.kr/",
    " * Includes a reviewed supplement. See README.md for source details.",
    " * Modified: noun headwords only, filtered by length, normalized and deduplicated.",
    " */",
    '"use strict";',
    "const wordChainLexicon = {"
  ];
  for (const [length, list] of nouns) {
    const words = [...list.keys()].sort();
    const common = words.filter((word) => list.get(word));
    const other = words.filter((word) => !list.get(word));
    lines.push(`  ${length}: {`);
    for (const [label, group] of Object.entries({ common, other })) {
      lines.push(`    ${label}: \``);
      for (let i = 0; i < group.length; i += 16) lines.push("      " + group.slice(i, i + 16).join(" "));
      lines.push("    \`,");
    }
    lines.push("  },");
    process.stdout.write(`${length}: ${words.length} nouns (${common.length} beginner/intermediate)\n`);
  }
  lines.push(
    "};",
    'if (typeof module === "object" && module.exports) module.exports = wordChainLexicon;',
    "else globalThis.WordChainLexicon = wordChainLexicon;",
    ""
  );
  writeFileSync(output, lines.join("\n"), "utf8");
  const entries = [...definitions].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const records = entries.map(([word, value]) => `  ${JSON.stringify(word)}: ${JSON.stringify(value)}`);
  writeFileSync(definitionsOutput, "{\n" + records.join(",\n") + "\n}\n", "utf8");
  process.stdout.write(`${definitions.size} dictionary definitions\n`);
}

if (require.main === module) {
  const archive = process.argv[2];
  const standardNouns = process.argv[3];
  if (!archive || !standardNouns) throw new Error("Usage: node scripts/build-word-chain-lexicon.js <krdict-json.zip> <stdict-nouns.jsonl>");
  build(archive, standardNouns, path.join(__dirname, "word-chain-supplement.txt"),
    path.join(__dirname, "../word-chain-lexicon.js"), path.join(__dirname, "../word-chain-definitions.json"));
}

module.exports = { extractNouns };
