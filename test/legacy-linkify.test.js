// Links in text from the old system: the name is the link; an imported file opens here; the rest stays escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const { linkify, localFinder } = require('../src/modules/legacy/linkify');
const promote = require('../src/modules/legacy/promote.service');

test('a link shows its name, opens the imported copy when there is one, text stays escaped', () => {
  const find = localFinder(7, [{ id: 3, source_url: 'https://old.example/files/2019/2253/a.pdf', inline: true }]);
  const html = linkify('كميل وائل عمارين.pdf https://old.example/files/2019/2253/a.pdf\n* صورة أوضح.pdf https://old.example/files/2020/b%20c.pdf\n<script>', find);
  assert.match(html, /<a class="link" href="\/api\/patients\/7\/attachments\/3\/download\?inline=1"[^>]*>كميل وائل عمارين\.pdf<\/a>/);
  assert.match(html, /href="https:\/\/old\.example\/files\/2020\/b%20c\.pdf"[^>]*>صورة أوضح\.pdf<\/a>/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  assert.match(linkify('https://old.example/x/%D9%83.pdf'), />ك\.pdf</, 'no name → the file name of the address');
  assert.equal(linkify('just text'), 'just text');
});

test('treatment status, tooth and doctor names', () => {
  assert.equal(promote.statusOf({ status: 'Done' }), 'done');
  assert.equal(promote.statusOf({ status: 'منجز' }), 'done');
  assert.equal(promote.statusOf({ status: '', complete_date: '2023-01-02' }), 'done');
  assert.equal(promote.statusOf({ status: 'Cancelled' }), 'cancelled');
  assert.equal(promote.statusOf({ status: 'Planned' }), 'planned');
  assert.equal(promote.toothOf('16'), 16); assert.equal(promote.toothOf('85'), 85); assert.equal(promote.toothOf('19'), null); assert.equal(promote.toothOf('11-21'), null);
  assert.equal(promote.docKey('د. خالد'), promote.docKey('دكتور خالد'));
  assert.equal(promote.docKey('Dr. Rana'), promote.docKey('rana'));
});
