# 단어배틀

자모 맞추기, 초성 퀴즈, 쿵쿵따를 혼자 또는 친구와 즐기는 한글 게임입니다.

## 로컬 실행

```bash
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다.

## 다른 네트워크 친구 초대

`file:///...` 또는 `192.168.x.x` 주소는 같은 컴퓨터/같은 공유기 안에서만 됩니다.
다른 네트워크의 친구를 초대하려면 Node 서버를 인터넷에 배포해야 합니다.

### Render 배포

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 `New` -> `Web Service`를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. 아래처럼 설정합니다.

```text
Environment: Node
Build Command: npm install
Start Command: npm start
```

5. 배포가 끝나면 `https://...onrender.com` 주소가 생깁니다.
6. 그 주소를 친구에게 보내면 다른 네트워크에서도 접속할 수 있습니다.

## 쿵쿵따

게임 방식에서 쿵쿵따 3글자 또는 4글자를 선택합니다. 마지막 글자로 시작하는 같은 길이의 새 단어를 게임 내 단어 목록에서 골라 잇습니다. 두음법칙을 적용할 수 있고, 이미 나온 단어는 다시 쓸 수 없습니다. 혼자 할 때는 컴퓨터와 번갈아 입력하고, 친구 대결에서는 차례당 20초 안에 잇지 못한 사람이 탈락합니다.

한 판에 참가자마다 자기 차례에 한 번 힌트를 쓸 수 있습니다. 시작 글자를 제외한 한 글자는 완성형으로, 나머지는 초성으로 보여줍니다.
상대나 컴퓨터가 낸 단어 옆의 이의 제기를 누르면 그 아래에 뜻과 출처가 표시됩니다. 친구 대결에서는 같은 방 참가자에게도 표시되며, 판정이나 제한 시간은 바뀌지 않습니다.

단어 규칙 테스트: `node --test test/word-chain.test.js`

### 쿵쿵따 단어 데이터

- 국립국어원 [한국어기초사전 전체 내려받기](https://krdict.korean.go.kr/download/downloadPopup)에서 제공한 2026-11-19 JSON 자료를 사용합니다. 한글 3·4음절 명사 표제어를 추리고 별도 뜻풀이 파일에 표제어별 뜻풀이 한 항목을 보관합니다. 예문·번역은 포함하지 않습니다.
- 국립국어원 [표준국어대사전](https://stdict.korean.go.kr/)의 [2019년 공개 자료 사본](https://github.com/spellcheck-ko/korean-dict-nikl-stdict/tree/3bac283568a6a2ef5e2645a752fd011de56893a2)에서 전문 분야 표시가 없는 일반어 명사를 추가했습니다. 별도로 검토한 일상어와 캐릭터 이름 예외는 `scripts/word-chain-supplement.txt`에 구분했습니다. 사전 전체가 아닌 게임용 목록입니다.
- 가공한 사전 데이터(`word-chain-lexicon.js`, `word-chain-definitions.json`)의 저작자 표시는 국립국어원이며, [CC BY-SA 2.0 KR](https://creativecommons.org/licenses/by-sa/2.0/kr/)을 적용합니다. 변경 사항은 필터링, 뜻풀이 선택, 표기 정규화, 중복 제거, 추가 목록 병합입니다. 별도 검토한 설명은 게임 설명으로 표시합니다.
- 갱신: `pwsh -File scripts/extract-word-chain-stdict.ps1 <표준국어대사전 XML 폴더> <출력.jsonl>`로 일반 명사와 뜻을 추출한 뒤 `node scripts/build-word-chain-lexicon.js <한국어기초사전-JSON.zip> <출력.jsonl>`를 실행합니다(시스템 `tar` 필요).

## 멀티플레이

- 방 만들기
- 초대 링크 복사
- 2~5명 입장
- 시작 전 채팅
- 참가자 준비
- 방장이 같이 시작
- 3초 카운트다운 후 시작
- 제한시간 3분 30초

모두 같은 정답으로 시작하고, 먼저 맞힌 순서가 방 목록에 표시됩니다. 제한시간 안에 못 맞힌 참가자는 패배로 기록됩니다.
