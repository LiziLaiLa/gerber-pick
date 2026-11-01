import Papa from 'papaparse';
import {unzipSync} from 'fflate';

export const LIMITS = Object.freeze({fileBytes: 10 * 1024 * 1024, inputBytes: 20 * 1024 * 1024, expandedBytes: 50 * 1024 * 1024, entries: 500, ratio: 200});
export class ImportError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ImportError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new ImportError(code, message, details); };
const normalize = s => String(s ?? '').replace(/^\uFEFF/, '').toLowerCase().replace(/[\s_\-().\[\]（）\/#]/g, '');
const cleanName = name => {
  name = String(name).replaceAll('\\', '/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\x00-\x1f]/.test(name) || name.split('/').includes('..')) fail('UNSAFE_PATH', `Unsafe archive filename: ${name}`);
  return name.replace(/^\.\//, '');
};

// Inspect the central directory before fflate allocates any decompressed entry.
function inspectZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (v.getUint32(p, true) === 0x06054b50 && p + 22 + v.getUint16(p + 20, true) === bytes.length) { eocd = p; break; }
  }
  if (eocd < 0) fail('INVALID_ZIP', 'ZIP end directory is missing or truncated.');
  const count = v.getUint16(eocd + 10, true), size = v.getUint32(eocd + 12, true), start = v.getUint32(eocd + 16, true);
  if (v.getUint16(eocd + 4, true) || v.getUint16(eocd + 6, true) || count !== v.getUint16(eocd + 8, true)) fail('UNSUPPORTED_ZIP', 'Multi-disk ZIP files are not supported.');
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) fail('UNSUPPORTED_ZIP', 'ZIP64 archives are not supported.');
  if (count > LIMITS.entries) fail('ZIP_ENTRY_LIMIT', `ZIP contains ${count} entries; limit is ${LIMITS.entries}.`);
  if (start + size > eocd) fail('INVALID_ZIP', 'ZIP directory extends beyond the archive.');
  let p = start, expanded = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (p + 46 > start + size || v.getUint32(p, true) !== 0x02014b50) fail('INVALID_ZIP', 'ZIP directory entry is invalid.');
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), packed = v.getUint32(p + 20, true), unpacked = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    if (p + 46 + nl + el + cl > start + size) fail('INVALID_ZIP', 'ZIP filename or extra field is truncated.');
    if ((flags & 1) || ![0, 8].includes(method)) fail('UNSUPPORTED_ZIP', 'Encrypted ZIP entries and compression methods other than store/deflate are not supported.');
    if (packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff) fail('UNSUPPORTED_ZIP', 'ZIP64 entries are not supported.');
    if (local + 30 > start || v.getUint32(local, true) !== 0x04034b50) fail('INVALID_ZIP', 'ZIP local entry is invalid.');
    const localName = v.getUint16(local + 26, true), localExtra = v.getUint16(local + 28, true);
    if (local + 30 + localName + localExtra + packed > start) fail('INVALID_ZIP', 'ZIP compressed entry extends into the directory.');
    const name = cleanName(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl)));
    if (names.has(name.toLowerCase())) fail('DUPLICATE_FILE', `Duplicate ZIP filename: ${name}`);
    names.add(name.toLowerCase());
    if (unpacked > LIMITS.fileBytes || unpacked / Math.max(1, packed) > LIMITS.ratio) fail('ZIP_EXPANSION_LIMIT', `ZIP entry exceeds size or expansion-ratio limit: ${name}`);
    expanded += unpacked;
    if (expanded > LIMITS.expandedBytes) fail('ZIP_EXPANSION_LIMIT', 'ZIP expanded data exceeds 50 MiB.');
    p += 46 + nl + el + cl;
  }
  if (p !== start + size) fail('INVALID_ZIP', 'ZIP directory size does not match its entries.');
  return {count, expanded};
}

function decode(bytes, name) {
  if (bytes.includes(0)) fail('BINARY_FILE', `Expected a text Gerber, drill or CSV file: ${name}`);
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch {
    try { return new TextDecoder('gb18030', {fatal: true}).decode(bytes); }
    catch { fail('TEXT_ENCODING', `Cannot decode ${name}; export it as UTF-8 text.`); }
  }
}

export async function unpackFiles(files) {
  files = Array.from(files || []);
  if (!files.length) fail('NO_FILES', 'Choose Gerber/drill files or a ZIP archive.');
  if (files.length > LIMITS.entries) fail('FILE_COUNT_LIMIT', 'More than 500 input files.');
  let input = 0, expanded = 0, count = 0;
  const entries = [], seen = new Set();
  function add(name, bytes) {
    name = cleanName(name);
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop().startsWith('.')) return;
    // Manufacturing archives may contain preview images or CAD models; they are not inputs.
    if (/\.(png|jpe?g|gif|webp|bmp|pdf|step|stp|stl|3mf|exe|dll|woff2?|ttf)$/i.test(name)) return;
    if (bytes.length > LIMITS.fileBytes) fail('FILE_SIZE_LIMIT', `File exceeds 10 MiB: ${name}`);
    expanded += bytes.length;
    if (expanded > LIMITS.expandedBytes) fail('EXPANDED_SIZE_LIMIT', 'Combined expanded input exceeds 50 MiB.');
    if (seen.has(name.toLowerCase())) fail('DUPLICATE_FILE', `Duplicate imported filename: ${name}`);
    seen.add(name.toLowerCase());
    entries.push({name, text: decode(bytes, name)});
  }
  for (const file of files) {
    const declared = Number(file.size ?? 0);
    if (declared > LIMITS.inputBytes || (!/\.zip$/i.test(file.name) && declared > LIMITS.fileBytes)) fail('FILE_SIZE_LIMIT', `Input file is too large: ${file.name}`);
    input += declared;
    if (input > LIMITS.inputBytes) fail('INPUT_SIZE_LIMIT', 'Combined input exceeds 20 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    input += bytes.length - declared;
    if (input > LIMITS.inputBytes || bytes.length > LIMITS.inputBytes) fail('INPUT_SIZE_LIMIT', 'Combined input exceeds 20 MiB.');
    if (/\.zip$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      const zip = inspectZip(bytes);
      count += zip.count;
      if (count > LIMITS.entries || expanded + zip.expanded > LIMITS.expandedBytes) fail('ZIP_EXPANSION_LIMIT', 'Combined ZIP inputs exceed entry or expanded-size limits.');
      let unzipped;
      try { unzipped = unzipSync(bytes); }
      catch (error) { fail('INVALID_ZIP', `Cannot decompress ${file.name}: ${error.message}`); }
      for (const [name, content] of Object.entries(unzipped)) add(name, content);
    } else {
      count++;
      if (count > LIMITS.entries) fail('FILE_COUNT_LIMIT', 'Combined input exceeds 500 entries.');
      add(file.name, bytes);
    }
  }
  return entries;
}

const ALIASES = {
  refs: ['references', 'reference', 'ref', 'refs', 'designator', 'designators', 'component', 'components', '位号', '元件位号', '元器件位号', '标号', '元件标号'],
  value: ['value', 'val', 'name', 'comment', '值', '参数', '规格', '型号', '名称', '元件值'],
  footprint: ['footprint', 'package', 'pattern', '封装', '封装名称'],
  mpn: ['mpn', 'manufacturerpartnumber', 'manufacturerpart', '制造商料号', '制造商型号', '厂商型号', '厂家型号'],
  supplierPart: ['lcsc', 'lcscpart', 'lcscpartnumber', 'supplierpart', 'supplierpartnumber', 'jlcpcbpart', '嘉立创编号', '立创编号', '立创料号', '供应商料号', '料号'],
  dnp: ['dnp', 'dnf', 'donotpopulate', 'donotfit', 'exclude', '不贴', '不焊', '不装配', 'populate', 'fitted', '装配'],
  quantity: ['quantity', 'qty', 'count', '数量', '用量'],
  x: ['midx', 'centerx', 'centrex', 'posx', 'positionx', 'x', 'x坐标', '坐标x', '中心x', '中心坐标x', '中心x坐标'],
  y: ['midy', 'centery', 'centrey', 'posy', 'positiony', 'y', 'y坐标', '坐标y', '中心y', '中心坐标y', '中心y坐标'],
  rotation: ['rotation', 'rot', 'angle', '旋转', '旋转角度', '角度'],
  side: ['side', 'layer', 'board side', '面', '层', '层别', '板面', '所在层'],
};
const headerBase = h => normalize(h).replace(/(?:millimeters?|millimetres?|inches|inch|mils?|mm|in)$/i, '');
const headerUnit = h => { const m = String(h).match(/(?:\(|\[|（|\s|_)(mm|mil|in|inch|inches)(?:\)|\]|）|\s)*$/i); return m?.[1]; };
const unitScale = units => {
  const name = String(units ?? '').trim().toLowerCase();
  if (['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'].includes(name)) return 1;
  if (['in', 'inch', 'inches', '"'].includes(name)) return 25.4;
  if (['mil', 'mils'].includes(name)) return 0.0254;
  fail('UNKNOWN_UNITS', `Unknown coordinate units: ${units || '(not supplied)'}. Choose mm, inch or mil.`, {units});
};

function readTable(text, options = {}) {
  if (typeof text !== 'string' || text.length > LIMITS.fileBytes) fail('TABLE_SIZE_LIMIT', 'Table is missing or exceeds 10 MiB.');
  text = text.replace(/^\uFEFF/, '');
  const preambleUnits = text.match(/(?:units?|单位)\s*[:=]\s*(mm|mil|inches|inch|in)\b/i)?.[1];
  const lines = text.split(/\r?\n/), posHeader = lines.find(l => /^\s*#/.test(l) && /\bPosX\b/i.test(l) && /\bPosY\b/i.test(l));
  let headers, rows;
  if (posHeader && !options.delimiter) {
    headers = posHeader.replace(/^\s*#+\s*/, '').trim().split(/\s+/);
    rows = lines.filter(l => l.trim() && !/^\s*#/.test(l)).map(l => {
      const tokens = l.match(/"(?:[^"]|"")*"|\S+/g) || [];
      return tokens.map(t => t.replace(/^"|"$/g, '').replaceAll('""', '"'));
    });
  } else {
    const body = lines.filter(l => !/^\s*#/.test(l)).join('\n');
    const parsed = Papa.parse(body, {header: false, delimiter: options.delimiter || '', skipEmptyLines: 'greedy'});
    const fatal = parsed.errors.filter(e => e.code !== 'UndetectableDelimiter');
    if (fatal.length) fail('INVALID_TABLE', `CSV could not be parsed: ${fatal[0].message}`, {errors: fatal});
    [headers = [], ...rows] = parsed.data;
  }
  headers = headers.map(h => String(h).trim());
  if (!headers.length || headers.every(h => !h)) fail('EMPTY_TABLE', 'The data table has no header row.');
  if (new Set(headers.map(normalize)).size !== headers.length) fail('DUPLICATE_HEADER', 'Table has duplicate column names; rename them before import.', {headers});
  if (rows.length > 100000) fail('TABLE_ROW_LIMIT', 'Table exceeds 100,000 rows.');
  for (let i = 0; i < rows.length; i++) if (rows[i].length !== headers.length) fail('ROW_COLUMN_COUNT', `Data row ${i + 2} has ${rows[i].length} columns; expected ${headers.length}.`, {row: i + 2, headers});
  return {headers, rows, preambleUnits};
}

function resolve(headers, roles, overrides = {}, strict = true) {
  const result = {};
  for (const role of roles) {
    if (Object.hasOwn(overrides, role) && overrides[role] === null) continue;
    if (role === 'ref' && !Object.hasOwn(overrides, role) && Object.hasOwn(overrides, 'refs') && overrides.refs === null) continue;
    const mapped = overrides[role] ?? (role === 'ref' ? overrides.refs : undefined);
    if (mapped !== undefined && mapped !== null && mapped !== '') {
      const index = typeof mapped === 'number' ? mapped : headers.indexOf(mapped);
      if (!Number.isInteger(index) || index < 0 || index >= headers.length) fail('INVALID_MAPPING', `Mapped ${role} column does not exist: ${mapped}`, {role, headers});
      result[role] = index; continue;
    }
    const aliases = ALIASES[role === 'ref' ? 'refs' : role] || [];
    const matches = headers.flatMap((h, i) => aliases.includes(headerBase(h)) ? [i] : []);
    if (matches.length > 1 && strict) fail('AMBIGUOUS_COLUMN', `More than one possible ${role} column; choose one.`, {role, headers, candidates: matches.map(i => headers[i])});
    if (matches.length === 1) result[role] = matches[0];
  }
  return result;
}
const valueAt = (row, mapping, key) => mapping[key] === undefined ? '' : String(row[mapping[key]] ?? '').trim();
const publicMapping = (headers, mapping) => Object.fromEntries(Object.entries(mapping).map(([k, i]) => [k, headers[i]]));
const requireColumn = (mapping, role, headers) => { if (mapping[role] === undefined) fail('MISSING_COLUMN', `Required ${role} column was not found. Select it in column mapping.`, {role, headers}); };

function parseRefs(text, row) {
  const refs = [];
  for (const item of text.split(/[,;\s/、]+/).filter(Boolean)) {
    const range = item.match(/^([a-z_$]+)(\d+)\s*[-~]\s*\1(\d+)$/i);
    if (range) {
      const from = +range[2], to = +range[3];
      if (to < from || to - from > 1000) fail('INVALID_REF_RANGE', `Invalid reference range on row ${row}: ${item}`);
      for (let n = from; n <= to; n++) refs.push(range[1] + (range[2].startsWith('0') ? String(n).padStart(range[2].length, '0') : n));
    } else refs.push(item);
  }
  if (!refs.length) fail('MISSING_REFERENCE', `Data row ${row} has no component reference.`, {row});
  return refs;
}
function parseDnp(value, header, row) {
  if (!value) return false;
  const yes = ['1', 'yes', 'y', 'true', '是', 'dnp', 'dnf', '不贴', '不焊', '不装', '不装配', 'exclude'].includes(value.toLowerCase());
  const no = ['0', 'no', 'n', 'false', '否', 'fit', 'fitted', '装配', '贴', '焊'].includes(value.toLowerCase());
  if (!yes && !no) fail('INVALID_DNP', `Cannot interpret assembly/DNP flag on row ${row}: ${value}`, {row, value});
  return ['populate', 'fitted', '装配'].includes(normalize(header)) ? !yes : yes;
}

export function parseBom(text, options = {}) {
  const table = readTable(text, options), {headers} = table;
  const mapping = resolve(headers, ['refs', 'value', 'footprint', 'mpn', 'supplierPart', 'dnp', 'quantity'], options.mapping);
  requireColumn(mapping, 'refs', headers);
  const seen = new Set(), warnings = [];
  const rows = table.rows.map((raw, i) => {
    const refs = parseRefs(valueAt(raw, mapping, 'refs'), i + 2);
    for (const ref of refs) { if (seen.has(ref.toLowerCase())) fail('DUPLICATE_REFERENCE', `BOM reference appears more than once: ${ref}`, {row: i + 2, ref}); seen.add(ref.toLowerCase()); }
    const declared = valueAt(raw, mapping, 'quantity');
    if (declared && (!/^\d+$/.test(declared) || +declared !== refs.length)) warnings.push(`BOM row ${i + 2}: quantity ${declared} differs from ${refs.length} listed references; using the listed references.`);
    return {refs, value: valueAt(raw, mapping, 'value'), footprint: valueAt(raw, mapping, 'footprint'), mpn: valueAt(raw, mapping, 'mpn'), supplierPart: valueAt(raw, mapping, 'supplierPart'), dnp: parseDnp(valueAt(raw, mapping, 'dnp'), headers[mapping.dnp], i + 2)};
  });
  return {rows, headers, mapping: publicMapping(headers, mapping), warnings};
}

function numberValue(text, label, row, fallback = undefined) {
  if (!text && fallback !== undefined) return fallback;
  const n = Number(text.replace(',', '.'));
  if (!text || !Number.isFinite(n)) fail('INVALID_NUMBER', `${label} on row ${row} is not a finite number: ${text || '(empty)'}`, {row, value: text});
  return n;
}
function lengthMm(text, units, header, row) {
  const m = text.match(/^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*(mm|mils?|inches|inch|in|")?\s*$/i);
  if (!m) fail('INVALID_COORDINATE', `Invalid coordinate on row ${row}, column ${header}: ${text || '(empty)'}`, {row, header, value: text});
  const unit = m[2] || headerUnit(header) || units;
  if (!unit) fail('MISSING_UNITS', `Coordinate units are missing in ${header}; choose mm, inch or mil.`, {row, header});
  const n = numberValue(m[1], header, row) * unitScale(unit);
  if (Math.abs(n) > 1e6) fail('COORDINATE_RANGE', `Coordinate on row ${row} exceeds the supported ±1,000,000 mm range.`, {row, header});
  return n;
}
function sideValue(text, row) {
  const s = normalize(text);
  if (['top', 't', 'front', 'f', 'fcu', 'toplayer', '顶层', '正面', '上层', '顶面'].includes(s)) return 'top';
  if (['bottom', 'bot', 'b', 'back', 'bcu', 'bottomlayer', '底层', '背面', '反面', '下层', '底面'].includes(s)) return 'bottom';
  fail('INVALID_SIDE', `Unknown board side on row ${row}: ${text || '(empty)'}. Use top/front or bottom/back.`, {row, value: text});
}

export function parsePlacements(text, options = {}) {
  const table = readTable(text, options), {headers} = table;
  const mapping = resolve(headers, ['ref', 'x', 'y', 'rotation', 'side', 'value', 'footprint'], options.mapping);
  for (const role of ['ref', 'x', 'y']) requireColumn(mapping, role, headers);
  if (mapping.side === undefined && !options.side) fail('MISSING_SIDE', 'Placement side is missing. Map its column or choose a default board side.', {headers, role: 'side'});
  const units = options.units || table.preambleUnits;
  if (units) unitScale(units);
  const offsetX = options.offsetXmm ?? 0, offsetY = options.offsetYmm ?? 0, mirrorOrigin = options.mirrorOriginXmm ?? 0;
  if (![offsetX, offsetY, mirrorOrigin].every(Number.isFinite)) fail('INVALID_OFFSET', 'Coordinate offsets and mirror origin must be finite millimetre numbers.');
  if (options.yAxis && !['up', 'down'].includes(options.yAxis)) fail('INVALID_AXIS', 'yAxis must be up or down.');
  const seen = new Set(), warnings = [];
  const rows = table.rows.map((raw, i) => {
    const ref = valueAt(raw, mapping, 'ref'), row = i + 2;
    if (!ref || /[,;\s]/.test(ref)) fail('INVALID_REFERENCE', `Placement row ${row} must contain exactly one reference.`, {row, ref});
    if (seen.has(ref.toLowerCase())) fail('DUPLICATE_REFERENCE', `Placement reference appears more than once: ${ref}`, {row, ref});
    seen.add(ref.toLowerCase());
    const side = sideValue(valueAt(raw, mapping, 'side') || options.side, row);
    let xMm = lengthMm(valueAt(raw, mapping, 'x'), units, headers[mapping.x], row), yMm = lengthMm(valueAt(raw, mapping, 'y'), units, headers[mapping.y], row);
    if (options.bottomXMirrored && side === 'bottom') xMm = 2 * mirrorOrigin - xMm;
    if (options.yAxis === 'down') yMm *= -1;
    xMm += offsetX; yMm += offsetY;
    const rotation = numberValue(valueAt(raw, mapping, 'rotation'), 'Rotation', row, 0);
    return {ref, xMm, yMm, rotation, side, value: valueAt(raw, mapping, 'value'), footprint: valueAt(raw, mapping, 'footprint')};
  });
  if (mapping.rotation === undefined) warnings.push('No rotation column: using 0° for display only; component orientation is not verified.');
  if (options.bottomXMirrored) warnings.push(`Bottom input X coordinates were unmirrored about X=${mirrorOrigin} mm before applying offsets.`);
  if (offsetX || offsetY || options.yAxis === 'down') warnings.push(`Placement coordinates adjusted: offset (${offsetX}, ${offsetY}) mm; source Y ${options.yAxis || 'up'}.`);
  return {rows, headers, mapping: publicMapping(headers, mapping), warnings};
}

export function inspectTables(entries) {
  const result = [];
  for (const e of entries) {
    if (!/\.(csv|tsv|pos|txt)$/i.test(e.name) || /^(?:M48|%FS|G04)/.test(e.text.trimStart())) continue;
    try {
      const table = readTable(e.text), map = resolve(table.headers, ['refs', 'x', 'y', 'value', 'footprint', 'side'], {}, false);
      const byName = /(?:cpl|pnp|pick.?place|placement|\.pos$|坐标)/i.test(e.name) ? 'placement' : /(?:bom|物料)/i.test(e.name) ? 'bom' : null;
      const hasAxis = role => table.headers.some(h => ALIASES[role].includes(headerBase(h)));
      const kind = map.refs !== undefined && hasAxis('x') && hasAxis('y') ? 'placement' : map.refs !== undefined && (map.value !== undefined || map.footprint !== undefined) ? 'bom' : byName;
      if (kind || /\.(csv|tsv|pos)$/i.test(e.name)) result.push({name: e.name, kind: kind || 'unknown', headers: table.headers, mapping: publicMapping(table.headers, map)});
    } catch (error) {
      const kind = /(?:cpl|pnp|placement|\.pos$)/i.test(e.name) ? 'placement' : /bom/i.test(e.name) ? 'bom' : null;
      if (kind || /\.(csv|tsv|pos)$/i.test(e.name)) result.push({name: e.name, kind: kind || 'unknown', headers: error.details?.headers || [], mapping: {}, issue: error.message});
    }
  }
  return result;
}

function classifyLayer(entry) {
  const fn = entry.text.match(/%TF\.FileFunction,([^*]+)\*%/i)?.[1]?.split(',');
  if (fn) {
    const name = fn[0].toLowerCase(), side = fn.some(s => /^(top|front)$/i.test(s)) ? 'top' : fn.some(s => /^(bot|bottom|back)$/i.test(s)) ? 'bottom' : fn.some(s => /^inr$/i.test(s)) ? 'inner' : 'all';
    if (name === 'component') return {x3: true};
    const type = ({copper: 'copper', soldermask: 'soldermask', legend: 'silkscreen', solderpaste: 'solderpaste', paste: 'solderpaste', profile: 'outline', plated: 'drill', nonplated: 'drill'})[name];
    if (type) return {side, type};
  }
  return {};
}
function evidence(entries) {
  const refs = new Map();
  for (const e of entries) for (const m of e.text.matchAll(/%TO\.(C|P),([^*]+)\*%/g)) {
    const [ref, pin] = m[2].split(',');
    if (!ref || ref.length > 200) continue;
    if (!refs.has(ref)) refs.set(ref, {ref, pins: new Set(), files: new Set()});
    const item = refs.get(ref); item.files.add(e.name);
    if (m[1] === 'P' && pin && pin.length < 200) item.pins.add(pin);
    if (refs.size > 100000) fail('ATTRIBUTE_LIMIT', 'Gerber contains more than 100,000 component attributes.');
  }
  return [...refs.values()].map(r => ({ref: r.ref, pins: [...r.pins], files: [...r.files]}));
}

/** Map mm source coordinates to the renderer's exact (1000*render-unit) SVG space. */
export function projectPoint(component, view) {
  if (!component.placed && component.placed !== undefined) return null;
  if (![component.xMm, component.yMm].every(Number.isFinite)) return null;
  const box = view.viewBox, factor = 1000 / unitScale(view.units);
  let x = component.xMm * factor, y = component.yMm * factor;
  if (view.mirrorX) x = 2 * box[0] + box[2] - x;
  y = 2 * box[1] + box[3] - y;
  return {x, y, u: (x - box[0]) / box[2], v: (y - box[1]) / box[3]};
}

export async function importBoard(entries, renderer = globalThis.pcbStackup, options = {}) {
  if (!Array.isArray(entries) || !entries.length) fail('NO_FILES', 'No input files were provided.');
  for (const e of entries) if (!e || typeof e.name !== 'string' || typeof e.text !== 'string' || e.text.length > LIMITS.fileBytes) fail('INVALID_ENTRY', 'Each input entry must contain a filename and text content of at most 10 MiB.');
  if (entries.length > LIMITS.entries || entries.reduce((n, e) => n + e.text.length, 0) > LIMITS.expandedBytes) fail('INPUT_SIZE_LIMIT', 'Input entries exceed size/count limits.');
  if (typeof renderer !== 'function') fail('RENDERER_MISSING', 'The local pcb-stackup 4.2.8 renderer has not loaded.');
  const tables = inspectTables(entries), warnings = [], dataIssues = [], layerInputs = [];
  for (const e of entries) {
    if (tables.some(t => t.name === e.name)) continue;
    if (/%FS[LT]|%MO(?:MM|IN)|^\s*M48\b|G0?4[^\n]*Gerber/im.test(e.text) || /\.(gbr|ger|gerber|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gko|gm\d+|drl|xln|g\d+)$/i.test(e.name)) {
      const cls = classifyLayer(e);
      if (cls.x3) { warnings.push(`${e.name}: X3 component layer metadata is not fully supported; it is not used as placement data.`); continue; }
      layerInputs.push({filename: e.name, gerber: e.text, ...cls, ...options.layerOverrides?.[e.name]});
    }
  }
  if (!layerInputs.length) fail('NO_GERBER', 'No Gerber or Excellon drill layers were recognized. Import the fabrication layer files.');
  let stack;
  try { stack = await renderer(layerInputs, {id: 'gp' + Math.random().toString(36).slice(2), useOutline: true}); }
  catch (error) { fail('GERBER_RENDER', `Gerber rendering failed: ${error.message}`); }
  const views = {};
  for (const side of ['top', 'bottom']) {
    const face = stack[side], box = face?.viewBox;
    if (!face?.svg || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) fail('EMPTY_RENDER', `The ${side} render has no valid board extent. Check layer names and board-outline data.`);
    unitScale(face.units);
    views[side] = {viewBox: [...box], units: face.units, mirrorX: side === 'bottom'};
  }
  if (views.top.units !== views.bottom.units) fail('MIXED_RENDER_UNITS', 'The renderer produced different units for the two faces. Re-export all Gerber/drill layers in the same unit (preferably mm) to prevent an inaccurate stackup.');
  const top = views.top, scale = unitScale(top.units) / 1000;
  const boundsMm = {minX: top.viewBox[0] * scale, minY: top.viewBox[1] * scale, width: top.viewBox[2] * scale, height: top.viewBox[3] * scale};
  boundsMm.maxX = boundsMm.minX + boundsMm.width; boundsMm.maxY = boundsMm.minY + boundsMm.height;
  const tableInfo = {bom: null, placement: null}, parsed = {};
  for (const kind of ['bom', 'placement']) {
    const candidates = tables.filter(t => t.kind === kind), wanted = options[kind === 'bom' ? 'bomName' : 'placementName'];
    let chosen = wanted ? tables.find(t => t.name === wanted) : candidates.length === 1 ? candidates[0] : null;
    if (!chosen && (candidates.length > 1 || wanted)) { dataIssues.push({name: wanted || kind, code: 'MULTIPLE_TABLES', message: `Choose one ${kind} table.`, details: {candidates: candidates.map(t => t.name)}}); continue; }
    if (!chosen) continue;
    tableInfo[kind] = {...chosen};
    try {
      parsed[kind] = (kind === 'bom' ? parseBom : parsePlacements)(entries.find(e => e.name === chosen.name).text, options[kind === 'bom' ? 'bomOptions' : 'placementOptions']);
      tableInfo[kind].mapping = parsed[kind].mapping;
      warnings.push(...parsed[kind].warnings);
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      dataIssues.push({name: chosen.name, code: error.code, message: error.message, details: error.details});
    }
  }
  const componentsByRef = new Map();
  for (const row of parsed.bom?.rows || []) for (const ref of row.refs) componentsByRef.set(ref.toLowerCase(), {...row, refs: undefined, ref, xMm: null, yMm: null, side: null, rotation: 0, placed: false, source: 'bom'});
  for (const row of parsed.placement?.rows || []) {
    const bom = componentsByRef.get(row.ref.toLowerCase());
    componentsByRef.set(row.ref.toLowerCase(), {...row, mpn: '', supplierPart: '', dnp: false, ...bom, ref: bom?.ref || row.ref, xMm: row.xMm, yMm: row.yMm, side: row.side, rotation: row.rotation, value: bom?.value || row.value, footprint: bom?.footprint || row.footprint, placed: true, source: bom ? 'bom+placement' : 'placement'});
  }
  const components = [...componentsByRef.values()], groups = [], groupByKey = new Map();
  for (const c of components) {
    const known = Boolean(c.mpn || c.supplierPart || (c.value && c.footprint));
    const key = JSON.stringify([c.value, c.footprint, c.mpn, c.supplierPart, c.dnp, known ? '' : c.ref]);
    if (!groupByKey.has(key)) { const g = {id: 'm' + (groups.length + 1), value: c.value || 'Unknown material', footprint: c.footprint || '', mpn: c.mpn || '', supplierPart: c.supplierPart || '', dnp: c.dnp, refs: [], quantity: 0, top: 0, bottom: 0, unplaced: 0, unknown: !known}; groups.push(g); groupByKey.set(key, g); }
    const g = groupByKey.get(key); c.groupId = g.id; g.refs.push(c.ref); g.quantity++;
    if (c.placed) g[c.side]++; else g.unplaced++;
  }
  const attributeEvidence = evidence(entries.filter(e => !tables.some(t => t.name === e.name)));
  if (!parsed.bom) warnings.push('No usable BOM: Gerber artwork does not provide a complete material list. Import a BOM for reliable values and part numbers.');
  if (!parsed.placement) warnings.push('No usable placement table: component centers are unavailable. Import CPL/PnP/KiCad .pos to enable location markers.');
  if (attributeEvidence.length && (!parsed.bom || !parsed.placement)) warnings.push(`X2 TO.C/TO.P evidence contains ${attributeEvidence.length} references; pin attributes are not treated as component centers or a complete BOM.`);
  const outside = components.filter(c => { if (!c.placed) return false; const p = projectPoint(c, views[c.side]); return p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1; });
  if (outside.length) warnings.push(`${outside.length} placements fall outside the Gerber bounds (${outside.slice(0, 8).map(c => c.ref).join(', ')}). Check coordinate units/origin and bottom-X convention; no auto-alignment was applied.`);
  const unplaced = components.filter(c => !c.placed).length;
  if (unplaced) warnings.push(`${unplaced} BOM references have no placement; they remain listed without invented coordinates.`);
  const layers = (stack.layers || layerInputs).map(l => ({name: l.filename || '', side: l.side || 'unknown', type: l.type || 'unknown'}));
  if (!layers.some(l => l.type === 'outline')) warnings.push('No outline layer was recognized. Render bounds use layer extents and can include off-board artwork.');
  for (const l of layers) if (!l.type || l.type === 'unknown') warnings.push(`Layer type is unknown: ${l.name}. Rename the layer or supply a layer override.`);
  return {topSvg: stack.top.svg, bottomSvg: stack.bottom.svg, boundsMm, views, components, groups, warnings, layers, tableInfo, tables, dataIssues, attributeEvidence};
}
