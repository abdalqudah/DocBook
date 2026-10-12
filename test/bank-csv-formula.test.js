// Bank-transfer files are opened in spreadsheets: a payee name or note that starts like a formula must reach the file
// as text, while ordinary values — negative amounts included — are written unchanged.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell } = require('../src/modules/payouts/bank.service');

test('formula-like cells are neutralised, numbers and text kept', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")', ','), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1+cmd', ','), "'+1+cmd");
  assert.equal(csvCell('@SUM(A1)', ';'), "'@SUM(A1)");
  assert.equal(csvCell('-2+3', ','), "'-2+3");
  assert.equal(csvCell('\tx', ','), "'\tx");
  assert.equal(csvCell('-125.50', ','), '-125.50');
  assert.equal(csvCell('125.50', ','), '125.50');
  assert.equal(csvCell('Ahmad Ali', ','), 'Ahmad Ali');
  assert.equal(csvCell('a,b', ','), '"a,b"');
});
