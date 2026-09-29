const assert = require('assert');
const path = require('path');
const {execFileSync} = require('child_process');
const vm = require('vm');

function runtime(input = {}) {
  return JSON.parse(execFileSync('php', [path.join(__dirname, 'stub-runtime.php')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  }));
}

const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const head = runtime().head;
const scripts = [...head.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);

function visit(query, cookie = '') {
  const document = {};
  let attributes = '';
  Object.defineProperty(document, 'cookie', {
    get: () => cookie,
    set: value => {
      assert(Buffer.byteLength(value) < 4096, `Campaign cookie is ${Buffer.byteLength(value)} bytes, over the browser size limit`);
      attributes = value;
      cookie = value.split(';')[0];
    },
  });
  const context = {document, window: {location: {search: query, protocol: 'https:'}}, URLSearchParams};
  // No jQuery, DOM-ready event, or third-party scripts are available.
  scripts.forEach(script => vm.runInNewContext(script, context));
  return {cookie, attributes};
}

const tests = [
  ['captures before any deferred script or DOM-ready', () => {
    const result = visit('?utm_source=manual_test&utm_medium=qa&utm_campaign=session_sticky_test');
    assert(result.cookie.startsWith('gf_utm_attribution='), 'No campaign cookie captured in the page head');
    assert(result.attributes.includes('Secure'));
    assert(result.attributes.includes('SameSite=Lax'));
    assert(!/expires|max-age/i.test(result.attributes), 'Must remain a session cookie');
  }],
  ['preserves the first campaign across untagged and retagged pages', () => {
    const first = visit('?utm_source=first').cookie;
    assert(first, 'First campaign was not captured');
    assert.strictEqual(visit('', first).cookie, first);
    assert.strictEqual(visit('?utm_source=second', first).cookie, first);
    assert.strictEqual(visit('').cookie, '');
  }],
  ['passes all five campaign values through the registered Gravity Forms callbacks', () => {
    const campaign = {utm_source: 'manual_test', utm_medium: 'qa', utm_campaign: 'session_sticky_test', utm_term: 'estate planning', utm_content: '0'};
    const cookie = visit('?' + new URLSearchParams(campaign)).cookie.split('=').slice(1).join('=');
    assert.deepStrictEqual(runtime({cookie}).values, campaign);
  }],
  ['does not overwrite existing attribution when an entry is edited', () => {
    const entry = {id: 123, utm_source: 'original', utm_medium: '', utm_campaign: 'first', utm_term: '', utm_content: ''};
    const expected = Object.assign({}, entry);
    delete expected.id;
    assert.deepStrictEqual(runtime({entry}).values, expected);
    assert.deepStrictEqual(runtime({entry, cookie: encodeURIComponent(JSON.stringify({utm_source: 'admin', utm_medium: 'admin'}))}).values, expected);
  }],
  ['stores empty values, not "0", when an edited entry has no UTM meta rows', () => {
    // Gravity Forms reloads the entry for an admin edit with every missing meta row set to false.
    const entry = {id: 123, utm_source: false, utm_medium: false, utm_campaign: false, utm_term: false, utm_content: false};
    const empty = {utm_source: '', utm_medium: '', utm_campaign: '', utm_term: '', utm_content: ''};
    assert.deepStrictEqual(runtime({entry}).values, empty);
    assert.deepStrictEqual(runtime({entry, cookie: encodeURIComponent(JSON.stringify({utm_source: 'admin'}))}).values, empty);
    assert.strictEqual(runtime({entry: {id: 123, utm_content: '0'}}).values.utm_content, '0');
  }],
  ['ignores malformed cookie input rather than breaking form processing', () => {
    for (const cookie of [null, 'not-json', [], {bad: 'cookie'}]) {
      assert(Object.values(runtime({cookie}).values).every(value => value === ''));
    }
  }],
  ['bounds encoded Unicode cookies and stores valid Unicode', () => {
    const campaign = Object.fromEntries(utmKeys.map(key => [key, '\u4e2d'.repeat(200)]));
    const cookie = visit('?' + new URLSearchParams(campaign)).cookie.split('=').slice(1).join('=');
    const values = runtime({cookie}).values;
    assert(Object.values(values).every(value => value.length > 0 && !value.includes('\ufffd')));
  }],
  ['bounds cookies of double quotes, which JSON escaping doubles', () => {
    const campaign = Object.fromEntries(utmKeys.map(key => [key, '"'.repeat(200)]));
    const cookie = visit('?' + new URLSearchParams(campaign)).cookie.split('=').slice(1).join('=');
    const values = runtime({cookie}).values;
    assert(Object.values(values).every(value => value.length > 0 && value === '"'.repeat(value.length)), JSON.stringify(values));
  }],
  ['bounds cookies of backslashes, which JSON escaping doubles', () => {
    const campaign = Object.fromEntries(utmKeys.map(key => [key, '\\'.repeat(200)]));
    const cookie = visit('?' + new URLSearchParams(campaign)).cookie.split('=').slice(1).join('=');
    const values = runtime({cookie}).values;
    assert(Object.values(values).every(value => value.length > 0 && value === '\\'.repeat(value.length)), JSON.stringify(values));
  }],
  ['prints no capture script when Gravity Forms is not active', () => {
    assert(scripts.length > 0, 'Capture script missing when Gravity Forms is active');
    assert.strictEqual(runtime({gravity_forms_active: false}).head, '');
  }],
  ['lists the five entry meta merge tags in the Gravity Forms merge tag picker', () => {
    assert.deepStrictEqual(runtime().merge_tags, [
      {tag: '{entry:utm_source}', label: 'UTM Source'},
      {tag: '{entry:utm_medium}', label: 'UTM Medium'},
      {tag: '{entry:utm_campaign}', label: 'UTM Campaign'},
      {tag: '{entry:utm_term}', label: 'UTM Term'},
      {tag: '{entry:utm_content}', label: 'UTM Content'},
    ]);
  }],
];

let failures = 0;
for (const [name, test] of tests) {
  try {
    test();
    console.log('PASS ' + name);
  } catch (error) {
    failures++;
    console.error('FAIL ' + name + '\n' + error.message);
  }
}
process.exitCode = failures ? 1 : 0;
