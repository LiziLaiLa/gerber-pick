import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {zipSync, strToU8} from 'fflate';
import {ImportError, LIMITS, unpackFiles, parseBom, parsePlacements, inspectTables, importBoard, projectPoint} from '../src/importer.js';

const require = createRequire(import.meta.url);
const renderer = require('pcb-stackup');
const directory = new URL('../fixtures/', import.meta.url);
const demoEntries = await Promise.all((await readdir(directory)).filter(n => n.startsWith('demo-')).map(async name => ({name, text: await readFile(new URL(name, directory), 'utf8')})));
const gerbers = demoEntries.filter(e => !e.name.endsWith('.csv'));
const errorCode = code => error => error instanceof ImportError && error.code === code;
const file = (name, contents) => {
  const bytes = typeof contents === 'string' ? strToU8(contents) : contents;
  return {name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const stubRenderer = async layers => ({top: {svg: '<svg/>', units: 'mm', viewBox: [0, 0, 40000, 30000]}, bottom: {svg: '<svg/>', units: 'mm', viewBox: [0, 0, 40000, 30000]}, layers});

test('synthetic public fixture renders with real stable pcb-stackup and joins all BOM positions', async () => {
  const board = await importBoard(demoEntries, renderer);
  assert.equal(board.components.length, 5);
  assert.equal(board.groups.length, 4);
  assert.equal(board.groups.reduce((n, g) => n + g.quantity, 0), 5);
  assert.deepEqual(board.dataIssues, []);
  assert.equal(board.layers.length, 8);
  assert.ok(board.layers.every(l => l.type !== 'unknown'));
  assert.equal(board.boundsMm.width, 40);
  assert.equal(board.boundsMm.height, 30);
  const resistors = board.groups.find(g => g.value === '10k');
  assert.deepEqual(resistors.refs, ['R1', 'R2']);
  assert.equal(resistors.top, 2);
  assert.equal(board.groups.find(g => g.refs.includes('D1')).dnp, true);
  assert.equal(board.attributeEvidence.length, 5);
  const c = board.components.find(c => c.ref === 'C1');
  assert.deepEqual(projectPoint(c, board.views.bottom), {x: 25000, y: 10000, u: 0.625, v: 1 / 3});
});

function outline(x, y, units = 'MM') {
  const p = (x, y) => `X${Math.round(x * 1e6)}Y${Math.round(y * 1e6)}`;
  return `%FSLAX46Y46*%\n%MO${units}*%\n%TF.FileFunction,Profile,NP*%\n%ADD10C,0.1*%\nD10*\n${p(x, y)}D02*\n${p(x + 40, y)}D01*\n${p(x + 40, y + 30)}D01*\n${p(x, y + 30)}D01*\n${p(x, y)}D01*\nM02*`;
}

for (const [label, x, y] of [['positive origin', 10, 20], ['negative origin', -30, -20]]) {
  test(`official SVG transforms and overlay agree for ${label}, on both board faces`, async () => {
    const b = await importBoard([{name: 'synthetic.gko', text: outline(x, y)}], renderer);
    assert.deepEqual(b.views.top.viewBox, [x * 1000, y * 1000, 40000, 30000]);
    assert.ok(b.topSvg.includes(`translate(0,${(2 * y + 30) * 1000}) scale(1,-1)`));
    assert.ok(b.bottomSvg.includes(`translate(${(2 * x + 40) * 1000},0) scale(-1,1)`));
    const c = {xMm: x + 5, yMm: y + 5, placed: true};
    const top = projectPoint(c, b.views.top), bottom = projectPoint(c, b.views.bottom);
    // These fractions come from the invented rectangle, independently of renderer box math.
    near(top.u, 5 / 40); near(top.v, 25 / 30);
    near(bottom.u, 35 / 40); near(bottom.v, 25 / 30);
    near(top.x, (x + 5) * 1000); near(top.y, (y + 25) * 1000);
  });
}

test('inch Gerber render units are respected rather than assumed millimetres', async () => {
  const b = await importBoard([{name: 'inch.gko', text: outline(-1, 2, 'IN')}], renderer);
  const p = projectPoint({xMm: 4 * 25.4, yMm: 7 * 25.4}, b.views.bottom);
  near(p.u, 35 / 40); near(p.v, 25 / 30);
  near(b.boundsMm.width, 40 * 25.4);
});

test('Gerber-only import shows artwork without fabricating BOM or component centers', async () => {
  const b = await importBoard(gerbers, renderer);
  assert.ok(b.topSvg.startsWith('<svg'));
  assert.deepEqual(b.components, []);
  assert.deepEqual(b.groups, []);
  assert.equal(b.attributeEvidence.length, 5);
  assert.ok(b.warnings.some(w => w.includes('No usable BOM')));
  assert.ok(b.warnings.some(w => w.includes('not treated as component centers')));
});

test('BOM supports Chinese/TSV aliases, ranges, DNP and quantity mismatch evidence', () => {
  const b = parseBom('位号\t参数\t封装\t制造商料号\t数量\t不贴\nR1-R3\t10k\t0603\tSYN-R\t4\t是\n');
  assert.deepEqual(b.rows[0].refs, ['R1', 'R2', 'R3']);
  assert.equal(b.rows[0].mpn, 'SYN-R');
  assert.equal(b.rows[0].dnp, true);
  assert.equal(b.warnings.length, 1);
});

test('fitted column has inverse meaning from DNP', () => {
  const b = parseBom('Ref,Value,Footprint,Fitted\nR1,10k,0603,Yes\nR2,10k,0603,No');
  assert.equal(b.rows[0].dnp, false);
  assert.equal(b.rows[1].dnp, true);
});

test('ambiguous headers require explicit mapping and preserve literal text values', () => {
  const text = 'Reference,Value,Comment,Package\nR1,<img src=x onerror=alert(1)>,10k,0603';
  assert.throws(() => parseBom(text), errorCode('AMBIGUOUS_COLUMN'));
  const b = parseBom(text, {mapping: {value: 'Comment'}});
  assert.equal(b.rows[0].value, '10k');
  assert.equal(parseBom(text, {mapping: {value: 'Value'}}).rows[0].value, '<img src=x onerror=alert(1)>');
});

test('duplicate refs, malformed rows and empty tables fail with specific errors', () => {
  assert.throws(() => parseBom('Ref,Value\nR1,1\nr1,1'), errorCode('DUPLICATE_REFERENCE'));
  assert.throws(() => parseBom('Ref,Value\nR1,1,extra'), errorCode('ROW_COLUMN_COUNT'));
  assert.throws(() => parseBom(''), errorCode('EMPTY_TABLE'));
  assert.throws(() => parseBom('Ref,Ref\nR1,R2'), errorCode('DUPLICATE_HEADER'));
  assert.throws(() => parseBom('Anything,Else\na,b'), errorCode('MISSING_COLUMN'));
});

test('JLC row suffixes, Chinese headers, mm/inch/mil and signed coordinates', () => {
  const p = parsePlacements('位号,中心X,中心Y,层,角度\nR1,-1in,100mil,Top,90\nC1,25.4mm,-2mm,Bottom,180');
  near(p.rows[0].xMm, -25.4); near(p.rows[0].yMm, 2.54);
  near(p.rows[1].xMm, 25.4); near(p.rows[1].yMm, -2);
  assert.equal(p.rows[1].side, 'bottom');
});

test('semicolon/decimal-comma coordinates and unit headers', () => {
  const p = parsePlacements('Ref;X (mm);Y (mm);Side\nR1;1,5;-2,25;Front');
  near(p.rows[0].xMm, 1.5); near(p.rows[0].yMm, -2.25);
});

test('KiCad .pos headers/preamble supply units and side', async () => {
  const p = parsePlacements(await readFile(new URL('kicad-sample.pos', directory), 'utf8'));
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].value, '10k');
  assert.equal(p.rows[2].side, 'bottom');
  near(p.rows[2].yMm, 20);
});

test('missing units/side and malformed coordinates are not guessed', () => {
  assert.throws(() => parsePlacements('Ref,X,Y,Side\nR1,1,2,Top'), errorCode('MISSING_UNITS'));
  assert.throws(() => parsePlacements('Ref,X,Y\nR1,1,2', {units: 'mm'}), errorCode('MISSING_SIDE'));
  assert.throws(() => parsePlacements('Ref,X,Y,Side\nR1,NaN,2,Top', {units: 'mm'}), errorCode('INVALID_COORDINATE'));
  assert.throws(() => parsePlacements('Ref,X,Y,Side\nR1,1,2,unknown', {units: 'mm'}), errorCode('INVALID_SIDE'));
  const p = parsePlacements('Ref,X,Y\nR1,1,2', {units: 'mm', side: 'top'});
  near(p.rows[0].xMm, 1);
});

test('mapping/offset/axis/bottom-unmirror are explicit and deterministic', () => {
  const p = parsePlacements('ID,Horizontal,Vertical,Face\nR1,8,2,B', {mapping: {ref: 'ID', x: 'Horizontal', y: 'Vertical', side: 'Face'}, units: 'mm', bottomXMirrored: true, mirrorOriginXmm: 10, offsetXmm: -3, offsetYmm: 4, yAxis: 'down'});
  near(p.rows[0].xMm, 9); near(p.rows[0].yMm, 2);
  assert.equal(p.rows[0].side, 'bottom');
});

test('broken placement table does not suppress Gerber artwork and offers mapping details', async () => {
  const b = await importBoard([...gerbers, {name: 'my-cpl.csv', text: 'Ref,X,Y,Side\nR1,1,2,Top'}], stubRenderer);
  assert.equal(b.topSvg, '<svg/>');
  assert.equal(b.dataIssues[0].code, 'MISSING_UNITS');
  assert.equal(b.dataIssues[0].name, 'my-cpl.csv');
  assert.deepEqual(b.tableInfo.placement.headers, ['Ref', 'X', 'Y', 'Side']);
  const fixed = await importBoard([...gerbers, {name: 'my-cpl.csv', text: 'Ref,X,Y,Side\nR1,1,2,Top'}], stubRenderer, {placementOptions: {units: 'mm'}});
  assert.equal(fixed.components.length, 1);
  assert.deepEqual(fixed.dataIssues, []);
});

test('header role wins over misleading filename and multiple placement tables require selection', async () => {
  const cpl = 'Ref,X (mm),Y (mm),Side\nR1,1,2,top';
  assert.equal(inspectTables([{name: 'misleading-bom.csv', text: cpl}])[0].kind, 'placement');
  const entries = [...gerbers, {name: 'first.csv', text: cpl}, {name: 'second.csv', text: cpl}];
  const b = await importBoard(entries, stubRenderer);
  assert.equal(b.dataIssues[0].code, 'MULTIPLE_TABLES');
  assert.equal(b.components.length, 0);
  const fixed = await importBoard(entries, stubRenderer, {placementName: 'second.csv'});
  assert.equal(fixed.components[0].ref, 'R1');
});

test('CPL-only groups with no material identity remain separate; BOM-only refs stay unplaced', async () => {
  const b = await importBoard([...gerbers, {name: 'positions.csv', text: 'Ref,X (mm),Y (mm),Side\nR1,1,2,Top\nR2,3,4,Top'}], stubRenderer);
  assert.equal(b.groups.length, 2);
  assert.ok(b.groups.every(g => g.unknown));
  const bomOnly = await importBoard([...gerbers, demoEntries.find(e => e.name.endsWith('bom.csv'))], stubRenderer);
  assert.equal(bomOnly.components.length, 5);
  assert.ok(bomOnly.components.every(c => !c.placed && c.xMm === null));
  assert.equal(projectPoint(bomOnly.components[0], bomOnly.views.top), null);
});

test('out-of-bounds placement warns and retains exact source coordinates', async () => {
  const b = await importBoard([...gerbers, {name: 'cpl.csv', text: 'Ref,X (mm),Y (mm),Side\nR1,-100,2,Top'}], stubRenderer);
  assert.equal(b.components[0].xMm, -100);
  assert.ok(b.warnings.some(w => w.includes('outside the Gerber bounds')));
});

test('scatter files and ZIP unpack identically without network or filesystem writes', async () => {
  const files = demoEntries.map(e => file(e.name, e.text));
  const unzipped = await unpackFiles([file('demo.zip', zipSync(Object.fromEntries(demoEntries.map(e => [e.name, strToU8(e.text)]))))]);
  const scattered = await unpackFiles(files);
  assert.deepEqual(unzipped.sort((a,b) => a.name.localeCompare(b.name)), scattered.sort((a,b) => a.name.localeCompare(b.name)));
  const b = await importBoard(unzipped, stubRenderer);
  assert.equal(b.components.length, 5);
});

test('ZIP protects against traversal, duplicate normalized names, encryption and truncated input', async () => {
  await assert.rejects(unpackFiles([file('bad.zip', zipSync({'../bad.gtl': strToU8('x')}))]), errorCode('UNSAFE_PATH'));
  await assert.rejects(unpackFiles([file('bad.zip', zipSync({'a.gtl': strToU8('x'), 'A.gtl': strToU8('y')}))]), errorCode('DUPLICATE_FILE'));
  const bytes = zipSync({'demo.gtl': strToU8('text')}, {level: 0});
  const v = new DataView(bytes.buffer);
  const central = bytes.findIndex((_, i) => i + 4 < bytes.length && v.getUint32(i, true) === 0x02014b50);
  v.setUint16(central + 8, 1, true);
  await assert.rejects(unpackFiles([file('encrypted.zip', bytes)]), errorCode('UNSUPPORTED_ZIP'));
  await assert.rejects(unpackFiles([file('bad.zip', strToU8('not zip'))]), errorCode('INVALID_ZIP'));
});

test('ZIP expansion/entry and scatter size limits are checked before inflation/reading', async () => {
  await assert.rejects(unpackFiles([file('bomb.zip', zipSync({'large.txt': new Uint8Array(200000)}))]), errorCode('ZIP_EXPANSION_LIMIT'));
  await assert.rejects(unpackFiles([file('many.zip', zipSync(Object.fromEntries(Array.from({length: 501}, (_, i) => [i + '.gbr', strToU8('x')]))))]), errorCode('ZIP_ENTRY_LIMIT'));
  let read = false;
  await assert.rejects(unpackFiles([{name: 'huge.gbr', size: LIMITS.fileBytes + 1, arrayBuffer: async () => {read = true;}}]), errorCode('FILE_SIZE_LIMIT'));
  assert.equal(read, false);
});

test('Gerber archive can carry ignored binary previews without rejecting fabrication layers', async () => {
  const zip = zipSync({'demo.gtl': strToU8(demoEntries.find(e => e.name.endsWith('.gtl')).text), 'preview.png': new Uint8Array([137,80,78,71,0,1])});
  const entries = await unpackFiles([file('with-preview.zip', zip)]);
  assert.deepEqual(entries.map(e => e.name), ['demo.gtl']);
});

test('X3 component metadata is not advertised as full placement support', async () => {
  const x3 = '%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Component,L1,Top*%\n%TO.C,R9*%\nM02*';
  const b = await importBoard([...gerbers, {name: 'component.gbr', text: x3}], stubRenderer);
  assert.ok(b.warnings.some(w => w.includes('X3 component layer metadata is not fully supported')));
  assert.equal(b.components.length, 0);
});

test('different output units across board faces are rejected rather than misaligned', async () => {
  const mixed = async layers => {
    const r = await stubRenderer(layers); r.bottom.units = 'in'; return r;
  };
  await assert.rejects(importBoard(gerbers, mixed), errorCode('MIXED_RENDER_UNITS'));
});

test('EasyEDA name/manufacturer/supplier columns and padded ranges are supported', () => {
  const b = parseBom('Designator,Name,Footprint,Manufacturer Part,LCSC Part #\nR001-R003,10k,0603,SYN-R,SYN-SUPPLIER');
  assert.deepEqual(b.rows[0].refs, ['R001', 'R002', 'R003']);
  assert.equal(b.rows[0].mpn, 'SYN-R');
  assert.equal(b.rows[0].supplierPart, 'SYN-SUPPLIER');
});

test('explicit null mapping disables a column instead of silently auto-detecting it again', () => {
  const b = parseBom('Ref,Value,Footprint,DNP\nR1,10k,0603,Yes', {mapping: {dnp: null}});
  assert.equal(b.rows[0].dnp, false);
  assert.equal(b.mapping.dnp, undefined);
  const p = parsePlacements('Ref,X,Y,Rotation,Side\nR1,1,2,90,Bottom', {units: 'mm', side: 'top', mapping: {rotation: null, side: null}});
  assert.equal(p.rows[0].rotation, 0);
  assert.equal(p.rows[0].side, 'top');
  assert.throws(() => parseBom('Ref,Value\nR1,10k', {mapping: {refs: null}}), errorCode('MISSING_COLUMN'));
});

test('unknown-header CSV remains available for explicit table and column mapping', async () => {
  const entries = [...gerbers, {name: 'data.csv', text: 'ID,Horizontal,Vertical,Face\nR1,1,2,T'}];
  assert.equal(inspectTables(entries).find(t => t.name === 'data.csv').kind, 'unknown');
  const b = await importBoard(entries, stubRenderer, {placementName: 'data.csv', placementOptions: {units: 'mm', mapping: {ref: 'ID', x: 'Horizontal', y: 'Vertical', side: 'Face'}}});
  assert.equal(b.components[0].ref, 'R1');
  assert.deepEqual(b.dataIssues, []);
});
