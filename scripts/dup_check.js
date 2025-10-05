const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'data', 'linkedin.json');
const raw = fs.readFileSync(file, 'utf8');
const items = JSON.parse(raw);

function canonicalUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (e) {
    return u.split('?')[0].split('#')[0];
  }
}

function normalizeText(s) {
  if (!s) return '';
  return s
    .toString()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const byUrl = new Map();
const byCanonicalUrl = new Map();
const byTitleEmployer = new Map();

items.forEach((it, idx) => {
  const url = it.url || '';
  const can = canonicalUrl(url);
  if (!byUrl.has(url)) byUrl.set(url, []);
  byUrl.get(url).push({ idx, item: it });
  if (!byCanonicalUrl.has(can)) byCanonicalUrl.set(can, []);
  byCanonicalUrl.get(can).push({ idx, item: it });

  const key = normalizeText((it.title || '') + '|' + (it.employer || ''));
  if (!byTitleEmployer.has(key)) byTitleEmployer.set(key, []);
  byTitleEmployer.get(key).push({ idx, item: it });
});

function groupsWithDuplicates(map) {
  const out = [];
  for (const [k, v] of map.entries()) {
    if (v.length > 1) out.push({ key: k, count: v.length, examples: v.slice(0, 5) });
  }
  return out.sort((a, b) => b.count - a.count);
}

const dupByUrl = groupsWithDuplicates(byUrl);
const dupByCanonicalUrl = groupsWithDuplicates(byCanonicalUrl);
const dupByTitleEmployer = groupsWithDuplicates(byTitleEmployer);

console.log('Total items:', items.length);
console.log('Unique exact URLs:', byUrl.size);
console.log('Unique canonical URLs (no query):', byCanonicalUrl.size);
console.log('Unique title|employer:', byTitleEmployer.size);
console.log('---');
console.log('Duplicate groups (exact URL):', dupByUrl.length);
dupByUrl.slice(0, 10).forEach(g => {
  console.log(`- ${g.count} items with exact URL: ${g.key}`);
});
console.log('---');
console.log('Duplicate groups (canonical URL):', dupByCanonicalUrl.length);
dupByCanonicalUrl.slice(0, 20).forEach(g => {
  console.log(`- ${g.count} items with canonical URL: ${g.key}`);
});
console.log('---');
console.log('Duplicate groups (title|employer):', dupByTitleEmployer.length);
dupByTitleEmployer.slice(0, 20).forEach(g => {
  const display = g.key.length > 80 ? g.key.slice(0, 80) + '...' : g.key;
  console.log(`- ${g.count} items with title|employer key: ${display}`);
});

// Print details for groups if requested via env var
if (process.env.SHOW_DETAILS === '1') {
  console.log('\nDetails for canonical URL duplicates:');
  dupByCanonicalUrl.forEach(g => {
    console.log('\nGROUP FOR CANONICAL URL:', g.key, 'COUNT:', g.count);
    g.examples.forEach(e => console.log('  idx=', e.idx, JSON.stringify(e.item)));
  });
}

// Exit with summary code
process.exit(0);
