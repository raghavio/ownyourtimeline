import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('release build ships no debug logging code', () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  for (const file of ['main.js', 'content.js', 'background.js', 'popup.js']) {
    assert.doesNotMatch(readFileSync(`dist/${file}`, 'utf8'), /indexedDB|ownyourtimeline-debug|"LOG"|provider-request|sourceMappingURL/, file);
  }
  assert.equal(JSON.parse(readFileSync('dist/manifest.json', 'utf8')).name, 'OwnYourTimeline');
});
