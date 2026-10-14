const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const frontendFiles = ["index.html", "style.css"];
const mojibakePattern = /\u00e2(?:\u20ac|\u2020|\u0152|\u0153|\u2122|\u2014|\u2013|\u2022|\u02dc|[\u0080-\u009f])|[\u00c2\u00c3][\u0080-\u00bf]|\u00c3\u017d|\u00f0\u0178|\u00ef\u00bf\u00bd|[\u0080-\u009f]/g;

function readUtf8(relativePath) {
  const bytes = fs.readFileSync(path.join(root, relativePath));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text;
}

test("frontend source files are valid UTF-8", () => {
  for (const file of frontendFiles) assert.doesNotThrow(() => readUtf8(file), file);
});

test("HTML entry points declare UTF-8", () => {
  for (const file of ["index.html"]) {
    assert.match(readUtf8(file), /<meta\s+charset=["']utf-8["']/i, file);
  }
});

test("frontend source has no common mojibake signatures or replacement characters", () => {
  for (const file of frontendFiles) {
    const text = readUtf8(file);
    const matches = [...text.matchAll(mojibakePattern)].map(match => ({ value: match[0], offset: match.index }));
    assert.deepEqual(matches, [], `${file} contains likely mojibake`);
  }
});

