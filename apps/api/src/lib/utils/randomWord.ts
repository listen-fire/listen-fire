import fs from 'node:fs/promises';
import path from 'node:path';

const WORDLIST_PATH = '../../../wordlist.txt';

let wordlistCache: string[] | null = null;

async function loadWordlist() {
  if (wordlistCache) {
    return wordlistCache;
  }

  wordlistCache = [];

  const wordListString = await fs.readFile(path.join(__dirname, WORDLIST_PATH), 'utf-8');
  const wordListRows = wordListString.split('\n');
  for (const row of wordListRows) {
    const [_idx, word] = row.split('\t');
    wordlistCache.push(word);
  }

  return wordlistCache;
}

async function randomWord() {
  const wordlist = await loadWordlist();
  const randomIndex = Math.floor(Math.random() * wordlist.length);
  return { index: randomIndex, word: wordlist[randomIndex] };
}

export { randomWord };
